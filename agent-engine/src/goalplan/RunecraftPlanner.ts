/**
 * Runecraft training from rune essence bought at the Grand Exchange: the free-to-play altars,
 * entered through their mysterious ruins with the matching talisman. Written after a live run where
 * the LLM planner tried to buy essence at Aubury's shop (it does not sell it), walked to the wrong
 * ruins (the generic name "Mysterious ruins" matched the nearest altar, not the planned one) and
 * spent 30 minutes on boats and shop windows.
 *
 *   Grand Exchange: buy talisman (once) + essence stock (notes) -> GE bank: deposit, withdraw 27
 *   -> walk to the ruins -> Enter -> Altar "Craft-rune" -> Portal "Use" -> repeat
 *
 * Every click that has a fixed object (ruins, altar, portal) is a direct action with the id and tile
 * from the knowledge base, so nothing depends on the classifier choosing between lookalikes.
 */
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot, WorldPoint } from '../types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { BuyScale } from './buyScale.ts';
import { carriedCoins, GRAND_EXCHANGE_BANK } from './SellPlanner.ts';

const ESSENCE = 'Rune essence';

export interface Altar {
  name: string;
  /** Lowest Runecraft level that crafts this rune. */
  level: number;
  talisman: string;
  ruins: { id: number; point: WorldPoint };
}

/** Free-to-play altars, the best the level allows first (Air from level 1: mind runes need level 2). Ruins ids/tiles are from the KB. */
export const ALTARS: Altar[] = [
  { name: 'Body', level: 20, talisman: 'Body talisman', ruins: { id: 34818, point: { x: 3052, y: 3444, plane: 0 } } },
  { name: 'Earth', level: 9, talisman: 'Earth talisman', ruins: { id: 34816, point: { x: 3305, y: 3473, plane: 0 } } },
  { name: 'Mind', level: 2, talisman: 'Mind talisman', ruins: { id: 34814, point: { x: 2981, y: 3513, plane: 0 } } },
  { name: 'Air', level: 1, talisman: 'Air talisman', ruins: { id: 34813, point: { x: 2984, y: 3291, plane: 0 } } },
];

export function altarFor(level: number): Altar {
  return ALTARS.find((a) => level >= a.level) ?? ALTARS.at(-1)!;
}

export interface RunecraftOptions {
  price: (item: string) => number | null;
  /** Essence bought per Grand Exchange visit (a stock for many trips). Default 540. */
  stock?: number;
}

const RESERVE = 300;
const OVERBID = 1.32;
const TRIP = 27;

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins', ESSENCE, 'talisman'], ...extra } };
}

const dist = (a: WorldPoint, b: WorldPoint) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

export class RunecraftPlanner implements Planner {
  readonly name = 'runecraft';
  private readonly o: RunecraftOptions;
  private seen: Map<string, number> | null = null;
  private readonly scale = new BuyScale();

  constructor(o: RunecraftOptions) {
    this.o = o;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s: Snapshot = ctx.snapshot;
    if (s.bank.open) this.seen = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
    const bank = this.seen;
    const me = s.player?.position;
    const level = s.skills.find((k) => k.name === 'Runecraft')?.level ?? 1;
    const altar = altarFor(level);
    const count = (name: string, noted?: boolean) => s.inventory.items.filter((i) => i.name === name && (noted === undefined || Boolean(i.noted) === noted)).reduce((n, i) => n + i.quantity, 0);
    const banked = (name: string) => bank?.get(name) ?? 0;
    const essence = count(ESSENCE, false);
    const talisman = count(altar.talisman, false);

    // Inside an altar (the interiors lie far below the map's y): craft, then leave.
    if (me && me.y >= 4000) {
      if (essence > 0) {
        const a = s.objects.find((o) => o.name === 'Altar' && o.actions.includes('Craft-rune'));
        if (!a) return { kind: 'wait', reason: 'waiting for the altar to load', until: { objectNear: { name: 'Altar', radius: 20 } }, maxSeconds: 6 };
        if (s.player?.animating || s.player?.moving) return { kind: 'wait', reason: 'crafting', until: { lacksItem: ESSENCE }, maxSeconds: 8 };
        return { kind: 'act', action: { op: 'interact', target: { kind: 'object', id: a.id, x: a.position.x, y: a.position.y, plane: a.position.plane }, action: 'Craft-rune' }, reason: `craft ${altar.name.toLowerCase()} runes` };
      }
      const portal = s.objects.find((o) => o.name === 'Portal' && o.actions.includes('Use'));
      if (!portal) return { kind: 'wait', reason: 'waiting for the portal to load', until: { objectNear: { name: 'Portal', radius: 20 } }, maxSeconds: 6 };
      return { kind: 'act', action: { op: 'interact', target: { kind: 'object', id: portal.id, x: portal.position.x, y: portal.position.y, plane: portal.position.plane }, action: 'Use' }, reason: 'leave the altar through the portal' };
    }

    // Ready: essence and the talisman in hand.
    if (essence > 0 && talisman > 0 && !s.bank.open && !s.grandExchange?.open) {
      const r = altar.ruins;
      if (me && me.plane === r.point.plane && dist(me, r.point) <= 5 && !s.player?.moving) {
        // Using the talisman on the ruins is what opens them; the plain "Enter" click did nothing live.
        const tal = s.inventory.items.find((i) => i.name === altar.talisman && !i.noted)!;
        return { kind: 'act', action: { op: 'use_item_on', itemSlot: tal.slot, target: { kind: 'object', id: r.id, x: r.point.x, y: r.point.y, plane: r.point.plane } }, reason: `use the ${altar.talisman} on the ${altar.name.toLowerCase()} altar ruins` };
      }
      return step(`walk to the ${altar.name.toLowerCase()} altar ruins`, [], [], { near: { ...r.point, radius: 4 } }, 150, { destination: { name: `${altar.name} altar ruins`, point: r.point } });
    }

    const coins = carriedCoins(s);
    const need = (name: string) => count(name) + banked(name);
    const price = this.o.price(ESSENCE) ?? 20;

    if (s.grandExchange?.open) {
      const scale = this.scale.update(ctx.reports.at(-1));
      if (need(altar.talisman) === 0) return { kind: 'act', action: { op: 'ge_buy', name: altar.talisman, quantity: 1 }, reason: `buy the ${altar.talisman}` };
      if (need(ESSENCE) < TRIP) {
        const n = Math.min(this.o.stock ?? 540, Math.floor(((coins - RESERVE) * scale) / Math.ceil(price * OVERBID)));
        if (n >= TRIP) return { kind: 'act', action: { op: 'ge_buy', name: ESSENCE, quantity: n }, reason: `buy ${n} rune essence` };
        return { kind: 'impossible', reason: `coins (${coins}) do not buy ${TRIP} rune essence` };
      }
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    }

    if (s.bank.open) {
      const keepNames = [ESSENCE, altar.talisman, 'Coins'];
      const junk = s.inventory.items.find((i) => i.noted || !keepNames.includes(i.name));
      if (junk) return { kind: 'act', action: { op: 'bank_deposit', itemId: junk.id, amount: 'all' }, reason: `deposit the ${junk.noted ? 'noted ' : ''}${junk.name}` };
      const tal = s.bank.items.find((b) => b.name === altar.talisman);
      if (tal && talisman === 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: tal.id, amount: 1 }, reason: `withdraw the ${altar.talisman}` };
      const ess = s.bank.items.find((b) => b.name === ESSENCE);
      const want = Math.min(TRIP - essence, ess?.quantity ?? 0, s.inventory.freeSlots);
      if (ess && want > 0) return { kind: 'act', action: { op: 'bank_withdraw', itemId: ess.id, amount: want }, reason: 'withdraw rune essence' };
      const coinStack = s.bank.items.find((b) => b.name === 'Coins');
      if (essence === 0 && banked(ESSENCE) < TRIP && coinStack && coinStack.quantity > coins) {
        return { kind: 'act', action: { op: 'bank_withdraw', itemId: coinStack.id, amount: 'all' }, reason: 'withdraw coins to buy essence' };
      }
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }

    // Outside with nothing ready: stock up. Banked stock first; otherwise buy at the Grand Exchange.
    const noted = count(ESSENCE, true) > 0 || count(altar.talisman, true) > 0;
    if (noted || bank === null || (banked(ESSENCE) >= TRIP && banked(altar.talisman) + talisman > 0) || (essence > 0 && talisman === 0 && banked(altar.talisman) > 0)) {
      return step('open the Grand Exchange bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, { destination: GRAND_EXCHANGE_BANK });
    }
    if (need(ESSENCE) < TRIP || need(altar.talisman) === 0) {
      if (coins - RESERVE < TRIP * Math.ceil(price * OVERBID)) {
        return step('open the Grand Exchange bank to take out coins', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, { destination: GRAND_EXCHANGE_BANK });
      }
      return step('open the Grand Exchange to buy rune essence and a talisman', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 300, { destination: GRAND_EXCHANGE });
    }
    return step('open the Grand Exchange bank', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, { destination: GRAND_EXCHANGE_BANK });
  }
}
