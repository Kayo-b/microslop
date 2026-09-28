/**
 * Live decision-quality checks against TypeSafe Jev (costs a few API calls).
 * Run: npm run test:live-jev   (reads JEV_API_KEY from the repo-root .env)
 *
 * Uses the real knowledge base when data/kb.sqlite exists, so the labels Jev sees are the same
 * enriched labels a live run produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createJevAdapter } from '../../src/decision/adapters.ts';
import { GameIntentEngine } from '../../src/engine/GameIntentEngine.ts';
import { MemoryStepLogger } from '../../src/engine/log.ts';
import { KnowledgeBase } from '../../src/kb/KnowledgeBase.ts';
import type { ActResponse, GameAction, Snapshot, SubGoal } from '../../src/types.ts';
import type { GameBackend } from '../../src/backend/MicrobotBackend.ts';
import { item, snapshot } from '../support/fixtures.ts';

const hasKey = !!(process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY);
const kb = existsSync('data/kb.sqlite') ? new KnowledgeBase('data/kb.sqlite') : null;

/** Serves one fixed snapshot and records the action instead of executing it. */
class FrozenBackend implements GameBackend {
  acted: GameAction | null = null;
  private readonly snap: Snapshot;
  constructor(snap: Snapshot) {
    this.snap = snap;
  }
  async snapshot() {
    return this.snap;
  }
  async act(action: GameAction): Promise<ActResponse> {
    this.acted = action;
    return { success: false, op: action.op, tick: this.snap.tick, reason: 'frozen' };
  }
}

async function decideOnce(snap: Snapshot, goal: SubGoal) {
  const backend = new FrozenBackend(snap);
  const logger = new MemoryStepLogger();
  const engine = new GameIntentEngine({ backend, decisionEngine: createJevAdapter(), kb, logger, verify: { sleep: async () => {}, pollMs: 0 } });
  const result = await engine.step(goal);
  const rec = logger.records[0];
  console.log(`  [${goal.text}] -> ${rec?.chosen?.op} ${rec?.chosen?.label ?? ''} (conf ${rec?.chosen?.confidence?.toFixed(2)}, ${rec?.latencyMs?.decision} ms)`);
  return { result, action: backend.acted, record: rec };
}

test('Jev picks the usable fishing option (net, not bait without a rod)', { skip: !hasKey && 'JEV_API_KEY not set' }, async () => {
  const { action } = await decideOnce(snapshot(), { text: 'catch shrimp at the fishing spot', targets: ['Fishing spot'] });
  assert.ok(action && action.op === 'interact', `expected an interaction, got ${JSON.stringify(action)}`);
  assert.equal((action as { action: string }).action, 'Small Net');
});

test('Jev walks to a bank when the sub-goal is to bank and none is nearby', { skip: !hasKey && 'JEV_API_KEY not set' }, async () => {
  const full = snapshot({
    inventory: { freeSlots: 0, items: [item(0, 303, 'Small fishing net'), ...Array.from({ length: 27 }, (_, i) => item(i + 1, 317, 'Raw shrimps'))] },
  });
  const { action } = await decideOnce(full, { text: 'go to the nearest bank to deposit the raw shrimps', targets: ['Bank booth', 'Banker'] });
  assert.ok(action?.op === 'walk', `expected a walk, got ${JSON.stringify(action)}`);
});

test('Jev chooses the dialogue option that matches the sub-goal', { skip: !hasKey && 'JEV_API_KEY not set' }, async () => {
  const dlg = snapshot({
    dialogue: { inDialogue: true, hasContinue: false, hasOptions: true, question: 'Select an Option', options: ["I'd like to access my bank account, please.", "I'd like to check my PIN settings.", 'What is this place?'] },
  });
  const { action } = await decideOnce(dlg, { text: 'open the bank through the banker' });
  assert.deepEqual(action, { op: 'dialogue_select', option: "I'd like to access my bank account, please." });
});
