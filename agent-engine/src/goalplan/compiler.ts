/**
 * Plan compiler: a plan (target levels, quests, items) plus the live account profile -> an ordered
 * roadmap of milestones, each runnable by one strategy phase.
 *
 * The roadmap is built greedily by simulation: pick the next milestone for the simulated account,
 * apply its effect (levels, quest, item, coins), repeat. The first milestone is therefore always
 * runnable now, so the executor recompiles after every phase and never needs saved progress:
 * a crash, restart or failed phase just recompiles from the real account.
 *
 * Order of picks: Tutorial Island; quests whose XP rewards skip early brackets; plan quests/items
 * that can be done now; then the target skill furthest behind (level / target), a few levels at a
 * time so combat stats stay balanced. A training method's requirements (quests, items, skills,
 * coins) become milestones scheduled right before it.
 */
import { TUTORIAL_DONE, type Profile } from '../strategy/account.ts';
import { ACQUIRE, MONEY, QUESTS, TRAINING, type Execution, type QuestInfo, type Requirement, type TrainingMethod } from '../strategy/catalog.ts';
import type { PlanSpec } from './spec.ts';

export type Coverage = 'scripted' | 'quest-helper+llm' | 'llm';

export interface Milestone {
  /** Phase id; also the key failed phases are skipped by. */
  id: string;
  kind: 'tutorial' | 'skill' | 'quest' | 'item' | 'coins';
  text: string;
  exec: Execution;
  why: string;
  /** Estimated hours. */
  hours: number;
  coverage: Coverage;
  until?: { skill: string; level: number };
  /** Coins phases: stop once the account holds this many coins. */
  untilCoins?: number;
}

export interface RoadmapOptions {
  /** Milestone ids to leave out (phases that kept failing). */
  skip?: Set<string>;
  /** Observed XP/hour per milestone id (from the ledger); replaces the catalog estimate. */
  rates?: Map<string, number>;
  /** Stop after this many milestones. Default 500. */
  limit?: number;
}

export interface Roadmap {
  milestones: Milestone[];
  /** Every target, quest and item is reached at the end of the roadmap. */
  complete: boolean;
  /** Goals nothing in the catalog can reach (no method, unknown item, members-only on F2P). */
  blocked: string[];
  hours: number;
}

const MELEE = new Set(['Attack', 'Strength', 'Defence']);
const COMBAT_XP_SKILLS = new Set(['Attack', 'Strength', 'Defence', 'Ranged', 'Magic']);
/** Coins a "has coins" requirement (High Alchemy) asks for before starting. */
const COINS_RESERVE = 10_000;
const MAX_DEPTH = 6;

// ---------------------------------------------------------------------------------------------
// XP table
// ---------------------------------------------------------------------------------------------

const XP_TABLE = (() => {
  const t = [0, 0];
  let points = 0;
  for (let l = 1; l < 99; l++) {
    points += Math.floor(l + 300 * 2 ** (l / 7));
    t.push(Math.floor(points / 4));
  }
  return t;
})();

export function xpForLevel(level: number): number {
  return XP_TABLE[Math.max(1, Math.min(99, level))]!;
}

export function levelForXp(xp: number): number {
  let l = 1;
  while (l < 99 && XP_TABLE[l + 1]! <= xp) l++;
  return l;
}

// ---------------------------------------------------------------------------------------------
// Simulated account
// ---------------------------------------------------------------------------------------------

interface Sim {
  members: boolean;
  tutorial: boolean;
  xp: Map<string, number>;
  quests: Set<string>;
  qp: number;
  /** Lower-case item names owned. */
  owned: Set<string>;
  coins: number;
}

function simulate(p: Profile): Sim {
  const xp = new Map<string, number>();
  for (const [skill, lvl] of p.levels) xp.set(skill, xpForLevel(lvl));
  return {
    members: p.account.members,
    tutorial: (p.account.tutorial ?? TUTORIAL_DONE) >= TUTORIAL_DONE,
    xp,
    quests: new Set([...p.account.quests].filter(([, st]) => st === 'FINISHED').map(([q]) => q)),
    qp: p.account.questPoints,
    owned: new Set([...p.owned].map((o) => o.toLowerCase())),
    coins: p.coins,
  };
}

const lvl = (sim: Sim, skill: string) => (skill === 'Hitpoints' && !sim.xp.has(skill) ? 10 : levelForXp(sim.xp.get(skill) ?? 0));

const meleeLevel = (sim: Sim) => Math.floor((lvl(sim, 'Attack') + lvl(sim, 'Strength') + lvl(sim, 'Defence')) / 3);

/** OSRS combat level formula. */
export function combatLevel(levels: (skill: string) => number): number {
  const base = 0.25 * (levels('Defence') + levels('Hitpoints') + Math.floor(levels('Prayer') / 2));
  const melee = 0.325 * (levels('Attack') + levels('Strength'));
  const range = 0.325 * Math.floor(levels('Ranged') * 1.5);
  const mage = 0.325 * Math.floor(levels('Magic') * 1.5);
  return Math.floor(base + Math.max(melee, range, mage));
}

function addXp(sim: Sim, skill: string, xp: number): void {
  sim.xp.set(skill, (sim.xp.get(skill) ?? xpForLevel(lvl(sim, skill))) + xp);
  // Combat XP also trains Hitpoints at a third of the rate.
  if (COMBAT_XP_SKILLS.has(skill)) sim.xp.set('Hitpoints', (sim.xp.get('Hitpoints') ?? xpForLevel(10)) + xp / 3);
}

// ---------------------------------------------------------------------------------------------
// Requirements -> needs
// ---------------------------------------------------------------------------------------------

type Need =
  | { kind: 'skill'; skill: string; level: number }
  | { kind: 'quest'; quest: QuestInfo }
  | { kind: 'qp'; qp: number }
  | { kind: 'combat'; level: number }
  | { kind: 'item'; item: string }
  | { kind: 'coins'; amount: number };

const methodId = (skill: string, m: TrainingMethod) => `train:${skill}:${m.name}`;
const questId = (q: string) => `quest:${q}`;

/** Unmet parts of a requirement as needs; null when one of them can never be met from here. */
function needsOf(req: Requirement | undefined, sim: Sim, skip: Set<string>, depth: number): Need[] | null {
  if (!req) return [];
  if (depth > MAX_DEPTH) return null;
  const out: Need[] = [];
  for (const [skill, level] of Object.entries(req.skills ?? {})) {
    if (lvl(sim, skill) >= level) continue;
    if (!TRAINING.some((m) => (m.skill === skill || (m.skill === 'Melee' && MELEE.has(skill))) && (sim.members || !m.members))) return null;
    out.push({ kind: 'skill', skill, level });
  }
  for (const name of req.quests ?? []) {
    if (sim.quests.has(name)) continue;
    const q = QUESTS.find((x) => x.name === name);
    if (!q || (q.members && !sim.members) || skip.has(questId(name))) return null;
    if (needsOf(q.req, sim, skip, depth + 1) === null) return null;
    out.push({ kind: 'quest', quest: q });
  }
  if (req.qp && sim.qp < req.qp) out.push({ kind: 'qp', qp: req.qp });
  if (req.combat && combatLevel((s) => lvl(sim, s)) < req.combat) out.push({ kind: 'combat', level: req.combat });
  for (const item of req.items ?? []) {
    if (/^coins$/i.test(item)) {
      if (sim.coins < COINS_RESERVE) out.push({ kind: 'coins', amount: COINS_RESERVE - sim.coins });
      continue;
    }
    if (sim.owned.has(item.toLowerCase())) continue;
    const a = ACQUIRE.find((x) => x.item.toLowerCase() === item.toLowerCase());
    if (!a || (a.members && !sim.members) || skip.has(`acquire:${a.item}`)) return null;
    out.push({ kind: 'item', item: a.item });
  }
  return out;
}

/** The best usable training method for a skill at its current level, with what it still needs. */
function methodFor(skill: string, sim: Sim, skip: Set<string>, depth = 0): { method: TrainingMethod; needs: Need[]; below?: boolean } | null {
  const key = MELEE.has(skill) ? 'Melee' : skill;
  // Melee brackets pick monsters by overall melee strength; a skill far below the others (Defence 1
  // with Attack 60) fights easier monsters.
  const at = key === 'Melee' ? Math.min(meleeLevel(sim), lvl(sim, skill) + 20) : lvl(sim, skill);
  const viable: { method: TrainingMethod; needs: Need[]; below?: boolean }[] = [];
  const lower: { method: TrainingMethod; needs: Need[]; below?: boolean }[] = [];
  for (const m of TRAINING) {
    if (m.skill !== key || at < m.from || (m.members && !sim.members) || skip.has(methodId(skill, m))) continue;
    // A quest that is already finished gives its XP no more.
    if (m.exec.kind === 'quest' && sim.quests.has(m.exec.quest)) continue;
    const needs = needsOf(m.req, sim, skip, depth + 1);
    if (needs === null) continue;
    if (at < m.to) viable.push({ method: m, needs });
    // A finished quest is one-shot XP, not a method to fall back on.
    else if (m.exec.kind !== 'llm' && m.exec.kind !== 'quest') lower.push({ method: m, needs, below: true });
  }
  // Scripted before LLM methods: an LLM bracket method (flesh crawlers behind the Stronghold of
  // Security's question doors) looped at the Gate of War. With no scripted method in the bracket,
  // the best scripted one below it still trains, slower but reliably; LLM methods come last.
  const byXp = (a: { method: TrainingMethod }, b: { method: TrainingMethod }) => (b.method.xpHour ?? 0) - (a.method.xpHour ?? 0);
  const scripted = viable.filter((v) => v.method.exec.kind !== 'llm').sort(byXp);
  return scripted[0] ?? lower.sort((a, b) => b.method.to - a.method.to)[0] ?? viable.sort(byXp)[0] ?? null;
}

function coverageOf(e: Execution): Coverage {
  if (e.kind === 'quest') return 'quest-helper+llm';
  if (e.kind === 'llm') return 'llm';
  return 'scripted';
}

// ---------------------------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------------------------

interface Ctx {
  spec: PlanSpec;
  skip: Set<string>;
  rates: Map<string, number>;
}

function skillMilestone(skill: string, m: TrainingMethod, to: number, sim: Sim, ctx: Ctx, why: string): Milestone {
  const id = methodId(skill, m);
  const from = lvl(sim, skill);
  const rate = ctx.rates.get(id) ?? m.xpHour ?? 10_000;
  let exec = m.exec;
  // Generic combat methods fight with the style of the skill being trained.
  if (exec.kind === 'combat' && (skill === 'Ranged' || skill === 'Magic')) exec = { ...exec, style: skill === 'Ranged' ? 'ranged' : 'magic' };
  return {
    id,
    kind: 'skill',
    text: `train ${skill} ${from} -> ${to} with ${m.name}`,
    exec,
    why,
    hours: (xpForLevel(to) - xpForLevel(from)) / rate,
    coverage: coverageOf(exec),
    until: { skill, level: to },
  };
}

function questMilestone(q: QuestInfo, sim: Sim, why: string): Milestone {
  const exec: Execution = { kind: 'quest', quest: q.name };
  return { id: questId(q.name), kind: 'quest', text: `complete the quest ${q.name}`, exec, why, hours: q.hours ?? (q.members ? 1 : 0.5), coverage: coverageOf(exec) };
}

function coinsMilestone(amount: number, sim: Sim, ctx: Ctx, why: string, depth: number): Milestone | null {
  const routes = MONEY.filter((r) => (sim.members || !r.members) && !ctx.skip.has(`money:${r.id}`) && needsOf(r.req, sim, ctx.skip, depth + 1)?.length === 0);
  const route = routes.sort((a, b) => b.gpHour - a.gpHour)[0];
  if (!route) return null;
  return {
    id: `money:${route.id}`,
    kind: 'coins',
    text: `make ${amount.toLocaleString('en')} coins: ${route.name}`,
    exec: route.exec,
    why,
    hours: amount / route.gpHour,
    coverage: coverageOf(route.exec),
    untilCoins: sim.coins + amount,
  };
}

function itemMilestone(item: string, sim: Sim, ctx: Ctx, why: string, depth: number): Milestone | null {
  const a = ACQUIRE.find((x) => x.item === item)!;
  const cost = Math.ceil(a.price * (a.source.kind === 'ge' ? 1.3 : 1));
  if (cost > sim.coins) return coinsMilestone(cost - sim.coins, sim, ctx, `${item} costs about ${cost} coins`, depth + 1);
  const exec: Execution = { kind: 'acquire', item: a.item, count: 1, source: a.source };
  return { id: `acquire:${a.item}`, kind: 'item', text: `buy a ${a.item}${a.source.kind === 'ge' ? ' at the Grand Exchange' : ` at ${a.source.name}`}`, exec, why, hours: 0.2, coverage: 'scripted' };
}

/** The milestone that works toward a need (possibly a prerequisite of it); null when none can. */
function forNeed(need: Need, sim: Sim, ctx: Ctx, why: string, depth: number): Milestone | null {
  if (depth > MAX_DEPTH) return null;
  switch (need.kind) {
    case 'skill': {
      const pick = methodFor(need.skill, sim, ctx.skip, depth);
      if (!pick) return null;
      if (pick.needs.length) return forNeed(pick.needs[0]!, sim, ctx, `${pick.method.name} needs it`, depth + 1);
      // Melee brackets follow the average melee level, not this skill's, so only the step caps them.
      // A method from below the bracket trains on past its own top.
      const bracketTop = MELEE.has(need.skill) || pick.below ? 99 : pick.method.to;
      const to = Math.min(need.level, bracketTop, lvl(sim, need.skill) + ctx.spec.policy.levelsPerPhase);
      return skillMilestone(need.skill, pick.method, to, sim, ctx, why);
    }
    case 'quest': {
      const needs = needsOf(need.quest.req, sim, ctx.skip, depth + 1);
      if (needs === null) return null;
      if (needs.length) return forNeed(needs[0]!, sim, ctx, `${need.quest.name} needs it`, depth + 1);
      return questMilestone(need.quest, sim, why);
    }
    case 'qp': {
      for (const q of QUESTS) {
        if (sim.quests.has(q.name) || (q.members && !sim.members) || ctx.skip.has(questId(q.name))) continue;
        if (needsOf(q.req, sim, ctx.skip, depth + 1)?.length === 0) return questMilestone(q, sim, `${why} (${need.qp} quest points)`);
      }
      return null;
    }
    case 'combat': {
      const lowest = [...MELEE].sort((a, b) => lvl(sim, a) - lvl(sim, b))[0]!;
      return forNeed({ kind: 'skill', skill: lowest, level: lvl(sim, lowest) + 5 }, sim, ctx, `${why} (combat ${need.level})`, depth + 1);
    }
    case 'item':
      return itemMilestone(need.item, sim, ctx, why, depth);
    case 'coins':
      return coinsMilestone(need.amount, sim, ctx, why, depth);
  }
}

function apply(m: Milestone, sim: Sim): void {
  switch (m.kind) {
    case 'tutorial':
      sim.tutorial = true;
      return;
    case 'skill':
      addXp(sim, m.until!.skill, xpForLevel(m.until!.level) - (sim.xp.get(m.until!.skill) ?? 0));
      return;
    case 'quest': {
      const q = QUESTS.find((x) => questId(x.name) === m.id)!;
      sim.quests.add(q.name);
      sim.qp += 1;
      for (const [skill, xp] of Object.entries(q.boosts ?? {})) addXp(sim, skill, xp);
      return;
    }
    case 'item': {
      const e = m.exec as Extract<Execution, { kind: 'acquire' }>;
      const a = ACQUIRE.find((x) => x.item === e.item)!;
      sim.owned.add(e.item.toLowerCase());
      sim.coins -= Math.ceil(a.price * (a.source.kind === 'ge' ? 1.3 : 1));
      return;
    }
    case 'coins':
      sim.coins = m.untilCoins!;
      return;
  }
}

function goalsMet(spec: PlanSpec, sim: Sim): boolean {
  return (
    Object.entries(spec.targets).every(([skill, level]) => lvl(sim, skill) >= level!) &&
    spec.quests.every((q) => sim.quests.has(q)) &&
    spec.items.every((i) => sim.owned.has(i.toLowerCase()))
  );
}

/** The next milestone for the simulated account; adds goals nothing can reach to `blocked`. */
function pick(sim: Sim, ctx: Ctx, blocked: Set<string>): Milestone | null {
  const { spec } = ctx;
  if (!sim.tutorial) return { id: 'tutorial', kind: 'tutorial', text: 'finish Tutorial Island', exec: { kind: 'tutorial' }, why: 'new account', hours: 0.5, coverage: 'scripted' };

  const targets = Object.entries(spec.targets).filter(([skill, level]) => lvl(sim, skill) < level! && !blocked.has(`skill ${skill}`));

  if (spec.policy.boosterQuests) {
    for (const q of QUESTS) {
      if (!q.boosts || sim.quests.has(q.name) || (q.members && !sim.members) || ctx.skip.has(questId(q.name))) continue;
      // Worth it while the boosted target skills are still in their slow early levels.
      const helps = Object.keys(q.boosts).filter((skill) => targets.some(([t]) => t === skill) && lvl(sim, skill) < 40);
      if (!helps.length || needsOf(q.req, sim, ctx.skip, 0)?.length !== 0) continue;
      return questMilestone(q, sim, `XP reward skips early ${helps.join('/')} training (${Object.entries(q.boosts).map(([s, x]) => `${x.toLocaleString('en')} ${s}`).join(', ')})`);
    }
  }

  const planQuests = spec.quests.filter((q) => !sim.quests.has(q) && !blocked.has(`quest ${q}`));
  const planItems = spec.items.filter((i) => !sim.owned.has(i.toLowerCase()) && !blocked.has(`item ${i}`));
  for (const q of planQuests) {
    const info = QUESTS.find((x) => x.name === q);
    if (info && !ctx.skip.has(questId(q)) && (sim.members || !info.members) && needsOf(info.req, sim, ctx.skip, 0)?.length === 0) return questMilestone(info, sim, 'in the plan');
  }

  // Furthest behind first (level / target); ties keep the plan's order.
  const ranked = targets.map(([skill, level]) => ({ skill, level: level!, ratio: lvl(sim, skill) / level! })).sort((a, b) => a.ratio - b.ratio);
  for (const t of ranked) {
    const m = forNeed({ kind: 'skill', skill: t.skill, level: t.level }, sim, ctx, `${t.skill} ${lvl(sim, t.skill)}/${t.level} is furthest behind`, 0);
    if (m) return m;
    blocked.add(`skill ${t.skill}`);
  }

  for (const q of planQuests) {
    const info = QUESTS.find((x) => x.name === q);
    const m = info && !ctx.skip.has(questId(q)) && (sim.members || !info.members) ? forNeed({ kind: 'quest', quest: info }, sim, ctx, 'in the plan', 0) : null;
    if (m) return m;
    blocked.add(`quest ${q}`);
  }
  for (const i of planItems) {
    const known = ACQUIRE.some((a) => a.item.toLowerCase() === i.toLowerCase() && (sim.members || !a.members));
    const m = known ? forNeed({ kind: 'item', item: ACQUIRE.find((a) => a.item.toLowerCase() === i.toLowerCase())!.item }, sim, ctx, 'in the plan', 0) : null;
    if (m) return m;
    blocked.add(`item ${i}`);
  }
  return null;
}

export function roadmap(spec: PlanSpec, profile: Profile, o: RoadmapOptions = {}): Roadmap {
  const sim = simulate(profile);
  const ctx: Ctx = { spec, skip: o.skip ?? new Set(), rates: o.rates ?? new Map() };
  const blocked = new Set<string>();
  const milestones: Milestone[] = [];
  const limit = o.limit ?? 500;
  while (milestones.length < limit) {
    const m = pick(sim, ctx, blocked);
    if (!m) break;
    milestones.push(m);
    apply(m, sim);
  }
  return { milestones, complete: goalsMet(spec, sim), blocked: [...blocked], hours: milestones.reduce((h, m) => h + m.hours, 0) };
}

/** What to run now: the first milestone, `done` when the plan is reached, null when nothing can progress. */
export function nextMilestone(spec: PlanSpec, profile: Profile, o: RoadmapOptions = {}): Milestone | { done: string } | null {
  const r = roadmap(spec, profile, { ...o, limit: 1 });
  if (r.milestones[0]) return r.milestones[0];
  return r.complete ? { done: `plan "${spec.name}" reached` } : null;
}

/** A fresh account straight off the character creator (for offline dry runs). */
export function freshProfile(members: boolean): Profile {
  return {
    account: { members, questPoints: 0, quests: new Map(), tutorial: 0 },
    levels: new Map([['Hitpoints', 10]]),
    combatLevel: 3,
    owned: new Set(),
    coins: 0,
    bankKnown: false,
  };
}

/**
 * Milestones that meet one requirement (an activity's skills, quests, quest points, combat level,
 * items) from the live account, in order; `blocked` names the parts nothing in the catalog reaches.
 * Used by the prerequisites flow (src/prereq/) before an activity starts.
 */
export function requirementMilestones(req: Requirement, profile: Profile, o: { skip?: Set<string>; limit?: number } = {}): { milestones: Milestone[]; blocked: string[] } {
  const sim = simulate(profile);
  const ctx: Ctx = { spec: { name: 'setup', targets: {}, quests: [], items: [], policy: { boosterQuests: false, levelsPerPhase: 98, llm: { tier1PerHour: 0, tier2PerHour: 0 } } }, skip: o.skip ?? new Set(), rates: new Map() };
  const milestones: Milestone[] = [];
  for (let i = 0; i < (o.limit ?? 20); i++) {
    const needs = needsOf(req, sim, ctx.skip, 0);
    if (needs === null) return { milestones, blocked: [describeReq(req)] };
    if (!needs.length) return { milestones, blocked: [] };
    const m = forNeed(needs[0]!, sim, ctx, 'activity prerequisite', 0);
    if (!m) return { milestones, blocked: [describeNeed(needs[0]!)] };
    milestones.push(m);
    apply(m, sim);
  }
  return { milestones, blocked: ['too many prerequisite steps'] };
}

function describeNeed(n: Need): string {
  switch (n.kind) {
    case 'skill':
      return `${n.skill} ${n.level}`;
    case 'quest':
      return `quest ${n.quest.name}`;
    case 'qp':
      return `${n.qp} quest points`;
    case 'combat':
      return `combat ${n.level}`;
    case 'item':
      return `item ${n.item}`;
    case 'coins':
      return `${n.amount} coins`;
  }
}

function describeReq(r: Requirement): string {
  return [
    ...Object.entries(r.skills ?? {}).map(([s, l]) => `${s} ${l}`),
    ...(r.quests ?? []).map((q) => `quest ${q}`),
    ...(r.items ?? []).map((i) => `item ${i}`),
    r.qp ? `${r.qp} quest points` : '',
    r.combat ? `combat ${r.combat}` : '',
  ].filter(Boolean).join(', ') || 'requirement';
}
