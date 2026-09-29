/**
 * Melee gear ranking for the pre-combat equipment check. Gear is scored by metal tier and item
 * type; an item is only a candidate when the player meets its Attack (weapons) or Defence (armour)
 * requirement. Tools that happen to be wieldable (axes, pickaxes) count as a weapon of score 0, so
 * any real weapon replaces them.
 */
import type { Snapshot } from '../types.ts';

export type GearSlot = 'weapon' | 'shield' | 'head' | 'body' | 'legs';

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

export interface GearInfo {
  slot: GearSlot;
  score: number;
  /** Attack (weapon) or Defence (armour) level needed. */
  req: number;
}

export function classifyGear(name: string): GearInfo | null {
  if (TOOL.test(name)) return { slot: 'weapon', score: 0, req: 1 };
  const tier = TIERS.find(([re]) => re.test(name));
  const type = TYPES.find(([re]) => re.test(name));
  if (!tier || !type) return null;
  return { slot: type[1], score: tier[1] * 10 + type[2], req: tier[2] };
}

export const GEAR_SLOTS: GearSlot[] = ['weapon', 'shield', 'head', 'body', 'legs'];

function level(s: Snapshot, skill: string): number {
  return s.skills.find((k) => k.name === skill)?.level ?? 1;
}

function usable(s: Snapshot, info: GearInfo): boolean {
  return info.req <= level(s, info.slot === 'weapon' ? 'Attack' : 'Defence');
}

/** Score of what is worn in each slot (-1 when empty or unrecognised). */
export function wornScores(s: Snapshot): Record<GearSlot, number> {
  const out = { weapon: -1, shield: -1, head: -1, body: -1, legs: -1 } as Record<GearSlot, number>;
  for (const e of s.equipment) {
    const g = classifyGear(e.name);
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
export function upgradesFrom(s: Snapshot, names: Iterable<string>): GearUpgrade[] {
  const worn = wornScores(s);
  const best = new Map<GearSlot, GearUpgrade>();
  for (const name of names) {
    const g = classifyGear(name);
    if (!g || g.score === 0 || !usable(s, g) || g.score <= worn[g.slot]) continue;
    const cur = best.get(g.slot);
    if (!cur || g.score > cur.score) best.set(g.slot, { slot: g.slot, name, score: g.score });
  }
  return GEAR_SLOTS.flatMap((slot) => (best.has(slot) ? [best.get(slot)!] : []));
}

/** Slots with nothing useful worn: an empty armour slot, or no real weapon (a tool counts as none). */
export function weakSlots(s: Snapshot): GearSlot[] {
  const worn = wornScores(s);
  return GEAR_SLOTS.filter((slot) => worn[slot] <= 0);
}
