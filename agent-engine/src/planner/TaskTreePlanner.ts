/**
 * Semi-hard-coded long-horizon plans. A task looks at the current snapshot and returns the next
 * sub-goal; the per-tick engine (and its decision model) works out the concrete clicks.
 *
 * The gathering template covers the classic loop: gather until full -> bank (or drop) -> repeat,
 * optionally until a skill level is reached.
 */
import type { Snapshot } from '../types.ts';
import { compile, type DoneCondition } from './conditions.ts';
import type { PlannedSubGoal, Planner, PlannerContext, PlanStep } from './types.ts';

export interface GatherTask {
  /** Human-readable activity, e.g. "catch shrimp". */
  activity: string;
  /** In-game target names ("Fishing spot", "Oak tree"). */
  targets: string[];
  /** Menu action on the target ("Small Net", "Chop down"). */
  action: string;
  /** What is gathered (inventory item name substring). */
  product: string;
  skill: string;
  /** Items to keep when banking or dropping (tools, bait). */
  keep: string[];
  /** Bank when full; otherwise drop the product. */
  bank: boolean;
  /** Stop once the skill reaches this level. */
  untilLevel?: number;
}

export const PRESETS: Record<string, Omit<GatherTask, 'bank' | 'untilLevel'>> = {
  'fish-shrimp': { activity: 'catch shrimp with a small fishing net', targets: ['Fishing spot'], action: 'Small Net', product: 'Raw', skill: 'Fishing', keep: ['Small fishing net'] },
  'fish-trout': { activity: 'fly fish for trout and salmon', targets: ['Rod Fishing spot'], action: 'Lure', product: 'Raw', skill: 'Fishing', keep: ['Fly fishing rod', 'Feather'] },
  'chop-trees': { activity: 'chop normal trees for logs', targets: ['Tree', 'Dead tree', 'Evergreen tree'], action: 'Chop down', product: 'Logs', skill: 'Woodcutting', keep: ['axe'] },
  'chop-oaks': { activity: 'chop oak trees for oak logs', targets: ['Oak tree'], action: 'Chop down', product: 'Oak logs', skill: 'Woodcutting', keep: ['axe'] },
  'chop-willows': { activity: 'chop willow trees for willow logs', targets: ['Willow tree'], action: 'Chop down', product: 'Willow logs', skill: 'Woodcutting', keep: ['axe'] },
  'mine-copper': { activity: 'mine copper ore', targets: ['Copper rocks'], action: 'Mine', product: 'Copper ore', skill: 'Mining', keep: ['pickaxe'] },
  'mine-tin': { activity: 'mine tin ore', targets: ['Tin rocks'], action: 'Mine', product: 'Tin ore', skill: 'Mining', keep: ['pickaxe'] },
  'mine-iron': { activity: 'mine iron ore', targets: ['Iron rocks'], action: 'Mine', product: 'Iron ore', skill: 'Mining', keep: ['pickaxe'] },
};

const BANK_TARGETS = ['Bank booth', 'Bank chest', 'Banker', 'Bank'];

function goal(text: string, targets: string[], actions: string[], doneWhen: DoneCondition | undefined, maxSteps: number, keep: string[]): PlannedSubGoal {
  return { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep };
}

export function nextGatherStep(task: GatherTask, s: Snapshot): PlanStep {
  if (task.untilLevel) {
    const sk = s.skills.find((k) => k.name.toLowerCase() === task.skill.toLowerCase());
    if (sk && sk.level >= task.untilLevel) return { kind: 'complete', reason: `${task.skill} reached ${sk.level}` };
  }
  const product = task.product.toLowerCase();
  const hasProduct = s.inventory.items.some((i) => i.name.toLowerCase().includes(product));
  const full = s.inventory.freeSlots === 0;

  if (s.bank.open) {
    if (hasProduct) {
      return {
        kind: 'subgoal',
        subgoal: goal(`deposit all ${task.product} items into the bank, keeping the ${task.keep.join(' and ')}`, [task.product], ['Deposit'], { lacksItem: task.product }, 10, task.keep),
      };
    }
    return { kind: 'subgoal', subgoal: goal('close the bank', ['Bank'], ['Close'], { bankOpen: false }, 5, task.keep) };
  }

  if (full && hasProduct) {
    if (task.bank) {
      return {
        kind: 'subgoal',
        subgoal: goal('go to the nearest bank and open it', BANK_TARGETS, ['Bank', 'Use'], { bankOpen: true }, 80, task.keep),
      };
    }
    return {
      kind: 'subgoal',
      subgoal: goal(`drop every ${task.product} item from the inventory, keeping the ${task.keep.join(' and ')}`, [task.product], ['Drop'], { lacksItem: task.product }, 40, task.keep),
    };
  }

  return {
    kind: 'subgoal',
    subgoal: goal(`${task.activity}: use "${task.action}" on the ${task.targets.join(' or ')}`, task.targets, [task.action], { inventoryFull: true }, 400, task.keep),
  };
}

export class TaskTreePlanner implements Planner {
  readonly name: string;
  private readonly task: GatherTask;

  constructor(task: GatherTask, name = 'task-tree') {
    this.task = task;
    this.name = name;
  }

  static fromPreset(preset: string, opts: { bank?: boolean; untilLevel?: number } = {}): TaskTreePlanner {
    const base = PRESETS[preset];
    if (!base) throw new Error(`Unknown task preset "${preset}". Available: ${Object.keys(PRESETS).join(', ')}`);
    return new TaskTreePlanner({ ...base, bank: opts.bank ?? false, untilLevel: opts.untilLevel }, preset);
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    // Three blocked attempts at the same sub-goal in a row means the tree cannot recover by itself.
    const last = ctx.reports.slice(-3);
    if (last.length === 3 && last.every((r) => r.result === 'blocked' && r.subgoal === last[0]!.subgoal)) {
      return { kind: 'impossible', reason: `blocked 3 times on "${last[0]!.subgoal}": ${last[2]!.reason}` };
    }
    return nextGatherStep(this.task, ctx.snapshot);
  }
}
