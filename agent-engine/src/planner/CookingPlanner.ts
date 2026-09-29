/**
 * Food economy: cook banked raw fish on fires so combat has food.
 *
 *   bank (deposit cooked/burnt, withdraw raw + axe + tinderbox) -> chop a log -> light a fire ->
 *   use raw fish on the fire -> repeat until the bank has no raw fish left
 *
 * Fires instead of ranges: the free-to-play ranges near Lumbridge are quest-locked (Cook's
 * Assistant) or behind the Al Kharid toll gate.
 */
import type { Snapshot } from '../types.ts';
import { compile, type DoneCondition } from './conditions.ts';
import type { PlannedSubGoal, Planner, PlannerContext, PlanStep } from './types.ts';
import { NOT_BANKS } from './TaskTreePlanner.ts';

export interface CookTask {
  /** Raw food to cook, e.g. "Raw shrimps". */
  raw: string;
  /** Raw food per trip (axe, tinderbox and a log take 3 slots). */
  batch: number;
  trees: string[];
}

export const COOK_PRESETS: Record<string, CookTask> = {
  'cook-shrimps': { raw: 'Raw shrimps', batch: 25, trees: ['Tree', 'Dead tree', 'Evergreen tree', 'Oak tree'] },
  'cook-trout': { raw: 'Raw trout', batch: 25, trees: ['Tree', 'Dead tree', 'Evergreen tree', 'Oak tree'] },
};

const TOOLS = ['Bronze axe', 'Tinderbox'];
const KEEP = ['axe', 'Tinderbox', 'Logs'];
const lc = (s: string) => s.toLowerCase();

function held(s: Snapshot, name: string): number {
  const n = lc(name);
  return s.inventory.items.filter((i) => lc(i.name).includes(n)).reduce((sum, i) => sum + i.quantity, 0);
}

function sg(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, extra: Partial<PlannedSubGoal> = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps: 200, keep: [...KEEP], ...extra } };
}

export class CookingPlanner implements Planner {
  readonly name: string;
  private readonly task: CookTask;
  /** Raw food last seen in the bank; null until the bank has been opened. */
  private bankRaw: number | null = null;

  constructor(task: CookTask, name = 'cook') {
    this.task = task;
    this.name = name;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    const { raw, batch, trees } = this.task;
    if (s.bank.open) this.bankRaw = s.bank.items.find((i) => i.name === raw)?.quantity ?? 0;

    const last = ctx.reports.slice(-3);
    if (last.length === 3 && last.every((r) => r.result !== 'done' && r.subgoal === last[0]!.subgoal)) {
      return { kind: 'impossible', reason: `failed 3 times on "${last[0]!.subgoal}": ${last[2]!.reason}` };
    }

    if (s.bank.open) {
      const junk = [...new Set(s.inventory.items.map((i) => i.name))].filter((n) => n !== raw && !KEEP.some((k) => lc(n).includes(lc(k))) && !/coins/i.test(n));
      if (junk.length) return sg(`deposit the ${junk.join(', ')}`, junk, ['Deposit'], { lacksItems: junk }, { maxSteps: 20 });
      const want: { name: string; count: number }[] = [];
      for (const t of TOOLS) {
        if (held(s, t) === 0 && s.bank.items.some((b) => b.name === t)) want.push({ name: t, count: 1 });
      }
      const inBank = this.bankRaw ?? 0;
      const target = Math.min(batch, held(s, raw) + inBank);
      if (held(s, raw) < target) want.push({ name: raw, count: target });
      if (want.length) {
        return sg(`withdraw ${want.map((w) => `${w.count} ${w.name}`).join(', ')}`, want.map((w) => w.name), ['Withdraw'], { hasItems: want }, { want, maxSteps: 30 });
      }
      return sg('close the bank', ['Bank'], ['Close'], { bankOpen: false }, { maxSteps: 5 });
    }

    const rawHeld = held(s, raw);
    const missingTool = TOOLS.some((t) => held(s, t) === 0 && !s.equipment.some((e) => e.name === t));
    if (rawHeld === 0 || missingTool) {
      if (this.bankRaw === 0 && rawHeld === 0) return { kind: 'complete', reason: `no ${raw} left in the bank` };
      const pos = s.player?.position;
      const bank = pos && ctx.kb ? ctx.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
      return sg(`go to the ${bank?.name ?? 'nearest bank'} and open the bank`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, {
        avoid: NOT_BANKS,
        destination: bank ? { name: bank.name, point: bank.point } : undefined,
        maxSteps: 300,
      });
    }

    const fire = s.objects.find((o) => o.name === 'Fire' && o.distance <= 3);
    if (fire) {
      return sg(`cook the ${lc(raw)} on the fire`, ['Fire', raw.replace(/^Raw /, '')], ['Use', 'Cook', 'Make'], { lacksItem: raw }, { maxSteps: 150 });
    }

    if (held(s, 'Logs') > 0) {
      // "You can't light a fire here" (bank floors, doorways): step aside, then retry.
      const lastFailed = ctx.reports.at(-1);
      if (lastFailed && lastFailed.result !== 'done' && /light a fire/i.test(lastFailed.reason) && s.player) {
        const p = s.player.position;
        const to = { x: p.x + 3, y: p.y - 2, plane: p.plane };
        return sg('step away to open ground to light a fire', [], [], { near: { ...to, radius: 1 } }, { destination: { name: 'open ground', point: to }, maxSteps: 30 });
      }
      return sg('light a fire by using the tinderbox on the logs', ['Logs'], ['Use Tinderbox'], { objectNear: { name: 'Fire', radius: 2 } }, { maxSteps: 30 });
    }

    return sg('chop a tree for one log', trees, ['Chop down'], { hasItem: { name: 'Logs', count: held(s, 'Logs') + 1 } }, { maxSteps: 200 });
  }
}
