/**
 * Decision-engine contract, shared with browser-intent-engine: State + typed Questions in, one
 * answer per question out. Laya (local laya-serve) and TypeSafe Jev (hosted) both speak this over
 * the same `POST /v1/systemone` wire protocol.
 */

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** option id -> human-readable description of that option. */
  criteria: Record<string, string>;
}

/** Yes/no question answered with P(yes). */
export interface NoulQuestion {
  type: 'noul';
  instructions: string;
}

export type DecisionQuestion = ChoiceQuestion | NoulQuestion;

export interface DecisionPayload {
  state: unknown;
  questions: Record<string, DecisionQuestion>;
}

export interface ChoiceAnswer {
  type: 'choice';
  questionId: string;
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface NoulAnswer {
  type: 'noul';
  questionId: string;
  /** P(yes), 0..1. */
  probability: number;
}

export type DecisionAnswer = ChoiceAnswer | NoulAnswer;

export interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  model?: string;
  latencyMs: number;
  usage?: { inputTokens?: number | null; outputTokens?: number | null };
}

export interface DecisionEngineAdapter {
  readonly name: string;
  decide(payload: DecisionPayload): Promise<DecisionResult>;
}
