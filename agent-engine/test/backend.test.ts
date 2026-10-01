import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MicrobotBackend } from '../src/backend/MicrobotBackend.ts';
import { snapshot } from './support/fixtures.ts';

test('backend: a 503 from /snapshot (client-thread read timed out) is retried', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return calls === 1
      ? new Response('{"error":"Game state unavailable (client thread read failed)"}', { status: 503 })
      : new Response(JSON.stringify(snapshot()));
  }) as unknown as typeof fetch;
  const b = new MicrobotBackend({ token: 't', fetchImpl });
  const s = await b.snapshot();
  assert.equal(calls, 2);
  assert.equal(s.loggedIn, true);
});
