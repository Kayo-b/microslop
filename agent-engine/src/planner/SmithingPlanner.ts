/**
 * Long-horizon plan: gear up through Smithing around Lumbridge.
 *
 *   mine ore -> bank -> withdraw a batch + hammer -> smelt at the Lumbridge furnace -> smith at
 *   the rusted anvil beside it -> equip upgrades -> repeat
 *
 * Bronze (copper + tin, Lumbridge Swamp mine) until Smithing 15, iron (Al Kharid mine, reached
 * from the north without the toll gate) until 35, then steel (iron ore + 2 coal per bar, both
 * mined at Al Kharid) up to the steel platebody at 48. Each call looks at the snapshot and returns one
 * concrete sub-goal; the per-tick engine and its classifier do the clicking. Bank contents are only
 * visible while the bank is open, so the planner remembers what it last saw there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Snapshot, WorldPoint } from '../types.ts';
import { compile, type DoneCondition } from './conditions.ts';
import { classifyGear, type GearSlot } from './gear.ts';
import { candidateSites, cheapestLoop, CostTable, type Site } from './routes.ts';
import type { PlannedSubGoal, Planner, PlannerContext, PlanStep } from './types.ts';

interface GearTier {
  item: string;
  level: number;
  bars: number;
  /** Equipment slot name, to tell whether something at least as good is already worn. */
  slot: string;
}

export interface Metal {
  name: 'Bronze' | 'Iron' | 'Steel' | 'Mithril' | 'Adamant';
  bar: string;
  /** Ores consumed per bar. */
  ores: string[];
  /** How many of each ore (same order as `ores`) one bar takes; default 1 each. */
  perBar?: number[];
  /** Bars per trip: bronze 13 copper + 13 tin, iron 26 ore, steel 8 iron + 16 coal (+ hammer + pickaxe). */
  batch: number;
  /** Ore mined when the bank runs short (tin is plentiful for bronze). */
  mineOre: string;
  mineRocks: string;
  /** Other ores mined when they run short first (steel's coal), with their rocks. */
  alsoMine?: { ore: string; rocks: string }[];
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

export const STEEL: Metal = {
  name: 'Steel',
  bar: 'Steel bar',
  ores: ['Iron ore', 'Coal'],
  perBar: [1, 2],
  batch: 8,
  mineOre: 'Iron ore',
  mineRocks: 'Iron rocks',
  alsoMine: [{ ore: 'Coal', rocks: 'Coal rocks' }],
  // Iron and coal side by side (9 iron, 3 coal rocks).
  mine: { name: 'Al Kharid mine', point: { x: 3301, y: 3303, plane: 0 } },
  filler: 'Steel dagger',
  anvil: { name: 'Varrock west anvils', point: { x: 3189, y: 3423, plane: 0 }, targets: ['Anvil'], avoid: ['Rusted anvil'] },
  gear: [
    { item: 'Steel scimitar', level: 35, bars: 2, slot: 'WEAPON' },
    { item: 'Steel full helm', level: 37, bars: 2, slot: 'HEAD' },
    { item: 'Steel chainbody', level: 41, bars: 3, slot: 'BODY' },
    { item: 'Steel kiteshield', level: 42, bars: 3, slot: 'SHIELD' },
    { item: 'Steel platelegs', level: 46, bars: 3, slot: 'LEGS' },
    { item: 'Steel platebody', level: 48, bars: 5, slot: 'BODY' },
  ],
};

/** Mithril: 1 ore + 4 coal a bar, from the Dwarven Mine (Falador); Smithing 50, Mining 55. */
export const MITHRIL: Metal = {
  name: 'Mithril',
  bar: 'Mithril bar',
  ores: ['Mithril ore', 'Coal'],
  perBar: [1, 4],
  batch: 5,
  mineOre: 'Mithril ore',
  mineRocks: 'Mithril rocks',
  alsoMine: [{ ore: 'Coal', rocks: 'Coal rocks' }],
  mine: { name: 'Dwarven Mine mithril and coal', point: { x: 3033, y: 9719, plane: 0 } },
  filler: 'Mithril dagger',
  anvil: { name: 'Varrock west anvils', point: { x: 3189, y: 3423, plane: 0 }, targets: ['Anvil'], avoid: ['Rusted anvil'] },
  gear: [
    { item: 'Mithril scimitar', level: 55, bars: 2, slot: 'WEAPON' },
    { item: 'Mithril full helm', level: 57, bars: 2, slot: 'HEAD' },
    { item: 'Mithril chainbody', level: 61, bars: 3, slot: 'BODY' },
    { item: 'Mithril kiteshield', level: 62, bars: 3, slot: 'SHIELD' },
    { item: 'Mithril platelegs', level: 66, bars: 3, slot: 'LEGS' },
    { item: 'Mithril platebody', level: 68, bars: 5, slot: 'BODY' },
  ],
};

/** Adamant: 1 ore + 6 coal a bar; Smithing 70, Mining 70. */
export const ADAMANT: Metal = {
  name: 'Adamant',
  bar: 'Adamantite bar',
  ores: ['Adamantite ore', 'Coal'],
  perBar: [1, 6],
  batch: 3,
  mineOre: 'Adamantite ore',
  mineRocks: 'Adamantite rocks',
  alsoMine: [{ ore: 'Coal', rocks: 'Coal rocks' }],
  mine: { name: 'Dwarven Mine adamantite and coal', point: { x: 3037, y: 9716, plane: 0 } },
  filler: 'Adamant dagger',
  anvil: { name: 'Varrock west anvils', point: { x: 3189, y: 3423, plane: 0 }, targets: ['Anvil'], avoid: ['Rusted anvil'] },
  gear: [
    { item: 'Adamant scimitar', level: 75, bars: 2, slot: 'WEAPON' },
    { item: 'Adamant full helm', level: 77, bars: 2, slot: 'HEAD' },
    { item: 'Adamant chainbody', level: 81, bars: 3, slot: 'BODY' },
    { item: 'Adamant kiteshield', level: 82, bars: 3, slot: 'SHIELD' },
    { item: 'Adamant platelegs', level: 86, bars: 3, slot: 'LEGS' },
    { item: 'Adamant platebody', level: 88, bars: 5, slot: 'BODY' },
  ],
};

/** Iron smelting needs Smithing 15; steel bars 30, but steel gear only starts at 35 (scimitar). */
const IRON_LEVEL = 15;
const STEEL_LEVEL = 35;
/** Mithril/adamant bars need both Smithing and Mining (the ore is mined by the planner). */
const MITHRIL_SMITHING = 50;
const MITHRIL_MINING = 55;
const ADAMANT_SMITHING = 70;
const ADAMANT_MINING = 70;
/** Smithing level of the last gear piece this planner makes (steel platebody). */
export const LAST_GEAR_LEVEL = 48;

const SLOT: Record<string, GearSlot> = { WEAPON: 'weapon', HEAD: 'head', BODY: 'body', SHIELD: 'shield', LEGS: 'legs' };

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

/**
 * True when `item` beats whatever is worn in `slot`, by the shared gear ranking (metal tier, then
 * type), so better gear worn (mithril, rune) is never swapped for a smithed piece.
 */
export function isUpgrade(s: Snapshot, item: string, slot: string): boolean {
  const g = classifyGear(item);
  if (!g || g.slot !== SLOT[slot]) return false;
  const current = s.equipment.find((e) => e.slot === slot)?.name;
  return !current || g.score > (classifyGear(current)?.score ?? 0);
}

const perBar = (metal: Metal, i: number) => metal.perBar?.[i] ?? 1;

/** The ore to mine next: the one whose stock (bank + carried) makes the fewest bars. */
function oreToMine(metal: Metal, stock: (ore: string) => number): { ore: string; rocks: string } {
  const all = [{ ore: metal.mineOre, rocks: metal.mineRocks }, ...(metal.alsoMine ?? [])];
  const bars = (ore: string) => stock(ore) / perBar(metal, metal.ores.indexOf(ore));
  return all.sort((a, b) => bars(a.ore) - bars(b.ore))[0]!;
}

function sg(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, extra: Partial<PlannedSubGoal> = {}): PlanStep {
  return {
    kind: 'subgoal',
    subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps: 150, keep: ['Hammer', 'pickaxe'], ...extra },
  };
}

export interface SmithingPlannerOptions {
  /** Stop when Smithing reaches this level (and unlocked upgrades are worn). Default 48 (steel platebody). */
  untilLevel?: number;
  /** Force a metal instead of choosing by level. */
  metal?: 'bronze' | 'iron' | 'steel' | 'mithril' | 'adamant';
  /** Only mine and smelt; bank the bars and never smith or stop at a level (smelting for profit). */
  smeltOnly?: boolean;
  /** File that remembers unreachable placements across runs. Null disables. Default data/unusable-sites.json. */
  memoryFile?: string | null;
}

export class SmithingPlanner implements Planner {
  readonly name = 'smith-progression';
  private readonly untilLevel: number;
  private readonly forced?: Metal;
  private readonly smeltOnly: boolean;
  /** Last seen bank counts (item name -> quantity); null until the bank has been opened once. */
  private bank: Map<string, number> | null = null;
  /** Cheapest mine -> furnace -> anvil -> bank cycle per metal, chosen once from real path costs. */
  private routes = new Map<string, { mine: Site; furnace: Site; anvil: Site; bank: Site; cost: number }>();
  private costs: CostTable | null = null;
  /** Sites proven unusable ("I can't reach that!"), as "x,y,plane"; excluded when re-planning. */
  private readonly unusable = new Set<string>();

  /**
   * A blocked sub-goal that could not reach its target retires the placements of that object type
   * next to the player (the engine uses whichever matching object is in view, which is not
   * necessarily the planned site) and forces a re-plan.
   */
  private learnFromReports(ctx: PlannerContext, metal: Metal): void {
    const last = ctx.reports.at(-1);
    const pos = ctx.snapshot.player?.position;
    if (!last || !pos || !ctx.kb || last.result === 'done' || !/can't reach|cannot reach/i.test(last.reason)) return;
    const object = /smith/i.test(last.subgoal) ? 'Anvil' : /smelt/i.test(last.subgoal) ? 'Furnace' : /mine/i.test(last.subgoal) ? (metal.alsoMine?.find((m) => last.subgoal.includes(lc(m.ore)))?.rocks ?? metal.mineRocks) : null;
    if (!object) return;
    const culprits = ctx.kb.nearestObjects(object, pos, { radius: 5, limit: 10 });
    if (culprits.length === 0) return;
    for (const c of culprits) this.unusable.add(`${c.point.x},${c.point.y},${c.point.plane}`);
    this.remember();
    this.routes.delete(metal.name);
    console.log(`[smith-progression] ${object} near ${pos.x},${pos.y} is unreachable (${culprits.length} placements retired); re-planning the loop`);
  }

  private retiredPoints(): WorldPoint[] {
    return [...this.unusable].map((k) => {
      const [x, y, plane] = k.split(',').map(Number);
      return { x: x!, y: y!, plane: plane! };
    });
  }

  /** True when a site lies within 12 tiles of a retired placement. */
  private isRetired(site: Site): boolean {
    for (const key of this.unusable) {
      const [x, y, plane] = key.split(',').map(Number);
      if (plane === site.point.plane && Math.max(Math.abs(x! - site.point.x), Math.abs(y! - site.point.y)) <= 12) return true;
    }
    return false;
  }

  /**
   * Picks the metal's sites as the cheapest walking cycle. Bronze keeps the Lumbridge sites (its
   * rusted anvil sits beside the furnace, which no loop beats).
   */
  private async route(metal: Metal, ctx: PlannerContext) {
    const cached = this.routes.get(metal.name);
    if (cached) return cached;
    const pos = ctx.snapshot.player?.position;
    if (metal.name === 'Bronze' || !ctx.kb || !pos) return null;
    this.costs ??= new CostTable(ctx.pathCost);
    const usable = (sites: Site[]) => sites.filter((x) => !this.isRetired(x));
    const stages = [
      usable(candidateSites(ctx.kb, pos, { object: metal.mineRocks, action: 'Mine', min: 3 }, 6)),
      usable(candidateSites(ctx.kb, pos, { object: 'Furnace', action: 'Smelt' }, 4)),
      usable(candidateSites(ctx.kb, pos, { object: 'Anvil', action: 'Smith' }, 4)),
      usable(candidateSites(ctx.kb, pos, { bank: true }, 4)),
    ].map((x) => x.slice(0, 3));
    const best = await cheapestLoop(stages, this.costs);
    if (!best) return null;
    const [mine, furnace, anvil, bank] = best.sites as [Site, Site, Site, Site];
    const chosen = { mine, furnace, anvil, bank, cost: best.cost };
    this.routes.set(metal.name, chosen);
    const at = (x: Site) => `${x.name} @${x.point.x},${x.point.y}`;
    console.log(`[smith-progression] ${metal.name} loop: ${at(mine)} -> ${at(furnace)} -> ${at(anvil)} -> ${at(bank)} (${best.cost} tiles per cycle)`);
    return chosen;
  }

  private readonly memoryFile: string | null;

  constructor(opts: SmithingPlannerOptions = {}) {
    this.smeltOnly = opts.smeltOnly ?? false;
    this.untilLevel = opts.smeltOnly ? 100 : (opts.untilLevel ?? LAST_GEAR_LEVEL);
    this.forced = opts.metal ? { bronze: BRONZE, iron: IRON, steel: STEEL, mithril: MITHRIL, adamant: ADAMANT }[opts.metal] : undefined;
    this.memoryFile = opts.memoryFile === undefined ? path.resolve('data/unusable-sites.json') : opts.memoryFile;
    if (this.memoryFile && existsSync(this.memoryFile)) {
      for (const k of JSON.parse(readFileSync(this.memoryFile, 'utf8')) as string[]) this.unusable.add(k);
    }
  }

  private remember(): void {
    if (!this.memoryFile) return;
    mkdirSync(path.dirname(this.memoryFile), { recursive: true });
    writeFileSync(this.memoryFile, JSON.stringify([...this.unusable], null, 1));
  }

  private metal(s: Snapshot): Metal {
    if (this.forced) return this.forced;
    const smithing = level(s, 'Smithing');
    const mining = level(s, 'Mining');
    if (smithing >= ADAMANT_SMITHING && mining >= ADAMANT_MINING) return ADAMANT;
    if (smithing >= MITHRIL_SMITHING && mining >= MITHRIL_MINING) return MITHRIL;
    return smithing >= STEEL_LEVEL ? STEEL : smithing >= IRON_LEVEL ? IRON : BRONZE;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.bank = new Map(s.bank.items.map((i) => [i.name, i.quantity]));

    // Learn before the give-up check: an unreachable site is replaced, not retried.
    this.learnFromReports(ctx, this.metal(s));

    const last = ctx.reports.slice(-3);
    if (last.length === 3 && last.every((r) => r.result !== 'done' && r.subgoal === last[0]!.subgoal)) {
      return { kind: 'impossible', reason: `failed 3 times on "${last[0]!.subgoal}": ${last[2]!.reason}` };
    }

    const smithing = level(s, 'Smithing');
    const metal = this.metal(s);
    const route = await this.route(metal, ctx);
    const allGear = [...BRONZE.gear, ...IRON.gear, ...STEEL.gear, ...MITHRIL.gear, ...ADAMANT.gear];

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

    // 3. Smelt ores into bars first (smithing first bounced between anvil and furnace) at the nearest furnace (Al Kharid's when banking there: walking to
    // Lumbridge from Al Kharid means the toll gate).
    if (metal.ores.every((o, i) => held(s, o) >= perBar(metal, i))) {
      const scarcest = [...metal.ores].sort((a, b) => held(s, a) - held(s, b))[0]!;
      const here = s.player?.position;
      const near = here && ctx.kb ? ctx.kb.nearestObjects('Furnace', here, { action: 'Smelt', radius: 200, limit: 1 })[0] : undefined;
      const furnace = route?.furnace ?? (near ? { name: 'nearest furnace', point: near.point } : { name: 'Lumbridge furnace', point: PLACES.furnace });
      return sg(`smelt the ${metal.ores.join(' and ').toLowerCase()} into ${lc(metal.bar)}s at the furnace`, ['Furnace', metal.bar], ['Smelt', 'Make'], { lacksItem: scarcest }, {
        destination: furnace,
        // Includes the walk to the furnace (Edgeville is ~130 tiles from the mine).
        maxSteps: 800,
      });
    }

    // 4. Smith while carrying bars and a hammer.
    if (bars > 0 && hasHammer && !this.smeltOnly) {
      const target = metal.gear.find((g) => g.level <= smithing && g.bars <= bars && isUpgrade(s, g.item, g.slot) && held(s, g.item) === 0);
      const anvil = route ? route.anvil : { name: metal.anvil.name, point: metal.anvil.point };
      const at = { destination: { name: anvil.name, point: anvil.point }, avoid: metal.anvil.avoid, avoidAt: this.retiredPoints(), maxSteps: 500 };
      if (target) {
        // One upgrade piece: exactly one, so the anvil does not queue a batch onto the next item's bars.
        const count = held(s, target.item) + 1;
        return sg(`smith a ${target.item} at the ${metal.anvil.name}`, [...metal.anvil.targets, target.item], ['Smith'], { hasItem: { name: target.item, count } }, { ...at, want: [{ name: target.item, count }] });
      }
      // XP filler: every carried bar in one "Smith All" (no want), not one dagger per sub-goal.
      return sg(`smith all the ${lc(metal.bar)}s into ${metal.filler}s at the ${metal.anvil.name}`, [...metal.anvil.targets, metal.filler], ['Smith'], { lacksItem: metal.bar }, at);
    }

    // 5. Out of materials. Mine when the bank (as last seen) cannot supply a batch.
    const mineNext = oreToMine(metal, (o) => (this.bank?.get(o) ?? 0) + held(s, o));
    const want = metal.batch * perBar(metal, metal.ores.indexOf(mineNext.ore));
    const bankOre = this.bank?.get(mineNext.ore) ?? 0;
    const needMining = this.bank !== null && bankOre < want && held(s, mineNext.ore) < want;
    const hasPickaxe = held(s, 'pickaxe') + s.equipment.filter((e) => lc(e.name).includes('pickaxe')).length > 0;
    // Bank the smithed junk first: a trip with a half-full inventory wastes the walk.
    const roomy = s.inventory.freeSlots >= 20 || held(s, mineNext.ore) > 0;
    if (needMining && roomy && s.inventory.freeSlots > 0 && hasPickaxe) {
      // The planned loop's mine was picked by its main rocks; other ores come from the metal's own mine.
      const mine = mineNext.ore === metal.mineOre ? (route?.mine ?? metal.mine) : metal.mine;
      return sg(`mine ${lc(mineNext.ore)} at the ${mine.name} until the inventory is full`, [mineNext.rocks], ['Mine'], { inventoryFull: true }, {
        destination: mine,
        // Steps include every busy tick; a contested iron mine with a bronze pickaxe needs ~800.
        maxSteps: 1500,
      });
    }

    // 6. Go and use the nearest bank (any bank works; the knowledge base knows where they are).
    const pos = s.player?.position;
    const nearest = pos && ctx.kb ? ctx.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
    const bank = route?.bank ?? (nearest ? { name: nearest.name, point: nearest.point } : { name: 'Lumbridge Top bank', point: PLACES.bank });
    return sg(`go to the ${bank.name} and open the bank`, ['Bank booth', 'Banker', 'Bank chest'], ['Bank', 'Use'], { bankOpen: true }, {
      avoid: ['Poll booth', 'Bank Deposit Box', 'Bank deposit box', 'Deposit Box'],
      destination: bank,
      maxSteps: 200,
    });
  }

  private atBank(s: Snapshot, metal: Metal): PlanStep {
    // Smelting for profit banks the bars; smithing keeps them for the anvil.
    const keepRe = new RegExp(`hammer|pickaxe|coins|${[...metal.ores, ...(this.smeltOnly ? [] : [metal.bar])].map((n) => lc(n)).join('|')}`, 'i');
    const junk = s.inventory.items
      .map((i) => i.name)
      .filter((n, idx, all) => all.indexOf(n) === idx)
      .filter((n) => !keepRe.test(n));
    if (junk.length > 0) {
      return sg(`deposit the ${junk.join(', ')}`, junk, ['Deposit'], { lacksItems: junk }, { maxSteps: 20 });
    }
    // Deposit mined ore beyond one batch (after a mining trip the inventory is full of it).
    if (metal.ores.length > 1) {
      const extra = metal.ores.find((o, i) => held(s, o) > metal.batch * perBar(metal, i));
      if (extra) return sg(`deposit all the ${lc(extra)}`, [extra], ['Deposit'], { lacksItem: extra }, { maxSteps: 6 });
    }
    const want: { name: string; count: number }[] = [];
    if (held(s, 'Hammer') === 0 && s.bank.items.some((i) => i.name === 'Hammer')) want.push({ name: 'Hammer', count: 1 });
    const wornPickaxe = s.equipment.some((e) => lc(e.name).includes('pickaxe'));
    const bankPickaxe = s.bank.items.find((i) => lc(i.name).includes('pickaxe'));
    if (!wornPickaxe && held(s, 'pickaxe') === 0 && bankPickaxe) want.push({ name: bankPickaxe.name, count: 1 });
    // A batch is limited by the scarcest ore (bank + inventory).
    const available = metal.ores.map((o, i) => Math.floor(((s.bank.items.find((x) => x.name === o)?.quantity ?? 0) + held(s, o)) / perBar(metal, i)));
    const batch = Math.min(metal.batch, ...available);
    if (batch > 0 && metal.ores.some((o, i) => held(s, o) < batch * perBar(metal, i))) {
      metal.ores.forEach((o, i) => want.push({ name: o, count: batch * perBar(metal, i) }));
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
