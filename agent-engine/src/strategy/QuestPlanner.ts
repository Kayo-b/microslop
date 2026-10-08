/**
 * Quest runner: Quest Helper (bundled with Microbot) tracks each quest's progress from game state
 * and knows the current step ("Talk to the Cook in Lumbridge Castle's kitchen"). This planner
 * selects the quest in Quest Helper, reads the current step each time a sub-goal ends, and has the
 * LLM planner turn that step into a sub-goal. Recurring steps are candidates for scripting.
 */
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { WorldPoint } from '../types.ts';
import { foodSupply } from '../kb/resources.ts';
import { inF2pArea } from './f2p.ts';

export interface QuestHelperApi {
  questHelperStatus(): Promise<{ selected: boolean; questName?: string; completed?: boolean; stepText?: string | string[]; stepPoint?: WorldPoint }>;
  questHelperStart(name: string): Promise<void>;
}

const STEP_PLACE = 'quest step location';

const coins = (ctx: PlannerContext) => ctx.snapshot.inventory.items.filter((i) => i.name === 'Coins').reduce((sum, i) => sum + i.quantity, 0);

export class QuestPlanner implements Planner {
  readonly name: string;
  private readonly quest: string;
  private readonly api: QuestHelperApi;
  private readonly llm: Planner;
  private readonly pollMs: number;
  /** Whether the account is a member; free accounts never go to members-only areas. */
  private readonly members: () => Promise<boolean>;
  /** Coins in the bank (last seen); lets a step that can be bought be bought. */
  private readonly bankCoins: () => number;

  constructor(quest: string, api: QuestHelperApi, llm: Planner, pollMs = 600, members: () => Promise<boolean> = async () => true, bankCoins: () => number = () => 0) {
    this.bankCoins = bankCoins;
    this.pollMs = pollMs;
    this.members = members;
    this.quest = quest;
    this.api = api;
    this.llm = llm;
    this.name = `quest:${quest}`;
  }

  /** A step that names the Grand Exchange or buying, and coins on hand to pay for it. */
  private canBuy(stepText: string | string[] | undefined, ctx: PlannerContext): boolean {
    const text = Array.isArray(stepText) ? stepText.join(' ') : (stepText ?? '');
    return /grand exchange|\bbuy\b|\bpurchase\b/i.test(text) && coins(ctx) + this.bankCoins() >= 2000;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    // Quests send the player into fights (imps, the Lesser demon) with whatever food is carried;
    // never start a step half dead with nothing to eat. HP regenerates about 1 per minute.
    const hp = ctx.snapshot.player?.hp;
    if (hp && hp.max > 0 && hp.current / hp.max < 0.5 && foodSupply(ctx.snapshot.inventory.items).count === 0) {
      return { kind: 'wait', reason: `HP ${hp.current}/${hp.max} and no food: resting before the next quest step`, until: { hpAtLeast: 0.8 }, maxSeconds: 1200 };
    }
    let status = await this.api.questHelperStatus();
    if (!status.selected || status.questName !== this.quest) {
      await this.api.questHelperStart(this.quest);
      status = await this.api.questHelperStatus();
      // Quest Helper sets the quest up on the client thread after start returns: for a moment the
      // status still shows the previous quest, then the new one without a step.
      const ready = () => status.questName === this.quest && (!!status.stepText?.length || !!status.completed);
      for (let i = 0; i < 10 && !ready(); i++) {
        await new Promise((r) => setTimeout(r, this.pollMs));
        status = await this.api.questHelperStatus();
      }
    }
    if (status.completed) return { kind: 'complete', reason: `${this.quest} completed` };
    if (!status.stepText?.length) return { kind: 'impossible', reason: `Quest Helper has no current step for ${this.quest}` };
    const at = status.stepPoint;
    if (at && !inF2pArea(at) && !(await this.members())) {
      return { kind: 'impossible', reason: `${this.quest}: the current step is at (${at.x}, ${at.y}, floor ${at.plane}), a members-only area, and this is a free account` };
    }
    const goal = [
      `Complete the quest "${this.quest}".`,
      `Quest Helper's current step: ${status.stepText}`,
      ...(at ? [`The step takes place at (${at.x}, ${at.y}, floor ${at.plane}). To travel there, set the destination name to exactly "${STEP_PLACE}".`] : []),
      ...(this.canBuy(status.stepText, ctx)
        ? [`The step says the items can be bought. The player has ${coins(ctx)} coins carried and ${this.bankCoins()} in the bank: BUY them instead of grinding drops. If the carried coins are not enough, first withdraw coins at the nearest bank, then buy each item at the Grand Exchange (north-west Varrock).`]
        : []),
      'Plan the next sub-goal toward this step only (gather the listed items, travel, talk to the named NPC, pick the dialogue options it names).',
      ...((await this.members()) ? [] : ['This is a FREE-TO-PLAY account on a free world: never enter members-only areas, use members-only items or transport.']),
      `The player carries ${coins(ctx)} coins. Prefer shops and gathering over the Grand Exchange (it costs the guide price +30%); if an item is unaffordable, get it another way or earn coins first.`,
      ...(foodSupply(ctx.snapshot.inventory.items).count < 5
        ? ['The player carries little or no food. If this step means fighting anything, first withdraw cooked food (e.g. Shrimps) from the nearest bank, or buy some.']
        : []),
    ].join('\n');
    const step = await this.llm.next({ ...ctx, goal });
    // Quest places ("Lumbridge General Store") are often missing from the map database; the step's
    // own location is exact.
    const dest = step.kind === 'subgoal' ? step.subgoal.destination : undefined;
    // ...unless the player already stands there: then the step is done here and the LLM's place is
    // somewhere else (Cadava bushes after talking to the Apothecary), so leave the targets to it.
    const me = ctx.snapshot.player?.position;
    const here = !!me && me.plane === at?.plane && Math.max(Math.abs(me.x - at.x), Math.abs(me.y - at.y)) < 5;
    const unresolved = !ctx.kb || ctx.kb.findPlaces(dest?.name ?? '', undefined, 1).length === 0;
    if (at && dest && !dest.point && (dest.name === STEP_PLACE || (unresolved && !here))) {
      dest.point = at;
    }
    return step;
  }
}
