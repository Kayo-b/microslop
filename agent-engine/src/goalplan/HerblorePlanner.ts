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
import { BuyScale } from './buyScale.ts';
import { carriedCoins, GRAND_EXCHANGE_BANK, coinTopUp } from './SellPlanner.ts';

const VIAL = 'Vial of water';
/** Things beside the GE bank that a processing step never wants (the poll booth's menu blocks the bank). */
export const GE_DISTRACTIONS = ['Poll booth', 'Fire', 'Bank deposit box', 'Grand Exchange Clerk', 'Banker'];

/** Cleaning XP per herb, in HERBS order. */
const CLEAN_XP = [2.5, 3.8, 5, 6.3, 7.5, 8, 8.8, 10, 11.3, 11.8, 12.5, 13.1, 13.8, 15];

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
  /** Products per inventory trip (27 herbs to clean; 13 herbs + 13 vials to mix: coins take a slot). */
  perTrip: number;
  /** Rough products per hour, to compare recipes by profit per hour. */
  perHour: number;
  /** Herblore XP per product (cleaning and finished potions; unfinished potions give none). */
  xp: number;
  /** Mix step with two named items: use the first on the second (finished potions). Default: a vial of water on the herb. */
  combine?: [string, string];
}

/** Finished potions: [name, level, unfinished potion, secondary ingredient, XP]. The secondary is bought at the GE. */
const POTIONS: [string, number, string, string, number][] = [
  ['Attack potion(3)', 3, 'Guam potion (unf)', 'Eye of newt', 25],
  ['Antipoison(3)', 5, 'Marrentill potion (unf)', 'Unicorn horn dust', 37.5],
  ['Strength potion(3)', 12, 'Tarromin potion (unf)', 'Limpwurt root', 50],
  ['Restore potion(3)', 22, 'Harralander potion (unf)', "Red spiders' eggs", 62.5],
  ['Energy potion(3)', 26, 'Harralander potion (unf)', 'Chocolate dust', 67.5],
  ['Defence potion(3)', 30, 'Ranarr potion (unf)', 'White berries', 75],
  ['Prayer potion(3)', 38, 'Ranarr potion (unf)', 'Snape grass', 87.5],
  ['Super attack(3)', 45, 'Irit potion (unf)', 'Eye of newt', 100],
  ['Superantipoison(3)', 48, 'Irit potion (unf)', 'Unicorn horn dust', 106.3],
  ['Fishing potion(3)', 50, 'Avantoe potion (unf)', 'Snape grass', 112.5],
  ['Super energy(3)', 52, 'Avantoe potion (unf)', 'Mort myre fungus', 117.5],
  ['Super strength(3)', 55, 'Kwuarm potion (unf)', 'Limpwurt root', 125],
  ['Super restore(3)', 63, 'Snapdragon potion (unf)', "Red spiders' eggs", 142.5],
  ['Super defence(3)', 66, 'Cadantine potion (unf)', 'White berries', 150],
  ['Antifire potion(3)', 69, 'Lantadyme potion (unf)', 'Dragon scale dust', 157.5],
  ['Ranging potion(3)', 72, 'Dwarf weed potion (unf)', 'Wine of zamorak', 162.5],
  ['Magic potion(3)', 76, 'Lantadyme potion (unf)', 'Potato cactus', 172.5],
];

export const HERB_RECIPES: HerbRecipe[] = [
  ...HERBS.flatMap(([clean, grimy, cleanLvl, unf, unfLvl], i) => [
    { id: `clean:${clean}`, level: cleanLvl, inputs: [grimy], output: clean, steps: ['clean'], perTrip: 27, perHour: 1200, xp: CLEAN_XP[i]! } as HerbRecipe,
    { id: `unf:${clean}`, level: Math.max(cleanLvl, unfLvl), inputs: [grimy, VIAL], output: unf, steps: ['clean', 'mix'], perTrip: 13, perHour: 900, xp: CLEAN_XP[i]! } as HerbRecipe,
    { id: `mix:${clean}`, level: unfLvl, inputs: [clean, VIAL], output: unf, steps: ['mix'], perTrip: 13, perHour: 1800, xp: 0 } as HerbRecipe,
  ]),
  ...POTIONS.map(([potion, lvl, unf, secondary, xp]): HerbRecipe => ({ id: `potion:${potion}`, level: lvl, inputs: [unf, secondary], output: potion, steps: ['mix'], perTrip: 13, perHour: 2000, xp, combine: [secondary, unf] })),
];

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

/** Levels ahead whose recipes can justify training: cleaning ~8 levels is about an hour of clicks. */
const TRAIN_REACH = 8;
/** A recipe from a higher level must out-earn the current best by this factor to be worth training for. */
const TRAIN_GAIN = 1.2;
/** Cleaning may lose up to this much per herb while it trains (cleaning is the only XP; unfinished potions give none). */
const TRAIN_LOSS = 10;

/**
 * `bestRecipe`, except when a recipe within reach pays clearly more: then the best herb to clean
 * now (cleaning gives XP, mixing unfinished potions gives none), until the level unlocks it.
 * Without this the best-paying unfinished potion kept Herblore stuck at 22 for hours.
 * `coins` skips herbs too dear to buy a first batch of.
 */
export function nextRecipe(level: number, price: (item: string) => number | null, coins = Infinity, minProfit = 20): (HerbRecipe & { profit: number; cost: number }) | null {
  const best = bestRecipe(level, price, minProfit);
  const afford = (r: { cost: number }) => r.cost * MIN_BUY <= coins - RESERVE;
  const ahead = bestRecipe(level + TRAIN_REACH, price, minProfit);
  if (!ahead || ahead.level <= level || !afford(ahead)) return best;
  if (best && ahead.profit * ahead.perHour < best.profit * best.perHour * TRAIN_GAIN) return best;
  if (best?.steps.length === 1 && best.steps[0] === 'clean') return best;
  // HERB_RECIPES lists herbs in level order, so the last affordable clean recipe is the most XP per click.
  const train = HERB_RECIPES.filter((r) => r.steps.length === 1 && r.steps[0] === 'clean' && r.level <= level)
    .map((r) => ({ ...r, profit: recipeProfit(r, price) ?? -1, cost: r.inputs.reduce((n, i) => n + (price(i) ?? 0), 0) }))
    .filter((r) => r.profit >= -TRAIN_LOSS && r.cost > 0 && afford(r))
    .at(-1);
  return train ?? best;
}

/** Training: a potion may lose up to this many coins each while it trains. */
const TRAIN_MAX_LOSS = 250;

/**
 * Herblore XP per hour is what a level-up run wants: the recipe at this level with the most XP per
 * hour that the coins can buy a first batch of and that loses at most TRAIN_MAX_LOSS per product.
 * Cleaning herbs and mixing finished potions give XP; unfinished potions give none.
 */
export function trainingRecipe(level: number, price: (item: string) => number | null, coins = Infinity): (HerbRecipe & { profit: number; cost: number }) | null {
  return HERB_RECIPES.filter((r) => r.level <= level && r.xp > 0)
    .map((r) => ({ ...r, profit: recipeProfit(r, price) ?? Number.NEGATIVE_INFINITY, cost: r.inputs.reduce((n, i) => n + (price(i) ?? 0), 0) }))
    .filter((r) => r.profit >= -TRAIN_MAX_LOSS && r.cost > 0 && r.cost * MIN_BUY <= coins - RESERVE)
    .sort((a, b) => b.xp * b.perHour - a.xp * a.perHour)[0] ?? null;
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
  /** Level up: pick recipes by XP per hour instead of profit. */
  train?: boolean;
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, keep: string[], extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins', ...keep], ...extra } };
}

export class HerblorePlanner implements Planner {
  readonly name = 'herblore';
  private readonly o: HerbloreOptions;
  private seen: Map<string, number> | null = null;
  private recipe: ReturnType<typeof nextRecipe> | undefined;
  private readonly scale = new BuyScale();

  constructor(o: HerbloreOptions) {
    this.o = o;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.seen = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    const bank = this.seen;
    const level = s.skills.find((k) => k.name === 'Herblore')?.level ?? 1;
    const count = (name: string, noted?: boolean) =>
      s.inventory.items.filter((i) => i.name === name && (noted === undefined || Boolean(i.noted) === noted)).reduce((n, i) => n + i.quantity, 0);
    // Re-picked only between batches (no inputs carried or banked), so a price wobble never
    // strands half-bought inputs, while a new level (Herblore 5: guam -> marrentill) takes effect
    // at the next purchase instead of the next run.
    const stockLeft = (x: NonNullable<typeof this.recipe>) => x.inputs.every((n) => count(n) > 0 || (bank?.get(n) ?? 0) > 0);
    if (this.recipe === undefined || ((this.recipe === null || !stockLeft(this.recipe)) && s.grandExchange?.open)) {
      const wallet = carriedCoins(s) + (bank?.get('Coins') ?? 0);
      this.recipe = this.o.train ? trainingRecipe(level, this.o.price, wallet) : nextRecipe(level, this.o.price, wallet);
      // Herbs already owned (in any form) are worked off before more are bought: a recipe change
      // used to leave 13,000 grimy harralander (~4.5m gp) in the bank while it bought more.
      const owned = (n: string) => count(n) + (bank?.get(n) ?? 0);
      // Only raw inputs (grimy herbs): products waiting to be sold are not stock to mix.
      const raw = (n: string) => n.startsWith('Grimy ');
      const stocked = HERB_RECIPES.filter((x) => x.level <= level && x.inputs.some(raw) && x.inputs.every((n) => n === VIAL || (raw(n) && owned(n) >= MIN_BUY)))
        .map((x) => ({ ...x, profit: recipeProfit(x, this.o.price) ?? -1, cost: x.inputs.reduce((n, i) => n + (this.o.price(i) ?? 0), 0) }))
        .sort((x, y) => y.profit * y.perHour - x.profit * x.perHour)[0];
      if (stocked) this.recipe = stocked;
    }
    const r = this.recipe;
    const products = [...new Set(HERB_RECIPES.map((x) => x.output))];
    const productsHeld = products.filter((n) => count(n) > 0 && !r?.inputs.includes(n));
    const coins = carriedCoins(s);
    const scale = this.scale.update(ctx.reports.at(-1));

    if (s.grandExchange?.open) {
      if (productsHeld.length) return { kind: 'act', action: { op: 'ge_sell', name: productsHeld[0]! }, reason: `sell the ${productsHeld[0]}` };
      if (r) {
        const have = (n: string) => count(n) + (bank?.get(n) ?? 0);
        const stock = Math.min(...r.inputs.map(have));
        if (stock < Math.min(MIN_BUY, r.perTrip)) {
          // Buy the first input, then top the others up to it.
          const lead = r.inputs[0]!;
          if (have(lead) < Math.min(MIN_BUY, r.perTrip)) {
            const n = Math.min(MAX_BUY, r.perHour, Math.floor(((coins - RESERVE) * scale) / Math.ceil(r.cost * OVERBID)));
            if (n >= Math.min(MIN_BUY, r.perTrip)) return { kind: 'act', action: { op: 'ge_buy', name: lead, quantity: n }, reason: `buy ${n} ${lead} (${r.id}, ~${r.profit} gp profit each)` };
            // Too poor even with the banked coins (after the refused-price scale-down): closing the GE
            // only made the flow reopen it forever.
            const reach = Math.floor(((coins + (bank?.get('Coins') ?? 0) - RESERVE) * scale) / Math.ceil(r.cost * OVERBID));
            if (reach < Math.min(MIN_BUY, r.perTrip)) return { kind: 'impossible', reason: `coins (${coins + (bank?.get('Coins') ?? 0)}) do not buy ${Math.min(MIN_BUY, r.perTrip)} ${lead} at the Grand Exchange price` };
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
      // Product notes stay once no inputs are left: they were just withdrawn to be sold (depositing
      // them again looped withdraw/deposit, as tanning once did with leather).
      // A trip is only live while every input is held, banked, or (grimy) already cleaned: a lone
      // leftover input (13 vials, herbs gone) is junk, else it was kept, nothing withdrawn, the bank
      // closed and reopened forever.
      const tripLive = inputs.every((n, k) => count(n) > 0 || s.bank.items.some((b) => b.name === n) || (k === 0 && cleaned !== undefined && count(cleaned) > 0));
      const inputsLeft = tripLive;
      const keep = tripLive ? inputs : [];
      const junk = s.inventory.items.find(
        (i) => i.name !== 'Coins' && !(!i.noted && (keep.includes(i.name) || mid.includes(i.name))) && !(i.noted && !inputsLeft && products.includes(i.name)),
      );
      if (junk) return { kind: 'act', action: { op: 'bank_deposit', itemId: junk.id, amount: 'all' }, reason: `deposit the ${junk.noted ? 'noted ' : ''}${junk.name}` };
      for (const name of keep) {
        const stack = s.bank.items.find((b) => b.name === name);
        // Never more than the free slots: a full inventory refuses the withdraw (withdraw_failed).
        const amount = Math.min(r!.perTrip - count(name), stack?.quantity ?? 0, s.inventory.freeSlots);
        if (stack && amount > 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: stack.id, amount }, reason: `withdraw ${name}` };
      }
      if (!keep.some((n) => count(n) > 0)) {
        const product = s.bank.items.find((b) => products.includes(b.name) && !inputs.includes(b.name));
        if (product) return { kind: 'act', action: { op: 'bank_withdraw', itemId: product.id, amount: 'all', noted: true }, reason: `withdraw the ${product.name} as notes to sell` };
        const coinStack = s.bank.items.find((b) => b.name === 'Coins');
        if (coinStack && coinTopUp(coinStack.quantity, coins, 500_000) > 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: coinTopUp(coinStack.quantity, coins, 500_000) }, reason: 'withdraw coins to buy herbs' };
      }
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }

    // Processing a trip carried in the inventory.
    if (r) {
      const grimy = r.inputs.find((i) => i.startsWith('Grimy '));
      if (r.steps.includes('clean') && grimy && count(grimy, false) > 0) {
        return step(`clean all the ${grimy.toLowerCase()}s`, [grimy], ['Clean'], { lacksItem: grimy }, 80, [grimy, ...inputs], { avoid: GE_DISTRACTIONS });
      }
      if (r.combine) {
        const [used, onto] = r.combine;
        if (count(used, false) > 0 && count(onto, false) > 0) {
          const scarcer = count(used, false) <= count(onto, false) ? used : onto;
          return step(`use the ${used.toLowerCase()} on the ${onto.toLowerCase()} and make all the ${r.output.toLowerCase()}`, [used, onto], ['Use', 'Make'], { lacksItem: scarcer }, 80, [used, onto], { avoid: GE_DISTRACTIONS });
        }
      }
      const herb = r.steps.includes('mix') && !r.combine ? (grimy ? HERBS.find((h) => h[1] === grimy)![0] : r.inputs[0]!) : null;
      if (herb && count(herb, false) > 0 && count(VIAL, false) > 0) {
        // Done when the scarcer input is gone (14 herbs and 13 vials leave a herb): waiting for the
        // other one, the classifier wandered to the poll booth, whose menu then blocked the bank.
        const scarcer = count(herb, false) <= count(VIAL, false) ? herb : VIAL;
        return step(`use a vial of water on the ${herb.toLowerCase()} and make all the ${r.output.toLowerCase()}`, [VIAL, herb], ['Use', 'Make'], { lacksItem: scarcer }, 80, [VIAL, herb], { avoid: GE_DISTRACTIONS });
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
