/**
 * LLM rescue: the scripted planners handle the common path; when one gives up ("impossible") or the
 * progress watchdog ends a sub-goal as stuck, an LLM gets one shot at a sub-goal that gets past it.
 * The scripted planner resumes afterwards.
 *
 * Every rescue is appended to data/rescues.jsonl with its trigger, the situation and what the LLM
 * proposed, then a second record with how the rescue sub-goal went. Recurring rescues are the list
 * of deterministic rules still missing: turn them into planner code, and the LLM calls go down.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { foldInventory } from '../engine/state.ts';
import type { Planner, PlannerContext, PlanStep, SubGoalReport } from '../planner/types.ts';
import type { WatchHint } from './watchFeed.ts';

export type RescueTrigger = 'impossible' | 'stuck' | 'loop' | 'blocked' | 'watcher';

export interface RescueRequest {
  trigger: RescueTrigger;
  /** Why the scripted layer gave up. */
  reason: string;
  /** Name of the scripted planner that gave up. */
  planner: string;
  /** Loop evidence (most frequent actions, positions, game messages). */
  evidence?: string[];
}

/** Proposes one step that gets past a situation the scripted planner could not handle. */
export interface Rescuer {
  readonly name: string;
  rescue(ctx: PlannerContext, req: RescueRequest): Promise<PlanStep>;
}

export interface RescueRecord {
  kind: 'rescue';
  id: string;
  ts: string;
  goal: string;
  trigger: RescueTrigger;
  reason: string;
  planner: string;
  rescuer: string;
  situation: { position?: string; inventory: string; equipped: string; nearby: string[]; recent: string[] };
  proposal: PlanStep | { kind: 'error'; reason: string };
}

export interface RescueOutcomeRecord {
  kind: 'outcome';
  id: string;
  ts: string;
  result: SubGoalReport['result'];
  reason: string;
  steps: number;
}

export interface RescueLog {
  write(rec: RescueRecord | RescueOutcomeRecord): void;
}

export class JsonlRescueLog implements RescueLog {
  readonly file: string;
  constructor(file = path.join('data', 'rescues.jsonl')) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
  }
  write(rec: RescueRecord | RescueOutcomeRecord): void {
    appendFileSync(this.file, `${JSON.stringify(rec)}\n`);
  }
}

export class MemoryRescueLog implements RescueLog {
  readonly records: (RescueRecord | RescueOutcomeRecord)[] = [];
  write(rec: RescueRecord | RescueOutcomeRecord): void {
    this.records.push(rec);
  }
}

export interface RescuingPlannerOptions {
  /** Total rescues per run. Default 6. */
  maxRescues?: number;
  /** Rescues for the same trigger reason. Default 2. */
  maxPerReason?: number;
  /** The run watcher's latest verdict, if it says the run is stuck; a new one triggers a rescue. */
  watchFeed?: () => WatchHint | null;
  now?: () => Date;
}

/** Watchdog verdicts end a sub-goal with "stuck: loop..." or "stuck: no progress..."; engine failure streaks are "stuck: N failed...". */
const WATCHDOG_STUCK = /^stuck: (loop|no progress)/;

/** Consecutive engine-level failures ("no options", "stuck: N failed actions") before a rescue; the gold rotation gives up at 3. */
const BLOCKED_STREAK = 2;
/** ...or this many blocked among the last BLOCKED_WINDOW reports. */
const BLOCKED_WINDOW = 6;
const BLOCKED_IN_WINDOW = 3;

/** Wraps a scripted planner; calls the rescuer when it gives up or the watchdog ends a sub-goal. */
export class RescuingPlanner implements Planner {
  readonly name: string;
  private readonly inner: Planner;
  private readonly rescuer: Rescuer;
  private readonly log: RescueLog;
  private readonly o: Required<RescuingPlannerOptions>;
  private used = 0;
  private readonly perReason = new Map<string, number>();
  /** Rescue sub-goal in flight: its text and log id, for the outcome record. */
  private pending: { id: string; text: string; reportsAt: number } | null = null;
  /** Reports already answered with a rescue, so one stuck report is rescued once. */
  private handledReports = 0;
  private lastHint = '';

  constructor(inner: Planner, rescuer: Rescuer, log: RescueLog, opts: RescuingPlannerOptions = {}) {
    this.inner = inner;
    this.rescuer = rescuer;
    this.log = log;
    this.name = `${inner.name}+rescue`;
    this.o = { maxRescues: opts.maxRescues ?? 6, maxPerReason: opts.maxPerReason ?? 2, watchFeed: opts.watchFeed ?? (() => null), now: opts.now ?? (() => new Date()) };
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    if (this.pending && ctx.reports.length > this.pending.reportsAt) {
      const r = ctx.reports[this.pending.reportsAt]!;
      this.log.write({ kind: 'outcome', id: this.pending.id, ts: this.o.now().toISOString(), result: r.result, reason: r.reason, steps: r.steps });
      this.pending = null;
      this.handledReports = ctx.reports.length;
    }

    // The watcher's reviews are precise: a fresh stuck/wrong verdict gets a rescue at once.
    const hint = this.o.watchFeed();
    if (hint && hint.id !== this.lastHint) {
      this.lastHint = hint.id;
      const step = await this.tryRescue(ctx, { trigger: 'watcher', reason: `the run watcher reports ${hint.status}: ${hint.diagnosis}`, planner: this.inner.name, evidence: hint.suggestion ? [`Suggested fix: ${hint.suggestion}`] : [] });
      if (step) return step;
    }

    const last = ctx.reports.at(-1);
    // The run-level loop detector: the agent has been going in circles across sub-goals.
    if (last && ctx.reports.length > this.handledReports && last.result === 'blocked' && last.reason.startsWith('loop:')) {
      this.handledReports = ctx.reports.length;
      const evidence = last.trail.filter((t) => /^(most frequent|positions visited|game messages)/.test(t));
      const step = await this.tryRescue(ctx, { trigger: 'loop', reason: last.reason, planner: this.inner.name, evidence });
      if (step) return step;
    }
    if (last && ctx.reports.length > this.handledReports && last.result === 'blocked' && WATCHDOG_STUCK.test(last.reason)) {
      this.handledReports = ctx.reports.length;
      const step = await this.tryRescue(ctx, { trigger: 'stuck', reason: last.reason, planner: this.inner.name });
      if (step) return step;
    }

    // The same sub-goal failing again and again at engine level (nothing to interact with, failed
    // actions) is neither a watchdog verdict nor a planner give-up, but the strategy layer would
    // soon abandon the whole route over it. Two blocked in a row count, and so do most of the recent
    // reports when "done" ones sit in between (open the bank, fail to use it, open it again).
    const isEngineBlock = (r: SubGoalReport) => r.result === 'blocked' && !WATCHDOG_STUCK.test(r.reason) && !r.reason.startsWith('loop:');
    const tail = ctx.reports.slice(-BLOCKED_STREAK);
    const recent = ctx.reports.slice(-BLOCKED_WINDOW);
    const streak = tail.length === BLOCKED_STREAK && tail.every(isEngineBlock);
    const scattered = recent.length === BLOCKED_WINDOW && recent.filter(isEngineBlock).length >= BLOCKED_IN_WINDOW;
    if (ctx.reports.length > this.handledReports && (streak || scattered)) {
      this.handledReports = ctx.reports.length;
      const bad = (streak ? tail : recent.filter(isEngineBlock)).slice(-BLOCKED_STREAK);
      const evidence = bad.flatMap((r) => r.trail.slice(-2));
      const step = await this.tryRescue(ctx, { trigger: 'blocked', reason: `${streak ? BLOCKED_STREAK : BLOCKED_IN_WINDOW} blocked sub-goals ${streak ? 'in a row' : `of the last ${BLOCKED_WINDOW}`}; last: ${bad.at(-1)!.subgoal} -> ${bad.at(-1)!.reason}`, planner: this.inner.name, evidence });
      if (step) return step;
    }

    const step = await this.inner.next(ctx);
    if (step.kind !== 'impossible') return step;
    return (await this.tryRescue(ctx, { trigger: 'impossible', reason: step.reason, planner: this.inner.name })) ?? step;
  }

  private async tryRescue(ctx: PlannerContext, req: RescueRequest): Promise<PlanStep | null> {
    // Loop verdicts differ in wording every time; they share one budget.
    const key = req.trigger === 'loop' ? 'loop' : req.trigger === 'watcher' ? 'watcher' : `${req.trigger}|${req.reason.replace(/\d+/g, '#')}`;
    // Watcher verdicts share one budget (they differ in wording every time) and may use more of the run's rescues.
    if (this.used >= this.o.maxRescues + (req.trigger === 'watcher' ? 2 : 0) || (this.perReason.get(key) ?? 0) >= (req.trigger === 'watcher' ? 4 : this.o.maxPerReason)) return null;
    this.used++;
    this.perReason.set(key, (this.perReason.get(key) ?? 0) + 1);

    const s = ctx.snapshot;
    const pos = s.player?.position;
    const record: RescueRecord = {
      kind: 'rescue',
      id: randomUUID(),
      ts: this.o.now().toISOString(),
      goal: ctx.goal,
      trigger: req.trigger,
      reason: req.reason,
      planner: req.planner,
      rescuer: this.rescuer.name,
      situation: {
        position: pos ? `${pos.x},${pos.y},${pos.plane}` : undefined,
        inventory: foldInventory(s),
        equipped: s.equipment.map((e) => e.name).join(', ') || 'nothing',
        nearby: [...new Set([...s.npcs.map((n) => n.name), ...s.objects.map((o) => o.name)])].slice(0, 20),
        recent: ctx.reports.slice(-3).flatMap((r) => [`${r.subgoal} -> ${r.result}: ${r.reason}`, ...r.trail.slice(-2).map((t) => `  ${t}`)]),
      },
      proposal: { kind: 'error', reason: 'not answered' },
    };
    let step: PlanStep | null = null;
    try {
      step = await this.rescuer.rescue(ctx, req);
      record.proposal = step;
    } catch (err) {
      record.proposal = { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
    this.log.write(record);
    if (!step || step.kind === 'complete') return null;
    if (step.kind === 'subgoal') this.pending = { id: record.id, text: step.subgoal.text, reportsAt: ctx.reports.length };
    return step;
  }
}
