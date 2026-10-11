/**
 * Per-step JSONL log: exactly what the decision engine saw (state + options), what it answered,
 * what was executed and the verified outcome. One file per run under logs/agent/<runId>/.
 *
 * The same records are the training data for fine-tuning Laya later: filter to steps whose
 * outcome succeeded (or that an escalation corrected) and keep the probability distributions as
 * soft targets. See docs in agent-engine/README.md.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DecisionAnswer, DecisionQuestion } from '../decision/types.ts';
import type { GameAction } from '../types.ts';
import type { DecisionState } from './state.ts';

export type DecisionSource = 'model' | 'escalation' | 'reflex' | 'gate' | 'rule';

export interface StepRecord {
  runId: string;
  step: number;
  time: string;
  tick: number;
  subgoal: string;
  engine: string;
  source: DecisionSource;
  state?: DecisionState;
  questions?: Record<string, DecisionQuestion>;
  answers?: Record<string, DecisionAnswer>;
  model?: string;
  chosen?: { op: string; optionId?: string; label?: string; confidence?: number };
  escalation?: { reason: string; op: string; optionId?: string; note?: string };
  action?: GameAction;
  act?: { success: boolean; reason?: string };
  outcome?: { success: boolean; effect: string; ticks: number; messages: string[] };
  latencyMs?: { decision?: number; total: number };
  note?: string;
}

export interface StepLogger {
  write(record: StepRecord): void;
}

export class JsonlStepLogger implements StepLogger {
  readonly file: string;
  readonly runId: string;

  constructor(dir = 'logs/agent', runId = new Date().toISOString().replace(/[:.]/g, '-')) {
    this.runId = runId;
    const runDir = path.resolve(dir, runId);
    mkdirSync(runDir, { recursive: true });
    this.file = path.join(runDir, 'steps.jsonl');
  }

  write(record: StepRecord): void {
    appendFileSync(this.file, JSON.stringify(record) + '\n');
  }
}

export class MemoryStepLogger implements StepLogger {
  readonly records: StepRecord[] = [];
  write(record: StepRecord): void {
    this.records.push(record);
  }
}
