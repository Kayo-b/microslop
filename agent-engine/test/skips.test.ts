import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentFailures, recordFailure } from '../src/strategy/skips.ts';

test('strategy skips: a phase that failed twice in 12 h is skipped; older failures expire', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'skips-')), 'f.json');
  const h = 3_600_000;
  recordFailure(file, "quest:The Knight's Sword", 0);
  assert.equal(recentFailures(file, h).size, 0);
  recordFailure(file, "quest:The Knight's Sword", 2 * h);
  assert.deepEqual([...recentFailures(file, 3 * h)], ["quest:The Knight's Sword"]);
  assert.equal(recentFailures(file, 13 * h).size, 0);
});
