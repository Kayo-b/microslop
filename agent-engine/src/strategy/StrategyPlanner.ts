/**
 * Strategy layer: turns a long-term goal ("level the account", "make money", "do quests") into a
 * sequence of phases, each run by a scripted planner (or the LLM/quest runner where nothing is
 * scripted yet). A phase ends when its planner completes, gives up, reaches its level bracket or
 * runs out of time; then the strategy picks the next phase from the catalog and the live profile.
 */
import { AcquirePlanner } from '../goalplan/AcquirePlanner.ts';
import { SellPlanner } from '../goalplan/SellPlanner.ts';
import { SmeltingPlanner } from '../goalplan/SmeltingPlanner.ts';
import { StringingPlanner } from '../goalplan/StringingPlanner.ts';
import { TanningPlanner } from '../goalplan/TanningPlanner.ts';
import { nextMilestone } from '../goalplan/compiler.ts';
import type { PlanSpec } from '../goalplan/spec.ts';
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import { COOK_PRESETS, CookingPlanner } from '../planner/CookingPlanner.ts';
import { LAST_GEAR_LEVEL, SmithingPlanner } from '../planner/SmithingPlanner.ts';
import { compile } from '../planner/conditions.ts';
import { NOT_BANKS, TaskTreePlanner, type CombatTask } from '../planner/TaskTreePlanner.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';
import { type AccountApi, BankMemory, buildProfile, level, type Profile, readAccount, TUTORIAL_DONE, unmet, VARP_TUTORIAL } from './account.ts';
import { ACQUIRE, type Execution, GOLD, inWilderness, JUNK, MONEY, QUESTS, TRAINING, type TrainingMethod } from './catalog.ts';

export type StrategyGoal =
  | { kind: 'level'; skill?: string; level?: number }
  | { kind: 'money'; minutesPerRoute?: number }
  /**
   * Make coins by alternating between every route that fits, least recently run first.
   * `lastRun` (route id -> epoch ms) carries the rotation across agent runs; the strategy
   * updates it as phases start.
   */
  | { kind: 'gold'; minutesPerRoute?: number; lastRun?: Map<string, number> }
  | { kind: 'quest'; quest?: string }
  /** A plan file compiled into milestones (see goalplan/compiler.ts). */
  | { kind: 'plan'; spec: PlanSpec; rates?: Map<string, number> };

export interface Phase {
  id: string;
  text: string;
  exec: Execution;
  /** Stop the phase once this skill reaches this level. */
  until?: { skill: string; level: number };
  /** Stop the phase after this long (ms), then re-evaluate. */
  maxMs?: number;
  /** Stop once the account holds this many coins (carried + banked). */
  untilCoins?: number;
}

export interface PhaseEnd {
  /** done: its planner completed or the phase target was reached; gave_up: impossible; over: time ran out. */
  outcome: 'done' | 'gave_up' | 'over';
  reason: string;
  minutes: number;
  /** XP gained per skill during the phase. */
  xp: Record<string, number>;
  /** Change in coins carried plus coins last seen banked over the phase. */
  coins: number;
  /**
   * Change in total worth: coins plus every carried and last-seen-banked item at its GE price.
   * Unlike `coins`, buying stock for a trading loop is not a loss. Absent without GE prices.
   */
  worth?: number;
}

export interface StrategyDeps {
  account: AccountApi;
  kb?: KnowledgeBase | null;
  bank?: BankMemory;
  /** LLM planner for `llm` executions; null when no API key is configured. */
  llmPlanner?: () => Planner | null;
  /** Runner for `quest` executions; null when questing is unavailable. */
  questPlanner?: (quest: string) => Planner | null;
  /** Runner for the `tutorial` execution; null when unavailable. */
  tutorialPlanner?: () => Planner | null;
  onPhase?: (phase: Phase, why: string) => void;
  onPhaseEnd?: (phase: Phase, end: PhaseEnd) => void;
  now?: () => number;
  /** Phase ids to leave out from the start (ones that kept failing in earlier runs). */
  skip?: Iterable<string>;
  /**
   * Wraps each phase's planner so its prerequisites (tools, gear, food, coins, levels) are met
   * first; see src/prereq/. Returns the planner unchanged when the phase has nothing to check.
   */
  prereq?: (phase: Phase, planner: Planner) => Planner;
  /** Grand Exchange prices, for scripted trading loops (tanning). */
  gePrice?: (item: string) => number | null;
}

const MELEE = new Set(['Attack', 'Strength', 'Defence', 'Hitpoints']);
/** Skills the "level the account" strategy rotates through (lowest first). */
const ROTATION = ['Melee', 'Ranged', 'Magic', 'Fishing', 'Cooking', 'Woodcutting', 'Mining', 'Smithing', 'Firemaking'];

/** Picks the next phase for a goal; null when nothing fits (or the goal is reached). */
export function choosePhase(goal: StrategyGoal, p: Profile, skip: Set<string>): { phase: Phase; why: string } | { done: string } | null {
  if (goal.kind === 'plan') {
    const m = nextMilestone(goal.spec, p, { skip, rates: goal.rates });
    if (!m || 'done' in m) return m;
    return { phase: { id: m.id, text: m.text, exec: m.exec, until: m.until, untilCoins: m.untilCoins }, why: `${m.why} [${m.coverage}, ~${m.hours.toFixed(1)} h]` };
  }
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
    // Products earlier money phases banked are only worth something once sold.
    const products = [...new Set(MONEY.flatMap((r) => r.products))].filter((n) => p.owned.has(n));
    if (products.length && !skip.has('sell:products')) {
      return { phase: { id: 'sell:products', text: `sell the ${products.join(', ')} on the Grand Exchange`, exec: { kind: 'sell', items: products } }, why: 'banked products from earlier money phases' };
    }
    const route = MONEY.filter((r) => fits(r) && !skip.has(`money:${r.id}`)).sort((a, b) => b.gpHour - a.gpHour)[0];
    if (!route) return null;
    return {
      phase: { id: `money:${route.id}`, text: route.name, exec: route.exec, maxMs: (goal.minutesPerRoute ?? 30) * 60_000 },
      why: `best available route (~${Math.round(route.gpHour / 1000)}k gp/h estimate)`,
    };
  }

  if (goal.kind === 'gold') {
    const last = goal.lastRun ?? new Map<string, number>();
    const gearDue = level(p, 'Smithing') < LAST_GEAR_LEVEL || !p.owned.has('Steel platebody');
    // At most one sell phase an hour: an item the GE refuses stays "owned" and would loop. Ores,
    // coal and bars stay while gear is still being smithed.
    // Cowhides are tanned (tan-hides), not sold raw.
    const sellable = [...new Set([...GOLD.flatMap((r) => r.products), ...JUNK])].filter((n) => p.owned.has(n) && n !== 'Cowhide' && !(gearDue && SMITHING_MATERIALS.has(n)));
    if (sellable.length && !skip.has('gold:sell') && Date.now() - (last.get('sell') ?? 0) > 3_600_000) {
      return { phase: { id: 'gold:sell', text: `sell the ${sellable.join(', ')} on the Grand Exchange`, exec: { kind: 'sell', items: sellable } }, why: 'banked items are only worth something once sold' };
    }
    // Stock bought for a trading loop (hides, unstrung amulets) is coins tied up: that loop runs
    // before the rotation moves on (the rotation once went mining with ~250 hides in the bank).
    const STOCK: [string, string[]][] = [['tan-hides', ['Cowhide']], ['string-amulets', AMULET_INPUTS]];
    for (const [id, items] of STOCK) {
      const r = GOLD.find((x) => x.id === id);
      if (r && fits(r) && !skip.has(`gold:${id}`) && items.some((n) => p.owned.has(n))) {
        return { phase: { id: `gold:${id}`, text: r.name, exec: r.exec, maxMs: (goal.minutesPerRoute ?? 25) * 60_000 }, why: `finish the ${items.filter((n) => p.owned.has(n)).join(', ')} already bought` };
      }
    }
    // Coins are for making more coins: gear is smithed, not bought. Until the steel platebody is
    // made, every other turn levels Smithing and smiths (and wears) each piece it unlocks.
    const lastRoute = Math.max(0, ...[...last].filter(([id]) => id !== 'gear' && id !== 'sell').map(([, t]) => t));
    if (gearDue && !skip.has('gold:gear') && (last.get('gear') ?? 0) <= lastRoute) {
      return {
        phase: { id: 'gold:gear', text: 'level Smithing and smith the next tier of gear, wearing each piece as it is made', exec: { kind: 'preset', preset: 'smith-progression' }, maxMs: (goal.minutesPerRoute ?? 25) * 60_000 },
        why: `Smithing ${level(p, 'Smithing')}: gear is smithed up to the steel platebody (${LAST_GEAR_LEVEL}) instead of bought`,
      };
    }
    const route = GOLD.filter((r) => fits(r) && !skip.has(`gold:${r.id}`))
      .sort((a, b) => (last.get(a.id) ?? 0) - (last.get(b.id) ?? 0) || b.gpHour - a.gpHour)[0];
    if (!route) return null;
    const ran = last.get(route.id);
    const training = route.recommend && trainFor(route.id, route.recommend, p, fits, skip);
    if (training) return training;
    return {
      phase: { id: `gold:${route.id}`, text: route.exec.kind === 'llm' ? route.exec.goal : route.name, exec: route.exec, maxMs: (goal.minutesPerRoute ?? 25) * 60_000 },
      why: `${ran ? `least recently run (last ${new Date(ran).toISOString().slice(0, 16)})` : 'not tried yet'}; ~${Math.round(route.gpHour / 1000)}k gp/h estimate`,
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

/**
 * A fight below its recommended levels: the route's turn trains the weakest short skill instead,
 * with the bracket's melee method (gear and food are checked by the prerequisite flow like any
 * fight). Null when the levels are met or no method fits.
 */
function trainFor(routeId: string, recommend: Record<string, number>, p: Profile, fits: (m: TrainingMethod) => boolean, skip: Set<string>): { phase: Phase; why: string } | null {
  const short = Object.entries(recommend).filter(([sk, lvl]) => level(p, sk) < lvl).sort(([a, x], [b, y]) => level(p, a) - x - (level(p, b) - y));
  const [skill, target] = short[0] ?? [];
  if (!skill || !target) return null;
  // Bracket by the trained skill's own level: Defence 24 trains on barbarians even with Attack 40.
  const lvl = level(p, skill);
  // Scripted methods only: an LLM method in the bracket (flesh crawlers behind the Stronghold of
  // Security's question doors) looped at the Gate of War. With none in the bracket, the best
  // scripted one below it still trains (barbarians at Strength 33), slower but surely.
  const usable = TRAINING.filter((m) => m.skill === (MELEE.has(skill) ? 'Melee' : skill) && m.exec.kind !== 'llm' && lvl >= m.from && fits(m) && !skip.has(`train:${m.skill}:${m.name}`));
  const method = usable.find((m) => lvl < m.to) ?? usable.sort((a, b) => b.to - a.to)[0];
  if (!method) return null;
  const to = lvl < method.to ? Math.min(target, method.to) : target;
  const gaps = short.map(([sk, l]) => `${sk} ${level(p, sk)}/${l}`).join(', ');
  const text = `train ${skill} to ${to} before ${routeId}`;
  return {
    phase: {
      id: `gold:${routeId}:train`,
      text: method.exec.kind === 'llm' ? `${method.exec.goal}; use the ${skill} attack style and stop at ${skill} ${to}` : `${text} with ${method.name}`,
      exec: method.exec,
      until: { skill, level: to },
      maxMs: 25 * 60_000,
    },
    why: `${routeId} is below its recommended levels (${gaps})`,
  };
}

/** Builds the planner that executes a phase; null when it cannot run here (no LLM key, monster not found). */
export function plannerFor(phase: Phase, s: Snapshot, deps: StrategyDeps): Planner | null {
  const e = phase.exec;
  const untilLevel = phase.until?.level;
  switch (e.kind) {
    case 'preset':
      if (COOK_PRESETS[e.preset]) return new CookingPlanner(COOK_PRESETS[e.preset]!, e.preset);
      if (e.preset === 'smith-progression') return new SmithingPlanner({ untilLevel });
      if (e.preset === 'tan-hides') {
        const bank = deps.bank;
        return new TanningPlanner({ bank: () => (bank?.seenAt ? bank.items : null), price: deps.gePrice });
      }
      if (e.preset === 'string-amulets') return deps.gePrice ? new StringingPlanner({ price: deps.gePrice }) : null;
      if (e.preset === 'smelt-steel') return new SmeltingPlanner();
      return TaskTreePlanner.fromPreset(e.preset, { bank: e.bank, untilLevel, skill: phase.until?.skill, setStyle: MELEE_TRAINED.has(phase.until?.skill ?? '') });
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
        setStyle: MELEE_TRAINED.has(phase.until?.skill ?? ''),
        style: e.style,
        untilLevel,
        area,
        buryAt: e.bury ? 5 : undefined,
        minFood: e.food ?? 5,
      };
      return new TaskTreePlanner({ kind: 'combat', ...task }, `kill-${e.monster.toLowerCase().replace(/\s+/g, '-')}`);
    }
    case 'llm':
      return deps.llmPlanner?.() ?? null;
    case 'quest':
      return deps.questPlanner?.(e.quest) ?? null;
    case 'tutorial':
      return deps.tutorialPlanner?.() ?? null;
    case 'acquire': {
      const price = e.price ?? ACQUIRE.find((a) => a.item === e.item)?.price ?? 0;
      const bank = deps.bank;
      return new AcquirePlanner({ item: e.item, count: e.count, price, source: e.source, bank: () => (bank?.seenAt ? bank.items : null) });
    }
    case 'sell': {
      const bank = deps.bank;
      return new SellPlanner({ items: e.items, bank: () => (bank?.seenAt ? bank.items : null) });
    }
  }
}

/** Opens the nearest bank once so item requirements can be checked against what the account owns. */
export function surveyBankStep(s: Snapshot, kb: KnowledgeBase | null): PlanStep {
  if (s.bank.open) {
    return { kind: 'subgoal', subgoal: { text: 'close the bank', targets: ['Bank'], actions: ['Close'], doneWhen: { bankOpen: false }, isDone: compile({ bankOpen: false }), maxSteps: 5 } };
  }
  const pos = s.player?.position;
  const bank = pos && kb ? kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
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

/** Unstrung amulets the stringing loop buys. */
const AMULET_INPUTS = ['Gold', 'Sapphire', 'Emerald', 'Ruby', 'Diamond'].map((g) => `${g} amulet (u)`);

/** What smith-progression consumes; not sold while gear is still being smithed. */
const SMITHING_MATERIALS = new Set(['Copper ore', 'Tin ore', 'Iron ore', 'Coal', 'Bronze bar', 'Iron bar', 'Steel bar']);

/** Failed sub-goals in a row after which a gold route gives way to the next. */
export const GOLD_MAX_BLOCKED = 3;

/** Melee skills a phase trains by selecting the matching attack style. */
const MELEE_TRAINED = new Set(['Attack', 'Strength', 'Defence']);

export class StrategyPlanner implements Planner {
  readonly name: string;
  private readonly goal: StrategyGoal;
  private readonly deps: StrategyDeps;
  private readonly bank: BankMemory;
  private readonly now: () => number;
  private readonly skip = new Set<string>();
  private current: { phase: Phase; planner: Planner; startedAt: number; reportsAt: number; xp: Map<string, number>; coins: number; worth: number | null } | null = null;

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
    // Item requirements (tools, keys, supplies) can only be checked once the bank has been seen;
    // on Tutorial Island there is no bank to survey yet.
    const survey = (await this.onTutorialIsland()) ? null : this.surveyBank(ctx);
    if (survey) return survey;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (this.current && this.phaseOver(ctx.snapshot)) this.endPhase(ctx.snapshot, this.reachedTarget(ctx.snapshot) ? 'done' : 'over', 'phase target or time reached');
      if (!this.current) {
        const profile = buildProfile(await readAccount(this.deps.account), ctx.snapshot, this.bank);
        const choice = choosePhase(this.goal, profile, this.skip);
        if (!choice) return { kind: 'impossible', reason: `no ${this.goal.kind} activity fits this account right now` };
        if ('done' in choice) return { kind: 'complete', reason: choice.done };
        const raw = plannerFor(choice.phase, ctx.snapshot, { ...this.deps, bank: this.bank });
        const planner = raw && this.deps.prereq ? this.deps.prereq(choice.phase, raw) : raw;
        if (!planner) {
          this.skip.add(choice.phase.id);
          this.deps.onPhase?.(choice.phase, 'skipped: cannot run here (needs an LLM key, Quest Helper, or a locatable spawn)');
          continue;
        }
        this.current = { phase: choice.phase, planner, startedAt: this.now(), reportsAt: ctx.reports.length, xp: new Map(ctx.snapshot.skills.map((k) => [k.name, k.xp])), coins: this.coins(ctx.snapshot), worth: this.worth(ctx.snapshot) };
        if (this.goal.kind === 'gold') (this.goal.lastRun ??= new Map()).set(choice.phase.id.split(':')[1]!, this.now());
        this.deps.onPhase?.(choice.phase, choice.why);
      }
      const cur = this.current;
      const own = ctx.reports.slice(cur.reportsAt);
      // Gold rotates: a route stuck on the same failure gives way to the next one instead of
      // running into the agent's run-wide limit (which ends every route with it).
      const stuck = own.slice(-GOLD_MAX_BLOCKED);
      if (this.goal.kind === 'gold' && stuck.length === GOLD_MAX_BLOCKED && stuck.every((r) => r.result !== 'done')) {
        this.skip.add(cur.phase.id);
        this.deps.onPhase?.(cur.phase, `gave up: ${GOLD_MAX_BLOCKED} sub-goals in a row failed; last: ${stuck.at(-1)!.reason}`);
        this.endPhase(ctx.snapshot, 'gave_up', 'sub-goals kept failing');
        continue;
      }
      // The phase's planner only sees its own history, not the reports of earlier phases.
      const step = await cur.planner.next({ ...ctx, goal: cur.phase.text, reports: own });
      if (step.kind === 'subgoal' || step.kind === 'wait' || step.kind === 'act') return step;
      if (step.kind === 'impossible') {
        this.skip.add(cur.phase.id);
        this.deps.onPhase?.(cur.phase, `gave up: ${step.reason}`);
      }
      this.endPhase(ctx.snapshot, step.kind === 'impossible' ? 'gave_up' : 'done', step.reason);
    }
    return { kind: 'impossible', reason: 'no phase could start after several attempts' };
  }

  private surveyBank(ctx: PlannerContext): PlanStep | null {
    return this.bank.seenAt !== null ? null : surveyBankStep(ctx.snapshot, this.deps.kb ?? null);
  }

  private tutorialDone = false;

  private async onTutorialIsland(): Promise<boolean> {
    if (this.goal.kind !== 'plan' || this.tutorialDone) return false;
    this.tutorialDone = ((await this.deps.account.varp(VARP_TUTORIAL)) ?? TUTORIAL_DONE) >= TUTORIAL_DONE;
    return !this.tutorialDone;
  }

  private reachedTarget(s: Snapshot): boolean {
    const ph = this.current!.phase;
    const u = ph.until;
    if (u && (s.skills.find((k) => k.name === u.skill)?.level ?? 1) >= u.level) return true;
    if (ph.untilCoins !== undefined && this.coins(s) >= ph.untilCoins) return true;
    return false;
  }

  /** Coins carried plus coins last seen banked. */
  /** Coins plus carried and last-seen-banked items at their GE price; null without prices. */
  private worth(s: Snapshot): number | null {
    const price = this.deps.gePrice;
    if (!price) return null;
    const items = new Map(this.bank.items);
    for (const i of s.inventory.items) items.set(i.name, (items.get(i.name) ?? 0) + i.quantity);
    let total = 0;
    for (const [name, n] of items) total += name === 'Coins' ? n : (price(name) ?? 0) * n;
    return total;
  }

  private coins(s: Snapshot): number {
    const carried = s.inventory.items.filter((i) => i.name === 'Coins').reduce((n, i) => n + i.quantity, 0);
    return carried + (this.bank.items.get('Coins') ?? 0);
  }

  private phaseOver(s: Snapshot): boolean {
    const cur = this.current!;
    return this.reachedTarget(s) || (cur.phase.maxMs !== undefined && this.now() - cur.startedAt >= cur.phase.maxMs);
  }

  private endPhase(s: Snapshot, outcome: PhaseEnd['outcome'], reason: string): void {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const xp: Record<string, number> = {};
    for (const k of s.skills) {
      const gained = k.xp - (cur.xp.get(k.name) ?? k.xp);
      if (gained > 0) xp[k.name] = gained;
    }
    this.deps.onPhaseEnd?.(cur.phase, { outcome, reason, minutes: (this.now() - cur.startedAt) / 60_000, xp, coins: this.coins(s) - cur.coins, ...(cur.worth !== null ? { worth: (this.worth(s) ?? cur.worth) - cur.worth } : {}) });
  }
}
