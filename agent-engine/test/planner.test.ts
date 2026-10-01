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

test('task tree: a gather task without its tool fetches it from the bank, or is impossible', () => {
  const task = { ...PRESETS['chop-trees']!, bank: true };
  const noAxe = () => snapshot({ inventory: { freeSlots: 27, items: [item(0, 1265, 'Bronze pickaxe')] } });
  const toBank = nextGatherStep(task, noAxe());
  assert.ok(toBank.kind === 'subgoal' && toBank.subgoal.doneWhen?.bankOpen === true && /axe/.test(toBank.subgoal.text));

  const atBank = noAxe();
  atBank.bank = { open: true, items: [{ id: 1351, name: 'Bronze axe', quantity: 1 } as never] };
  const withdraw = nextGatherStep(task, atBank);
  assert.ok(withdraw.kind === 'subgoal' && withdraw.subgoal.actions?.includes('Withdraw') && withdraw.subgoal.doneWhen?.hasItem?.name === 'Bronze axe');

  atBank.bank = { open: true, items: [] };
  assert.equal(nextGatherStep(task, atBank).kind, 'impossible');
  assert.equal(nextGatherStep(task, noAxe(), ['Logs']).kind, 'impossible');

  const oaks = { ...PRESETS['chop-oaks']!, bank: true };
  const low = snapshot({ skills: [{ name: 'Woodcutting', level: 8, xp: 0, boostedLevel: 8 } as never] });
  const tooLow = nextGatherStep(oaks, low);
  assert.ok(tooLow.kind === 'impossible' && /Woodcutting 15/.test(tooLow.reason));

  const wielded = noAxe();
  wielded.equipment = [{ slot: 'weapon', id: 1351, name: 'Bronze axe' } as never];
  assert.ok(nextGatherStep(task, wielded).kind === 'subgoal' && /chop/.test((nextGatherStep(task, wielded) as { subgoal: { text: string } }).subgoal.text));
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

test('combat task tree: loot our drop when it is on the ground, otherwise attack', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const { goblin } = await import('./support/fixtures.ts');
  const task = { ...COMBAT_PRESETS['kill-chickens']!, monsters: ['Goblin'] };
  const s = snapshot({ npcs: [goblin()], groundItems: [] });
  const attack = nextCombatStep(task, s);
  assert.ok(attack.kind === 'subgoal' && attack.subgoal.actions?.includes('Attack'));
  assert.equal(attack.kind === 'subgoal' && attack.subgoal.isDone!(s), false);

  const dropped = structuredClone(s);
  dropped.groundItems = [{ id: 314, name: 'Feather', quantity: 5, position: { x: 1, y: 1, plane: 0 }, distance: 2, geValue: 10, lootable: true, reachable: true, pathDistance: 2 }];
  assert.equal(attack.kind === 'subgoal' && attack.subgoal.isDone!(dropped), true, 'attack ends once our loot is down');

  const loot = nextCombatStep(task, dropped);
  assert.ok(loot.kind === 'subgoal' && loot.subgoal.targets?.[0] === 'Feather' && loot.subgoal.doneWhen?.hasItem?.count === 1);

  dropped.groundItems[0]!.lootable = false;
  assert.ok(nextCombatStep(task, dropped).kind === 'subgoal' && /attack/.test((nextCombatStep(task, dropped) as { subgoal: { text: string } }).subgoal.text), "someone else's drop is ignored");
});

test('combat: level cap filters targets, bones get buried in batches', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const { buildCandidates } = await import('../src/engine/candidates.ts');
  const { goblin } = await import('./support/fixtures.ts');
  const task = COMBAT_PRESETS['kill-barbarians']!;
  const s = snapshot({ npcs: [goblin({ name: 'Barbarian', combatLevel: 17, index: 1 }), goblin({ name: 'Barbarian', combatLevel: 9, index: 2 })], groundItems: [] });
  const step = nextCombatStep(task, s);
  assert.ok(step.kind === 'subgoal' && step.subgoal.maxTargetLevel === 10);
  const ids = buildCandidates(s, null, step.kind === 'subgoal' ? step.subgoal : { text: '' }).candidates.filter((c) => c.kind === 'npc').map((c) => c.id);
  assert.deepEqual(ids, ['npc:2#Attack'], 'the level-17 barbarian is never offered');

  const bones = snapshot({ inventory: { freeSlots: 20, items: Array.from({ length: 5 }, (_, i) => item(i, 526, 'Bones', { actions: ['Bury', 'Drop'] })) } });
  const bury = nextCombatStep(task, bones);
  assert.ok(bury.kind === 'subgoal' && bury.subgoal.actions?.includes('Bury'));
});

test('combat readiness: eat up, restock at a bank, rest when there is no food', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const { goblin } = await import('./support/fixtures.ts');
  const task = COMBAT_PRESETS['kill-barbarians']!;
  const kb = { nearestBanks: () => [{ name: 'Varrock West bank', kind: 'bank', point: { x: 3183, y: 3441, plane: 0 }, members: false }] } as never;
  const shrimps = (n: number) => Array.from({ length: n }, (_, i) => item(i, 315, 'Shrimps', { actions: ['Eat', 'Drop'] }));
  const base = () => {
    const b = snapshot({ npcs: [goblin({ name: 'Barbarian', combatLevel: 9 })], groundItems: [], inventory: { freeSlots: 20, items: shrimps(8) } });
    b.player!.hp = { current: 31, max: 31 };
    return b;
  };

  const hurt = base();
  hurt.player!.hp.current = 5;
  const eat = nextCombatStep(task, hurt, { kb });
  assert.ok(eat.kind === 'subgoal' && eat.subgoal.actions?.includes('Eat') && eat.subgoal.doneWhen?.hpAtLeast === 0.8);

  const noFood = base();
  noFood.inventory = { freeSlots: 28, items: [] };
  const restock = nextCombatStep(task, noFood, { kb, bankFood: null });
  assert.ok(restock.kind === 'subgoal' && /restock food/.test(restock.subgoal.text));

  noFood.player!.hp.current = 10;
  const rest = nextCombatStep(task, noFood, { kb, bankFood: new Map(), bankItems: [] });
  assert.equal(rest.kind, 'wait', 'bank known to be empty of food and HP low: rest');
  noFood.player!.hp.current = 31;
  assert.ok(nextCombatStep(task, noFood, { kb, bankFood: new Map(), bankItems: [] }).kind === 'subgoal', 'full HP and no food anywhere: fight carefully');

  const bank = base();
  bank.inventory = { freeSlots: 26, items: [item(0, 526, 'Bones'), item(1, 1351, 'Bronze axe')] };
  bank.bank = { open: true, items: [{ slot: 0, id: 315, name: 'Shrimps', quantity: 13 }, { slot: 1, id: 333, name: 'Trout', quantity: 4 }] };
  const deposit = nextCombatStep(task, bank, { kb });
  assert.ok(deposit.kind === 'subgoal' && /deposit the Bones, Bronze axe/.test(deposit.subgoal.text));
  bank.inventory = { freeSlots: 28, items: [] };
  const withdraw = nextCombatStep(task, bank, { kb });
  assert.ok(withdraw.kind === 'subgoal' && /withdraw 4 Trout/.test(withdraw.subgoal.text), 'best-healing food first');
});

test('combat looting takes coins and valuable drops before the task loot', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const task = COMBAT_PRESETS['kill-barbarians']!;
  const g = (name: string, geValue: number, distance: number, quantity = 1) => ({ id: 1, name, quantity, position: { x: 1, y: 1, plane: 0 }, distance, geValue, lootable: true, reachable: true, pathDistance: distance });
  const shrimps = Array.from({ length: 6 }, (_, i) => item(i, 315, 'Shrimps', { actions: ['Eat'] }));
  const s = snapshot({ inventory: { freeSlots: 22, items: shrimps }, groundItems: [g('Bones', 1, 1), g('Coins', 12, 3, 12), g('Mind rune', 60, 4)] });
  const first = nextCombatStep(task, s);
  assert.ok(first.kind === 'subgoal' && first.subgoal.text === 'pick up 12 coins on the ground');
  s.groundItems = s.groundItems.filter((x) => x.name !== 'Coins');
  const second = nextCombatStep(task, s);
  assert.ok(second.kind === 'subgoal' && /Mind rune/.test(second.subgoal.text));
  s.groundItems = [g('Bones', 1, 1), { ...g('Rune scimitar', 15000, 2), lootable: false }];
  const third = nextCombatStep(task, s);
  assert.ok(third.kind === 'subgoal' && /Bones/.test(third.subgoal.text), "another player's drop is never taken");
});

test('combat gear check: wield carried upgrades, fetch banked ones, check the bank once when a slot is weak', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const { classifyGear } = await import('../src/planner/gear.ts');
  const task = COMBAT_PRESETS['kill-barbarians']!;
  const kb = { nearestBanks: () => [{ name: 'Edgeville bank', kind: 'bank', point: { x: 3094, y: 3491, plane: 0 }, members: false }] } as never;
  const shrimps = Array.from({ length: 8 }, (_, i) => item(i + 2, 315, 'Shrimps', { actions: ['Eat', 'Drop'] }));
  const worn = [
    { slot: 'HEAD', id: 1153, name: 'Iron full helm' },
    { slot: 'WEAPON', id: 1351, name: 'Bronze axe' },
    { slot: 'BODY', id: 1115, name: 'Iron platebody' },
    { slot: 'SHIELD', id: 1189, name: 'Bronze kiteshield' },
    { slot: 'LEGS', id: 1067, name: 'Iron platelegs' },
  ];
  const s = snapshot({ equipment: worn, groundItems: [], inventory: { freeSlots: 18, items: [item(0, 1323, 'Iron scimitar', { actions: ['Wield', 'Drop'] }), ...shrimps] } });
  s.player!.hp = { current: 31, max: 31 };
  s.skills = [{ name: 'Attack', level: 32, boosted: 32, xp: 0 }, { name: 'Defence', level: 24, boosted: 24, xp: 0 }] as never;

  assert.equal(classifyGear('Bronze axe')!.score, 0);
  assert.equal(classifyGear('Rune scimitar')!.req, 40);

  const wield = nextCombatStep(task, s, { kb, bankItems: [] });
  assert.ok(wield.kind === 'subgoal' && /wield the Iron scimitar/.test(wield.subgoal.text) && wield.subgoal.doneWhen?.equipped?.[0] === 'Iron scimitar');

  // Scimitar banked, bank not seen yet: an axe in hand is a weak weapon slot, so check the bank.
  s.inventory = { freeSlots: 20, items: shrimps };
  const trip = nextCombatStep(task, s, { kb, bankItems: null });
  assert.ok(trip.kind === 'subgoal' && /better gear/.test(trip.subgoal.text) && trip.subgoal.doneWhen?.bankOpen);

  // At the bank: withdraw the best usable upgrade, not the rune one (Attack 32 < 40).
  s.bank = { open: true, items: [{ id: 1323, name: 'Iron scimitar', quantity: 1 }, { id: 1333, name: 'Rune scimitar', quantity: 1 }, { id: 315, name: 'Shrimps', quantity: 50 }] } as never;
  const withdraw = nextCombatStep(task, s, { kb, bankItems: null });
  assert.ok(withdraw.kind === 'subgoal' && withdraw.subgoal.want?.[0]?.name === 'Iron scimitar', JSON.stringify(withdraw));

  // Bank known and holds nothing better: no gear trip, go fight.
  s.bank = { open: false, items: [] } as never;
  const fight = nextCombatStep(task, s, { kb, bankItems: ['Rune scimitar', 'Shrimps'] });
  assert.ok(fight.kind === 'subgoal' && /attack|walk to the Barbarian/.test(fight.subgoal.text), JSON.stringify(fight));
});

test('combat: out of runes mid-fight waits for the fight to end instead of re-planning attacks', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const s = snapshot();
  s.player = { ...s.player!, inCombat: true, autocast: 'WIND_STRIKE' } as never;
  s.equipment = [{ slot: 'WEAPON', id: 1379, name: 'Staff' } as never];
  const step = nextCombatStep(COMBAT_PRESETS['mage-chickens']!, s, { bankCounts: new Map(), bankItems: [], bankFood: new Map() });
  assert.ok(step.kind === 'wait' && step.until.inCombat === false);
});

test('combat: restocking food ignores raw fish of the same name', async () => {
  const { nextCombatStep, COMBAT_PRESETS } = await import('../src/planner/TaskTreePlanner.ts');
  const s = snapshot({
    inventory: { freeSlots: 10, items: [item(0, 317, 'Raw shrimps', { quantity: 1 }), ...Array.from({ length: 12 }, (_, i) => item(i + 1, 317, 'Raw shrimps'))] },
    bank: { open: true, items: [{ id: 315, name: 'Shrimps', quantity: 40 } as never] },
  });
  const step = nextCombatStep({ ...COMBAT_PRESETS['kill-chickens']!, minFood: 5 }, s, { bankCounts: new Map([['Shrimps', 40]]), bankItems: ['Shrimps'], bankFood: new Map([['Shrimps', 40]]) });
  assert.ok(step.kind === 'subgoal' && /withdraw 10 Shrimps/.test(step.subgoal.text), JSON.stringify(step).slice(0, 200));
  assert.equal(step.subgoal.isDone!(s), false);
});

test('agent: a sub-goal that is already complete every time it is issued ends the run', async () => {
  const game = new FakeGame({ initial: snapshot(), actionTicks: 3 });
  const server = await startFakeServer(game, 'tok');
  const backend = new MicrobotBackend({ port: server.port, token: 'tok' });
  const engine = new GameIntentEngine({ backend, decisionEngine: new ScriptedDecisionEngine(), verify: { sleep: async () => {}, pollMs: 0 } });
  const planner = { name: 'spin', next: async () => ({ kind: 'subgoal' as const, subgoal: { text: 'withdraw 10 Shrimps', targets: ['Shrimps'], isDone: () => true } }) };
  const agent = new Agent({ backend, engine, planner, maxSubGoals: 100, sleep: async () => {} });
  try {
    const outcome = await agent.run('spin');
    assert.equal(outcome.status, 'impossible');
    assert.match(outcome.reason, /already complete/);
  } finally {
    await server.close();
  }
});
