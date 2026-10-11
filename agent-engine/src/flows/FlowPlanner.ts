/**
 * Strict activity flows: a goal ("make gold") is a tree of options (tan hides, smelt steel, ...),
 * each with the requirements it needs. A flow run executes one option and only the sub-flows its
 * requirements trigger (Smithing below 30 -> level Smithing first; no gear -> buy the cheapest),
 * never an unrelated activity: no rotation, no money route to earn missing coins, no setup time
 * cap. When a requirement cannot be met inside the tree, the run stops and says which.
 *
 *   npm run agent -- flow gold                      (the tree for the logged-in account)
 *   npm run agent -- run --flow gold --option smelt-steel
 *   npm run agent -- run --flow gold                (the best option that can be set up)
 */
import { type ActivityNeeds, activityNeeds, catalogReqFor } from '../prereq/needs.ts';
import { PrereqPlanner, type PrereqDeps } from '../prereq/PrereqPlanner.ts';
import { type AccountView, resolveSetup, type Setup } from '../prereq/resolve.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import { GOLD, type MoneyRoute, type Requirement } from '../strategy/catalog.ts';
import { type Phase, plannerFor, type StrategyDeps } from '../strategy/StrategyPlanner.ts';

export interface FlowOption {
  id: string;
  name: string;
  members: boolean;
  /** Hard requirements (levels, quests, items). */
  requires?: Requirement;
  /** Levels the option is comfortable at (fights); below them, they are trained first. */
  recommend?: Record<string, number>;
  /** Rough profit or XP per hour, to rank options when none is named. */
  perHour: number;
  phase: Phase;
}

export interface FlowGoal {
  id: string;
  name: string;
  options: FlowOption[];
}

const fromRoute = (r: MoneyRoute): FlowOption => ({
  id: r.id,
  name: r.name,
  members: r.members,
  requires: r.req,
  recommend: r.recommend,
  perHour: r.gpHour,
  phase: { id: `flow:gold:${r.id}`, text: r.exec.kind === 'llm' ? r.exec.goal : r.name, exec: r.exec },
});

export const FLOWS: Record<string, FlowGoal> = {
  gold: { id: 'gold', name: 'make gold', options: GOLD.map(fromRoute) },
};

/** Everything an option needs: its execution's own needs plus its requirements and recommended levels. */
export function optionNeeds(o: FlowOption): ActivityNeeds {
  const req: Requirement = { ...(catalogReqFor(o.phase.exec) ?? {}), ...(o.requires ?? {}) };
  // "Coins" on a trading loop means "starts with some coins": the loop sizes its own batches and
  // stops when they run out. As a prerequisite it demanded a fixed sum and blocked a herblore run
  // whose coins were already in herbs.
  if (req.items?.includes('Coins')) req.items = req.items.filter((i) => i !== 'Coins');
  const skills = { ...(req.skills ?? {}) };
  for (const [k, v] of Object.entries(o.recommend ?? {})) skills[k] = Math.max(skills[k] ?? 0, v);
  if (Object.keys(skills).length) req.skills = skills;
  const needs = activityNeeds(o.phase.exec, req) ?? activityNeeds({ kind: 'llm', goal: o.name }, req)!;
  return { ...needs, name: o.id };
}

/** The setup each option needs on this account, strict (no coin earning). */
export function flowStatus(goal: FlowGoal, v: AccountView, o: { members: boolean; skip?: Set<string>; gePrice?: (item: string) => number | null }): { option: FlowOption; setup: Setup }[] {
  return goal.options
    .filter((x) => o.members || !x.members)
    .map((option) => ({ option, setup: resolveSetup(optionNeeds(option), v, { skip: o.skip, gePrice: o.gePrice, earnCoins: false }) }));
}

/** The option a goal run takes: the best per hour among those whose setup is not blocked. */
export function chooseOption(status: { option: FlowOption; setup: Setup }[], skip: Set<string>): FlowOption | null {
  return status.filter((s) => !s.setup.blocked.length && !skip.has(s.option.phase.id)).sort((a, b) => b.option.perHour - a.option.perHour)[0]?.option ?? null;
}

export interface FlowDeps {
  /** Builds the account view (profile + item counts) for choosing an option. */
  view: (ctx: PlannerContext) => Promise<AccountView>;
  members: (ctx: PlannerContext) => Promise<boolean>;
  strategy: StrategyDeps;
  prereq: Omit<PrereqDeps, 'budgetMinutes' | 'maxChecks' | 'earnCoins'>;
  skip?: Set<string>;
  log?: (msg: string) => void;
}

export class FlowPlanner implements Planner {
  readonly name: string;
  private inner: Planner | null = null;
  private readonly goal: FlowGoal;
  private readonly optionId: string | undefined;
  private readonly d: FlowDeps;

  constructor(goal: FlowGoal, optionId: string | undefined, d: FlowDeps) {
    this.goal = goal;
    this.optionId = optionId;
    this.d = d;
    this.name = `flow:${goal.id}${optionId ? `:${optionId}` : ''}`;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    if (!this.inner) {
      let option = this.optionId ? this.goal.options.find((o) => o.id === this.optionId) : undefined;
      if (this.optionId && !option) {
        return { kind: 'impossible', reason: `${this.goal.name} has no option "${this.optionId}" (${this.goal.options.map((o) => o.id).join(', ')})` };
      }
      if (!option) {
        const status = flowStatus(this.goal, await this.d.view(ctx), { members: await this.d.members(ctx), skip: this.d.skip, gePrice: this.d.strategy.gePrice });
        option = chooseOption(status, this.d.skip ?? new Set()) ?? undefined;
        if (!option) return { kind: 'impossible', reason: `no ${this.goal.name} option can be set up on this account (see: agent flow ${this.goal.id})` };
      }
      const main = plannerFor(option.phase, ctx.snapshot, this.d.strategy);
      if (!main) return { kind: 'impossible', reason: `${option.id} cannot run here (needs an LLM, GE prices or a locatable spawn)` };
      this.d.log?.(`[flow] ${this.goal.name} -> ${option.id}: ${option.name}`);
      // Strict: only this option's own sub-flows, however long they take, never a money detour.
      this.inner = new PrereqPlanner(main, optionNeeds(option), { ...this.d.prereq, budgetMinutes: Infinity, maxChecks: 100, earnCoins: false });
    }
    return this.inner.next(ctx);
  }
}
