import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestAmulet, StringingPlanner } from '../src/goalplan/StringingPlanner.ts';
import type { PlanStep } from '../src/planner/types.ts';
import type { InventoryItem, Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

// 2026-10-06 mid prices: only emerald pays after the 2% tax.
const prices: Record<string, number> = {
  'Ball of wool': 67,
  'Gold amulet (u)': 146, 'Gold amulet': 131,
  'Sapphire amulet (u)': 434, 'Sapphire amulet': 425,
  'Emerald amulet (u)': 575, 'Emerald amulet': 711,
  'Ruby amulet (u)': 990, 'Ruby amulet': 1069,
  'Diamond amulet (u)': 1824, 'Diamond amulet': 1942,
};
const price = (n: string) => prices[n] ?? null;
const coins = (n: number) => item(0, 995, 'Coins', { quantity: n, stackable: true });
const state = (items: InventoryItem[], extra: Partial<Snapshot> = {}) => snapshot({ inventory: { freeSlots: 28 - items.length, items }, ...extra });
const next = (p: StringingPlanner, s: Snapshot) => p.next({ goal: 'string', snapshot: s, kb: null, reports: [] });
const act = (st: PlanStep) => (st.kind === 'act' ? st.action : null);
const text = (st: PlanStep) => (st.kind === 'subgoal' ? st.subgoal.text : st.kind === 'impossible' ? st.reason : st.kind);
const bankOpen = (inv: InventoryItem[], bank: { id: number; name: string; quantity: number }[]) =>
  state(inv, { bank: { open: true, items: bank.map((b, slot) => ({ slot, ...b })) } } as Partial<Snapshot>);

test('stringing: the amulet with the best margin after tax is chosen, none when nothing pays', () => {
  assert.deepEqual(bestAmulet(price), { unstrung: 'Emerald amulet (u)', strung: 'Emerald amulet', profit: 55, cost: 642 });
  assert.equal(bestAmulet((n) => (n === 'Emerald amulet' ? 600 : price(n))), null);
});

test('stringing: buys amulets, then as much wool, within the coins', async () => {
  const ge = { grandExchange: { open: true } } as Partial<Snapshot>;
  const p = new StringingPlanner({ price });
  await next(p, bankOpen([coins(60_000)], []));
  // (60,000 - 500) / ceil(642 * 1.35) = 68 amulets.
  assert.deepEqual(act(await next(p, state([coins(60_000)], ge))), { op: 'ge_buy', name: 'Emerald amulet (u)', quantity: 68 });
  const notes = item(1, 1700, 'Emerald amulet (u)', { noted: true, quantity: 68, stackable: true });
  assert.deepEqual(act(await next(p, state([coins(16_000), notes], ge))), { op: 'ge_buy', name: 'Ball of wool', quantity: 68 });
  const wool = item(2, 1760, 'Ball of wool', { noted: true, quantity: 68, stackable: true });
  assert.deepEqual(act(await next(p, state([coins(10_000), notes, wool], ge))), { op: 'ge_close' });
});

test('stringing: the GE bank turns notes into 13 + 13 (coins take a slot), then the wool is used on the amulets', async () => {
  const p = new StringingPlanner({ price });
  const notes = item(1, 1700, 'Emerald amulet (u)', { noted: true, quantity: 68, stackable: true });
  assert.match(text(await next(p, state([coins(10_000), notes]))), /open the Grand Exchange bank/);
  assert.deepEqual(act(await next(p, bankOpen([coins(10_000), notes], []))), { op: 'bank_deposit', itemId: 1700, amount: 'all' });
  const stock = [{ id: 1699, name: 'Emerald amulet (u)', quantity: 68 }, { id: 1759, name: 'Ball of wool', quantity: 68 }];
  assert.deepEqual(act(await next(p, bankOpen([coins(10_000)], stock))), { op: 'bank_withdraw', itemId: 1699, amount: 13 });
  const amulets = Array.from({ length: 13 }, (_, i) => item(1 + i, 1699, 'Emerald amulet (u)'));
  assert.deepEqual(act(await next(p, bankOpen([coins(10_000), ...amulets], stock))), { op: 'bank_withdraw', itemId: 1759, amount: 13 });
  const wool = Array.from({ length: 13 }, (_, i) => item(14 + i, 1759, 'Ball of wool'));
  const string = await next(p, state([coins(10_000), ...amulets, ...wool]));
  assert.ok(string.kind === 'subgoal' && string.subgoal.targets?.includes('Ball of wool') && string.subgoal.doneWhen?.lacksItem === 'Emerald amulet (u)', text(string));
});

test('stringing: strung amulets are banked, then sold as notes', async () => {
  const p = new StringingPlanner({ price });
  const strung = Array.from({ length: 14 }, (_, i) => item(1 + i, 1696, 'Emerald amulet'));
  assert.match(text(await next(p, state([coins(10_000), ...strung]))), /open the Grand Exchange bank/);
  assert.deepEqual(act(await next(p, bankOpen([coins(10_000), ...strung], []))), { op: 'bank_deposit', itemId: 1696, amount: 'all' });
  assert.deepEqual(act(await next(p, bankOpen([coins(10_000)], [{ id: 1696, name: 'Emerald amulet', quantity: 68 }]))), { op: 'bank_withdraw', itemId: 1696, amount: 'all', noted: true });
  const notes = item(1, 1697, 'Emerald amulet', { noted: true, quantity: 68, stackable: true });
  assert.deepEqual(act(await next(p, bankOpen([coins(10_000), notes], []))), { op: 'bank_close' }, 'notes withdrawn to sell stay carried');
  assert.match(text(await next(p, state([coins(10_000), notes]))), /Grand Exchange to sell/);
  assert.deepEqual(act(await next(p, state([coins(10_000), notes], { grandExchange: { open: true } } as Partial<Snapshot>))), { op: 'ge_sell', name: 'Emerald amulet' });
});

test('stringing: gives up when nothing pays or coins are short', async () => {
  const p = new StringingPlanner({ price: (n) => (n === 'Emerald amulet' ? 600 : price(n)) });
  await next(p, bankOpen([coins(60_000)], []));
  assert.match(text(await next(p, state([coins(60_000)]))), /no free-to-play amulet/);
  const q = new StringingPlanner({ price });
  await next(q, bankOpen([coins(5_000)], []));
  assert.match(text(await next(q, state([coins(5_000)]))), /do not buy 13/);
});
