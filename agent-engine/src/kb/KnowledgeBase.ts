/**
 * Read-only query API over data/kb.sqlite (built by build.ts).
 *
 * Used at runtime to enrich candidate labels with game knowledge the live client does not
 * expose (skill levels, tools, monster stats) and to resolve planner destinations ("nearest
 * bank", "nearest Iron rocks") to coordinates.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { InventoryItem, EquipmentItem, SkillState, WorldPoint } from '../types.ts';
import { inWilderness, SHOP_LOCATIONS } from '../strategy/catalog.ts';

export interface ResourceInfo {
  kind: 'npc' | 'object';
  target: string;
  action: string;
  skill: string;
  level: number;
  tools: string[];
  consumes: string[];
  products: string[];
  members: boolean;
}

export interface StationInfo {
  target: string;
  action: string;
  skill: string;
  inputs: string[];
}

export interface MonsterInfo {
  npcId: number;
  name: string;
  combatLevel: number | null;
  hitpoints: number | null;
  maxHit: string[];
  attackStyle: string[];
  attributes: string[];
  poisonous: string | null;
  slayerLevel: number | null;
}

export interface Place {
  name: string;
  kind: 'label' | 'bank' | 'deposit_box' | 'object' | 'spawn';
  point: WorldPoint;
  members: boolean;
  distance?: number;
}

export interface PlayerContext {
  skills: SkillState[];
  inventory: InventoryItem[];
  equipment: EquipmentItem[];
}

const parse = (s: unknown): string[] => (typeof s === 'string' ? (JSON.parse(s) as string[]) : []);

/** Tiles-equivalent cost of each floor of stairs/ladders between two points. */
export const FLOOR_COST = 20;

/**
 * Chebyshev distance (the metric tiles use), plus FLOOR_COST per floor of difference. Upper-floor
 * banks (Lumbridge castle top floor) must stay "near"; a huge cross-plane penalty used to push the
 * agent toward a ground-floor bank on the other side of a toll gate.
 */
export function tileDistance(a: WorldPoint, b: WorldPoint): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) + FLOOR_COST * Math.abs(a.plane - b.plane);
}

export class KnowledgeBase {
  private readonly db: DatabaseSync;
  private readonly stmts = new Map<string, StatementSync>();
  private resourceCache: ResourceInfo[] | null = null;
  private stationCache: StationInfo[] | null = null;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true });
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  // --- definitions ---------------------------------------------------------------------------

  item(id: number): { id: number; name: string; stackable: boolean; noted: boolean; inventoryActions: string[] } | null {
    const r = this.stmt('SELECT id, name, stackable, noted, inventory_actions FROM items WHERE id = ?').get(id);
    if (!r) return null;
    return { id: r.id as number, name: r.name as string, stackable: r.stackable === 1, noted: r.noted === 1, inventoryActions: parse(r.inventory_actions) };
  }

  itemIdsByName(name: string): number[] {
    return this.stmt('SELECT id FROM items WHERE name = ? COLLATE NOCASE AND noted = 0').all(name).map((r) => r.id as number);
  }

  /** Base store value (coins) of an item by name, or null when unknown. Shops pay a fraction of it; High Alchemy 60%. */
  itemValue(name: string): number | null {
    const r = this.stmt('SELECT cost FROM items WHERE name = ? COLLATE NOCASE AND noted = 0 AND cost IS NOT NULL LIMIT 1').get(name);
    return r ? (r.cost as number) : null;
  }

  npc(id: number): { id: number; name: string | null; combatLevel: number; actions: string[]; wikiPage: string | null } | null {
    const r = this.stmt('SELECT id, name, combat_level, actions, wiki_page FROM npcs WHERE id = ?').get(id);
    if (!r) return null;
    return { id: r.id as number, name: (r.name as string) ?? null, combatLevel: r.combat_level as number, actions: parse(r.actions), wikiPage: (r.wiki_page as string) ?? null };
  }

  monster(npcId: number): MonsterInfo | null {
    const r = this.stmt('SELECT * FROM monsters WHERE npc_id = ?').get(npcId);
    if (!r) return null;
    return {
      npcId,
      name: r.name as string,
      combatLevel: (r.combat_level as number) ?? null,
      hitpoints: (r.hitpoints as number) ?? null,
      maxHit: parse(r.max_hit),
      attackStyle: parse(r.attack_style),
      attributes: parse(r.attributes),
      poisonous: (r.poisonous as string) ?? null,
      slayerLevel: (r.slayer_level as number) ?? null,
    };
  }

  // --- curated skilling data -------------------------------------------------------------------

  resources(): ResourceInfo[] {
    this.resourceCache ??= this.stmt('SELECT * FROM resources').all().map((r) => ({
      kind: r.kind as 'npc' | 'object',
      target: r.target as string,
      action: r.action as string,
      skill: r.skill as string,
      level: r.level as number,
      tools: parse(r.tools),
      consumes: parse(r.consumes),
      products: parse(r.products),
      members: r.members === 1,
    }));
    return this.resourceCache;
  }

  resourceFor(kind: 'npc' | 'object', target: string, action: string): ResourceInfo | null {
    const t = target.toLowerCase();
    const a = action.toLowerCase();
    return this.resources().find((r) => r.kind === kind && r.target.toLowerCase() === t && r.action.toLowerCase() === a) ?? null;
  }

  /** Resources whose products match (substring, case-insensitive), e.g. "iron ore" -> Iron rocks. */
  resourcesProducing(product: string): ResourceInfo[] {
    const p = product.toLowerCase();
    return this.resources().filter((r) => r.products.some((x) => x.toLowerCase().includes(p)));
  }

  stations(): StationInfo[] {
    this.stationCache ??= this.stmt('SELECT * FROM stations').all().map((r) => ({
      target: r.target as string,
      action: r.action as string,
      skill: r.skill as string,
      inputs: parse(r.inputs),
    }));
    return this.stationCache;
  }

  stationFor(target: string, action: string): StationInfo | null {
    const t = target.toLowerCase();
    const a = action.toLowerCase();
    return this.stations().find((s) => s.target.toLowerCase() === t && s.action.toLowerCase() === a) ?? null;
  }

  /** Requirements of a resource the player does not meet, e.g. ["Mining 15", "pickaxe"]. */
  unmetRequirements(rule: ResourceInfo, ctx: PlayerContext): string[] {
    const unmet: string[] = [];
    const skill = ctx.skills.find((s) => s.name.toLowerCase() === rule.skill.toLowerCase());
    if (skill && skill.level < rule.level) unmet.push(`${rule.skill} ${rule.level}`);
    const held = [...ctx.inventory.map((i) => i.name), ...ctx.equipment.map((e) => e.name)].map((n) => n.toLowerCase());
    if (rule.tools.length > 0 && !rule.tools.some((t) => held.some((h) => h.includes(t)))) unmet.push(rule.tools.join(' or '));
    for (const c of rule.consumes) {
      if (!held.some((h) => h.includes(c))) unmet.push(c);
    }
    return unmet;
  }

  // --- places ----------------------------------------------------------------------------------

  /** Named places by case-insensitive substring, nearest first when `from` is given. */
  findPlaces(query: string, from?: WorldPoint, limit = 5): Place[] {
    const rows = this.stmt('SELECT name, kind, x, y, plane, members FROM places WHERE name LIKE ? COLLATE NOCASE')
      .all(`%${query}%`)
      .map((r) => this.toPlace(r, from))
      .filter((p) => safeFrom(p.point, from));
    return sortAndLimit(rows, from, limit);
  }

  /**
   * Nearest banks and deposit boxes. Banks Microbot marks as conditional (quest, PvP world,
   * guild access) are skipped unless `includeConditional`. Wilderness banks (Ferox Enclave) never
   * qualify: the walk there crosses PvP ground, and leaving Ferox by portal strands an F2P account
   * in the Castle Wars lobby.
   */
  nearestBanks(from: WorldPoint, limit = 3, includeMembers = true, includeConditional = false): Place[] {
    const rows = this.stmt("SELECT name, kind, x, y, plane, members, requirement FROM places WHERE kind IN ('bank', 'deposit_box')")
      .all()
      .filter((r) => includeConditional || r.requirement == null)
      .map((r) => this.toPlace(r, from))
      .filter((p) => (includeMembers || !p.members) && !inWilderness(p.point));
    return sortAndLimit(rows, from, limit);
  }

  /** Map labels (towns, areas) near a point: "where am I" context for the decision engine. */
  labelsNear(from: WorldPoint, radius = 60, limit = 3): Place[] {
    const rows = this.stmt(
      "SELECT name, kind, x, y, plane, members FROM places WHERE kind = 'label' AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?",
    )
      .all(from.x - radius, from.x + radius, from.y - radius, from.y + radius)
      .map((r) => this.toPlace(r, from));
    return sortAndLimit(rows, from, limit);
  }

  /** Nearest placements of an object by exact name (optionally requiring an action). */
  nearestObjects(name: string, from: WorldPoint, opts: { action?: string; radius?: number; limit?: number } = {}): Place[] {
    const radius = opts.radius ?? 400;
    const rows = this.stmt(
      'SELECT name, actions, x, y, plane FROM locations WHERE name = ? COLLATE NOCASE AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?',
    )
      .all(name, from.x - radius, from.x + radius, from.y - radius, from.y + radius)
      .filter((r) => !opts.action || parse(r.actions).some((a) => a.toLowerCase() === opts.action!.toLowerCase()))
      .map((r) => ({ name: r.name as string, kind: 'object' as const, point: { x: r.x as number, y: r.y as number, plane: r.plane as number }, members: false }))
      .filter((p) => safeFrom(p.point, from));
    return sortAndLimit(rows, from, opts.limit ?? 5);
  }

  /** Nearest wiki spawn points for an NPC/scenery/item page name. */
  nearestSpawns(page: string, from: WorldPoint, opts: { radius?: number; limit?: number } = {}): Place[] {
    const radius = opts.radius ?? 400;
    const rows = this.stmt(
      'SELECT page, x, y, plane, members FROM spawns WHERE page = ? COLLATE NOCASE AND x BETWEEN ? AND ? AND y BETWEEN ? AND ?',
    )
      .all(page, from.x - radius, from.x + radius, from.y - radius, from.y + radius)
      .map((r) => ({ name: r.page as string, kind: 'spawn' as const, point: { x: r.x as number, y: r.y as number, plane: r.plane as number }, members: r.members === 1 }))
      .filter((p) => safeFrom(p.point, from));
    return sortAndLimit(rows, from, opts.limit ?? 5);
  }

  /**
   * Shops that sell `item` for coins, among the shops with a known keeper location
   * (`SHOP_LOCATIONS`): cheapest first, then nearest.
   */
  shopOffers(item: string, from: WorldPoint): { shop: string; keeper: string; point: WorldPoint; price: number }[] {
    const out: { shop: string; keeper: string; point: WorldPoint; price: number; distance: number }[] = [];
    for (const r of this.stmt('SELECT shop, sell_price FROM shop_stock WHERE item = ? COLLATE NOCASE AND currency = ?').all(item, 'Coins')) {
      const shop = String(r.shop).replace(/\.$/, '');
      const loc = SHOP_LOCATIONS[shop];
      const price = Number(r.sell_price);
      if (!loc || !Number.isFinite(price) || price <= 0) continue;
      out.push({ shop, keeper: loc.keeper, point: loc.point, price, distance: tileDistance(from, loc.point) });
    }
    return out.sort((a, b) => a.price - b.price || a.distance - b.distance).map(({ distance: _d, ...o }) => o);
  }

  shopsSelling(item: string): { shop: string; sellPrice: string | null; stock: string | null }[] {
    return this.stmt('SELECT shop, sell_price, stock FROM shop_stock WHERE item = ? COLLATE NOCASE')
      .all(item)
      .map((r) => ({ shop: r.shop as string, sellPrice: (r.sell_price as string) ?? null, stock: (r.stock as string) ?? null }));
  }

  private toPlace(r: Record<string, unknown>, from?: WorldPoint): Place {
    const point = { x: r.x as number, y: r.y as number, plane: r.plane as number };
    return {
      name: r.name as string,
      kind: r.kind as Place['kind'],
      point,
      members: r.members === 1,
      distance: from ? tileDistance(from, point) : undefined,
    };
  }
}

function sortAndLimit(rows: Place[], from: WorldPoint | undefined, limit: number): Place[] {
  if (from) {
    for (const r of rows) r.distance = tileDistance(from, r.point);
    rows.sort((a, b) => a.distance! - b.distance!);
  }
  return rows.slice(0, limit);
}

/**
 * Wilderness points are never offered from outside it: "nearest Iron rocks" from Edgeville bank
 * were the Wilderness rocks north of the ditch, and the account went mining among player killers.
 * Inside the Wilderness everything stays available (the way out may lead through it).
 */
function safeFrom(p: WorldPoint, from?: WorldPoint): boolean {
  return !inWilderness(p) || (from !== undefined && inWilderness(from));
}
