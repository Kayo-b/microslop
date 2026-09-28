/**
 * Exports logged decisions as supervised examples for fine-tuning a System 1 model (Laya).
 *
 * Each output line is a `/v1/systemone`-shaped request plus gold labels:
 *   { state, questions, labels: {qid: optionId}, soft: {qid: {optionId: p}} | null,
 *     source, outcome, subgoal, engine, runId, step }
 *
 * Kept:
 *   - model decisions whose action was verified successful (label = the model's own answers,
 *     soft targets = its probability distribution),
 *   - escalations whose action succeeded (label = the escalator's choice, no soft targets:
 *     these are the corrections that teach the student what the teacher missed),
 *   - model "done" answers (no action to verify; kept only with --include-done).
 *
 * Run: node src/dataset/export.ts [--logs logs/agent] [--out data/dataset/decisions.jsonl] [--include-done]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { StepRecord } from '../engine/log.ts';

export interface Example {
  state: unknown;
  questions: StepRecord['questions'];
  labels: Record<string, string>;
  soft: Record<string, Record<string, number>> | null;
  source: StepRecord['source'];
  outcome: string;
  subgoal: string;
  engine: string;
  runId: string;
  step: number;
}

export function toExample(r: StepRecord, includeDone = false): Example | null {
  if (!r.questions || !r.chosen || !r.state) return null;
  if (r.source !== 'model' && r.source !== 'escalation') return null;
  const acted = r.outcome !== undefined;
  if (acted && !r.outcome!.success) return null;
  if (!acted && !(includeDone && r.chosen.op === 'done')) return null;

  const labels: Record<string, string> = {};
  if (r.questions.op) labels.op = r.chosen.op;
  if (r.chosen.op === 'interact' && r.chosen.optionId && r.questions.target) labels.target = r.chosen.optionId;
  if (r.chosen.op === 'walk' && r.chosen.optionId && r.questions.destination) labels.destination = r.chosen.optionId;
  if (Object.keys(labels).length === 0) return null;

  let soft: Example['soft'] = null;
  if (r.source === 'model' && r.answers) {
    soft = {};
    for (const qid of Object.keys(labels)) {
      const a = r.answers[qid];
      if (a?.type === 'choice' && a.probabilities) soft[qid] = a.probabilities;
    }
    if (Object.keys(soft).length === 0) soft = null;
  }

  // Only the questions that carry a label are training signal for this example.
  const questions = Object.fromEntries(Object.entries(r.questions).filter(([qid]) => qid in labels));
  return {
    state: r.state,
    questions,
    labels,
    soft,
    source: r.source,
    outcome: r.outcome?.effect ?? 'done',
    subgoal: r.subgoal,
    engine: r.engine,
    runId: r.runId,
    step: r.step,
  };
}

export function exportDataset(logsDir: string, includeDone = false): { examples: Example[]; scanned: number } {
  const examples: Example[] = [];
  let scanned = 0;
  if (!existsSync(logsDir)) return { examples, scanned };
  for (const run of readdirSync(logsDir)) {
    const file = path.join(logsDir, run, 'steps.jsonl');
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      scanned++;
      const ex = toExample(JSON.parse(line) as StepRecord, includeDone);
      if (ex) examples.push(ex);
    }
  }
  return { examples, scanned };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      logs: { type: 'string', default: 'logs/agent' },
      out: { type: 'string', default: 'data/dataset/decisions.jsonl' },
      'include-done': { type: 'boolean', default: false },
    },
  });
  const { examples, scanned } = exportDataset(path.resolve(values.logs!), values['include-done']);
  mkdirSync(path.dirname(path.resolve(values.out!)), { recursive: true });
  writeFileSync(values.out!, examples.map((e) => JSON.stringify(e)).join('\n') + (examples.length ? '\n' : ''));
  const bySource = examples.reduce<Record<string, number>>((m, e) => ((m[e.source] = (m[e.source] ?? 0) + 1), m), {});
  console.log(`${examples.length} examples from ${scanned} logged steps -> ${values.out} ${JSON.stringify(bySource)}`);
}
