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

test('watchdog: an alternating loop blames the targeted action, not the dialogue continue', () => {
  const w = new ProgressWatchdog({ repeatLimit: 3 });
  const s = snapshot();
  const cont = { kind: 'acted', source: 'gate', action: { op: 'dialogue_continue' }, label: 'Continue', outcome: { success: true, effect: 'changed: dialogue', after: s } } as unknown as StepResult;
  let v = null;
  for (let i = 0; i < 3 && !v; i++) v = w.observe(cont) ?? w.observe(acted(s));
  assert.match(v!.reason, /Continue/);
  assert.deepEqual(v!.action, chop);
});

test('watchdog: clicks that start the skilling animation are not a loop; the idle window still applies', () => {
  let t = 0;
  const w = new ProgressWatchdog({ repeatLimit: 4, windowMs: 60_000, now: () => t });
  const s = snapshot();
  const fish = { ...acted(s, 'Fishing spot: Small Net'), outcome: { success: true, effect: 'changed: animation', changes: ['animation'], after: s } } as unknown as StepResult;
  for (let i = 0; i < 10; i++) assert.equal(w.observe(fish), null);
  t = 61_000;
  assert.match(w.observe(fish)?.reason ?? '', /no progress/);
});

test('watchdog: clicking through a long dialogue (new text each time) is progress', () => {
  const w = new ProgressWatchdog({ repeatLimit: 3 });
  const cont = (text: string) => {
    const s = snapshot();
    s.dialogue = { inDialogue: true, hasContinue: true, hasOptions: false, text, options: [] };
    return { kind: 'acted', source: 'gate', action: { op: 'dialogue_continue' }, label: 'Click to continue the dialogue', outcome: { success: true, effect: 'changed: dialogue', changes: ['dialogue'], after: s } } as unknown as StepResult;
  };
  for (let i = 0; i < 8; i++) assert.equal(w.observe(cont(`line ${i}`)), null);
  assert.equal(w.observe(cont('same')), null); // new text once more
  w.observe(cont('same'));
  w.observe(cont('same'));
  assert.ok(w.observe(cont('same')));
});

test('watchdog: going up and down a staircase on the same spot is not progress', () => {
  let t = 0;
  const w = new ProgressWatchdog({ windowMs: 60_000, repeatLimit: 100, now: () => t });
  const at = (plane: number) => {
    const s = snapshot();
    s.player = { ...s.player!, position: { x: 3109, y: 3366, plane } };
    return s;
  };
  for (let i = 0; i < 20; i++) {
    t += 4000;
    const v = w.observe(acted(at(i % 3), 'Staircase: Climb-up'));
    if (t >= 60_000) {
      assert.ok(v, 'trips once the window passes');
      return;
    }
    assert.equal(v, null);
  }
});
