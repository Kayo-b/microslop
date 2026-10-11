/**
 * Cheap-first LLM use for plan runs. Tier 1 (a small fast model, Claude Haiku 4.5 by default)
 * handles routine calls: quest steps, unscripted phases, the first rescue for a problem. Tier 2 (the
 * strong model) only sees what tier 1 could not settle: a rescue reason seen before, a loop, or a
 * tier-1 rescue that gave up. Each tier has an hourly call budget; over budget a call returns a
 * refusal, which callers already treat as "skip this phase" / "no rescue".
 *
 * Every call is logged (prompt, answer, latency) to the account's llm-calls.jsonl: the record of
 * what still needs an LLM, and training data for distilling tier 1 into a local model later.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { PlannerContext, PlanStep } from '../planner/types.ts';
import { AnthropicClient, createLlmClient, DEFAULT_ANTHROPIC_MODEL, type LlmClient, type LlmSelection, type StructuredRequest, type StructuredResult } from './providers.ts';
import type { RescueRequest, Rescuer } from './rescue.ts';

export const DEFAULT_TIER1_MODEL = 'claude-haiku-4-5';

export type LlmPurpose = 'plan' | 'quest' | 'rescue' | 'escalate';

export interface LlmCallRecord {
  ts: string;
  purpose: LlmPurpose;
  tier: 1 | 2;
  model: string;
  schemaName: string;
  user: string;
  result: 'ok' | 'refusal' | 'over_budget' | 'error';
  response?: unknown;
  reason?: string;
  latencyMs: number;
}

/** Calls allowed per rolling hour. */
export class HourlyBudget {
  private readonly perHour: number;
  private readonly now: () => number;
  private readonly calls: number[] = [];

  constructor(perHour: number, now: () => number = Date.now) {
    this.perHour = perHour;
    this.now = now;
  }

  /** Records a call and returns true, or false when the hour's budget is spent. */
  take(): boolean {
    const t = this.now();
    while (this.calls.length && t - this.calls[0]! >= 3_600_000) this.calls.shift();
    if (this.calls.length >= this.perHour) return false;
    this.calls.push(t);
    return true;
  }

  get used(): number {
    const t = this.now();
    return this.calls.filter((c) => t - c < 3_600_000).length;
  }
}

export function jsonlCallLog(file: string): (rec: LlmCallRecord) => void {
  mkdirSync(path.dirname(file), { recursive: true });
  return (rec) => appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

/** An LLM client with a budget and a call log, labelled with what it is used for. */
export class GuardedLlm implements LlmClient {
  readonly name: string;
  private readonly inner: LlmClient;
  private readonly o: { tier: 1 | 2; purpose: LlmPurpose; budget: HourlyBudget; log?: (rec: LlmCallRecord) => void; now?: () => number };

  constructor(inner: LlmClient, o: { tier: 1 | 2; purpose: LlmPurpose; budget: HourlyBudget; log?: (rec: LlmCallRecord) => void; now?: () => number }) {
    this.inner = inner;
    this.o = o;
    this.name = inner.name;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const now = this.o.now ?? Date.now;
    const started = now();
    const base = { ts: new Date(started).toISOString(), purpose: this.o.purpose, tier: this.o.tier, model: this.inner.name, schemaName: req.schemaName, user: req.user };
    if (!this.o.budget.take()) {
      const reason = `tier ${this.o.tier} LLM budget for this hour is spent`;
      this.o.log?.({ ...base, result: 'over_budget', reason, latencyMs: 0 });
      return { kind: 'refusal', reason };
    }
    try {
      const res = await this.inner.structured(req);
      this.o.log?.({ ...base, result: res.kind, ...(res.kind === 'ok' ? { response: res.value } : { reason: res.reason }), latencyMs: now() - started });
      return res;
    } catch (err) {
      this.o.log?.({ ...base, result: 'error', reason: err instanceof Error ? err.message : String(err), latencyMs: now() - started });
      throw err;
    }
  }
}

/** Tier 1 first; tier 2 for loops, repeated problems and whatever tier 1 gives up on. */
export class TieredRescuer implements Rescuer {
  readonly name: string;
  private readonly tier1: Rescuer;
  private readonly tier2: Rescuer;
  private readonly seen = new Map<string, number>();

  constructor(tier1: Rescuer, tier2: Rescuer) {
    this.tier1 = tier1;
    this.tier2 = tier2;
    this.name = `${tier1.name} > ${tier2.name}`;
  }

  async rescue(ctx: PlannerContext, req: RescueRequest): Promise<PlanStep> {
    const key = req.trigger === 'loop' ? 'loop' : `${req.trigger}|${req.reason.replace(/\d+/g, '#')}`;
    const times = this.seen.get(key) ?? 0;
    this.seen.set(key, times + 1);
    if (req.trigger !== 'loop' && times === 0) {
      try {
        const step = await this.tier1.rescue(ctx, req);
        if (step.kind !== 'impossible') return step;
      } catch {
        // Tier 1 unavailable or broken: escalate.
      }
    }
    return this.tier2.rescue(ctx, req);
  }
}

export interface Tiers {
  tier1: LlmClient;
  tier2: LlmClient;
}

/**
 * Tier clients for the configured provider. With Anthropic and no explicit model, tier 1 is Haiku
 * 4.5 and tier 2 the default Sonnet (LLM_TIER1_MODEL / LLM_TIER2_MODEL override). Any other
 * provider, or an explicit --llm-model, uses the same client for both tiers.
 */
export function createTiers(sel: LlmSelection = {}, env: NodeJS.ProcessEnv = process.env): Tiers | null {
  const base = createLlmClient(sel, env);
  if (!base) return null;
  if (!(base instanceof AnthropicClient) || sel.model || env.LLM_MODEL) return { tier1: base, tier2: base };
  const apiKey = sel.apiKey ?? env.LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
  return {
    tier1: new AnthropicClient({ model: env.LLM_TIER1_MODEL ?? DEFAULT_TIER1_MODEL, apiKey }),
    tier2: new AnthropicClient({ model: env.LLM_TIER2_MODEL ?? env.CLAUDE_MODEL ?? DEFAULT_ANTHROPIC_MODEL, apiKey }),
  };
}
