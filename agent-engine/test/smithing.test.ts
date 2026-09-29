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
  const p = new SmithingPlanner();
  assert.match(text(await next(p, withSmithing(7))), /bank and open/);

  const atBank = withSmithing(7);
  atBank.bank = { open: true, items: [{ slot: 0, id: 436, name: 'Copper ore', quantity: 40 }, { slot: 1, id: 438, name: 'Tin ore', quantity: 200 }] };
  const withdraw = await next(p, atBank);
  assert.match(text(withdraw), /withdraw 13 Copper ore, 13 Tin ore/);

  const ores = withSmithing(7, [item(0, 2347, 'Hammer'), item(1, 1265, 'Bronze pickaxe'), ...Array.from({ length: 13 }, (_, i) => item(2 + i, 436, 'Copper ore')), ...Array.from({ length: 13 }, (_, i) => item(15 + i, 438, 'Tin ore'))]);
  assert.match(text(await next(p, ores)), /smelt/);

  const bars = withSmithing(7, [item(0, 2347, 'Hammer'), ...Array.from({ length: 5 }, (_, i) => item(1 + i, 2349, 'Bronze bar'))]);
  bars.equipment = [{ slot: 'HEAD', id: 1139, name: 'Bronze med helm' }];
  const smith = await next(p, bars);
  assert.match(text(smith), /Bronze full helm/, 'level 7 unlocks the full helm, an upgrade over the med helm');

  const noUpgrade = withSmithing(5, [item(0, 2347, 'Hammer'), item(1, 2349, 'Bronze bar')]);
  assert.match(text(await next(p, noUpgrade)), /Bronze dagger/);
});

test('smithing planner: wears upgrades, mines when the bank is short of copper', async () => {
  const p = new SmithingPlanner();
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
  assert.equal((await next(new SmithingPlanner(), done)).kind, 'complete');
});

test('smithing planner banks a cluttered inventory before a mining trip', async () => {
  const p = new SmithingPlanner();
  const bank = withSmithing(7);
  bank.bank = { open: true, items: [{ slot: 0, id: 438, name: 'Tin ore', quantity: 200 }] };
  await next(p, bank);
  const cluttered = withSmithing(7, [item(0, 2347, 'Hammer'), item(1, 1265, 'Bronze pickaxe'), ...Array.from({ length: 11 }, (_, i) => item(2 + i, 1205, 'Bronze dagger'))]);
  assert.match(text(await next(p, cluttered)), /bank/);
});
