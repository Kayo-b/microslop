/**
 * HTTP client for the `/v1/systemone` wire protocol, shared by a local `laya-serve` and TypeSafe
 * Jev's hosted API: `{state, model, questions}` in, `{model, answers, usage}` out, optional
 * `Authorization: Bearer` auth. Ported from browser-intent-engine and extended with `noul`.
 */
import type {
  DecisionAnswer,
  DecisionEngineAdapter,
  DecisionPayload,
  DecisionResult,
} from './types.ts';

interface WireAnswer {
  type: string;
  choice?: string;
  answer_confidence?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  noul?: number;
  [key: string]: unknown;
}

interface WireResponse {
  model?: string;
  answers?: Record<string, WireAnswer>;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

export interface SystemOneHttpAdapterOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  name: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export class SystemOneHttpAdapter implements DecisionEngineAdapter {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SystemOneHttpAdapterOptions) {
    if (!options.baseUrl) throw new Error('SystemOneHttpAdapter requires a non-empty "baseUrl".');
    this.name = options.name;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async decide(payload: DecisionPayload): Promise<DecisionResult> {
    const url = `${this.baseUrl}/v1/systemone`;
    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...this.headers,
        },
        body: JSON.stringify({ state: payload.state, model: this.model ?? null, questions: payload.questions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(`${this.name}: failed to reach ${url} (${cause})`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${this.name}: ${url} returned ${response.status}: ${text.slice(0, 500)}`);
    }

    const result = (await response.json()) as WireResponse;
    const answers: Record<string, DecisionAnswer> = {};
    for (const [questionId, question] of Object.entries(payload.questions)) {
      const raw = result.answers?.[questionId];
      if (question.type === 'choice') {
        if (!raw || raw.type !== 'choice' || typeof raw.choice !== 'string' || !(raw.choice in question.criteria)) {
          throw new Error(`${this.name}: no valid choice answer for "${questionId}"`);
        }
        answers[questionId] = {
          type: 'choice',
          questionId,
          choice: raw.choice,
          confidence: raw.answer_confidence ?? raw.confidence ?? 0,
          probabilities: raw.probabilities,
        };
      } else {
        const p = typeof raw?.noul === 'number' ? raw.noul : typeof raw?.confidence === 'number' ? raw.confidence : null;
        if (!raw || raw.type !== 'noul' || p === null) {
          throw new Error(`${this.name}: no valid noul answer for "${questionId}"`);
        }
        answers[questionId] = { type: 'noul', questionId, probability: p };
      }
    }

    return {
      answers,
      model: result.model,
      latencyMs: Date.now() - started,
      usage: result.usage ? { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens } : undefined,
    };
  }
}
