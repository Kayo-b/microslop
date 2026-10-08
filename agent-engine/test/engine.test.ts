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

test('bank withdraws fit the free inventory slots', () => {
  const bank = { open: true, items: [{ slot: 0, id: 440, name: 'Iron ore', quantity: 112 }, { slot: 1, id: 995, name: 'Coins', quantity: 500 }] };
  const goal = { text: 'withdraw iron ore', targets: ['Iron ore', 'Coins'], actions: ['Withdraw'], want: [{ name: 'Iron ore', count: 26 }] };
  const coins = { ...item(1, 995, 'Coins'), quantity: 240, stackable: true };
  const full = snapshot({ inventory: { freeSlots: 0, items: [item(0, 440, 'Iron ore'), coins] }, bank });
  const fullIds = buildCandidates(full, null, goal).candidates.map((c) => c.id);
  assert.ok(!fullIds.some((id) => id.startsWith('bank:withdraw') && id.endsWith(':440')), 'no iron ore with 0 free slots');
  assert.ok(fullIds.includes('bank:withdraw10:995'), 'a carried stack still takes more');
  const junk = snapshot({ inventory: { freeSlots: 0, items: [item(0, 440, 'Iron ore'), item(1, 1265, 'Bronze pickaxe')] }, bank });
  const junkIds = buildCandidates(junk, null, goal).candidates.map((c) => c.id);
  assert.ok(junkIds.includes('bank:deposit:1265'), 'full: deposit what the sub-goal does not want');
  assert.ok(!junkIds.includes('bank:deposit:440'), 'never deposit the wanted item');

  const three = snapshot({ inventory: { freeSlots: 3, items: [item(0, 440, 'Iron ore')] }, bank });
  const ids = buildCandidates(three, null, goal).candidates.map((c) => c.id);
  assert.ok(ids.includes('bank:withdraw3:440') && ids.includes('bank:withdraw1:440'));
  assert.ok(!ids.includes('bank:withdraw5:440') && !ids.includes('bank:withdraw10:440'), 'never more than fits');
  assert.match(buildCandidates(three, null, goal).candidates.find((c) => c.id === 'bank:withdraw3:440')!.label, /3 free slots/);
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

test('a nearest placement seen as unreachable is not offered; the bank stand point is', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const booth = { x: 3268, y: 3168, plane: 0 };
  const kb = { findPlaces: () => [], nearestObjects: () => [{ name: 'Bank booth', kind: 'object', point: booth, members: false }], nearestSpawns: () => [], nearestBanks: () => [{ name: 'Al Kharid bank', kind: 'bank', point: { x: 3270, y: 3166, plane: 0 }, members: false }] } as never;
  const s = snapshot({
    player: { ...snapshot().player!, position: { x: 3264, y: 3172, plane: 0 } },
    objects: [{ id: 10355, name: 'Bank booth', type: 'GAME', actions: ['Bank', 'Collect'], position: booth, distance: 4, reachable: false, pathDistance: -1 }],
  });
  const dests = buildDestinations(s, kb, { text: 'go to the nearest bank and open it', targets: ['Bank booth'] }, 5);
  assert.deepEqual(dests.map((d) => d.label.split(' (')[0]), ['Nearest bank: Al Kharid bank']);
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

test('conditions: picked-up ammo joining the quiver counts as carried', async () => {
  const { evaluate } = await import('../src/planner/conditions.ts');
  const s = snapshot({ equipment: [{ slot: 'AMMO', id: 882, name: 'Bronze arrow', quantity: 97 }] });
  assert.ok(evaluate({ hasItem: { name: 'Bronze arrow', count: 93 } }, s));
  assert.ok(!evaluate({ hasItem: { name: 'Bronze arrow', count: 98 } }, s));
});

test('engine: an active web walk is cancelled before clicking something else', async () => {
  const initial = snapshot({ inventory: { freeSlots: 3, items: [item(0, 303, 'Small fishing net')] } });
  initial.walk = { active: true } as never;
  const game = new FakeGame({ initial, actionTicks: 5 });
  const server = await startFakeServer(game, 'tok');
  const engine = new GameIntentEngine({
    backend: new MicrobotBackend({ port: server.port, token: 'tok' }),
    decisionEngine: new ScriptedDecisionEngine(),
    logger: new MemoryStepLogger(),
    verify: noSleep,
    maxBusyWaits: 0,
  });
  try {
    const r = await engine.step({ text: 'catch shrimp with the small net at the fishing spot', targets: ['Fishing spot'], actions: ['Small Net'], noTravel: true, isDone: () => false });
    assert.equal(r.kind, 'acted', JSON.stringify(r).slice(0, 200));
    const ops = game.acts.map((a) => a.op);
    assert.equal(ops[0], 'walk_cancel');
    assert.equal(ops[1], 'interact');
  } finally {
    await server.close();
  }
});

test('engine: an /act that times out is a failed step, not a crash', async () => {
  const s = snapshot();
  const fetchImpl = (async (url: string) => {
    if (String(url).includes('/act')) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    return new Response(JSON.stringify(s));
  }) as unknown as typeof fetch;
  const engine = new GameIntentEngine({
    backend: new MicrobotBackend({ token: 't', fetchImpl }),
    decisionEngine: new ScriptedDecisionEngine(),
    logger: new MemoryStepLogger(),
    verify: noSleep,
  });
  const r = await engine.step({ text: 'catch shrimp with the small net at the fishing spot', targets: ['Fishing spot'], actions: ['Small Net'], noTravel: true, isDone: () => false });
  assert.equal(r.kind, 'acted');
  assert.ok(r.kind === 'acted' && /did not answer/.test(r.outcome.effect));
});

test('engine: toggling run or eating does not cancel an active walk', async () => {
  const initial = snapshot({ inventory: { freeSlots: 27, items: [item(0, 315, 'Shrimps', { actions: ['Eat', 'Drop'] })] } });
  initial.walk = { active: true } as never;
  initial.player = { ...initial.player!, runEnergy: 80, runEnabled: false } as never;
  const game = new FakeGame({ initial, actionTicks: 5 });
  const server = await startFakeServer(game, 'tok');
  const engine = new GameIntentEngine({
    backend: new MicrobotBackend({ port: server.port, token: 'tok' }),
    decisionEngine: new ScriptedDecisionEngine(),
    logger: new MemoryStepLogger(),
    verify: noSleep,
    maxBusyWaits: 0,
  });
  try {
    await engine.step({ text: 'walk to the bank', targets: [], isDone: () => false });
    assert.ok(game.acts.some((a) => a.op === 'toggle_run'), JSON.stringify(game.acts));
    assert.ok(!game.acts.some((a) => a.op === 'walk_cancel'), JSON.stringify(game.acts));
  } finally {
    await server.close();
  }
});

test('a sub-goal destination already reached falls back to the nearest targets', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const me = snapshot().player!.position;
  const kb = { findPlaces: () => [], nearestObjects: () => [{ name: 'Cadava bush', kind: 'object', point: { x: me.x + 60, y: me.y, plane: me.plane }, members: false }], nearestSpawns: () => [], nearestBanks: () => [] } as never;
  const dests = buildDestinations(snapshot(), kb, { text: 'pick cadava berries', targets: ['Cadava bush'], destination: { name: 'quest step location', point: { ...me } } }, 5);
  assert.deepEqual(dests.map((d) => d.label.split(' (')[0]), ['Nearest Cadava bush']);
});

test('an open Grand Exchange offers buying the wanted item, collecting and closing', () => {
  const s = snapshot();
  s.grandExchange = { open: true };
  const { candidates } = buildCandidates(s, null, { text: 'buy 1 Redberry pie at the Grand Exchange', targets: ['Grand Exchange Clerk', 'Redberry pie'], actions: ['Exchange'], want: [{ name: 'Redberry pie', count: 1 }] });
  assert.deepEqual(candidates.map((c) => c.id), ['ge:buy:Redberry pie', 'ge:collect', 'ge:close']);
  assert.deepEqual(candidates[0]!.gameAction, { op: 'ge_buy', name: 'Redberry pie', quantity: 1 });
  s.grandExchange = { open: true, collectable: false };
  const idle = buildCandidates(s, null, { text: 'buy 1 Redberry pie at the Grand Exchange', targets: ['Grand Exchange Clerk', 'Redberry pie'], actions: ['Exchange'], want: [{ name: 'Redberry pie', count: 1 }] });
  assert.ok(!idle.candidates.some((c) => c.id === 'ge:collect'), 'nothing to collect: no Collect option');
});

test('banking walks to a tile inside the bank, not onto a booth (Al Kharid back wall)', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const s = snapshot();
  s.player = { ...s.player!, position: { x: 3267, y: 3174, plane: 0 } };
  const kb = {
    findPlaces: () => [],
    nearestObjects: () => [{ name: 'Bank booth', kind: 'object', point: { x: 3268, y: 3169, plane: 0 }, members: false }],
    nearestSpawns: () => [{ name: 'Banker', kind: 'npc', point: { x: 3267, y: 3166, plane: 0 }, members: false }],
    nearestBanks: () => [{ name: 'Al Kharid bank', kind: 'bank', point: { x: 3270, y: 3166, plane: 0 }, members: false }],
  } as never;
  const dests = buildDestinations(s, kb, { text: 'go to the nearest bank and open it', targets: ['Bank booth', 'Banker'] }, 5);
  assert.deepEqual(dests.map((d) => d.to), [{ x: 3270, y: 3166, plane: 0 }]);
});

test('a Grand Exchange buy with no want takes the count from the sub-goal text, not one at a time', () => {
  const s = snapshot();
  s.grandExchange = { open: true };
  const text = 'talk to the Grand Exchange Clerk and place a buy offer for 3,000 Feather a little below guide price';
  const { candidates } = buildCandidates(s, null, { text, targets: ['Grand Exchange Clerk', 'Feather'], actions: ['Exchange'] });
  assert.deepEqual(candidates[0]!.gameAction, { op: 'ge_buy', name: 'Feather', quantity: 3000 });
  const plain = buildCandidates(s, null, { text: 'buy a Knife at the Grand Exchange', targets: ['Grand Exchange Clerk', 'Knife'], actions: ['Exchange'] });
  assert.deepEqual(plain.candidates[0]!.gameAction, { op: 'ge_buy', name: 'Knife', quantity: 1 });
});

test('reflexes: low HP and no food while something else attacks -> walk away from it', async () => {
  const { goblin } = await import('./support/fixtures.ts');
  const s = snapshot({ inventory: { freeSlots: 28, items: [] } });
  const me = s.player!.position;
  s.player = { ...s.player!, hp: { current: 13, max: 33 }, inCombat: true };
  s.npcs = [goblin({ name: 'Black Knight', combatLevel: 33, interactingWithPlayer: true, position: { x: me.x + 1, y: me.y, plane: me.plane } })];
  const r = checkReflexes(s, undefined, { text: 'kill imps', targets: ['Imp'] });
  assert.ok(r?.kind === 'act' && r.action.op === 'walk' && r.action.to.x < me.x, JSON.stringify(r));
  // Fighting the sub-goal's own target is not fled from.
  assert.equal(checkReflexes(s, undefined, { text: 'kill knights', targets: ['Black Knight'] }), null);
});

test('attack is offered only on the monsters the sub-goal names (or ones attacking us)', async () => {
  const { goblin } = await import('./support/fixtures.ts');
  const s = snapshot({ npcs: [goblin({ index: 1, name: 'Imp', combatLevel: 2 }), goblin({ index: 2, name: 'Guard', combatLevel: 21 }), goblin({ index: 3, name: 'Cow', combatLevel: 2 })] });
  const attacks = buildCandidates(s, null, { text: 'kill imps for beads', targets: ['Imp', 'Red bead'], actions: ['Attack', 'Take'] }).candidates.filter((c) => c.action === 'Attack');
  assert.deepEqual(attacks.map((c) => c.name), ['Imp']);
});

test('the nearest-bank destination is only offered to banking sub-goals', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const kb = { findPlaces: () => [], nearestObjects: () => [], nearestSpawns: () => [], nearestBanks: () => [{ name: 'Falador deposit box', kind: 'deposit_box', point: { x: 3000, y: 3300, plane: 0 }, members: false }] } as never;
  const quest = buildDestinations(snapshot(), kb, { text: 'take the Poison in Draynor Manor; do not walk to any bank', targets: ['Poison'] }, 5);
  assert.equal(quest.length, 0);
  const banking = buildDestinations(snapshot(), kb, { text: 'go to the nearest bank and open it', targets: ['Bank booth'] }, 5);
  assert.deepEqual(banking.map((d) => d.label.split(' (')[0]), ['Nearest bank: Falador deposit box']);
});

test('two carried items the sub-goal names can be used on each other', () => {
  const s = snapshot({ inventory: { freeSlots: 26, items: [item(0, 273, 'Poison'), item(1, 272, 'Fish food')] } });
  const c = buildCandidates(s, null, { text: 'use the Poison on the Fish food', targets: ['Poison', 'Fish food'], actions: ['Use'], noTravel: true }).candidates;
  const use = c.find((x) => x.label === 'Use Poison on Fish food');
  assert.ok(use, JSON.stringify(c.map((x) => x.label)));
  assert.deepEqual(use!.gameAction, { op: 'use_item_on', itemSlot: 0, target: { kind: 'inventory', slot: 1, id: 272 } });
});

test('a slot-addressed action that finds its slot changed re-decides instead of counting a failure', async () => {
  const s = snapshot({ inventory: { freeSlots: 26, items: [item(0, 199, 'Grimy guam leaf', { actions: ['Clean', 'Drop'] }), item(1, 199, 'Grimy guam leaf', { actions: ['Clean', 'Drop'] })] } });
  const backend = {
    snapshot: async () => s,
    act: async () => ({ success: false, op: 'interact', tick: 1, reason: 'slot_changed' }),
  } as never;
  const decider = new ScriptedDecisionEngine((p) => {
    const t = p.questions.target as { criteria: Record<string, string> };
    return { op: { choice: 'interact' }, target: { choice: Object.keys(t.criteria).find((k) => k.includes('#Clean'))! } };
  });
  const engine = new GameIntentEngine({ backend, decisionEngine: decider, maxFailures: 3 });
  for (let i = 0; i < 5; i++) {
    const r = await engine.step({ text: 'clean all the grimy guam leafs', targets: ['Grimy guam leaf'], actions: ['Clean'] });
    assert.equal(r.kind, 'waiting', `step ${i}: ${r.kind}`);
  }
});

test('candidates: a free account is never offered a destination outside the free-to-play map', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const { inF2pArea } = await import('../src/strategy/f2p.ts');
  const kb = { findPlaces: () => [{ name: 'Karamja Volcano', point: { x: 2829, y: 9580, plane: 0 } }], nearestBanks: () => [], nearestObjects: () => [], nearestSpawns: () => [] } as never;
  const s = snapshot();
  const goal = { text: 'mine gold ore', destination: { name: 'Varrock gold mine' } } as never;
  assert.equal(buildDestinations(s, kb, goal, 5).length, 1, 'members accounts are offered it');
  assert.equal(buildDestinations(s, kb, goal, 5, inF2pArea).length, 0, 'free accounts are not');
});

test('candidates: coordinates written in the sub-goal text beat the nearest object of that name', async () => {
  const { buildDestinations } = await import('../src/engine/candidates.ts');
  const kb = { findPlaces: () => [], nearestBanks: () => [], nearestObjects: () => [{ name: 'Mysterious ruins', point: { x: 3052, y: 3444, plane: 0 } }], nearestSpawns: () => [] } as never;
  const goal = { text: 'Walk to the Air Altar mysterious ruins around 2985,3292', targets: ['Mysterious ruins'] } as never;
  const d = buildDestinations(snapshot(), kb, goal, 5);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0]!.to.x, d[0]!.to.y], [2985, 3292]);
});
