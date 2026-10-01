/**
 * Strategy layer: turns a long-term goal ("level the account", "make money", "do quests") into a
 * sequence of phases, each run by a scripted planner (or the LLM/quest runner where nothing is
 * scripted yet). A phase ends when its planner completes, gives up, reaches its level bracket or
 * runs out of time; then the strategy picks the next phase from the catalog and the live profile.
 */
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import { COOK_PRESETS, CookingPlanner } from '../planner/CookingPlanner.ts';
import { SmithingPlanner } from '../planner/SmithingPlanner.ts';
import { compile } from '../planner/conditions.ts';
import { NOT_BANKS, TaskTreePlanner, type CombatTask } from '../planner/TaskTreePlanner.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';
import { type AccountApi, BankMemory, buildProfile, level, type Profile, readAccount, unmet } from './account.ts';
import { type Execution, inWilderness, MONEY, QUESTS, TRAINING, type TrainingMethod } from './catalog.ts';

export type StrategyGoal =
  | { kind: 'level'; skill?: string; level?: number }
  | { kind: 'money'; minutesPerRoute?: number }
  | { kind: 'quest'; quest?: string };

export interface Phase {
  id: string;
  text: string;
  exec: Execution;
  /** Stop the phase once this skill reaches this level. */
  until?: { skill: string; level: number };
  /** Stop the phase after this long (ms), then re-evaluate. */
  maxMs?: number;
}

export interface StrategyDeps {
  account: AccountApi;
  kb?: KnowledgeBase | null;
  bank?: BankMemory;
  /** LLM planner for `llm` executions; null when no API key is configured. */
  llmPlanner?: () => Planner | null;
  /** Runner for `quest` executions; null when questing is unavailable. */
  questPlanner?: (quest: string) => Planner | null;
  onPhase?: (phase: Phase, why: string) => void;
  now?: () => number;
  /** Phase ids to leave out from the start (ones that kept failing in earlier runs). */
  skip?: Iterable<string>;
}

const MELEE = new Set(['Attack', 'Strength', 'Defence', 'Hitpoints']);
/** Skills the "level the account" strategy rotates through (lowest first). */
const ROTATION = ['Melee', 'Ranged', 'Magic', 'Fishing', 'Cooking', 'Woodcutting', 'Mining', 'Smithing', 'Firemaking'];

/** Picks the next phase for a goal; null when nothing fits (or the goal is reached). */
export function choosePhase(goal: StrategyGoal, p: Profile, skip: Set<string>): { phase: Phase; why: string } | { done: string } | null {
  const members = p.account.members;
  const fits = (m: { members: boolean; req?: TrainingMethod['req'] }) => (members || !m.members) && unmet(m.req, p).length === 0;

  if (goal.kind === 'level') {
    const skill = goal.skill ? (MELEE.has(goal.skill) ? 'Melee' : goal.skill) : undefined;
    if (skill && goal.level && level(p, skill) >= goal.level) return { done: `${goal.skill} reached ${goal.level}` };
    const skills = skill ? [skill] : [...ROTATION].sort((a, b) => level(p, a) - level(p, b));
    for (const sk of skills) {
      const lvl = level(p, sk);
      const method = TRAINING.find((m) => m.skill === sk && lvl >= m.from && lvl < m.to && fits(m) && !skip.has(`train:${m.skill}:${m.name}`));
      if (!method) continue;
      const to = goal.level ? Math.min(goal.level, method.to) : method.to;
      const untilSkill = sk === 'Melee' ? 'Strength' : sk;
      return {
        phase: { id: `train:${method.skill}:${method.name}`, text: `train ${sk} with ${method.name} to ${to}`, exec: method.exec, until: { skill: untilSkill, level: to } },
        why: `${sk} is ${lvl}${skill ? '' : ' (lowest trainable)'}; ${method.name} fits levels ${method.from}-${method.to}`,
      };
    }
    return null;
  }

  if (goal.kind === 'money') {
    const route = MONEY.filter((r) => fits(r) && !skip.has(`money:${r.id}`)).sort((a, b) => b.gpHour - a.gpHour)[0];
    if (!route) return null;
    return {
      phase: { id: `money:${route.id}`, text: route.name, exec: route.exec, maxMs: (goal.minutesPerRoute ?? 30) * 60_000 },
      why: `best available route (~${Math.round(route.gpHour / 1000)}k gp/h estimate)`,
    };
  }

  const named = goal.quest ? QUESTS.find((q) => q.name.toLowerCase() === goal.quest!.toLowerCase()) ?? { name: goal.quest, members: false, reward: '' } : undefined;
  const candidates = named ? [named] : QUESTS;
  for (const q of candidates) {
    if (p.account.quests.get(q.name) === 'FINISHED') {
      if (named) return { done: `${q.name} is finished` };
      continue;
    }
    if (skip.has(`quest:${q.name}`) || (q.members && !members)) continue;
    const missing = unmet(q.req, p);
    if (missing.length) continue;
    return { phase: { id: `quest:${q.name}`, text: `complete the quest ${q.name}`, exec: { kind: 'quest', quest: q.name } }, why: q.reward };
  }
  return named ? null : { done: 'no remaining quest is available' };
}

/** Builds the planner that executes a phase; null when it cannot run here (no LLM key, monster not found). */
export function plannerFor(phase: Phase, s: Snapshot, deps: StrategyDeps): Planner | null {
  const e = phase.exec;
  const untilLevel = phase.until?.level;
  switch (e.kind) {
    case 'preset':
      if (COOK_PRESETS[e.preset]) return new CookingPlanner(COOK_PRESETS[e.preset]!, e.preset);
      if (e.preset === 'smith-progression') return new SmithingPlanner({ untilLevel });
      return TaskTreePlanner.fromPreset(e.preset, { bank: e.bank, untilLevel });
    case 'combat': {
      let area = e.area;
      const pos = s.player?.position;
      if (!area && pos && deps.kb) {
        const spawn = deps.kb.nearestSpawns(e.monster, pos, { radius: 1500, limit: 20 }).find((sp) => !inWilderness(sp.point));
        if (spawn) area = { name: `${e.monster} spawn`, point: spawn.point };
      }
      if (!area) return null;
      const task: CombatTask = {
        activity: `kill ${e.monster}s`,
        monsters: [e.monster],
        loot: e.loot ?? ['Coins'],
        keep: [],
        skill: phase.until?.skill ?? 'Strength',
        untilLevel,
        area,
        buryAt: e.bury ? 5 : undefined,
        minFood: 5,
      };
      return new TaskTreePlanner({ kind: 'combat', ...task }, `kill-${e.monster.toLowerCase().replace(/\s+/g, '-')}`);
    }
    case 'llm':
      return deps.llmPlanner?.() ?? null;
    case 'quest':
      return deps.questPlanner?.(e.quest) ?? null;
  }
}

export class StrategyPlanner implements Planner {
  readonly name: string;
  private readonly goal: StrategyGoal;
  private readonly deps: StrategyDeps;
  private readonly bank: BankMemory;
  private readonly now: () => number;
  private readonly skip = new Set<string>();
  private current: { phase: Phase; planner: Planner; startedAt: number; reportsAt: number } | null = null;

  constructor(goal: StrategyGoal, deps: StrategyDeps) {
    this.goal = goal;
    this.deps = deps;
    this.bank = deps.bank ?? new BankMemory();
    this.now = deps.now ?? Date.now;
    this.name = `strategy:${goal.kind}`;
    for (const id of deps.skip ?? []) this.skip.add(id);
  }

  get phase(): Phase | null {
    return this.current?.phase ?? null;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    this.bank.update(ctx.snapshot);
    // Item requirements (tools, keys, supplies) can only be checked once the bank has been seen.
    const survey = this.surveyBank(ctx);
    if (survey) return survey;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.current && this.phaseOver(ctx.snapshot)) this.current = null;
      if (!this.current) {
        const profile = buildProfile(await readAccount(this.deps.account), ctx.snapshot, this.bank);
        const choice = choosePhase(this.goal, profile, this.skip);
        if (!choice) return { kind: 'impossible', reason: `no ${this.goal.kind} activity fits this account right now` };
        if ('done' in choice) return { kind: 'complete', reason: choice.done };
        const planner = plannerFor(choice.phase, ctx.snapshot, this.deps);
        if (!planner) {
          this.skip.add(choice.phase.id);
          this.deps.onPhase?.(choice.phase, 'skipped: cannot run here (needs an LLM key, Quest Helper, or a locatable spawn)');
          continue;
        }
        this.current = { phase: choice.phase, planner, startedAt: this.now(), reportsAt: ctx.reports.length };
        this.deps.onPhase?.(choice.phase, choice.why);
      }
      const cur = this.current;
      // The phase's planner only sees its own history, not the reports of earlier phases.
      const step = await cur.planner.next({ ...ctx, goal: cur.phase.text, reports: ctx.reports.slice(cur.reportsAt) });
      if (step.kind === 'subgoal' || step.kind === 'wait' || step.kind === 'act') return step;
      if (step.kind === 'impossible') {
        this.skip.add(cur.phase.id);
        this.deps.onPhase?.(cur.phase, `gave up: ${step.reason}`);
      }
      this.current = null;
    }
    return { kind: 'impossible', reason: 'no phase could start after several attempts' };
  }

  private surveyBank(ctx: PlannerContext): PlanStep | null {
    const s = ctx.snapshot;
    if (this.bank.seenAt !== null) return null;
    if (s.bank.open) {
      return { kind: 'subgoal', subgoal: { text: 'close the bank', targets: ['Bank'], actions: ['Close'], doneWhen: { bankOpen: false }, isDone: compile({ bankOpen: false }), maxSteps: 5 } };
    }
    const pos = s.player?.position;
    const bank = pos && this.deps.kb ? this.deps.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
    return {
      kind: 'subgoal',
      subgoal: {
        text: `open the ${bank?.name ?? 'nearest bank'} to see what the account owns`,
        targets: ['Bank booth', 'Banker'],
        actions: ['Bank'],
        destination: bank ? { name: bank.name, point: bank.point } : undefined,
        avoid: NOT_BANKS,
        doneWhen: { bankOpen: true },
        isDone: compile({ bankOpen: true }),
        maxSteps: 300,
      },
    };
  }

  private phaseOver(s: Snapshot): boolean {
    const cur = this.current!;
    const u = cur.phase.until;
    if (u && (s.skills.find((k) => k.name === u.skill)?.level ?? 1) >= u.level) return true;
    return cur.phase.maxMs !== undefined && this.now() - cur.startedAt >= cur.phase.maxMs;
  }
}
