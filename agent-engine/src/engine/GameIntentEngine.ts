/**
 * The per-step decision loop for one sub-goal:
 *
 *   snapshot -> reflexes -> busy gate -> candidates -> decision engine (op + target + destination)
 *            -> [low confidence: escalate] -> POST /act -> verify effect -> log
 *
 * Mirrors browser-intent-engine's extract -> resolve -> execute split, with game-specific
 * gating: deterministic rules decide whenever a classifier is not needed (walking, animating,
 * level-up dialogs, eating), so model calls are spent only on real choices.
 */
import type { GameBackend } from '../backend/MicrobotBackend.ts';
import type { ChoiceAnswer, DecisionEngineAdapter, DecisionQuestion } from '../decision/types.ts';
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import type { Candidate, Destination, GameAction, Snapshot, SubGoal } from '../types.ts';
import { buildCandidates, type CandidateOptions } from './candidates.ts';
import type { DecisionSource, StepLogger, StepRecord } from './log.ts';
import { checkReflexes, DEFAULT_REFLEXES, type ReflexConfig } from './reflexes.ts';
import { buildDecisionState, relevantSkillsFor, type DecisionState, type HistoryEntry } from './state.ts';
import { verifyEffect, type Outcome, type VerifyOptions } from './verify.ts';

export type Op = 'interact' | 'walk' | 'wait' | 'done';

export interface EscalationRequest {
  goal: SubGoal;
  state: DecisionState;
  candidates: Candidate[];
  destinations: Destination[];
  reason: string;
  modelChoice?: { op: Op; optionId?: string; confidence: number };
}

export interface EscalationResponse {
  op: Op;
  optionId?: string;
  note?: string;
}

/** A slower, stronger decider consulted when the System 1 engine is unsure (e.g. an LLM). */
export interface Escalator {
  choose(req: EscalationRequest): Promise<EscalationResponse | null>;
}

export interface GameIntentEngineOptions {
  backend: GameBackend;
  decisionEngine: DecisionEngineAdapter;
  kb?: KnowledgeBase | null;
  escalator?: Escalator | null;
  logger?: StepLogger | null;
  runId?: string;
  reflexes?: ReflexConfig;
  candidates?: CandidateOptions;
  verify?: VerifyOptions;
  /** Below this confidence (op or option) the escalator is consulted. Default 0.4. */
  minConfidence?: number;
  /** P(done) needed to end a sub-goal on the model's word alone. Default 0.55. */
  doneConfidence?: number;
  /** Consecutive failed actions before the sub-goal is reported stuck. Default 3. */
  maxFailures?: number;
  /** Consecutive busy waits before forcing a fresh decision anyway. Default 40. */
  maxBusyWaits?: number;
}

export type StepResult =
  | { kind: 'acted'; source: DecisionSource; action: GameAction; label?: string; outcome: Outcome }
  | { kind: 'waiting'; reason: string; snapshot: Snapshot }
  | { kind: 'done'; reason: string; snapshot: Snapshot }
  | { kind: 'blocked'; reason: string; snapshot?: Snapshot };

const OP_DESCRIPTIONS: Record<Op, string> = {
  interact: 'Do one of the listed actions now (on something nearby, in the inventory, or in the open interface)',
  walk: 'Travel to one of the listed destinations because what is needed is not here',
  wait: 'Do nothing this tick; the current activity is still in progress',
  done: 'The sub-goal is already complete',
};

export class GameIntentEngine {
  private readonly o: Required<Omit<GameIntentEngineOptions, 'kb' | 'escalator' | 'logger' | 'runId' | 'candidates' | 'verify'>> &
    Pick<GameIntentEngineOptions, 'kb' | 'escalator' | 'logger' | 'candidates' | 'verify'>;
  private readonly runId: string;
  private goalKey: string | null = null;
  private history: HistoryEntry[] = [];
  private failures = 0;
  private busyWaits = 0;
  private stepNo = 0;
  private lastActTick = -1;

  constructor(options: GameIntentEngineOptions) {
    this.o = {
      reflexes: DEFAULT_REFLEXES,
      minConfidence: 0.4,
      doneConfidence: 0.55,
      maxFailures: 3,
      maxBusyWaits: 40,
      ...options,
    };
    this.runId = options.runId ?? new Date().toISOString();
  }

  /** History of the current sub-goal (action -> outcome), newest last. */
  get recentHistory(): readonly HistoryEntry[] {
    return this.history;
  }

  async step(goal: SubGoal): Promise<StepResult> {
    // Keyed by content, not identity: planners may rebuild an identical sub-goal every step.
    const key = JSON.stringify([goal.text, goal.targets ?? [], goal.actions ?? [], goal.destination ?? null]);
    if (key !== this.goalKey) {
      this.goalKey = key;
      this.history = [];
      this.failures = 0;
      this.busyWaits = 0;
    }
    const started = Date.now();
    const snap = await this.o.backend.snapshot();
    if (!snap.loggedIn || !snap.player) return { kind: 'blocked', reason: 'logged_out', snapshot: snap };

    if (goal.isDone?.(snap)) return { kind: 'done', reason: 'completion check passed', snapshot: snap };

    const reflex = checkReflexes(snap, this.o.reflexes);
    if (reflex?.kind === 'halt') return { kind: 'blocked', reason: `halt: ${reflex.reason}`, snapshot: snap };
    if (reflex?.kind === 'act') {
      return this.execute(snap, goal, reflex.action, 'reflex', reflex.reason, started, { note: reflex.reason });
    }

    const busy = this.busyReason(snap);
    if (busy && this.busyWaits < this.o.maxBusyWaits) {
      this.busyWaits++;
      return { kind: 'waiting', reason: busy, snapshot: snap };
    }
    this.busyWaits = 0;

    const kb = this.o.kb ?? null;
    const { candidates, destinations } = buildCandidates(snap, kb, goal, this.o.candidates);
    const state = buildDecisionState(snap, goal, this.history, kb, relevantSkillsFor(goal, kb));

    // A lone "click to continue" needs no classifier.
    if (candidates.length === 1 && candidates[0]!.kind === 'dialogue' && candidates[0]!.action === 'Continue') {
      return this.execute(snap, goal, candidates[0]!.gameAction, 'gate', candidates[0]!.label, started, { state });
    }
    if (candidates.length === 0 && destinations.length === 0) {
      return { kind: 'blocked', reason: 'no options (nothing interactable nearby and no known destination)', snapshot: snap };
    }

    const ops: Op[] = [];
    if (candidates.length > 0) ops.push('interact');
    if (destinations.length > 0) ops.push('walk');
    ops.push('wait', 'done');

    const questions: Record<string, DecisionQuestion> = {
      op: { type: 'choice', instructions: 'Given the sub-goal and the current state, what should the player do next?', criteria: Object.fromEntries(ops.map((op) => [op, OP_DESCRIPTIONS[op]])) },
    };
    if (candidates.length > 0) {
      questions.target = { type: 'choice', instructions: `Which action best serves the sub-goal "${goal.text}"?`, criteria: Object.fromEntries(candidates.map((c) => [c.id, c.label])) };
    }
    if (destinations.length > 0) {
      questions.destination = { type: 'choice', instructions: `If the player must travel for "${goal.text}", where should they go?`, criteria: Object.fromEntries(destinations.map((d) => [d.id, d.label])) };
    }

    let decision;
    try {
      decision = await this.o.decisionEngine.decide({ state, questions });
    } catch (err) {
      return { kind: 'blocked', reason: `decision engine error: ${err instanceof Error ? err.message : err}`, snapshot: snap };
    }

    const opAns = decision.answers.op as ChoiceAnswer;
    const op = opAns.choice as Op;
    const optionAns = (op === 'interact' ? decision.answers.target : op === 'walk' ? decision.answers.destination : undefined) as ChoiceAnswer | undefined;
    const confidence = Math.min(opAns.confidence, optionAns?.confidence ?? 1);

    let chosen: { op: Op; optionId?: string; source: DecisionSource; confidence?: number } = { op, optionId: optionAns?.choice, source: 'model', confidence };
    let escalation: StepRecord['escalation'];
    const lowConfidence = confidence < this.o.minConfidence || (op === 'done' && opAns.confidence < this.o.doneConfidence);
    if (lowConfidence && this.o.escalator) {
      const reason = `low confidence (${confidence.toFixed(2)})`;
      const esc = await this.o.escalator
        .choose({ goal, state, candidates, destinations, reason, modelChoice: { op, optionId: optionAns?.choice, confidence } })
        .catch(() => null);
      if (esc && isValidChoice(esc, candidates, destinations)) {
        chosen = { op: esc.op, optionId: esc.optionId, source: 'escalation' };
        escalation = { reason, op: esc.op, optionId: esc.optionId, note: esc.note };
      }
    }

    const base: Partial<StepRecord> = { state, questions, answers: decision.answers, model: decision.model, escalation };
    const decisionMs = decision.latencyMs;

    if (chosen.op === 'wait') {
      this.log(snap, goal, chosen.source, { ...base, chosen: { op: 'wait', confidence: chosen.confidence }, latencyMs: { decision: decisionMs, total: Date.now() - started } });
      return { kind: 'waiting', reason: `${chosen.source} chose wait`, snapshot: snap };
    }
    if (chosen.op === 'done') {
      this.log(snap, goal, chosen.source, { ...base, chosen: { op: 'done', confidence: chosen.confidence }, latencyMs: { decision: decisionMs, total: Date.now() - started } });
      return { kind: 'done', reason: `${chosen.source} judged the sub-goal complete`, snapshot: snap };
    }

    let action: GameAction;
    let label: string;
    if (chosen.op === 'walk') {
      const dest = destinations.find((d) => d.id === chosen.optionId) ?? destinations[0]!;
      action = { op: 'walk', to: dest.to, distance: 2, label: dest.label };
      label = `walk to ${dest.label}`;
    } else {
      const cand = candidates.find((c) => c.id === chosen.optionId) ?? candidates[0]!;
      action = cand.gameAction;
      label = cand.label;
    }
    return this.execute(snap, goal, action, chosen.source, label, started, {
      ...base,
      chosen: { op: chosen.op, optionId: chosen.optionId, label, confidence: chosen.confidence },
      latencyMs: { decision: decisionMs, total: 0 },
    });
  }

  private busyReason(s: Snapshot): string | null {
    const p = s.player!;
    if (s.walk.active) return 'walking';
    if (s.dialogue.inDialogue || s.production.open || s.bank.open) return null;
    if (p.animating) return 'animating';
    if (p.moving) return 'moving';
    if (p.inCombat && p.interacting?.type === 'npc') return 'in combat';
    // Give a just-dispatched interaction a tick to start before re-deciding.
    if (this.lastActTick >= 0 && s.tick - this.lastActTick < 1) return 'action just dispatched';
    return null;
  }

  private async execute(
    snap: Snapshot,
    goal: SubGoal,
    action: GameAction,
    source: DecisionSource,
    label: string,
    started: number,
    extra: Partial<StepRecord>,
  ): Promise<StepResult> {
    const act = await this.o.backend.act(action);
    this.lastActTick = act.tick;
    let outcome: Outcome;
    if (!act.success) {
      outcome = { success: false, effect: `not dispatched: ${act.reason ?? 'unknown'}`, changes: [], ticks: 0, messages: [], after: snap };
    } else {
      outcome = await verifyEffect(this.o.backend, snap, action, this.o.verify);
    }

    this.failures = outcome.success ? 0 : this.failures + 1;
    this.history.push({ tick: snap.tick, action: label, outcome: outcome.effect });
    if (this.history.length > 20) this.history.shift();

    this.log(snap, goal, source, {
      ...extra,
      action,
      act: { success: act.success, reason: act.reason },
      outcome: { success: outcome.success, effect: outcome.effect, ticks: outcome.ticks, messages: outcome.messages },
      latencyMs: { decision: extra.latencyMs?.decision, total: Date.now() - started },
    });

    if (this.failures >= this.o.maxFailures) {
      return { kind: 'blocked', reason: `stuck: ${this.failures} failed actions in a row (last: ${label} -> ${outcome.effect})`, snapshot: outcome.after };
    }
    return { kind: 'acted', source, action, label, outcome };
  }

  private log(snap: Snapshot, goal: SubGoal, source: DecisionSource, rec: Partial<StepRecord>): void {
    this.o.logger?.write({
      runId: this.runId,
      step: ++this.stepNo,
      time: new Date().toISOString(),
      tick: snap.tick,
      subgoal: goal.text,
      engine: this.o.decisionEngine.name,
      source,
      ...rec,
    } as StepRecord);
  }
}

function isValidChoice(esc: EscalationResponse, candidates: Candidate[], destinations: Destination[]): boolean {
  if (esc.op === 'interact') return candidates.some((c) => c.id === esc.optionId);
  if (esc.op === 'walk') return destinations.some((d) => d.id === esc.optionId);
  return esc.op === 'wait' || esc.op === 'done';
}
