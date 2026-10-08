import { test } from 'node:test';
import assert from 'node:assert/strict';
import { altarFor, RunecraftPlanner } from '../src/goalplan/RunecraftPlanner.ts';
import type { PlanStep, PlannerContext } from '../src/planner/types.ts';
import type { Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const planner = () => new RunecraftPlanner({ price: (n) => (n === 'Rune essence' ? 20 : null) });
const ctx = (snap: Snapshot): PlannerContext => ({ goal: 'train Runecraft', snapshot: snap, kb: null, reports: [] });
const at = (x: number, y: number, extra: Partial<Snapshot> = {}): Snapshot => {
  const s = snapshot(extra);
  s.player!.position = { x, y, plane: 0 };
  s.skills = [{ name: 'Runecraft', level: 5, boosted: 5, xp: 0 }, ...s.skills] as never;
  return s;
};
const inv = (...names: [string, number?][]) => ({ freeSlots: 28 - names.length, items: names.map(([n, q], i) => item(i, 1000 + i, n, { quantity: q ?? 1 })) });

test('runecraft: the altar follows the level (mind, then earth, then body) and names its own ruins', () => {
  assert.equal(altarFor(1).name, 'Air', 'mind runes need level 2');
  assert.equal(altarFor(2).name, 'Mind');
  assert.equal(altarFor(9).name, 'Earth');
  assert.equal(altarFor(20).name, 'Body');
  assert.equal(altarFor(5).ruins.point.x, 2981, 'the mind ruins, not whichever mysterious ruins is nearest');
});

test('runecraft: ready -> walk to the right ruins, enter with a direct action, craft at the altar, leave by the portal', async () => {
  const far = await planner().next(ctx(at(3164, 3487, { inventory: inv(['Rune essence', 27], ['Mind talisman']) })));
  assert.ok(far.kind === 'subgoal' && far.subgoal.destination?.point?.x === 2981 && far.subgoal.doneWhen?.near);

  const near = await planner().next(ctx(at(2982, 3510, { inventory: inv(['Rune essence', 27], ['Mind talisman']) })));
  assert.ok(near.kind === 'act' && near.action.op === 'use_item_on' && near.action.target.kind === 'object' && near.action.target.id === 34814, 'the talisman is used on the ruins');

  const altar = { id: 34764, name: 'Altar', type: 'GAME', actions: ['Craft-rune'], position: { x: 2584, y: 4837, plane: 0 }, distance: 4, reachable: true, pathDistance: 4 };
  const inside = await planner().next(ctx(at(2583, 4832, { inventory: inv(['Rune essence', 27], ['Mind talisman']), objects: [altar] })));
  assert.ok(inside.kind === 'act' && inside.action.op === 'interact' && inside.action.action === 'Craft-rune');

  const portal = { ...altar, id: 34754, name: 'Portal', actions: ['Use'] };
  const done = await planner().next(ctx(at(2583, 4832, { inventory: inv(['Mind talisman']), objects: [altar, portal] })));
  assert.ok(done.kind === 'act' && done.action.op === 'interact' && done.action.action === 'Use');
});

test('runecraft: empty-handed it buys a talisman and essence at the Grand Exchange, never at a shop', async () => {
  const p = planner();
  const bank = { open: true, items: [{ slot: 0, id: 995, name: 'Coins', quantity: 50_000, noted: false, stackable: true }] } as never;
  const open = at(3164, 3487, { inventory: inv(['Coins', 5000]), bank });
  const first = await p.next(ctx(open));
  assert.ok(first.kind === 'subgoal' || first.kind === 'act');
  const ge = at(3164, 3487, { inventory: inv(['Coins', 5000]), grandExchange: { open: true } as never });
  const buy1 = await planner().next(ctx(ge));
  assert.ok(buy1.kind === 'act' && buy1.action.op === 'ge_buy' && buy1.action.name === 'Mind talisman');
  const withTalisman = at(3164, 3487, { inventory: inv(['Coins', 5000]), grandExchange: { open: true } as never });
  const pl = planner();
  // Having bought the talisman (carried), the next order is the essence stock.
  const stocked = await pl.next(ctx({ ...withTalisman, inventory: inv(['Coins', 5000], ['Mind talisman']) }));
  assert.ok(stocked.kind === 'act' && stocked.action.op === 'ge_buy' && stocked.action.name === 'Rune essence');
});
