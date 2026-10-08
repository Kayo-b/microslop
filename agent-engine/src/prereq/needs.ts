/**
 * What an activity needs before it can make progress: skill levels and quests (catalog
 * `Requirement`), a tool, consumables, food, a ranged/magic kit, or input materials. Derived from
 * the activity's own definition (preset, cooking preset, combat execution, catalog requirement),
 * so a new preset gets its prerequisites without another table to keep in sync.
 */
import { FOOD_HEAL, RESOURCES } from '../kb/resources.ts';
import { COOK_PRESETS } from '../planner/CookingPlanner.ts';
import { type CombatStyle, type GearSlot, requiredSlots } from '../planner/gear.ts';
import { COMBAT_PRESETS, PRESETS } from '../planner/TaskTreePlanner.ts';
import { GOLD, QUESTS, TRAINING, type Execution, type Requirement } from '../strategy/catalog.ts';

export interface ToolNeed {
  /** Lower-case name suffix any owned item may match ("axe" matches "Bronze axe", not "Pickaxe"). */
  any: string;
  /** What to buy when none is owned. */
  buy: string;
}

export interface SupplyNeed {
  item: string;
  /** Owned below this: restock. */
  min: number;
  /** How many to buy when restocking. */
  buy: number;
}

export interface InputNeed {
  /** Exact item name the activity consumes from the bank (raw fish, ore). */
  item: string;
  min: number;
  /** Activity that produces it, run for `minutes` per round. */
  produce: Execution;
  minutes: number;
}

export interface ActivityNeeds {
  /** Short name for logs and skip memory. */
  name: string;
  req: Requirement;
  tools: ToolNeed[];
  supplies: SupplyNeed[];
  /** Pieces of cooked food owned (carried + banked) before fighting. */
  food: number;
  /** Combat gear: these slots must hold usable gear for the style (bought when none is owned). */
  gear?: { style: CombatStyle; slots: GearSlot[]; /** Loadout for non-combat work: buy only what the coins on hand cover, never block or earn coins for it. */ soft?: boolean };
  /** Ranged/magic kit; its coins come from `planKit`. */
  style?: Exclude<CombatStyle, 'melee'>;
  inputs: InputNeed[];
  /** Deposit carried materials (potions, herbs, ore, logs...) at the bank before the activity starts. */
  bankMaterials?: boolean;
}

const TOOL_BUY: Record<string, string> = { axe: 'Bronze axe', pickaxe: 'Bronze pickaxe', 'small fishing net': 'Small fishing net', 'fly fishing rod': 'Fly fishing rod', hammer: 'Hammer', tinderbox: 'Tinderbox' };

/** Executions that run before the character has (or sells) gear: no loadout check. */
const NO_LOADOUT = new Set<Execution['kind']>(['tutorial', 'sell', 'acquire']);

/** Food to have before a fight: none against monsters that cannot really hurt (chickens, cows). */
const HARMLESS = /^(chicken|cow|cow calf|goblin|man|woman|rat|giant rat)$/i;

function empty(name: string): ActivityNeeds {
  return { name, req: {}, tools: [], supplies: [], food: 0, inputs: [] };
}

function toolFor(keep: string): ToolNeed | null {
  const k = keep.toLowerCase();
  const buy = TOOL_BUY[k];
  return buy ? { any: k, buy } : null;
}

/** Lowest level any of the targets can be gathered at (oaks: Woodcutting 15). */
function gatherLevel(targets: string[], skill: string): number | null {
  const levels = RESOURCES.filter((r) => targets.includes(r.target) && r.skill === skill).map((r) => r.level);
  return levels.length ? Math.min(...levels) : null;
}

function presetNeeds(preset: string): ActivityNeeds | null {
  const g = PRESETS[preset];
  if (g) {
    const n = empty(preset);
    const lvl = gatherLevel(g.targets, g.skill);
    if (lvl && lvl > 1) n.req.skills = { [g.skill]: lvl };
    for (const k of g.keep) {
      const t = toolFor(k);
      if (t) n.tools.push(t);
      else if (k === 'Feather') n.supplies.push({ item: 'Feather', min: 50, buy: 300 });
    }
    // Fly fishing has no level-1 target: the catalog's 20 is the real floor.
    if (preset === 'fish-trout') n.req.skills = { Fishing: 20 };
    return n;
  }
  const c = COMBAT_PRESETS[preset];
  if (c) {
    const n = empty(preset);
    n.food = c.minFood ?? (c.monsters.every((m) => HARMLESS.test(m)) ? 0 : 5);
    if (c.style && c.style !== 'melee') n.style = c.style;
    // Armour is bought only for fights that hurt; owned gear is worn for every fight (combatReadiness).
    if (!c.monsters.every((m) => HARMLESS.test(m))) n.gear = { style: c.style ?? 'melee', slots: requiredSlots(c.style ?? 'melee') };
    return n;
  }
  const cook = COOK_PRESETS[preset];
  if (cook) {
    const n = empty(preset);
    n.tools.push(toolFor('axe')!, toolFor('tinderbox')!);
    const fish = cook.raw === 'Raw shrimps' ? 'fish-shrimp' : cook.raw === 'Raw trout' ? 'fish-trout' : null;
    if (fish) n.inputs.push({ item: cook.raw, min: 1, produce: { kind: 'preset', preset: fish, bank: true }, minutes: 15 });
    return n;
  }
  if (preset === 'smith-progression') {
    const n = empty(preset);
    n.tools.push(toolFor('hammer')!);
    return n;
  }
  return null;
}

/** Needs of a strategy/plan phase or a `--task` preset. Null for executions with nothing to check. */
export function activityNeeds(exec: Execution, catalogReq?: Requirement): ActivityNeeds | null {
  let n: ActivityNeeds | null = null;
  switch (exec.kind) {
    case 'preset':
      n = presetNeeds(exec.preset);
      break;
    case 'combat': {
      n = empty(`kill-${exec.monster.toLowerCase().replace(/\s+/g, '-')}`);
      n.food = HARMLESS.test(exec.monster) ? 0 : (exec.food ?? 5);
      if (exec.style && exec.style !== 'melee') n.style = exec.style;
      if (!HARMLESS.test(exec.monster)) n.gear = { style: exec.style ?? 'melee', slots: requiredSlots(exec.style ?? 'melee') };
      break;
    }
    case 'quest': {
      n = empty(`quest:${exec.quest}`);
      n.req = { ...(QUESTS.find((q) => q.name === exec.quest)?.req ?? {}) };
      break;
    }
    default:
      n = catalogReq || !NO_LOADOUT.has(exec.kind) ? empty(exec.kind) : null;
  }
  // Every activity starts fully geared: a weapon and armour in every slot, worn (PrereqPlanner's
  // equip step). Combat already needs it hard; elsewhere it is bought only when affordable.
  if (n && (exec.kind === 'quest' || exec.kind === 'llm')) n.bankMaterials = true;
  if (n && !n.gear && !NO_LOADOUT.has(exec.kind)) n.gear = { style: 'melee', slots: requiredSlots('melee'), soft: true };
  if (n && catalogReq) n.req = mergeReq(n.req, catalogReq);
  return n;
}

/** The catalog requirement of the method/route/quest that runs an execution, if any. */
export function catalogReqFor(exec: Execution): Requirement | undefined {
  const same = (e: Execution) => JSON.stringify(e) === JSON.stringify(exec);
  return TRAINING.find((m) => same(m.exec))?.req ?? GOLD.find((r) => same(r.exec))?.req;
}

function mergeReq(a: Requirement, b: Requirement): Requirement {
  const skills = { ...(a.skills ?? {}) };
  for (const [k, v] of Object.entries(b.skills ?? {})) skills[k] = Math.max(skills[k] ?? 0, v);
  return {
    skills: Object.keys(skills).length ? skills : undefined,
    quests: [...new Set([...(a.quests ?? []), ...(b.quests ?? [])])],
    qp: Math.max(a.qp ?? 0, b.qp ?? 0) || undefined,
    items: [...new Set([...(a.items ?? []), ...(b.items ?? [])])],
    combat: Math.max(a.combat ?? 0, b.combat ?? 0) || undefined,
  };
}

/** Cooked food pieces in a name -> count map. */
export function foodCount(counts: Map<string, number>): number {
  let n = 0;
  for (const [name, q] of counts) if (FOOD_HEAL[name] !== undefined) n += q;
  return n;
}
