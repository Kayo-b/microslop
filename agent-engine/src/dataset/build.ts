/**
 * Builds the fine-tuning mix from all sources and splits it for evaluation:
 *
 *   decisions  logged Jev decisions with a verified effect        (export.ts)
 *   reverse    goals reverse-generated from logged states          (reverse.ts)
 *   synthetic  rule-labelled knowledge questions from the KB       (synth.ts)
 *
 * Eval holds out whole runs (every decision and reverse example from ~10% of runs, chosen by a
 * hash of the run id), so no state is seen in both splits, plus every 10th synthetic example.
 *
 * Run: node src/dataset/build.ts [--logs logs/agent] [--kb data/kb.sqlite] [--out data/dataset]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { type Example, exportDataset } from './export.ts';
import { reverseDataset } from './reverse.ts';
import { synthesize } from './synth.ts';

export function isEvalRun(runId: string, fraction = 0.1): boolean {
  const h = createHash('sha1').update(runId).digest().readUInt32BE(0);
  return h / 0xffffffff < fraction;
}

export function split(examples: Example[]): { train: Example[]; eval: Example[] } {
  const train: Example[] = [];
  const evalSet: Example[] = [];
  for (const e of examples) {
    const held = e.source === ('synthetic' as Example['source']) ? e.step % 10 === 0 : isEvalRun(e.runId);
    (held ? evalSet : train).push(e);
  }
  return { train, eval: evalSet };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      logs: { type: 'string', default: 'logs/agent' },
      kb: { type: 'string', default: 'data/kb.sqlite' },
      out: { type: 'string', default: 'data/dataset' },
    },
  });
  const logs = path.resolve(values.logs!);
  const decisions = exportDataset(logs).examples;
  const reverse = reverseDataset(logs).examples;
  const synthetic = synthesize(new DatabaseSync(values.kb!, { readOnly: true }), decisions.map((d) => d.state as Record<string, unknown>), 600, 7);
  const all = [...decisions, ...reverse, ...synthetic];
  const { train, eval: evalSet } = split(all);
  const out = path.resolve(values.out!);
  mkdirSync(out, { recursive: true });
  const write = (name: string, rows: Example[]) => writeFileSync(path.join(out, name), rows.map((e) => JSON.stringify(e)).join('\n') + '\n');
  write('train.jsonl', train);
  write('eval.jsonl', evalSet);
  const count = (rows: Example[]) => rows.reduce<Record<string, number>>((m, e) => ((m[e.source] = (m[e.source] ?? 0) + 1), m), {});
  const stats = { total: all.length, train: { n: train.length, bySource: count(train) }, eval: { n: evalSet.length, bySource: count(evalSet) } };
  writeFileSync(path.join(out, 'mix-stats.json'), JSON.stringify(stats, null, 2));
  console.log(JSON.stringify(stats));
}
