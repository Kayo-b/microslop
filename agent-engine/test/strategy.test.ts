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
  ['Attack', 'Strength', 'Defence', 'Hitpoints', 'Fishing', 'Cooking', 'Woodcutting', 'Mining', 'Smithing', 'Firemaking'].map((name) => ({ name, level: levels[name] ?? 1, boosted: levels[name] ?? 1, xp: 0 }));

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
  const s = state({ Attack: 32, Strength: 33, Defence: 24, Hitpoints: 31, Fishing: 20, Cooking: 21, Woodcutting: 8, Mining: 30, Smithing: 23, Firemaking: 9 });
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
