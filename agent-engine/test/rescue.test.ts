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
