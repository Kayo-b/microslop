import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { BankMemory, buildProfile, type Account } from '../src/strategy/account.ts';
import { choosePhase, StrategyPlanner } from '../src/strategy/StrategyPlanner.ts';
import { QuestPlanner } from '../src/strategy/QuestPlanner.ts';
import type { Planner, PlannerContext } from '../src/planner/types.ts';
import type { Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const tmp = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : '/tmp';
const skills = (levels: Record<string, number>) =>
  ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Magic', 'Fishing', 'Cooking', 'Woodcutting', 'Mining', 'Smithing', 'Firemaking'].map((name) => ({ name, level: levels[name] ?? 1, boosted: levels[name] ?? 1, xp: 0 }));

function state(levels: Record<string, number>, extra: Partial<Snapshot> = {}): Snapshot {
  const s = snapshot(extra);
  s.skills = skills(levels) as never;
  return s;
}

function account(members = false, finished: string[] = [], qp = 0): Account {
  return { members, questPoints: qp, quests: new Map(finished.map((q) => [q, 'FINISHED'])) };
}

function bankWith(items: string[]): BankMemory {
  const b = new BankMemory(path.join(tmp, `bank-${Math.random()}.json`));
  b.items = new Map(items.map((n) => [n, 1]));
  b.seenAt = 'test';
  return b;
}

test('strategy level: rotates to the lowest trainable skill; a named skill uses its bracket', () => {
  const s = state({ Attack: 32, Strength: 33, Defence: 24, Hitpoints: 31, Ranged: 20, Magic: 20, Fishing: 20, Cooking: 21, Woodcutting: 8, Mining: 30, Smithing: 23, Firemaking: 9 });
  const p = buildProfile(account(), s, bankWith(['Tinderbox']));
  const any = choosePhase({ kind: 'level' }, p, new Set());
  assert.ok(any && 'phase' in any && /Woodcutting/.test(any.phase.text) && any.phase.until?.level === 15, JSON.stringify(any));

  const fish = choosePhase({ kind: 'level', skill: 'Fishing', level: 30 }, p, new Set());
  assert.ok(fish === null, 'fly fishing needs a rod and feathers the account does not own');
  const withRod = buildProfile(account(), s, bankWith(['Fly fishing rod', 'Feather']));
  const fly = choosePhase({ kind: 'level', skill: 'Fishing', level: 30 }, withRod, new Set());
  assert.ok(fly && 'phase' in fly && fly.phase.exec.kind === 'preset' && fly.phase.until?.level === 30);

  const reached = choosePhase({ kind: 'level', skill: 'Mining', level: 30 }, p, new Set());
  assert.ok(reached && 'done' in reached);
});

test('strategy money and quest: membership, requirements and finished quests are respected', () => {
  const s = state({ Mining: 20 });
  const f2p = buildProfile(account(false, ["Cook's Assistant"]), s, bankWith([]));
  const money = choosePhase({ kind: 'money' }, f2p, new Set(['money:tan-hides']));
  assert.ok(money && 'phase' in money && money.phase.id === 'money:iron-ore' && money.phase.maxMs, JSON.stringify(money));

  const quest = choosePhase({ kind: 'quest' }, f2p, new Set());
  assert.ok(quest && 'phase' in quest && quest.phase.id === 'quest:Sheep Shearer', 'first unfinished quest in order');
  const members = choosePhase({ kind: 'quest', quest: 'Waterfall Quest' }, f2p, new Set());
  assert.equal(members, null, 'members quest on a free account');
});

test('strategy gold: sells banked goods once an hour, then rotates through routes least recently run first', () => {
  const s = state({ Mining: 20, Attack: 30, Strength: 30, Defence: 20 }, { player: { ...snapshot().player!, combatLevel: 35 } });
  const p = buildProfile(account(false), s, bankWith(['Coins', 'Iron dagger', 'Shears']));
  const sell = choosePhase({ kind: 'gold' }, p, new Set());
  assert.ok(sell && 'phase' in sell && sell.phase.id === 'gold:sell' && sell.phase.exec.kind === 'sell' && sell.phase.exec.items.includes('Iron dagger'), JSON.stringify(sell));

  // Gear smithing just ran (it alternates with the routes; tested below).
  const lastRun = new Map([['sell', Date.now()], ['tan-hides', Date.now()], ['gear', Date.now() + 3_600_000]]);
  const first = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(first && 'phase' in first && first.phase.id === 'gold:string-amulets', 'untried routes first, best estimate among them');
  lastRun.set('iron-ore', Date.now()).set('string-amulets', Date.now()).set('cowhides', Date.now()).set('feathers', Date.now()).set('guard-coins', Date.now());
  const wool = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(wool && 'phase' in wool && wool.phase.id === 'gold:wool' && wool.phase.text.startsWith('take shears'), 'llm routes run with their full goal');

  // Every fitting route tried: the oldest comes round again.
  const order = ['cowhides', 'iron-ore', 'string-amulets', 'feathers', 'guard-coins', 'wool', 'pickpocket-men'];
  order.forEach((id, i) => lastRun.set(id, Date.now() - (order.length - i) * 60_000));
  const again = choosePhase({ kind: 'gold', lastRun }, p, new Set(['gold:cowhides']));
  assert.ok(again && 'phase' in again && again.phase.id === 'gold:iron-ore', JSON.stringify(again));
});

test('strategy gold: a fight below its recommended levels trains the weakest skill in its turn', () => {
  const s = state({ Attack: 40, Strength: 33, Defence: 24, Hitpoints: 35 }, { player: { ...snapshot().player!, combatLevel: 42 } });
  const p = buildProfile(account(false), s, bankWith(['Coins']));
  const lastRun = new Map<string, number>([['sell', Date.now()], ['tan-hides', Date.now()], ['string-amulets', Date.now()], ['gear', Date.now() + 3_600_000]]);
  const moss = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(moss && 'phase' in moss && moss.phase.id === 'gold:moss-giants:train', JSON.stringify(moss));
  assert.deepEqual(moss.phase.until, { skill: 'Defence', level: 30 }, 'largest gap first, capped at its bracket');
  assert.ok(moss.phase.exec.kind === 'preset' && moss.phase.exec.preset === 'kill-barbarians', 'bracketed by Defence 24, not the melee average');

  const strong = buildProfile(account(false), state({ Attack: 45, Strength: 45, Defence: 40, Hitpoints: 45 }, { player: { ...snapshot().player!, combatLevel: 50 } }), bankWith(['Coins']));
  const fight = choosePhase({ kind: 'gold', lastRun }, strong, new Set());
  assert.ok(fight && 'phase' in fight && fight.phase.id === 'gold:moss-giants' && fight.phase.exec.kind === 'combat' && fight.phase.exec.food === 15, JSON.stringify(fight));
});

test('strategy gold: a route whose sub-goals keep failing gives way to the next route', async () => {
  const api = { varp: async () => 0, questStates: async () => [] };
  const s = state({ Attack: 20, Strength: 20, Defence: 20 }, { player: { ...snapshot().player!, combatLevel: 25 } });
  const log: string[] = [];
  // Only harmless combat routes fit (no coins, no levels), both with a fixed area.
  const lastRun = new Map<string, number>([['sell', Date.now()]]);
  const llm: Planner = { name: 'llm-stub', next: async () => ({ kind: 'wait', ms: 600, reason: 'stub' }) as never };
  const planner = new StrategyPlanner({ kind: 'gold', lastRun }, { account: api, bank: bankWith(['Bronze sword']), llmPlanner: () => llm, onPhase: (p, why) => log.push(`${p.id}: ${why}`) });
  const ctx: PlannerContext = { goal: 'gold', snapshot: s, kb: null, reports: [] };
  await planner.next(ctx);
  const first = planner.phase!.id;
  const blocked = { subgoal: 'x', result: 'blocked' as const, reason: 'offer_failed', steps: 1, trail: [] };
  await planner.next({ ...ctx, reports: [blocked, blocked, blocked] });
  assert.ok(log.some((l) => l.startsWith(`${first}: gave up: 3 sub-goals`)), log.join('\n'));
  assert.ok(planner.phase && planner.phase.id !== first, `moved on from ${first}: ${planner.phase?.id}`);
});

test('strategy gold: gear is smithed every other turn until the steel platebody, never bought', () => {
  const s = state({ Attack: 40, Strength: 33, Defence: 28 }, { player: { ...snapshot().player!, combatLevel: 42 } });
  s.skills.push({ name: 'Smithing', level: 24, boosted: 24, xp: 0 } as never);
  const p = buildProfile(account(false), s, bankWith(['Coins']));
  const keep = choosePhase({ kind: 'gold' }, buildProfile(account(false), s, bankWith(['Coins', 'Iron ore', 'Iron dagger'])), new Set());
  assert.ok(keep && 'phase' in keep && keep.phase.exec.kind === 'sell' && keep.phase.exec.items.join() === 'Iron dagger', 'ore is kept for smithing');
  const lastRun = new Map<string, number>([['sell', Date.now()]]);
  const gear = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(gear && 'phase' in gear && gear.phase.id === 'gold:gear' && gear.phase.exec.kind === 'preset' && gear.phase.exec.preset === 'smith-progression', JSON.stringify(gear));

  lastRun.set('gear', Date.now());
  const route = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(route && 'phase' in route && route.phase.id !== 'gold:gear', 'a money route next');
  lastRun.set((route as { phase: { id: string } }).phase.id.split(':')[1]!, Date.now() + 1);
  const again = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(again && 'phase' in again && again.phase.id === 'gold:gear', 'then gear again');

  s.skills = s.skills.map((k) => (k.name === 'Smithing' ? { ...k, level: 48 } : k));
  const after = choosePhase({ kind: 'gold', lastRun: new Map([['sell', Date.now()]]) }, buildProfile(account(false), s, bankWith(['Coins', 'Steel platebody'])), new Set());
  assert.ok(after && 'phase' in after && after.phase.id !== 'gold:gear', 'steel platebody made: no more gear phases');
});

test('strategy gold: training falls back to a scripted method below the bracket, never the Stronghold', () => {
  const s = state({ Attack: 40, Strength: 33, Defence: 31, Hitpoints: 36 }, { player: { ...snapshot().player!, combatLevel: 43 } });
  const p = buildProfile(account(false), s, bankWith(['Coins']));
  const lastRun = new Map<string, number>([['sell', Date.now()], ['tan-hides', Date.now()], ['gear', Date.now() + 3_600_000], ['string-amulets', Date.now()]]);
  const moss = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(moss && 'phase' in moss && moss.phase.id === 'gold:moss-giants:train', JSON.stringify(moss));
  assert.ok(moss.phase.exec.kind === 'preset' && moss.phase.exec.preset === 'kill-barbarians', JSON.stringify(moss.phase.exec));
  assert.deepEqual(moss.phase.until, { skill: 'Strength', level: 40 });
});

test('strategy gold: hides already bought are tanned before the rotation moves on', () => {
  const s = state({ Attack: 40, Strength: 33, Defence: 30, Mining: 36 }, { player: { ...snapshot().player!, combatLevel: 43 } });
  const p = buildProfile(account(false), s, bankWith(['Coins', 'Cowhide']));
  const lastRun = new Map<string, number>([['sell', Date.now()], ['gear', Date.now() + 3_600_000], ['tan-hides', Date.now() - 60_000]]);
  const tan = choosePhase({ kind: 'gold', lastRun }, p, new Set());
  assert.ok(tan && 'phase' in tan && tan.phase.id === 'gold:tan-hides' && /Cowhide already bought/.test(tan.why), JSON.stringify(tan));
});

test('strategy gold: a phase that buys stock logs a coin loss but no worth loss', async () => {
  const api = { varp: async () => 0, questStates: async () => [] };
  const ends: { coins: number; worth?: number }[] = [];
  const bank = bankWith([]);
  bank.items = new Map();
  let now = 0;
  const stub: Planner = { name: 'stub', next: async () => ({ kind: 'wait', reason: 'x', until: {}, maxSeconds: 1 }) as never };
  const planner = new StrategyPlanner({ kind: 'gold', lastRun: new Map([['sell', Date.now()]]) }, {
    account: api, bank, gePrice: (n) => (n === 'Cowhide' ? 130 : null), llmPlanner: () => stub, now: () => now,
    onPhaseEnd: (_p, e) => ends.push(e),
  });
  const s0 = state({ Attack: 20 }, { inventory: { freeSlots: 27, items: [item(0, 995, 'Coins', { quantity: 13_000, stackable: true })] } });
  await planner.next({ goal: 'g', snapshot: s0, kb: null, reports: [] });
  now = 30 * 60_000;
  const s1 = state({ Attack: 20 }, { inventory: { freeSlots: 27, items: [item(0, 1740, 'Cowhide', { quantity: 100, noted: true, stackable: true })] } });
  await planner.next({ goal: 'g', snapshot: s1, kb: null, reports: [] });
  assert.deepEqual(ends[0] && { coins: ends[0].coins, worth: ends[0].worth }, { coins: -13_000, worth: 0 });
});

test('strategy planner: surveys the bank first, skips phases that cannot run, gives up when nothing fits', async () => {
  const api = { varp: async (id: number) => (id === 101 ? 2 : 0), questStates: async () => [] };
  const phases: string[] = [];
  const s = state({ Woodcutting: 8, Mining: 30, Attack: 32, Strength: 33, Defence: 24, Fishing: 20, Cooking: 21, Smithing: 23, Firemaking: 9 });
  const ctx: PlannerContext = { goal: 'x', snapshot: s, kb: null, reports: [] };

  const fresh = new BankMemory(path.join(tmp, `bank-${Math.random()}.json`));
  const surveying = new StrategyPlanner({ kind: 'level' }, { account: api, bank: fresh });
  const first = await surveying.next(ctx);
  assert.ok(first.kind === 'subgoal' && first.subgoal.doneWhen?.bankOpen === true);

  // Level goal for Firemaking: only an LLM method exists, and there is no LLM here.
  const planner = new StrategyPlanner({ kind: 'level', skill: 'Firemaking' }, { account: api, bank: bankWith(['Tinderbox', 'Logs']), onPhase: (p, why) => phases.push(`${p.id}: ${why}`) });
  const step = await planner.next(ctx);
  assert.equal(step.kind, 'impossible');
  assert.ok(phases.some((p) => /skipped/.test(p)));
});

test('quest planner: selects the quest in Quest Helper and plans toward its current step', async () => {
  const calls: string[] = [];
  let selected = false;
  const api = {
    questHelperStatus: async () => (selected ? { selected, questName: "Cook's Assistant", completed: false, stepText: 'Talk to the Cook in Lumbridge Castle.' } : { selected: false }),
    questHelperStart: async (n: string) => {
      calls.push(n);
      selected = true;
    },
  };
  let seenGoal = '';
  const llm: Planner = { name: 'llm', next: async (c) => ((seenGoal = c.goal), { kind: 'subgoal', subgoal: { text: 'talk to the Cook', targets: ['Cook'], actions: ['Talk-to'] } }) };
  const q = new QuestPlanner("Cook's Assistant", api, llm);
  const step = await q.next({ goal: 'g', snapshot: snapshot({ inventory: { freeSlots: 27, items: [item(0, 1931, 'Pot')] } }), kb: null, reports: [] });
  assert.deepEqual(calls, ["Cook's Assistant"]);
  assert.ok(step.kind === 'subgoal' && /Talk to the Cook in Lumbridge Castle/.test(seenGoal));
});

test('quest planner waits for Quest Helper to produce the first step after starting a quest', async () => {
  let polls = 0;
  const api = {
    questHelperStatus: async () => (polls++ < 3 ? { selected: true, questName: 'Demon Slayer', completed: false } : { selected: true, questName: 'Demon Slayer', completed: false, stepText: 'Talk to the Gypsy in Varrock.' }),
    questHelperStart: async () => {},
  };
  const llm: Planner = { name: 'llm', next: async () => ({ kind: 'subgoal', subgoal: { text: 'talk to the Gypsy', targets: ['Gypsy Aris'], actions: ['Talk-to'] } }) };
  const q = new QuestPlanner('Demon Slayer', { ...api, questHelperStatus: async () => (polls === 0 ? (polls++, { selected: false }) : api.questHelperStatus()) }, llm, 1);
  const step = await q.next({ goal: 'g', snapshot: snapshot(), kb: null, reports: [] });
  assert.equal(step.kind, 'subgoal');
});

test('quest planner gives an unresolvable destination the Quest Helper step location', async () => {
  const at = { x: 3212, y: 3246, plane: 0 };
  const api = {
    questHelperStatus: async () => ({ selected: true, questName: "Cook's Assistant", completed: false, stepText: ['Purchase a bucket from the Lumbridge General Store.'], stepPoint: at }),
    questHelperStart: async () => {},
  };
  let prompt = '';
  const llm: Planner = { name: 'llm', next: async (c) => ((prompt = c.goal), { kind: 'subgoal', subgoal: { text: 'buy a bucket', targets: ['Shop keeper'], actions: ['Trade'], destination: { name: 'Lumbridge General Store' } } }) };
  const kb = { findPlaces: () => [] } as never;
  const step = await new QuestPlanner("Cook's Assistant", api, llm, 1).next({ goal: 'g', snapshot: snapshot(), kb, reports: [] });
  assert.ok(/3212, 3246/.test(prompt));
  assert.ok(step.kind === 'subgoal' && step.subgoal.destination?.point?.x === 3212);
});

test('quest planner rests to 80% HP before a step when low and without food', async () => {
  const api = { questHelperStatus: async () => ({ selected: true, questName: 'Imp Catcher', completed: false, stepText: 'Kill imps' }), questHelperStart: async () => {} };
  const llm: Planner = { name: 'llm', next: async () => ({ kind: 'subgoal', subgoal: { text: 'kill imps', targets: ['Imp'] } }) };
  const s = snapshot({ inventory: { freeSlots: 28, items: [] } });
  s.player = { ...s.player!, hp: { current: 8, max: 33 } } as never;
  const step = await new QuestPlanner('Imp Catcher', api, llm, 1).next({ goal: 'g', snapshot: s, kb: null, reports: [] });
  assert.ok(step.kind === 'wait' && step.until.hpAtLeast === 0.8);
});
