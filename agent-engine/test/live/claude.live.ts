/**
 * Live checks for the Claude planner / escalator (a few Sonnet calls).
 * Run: npm run test:live-claude   (needs ANTHROPIC_API_KEY in the repo-root .env or the environment)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildCandidates } from '../../src/engine/candidates.ts';
import { buildDecisionState } from '../../src/engine/state.ts';
import { KnowledgeBase } from '../../src/kb/KnowledgeBase.ts';
import { ClaudeEscalator, ClaudePlanner, describeSubGoal } from '../../src/llm/claude.ts';
import { item, snapshot } from '../support/fixtures.ts';

const hasKey = !!(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
const kb = existsSync('data/kb.sqlite') ? new KnowledgeBase('data/kb.sqlite') : null;

test('planner turns a goal into a concrete sub-goal with a deterministic completion check', { skip: !hasKey && 'ANTHROPIC_API_KEY not set' }, async () => {
  const s = snapshot({ inventory: { freeSlots: 27, items: [item(0, 1351, 'Bronze axe', { actions: ['Wield', 'Drop'] })] } });
  const step = await new ClaudePlanner().next({ goal: 'train woodcutting to level 5', snapshot: s, kb, reports: [] });
  assert.equal(step.kind, 'subgoal');
  if (step.kind !== 'subgoal') return;
  console.log(`  ${describeSubGoal(step.subgoal)}`);
  assert.ok(step.subgoal.targets?.some((t) => /tree/i.test(t)), 'targets a tree');
  assert.ok(step.subgoal.isDone, 'has a completion check');
  assert.ok(step.subgoal.keep?.some((k) => /axe/i.test(k)), 'protects the axe');
});

test('escalator picks a listed option id', { skip: !hasKey && 'ANTHROPIC_API_KEY not set' }, async () => {
  const s = snapshot();
  const goal = { text: 'catch shrimp at the fishing spot', targets: ['Fishing spot'] };
  const { candidates, destinations } = buildCandidates(s, kb, goal);
  const res = await new ClaudeEscalator().choose({ goal, state: buildDecisionState(s, goal, [], kb), candidates, destinations, reason: 'test' });
  console.log(`  ${JSON.stringify(res)}`);
  assert.equal(res?.op, 'interact');
  assert.equal(res?.optionId, 'npc:1530#Small Net');
});
