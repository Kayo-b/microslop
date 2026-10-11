/**
 * Runs an activity's prerequisites before the activity itself: survey the bank, resolve what is
 * missing (src/prereq/resolve.ts), run the setup phases with the strategy layer's executors, check
 * again, then hand over to the activity. When the activity later gives up for a reason setup can
 * fix (out of arrows, no axe), setup runs once more.
 *
 * Setup longer than the budget is not started: the activity reports impossible with the plan, and
 * the campaign (or strategy) moves on to something cheaper; skip memory keeps it out for a while.
 */
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import { type AccountApi, BankMemory, buildProfile, readAccount } from '../strategy/account.ts';
import { nextCoinStep, nextLoadoutStep } from './loadout.ts';
import { type Phase, plannerFor, type StrategyDeps, surveyBankStep } from '../strategy/StrategyPlanner.ts';
import type { Snapshot } from '../types.ts';
import type { ActivityNeeds } from './needs.ts';
import { resolveSetup, type Setup, type SetupStep } from './resolve.ts';

export interface PrereqDeps {
  account: AccountApi;
  kb?: KnowledgeBase | null;
  bank?: BankMemory;
  /** Executors for setup phases (LLM/quest planners); defaults: none. */
  strategy?: Partial<StrategyDeps>;
  /** Longest setup started automatically, in minutes. Default 30; Infinity for strict flows. */
  budgetMinutes?: number;
  /** Check rounds before the activity starts anyway. Default 3; flows that level skills need more. */
  maxChecks?: number;
  /** See ResolveOptions.earnCoins. */
  earnCoins?: boolean;
  /** Phase ids that kept failing. */
  skip?: Set<string>;
  log?: (msg: string) => void;
  /** A setup phase gave up (feeds skip memory). */
  onSetupFailed?: (phaseId: string) => void;
  /** Grand Exchange prices (loaded once per check); without it, gear comes from shops only. */
  gePrice?: () => Promise<(item: string) => number | null>;
  now?: () => number;
}

/** Activity give-up reasons that setup can fix. */
const FIXABLE = /out of (arrows|runes)|no coins|coins only cover|needs \d+ coins|no .* carried, worn or banked|no food|has none left/i;
const MAX_CHECKS = 3;

export function counts(s: Snapshot, bank: BankMemory): Map<string, number> {
  const m = new Map<string, number>(bank.items);
  for (const i of s.inventory.items) m.set(i.name, (m.get(i.name) ?? 0) + i.quantity);
  for (const e of s.equipment) m.set(e.name, (m.get(e.name) ?? 0) + (e.quantity ?? 1));
  return m;
}

export class PrereqPlanner implements Planner {
  readonly name: string;
  private readonly inner: Planner;
  private readonly needs: ActivityNeeds;
  private readonly d: PrereqDeps;
  private readonly bank: BankMemory;
  private readonly now: () => number;
  private mode: 'check' | 'setup' | 'equip' | 'activity' = 'check';
  private equipSteps = 0;
  private coinGuards = 0;
  private queue: SetupStep[] = [];
  private current: { step: SetupStep; planner: Planner; startedAt: number; reportsAt: number } | null = null;
  private checks = 0;
  private activityReportsAt = 0;

  constructor(inner: Planner, needs: ActivityNeeds, deps: PrereqDeps) {
    this.inner = inner;
    this.needs = needs;
    this.d = deps;
    this.bank = deps.bank ?? new BankMemory();
    this.now = deps.now ?? Date.now;
    this.name = `prereq(${inner.name})`;
  }

  private log(msg: string): void {
    this.d.log?.(`[prereq] ${msg}`);
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    this.bank.update(ctx.snapshot);
    for (let i = 0; i < 12; i++) {
      if (this.mode === 'check') {
        const r = await this.check(ctx);
        if (r) return r;
        continue;
      }
      if (this.mode === 'equip') {
        const r = this.equip(ctx);
        if (r) return r;
        continue;
      }
      if (this.mode === 'setup') {
        const r = await this.runSetup(ctx);
        if (r) return r;
        continue;
      }
      // Between sub-goals: never carry a fortune around (6M went for a walk once). Capped, so an
      // activity that keeps withdrawing cannot loop with it.
      if (!this.needs.coinsManaged && this.coinGuards < 12) {
        const bankIt = nextCoinStep(ctx.snapshot, this.d.kb ?? null);
        if (bankIt) {
          this.coinGuards++;
          this.log(`coin guard: ${bankIt.kind === 'subgoal' ? bankIt.subgoal.text : bankIt.kind === 'act' ? bankIt.reason : bankIt.kind}`);
          return bankIt;
        }
      }
      const step = await this.inner.next({ ...ctx, reports: ctx.reports.slice(this.activityReportsAt) });
      if (step.kind === 'impossible' && FIXABLE.test(step.reason) && this.checks < (this.d.maxChecks ?? MAX_CHECKS)) {
        this.log(`activity gave up (${step.reason}); checking prerequisites again`);
        this.mode = 'check';
        continue;
      }
      return step;
    }
    return { kind: 'impossible', reason: 'prerequisites did not settle' };
  }

  /** Resolves what is missing; null after switching mode. */
  private async check(ctx: PlannerContext): Promise<PlanStep | null> {
    const s = ctx.snapshot;
    if (this.bank.seenAt === null) return surveyBankStep(s, this.d.kb ?? null);
    this.checks++;
    const profile = buildProfile(await readAccount(this.d.account), s, this.bank);
    const pos = s.player?.position;
    const kb = this.d.kb;
    const shop = (item: string) => {
      const o = pos && kb ? kb.shopOffers(item, pos)[0] : undefined;
      return o ? { source: { kind: 'shop' as const, name: o.shop, keeper: o.keeper, point: o.point }, price: o.price } : null;
    };
    const gePrice = this.d.gePrice ? await this.d.gePrice() : undefined;
    const setup: Setup = resolveSetup(this.needs, { profile, counts: counts(s, this.bank) }, { skip: this.d.skip, shop, gePrice, earnCoins: this.d.earnCoins });
    const budget = this.d.budgetMinutes ?? 30;
    if (setup.blocked.length) return { kind: 'impossible', reason: `prerequisites for ${this.needs.name} cannot be met: ${setup.blocked.join('; ')}` };
    if (!setup.steps.length) {
      this.log(`${this.needs.name}: prerequisites met`);
      this.mode = 'equip';
      this.equipSteps = 0;
      return null;
    }
    const plan = setup.steps.map((st) => `${st.phase.text} (~${st.minutes} min)`).join(' -> ');
    if (setup.minutes > budget) {
      return { kind: 'impossible', reason: `setup for ${this.needs.name} takes ~${setup.minutes} min (budget ${budget}): ${plan}` };
    }
    if (this.checks > (this.d.maxChecks ?? MAX_CHECKS)) {
      this.log(`setup still incomplete after ${this.d.maxChecks ?? MAX_CHECKS} rounds (${plan}); starting ${this.needs.name} anyway`);
      this.mode = 'activity';
      this.activityReportsAt = ctx.reports.length;
      return null;
    }
    this.log(`${this.needs.name} needs setup (~${setup.minutes} min): ${plan}`);
    this.queue = setup.steps;
    this.mode = 'setup';
    return null;
  }

  /** Wears the best owned gear before the activity; a few steps at most, then the activity starts anyway. */
  private equip(ctx: PlannerContext): PlanStep | null {
    const step = this.equipSteps < 8 && (this.needs.gear || this.needs.bankMaterials) ? nextLoadoutStep(ctx.snapshot, [...this.bank.items.keys()], this.d.kb ?? null, { bankMaterials: this.needs.bankMaterials }) : null;
    if (step) {
      this.equipSteps++;
      this.log(`loadout: ${step.kind === 'subgoal' ? step.subgoal.text : step.kind}`);
      return step;
    }
    this.mode = 'activity';
    this.activityReportsAt = ctx.reports.length;
    return null;
  }

  private async runSetup(ctx: PlannerContext): Promise<PlanStep | null> {
    const s = ctx.snapshot;
    if (this.current && this.phaseOver(this.current.step.phase, s)) this.current = null;
    if (!this.current) {
      const step = this.queue.shift();
      if (!step) {
        this.mode = 'check';
        return null;
      }
      const planner = plannerFor(step.phase, s, { account: this.d.account, kb: this.d.kb, bank: this.bank, ...this.d.strategy });
      if (!planner) return { kind: 'impossible', reason: `setup step "${step.phase.text}" cannot run here` };
      this.log(`setup: ${step.phase.text} (${step.why})`);
      this.current = { step, planner, startedAt: this.now(), reportsAt: ctx.reports.length };
    }
    const cur = this.current;
    const next = await cur.planner.next({ ...ctx, goal: cur.step.phase.text, reports: ctx.reports.slice(cur.reportsAt) });
    if (next.kind === 'subgoal' || next.kind === 'wait' || next.kind === 'act') return next;
    this.current = null;
    if (next.kind === 'impossible') {
      this.d.onSetupFailed?.(cur.step.phase.id);
      return { kind: 'impossible', reason: `setup step "${cur.step.phase.text}" failed: ${next.reason}` };
    }
    return null;
  }

  private phaseOver(ph: Phase, s: Snapshot): boolean {
    if (ph.until && (s.skills.find((k) => k.name === ph.until!.skill)?.level ?? 1) >= ph.until.level) return true;
    if (ph.untilCoins !== undefined) {
      const carried = s.inventory.items.filter((i) => i.name === 'Coins').reduce((n, i) => n + i.quantity, 0);
      if (carried + (this.bank.items.get('Coins') ?? 0) >= ph.untilCoins) return true;
    }
    return ph.maxMs !== undefined && this.now() - this.current!.startedAt >= ph.maxMs;
  }
}
