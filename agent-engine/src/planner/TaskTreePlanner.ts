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

/** Fight-and-loot loop: loot whenever our drop is on the ground, otherwise attack. */
export interface CombatTask {
  activity: string;
  monsters: string[];
  /** Drop names to pick up, most important first. */
  loot: string[];
  keep: string[];
  /** Skill to watch for --until-level (e.g. Strength). */
  skill: string;
  untilLevel?: number;
}

export const COMBAT_PRESETS: Record<string, Omit<CombatTask, 'untilLevel'>> = {
  'kill-chickens': { activity: 'kill chickens and collect feathers', monsters: ['Chicken'], loot: ['Feather'], keep: [], skill: 'Strength' },
  'kill-cows': { activity: 'kill cows and collect cowhides', monsters: ['Cow', 'Cow calf'], loot: ['Cowhide'], keep: [], skill: 'Strength' },
  'kill-goblins': { activity: 'kill goblins and collect their bones', monsters: ['Goblin'], loot: ['Bones'], keep: [], skill: 'Strength' },
};

/** How many of an item (by name substring) the inventory holds, counting stack sizes. */
function held(s: Snapshot, name: string): number {
  const n = name.toLowerCase();
  return s.inventory.items.filter((i) => i.name.toLowerCase().includes(n)).reduce((sum, i) => sum + i.quantity, 0);
}

export function nextCombatStep(task: CombatTask, s: Snapshot): PlanStep {
  if (task.untilLevel) {
    const sk = s.skills.find((k) => k.name.toLowerCase() === task.skill.toLowerCase());
    if (sk && sk.level >= task.untilLevel) return { kind: 'complete', reason: `${task.skill} reached ${sk.level}` };
  }
  // Sequencing ("kill, then loot") is decided here, not by the classifier: offered both, it keeps
  // choosing the next attack over the drop on the floor.
  const lootHere = task.loot
    .map((name) => s.groundItems.find((g) => g.lootable && g.reachable && g.distance <= 8 && g.name.toLowerCase().includes(name.toLowerCase())))
    .find(Boolean);
  const stackable = lootHere && s.inventory.items.some((i) => i.name === lootHere.name && i.stackable);
  if (lootHere && (s.inventory.freeSlots > 0 || stackable)) {
    return {
      kind: 'subgoal',
      subgoal: goal(`pick up the ${lootHere.name} on the ground`, [lootHere.name], ['Take'], { hasItem: { name: lootHere.name, count: held(s, lootHere.name) + 1 } }, 12, task.keep),
    };
  }
  if (s.inventory.freeSlots === 0) return { kind: 'complete', reason: 'inventory full' };
  return {
    kind: 'subgoal',
    subgoal: goal(`attack a ${task.monsters.join(' or ')}`, task.monsters, ['Attack'], { groundItemNear: { name: task.loot[0]!, radius: 6 } }, 60, task.keep),
  };
}

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

type Task = ({ kind: 'gather' } & GatherTask) | ({ kind: 'combat' } & CombatTask);

export class TaskTreePlanner implements Planner {
  readonly name: string;
  private readonly task: Task;

  constructor(task: GatherTask | Task, name = 'task-tree') {
    this.task = 'kind' in task ? task : { kind: 'gather', ...task };
    this.name = name;
  }

  static fromPreset(preset: string, opts: { bank?: boolean; untilLevel?: number } = {}): TaskTreePlanner {
    const gather = PRESETS[preset];
    if (gather) return new TaskTreePlanner({ kind: 'gather', ...gather, bank: opts.bank ?? false, untilLevel: opts.untilLevel }, preset);
    const combat = COMBAT_PRESETS[preset];
    if (combat) return new TaskTreePlanner({ kind: 'combat', ...combat, untilLevel: opts.untilLevel }, preset);
    throw new Error(`Unknown task preset "${preset}". Available: ${[...Object.keys(PRESETS), ...Object.keys(COMBAT_PRESETS)].join(', ')}`);
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    // Three blocked attempts at the same sub-goal in a row means the tree cannot recover by itself.
    const last = ctx.reports.slice(-3);
    if (last.length === 3 && last.every((r) => r.result === 'blocked' && r.subgoal === last[0]!.subgoal)) {
      return { kind: 'impossible', reason: `blocked 3 times on "${last[0]!.subgoal}": ${last[2]!.reason}` };
    }
    return this.task.kind === 'combat' ? nextCombatStep(this.task, ctx.snapshot) : nextGatherStep(this.task, ctx.snapshot);
  }
}

/** Runs exactly one fixed sub-goal, then reports complete (or impossible if it failed). */
export class SingleSubGoalPlanner implements Planner {
  readonly name = 'single';
  private readonly subgoal: PlannedSubGoal;
  private issued = false;

  constructor(subgoal: PlannedSubGoal) {
    this.subgoal = subgoal;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    if (!this.issued) {
      this.issued = true;
      return { kind: 'subgoal', subgoal: this.subgoal };
    }
    const last = ctx.reports.at(-1);
    return last?.result === 'done'
      ? { kind: 'complete', reason: `sub-goal done: ${last.reason}` }
      : { kind: 'impossible', reason: `sub-goal ${last?.result ?? 'not run'}: ${last?.reason ?? ''}` };
  }
}
