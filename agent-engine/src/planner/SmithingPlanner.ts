/**
 * Long-horizon plan: gear up through Smithing around Lumbridge.
 *
 *   mine copper (swamp mine) -> bank -> withdraw 13 copper + 13 tin + hammer -> smelt at the
 *   Lumbridge furnace -> smith at the rusted anvil beside it -> equip upgrades -> repeat
 *
 * Each call looks at the snapshot and returns one concrete sub-goal; the per-tick engine and its
 * classifier do the clicking. Bank contents are only visible while the bank is open, so the planner
 * remembers what it last saw there.
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

/** Bronze armour worth making, in unlock order. Weapons are handled separately (scimitar). */
export const BRONZE_GEAR: GearTier[] = [
  { item: 'Bronze full helm', level: 7, bars: 2, slot: 'HEAD' },
  { item: 'Bronze chainbody', level: 11, bars: 3, slot: 'BODY' },
  { item: 'Bronze kiteshield', level: 12, bars: 3, slot: 'SHIELD' },
  { item: 'Bronze platelegs', level: 16, bars: 3, slot: 'LEGS' },
  { item: 'Bronze platebody', level: 18, bars: 5, slot: 'BODY' },
];

/** Better-to-worse ordering inside a slot, for "is this an upgrade?". */
const RANK = ['Bronze platebody', 'Bronze chainbody', 'Bronze full helm', 'Bronze med helm', 'Bronze kiteshield', 'Bronze sq shield', 'Bronze platelegs'];

export const PLACES = {
  bank: { x: 3209, y: 3220, plane: 2 } as WorldPoint, // Lumbridge castle top floor
  furnace: { x: 3226, y: 3255, plane: 0 } as WorldPoint, // Lumbridge furnace; rusted anvil beside it
  mine: { x: 3229, y: 3146, plane: 0 } as WorldPoint, // Lumbridge Swamp east mine (copper + tin)
};

const BATCH = 13; // 13 copper + 13 tin + hammer + pickaxe = 28 slots

const lc = (s: string) => s.toLowerCase();

function held(s: Snapshot, name: string): number {
  const n = lc(name);
  return s.inventory.items.filter((i) => lc(i.name).includes(n)).reduce((sum, i) => sum + i.quantity, 0);
}

function level(s: Snapshot, skill: string): number {
  return s.skills.find((k) => k.name === skill)?.level ?? 1;
}

function wornIn(s: Snapshot, slot: string): string | undefined {
  return s.equipment.find((e) => e.slot === slot)?.name;
}

/** True when `item` beats whatever is in its slot (by the RANK list; anything beats nothing). */
function isUpgrade(s: Snapshot, item: string, slot: string): boolean {
  const current = wornIn(s, slot);
  if (!current) return true;
  const a = RANK.indexOf(item);
  const b = RANK.indexOf(current);
  if (a < 0) return false;
  return b < 0 || a < b;
}

function sg(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, extra: Partial<PlannedSubGoal> = {}): PlanStep {
  return {
    kind: 'subgoal',
    subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps: 150, keep: ['Hammer', 'pickaxe'], ...extra },
  };
}

export interface SmithingPlannerOptions {
  /** Stop when Smithing reaches this level. Default 18 (bronze platebody). */
  untilLevel?: number;
}

export class SmithingPlanner implements Planner {
  readonly name = 'smith-progression';
  private readonly untilLevel: number;
  /** Last seen bank counts (item name -> quantity); null until the bank has been opened once. */
  private bank: Map<string, number> | null = null;

  constructor(opts: SmithingPlannerOptions = {}) {
    this.untilLevel = opts.untilLevel ?? 18;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.bank = new Map(s.bank.items.map((i) => [i.name, i.quantity]));

    const last = ctx.reports.slice(-3);
    if (last.length === 3 && last.every((r) => r.result !== 'done' && r.subgoal === last[0]!.subgoal)) {
      return { kind: 'impossible', reason: `failed 3 times on "${last[0]!.subgoal}": ${last[2]!.reason}` };
    }

    const smithing = level(s, 'Smithing');
    // Done at the target level only once every unlocked upgrade is made and worn; otherwise the
    // run stopped at 18 holding 12 bars and no platebody.
    const pendingUpgrade = BRONZE_GEAR.some(
      (g) => g.level <= smithing && isUpgrade(s, g.item, g.slot) && (held(s, g.item) > 0 || held(s, 'Bronze bar') >= g.bars),
    );
    if (smithing >= this.untilLevel && !pendingUpgrade) {
      return { kind: 'complete', reason: `Smithing ${smithing} reached and all unlocked upgrades worn` };
    }

    // 1. Wear any upgrade we are carrying.
    const wearable = s.inventory.items.find((i) => {
      const tier = BRONZE_GEAR.find((g) => g.item === i.name);
      return tier && isUpgrade(s, tier.item, tier.slot);
    });
    if (wearable && !s.bank.open) {
      return sg(`wear the ${wearable.name}`, [wearable.name], ['Wear'], { equipped: [wearable.name] }, { maxSteps: 6 });
    }

    const bars = held(s, 'Bronze bar');
    const copper = held(s, 'Copper ore');
    const tin = held(s, 'Tin ore');
    const hasHammer = held(s, 'Hammer') > 0;

    // 2. Bank screen: the planner decides what goes in and out.
    if (s.bank.open) return this.atBank(s);

    // 3. Smith while carrying bars and a hammer.
    if (bars > 0 && hasHammer) {
      const target = BRONZE_GEAR.find(
        (g) => g.level <= smithing && g.bars <= bars && isUpgrade(s, g.item, g.slot) && held(s, g.item) === 0,
      );
      const item = target?.item ?? 'Bronze dagger';
      const count = held(s, item) + 1;
      return sg(`smith a ${item} at the anvil`, ['Rusted anvil', 'Anvil', item], ['Smith'], { hasItem: { name: item, count } }, {
        destination: { name: 'Lumbridge furnace', point: PLACES.furnace },
        want: [{ name: item, count }],
        maxSteps: 60,
      });
    }

    // 4. Smelt ores into bars.
    if (copper > 0 && tin > 0) {
      return sg('smelt the copper and tin ore into bronze bars at the furnace', ['Furnace', 'Bronze bar'], ['Smelt', 'Make'], { lacksItem: copper <= tin ? 'Copper ore' : 'Tin ore' }, {
        destination: { name: 'Lumbridge furnace', point: PLACES.furnace },
        maxSteps: 200,
      });
    }

    // 5. Out of materials. Mine when the bank (as last seen) cannot supply a batch of copper.
    const bankCopper = this.bank?.get('Copper ore') ?? 0;
    const needMining = this.bank !== null && bankCopper < BATCH && copper < BATCH;
    const hasPickaxe = held(s, 'pickaxe') + s.equipment.filter((e) => lc(e.name).includes('pickaxe')).length > 0;
    // Bank the smithed junk first: a trip with a half-full inventory wastes the walk.
    const roomy = s.inventory.freeSlots >= 20 || copper > 0;
    if (needMining && roomy && s.inventory.freeSlots > 0 && hasPickaxe) {
      return sg('mine copper ore at the Lumbridge Swamp mine until the inventory is full', ['Copper rocks'], ['Mine'], { inventoryFull: true }, {
        destination: { name: 'Lumbridge Swamp mine', point: PLACES.mine },
        maxSteps: 500,
      });
    }

    // 6. Go and use the bank.
    return sg('go to the Lumbridge castle bank and open a bank booth', ['Bank booth'], ['Bank'], { bankOpen: true }, {
      destination: { name: 'Lumbridge Top bank', point: PLACES.bank },
      maxSteps: 150,
    });
  }

  private atBank(s: Snapshot): PlanStep {
    const junk = s.inventory.items
      .map((i) => i.name)
      .filter((n, idx, all) => all.indexOf(n) === idx)
      .filter((n) => !/hammer|pickaxe|copper ore|tin ore|coins|bronze bar/i.test(n));
    if (junk.length > 0) {
      return sg(`deposit the ${junk.join(', ')}`, junk, ['Deposit'], { lacksItems: junk }, { maxSteps: 20 });
    }
    const copperInBank = s.bank.items.find((i) => i.name === 'Copper ore')?.quantity ?? 0;
    const tinInBank = s.bank.items.find((i) => i.name === 'Tin ore')?.quantity ?? 0;
    const hasHammer = held(s, 'Hammer') > 0;
    const want: { name: string; count: number }[] = [];
    if (!hasHammer && s.bank.items.some((i) => i.name === 'Hammer')) want.push({ name: 'Hammer', count: 1 });
    // Mined copper beyond one batch stays banked; a full batch needs both ores.
    const batch = Math.min(BATCH, copperInBank + held(s, 'Copper ore'), tinInBank + held(s, 'Tin ore'));
    if (batch > 0 && (held(s, 'Copper ore') < batch || held(s, 'Tin ore') < batch)) {
      want.push({ name: 'Copper ore', count: batch }, { name: 'Tin ore', count: batch });
    }
    // Deposit copper beyond the batch (after a mining trip the inventory is full of it).
    if (held(s, 'Copper ore') > BATCH) {
      return sg('deposit all the copper ore', ['Copper ore'], ['Deposit'], { lacksItem: 'Copper ore' }, { maxSteps: 6 });
    }
    if (want.length > 0) {
      return sg(
        `withdraw ${want.map((w) => `${w.count} ${w.name}`).join(', ')}`,
        want.map((w) => w.name),
        ['Withdraw'],
        { hasItems: want.map((w) => ({ name: w.name, count: w.count })) },
        { want, maxSteps: 25 },
      );
    }
    return sg('close the bank', ['Bank'], ['Close'], { bankOpen: false }, { maxSteps: 5 });
  }
}
