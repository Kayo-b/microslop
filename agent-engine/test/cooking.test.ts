import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COOK_PRESETS, CookingPlanner } from '../src/planner/CookingPlanner.ts';
import { item, snapshot, tree } from './support/fixtures.ts';

const task = COOK_PRESETS['cook-shrimps']!;
const text = (s: { kind: string; subgoal?: { text: string } }) => (s.kind === 'subgoal' ? s.subgoal!.text : s.kind);
const tools = () => [item(0, 1351, 'Bronze axe'), item(1, 590, 'Tinderbox')];
const raw = (n: number, from = 2) => Array.from({ length: n }, (_, i) => item(from + i, 317, 'Raw shrimps'));

test('cooking loop: bank -> chop -> light -> cook, stepping aside when fires are not allowed', async () => {
  const p = new CookingPlanner(task);
  const ctx = (s: ReturnType<typeof snapshot>, reports: never[] = []) => ({ goal: 'g', snapshot: s, kb: null, reports });

  assert.match(text(await p.next(ctx(snapshot({ inventory: { freeSlots: 28, items: [] } })))), /open the bank/);

  const bank = snapshot({ inventory: { freeSlots: 26, items: [item(0, 315, 'Shrimps'), item(1, 7954, 'Burnt shrimp')] } });
  bank.bank = { open: true, items: [{ slot: 0, id: 317, name: 'Raw shrimps', quantity: 240 }, { slot: 1, id: 1351, name: 'Bronze axe', quantity: 1 }, { slot: 2, id: 590, name: 'Tinderbox', quantity: 1 }] };
  assert.match(text(await p.next(ctx(bank))), /deposit the Shrimps, Burnt shrimp/);
  bank.inventory = { freeSlots: 28, items: [] };
  assert.match(text(await p.next(ctx(bank))), /withdraw 1 Bronze axe, 1 Tinderbox, 25 Raw shrimps/);

  const ready = snapshot({ inventory: { freeSlots: 1, items: [...tools(), ...raw(25)] }, objects: [tree()] });
  assert.match(text(await p.next(ctx(ready))), /chop a tree/);
  ready.inventory.items.push(item(27, 1511, 'Logs'));
  assert.match(text(await p.next(ctx(ready))), /light a fire/);
  const refused = { subgoal: 'light a fire', result: 'blocked', reason: "stuck: 3 failed actions (last: Use Tinderbox on Logs -> failed: You can't light a fire here.)", steps: 3, trail: [] };
  assert.match(text(await p.next(ctx(ready, [refused] as never))), /step away/);

  ready.objects.push({ id: 26185, name: 'Fire', type: 'GAME', actions: [], position: { x: 1, y: 1, plane: 0 }, distance: 1, reachable: true, pathDistance: 1 });
  assert.match(text(await p.next(ctx(ready))), /cook the raw shrimps on the fire/);
});

test('cooking loop completes when the bank has no raw food left', async () => {
  const p = new CookingPlanner(task);
  const bank = snapshot({ inventory: { freeSlots: 26, items: tools() } });
  bank.bank = { open: true, items: [] };
  await p.next({ goal: 'g', snapshot: bank, kb: null, reports: [] });
  const out = snapshot({ inventory: { freeSlots: 26, items: tools() } });
  assert.equal((await p.next({ goal: 'g', snapshot: out, kb: null, reports: [] })).kind, 'complete');
});
