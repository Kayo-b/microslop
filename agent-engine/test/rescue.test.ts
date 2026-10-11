import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRescueLog, RescuingPlanner, type Rescuer } from '../src/llm/rescue.ts';
import type { Planner, PlannerContext, PlanStep, SubGoalReport } from '../src/planner/types.ts';
import { snapshot } from './support/fixtures.ts';

const walkAround: PlanStep = { kind: 'subgoal', subgoal: { text: 'walk around the fence', targets: [], actions: [] } };
const chop: PlanStep = { kind: 'subgoal', subgoal: { text: 'chop a tree', targets: ['Tree'], actions: ['Chop down'] } };

function ctx(reports: SubGoalReport[] = []): PlannerContext {
  return { goal: 'chop logs', snapshot: snapshot(), kb: null, reports };
}

class Fixed implements Planner {
  readonly name = 'fixed';
  step: PlanStep;
  constructor(step: PlanStep) {
    this.step = step;
  }
  async next(): Promise<PlanStep> {
    return this.step;
  }
}

class Scripted implements Rescuer {
  readonly name = 'scripted';
  calls = 0;
  async rescue(): Promise<PlanStep> {
    this.calls++;
    return walkAround;
  }
}

test('rescue: an impossible scripted plan is rescued once per reason, and the outcome is logged', async () => {
  const inner = new Fixed({ kind: 'impossible', reason: 'blocked 3 times on "chop a tree"' });
  const rescuer = new Scripted();
  const log = new MemoryRescueLog();
  const p = new RescuingPlanner(inner, rescuer, log, { maxPerReason: 1 });

  assert.deepEqual(await p.next(ctx()), walkAround);
  const rescue = log.records[0]!;
  assert.ok(rescue.kind === 'rescue' && rescue.trigger === 'impossible' && rescue.planner === 'fixed');

  const report: SubGoalReport = { subgoal: 'walk around the fence', result: 'done', reason: 'ok', steps: 4, trail: [] };
  const again = await p.next(ctx([report]));
  assert.equal(again.kind, 'impossible', 'same reason is not rescued twice');
  const outcome = log.records[1]!;
  assert.ok(outcome.kind === 'outcome' && outcome.id === rescue.id && outcome.result === 'done');
  assert.equal(rescuer.calls, 1);
});

test('rescue: a watchdog-stuck sub-goal is rescued before the scripted planner resumes; engine failure streaks are not', async () => {
  const inner = new Fixed(chop);
  const rescuer = new Scripted();
  const log = new MemoryRescueLog();
  const p = new RescuingPlanner(inner, rescuer, log);

  const failures: SubGoalReport = { subgoal: 'chop a tree', result: 'blocked', reason: 'stuck: 3 failed actions in a row', steps: 3, trail: [] };
  assert.deepEqual(await p.next(ctx([failures])), chop);

  const loop: SubGoalReport = { subgoal: 'chop a tree', result: 'blocked', reason: 'stuck: loop: "Tree: Chop down" 6 times without progress', steps: 12, trail: [] };
  assert.deepEqual(await p.next(ctx([failures, loop])), walkAround);
  assert.deepEqual(await p.next(ctx([failures, loop])), chop, 'same stuck report is not rescued twice');
  assert.equal(rescuer.calls, 1);
});

test('rescue: a rescuer error is logged and the scripted answer stands', async () => {
  const inner = new Fixed({ kind: 'impossible', reason: 'no route' });
  const log = new MemoryRescueLog();
  const p = new RescuingPlanner(inner, { name: 'broken', rescue: async () => { throw new Error('no credentials'); } }, log);
  assert.equal((await p.next(ctx())).kind, 'impossible');
  const rec = log.records[0]!;
  assert.ok(rec.kind === 'rescue' && rec.proposal.kind === 'error' && /no credentials/.test((rec.proposal as { reason: string }).reason));
});

test('rescue: a loop report goes to the rescuer with its evidence; loops share one budget', async () => {
  const seen: { trigger: string; evidence?: string[] }[] = [];
  const rescuer: Rescuer = { name: 'r', rescue: async (_c, req) => (seen.push({ trigger: req.trigger, evidence: req.evidence }), walkAround) };
  const p = new RescuingPlanner(new Fixed(chop), rescuer, new MemoryRescueLog(), { maxPerReason: 2 });
  const loop = (n: number): SubGoalReport => ({ subgoal: 'take the poison', result: 'blocked', reason: `loop: ${n} min within 20 tiles`, steps: 40, trail: ['most frequent actions: 54x Trapdoor: Open -> changed: dialogue', 'game messages: The trapdoor is locked.', 'Trapdoor: Open -> changed: dialogue'] });
  const reports: SubGoalReport[] = [loop(8)];
  assert.deepEqual(await p.next(ctx(reports)), walkAround);
  assert.equal(seen[0]!.trigger, 'loop');
  assert.deepEqual(seen[0]!.evidence, ['most frequent actions: 54x Trapdoor: Open -> changed: dialogue', 'game messages: The trapdoor is locked.']);
  reports.push({ subgoal: 'walk around the fence', result: 'done', reason: 'ok', steps: 3, trail: [] });
  assert.deepEqual(await p.next(ctx(reports)), chop);
  reports.push(loop(9));
  assert.deepEqual(await p.next(ctx(reports)), walkAround);
  reports.push({ subgoal: 'walk around the fence', result: 'done', reason: 'ok', steps: 3, trail: [] });
  await p.next(ctx(reports));
  reports.push(loop(11));
  // Budget for loops used up: the scripted planner continues; the agent gives up on the next loop verdict.
  assert.deepEqual(await p.next(ctx(reports)), chop);
  assert.equal(seen.length, 2);
});

test('rescue: the same sub-goal blocked twice in a row at engine level is rescued before the route is abandoned', async () => {
  const inner = new Fixed(chop);
  const rescuer = new Scripted();
  const log = new MemoryRescueLog();
  const p = new RescuingPlanner(inner, rescuer, log);

  const noOptions: SubGoalReport = { subgoal: 'smelt the bars', result: 'blocked', reason: 'no options (nothing interactable nearby and no known destination)', steps: 1, trail: [] };
  assert.deepEqual(await p.next(ctx([noOptions])), chop, 'one failure is left to the scripted planner');
  assert.deepEqual(await p.next(ctx([noOptions, noOptions])), walkAround);
  const rec = log.records[0]!;
  assert.ok(rec.kind === 'rescue' && rec.trigger === 'blocked');
  assert.deepEqual(await p.next(ctx([noOptions, noOptions])), chop, 'the same streak is not rescued twice');
  assert.equal(rescuer.calls, 1);
});

test('rescue: a loop that alternates done and blocked reports (open the bank / fail to use it) is rescued too', async () => {
  const inner = new Fixed(chop);
  const rescuer = new Scripted();
  const p = new RescuingPlanner(inner, rescuer, new MemoryRescueLog());
  const done: SubGoalReport = { subgoal: 'open the bank', result: 'done', reason: 'completion check passed', steps: 2, trail: [] };
  const blocked: SubGoalReport = { subgoal: 'close the bank', result: 'blocked', reason: 'no effect: "close the bank" sent 9 times and nothing changed', steps: 1, trail: [] };
  const reports = [done, blocked, done, blocked, done];
  assert.deepEqual(await p.next(ctx(reports)), chop, 'two blocked in six is not yet a loop');
  assert.deepEqual(await p.next(ctx([...reports, blocked])), walkAround, 'three blocked in the last six is');
  assert.equal(rescuer.calls, 1);
});

test('rescue: a fresh stuck verdict from the run watcher triggers a rescue once, with its diagnosis and fix as the evidence', async () => {
  const { readWatchHint } = await import('../src/llm/watchFeed.ts');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'watch-')), 'latest.json');
  const now = Date.now();
  const write = (o: object) => writeFileSync(file, JSON.stringify(o));
  write({ ts: new Date(now - 30_000).toISOString(), status: 'stuck', severity: 3, diagnosis: 'open the bank loops', suggestion: 'withdraw the mould' });
  assert.equal(readWatchHint(file, now - 60_000, 8 * 60_000, now)?.status, 'stuck');
  assert.equal(readWatchHint(file, now, 8 * 60_000, now), null, 'a review from before this run started is ignored');
  write({ ts: new Date(now - 20 * 60_000).toISOString(), status: 'stuck', severity: 3, diagnosis: 'x', suggestion: '' });
  assert.equal(readWatchHint(file, 0, 8 * 60_000, now), null, 'stale');
  write({ ts: new Date(now - 30_000).toISOString(), status: 'slow', severity: 3, diagnosis: 'x', suggestion: '' });
  assert.equal(readWatchHint(file, 0, 8 * 60_000, now), null, 'only stuck or wrong');

  let hint: ReturnType<typeof readWatchHint> = { id: 't1', status: 'stuck', severity: 3, diagnosis: 'open the bank loops', suggestion: 'withdraw the mould' };
  const seen: string[][] = [];
  const rescuer: Rescuer = { name: 'r', rescue: async (_c, req) => { seen.push([req.trigger, req.reason, ...(req.evidence ?? [])]); return walkAround; } };
  const log = new MemoryRescueLog();
  const p = new RescuingPlanner(new Fixed(chop), rescuer, log, { watchFeed: () => hint });
  assert.deepEqual(await p.next(ctx()), walkAround);
  assert.equal(seen[0]![0], 'watcher');
  assert.match(seen[0]![1]!, /open the bank loops/);
  assert.match(seen[0]![2]!, /withdraw the mould/);
  assert.deepEqual(await p.next(ctx()), chop, 'the same verdict is not acted on twice');
  hint = { id: 't2', status: 'wrong', severity: 2, diagnosis: 'another', suggestion: '' };
  assert.deepEqual(await p.next(ctx()), walkAround, 'a new verdict is');
});
