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

  constructor(quest: string, api: QuestHelperApi, llm: Planner) {
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
    }
    if (status.completed) return { kind: 'complete', reason: `${this.quest} completed` };
    if (!status.stepText) return { kind: 'impossible', reason: `Quest Helper has no current step for ${this.quest}` };
    const goal = [
      `Complete the quest "${this.quest}".`,
      `Quest Helper's current step: ${status.stepText}`,
      'Plan the next sub-goal toward this step only (gather the listed items, travel, talk to the named NPC, pick the dialogue options it names).',
    ].join('\n');
    return this.llm.next({ ...ctx, goal });
  }
}
