/**
 * Buys an item a plan needs: fetch coins from the bank if the carried ones fall short, then buy it
 * at its shop or at the Grand Exchange (guide price +30%, see the `ge_buy` action). Completes as soon
 * as the item is carried, worn or seen in the bank.
 */
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { AcquireSource } from '../strategy/catalog.ts';
import type { Snapshot } from '../types.ts';

/** Where the Grand Exchange clerks stand. */
export const GRAND_EXCHANGE = { name: 'Grand Exchange', point: { x: 3164, y: 3487, plane: 0 } };

export interface AcquireOptions {
  item: string;
  count: number;
  /** Price per item (gp) before the GE markup. */
  price: number;
  source: AcquireSource;
  /** Bank contents last seen (name -> count); null when never seen. */
  bank: () => Map<string, number> | null;
}

const carried = (s: Snapshot, name: string) =>
  s.inventory.items.filter((i) => i.name === name).reduce((n, i) => n + i.quantity, 0) + s.equipment.filter((e) => e.name === name).reduce((n, e) => n + (e.quantity ?? 1), 0);

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins'], ...extra } };
}

export class AcquirePlanner implements Planner {
  readonly name: string;
  private readonly o: AcquireOptions;

  constructor(o: AcquireOptions) {
    this.o = o;
    this.name = `acquire:${o.item}`;
  }

  /** Coins the purchase needs. */
  get cost(): number {
    return Math.ceil(this.o.price * this.o.count * (this.o.source.kind === 'ge' ? 1.3 : 1));
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    const { item, count, source } = this.o;
    const bank = this.o.bank();
    const have = carried(s, item) + (bank?.get(item) ?? 0);
    if (have >= count) return { kind: 'complete', reason: `owns ${have} ${item}` };
    const want = [{ name: item, count: carried(s, item) + count - have }];
    const coins = carried(s, 'Coins');

    if (s.shop.open) {
      if (source.kind === 'shop' && s.shop.items.some((i) => i.name === item) && coins > 0) {
        return step(`buy ${count - have} ${item}`, [item], ['Buy'], { hasItem: { name: item, count: want[0]!.count, exact: true } }, 30, { want });
      }
      return step('close the shop', [], ['Close'], { shopOpen: false }, 5);
    }

    if (coins < this.cost) {
      const banked = bank?.get('Coins') ?? 0;
      if (s.bank.open) {
        if (banked + coins < this.cost) return { kind: 'impossible', reason: `${item} needs ${this.cost} coins; ${coins + banked} owned` };
        return step(`withdraw ${this.cost - coins} coins to buy ${item}`, ['Coins'], ['Withdraw'], { hasItem: { name: 'Coins', count: this.cost, exact: true } }, 20, { want: [{ name: 'Coins', count: this.cost }] });
      }
      if (bank !== null && banked + coins < this.cost) return { kind: 'impossible', reason: `${item} needs ${this.cost} coins; ${coins + banked} owned` };
      const near = this.nearestBank(ctx.kb, s);
      return step(`get coins for ${item} from the ${near?.name ?? 'nearest bank'}`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, near ? { destination: near } : {});
    }
    if (s.bank.open) return step('close the bank', ['Bank'], ['Close'], { bankOpen: false }, 5);

    if (source.kind === 'shop') {
      return step(`buy ${item} at ${source.name}`, [source.keeper], ['Trade'], { shopOpen: true }, 300, { destination: { name: source.name, point: source.point } });
    }
    return step(`buy ${count - have} ${item} at the Grand Exchange`, ['Grand Exchange Clerk', item], ['Exchange', 'Buy'], { hasItem: { name: item, count: want[0]!.count, exact: true } }, 300, {
      destination: GRAND_EXCHANGE,
      want,
    });
  }

  private nearestBank(kb: KnowledgeBase | null, s: Snapshot): { name: string; point: { x: number; y: number; plane: number } } | undefined {
    const pos = s.player?.position;
    const b = pos && kb ? kb.nearestBanks(pos, 3, false).find((x) => x.kind === 'bank') : undefined;
    return b ? { name: b.name, point: b.point } : undefined;
  }
}
