/**
 * Turns banked products into coins: withdraw them as notes at the Grand Exchange bank, sell each on
 * the Grand Exchange (70% of the guide price, so the offer fills at once; see the `ge_sell` action)
 * and bank nothing back: the coins stay carried. Completes when none of the products is carried or
 * banked.
 */
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { geLosesToShop, sellValue } from './sellValue.ts';

/** The bank booths next to the Grand Exchange clerks. */
export const GRAND_EXCHANGE_BANK = { name: 'Grand Exchange bank', point: { x: 3164, y: 3489, plane: 0 } };

export interface SellOptions {
  /** Item names to sell (exact, unnoted names). */
  items: string[];
  /** Bank contents last seen (name -> count); null when never seen. */
  bank: () => Map<string, number> | null;
  /** Value check: guide price and store value per item. Items the Grand Exchange would undersell are not sold there. */
  prices?: { guide: (item: string) => number | null; store: (item: string) => number | null; log?: (msg: string) => void };
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins'], ...extra } };
}

export class SellPlanner implements Planner {
  readonly name: string;
  private readonly o: SellOptions;
  /** Products whose sale failed this run; not retried. */
  private readonly failed = new Set<string>();
  private readonly warned = new Set<string>();

  constructor(o: SellOptions) {
    this.o = o;
    this.name = `sell:${o.items.join(',')}`;
  }

  /** False (and noted once) when a general store would pay more than a quick Grand Exchange sale. */
  private worthSellingOnGe(item: string): boolean {
    const p = this.o.prices;
    if (!p) return true;
    const v = sellValue(p.guide(item), p.store(item));
    if (!geLosesToShop(v)) return true;
    if (!this.warned.has(item)) {
      this.warned.add(item);
      p.log?.(`[sell] ${item}: Grand Exchange nets ${v.ge ?? '?'} gp, a general store ${v.shop} gp: not selling it on the Grand Exchange`);
    }
    return false;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    const report = ctx.reports.at(-1);
    if (report?.result === 'blocked' && /ge_sell/.test(report.trail.join(' '))) {
      for (const item of this.o.items) if (report.trail.some((t) => t.includes(item))) this.failed.add(item);
    }
    const items = this.o.items.filter((i) => !this.failed.has(i) && this.worthSellingOnGe(i));
    const carried = items.filter((i) => s.inventory.items.some((x) => x.name === i));
    const bank = s.bank.open ? new Map(s.bank.items.map((b) => [b.name, b.quantity])) : this.o.bank();
    const banked = items.filter((i) => (bank?.get(i) ?? 0) > 0);

    if (s.grandExchange?.open) {
      const item = carried[0];
      if (item) return { kind: 'act', action: { op: 'ge_sell', name: item }, reason: `sell the ${item}` };
      if (!banked.length) return { kind: 'complete', reason: `sold ${items.join(', ')}` };
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange to fetch more from the bank' };
    }

    if (s.bank.open) {
      const b = s.bank.items.find((x) => banked.includes(x.name));
      // One noted stack per product; noted items take one slot each.
      if (b && s.inventory.freeSlots > 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: b.id, amount: 'all', noted: true }, reason: `withdraw all ${b.name} as notes to sell` };
      if (!carried.length) return { kind: 'complete', reason: `no ${items.join(', ')} left to sell` };
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank and go to the clerk' };
    }

    if (carried.length) {
      return step(`open the Grand Exchange to sell ${carried.join(', ')}`, ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, { destination: GRAND_EXCHANGE });
    }
    if (bank !== null && !banked.length) return { kind: 'complete', reason: `no ${items.join(', ')} left to sell` };
    return step(`open the Grand Exchange bank to fetch ${items.join(', ')} to sell`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, { destination: GRAND_EXCHANGE_BANK });
  }
}

/** Coins carried. */
export const carriedCoins = (s: Snapshot) => s.inventory.items.filter((i) => i.name === 'Coins').reduce((n, i) => n + i.quantity, 0);

/** Coins above this are banked before walking anywhere (a PK or a misclick would cost the stack). */
export const SAFE_CARRY = 10_000;

/** True within a short walk of the Grand Exchange bank: coins are only taken out of the bank here. */
export function nearGrandExchange(s: Snapshot, radius = 30): boolean {
  const p = s.player?.position;
  const b = GRAND_EXCHANGE_BANK.point;
  return !!p && p.plane === b.plane && Math.abs(p.x - b.x) <= radius && Math.abs(p.y - b.y) <= radius;
}
