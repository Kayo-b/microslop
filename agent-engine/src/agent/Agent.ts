/**
 * Top-level loop: ask the planner for a sub-goal, run engine steps until it completes, is blocked
 * or runs out of steps, report back to the planner, repeat.
 */
import type { GameBackend } from '../backend/MicrobotBackend.ts';
import type { GameIntentEngine, StepResult } from '../engine/GameIntentEngine.ts';
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import type { PlannedSubGoal, Planner, SubGoalReport } from '../planner/types.ts';
import { evaluate } from '../planner/conditions.ts';
import type { GameAction, WorldPoint } from '../types.ts';
import { LoopDetector, type LoopDetectorOptions } from './loopDetector.ts';
import { ProgressWatchdog, type WatchdogOptions } from './watchdog.ts';

export type AgentEvent =
  | { type: 'wait'; reason: string }
  | { type: 'subgoal'; subgoal: PlannedSubGoal }
  | { type: 'step'; result: StepResult }
  | { type: 'report'; report: SubGoalReport }
  | { type: 'stuck'; reason: string; recovery: string }
  | { type: 'finished'; outcome: AgentOutcome };

export interface AgentOutcome {
  status: 'complete' | 'impossible' | 'stopped' | 'halted' | 'error';
  reason: string;
  subgoals: number;
  steps: number;
}

export interface AgentOptions {
  backend: GameBackend;
  engine: GameIntentEngine;
  planner: Planner;
  kb?: KnowledgeBase | null;
  /** Stop after this many sub-goals. Default 200. */
  maxSubGoals?: number;
  /** Stop after this many consecutive blocked sub-goals. Default 4. */
  maxBlockedInARow?: number;
  /** Pause between engine steps while waiting (ms). Default 600 (one game tick). */
  waitMs?: number;
  /** Progress watchdog settings; see watchdog.ts. */
  watchdog?: WatchdogOptions;
  /** Run-level loop detector (see loopDetector.ts); false turns it off. */
  loop?: LoopDetectorOptions | false;
  /** Loop verdicts before the run gives up (the first ones go to the planner, e.g. an LLM rescue). Default 3. */
  maxLoops?: number;
  onEvent?: (e: AgentEvent) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Agent {
  private readonly o: AgentOptions;
  private stopRequested = false;

  constructor(options: AgentOptions) {
    this.o = options;
  }

  stop(): void {
    this.stopRequested = true;
  }

  private async flee(from: WorldPoint | undefined): Promise<void> {
    const bank = from && this.o.kb ? this.o.kb.nearestBanks(from, 1, false)[0] : undefined;
    if (!bank) return;
    await this.o.backend.act({ op: 'walk', to: bank.point, distance: 3, label: `flee to ${bank.name}` }).catch(() => undefined);
  }

  /**
   * First recovery rung: withhold the looping target (e.g. a "tree" that is really an NPC gimmick)
   * and clear anything that could be swallowing clicks. False when there is nothing to withhold,
   * so the caller ends the sub-goal instead.
   */
  private async unstick(action: GameAction | undefined): Promise<boolean> {
    const { backend, engine } = this.o;
    const withheld = action ? engine.withhold(action) : false;
    const s = await backend.snapshot().catch(() => null);
    if (s?.walk.active) await backend.act({ op: 'walk_cancel' }).catch(() => undefined);
    if (s?.bank.open) await backend.act({ op: 'bank_close' }).catch(() => undefined);
    if (s?.shop.open) await backend.act({ op: 'shop_close' }).catch(() => undefined);
    return withheld;
  }

  async run(goal: string): Promise<AgentOutcome> {
    const { backend, engine, planner } = this.o;
    const sleep = this.o.sleep ?? defaultSleep;
    const waitMs = this.o.waitMs ?? 600;
    const reports: SubGoalReport[] = [];
    let subgoals = 0;
    let steps = 0;
    let blockedInARow = 0;

    const finish = (status: AgentOutcome['status'], reason: string): AgentOutcome => {
      const outcome = { status, reason, subgoals, steps };
      this.o.onEvent?.({ type: 'finished', outcome });
      return outcome;
    };

    const loop = this.o.loop === false ? null : new LoopDetector(this.o.loop);
    let loops = 0;
    try {
      // A walk started by an earlier run keeps going after that process exits; every engine
      // step would then just wait for it.
      const first = await backend.snapshot();
      if (first.walk.active) await backend.act({ op: 'walk_cancel' }).catch(() => undefined);

      while (!this.stopRequested) {
        if (subgoals >= (this.o.maxSubGoals ?? 200)) return finish('stopped', 'sub-goal limit reached');
        let snapshot = await backend.snapshot();
        // Ride out region loads and reconnects before deciding the player really logged out.
        for (let waited = 0; !snapshot.loggedIn && waited < 60_000; waited += 2000) {
          await sleep(2000);
          snapshot = await backend.snapshot();
        }
        if (!snapshot.loggedIn) return finish('halted', 'player is logged out');
        if (snapshot.welcomeScreen && backend.login) {
          // Nothing is clickable behind it; /login dismisses it.
          await backend.login().catch(() => undefined);
          snapshot = await backend.snapshot();
        }

        const pathCost = backend.pathLength ? (a: WorldPoint, b: WorldPoint) => backend.pathLength!(a, b) : undefined;
        const plan = await planner.next({ goal, snapshot, kb: this.o.kb ?? null, reports, pathCost });
        if (plan.kind === 'complete') return finish('complete', plan.reason);
        if (plan.kind === 'impossible') return finish('impossible', plan.reason);
        if (plan.kind === 'wait') {
          this.o.onEvent?.({ type: 'wait', reason: plan.reason });
          const deadline = Date.now() + plan.maxSeconds * 1000;
          while (!this.stopRequested && Date.now() < deadline) {
            await sleep(3000);
            const s = await backend.snapshot();
            if (!s.loggedIn || evaluate(plan.until, s)) break;
          }
          // Resting is not looping: start the clock again.
          loop?.reset(await backend.snapshot().catch(() => undefined));
          continue;
        }

        if (plan.kind === 'act') {
          // Reported like a one-step sub-goal, so the planner's give-up rules see repeated failures.
          const res = await backend.act(plan.action).catch((e) => ({ success: false, reason: e instanceof Error ? e.message : String(e) }));
          await sleep(waitMs * 2);
          const report: SubGoalReport = { subgoal: plan.reason, result: res.success ? 'done' : 'blocked', reason: res.success ? 'action sent' : `failed: ${res.reason ?? 'unknown'}`, steps: 1, trail: [] };
          reports.push(report);
          this.o.onEvent?.({ type: 'report', report });
          blockedInARow = report.result === 'done' ? 0 : blockedInARow + 1;
          if (blockedInARow >= (this.o.maxBlockedInARow ?? 4)) return finish('impossible', `${blockedInARow} sub-goals in a row failed; last: ${report.reason}`);
          continue;
        }

        const sg = plan.subgoal;
        subgoals++;
        this.o.onEvent?.({ type: 'subgoal', subgoal: sg });

        let report: SubGoalReport | null = null;
        const maxSteps = sg.maxSteps ?? 100;
        let n = 0;
        let waits = 0;
        const watchdog = new ProgressWatchdog(this.o.watchdog);
        let trips = 0;
        while (!report && !this.stopRequested) {
          if (n >= maxSteps) {
            report = { subgoal: sg.text, result: 'max_steps', reason: `no completion after ${n} steps`, steps: n, trail: trail(engine) };
            break;
          }
          const result = await engine.step(sg);
          // Waiting out an action in progress (walking, a fight ending, a skilling batch) does not
          // use up the sub-goal's step budget; the watchdog ends waits that never finish.
          if (result.kind !== 'waiting' || ++waits % 4 === 0) n++;
          steps++;
          this.o.onEvent?.({ type: 'step', result });
          const stuck = result.kind === 'blocked' ? null : watchdog.observe(result);
          if (stuck) {
            trips++;
            if (trips >= 2 || !(await this.unstick(stuck.action))) {
              this.o.onEvent?.({ type: 'stuck', reason: stuck.reason, recovery: 'end sub-goal' });
              report = { subgoal: sg.text, result: 'blocked', reason: `stuck: ${stuck.reason}`, steps: n, trail: trail(engine) };
              break;
            }
            this.o.onEvent?.({ type: 'stuck', reason: stuck.reason, recovery: 'withheld target, cleared UI' });
            watchdog.reset();
            continue;
          }
          const looping = result.kind === 'blocked' ? null : loop?.observe(result);
          if (looping) {
            loops++;
            this.o.onEvent?.({ type: 'stuck', reason: `loop: ${looping.reason}`, recovery: loops >= (this.o.maxLoops ?? 3) ? 'give up' : 'end sub-goal, ask the planner' });
            const r: SubGoalReport = { subgoal: sg.text, result: 'blocked', reason: `loop: ${looping.reason}`, steps: n, trail: [...looping.evidence, ...trail(engine)] };
            if (loops >= (this.o.maxLoops ?? 3)) {
              this.o.onEvent?.({ type: 'report', report: r });
              return finish('impossible', `stuck in a loop: ${looping.reason}`);
            }
            report = r;
            loop!.reset(result.kind === 'acted' ? result.outcome.after : result.snapshot);
            break;
          }
          switch (result.kind) {
            case 'done':
              report = { subgoal: sg.text, result: 'done', reason: result.reason, steps: n, trail: trail(engine) };
              break;
            case 'blocked':
              if (result.reason.startsWith('halt:')) {
                // Low HP and no food: the character keeps fighting on auto-retaliate after the
                // agent stops, so walk to the nearest bank first.
                await this.flee(result.snapshot?.player?.position);
              }
              if (result.reason === 'logged_out' || result.reason.startsWith('halt:')) {
                this.o.onEvent?.({ type: 'report', report: { subgoal: sg.text, result: 'blocked', reason: result.reason, steps: n, trail: trail(engine) } });
                return finish('halted', result.reason);
              }
              report = { subgoal: sg.text, result: 'blocked', reason: result.reason, steps: n, trail: trail(engine) };
              break;
            case 'waiting':
              await sleep(waitMs);
              break;
            case 'acted':
              break;
          }
        }
        if (!report) break;
        reports.push(report);
        this.o.onEvent?.({ type: 'report', report });
        blockedInARow = report.result === 'done' ? 0 : blockedInARow + 1;
        if (blockedInARow >= (this.o.maxBlockedInARow ?? 4)) {
          return finish('impossible', `${blockedInARow} sub-goals in a row failed; last: ${report.reason}`);
        }
        // The planner re-issuing a sub-goal that is complete the moment it starts (its done check
        // and the planner's own test disagree) spins without acting; nothing will change that.
        const recent = reports.slice(-20);
        if (recent.length === 20 && recent.every((r) => r.subgoal === report.subgoal && r.result === 'done' && r.steps <= 1)) {
          return finish('impossible', `planner keeps re-issuing "${report.subgoal}", which is already complete`);
        }
      }
      return finish('stopped', 'stop requested');
    } catch (err) {
      return finish('error', err instanceof Error ? err.message : String(err));
    }
  }
}

function trail(engine: GameIntentEngine): string[] {
  return engine.recentHistory.slice(-5).map((h) => `${h.action} -> ${h.outcome}`);
}
