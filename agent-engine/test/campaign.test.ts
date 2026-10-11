import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Activity, type ActivityResult, type CampaignDeps, chooseActivity, DEFAULT_CONFIG, parseOutcome, runCampaign } from '../src/campaign/runner.ts';

test('campaign: parses the agent outcome line', () => {
  assert.deepEqual(parseOutcome('...\n[agent] impossible: out of arrows (3 sub-goals, 40 steps)\n'), { status: 'impossible', reason: 'out of arrows (3 sub-goals, 40 steps)' });
  assert.equal(parseOutcome('crash trace'), null);
});

test('campaign: weighted choice skips cooldowns, LLM-only activities without an LLM, and the last activity', () => {
  const acts: Activity[] = [{ name: 'a', args: [] }, { name: 'b', args: [] }, { name: 'q', args: [], needsLlm: true, weight: 100 }];
  assert.equal(chooseActivity(acts, new Map([['a', 2]]), false, () => 0.5)?.name, 'b');
  assert.equal(chooseActivity(acts, new Map(), true, () => 0.99, 'a')?.name, 'q');
  assert.equal(chooseActivity(acts, new Map(), false, () => 0, 'a')?.name, 'b');
});

function fakeDeps(outcomes: string[], health: { reachable: boolean; loggedIn: boolean }[]): CampaignDeps & { results: ActivityResult[]; logins: number; ran: string[] } {
  let t = 0;
  let h = 0;
  const d = {
    results: [] as ActivityResult[],
    logins: 0,
    ran: [] as string[],
    hasLlm: false,
    stopped: () => false,
    now: () => t,
    random: () => 0,
    sleep: async (ms: number) => void (t += ms),
    log: () => {},
    record: (r: ActivityResult) => d.results.push(r),
    health: async () => health[Math.min(h++, health.length - 1)]!,
    login: async () => (d.logins++, true),
    relaunchClient: async () => {},
    rebuildDataset: async () => {},
    runActivity: async (a: Activity, minutes: number) => {
      d.ran.push(a.name);
      const o = outcomes.shift() ?? 'timeout';
      t += (o === 'timeout' ? minutes : 5) * 60_000;
      if (o.startsWith('watcher:')) return { output: 'killed mid-step', timedOut: false, code: null, endedBy: o.slice(8) };
      return o === 'timeout' ? { output: '', timedOut: true, code: null } : { output: `[agent] ${o}`, timedOut: false, code: 0 };
    },
  };
  return d;
}

test('campaign: logs in when logged out, puts impossible activities on cooldown, stops at the deadline', async () => {
  const cfg = { ...DEFAULT_CONFIG, hours: 1.5, breakMinutes: [1, 1] as [number, number], activities: [{ name: 'a', args: [] }, { name: 'b', args: [] }] };
  const d = fakeDeps(['impossible: no coins', 'complete: done', 'timeout', 'timeout'], [{ reachable: true, loggedIn: false }, { reachable: true, loggedIn: true }]);
  const res = await runCampaign(cfg, d);
  assert.equal(d.logins, 1);
  assert.deepEqual(d.ran.slice(0, 3), ['a', 'b', 'b'], 'a sits out after impossible');
  assert.equal(res[0]!.status, 'impossible');
  assert.equal(res[2]!.status, 'timeout');
  assert.ok(d.now() <= 1.5 * 3_600_000 + 60_000 * 2);
});

test('campaign: stops after three failed recoveries (expired session)', async () => {
  const cfg = { ...DEFAULT_CONFIG, hours: 5, activities: [{ name: 'a', args: [] }] };
  const d = fakeDeps([], [{ reachable: true, loggedIn: false }]);
  const res = await runCampaign(cfg, d);
  assert.equal(res.length, 0);
  assert.equal(d.logins, 9);
});

test('campaign: an agent ended by the run watcher is recorded as stopped, not crashed, and runs again', async () => {
  const cfg = { ...DEFAULT_CONFIG, hours: 0.5, breakMinutes: [1, 1] as [number, number], activities: [{ name: 'a', args: [], final: true }] };
  const d = fakeDeps(['watcher:looping at the bank', 'timeout'], [{ reachable: true, loggedIn: true }]);
  const res = await runCampaign(cfg, d);
  assert.equal(res[0]!.status, 'stopped');
  assert.match(res[0]!.reason, /ended by the run watcher: looping at the bank/);
  assert.deepEqual(d.ran.slice(0, 2), ['a', 'a'], 'no cooldown after a watcher skip');
});
