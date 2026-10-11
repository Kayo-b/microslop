/**
 * Phases (quests, routes) that keep failing, remembered across agent runs. A campaign starts a
 * fresh `agent run` every round, so without this each round walks straight back into the quest
 * that blocked the last one (The Knight's Sword's pie ingredients, three rounds in a row).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Failures = Record<string, number[]>;

const WINDOW_MS = 12 * 3_600_000;

function read(file: string): Failures {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Failures;
  } catch {
    return {};
  }
}

/** Phase ids that failed at least `times` times within the last 12 hours. */
export function recentFailures(file: string, now = Date.now(), times = 2): Set<string> {
  const out = new Set<string>();
  for (const [id, at] of Object.entries(read(file))) {
    if (at.filter((t) => now - t < WINDOW_MS).length >= times) out.add(id);
  }
  return out;
}

export function recordFailure(file: string, id: string, now = Date.now()): void {
  const all = read(file);
  all[id] = [...(all[id] ?? []).filter((t) => now - t < WINDOW_MS), now];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
}
