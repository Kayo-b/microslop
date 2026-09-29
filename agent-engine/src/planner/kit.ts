/**
 * Ranged and magic kits: a weapon plus consumables (arrows, runes) that run out. Before fighting
 * with those styles the planner makes sure the kit is owned (buying it from Varrock shops within
 * the coins available), carried and worn, and for magic that the staff autocasts the spell.
 */
import type { Snapshot, WorldPoint } from '../types.ts';
import { compile } from './conditions.ts';
import { classifyGear, type CombatStyle, STARTER_KIT, wornScores } from './gear.ts';
import type { PlanStep } from './types.ts';

export interface Shop {
  name: string;
  keeper: string;
  point: WorldPoint;
}

export const SHOPS: Record<string, Shop> = {
  lowe: { name: "Lowe's Archery Emporium", keeper: 'Lowe', point: { x: 3232, y: 3423, plane: 0 } },
  zaff: { name: "Zaff's Superior Staffs", keeper: 'Zaff', point: { x: 3203, y: 3434, plane: 0 } },
  aubury: { name: "Aubury's Rune Shop", keeper: 'Aubury', point: { x: 3253, y: 3401, plane: 0 } },
};

/** Shop price (gp) and where to buy it. */
const PRICES: Record<string, { price: number; shop: Shop }> = {
  Shortbow: { price: 50, shop: SHOPS.lowe! },
  'Bronze arrow': { price: 1, shop: SHOPS.lowe! },
  'Iron arrow': { price: 3, shop: SHOPS.lowe! },
  Staff: { price: 15, shop: SHOPS.zaff! },
  'Air rune': { price: 4, shop: SHOPS.aubury! },
  'Mind rune': { price: 3, shop: SHOPS.aubury! },
};

/** Runes per cast of the spells the kit supports (modern spellbook, no elemental staff). */
export const SPELLS: { spell: string; magic: number; runes: Record<string, number> }[] = [
  { spell: 'WIND_STRIKE', magic: 1, runes: { 'Air rune': 1, 'Mind rune': 1 } },
];

export interface KitOptions {
  /** Below this many arrows or casts, restock. Default 50. */
  minSupply?: number;
  /** Buy up to this many arrows or casts at a time. Default 300. */
  maxBuy?: number;
}

export interface KitContext {
  /** Bank contents last seen (name -> count); null when not seen this run. */
  bank: Map<string, number> | null;
}

function count(s: Snapshot, bank: Map<string, number> | null, name: string, where: 'carried' | 'all'): number {
  const inv = s.inventory.items.filter((i) => i.name === name).reduce((n, i) => n + i.quantity, 0);
  const worn = s.equipment.filter((e) => e.name === name).reduce((n, e) => n + (e.quantity ?? 1), 0);
  return inv + worn + (where === 'all' ? (bank?.get(name) ?? 0) : 0);
}

const level = (s: Snapshot, skill: string) => s.skills.find((k) => k.name === skill)?.level ?? 1;

export interface KitPlan {
  /** Kit items to have carried or worn, with counts. */
  need: { name: string; count: number }[];
  /** What must be bought (not owned anywhere), with counts and total cost. */
  buy: { name: string; count: number; shop: Shop }[];
  cost: number;
  spell?: string;
}

/** What the style needs and what has to be bought, given the coins available. */
export function planKit(style: Exclude<CombatStyle, 'melee'>, s: Snapshot, kc: KitContext, opts: KitOptions = {}): KitPlan {
  const minSupply = opts.minSupply ?? 50;
  const maxBuy = opts.maxBuy ?? 300;
  const owned = new Set([...s.inventory.items.map((i) => i.name), ...s.equipment.map((e) => e.name), ...(kc.bank?.keys() ?? [])]);
  const coins = count(s, kc.bank, 'Coins', 'all');
  const need: KitPlan['need'] = [];
  const buy: KitPlan['buy'] = [];
  let cost = 0;

  const skill = style === 'ranged' ? 'Ranged' : 'Magic';
  const weapons = [...owned].map((n) => ({ n, g: classifyGear(n, style) })).filter((w) => w.g?.slot === 'weapon' && w.g.score > 0 && w.g.req <= level(s, skill));
  const weapon = weapons.sort((a, b) => b.g!.score - a.g!.score)[0]?.n;
  if (weapon) need.push({ name: weapon, count: 1 });
  else {
    const starter = STARTER_KIT[style].weapon;
    const p = PRICES[starter]!;
    buy.push({ name: starter, count: 1, shop: p.shop });
    need.push({ name: starter, count: 1 });
    cost += p.price;
  }

  if (style === 'ranged') {
    const arrows = [...owned].filter((n) => classifyGear(n, 'ranged')?.slot === 'ammo');
    const total = arrows.reduce((n, a) => n + count(s, kc.bank, a, 'all'), 0);
    const best = arrows.sort((a, b) => classifyGear(b, 'ranged')!.score - classifyGear(a, 'ranged')!.score)[0];
    if (total < minSupply) {
      const ammo = STARTER_KIT.ranged.ammo!;
      const n = Math.min(maxBuy, Math.max(0, coins - cost));
      if (n > 0) {
        buy.push({ name: ammo, count: n, shop: PRICES[ammo]!.shop });
        cost += n * PRICES[ammo]!.price;
      }
      need.push({ name: ammo, count: Math.min(n + count(s, kc.bank, ammo, 'all'), maxBuy) });
    } else if (best) {
      need.push({ name: best, count: Math.min(count(s, kc.bank, best, 'all'), maxBuy) });
    }
    return { need, buy, cost };
  }

  const spell = SPELLS.filter((sp) => sp.magic <= level(s, 'Magic')).at(-1)!;
  const casts = Math.min(...Object.entries(spell.runes).map(([rune, per]) => Math.floor(count(s, kc.bank, rune, 'all') / per)));
  const perCast = Object.entries(spell.runes).reduce((sum, [rune, per]) => sum + per * PRICES[rune]!.price, 0);
  let target = casts;
  if (casts < minSupply) {
    const n = Math.min(maxBuy - casts, Math.floor(Math.max(0, coins - cost) / perCast));
    for (const [rune, per] of Object.entries(spell.runes)) {
      const have = count(s, kc.bank, rune, 'all');
      const want = (casts + n) * per;
      if (want > have) {
        buy.push({ name: rune, count: want - have, shop: PRICES[rune]!.shop });
        cost += (want - have) * PRICES[rune]!.price;
      }
    }
    target = casts + n;
  }
  for (const [rune, per] of Object.entries(spell.runes)) need.push({ name: rune, count: Math.min(target, maxBuy) * per });
  return { need, buy, cost, spell: spell.spell };
}

function sub(text: string, targets: string[], actions: string[], doneWhen: Parameters<typeof compile>[0], maxSteps: number, keep: string[], extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep, ...extra } };
}

/**
 * Next step to get the kit ready, or null when it is: buy what is missing (fetching coins first),
 * take kit out of the bank, wear it, and set autocast.
 */
export function nextKitStep(style: Exclude<CombatStyle, 'melee'>, s: Snapshot, kc: KitContext, bank: { name: string; point: WorldPoint } | undefined, opts: KitOptions = {}): PlanStep | null {
  const kit = planKit(style, s, kc, opts);
  const keep = [...kit.need.map((n) => n.name), 'Coins'];
  const carried = (name: string) => count(s, null, name, 'carried');
  const invCoins = carried('Coins');
  const minSupply = opts.minSupply ?? 50;

  if (s.shop.open) {
    const here = kit.buy.filter((b) => s.shop.items.some((i) => i.name === b.name));
    if (here.length && invCoins > 0) {
      const want = here.map((b) => ({ name: b.name, count: carried(b.name) + b.count }));
      return sub(`buy ${here.map((b) => `${b.count} ${b.name}`).join(', ')}`, here.map((b) => b.name), ['Buy'], { hasItems: want }, 40, keep, { want });
    }
    return sub('close the shop', [], ['Close'], { shopOpen: false }, 5, keep);
  }

  if (s.bank.open) {
    const want: { name: string; count: number }[] = [];
    for (const n of kit.need) {
      if (carried(n.name) < n.count && (kc.bank?.get(n.name) ?? 0) > 0) want.push({ name: n.name, count: Math.min(n.count, carried(n.name) + kc.bank!.get(n.name)!) });
    }
    if (kit.cost > invCoins && (kc.bank?.get('Coins') ?? 0) > 0) want.push({ name: 'Coins', count: Math.min(kit.cost, invCoins + kc.bank!.get('Coins')!) });
    if (want.length) return sub(`withdraw ${want.map((w) => `${w.count} ${w.name}`).join(', ')} for ${style}`, want.map((w) => w.name), ['Withdraw'], { hasItems: want }, 30, keep, { want });
    return null;
  }

  if (kit.buy.length) {
    // Purchases are sized to the coins owned, so carrying the cost means all coins are on hand.
    if (invCoins >= kit.cost) {
      const shop = kit.buy[0]!.shop;
      const items = kit.buy.filter((b) => b.shop === shop);
      return sub(`buy ${items.map((b) => `${b.count} ${b.name}`).join(', ')} at ${shop.name}`, [shop.keeper], ['Trade'], { shopOpen: true }, 300, keep, { destination: { name: shop.name, point: shop.point } });
    }
    if (bank && (kc.bank === null || (kc.bank.get('Coins') ?? 0) > 0)) {
      return sub(`get ${kit.cost} coins for ${style} supplies at the ${bank.name}`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, keep, { destination: bank });
    }
    if (kit.cost > invCoins) return { kind: 'impossible', reason: `${style} kit needs ${kit.cost} coins; only ${invCoins} available` };
  }

  // Kit banked but not carried: fetch it.
  const banked = kit.need.filter((n) => carried(n.name) < Math.min(n.count, minSupply) && (kc.bank?.get(n.name) ?? 0) > 0);
  if (banked.length && bank) {
    return sub(`fetch ${banked.map((b) => b.name).join(', ')} from the ${bank.name}`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, keep, { destination: bank });
  }

  // Wear the weapon and ammo.
  const worn = wornScores(s, style);
  for (const n of kit.need) {
    const g = classifyGear(n.name, style);
    if (!g || (g.slot !== 'weapon' && g.slot !== 'ammo')) continue;
    const inInventory = s.inventory.items.filter((i) => i.name === n.name).reduce((sum, i) => sum + i.quantity, 0);
    const wearing = s.equipment.some((e) => e.name === n.name);
    // Picked-up arrows land in the inventory; add them back to the quiver once a handful pile up.
    const due = g.slot === 'ammo' && wearing ? inInventory >= 20 : inInventory > 0 && !wearing && g.score >= worn[g.slot];
    if (due) {
      return sub(`wield the ${n.name}`, [n.name], ['Wield', 'Wear'], { equipped: [n.name] }, 10, keep);
    }
  }
  if (style === 'magic' && kit.spell && s.player && s.player.autocast !== kit.spell) {
    return { kind: 'act', action: { op: 'autocast', spell: kit.spell }, reason: `autocast ${kit.spell.toLowerCase().replace('_', ' ')}` };
  }
  return null;
}
