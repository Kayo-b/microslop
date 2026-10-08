/**
 * Jewellery for profit and Crafting levels (free-to-play): buy gold bars and cut gems at the Grand
 * Exchange, craft rings, necklaces and amulets at the Edgeville furnace, sell them. The recipe is
 * picked from live prices and the Crafting level. When a clearly better recipe unlocks within
 * reach, the run trains towards it with the recipe that earns the most XP without losing money,
 * so the character climbs sapphire -> emerald -> ruby -> diamond by itself.
 *
 *   GE: sell products, buy moulds (once) and a stack of bars and gems (collected as notes)
 *   -> Edgeville bank: deposit the notes, withdraw a trip of bars and gems (the mould stays carried)
 *   -> furnace: use a gold bar on it, pick the product from the make menu -> bank -> repeat
 *   -> inputs gone: withdraw the products as notes -> sell
 */
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { BuyScale } from './buyScale.ts';
import { carriedCoins, GRAND_EXCHANGE_BANK, nearGrandExchange, SAFE_CARRY } from './SellPlanner.ts';

/** A tile inside the bank (the booths themselves cannot be stood on). */
export const EDGEVILLE_BANK = { name: 'Edgeville bank', point: { x: 3094, y: 3492, plane: 0 } };
export const EDGEVILLE_FURNACE = { name: 'Edgeville furnace', point: { x: 3109, y: 3499, plane: 0 } };

const BAR = 'Gold bar';

export interface JewelleryRecipe {
  id: string;
  level: number;
  /** Crafting XP per piece. */
  xp: number;
  mould: string;
  /** One of each per piece. */
  inputs: string[];
  /** The item that results (what the Grand Exchange trades). */
  product: string;
  /** The make-menu entry. */
  option: string;
  /** Pieces per inventory trip: the mould and the coins take a slot. */
  perTrip: number;
  /** Rough pieces per hour, to compare recipes by profit per hour. */
  perHour: number;
}

const GEMS = ['Sapphire', 'Emerald', 'Ruby', 'Diamond'];
const KINDS = [
  { kind: 'ring', mould: 'Ring mould', suffix: '' },
  { kind: 'necklace', mould: 'Necklace mould', suffix: '' },
  { kind: 'amulet', mould: 'Amulet mould', suffix: ' (u)' },
];
/** [level, xp] per [gold, sapphire, emerald, ruby, diamond] x [ring, necklace, amulet]. */
const TABLE: [number, number][][] = [
  [[5, 15], [6, 20], [8, 30]],
  [[20, 40], [22, 55], [24, 65]],
  [[27, 55], [29, 60], [31, 70]],
  [[34, 70], [40, 75], [50, 85]],
  [[43, 85], [56, 90], [70, 100]],
];

export const JEWELLERY_RECIPES: JewelleryRecipe[] = ['Gold', ...GEMS].flatMap((gem, g) =>
  KINDS.map((k, i) => {
    const [level, xp] = TABLE[g]![i]!;
    const name = `${gem} ${k.kind}`;
    return {
      id: name.toLowerCase(),
      level,
      xp,
      mould: k.mould,
      inputs: gem === 'Gold' ? [BAR] : [BAR, gem],
      product: `${name}${k.suffix}`,
      option: name,
      perTrip: gem === 'Gold' ? 26 : 13,
      perHour: gem === 'Gold' ? 1500 : 1000,
    };
  }),
);

type Priced = JewelleryRecipe & { profit: number; cost: number };

const priced = (price: (item: string) => number | null) => (r: JewelleryRecipe): Priced => {
  const out = price(r.product);
  const costs = r.inputs.map((i) => price(i) ?? 0);
  const ok = Boolean(out) && costs.every((c) => c > 0);
  return { ...r, profit: ok ? Math.round(out! * 0.98 - costs.reduce((n, c) => n + c, 0)) : -1, cost: costs.reduce((n, c) => n + c, 0) };
};

const RESERVE = 500;
const OVERBID = 1.35;
const MIN_BUY = 10;
const MAX_BUY = 1000;
/**
 * What a Crafting XP point is worth in gp when ranking recipes. Margins are flat across the table
 * (about 100 to 250 gp a piece), so profit alone would stay on the first recipe forever; counting
 * XP moves the run up to the higher-XP pieces as soon as the level allows, which is also what
 * unlocks the better ones later (diamond at 43 to 70).
 */
const XP_VALUE = 1;

/** The recipe with the best profit per hour the level allows, earning at least `minProfit` each; null when none. */
export function bestJewellery(level: number, price: (item: string) => number | null, minProfit = 20): Priced | null {
  return JEWELLERY_RECIPES.filter((r) => r.level <= level)
    .map(priced(price))
    .filter((r) => r.profit >= minProfit)
    .sort((a, b) => b.profit * b.perHour - a.profit * a.perHour)[0] ?? null;
}

/**
 * The recipe to run: best profit plus XP value per hour among those the level allows that do not
 * lose money, skipping any too dear to buy a first batch of with `coins`.
 */
export function nextJewellery(level: number, price: (item: string) => number | null, coins = Infinity, minProfit = 20): Priced | null {
  return JEWELLERY_RECIPES.filter((r) => r.level <= level)
    .map(priced(price))
    .filter((r) => r.profit >= minProfit && r.cost * MIN_BUY + 1500 <= coins - RESERVE)
    .sort((a, b) => (b.profit + b.xp * XP_VALUE) * b.perHour - (a.profit + a.xp * XP_VALUE) * a.perHour)[0] ?? null;
}

export interface JewelleryOptions {
  price: (item: string) => number | null;
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, keep: string[], extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins', ...keep], ...extra } };
}

const MOULDS = KINDS.map((k) => k.mould);

export class JewelleryPlanner implements Planner {
  readonly name = 'craft-jewellery';
  private readonly o: JewelleryOptions;
  private seen: Map<string, number> | null = null;
  private recipe: Priced | null | undefined;
  private readonly scale = new BuyScale();

  constructor(o: JewelleryOptions) {
    this.o = o;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.seen = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    const bank = this.seen;
    const banked = (n: string) => bank?.get(n) ?? 0;
    const level = s.skills.find((k) => k.name === 'Crafting')?.level ?? 1;
    const count = (name: string, noted?: boolean) =>
      s.inventory.items.filter((i) => i.name === name && (noted === undefined || Boolean(i.noted) === noted)).reduce((n, i) => n + i.quantity, 0);
    const coins = carriedCoins(s);
    const wealth = coins + banked('Coins');

    // Re-picked only between batches, so a price wobble never strands half-bought inputs, while
    // a new level takes effect at the next purchase.
    const stockLeft = (x: Priced) => x.inputs.some((n) => count(n) > 0 || banked(n) > 0);
    if (this.recipe === undefined || ((this.recipe === null || !stockLeft(this.recipe)) && (s.grandExchange?.open || !bank))) {
      this.recipe = nextJewellery(level, this.o.price, wealth);
    }
    const r = this.recipe;
    const products = JEWELLERY_RECIPES.map((x) => x.product);
    const inputs = r?.inputs ?? [];
    const scale = this.scale.update(ctx.reports.at(-1));
    const have = (n: string) => count(n, false) + count(n, true) + banked(n);
    const mouldOwned = r ? have(r.mould) > 0 : true;
    const stocked = !!r && Math.min(...inputs.map(have)) >= Math.min(MIN_BUY, r.perTrip);

    // The make menu: pick the product when the bars and gems are still there.
    if (s.production.open && (s.production.interface === 'make' || s.production.interface === 'jewellery')) {
      if (r && inputs.every((n) => count(n, false) > 0)) return { kind: 'act', action: { op: 'production_select', option: r.option }, reason: `make ${r.option} (${r.xp} xp each)` };
      return step('open the Edgeville bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 200, [], { destination: EDGEVILLE_BANK });
    }

    if (s.grandExchange?.open) {
      const sellable = products.find((p) => count(p) > 0 && !inputs.includes(p));
      if (sellable) return { kind: 'act', action: { op: 'ge_sell', name: sellable }, reason: `sell the ${sellable}` };
      if (r) {
        if (!mouldOwned) return { kind: 'act', action: { op: 'ge_buy', name: r.mould, quantity: 1 }, reason: `buy a ${r.mould} for ${r.id}` };
        const stock = Math.min(...inputs.map(have));
        if (stock < Math.min(MIN_BUY, r.perTrip)) {
          const lead = inputs[0]!;
          if (have(lead) < Math.min(MIN_BUY, r.perTrip)) {
            const n = Math.min(MAX_BUY, Math.floor(((coins - RESERVE) * scale) / Math.ceil(r.cost * OVERBID)));
            if (n >= Math.min(MIN_BUY, r.perTrip)) return { kind: 'act', action: { op: 'ge_buy', name: lead, quantity: n }, reason: `buy ${n} ${lead} (${r.id}, ~${r.profit} gp profit each)` };
          } else {
            const short = inputs.find((i) => have(i) < have(lead));
            if (short) return { kind: 'act', action: { op: 'ge_buy', name: short, quantity: have(lead) - have(short) }, reason: `buy ${have(lead) - have(short)} ${short}` };
          }
        }
      }
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    }

    if (s.bank.open) {
      const inputsLeft = inputs.some((n) => count(n) > 0 || banked(n) > 0);
      const keepMould = r?.mould;
      // Unnoted inputs and the mould stay; product notes stay once no inputs are left (they were
      // just withdrawn to be sold). Anything else, finished jewellery included, goes in.
      const junk = s.inventory.items.find(
        (i) => i.name !== 'Coins' && !(!i.noted && (inputs.includes(i.name) || i.name === keepMould)) && !(i.noted && !inputsLeft && products.includes(i.name)),
      );
      if (junk) return { kind: 'act', action: { op: 'bank_deposit', itemId: junk.id, amount: 'all' }, reason: `deposit the ${junk.noted ? 'noted ' : ''}${junk.name}` };
      if (r) {
        const mould = s.bank.items.find((b) => b.name === r.mould);
        if (mould && count(r.mould, false) === 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: mould.id, amount: 1 }, reason: `withdraw the ${r.mould}` };
        for (const name of inputs) {
          const stack = s.bank.items.find((b) => b.name === name);
          const amount = Math.min(r.perTrip - count(name, false), stack?.quantity ?? 0, s.inventory.freeSlots);
          if (stack && amount > 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: stack.id, amount }, reason: `withdraw ${name}` };
        }
      }
      // Bank the coins once the trip is withdrawn: nothing is walked to the furnace with them.
      const coinsHeld = s.inventory.items.find((i) => i.name === 'Coins');
      if (stocked && coinsHeld && coins > SAFE_CARRY) return { kind: 'act', action: { op: 'bank_deposit', itemId: coinsHeld.id, amount: 'all' }, reason: 'bank the coins before walking' };
      if (!inputs.some((n) => count(n, false) > 0)) {
        const product = s.bank.items.find((b) => products.includes(b.name) && !inputs.includes(b.name));
        if (product) return { kind: 'act', action: { op: 'bank_withdraw', itemId: product.id, amount: 'all', noted: true }, reason: `withdraw the ${product.name} as notes to sell` };
        const coinStack = s.bank.items.find((b) => b.name === 'Coins');
        // Coins come out only at the Grand Exchange bank, where they are spent on the spot.
        if (coinStack && coinStack.quantity > coins && !stocked && nearGrandExchange(s)) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: 'all' }, reason: 'withdraw coins to buy bars and gems' };
      }
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }

    // A trip in the inventory: use a gold bar on the furnace.
    if (r && inputs.every((n) => count(n, false) > 0) && count(r.mould, false) > 0) {
      const furnace = s.objects.filter((o) => /furnace/i.test(o.name) && o.reachable && o.distance <= 12).sort((a, b) => a.distance - b.distance)[0];
      const bar = s.inventory.items.find((i) => i.name === BAR && !i.noted);
      if (furnace && bar) {
        const p = furnace.position;
        return { kind: 'act', action: { op: 'use_item_on', itemSlot: bar.slot, target: { kind: 'object', id: furnace.id, x: p.x, y: p.y, plane: p.plane } }, reason: `use a gold bar on the ${furnace.name}` };
      }
      return step('walk to the Edgeville furnace', ['Furnace'], ['Walk'], { near: { ...EDGEVILLE_FURNACE.point, radius: 5 } }, 200, [...inputs, r.mould], { destination: EDGEVILLE_FURNACE });
    }

    const others = s.inventory.items.filter((i) => i.name !== 'Coins');
    if (others.length && others.every((i) => i.noted && products.includes(i.name) && !inputs.includes(i.name))) {
      return step('open the Grand Exchange to sell', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, products, { destination: GRAND_EXCHANGE });
    }
    const stockBanked = (inputs.length > 0 && inputs.every((n) => banked(n) > 0)) || products.some((n) => banked(n) > 0 && !inputs.includes(n));
    if (stocked && coins > SAFE_CARRY && nearGrandExchange(s)) {
      return step('open the Grand Exchange bank to bank the coins', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [], { destination: GRAND_EXCHANGE_BANK });
    }
    if (others.length || bank === null || stockBanked) {
      return step('open the Edgeville bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [...inputs, ...(r ? [r.mould] : [])], { destination: EDGEVILLE_BANK });
    }
    if (!r) return { kind: 'impossible', reason: `no jewellery recipe pays at Crafting ${level} with current prices` };
    const batch = Math.min(MIN_BUY, r.perTrip);
    if (Math.floor((wealth - RESERVE) / Math.ceil(r.cost * OVERBID)) < batch) {
      return { kind: 'impossible', reason: `coins (${wealth}) do not buy ${batch} for ${r.id}` };
    }
    if (Math.floor((coins - RESERVE) / Math.ceil(r.cost * OVERBID)) < batch) {
      return step('open the Grand Exchange bank to take out coins', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [], { destination: GRAND_EXCHANGE_BANK });
    }
    return step(`open the Grand Exchange to buy ${r.inputs.join(' and ').toLowerCase()}`, ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, [], { destination: GRAND_EXCHANGE });
  }
}
