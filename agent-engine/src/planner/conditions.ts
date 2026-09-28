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
  /** Inventory holds none of this item. */
  lacksItem?: string;
  bankOpen?: boolean;
  /** Player is within `radius` tiles of a point. */
  near?: { x: number; y: number; plane: number; radius?: number };
  skillLevel?: { skill: string; level: number };
  dialogueOpen?: boolean;
}

const count = (s: Snapshot, name: string) => {
  const n = name.toLowerCase();
  return s.inventory.items.filter((i) => i.name.toLowerCase().includes(n)).reduce((sum, i) => sum + i.quantity, 0);
};

/** All specified clauses must hold. An empty condition never completes (the model decides). */
export function evaluate(cond: DoneCondition, s: Snapshot): boolean {
  const clauses: boolean[] = [];
  if (cond.inventoryFull !== undefined) clauses.push((s.inventory.freeSlots === 0) === cond.inventoryFull);
  if (cond.hasItem) clauses.push(count(s, cond.hasItem.name) >= (cond.hasItem.count ?? 1));
  if (cond.lacksItem) clauses.push(count(s, cond.lacksItem) === 0);
  if (cond.bankOpen !== undefined) clauses.push(s.bank.open === cond.bankOpen);
  if (cond.dialogueOpen !== undefined) clauses.push(s.dialogue.inDialogue === cond.dialogueOpen);
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
  if (cond.lacksItem) parts.push(`no ${cond.lacksItem}`);
  if (cond.bankOpen !== undefined) parts.push(cond.bankOpen ? 'bank open' : 'bank closed');
  if (cond.dialogueOpen !== undefined) parts.push(cond.dialogueOpen ? 'dialogue open' : 'dialogue closed');
  if (cond.near) parts.push(`within ${cond.near.radius ?? 3} of (${cond.near.x}, ${cond.near.y}, ${cond.near.plane})`);
  if (cond.skillLevel) parts.push(`${cond.skillLevel.skill} >= ${cond.skillLevel.level}`);
  return parts.join(' and ') || 'model decides';
}
