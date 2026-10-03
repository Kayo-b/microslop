/**
 * Goal plan files (`plans/*.json`): the build an account should reach, e.g. "90 Attack, Strength,
 * Defence, Ranged and Magic, 70 Slayer". The compiler turns a plan plus the live account into an
 * ordered roadmap; the strategy layer runs it one milestone at a time.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const SKILLS = [
  'Attack', 'Strength', 'Defence', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing',
  'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Slayer', 'Farming', 'Runecraft', 'Hunter', 'Construction',
] as const;

export const PlanSpecSchema = z.object({
  name: z.string().min(1),
  /** Directory under data/accounts/ for this account's bank memory, skips, ledger and LLM logs. Default: name. */
  account: z.string().regex(/^[\w.-]+$/).optional(),
  targets: z.partialRecord(z.enum(SKILLS), z.number().int().min(2).max(99)),
  /** Quests to finish besides the ones the targets need. */
  quests: z.array(z.string()).default([]),
  /** Items to own at the end (bought when the catalog knows how). */
  items: z.array(z.string()).default([]),
  policy: z
    .object({
      /** Do quests whose XP rewards skip early training brackets. Default true. */
      boosterQuests: z.boolean().default(true),
      /** Train at most this many levels per phase before re-evaluating, so combat stats stay balanced. Default 10. */
      levelsPerPhase: z.number().int().min(1).max(98).default(10),
      llm: z
        .object({
          /** Cheap-model calls allowed per hour (quest steps, LLM phases, first rescues). Default 20. */
          tier1PerHour: z.number().int().min(0).default(20),
          /** Strong-model calls allowed per hour (repeated or loop rescues). Default 4. */
          tier2PerHour: z.number().int().min(0).default(4),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type PlanSpec = z.infer<typeof PlanSpecSchema>;

export function parsePlan(raw: unknown): PlanSpec {
  return PlanSpecSchema.parse(raw);
}

export function loadPlan(file: string): PlanSpec {
  return parsePlan(JSON.parse(readFileSync(file, 'utf8')));
}

/** data/accounts/<account> for a plan. */
export function accountDir(spec: PlanSpec, root = 'data'): string {
  return path.join(root, 'accounts', spec.account ?? spec.name.replace(/[^\w.-]+/g, '-'));
}
