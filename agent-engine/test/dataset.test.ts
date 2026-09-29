import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { goalsFor, intentKey, parseOption, reverseFromRecord, rng } from '../src/dataset/reverse.ts';
import { synthesize } from '../src/dataset/synth.ts';
import { isEvalRun } from '../src/dataset/build.ts';
import type { StepRecord } from '../src/engine/log.ts';

test('reverse: option labels parse into name, action and product', () => {
  const rock = parseOption('obj:11361@3285,3368,0#Mine', 'Copper rocks: Mine (Mining 1, gives Copper ore) - 4 tiles');
  assert.equal(rock.name, 'Copper rocks');
  assert.equal(rock.product, 'Copper ore');
  assert.equal(rock.distance, 4);
  const cow = parseOption('npc:2802#Attack', 'Cow (level 2): Attack (8 hp, max hit 1, Crush) - 3 tiles');
  assert.equal(cow.name, 'Cow');
  const w = parseOption('bank:w10:317', 'Withdraw 10 Raw shrimps (bank has 156; you need 25 more)');
  assert.deepEqual([w.kind, w.action, w.name, w.amount], ['bank', 'Withdraw', 'Raw shrimps', '10']);
  assert.ok(parseOption('npc:1#Net', 'Fishing spot: Net (Fishing 1, Raw shrimps; missing small fishing net) - 11 tiles').unusable);
  assert.equal(intentKey(parseOption('npc:3#Bank', 'Banker: Bank - 2 tiles')), intentKey(parseOption('obj:1@1,1,0#Bank', 'Bank booth: Bank - 1 tiles')));
  assert.ok(goalsFor(rock)!.some((g) => /copper ore/.test(g)));
});

test('reverse: equivalent options share the soft label, the nearest is the hard label, stale need hints are dropped', () => {
  const record = {
    runId: 'r1', step: 1, subgoal: 'x', state: { subgoal: 'x', location: 'Lumbridge' },
    questions: { target: { type: 'choice', instructions: 'x', criteria: {
      'npc:1#Attack': 'Cow (level 2): Attack (8 hp, max hit 1, Crush) - 5 tiles',
      'npc:2#Attack': 'Cow (level 2): Attack (8 hp, max hit 1, Crush) - 2 tiles',
      'bank:w5:995': 'Withdraw 5 Coins (bank has 900; you need 400 more)',
      'inv:0#Eat': 'Inventory Shrimps: Eat',
    } } },
  } as unknown as StepRecord;
  const freq = new Map([['Attack|Cow', 1]]);
  const ex = reverseFromRecord(record, new Map(), freq, rng(3), { perState: 3, perPattern: 60, seed: 1 });
  const cow = ex.find((e) => /cow/.test(e.subgoal))!;
  assert.equal(cow.labels.target, 'npc:2#Attack');
  assert.equal(cow.soft!.target!['npc:1#Attack'], 0.5);
  assert.ok(ex.every((e) => !Object.values((e.questions!.target as { criteria: Record<string, string> }).criteria).some((l) => /you need/.test(l))));
});

test('synthetic: every family labels an option that exists, answers follow the rules', () => {
  const db = new DatabaseSync('data/kb.sqlite', { readOnly: true });
  const ex = synthesize(db, [{ subgoal: 'x', location: 'Varrock', inventory: '28 free slots', skills: 'Hitpoints 10' }], 20, 11);
  const families = new Set(ex.map((e) => e.outcome));
  assert.equal(families.size, 7);
  for (const e of ex) {
    const c = (e.questions!.target as { criteria: Record<string, string> }).criteria;
    assert.ok(c[e.labels.target!], `${e.outcome}: label ${e.labels.target} missing`);
    assert.ok(Math.abs(Object.values(e.soft!.target!).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
  const weakest = ex.find((e) => e.outcome === 'rule:monster' && /weakest|lowest|easiest/.test(e.subgoal))!;
  const c = (weakest.questions!.target as { criteria: Record<string, string> }).criteria;
  const lvl = (id: string) => Number(/level (\d+)/.exec(c[id]!)![1]);
  assert.equal(lvl(weakest.labels.target!), Math.min(...Object.keys(c).map(lvl)));
});

test('build: eval split holds out whole runs deterministically', () => {
  assert.equal(isEvalRun('2026-09-29T10-23-15-389Z'), isEvalRun('2026-09-29T10-23-15-389Z'));
  const runs = Array.from({ length: 1000 }, (_, i) => `run-${i}`).filter((r) => isEvalRun(r)).length;
  assert.ok(runs > 60 && runs < 140, String(runs));
});
