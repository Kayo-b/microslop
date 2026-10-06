/**
 * Buy cowhides, tan them into leather at Ellis in Al Kharid, sell the leather: a scripted loop
 * that turns coins into more coins (~95 gp a hide at 2026-10 prices).
 *
 *   Grand Exchange: sell carried leather, buy a stack of hides (collected as notes)
 *   -> Al Kharid bank: deposit the notes, withdraw 27 hides (coins stay carried)
 *   -> Ellis: Trade, "Tan All" leather (1 gp each) -> bank the leather -> repeat
 *   -> no hides left: withdraw the leather as notes -> Grand Exchange
 *
 * Each call looks at the snapshot and returns one step: a direct action when an interface is open
 * (bank, GE), a sub-goal for the walking and talking in between. Gives up when coins cannot buy a
 * useful batch or the margin is gone.
 */
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { carriedCoins, GRAND_EXCHANGE_BANK } from './SellPlanner.ts';

/** A tile inside the bank (the booths themselves cannot be stood on). */
export const AL_KHARID_BANK = { name: 'Al Kharid bank', point: { x: 3270, y: 3166, plane: 0 } };
export const ELLIS = { name: 'Al Kharid tannery', point: { x: 3273, y: 3192, plane: 0 } };

const HIDE = 'Cowhide';
const LEATHER = 'Leather';
/** The tanner's name for the 1 gp cowhide -> leather option. */
const TAN_OPTION = 'Soft leather';
/** Coins kept back from hide purchases: tanning fees and the toll gate. */
const RESERVE = 500;
/** GE offers are placed at the guide price +30%; a little more covers price drift. */
const OVERBID = 1.35;
/** Hides per GE purchase: enough for ~10 tanning trips, so a round trip to the GE pays off. */
const MAX_BUY = 270;
/** Fewer hides than this are not worth the walk. */
const MIN_BUY = 27;

export interface TanningOptions {
  /** Bank contents last seen before this run (name -> count); null when never seen. */
  bank?: () => Map<string, number> | null;
  /** GE price of an item; defaults keep the loop running without the price feed. */
  price?: (item: string) => number | null;
}

interface Held {
  hides: number;
  hideNotes: number;
  leather: number;
  leatherNotes: number;
  coins: number;
}

function held(s: Snapshot): Held {
  const count = (name: string, noted: boolean) =>
    s.inventory.items.filter((i) => i.name === name && Boolean(i.noted) === noted).reduce((n, i) => n + i.quantity, 0);
  return { hides: count(HIDE, false), hideNotes: count(HIDE, true), leather: count(LEATHER, false), leatherNotes: count(LEATHER, true), coins: carriedCoins(s) };
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins', HIDE, LEATHER], ...extra } };
}

export class TanningPlanner implements Planner {
  readonly name = 'tan-hides';
  private readonly o: TanningOptions;
  /** The bank as this planner last saw it open. */
  private seen: Map<string, number> | null = null;

  constructor(o: TanningOptions) {
    this.o = o;
  }

  private hidePrice(): number {
    return this.o.price?.(HIDE) ?? 131;
  }

  /** Hides the carried coins buy, after the reserve, at the GE overbid. */
  private affordable(coins: number): number {
    return Math.max(0, Math.min(MAX_BUY, Math.floor((coins - RESERVE) / Math.ceil(this.hidePrice() * OVERBID))));
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    const h = held(s);
    if (s.bank.open) this.seen = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    const bank = this.seen ?? this.o.bank?.() ?? null;
    const bankHides = bank?.get(HIDE) ?? 0;
    const bankLeather = bank?.get(LEATHER) ?? 0;
    const bankCoins = bank?.get('Coins') ?? 0;

    const margin = (this.o.price?.(LEATHER) ?? 227) * 0.98 - this.hidePrice() - 1;
    const hidesAnywhere = h.hides + h.hideNotes + bankHides;
    if (margin <= 0 && hidesAnywhere === 0 && h.leather + h.leatherNotes + bankLeather === 0) {
      return { kind: 'impossible', reason: `tanning makes no profit at current prices (${Math.round(margin)} gp a hide)` };
    }

    // The tanner's interface: tan every carried hide.
    if (s.production.open && s.production.interface === 'tanning') {
      if (h.hides > 0) return { kind: 'act', action: { op: 'production_select', option: TAN_OPTION }, reason: `tan ${h.hides} cowhides into leather` };
      return step('bank the leather at the Al Kharid bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 200, { destination: AL_KHARID_BANK });
    }

    if (s.grandExchange?.open) {
      if (h.leather + h.leatherNotes > 0) return { kind: 'act', action: { op: 'ge_sell', name: LEATHER }, reason: `sell ${h.leather + h.leatherNotes} leather` };
      const buy = this.affordable(h.coins);
      if (hidesAnywhere < MIN_BUY && buy >= MIN_BUY && margin > 0) {
        return { kind: 'act', action: { op: 'ge_buy', name: HIDE, quantity: buy }, reason: `buy ${buy} cowhides (~${Math.round(margin)} gp profit each)` };
      }
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    }

    if (s.bank.open) {
      // Everything but coins goes in: hide notes, leather, whatever the last activity left. Except
      // leather notes once no hides are left: those were just withdrawn to be sold (depositing them
      // again looped withdraw/deposit at the end of the first batch).
      const hidesLeft = h.hides > 0 || s.bank.items.some((b) => b.name === HIDE);
      const junk = s.inventory.items.find((i) => i.name !== 'Coins' && !(i.name === HIDE && !i.noted) && !(i.name === LEATHER && i.noted && !hidesLeft));
      if (junk) return { kind: 'act', action: { op: 'bank_deposit', itemId: junk.id, amount: 'all' }, reason: `deposit the ${junk.noted ? 'noted ' : ''}${junk.name}` };
      const hideStack = s.bank.items.find((b) => b.name === HIDE);
      if (h.hides === 0 && hideStack) {
        // Tanning costs 1 gp a hide; coins live in the inventory.
        const coinStack = s.bank.items.find((b) => b.name === 'Coins');
        if (h.coins < 27 && coinStack) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: 'all' }, reason: 'withdraw coins for the tanning fees' };
        return { kind: 'act', action: { op: 'bank_withdraw', itemId: hideStack.id, amount: Math.min(hideStack.quantity, s.inventory.freeSlots) }, reason: 'withdraw cowhides to tan' };
      }
      const leatherStack = s.bank.items.find((b) => b.name === LEATHER);
      if (h.hides === 0 && leatherStack) return { kind: 'act', action: { op: 'bank_withdraw', itemId: leatherStack.id, amount: 'all', noted: true }, reason: 'withdraw the leather as notes to sell' };
      // Coins for the next purchase, when most of them are banked.
      const coinStack = s.bank.items.find((b) => b.name === 'Coins');
      if (h.hides === 0 && coinStack && coinStack.quantity > h.coins) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: 'all' }, reason: 'withdraw coins to buy cowhides' };
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }

    if (h.hides > 0) {
      return step(`trade with Ellis at the Al Kharid tannery and tan all ${h.hides} cowhides into leather`, ['Ellis', TAN_OPTION], ['Trade', 'Tan All'], { lacksItem: HIDE }, 250, {
        destination: ELLIS,
        avoid: ['Tanning rack'],
      });
    }
    if (h.leather > 0 || h.hideNotes > 0) {
      return step('open the Al Kharid bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 400, { destination: AL_KHARID_BANK });
    }
    if (h.leatherNotes > 0) {
      return step('open the Grand Exchange to sell the leather', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 600, { destination: GRAND_EXCHANGE });
    }
    // Nothing carried: hides or leather in the bank (as last seen) come first.
    if (bank === null || bankHides > 0 || bankLeather > 0) {
      return step('open the Al Kharid bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 600, { destination: AL_KHARID_BANK });
    }
    if (this.affordable(h.coins + bankCoins) < MIN_BUY) {
      return { kind: 'impossible', reason: `coins (${h.coins + bankCoins}) do not buy ${MIN_BUY} cowhides` };
    }
    if (this.affordable(h.coins) < MIN_BUY) {
      return step('open the Grand Exchange bank to take out coins for cowhides', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 600, { destination: GRAND_EXCHANGE_BANK });
    }
    return step('open the Grand Exchange to buy cowhides', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 600, { destination: GRAND_EXCHANGE });
  }
}
