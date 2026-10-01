/**
 * Serializable sub-goal completion conditions. Task trees and the LLM planner both describe
 * "done" declaratively so it can be logged, sent over the wire, and checked deterministically
 * every tick instead of trusting the classifier's `done` answer.
 */
import { tileDistance } from '../kb/KnowledgeBase.ts';
import type { Snapshot } from '../types.ts';

export interface DoneCondition {
  inventoryFull?: boolean;
  /** Inventory holds at least `count` of an item (case-insensitive substring match). */
  hasItem?: { name: string; count?: number };
  /** Every listed item is held in at least the given count. */
  hasItems?: { name: string; count?: number }[];
  /** Inventory holds none of this item. */
  lacksItem?: string;
  /** Inventory holds none of any of these items. */
  lacksItems?: string[];
  bankOpen?: boolean;
  shopOpen?: boolean;
  /** Current HP is at least this fraction of max (0-1). */
  hpAtLeast?: number;
  /** Every listed item is worn/wielded (case-insensitive substring). */
  equipped?: string[];
  /** Player is within `radius` tiles of a point. */
  near?: { x: number; y: number; plane: number; radius?: number };
  skillLevel?: { skill: string; level: number };
  dialogueOpen?: boolean;
  /** The player is (not) in combat. */
  inCombat?: boolean;
  /** An object with this name is within `radius` tiles (a lit fire, an open door...). */
  objectNear?: { name: string; radius?: number };
  /** Any of our drops lies within `radius`: named items, coins, or anything worth >= minValue gp. */
  lootNear?: { names: string[]; minValue: number; radius?: number };
  /** One of our (lootable) items of this name lies on the ground within `radius` tiles. */
  groundItemNear?: { name: string; radius?: number };
}

/** Carried count; picked-up ammo goes straight into a matching quiver stack, so that counts too. */
const count = (s: Snapshot, name: string) => {
  const n = name.toLowerCase();
  const inv = s.inventory.items.filter((i) => i.name.toLowerCase().includes(n)).reduce((sum, i) => sum + i.quantity, 0);
  const ammo = s.equipment.filter((e) => e.slot === 'AMMO' && e.name.toLowerCase().includes(n)).reduce((sum, e) => sum + (e.quantity ?? 1), 0);
  return inv + ammo;
};

/** All specified clauses must hold. An empty condition never completes (the model decides). */
export function evaluate(cond: DoneCondition, s: Snapshot): boolean {
  const clauses: boolean[] = [];
  if (cond.inventoryFull !== undefined) clauses.push((s.inventory.freeSlots === 0) === cond.inventoryFull);
  if (cond.hasItem) clauses.push(count(s, cond.hasItem.name) >= (cond.hasItem.count ?? 1));
  if (cond.hasItems?.length) clauses.push(cond.hasItems.every((h) => count(s, h.name) >= (h.count ?? 1)));
  if (cond.lacksItem) clauses.push(count(s, cond.lacksItem) === 0);
  if (cond.lacksItems?.length) clauses.push(cond.lacksItems.every((n) => count(s, n) === 0));
  if (cond.bankOpen !== undefined) clauses.push(s.bank.open === cond.bankOpen);
  if (cond.shopOpen !== undefined) clauses.push(s.shop.open === cond.shopOpen);
  if (cond.hpAtLeast !== undefined) {
    const hp = s.player?.hp;
    clauses.push(!!hp && hp.max > 0 && hp.current / hp.max >= cond.hpAtLeast);
  }
  if (cond.equipped?.length) {
    const worn = s.equipment.map((e) => e.name.toLowerCase());
    clauses.push(cond.equipped.every((n) => worn.some((w) => w.includes(n.toLowerCase()))));
  }
  if (cond.dialogueOpen !== undefined) clauses.push(s.dialogue.inDialogue === cond.dialogueOpen);
  if (cond.inCombat !== undefined) clauses.push(!!s.player?.inCombat === cond.inCombat);
  if (cond.objectNear) {
    const n = cond.objectNear.name.toLowerCase();
    const r = cond.objectNear.radius ?? 3;
    clauses.push(s.objects.some((o) => o.distance <= r && o.name.toLowerCase() === n));
  }
  if (cond.lootNear) {
    const { names, minValue } = cond.lootNear;
    const r = cond.lootNear.radius ?? 6;
    clauses.push(
      s.groundItems.some(
        (g) => g.lootable && g.reachable && g.distance <= r &&
          (/^coins$/i.test(g.name) || g.geValue >= minValue || names.some((n) => g.name.toLowerCase().includes(n.toLowerCase()))),
      ),
    );
  }
  if (cond.groundItemNear) {
    const n = cond.groundItemNear.name.toLowerCase();
    const r = cond.groundItemNear.radius ?? 6;
    clauses.push(s.groundItems.some((g) => g.lootable && g.reachable && g.distance <= r && g.name.toLowerCase().includes(n)));
  }
  if (cond.near) {
    const pos = s.player?.position;
    clauses.push(!!pos && tileDistance(pos, cond.near) <= (cond.near.radius ?? 3));
  }
  if (cond.skillLevel) {
    const sk = s.skills.find((k) => k.name.toLowerCase() === cond.skillLevel!.skill.toLowerCase());
    clauses.push(!!sk && sk.level >= cond.skillLevel.level);
  }
  return clauses.length > 0 && clauses.every(Boolean);
}

export function compile(cond: DoneCondition | undefined): ((s: Snapshot) => boolean) | undefined {
  if (!cond || Object.keys(cond).length === 0) return undefined;
  return (s) => evaluate(cond, s);
}

export function describe(cond: DoneCondition | undefined): string {
  if (!cond) return 'model decides';
  const parts: string[] = [];
  if (cond.inventoryFull !== undefined) parts.push(cond.inventoryFull ? 'inventory full' : 'inventory not full');
  if (cond.hasItem) parts.push(`has ${cond.hasItem.count ?? 1}+ ${cond.hasItem.name}`);
  if (cond.hasItems?.length) parts.push(cond.hasItems.map((h) => `has ${h.count ?? 1}+ ${h.name}`).join(' and '));
  if (cond.lacksItem) parts.push(`no ${cond.lacksItem}`);
  if (cond.lacksItems?.length) parts.push(`no ${cond.lacksItems.join('/')}`);
  if (cond.bankOpen !== undefined) parts.push(cond.bankOpen ? 'bank open' : 'bank closed');
  if (cond.shopOpen !== undefined) parts.push(cond.shopOpen ? 'shop open' : 'shop closed');
  if (cond.hpAtLeast !== undefined) parts.push(`HP >= ${Math.round(cond.hpAtLeast * 100)}%`);
  if (cond.equipped?.length) parts.push(`wearing ${cond.equipped.join(', ')}`);
  if (cond.dialogueOpen !== undefined) parts.push(cond.dialogueOpen ? 'dialogue open' : 'dialogue closed');
  if (cond.inCombat !== undefined) parts.push(cond.inCombat ? 'in combat' : 'out of combat');
  if (cond.near) parts.push(`within ${cond.near.radius ?? 3} of (${cond.near.x}, ${cond.near.y}, ${cond.near.plane})`);
  if (cond.skillLevel) parts.push(`${cond.skillLevel.skill} >= ${cond.skillLevel.level}`);
  if (cond.groundItemNear) parts.push(`${cond.groundItemNear.name} on the ground nearby`);
  if (cond.lootNear) parts.push(`loot (${[...cond.lootNear.names, 'coins'].join('/')} or >=${cond.lootNear.minValue} gp) on the ground nearby`);
  if (cond.objectNear) parts.push(`${cond.objectNear.name} within ${cond.objectNear.radius ?? 3} tiles`);
  return parts.join(' and ') || 'model decides';
}
