/**
 * What the strategy layer knows about the account: membership, quests, levels and owned items.
 * Membership and quest progress come from the client (varps and Quest Helper); owned items from
 * the inventory, equipment and the last bank contents seen (persisted, since the bank is only
 * readable while open).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Snapshot } from '../types.ts';
import type { Requirement } from './catalog.ts';

/** VarPlayer ids (RuneLite VarPlayerID). */
export const VARP_MEMBERSHIP_DAYS = 1780;
export const VARP_QUEST_POINTS = 101;
/** Tutorial Island progress (VarPlayerID.TUTORIAL); 1000 once the player reaches the mainland. */
export const VARP_TUTORIAL = 281;
export const TUTORIAL_DONE = 1000;

export interface AccountApi {
  varp(id: number): Promise<number>;
  questStates(): Promise<{ displayName: string; state: string }[]>;
}

export interface Account {
  members: boolean;
  questPoints: number;
  /** Quest display name -> NOT_STARTED | IN_PROGRESS | FINISHED. */
  quests: Map<string, string>;
  /** Tutorial Island progress (varp 281); absent means finished. */
  tutorial?: number;
}

export async function readAccount(api: AccountApi): Promise<Account> {
  const [days, qp, states, tutorial] = await Promise.all([api.varp(VARP_MEMBERSHIP_DAYS), api.varp(VARP_QUEST_POINTS), api.questStates(), api.varp(VARP_TUTORIAL)]);
  return { members: days > 0, questPoints: qp, quests: new Map(states.map((q) => [q.displayName, q.state])), tutorial };
}

/** Last bank contents seen, kept across runs. */
export class BankMemory {
  private readonly file: string;
  items: Map<string, number>;
  seenAt: string | null;

  constructor(file = path.join('data', 'bank-seen.json')) {
    this.file = file;
    this.items = new Map();
    this.seenAt = null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { seenAt: string; items: [string, number][] };
      this.items = new Map(raw.items);
      this.seenAt = raw.seenAt;
    } catch {
      // Never seen yet.
    }
  }

  update(s: Snapshot): void {
    if (!s.bank.open || s.bank.items.length === 0) return;
    this.items = new Map(s.bank.items.map((i) => [i.name, i.quantity]));
    this.seenAt = new Date().toISOString();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify({ seenAt: this.seenAt, items: [...this.items] }));
    } catch {
      // Memory only.
    }
  }
}

export interface Profile {
  account: Account;
  levels: Map<string, number>;
  combatLevel: number;
  /** Names of items carried, worn or last seen banked. */
  owned: Set<string>;
  /** Coins carried plus coins last seen banked. */
  coins: number;
  bankKnown: boolean;
}

export function buildProfile(account: Account, s: Snapshot, bank: BankMemory): Profile {
  const owned = new Set<string>([...s.inventory.items.map((i) => i.name), ...s.equipment.map((e) => e.name), ...bank.items.keys()]);
  return {
    account,
    levels: new Map(s.skills.map((k) => [k.name, k.level])),
    combatLevel: s.player?.combatLevel ?? 3,
    owned,
    coins: s.inventory.items.filter((i) => i.name === 'Coins').reduce((n, i) => n + i.quantity, 0) + (bank.items.get('Coins') ?? 0),
    bankKnown: bank.seenAt !== null,
  };
}

/** Level used for melee method brackets: the average of Attack, Strength and Defence. */
export function meleeLevel(p: Profile): number {
  const l = (n: string) => p.levels.get(n) ?? 1;
  return Math.floor((l('Attack') + l('Strength') + l('Defence')) / 3);
}

export function level(p: Profile, skill: string): number {
  return skill === 'Melee' ? meleeLevel(p) : (p.levels.get(skill) ?? 1);
}

/** Unmet parts of a requirement, as readable strings (empty when met). */
export function unmet(req: Requirement | undefined, p: Profile): string[] {
  if (!req) return [];
  const out: string[] = [];
  for (const [skill, lvl] of Object.entries(req.skills ?? {})) if ((p.levels.get(skill) ?? 1) < lvl) out.push(`${skill} ${lvl}`);
  for (const q of req.quests ?? []) if (p.account.quests.get(q) !== 'FINISHED') out.push(`quest ${q}`);
  if (req.qp && p.account.questPoints < req.qp) out.push(`${req.qp} quest points`);
  if (req.combat && p.combatLevel < req.combat) out.push(`combat ${req.combat}`);
  for (const item of req.items ?? []) {
    if (![...p.owned].some((o) => o.toLowerCase() === item.toLowerCase())) out.push(`item ${item}`);
  }
  return out;
}
