/**
 * Builds data/kb.sqlite from:
 *   - data/kb-raw/{items,npcs,objects,locations,map_elements}.jsonl   (cache, via kb-dumper)
 *   - data/kb-raw/wiki_*.jsonl                                        (OSRS Wiki, via wiki.ts)
 *   - Microbot's BankLocation / DepositBoxLocation enums              (named bank coordinates)
 *   - resources.ts                                                    (curated skill requirements)
 *
 * Run: node src/kb/build.ts [--raw data/kb-raw] [--out data/kb.sqlite]
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { RESOURCES, STATIONS } from './resources.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const MICROBOT_UTIL = path.join(REPO, 'runelite-client/src/main/java/net/runelite/client/plugins/microbot/util');

const SCHEMA = `
CREATE TABLE items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, members INTEGER, stackable INTEGER, noted INTEGER,
  noted_id INTEGER, tradeable INTEGER, cost INTEGER, wear_pos INTEGER,
  inventory_actions TEXT, ground_actions TEXT
);
CREATE INDEX items_name ON items(name COLLATE NOCASE);

CREATE TABLE npcs (
  id INTEGER PRIMARY KEY, name TEXT, combat_level INTEGER, size INTEGER, actions TEXT,
  transforms TEXT, wiki_page TEXT
);
CREATE INDEX npcs_name ON npcs(name COLLATE NOCASE);

CREATE TABLE monsters (
  npc_id INTEGER PRIMARY KEY, name TEXT, combat_level INTEGER, hitpoints INTEGER, max_hit TEXT,
  attack_style TEXT, attack_speed INTEGER, attributes TEXT, poisonous TEXT, slayer_level INTEGER, members INTEGER
);

CREATE TABLE objects (
  id INTEGER PRIMARY KEY, name TEXT, size_x INTEGER, size_y INTEGER, actions TEXT, transforms TEXT
);
CREATE INDEX objects_name ON objects(name COLLATE NOCASE);

-- Interactable object placements. name/actions are denormalized (resolved through multi-loc
-- transforms when the base object is unnamed) so area queries need no join.
CREATE TABLE locations (
  object_id INTEGER, name TEXT, actions TEXT, x INTEGER, y INTEGER, plane INTEGER, type INTEGER, orientation INTEGER
);
CREATE INDEX locations_xy ON locations(plane, x, y);
CREATE INDEX locations_name ON locations(name COLLATE NOCASE);

-- One row per spawn coordinate from the wiki location tables.
CREATE TABLE spawns (
  page TEXT, kind TEXT, x INTEGER, y INTEGER, plane INTEGER, members INTEGER
);
CREATE INDEX spawns_xy ON spawns(plane, x, y);
CREATE INDEX spawns_page ON spawns(page COLLATE NOCASE);

-- Named places the planner can send the player to: map labels, banks, deposit boxes.
CREATE TABLE places (
  name TEXT, kind TEXT, x INTEGER, y INTEGER, plane INTEGER, members INTEGER,
  -- Non-null when access is conditional (quest, PvP world, guild): from BankLocation.hasRequirements.
  requirement TEXT
);
CREATE INDEX places_name ON places(name COLLATE NOCASE);

CREATE TABLE shops (page TEXT PRIMARY KEY, name TEXT, owner TEXT, location TEXT, members INTEGER, specialty TEXT);
CREATE TABLE shop_stock (shop TEXT, item TEXT, buy_price TEXT, sell_price TEXT, currency TEXT, stock TEXT);
CREATE INDEX shop_stock_item ON shop_stock(item COLLATE NOCASE);

CREATE TABLE resources (
  kind TEXT, target TEXT, action TEXT, skill TEXT, level INTEGER, tools TEXT, consumes TEXT, products TEXT, members INTEGER
);
CREATE INDEX resources_target ON resources(target COLLATE NOCASE);

CREATE TABLE stations (target TEXT, action TEXT, skill TEXT, inputs TEXT);

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

type Row = Record<string, unknown>;

function readJsonl<T = Row>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

const bool = (v: unknown): number => (v === true || v === 'true' || v === 'Yes' || v === 1 ? 1 : 0);
const json = (v: unknown): string => JSON.stringify(v ?? []);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * Reads the `case NAME:` branches of BankLocation.hasRequirements() and returns, per enum name, a
 * short description of the requirement (its first comment line, or "conditional").
 */
export function parseRequirementCases(source: string): Map<string, string> {
  const out = new Map<string, string>();
  const start = source.indexOf('hasRequirements()');
  if (start < 0) return out;
  const body = source.slice(start);
  const re = /case\s+([A-Z0-9_]+)\s*:([\s\S]*?)(?=case\s+[A-Z0-9_]+\s*:|default\s*:|$)/g;
  let pending: string[] = [];
  for (const m of body.matchAll(re)) {
    const name = m[1]!;
    const block = m[2]!.trim();
    pending.push(name);
    if (block.length === 0) continue; // fall-through: shares the next case's requirement
    const comment = /\/\/\s*(.+)/.exec(block)?.[1]?.trim() ?? 'conditional';
    for (const n of pending) out.set(n, comment);
    pending = [];
  }
  return out;
}

/** Parses `NAME(new WorldPoint(x, y, plane)[, members])` enum constants out of a Microbot source file. */
export function parseWorldPointEnum(source: string): { name: string; x: number; y: number; plane: number; members: boolean }[] {
  const re = /^\s*([A-Z0-9_]+)\s*\(\s*new WorldPoint\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)\s*(?:,\s*(true|false))?/gm;
  const out = [];
  for (const m of source.matchAll(re)) {
    out.push({ name: m[1]!, x: Number(m[2]), y: Number(m[3]), plane: Number(m[4]), members: m[5] === 'true' });
  }
  return out;
}

const titleCase = (enumName: string) =>
  enumName.toLowerCase().split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/** Wiki coordinates come as "x:3202,y:3253" or "3202,3253". */
export function parseWikiCoordinate(raw: string): { x: number; y: number } | null {
  const tagged = /x:\s*(\d+)\s*,\s*y:\s*(\d+)/.exec(raw);
  if (tagged) return { x: Number(tagged[1]), y: Number(tagged[2]) };
  const plain = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(raw);
  if (plain) return { x: Number(plain[1]), y: Number(plain[2]) };
  return null;
}

export function buildKnowledgeBase(rawDir: string, outFile: string): Record<string, number> {
  rmSync(outFile, { force: true });
  const db = new DatabaseSync(outFile);
  db.exec(SCHEMA);
  db.exec('BEGIN');
  const counts: Record<string, number> = {};

  const insert = (table: string, cols: string[]) => {
    const stmt = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    return (...values: (string | number | null | undefined)[]) => {
      stmt.run(...values.map((v) => v ?? null));
      counts[table] = (counts[table] ?? 0) + 1;
    };
  };

  // --- cache definitions ---------------------------------------------------------------
  const addItem = insert('items', ['id', 'name', 'members', 'stackable', 'noted', 'noted_id', 'tradeable', 'cost', 'wear_pos', 'inventory_actions', 'ground_actions']);
  for (const i of readJsonl(path.join(rawDir, 'items.jsonl'))) {
    addItem(i.id as number, i.name as string, bool(i.members), bool(i.stackable), bool(i.noted), i.notedId as number,
      bool(i.tradeable), i.cost as number, i.wearPos as number, json(i.inventoryActions), json(i.groundActions));
  }

  // NPC id -> wiki page, from infobox_npc and infobox_monster id lists.
  const npcPage = new Map<number, string>();
  const npcPages = new Set<string>();
  for (const r of readJsonl(path.join(rawDir, 'wiki_infobox_npc.jsonl'))) {
    npcPages.add(r.page_name as string);
    for (const id of asArray(r.npc_id)) npcPage.set(Number(id), r.page_name as string);
  }
  const monsters = readJsonl(path.join(rawDir, 'wiki_infobox_monster.jsonl'));
  for (const r of monsters) {
    npcPages.add(r.page_name as string);
    for (const id of asArray(r.id)) npcPage.set(Number(id), r.page_name as string);
  }

  const addNpc = insert('npcs', ['id', 'name', 'combat_level', 'size', 'actions', 'transforms', 'wiki_page']);
  for (const n of readJsonl(path.join(rawDir, 'npcs.jsonl'))) {
    addNpc(n.id as number, (n.name as string) ?? null, n.combatLevel as number, n.size as number, json(n.actions),
      n.transforms ? json(n.transforms) : null, npcPage.get(n.id as number) ?? null);
  }

  const addMonster = insert('monsters', ['npc_id', 'name', 'combat_level', 'hitpoints', 'max_hit', 'attack_style', 'attack_speed', 'attributes', 'poisonous', 'slayer_level', 'members']);
  const seenMonster = new Set<number>();
  for (const m of monsters) {
    for (const id of asArray(m.id)) {
      const npcId = Number(id);
      if (!Number.isFinite(npcId) || seenMonster.has(npcId)) continue;
      seenMonster.add(npcId);
      addMonster(npcId, (m.name as string) ?? (m.page_name as string), (m.combat_level as number) ?? null,
        (m.hitpoints as number) ?? null, json(m.max_hit), json(m.attack_style), (m.attack_speed as number) ?? null,
        json(m.attribute), (m.poisonous as string) ?? null, (m.slayer_level as number) ?? null, bool(m.is_members_only));
    }
  }

  const objects = new Map<number, Row>();
  const addObject = insert('objects', ['id', 'name', 'size_x', 'size_y', 'actions', 'transforms']);
  for (const o of readJsonl(path.join(rawDir, 'objects.jsonl'))) {
    objects.set(o.id as number, o);
    addObject(o.id as number, (o.name as string) ?? null, o.sizeX as number, o.sizeY as number, json(o.actions),
      o.transforms ? json(o.transforms) : null);
  }

  // Resolve an unnamed multi-loc to its first named, actionable transform (e.g. rocks whose
  // base id is a varbit switch). Good enough for "what is at this tile"; the live client
  // reports the exact current transform.
  const resolveObject = (id: number): { name: string | null; actions: unknown[] } => {
    const o = objects.get(id);
    if (!o) return { name: null, actions: [] };
    if (o.name && asArray(o.actions).length > 0) return { name: o.name as string, actions: asArray(o.actions) };
    for (const t of asArray(o.transforms)) {
      const to = objects.get(Number(t));
      if (to?.name && asArray(to.actions).length > 0) return { name: to.name as string, actions: asArray(to.actions) };
    }
    return { name: (o.name as string) ?? null, actions: asArray(o.actions) };
  };

  const addLocation = insert('locations', ['object_id', 'name', 'actions', 'x', 'y', 'plane', 'type', 'orientation']);
  for (const [id, x, y, plane, type, orientation] of readJsonl<number[]>(path.join(rawDir, 'locations.jsonl'))) {
    const r = resolveObject(id!);
    addLocation(id!, r.name, json(r.actions), x!, y!, plane!, type!, orientation!);
  }

  // --- places ----------------------------------------------------------------------------
  const addPlace = insert('places', ['name', 'kind', 'x', 'y', 'plane', 'members', 'requirement']);
  for (const e of readJsonl(path.join(rawDir, 'map_elements.jsonl'))) {
    addPlace(e.name as string, 'label', e.x as number, e.y as number, e.plane as number, bool(e.members), null);
  }
  const enumSources: [string, string, string][] = [
    ['bank/enums/BankLocation.java', 'bank', ' bank'],
    ['depositbox/DepositBoxLocation.java', 'deposit_box', ' deposit box'],
  ];
  for (const [rel, kind, suffix] of enumSources) {
    const file = path.join(MICROBOT_UTIL, rel);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, 'utf8');
    const requirements = parseRequirementCases(source);
    for (const p of parseWorldPointEnum(source)) {
      addPlace(titleCase(p.name) + suffix, kind, p.x, p.y, p.plane, p.members ? 1 : 0, requirements.get(p.name) ?? null);
    }
  }

  // --- wiki spawns ------------------------------------------------------------------------
  const sceneryPages = new Set(readJsonl(path.join(rawDir, 'wiki_infobox_scenery.jsonl')).map((r) => r.page_name as string));
  const itemNames = new Set(readJsonl(path.join(rawDir, 'items.jsonl')).map((r) => String(r.name).toLowerCase()));
  const addSpawn = insert('spawns', ['page', 'kind', 'x', 'y', 'plane', 'members']);
  for (const r of readJsonl(path.join(rawDir, 'wiki_locline.jsonl'))) {
    const page = r.page_name as string;
    const kind = npcPages.has(page) ? 'npc' : sceneryPages.has(page) ? 'object' : itemNames.has(page.toLowerCase()) ? 'item' : 'other';
    for (const c of asArray(r.coordinates)) {
      const xy = parseWikiCoordinate(String(c));
      if (xy) addSpawn(page, kind, xy.x, xy.y, Number(r.plane ?? 0), bool(r.members));
    }
  }

  // --- shops ------------------------------------------------------------------------------
  const addShop = insert('shops', ['page', 'name', 'owner', 'location', 'members', 'specialty']);
  const shopSeen = new Set<string>();
  for (const s of readJsonl(path.join(rawDir, 'wiki_infobox_shop.jsonl'))) {
    const page = s.page_name as string;
    if (shopSeen.has(page)) continue;
    shopSeen.add(page);
    addShop(page, (s.shop_name as string) ?? page, (s.owner as string) ?? null, (s.location as string) ?? null,
      bool(s.is_members_only), (s.specialty as string) ?? null);
  }
  const addStock = insert('shop_stock', ['shop', 'item', 'buy_price', 'sell_price', 'currency', 'stock']);
  for (const s of readJsonl(path.join(rawDir, 'wiki_storeline.jsonl'))) {
    addStock(s.sold_by as string, s.sold_item as string, (s.store_buy_price as string) ?? null,
      (s.store_sell_price as string) ?? null, (s.store_currency as string) ?? null, (s.store_stock as string) ?? null);
  }

  // --- curated ----------------------------------------------------------------------------
  const addResource = insert('resources', ['kind', 'target', 'action', 'skill', 'level', 'tools', 'consumes', 'products', 'members']);
  for (const r of RESOURCES) {
    addResource(r.kind, r.target, r.action, r.skill, r.level, json(r.tools), json(r.consumes), json(r.products), r.members ? 1 : 0);
  }
  const addStation = insert('stations', ['target', 'action', 'skill', 'inputs']);
  for (const s of STATIONS) addStation(s.target, s.action, s.skill, json(s.inputs));

  const manifestFile = path.join(rawDir, 'manifest.json');
  const addMeta = insert('meta', ['key', 'value']);
  addMeta('built_at', new Date().toISOString());
  if (existsSync(manifestFile)) addMeta('cache_manifest', readFileSync(manifestFile, 'utf8'));

  db.exec('COMMIT');
  db.close();
  delete counts.meta;
  return counts;
}

if (import.meta.main) {
  const arg = (flag: string, dflt: string) => {
    const i = process.argv.indexOf(flag);
    return path.resolve(i > 0 ? process.argv[i + 1]! : dflt);
  };
  const counts = buildKnowledgeBase(arg('--raw', 'data/kb-raw'), arg('--out', 'data/kb.sqlite'));
  console.log(JSON.stringify(counts));
}
