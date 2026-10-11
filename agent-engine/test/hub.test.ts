import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubPluginPlanner, type HubSpec } from '../src/goalplan/HubPluginPlanner.ts';
import { AGILITY, bestAlch, bestSmelt, bestSmith, smithingSpec } from '../src/goalplan/hubSpecs.ts';
import type { PlanStep } from '../src/planner/types.ts';
import type { InventoryItem, Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

// Live-like prices (2026-10-10).
const PRICES: Record<string, number> = {
  'Nature rune': 140, 'Rune arrow': 43, 'Gold bar': 66, 'Steel platebody': 929, 'Yew longbow (u)': 157, 'Amethyst arrow': 139, 'Maple longbow (u)': 72,
  'Iron bar': 185, 'Steel bar': 532, 'Mithril bar': 950, 'Adamantite bar': 1867, 'Runite bar': 12191,
  'Iron platebody': 93, 'Mithril platebody': 2732, 'Adamant platebody': 9450, 'Iron platelegs': 66, 'Steel platelegs': 346, 'Mithril platelegs': 1200, 'Adamant platelegs': 4000,
  'Iron ore': 73, Coal: 143, 'Mithril ore': 158, 'Adamantite ore': 557, Hammer: 20, 'Staff of fire': 905,
};
const price = (n: string) => PRICES[n] ?? null;

function fakeBackend() {
  const calls: string[] = [];
  return {
    calls,
    pluginConfig: async (g: string, k: string, v: string) => void calls.push(`config ${g}.${k}=${v}`),
    pluginStart: async (c: string) => void calls.push(`start ${c}`),
    pluginStop: async (c: string) => void calls.push(`stop ${c}`),
    pluginState: async () => ({ loaded: true, active: false }),
  };
}

const SPEC: HubSpec = {
  id: 'test',
  className: 'x.TestPlugin',
  group: 'test',
  skill: 'Magic',
  plan: () => ({ label: 'alch', config: { a: '1' }, supplies: [{ name: 'Nature rune', want: 100, min: 10 }], sell: ['Iron bar'], start: { name: 'GE', point: { x: 3164, y: 3489, plane: 0 } } }),
};
const coins = (n: number) => item(0, 995, 'Coins', { quantity: n, stackable: true });
const at = { x: 3164, y: 3489, plane: 0 };
const state = (items: InventoryItem[], extra: Partial<Snapshot> = {}, xp = 5000, level = 21) => {
  const base = snapshot({ inventory: { freeSlots: 28 - items.length, items }, ...extra });
  return { ...base, player: { ...base.player!, position: at }, skills: [{ name: 'Magic', level, boosted: level, xp }] };
};
const next = (p: HubPluginPlanner, s: Snapshot) => p.next({ goal: 'g', snapshot: s, kb: null, reports: [] });
const desc = (st: PlanStep) => (st.kind === 'act' ? st.action.op : st.kind === 'subgoal' ? st.subgoal.text : st.kind);

test('hub: short supplies go through the GE: withdraw coins, buy, deposit, then the plugin starts with its config', async () => {
  const be = fakeBackend();
  const p = new HubPluginPlanner(SPEC, { backend: be, price, bank: () => new Map([['Coins', 500_000]]) });
  assert.match(desc(await next(p, state([]))), /open the Grand Exchange bank to restock/);
  const bankOpen = { bank: { open: true, items: [item(0, 995, 'Coins', { quantity: 500_000 })] } } as Partial<Snapshot>;
  assert.equal(desc(await next(p, state([], bankOpen))), 'bank_withdraw', 'coins for the supplies');
  const bankLeft = { bank: { open: true, items: [item(0, 995, 'Coins', { quantity: 20_000 })] } } as Partial<Snapshot>;
  assert.equal(desc(await next(p, state([coins(480_000)], bankLeft))), 'bank_close');
  assert.match(desc(await next(p, state([coins(480_000)]))), /open the Grand Exchange$/);
  const ge = { grandExchange: { open: true } } as Partial<Snapshot>;
  const buy = await next(p, state([coins(480_000)], ge));
  assert.deepEqual(buy.kind === 'act' && buy.action, { op: 'ge_buy', name: 'Nature rune', quantity: 100 });
  const bought = item(1, 561, 'Nature rune', { quantity: 100, stackable: true });
  assert.equal(desc(await next(p, state([coins(460_000), bought], ge))), 'ge_close');
  const bank2 = { bank: { open: true, items: [item(0, 995, 'Coins', { quantity: 20_000 })] } } as Partial<Snapshot>;
  assert.equal(desc(await next(p, state([coins(460_000), bought], bank2))), 'bank_deposit_all');
  const stocked = { bank: { open: true, items: [item(0, 995, 'Coins', { quantity: 480_000 }), item(1, 561, 'Nature rune', { quantity: 100 })] } } as Partial<Snapshot>;
  assert.equal(desc(await next(p, state([], stocked))), 'bank_close', 'restock done');
  assert.equal(desc(await next(p, state([], stocked))), 'bank_close', 'closed before starting');
  assert.equal((await next(p, state([]))).kind, 'wait');
  assert.deepEqual(be.calls, ['config test.a=1', 'start x.TestPlugin']);
});

test('hub: no XP for the stall window stops the plugin and re-checks the bank; the level target completes', async () => {
  const be = fakeBackend();
  let t = 0;
  const p = new HubPluginPlanner(SPEC, { backend: be, price, untilLevel: 25, now: () => t, bank: () => new Map([['Coins', 100_000], ['Nature rune', 50]]) });
  assert.equal((await next(p, state([]))).kind, 'wait');
  t += 60_000;
  assert.equal((await next(p, state([], {}, 5100))).kind, 'wait', 'XP rises');
  t += 5 * 60_000;
  assert.match(desc(await next(p, state([], {}, 5100))), /open the nearest bank/, 'stalled: look at the bank again');
  assert.deepEqual(be.calls.slice(-1), ['stop x.TestPlugin']);
  assert.equal((await next(p, state([], {}, 9000, 25))).kind, 'complete');
});

test('hub specs: alching picks the best item for the account; rooftops follow the level', () => {
  assert.equal(bestAlch(60, true, price)?.name, 'Yew longbow (u)');
  assert.ok(bestAlch(60, true, price)!.perCast > 0, 'high alching unstrung yew longbows pays');
  assert.equal(bestAlch(30, false, price)?.name, 'Gold bar', 'free worlds');
  const agi = (level: number) => {
    const r = AGILITY.plan({ level, levels: () => level, coins: 0, owned: () => 0, price, members: true });
    return typeof r === 'string' ? r : r.config.course;
  };
  assert.equal(agi(16), 'DRAYNOR_VILLAGE_ROOFTOP_COURSE');
  assert.equal(agi(63), 'SEERS_VILLAGE_ROOFTOP_COURSE');
  assert.equal(typeof AGILITY.plan({ level: 40, levels: () => 40, coins: 0, owned: () => 0, price, members: false }), 'string');
});

test('hub specs: smithing smelts for profit when coins are short and smiths the cheapest XP when they are not', () => {
  assert.equal(bestSmith(90, price)?.item, 'Adamant platebody');
  assert.ok(bestSmith(90, price)!.gpPerXp < 1);
  assert.equal(bestSmelt(72, price)?.bar, 'Adamantite bar');
  const spec = smithingSpec();
  const run = (level: number, coins: number) => spec.plan({ level, levels: () => level, coins, owned: () => 0, price, members: false });
  const poor = run(70, 200_000);
  assert.ok(typeof poor === 'object' && poor.className?.endsWith('AutoSmeltingPlugin'), 'smelt with 200k');
  const rich = run(70, 30_000_000);
  assert.ok(typeof rich === 'object' && rich.className?.endsWith('VarrockAnvilPlugin') && rich.config.smithObject === 'PLATE_BODY');
  const cheap = run(90, 500_000);
  assert.ok(typeof cheap === 'object' && cheap.config.barType === 'ADAMANTITE', 'adamant platebodies are nearly free: smith even with little coin');
});
