/**
 * Gear ranking for the pre-combat equipment check, per combat style (melee metal gear; bows and
 * arrows for ranged; staves for magic). Gear is scored by metal tier and item
 * type; an item is only a candidate when the player meets its Attack (weapons) or Defence (armour)
 * requirement. Tools that happen to be wieldable (axes, pickaxes) count as a weapon of score 0, so
 * any real weapon replaces them.
 */
import type { Snapshot } from '../types.ts';

export type GearSlot = 'weapon' | 'shield' | 'head' | 'body' | 'legs' | 'ammo';
export type CombatStyle = 'melee' | 'ranged' | 'magic';

/** Metal prefix -> [tier, level requirement]. */
const TIERS: [RegExp, number, number][] = [
  [/^bronze /i, 1, 1],
  [/^iron /i, 2, 1],
  [/^steel /i, 3, 5],
  [/^black /i, 4, 10],
  [/^mithril /i, 5, 20],
  [/^adamant /i, 6, 30],
  [/^rune /i, 7, 40],
];

/** Item type -> slot and a small bonus ranking types within a tier. Two-handers are left out: they block the shield. */
const TYPES: [RegExp, GearSlot, number][] = [
  [/ scimitar$/i, 'weapon', 4],
  [/ longsword$/i, 'weapon', 3],
  [/ sword$/i, 'weapon', 2],
  [/ battleaxe$/i, 'weapon', 2],
  [/ mace$/i, 'weapon', 1],
  [/ warhammer$/i, 'weapon', 1],
  [/ dagger$/i, 'weapon', 0],
  [/ kiteshield$/i, 'shield', 2],
  [/ sq shield$/i, 'shield', 1],
  [/ full helm$/i, 'head', 2],
  [/ med helm$/i, 'head', 1],
  [/ platebody$/i, 'body', 2],
  [/ chainbody$/i, 'body', 1],
  [/ platelegs$/i, 'legs', 2],
  [/ plateskirt$/i, 'legs', 2],
];

const TOOL = /(^|\s)(axe|pickaxe)$/i;

/** Bows by name: [score, Ranged level]. All are two-handed. */
const BOWS: Record<string, [number, number]> = {
  Shortbow: [10, 1], Longbow: [9, 1],
  'Oak shortbow': [20, 5], 'Oak longbow': [19, 5],
  'Willow shortbow': [30, 20], 'Willow longbow': [29, 20],
  'Maple shortbow': [40, 30], 'Maple longbow': [39, 30],
  'Yew shortbow': [50, 40], 'Yew longbow': [49, 40],
};
/** Arrows by name: [score, Ranged level of the weakest bow that fires them]. */
const ARROWS: Record<string, [number, number]> = {
  'Bronze arrow': [10, 1], 'Iron arrow': [20, 1], 'Steel arrow': [30, 5], 'Mithril arrow': [40, 20], 'Adamant arrow': [50, 30], 'Rune arrow': [60, 40],
};
/** Staves that can autocast: [score, Magic level]. */
const STAVES: Record<string, [number, number]> = {
  Staff: [10, 1], 'Magic staff': [12, 1],
  'Staff of air': [20, 1], 'Staff of water': [20, 1], 'Staff of earth': [20, 1], 'Staff of fire': [20, 1],
};

export interface GearInfo {
  slot: GearSlot;
  score: number;
  /** Attack (weapon) or Defence (armour) level needed. */
  req: number;
}

export function classifyGear(name: string, style: CombatStyle = 'melee'): GearInfo | null {
  if (style !== 'melee') {
    const table = style === 'ranged' ? BOWS : STAVES;
    if (table[name]) return { slot: 'weapon', score: table[name]![0], req: table[name]![1] };
    if (style === 'ranged' && ARROWS[name]) return { slot: 'ammo', score: ARROWS[name]![0], req: ARROWS[name]![1] };
    const melee = classifyGear(name, 'melee');
    // Any other weapon is no weapon for this style; bows are two-handed, so shields are left alone.
    if (melee?.slot === 'weapon') return { slot: 'weapon', score: 0, req: 1 };
    if (melee?.slot === 'shield' && style === 'ranged') return null;
    return melee;
  }
  if (TOOL.test(name)) return { slot: 'weapon', score: 0, req: 1 };
  const tier = TIERS.find(([re]) => re.test(name));
  const type = TYPES.find(([re]) => re.test(name));
  if (!tier || !type) return null;
  return { slot: type[1], score: tier[1] * 10 + type[2], req: tier[2] };
}

export const GEAR_SLOTS: GearSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'ammo'];

function slotsFor(style: CombatStyle): GearSlot[] {
  if (style === 'ranged') return ['weapon', 'ammo', 'head', 'body', 'legs'];
  return ['weapon', 'shield', 'head', 'body', 'legs'];
}

const LEVEL_SKILL: Record<CombatStyle, string> = { melee: 'Attack', ranged: 'Ranged', magic: 'Magic' };

function level(s: Snapshot, skill: string): number {
  return s.skills.find((k) => k.name === skill)?.level ?? 1;
}

function usable(s: Snapshot, info: GearInfo, style: CombatStyle): boolean {
  const armour = info.slot !== 'weapon' && info.slot !== 'ammo';
  return info.req <= level(s, armour ? 'Defence' : LEVEL_SKILL[style]);
}

/** Score of what is worn in each slot (-1 when empty or unrecognised). */
export function wornScores(s: Snapshot, style: CombatStyle = 'melee'): Record<GearSlot, number> {
  const out = { weapon: -1, shield: -1, head: -1, body: -1, legs: -1, ammo: -1 } as Record<GearSlot, number>;
  for (const e of s.equipment) {
    const g = classifyGear(e.name, style);
    if (g) out[g.slot] = Math.max(out[g.slot], g.score);
  }
  return out;
}

export interface GearUpgrade {
  slot: GearSlot;
  name: string;
  score: number;
}

/** The best usable item per slot among `names` that beats what is worn. */
export function upgradesFrom(s: Snapshot, names: Iterable<string>, style: CombatStyle = 'melee'): GearUpgrade[] {
  const worn = wornScores(s, style);
  const best = new Map<GearSlot, GearUpgrade>();
  for (const name of names) {
    const g = classifyGear(name, style);
    if (!g || g.score === 0 || !usable(s, g, style) || g.score <= worn[g.slot]) continue;
    const cur = best.get(g.slot);
    if (!cur || g.score > cur.score) best.set(g.slot, { slot: g.slot, name, score: g.score });
  }
  return slotsFor(style).flatMap((slot) => (best.has(slot) ? [best.get(slot)!] : []));
}

/** Slots with nothing useful worn: an empty armour slot, or no real weapon (a tool counts as none). */
export function weakSlots(s: Snapshot, style: CombatStyle = 'melee'): GearSlot[] {
  const worn = wornScores(s, style);
  return slotsFor(style).filter((slot) => worn[slot] <= 0);
}

/** Cheapest shop weapon/ammo per style, used when the account owns none. */
export const STARTER_KIT: Record<Exclude<CombatStyle, 'melee'>, { weapon: string; ammo?: string }> = {
  ranged: { weapon: 'Shortbow', ammo: 'Bronze arrow' },
  magic: { weapon: 'Staff' },
};

const METALS: [string, number][] = [['Bronze', 1], ['Iron', 1], ['Steel', 5], ['Black', 10], ['Mithril', 20], ['Adamant', 30], ['Rune', 40]];
const SLOT_TYPES: Partial<Record<GearSlot, string[]>> = {
  weapon: ['scimitar', 'longsword', 'sword'],
  shield: ['kiteshield', 'sq shield'],
  head: ['full helm', 'med helm'],
  body: ['platebody', 'chainbody'],
  legs: ['platelegs', 'plateskirt'],
};

/** Armour (and melee weapon) slots worth filling before fighting in a style. */
export function requiredSlots(style: CombatStyle): GearSlot[] {
  if (style === 'melee') return ['weapon', 'head', 'body', 'legs', 'shield'];
  // Bows are two-handed; the ranged/magic weapon and ammo come from the kit.
  return style === 'ranged' ? ['head', 'body', 'legs'] : ['head', 'body', 'legs', 'shield'];
}

/** Items that fill a slot at these levels, best first (metal tier, then type). */
export function gearCandidates(slot: GearSlot, levels: { attack: number; defence: number }): string[] {
  const types = SLOT_TYPES[slot] ?? [];
  const lvl = slot === 'weapon' ? levels.attack : levels.defence;
  return METALS.filter(([, req]) => req <= lvl)
    .reverse()
    .flatMap(([metal]) => types.map((t) => `${metal} ${t}`));
}

/** Whether `name` fills `slot` for `style` and its level requirement is met. */
export function fillsSlot(name: string, slot: GearSlot, style: CombatStyle, levels: { attack: number; defence: number; ranged: number; magic: number }): boolean {
  const g = classifyGear(name, style);
  if (!g || g.slot !== slot || g.score <= 0) return false;
  const armour = slot !== 'weapon' && slot !== 'ammo';
  const lvl = armour ? levels.defence : style === 'melee' ? levels.attack : style === 'ranged' ? levels.ranged : levels.magic;
  return g.req <= lvl;
}
