/**
 * Core contracts shared by the backend, knowledge base, engine and planner.
 *
 * Coordinates follow RuneLite: x/y on the world map, plane 0-3. "tick" is the client's game tick
 * counter (600 ms per tick), which is the natural clock for waiting on effects.
 */

export interface WorldPoint {
  x: number;
  y: number;
  plane: number;
}

// ---------------------------------------------------------------------------------------------
// Snapshot: what GET /snapshot on the Microbot agent server returns.
// ---------------------------------------------------------------------------------------------

export interface PlayerState {
  name: string | null;
  combatLevel: number;
  position: WorldPoint;
  hp: { current: number; max: number };
  prayer: { current: number; max: number };
  /** 0-100. */
  runEnergy: number;
  runEnabled: boolean;
  /** Selected combat tab style button, 0-3 (varp 43). */
  attackStyle?: number;
  /** Modern-spellbook spell set to autocast (e.g. WIND_STRIKE), or null. */
  autocast?: string | null;
  /** 0-100. */
  specialAttack: number;
  animation: number;
  animating: boolean;
  moving: boolean;
  inCombat: boolean;
  interacting: { type: 'npc' | 'player' | 'other'; name: string | null; index: number } | null;
}

export interface SkillState {
  name: string;
  level: number;
  boosted: number;
  xp: number;
}

export interface InventoryItem {
  slot: number;
  id: number;
  name: string;
  quantity: number;
  noted: boolean;
  stackable: boolean;
  actions: string[];
}

export interface EquipmentItem {
  slot: string;
  id: number;
  name: string;
  /** Stack size (arrows/runes in the ammo slot); 1 for other items. */
  quantity?: number;
}

export interface SnapshotNpc {
  index: number;
  id: number;
  name: string;
  combatLevel: number;
  actions: string[];
  position: WorldPoint;
  distance: number;
  healthRatio: number;
  healthScale: number;
  interactingWithPlayer: boolean;
  /** Fighting / talking to another player. */
  interactingWithOther?: boolean;
  animation: number;
  reachable: boolean;
  /** Walking distance to the best tile beside it; -1 when unreachable. */
  pathDistance: number;
}

export interface SnapshotObject {
  id: number;
  name: string;
  type: string;
  actions: string[];
  position: WorldPoint;
  distance: number;
  reachable: boolean;
  pathDistance: number;
}

export interface SnapshotGroundItem {
  id: number;
  name: string;
  quantity: number;
  position: WorldPoint;
  distance: number;
  geValue: number;
  lootable: boolean;
  reachable: boolean;
  pathDistance: number;
}

export interface DialogueState {
  inDialogue: boolean;
  hasContinue: boolean;
  hasOptions: boolean;
  text?: string;
  question?: string;
  options: string[];
}

export interface BankItem {
  slot: number;
  id: number;
  name: string;
  quantity: number;
}

export interface BankState {
  open: boolean;
  items: BankItem[];
}

/** The skilling "how many?" interface (cook, smelt, fletch...). */
export interface ProductionState {
  open: boolean;
  /** "make": skill-multi chatbox (cook, smelt, fletch); "smithing": the anvil grid. */
  interface?: 'make' | 'smithing' | null;
  options: string[];
}

export interface ShopState {
  open: boolean;
  items: { id: number; name: string; quantity: number }[];
}

export interface WalkStatus {
  active: boolean;
  target?: WorldPoint;
  distanceToTarget?: number;
}

export interface GameMessage {
  tick: number;
  type: string;
  text: string;
}

export interface Snapshot {
  tick: number;
  /** Wall-clock ms on the client when the snapshot was taken. */
  timestamp: number;
  loggedIn: boolean;
  /** Logged in but still on the "CLICK HERE TO PLAY" welcome screen. */
  welcomeScreen?: boolean;
  gameState: string;
  player: PlayerState | null;
  skills: SkillState[];
  inventory: { freeSlots: number; items: InventoryItem[] };
  equipment: EquipmentItem[];
  npcs: SnapshotNpc[];
  objects: SnapshotObject[];
  groundItems: SnapshotGroundItem[];
  dialogue: DialogueState;
  production: ProductionState;
  bank: BankState;
  shop: ShopState;
  walk: WalkStatus;
  /** Recent game/system messages only; other players' chat is never included. */
  messages: GameMessage[];
}

// ---------------------------------------------------------------------------------------------
// Targets and actions: what POST /act accepts.
// ---------------------------------------------------------------------------------------------

export type TargetRef =
  | { kind: 'npc'; index: number; id: number }
  | { kind: 'object'; id: number; x: number; y: number; plane: number }
  | { kind: 'ground_item'; id: number; x: number; y: number; plane: number }
  | { kind: 'inventory'; slot: number; id: number }
  | { kind: 'equipment'; slot: string; id: number }
  | { kind: 'dialogue'; option: string };

export type GameAction =
  | { op: 'interact'; target: TargetRef; action: string }
  | { op: 'use_item_on'; itemSlot: number; target: TargetRef }
  | { op: 'walk'; to: WorldPoint; distance?: number; label?: string }
  | { op: 'walk_cancel' }
  | { op: 'dialogue_continue' }
  | { op: 'dialogue_select'; option: string }
  /** amount applies to the anvil smithing grid (1, 5, 10 or 'all'); the make-X chatbox always makes all. */
  | { op: 'production_select'; option: string; amount?: 1 | 5 | 10 | 'all' }
  | { op: 'bank_open' }
  | { op: 'bank_close' }
  | { op: 'bank_deposit_all' }
  | { op: 'bank_deposit'; itemId: number; amount: number | 'all' }
  | { op: 'bank_withdraw'; itemId: number; amount: number | 'all' }
  | { op: 'drop'; slot: number }
  | { op: 'shop_buy'; itemId: number; amount: 1 | 5 | 10 | 50 }
  | { op: 'shop_close' }
  | { op: 'toggle_run'; enabled: boolean }
  /** Combat tab style button 0-3 (e.g. bows: 0 accurate, 1 rapid, 2 longrange). */
  | { op: 'attack_style'; index: number }
  /** Autocast a combat spell (needs a staff): WIND_STRIKE, WATER_STRIKE, EARTH_STRIKE, FIRE_STRIKE, ... */
  | { op: 'autocast'; spell: string; defensive?: boolean }
  | { op: 'wait'; ticks: number }
  | { op: 'done' };

export interface ActResponse {
  success: boolean;
  op: string;
  tick: number;
  reason?: string;
}

// ---------------------------------------------------------------------------------------------
// Candidates: the engine's per-tick option list, one entry per (target, action) pair.
// ---------------------------------------------------------------------------------------------

export type CandidateKind =
  | 'npc'
  | 'object'
  | 'ground_item'
  | 'inventory'
  | 'equipment'
  | 'bank_item'
  | 'shop_item'
  | 'dialogue'
  | 'production'
  | 'destination';

export interface Candidate {
  /** Stable within one step, e.g. "npc:1530#Net". Used as the decision-engine option key. */
  id: string;
  kind: CandidateKind;
  name: string;
  action: string;
  /** Rich, human-readable option text shown to the decision engine. */
  label: string;
  /** The concrete action to send when this candidate is chosen. */
  gameAction: GameAction;
  distance?: number;
  /** Requirements the player does not meet (level, tool). Unmet candidates are dropped or ranked last. */
  unmet?: string[];
  score?: number;
}

export interface Destination {
  id: string;
  label: string;
  to: WorldPoint;
  distance: number;
}

// ---------------------------------------------------------------------------------------------
// Sub-goals: what the planner hands the per-tick engine.
// ---------------------------------------------------------------------------------------------

export interface SubGoal {
  /** Natural-language instruction for the decision engine, e.g. "catch shrimp with the small net". */
  text: string;
  /** Optional hints that narrow the candidate list (target names, actions, destinations). */
  targets?: string[];
  actions?: string[];
  destination?: { name?: string; point?: WorldPoint };
  /** Everything needed is right here (a drop to pick up, a monster in view): offer no walk destinations. */
  noTravel?: boolean;
  /** Items that must never be dropped or deposited (tools, bait). Case-insensitive substrings. */
  keep?: string[];
  /** Target inventory counts; withdraw/buy options show what is still missing and never overshoot. */
  want?: { name: string; count: number }[];
  /** Entity names never to offer (exact, case-insensitive), e.g. the bronze-only "Rusted anvil". */
  avoid?: string[];
  /** Positions whose objects are never offered (known unreachable placements), within 1 tile. */
  avoidAt?: WorldPoint[];
  /** Never offer attacking NPCs above this combat level. */
  maxTargetLevel?: number;
  /** Quantity to make per production pick (anvil grid only). Default: all. */
  makeAmount?: 1 | 5 | 10;
  /** Deterministic completion check; when absent the decision engine's `done` answer decides. */
  isDone?: (snapshot: Snapshot) => boolean;
  /** Give up after this many engine steps without completion. */
  maxSteps?: number;
}
