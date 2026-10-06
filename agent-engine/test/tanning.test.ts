import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TanningPlanner } from '../src/goalplan/TanningPlanner.ts';
import type { PlanStep } from '../src/planner/types.ts';
import type { InventoryItem, Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const prices: Record<string, number> = { Cowhide: 131, Leather: 227 };
const planner = (bank: Record<string, number> | null = {}) =>
  new TanningPlanner({ bank: () => (bank ? new Map(Object.entries(bank)) : null), price: (n) => prices[n] ?? null });
const coins = (n: number) => item(0, 995, 'Coins', { quantity: n, stackable: true });
const hides = (n: number, from = 1) => Array.from({ length: n }, (_, i) => item(from + i, 1739, 'Cowhide'));
const state = (items: InventoryItem[], extra: Partial<Snapshot> = {}) => snapshot({ inventory: { freeSlots: 28 - items.length, items }, ...extra });
const next = (p: TanningPlanner, s: Snapshot) => p.next({ goal: 'tan', snapshot: s, kb: null, reports: [] });
const act = (st: PlanStep) => (st.kind === 'act' ? st.action : null);
const text = (st: PlanStep) => (st.kind === 'subgoal' ? st.subgoal.text : st.kind);

test('tanning: at the Grand Exchange, leather is sold and a stack of hides bought within the coins', async () => {
  const ge = { grandExchange: { open: true } } as Partial<Snapshot>;
  assert.deepEqual(act(await next(planner(), state([coins(40_000), item(1, 1742, 'Leather', { noted: true, quantity: 120, stackable: true })], ge))), { op: 'ge_sell', name: 'Leather' });
  // (40,000 - 500 reserve) / ceil(131 * 1.35) = 223 hides.
  assert.deepEqual(act(await next(planner(), state([coins(40_000)], ge))), { op: 'ge_buy', name: 'Cowhide', quantity: 223 });
  assert.deepEqual(act(await next(planner(), state([coins(400_000)], ge))), { op: 'ge_buy', name: 'Cowhide', quantity: 270 }, 'capped per trip');
  assert.deepEqual(act(await next(planner({ Cowhide: 100 }), state([coins(40_000)], ge))), { op: 'ge_close' }, 'hides already banked');
});

test('tanning: hide notes go into the Al Kharid bank and come out as 27 hides, coins stay carried', async () => {
  const notes = item(1, 1740, 'Cowhide', { noted: true, quantity: 223, stackable: true });
  const p = planner();
  assert.match(text(await next(p, state([coins(5_000), notes]))), /open the Al Kharid bank/);
  const bankOpen = (inv: InventoryItem[], bank: { id: number; name: string; quantity: number }[]) =>
    state(inv, { bank: { open: true, items: bank.map((b, slot) => ({ slot, ...b })) } } as Partial<Snapshot>);
  assert.deepEqual(act(await next(p, bankOpen([coins(5_000), notes], []))), { op: 'bank_deposit', itemId: 1740, amount: 'all' });
  assert.deepEqual(act(await next(p, bankOpen([coins(5_000)], [{ id: 1739, name: 'Cowhide', quantity: 223 }]))), { op: 'bank_withdraw', itemId: 1739, amount: 27 });
  // Leather from the last trip goes in before the next hides come out.
  assert.deepEqual(act(await next(p, bankOpen([coins(5_000), item(1, 1741, 'Leather')], [{ id: 1739, name: 'Cowhide', quantity: 196 }]))), { op: 'bank_deposit', itemId: 1741, amount: 'all' });
});

test('tanning: carried hides go to Ellis, whose interface tans them all', async () => {
  const p = planner({ Cowhide: 196 });
  const walk = await next(p, state([coins(5_000), ...hides(27)]));
  assert.ok(walk.kind === 'subgoal' && walk.subgoal.targets?.includes('Ellis') && walk.subgoal.doneWhen?.lacksItem === 'Cowhide', text(walk));
  const open = state([coins(5_000), ...hides(27)], { production: { open: true, interface: 'tanning', options: ['Soft leather', 'Hard leather'] } } as Partial<Snapshot>);
  assert.deepEqual(act(await next(p, open)), { op: 'production_select', option: 'Soft leather' });
});

test('tanning: once the hides are tanned, the leather is withdrawn as notes and sold', async () => {
  const p = planner();
  const bankOpen = state([coins(5_000)], { bank: { open: true, items: [{ slot: 0, id: 1741, name: 'Leather', quantity: 223 }] } } as Partial<Snapshot>);
  assert.deepEqual(act(await next(p, bankOpen)), { op: 'bank_withdraw', itemId: 1741, amount: 'all', noted: true });
  const sell = await next(planner(), state([coins(5_000), item(1, 1742, 'Leather', { noted: true, quantity: 223, stackable: true })]));
  assert.match(text(sell), /Grand Exchange to sell the leather/);
});

test('tanning: gives up without coins for a batch, or when there is no margin', async () => {
  const broke = await next(planner({ Coins: 100 }), state([coins(1_000)]));
  assert.ok(broke.kind === 'impossible' && /do not buy 27 cowhides/.test(broke.reason), text(broke));
  const p = new TanningPlanner({ bank: () => new Map(), price: (n) => ({ Cowhide: 230, Leather: 227 })[n] ?? null });
  const loss = await next(p, state([coins(40_000)]));
  assert.ok(loss.kind === 'impossible' && /no profit/.test(loss.reason), text(loss));
});
