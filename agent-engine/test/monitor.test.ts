import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monitorReport, type MonitorInput } from '../src/campaign/monitor.ts';

const t0 = Date.parse('2026-10-06T10:00:00Z');
const rescue = (id: string, min: number, rescuer: string, reason: string) => ({
  kind: 'rescue' as const, id, ts: new Date(t0 + min * 60_000).toISOString(), goal: 'strategy gold', trigger: 'stuck' as const, reason, planner: 'strategy:gold', rescuer,
  situation: { inventory: '', equipped: '', nearby: [], recent: [] }, proposal: { kind: 'subgoal', subgoal: { text: `fix ${id}` } } as never,
});
const outcome = (id: string, result: 'done' | 'blocked') => ({ kind: 'outcome' as const, id, ts: new Date(t0).toISOString(), result, reason: result, steps: 3 });

test('monitor: rescues by model with success rates, gold per phase, and alerts', () => {
  const m: MonitorInput = {
    now: t0 + 120 * 60_000,
    since: t0,
    unitActive: 'active',
    campaignDir: '/logs/campaign/x',
    campaignLog: ['10:00 AM ▶ gold (55 min)'],
    activity: { name: '001-gold', lines: ['[strategy] smith gear [preset]: Smithing 26', '12:00 PM   model  Mine'], modifiedAt: t0 + 100 * 60_000 },
    rescues: [
      rescue('old', -60, 'claude-code:default', 'before the window'),
      rescue('a', 5, 'claude-code:haiku', 'stuck: Gate: Open 6 times'), outcome('a', 'blocked'),
      rescue('b', 15, 'claude-code:haiku', 'stuck: Gate: Open 6 times'), outcome('b', 'blocked'),
      rescue('c', 25, 'claude-code:haiku', 'stuck: Gate: Open 6 times'), outcome('c', 'blocked'),
      rescue('d', 35, 'claude-code:haiku', 'no options'), outcome('d', 'done'),
      rescue('e', 45, 'claude-code:haiku', 'no options'), outcome('e', 'blocked'),
    ],
    gold: [{ ts: new Date(t0 + 30 * 60_000).toISOString(), plan: 'gold', phase: 'gold:cowhides', text: 'x', outcome: 'over', reason: '', minutes: 30, xp: {}, coins: 3000 }],
    skipping: ['gold:feathers'],
  };
  const text = monitorReport(m).join('\n');
  assert.match(text, /LLM rescues: 5 \(1 done of 5 settled, 20%\)/);
  assert.match(text, /model claude-code:haiku\s+5\s+20% done/);
  assert.match(text, /gold:cowhides\s+1 runs 0d\/1o\/0g\s+30 min\s+3000 coins 6000\/h/);
  assert.match(text, /Skipped .*gold:feathers/);
  assert.match(text, /! activity log silent for 20 min/);
  assert.match(text, /! rescue never helps with "stuck: Gate: Open # times"/);
  assert.match(text, /! rescue success 20%/);
});
