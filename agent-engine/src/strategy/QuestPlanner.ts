/**
 * Quest runner: Quest Helper (bundled with Microbot) tracks each quest's progress from game state
 * and knows the current step ("Talk to the Cook in Lumbridge Castle's kitchen"). This planner
 * selects the quest in Quest Helper, reads the current step each time a sub-goal ends, and has the
 * LLM planner turn that step into a sub-goal. Recurring steps are candidates for scripting.
 */
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';

export interface QuestHelperApi {
  questHelperStatus(): Promise<{ selected: boolean; questName?: string; completed?: boolean; stepText?: string }>;
  questHelperStart(name: string): Promise<void>;
}

export class QuestPlanner implements Planner {
  readonly name: string;
  private readonly quest: string;
  private readonly api: QuestHelperApi;
  private readonly llm: Planner;
  private readonly pollMs: number;

  constructor(quest: string, api: QuestHelperApi, llm: Planner, pollMs = 600) {
    this.pollMs = pollMs;
    this.quest = quest;
    this.api = api;
    this.llm = llm;
    this.name = `quest:${quest}`;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
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
    const goal = [
      `Complete the quest "${this.quest}".`,
      `Quest Helper's current step: ${status.stepText}`,
      'Plan the next sub-goal toward this step only (gather the listed items, travel, talk to the named NPC, pick the dialogue options it names).',
    ].join('\n');
    return this.llm.next({ ...ctx, goal });
  }
}
