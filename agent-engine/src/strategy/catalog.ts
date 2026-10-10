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
import type { CombatStyle } from '../planner/gear.ts';
import type { WorldPoint } from '../types.ts';

export type Execution =
  | { kind: 'preset'; preset: string; bank?: boolean }
  | { kind: 'combat'; monster: string; area?: { name: string; point: WorldPoint }; loot?: string[]; bury?: boolean; style?: CombatStyle; /** Cooked food to bring (default 5). */ food?: number }
  | { kind: 'llm'; goal: string }
  | { kind: 'quest'; quest: string }
  /** Tutorial Island, driven by its progress varp. */
  | { kind: 'tutorial' }
  /** Buy an item at a shop or the Grand Exchange. */
  | { kind: 'acquire'; item: string; count: number; source: AcquireSource; /** Price each; default: the ACQUIRE entry. */ price?: number }
  /** Turn banked products into coins on the Grand Exchange. */
  | { kind: 'sell'; items: string[] };

export type AcquireSource = { kind: 'shop'; name: string; keeper: string; point: WorldPoint } | { kind: 'ge' };

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
  /** Rough XP/hour at the bracket's start level (estimates only; the ledger's observed rate wins). */
  xpHour?: number;
  notes?: string;
}

/** Skill -> methods, lowest level first. The first method whose level bracket and requirements fit is used. */
export const TRAINING: TrainingMethod[] = [
  // Melee: monsters picked by combat stats, safest XP/hour without quests.
  { skill: 'Melee', from: 1, to: 10, members: false, name: 'chickens and cows at Lumbridge', xpHour: 8000, exec: { kind: 'preset', preset: 'kill-cows' } },
  { skill: 'Melee', from: 10, to: 20, members: false, name: 'goblins east of Lumbridge', xpHour: 12000, exec: { kind: 'preset', preset: 'kill-goblins' } },
  { skill: 'Melee', from: 20, to: 30, members: false, name: 'barbarians in Barbarian Village', xpHour: 15000, exec: { kind: 'preset', preset: 'kill-barbarians' } },
  {
    skill: 'Melee', from: 30, to: 45, members: false, name: 'flesh crawlers (Stronghold of Security, level 2)', xpHour: 20000,
    exec: { kind: 'llm', goal: 'go down the Stronghold of Security (Barbarian Village) to level 2, the Catacomb of Famine (around 1945, 5094), answering the door questions, then kill flesh crawlers and bank at Edgeville' },
    notes: 'aggressive, weak hits, dense; the Stronghold door questions are not scripted yet',
  },
  {
    skill: 'Melee', from: 30, to: 50, members: false, name: 'hill giants (Edgeville Dungeon)', xpHour: 22000,
    exec: { kind: 'combat', monster: 'Hill giant', area: { name: 'Edgeville Dungeon hill giants', point: { x: 3117, y: 9848, plane: 0 } }, loot: ['Big bones', 'Coins', 'Limpwurt root'], bury: true },
    req: { items: ['Brass key'] }, notes: 'big bones give good Prayer XP; the brass key is found west of Edgeville',
  },
  {
    skill: 'Melee', from: 40, to: 60, members: false, name: 'moss giants (Varrock Sewers)', xpHour: 28000,
    exec: { kind: 'combat', monster: 'Moss giant', area: { name: 'Varrock Sewers moss giants', point: { x: 3165, y: 9880, plane: 0 } }, loot: ['Big bones', 'Coins', 'Nature rune'], bury: true },
    req: { items: ['Knife'] }, notes: 'a knife or sharp weapon cuts the sewer web',
  },
  { skill: 'Melee', from: 60, to: 99, members: false, name: 'ogresses at Corsair Cove', xpHour: 40000, exec: { kind: 'llm', goal: 'train melee on Ogress Warriors in the Corsair Cove dungeon, banking at the Corsair Cove bank' }, req: { quests: ['The Corsair Curse'] } },
  { skill: 'Melee', from: 20, to: 70, members: true, name: 'sand crabs (Hosidius coast)', xpHour: 30000, exec: { kind: 'combat', monster: 'Sand crab', area: { name: 'Hosidius sand crabs', point: { x: 1760, y: 3470, plane: 0 } } }, notes: 'AFK; high HP, 1 max hit' },

  // Ranged and magic: no quests needed; kits are bought in Varrock (Lowe's, Zaff's, Aubury's).
  { skill: 'Ranged', from: 1, to: 30, members: false, name: 'cows at Lumbridge with a shortbow', xpHour: 8000, exec: { kind: 'preset', preset: 'range-cows' }, notes: 'buys a shortbow and bronze arrows at Lowe\'s; picks arrows back up' },
  { skill: 'Magic', from: 1, to: 55, members: false, name: 'chickens with Wind Strike autocast', xpHour: 6000, exec: { kind: 'preset', preset: 'mage-chickens' }, notes: 'buys a staff (Zaff) and air/mind runes (Aubury); Imp Catcher and Witch\'s Potion add ~1,200 Magic XP' },
  // Members ranged/magic past the starter kits: the kit planner only knows a shortbow with bronze/iron
  // arrows and Wind Strike, so these stay with the LLM until gear progression is scripted.
  { skill: 'Ranged', from: 30, to: 70, members: true, name: 'sand crabs with the best bow and arrows', xpHour: 30000, exec: { kind: 'llm', goal: 'buy the best bow and arrows your Ranged level allows (maple shortbow at 30, yew at 40, magic at 50; adamant arrows) at the Grand Exchange, then kill Sand crabs on the Hosidius coast with Ranged, picking up arrows and banking at Hosidius' }, notes: 'bow/arrow upgrades are not scripted yet' },
  { skill: 'Ranged', from: 70, to: 99, members: true, name: 'ammonite crabs with Ranged', xpHour: 70000, exec: { kind: 'llm', goal: 'kill Ammonite crabs on Fossil Island with the best bow and arrows your Ranged level allows, resetting aggression when they stop attacking' }, req: { quests: ['Bone Voyage'] } },
  { skill: 'Magic', from: 25, to: 55, members: true, name: 'sand crabs autocasting the best strike/bolt spell', xpHour: 25000, exec: { kind: 'llm', goal: 'set autocast to the best strike or bolt spell your Magic level and runes allow (buy runes and a matching elemental staff at the Grand Exchange or Port Sarim/Varrock shops), then kill Sand crabs on the Hosidius coast' }, notes: 'only Wind Strike is scripted' },
  { skill: 'Magic', from: 55, to: 99, members: false, name: 'High Level Alchemy', xpHour: 75000, exec: { kind: 'llm', goal: 'buy nature runes and an item that alchs at a small loss (or break-even) at the Grand Exchange, wield a staff of fire, then cast High Level Alchemy on them one by one' }, req: { items: ['Coins'] }, notes: 'costs money; profitable items need a live price feed' },

  // Slayer: placeholder until the Slayer module (task masters, task table, required items) exists.
  { skill: 'Slayer', from: 1, to: 99, members: true, name: 'Slayer tasks from the best master for the combat level', xpHour: 15000, exec: { kind: 'llm', goal: 'get a Slayer task from the best Slayer master your combat level allows (Turael in Burthorpe below combat 20, then Vannaka in Edgeville Dungeon, Chaeldar at 70), fetch any item the task needs (nose peg, earmuffs, light source), kill the assigned monster until the task is done, then get the next task' } },

  // Gathering.
  { skill: 'Fishing', from: 1, to: 20, members: false, name: 'net shrimps and anchovies at Draynor', exec: { kind: 'preset', preset: 'fish-shrimp', bank: true }, req: { items: ['Small fishing net'] } },
  { skill: 'Fishing', from: 20, to: 35, members: false, name: 'fly fish trout and salmon at Barbarian Village', exec: { kind: 'preset', preset: 'fish-trout', bank: true }, req: { items: ['Fly fishing rod', 'Feather'] } },
  { skill: 'Fishing', from: 58, to: 99, members: true, name: 'barbarian fishing at Otto\'s Grotto', exec: { kind: 'llm', goal: 'barbarian fish with a barbarian rod and feathers at Otto\'s Grotto, and bank the fish at the nearest bank when the inventory is full' }, req: { skills: { Agility: 15, Strength: 15 }, items: ['Barbarian rod', 'Feather'] } },
  { skill: 'Fishing', from: 35, to: 99, members: false, name: 'tuna and swordfish with a harpoon at Musa Point, Karamja', exec: { kind: 'llm', goal: 'fish tuna and swordfish at Musa Point on Karamja with a harpoon, taking the Port Sarim boat (30 coins) and banking the fish at the deposit box on the Port Sarim docks or the nearest bank' }, req: { items: ['Harpoon', 'Coins'] } },
  { skill: 'Woodcutting', from: 1, to: 15, members: false, name: 'normal trees', exec: { kind: 'preset', preset: 'chop-trees', bank: true } },
  { skill: 'Woodcutting', from: 15, to: 30, members: false, name: 'oaks', exec: { kind: 'preset', preset: 'chop-oaks', bank: true } },
  { skill: 'Woodcutting', from: 30, to: 60, members: false, name: 'willows at Draynor', exec: { kind: 'preset', preset: 'chop-willows', bank: true } },
  // Members get magic trees from 75 (listed first); free accounts stay on yews.
  { skill: 'Woodcutting', from: 75, to: 99, members: true, name: 'magic trees at Seers\' Village', exec: { kind: 'llm', goal: 'chop magic trees west of Seers\' Village (next to the Seers bank at the Sorcerer\'s Tower) and bank the magic logs when the inventory is full' } },
  { skill: 'Woodcutting', from: 60, to: 99, members: false, name: 'yews at Edgeville', exec: { kind: 'preset', preset: 'chop-yews', bank: true } },
  { skill: 'Mining', from: 1, to: 15, members: false, name: 'copper and tin', exec: { kind: 'preset', preset: 'mine-copper', bank: true } },
  { skill: 'Mining', from: 15, to: 30, members: false, name: 'iron ore', exec: { kind: 'preset', preset: 'mine-iron', bank: true } },
  { skill: 'Mining', from: 30, to: 55, members: false, name: 'coal in the Dwarven Mine', exec: { kind: 'preset', preset: 'mine-coal', bank: true }, notes: 'coal gives 50 XP an ore against iron\'s 35; the ore is also the steel/mithril smelting input' },
  { skill: 'Mining', from: 55, to: 70, members: false, name: 'mithril ore in the Dwarven Mine', exec: { kind: 'preset', preset: 'mine-mithril', bank: true }, notes: '80 XP an ore' },
  { skill: 'Mining', from: 70, to: 99, members: false, name: 'adamantite ore in the Dwarven Mine', exec: { kind: 'preset', preset: 'mine-adamant', bank: true }, notes: '95 XP an ore' },

  // Processing: fed by the gathering loops' banked output.
  { skill: 'Cooking', from: 1, to: 15, members: false, name: 'cook banked shrimps on fires', exec: { kind: 'preset', preset: 'cook-shrimps' }, req: { items: ['Raw shrimps'] } },
  { skill: 'Cooking', from: 15, to: 30, members: false, name: 'cook banked trout and salmon on fires', exec: { kind: 'preset', preset: 'cook-trout' }, req: { items: ['Raw trout'] } },
  { skill: 'Cooking', from: 30, to: 40, members: false, name: 'cook tuna on fires', exec: { kind: 'preset', preset: 'cook-tuna' }, notes: 'raw tuna comes from the harpoon fishing goal when the bank has none' },
  { skill: 'Cooking', from: 40, to: 45, members: false, name: 'cook lobsters on fires', exec: { kind: 'preset', preset: 'cook-lobsters' }, notes: 'raw lobsters come from the lobster pot goal when the bank has none' },
  { skill: 'Cooking', from: 45, to: 99, members: false, name: 'cook swordfish on fires', exec: { kind: 'preset', preset: 'cook-swordfish' }, notes: 'raw swordfish come from the harpoon fishing goal when the bank has none' },
  { skill: 'Smithing', from: 1, to: 99, members: false, name: 'mine, smelt and smith bronze, iron, steel, then mithril and adamant gear (by Smithing and Mining level)', exec: { kind: 'preset', preset: 'smith-progression' } },
  { skill: 'Firemaking', from: 1, to: 99, members: false, name: 'burn banked logs in lines', exec: { kind: 'llm', goal: 'withdraw logs from the nearest bank and burn them in a line on open ground with a tinderbox, repeating until no logs are left' }, req: { items: ['Tinderbox', 'Logs'] } },
  { skill: 'Crafting', from: 1, to: 4, members: false, name: 'Sheep Shearer for Crafting XP', exec: { kind: 'quest', quest: 'Sheep Shearer' }, notes: '150 Crafting XP' },
  { skill: 'Crafting', from: 4, to: 6, members: false, name: 'Goblin Diplomacy for Crafting XP', exec: { kind: 'quest', quest: 'Goblin Diplomacy' }, notes: '200 Crafting XP' },
  // Skills with no scripted method yet: LLM-driven goals (Claude plans, Jev/Laya clicks); unverified live.
  { skill: 'Agility', from: 1, to: 10, members: true, name: 'Gnome Stronghold Agility Course', xpHour: 8000, exec: { kind: 'llm', goal: 'run laps of the Gnome Stronghold Agility Course (log balance, obstacle net, tree branch, balancing rope, tree branch, obstacle net, obstacle pipe), repeating the lap' } },
  { skill: 'Agility', from: 10, to: 30, members: true, name: 'Draynor then Al Kharid rooftop courses', xpHour: 12000, exec: { kind: 'llm', goal: 'run laps of the Draynor Village rooftop course until Agility 20, then the Al Kharid rooftop course, picking up marks of grace, repeating the lap' } },
  { skill: 'Agility', from: 30, to: 60, members: true, name: 'Varrock then Canifis rooftop courses', xpHour: 25000, exec: { kind: 'llm', goal: 'run laps of the Varrock rooftop course until Agility 40, then the Canifis rooftop course, picking up marks of grace, repeating the lap' } },
  { skill: 'Agility', from: 60, to: 99, members: true, name: 'Seers Village then Ardougne rooftop courses', xpHour: 45000, exec: { kind: 'llm', goal: 'run laps of the Seers Village rooftop course until Agility 90 or the Ardougne rooftop course from 90, picking up marks of grace, repeating the lap' } },
  { skill: 'Thieving', from: 1, to: 25, members: false, name: 'pickpocket men and women in Lumbridge/Varrock', xpHour: 8000, exec: { kind: 'llm', goal: 'pickpocket men and women, eating food when hitpoints drop below half and banking the coins when food runs out' } },
  { skill: 'Thieving', from: 25, to: 55, members: false, name: 'pickpocket Al Kharid warriors then Falador guards', xpHour: 25000, exec: { kind: 'llm', goal: 'pickpocket Al Kharid warriors until Thieving 40 then Falador guards, eating food when hitpoints drop below half and banking when food runs out' }, req: { combat: 20 } },
  { skill: 'Thieving', from: 55, to: 99, members: true, name: 'pickpocket Knights of Ardougne', xpHour: 100000, exec: { kind: 'llm', goal: 'pickpocket Knights of Ardougne, eating food when hitpoints drop below half and banking the coins when food runs out' }, req: { combat: 40 } },
  { skill: 'Fletching', from: 1, to: 20, members: false, name: 'fletch logs into arrow shafts then shortbows', xpHour: 20000, exec: { kind: 'llm', goal: 'buy logs and a knife at the Grand Exchange, fletch them into the best bow or arrow shafts the Fletching level allows, and bank the products' }, req: { items: ['Coins'] } },
  { skill: 'Fletching', from: 20, to: 99, members: false, name: 'fletch oak and willow then yew bows and string them', xpHour: 60000, exec: { kind: 'llm', goal: 'buy logs and bowstrings at the Grand Exchange, fletch the best unstrung bow the Fletching level allows, string them and sell or bank them' }, req: { items: ['Coins'] } },
  { skill: 'Farming', from: 1, to: 99, members: true, name: 'herb and allotment runs', xpHour: 20000, exec: { kind: 'llm', goal: 'plant and harvest seeds at the Falador, Catherby, Ardougne and Canifis herb patches and the Draynor allotment, using compost and buying seeds at the Grand Exchange' }, req: { items: ['Coins'] } },
  { skill: 'Construction', from: 1, to: 99, members: true, name: 'Mahogany Homes', xpHour: 30000, exec: { kind: 'llm', goal: 'do Mahogany Homes contracts from the carpenter in Hosidius or Falador, buying planks, nails and a saw and hammer as needed' }, req: { items: ['Coins'] } },
  // Gold-unlock skills (plans/gold-*.json): trained by the gold loops themselves or by LLM-driven goals.
  { skill: 'Herblore', from: 3, to: 99, members: true, name: 'clean herbs and mix finished potions bought at the Grand Exchange', xpHour: 40000, exec: { kind: 'preset', preset: 'herblore-train' }, req: { quests: ['Druidic Ritual'], items: ['Coins'] }, notes: 'scripted (HerblorePlanner); XP/h is an estimate, the ledger value replaces it' },
  { skill: 'Crafting', from: 5, to: 20, members: false, name: 'craft leather items with needle and thread', xpHour: 25000, exec: { kind: 'llm', goal: 'train Crafting on leather: buy a needle and thread (Dommik\'s Crafting Store, Al Kharid, or the Grand Exchange), take leather from the bank (buy more at the Grand Exchange if short), and craft the best item the level allows: leather gloves (1), boots (7), cowl (9), vambraces (11), body (14), chaps (18). Craft in batches (Make all) and bank the finished items and spare leather' }, notes: 'LLM-driven; uses the leather the tanning loop leaves in the bank' },
  { skill: 'Crafting', from: 20, to: 99, members: false, name: 'craft jewellery at the Edgeville furnace and sell it', xpHour: 35000, exec: { kind: 'preset', preset: 'craft-jewellery' }, req: { items: ['Coins'] }, notes: 'scripted (JewelleryPlanner); climbs gold -> sapphire -> emerald -> ruby -> diamond' },
  { skill: 'Smithing', from: 30, to: 99, members: false, name: 'mine iron and coal, smelt steel bars', xpHour: 6000, exec: { kind: 'preset', preset: 'smelt-steel' }, req: { skills: { Mining: 30 } }, notes: 'scripted (SmeltingPlanner); about 17.5 XP per bar' },
  { skill: 'Hunter', from: 1, to: 15, members: true, name: 'bird snares for crimson swifts, golden warblers and copper longtails', xpHour: 10000, exec: { kind: 'llm', goal: 'train Hunter with bird snares in the Feldip Hills hunting area (crimson swifts, golden warblers, copper longtails), picking up the snare and the birds each cycle and burying or dropping the bones and feathers you do not need' }, notes: 'LLM-driven; no script yet' },
  { skill: 'Hunter', from: 15, to: 99, members: true, name: 'butterfly catching (ruby harvest, sapphire glacialis, snowy knight, black warlock)', xpHour: 20000, exec: { kind: 'llm', goal: 'train Hunter by catching butterflies with a butterfly net and jars: ruby harvest from 15, sapphire glacialis from 25, snowy knight from 35, black warlock from 45. Buy a butterfly net and jars if missing, release or bank the butterflies' }, notes: 'LLM-driven; no script yet' },
  { skill: 'Runecraft', from: 1, to: 27, members: false, name: 'craft rune essence at the mind, earth and body altars', xpHour: 6000, exec: { kind: 'preset', preset: 'runecraft' }, notes: 'scripted (RunecraftPlanner): essence and talismans from the Grand Exchange, ruins ids and tiles from the KB' },
  { skill: 'Runecraft', from: 27, to: 99, members: true, name: 'Guardians of the Rift', xpHour: 40000, exec: { kind: 'llm', goal: 'play Guardians of the Rift at Temple of the Eye: mine guardian fragments, craft guardian essence into runes and power the portal until the game ends, repeating rounds' }, notes: 'LLM-driven; no script yet' },
  { skill: 'Runecraft', from: 27, to: 99, members: false, name: 'craft rune essence at the body altar', xpHour: 6000, exec: { kind: 'preset', preset: 'runecraft' }, notes: 'free accounts only reach the body altar' },
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
  /**
   * Levels at which a fight is comfortable rather than merely allowed. Below them the gold
   * strategy spends the route's turn training the weakest of these skills instead.
   */
  recommend?: Record<string, number>;
}

export const MONEY: MoneyRoute[] = [
  { id: 'cowhides', name: 'kill cows and bank cowhides', members: false, gpHour: 20_000, products: ['Cowhide'], exec: { kind: 'combat', monster: 'Cow', loot: ['Cowhide'] } },
  { id: 'iron-ore', name: 'mine and bank iron ore', members: false, req: { skills: { Mining: 15 } }, gpHour: 30_000, products: ['Iron ore'], exec: { kind: 'preset', preset: 'mine-iron', bank: true } },
  { id: 'willow-logs', name: 'chop and bank willow logs', members: false, req: { skills: { Woodcutting: 30 } }, gpHour: 10_000, products: ['Willow logs'], exec: { kind: 'preset', preset: 'chop-willows', bank: true } },
  { id: 'trout-salmon', name: 'fly fish and bank trout/salmon', members: false, req: { skills: { Fishing: 30 }, items: ['Fly fishing rod', 'Feather'] }, gpHour: 25_000, products: ['Raw trout', 'Raw salmon'], exec: { kind: 'preset', preset: 'fish-trout', bank: true } },
  { id: 'lobsters', name: 'fish lobsters on Karamja', members: false, req: { skills: { Fishing: 40 }, items: ['Lobster pot'] }, gpHour: 45_000, products: ['Raw lobster'], exec: { kind: 'llm', goal: 'fish lobsters at Musa Point on Karamja and bank them at the Port Sarim deposit box' } },
  { id: 'hill-giants', name: 'kill hill giants for big bones and limpwurt roots', members: false, req: { combat: 30, items: ['Brass key'] }, recommend: { Attack: 30, Strength: 30, Defence: 25 }, gpHour: 60_000, products: ['Big bones', 'Limpwurt root'], exec: { kind: 'combat', monster: 'Hill giant', area: { name: 'Edgeville Dungeon hill giants', point: { x: 3117, y: 9848, plane: 0 } }, loot: ['Big bones', 'Limpwurt root', 'Coins'], food: 10 } },
  { id: 'moss-giants', name: 'kill moss giants for big bones and nature runes', members: false, req: { combat: 40 }, recommend: { Attack: 40, Strength: 40, Defence: 35 }, gpHour: 70_000, products: ['Big bones', 'Nature rune'], exec: { kind: 'combat', monster: 'Moss giant', area: { name: 'Varrock Sewers moss giants', point: { x: 3165, y: 9880, plane: 0 } }, loot: ['Big bones', 'Nature rune', 'Coins'], food: 15 } },
  { id: 'yew-logs', name: 'chop and bank yew logs', members: false, req: { skills: { Woodcutting: 60 } }, gpHour: 60_000, products: ['Yew logs'], exec: { kind: 'llm', goal: 'chop yew trees near Edgeville or Varrock palace and bank the yew logs' } },
  { id: 'tan-hides', name: 'buy cowhides and tan them into leather at Al Kharid', members: false, req: { items: ['Coins'] }, gpHour: 250_000, products: ['Leather'], exec: { kind: 'preset', preset: 'tan-hides' }, notes: 'scripted (TanningPlanner); gives up by itself when the margin is gone' },
  { id: 'sand-crabs-herbs', name: 'kill sand crabs (P2P, AFK)', members: true, req: { combat: 20 }, gpHour: 10_000, products: [], exec: { kind: 'combat', monster: 'Sand crab' } },
];

/**
 * Routes the "make gold" strategy rotates through: the money routes plus ones that earn coins
 * without training a gathering skill (looting, coin drops, pickpocketing, trading). The rotation
 * tries each in turn instead of always taking the best estimate, so the ledger shows which ones
 * actually pay on this account.
 */
export const GOLD: MoneyRoute[] = [
  ...MONEY,
  { id: 'feathers', name: 'kill chickens and bank their feathers', members: false, gpHour: 15_000, products: ['Feather'], exec: { kind: 'combat', monster: 'Chicken', area: { name: 'Lumbridge chicken farm', point: { x: 3232, y: 3295, plane: 0 } }, loot: ['Feather'] } },
  { id: 'guard-coins', name: 'kill Varrock guards for their coin drops', members: false, req: { combat: 30 }, recommend: { Attack: 30, Strength: 30, Defence: 25 }, gpHour: 15_000, products: [], exec: { kind: 'combat', monster: 'Guard', area: { name: 'Varrock west guards', point: { x: 3175, y: 3425, plane: 0 } }, loot: ['Coins'], food: 10 } },
  { id: 'smelt-steel', name: 'mine iron and coal, smelt steel bars and sell them', members: false, req: { skills: { Smithing: 30, Mining: 30 } }, gpHour: 100_000, products: ['Steel bar'], exec: { kind: 'preset', preset: 'smelt-steel' }, notes: 'scripted (SmeltingPlanner): Al Kharid mine and furnace, sells at 200 bars' },
  { id: 'craft-jewellery', name: 'craft gold jewellery at the Edgeville furnace and sell it', members: false, req: { skills: { Crafting: 5 }, items: ['Coins'] }, gpHour: 200_000, products: ['Gold ring', 'Sapphire ring', 'Emerald necklace', 'Ruby necklace', 'Diamond necklace'], exec: { kind: 'preset', preset: 'craft-jewellery' }, notes: 'scripted (JewelleryPlanner): best ring/necklace/amulet for the Crafting level from live prices; trains towards a better recipe (gold 5, sapphire 20, emerald 27, ruby 34, diamond 43) while it earns' },
  { id: 'herblore', name: 'clean herbs and mix unfinished potions at the Grand Exchange', members: true, req: { skills: { Herblore: 3 }, quests: ['Druidic Ritual'], items: ['Coins'] }, gpHour: 150_000, products: [], exec: { kind: 'preset', preset: 'herblore' }, notes: 'scripted (HerblorePlanner): best recipe for the level from live prices (marrentill cleaning at 5, harralander unf at 22, ranarr unf at 30)' },
  { id: 'string-amulets', name: 'string amulets with wool at the Grand Exchange', members: false, req: { items: ['Coins'] }, gpHour: 150_000, products: ['Gold amulet', 'Sapphire amulet', 'Emerald amulet', 'Ruby amulet', 'Diamond amulet'], exec: { kind: 'preset', preset: 'string-amulets' }, notes: 'scripted (StringingPlanner): picks the F2P amulet with the best live margin, gives up when none pays' },
  { id: 'pickpocket-men', name: 'pickpocket men for coins', members: false, gpHour: 8_000, products: [], exec: { kind: 'llm', goal: 'pickpocket men and women in Lumbridge for coins, eating food when hitpoints drop below half and banking when food runs out' } },
  { id: 'wool', name: 'shear sheep and spin balls of wool to sell', members: false, gpHour: 12_000, products: ['Ball of wool', 'Wool'], exec: { kind: 'llm', goal: 'take shears, shear sheep in the field north-east of Lumbridge, spin the wool into balls of wool on the Lumbridge Castle spinning wheel, and bank the balls of wool' } },
];

/** Banked items with no use to the account that the gold strategy turns into coins. */
export const JUNK = ['Bronze dagger', 'Iron dagger', 'Bronze mace', 'Iron mace', 'Bronze scimitar', 'Goblin mail', 'Bronze bar', 'Iron bar', 'Copper ore', 'Tin ore', 'Iron ore', 'Oak logs', 'Raw anchovies', 'Uncut sapphire'];

export interface QuestInfo {
  name: string;
  members: boolean;
  req?: Requirement;
  /** Why it is worth doing early: XP rewards, unlocks. */
  reward: string;
  /** XP rewards, used to schedule quests that skip early training brackets. */
  boosts?: Record<string, number>;
  /** Rough hours to complete (estimates only). Default 0.5 (F2P) / 1 (members). */
  hours?: number;
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
  { name: 'Imp Catcher', members: false, boosts: { Magic: 875 },  reward: '875 Magic XP' },
  { name: "Witch's Potion", members: false, boosts: { Magic: 325 },  reward: '325 Magic XP' },
  { name: "Doric's Quest", members: false, req: { skills: { Mining: 15 } }, reward: '1,300 Mining XP; Doric\'s anvils' },
  { name: "The Knight's Sword", members: false, req: { skills: { Mining: 10 } }, reward: '12,725 Smithing XP' },
  { name: 'Goblin Diplomacy', members: false, reward: '200 Crafting XP' },
  { name: 'Ernest the Chicken', members: false, reward: '300 coins; 4 quest points' },
  { name: 'Vampyre Slayer', members: false, boosts: { Attack: 4825 },  reward: '4,825 Attack XP' },
  { name: 'Prince Ali Rescue', members: false, reward: 'free Al Kharid toll gate' },
  { name: "Pirate's Treasure", members: false, reward: '450 coins, emerald, gold ring' },
  { name: 'Misthalin Mystery', members: false, reward: '600 Crafting XP' },
  { name: 'X Marks the Spot', members: false, reward: '300 coins, antique lamp' },
  { name: 'The Corsair Curse', members: false, reward: 'Corsair Cove bank and ogress training' },
  { name: "Black Knights' Fortress", members: false, req: { qp: 12 }, reward: '2,500 coins' },
  { name: 'Demon Slayer', members: false, reward: 'Silverlight' },
  { name: 'Below Ice Mountain', members: false, req: { qp: 16 }, reward: 'Ruins of Camdozaal access' },
  { name: 'Dragon Slayer I', members: false, boosts: { Strength: 18650, Defence: 18650 }, hours: 3,  req: { qp: 32 }, reward: '18,650 Strength and Defence XP; rune platebody' },

  { name: 'Waterfall Quest', members: true, boosts: { Attack: 13750, Strength: 13750 },  reward: '13,750 Attack and Strength XP (level 1 -> 30)' },
  { name: 'Witch\'s House', members: true, boosts: { Hitpoints: 6325 },  reward: '6,325 Hitpoints XP' },
  { name: 'Fight Arena', members: true, boosts: { Attack: 12175 },  reward: '12,175 Attack XP; 2,175 Thieving XP' },
  { name: 'Tree Gnome Village', members: true, boosts: { Attack: 11450 },  reward: '11,450 Attack XP; spirit tree access' },
  { name: 'Druidic Ritual', members: true, reward: 'Herblore unlocked' },
  { name: 'Priest in Peril', members: true, reward: '1,406 Prayer XP; Morytania access' },
  { name: 'Nature Spirit', members: true, req: { quests: ['Priest in Peril', 'The Restless Ghost'] }, reward: 'Mort Myre access; 3 x 2,000 XP' },
  { name: 'Lost City', members: true, req: { skills: { Crafting: 31, Woodcutting: 36 } }, reward: 'Zanaris; dragon longsword/dagger' },
  { name: 'The Dig Site', members: true, req: { skills: { Agility: 10, Herblore: 10, Thieving: 25 }, quests: ['Druidic Ritual'] }, reward: 'Digsite pendant; Fossil Island access via Bone Voyage', hours: 2 },
  { name: 'Bone Voyage', members: true, req: { quests: ['The Dig Site'] }, reward: 'Fossil Island (ammonite crabs); needs 100 Varrock Museum kudos', hours: 1 },
  { name: 'Monkey Madness I', members: true, req: { quests: ['The Grand Tree', 'Tree Gnome Village'] }, reward: 'dragon scimitar; big combat XP' },
];

export interface AcquireInfo {
  item: string;
  members: boolean;
  /** Price per item (gp); the GE pays guide price +30%. */
  price: number;
  source: AcquireSource;
  req?: Requirement;
}

const GE: AcquireSource = { kind: 'ge' };

/**
 * Where F2P shopkeepers stand, keyed by the wiki shop name (no trailing period). The KB has every
 * shop's stock and prices but no keeper locations; points are approximate, the keeper is found by
 * name once in view. Shops not listed here are never chosen.
 */
export const SHOP_LOCATIONS: Record<string, { keeper: string; point: WorldPoint }> = {
  "Horvik's Armour Shop": { keeper: 'Horvik', point: { x: 3229, y: 3437, plane: 0 } },
  "Wayne's Chains! - Chainmail specialist": { keeper: 'Wayne', point: { x: 2972, y: 3312, plane: 0 } },
  "Louie's Armoured Legs Bazaar": { keeper: 'Louie Legs', point: { x: 3316, y: 3175, plane: 0 } },
  'Helmet Shop': { keeper: 'Peksa', point: { x: 3076, y: 3427, plane: 0 } },
  "Cassie's Shield Shop": { keeper: 'Cassie', point: { x: 2976, y: 3383, plane: 0 } },
  "Zeke's Superior Scimitars": { keeper: 'Zeke', point: { x: 3287, y: 3190, plane: 0 } },
  "Lowe's Archery Emporium": { keeper: 'Lowe', point: { x: 3232, y: 3423, plane: 0 } },
  "Zaff's Superior Staffs!": { keeper: 'Zaff', point: { x: 3203, y: 3434, plane: 0 } },
  "Aubury's Rune Shop": { keeper: 'Aubury', point: { x: 3253, y: 3401, plane: 0 } },
  "Bob's Brilliant Axes": { keeper: 'Bob', point: { x: 3230, y: 3203, plane: 0 } },
  "Gerrant's Fishy Business": { keeper: 'Gerrant', point: { x: 3013, y: 3224, plane: 0 } },
  'Lumbridge General Store': { keeper: 'Shop keeper', point: { x: 3212, y: 3246, plane: 0 } },
};

/** F2P shops that stock starter tools. Shops first: GE buying is the less reliable path. */
export const TOOL_SHOPS = {
  bob: { kind: 'shop', name: "Bob's Brilliant Axes", keeper: 'Bob', point: { x: 3230, y: 3203, plane: 0 } },
  lumbridgeGeneral: { kind: 'shop', name: 'Lumbridge General Store', keeper: 'Shop keeper', point: { x: 3212, y: 3246, plane: 0 } },
  gerrant: { kind: 'shop', name: "Gerrant's Fishy Business", keeper: 'Gerrant', point: { x: 3013, y: 3224, plane: 0 } },
} satisfies Record<string, AcquireSource>;

/**
 * Items that training methods and quests require, and how to get them. Shops first: GE buying is
 * the less reliable path (search/price entry is not verified live yet).
 */
export const ACQUIRE: AcquireInfo[] = [
  { item: 'Bronze axe', members: false, price: 16, source: TOOL_SHOPS.bob },
  { item: 'Bronze pickaxe', members: false, price: 1, source: TOOL_SHOPS.bob },
  { item: 'Hammer', members: false, price: 1, source: TOOL_SHOPS.lumbridgeGeneral },
  { item: 'Tinderbox', members: false, price: 1, source: TOOL_SHOPS.lumbridgeGeneral },
  { item: 'Small fishing net', members: false, price: 5, source: TOOL_SHOPS.gerrant },
  { item: 'Fly fishing rod', members: false, price: 5, source: TOOL_SHOPS.gerrant },
  { item: 'Feather', members: false, price: 2, source: TOOL_SHOPS.gerrant },
  { item: 'Knife', members: false, price: 10, source: GE },
  { item: 'Lobster pot', members: false, price: 40, source: GE },
  { item: 'Harpoon', members: false, price: 3, source: TOOL_SHOPS.gerrant },
  { item: 'Barbarian rod', members: true, price: 50, source: GE },
];

/** Areas never walked into by a strategy: the Wilderness (surface and dungeons). */
export function inWilderness(p: WorldPoint): boolean {
  const surface = p.x >= 2944 && p.x <= 3391 && p.y >= 3520 && p.y <= 3967;
  const underground = p.x >= 2944 && p.x <= 3391 && p.y >= 9920 && p.y <= 10366;
  return surface || underground;
}
