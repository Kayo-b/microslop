/**
 * The run watcher (src/campaign/watcher.ts) writes its latest review to data/watch/latest.json. The
 * rescue reads it between sub-goals: the reviews name the problem precisely, so a stuck/wrong
 * verdict triggers a rescue straight away instead of waiting for the in-run detectors.
 */
import { readFileSync } from 'node:fs';

export interface WatchHint {
  /** Review timestamp; a hint is acted on once. */
  id: string;
  status: string;
  severity: number;
  diagnosis: string;
  suggestion: string;
}

/** The latest review if it is fresh (under `maxAgeMs`), newer than `since` and says stuck/wrong at severity 2+. */
export function readWatchHint(file: string, since: number, maxAgeMs = 8 * 60_000, now = Date.now()): WatchHint | null {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as { ts: string; status: string; severity: number; diagnosis: string; suggestion: string };
    const at = Date.parse(r.ts);
    if (!Number.isFinite(at) || at < since || now - at > maxAgeMs) return null;
    if ((r.status !== 'stuck' && r.status !== 'wrong') || r.severity < 2) return null;
    return { id: r.ts, status: r.status, severity: r.severity, diagnosis: r.diagnosis, suggestion: r.suggestion };
  } catch {
    return null;
  }
}
