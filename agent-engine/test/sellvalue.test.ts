import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geLosesToShop, sellValue } from '../src/goalplan/sellValue.ts';
import { SellPlanner } from '../src/goalplan/SellPlanner.ts';
import { item, snapshot } from './support/fixtures.ts';

test('sell value: GE quick-sell is 70% minus 2% tax; cheap items pay no tax; shops pay 40% of store value', () => {
  const v = sellValue(1000, 100);
  assert.equal(v.ge, 700 - 14);
  assert.equal(v.shop, 40);
  assert.equal(v.best, 'ge');
  assert.equal(sellValue(60, null).ge, 42);
  assert.equal(sellValue(null, null).best, 'unknown');
  assert.ok(geLosesToShop(sellValue(10, 100)), 'a 10 gp guide price loses to a 100 gp item at a store');
});

test('sell planner: an item a store would buy for more is not sold on the Grand Exchange', async () => {
  const logs: string[] = [];
  const planner = new SellPlanner({ items: ['Odd item'], bank: () => new Map(), prices: { guide: () => 10, store: () => 100, log: (m) => logs.push(m) } });
  const s = snapshot({ inventory: { freeSlots: 27, items: [item(0, 1, 'Odd item')] } });
  const step = await planner.next({ goal: 'sell', snapshot: s, kb: null, reports: [] });
  assert.equal(step.kind, 'complete');
  assert.match(logs[0] ?? '', /not selling it on the Grand Exchange/);

  const fine = new SellPlanner({ items: ['Odd item'], bank: () => new Map(), prices: { guide: () => 1000, store: () => 100 } });
  assert.notEqual((await fine.next({ goal: 'sell', snapshot: s, kb: null, reports: [] })).kind, 'complete');
});
