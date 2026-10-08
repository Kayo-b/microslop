import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideIntervention } from '../src/campaign/watcher.ts';

const stuck = (action: 'close_interfaces' | 'cancel_walk' | 'skip_activity' | 'none', severity = 3) => ({ status: 'stuck' as const, severity, action });

test('watcher: healthy or mild reviews never act', () => {
  assert.equal(decideIntervention({ status: 'ok', severity: 0, action: 'skip_activity' }, 5, 1e9), 'none');
  assert.equal(decideIntervention({ status: 'slow', severity: 3, action: 'skip_activity' }, 5, 1e9), 'none');
  assert.equal(decideIntervention(stuck('skip_activity', 1), 5, 1e9), 'none');
  assert.equal(decideIntervention(stuck('none'), 5, 1e9), 'none');
});

test('watcher: the first stuck verdict is left to the rescue; the watcher acts on repeats, skipping last', () => {
  assert.equal(decideIntervention(stuck('close_interfaces'), 1, 0), 'none', 'first review: the rescue gets it');
  assert.equal(decideIntervention(stuck('close_interfaces'), 2, 0), 'close_interfaces');
  assert.equal(decideIntervention(stuck('cancel_walk'), 2, 0), 'cancel_walk');
  assert.equal(decideIntervention(stuck('skip_activity'), 2, 1e9), 'close_interfaces', 'second review: only the soft fix');
  assert.equal(decideIntervention(stuck('skip_activity'), 3, 1e9), 'skip_activity');
  assert.equal(decideIntervention(stuck('skip_activity'), 4, 60_000), 'none', 'just skipped one a minute ago');
  assert.equal(decideIntervention({ status: 'wrong', severity: 2, action: 'skip_activity' }, 3, 1e9), 'skip_activity');
});
