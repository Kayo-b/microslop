import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SmithingPlanner } from '../src/planner/SmithingPlanner.ts';
import type { PlanStep } from '../src/planner/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const next = (p: SmithingPlanner, s = snapshot()) => p.next({ goal: 'g', snapshot: s, kb: null, reports: [] });
const text = (step: PlanStep) => (step.kind === 'subgoal' ? step.subgoal.text : step.kind);

function withSmithing(level: number, items = [item(0, 2347, 'Hammer'), item(1, 1265, 'Bronze pickaxe')]) {
  const s = snapshot({ inventory: { freeSlots: 28 - items.length, items } });
  s.skills.push({ name: 'Smithing', level, boosted: level, xp: 0 });
  return s;
}

test('smithing planner: bank first, then withdraw a batch, smelt, smith the best unlocked upgrade', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  assert.match(text(await next(p, withSmithing(7))), /bank and open/);

  const atBank = withSmithing(7);
  atBank.bank = { open: true, items: [{ slot: 0, id: 436, name: 'Copper ore', quantity: 40 }, { slot: 1, id: 438, name: 'Tin ore', quantity: 200 }] };
  const withdraw = await next(p, atBank);
  assert.match(text(withdraw), /withdraw 13 Copper ore, 13 Tin ore/);

  const ores = withSmithing(7, [item(0, 2347, 'Hammer'), item(1, 1265, 'Bronze pickaxe'), ...Array.from({ length: 13 }, (_, i) => item(2 + i, 436, 'Copper ore')), ...Array.from({ length: 13 }, (_, i) => item(15 + i, 438, 'Tin ore'))]);
  assert.match(text(await next(p, ores)), /smelt/);

  const bars = withSmithing(7, [item(0, 2347, 'Hammer'), ...Array.from({ length: 5 }, (_, i) => item(1 + i, 2349, 'Bronze bar'))]);
  bars.equipment = [{ slot: 'HEAD', id: 1139, name: 'Bronze med helm' }, { slot: 'WEAPON', id: 1321, name: 'Bronze scimitar' }];
  const smith = await next(p, bars);
  assert.match(text(smith), /Bronze full helm/, 'level 7 unlocks the full helm, an upgrade over the med helm');

  const noUpgrade = withSmithing(4, [item(0, 2347, 'Hammer'), item(1, 2349, 'Bronze bar')]);
  assert.match(text(await next(p, noUpgrade)), /Bronze dagger/);
});

test('smithing planner: wears upgrades, mines when the bank is short of copper', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  const helm = withSmithing(7, [item(0, 2347, 'Hammer'), item(1, 1153, 'Bronze full helm')]);
  helm.equipment = [{ slot: 'HEAD', id: 1139, name: 'Bronze med helm' }];
  assert.match(text(await next(p, helm)), /wear the Bronze full helm/);

  const bank = withSmithing(7);
  bank.bank = { open: true, items: [{ slot: 0, id: 438, name: 'Tin ore', quantity: 200 }] };
  await next(p, bank); // remembers: no copper banked
  const out = withSmithing(7);
  const mine = await next(p, out);
  assert.match(text(mine), /mine copper/);
  assert.ok(mine.kind === 'subgoal' && mine.subgoal.doneWhen?.inventoryFull);

  const done = withSmithing(18);
  done.equipment = ['Bronze scimitar:WEAPON', 'Bronze full helm:HEAD', 'Bronze platebody:BODY', 'Bronze kiteshield:SHIELD', 'Bronze platelegs:LEGS'].map((x) => ({ slot: x.split(':')[1]!, id: 1, name: x.split(':')[0]! }));
  assert.equal((await next(new SmithingPlanner({ metal: 'bronze', untilLevel: 18, memoryFile: null }), done)).kind, 'complete');
});

test('smithing planner banks a cluttered inventory before a mining trip', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  const bank = withSmithing(7);
  bank.bank = { open: true, items: [{ slot: 0, id: 438, name: 'Tin ore', quantity: 200 }] };
  await next(p, bank);
  const cluttered = withSmithing(7, [item(0, 2347, 'Hammer'), item(1, 1265, 'Bronze pickaxe'), ...Array.from({ length: 11 }, (_, i) => item(2 + i, 1205, 'Bronze dagger'))]);
  assert.match(text(await next(p, cluttered)), /bank/);
});

test('smithing planner does not finish at the target level while an unlocked upgrade can still be made', async () => {
  const s = withSmithing(18, [item(0, 2347, 'Hammer'), ...Array.from({ length: 12 }, (_, i) => item(1 + i, 2349, 'Bronze bar'))]);
  s.equipment = [
    { slot: 'HEAD', id: 1155, name: 'Bronze full helm' },
    { slot: 'BODY', id: 1103, name: 'Bronze chainbody' },
    { slot: 'SHIELD', id: 1189, name: 'Bronze kiteshield' },
    { slot: 'LEGS', id: 1075, name: 'Bronze platelegs' },
    { slot: 'WEAPON', id: 1321, name: 'Bronze scimitar' },
  ];
  assert.match(text(await next(new SmithingPlanner({ metal: 'bronze', untilLevel: 18, memoryFile: null }), s)), /Bronze platebody/);
});

test('smithing planner switches to iron at Smithing 15: mine iron, smelt, smith the iron scimitar at 20', async () => {
  const { IRON } = await import('../src/planner/SmithingPlanner.ts');
  const p = new SmithingPlanner({ memoryFile: null });
  const bank = withSmithing(20);
  bank.bank = { open: true, items: [{ slot: 0, id: 440, name: 'Iron ore', quantity: 32 }, { slot: 1, id: 438, name: 'Tin ore', quantity: 200 }] };
  assert.match(text(await next(p, bank)), /withdraw 26 Iron ore/);

  const ore = withSmithing(20, [item(0, 2347, 'Hammer'), item(1, 1265, 'Bronze pickaxe'), ...Array.from({ length: 26 }, (_, i) => item(2 + i, 440, 'Iron ore'))]);
  const smelt = await next(p, ore);
  assert.match(text(smelt), /smelt the iron ore into iron bars/);

  const bars = withSmithing(20, [item(0, 2347, 'Hammer'), ...Array.from({ length: 4 }, (_, i) => item(1 + i, 2351, 'Iron bar'))]);
  bars.equipment = [{ slot: 'WEAPON', id: 1321, name: 'Bronze scimitar' }];
  assert.match(text(await next(p, bars)), /Iron scimitar/);

  const scim = withSmithing(20, [item(0, 2347, 'Hammer'), item(1, 1323, 'Iron scimitar')]);
  scim.equipment = [{ slot: 'WEAPON', id: 1321, name: 'Bronze scimitar' }];
  const wield = await next(p, scim);
  assert.match(text(wield), /wield the Iron scimitar/);
  assert.ok(wield.kind === 'subgoal' && wield.subgoal.actions?.[0] === 'Wield');

  // Out of iron: the bank (last seen) is short, so go mining at the Al Kharid mine.
  const emptyBank = withSmithing(20);
  emptyBank.bank = { open: true, items: [{ slot: 0, id: 438, name: 'Tin ore', quantity: 200 }] };
  await next(p, emptyBank);
  const mine = await next(p, withSmithing(20));
  assert.match(text(mine), new RegExp(`mine iron ore at the ${IRON.mine.name}`));
});

test('iron is smithed at a real anvil, bronze at the rusted one', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  const iron = withSmithing(20, [item(0, 2347, 'Hammer'), item(1, 2351, 'Iron bar')]);
  iron.equipment = [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }];
  const step = await next(p, iron);
  assert.ok(step.kind === 'subgoal' && step.subgoal.destination?.point?.x === 3189, 'Varrock west anvils');
  assert.ok(step.kind === 'subgoal' && !step.subgoal.targets?.includes('Rusted anvil'));
  const bronze = await next(new SmithingPlanner({ memoryFile: null }), withSmithing(4, [item(0, 2347, 'Hammer'), item(1, 2349, 'Bronze bar')]));
  assert.ok(bronze.kind === 'subgoal' && bronze.subgoal.targets?.includes('Rusted anvil'));
});

test('an unreachable anvil is retired and the loop re-planned without it', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  const good = { x: 3188, y: 3421, plane: 0 };
  const bad = { x: 3246, y: 3404, plane: 0 };
  const kb = {
    nearestObjects: (name: string, _from: unknown, o: { radius?: number } = {}) =>
      name === 'Anvil'
        ? o.radius === 5
          ? [{ name: 'Anvil', kind: 'object', point: bad, members: false }]
          : [{ name: 'Anvil', kind: 'object', point: bad, members: false }, { name: 'Anvil', kind: 'object', point: good, members: false }]
        : [{ name, kind: 'object', point: { x: 3285, y: 3368, plane: 0 }, members: false }, { name, kind: 'object', point: { x: 3286, y: 3368, plane: 0 }, members: false }, { name, kind: 'object', point: { x: 3287, y: 3369, plane: 0 }, members: false }],
    nearestBanks: () => [{ name: 'Varrock East bank', kind: 'bank', point: { x: 3253, y: 3422, plane: 0 }, members: false }],
  } as never;
  const bars = withSmithing(20, [item(0, 2347, 'Hammer'), item(1, 2351, 'Iron bar')]);
  bars.equipment = [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }];
  bars.player!.position = { x: 3247, y: 3405, plane: 0 }; // standing at the bad anvil when it fails
  const ctx = (reports: never[]) => ({ goal: 'g', snapshot: bars, kb, reports, pathCost: async (a: { x: number }, b: { x: number }) => Math.abs(a.x - b.x) });
  const first = await p.next(ctx([]) as never);
  assert.ok(first.kind === 'subgoal' && first.subgoal.destination?.point?.x === bad.x, 'straight-line cheapest anvil first');
  const blocked = { subgoal: first.kind === 'subgoal' ? first.subgoal.text : '', result: 'blocked', reason: "stuck: 3 failed actions in a row (last: Anvil: Smith - 1 tiles -> failed: I can't reach that!)", steps: 5, trail: [] };
  const second = await p.next(ctx([blocked] as never) as never);
  assert.ok(second.kind === 'subgoal' && second.subgoal.destination?.point?.x === good.x, 're-planned to the reachable anvil');
});

test('smithing planner: steel from 35 takes iron ore and twice the coal, mines whichever runs short', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  const bank = withSmithing(36);
  bank.equipment = [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }];
  bank.bank = { open: true, items: [{ slot: 0, id: 440, name: 'Iron ore', quantity: 40 }, { slot: 1, id: 453, name: 'Coal', quantity: 30 }] };
  assert.match(text(await next(p, bank)), /withdraw 8 Iron ore, 16 Coal/);

  const ore = withSmithing(36, [item(0, 2347, 'Hammer'), ...Array.from({ length: 8 }, (_, i) => item(1 + i, 440, 'Iron ore')), ...Array.from({ length: 16 }, (_, i) => item(9 + i, 453, 'Coal'))]);
  assert.match(text(await next(p, ore)), /smelt the iron ore and coal into steel bars/);

  const bars = withSmithing(36, [item(0, 2347, 'Hammer'), item(1, 2353, 'Steel bar'), item(2, 2353, 'Steel bar')]);
  bars.equipment = [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }];
  assert.match(text(await next(p, bars)), /smith a Steel scimitar/);

  // Plenty of iron, little coal: mine coal at the Al Kharid mine.
  const noCoal = withSmithing(36);
  noCoal.bank = { open: true, items: [{ slot: 0, id: 440, name: 'Iron ore', quantity: 100 }, { slot: 1, id: 453, name: 'Coal', quantity: 1 }] };
  const q = new SmithingPlanner({ memoryFile: null });
  await next(q, noCoal);
  const mine = await next(q, withSmithing(36));
  assert.ok(mine.kind === 'subgoal' && /mine coal at the Al Kharid mine/.test(mine.subgoal.text) && mine.subgoal.targets?.includes('Coal rocks'), text(mine));
});

test('smithing planner: better gear already worn is never swapped for a smithed piece', async () => {
  const { isUpgrade } = await import('../src/planner/SmithingPlanner.ts');
  const s = withSmithing(40);
  s.equipment = [{ slot: 'WEAPON', id: 1333, name: 'Rune scimitar' }, { slot: 'BODY', id: 1101, name: 'Iron chainbody' }];
  assert.equal(isUpgrade(s, 'Steel scimitar', 'WEAPON'), false);
  assert.equal(isUpgrade(s, 'Steel chainbody', 'BODY'), true);
  assert.equal(isUpgrade(s, 'Bronze platebody', 'BODY'), false, 'iron chainbody (tier 2) beats bronze platebody');
});

test('smithing planner: XP filler smiths every carried bar in one go; an upgrade piece stays at one', async () => {
  const p = new SmithingPlanner({ memoryFile: null });
  const bars = withSmithing(24, [item(0, 2347, 'Hammer'), ...Array.from({ length: 20 }, (_, i) => item(1 + i, 2351, 'Iron bar'))]);
  bars.equipment = [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }, { slot: 'HEAD', id: 1153, name: 'Iron full helm' }];
  const filler = await next(p, bars);
  assert.ok(filler.kind === 'subgoal' && filler.subgoal.want === undefined && filler.subgoal.doneWhen?.lacksItem === 'Iron bar', text(filler));
  assert.match(text(filler), /smith all the iron bars into Iron daggers/);

  const { buildCandidates } = await import('../src/engine/candidates.ts');
  bars.production = { open: true, interface: 'smithing', options: ['Iron dagger', 'Iron scimitar'] } as never;
  const smithAll = buildCandidates(bars, null, filler.subgoal).candidates.find((c) => c.id === 'production:Iron dagger');
  assert.deepEqual(smithAll?.gameAction, { op: 'production_select', option: 'Iron dagger' }, 'no amount: Smith All');

  bars.equipment = [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }];
  const helm = await next(new SmithingPlanner({ memoryFile: null }), bars);
  assert.ok(helm.kind === 'subgoal' && helm.subgoal.want?.[0]?.name === 'Iron full helm' && helm.subgoal.want[0].count === 1, text(helm));
});
