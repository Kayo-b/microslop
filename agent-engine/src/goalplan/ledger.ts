/**
 * Per-account state for plan runs, under data/accounts/<account>/: bank memory, failed-phase skips,
 * the rescue log, the LLM call log and the phase ledger. The ledger is one line per finished phase
 * (minutes, XP, outcome); the compiler uses its observed XP/hour in place of the catalog estimates.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface AccountPaths {
  dir: string;
  bank: string;
  failures: string;
  rescues: string;
  llmCalls: string;
  ledger: string;
}

export function accountPaths(dir: string): AccountPaths {
  return {
    dir,
    bank: path.join(dir, 'bank-seen.json'),
    failures: path.join(dir, 'strategy-failures.json'),
    rescues: path.join(dir, 'rescues.jsonl'),
    llmCalls: path.join(dir, 'llm-calls.jsonl'),
    ledger: path.join(dir, 'ledger.jsonl'),
  };
}

export interface LedgerRecord {
  ts: string;
  plan: string;
  phase: string;
  text: string;
  outcome: 'done' | 'gave_up' | 'over';
  reason: string;
  minutes: number;
  xp: Record<string, number>;
  /** Skill the phase trained, for XP/hour. */
  skill?: string;
}

export function appendLedger(file: string, rec: LedgerRecord): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

export function readJsonl<T>(file: string): T[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A line cut short by a crash.
    }
  }
  return out;
}

/** Observed XP/hour per phase id, from phases of at least `minMinutes` that trained a skill. */
export function observedRates(records: LedgerRecord[], minMinutes = 5): Map<string, number> {
  const sums = new Map<string, { xp: number; minutes: number }>();
  for (const r of records) {
    if (!r.skill || r.outcome === 'gave_up' || r.minutes < minMinutes) continue;
    const acc = sums.get(r.phase) ?? { xp: 0, minutes: 0 };
    acc.xp += r.xp[r.skill] ?? 0;
    acc.minutes += r.minutes;
    sums.set(r.phase, acc);
  }
  const out = new Map<string, number>();
  for (const [id, { xp, minutes }] of sums) if (xp > 0) out.set(id, (xp / minutes) * 60);
  return out;
}
