import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import type { Snapshot, SubGoal, WorldPoint } from '../types.ts';
import type { DoneCondition } from './conditions.ts';

/** A sub-goal plus its declarative completion condition (kept for logging / LLM context). */
export interface PlannedSubGoal extends SubGoal {
  doneWhen?: DoneCondition;
}

export interface SubGoalReport {
  subgoal: string;
  result: 'done' | 'blocked' | 'max_steps';
  reason: string;
  steps: number;
  /** Last few action -> outcome lines, for the planner's next decision. */
  trail: string[];
}

export interface PlannerContext {
  goal: string;
  snapshot: Snapshot;
  kb: KnowledgeBase | null;
  reports: SubGoalReport[];
  /** Real walking cost between two points (web walker), when the backend provides it. */
  pathCost?: (from: WorldPoint, to: WorldPoint) => Promise<number | null>;
}

export type PlanStep =
  | { kind: 'subgoal'; subgoal: PlannedSubGoal }
  | { kind: 'complete'; reason: string }
  | { kind: 'impossible'; reason: string }
  /** Do nothing until `until` holds (or `maxSeconds` pass), e.g. resting for HP to regenerate. */
  | { kind: 'wait'; reason: string; until: DoneCondition; maxSeconds: number };

/** Long-horizon layer: decides the next sub-goal whenever the previous one ends. */
export interface Planner {
  readonly name: string;
  next(ctx: PlannerContext): Promise<PlanStep>;
}
