/**
 * Curated skilling requirements: which (target name, action) pairs train which skill, the level
 * they need, the tool they need, and what they produce. The cache knows names and actions but not
 * levels or tools, and the wiki has no clean table for them, so this list is hand-maintained.
 *
 * Target and action names are matched case-insensitively ("Small Net" and "Small net" both occur).
 *
 * Extend freely; `build.ts` loads it into the `resources` table and `KnowledgeBase.describe*`
 * uses it to enrich candidate labels ("Iron rocks — Mine (Mining 15, needs pickaxe)").
 */

export type ResourceKind = 'npc' | 'object';

export interface ResourceRule {
  kind: ResourceKind;
  /** Exact target name as shown in game ("Oak tree", "Fishing spot"). */
  target: string;
  /** Menu action on the target ("Chop down", "Small Net"). */
  action: string;
  skill: string;
  level: number;
  /** Any one of these must be in the inventory or equipped. Lower-case substrings. */
  tools: string[];
  /** Consumed per action (bait, feathers). Lower-case substrings. */
  consumes?: string[];
  /** Possible products, lowest level first. */
  products: string[];
  members?: boolean;
}

const AXE = ['axe'];
const PICKAXE = ['pickaxe'];

const tree = (target: string, level: number, product: string, members = false, action = 'Chop down'): ResourceRule =>
  ({ kind: 'object', target, action, skill: 'Woodcutting', level, tools: AXE, products: [product], members });

const rock = (target: string, level: number, product: string, members = false): ResourceRule =>
  ({ kind: 'object', target, action: 'Mine', skill: 'Mining', level, tools: PICKAXE, products: [product], members });

export const RESOURCES: ResourceRule[] = [
  tree('Tree', 1, 'Logs'),
  tree('Dead tree', 1, 'Logs'),
  tree('Evergreen tree', 1, 'Logs'),
  tree('Achey tree', 1, 'Achey tree logs', true),
  tree('Oak tree', 15, 'Oak logs'),
  tree('Willow tree', 30, 'Willow logs'),
  tree('Teak tree', 35, 'Teak logs', true),
  tree('Maple tree', 45, 'Maple logs', true),
  tree('Mahogany tree', 50, 'Mahogany logs', true),
  tree('Arctic pine tree', 54, 'Arctic pine logs', true, 'Cut down'),
  tree('Yew tree', 60, 'Yew logs'),
  tree('Magic tree', 75, 'Magic logs', true),
  tree('Redwood tree', 90, 'Redwood logs', true, 'Cut'),

  rock('Clay rocks', 1, 'Clay'),
  rock('Copper rocks', 1, 'Copper ore'),
  rock('Tin rocks', 1, 'Tin ore'),
  rock('Blurite rocks', 10, 'Blurite ore'),
  rock('Iron rocks', 15, 'Iron ore'),
  rock('Silver rocks', 20, 'Silver ore'),
  rock('Coal rocks', 30, 'Coal'),
  rock('Sandstone rocks', 35, 'Sandstone', true),
  rock('Gold rocks', 40, 'Gold ore'),
  rock('Gem rocks', 40, 'Uncut gem', true),
  rock('Granite rocks', 45, 'Granite', true),
  rock('Mithril rocks', 55, 'Mithril ore'),
  rock('Adamantite rocks', 70, 'Adamantite ore'),
  rock('Runite rocks', 85, 'Runite ore'),
  rock('Amethyst crystals', 92, 'Amethyst', true),
  { kind: 'object', target: 'Rune Essence', action: 'Mine', skill: 'Mining', level: 1, tools: PICKAXE, products: ['Rune essence', 'Pure essence'] },

  { kind: 'npc', target: 'Fishing spot', action: 'Small Net', skill: 'Fishing', level: 1, tools: ['small fishing net'], products: ['Raw shrimps', 'Raw anchovies'] },
  { kind: 'npc', target: 'Fishing spot', action: 'Net', skill: 'Fishing', level: 1, tools: ['small fishing net'], products: ['Raw shrimps', 'Raw anchovies'] },
  { kind: 'npc', target: 'Fishing spot', action: 'Bait', skill: 'Fishing', level: 5, tools: ['fishing rod'], consumes: ['fishing bait'], products: ['Raw sardine', 'Raw herring', 'Raw pike'] },
  { kind: 'npc', target: 'Rod Fishing spot', action: 'Bait', skill: 'Fishing', level: 5, tools: ['fishing rod'], consumes: ['fishing bait'], products: ['Raw sardine', 'Raw herring', 'Raw pike'] },
  { kind: 'npc', target: 'Rod Fishing spot', action: 'Lure', skill: 'Fishing', level: 20, tools: ['fly fishing rod'], consumes: ['feather'], products: ['Raw trout', 'Raw salmon'] },
  { kind: 'npc', target: 'Fishing spot', action: 'Lure', skill: 'Fishing', level: 20, tools: ['fly fishing rod'], consumes: ['feather'], products: ['Raw trout', 'Raw salmon'] },
  { kind: 'npc', target: 'Fishing spot', action: 'Cage', skill: 'Fishing', level: 40, tools: ['lobster pot'], products: ['Raw lobster'] },
  { kind: 'npc', target: 'Fishing spot', action: 'Harpoon', skill: 'Fishing', level: 35, tools: ['harpoon'], products: ['Raw tuna', 'Raw swordfish', 'Raw shark'] },
  { kind: 'npc', target: 'Fishing spot', action: 'Big Net', skill: 'Fishing', level: 16, tools: ['big fishing net'], products: ['Raw mackerel', 'Raw cod', 'Raw bass'], members: true },
];

/**
 * Stations: objects that process items rather than yield them. Used to label candidates
 * ("Furnace — Smelt (Smithing)") and by task trees to find where to go.
 */
export interface StationRule {
  target: string;
  action: string;
  skill: string;
  /** What the station consumes, lower-case substrings. */
  inputs: string[];
}

export const STATIONS: StationRule[] = [
  { target: 'Range', action: 'Cook', skill: 'Cooking', inputs: ['raw '] },
  { target: 'Cooking range', action: 'Cook', skill: 'Cooking', inputs: ['raw '] },
  { target: 'Fire', action: 'Cook', skill: 'Cooking', inputs: ['raw '] },
  { target: 'Furnace', action: 'Smelt', skill: 'Smithing', inputs: ['ore', 'coal'] },
  { target: 'Anvil', action: 'Smith', skill: 'Smithing', inputs: [' bar'] },
  { target: 'Spinning wheel', action: 'Spin', skill: 'Crafting', inputs: ['wool', 'flax'] },
  { target: "Potter's Wheel", action: 'Use', skill: 'Crafting', inputs: ['soft clay'] },
  { target: 'Pottery oven', action: 'Fire', skill: 'Crafting', inputs: ['unfired'] },
  { target: 'Altar', action: 'Pray-at', skill: 'Prayer', inputs: [] },
];
