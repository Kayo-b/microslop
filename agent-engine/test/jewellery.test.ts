import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JewelleryPlanner, nextJewellery } from '../src/goalplan/JewelleryPlanner.ts';
import type { PlanStep } from '../src/planner/types.ts';
import type { InventoryItem, Snapshot } from '../src/types.ts';
import { item, snapshot, tree } from './support/fixtures.ts';

// 2026-10-07 mid prices.
const prices: Record<string, number> = {
  'Gold bar': 68, Sapphire: 174, Emerald: 320, Ruby: 732, Diamond: 1548,
  'Gold ring': 157, 'Gold necklace': 174, 'Gold amulet (u)': 159,
  'Sapphire ring': 423, 'Sapphire necklace': 435, 'Sapphire amulet (u)': 451,
  'Emerald ring': 575, 'Emerald necklace': 615, 'Emerald amulet (u)': 516,
  'Ruby ring': 920, 'Ruby necklace': 1019, 'Ruby amulet (u)': 1023,
  'Diamond ring': 1817, 'Diamond necklace': 1903, 'Diamond amulet (u)': 1792,
  'Ring mould': 263, 'Necklace mould': 662, 'Amulet mould': 267,
};
const price = (n: string) => prices[n] ?? null;
const coins = (n: number) => item(0, 995, 'Coins', { quantity: n, stackable: true });
const state = (level: number, items: InventoryItem[], extra: Partial<Snapshot> = {}) => {
  const s = snapshot({ inventory: { freeSlots: 28 - items.length, items }, objects: [], ...extra });
  s.skills.push({ name: 'Crafting', level, boosted: level, xp: 0 });
  return s;
};
const bankOpen = (level: number, items: InventoryItem[], bank: { id: number; name: string; quantity: number }[]) =>
  state(level, items, { bank: { open: true, items: bank.map((b, slot) => ({ slot, ...b })) } } as Partial<Snapshot>);
const next = (p: JewelleryPlanner, s: Snapshot) => p.next({ goal: 'craft', snapshot: s, kb: null, reports: [] });
const act = (st: PlanStep) => (st.kind === 'act' ? st.action : null);
const ge = { grandExchange: { open: true } } as Partial<Snapshot>;

test('jewellery: nothing below Crafting 5; profit and XP decide among the rest', () => {
  assert.equal(nextJewellery(4, price), null);
  assert.equal(nextJewellery(5, price)?.id, 'gold ring', 'the only recipe at 5');
  assert.equal(nextJewellery(8, price)?.id, 'gold necklace', 'gold necklace +102 and 20 xp beats the amulet +88 and 30 xp');
  assert.equal(nextJewellery(24, price)?.id, 'sapphire amulet', '+200 and 65 xp at 1,000 an hour beats gold at 1,500');
  assert.equal(nextJewellery(56, price)?.id, 'diamond necklace');
  assert.equal(nextJewellery(24, price, 3_000)?.id, 'gold necklace', 'too poor for a sapphire batch: stay on gold');
});

test('jewellery: GE buys the mould once, then bars; bank withdraws a trip; the furnace is used with a gold bar', async () => {
  const p = new JewelleryPlanner({ price });
  await next(p, bankOpen(8, [coins(50_000)], []));
  const buyMould = act(await next(p, state(8, [coins(50_000)], ge)));
  assert.equal((buyMould as { name: string }).name, 'Necklace mould');
  const withMould = [coins(50_000), item(1, 1597, 'Necklace mould')];
  const buyBars = act(await next(p, state(8, withMould, ge))) as { op: string; name: string; quantity: number };
  assert.deepEqual([buyBars.op, buyBars.name], ['ge_buy', 'Gold bar']);
  // Bars in the bank: withdraw a trip of 26.
  const bank = bankOpen(8, withMould, [{ id: 2357, name: 'Gold bar', quantity: 300 }]);
  assert.deepEqual(act(await next(p, bank)), { op: 'bank_withdraw', itemId: 2357, amount: 26 });
  // A trip carried, a furnace beside: use a bar on it.
  const bars = Array.from({ length: 26 }, (_, i) => item(2 + i, 2357, 'Gold bar'));
  const furnace = { id: 16469, name: 'Furnace', type: 'GAME', actions: ['Smelt'], position: { x: 3109, y: 3499, plane: 0 }, distance: 3, reachable: true, pathDistance: 3 };
  const use = act(await next(p, state(8, [coins(100), withMould[1]!, ...bars], { objects: [furnace, tree()] })));
  assert.equal(use?.op, 'use_item_on');
  // The make menu open: pick the product.
  const menu = state(8, [coins(100), withMould[1]!, ...bars], { production: { open: true, interface: 'make', options: ['Gold necklace'] } } as Partial<Snapshot>);
  assert.deepEqual(act(await next(p, menu)), { op: 'production_select', option: 'Gold necklace' });
});

test('jewellery: finished pieces go to the bank, then out as notes to sell', async () => {
  const p = new JewelleryPlanner({ price });
  await next(p, bankOpen(8, [coins(50_000)], []));
  const mould = item(1, 1597, 'Necklace mould');
  const made = Array.from({ length: 26 }, (_, i) => item(2 + i, 1654, 'Gold necklace'));
  assert.deepEqual(act(await next(p, bankOpen(8, [coins(100), mould, ...made], []))), { op: 'bank_deposit', itemId: 1654, amount: 'all' });
  assert.deepEqual(act(await next(p, bankOpen(8, [coins(100), mould], [{ id: 1654, name: 'Gold necklace', quantity: 26 }]))), { op: 'bank_withdraw', itemId: 1654, amount: 'all', noted: true });
});
