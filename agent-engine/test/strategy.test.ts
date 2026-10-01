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
