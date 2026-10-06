/**
 * Prerequisites resolver: an activity's needs plus the live account -> the setup phases that meet
 * them, in order, with a time estimate. Skills and quests go through the plan compiler's
 * requirement resolution; tools and consumables are bought (coins first, from a money route whose
 * products are then sold); food is fished and cooked; input materials are produced by their
 * gathering activity.
 *
 * Pure: everything comes from the profile and item counts, so it is tested offline and the
 * caller decides whether the setup is worth its time.
 */
import { requirementMilestones } from '../goalplan/compiler.ts';
import { KIT_PRICES, MIN_VIABLE_SUPPLY } from '../planner/kit.ts';
import { STARTER_KIT, classifyGear, fillsSlot, gearCandidates } from '../planner/gear.ts';
import { type Profile, unmet } from '../strategy/account.ts';
import { ACQUIRE, type AcquireSource, MONEY, type MoneyRoute } from '../strategy/catalog.ts';
import type { Phase } from '../strategy/StrategyPlanner.ts';
import { type ActivityNeeds, activityNeeds, foodCount } from './needs.ts';

export interface SetupStep {
  phase: Phase;
  minutes: number;
  why: string;
  /** A gear upgrade: worth doing, but dropped first when the setup runs over its time budget. */
  optional?: boolean;
}

export interface Setup {
  steps: SetupStep[];
  /** Needs nothing can meet from here (members-only, no method, no money route). */
  blocked: string[];
  minutes: number;
}

export interface AccountView {
  profile: Profile;
  /** Item name -> count, carried + worn + last seen banked. */
  counts: Map<string, number>;
}

export interface ResolveOptions {
  /** Phase ids that kept failing (skip memory). */
  skip?: Set<string>;
  /** Cheapest reachable shop for an item (KB stock + SHOP_LOCATIONS); used when ACQUIRE has none. */
  shop?: (item: string) => { source: AcquireSource; price: number } | null;
  /** Grand Exchange price of an item; the GE is used when it is cheaper than the shops. */
  gePrice?: (item: string) => number | null;
}

/** Cooked food to aim for when fishing for it. */
const FOOD_BATCH = 20;
/** Minutes per shop trip (walk, trade, back). */
const SHOP_MINUTES = 6;
const SELL_MINUTES = 8;
/** Minutes per GE purchase: several are bought on one visit. */
const GE_MINUTES = 3;

const a = (noun: string) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

const owns = (v: AccountView, suffix: string) => [...v.counts.keys()].some((n) => n.toLowerCase() === suffix || n.toLowerCase().endsWith(` ${suffix}`));

/** `cost`: coins to carry (a GE offer is placed 30% over the guide); `value`: what it really costs. */
function acquireStep(item: string, count: number, why: string, o: ResolveOptions): { step: SetupStep; cost: number; value: number } | null {
  const a = ACQUIRE.find((x) => x.item === item) ?? (() => {
    const s = o.shop?.(item);
    const ge = o.gePrice?.(item);
    // GE offers are placed 30% over the guide price (the difference comes back when they fill).
    if (ge && (!s || ge * 1.3 < s.price)) return { price: ge, source: { kind: 'ge' } as AcquireSource };
    return s ? { price: s.price, source: s.source } : undefined;
  })();
  if (!a) return null;
  const cost = Math.ceil(a.price * count * (a.source.kind === 'ge' ? 1.3 : 1));
  return {
    cost,
    value: a.price * count,
    step: { phase: { id: `acquire:${item}`, text: `buy ${count} ${item}`, exec: { kind: 'acquire', item, count, source: a.source, price: a.price } }, minutes: a.source.kind === 'ge' ? GE_MINUTES : SHOP_MINUTES, why },
  };
}

/** Coins it takes to start a ranged/magic kit that lasts more than one fight. */
function kitCost(style: 'ranged' | 'magic', v: AccountView): number {
  const weaponOwned = [...v.counts.keys()].some((n) => classifyGear(n, style)?.slot === 'weapon' && classifyGear(n, style)!.score > 0);
  const weapon = weaponOwned ? 0 : (KIT_PRICES[STARTER_KIT[style].weapon]?.price ?? 0);
  const supply = MIN_VIABLE_SUPPLY * 5;
  if (style === 'ranged') {
    const arrows = [...v.counts].filter(([n]) => classifyGear(n, 'ranged')?.slot === 'ammo').reduce((s, [, q]) => s + q, 0);
    return arrows >= MIN_VIABLE_SUPPLY ? weapon : Math.ceil((weapon + supply * (KIT_PRICES['Bronze arrow']?.price ?? 1)) * 1.3);
  }
  const casts = Math.min(v.counts.get('Air rune') ?? 0, v.counts.get('Mind rune') ?? 0);
  const perCast = (KIT_PRICES['Air rune']?.price ?? 4) + (KIT_PRICES['Mind rune']?.price ?? 3);
  return casts >= MIN_VIABLE_SUPPLY ? weapon : Math.ceil((weapon + supply * perCast) * 1.3);
}

/** Combat levels above a money route's requirement before fighting there. */
const COMBAT_MARGIN = 15;

const gearLevels = (v: AccountView) => {
  const lv = (k: string) => v.profile.levels.get(k) ?? 1;
  return { attack: lv('Attack'), defence: lv('Defence'), ranged: lv('Ranged'), magic: lv('Magic') };
};

/** Every required gear slot holds something usable. */
function gearMet(n: ActivityNeeds, v: AccountView): boolean {
  if (!n.gear) return true;
  const levels = gearLevels(v);
  return n.gear.slots.every((slot) => [...v.counts.keys()].some((name) => fillsSlot(name, slot, n.gear!.style, levels)));
}

/** The best money route this account can run with nothing to buy first, or null. */
function moneyRoute(v: AccountView, skip: Set<string>): MoneyRoute | null {
  const ok = MONEY.filter((r) => {
    if ((r.members && !v.profile.account.members) || skip.has(`money:${r.id}`) || r.exec.kind === 'llm' || !r.products.length) return false;
    if (unmet(r.req, v.profile).length) return false;
    // Fights for money need a margin over the requirement: moss giants at combat 40 in bronze kill.
    if (r.exec.kind === 'combat' && v.profile.combatLevel < (r.req?.combat ?? 0) + COMBAT_MARGIN) return false;
    const n = activityNeeds(r.exec);
    return !n || (n.tools.every((t) => owns(v, t.any)) && foodCount(v.counts) >= n.food && !n.style && gearMet(n, v));
  });
  return ok.sort((a, b) => b.gpHour - a.gpHour)[0] ?? null;
}

function coinSteps(amount: number, v: AccountView, skip: Set<string>, why: string): SetupStep[] | null {
  const route = moneyRoute(v, skip);
  if (!route) return null;
  const minutes = Math.min(45, Math.max(10, Math.ceil((amount / route.gpHour) * 60 * 1.5)));
  return [
    { phase: { id: `money:${route.id}`, text: `${route.name} (for ${amount} coins)`, exec: route.exec, maxMs: minutes * 60_000 }, minutes, why },
    { phase: { id: `sell:${route.id}`, text: `sell the ${route.products.join(', ')} on the Grand Exchange`, exec: { kind: 'sell', items: route.products } }, minutes: SELL_MINUTES, why: 'turn the products into coins' },
  ];
}

export function resolveSetup(needs: ActivityNeeds, v: AccountView, o: ResolveOptions = {}): Setup {
  const skip = o.skip ?? new Set<string>();
  const acquire = (item: string, count: number, why: string) => acquireStep(item, count, why, o);
  const steps: SetupStep[] = [];
  const blocked: string[] = [];
  const buys: { step: SetupStep; cost: number; value: number }[] = [];
  let coinsNeeded = 0;

  // 1. Levels, quests, quest points, combat level, catalog items: the plan compiler's resolution.
  const req = requirementMilestones(needs.req, v.profile, { skip });
  blocked.push(...req.blocked);
  for (const m of req.milestones) {
    if (m.kind === 'coins') {
      coinsNeeded += (m.untilCoins ?? v.profile.coins) - v.profile.coins;
      continue;
    }
    steps.push({ phase: { id: m.id, text: m.text, exec: m.exec, until: m.until }, minutes: Math.ceil(m.hours * 60), why: m.why });
  }

  // 2. Tools, then 3. consumables.
  for (const t of needs.tools) {
    if (owns(v, t.any)) continue;
    const b = acquire(t.buy, 1, `${needs.name} needs ${a(t.any)}`);
    if (b) buys.push(b);
    else blocked.push(`no way to get ${a(t.any)}`);
  }
  for (const s of needs.supplies) {
    if ((v.counts.get(s.item) ?? 0) >= s.min) continue;
    const b = acquire(s.item, s.buy, `${needs.name} uses ${s.item}`);
    if (b) buys.push(b);
    else blocked.push(`no way to get ${s.item}`);
  }

  // 4a. Gear: every required slot holds something usable for the style; otherwise buy the best
  // tier that costs at most a third of the coins owned, or the cheapest when none does.
  const upgrades: { step: SetupStep; cost: number; value: number }[] = [];
  if (needs.gear) {
    const levels = gearLevels(v);
    const style = needs.gear.style;
    let spare = v.profile.coins;
    for (const slot of needs.gear.slots) {
      const owned = [...v.counts.keys()].filter((n) => fillsSlot(n, slot, style, levels)).map((n) => classifyGear(n, style)!.score);
      if (!owned.length) {
        const options = gearCandidates(slot, levels).map((item) => acquire(item, 1, `${needs.name}: nothing to wear in the ${slot} slot`)).filter((b) => b !== null);
        const pick = options.find((b) => b.cost * 3 <= v.profile.coins) ?? options.sort((a, b) => a.cost - b.cost)[0];
        if (pick) {
          buys.push(pick);
          spare -= pick.value;
        }
        continue;
      }
      // 4b. Upgrades: the levels allow a better tier than the best owned piece. Buy the best one
      // that costs at most a third of the coins, from what is left after the required purchases;
      // never earned first, and dropped when the setup runs over its time budget.
      if (style !== 'melee') continue;
      const best = Math.max(...owned);
      const better = gearCandidates(slot, levels).filter((item) => (classifyGear(item, style)?.score ?? 0) >= best + 10);
      for (const item of better) {
        const b = acquire(item, 1, `${needs.name}: ${item} beats the ${slot} owned`);
        if (!b || b.value * 3 > v.profile.coins || b.cost > spare) continue;
        b.step.optional = true;
        upgrades.push(b);
        spare -= b.value;
        break;
      }
    }
  }

  // 4c. Ranged/magic kit: the activity's kit planner buys it; make sure the coins are there.
  if (needs.style) coinsNeeded += kitCost(needs.style, v);

  // 5. Food: fish and cook shrimps (no coins needed beyond a net, axe and tinderbox).
  const food = foodCount(v.counts);
  if (food < needs.food) {
    for (const t of activityNeeds({ kind: 'preset', preset: 'cook-shrimps' })!.tools.concat(activityNeeds({ kind: 'preset', preset: 'fish-shrimp' })!.tools)) {
      if (owns(v, t.any) || buys.some((b) => b.step.phase.id === `acquire:${t.buy}`)) continue;
      const b = acquire(t.buy, 1, `fishing and cooking food needs ${a(t.any)}`);
      if (b) buys.push(b);
    }
    const raw = v.counts.get('Raw shrimps') ?? 0;
    if (raw + food < FOOD_BATCH) {
      steps.push({ phase: { id: 'food:fish-shrimp', text: 'catch shrimp for food', exec: { kind: 'preset', preset: 'fish-shrimp', bank: true }, maxMs: 15 * 60_000 }, minutes: 15, why: `${needs.name} needs ${needs.food}+ food (have ${food})` });
    }
    steps.push({ phase: { id: 'food:cook-shrimps', text: 'cook the shrimp for food', exec: { kind: 'preset', preset: 'cook-shrimps' }, maxMs: 15 * 60_000 }, minutes: 10, why: 'cooked food for combat' });
  }

  // 6. Input materials (raw fish to cook, ore to smith), produced by their gathering activity.
  for (const i of needs.inputs) {
    if ((v.counts.get(i.item) ?? 0) >= i.min) continue;
    const sub = activityNeeds(i.produce);
    for (const t of sub?.tools ?? []) {
      if (owns(v, t.any) || buys.some((b) => b.step.phase.id === `acquire:${t.buy}`)) continue;
      const b = acquire(t.buy, 1, `getting ${i.item} needs ${a(t.any)}`);
      if (b) buys.push(b);
    }
    steps.push({ phase: { id: `input:${i.item}`, text: `gather ${i.item}`, exec: i.produce, maxMs: i.minutes * 60_000 }, minutes: i.minutes, why: `${needs.name} uses ${i.item}` });
  }

  // Setup phases have tools of their own (training Woodcutting needs an axe).
  for (const st of steps) {
    for (const t of activityNeeds(st.phase.exec)?.tools ?? []) {
      if (owns(v, t.any) || buys.some((b) => b.step.phase.id === `acquire:${t.buy}`)) continue;
      const b = acquire(t.buy, 1, `${st.phase.text} needs ${a(t.any)}`);
      if (b) buys.push(b);
      else blocked.push(`no way to get ${a(t.any)}`);
    }
  }

  // Coins for every purchase, earned first.
  coinsNeeded += buys.reduce((s, b) => s + b.cost, 0);
  const prefix: SetupStep[] = [];
  if (coinsNeeded > v.profile.coins) {
    const earn = coinSteps(coinsNeeded - v.profile.coins, v, skip, `${coinsNeeded} coins needed, ${v.profile.coins} owned`);
    if (earn) prefix.push(...earn);
    else blocked.push(`${coinsNeeded} coins (no money route fits this account)`);
  }
  // Buying comes before the rest: fishing for food needs the net it buys. Upgrades only when
  // nothing has to be earned first.
  const extra: SetupStep[] = [];
  // The GE overbid comes back once an offer fills, so the upgrades are paid at their value.
  for (const u of prefix.length ? [] : upgrades) {
    if (coinsNeeded + u.value > v.profile.coins) continue;
    coinsNeeded += u.value;
    extra.push(u.step);
  }
  const all = [...prefix, ...buys.map((b) => b.step), ...extra, ...steps];
  return { steps: all, blocked, minutes: all.reduce((s, x) => s + x.minutes, 0) };
}
