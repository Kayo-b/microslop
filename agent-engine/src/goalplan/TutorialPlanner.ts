/**
 * Tutorial Island, driven by its progress varp (281, `VarPlayerID.TUTORIAL`; 1000 = on the
 * mainland). Every call re-reads the varp and sends the one action its stage needs - talk to the
 * guide, open a tab, use an item, click a door - as a direct `act`, so a restart resumes at the
 * right stage. Dialogue is clicked through here too (Tutorial Island dialogue is linear).
 *
 * The stage values below follow the commonly documented sequence; they are not all verified live.
 * When a stage does not advance after several attempts the planner gives up, which hands the
 * situation to the LLM rescue (with the stage in the reason). Capture the real values with
 * `./microbot-cli varp 281` while walking a throwaway account through, and fix the table.
 */
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import { TUTORIAL_DONE, VARP_TUTORIAL } from '../strategy/account.ts';
import type { GameAction, Snapshot } from '../types.ts';

type Step =
  | { kind: 'design' }
  | { kind: 'talk'; npc: string }
  | { kind: 'tab'; tab: string }
  | { kind: 'npc'; name: string; action: string }
  | { kind: 'object'; name: string; action: string }
  | { kind: 'useOnItem'; item: string; on: string }
  | { kind: 'useOnObject'; item: string; on: string }
  | { kind: 'equip'; items: string[] }
  | { kind: 'widget'; text: string }
  | { kind: 'smith'; option: string }
  | { kind: 'attack'; npc: string; equip?: string[] }
  | { kind: 'cast'; spell: string; npc: string };

export interface Stage {
  /** First varp value of the stage. */
  at: number;
  step: Step;
  what: string;
}

export const TUTORIAL_STAGES: Stage[] = [
  { at: 0, step: { kind: 'design' }, what: 'confirm the character design' },
  { at: 2, step: { kind: 'talk', npc: 'Gielinor Guide' }, what: 'talk to the Gielinor Guide' },
  { at: 3, step: { kind: 'tab', tab: 'SETTINGS' }, what: 'open the settings tab' },
  { at: 7, step: { kind: 'talk', npc: 'Gielinor Guide' }, what: 'talk to the Gielinor Guide again' },
  { at: 10, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'leave the guide\'s house' },
  { at: 20, step: { kind: 'talk', npc: 'Survival Expert' }, what: 'talk to the Survival Expert' },
  { at: 30, step: { kind: 'tab', tab: 'INVENTORY' }, what: 'open the inventory' },
  { at: 40, step: { kind: 'npc', name: 'Fishing spot', action: 'Net' }, what: 'net some shrimps' },
  { at: 50, step: { kind: 'tab', tab: 'SKILLS' }, what: 'open the skills tab' },
  { at: 60, step: { kind: 'talk', npc: 'Survival Expert' }, what: 'talk to the Survival Expert' },
  { at: 70, step: { kind: 'object', name: 'Tree', action: 'Chop down' }, what: 'chop a tree' },
  { at: 80, step: { kind: 'useOnItem', item: 'Tinderbox', on: 'Logs' }, what: 'light a fire' },
  { at: 90, step: { kind: 'useOnObject', item: 'Raw shrimps', on: 'Fire' }, what: 'cook the shrimps' },
  { at: 120, step: { kind: 'object', name: 'Gate', action: 'Open' }, what: 'go through the gate' },
  { at: 130, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'enter the kitchen' },
  { at: 140, step: { kind: 'talk', npc: 'Master Chef' }, what: 'talk to the Master Chef' },
  { at: 150, step: { kind: 'useOnItem', item: 'Pot of flour', on: 'Bucket of water' }, what: 'make bread dough' },
  { at: 160, step: { kind: 'useOnObject', item: 'Bread dough', on: 'Range' }, what: 'bake the bread' },
  { at: 170, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'leave the kitchen' },
  { at: 200, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'enter the Quest Guide\'s house' },
  { at: 220, step: { kind: 'talk', npc: 'Quest Guide' }, what: 'talk to the Quest Guide' },
  { at: 230, step: { kind: 'tab', tab: 'QUESTS' }, what: 'open the quest list' },
  { at: 240, step: { kind: 'talk', npc: 'Quest Guide' }, what: 'talk to the Quest Guide again' },
  { at: 250, step: { kind: 'object', name: 'Ladder', action: 'Climb-down' }, what: 'climb down to the mine' },
  { at: 260, step: { kind: 'talk', npc: 'Mining Instructor' }, what: 'talk to the Mining Instructor' },
  { at: 300, step: { kind: 'object', name: 'Tin rocks', action: 'Mine' }, what: 'mine tin' },
  { at: 310, step: { kind: 'object', name: 'Copper rocks', action: 'Mine' }, what: 'mine copper' },
  { at: 320, step: { kind: 'useOnObject', item: 'Tin ore', on: 'Furnace' }, what: 'smelt a bronze bar' },
  { at: 330, step: { kind: 'talk', npc: 'Mining Instructor' }, what: 'talk to the Mining Instructor again' },
  { at: 340, step: { kind: 'smith', option: 'Bronze dagger' }, what: 'smith a bronze dagger' },
  { at: 360, step: { kind: 'object', name: 'Gate', action: 'Open' }, what: 'go through the gate to the combat area' },
  { at: 370, step: { kind: 'talk', npc: 'Combat Instructor' }, what: 'talk to the Combat Instructor' },
  { at: 390, step: { kind: 'tab', tab: 'EQUIPMENT' }, what: 'open the equipment tab' },
  { at: 400, step: { kind: 'widget', text: 'View equipment stats' }, what: 'view equipment stats' },
  { at: 405, step: { kind: 'equip', items: ['Bronze dagger'] }, what: 'wield the bronze dagger' },
  { at: 410, step: { kind: 'talk', npc: 'Combat Instructor' }, what: 'talk to the Combat Instructor' },
  { at: 420, step: { kind: 'equip', items: ['Bronze sword', 'Wooden shield'] }, what: 'wield the sword and shield' },
  { at: 430, step: { kind: 'tab', tab: 'COMBAT' }, what: 'open the combat options' },
  { at: 440, step: { kind: 'object', name: 'Gate', action: 'Open' }, what: 'enter the rat pen' },
  { at: 450, step: { kind: 'attack', npc: 'Giant rat' }, what: 'kill a giant rat' },
  { at: 470, step: { kind: 'talk', npc: 'Combat Instructor' }, what: 'talk to the Combat Instructor' },
  { at: 480, step: { kind: 'attack', npc: 'Giant rat', equip: ['Shortbow', 'Bronze arrow'] }, what: 'shoot a giant rat' },
  { at: 500, step: { kind: 'object', name: 'Ladder', action: 'Climb-up' }, what: 'climb out of the mine' },
  { at: 510, step: { kind: 'object', name: 'Bank booth', action: 'Use' }, what: 'open the bank' },
  { at: 520, step: { kind: 'object', name: 'Poll booth', action: 'Use' }, what: 'use the poll booth' },
  { at: 525, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'go to the Account Guide' },
  { at: 530, step: { kind: 'talk', npc: 'Account Guide' }, what: 'talk to the Account Guide' },
  { at: 531, step: { kind: 'tab', tab: 'ACC_MAN' }, what: 'open the account management tab' },
  { at: 532, step: { kind: 'talk', npc: 'Account Guide' }, what: 'talk to the Account Guide again' },
  { at: 540, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'go to the chapel' },
  { at: 550, step: { kind: 'talk', npc: 'Brother Brace' }, what: 'talk to Brother Brace' },
  { at: 560, step: { kind: 'tab', tab: 'PRAYER' }, what: 'open the prayer tab' },
  { at: 570, step: { kind: 'talk', npc: 'Brother Brace' }, what: 'talk to Brother Brace again' },
  { at: 580, step: { kind: 'tab', tab: 'FRIENDS' }, what: 'open the friends list' },
  { at: 600, step: { kind: 'talk', npc: 'Brother Brace' }, what: 'talk to Brother Brace once more' },
  { at: 610, step: { kind: 'object', name: 'Door', action: 'Open' }, what: 'leave the chapel' },
  { at: 620, step: { kind: 'talk', npc: 'Magic Instructor' }, what: 'talk to the Magic Instructor' },
  { at: 630, step: { kind: 'tab', tab: 'MAGIC' }, what: 'open the magic tab' },
  { at: 640, step: { kind: 'talk', npc: 'Magic Instructor' }, what: 'talk to the Magic Instructor again' },
  { at: 650, step: { kind: 'cast', spell: 'WIND_STRIKE', npc: 'Chicken' }, what: 'cast Wind Strike on a chicken' },
  { at: 670, step: { kind: 'talk', npc: 'Magic Instructor' }, what: 'talk to the Magic Instructor and go to the mainland' },
];

export function stageFor(progress: number): Stage {
  let cur = TUTORIAL_STAGES[0]!;
  for (const st of TUTORIAL_STAGES) if (st.at <= progress) cur = st;
  return cur;
}

/**
 * Dialogue answers: never become an ironman, go to the mainland, and otherwise take the option
 * that keeps the tutorial moving.
 */
export function chooseOption(options: string[]): string | undefined {
  const iron = options.some((o) => /iron/i.test(o));
  if (iron) return options.find((o) => /\bno\b|not|normal|regular/i.test(o) && !/^yes/i.test(o));
  return (
    options.find((o) => /brand new|first time|mainland|^yes/i.test(o)) ??
    options.find((o) => !/^no\b|cancel|back/i.test(o)) ??
    options[0]
  );
}

export interface TutorialApi {
  varp(id: number): Promise<number>;
}

export interface TutorialOptions {
  /** Calls at one stage before giving up (to the rescue). Default 25. */
  maxAttemptsPerStage?: number;
}

const act = (action: GameAction, reason: string): PlanStep => ({ kind: 'act', action, reason });

export class TutorialPlanner implements Planner {
  readonly name = 'tutorial-island';
  private readonly api: TutorialApi;
  private readonly maxAttempts: number;
  private lastStage = -1;
  private attempts = 0;
  private designTried = false;

  constructor(api: TutorialApi, o: TutorialOptions = {}) {
    this.api = api;
    this.maxAttempts = o.maxAttemptsPerStage ?? 25;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const progress = await this.api.varp(VARP_TUTORIAL);
    if (progress >= TUTORIAL_DONE) return { kind: 'complete', reason: 'Tutorial Island finished' };
    const s = ctx.snapshot;
    const stage = stageFor(progress);

    if (s.dialogue.inDialogue) {
      if (s.dialogue.hasOptions && s.dialogue.options.length) {
        const option = chooseOption(s.dialogue.options);
        if (option) return act({ op: 'dialogue_select', option }, `answer "${option}"`);
      }
      if (s.dialogue.hasContinue) return act({ op: 'dialogue_continue' }, 'continue the dialogue');
    }
    const p = s.player;
    if (p && (p.moving || p.animating || (p.inCombat && stage.step.kind === 'attack'))) return act({ op: 'wait', ticks: 2 }, 'wait for the current action');

    if (stage.at !== this.lastStage) {
      this.lastStage = stage.at;
      this.attempts = 0;
    }
    if (++this.attempts > this.maxAttempts) {
      return { kind: 'impossible', reason: `Tutorial Island stuck at stage ${progress} (${stage.what}) after ${this.maxAttempts} attempts` };
    }
    return this.stepFor(stage, s) ?? { kind: 'impossible', reason: `Tutorial Island stage ${progress} (${stage.what}): target not in view` };
  }

  private stepFor(stage: Stage, s: Snapshot): PlanStep | null {
    const st = stage.step;
    const slot = (name: string) => s.inventory.items.find((i) => i.name.toLowerCase() === name.toLowerCase());
    const npc = (name: string) => s.npcs.filter((n) => n.name === name && n.reachable !== false).sort((a, b) => a.distance - b.distance)[0];
    const obj = (name: string, action: string) =>
      s.objects.filter((o) => o.name === name && o.actions.includes(action)).sort((a, b) => (a.reachable === b.reachable ? a.distance - b.distance : a.reachable ? -1 : 1))[0];
    const find = (name: string, action: string): PlanStep => ({
      kind: 'subgoal',
      subgoal: { text: `find the ${name} and ${action.toLowerCase()} it (Tutorial Island: ${stage.what})`, targets: [name], actions: [action], maxSteps: 20 },
    });

    switch (st.kind) {
      case 'design':
        if (!this.designTried) {
          this.designTried = true;
          return act({ op: 'widget_click', text: 'Confirm' }, stage.what);
        }
        return this.stepFor(stageFor(2), s);
      case 'talk': {
        const n = npc(st.npc);
        return n ? act({ op: 'interact', target: { kind: 'npc', index: n.index, id: n.id }, action: 'Talk-to' }, stage.what) : find(st.npc, 'Talk-to');
      }
      case 'tab':
        return act({ op: 'tab_open', tab: st.tab }, stage.what);
      case 'widget':
        return act({ op: 'widget_click', text: st.text }, stage.what);
      case 'npc': {
        const n = npc(st.name);
        return n ? act({ op: 'interact', target: { kind: 'npc', index: n.index, id: n.id }, action: st.action }, stage.what) : find(st.name, st.action);
      }
      case 'object': {
        const o = obj(st.name, st.action);
        return o ? act({ op: 'interact', target: { kind: 'object', id: o.id, ...o.position }, action: st.action }, stage.what) : find(st.name, st.action);
      }
      case 'useOnItem': {
        const a = slot(st.item);
        const b = slot(st.on);
        if (!a || !b) return null;
        return act({ op: 'use_item_on', itemSlot: a.slot, target: { kind: 'inventory', slot: b.slot, id: b.id } }, stage.what);
      }
      case 'useOnObject': {
        const a = slot(st.item);
        const o = s.objects.filter((x) => x.name === st.on).sort((x, y) => x.distance - y.distance)[0];
        if (!a) return null;
        return o ? act({ op: 'use_item_on', itemSlot: a.slot, target: { kind: 'object', id: o.id, ...o.position } }, stage.what) : find(st.on, 'Use');
      }
      case 'smith': {
        if (s.production.open) return act({ op: 'production_select', option: st.option, amount: 1 }, stage.what);
        const a = slot('Bronze bar');
        const anvil = s.objects.filter((x) => x.name === 'Anvil').sort((x, y) => x.distance - y.distance)[0];
        if (!a) return null;
        return anvil ? act({ op: 'use_item_on', itemSlot: a.slot, target: { kind: 'object', id: anvil.id, ...anvil.position } }, stage.what) : find('Anvil', 'Smith');
      }
      case 'equip':
      case 'attack': {
        const toWear = (st.kind === 'equip' ? st.items : st.equip ?? []).map(slot).find((i) => i !== undefined);
        if (toWear) {
          const action = toWear.actions.find((x) => /^(wield|wear)$/i.test(x)) ?? 'Wield';
          return act({ op: 'interact', target: { kind: 'inventory', slot: toWear.slot, id: toWear.id }, action }, `${stage.what}: ${action.toLowerCase()} the ${toWear.name}`);
        }
        if (st.kind === 'equip') return null;
        const n = s.npcs.filter((x) => x.name === st.npc && !x.interactingWithOther).sort((a, b) => a.distance - b.distance)[0];
        return n ? act({ op: 'interact', target: { kind: 'npc', index: n.index, id: n.id }, action: 'Attack' }, stage.what) : find(st.npc, 'Attack');
      }
      case 'cast': {
        const n = npc(st.npc);
        return n ? act({ op: 'cast_on', spell: st.spell, target: { kind: 'npc', index: n.index, id: n.id } }, stage.what) : find(st.npc, 'Attack');
      }
    }
  }
}
