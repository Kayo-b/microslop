/**
 * Presets over SystemOneHttpAdapter for the two engines, plus a factory driven by env.
 *
 *   Jev  (hosted):  JEV_API_KEY (or TYPESAFE_API_KEY), JEV_BASE_URL, JEV_MODEL (default jev-latest)
 *   Laya (local):   LAYA_URL (default http://127.0.0.1:8000), LAYA_API_KEY, LAYA_MODEL
 *
 * Swapping Jev for a fine-tuned Laya is `DECISION_ENGINE=laya` with `LAYA_MODEL` pointing at the
 * checkpoint laya-serve loaded; nothing else changes.
 */
import { SystemOneHttpAdapter } from './SystemOneHttpAdapter.ts';
import type { DecisionEngineAdapter } from './types.ts';

export interface EngineOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createJevAdapter(opts: EngineOptions = {}, env: NodeJS.ProcessEnv = process.env): SystemOneHttpAdapter {
  const apiKey = opts.apiKey ?? env.JEV_API_KEY ?? env.TYPESAFE_API_KEY;
  if (!apiKey) {
    throw new Error('Jev needs an API key: set JEV_API_KEY (e.g. in the repo-root .env) or pass { apiKey }.');
  }
  return new SystemOneHttpAdapter({
    name: 'jev',
    baseUrl: opts.baseUrl ?? env.JEV_BASE_URL ?? env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai',
    apiKey,
    // The hosted API rejects a null model; jev-latest tracks the newest release.
    model: opts.model ?? env.JEV_MODEL ?? 'jev-latest',
    timeoutMs: opts.timeoutMs ?? 15_000,
    fetchImpl: opts.fetchImpl,
  });
}

export function createLayaAdapter(opts: EngineOptions = {}, env: NodeJS.ProcessEnv = process.env): SystemOneHttpAdapter {
  return new SystemOneHttpAdapter({
    name: 'laya',
    baseUrl: opts.baseUrl ?? env.LAYA_URL ?? 'http://127.0.0.1:8000',
    apiKey: opts.apiKey ?? env.LAYA_API_KEY,
    model: opts.model ?? env.LAYA_MODEL,
    timeoutMs: opts.timeoutMs ?? 10_000,
    fetchImpl: opts.fetchImpl,
  });
}

export function createDecisionEngine(name = process.env.DECISION_ENGINE ?? 'jev', opts: EngineOptions = {}): DecisionEngineAdapter {
  switch (name) {
    case 'jev':
      return createJevAdapter(opts);
    case 'laya':
      return createLayaAdapter(opts);
    default:
      throw new Error(`Unknown DECISION_ENGINE "${name}" (expected "jev" or "laya")`);
  }
}
