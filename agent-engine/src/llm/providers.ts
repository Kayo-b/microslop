/**
 * LLM backends for the planner, rescuer, escalator and quest runner. Every call is "system prompt
 * + user prompt -> JSON matching a zod schema", which all backends can do:
 *
 *   anthropic      Anthropic SDK, structured outputs (ANTHROPIC_API_KEY or an `ant` profile)
 *   openai-style   any OpenAI-compatible /chat/completions API with json_schema output:
 *                  openai, openrouter, groq, together, gemini, deepseek, mistral, xai, ollama,
 *                  lmstudio, or LLM_BASE_URL for anything else
 *   claude-code    the local `claude` CLI: `claude -p --output-format json --json-schema ...
 *                  --dangerously-skip-permissions`, using whatever login Claude Code has
 *
 * Selection (first match): --llm / LLM_PROVIDER; else the first provider whose API key is set
 * (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, ...). Claude Code is never picked
 * implicitly: it runs an agent with permissions bypassed, so it must be asked for by name.
 *
 * Env: LLM_PROVIDER, LLM_MODEL, LLM_API_KEY, LLM_BASE_URL, CLAUDE_CODE_BIN, CLAUDE_CODE_TOOLS,
 * CLAUDE_CODE_ARGS, CLAUDE_CODE_CWD, CLAUDE_CODE_MAX_BUDGET_USD.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { spawn } from 'node:child_process';
import { z } from 'zod';

export type StructuredResult<T> = { kind: 'ok'; value: T } | { kind: 'refusal'; reason: string };

export interface StructuredRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Short identifier for the schema (OpenAI requires one). */
  schemaName: string;
  /** Output budget hint. */
  maxTokens?: number;
  /** Reasoning effort hint where the backend supports one. */
  effort?: 'low' | 'medium' | 'high';
}

export interface LlmClient {
  /** "provider:model", for logs. */
  readonly name: string;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** JSON Schema for a zod schema, without the $schema key some APIs reject. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return stripSafeIntBounds(rest) as Record<string, unknown>;
}

/** zod marks ints with +-MAX_SAFE_INTEGER bounds; strict validators (OpenAI) reject the keywords. */
function stripSafeIntBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripSafeIntBounds);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'minimum' || k === 'maximum') && Math.abs(v as number) === Number.MAX_SAFE_INTEGER) continue;
    out[k] = stripSafeIntBounds(v);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export class AnthropicClient implements LlmClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { client?: Anthropic; model?: string; apiKey?: string } = {}) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    this.name = `anthropic:${this.model}`;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // Haiku 4.5 rejects `effort`, and the refusal fallback is for the 5.x models.
    const small = /haiku/i.test(this.model);
    const format = betaZodOutputFormat(req.schema as z.ZodType);
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      // Server-side refusal fallback: a declined request is retried on the recommended model.
      ...(small ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const }),
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      output_config: small ? { format } : { effort: req.effort ?? 'medium', format },
      messages: [{ role: 'user', content: req.user }],
    });
    if (response.stop_reason === 'refusal') return { kind: 'refusal', reason: `declined (${response.stop_details?.category ?? 'no category'})` };
    if (!response.parsed_output) throw new Error(`no parseable output (stop_reason ${response.stop_reason})`);
    return { kind: 'ok', value: response.parsed_output as T };
  }
}

// ---------------------------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------------------------

export const OPENAI_COMPATIBLE: Record<string, { baseUrl: string; keyEnv: string[]; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', keyEnv: ['OPENAI_API_KEY'], model: 'gpt-5-mini' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', keyEnv: ['OPENROUTER_API_KEY'], model: 'anthropic/claude-sonnet-5.5' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'], model: 'llama-3.3-70b-versatile' },
  together: { baseUrl: 'https://api.together.xyz/v1', keyEnv: ['TOGETHER_API_KEY'], model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], model: 'gemini-2.5-flash' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', keyEnv: ['DEEPSEEK_API_KEY'], model: 'deepseek-chat' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', keyEnv: ['MISTRAL_API_KEY'], model: 'mistral-large-latest' },
  xai: { baseUrl: 'https://api.x.ai/v1', keyEnv: ['XAI_API_KEY'], model: 'grok-4' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: [], model: 'qwen3:8b' },
  lmstudio: { baseUrl: 'http://127.0.0.1:1234/v1', keyEnv: [], model: 'local-model' },
};

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAICompatibleClient implements LlmClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly fetchImpl: FetchLike;
  /** Some servers (older local ones) reject json_schema; fall back to json_object + schema in the prompt. */
  private schemaMode: 'json_schema' | 'json_object' = 'json_schema';

  constructor(opts: { provider: string; baseUrl: string; apiKey?: string; model: string; fetchImpl?: FetchLike }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
    this.name = `${opts.provider}:${opts.model}`;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const schema = jsonSchema(req.schema as z.ZodType);
    for (let attempt = 0; attempt < 2; attempt++) {
      const jsonObject = this.schemaMode === 'json_object';
      const body = {
        model: this.model,
        max_tokens: req.maxTokens ?? 8000,
        messages: [
          { role: 'system', content: jsonObject ? `${req.system}\n\nAnswer with one JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` : req.system },
          { role: 'user', content: req.user },
        ],
        response_format: jsonObject ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema } },
      };
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      if (!res.ok) {
        if (res.status === 400 && !jsonObject && /response_format|json_schema/i.test(text)) {
          this.schemaMode = 'json_object';
          continue;
        }
        throw new Error(`${this.name} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const msg = (JSON.parse(text) as { choices?: { message?: { content?: string | null; refusal?: string | null } }[] }).choices?.[0]?.message;
      if (msg?.refusal) return { kind: 'refusal', reason: msg.refusal };
      return { kind: 'ok', value: parseJson(req.schema, msg?.content ?? '', this.name) };
    }
    throw new Error(`${this.name}: structured output unsupported`);
  }
}

/** Parses model text as JSON (tolerating a ```json fence) and validates it against the schema. */
export function parseJson<T>(schema: z.ZodType<T>, text: string, who: string): T {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(`${who} returned non-JSON: ${text.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`${who} output does not match the schema: ${parsed.error.message.slice(0, 300)}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  bin?: string;
  model?: string;
  /**
   * Tools the spawned agent may use. Default: read-only research tools (web search/fetch, read
   * and search files). "default" = Claude Code's full tool set; "" = none.
   */
  tools?: string;
  /** Working directory of the spawned agent (what Read/Grep can see). Default: the process cwd. */
  cwd?: string;
  /** Extra CLI arguments, whitespace-separated. */
  extraArgs?: string[];
  maxBudgetUsd?: number;
  timeoutMs?: number;
  spawnImpl?: typeof spawn;
}

export const CLAUDE_CODE_DEFAULT_TOOLS = 'WebSearch,WebFetch,Read,Grep,Glob';

/** Claude Code as a structured-output backend via `claude -p`. */
export class ClaudeCodeClient implements LlmClient {
  readonly name: string;
  private readonly o: Required<Omit<ClaudeCodeOptions, 'model' | 'maxBudgetUsd' | 'spawnImpl'>> & Pick<ClaudeCodeOptions, 'model' | 'maxBudgetUsd' | 'spawnImpl'>;

  constructor(opts: ClaudeCodeOptions = {}) {
    this.o = {
      bin: opts.bin ?? 'claude',
      model: opts.model,
      tools: opts.tools ?? CLAUDE_CODE_DEFAULT_TOOLS,
      cwd: opts.cwd ?? process.cwd(),
      extraArgs: opts.extraArgs ?? [],
      maxBudgetUsd: opts.maxBudgetUsd,
      timeoutMs: opts.timeoutMs ?? 300_000,
      spawnImpl: opts.spawnImpl,
    };
    this.name = `claude-code:${this.o.model ?? 'default'}`;
  }

  /** The argv for one call (exposed for tests and logs). */
  args(req: StructuredRequest<unknown>): string[] {
    const a = [
      '-p', req.user,
      '--system-prompt', req.system,
      '--output-format', 'json',
      '--json-schema', JSON.stringify(jsonSchema(req.schema as z.ZodType)),
      '--dangerously-skip-permissions',
      '--no-session-persistence',
      '--tools', this.o.tools,
    ];
    if (this.o.model) a.push('--model', this.o.model);
    if (this.o.maxBudgetUsd) a.push('--max-budget-usd', String(this.o.maxBudgetUsd));
    return [...a, ...this.o.extraArgs];
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const stdout = await this.run(this.args(req as StructuredRequest<unknown>));
    let out: { is_error?: boolean; result?: string; structured_output?: unknown; subtype?: string };
    try {
      out = JSON.parse(stdout);
    } catch {
      throw new Error(`claude-code returned non-JSON: ${stdout.slice(0, 200)}`);
    }
    if (out.is_error) throw new Error(`claude-code error (${out.subtype ?? 'unknown'}): ${String(out.result ?? '').slice(0, 300)}`);
    if (out.structured_output !== undefined) {
      const parsed = req.schema.safeParse(out.structured_output);
      if (parsed.success) return { kind: 'ok', value: parsed.data };
    }
    return { kind: 'ok', value: parseJson(req.schema, out.result ?? '', this.name) };
  }

  private run(args: string[]): Promise<string> {
    const spawnFn = this.o.spawnImpl ?? spawn;
    return new Promise((resolve, reject) => {
      const child = spawnFn(this.o.bin, args, { cwd: this.o.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), this.o.timeoutMs);
      child.stdout!.on('data', (d) => (out += d));
      child.stderr!.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`cannot run ${this.o.bin}: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 || out.trim().startsWith('{')) resolve(out);
        else reject(new Error(`claude-code exited ${code}: ${(err || out).slice(0, 300)}`));
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

export interface LlmSelection {
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/** The configured LLM backend, or null when none is configured. */
export function createLlmClient(sel: LlmSelection = {}, env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const provider = (sel.provider ?? env.LLM_PROVIDER ?? detectProvider(env))?.toLowerCase();
  if (!provider) return null;
  const model = sel.model ?? env.LLM_MODEL;
  if (provider === 'claude-code' || provider === 'claude_code') {
    return new ClaudeCodeClient({
      bin: env.CLAUDE_CODE_BIN,
      model,
      tools: env.CLAUDE_CODE_TOOLS,
      cwd: env.CLAUDE_CODE_CWD,
      extraArgs: env.CLAUDE_CODE_ARGS?.split(/\s+/).filter(Boolean),
      maxBudgetUsd: env.CLAUDE_CODE_MAX_BUDGET_USD ? Number(env.CLAUDE_CODE_MAX_BUDGET_USD) : undefined,
    });
  }
  if (provider === 'anthropic') {
    const apiKey = sel.apiKey ?? env.LLM_API_KEY ?? env.ANTHROPIC_API_KEY;
    return new AnthropicClient({ model, apiKey });
  }
  const preset = OPENAI_COMPATIBLE[provider];
  const baseUrl = sel.baseUrl ?? env.LLM_BASE_URL ?? preset?.baseUrl;
  if (!baseUrl) throw new Error(`Unknown LLM provider "${provider}" (set LLM_BASE_URL for an OpenAI-compatible endpoint). Known: anthropic, claude-code, ${Object.keys(OPENAI_COMPATIBLE).join(', ')}`);
  const apiKey = sel.apiKey ?? env.LLM_API_KEY ?? preset?.keyEnv.map((k) => env[k]).find(Boolean);
  return new OpenAICompatibleClient({ provider, baseUrl, apiKey, model: model ?? preset?.model ?? 'default' });
}

/** First provider with a key in the environment; Claude Code is never auto-selected. */
export function detectProvider(env: NodeJS.ProcessEnv): string | undefined {
  if (env.LLM_BASE_URL) return 'openai-compatible';
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'anthropic';
  for (const [name, p] of Object.entries(OPENAI_COMPATIBLE)) if (p.keyEnv.some((k) => env[k])) return name;
  return undefined;
}
