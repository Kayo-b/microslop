import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cheapestLoop, cluster, CostTable } from '../src/planner/routes.ts';

const P = (x: number, y: number) => ({ x, y, plane: 0 });

test('cluster groups nearby placements and drops thin sites', () => {
  const places = [P(0, 0), P(2, 1), P(3, 3), P(100, 100)].map((point) => ({ name: 'Iron rocks', kind: 'object' as const, point, members: false }));
  const sites = cluster(places, 12, 2);
  assert.equal(sites.length, 1);
  assert.equal(sites[0]!.name, 'Iron rocks (3)');
});

test('cheapestLoop picks the cycle with the lowest real path cost, skipping unreachable legs', async () => {
  const mines = [{ name: 'far mine', point: P(0, 0) }, { name: 'near mine', point: P(50, 0) }];
  const furnaces = [{ name: 'furnace', point: P(60, 0) }];
  const banks = [{ name: 'gated bank', point: P(55, 0) }, { name: 'open bank', point: P(70, 0) }];
  // Straight-line would pick the gated bank; the path cost says it is unreachable.
  const pathCost = async (a: { x: number }, b: { x: number }) => (a.x === 55 || b.x === 55 ? null : Math.abs(a.x - b.x));
  const best = await cheapestLoop([mines, furnaces, banks], new CostTable(pathCost as never));
  assert.deepEqual(best?.sites.map((s) => s.name), ['near mine', 'furnace', 'open bank']);
  assert.equal(best?.cost, 10 + 10 + 20);
});
