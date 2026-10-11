/**
 * Pulls the OSRS Wiki structured-data tables ("buckets") the knowledge base needs and writes
 * them to data/kb-raw/wiki_<bucket>.jsonl.
 *
 * The cache has every definition and object placement, but not NPC spawns (server-side) or
 * shop stock; those come from the wiki. Wiki content is CC BY-NC-SA 3.0.
 *
 * Run: node src/kb/wiki.ts [--out data/kb-raw]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API = 'https://oldschool.runescape.wiki/api.php';
const USER_AGENT = 'microbot-agent-engine-kb/0.1 (knowledge-base builder; low request rate)';
const PAGE_SIZE = 5000;
const REQUEST_GAP_MS = 1000;

export interface BucketSpec {
  bucket: string;
  fields: string[];
}

export const BUCKETS: BucketSpec[] = [
  // One row per location table line on an NPC/monster page: coordinates of every spawn.
  { bucket: 'locline', fields: ['page_name', 'page_name_sub', 'coordinates', 'plane', 'mapid', 'members'] },
  { bucket: 'infobox_npc', fields: ['page_name', 'page_name_sub', 'npc_id', 'npc_name', 'location', 'is_members_only', 'quest'] },
  {
    bucket: 'infobox_monster',
    fields: [
      'page_name', 'page_name_sub', 'id', 'name', 'combat_level', 'hitpoints', 'max_hit', 'attribute',
      'is_members_only', 'slayer_level', 'attack_style', 'attack_speed', 'poisonous', 'size',
    ],
  },
  { bucket: 'infobox_shop', fields: ['page_name', 'shop_name', 'owner', 'location', 'is_members_only', 'specialty'] },
  { bucket: 'storeline', fields: ['sold_by', 'sold_item', 'store_buy_price', 'store_sell_price', 'store_currency', 'store_stock'] },
  { bucket: 'infobox_scenery', fields: ['page_name', 'page_name_sub', 'object_id', 'is_members_only'] },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildQuery(spec: BucketSpec, offset: number): string {
  const fields = spec.fields.map((f) => `'${f}'`).join(',');
  return `bucket('${spec.bucket}').select(${fields}).limit(${PAGE_SIZE}).offset(${offset}).run()`;
}

async function fetchPage(spec: BucketSpec, offset: number): Promise<Record<string, unknown>[]> {
  const url = new URL(API);
  url.searchParams.set('action', 'bucket');
  url.searchParams.set('format', 'json');
  url.searchParams.set('query', buildQuery(spec, offset));

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) {
      const body = (await res.json()) as { bucket?: Record<string, unknown>[]; error?: string };
      if (body.error) throw new Error(`wiki bucket ${spec.bucket}: ${body.error}`);
      return body.bucket ?? [];
    }
    if (attempt >= 4 || (res.status < 500 && res.status !== 429)) {
      throw new Error(`wiki bucket ${spec.bucket} offset ${offset}: HTTP ${res.status}`);
    }
    await sleep(REQUEST_GAP_MS * 2 ** attempt);
  }
}

export async function fetchBucket(spec: BucketSpec): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await fetchPage(spec, offset);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
    await sleep(REQUEST_GAP_MS);
  }
}

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const outDir = path.resolve(outIdx > 0 ? process.argv[outIdx + 1]! : 'data/kb-raw');
  await mkdir(outDir, { recursive: true });

  for (const spec of BUCKETS) {
    const rows = await fetchBucket(spec);
    const file = path.join(outDir, `wiki_${spec.bucket}.jsonl`);
    await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${spec.bucket}: ${rows.length} rows -> ${path.relative(process.cwd(), file)}`);
    await sleep(REQUEST_GAP_MS);
  }
}

if (import.meta.main) {
  await main();
}
