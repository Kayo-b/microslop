/**
 * String amulets for profit at the Grand Exchange (Crafting 1): buy unstrung amulets and balls of
 * wool, string 14 per inventory at the GE bank, sell the strung amulets. Which amulet is chosen
 * from live prices each run (after the 2% GE tax); the loop gives up when none pays.
 *
 *   GE: sell strung amulets, buy unstrung + wool (collected as notes)
 *   -> GE bank: deposit everything but coins, withdraw 14 + 14
 *   -> use the wool on an amulet, Make All -> bank -> repeat
 *   -> inputs gone: withdraw the strung amulets as notes -> sell
 */
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { carriedCoins, GRAND_EXCHANGE_BANK } from './SellPlanner.ts';

const WOOL = 'Ball of wool';
/** Free-to-play gem tiers whose unstrung amulets can be strung with wool. */
const AMULETS = ['Gold', 'Sapphire', 'Emerald', 'Ruby', 'Diamond'];
/** Profit per amulet below which stringing is not worth the trips. */
const MIN_PROFIT = 20;
const RESERVE = 500;
const OVERBID = 1.35;
/** Amulets per GE purchase (20 inventories). */
const MAX_BUY = 280;
const PER_TRIP = 14;

export interface StringingOptions {
  price: (item: string) => number | null;
}

export interface AmuletChoice {
  unstrung: string;
  strung: string;
  profit: number;
  /** Coins one amulet ties up (both inputs). */
  cost: number;
}

/** The F2P amulet with the best profit after the GE tax; null when none reaches MIN_PROFIT. */
export function bestAmulet(price: (item: string) => number | null): AmuletChoice | null {
  const wool = price(WOOL);
  if (!wool) return null;
  const all = AMULETS.flatMap((gem) => {
    const unstrung = `${gem} amulet (u)`;
    const strung = `${gem} amulet`;
    const u = price(unstrung);
    const st = price(strung);
    return u && st ? [{ unstrung, strung, profit: Math.round(st * 0.98 - u - wool), cost: u + wool }] : [];
  });
  return all.filter((a) => a.profit >= MIN_PROFIT).sort((a, b) => b.profit - a.profit)[0] ?? null;
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, keep: string[], extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins', ...keep], ...extra } };
}

export class StringingPlanner implements Planner {
  readonly name = 'string-amulets';
  private readonly o: StringingOptions;
  private seen: Map<string, number> | null = null;
  /** Chosen once per run, so a price wobble does not strand half-bought inputs. */
  private choice: AmuletChoice | null | undefined;

  constructor(o: StringingOptions) {
    this.o = o;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.seen = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    const bank = this.seen;
    this.choice ??= bestAmulet(this.o.price);
    const strungNames = AMULETS.map((g) => `${g} amulet`);
    const count = (name: string, noted?: boolean) =>
      s.inventory.items.filter((i) => i.name === name && (noted === undefined || Boolean(i.noted) === noted)).reduce((n, i) => n + i.quantity, 0);
    const strungHeld = strungNames.filter((n) => count(n) > 0);
    const coins = carriedCoins(s);
    const c = this.choice;

    if (s.grandExchange?.open) {
      if (strungHeld.length) return { kind: 'act', action: { op: 'ge_sell', name: strungHeld[0]! }, reason: `sell the ${strungHeld[0]}s` };
      if (c) {
        const have = (n: string) => count(n) + (bank?.get(n) ?? 0);
        // Buy the amulets first, then exactly as much wool.
        if (have(c.unstrung) < PER_TRIP) {
          const n = Math.min(MAX_BUY, Math.floor((coins - RESERVE) / Math.ceil(c.cost * OVERBID)));
          if (n >= PER_TRIP) return { kind: 'act', action: { op: 'ge_buy', name: c.unstrung, quantity: n }, reason: `buy ${n} ${c.unstrung} (~${c.profit} gp profit each)` };
        } else if (have(WOOL) < have(c.unstrung)) {
          const n = have(c.unstrung) - have(WOOL);
          return { kind: 'act', action: { op: 'ge_buy', name: WOOL, quantity: n }, reason: `buy ${n} balls of wool` };
        }
      }
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    }

    const unstrung = c?.unstrung;
    if (s.bank.open) {
      const keepUnnoted = (name: string, noted: boolean) => !noted && (name === WOOL || name === unstrung);
      // Strung-amulet notes stay once nothing is left to string: they were withdrawn to be sold.
      const inputsLeft = !!unstrung && (count(unstrung) > 0 || s.bank.items.some((b) => b.name === unstrung));
      const junk = s.inventory.items.find(
        (i) => i.name !== 'Coins' && !keepUnnoted(i.name, Boolean(i.noted)) && !(i.noted && !inputsLeft && strungNames.includes(i.name)),
      );
      if (junk) return { kind: 'act', action: { op: 'bank_deposit', itemId: junk.id, amount: 'all' }, reason: `deposit the ${junk.noted ? 'noted ' : ''}${junk.name}` };
      for (const name of unstrung ? [unstrung, WOOL] : []) {
        const stack = s.bank.items.find((b) => b.name === name);
        if (stack && count(name) < PER_TRIP) return { kind: 'act', action: { op: 'bank_withdraw', itemId: stack.id, amount: Math.min(PER_TRIP - count(name), stack.quantity) }, reason: `withdraw ${name} to string` };
      }
      if (!unstrung || count(unstrung) === 0) {
        const strung = s.bank.items.find((b) => strungNames.includes(b.name));
        if (strung) return { kind: 'act', action: { op: 'bank_withdraw', itemId: strung.id, amount: 'all', noted: true }, reason: `withdraw the ${strung.name}s as notes to sell` };
        const coinStack = s.bank.items.find((b) => b.name === 'Coins');
        if (coinStack && coinStack.quantity > coins) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: 'all' }, reason: 'withdraw coins to buy amulets' };
      }
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }

    if (unstrung && count(unstrung, false) > 0 && count(WOOL, false) > 0) {
      return step(`use a ball of wool on a ${unstrung} and string them all`, [WOOL, unstrung], ['Use', 'Make'], { lacksItem: unstrung }, 80, [WOOL, unstrung]);
    }
    // Only coins and strung amulet notes carried: off to sell them.
    const others = s.inventory.items.filter((i) => i.name !== 'Coins');
    if (others.length && others.every((i) => i.noted && strungNames.includes(i.name))) {
      return step('open the Grand Exchange to sell the amulets', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, strungNames, { destination: GRAND_EXCHANGE });
    }
    // Anything else carried (strung amulets, input notes, leftovers), or stock in the bank: the GE bank sorts it out.
    const banked = (n: string) => bank?.get(n) ?? 0;
    const stockBanked = (unstrung ? banked(unstrung) > 0 && banked(WOOL) > 0 : false) || strungNames.some((n) => banked(n) > 0);
    if (others.length || bank === null || stockBanked) {
      return step('open the Grand Exchange bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [WOOL, ...(unstrung ? [unstrung] : []), ...strungNames], { destination: GRAND_EXCHANGE_BANK });
    }
    if (!c) return { kind: 'impossible', reason: `no free-to-play amulet strings for ${MIN_PROFIT}+ gp profit at current prices` };
    if (Math.floor((coins + banked('Coins') - RESERVE) / Math.ceil(c.cost * OVERBID)) < PER_TRIP) {
      return { kind: 'impossible', reason: `coins (${coins + banked('Coins')}) do not buy ${PER_TRIP} ${c.unstrung} with wool` };
    }
    if (Math.floor((coins - RESERVE) / Math.ceil(c.cost * OVERBID)) < PER_TRIP) {
      return step('open the Grand Exchange bank to take out coins', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, [], { destination: GRAND_EXCHANGE_BANK });
    }
    return step(`open the Grand Exchange to buy ${c.unstrung} and balls of wool`, ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, [], { destination: GRAND_EXCHANGE });
  }
}
