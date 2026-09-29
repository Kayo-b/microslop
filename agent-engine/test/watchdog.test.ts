import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProgressWatchdog } from '../src/agent/watchdog.ts';
import type { StepResult } from '../src/engine/GameIntentEngine.ts';
import type { GameAction, Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const chop: GameAction = { op: 'interact', target: { kind: 'object', id: 1276, x: 3100, y: 3240, plane: 0 }, action: 'Chop down' };

function acted(after: Snapshot, label = 'Tree: Chop down'): StepResult {
  return { kind: 'acted', source: 'model', action: chop, label, outcome: { success: true, effect: 'changed: animation', after } } as unknown as StepResult;
}

test('watchdog: the same action repeating without progress trips as a loop and names the action', () => {
  const w = new ProgressWatchdog({ repeatLimit: 4 });
  const s = snapshot();
  for (let i = 0; i < 3; i++) assert.equal(w.observe(acted(s)), null);
  const v = w.observe(acted(s));
  assert.match(v!.reason, /loop: "Tree: Chop down" 4 times/);
  assert.deepEqual(v!.action, chop);
});

test('watchdog: inventory or xp changes count as progress', () => {
  const w = new ProgressWatchdog({ repeatLimit: 3 });
  const s = snapshot();
  w.observe(acted(s));
  w.observe(acted(s));
  const withLog = snapshot({ inventory: { ...s.inventory, items: [...s.inventory.items, item(5, 1511, 'Logs')] } });
  assert.equal(w.observe(acted(withLog)), null);
  assert.equal(w.observe(acted(withLog)), null);
  assert.equal(w.observe(acted(withLog)), null);
  assert.ok(w.observe(acted(withLog)));
});

test('watchdog: waiting with no progress trips after the time window', () => {
  let now = 0;
  const w = new ProgressWatchdog({ windowMs: 1000, now: () => now });
  const s = snapshot();
  const waiting = { kind: 'waiting', reason: 'animating', snapshot: s } as StepResult;
  assert.equal(w.observe(waiting), null);
  now = 1500;
  assert.match(w.observe(waiting)!.reason, /no progress for 2 s/);
});
