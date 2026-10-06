/**
 * Purchases are sized from wiki prices, but ge_buy pays the client's guide price +30% and refuses
 * an order the carried coins do not cover ("not_enough_coins (need X, have Y)"). A refused order
 * shrinks the next one by have/need (with a margin) instead of being repeated until the run ends.
 */
import type { SubGoalReport } from '../planner/types.ts';

const REFUSED = /not_enough_coins \(need (\d+), have (\d+)\)/;

export class BuyScale {
  private factor = 1;

  /** Updates from the latest report; returns the factor to multiply the next quantity by. */
  update(last: SubGoalReport | undefined): number {
    const m = last && last.result !== 'done' ? REFUSED.exec(last.reason) : null;
    if (m) this.factor = Math.max(0.05, this.factor * (Number(m[2]) / Number(m[1])) * 0.95);
    return this.factor;
  }
}
