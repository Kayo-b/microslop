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

export type RescueTrigger = 'impossible' | 'stuck' | 'loop';

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
  now?: () => Date;
}

/** Watchdog verdicts end a sub-goal with "stuck: loop..." or "stuck: no progress..."; engine failure streaks are "stuck: N failed...". */
const WATCHDOG_STUCK = /^stuck: (loop|no progress)/;

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

  constructor(inner: Planner, rescuer: Rescuer, log: RescueLog, opts: RescuingPlannerOptions = {}) {
    this.inner = inner;
    this.rescuer = rescuer;
    this.log = log;
    this.name = `${inner.name}+rescue`;
    this.o = { maxRescues: opts.maxRescues ?? 6, maxPerReason: opts.maxPerReason ?? 2, now: opts.now ?? (() => new Date()) };
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    if (this.pending && ctx.reports.length > this.pending.reportsAt) {
      const r = ctx.reports[this.pending.reportsAt]!;
      this.log.write({ kind: 'outcome', id: this.pending.id, ts: this.o.now().toISOString(), result: r.result, reason: r.reason, steps: r.steps });
      this.pending = null;
      this.handledReports = ctx.reports.length;
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

    const step = await this.inner.next(ctx);
    if (step.kind !== 'impossible') return step;
    return (await this.tryRescue(ctx, { trigger: 'impossible', reason: step.reason, planner: this.inner.name })) ?? step;
  }

  private async tryRescue(ctx: PlannerContext, req: RescueRequest): Promise<PlanStep | null> {
    // Loop verdicts differ in wording every time; they share one budget.
    const key = req.trigger === 'loop' ? 'loop' : `${req.trigger}|${req.reason.replace(/\d+/g, '#')}`;
    if (this.used >= this.o.maxRescues || (this.perReason.get(key) ?? 0) >= this.o.maxPerReason) return null;
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
