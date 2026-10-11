import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestRecipe, HerblorePlanner, nextRecipe } from '../src/goalplan/HerblorePlanner.ts';
import type { PlanStep } from '../src/planner/types.ts';
import type { InventoryItem, Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

// 2026-10-06 mid prices.
const prices: Record<string, number> = {
  'Vial of water': 5,
  'Grimy guam leaf': 275, 'Guam leaf': 357, 'Guam potion (unf)': 289,
  'Grimy marrentill': 229, Marrentill: 425, 'Marrentill potion (unf)': 241,
  'Grimy tarromin': 212, Tarromin: 319, 'Tarromin potion (unf)': 377,
  'Grimy harralander': 331, Harralander: 445, 'Harralander potion (unf)': 661,
  'Grimy ranarr weed': 5687, 'Ranarr weed': 5892, 'Ranarr potion (unf)': 6274,
};
const price = (n: string) => prices[n] ?? null;
// Without ranarr in reach the best level-22 recipe is mixing; the training detour has its own test.
const noRanarr = (n: string) => (/ranarr/i.test(n) ? null : price(n));
const coins = (n: number) => item(0, 995, 'Coins', { quantity: n, stackable: true });
const state = (level: number, items: InventoryItem[], extra: Partial<Snapshot> = {}) => {
  const s = snapshot({ inventory: { freeSlots: 28 - items.length, items }, ...extra });
  s.skills.push({ name: 'Herblore', level, boosted: level, xp: 0 });
  return s;
};
const next = (p: HerblorePlanner, s: Snapshot) => p.next({ goal: 'herb', snapshot: s, kb: null, reports: [] });
const act = (st: PlanStep) => (st.kind === 'act' ? st.action : null);
const text = (st: PlanStep) => (st.kind === 'subgoal' ? st.subgoal.text : st.kind === 'impossible' ? st.reason : st.kind);
const bankOpen = (level: number, inv: InventoryItem[], bank: { id: number; name: string; quantity: number }[]) =>
  state(level, inv, { bank: { open: true, items: bank.map((b, slot) => ({ slot, ...b })) } } as Partial<Snapshot>);

test('herblore: the best recipe per hour for the level, from live prices', () => {
  assert.equal(bestRecipe(3, price)?.id, 'clean:Guam leaf');
  assert.equal(bestRecipe(5, price)?.id, 'clean:Marrentill', '+188 each beats guam');
  assert.equal(bestRecipe(22, price)?.id, 'mix:Harralander', 'clean harralander + vial: +198 each but twice as fast as cleaning first (+312)');
  assert.equal(bestRecipe(30, price)?.id, 'mix:Ranarr weed');
  const dearClean = (n: string) => (n === 'Harralander' ? 520 : price(n));
  assert.equal(bestRecipe(22, dearClean)?.id, 'unf:Harralander', 'clean herbs dear: clean the grimy ones first');
  assert.equal(bestRecipe(1, price), null, 'no recipe below Herblore 3');
});

test('herblore: trains by cleaning while a much better recipe is in reach, instead of mixing unfinished potions forever', () => {
  assert.equal(nextRecipe(22, price, 150_000)?.id, 'clean:Harralander', 'ranarr unf (level 30) beats harralander unf: clean for XP');
  assert.equal(nextRecipe(22, price, 5_000)?.id, 'mix:Harralander', 'too poor to buy a ranarr batch: keep earning');
  assert.equal(nextRecipe(30, price, 150_000)?.id, 'mix:Ranarr weed', 'level reached: mix');
  assert.equal(nextRecipe(5, price, 150_000)?.id, bestRecipe(5, price)?.id, 'no better recipe in reach: unchanged');
});

test('herblore: cleaning loop - buy grimy herbs, withdraw 27, clean, bank, sell', async () => {
  const p = new HerblorePlanner({ price });
  await next(p, bankOpen(5, [coins(50_000)], []));
  // (50,000 - 500) / ceil(229 * 1.32) = 163.
  assert.deepEqual(act(await next(p, state(5, [coins(50_000)], { grandExchange: { open: true } } as Partial<Snapshot>))), { op: 'ge_buy', name: 'Grimy marrentill', quantity: 163 });
  const notes = item(1, 3002, 'Grimy marrentill', { noted: true, quantity: 160, stackable: true });
  assert.deepEqual(act(await next(p, bankOpen(5, [coins(13_000), notes], []))), { op: 'bank_deposit', itemId: 3002, amount: 'all' });
  assert.deepEqual(act(await next(p, bankOpen(5, [coins(13_000)], [{ id: 201, name: 'Grimy marrentill', quantity: 160 }]))), { op: 'bank_withdraw', itemId: 201, amount: 27 });
  const grimy = Array.from({ length: 27 }, (_, i) => item(1 + i, 201, 'Grimy marrentill', { actions: ['Clean', 'Drop'] }));
  const clean = await next(p, state(5, [coins(13_000), ...grimy]));
  assert.ok(clean.kind === 'subgoal' && clean.subgoal.actions?.includes('Clean') && clean.subgoal.doneWhen?.lacksItem === 'Grimy marrentill', text(clean));
  const cleaned = Array.from({ length: 27 }, (_, i) => item(1 + i, 251, 'Marrentill'));
  assert.match(text(await next(p, state(5, [coins(13_000), ...cleaned]))), /Grand Exchange bank/);
  assert.deepEqual(act(await next(p, bankOpen(5, [coins(13_000), ...cleaned], []))), { op: 'bank_deposit', itemId: 251, amount: 'all' });
  assert.deepEqual(act(await next(p, bankOpen(5, [coins(13_000)], [{ id: 251, name: 'Marrentill', quantity: 160 }]))), { op: 'bank_withdraw', itemId: 251, amount: 'all', noted: true });
  // The withdrawn notes stay carried: the bank closes and they go to the GE.
  const notesOut = item(1, 252, 'Marrentill', { noted: true, quantity: 160, stackable: true });
  assert.deepEqual(act(await next(p, bankOpen(5, [coins(13_000), notesOut], []))), { op: 'bank_close' });
  const sold = item(1, 252, 'Marrentill', { noted: true, quantity: 160, stackable: true });
  assert.deepEqual(act(await next(p, state(5, [coins(13_000), sold], { grandExchange: { open: true } } as Partial<Snapshot>))), { op: 'ge_sell', name: 'Marrentill' });
});

test('herblore: unfinished potions from grimy herbs - clean, then mix with vials, keeping the cleaned herbs at the bank', async () => {
  const p = new HerblorePlanner({ price: (n) => (n === 'Harralander' ? 520 : noRanarr(n)) });
  await next(p, bankOpen(22, [coins(100_000)], []));
  const ge = { grandExchange: { open: true } } as Partial<Snapshot>;
  // (100,000 - 500) / ceil((331 + 5) * 1.32) = 224.
  assert.deepEqual(act(await next(p, state(22, [coins(100_000)], ge))), { op: 'ge_buy', name: 'Grimy harralander', quantity: 224 });
  const herbNotes = item(1, 256, 'Grimy harralander', { noted: true, quantity: 224, stackable: true });
  assert.deepEqual(act(await next(p, state(22, [coins(27_000), herbNotes], ge))), { op: 'ge_buy', name: 'Vial of water', quantity: 224 });
  const grimy = Array.from({ length: 14 }, (_, i) => item(1 + i, 255, 'Grimy harralander', { actions: ['Clean'] }));
  const vials = Array.from({ length: 14 }, (_, i) => item(15 + i, 227, 'Vial of water'));
  assert.match(text(await next(p, state(22, [coins(1_000), ...grimy, ...vials]))), /clean all the grimy harralanders/);
  const herbs = Array.from({ length: 14 }, (_, i) => item(1 + i, 255, 'Harralander'));
  const mix = await next(p, state(22, [coins(1_000), ...herbs, ...vials]));
  assert.ok(mix.kind === 'subgoal' && mix.subgoal.targets?.includes('Vial of water') && mix.subgoal.targets.includes('Harralander'), text(mix));
  assert.ok(mix.kind === 'subgoal' && mix.subgoal.avoid?.includes('Poll booth'));
  // 14 herbs, 13 vials: done when the vials are gone, not the herbs.
  const uneven = await next(p, state(22, [coins(1_000), ...herbs, ...vials.slice(0, 13)]));
  assert.ok(uneven.kind === 'subgoal' && uneven.subgoal.doneWhen?.lacksItem === 'Vial of water', JSON.stringify(uneven.kind === 'subgoal' && uneven.subgoal.doneWhen));
});

test('herblore: a level gained mid-run switches the recipe at the next purchase, not mid-batch', async () => {
  const p = new HerblorePlanner({ price: noRanarr });
  await next(p, bankOpen(4, [coins(50_000)], []));
  const ge = { grandExchange: { open: true } } as Partial<Snapshot>;
  assert.equal((act(await next(p, state(4, [coins(50_000)], ge))) as { name: string }).name, 'Grimy guam leaf');
  // Level 5 with guam still banked: keep cleaning guam.
  await next(p, bankOpen(5, [coins(40_000)], [{ id: 199, name: 'Grimy guam leaf', quantity: 100 }]));
  assert.deepEqual(act(await next(p, state(5, [coins(40_000)], ge))), { op: 'ge_close' });
  // Stock gone: the next purchase is marrentill.
  await next(p, bankOpen(5, [coins(40_000)], []));
  assert.equal((act(await next(p, state(5, [coins(40_000)], ge))) as { name: string }).name, 'Grimy marrentill');
});

test('herblore: a purchase refused for coins (client guide price above the wiki) shrinks the next one', async () => {
  const p = new HerblorePlanner({ price });
  await next(p, bankOpen(5, [coins(50_000)], []));
  const ge = state(5, [coins(50_000)], { grandExchange: { open: true } } as Partial<Snapshot>);
  assert.deepEqual(act(await p.next({ goal: 'h', snapshot: ge, kb: null, reports: [] })), { op: 'ge_buy', name: 'Grimy marrentill', quantity: 163 });
  const refused = { subgoal: 'buy', result: 'blocked' as const, reason: 'failed: not_enough_coins (need 80000, have 50000)', steps: 1, trail: [] };
  const retry = act(await p.next({ goal: 'h', snapshot: ge, kb: null, reports: [refused] })) as { quantity: number };
  assert.ok(retry.quantity > 0 && retry.quantity <= Math.floor(163 * (50 / 80) * 0.95) + 1, `${retry.quantity}`);
});

test('herblore: a full inventory is processed as it is, never a withdraw into no free slot', async () => {
  const p = new HerblorePlanner({ price: noRanarr });
  const herbs = Array.from({ length: 14 }, (_, i) => item(1 + i, 255, 'Harralander'));
  const vials = Array.from({ length: 13 }, (_, i) => item(15 + i, 227, 'Vial of water'));
  const full = bankOpen(22, [coins(87_000), ...herbs, ...vials], [{ id: 255, name: 'Harralander', quantity: 157 }, { id: 227, name: 'Vial of water', quantity: 158 }]);
  full.inventory.freeSlots = 0;
  assert.deepEqual(act(await next(p, full)), { op: 'bank_close' });
});

test('herblore: gives up without a paying recipe or the coins for a trip', async () => {
  const p = new HerblorePlanner({ price });
  await next(p, bankOpen(5, [coins(1_000)], []));
  assert.match(text(await next(p, state(5, [coins(1_000)]))), /do not buy 10/);
  // 10,208 coins (the live account) is enough for a first, partial guam batch.
  const r = new HerblorePlanner({ price });
  await next(r, bankOpen(3, [coins(10_208)], []));
  assert.deepEqual(act(await next(r, state(3, [coins(10_208)], { grandExchange: { open: true } } as Partial<Snapshot>))), { op: 'ge_buy', name: 'Grimy guam leaf', quantity: 26 });
  const q = new HerblorePlanner({ price });
  await next(q, bankOpen(2, [coins(50_000)], []));
  assert.match(text(await next(q, state(2, [coins(50_000)]))), /no herblore recipe pays at Herblore 2/);
});

test('herblore training: recipes are picked by XP per hour, finished potions included, and the choice follows the level', async () => {
  const { trainingRecipe, HERB_RECIPES } = await import('../src/goalplan/HerblorePlanner.ts');
  const prices: Record<string, number> = {
    'Grimy guam leaf': 20, 'Guam leaf': 25, 'Guam potion (unf)': 30, 'Eye of newt': 5, 'Attack potion(3)': 40, 'Vial of water': 3,
    'Marrentill potion (unf)': 40, 'Unicorn horn dust': 100, 'Antipoison(3)': 120, 'Grimy marrentill': 25, Marrentill: 30,
  };
  const price = (n: string) => prices[n] ?? null;
  assert.ok(HERB_RECIPES.some((r) => r.id === 'potion:Attack potion(3)' && r.combine?.[0] === 'Eye of newt'));
  const at3 = trainingRecipe(3, price, 100_000)!;
  assert.equal(at3.id, 'potion:Attack potion(3)', '25 XP a potion beats 2.5 XP a cleaned herb');
  const at5 = trainingRecipe(5, price, 100_000)!;
  assert.ok(at5.xp >= 25 && at5.level <= 5);
  assert.equal(trainingRecipe(3, price, 100), null, 'too poor for a first batch');
  assert.equal(trainingRecipe(1, price, 100_000), null, 'no recipe below level 3');
});

test('herblore: leftover vials with no herbs left are deposited, not kept (bank reopen loop)', async () => {
  const p = new HerblorePlanner({ price: noRanarr });
  await next(p, state(22, [coins(5145)], { grandExchange: { open: true } } as Partial<Snapshot>));
  const vials = item(1, 227, 'Vial of water', { quantity: 13, stackable: true });
  const s = bankOpen(22, [coins(5145), vials], [{ id: 995, name: 'Coins', quantity: 100 }]);
  assert.deepEqual(act(await next(p, s)), { op: 'bank_deposit', itemId: 227, amount: 'all' });
});
