/**
 * Top-level loop: ask the planner for a sub-goal, run engine steps until it completes, is blocked
 * or runs out of steps, report back to the planner, repeat.
 */
import type { GameBackend } from '../backend/MicrobotBackend.ts';
import type { GameIntentEngine, StepResult } from '../engine/GameIntentEngine.ts';
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import type { PlannedSubGoal, Planner, SubGoalReport } from '../planner/types.ts';
import type { WorldPoint } from '../types.ts';

export type AgentEvent =
  | { type: 'subgoal'; subgoal: PlannedSubGoal }
  | { type: 'step'; result: StepResult }
  | { type: 'report'; report: SubGoalReport }
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

        const pathCost = backend.pathLength ? (a: WorldPoint, b: WorldPoint) => backend.pathLength!(a, b) : undefined;
        const plan = await planner.next({ goal, snapshot, kb: this.o.kb ?? null, reports, pathCost });
        if (plan.kind === 'complete') return finish('complete', plan.reason);
        if (plan.kind === 'impossible') return finish('impossible', plan.reason);

        const sg = plan.subgoal;
        subgoals++;
        this.o.onEvent?.({ type: 'subgoal', subgoal: sg });

        let report: SubGoalReport | null = null;
        const maxSteps = sg.maxSteps ?? 100;
        let n = 0;
        while (!report && !this.stopRequested) {
          if (n >= maxSteps) {
            report = { subgoal: sg.text, result: 'max_steps', reason: `no completion after ${n} steps`, steps: n, trail: trail(engine) };
            break;
          }
          const result = await engine.step(sg);
          n++;
          steps++;
          this.o.onEvent?.({ type: 'step', result });
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
