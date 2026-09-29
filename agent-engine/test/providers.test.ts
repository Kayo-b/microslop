import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { ClaudeCodeClient, createLlmClient, OpenAICompatibleClient } from '../src/llm/providers.ts';

const Schema = z.object({ status: z.enum(['continue', 'complete']), note: z.string().nullable() });
const req = { system: 'sys', user: 'plan', schema: Schema, schemaName: 'plan' };

test('openai-compatible: json_schema request, validated reply; falls back to json_object when unsupported', async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    calls++;
    if (calls === 1) return new Response('{"error":{"message":"response_format json_schema is not supported"}}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"status":"complete","note":null}\n```' } }] }), { status: 200 });
  };
  const c = new OpenAICompatibleClient({ provider: 'ollama', baseUrl: 'http://x/v1', model: 'qwen3:8b', fetchImpl });
  const res = await c.structured(req);
  assert.deepEqual(res, { kind: 'ok', value: { status: 'complete', note: null } });
  assert.equal((bodies[0]!.response_format as { type: string }).type, 'json_schema');
  assert.equal((bodies[1]!.response_format as { type: string }).type, 'json_object');
  assert.match(String((bodies[1]!.messages as { content: string }[])[0]!.content), /JSON Schema/);
});

test('openai-compatible: schema violations are errors, refusals are reported', async () => {
  const bad = new OpenAICompatibleClient({ provider: 'openai', baseUrl: 'http://x/v1', model: 'm', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"status":"maybe"}' } }] })) });
  await assert.rejects(bad.structured(req), /does not match the schema/);
  const no = new OpenAICompatibleClient({ provider: 'openai', baseUrl: 'http://x/v1', model: 'm', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'no' } }] })) });
  assert.deepEqual(await no.structured(req), { kind: 'refusal', reason: 'no' });
});

function fakeSpawn(stdout: string, seen: { args?: string[]; cwd?: string }) {
  return ((_bin: string, args: string[], opts: { cwd: string }) => {
    seen.args = args;
    seen.cwd = opts.cwd;
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', 0);
    });
    return child;
  }) as never;
}

test('claude-code: runs claude -p with the schema and permissions bypassed, reads structured_output', async () => {
  const seen: { args?: string[]; cwd?: string } = {};
  const c = new ClaudeCodeClient({ model: 'sonnet', cwd: '/tmp', spawnImpl: fakeSpawn(JSON.stringify({ is_error: false, result: '', structured_output: { status: 'continue', note: 'x' } }), seen) });
  assert.deepEqual(await c.structured(req), { kind: 'ok', value: { status: 'continue', note: 'x' } });
  const a = seen.args!;
  for (const flag of ['-p', '--output-format', '--json-schema', '--dangerously-skip-permissions', '--no-session-persistence', '--tools', '--system-prompt']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Grep,Glob');
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
  assert.equal(seen.cwd, '/tmp');
  const err = new ClaudeCodeClient({ spawnImpl: fakeSpawn(JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd', result: 'budget' }), {}) });
  await assert.rejects(err.structured(req), /error_max_budget_usd/);
});

test('provider selection: explicit, by key, never claude-code implicitly', () => {
  assert.equal(createLlmClient({}, {}), null);
  assert.match(createLlmClient({}, { OPENROUTER_API_KEY: 'k' })!.name, /^openrouter:/);
  assert.match(createLlmClient({}, { ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' })!.name, /^anthropic:/);
  assert.match(createLlmClient({ provider: 'claude-code', model: 'opus' }, {})!.name, /^claude-code:opus/);
  assert.match(createLlmClient({}, { LLM_PROVIDER: 'ollama', LLM_MODEL: 'qwen3:14b' })!.name, /^ollama:qwen3:14b/);
  assert.match(createLlmClient({}, { LLM_BASE_URL: 'http://gpu-box:8000/v1', LLM_MODEL: 'm' })!.name, /^openai-compatible:m/);
  assert.throws(() => createLlmClient({ provider: 'nope' }, {}), /Unknown LLM provider/);
});
