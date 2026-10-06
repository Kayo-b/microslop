/**
 * Herblore for profit (members), all at the Grand Exchange: buy grimy herbs (and vials of water),
 * clean them and/or mix unfinished potions at the GE bank, sell the result. The recipe is picked
 * once per run from live prices, the Herblore level and the coins: the best profit per hour after
 * the 2% GE tax. Cleaning gives XP, so the run climbs to better herbs by itself.
 *
 *   GE: sell products, buy inputs (collected as notes)
 *   -> GE bank: deposit everything but coins, withdraw a trip of inputs
 *   -> clean the grimy herbs (one click each) and/or use vials on the herbs (Make All) -> bank -> repeat
 *   -> inputs gone: withdraw the products as notes -> sell
 */
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { carriedCoins, GRAND_EXCHANGE_BANK } from './SellPlanner.ts';

const VIAL = 'Vial of water';

/** [clean herb, grimy herb, level to clean, unfinished potion, level to mix it]. */
const HERBS: [string, string, number, string, number][] = [
  ['Guam leaf', 'Grimy guam leaf', 3, 'Guam potion (unf)', 3],
  ['Marrentill', 'Grimy marrentill', 5, 'Marrentill potion (unf)', 5],
  ['Tarromin', 'Grimy tarromin', 11, 'Tarromin potion (unf)', 12],
  ['Harralander', 'Grimy harralander', 20, 'Harralander potion (unf)', 22],
  ['Ranarr weed', 'Grimy ranarr weed', 25, 'Ranarr potion (unf)', 30],
  ['Toadflax', 'Grimy toadflax', 30, 'Toadflax potion (unf)', 34],
  ['Irit leaf', 'Grimy irit leaf', 40, 'Irit potion (unf)', 45],
  ['Avantoe', 'Grimy avantoe', 48, 'Avantoe potion (unf)', 50],
  ['Kwuarm', 'Grimy kwuarm', 54, 'Kwuarm potion (unf)', 55],
  ['Snapdragon', 'Grimy snapdragon', 59, 'Snapdragon potion (unf)', 63],
  ['Cadantine', 'Grimy cadantine', 65, 'Cadantine potion (unf)', 66],
  ['Lantadyme', 'Grimy lantadyme', 67, 'Lantadyme potion (unf)', 69],
  ['Dwarf weed', 'Grimy dwarf weed', 70, 'Dwarf weed potion (unf)', 72],
  ['Torstol', 'Grimy torstol', 75, 'Torstol potion (unf)', 78],
];

export interface HerbRecipe {
  id: string;
  level: number;
  /** Bought at the GE, one of each per product. */
  inputs: string[];
  output: string;
  /** clean: click Clean on each grimy herb; mix: use a vial of water on the herbs (Make All). */
  steps: ('clean' | 'mix')[];
  /** Products per inventory trip (27 herbs to clean; 14 herbs + 14 vials to mix). */
  perTrip: number;
  /** Rough products per hour, to compare recipes by profit per hour. */
  perHour: number;
}

export const HERB_RECIPES: HerbRecipe[] = HERBS.flatMap(([clean, grimy, cleanLvl, unf, unfLvl]) => [
  { id: `clean:${clean}`, level: cleanLvl, inputs: [grimy], output: clean, steps: ['clean'], perTrip: 27, perHour: 1200 },
  { id: `unf:${clean}`, level: Math.max(cleanLvl, unfLvl), inputs: [grimy, VIAL], output: unf, steps: ['clean', 'mix'], perTrip: 14, perHour: 900 },
  { id: `mix:${clean}`, level: unfLvl, inputs: [clean, VIAL], output: unf, steps: ['mix'], perTrip: 14, perHour: 1800 },
]);

/** Profit per product after the GE tax; null when a price is missing. */
export function recipeProfit(r: HerbRecipe, price: (item: string) => number | null): number | null {
  const out = price(r.output);
  const inputs = r.inputs.map((i) => price(i));
  if (!out || inputs.some((p) => !p)) return null;
  return Math.round(out * 0.98 - inputs.reduce((n, p) => n! + p!, 0)!);
}

/** The best recipe per hour the level allows, earning at least `minProfit` each; null when none. */
export function bestRecipe(level: number, price: (item: string) => number | null, minProfit = 20): (HerbRecipe & { profit: number; cost: number }) | null {
  return HERB_RECIPES.filter((r) => r.level <= level)
    .map((r) => ({ ...r, profit: recipeProfit(r, price) ?? -1, cost: r.inputs.reduce((n, i) => n + (price(i) ?? 0), 0) }))
    .filter((r) => r.profit >= minProfit)
    .sort((a, b) => b.profit * b.perHour - a.profit * a.perHour)[0] ?? null;
}

const RESERVE = 500;
/** ge_buy offers the client's guide price +30%; a little more covers the wiki price differing. */
const OVERBID = 1.32;
/** A first batch smaller than a full trip still starts the loop (10k coins buys 26 guam). */
const MIN_BUY = 10;
/** Products per GE purchase (capped by coins; grimy herb buy limits are 13,000 per 4 h). */
const MAX_BUY = 1000;

export interface HerbloreOptions {
  price: (item: string) => number | null;
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, keep: string[], extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins', ...keep], ...extra } };
}

export class HerblorePlanner implements Planner {
  readonly name = 'herblore';
  private readonly o: HerbloreOptions;
  private seen: Map<string, number> | null = null;
  private recipe: ReturnType<typeof bestRecipe> | undefined;

  constructor(o: HerbloreOptions) {
    this.o = o;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.seen = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    const bank = this.seen;
    const level = s.skills.find((k) => k.name === 'Herblore')?.level ?? 1;
    // Chosen once per run, so a price wobble does not strand half-bought inputs.
    this.recipe ??= bestRecipe(level, this.o.price);
    const r = this.recipe;
    const count = (name: string, noted?: boolean) =>
      s.inventory.items.filter((i) => i.name === name && (noted === undefined || Boolean(i.noted) === noted)).reduce((n, i) => n + i.quantity, 0);
    const products = [...new Set(HERB_RECIPES.map((x) => x.output))];
    const productsHeld = products.filter((n) => count(n) > 0 && !r?.inputs.includes(n));
    const coins = carriedCoins(s);

    if (s.grandExchange?.open) {
      if (productsHeld.length) return { kind: 'act', action: { op: 'ge_sell', name: productsHeld[0]! }, reason: `sell the ${productsHeld[0]}` };
      if (r) {
        const have = (n: string) => count(n) + (bank?.get(n) ?? 0);
        const stock = Math.min(...r.inputs.map(have));
        if (stock < Math.min(MIN_BUY, r.perTrip)) {
          // Buy the first input, then top the others up to it.
          const lead = r.inputs[0]!;
          if (have(lead) < Math.min(MIN_BUY, r.perTrip)) {
            const n = Math.min(MAX_BUY, Math.floor((coins - RESERVE) / Math.ceil(r.cost * OVERBID)));
            if (n >= Math.min(MIN_BUY, r.perTrip)) return { kind: 'act', action: { op: 'ge_buy', name: lead, quantity: n }, reason: `buy ${n} ${lead} (${r.id}, ~${r.profit} gp profit each)` };
          } else {
            const short = r.inputs.find((i) => have(i) < have(lead));
            if (short) return { kind: 'act', action: { op: 'ge_buy', name: short, quantity: have(lead) - have(short) }, reason: `buy ${have(lead) - have(short)} ${short}` };
          }
        }
      }
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    }

    const inputs = r?.inputs ?? [];
    if (s.bank.open) {
      // Coins and unnoted inputs stay; a half-processed trip (clean herbs waiting for vials) too.
      const cleaned = r && r.steps.length > 1 ? HERBS.find((h) => h[1] === r.inputs[0])?.[0] : undefined;
      const mid = cleaned ? [cleaned] : [];
      const junk = s.inventory.items.find((i) => i.name !== 'Coins' && !(!i.noted && (inputs.includes(i.name) || mid.includes(i.name))));
      if (junk) return { kind: 'act', action: { op: 'bank_deposit', itemId: junk.id, amount: 'all' }, reason: `deposit the ${junk.noted ? 'noted ' : ''}${junk.name}` };
      for (const name of inputs) {
        const stack = s.bank.items.find((b) => b.name === name);
        if (stack && count(name) < r!.perTrip) return { kind: 'act', action: { op: 'bank_withdraw', itemId: stack.id, amount: Math.min(r!.perTrip - count(name), stack.quantity) }, reason: `withdraw ${name}` };
      }
      if (!inputs.some((n) => count(n) > 0)) {
        const product = s.bank.items.find((b) => products.includes(b.name) && !inputs.includes(b.name));
        if (product) return { kind: 'act', action: { op: 'bank_withdraw', itemId: product.id, amount: 'all', noted: true }, reason: `withdraw the ${product.name} as notes to sell` };
        const coinStack = s.bank.items.find((b) => b.name === 'Coins');
        if (coinStack && coinStack.quantity > coins) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: 'all' }, reason: 'withdraw coins to buy herbs' };
      }
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }

    // Processing a trip carried in the inventory.
    if (r) {
      const grimy = r.inputs.find((i) => i.startsWith('Grimy '));
      if (r.steps.includes('clean') && grimy && count(grimy, false) > 0) {
        return step(`clean all the ${grimy.toLowerCase()}s`, [grimy], ['Clean'], { lacksItem: grimy }, 80, [grimy, ...inputs]);
      }
      const herb = r.steps.includes('mix') ? (grimy ? HERBS.find((h) => h[1] === grimy)![0] : r.inputs[0]!) : null;
      if (herb && count(herb, false) > 0 && count(VIAL, false) > 0) {
        return step(`use a vial of water on the ${herb.toLowerCase()} and make all the ${r.output.toLowerCase()}`, [VIAL, herb], ['Use', 'Make'], { lacksItem: herb }, 80, [VIAL, herb]);
      }
    }

    const others = s.inventory.items.filter((i) => i.name !== 'Coins');
    if (others.length && others.every((i) => i.noted && products.includes(i.name) && !inputs.includes(i.name))) {
      return step('open the Grand Exchange to sell', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, products, { destination: GRAND_EXCHANGE });
    }
    const banked = (n: string) => bank?.get(n) ?? 0;
    const stockBanked = (inputs.length > 0 && inputs.every((n) => banked(n) > 0)) || products.some((n) => banked(n) > 0 && !inputs.includes(n));
    if (others.length || bank === null || stockBanked) {
      return step('open the Grand Exchange bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [...inputs, ...products], { destination: GRAND_EXCHANGE_BANK });
    }
    if (!r) return { kind: 'impossible', reason: `no herblore recipe pays at Herblore ${level} with current prices` };
    const batch = Math.min(MIN_BUY, r.perTrip);
    if (Math.floor((coins + banked('Coins') - RESERVE) / Math.ceil(r.cost * OVERBID)) < batch) {
      return { kind: 'impossible', reason: `coins (${coins + banked('Coins')}) do not buy ${batch} for ${r.id}` };
    }
    if (Math.floor((coins - RESERVE) / Math.ceil(r.cost * OVERBID)) < batch) {
      return step('open the Grand Exchange bank to take out coins', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [], { destination: GRAND_EXCHANGE_BANK });
    }
    return step(`open the Grand Exchange to buy ${r.inputs.join(' and ')}`, ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, [], { destination: GRAND_EXCHANGE });
  }
}
