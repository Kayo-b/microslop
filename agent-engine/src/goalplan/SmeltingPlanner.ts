/**
 * Smelting for profit: mine iron ore and coal, smelt steel bars, bank them (SmithingPlanner in
 * smelt-only mode), and once enough bars are banked sell them at the Grand Exchange.
 */
import { SmithingPlanner } from '../planner/SmithingPlanner.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import { SellPlanner } from './SellPlanner.ts';

const BAR = 'Steel bar';
/** Bars banked before a selling trip (the GE is far from the mine). */
const SELL_AT = 200;

export class SmeltingPlanner implements Planner {
  readonly name = 'smelt-steel';
  private readonly smelt = new SmithingPlanner({ metal: 'steel', smeltOnly: true });
  private sell: SellPlanner | null = null;
  private bank: Map<string, number> | null = null;
  private reportsAt = 0;

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) this.bank = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    if (!this.sell && (this.bank?.get(BAR) ?? 0) >= SELL_AT) {
      this.sell = new SellPlanner({ items: [BAR], bank: () => this.bank });
      this.reportsAt = ctx.reports.length;
    }
    if (this.sell) {
      const step = await this.sell.next({ ...ctx, reports: ctx.reports.slice(this.reportsAt) });
      if (step.kind !== 'complete') return step;
      this.sell = null;
      this.bank?.delete(BAR);
    }
    return this.smelt.next(ctx);
  }
}
