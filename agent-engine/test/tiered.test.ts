import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { LlmClient, StructuredRequest, StructuredResult } from '../src/llm/providers.ts';
import { AnthropicClient } from '../src/llm/providers.ts';
import type { RescueRequest, Rescuer } from '../src/llm/rescue.ts';
import { createTiers, GuardedLlm, HourlyBudget, type LlmCallRecord, TieredRescuer } from '../src/llm/tiered.ts';
import type { PlannerContext, PlanStep } from '../src/planner/types.ts';
import { snapshot } from './support/fixtures.ts';

const ctx: PlannerContext = { goal: 'g', snapshot: snapshot(), kb: null, reports: [] };

function fakeRescuer(name: string, answer: PlanStep, calls: string[]): Rescuer {
  return { name, rescue: async (_c, req) => (calls.push(`${name}:${req.trigger}`), answer) };
}

const sub: PlanStep = { kind: 'subgoal', subgoal: { text: 'open the door', targets: ['Door'], actions: ['Open'] } };
const stuck = (reason: string): RescueRequest => ({ trigger: 'stuck', reason, planner: 'p' });

test('tiered rescue: tier 1 first, tier 2 for a repeated reason or a loop', async () => {
  const calls: string[] = [];
  const r = new TieredRescuer(fakeRescuer('haiku', sub, calls), fakeRescuer('sonnet', sub, calls));
  await r.rescue(ctx, stuck('stuck: no progress for 30 steps'));
  await r.rescue(ctx, stuck('stuck: no progress for 45 steps'));
  await r.rescue(ctx, { trigger: 'loop', reason: 'loop: 3 cycles', planner: 'p' });
  assert.deepEqual(calls, ['haiku:stuck', 'sonnet:stuck', 'sonnet:loop']);
});

test('tiered rescue: tier 1 giving up or failing escalates at once', async () => {
  const calls: string[] = [];
  const r = new TieredRescuer(fakeRescuer('haiku', { kind: 'impossible', reason: 'no idea' }, calls), fakeRescuer('sonnet', sub, calls));
  assert.deepEqual(await r.rescue(ctx, stuck('a')), sub);
  const broken: Rescuer = { name: 'broken', rescue: async () => Promise.reject(new Error('503')) };
  assert.deepEqual(await new TieredRescuer(broken, fakeRescuer('sonnet', sub, calls)).rescue(ctx, stuck('b')), sub);
  assert.deepEqual(calls, ['haiku:stuck', 'sonnet:stuck', 'sonnet:stuck']);
});

test('hourly budget: refuses once spent, frees up after an hour', () => {
  let t = 0;
  const b = new HourlyBudget(2, () => t);
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false);
  t = 3_600_001;
  assert.equal(b.take(), true);
  assert.equal(b.used, 1);
});

test('guarded llm: logs every call and refuses over budget without calling the model', async () => {
  let called = 0;
  const inner: LlmClient = {
    name: 'fake:model',
    structured: async <T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> => (called++, { kind: 'ok', value: req.schema.parse({ a: 1 }) }),
  };
  const log: LlmCallRecord[] = [];
  const llm = new GuardedLlm(inner, { tier: 1, purpose: 'quest', budget: new HourlyBudget(1), log: (r) => log.push(r) });
  const req = { system: 's', user: 'u', schema: z.object({ a: z.number() }), schemaName: 'x' };
  assert.deepEqual(await llm.structured(req), { kind: 'ok', value: { a: 1 } });
  const over = await llm.structured(req);
  assert.equal(over.kind, 'refusal');
  assert.equal(called, 1);
  assert.deepEqual(log.map((r) => [r.purpose, r.tier, r.result]), [['quest', 1, 'ok'], ['quest', 1, 'over_budget']]);
  assert.deepEqual(log[0]!.response, { a: 1 });
});

test('tiers: Anthropic gets Haiku then Sonnet; an explicit model or another provider uses one client', () => {
  const t = createTiers({}, { ANTHROPIC_API_KEY: 'k' })!;
  assert.ok(t.tier1 instanceof AnthropicClient && t.tier2 instanceof AnthropicClient);
  assert.equal(t.tier1.name, 'anthropic:claude-haiku-4-5');
  assert.equal(t.tier2.name, 'anthropic:claude-sonnet-5-5');
  const one = createTiers({ model: 'claude-opus-5-5' }, { ANTHROPIC_API_KEY: 'k' })!;
  assert.equal(one.tier1, one.tier2);
  const other = createTiers({}, { OPENROUTER_API_KEY: 'k' })!;
  assert.equal(other.tier1, other.tier2);
  assert.equal(createTiers({}, {}), null);
});
