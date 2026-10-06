/**
 * Grand Exchange prices from the OSRS Wiki real-time API (prices.runescape.wiki), cached on disk so
 * a campaign's many short agent runs fetch them at most every few hours. Used to compare the GE with
 * shop prices when buying gear; any failure leaves the GE out (shops only), never ends a run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API = 'https://prices.runescape.wiki/api/v1/osrs';
const USER_AGENT = 'microbot-agent-engine/0.1 (gear purchase prices; low request rate)';
const MAX_AGE_MS = 6 * 3_600_000;

interface Cache {
  fetchedAt: number;
  /** Lower-cased item name -> mid price (average of the latest high and low trades). */
  prices: Record<string, number>;
}

async function getJson(route: string): Promise<unknown> {
  const res = await fetch(`${API}/${route}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}

async function download(): Promise<Record<string, number>> {
  const mapping = (await getJson('mapping')) as { id: number; name: string }[];
  const latest = ((await getJson('latest')) as { data: Record<string, { high: number | null; low: number | null }> }).data;
  const prices: Record<string, number> = {};
  for (const { id, name } of mapping) {
    const p = latest[id];
    const vals = [p?.high, p?.low].filter((v): v is number => typeof v === 'number' && v > 0);
    if (vals.length) prices[name.toLowerCase()] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  }
  return prices;
}

/** Item name -> GE price lookup; null for unknown items, or for every item when prices are unavailable. */
export async function loadGePrices(cacheFile: string, now = Date.now()): Promise<(item: string) => number | null> {
  let cache: Cache | null = null;
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Cache;
  } catch {
    cache = null;
  }
  if (!cache || now - cache.fetchedAt > MAX_AGE_MS) {
    try {
      cache = { fetchedAt: now, prices: await download() };
      mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache));
    } catch (e) {
      console.log(`[prereq] GE prices unavailable (${e instanceof Error ? e.message : e}); ${cache ? 'using the stale cache' : 'shops only'}`);
    }
  }
  const prices = cache?.prices ?? {};
  return (item) => prices[item.toLowerCase()] ?? null;
}
