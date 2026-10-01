import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionKey, LoopDetector } from '../src/agent/loopDetector.ts';
import type { StepResult } from '../src/engine/GameIntentEngine.ts';
import type { Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

function at(x: number, y: number, plane = 0, extra: (s: Snapshot) => void = () => {}): Snapshot {
  const s = snapshot();
  s.player = { ...s.player!, position: { x, y, plane } };
  extra(s);
  return s;
}

const acted = (after: Snapshot, label: string, messages: string[] = []): StepResult =>
  ({ kind: 'acted', source: 'model', action: { op: 'interact' }, label, outcome: { success: true, effect: 'changed: dialogue', after, messages } }) as unknown as StepResult;

test('loop detector: the same few clicks with nothing gained trip it, with evidence', () => {
  const d = new LoopDetector({ window: 12, maxDistinct: 3 });
  let v = null;
  for (let i = 0; i < 40 && !v; i++) {
    v = d.observe(acted(at(3108, 3354, i % 3), ['Trapdoor: Open - 1 tiles', 'Staircase: Climb-up - 2 tiles', 'Staircase: Climb-down - 1 tiles'][i % 3]!, ['The trapdoor is locked.']));
  }
  assert.ok(v);
  assert.match(v!.reason, /repeat 3 click/);
  assert.ok(v!.evidence.some((e) => /Trapdoor: Open/.test(e) && /most frequent/.test(e)));
  assert.ok(v!.evidence.some((e) => /trapdoor is locked/.test(e)));
});

test('loop detector: gathering (XP and items) never trips it', () => {
  const d = new LoopDetector({ window: 10, maxDistinct: 2 });
  for (let i = 0; i < 60; i++) {
    const s = at(3100, 3200, 0, (x) => {
      x.skills = x.skills.map((k) => (k.name === 'Woodcutting' ? { ...k, xp: k.xp + i * 25 } : k));
      x.inventory = { freeSlots: 27 - (i % 27), items: Array.from({ length: i % 27 }, (_, j) => item(j, 1511, 'Logs')) };
    });
    assert.equal(d.observe(acted(s, 'Tree: Chop down - 1 tiles')), null, `step ${i}`);
  }
});

test('loop detector: minutes in one small area without progress trip it; leaving it does not', () => {
  let t = 0;
  const d = new LoopDetector({ areaMs: 8 * 60_000, window: 1000, now: () => t });
  for (let i = 0; i < 40; i++) {
    t += 10_000;
    assert.equal(d.observe(acted(at(3100 + (i % 15), 3300), `walk to spot ${i}`)), null);
  }
  t += 10_000;
  assert.equal(d.observe(acted(at(3200, 3300), 'walk far away')), null, 'left the area: progress');
  let v = null;
  for (let i = 0; i < 60 && !v; i++) {
    t += 10_000;
    v = d.observe(acted(at(3200 + (i % 10), 3300), `walk to spot ${i}`));
  }
  assert.ok(v);
  assert.match(v!.reason, /min within 20 tiles/);
});

test('loop detector: distances and counts do not make clicks distinct', () => {
  assert.equal(actionKey('walk to Nearest Imp (21 tiles)'), actionKey('walk to Nearest Imp (17 tiles)'));
  assert.equal(actionKey('Imp (level 2): Attack - 13 tiles'), actionKey('Imp (level 2): Attack - 3 tiles'));
});

test('agent: the third loop verdict ends the run; the first ones end the sub-goal for the planner', async () => {
  const { Agent } = await import('../src/agent/Agent.ts');
  const s = at(3108, 3354);
  const backend = { snapshot: async () => s, act: async () => ({ success: true, op: 'x', tick: 1 }) };
  const engine = {
    step: async () => acted(s, 'Trapdoor: Open - 1 tiles', ['The trapdoor is locked.']),
    withhold: () => false,
    recentHistory: [],
  };
  const planner = { name: 'p', next: async () => ({ kind: 'subgoal' as const, subgoal: { text: 'go down the trapdoor', targets: ['Trapdoor'], maxSteps: 1000 } }) };
  const reasons: string[] = [];
  const agent = new Agent({
    backend: backend as never,
    engine: engine as never,
    planner,
    watchdog: { repeatLimit: 10_000, windowMs: 10_000_000 },
    loop: { window: 10, maxDistinct: 2 },
    sleep: async () => {},
    onEvent: (e) => e.type === 'report' && reasons.push(e.report.reason),
  });
  const out = await agent.run('ernest');
  assert.equal(out.status, 'impossible');
  assert.match(out.reason, /stuck in a loop/);
  assert.equal(reasons.filter((r) => r.startsWith('loop:')).length, 3);
});
