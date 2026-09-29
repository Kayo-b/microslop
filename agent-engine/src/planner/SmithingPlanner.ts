/**
 * Long-horizon plan: gear up through Smithing around Lumbridge.
 *
 *   mine ore -> bank -> withdraw a batch + hammer -> smelt at the Lumbridge furnace -> smith at
 *   the rusted anvil beside it -> equip upgrades -> repeat
 *
 * Bronze (copper + tin, Lumbridge Swamp mine) until Smithing 15, then iron (Al Kharid mine,
 * reached from the north without the toll gate). Each call looks at the snapshot and returns one
 * concrete sub-goal; the per-tick engine and its classifier do the clicking. Bank contents are only
 * visible while the bank is open, so the planner remembers what it last saw there.
 */
import type { Snapshot, WorldPoint } from '../types.ts';
import { compile, type DoneCondition } from './conditions.ts';
import type { PlannedSubGoal, Planner, PlannerContext, PlanStep } from './types.ts';

interface GearTier {
  item: string;
  level: number;
  bars: number;
  /** Equipment slot name, to tell whether something at least as good is already worn. */
  slot: string;
}

export interface Metal {
  name: 'Bronze' | 'Iron';
  bar: string;
  /** Ores consumed per bar. */
  ores: string[];
  /** Ore sets per trip: bronze 13 copper + 13 tin, iron 26 ore (+ hammer + pickaxe = 28). */
  batch: number;
  /** Ore mined when the bank runs short (tin is plentiful for bronze). */
  mineOre: string;
  mineRocks: string;
  mine: { name: string; point: WorldPoint };
  /** One-bar item smithed for XP when no upgrade is due. */
  filler: string;
  /** Where to smith: the rusted anvil by the Lumbridge furnace accepts bronze only. */
  anvil: { name: string; point: WorldPoint; targets: string[]; avoid?: string[] };
  gear: GearTier[];
}

export const BRONZE: Metal = {
  name: 'Bronze',
  bar: 'Bronze bar',
  ores: ['Copper ore', 'Tin ore'],
  batch: 13,
  mineOre: 'Copper ore',
  mineRocks: 'Copper rocks',
  mine: { name: 'Lumbridge Swamp mine', point: { x: 3229, y: 3146, plane: 0 } },
  filler: 'Bronze dagger',
  anvil: { name: 'Lumbridge furnace rusted anvil', point: { x: 3226, y: 3255, plane: 0 }, targets: ['Rusted anvil', 'Anvil'] },
  gear: [
    { item: 'Bronze scimitar', level: 5, bars: 2, slot: 'WEAPON' },
    { item: 'Bronze full helm', level: 7, bars: 2, slot: 'HEAD' },
    { item: 'Bronze chainbody', level: 11, bars: 3, slot: 'BODY' },
    { item: 'Bronze kiteshield', level: 12, bars: 3, slot: 'SHIELD' },
    { item: 'Bronze platelegs', level: 16, bars: 3, slot: 'LEGS' },
    { item: 'Bronze platebody', level: 18, bars: 5, slot: 'BODY' },
  ],
};

export const IRON: Metal = {
  name: 'Iron',
  bar: 'Iron bar',
  ores: ['Iron ore'],
  batch: 26,
  mineOre: 'Iron ore',
  mineRocks: 'Iron rocks',
  mine: { name: 'Al Kharid mine', point: { x: 3296, y: 3311, plane: 0 } },
  filler: 'Iron dagger',
  anvil: { name: 'Varrock west anvils', point: { x: 3189, y: 3423, plane: 0 }, targets: ['Anvil'], avoid: ['Rusted anvil'] },
  gear: [
    { item: 'Iron scimitar', level: 20, bars: 2, slot: 'WEAPON' },
    { item: 'Iron full helm', level: 22, bars: 2, slot: 'HEAD' },
    { item: 'Iron chainbody', level: 26, bars: 3, slot: 'BODY' },
    { item: 'Iron kiteshield', level: 27, bars: 3, slot: 'SHIELD' },
    { item: 'Iron platelegs', level: 31, bars: 3, slot: 'LEGS' },
    { item: 'Iron platebody', level: 33, bars: 5, slot: 'BODY' },
  ],
};

/** Iron smelting needs Smithing 15. */
const IRON_LEVEL = 15;

/** Best-first ordering per slot, for "is this an upgrade?". Unlisted items never count as upgrades. */
const RANK: Record<string, string[]> = {
  WEAPON: ['Iron scimitar', 'Bronze scimitar'],
  HEAD: ['Iron full helm', 'Bronze full helm', 'Iron med helm', 'Bronze med helm'],
  BODY: ['Iron platebody', 'Bronze platebody', 'Iron chainbody', 'Bronze chainbody'],
  SHIELD: ['Iron kiteshield', 'Bronze kiteshield', 'Iron sq shield', 'Bronze sq shield'],
  LEGS: ['Iron platelegs', 'Bronze platelegs'],
};

export const PLACES = {
  bank: { x: 3209, y: 3220, plane: 2 } as WorldPoint, // Lumbridge castle top floor
  furnace: { x: 3226, y: 3255, plane: 0 } as WorldPoint, // Lumbridge furnace; rusted anvil beside it
};

const lc = (s: string) => s.toLowerCase();

function held(s: Snapshot, name: string): number {
  const n = lc(name);
  return s.inventory.items.filter((i) => lc(i.name).includes(n)).reduce((sum, i) => sum + i.quantity, 0);
}

function level(s: Snapshot, skill: string): number {
  return s.skills.find((k) => k.name === skill)?.level ?? 1;
}

/** True when `item` beats whatever is worn in `slot` (anything ranked beats an empty or unranked slot). */
export function isUpgrade(s: Snapshot, item: string, slot: string): boolean {
  const order = RANK[slot] ?? [];
  const a = order.indexOf(item);
  if (a < 0) return false;
  const current = s.equipment.find((e) => e.slot === slot)?.name;
  if (!current) return true;
  const b = order.indexOf(current);
  return b < 0 || a < b;
}

function sg(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, extra: Partial<PlannedSubGoal> = {}): PlanStep {
  return {
    kind: 'subgoal',
    subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps: 150, keep: ['Hammer', 'pickaxe'], ...extra },
  };
}

export interface SmithingPlannerOptions {
  /** Stop when Smithing reaches this level (and unlocked upgrades are worn). Default 33 (iron platebody). */
  untilLevel?: number;
  /** Force a metal instead of choosing by level. */
  metal?: 'bronze' | 'iron';
}

export class SmithingPlanner implements Planner {
  readonly name = 'smith-progression';
  private readonly untilLevel: number;
  private readonly forced?: Metal;
  /** Last seen bank counts (item name -> quantity); null until the bank has been opened once. */
  private bank: Map<string, number> | null = null;

  constructor(opts: SmithingPlannerOptions = {}) {
    this.untilLevel = opts.untilLevel ?? 33;
    this.forced = opts.metal === 'bronze' ? BRONZE : opts.metal === 'iron' ? IRON : undefined;
  }

  private metal(smithing: number): Metal {
    return this.forced ?? (smithing >= IRON_LEVEL ? IRON : BRONZE);
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.bank = new Map(s.bank.items.map((i) => [i.name, i.quantity]));

    const last = ctx.reports.slice(-3);
    if (last.length === 3 && last.every((r) => r.result !== 'done' && r.subgoal === last[0]!.subgoal)) {
      return { kind: 'impossible', reason: `failed 3 times on "${last[0]!.subgoal}": ${last[2]!.reason}` };
    }

    const smithing = level(s, 'Smithing');
    const metal = this.metal(smithing);
    const allGear = [...BRONZE.gear, ...IRON.gear];

    // Done at the target level only once every unlocked upgrade is made and worn.
    const pendingUpgrade = metal.gear.some(
      (g) => g.level <= smithing && isUpgrade(s, g.item, g.slot) && (held(s, g.item) > 0 || held(s, metal.bar) >= g.bars),
    );
    if (smithing >= this.untilLevel && !pendingUpgrade) {
      return { kind: 'complete', reason: `Smithing ${smithing} reached and all unlocked upgrades worn` };
    }

    // 1. Wear any upgrade we are carrying.
    const wearable = s.inventory.items.find((i) => {
      const tier = allGear.find((g) => g.item === i.name);
      return tier && isUpgrade(s, tier.item, tier.slot);
    });
    if (wearable && !s.bank.open) {
      const verb = allGear.find((g) => g.item === wearable.name)?.slot === 'WEAPON' ? 'Wield' : 'Wear';
      return sg(`${lc(verb)} the ${wearable.name}`, [wearable.name], [verb], { equipped: [wearable.name] }, { maxSteps: 6 });
    }

    // 2. Bank screen: the planner decides what goes in and out.
    if (s.bank.open) return this.atBank(s, metal);

    const bars = held(s, metal.bar);
    const hasHammer = held(s, 'Hammer') > 0;

    // 3. Smith while carrying bars and a hammer.
    if (bars > 0 && hasHammer) {
      const target = metal.gear.find((g) => g.level <= smithing && g.bars <= bars && isUpgrade(s, g.item, g.slot) && held(s, g.item) === 0);
      const item = target?.item ?? metal.filler;
      const count = held(s, item) + 1;
      return sg(`smith a ${item} at the ${metal.anvil.name}`, [...metal.anvil.targets, item], ['Smith'], { hasItem: { name: item, count } }, {
        destination: { name: metal.anvil.name, point: metal.anvil.point },
        want: [{ name: item, count }],
        avoid: metal.anvil.avoid,
        maxSteps: 200,
      });
    }

    // 4. Smelt ores into bars.
    if (metal.ores.every((o) => held(s, o) > 0)) {
      const scarcest = [...metal.ores].sort((a, b) => held(s, a) - held(s, b))[0]!;
      return sg(`smelt the ${metal.ores.join(' and ').toLowerCase()} into ${lc(metal.bar)}s at the furnace`, ['Furnace', metal.bar], ['Smelt', 'Make'], { lacksItem: scarcest }, {
        destination: { name: 'Lumbridge furnace', point: PLACES.furnace },
        maxSteps: 250,
      });
    }

    // 5. Out of materials. Mine when the bank (as last seen) cannot supply a batch.
    const bankOre = this.bank?.get(metal.mineOre) ?? 0;
    const needMining = this.bank !== null && bankOre < metal.batch && held(s, metal.mineOre) < metal.batch;
    const hasPickaxe = held(s, 'pickaxe') + s.equipment.filter((e) => lc(e.name).includes('pickaxe')).length > 0;
    // Bank the smithed junk first: a trip with a half-full inventory wastes the walk.
    const roomy = s.inventory.freeSlots >= 20 || held(s, metal.mineOre) > 0;
    if (needMining && roomy && s.inventory.freeSlots > 0 && hasPickaxe) {
      return sg(`mine ${lc(metal.mineOre)} at the ${metal.mine.name} until the inventory is full`, [metal.mineRocks], ['Mine'], { inventoryFull: true }, {
        destination: metal.mine,
        maxSteps: 600,
      });
    }

    // 6. Go and use the nearest bank (any bank works; the knowledge base knows where they are).
    const pos = s.player?.position;
    const nearest = pos && ctx.kb ? ctx.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
    const bank = nearest ? { name: nearest.name, point: nearest.point } : { name: 'Lumbridge Top bank', point: PLACES.bank };
    return sg(`go to the ${bank.name} and open the bank`, ['Bank booth', 'Banker', 'Bank chest'], ['Bank', 'Use'], { bankOpen: true }, {
      destination: bank,
      maxSteps: 200,
    });
  }

  private atBank(s: Snapshot, metal: Metal): PlanStep {
    const keepRe = new RegExp(`hammer|pickaxe|coins|${[...metal.ores, metal.bar].map((n) => lc(n)).join('|')}`, 'i');
    const junk = s.inventory.items
      .map((i) => i.name)
      .filter((n, idx, all) => all.indexOf(n) === idx)
      .filter((n) => !keepRe.test(n));
    if (junk.length > 0) {
      return sg(`deposit the ${junk.join(', ')}`, junk, ['Deposit'], { lacksItems: junk }, { maxSteps: 20 });
    }
    // Deposit mined ore beyond one batch (after a mining trip the inventory is full of it).
    if (metal.ores.length > 1 && held(s, metal.mineOre) > metal.batch) {
      return sg(`deposit all the ${lc(metal.mineOre)}`, [metal.mineOre], ['Deposit'], { lacksItem: metal.mineOre }, { maxSteps: 6 });
    }
    const want: { name: string; count: number }[] = [];
    if (held(s, 'Hammer') === 0 && s.bank.items.some((i) => i.name === 'Hammer')) want.push({ name: 'Hammer', count: 1 });
    const wornPickaxe = s.equipment.some((e) => lc(e.name).includes('pickaxe'));
    const bankPickaxe = s.bank.items.find((i) => lc(i.name).includes('pickaxe'));
    if (!wornPickaxe && held(s, 'pickaxe') === 0 && bankPickaxe) want.push({ name: bankPickaxe.name, count: 1 });
    // A batch is limited by the scarcest ore (bank + inventory).
    const available = metal.ores.map((o) => (s.bank.items.find((i) => i.name === o)?.quantity ?? 0) + held(s, o));
    const batch = Math.min(metal.batch, ...available);
    if (batch > 0 && metal.ores.some((o) => held(s, o) < batch)) {
      for (const o of metal.ores) want.push({ name: o, count: batch });
    }
    if (want.length > 0) {
      return sg(
        `withdraw ${want.map((w) => `${w.count} ${w.name}`).join(', ')}`,
        want.map((w) => w.name),
        ['Withdraw'],
        { hasItems: want.map((w) => ({ name: w.name, count: w.count })) },
        { want, maxSteps: 30 },
      );
    }
    return sg('close the bank', ['Bank'], ['Close'], { bankOpen: false }, { maxSteps: 5 });
  }
}
