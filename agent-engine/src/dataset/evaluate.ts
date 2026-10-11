/**
 * Scores a System 1 engine (Laya or Jev) on held-out examples: top-1 against the hard label,
 * "credit" (the pick is any option the soft label accepts, e.g. another cow), chance level,
 * confidence when right vs wrong, and latency, per source and per rule family.
 *
 * Run: node src/dataset/evaluate.ts [--engine laya] [--model typed-decisions]
 *      [--data data/dataset/eval.jsonl] [--limit 0] [--concurrency 4] [--seed 1]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createDecisionEngine } from '../decision/adapters.ts';
import type { DecisionEngineAdapter, DecisionQuestion } from '../decision/types.ts';
import type { Example } from './export.ts';
import { rng } from './reverse.ts';

interface Score {
  n: number;
  top1: number;
  credit: number;
  chance: number;
  confRight: number[];
  confWrong: number[];
  latency: number[];
  errors: number;
}

const empty = (): Score => ({ n: 0, top1: 0, credit: 0, chance: 0, confRight: [], confWrong: [], latency: [], errors: 0 });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] ?? NaN;

export function summarize(s: Score) {
  return {
    n: s.n,
    top1: +(s.top1 / s.n).toFixed(3),
    credit: +(s.credit / s.n).toFixed(3),
    chance: +(s.chance / s.n).toFixed(3),
    confidenceWhenRight: +mean(s.confRight).toFixed(3),
    confidenceWhenWrong: +mean(s.confWrong).toFixed(3),
    latencyMsP50: Math.round(pct(s.latency, 0.5)),
    errors: s.errors,
  };
}

export async function evaluate(engine: DecisionEngineAdapter, examples: Example[], concurrency = 4, onProgress?: (done: number) => void) {
  const groups = new Map<string, Score>();
  const bucket = (k: string) => groups.get(k) ?? (groups.set(k, empty()), groups.get(k)!);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < examples.length) {
      const e = examples[next++]!;
      const qid = Object.keys(e.labels)[0]!;
      const q = e.questions![qid] as DecisionQuestion;
      const options = q.type === 'choice' ? Object.keys(q.criteria) : [];
      const keys = ['all', `source:${e.source}`, ...(e.source === ('synthetic' as Example['source']) ? [`family:${e.outcome}`] : [])];
      try {
        const res = await engine.decide({ state: e.state, questions: { [qid]: q } });
        const a = res.answers[qid];
        const choice = a?.type === 'choice' ? a.choice : undefined;
        const conf = a?.type === 'choice' ? a.confidence : 0;
        const right = choice === e.labels[qid];
        const credited = !!choice && (e.soft?.[qid]?.[choice] ?? (right ? 1 : 0)) > 0;
        for (const k of keys) {
          const s = bucket(k);
          s.n++;
          s.top1 += right ? 1 : 0;
          s.credit += credited ? 1 : 0;
          s.chance += options.length ? 1 / options.length : 0;
          (credited ? s.confRight : s.confWrong).push(conf);
          s.latency.push(res.latencyMs);
        }
      } catch {
        for (const k of keys) bucket(k).errors++;
      }
      onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, summarize(s)]));
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string', default: 'laya' },
      model: { type: 'string' },
      data: { type: 'string', default: 'data/dataset/eval.jsonl' },
      limit: { type: 'string', default: '0' },
      concurrency: { type: 'string', default: '4' },
      seed: { type: 'string', default: '1' },
    },
  });
  let examples = readFileSync(values.data!, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Example).filter((e) => e.questions && Object.keys(e.labels).length);
  const limit = Number(values.limit);
  if (limit > 0 && examples.length > limit) {
    // Stratified-ish: shuffle with a fixed seed so runs are comparable.
    const r = rng(Number(values.seed));
    examples = examples.map((e) => ({ e, k: r() })).sort((a, b) => a.k - b.k).slice(0, limit).map((x) => x.e);
  }
  const engine = createDecisionEngine(values.engine, { model: values.model, timeoutMs: 60_000 });
  const t0 = Date.now();
  const report = await evaluate(engine, examples, Number(values.concurrency), (d) => {
    if (d % 100 === 0) process.stderr.write(`  ${d}/${examples.length}\n`);
  });
  const out = { engine: values.engine, model: values.model ?? null, data: values.data, examples: examples.length, seconds: Math.round((Date.now() - t0) / 1000), report };
  const file = path.join('data', 'dataset', `eval-${values.engine}${values.model ? `-${values.model}` : ''}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.report, null, 1));
  console.log(`-> ${file}`);
}
