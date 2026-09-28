import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, type AgentEvent } from '../src/agent/Agent.ts';
import { MicrobotBackend } from '../src/backend/MicrobotBackend.ts';
import { GameIntentEngine } from '../src/engine/GameIntentEngine.ts';
import { escalationPrompt, planToStep, plannerPrompt, toDoneCondition } from '../src/llm/claude.ts';
import { compile, describe, evaluate } from '../src/planner/conditions.ts';
import { nextGatherStep, PRESETS, TaskTreePlanner } from '../src/planner/TaskTreePlanner.ts';
import { FakeGame, startFakeServer } from './support/FakeMicrobotServer.ts';
import { ScriptedDecisionEngine } from './support/ScriptedDecisionEngine.ts';
import { item, snapshot, tree } from './support/fixtures.ts';

const fullOfShrimp = () =>
  snapshot({ inventory: { freeSlots: 0, items: [item(0, 303, 'Small fishing net'), ...Array.from({ length: 27 }, (_, i) => item(i + 1, 317, 'Raw shrimps'))] } });

test('conditions: every clause must hold, empty never completes', () => {
  const s = fullOfShrimp();
  assert.equal(evaluate({ inventoryFull: true }, s), true);
  assert.equal(evaluate({ inventoryFull: true, bankOpen: true }, s), false);
  assert.equal(evaluate({ hasItem: { name: 'raw shr', count: 27 } }, s), true);
  assert.equal(evaluate({ lacksItem: 'Raw shrimps' }, s), false);
  assert.equal(evaluate({ skillLevel: { skill: 'fishing', level: 1 } }, s), true);
  assert.equal(evaluate({ near: { x: 3243, y: 3152, plane: 0 } }, s), true);
  assert.equal(evaluate({}, s), false);
  assert.equal(compile({}), undefined);
  assert.equal(describe({ inventoryFull: true, bankOpen: false }), 'inventory full and bank closed');
});

test('task tree: gather -> bank -> deposit -> close -> gather', () => {
  const task = { ...PRESETS['fish-shrimp']!, bank: true };
  const gather = nextGatherStep(task, snapshot());
  assert.ok(gather.kind === 'subgoal' && gather.subgoal.actions?.includes('Small Net'));
  assert.ok(gather.kind === 'subgoal' && gather.subgoal.isDone!(fullOfShrimp()));

  const toBank = nextGatherStep(task, fullOfShrimp());
  assert.ok(toBank.kind === 'subgoal' && /bank/.test(toBank.subgoal.text) && toBank.subgoal.doneWhen?.bankOpen === true);

  const atBank = fullOfShrimp();
  atBank.bank.open = true;
  const deposit = nextGatherStep(task, atBank);
  assert.ok(deposit.kind === 'subgoal' && deposit.subgoal.doneWhen?.lacksItem === 'Raw');

  const emptied = snapshot({ bank: { open: true, items: [] } });
  const close = nextGatherStep(task, emptied);
  assert.ok(close.kind === 'subgoal' && close.subgoal.doneWhen?.bankOpen === false);

  const drop = nextGatherStep({ ...task, bank: false }, fullOfShrimp());
  assert.ok(drop.kind === 'subgoal' && drop.subgoal.actions?.includes('Drop'));

  const leveled = snapshot();
  leveled.skills.find((s) => s.name === 'Fishing')!.level = 20;
  assert.equal(nextGatherStep({ ...task, untilLevel: 20 }, leveled).kind, 'complete');
});

test('task tree planner gives up after three identical blocked sub-goals', async () => {
  const planner = TaskTreePlanner.fromPreset('chop-trees');
  const r = { subgoal: 'x', result: 'blocked' as const, reason: 'stuck', steps: 3, trail: [] };
  const step = await planner.next({ goal: 'g', snapshot: snapshot(), kb: null, reports: [r, r, r] });
  assert.equal(step.kind, 'impossible');
  assert.throws(() => TaskTreePlanner.fromPreset('nope'), /Unknown task preset/);
});

test('claude plan conversion keeps only the provided done clauses', () => {
  const nulls = { inventory_full: null, has_item: null, lacks_item: null, bank_open: null, skill_level: null, near: null };
  assert.deepEqual(toDoneCondition({ ...nulls, bank_open: true }), { bankOpen: true });
  const step = planToStep({
    status: 'continue',
    reasoning: 'need logs',
    subgoal: { text: 'chop oaks', targets: ['Oak tree'], actions: ['Chop down'], destination_name: 'Draynor Village', keep_items: ['axe'], done_when: { ...nulls, inventory_full: true }, max_steps: 9999 },
  });
  assert.ok(step.kind === 'subgoal');
  assert.equal(step.subgoal.maxSteps, 600, 'step budget is clamped');
  assert.deepEqual(step.subgoal.destination, { name: 'Draynor Village' });
  assert.equal(step.subgoal.isDone!(fullOfShrimp()), true);
  assert.equal(planToStep({ status: 'complete', reasoning: 'level reached', subgoal: null }).kind, 'complete');
  assert.equal(planToStep({ status: 'continue', reasoning: 'odd', subgoal: null }).kind, 'impossible');
});

test('claude prompts carry state, reports and option ids', () => {
  const p = plannerPrompt({
    goal: 'get 15 woodcutting',
    snapshot: snapshot(),
    kb: null,
    reports: [{ subgoal: 'chop trees', result: 'blocked', reason: 'no axe', steps: 3, trail: ['Tree: Chop down -> failed: You do not have an axe'] }],
  });
  assert.match(p, /Overall goal: get 15 woodcutting/);
  assert.match(p, /"chop trees" -> blocked after 3 steps: no axe/);
  assert.match(p, /Nearby: Fishing spot, Goblin, Tree/);

  const e = escalationPrompt({
    goal: { text: 'chop' },
    state: { subgoal: 'chop' } as never,
    candidates: [{ id: 'obj:1#Chop down', kind: 'object', name: 'Tree', action: 'Chop down', label: 'Tree: Chop down', gameAction: { op: 'done' } }],
    destinations: [],
    reason: 'low confidence (0.20)',
  });
  assert.match(e, /- obj:1#Chop down: Tree: Chop down/);
  assert.match(e, /- \(none\)/);
});

test('agent: task tree + engine run the full gather/bank loop against the fake client', async () => {
  const initial = snapshot({
    inventory: { freeSlots: 2, items: [item(0, 1351, 'Bronze axe', { actions: ['Wield', 'Drop'] })] },
    npcs: [],
    objects: [
      tree(),
      { id: 10355, name: 'Bank booth', type: 'GAME', actions: ['Bank', 'Collect'], position: { x: 3238, y: 3150, plane: 0 }, distance: 5, reachable: true, pathDistance: 4 },
    ],
  });
  const game = new FakeGame({ initial, actionTicks: 3 });
  const server = await startFakeServer(game, 'tok');
  const backend = new MicrobotBackend({ port: server.port, token: 'tok' });
  const engine = new GameIntentEngine({ backend, decisionEngine: new ScriptedDecisionEngine(), verify: { sleep: async () => {}, pollMs: 0 } });
  const events: AgentEvent[] = [];
  const planner = TaskTreePlanner.fromPreset('chop-trees', { bank: true });
  const agent = new Agent({ backend, engine, planner, maxSubGoals: 5, onEvent: (e) => events.push(e), sleep: async () => {} });
  try {
    const outcome = await agent.run('chop and bank');
    const reports = events.filter((e) => e.type === 'report').map((e) => (e as { report: { subgoal: string; result: string } }).report);
    assert.deepEqual(reports.map((r) => r.result), ['done', 'done', 'done', 'done', 'done'], JSON.stringify(reports));
    assert.match(reports[0]!.subgoal, /chop normal trees/);
    assert.match(reports[1]!.subgoal, /bank and open it/);
    assert.match(reports[2]!.subgoal, /deposit all Logs/);
    assert.match(reports[3]!.subgoal, /close the bank/);
    assert.match(reports[4]!.subgoal, /chop normal trees/);
    assert.equal(outcome.status, 'stopped');
    assert.ok(game.state.inventory.items.some((i) => i.name === 'Bronze axe'), 'kept the axe');
  } finally {
    await server.close();
  }
});

test('dataset export keeps verified model decisions and successful escalations', async () => {
  const { toExample } = await import('../src/dataset/export.ts');
  const base = {
    runId: 'r', step: 1, time: '', tick: 1, subgoal: 'chop', engine: 'jev',
    state: { subgoal: 'chop' } as never,
    questions: {
      op: { type: 'choice' as const, instructions: '', criteria: { interact: '', walk: '' } },
      target: { type: 'choice' as const, instructions: '', criteria: { a: 'Tree', b: 'Rock' } },
      destination: { type: 'choice' as const, instructions: '', criteria: { 'dest:0': 'bank' } },
    },
    answers: { target: { type: 'choice' as const, questionId: 'target', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } },
  };
  const ok = toExample({ ...base, source: 'model', chosen: { op: 'interact', optionId: 'a' }, outcome: { success: true, effect: 'changed: animation', ticks: 1, messages: [] } });
  assert.deepEqual(ok?.labels, { op: 'interact', target: 'a' });
  assert.deepEqual(ok?.soft, { target: { a: 0.9, b: 0.1 } });
  assert.deepEqual(Object.keys(ok!.questions!), ['op', 'target'], 'unlabelled questions dropped');

  const failed = toExample({ ...base, source: 'model', chosen: { op: 'interact', optionId: 'a' }, outcome: { success: false, effect: 'no effect', ticks: 5, messages: [] } });
  assert.equal(failed, null);

  const esc = toExample({ ...base, source: 'escalation', chosen: { op: 'interact', optionId: 'b' }, outcome: { success: true, effect: 'changed: animation', ticks: 1, messages: [] } });
  assert.equal(esc?.labels.target, 'b');
  assert.equal(esc?.soft, null);

  assert.equal(toExample({ ...base, source: 'reflex', chosen: { op: 'interact' } }), null);
  assert.equal(toExample({ ...base, source: 'model', chosen: { op: 'done' } }), null);
  assert.deepEqual(toExample({ ...base, source: 'model', chosen: { op: 'done' } }, true)?.labels, { op: 'done' });
});
