import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicrobotBackend, toWire } from '../src/backend/MicrobotBackend.ts';
import { buildCandidates } from '../src/engine/candidates.ts';
import { GameIntentEngine, type Escalator } from '../src/engine/GameIntentEngine.ts';
import { MemoryStepLogger } from '../src/engine/log.ts';
import { checkReflexes } from '../src/engine/reflexes.ts';
import { buildDecisionState, foldInventory } from '../src/engine/state.ts';
import { diff, expectedChanges } from '../src/engine/verify.ts';
import type { SubGoal } from '../src/types.ts';
import { FakeGame, startFakeServer } from './support/FakeMicrobotServer.ts';
import { ScriptedDecisionEngine } from './support/ScriptedDecisionEngine.ts';
import { goblin, item, snapshot, tree } from './support/fixtures.ts';

const noSleep = { sleep: async () => {}, pollMs: 0 };

test('candidates: one per (target, action), exact targets, sub-goal hints ranked first', () => {
  const s = snapshot();
  const { candidates } = buildCandidates(s, null, { text: 'chop the tree', targets: ['Tree'] });
  assert.equal(candidates[0]?.id, 'obj:1276@3240,3150,0#Chop down');
  assert.deepEqual(candidates[0]?.gameAction, {
    op: 'interact',
    target: { kind: 'object', id: 1276, x: 3240, y: 3150, plane: 0 },
    action: 'Chop down',
  });
  const net = candidates.find((c) => c.id === 'npc:1530#Small Net');
  assert.deepEqual(net?.gameAction, { op: 'interact', target: { kind: 'npc', index: 1530, id: 1530 }, action: 'Small Net' });
  assert.ok(!candidates.some((c) => c.id === 'inv:0#Drop'), 'Drop is offered only for items the sub-goal names');
});

test('candidates: identical targets collapse to the nearest few and unreachable ones are dropped', () => {
  const trees = Array.from({ length: 6 }, (_, i) => tree({ position: { x: 3240 + i, y: 3150, plane: 0 }, distance: 3 + i }));
  trees.push(tree({ position: { x: 3200, y: 3150, plane: 0 }, distance: 1, reachable: false }));
  const { candidates } = buildCandidates(snapshot({ objects: trees }), null, { text: 'chop' });
  const chop = candidates.filter((c) => c.name === 'Tree');
  assert.equal(chop.length, 2);
  assert.deepEqual(chop.map((c) => c.distance), [3, 4]);
});

test('candidates: modal interfaces replace world options', () => {
  const dlg = snapshot({ dialogue: { inDialogue: true, hasContinue: false, hasOptions: true, options: ['Yes', 'No'] } });
  assert.deepEqual(buildCandidates(dlg, null, { text: 'x' }).candidates.map((c) => c.id), ['dialogue:0', 'dialogue:1']);

  const bank = snapshot({ bank: { open: true, items: [{ slot: 0, id: 1351, name: 'Bronze axe', quantity: 1 }] } });
  const ids = buildCandidates(bank, null, { text: 'get an axe', targets: ['axe'] }).candidates.map((c) => c.id);
  assert.ok(ids.includes('bank:deposit_all'));
  assert.ok(ids.includes('bank:withdraw1:1351'));
  assert.ok(ids.includes('bank:close'));
});

test('candidates: tool pairs become use-item-on candidates', () => {
  const s = snapshot({ inventory: { freeSlots: 26, items: [item(0, 590, 'Tinderbox'), item(1, 1511, 'Logs')] } });
  const use = buildCandidates(s, null, { text: 'light logs' }).candidates.find((c) => c.id === 'use:0>inv:1');
  assert.deepEqual(use?.gameAction, { op: 'use_item_on', itemSlot: 0, target: { kind: 'inventory', slot: 1, id: 1511 } });
});

test('decision state folds inventory and summarises status', () => {
  const s = snapshot({ inventory: { freeSlots: 0, items: [item(0, 303, 'Small fishing net'), ...Array.from({ length: 27 }, (_, i) => item(i + 1, 317, 'Raw shrimps'))] } });
  assert.equal(foldInventory(s), 'Small fishing net; Raw shrimps x27; FULL (0 free slots)');
  const st = buildDecisionState(s, { text: 'fish' }, [{ tick: 1, action: 'net', outcome: 'changed: inventory' }], null, ['Fishing']);
  assert.equal(st.status, 'idle');
  assert.equal(st.skills, 'Fishing 1');
  assert.deepEqual(st.recent_actions, ['net -> changed: inventory']);
});

test('reflexes: eat when low, halt with no food, dismiss level-ups', () => {
  const low = snapshot();
  low.player!.hp.current = 3;
  low.inventory.items.push(item(5, 333, 'Trout', { actions: ['Eat', 'Drop'] }));
  assert.equal(checkReflexes(low)?.kind, 'act');

  const lowNoFood = snapshot();
  lowNoFood.player!.hp.current = 2;
  assert.equal(checkReflexes(lowNoFood), null, 'out of combat the planner handles low HP (restock or rest)');
  lowNoFood.player!.inCombat = true;
  assert.deepEqual(checkReflexes(lowNoFood), { kind: 'halt', reason: 'hp 2/10 and no food' });

  const lvl = snapshot({ dialogue: { inDialogue: true, hasContinue: true, hasOptions: false, text: "Congratulations, you've just advanced your Fishing level.", options: [] } });
  const r = checkReflexes(lvl);
  assert.ok(r?.kind === 'act' && r.action.op === 'dialogue_continue');
});

test('verify: diff and expected changes', () => {
  const a = snapshot();
  const b = structuredClone(a);
  b.player!.animating = true;
  assert.deepEqual(diff(a, b), ['animation']);
  assert.ok(expectedChanges({ op: 'interact', target: { kind: 'npc', index: 1, id: 1 }, action: 'Net' }).includes('animation'));
  assert.deepEqual(expectedChanges({ op: 'bank_deposit_all' }), ['inventory']);
});

test('backend: token auth, token-file rotation retry, wire format', async () => {
  const game = new FakeGame();
  const server = await startFakeServer(game, 'tok');
  try {
    const bad = new MicrobotBackend({ port: server.port, token: 'wrong' });
    await assert.rejects(bad.snapshot(), /404/);
    const ok = new MicrobotBackend({ port: server.port, token: 'tok' });
    const s = await ok.snapshot();
    assert.equal(s.player?.name, 'Tester');
    const res = await ok.act({ op: 'walk', to: { x: 1, y: 2, plane: 0 } });
    assert.equal(res.success, true);
    assert.deepEqual(game.acts.at(-1), { op: 'walk', to: { x: 1, y: 2, plane: 0 }, distance: 1 });
    await assert.rejects(ok.act({ op: 'wait', ticks: 1 }), /engine-side/);
  } finally {
    await server.close();
  }
  assert.deepEqual(toWire({ op: 'bank_deposit', itemId: 1, amount: 'all' }), { op: 'bank_deposit', itemId: 1, amount: 'all' });
});

test('engine: fishes until the inventory is full, waiting while busy, logging every decision', async () => {
  const initial = snapshot({ inventory: { freeSlots: 3, items: [item(0, 303, 'Small fishing net')] } });
  const game = new FakeGame({ initial, actionTicks: 5 });
  const server = await startFakeServer(game, 'tok');
  const logger = new MemoryStepLogger();
  const decider = new ScriptedDecisionEngine();
  const engine = new GameIntentEngine({
    backend: new MicrobotBackend({ port: server.port, token: 'tok' }),
    decisionEngine: decider,
    logger,
    verify: noSleep,
  });
  const goal: SubGoal = {
    text: 'catch shrimp with the small net at the fishing spot',
    targets: ['Fishing spot'],
    actions: ['Small Net'],
    isDone: (s) => s.inventory.freeSlots === 0,
  };
  try {
    const kinds: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await engine.step(goal);
      kinds.push(r.kind);
      if (r.kind === 'done' || r.kind === 'blocked') break;
    }
    assert.equal(kinds.at(-1), 'done');
    assert.ok(kinds.includes('waiting'), 'waits while animating instead of re-deciding');
    assert.equal(game.state.inventory.freeSlots, 0);
    const nets = game.acts.filter((a) => a.op === 'interact' && a.action === 'Small Net');
    assert.equal(nets.length, 3, 'one interaction per catch');
    const acted = logger.records.filter((r) => r.action);
    assert.ok(acted.every((r) => r.outcome?.success), 'every action verified');
    assert.ok(acted.every((r) => r.questions?.target && r.state?.subgoal === goal.text), 'logs carry the full decision input');
  } finally {
    await server.close();
  }
});

test('engine: repeated failures are reported as stuck', async () => {
  const initial = snapshot({ inventory: { freeSlots: 28, items: [] } });
  initial.npcs = [];
  const game = new FakeGame({ initial });
  const server = await startFakeServer(game, 'tok');
  const engine = new GameIntentEngine({
    backend: new MicrobotBackend({ port: server.port, token: 'tok' }),
    decisionEngine: new ScriptedDecisionEngine(() => ({ op: { choice: 'interact' }, target: { choice: 'obj:1276@3240,3150,0#Chop down' } })),
    verify: noSleep,
    maxFailures: 2,
  });
  try {
    let last;
    for (let i = 0; i < 6; i++) {
      last = await engine.step({ text: 'chop the tree', targets: ['Tree'] });
      if (last.kind === 'blocked') break;
    }
    assert.equal(last?.kind, 'blocked');
    assert.match((last as { reason: string }).reason, /stuck: 2 failed actions.*do not have an axe/);
  } finally {
    await server.close();
  }
});

test('engine: low confidence escalates and the escalator decision wins', async () => {
  const game = new FakeGame();
  const server = await startFakeServer(game, 'tok');
  const logger = new MemoryStepLogger();
  const escalator: Escalator = {
    choose: async (req) => ({ op: 'interact', optionId: req.candidates.find((c) => c.action === 'Small Net')!.id, note: 'net is the only usable tool' }),
  };
  const engine = new GameIntentEngine({
    backend: new MicrobotBackend({ port: server.port, token: 'tok' }),
    decisionEngine: new ScriptedDecisionEngine(() => ({ op: { choice: 'interact', confidence: 0.2 }, target: { choice: 'npc:77#Attack', confidence: 0.2 } })),
    escalator,
    logger,
    verify: noSleep,
  });
  try {
    const r = await engine.step({ text: 'fish', targets: ['Fishing spot'] });
    assert.equal(r.kind, 'acted');
    assert.equal((r as { source: string }).source, 'escalation');
    assert.equal(game.acts[0]?.action, 'Small Net');
    assert.equal(logger.records[0]?.escalation?.note, 'net is the only usable tool');
  } finally {
    await server.close();
  }
});

test('candidates skip dying NPCs; verification reports xp gains', async () => {
  const { goblin } = await import('./support/fixtures.ts');
  const { xpGains } = await import('../src/engine/verify.ts');
  const s = snapshot({ npcs: [goblin({ healthScale: 30, healthRatio: 0 }), goblin({ index: 78, healthScale: 30, healthRatio: 12 })] });
  const ids = buildCandidates(s, null, { text: 'kill goblins' }).candidates.filter((c) => c.kind === 'npc').map((c) => c.id);
  assert.deepEqual(ids, ['npc:78#Attack']);

  const after = structuredClone(s);
  after.skills.find((k) => k.name === 'Hitpoints')!.xp += 13;
  assert.deepEqual(xpGains(s, after), ['Hitpoints']);
  assert.ok(diff(s, after).includes('xp'));
});

test('bank candidates follow wanted counts and the sub-goal actions', () => {
  const s = snapshot({
    inventory: { freeSlots: 20, items: [item(0, 436, 'Copper ore'), item(1, 436, 'Copper ore'), item(2, 436, 'Copper ore')] },
    bank: { open: true, items: [{ slot: 0, id: 436, name: 'Copper ore', quantity: 40 }, { slot: 1, id: 438, name: 'Tin ore', quantity: 227 }] },
  });
  const goal = { text: 'withdraw ore', targets: ['Copper ore', 'Tin ore'], actions: ['Withdraw'], want: [{ name: 'Copper ore', count: 8 }, { name: 'Tin ore', count: 13 }] };
  const ids = buildCandidates(s, null, goal).candidates.map((c) => c.id);
  assert.ok(ids.includes('bank:withdraw5:436') && !ids.includes('bank:withdraw10:436'), 'copper: 5 more needed, never 10');
  assert.ok(!ids.includes('bank:withdrawAll:436') && !ids.includes('bank:withdrawAll:438'), 'All would overshoot');
  assert.ok(ids.includes('bank:withdraw10:438'));
  assert.ok(!ids.some((id) => id.startsWith('bank:deposit')), 'no deposit options for a withdraw sub-goal');
  assert.ok(ids.includes('bank:close'));
  const label = buildCandidates(s, null, goal).candidates.find((c) => c.id === 'bank:withdraw5:436')!.label;
  assert.match(label, /you need 5 more/);
});

test('smithing candidates queue no more than the sub-goal still needs', () => {
  const s = snapshot({ production: { open: true, interface: 'smithing', options: ['Bronze sword', 'Bronze mace'] } });
  s.inventory.items.push(item(3, 1321, 'Bronze sword'));
  const pick = (want: number) =>
    buildCandidates(s, null, { text: 'smith swords', targets: ['Bronze sword'], want: [{ name: 'Bronze sword', count: want }] })
      .candidates.find((c) => c.name === 'Bronze sword')!.gameAction;
  assert.deepEqual(pick(2), { op: 'production_select', option: 'Bronze sword', amount: 1 });
  assert.deepEqual(pick(7), { op: 'production_select', option: 'Bronze sword', amount: 5 });
  assert.deepEqual(pick(20), { op: 'production_select', option: 'Bronze sword', amount: 10 });
});

test('an exact sub-goal destination is the only destination offered', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const kb = { findPlaces: () => [], nearestObjects: () => [{ name: 'Bank booth', kind: 'object', point: { x: 3250, y: 3170, plane: 0 }, members: false }], nearestSpawns: () => [], nearestBanks: () => [] } as never;
  const dests = buildDestinations(snapshot(), kb, { text: 'bank', targets: ['Bank booth'], destination: { name: 'Lumbridge Top bank', point: { x: 3209, y: 3220, plane: 2 } } }, 5);
  assert.deepEqual(dests.map((d) => d.label.split(' (')[0]), ['Lumbridge Top bank']);
});

test('action-less objects such as a fire become use-item-on targets', () => {
  const s = snapshot({
    inventory: { freeSlots: 26, items: [item(0, 317, 'Raw shrimps'), item(1, 590, 'Tinderbox')] },
    objects: [{ id: 26185, name: 'Fire', type: 'GAME', actions: [], position: { x: 3230, y: 3232, plane: 0 }, distance: 1, reachable: true, pathDistance: 1 }],
  });
  const c = buildCandidates(s, null, { text: 'cook shrimps on the fire', targets: ['Fire'] }).candidates.find((x) => x.name === 'Fire');
  assert.deepEqual(c?.gameAction, { op: 'use_item_on', itemSlot: 0, target: { kind: 'object', id: 26185, x: 3230, y: 3232, plane: 0 } });
  assert.equal(c?.label, 'Use Raw shrimps on the Fire - 1 tiles');
});

test('avoided names are never offered, so a look-alike does not stop travel', () => {
  const s = snapshot({ objects: [tree({ id: 40725, name: 'Rusted anvil', actions: ['Smith'] })] });
  const { candidates } = buildCandidates(s, null, { text: 'smith', targets: ['Anvil'], avoid: ['Rusted anvil'] });
  assert.ok(!candidates.some((c) => c.name === 'Rusted anvil'));
});

test('transient game states (region loading) wait instead of blocking as a logout', async () => {
  const game = new FakeGame();
  game.state.loggedIn = false;
  game.state.gameState = 'LOADING';
  const server = await startFakeServer(game, 'tok');
  const engine = new GameIntentEngine({ backend: new MicrobotBackend({ port: server.port, token: 'tok' }), decisionEngine: new ScriptedDecisionEngine(), verify: noSleep, logoutGraceMs: 0 });
  try {
    const r = await engine.step({ text: 'fish' });
    assert.equal(r.kind, 'waiting');
    game.state.gameState = 'LOGIN_SCREEN';
    assert.deepEqual((await engine.step({ text: 'fish' })).kind, 'blocked');
  } finally {
    await server.close();
  }
});

test('hint matching is one-directional: depleted "Rocks" is not an "Iron rocks" target', async () => {
  const { matchesAny } = await import('../src/engine/candidates.ts');
  assert.equal(matchesAny('Rocks', ['Iron rocks']), false);
  assert.equal(matchesAny('Iron rocks', ['Iron rocks']), true);
  assert.equal(matchesAny('Dead tree', ['Tree']), true);
});

test('objects at avoided positions are never offered', () => {
  const s = snapshot({ objects: [tree({ id: 2097, name: 'Anvil', actions: ['Smith'], position: { x: 3246, y: 3404, plane: 0 } }), tree({ id: 2097, name: 'Anvil', actions: ['Smith'], position: { x: 3188, y: 3421, plane: 0 }, distance: 9 })] });
  const ids = buildCandidates(s, null, { text: 'smith', targets: ['Anvil'], avoidAt: [{ x: 3246, y: 3404, plane: 0 }] }).candidates.map((c) => c.id);
  assert.deepEqual(ids.filter((i) => i.startsWith('obj:')), ['obj:2097@3188,3421,0#Smith']);
});

test('a target that fails twice is withheld for the rest of the sub-goal', async () => {
  const initial = snapshot();
  initial.npcs = [goblin({ name: 'Banker', actions: ['Bank', 'Talk-to'], index: 5 })];
  initial.objects = [{ id: 10355, name: 'Bank booth', type: 'GAME', actions: ['Bank'], position: { x: 3238, y: 3150, plane: 0 }, distance: 5, reachable: true, pathDistance: 4 }];
  const game = new FakeGame({ initial });
  const server = await startFakeServer(game, 'tok');
  // Always prefer the banker; the fake client does nothing for it, so every banker click has "no effect".
  const decider = new ScriptedDecisionEngine((p) => {
    const t = p.questions.target as { criteria: Record<string, string> };
    const banker = Object.keys(t.criteria).find((k) => k.startsWith('npc:5'));
    return { op: { choice: 'interact' }, target: { choice: banker ?? Object.keys(t.criteria).find((k) => k.includes('Bank booth') || k.startsWith('obj:10355'))! } };
  });
  const engine = new GameIntentEngine({ backend: new MicrobotBackend({ port: server.port, token: 'tok' }), decisionEngine: decider, verify: { ...noSleep, timeoutTicks: 1 }, maxFailures: 5 });
  try {
    for (let i = 0; i < 3; i++) await engine.step({ text: 'open the bank', targets: ['Bank booth', 'Banker'] });
    const lastTargets = Object.keys((decider.calls.at(-1)!.questions.target as { criteria: Record<string, string> }).criteria);
    assert.ok(!lastTargets.some((k) => k.startsWith('npc:5')), 'banker withheld after two failures');
    assert.equal(game.state.bank.open, true, 'the booth was used instead');
  } finally {
    await server.close();
  }
});

test('candidates: an NPC already attacking us is the only attack option', () => {
  const s = snapshot({
    npcs: [goblin({ index: 1, distance: 1 }), goblin({ index: 2, distance: 4, interactingWithPlayer: true })],
  });
  const goal: SubGoal = { text: 'attack a goblin', targets: ['Goblin'], actions: ['Attack'] };
  const ids = buildCandidates(s, null, goal).candidates.filter((c) => c.id.endsWith('#Attack')).map((c) => c.id);
  assert.deepEqual(ids, ['npc:2#Attack']);
});

test('candidates: fights and pickups never swap gear or grab unnamed loot', () => {
  const ground = (id: number, name: string) => ({ id, name, quantity: 1, position: { x: 3250, y: 3260, plane: 0 }, distance: 1, reachable: true, lootable: true, geValue: 1, stackable: false });
  const s = snapshot({
    npcs: [goblin({ name: 'Cow', distance: 3 })],
    inventory: { freeSlots: 26, items: [item(0, 1323, 'Iron scimitar', { actions: ['Wield', 'Drop'] })] },
    equipment: [{ slot: 'AMMO', id: 882, name: 'Bronze arrow', quantity: 100 }],
    groundItems: [ground(526, 'Bones'), ground(882, 'Bronze arrow')] as never,
  });
  const attack = buildCandidates(s, null, { text: 'attack a cow', targets: ['Cow'], actions: ['Attack'] }).candidates.map((c) => c.id);
  assert.ok(!attack.some((id) => /Wield|ground:|Remove/.test(id)), attack.join(', '));
  const pickup = buildCandidates(s, null, { text: 'pick up arrows', targets: ['Bronze arrow'], actions: ['Take'] }).candidates.map((c) => c.id);
  assert.ok(pickup.includes('ground:882@3250,3260,0#Take') && !pickup.some((id) => /ground:526|Remove|Wield/.test(id)), pickup.join(', '));
});

test('reflexes: a random event NPC targeting us is dismissed; one talking to someone else is left alone', () => {
  const genie = goblin({ index: 9, id: 326, name: 'Genie', actions: ['Talk-to', 'Dismiss'], interactingWithPlayer: true });
  const r = checkReflexes(snapshot({ npcs: [genie] }));
  assert.ok(r?.kind === 'act' && r.action.op === 'interact' && r.action.action === 'Dismiss' && /Genie/.test(r.reason));
  assert.equal(checkReflexes(snapshot({ npcs: [{ ...genie, interactingWithPlayer: false }] })), null);
  const ids = buildCandidates(snapshot({ npcs: [genie] }), null, { text: 'look around' }).candidates.map((c) => c.id);
  assert.ok(!ids.some((id) => id.startsWith('npc:9')), 'random events are never offered to the classifier');
});

test('candidates: a pickup never offers Drop; a drop sub-goal does', () => {
  const s = snapshot({ inventory: { freeSlots: 26, items: [item(0, 1323, 'Iron scimitar', { actions: ['Wield', 'Drop'] }), item(1, 995, 'Coins', { quantity: 16, actions: ['Drop'] })] } });
  const pickup = buildCandidates(s, null, { text: 'pick up arrows', targets: ['Bronze arrow'], actions: ['Take'] }).candidates.map((c) => c.id);
  assert.ok(!pickup.some((id) => id.startsWith('inv:')), pickup.join(', '));
  const drop = buildCandidates(s, null, { text: 'drop the scimitar', targets: ['Iron scimitar'], actions: ['Drop'] }).candidates.map((c) => c.id);
  assert.ok(drop.includes('inv:0#Drop') && !drop.includes('inv:0#Wield'));
});
