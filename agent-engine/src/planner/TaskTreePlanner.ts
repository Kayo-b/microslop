/**
 * Semi-hard-coded long-horizon plans. A task looks at the current snapshot and returns the next
 * sub-goal; the per-tick engine (and its decision model) works out the concrete clicks.
 *
 * The gathering template covers the classic loop: gather until full -> bank (or drop) -> repeat,
 * optionally until a skill level is reached.
 */
import type { Snapshot, WorldPoint } from '../types.ts';
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import { FOOD_HEAL, foodSupply, RESOURCES } from '../kb/resources.ts';
import { compile, type DoneCondition } from './conditions.ts';
import { type CombatStyle, upgradesFrom, weakSlots } from './gear.ts';
import { nextKitStep, outOfSupplies, planKit } from './kit.ts';
import type { PlannedSubGoal, Planner, PlannerContext, PlanStep } from './types.ts';

export interface GatherTask {
  /** Human-readable activity, e.g. "catch shrimp". */
  activity: string;
  /** In-game target names ("Fishing spot", "Oak tree"). */
  targets: string[];
  /** Menu action on the target ("Small Net", "Chop down"). */
  action: string;
  /** Other names the same action has at some spots (Draynor's net spots say "Net"). */
  altActions?: string[];
  /** What is gathered (inventory item name substring). */
  product: string;
  skill: string;
  /** Items to keep when banking or dropping (tools, bait). */
  keep: string[];
  /** Bank when full; otherwise drop the product. */
  bank: boolean;
  /** Stop once the skill reaches this level. */
  untilLevel?: number;
  /** Where the resource is; walked to when no target is in view. */
  area?: { name: string; point: WorldPoint };
}

export const PRESETS: Record<string, Omit<GatherTask, 'bank' | 'untilLevel'>> = {
  'fish-shrimp': { activity: 'catch shrimp with a small fishing net', targets: ['Fishing spot'], action: 'Small Net', altActions: ['Net'], product: 'Raw', skill: 'Fishing', keep: ['Small fishing net'], area: { name: 'Draynor Village fishing spots', point: { x: 3087, y: 3228, plane: 0 } } },
  'fish-trout': { activity: 'fly fish for trout and salmon', targets: ['Rod Fishing spot'], action: 'Lure', product: 'Raw', skill: 'Fishing', keep: ['Fly fishing rod', 'Feather'], area: { name: 'Barbarian Village fishing spots', point: { x: 3104, y: 3430, plane: 0 } } },
  // A fixed spot: the nearest trees are often next to aggressive NPCs (Draynor's jail guards).
  'chop-trees': { activity: 'chop normal trees for logs', targets: ['Tree', 'Dead tree', 'Evergreen tree'], action: 'Chop down', product: 'Logs', skill: 'Woodcutting', keep: ['axe'], area: { name: 'trees by Varrock West bank', point: { x: 3170, y: 3450, plane: 0 } } },
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
  /** Where the monsters are; walked to when none is in view. */
  area?: { name: string; point: WorldPoint };
  /** Only attack monsters up to this combat level. */
  maxLevel?: number;
  /** Bury carried bones once this many are held (Prayer XP). */
  buryAt?: number;
  /** Food to carry into fights; below this the planner restocks at a bank (or rests if none). Default 0. */
  minFood?: number;
  /** How much food to withdraw when restocking. Default 10. */
  foodBatch?: number;
  /** Also loot any of our drops worth at least this (gp, ground value). Coins are always looted. Default 25. */
  lootValue?: number;
  /** Combat style; ranged and magic buy, carry and wear their kit (bow + arrows, staff + runes). Default melee. */
  style?: CombatStyle;
}

/** What the combat planner has seen of the bank, and helpers it needs from the world. */
export interface CombatContext {
  kb?: KnowledgeBase | null;
  /** Cooked food last seen in the bank (name -> count); null until the bank has been opened. */
  bankFood?: Map<string, number> | null;
  /** Item names last seen in the bank; null until the bank has been opened. */
  bankItems?: string[] | null;
  /** Bank counts last seen (name -> quantity); null until the bank has been opened. */
  bankCounts?: Map<string, number> | null;
}

export const COMBAT_PRESETS: Record<string, Omit<CombatTask, 'untilLevel'>> = {
  'kill-chickens': { activity: 'kill chickens and collect feathers', monsters: ['Chicken'], loot: ['Feather'], keep: [], skill: 'Strength', area: { name: 'Lumbridge chicken farm', point: { x: 3232, y: 3295, plane: 0 } } },
  'kill-cows': { activity: 'kill cows and collect cowhides', monsters: ['Cow', 'Cow calf'], loot: ['Cowhide'], keep: [], skill: 'Strength', area: { name: 'Lumbridge cow field', point: { x: 3257, y: 3265, plane: 0 } } },
  'kill-goblins': { activity: 'kill goblins and collect their bones', monsters: ['Goblin'], loot: ['Bones'], keep: [], skill: 'Strength', area: { name: 'Lumbridge goblins', point: { x: 3245, y: 3240, plane: 0 } } },
  'kill-barbarians': { activity: 'kill barbarians and bury their bones', monsters: ['Barbarian'], loot: ['Bones'], keep: [], skill: 'Strength', maxLevel: 10, buryAt: 5, minFood: 5, area: { name: 'Barbarian Village', point: { x: 3079, y: 3419, plane: 0 } } },
  'range-cows': { activity: 'train Ranged on cows with a bow, picking up arrows', monsters: ['Cow', 'Cow calf'], loot: ['Bronze arrow', 'Iron arrow'], keep: [], skill: 'Ranged', style: 'ranged', area: { name: 'Lumbridge cow field', point: { x: 3257, y: 3265, plane: 0 } } },
  'mage-chickens': { activity: 'train Magic on chickens with Wind Strike autocast', monsters: ['Chicken'], loot: [], keep: [], skill: 'Magic', style: 'magic', area: { name: 'Lumbridge chicken farm', point: { x: 3232, y: 3295, plane: 0 } } },
  'kill-guards': { activity: 'kill Varrock guards and collect coins', monsters: ['Guard'], loot: ['Coins'], keep: [], skill: 'Strength', minFood: 10, area: { name: 'Varrock west guards', point: { x: 3175, y: 3425, plane: 0 } } },
};

/** How many of an item (by name substring) the inventory holds, counting stack sizes. */
function held(s: Snapshot, name: string): number {
  const n = name.toLowerCase();
  const inv = s.inventory.items.filter((i) => i.name.toLowerCase().includes(n)).reduce((sum, i) => sum + i.quantity, 0);
  // Matches the hasItem condition: ammo picked up joins the quiver stack.
  const ammo = s.equipment.filter((e) => e.slot === 'AMMO' && e.name.toLowerCase().includes(n)).reduce((sum, e) => sum + (e.quantity ?? 1), 0);
  return inv + ammo;
}

export function nextCombatStep(task: CombatTask, s: Snapshot, cc: CombatContext = {}): PlanStep {
  if (task.untilLevel) {
    const sk = s.skills.find((k) => k.name.toLowerCase() === task.skill.toLowerCase());
    if (sk && sk.level >= task.untilLevel) return { kind: 'complete', reason: `${task.skill} reached ${sk.level}` };
  }
  const readiness = combatReadiness(task, s, cc);
  if (readiness) return readiness;
  if (task.buryAt && held(s, 'Bones') >= task.buryAt) {
    return { kind: 'subgoal', subgoal: goal('bury all the bones in the inventory', ['Bones'], ['Bury'], { lacksItem: 'Bones' }, 60, task.keep) };
  }
  // Sequencing ("kill, then loot") is decided here, not by the classifier: offered both, it keeps
  // choosing the next attack over the drop on the floor. Coins and valuable drops come first, then
  // the task's own loot (bones, hides); each pickup is its own sub-goal.
  const minValue = task.lootValue ?? 25;
  const ours = s.groundItems.filter((g) => g.lootable && g.reachable && g.distance <= 8);
  const wanted = (g: (typeof ours)[number]) =>
    /^coins$/i.test(g.name) || g.geValue >= minValue || task.loot.some((l) => g.name.toLowerCase().includes(l.toLowerCase()));
  const priority = (g: (typeof ours)[number]) => (/^coins$/i.test(g.name) ? 0 : g.geValue >= minValue ? 1 : 2);
  const lootHere = ours.filter(wanted).sort((x, y) => priority(x) - priority(y) || x.distance - y.distance)[0];
  const stackable = lootHere && (/^coins$/i.test(lootHere.name) || s.inventory.items.some((i) => i.name === lootHere.name && i.stackable));
  if (lootHere && (s.inventory.freeSlots > 0 || stackable)) {
    const what = /^coins$/i.test(lootHere.name) ? `${lootHere.quantity} coins` : `the ${lootHere.name}`;
    return {
      kind: 'subgoal',
      subgoal: { ...goal(`pick up ${what} on the ground`, [lootHere.name], ['Take'], { hasItem: { name: lootHere.name, count: held(s, lootHere.name) + (/^coins$/i.test(lootHere.name) ? lootHere.quantity : 1) } }, 30, task.keep), noTravel: true },
    };
  }
  if (s.inventory.freeSlots === 0) return { kind: 'complete', reason: 'inventory full' };
  const inView = s.npcs.some(
    (n) => task.monsters.some((m) => n.name.toLowerCase() === m.toLowerCase()) && n.reachable && (task.maxLevel === undefined || n.combatLevel <= task.maxLevel),
  );
  if (!inView && task.area) {
    return {
      kind: 'subgoal',
      subgoal: { ...goal(`walk to the ${task.area.name}`, task.monsters, ['Attack'], { near: { ...task.area.point, radius: 6 } }, 300, task.keep), destination: task.area },
    };
  }
  const attack = goal(`attack a ${task.monsters.join(' or ')}${task.maxLevel ? ` (level ${task.maxLevel} or lower)` : ''}`, task.monsters, ['Attack'], { lootNear: { names: task.loot, minValue: task.lootValue ?? 25, radius: 6 } }, 250, task.keep);
  const style = task.style ?? 'melee';
  const lootDone = attack.isDone!;
  return {
    kind: 'subgoal',
    // Steps include every combat tick; a level-21 guard takes far longer than a chicken.
    subgoal: {
      ...attack,
      // An empty quiver or missing runes also ends the fight, so the kit check can re-equip or restock.
      isDone: (snap) => lootDone(snap) || outOfSupplies(style, snap),
      maxTargetLevel: task.maxLevel,
      noTravel: true,
    },
  };
}

const foodKeep = Object.keys(FOOD_HEAL);

/**
 * Pre-fight checks, in order: finish banking; top HP up with carried food; restock food when below
 * the task's minimum and the bank has some; with no food anywhere, rest to 80% HP before fighting.
 * Returns null when ready to fight.
 */
function combatReadiness(task: CombatTask, s: Snapshot, cc: CombatContext): PlanStep | null {
  const hp = s.player?.hp;
  const hpFrac = hp && hp.max > 0 ? hp.current / hp.max : 1;
  const food = foodSupply(s.inventory.items);
  const minFood = task.minFood ?? 0;
  const style = task.style ?? 'melee';
  const invNames = s.inventory.items.map((i) => i.name);
  const invUpgrades = upgradesFrom(s, invNames, style);
  const kitNames = style === 'melee' ? [] : planKit(style, s, { bank: cc.bankCounts ?? null }).need.map((n) => n.name);
  const keep = [...task.keep, ...foodKeep, ...invUpgrades.map((u) => u.name), ...kitNames];
  const pos = s.player?.position;
  const nearestBank = pos && cc.kb ? cc.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
  const kitStep = () =>
    style === 'melee' ? null : nextKitStep(style, s, { bank: cc.bankCounts ?? null }, nearestBank ? { name: nearestBank.name, point: nearestBank.point } : undefined);

  if (s.shop.open) return kitStep() ?? { kind: 'subgoal', subgoal: goal('close the shop', [], ['Close'], { shopOpen: false }, 5, keep) };

  if (s.bank.open) {
    const loot = [...new Set(s.inventory.items.map((i) => i.name))].filter((n) => !keep.some((k) => n.toLowerCase().includes(k.toLowerCase())) && !/coins/i.test(n));
    if (loot.length) return { kind: 'subgoal', subgoal: goal(`deposit the ${loot.join(', ')}`, loot, ['Deposit'], { lacksItems: loot }, 20, keep) };
    const kit = kitStep();
    if (kit) return kit;
    // Better weapon/armour in the bank than what is worn or carried: take it out to wield.
    const fetch = upgradesFrom(s, [...invNames, ...s.bank.items.map((b) => b.name)], style).filter((u) => !invNames.includes(u.name) && !kitNames.includes(u.name));
    if (fetch.length) {
      const want = fetch.map((u) => ({ name: u.name, count: 1 }));
      return {
        kind: 'subgoal',
        subgoal: { ...goal(`withdraw ${fetch.map((u) => u.name).join(', ')} to wear for combat`, fetch.map((u) => u.name), ['Withdraw'], { hasItems: want }, 20, [...keep, ...fetch.map((u) => u.name)]), want },
      };
    }
    const best = s.bank.items.filter((b) => FOOD_HEAL[b.name] !== undefined).sort((a, b) => FOOD_HEAL[b.name]! - FOOD_HEAL[a.name]!)[0];
    const batch = task.foodBatch ?? 10;
    if (best && food.count < batch) {
      const count = Math.min(batch, food.count + best.quantity);
      return {
        kind: 'subgoal',
        subgoal: { ...goal(`withdraw ${count} ${best.name} to eat during combat`, [best.name], ['Withdraw'], { hasItem: { name: best.name, count } }, 20, keep), want: [{ name: best.name, count }] },
      };
    }
    return { kind: 'subgoal', subgoal: goal('close the bank', ['Bank'], ['Close'], { bankOpen: false }, 5, keep) };
  }

  if (!s.player?.inCombat) {
    const kit = kitStep();
    if (kit) return kit;
  } else if (outOfSupplies(style, s)) {
    // Mid-fight with no ammo/runes: an attack sub-goal would be done before it starts (see
    // nextCombatStep), and re-planning it spins. Let the fight end, then restock.
    return { kind: 'wait', reason: `out of ${style} supplies; waiting for the fight to end`, until: { inCombat: false }, maxSeconds: 30 };
  }

  // Never fight with a tool in hand: wield the best carried weapon/armour first.
  const wield = invUpgrades[0];
  if (wield && !s.player?.inCombat) {
    return { kind: 'subgoal', subgoal: goal(`wield the ${wield.name} (better ${wield.slot})`, [wield.name], ['Wield', 'Wear'], { equipped: [wield.name] }, 10, keep) };
  }

  // Top up before engaging: the in-fight reflex only eats below 50%.
  if (hpFrac < 0.6 && food.count > 0 && !s.player?.inCombat) {
    const edible = s.inventory.items.find((i) => i.actions.some((a) => a.toLowerCase() === 'eat'))!;
    return { kind: 'subgoal', subgoal: goal(`eat the ${edible.name} to heal before fighting`, [edible.name], ['Eat'], { hpAtLeast: 0.8 }, 12, keep) };
  }

  // Gear upgrades known to be banked, or weak/empty slots and the bank not checked yet.
  const weak = weakSlots(s, style).filter((slot) => style === 'melee' || (slot !== 'weapon' && slot !== 'ammo'));
  const gearTrip = cc.bankItems ? upgradesFrom(s, cc.bankItems, style).length > 0 : weak.length > 0;
  const needFood = food.count < minFood;
  if (needFood || gearTrip) {
    const bankHasFood = cc.bankFood === null || cc.bankFood === undefined ? true : [...cc.bankFood.values()].some((n) => n > 0);
    const pos = s.player?.position;
    const bank = pos && cc.kb ? cc.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
    if (((needFood && bankHasFood) || gearTrip) && bank) {
      const why = [needFood && bankHasFood ? 'restock food' : '', gearTrip ? `get better gear (${weak.join(', ') || 'upgrades'})` : ''].filter(Boolean).join(' and ');
      return {
        kind: 'subgoal',
        subgoal: { ...goal(`${why} at the ${bank.name}`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, keep), destination: { name: bank.name, point: bank.point }, avoid: NOT_BANKS },
      };
    }
  }
  if (needFood) {
    // No food to be had: never start a fight weak; let HP regenerate (1 HP/min) first.
    if (hpFrac < 0.8) {
      return { kind: 'wait', reason: `no food; resting until HP >= 80% (now ${hp?.current}/${hp?.max})`, until: { hpAtLeast: 0.8 }, maxSeconds: 900 };
    }
  }
  return null;
}

const BANK_TARGETS = ['Bank booth', 'Bank chest', 'Banker'];
/** Look-alikes that are not banks: a poll booth ("Use") opens the poll menu, a deposit box only deposits. */
export const NOT_BANKS = ['Poll booth', 'Bank Deposit Box', 'Bank deposit box', 'Deposit Box'];

function goal(text: string, targets: string[], actions: string[], doneWhen: DoneCondition | undefined, maxSteps: number, keep: string[]): PlannedSubGoal {
  return { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep };
}

/** Whether an item name is the tool a keep entry names: "axe" matches "Bronze axe", not "Bronze pickaxe". */
export function isTool(name: string, tool: string): boolean {
  const n = name.toLowerCase();
  const t = tool.toLowerCase();
  return n === t || n.endsWith(` ${t}`);
}

/**
 * @param bankItems item names last seen in the bank; null until the bank has been opened. With it,
 * a missing tool (the first `keep` entry) is fetched from the bank, or the task is impossible.
 */
export function nextGatherStep(task: GatherTask, s: Snapshot, bankItems: string[] | null = null): PlanStep {
  if (task.untilLevel) {
    const sk = s.skills.find((k) => k.name.toLowerCase() === task.skill.toLowerCase());
    if (sk && sk.level >= task.untilLevel) return { kind: 'complete', reason: `${task.skill} reached ${sk.level}` };
  }
  // Too low a level for every target (oaks at Woodcutting 8): each click would only fail.
  const rules = RESOURCES.filter((r) => task.targets.includes(r.target) && r.skill.toLowerCase() === task.skill.toLowerCase());
  const level = s.skills.find((k) => k.name.toLowerCase() === task.skill.toLowerCase())?.level;
  if (rules.length && level !== undefined && rules.every((r) => level < r.level)) {
    return { kind: 'impossible', reason: `${task.skill} ${Math.min(...rules.map((r) => r.level))} needed (have ${level})` };
  }
  const product = task.product.toLowerCase();
  const hasProduct = s.inventory.items.some((i) => i.name.toLowerCase().includes(product));
  const full = s.inventory.freeSlots === 0;

  const tool = task.keep[0];
  const hasTool = !tool || [...s.inventory.items, ...s.equipment].some((i) => isTool(i.name, tool));

  if (s.bank.open) {
    if (hasProduct) {
      return {
        kind: 'subgoal',
        subgoal: goal(`deposit all ${task.product} items into the bank, keeping the ${task.keep.join(' and ')}`, [task.product], ['Deposit'], { lacksItem: task.product }, 10, task.keep),
      };
    }
    if (!hasTool) {
      const banked = s.bank.items.find((b) => isTool(b.name, tool));
      if (!banked) return { kind: 'impossible', reason: `no ${tool} carried, worn or banked` };
      const want = [{ name: banked.name, count: 1 }];
      return { kind: 'subgoal', subgoal: { ...goal(`withdraw 1 ${banked.name}`, [banked.name], ['Withdraw'], { hasItem: want[0] }, 20, [...task.keep, banked.name]), want } };
    }
    return { kind: 'subgoal', subgoal: goal('close the bank', ['Bank'], ['Close'], { bankOpen: false }, 5, task.keep) };
  }

  if (!hasTool) {
    if (bankItems && !bankItems.some((b) => isTool(b, tool))) return { kind: 'impossible', reason: `no ${tool} carried, worn or banked` };
    return {
      kind: 'subgoal',
      subgoal: { ...goal(`go to the nearest bank and open it to fetch the ${tool}`, BANK_TARGETS, ['Bank'], { bankOpen: true }, 300, task.keep), avoid: NOT_BANKS },
    };
  }

  if (full && hasProduct) {
    if (task.bank) {
      return {
        kind: 'subgoal',
        subgoal: { ...goal('go to the nearest bank and open it', BANK_TARGETS, ['Bank'], { bankOpen: true }, 300, task.keep), avoid: NOT_BANKS },
      };
    }
    return {
      kind: 'subgoal',
      subgoal: goal(`drop every ${task.product} item from the inventory, keeping the ${task.keep.join(' and ')}`, [task.product], ['Drop'], { lacksItem: task.product }, 40, task.keep),
    };
  }

  const actions = [task.action, ...(task.altActions ?? [])];
  const inView =
    s.npcs.some((n) => task.targets.includes(n.name) && n.actions.some((a) => actions.includes(a))) ||
    s.objects.some((o) => task.targets.includes(o.name) && o.actions.some((a) => actions.includes(a)));
  if (!inView && task.area) {
    return {
      kind: 'subgoal',
      subgoal: { ...goal(`walk to the ${task.area.name}`, task.targets, actions, { near: { ...task.area.point, radius: 8 } }, 400, task.keep), destination: task.area },
    };
  }
  // The area stays the destination so that, if the spots drift out of view mid-trip, the engine
  // travels back instead of clicking whatever is nearby (a Draynor poll booth, once).
  return {
    kind: 'subgoal',
    subgoal: {
      ...goal(`${task.activity}: use "${task.action}" on the ${task.targets.join(' or ')}`, task.targets, actions, { inventoryFull: true }, 1200, task.keep),
      destination: task.area,
    },
  };
}

type Task = ({ kind: 'gather' } & GatherTask) | ({ kind: 'combat' } & CombatTask);

export class TaskTreePlanner implements Planner {
  readonly name: string;
  private readonly task: Task;
  private bankFood: Map<string, number> | null = null;
  private bankItems: string[] | null = null;
  private bankCounts: Map<string, number> | null = null;

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
    if (ctx.snapshot.bank.open) {
      this.bankItems = ctx.snapshot.bank.items.map((b) => b.name);
      this.bankCounts = new Map(ctx.snapshot.bank.items.map((b) => [b.name, b.quantity]));
      this.bankFood = new Map(ctx.snapshot.bank.items.filter((b) => FOOD_HEAL[b.name] !== undefined).map((b) => [b.name, b.quantity]));
    }
    return this.task.kind === 'combat'
      ? nextCombatStep(this.task, ctx.snapshot, { kb: ctx.kb, bankFood: this.bankFood, bankItems: this.bankItems, bankCounts: this.bankCounts })
      : nextGatherStep(this.task, ctx.snapshot, this.bankItems);
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
