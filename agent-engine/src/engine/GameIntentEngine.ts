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
import { buildCandidates, matchesAny, type CandidateOptions } from './candidates.ts';
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
  /** Retries for a failed decision-engine call (timeouts, 5xx) before blocking. Default 2. */
  decisionRetries?: number;
  /** How long a non-transient logged-out state may last before the sub-goal is blocked. Default 60 s. */
  logoutGraceMs?: number;
}

export type StepResult =
  | { kind: 'acted'; source: DecisionSource; action: GameAction; label?: string; outcome: Outcome }
  | { kind: 'waiting'; reason: string; snapshot: Snapshot }
  | { kind: 'done'; reason: string; snapshot: Snapshot }
  | { kind: 'blocked'; reason: string; snapshot?: Snapshot };

/** Game states that pass by themselves; never treat them as a logout. */
const TRANSIENT_STATES = new Set(['LOADING', 'HOPPING', 'CONNECTION_LOST', 'LOGGING_IN']);

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
  private loggedOutSince: number | null = null;
  /** Last tick the player was seen animating (skilling batches pause between items). */
  private lastAnimTick = -1;
  /** Ticks of animation gap still treated as "busy" (make-all batches pause 1-3 ticks per item). */
  private static readonly ANIM_GRACE_TICKS = 4;
  /** NPC the last successful Attack targeted, so the approach is not abandoned mid-way. */
  private attackTarget: { index: number; tick: number } | null = null;
  /** Ticks to keep pursuing an attacked NPC before re-deciding. Chickens and goblins wander. */
  private static readonly ATTACK_SETTLE_TICKS = 8;

  constructor(options: GameIntentEngineOptions) {
    this.o = {
      reflexes: DEFAULT_REFLEXES,
      minConfidence: 0.4,
      doneConfidence: 0.55,
      maxFailures: 3,
      maxBusyWaits: 40,
      decisionRetries: 2,
      logoutGraceMs: 60_000,
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
    if (!snap.loggedIn || !snap.player) {
      // Region loads (LOADING), world hops and reconnects flip loggedIn off for a moment; only a
      // sustained logout ends the sub-goal.
      if (this.loggedOutSince === null) this.loggedOutSince = Date.now();
      if (TRANSIENT_STATES.has(snap.gameState) || Date.now() - this.loggedOutSince < this.o.logoutGraceMs) {
        return { kind: 'waiting', reason: `not in game (${snap.gameState})`, snapshot: snap };
      }
      return { kind: 'blocked', reason: 'logged_out', snapshot: snap };
    }
    this.loggedOutSince = null;

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

    // Only offer ops the deterministic layers cannot settle. Waiting is the busy gate's job
    // (offered here only once its wait budget ran out while still busy) and completion is the
    // sub-goal's own check when it has one. Classifiers are strong at "which option" and weak at
    // abstract "what now" questions, so the op question is skipped whenever one op remains.
    const ops: Op[] = [];
    // A sub-goal with an explicit destination whose targets are nowhere in sight means "travel":
    // the web walker handles doors and stairs on the way, so nothing else nearby is relevant.
    const mustTravel =
      !!goal.destination && !!goal.targets?.length && destinations.length > 0 && !candidates.some((c) => matchesAny(c.name, goal.targets));
    if (candidates.length > 0 && !mustTravel) ops.push('interact');
    // Travel is only a real option when nothing the sub-goal names is usable right here.
    const targetHere = candidates.some((c) => matchesAny(c.name, goal.targets) && !(c.unmet && c.unmet.length > 0));
    if (destinations.length > 0 && !targetHere) ops.push('walk');
    if (busy) ops.push('wait');
    if (!goal.isDone) ops.push('done');

    const questions: Record<string, DecisionQuestion> = {};
    if (ops.length > 1) {
      questions.op = { type: 'choice', instructions: 'Given the sub-goal and the current state, what should the player do next?', criteria: Object.fromEntries(ops.map((op) => [op, OP_DESCRIPTIONS[op]])) };
    }
    if (candidates.length > 0) {
      questions.target = { type: 'choice', instructions: `Which action best serves the sub-goal "${goal.text}"?`, criteria: Object.fromEntries(candidates.map((c) => [c.id, c.label])) };
    }
    if (ops.includes('walk')) {
      questions.destination = { type: 'choice', instructions: `If the player must travel for "${goal.text}", where should they go?`, criteria: Object.fromEntries(destinations.map((d) => [d.id, d.label])) };
    }

    let decision;
    // Hosted engines occasionally time out; a stalled tick is cheap, a blocked sub-goal is not.
    for (let attempt = 1; ; attempt++) {
      try {
        decision = await this.o.decisionEngine.decide({ state, questions });
        break;
      } catch (err) {
        if (attempt >= this.o.decisionRetries + 1) {
          return { kind: 'blocked', reason: `decision engine error: ${err instanceof Error ? err.message : err}`, snapshot: snap };
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }

    const opAns = decision.answers.op as ChoiceAnswer | undefined;
    const op = (opAns?.choice ?? ops[0]!) as Op;
    const opConfidence = opAns?.confidence ?? 1;
    const optionAns = (op === 'interact' ? decision.answers.target : op === 'walk' ? decision.answers.destination : undefined) as ChoiceAnswer | undefined;
    const confidence = Math.min(opConfidence, optionAns?.confidence ?? 1);

    let chosen: { op: Op; optionId?: string; source: DecisionSource; confidence?: number } = { op, optionId: optionAns?.choice, source: 'model', confidence };
    let escalation: StepRecord['escalation'];
    const lowConfidence = confidence < this.o.minConfidence || (op === 'done' && opConfidence < this.o.doneConfidence);
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
    if (s.dialogue.inDialogue || s.production.open || s.bank.open || s.shop.open) return null;
    if (p.animating) {
      this.lastAnimTick = s.tick;
      return 'animating';
    }
    // A make-all batch (smelting, cooking) pauses between items; re-clicking the station in that
    // gap restarts the batch, which stalled iron smelting for 250 steps.
    if (this.lastAnimTick >= 0 && s.tick - this.lastAnimTick < GameIntentEngine.ANIM_GRACE_TICKS) return 'between batch items';
    if (p.moving) return 'moving';
    if (p.inCombat && p.interacting?.type === 'npc') return 'in combat';
    // Give a just-dispatched interaction a tick to start before re-deciding.
    if (this.lastActTick >= 0 && s.tick - this.lastActTick < 1) return 'action just dispatched';
    // Keep pursuing the NPC we attacked while it is alive and nobody else took it; the player
    // briefly shows neither moving nor fighting while re-pathing to a wandering target.
    const t = this.attackTarget;
    if (t && s.tick - t.tick < GameIntentEngine.ATTACK_SETTLE_TICKS) {
      const npc = s.npcs.find((n) => n.index === t.index);
      const alive = npc && !(npc.healthScale > 0 && npc.healthRatio === 0);
      if (alive && !(npc!.interactingWithOther && !npc!.interactingWithPlayer)) return 'pursuing attack target';
    }
    this.attackTarget = null;
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
    this.attackTarget =
      act.success && action.op === 'interact' && action.target.kind === 'npc' && action.action.toLowerCase() === 'attack'
        ? { index: action.target.index, tick: act.tick }
        : null;
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
