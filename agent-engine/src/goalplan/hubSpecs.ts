/**
 * Microbot Hub plugins as training methods (driven by HubPluginPlanner). Each spec picks the
 * plugin's settings and supplies from the account's levels, coins and live GE prices.
 *
 * Jars: <client home>/.runelite/microbot-plugins/<InternalName>.jar from
 * github.com/chsami/Microbot-Hub releases (sha256 in the hub's plugins.json).
 */
import type { HubRun, HubSpec } from './HubPluginPlanner.ts';

const PKG = 'net.runelite.client.plugins.microbot';
const GE_BANK = { name: 'Grand Exchange bank', point: { x: 3164, y: 3489, plane: 0 }, radius: 10 };

// --- Magic: Low/High Level Alchemy (AIO Magic) ------------------------------------------------

/**
 * Items worth alching: low alchemy value (high = 1.5x). Members items do nothing on free worlds.
 * Only items whose GE buy limit (per 4 h) covers a batch: steel platebodies alch at a profit too,
 * but the limit is 125.
 */
export const ALCH_ITEMS: { name: string; low: number; members: boolean }[] = [
  { name: 'Rune arrow', low: 160, members: true },
  { name: 'Yew longbow (u)', low: 256, members: true },
  { name: 'Amethyst arrow', low: 196, members: true },
  { name: 'Maple longbow (u)', low: 128, members: true },
  { name: 'Gold bar', low: 120, members: false },
];
const ALCH_BATCH = 2000;

/** The alch item with the smallest loss (or best profit) per cast at current prices, nature rune included. */
export function bestAlch(level: number, members: boolean, price: (item: string) => number | null): { name: string; perCast: number } | null {
  const nature = price('Nature rune') ?? 140;
  const high = level >= 55;
  let best: { name: string; perCast: number } | null = null;
  for (const it of ALCH_ITEMS) {
    if (it.members && !members) continue;
    const p = price(it.name);
    if (p === null) continue;
    const perCast = Math.floor(it.low * (high ? 1.5 : 1)) - p - nature;
    if (!best || perCast > best.perCast) best = { name: it.name, perCast };
  }
  return best;
}

export const ALCH: HubSpec = {
  id: 'alch',
  className: `${PKG}.aiomagic.AIOMagicPlugin`,
  group: 'aio-magic',
  skill: 'Magic',
  stallMinutes: 3,
  plan: ({ level, coins, owned, price, members }) => {
    if (level < 21) return 'Low Level Alchemy needs Magic 21';
    // Items already owned go first (char 1's gold bars), then the best buy.
    const pick = ALCH_ITEMS.find((i) => (!i.members || members) && owned(i.name) >= 50) ?? bestAlch(level, members, price);
    if (!pick) return 'no GE prices for the alch items';
    const each = (price(pick.name) ?? 0) + (price('Nature rune') ?? 140);
    const batch = Math.max(100, Math.min(ALCH_BATCH, Math.floor((coins - 50_000) / Math.max(1, each * 1.3))));
    return {
      label: `${level >= 55 ? 'High' : 'Low'} Level Alchemy on ${pick.name}`,
      config: { magicActivity: 'ALCHING', alchItems: pick.name },
      supplies: [
        { name: 'Staff of fire', want: 1, anyOf: ['staff of fire', 'fire battlestaff', 'mystic fire staff'] },
        { name: 'Nature rune', want: batch, min: 30 },
        { name: pick.name, want: batch, min: 30 },
      ],
      sell: [],
      carry: [{ name: pick.name, noted: true }, { name: 'Nature rune' }],
      wear: ['Staff of fire'],
      start: GE_BANK,
    };
  },
};

// --- Agility: rooftop courses (Micro Agility) --------------------------------------------------

export const ROOFTOPS: { level: number; course: string; name: string; point: { x: number; y: number; plane: number } }[] = [
  { level: 60, course: 'SEERS_VILLAGE_ROOFTOP_COURSE', name: "Seers' Village rooftop course", point: { x: 2729, y: 3486, plane: 0 } },
  { level: 50, course: 'FALADOR_ROOFTOP_COURSE', name: 'Falador rooftop course', point: { x: 3036, y: 3341, plane: 0 } },
  { level: 40, course: 'CANIFIS_ROOFTOP_COURSE', name: 'Canifis rooftop course', point: { x: 3507, y: 3489, plane: 0 } },
  { level: 30, course: 'VARROCK_ROOFTOP_COURSE', name: 'Varrock rooftop course', point: { x: 3221, y: 3414, plane: 0 } },
  { level: 20, course: 'AL_KHARID_ROOFTOP_COURSE', name: 'Al Kharid rooftop course', point: { x: 3273, y: 3195, plane: 0 } },
  { level: 10, course: 'DRAYNOR_VILLAGE_ROOFTOP_COURSE', name: 'Draynor Village rooftop course', point: { x: 3103, y: 3279, plane: 0 } },
];

export const AGILITY: HubSpec = {
  id: 'agility',
  className: `${PKG}.agility.MicroAgilityPlugin`,
  group: 'MicroAgility',
  skill: 'Agility',
  stallMinutes: 4,
  plan: ({ level, members }) => {
    if (!members) return 'rooftop courses are members-only';
    const c = ROOFTOPS.find((r) => level >= r.level);
    if (!c) return 'rooftop courses start at Agility 10';
    return { label: c.name, config: { course: c.course, shouldAlch: 'false' }, supplies: [], sell: [], start: { name: c.name, point: c.point, radius: 10 } };
  },
};

// --- Runecraft: Guardians of the Rift ----------------------------------------------------------

/** Runes kept for training (alching, spells); the rest of what the rift pays out is sold. */
const GOTR_SOLD = ['Air rune', 'Mind rune', 'Water rune', 'Earth rune', 'Body rune', 'Cosmic rune', 'Chaos rune', 'Law rune', 'Death rune', 'Blood rune'];
const PICKAXES = ['Rune pickaxe', 'Adamant pickaxe', 'Mithril pickaxe', 'Steel pickaxe', 'Iron pickaxe', 'Bronze pickaxe'];

export const GOTR: HubSpec = {
  id: 'gotr',
  className: `${PKG}.gotr.GotrPlugin`,
  group: 'gotr',
  skill: 'Runecraft',
  // A round lasts ~10 minutes with a few minutes of lobby between rounds.
  stallMinutes: 12,
  plan: ({ level, levels, owned }) => {
    if (level < 27) return 'Guardians of the Rift needs Runecraft 27';
    // The plugin only needs a pickaxe in the inventory or worn; Rune needs Mining 41.
    const pick = PICKAXES.find((p) => owned(p) > 0) ?? (levels('Mining') >= 41 ? 'Rune pickaxe' : 'Iron pickaxe');
    return {
      label: 'Guardians of the Rift',
      config: { Mode: 'BALANCED' },
      supplies: [{ name: pick, want: 1, anyOf: ['pickaxe'] }],
      sell: GOTR_SOLD,
      carry: [{ name: pick }],
      start: { name: 'the Guardians of the Rift barrier', point: { x: 3615, y: 9476, plane: 0 }, radius: 8 },
    };
  },
};

// --- Smithing on a free account: smelt for profit, smith platebodies with it ---------------------

const METALS = [
  { metal: 'Bronze', bar: 'Bronze bar', enumBar: 'BRONZE', base: 1, xp: 12.5 },
  { metal: 'Iron', bar: 'Iron bar', enumBar: 'IRON', base: 15, xp: 25 },
  { metal: 'Steel', bar: 'Steel bar', enumBar: 'STEEL', base: 30, xp: 37.5 },
  { metal: 'Mithril', bar: 'Mithril bar', enumBar: 'MITHRIL', base: 50, xp: 50 },
  { metal: 'Adamant', bar: 'Adamantite bar', enumBar: 'ADAMANTITE', base: 70, xp: 62.5 },
  { metal: 'Rune', bar: 'Runite bar', enumBar: 'RUNITE', base: 85, xp: 75 },
];
/** Liquid anvil products: level offset from the metal's base, bars, the plugin's enum. */
const PRODUCTS = [
  { item: 'platebody', enumItem: 'PLATE_BODY', offset: 18, bars: 5 },
  { item: 'platelegs', enumItem: 'PLATE_LEGS', offset: 16, bars: 3 },
];
/** Smelting: ores per bar and smelting XP; free accounts carry no coal bag. */
const SMELTS = [
  { bar: 'Steel bar', enumBar: 'STEEL', level: 30, xp: 17.5, ore: 'Iron ore', coal: 2 },
  { bar: 'Mithril bar', enumBar: 'MITHRIL', level: 50, xp: 30, ore: 'Mithril ore', coal: 4 },
  { bar: 'Adamantite bar', enumBar: 'ADAMANTITE', level: 70, xp: 37.5, ore: 'Adamantite ore', coal: 6 },
  { bar: 'Runite bar', enumBar: 'RUNITE', level: 85, xp: 50, ore: 'Runite ore', coal: 8 },
];
const GE_TAX = 0.98;

export interface SmithChoice { label: string; gpPerXp: number; xpHour: number; item: string; bar: string; bars: number; enumBar: string; enumItem: string }

/** GE buy limit on bars: 10,000 every 4 hours. */
const BAR_LIMIT_HOUR = 2500;
/** Bars an hour at Varrock West: 27 bars a trip, 3 s an item, ~12 s at the bank. */
function barsPerHour(barsPerItem: number): number {
  const items = Math.floor(27 / barsPerItem);
  return Math.min(BAR_LIMIT_HOUR, (3600 * items * barsPerItem) / (items * 3 + 12));
}
/** Smelting without a coal bag: (1 ore + n coal) per bar in 28 slots, ~3 s a bar, ~12 s at the bank. */
function smeltBarsPerHour(coal: number): number {
  const bars = Math.floor(28 / (1 + coal));
  return (3600 * bars) / (bars * 3 + 12);
}

/**
 * XP an hour of smithing `smith` paid for by smelting `smelt` (no coins spent overall):
 * smithing t_s hours costs c*R_s*t_s, which t_m = c*R_s*t_s/profit hours of smelting earn back.
 */
export function fundedXpHour(smith: SmithChoice, smelt: SmeltChoice | null): number {
  if (smith.gpPerXp <= 0) return smith.xpHour;
  if (!smelt || smelt.profitHour <= 0) return 0;
  const ratio = (smith.gpPerXp * smith.xpHour) / smelt.profitHour;
  return (smith.xpHour + smelt.xpHour * ratio) / (1 + ratio);
}
export interface SmeltChoice { label: string; profitPerBar: number; profitHour: number; xpHour: number; bar: string; enumBar: string; ore: string; coal: number; xp: number }

/**
 * Anvil product the level allows with the best XP an hour once paid for by smelting (the cheapest
 * per XP when nothing smelts at a profit).
 */
export function bestSmith(level: number, price: (item: string) => number | null): SmithChoice | null {
  const smelt = bestSmelt(level, price);
  let best: SmithChoice | null = null;
  let bestScore = -Infinity;
  for (const m of METALS) {
    const bar = price(m.bar);
    if (bar === null) continue;
    for (const p of PRODUCTS) {
      if (level < m.base + p.offset) continue;
      const item = `${m.metal} ${p.item}`;
      const sell = price(item);
      if (sell === null) continue;
      const gpPerXp = (bar * p.bars - sell * GE_TAX) / (m.xp * p.bars);
      const choice: SmithChoice = { label: `smith ${item} at Varrock West`, gpPerXp, xpHour: barsPerHour(p.bars) * m.xp, item, bar: m.bar, bars: p.bars, enumBar: m.enumBar, enumItem: p.enumItem };
      const score = smelt ? fundedXpHour(choice, smelt) : -gpPerXp;
      if (score > bestScore) [best, bestScore] = [choice, score];
    }
  }
  return best;
}

/** Most profitable bar to smelt from bought ore and coal. */
export function bestSmelt(level: number, price: (item: string) => number | null): SmeltChoice | null {
  let best: SmeltChoice | null = null;
  for (const s of SMELTS) {
    if (level < s.level) continue;
    const bar = price(s.bar);
    const ore = price(s.ore);
    const coal = price('Coal');
    if (bar === null || ore === null || coal === null) continue;
    const profitPerBar = bar * GE_TAX - ore - coal * s.coal;
    const perHour = smeltBarsPerHour(s.coal);
    if (!best || profitPerBar * perHour > best.profitHour) {
      best = { label: `smelt ${s.bar}s at Edgeville`, profitPerBar, profitHour: profitPerBar * perHour, xpHour: s.xp * perHour, bar: s.bar, enumBar: s.enumBar, ore: s.ore, coal: s.coal, xp: s.xp };
    }
  }
  return best;
}

/** Smith while the coins cover about an hour of it; below that, smelt for profit until they cover two. */
export function smithingSpec(): HubSpec {
  let mode: 'smith' | 'smelt' = 'smith';
  return {
    id: 'smithing',
    className: `${PKG}.varrockanvil.VarrockAnvilPlugin`,
    group: 'VarrockAnvil',
    skill: 'Smithing',
    stallMinutes: 3,
    plan: ({ level, coins, price }): HubRun | string => {
      const smith = bestSmith(level, price);
      const smelt = bestSmelt(level, price);
      if (!smith && !smelt) return 'no GE prices for bars and anvil products';
      const hourCost = smith ? Math.max(0, smith.gpPerXp) * smith.xpHour : Infinity;
      if (smith && (smith.gpPerXp <= 1 || coins >= 2 * hourCost)) mode = 'smith';
      else if (!smith || coins < Math.max(150_000, hourCost)) mode = 'smelt';
      if (mode === 'smith' && smith) {
        const barPrice = price(smith.bar) ?? 1;
        const bars = Math.floor(Math.min(2500, (coins - 30_000) / (barPrice * 1.3)) / smith.bars) * smith.bars;
        if (bars >= smith.bars) {
          return {
            label: `${smith.label} (${smith.gpPerXp.toFixed(1)} gp/xp)`,
            className: `${PKG}.varrockanvil.VarrockAnvilPlugin`,
            group: 'VarrockAnvil',
            config: { barType: smith.enumBar, smithObject: smith.enumItem, logout: 'false' },
            supplies: [{ name: 'Hammer', want: 1 }, { name: smith.bar, want: bars, min: smith.bars }],
            sell: [smith.item],
            start: { name: 'Varrock West anvils', point: { x: 3188, y: 3426, plane: 0 }, radius: 10 },
          };
        }
      }
      if (!smelt) return `Smithing ${level}: no bar smelts at a profit and ${coins} coins do not fund smithing`;
      const perBar = (price(smelt.ore) ?? 0) + (price('Coal') ?? 0) * smelt.coal;
      const bars = Math.floor(Math.min(1500, (coins - 30_000) / (perBar * 1.3)));
      if (bars < 20) return `${coins} coins do not buy ore for ${smelt.bar}s`;
      return {
        label: `${smelt.label} (+${Math.round(smelt.profitPerBar)} gp a bar)`,
        className: `${PKG}.smelting.AutoSmeltingPlugin`,
        group: 'Smithing',
        config: { Bar: smelt.enumBar },
        supplies: [{ name: smelt.ore, want: bars, min: 1 }, { name: 'Coal', want: bars * smelt.coal, min: smelt.coal }],
        sell: [smelt.bar],
        start: { name: 'the Edgeville furnace', point: { x: 3108, y: 3499, plane: 0 }, radius: 6 },
      };
    },
  };
}

export const HUB_SPECS: Record<string, () => HubSpec> = {
  alch: () => ALCH,
  agility: () => AGILITY,
  gotr: () => GOTR,
  smithing: smithingSpec,
};
