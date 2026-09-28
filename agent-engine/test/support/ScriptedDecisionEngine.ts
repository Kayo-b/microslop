import type { ChoiceQuestion, DecisionAnswer, DecisionEngineAdapter, DecisionPayload, DecisionResult } from '../../src/decision/types.ts';

export type Policy = (payload: DecisionPayload) => Record<string, { choice: string; confidence?: number }>;

/**
 * Deterministic stand-in for Laya/Jev. By default: op = "interact" when a target option matches
 * the sub-goal words, else "walk" if possible, else "done"; target = best word overlap with the
 * sub-goal, skipping options that say "missing".
 */
export class ScriptedDecisionEngine implements DecisionEngineAdapter {
  readonly name = 'scripted';
  readonly calls: DecisionPayload[] = [];
  private readonly policy: Policy;

  constructor(policy: Policy = defaultPolicy) {
    this.policy = policy;
  }

  async decide(payload: DecisionPayload): Promise<DecisionResult> {
    this.calls.push(payload);
    const picks = this.policy(payload);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [qid, q] of Object.entries(payload.questions)) {
      if (q.type !== 'choice') continue;
      const pick = picks[qid] ?? { choice: Object.keys(q.criteria)[0]! };
      answers[qid] = { type: 'choice', questionId: qid, choice: pick.choice, confidence: pick.confidence ?? 0.9 };
    }
    return { answers, latencyMs: 1, model: 'scripted' };
  }
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]+/g) ?? []);

export function bestOption(q: ChoiceQuestion, goal: string): { id: string; score: number } {
  const gw = words(goal);
  let best = { id: Object.keys(q.criteria)[0]!, score: -Infinity };
  for (const [id, label] of Object.entries(q.criteria)) {
    let score = [...words(label)].filter((w) => gw.has(w)).length;
    if (/missing/i.test(label)) score -= 5;
    if (score > best.score) best = { id, score };
  }
  return best;
}

export const defaultPolicy: Policy = (payload) => {
  const goal = String((payload.state as { subgoal?: string }).subgoal ?? '');
  const out: Record<string, { choice: string; confidence?: number }> = {};
  const target = payload.questions.target as ChoiceQuestion | undefined;
  const dest = payload.questions.destination as ChoiceQuestion | undefined;
  const t = target ? bestOption(target, goal) : null;
  if (t && t.score > 0) {
    out.op = { choice: 'interact' };
    out.target = { choice: t.id };
  } else if (dest) {
    out.op = { choice: 'walk' };
    out.destination = { choice: bestOption(dest, goal).id };
  } else {
    out.op = { choice: 'done' };
  }
  return out;
};
