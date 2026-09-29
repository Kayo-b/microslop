/**
 * Strategy templates: which activity to do for a goal, given the account's levels, membership and
 * quests. Curated from established OSRS knowledge (training methods, money makers, quest order);
 * everything that changes over time (quest progress, membership, spawn locations, prices) is read
 * live from the client, the KB or the wiki instead of being stored here.
 *
 * An activity is executed by one of:
 *   - an existing scripted planner (`preset`),
 *   - a generic combat task against a monster the KB can locate (`combat`),
 *   - the LLM planner with a method description (`llm`) until someone scripts it,
 *   - the quest runner (`quest`), which follows Quest Helper's current step.
 */
import type { WorldPoint } from '../types.ts';

export type Execution =
  | { kind: 'preset'; preset: string; bank?: boolean }
  | { kind: 'combat'; monster: string; area?: { name: string; point: WorldPoint }; loot?: string[]; bury?: boolean }
  | { kind: 'llm'; goal: string }
  | { kind: 'quest'; quest: string };

export interface Requirement {
  skills?: Record<string, number>;
  quests?: string[];
  /** Quest points needed. */
  qp?: number;
  items?: string[];
  combat?: number;
}

export interface TrainingMethod {
  skill: string;
  /** Level the method starts being worthwhile / unlocked. */
  from: number;
  /** Level to move on at (the next method's `from`). */
  to: number;
  members: boolean;
  name: string;
  exec: Execution;
  req?: Requirement;
  notes?: string;
}

/** Skill -> methods, lowest level first. The first method whose level bracket and requirements fit is used. */
export const TRAINING: TrainingMethod[] = [
  // Melee: monsters picked by combat stats, safest XP/hour without quests.
  { skill: 'Melee', from: 1, to: 10, members: false, name: 'chickens and cows at Lumbridge', exec: { kind: 'preset', preset: 'kill-cows' } },
  { skill: 'Melee', from: 10, to: 20, members: false, name: 'goblins east of Lumbridge', exec: { kind: 'preset', preset: 'kill-goblins' } },
  { skill: 'Melee', from: 20, to: 30, members: false, name: 'barbarians in Barbarian Village', exec: { kind: 'preset', preset: 'kill-barbarians' } },
  {
    skill: 'Melee', from: 30, to: 45, members: false, name: 'flesh crawlers (Stronghold of Security, level 2)',
    exec: { kind: 'llm', goal: 'go down the Stronghold of Security (Barbarian Village) to level 2, the Catacomb of Famine (around 1945, 5094), answering the door questions, then kill flesh crawlers and bank at Edgeville' },
    notes: 'aggressive, weak hits, dense; the Stronghold door questions are not scripted yet',
  },
  {
    skill: 'Melee', from: 30, to: 50, members: false, name: 'hill giants (Edgeville Dungeon)',
    exec: { kind: 'combat', monster: 'Hill giant', area: { name: 'Edgeville Dungeon hill giants', point: { x: 3117, y: 9848, plane: 0 } }, loot: ['Big bones', 'Coins', 'Limpwurt root'], bury: true },
    req: { items: ['Brass key'] }, notes: 'big bones give good Prayer XP; the brass key is found west of Edgeville',
  },
  {
    skill: 'Melee', from: 40, to: 60, members: false, name: 'moss giants (Varrock Sewers)',
    exec: { kind: 'combat', monster: 'Moss giant', area: { name: 'Varrock Sewers moss giants', point: { x: 3165, y: 9880, plane: 0 } }, loot: ['Big bones', 'Coins', 'Nature rune'], bury: true },
    req: { items: ['Knife'] }, notes: 'a knife or sharp weapon cuts the sewer web',
  },
  { skill: 'Melee', from: 60, to: 99, members: false, name: 'ogresses at Corsair Cove', exec: { kind: 'llm', goal: 'train melee on Ogress Warriors in the Corsair Cove dungeon, banking at the Corsair Cove bank' }, req: { quests: ['The Corsair Curse'] } },
  { skill: 'Melee', from: 20, to: 70, members: true, name: 'sand crabs (Hosidius coast)', exec: { kind: 'combat', monster: 'Sand crab', area: { name: 'Hosidius sand crabs', point: { x: 1760, y: 3470, plane: 0 } } }, notes: 'AFK; high HP, 1 max hit' },

  // Ranged and magic: no quests needed; kits are bought in Varrock (Lowe's, Zaff's, Aubury's).
  { skill: 'Ranged', from: 1, to: 30, members: false, name: 'cows at Lumbridge with a shortbow', exec: { kind: 'preset', preset: 'range-cows' }, notes: 'buys a shortbow and bronze arrows at Lowe\'s; picks arrows back up' },
  { skill: 'Magic', from: 1, to: 13, members: false, name: 'chickens with Wind Strike autocast', exec: { kind: 'preset', preset: 'mage-chickens' }, notes: 'buys a staff (Zaff) and air/mind runes (Aubury); Imp Catcher and Witch\'s Potion add ~1,200 Magic XP' },

  // Gathering.
  { skill: 'Fishing', from: 1, to: 20, members: false, name: 'net shrimps and anchovies at Draynor', exec: { kind: 'preset', preset: 'fish-shrimp', bank: true }, req: { items: ['Small fishing net'] } },
  { skill: 'Fishing', from: 20, to: 40, members: false, name: 'fly fish trout and salmon at Barbarian Village', exec: { kind: 'preset', preset: 'fish-trout', bank: true }, req: { items: ['Fly fishing rod', 'Feather'] } },
  { skill: 'Fishing', from: 40, to: 99, members: false, name: 'lobsters at Musa Point, Karamja', exec: { kind: 'llm', goal: 'fish lobsters at Musa Point on Karamja with a lobster pot, taking the Port Sarim boat (30 coins) and banking at the deposit box on the Port Sarim docks' }, req: { items: ['Lobster pot', 'Coins'] } },
  { skill: 'Fishing', from: 58, to: 99, members: true, name: 'barbarian fishing at Otto\'s Grotto', exec: { kind: 'llm', goal: 'barbarian fish with a barbarian rod and feathers at Otto\'s Grotto, dropping the fish' }, req: { skills: { Agility: 15, Strength: 15 }, items: ['Barbarian rod', 'Feather'] } },
  { skill: 'Woodcutting', from: 1, to: 15, members: false, name: 'normal trees', exec: { kind: 'preset', preset: 'chop-trees', bank: true } },
  { skill: 'Woodcutting', from: 15, to: 30, members: false, name: 'oaks', exec: { kind: 'preset', preset: 'chop-oaks', bank: true } },
  { skill: 'Woodcutting', from: 30, to: 99, members: false, name: 'willows at Draynor', exec: { kind: 'preset', preset: 'chop-willows', bank: true } },
  { skill: 'Mining', from: 1, to: 15, members: false, name: 'copper and tin', exec: { kind: 'preset', preset: 'mine-copper', bank: true } },
  { skill: 'Mining', from: 15, to: 99, members: false, name: 'iron ore', exec: { kind: 'preset', preset: 'mine-iron', bank: true } },

  // Processing: fed by the gathering loops' banked output.
  { skill: 'Cooking', from: 1, to: 25, members: false, name: 'cook banked shrimps on fires', exec: { kind: 'preset', preset: 'cook-shrimps' }, req: { items: ['Raw shrimps'] } },
  { skill: 'Cooking', from: 15, to: 99, members: false, name: 'cook banked trout and salmon on fires', exec: { kind: 'preset', preset: 'cook-trout' }, req: { items: ['Raw trout'] } },
  { skill: 'Smithing', from: 1, to: 40, members: false, name: 'mine, smelt and smith bronze then iron gear', exec: { kind: 'preset', preset: 'smith-progression' } },
  { skill: 'Firemaking', from: 1, to: 99, members: false, name: 'burn banked logs in lines', exec: { kind: 'llm', goal: 'withdraw logs from the nearest bank and burn them in a line on open ground with a tinderbox, repeating until no logs are left' }, req: { items: ['Tinderbox', 'Logs'] } },
  { skill: 'Prayer', from: 1, to: 99, members: false, name: 'bury bones from combat', exec: { kind: 'preset', preset: 'kill-barbarians' }, notes: 'bones are buried by the combat presets; hill/moss giants drop big bones' },
];

export interface MoneyRoute {
  id: string;
  name: string;
  members: boolean;
  req?: Requirement;
  /** Rough gp/hour at the requirement levels (moves with prices; rank only). */
  gpHour: number;
  /** Items produced, for live price lookups. */
  products: string[];
  exec: Execution;
  notes?: string;
}

export const MONEY: MoneyRoute[] = [
  { id: 'cowhides', name: 'kill cows and bank cowhides', members: false, gpHour: 20_000, products: ['Cowhide'], exec: { kind: 'combat', monster: 'Cow', loot: ['Cowhide'] } },
  { id: 'iron-ore', name: 'mine and bank iron ore', members: false, req: { skills: { Mining: 15 } }, gpHour: 30_000, products: ['Iron ore'], exec: { kind: 'preset', preset: 'mine-iron', bank: true } },
  { id: 'willow-logs', name: 'chop and bank willow logs', members: false, req: { skills: { Woodcutting: 30 } }, gpHour: 10_000, products: ['Willow logs'], exec: { kind: 'preset', preset: 'chop-willows', bank: true } },
  { id: 'trout-salmon', name: 'fly fish and bank trout/salmon', members: false, req: { skills: { Fishing: 30 }, items: ['Fly fishing rod', 'Feather'] }, gpHour: 25_000, products: ['Raw trout', 'Raw salmon'], exec: { kind: 'preset', preset: 'fish-trout', bank: true } },
  { id: 'lobsters', name: 'fish lobsters on Karamja', members: false, req: { skills: { Fishing: 40 }, items: ['Lobster pot'] }, gpHour: 45_000, products: ['Raw lobster'], exec: { kind: 'llm', goal: 'fish lobsters at Musa Point on Karamja and bank them at the Port Sarim deposit box' } },
  { id: 'hill-giants', name: 'kill hill giants for big bones and limpwurt roots', members: false, req: { combat: 30, items: ['Brass key'] }, gpHour: 60_000, products: ['Big bones', 'Limpwurt root'], exec: { kind: 'combat', monster: 'Hill giant', area: { name: 'Edgeville Dungeon hill giants', point: { x: 3117, y: 9848, plane: 0 } }, loot: ['Big bones', 'Limpwurt root', 'Coins'] } },
  { id: 'moss-giants', name: 'kill moss giants for big bones and nature runes', members: false, req: { combat: 40 }, gpHour: 70_000, products: ['Big bones', 'Nature rune'], exec: { kind: 'combat', monster: 'Moss giant', area: { name: 'Varrock Sewers moss giants', point: { x: 3165, y: 9880, plane: 0 } }, loot: ['Big bones', 'Nature rune', 'Coins'] } },
  { id: 'yew-logs', name: 'chop and bank yew logs', members: false, req: { skills: { Woodcutting: 60 } }, gpHour: 60_000, products: ['Yew logs'], exec: { kind: 'llm', goal: 'chop yew trees near Edgeville or Varrock palace and bank the yew logs' } },
  { id: 'tan-hides', name: 'buy cowhides and tan them into leather at Al Kharid', members: false, req: { items: ['Coins'] }, gpHour: 80_000, products: ['Leather'], exec: { kind: 'llm', goal: 'withdraw coins and cowhides, have Ellis in Al Kharid tan them into leather, bank at Al Kharid' }, notes: 'profit depends on hide/leather prices; check live prices first' },
  { id: 'sand-crabs-herbs', name: 'kill sand crabs (P2P, AFK)', members: true, req: { combat: 20 }, gpHour: 10_000, products: [], exec: { kind: 'combat', monster: 'Sand crab' } },
];

export interface QuestInfo {
  name: string;
  members: boolean;
  req?: Requirement;
  /** Why it is worth doing early: XP rewards, unlocks. */
  reward: string;
}

/**
 * Recommended order: fast XP and unlocks first, requirements before the quests needing them.
 * Names match Quest Helper's display names.
 */
export const QUESTS: QuestInfo[] = [
  { name: "Cook's Assistant", members: false, reward: '300 Cooking XP; unlocks the Lumbridge castle range' },
  { name: 'Sheep Shearer', members: false, reward: '150 Crafting XP' },
  { name: 'The Restless Ghost', members: false, reward: '1,125 Prayer XP' },
  { name: 'Romeo & Juliet', members: false, reward: '5 quest points' },
  { name: 'Rune Mysteries', members: false, reward: 'Runecraft access (air runes)' },
  { name: 'Imp Catcher', members: false, reward: '875 Magic XP' },
  { name: "Witch's Potion", members: false, reward: '325 Magic XP' },
  { name: "Doric's Quest", members: false, req: { skills: { Mining: 15 } }, reward: '1,300 Mining XP; Doric\'s anvils' },
  { name: "The Knight's Sword", members: false, req: { skills: { Mining: 10 } }, reward: '12,725 Smithing XP' },
  { name: 'Goblin Diplomacy', members: false, reward: '200 Crafting XP' },
  { name: 'Ernest the Chicken', members: false, reward: '300 coins; 4 quest points' },
  { name: 'Vampyre Slayer', members: false, reward: '4,825 Attack XP' },
  { name: 'Prince Ali Rescue', members: false, reward: 'free Al Kharid toll gate' },
  { name: "Pirate's Treasure", members: false, reward: '450 coins, emerald, gold ring' },
  { name: 'Misthalin Mystery', members: false, reward: '600 Crafting XP' },
  { name: 'X Marks the Spot', members: false, reward: '300 coins, antique lamp' },
  { name: 'The Corsair Curse', members: false, reward: 'Corsair Cove bank and ogress training' },
  { name: "Black Knights' Fortress", members: false, req: { qp: 12 }, reward: '2,500 coins' },
  { name: 'Demon Slayer', members: false, reward: 'Silverlight' },
  { name: 'Below Ice Mountain', members: false, req: { qp: 16 }, reward: 'Ruins of Camdozaal access' },
  { name: 'Dragon Slayer I', members: false, req: { qp: 32 }, reward: '18,650 Strength and Defence XP; rune platebody' },

  { name: 'Waterfall Quest', members: true, reward: '13,750 Attack and Strength XP (level 1 -> 30)' },
  { name: 'Witch\'s House', members: true, reward: '6,325 Hitpoints XP' },
  { name: 'Fight Arena', members: true, reward: '12,175 Attack XP; 2,175 Thieving XP' },
  { name: 'Tree Gnome Village', members: true, reward: '11,450 Attack XP; spirit tree access' },
  { name: 'Druidic Ritual', members: true, reward: 'Herblore unlocked' },
  { name: 'Priest in Peril', members: true, reward: '1,406 Prayer XP; Morytania access' },
  { name: 'Nature Spirit', members: true, req: { quests: ['Priest in Peril', 'The Restless Ghost'] }, reward: 'Mort Myre access; 3 x 2,000 XP' },
  { name: 'Lost City', members: true, req: { skills: { Crafting: 31, Woodcutting: 36 } }, reward: 'Zanaris; dragon longsword/dagger' },
  { name: 'Monkey Madness I', members: true, req: { quests: ['The Grand Tree', 'Tree Gnome Village'] }, reward: 'dragon scimitar; big combat XP' },
];

/** Areas never walked into by a strategy: the Wilderness (surface and dungeons). */
export function inWilderness(p: WorldPoint): boolean {
  const surface = p.x >= 2944 && p.x <= 3391 && p.y >= 3520 && p.y <= 3967;
  const underground = p.x >= 2944 && p.x <= 3391 && p.y >= 9920 && p.y <= 10366;
  return surface || underground;
}
