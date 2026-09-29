/**
 * Site selection for loop-shaped activities (mine -> furnace -> anvil -> bank -> mine): pick the
 * combination of sites with the cheapest walking cycle, using the web walker's real path lengths
 * (GET /path) when available and straight-line distance otherwise.
 *
 * Why: choosing each stop independently by straight-line distance sent the iron loop to the Al
 * Kharid mine and across the toll gate, roughly 30% more walking per cycle than the Varrock loop.
 */
import { tileDistance, type KnowledgeBase, type Place } from '../kb/KnowledgeBase.ts';
import type { WorldPoint } from '../types.ts';

/** Walking cost between two points, or null when there is no route. */
export type PathCost = (from: WorldPoint, to: WorldPoint) => Promise<number | null>;

export interface Site {
  name: string;
  point: WorldPoint;
}

/** Memoised path costs (symmetric), falling back to straight-line distance when no pathfinder. */
export class CostTable {
  private readonly cache = new Map<string, number | null>();
  private readonly pathCost?: PathCost;

  constructor(pathCost?: PathCost) {
    this.pathCost = pathCost;
  }

  async cost(a: WorldPoint, b: WorldPoint): Promise<number | null> {
    const ka = `${a.x},${a.y},${a.plane}`;
    const kb = `${b.x},${b.y},${b.plane}`;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    if (this.cache.has(key)) return this.cache.get(key)!;
    let c: number | null;
    try {
      c = this.pathCost ? await this.pathCost(a, b) : tileDistance(a, b);
    } catch {
      c = tileDistance(a, b);
    }
    this.cache.set(key, c);
    return c;
  }
}

/**
 * Groups placements into sites (rocks within `radius` tiles form one mine), keeping sites with at
 * least `min` members, nearest first.
 */
export function cluster(places: Place[], radius = 12, min = 1): Site[] {
  const sites: { name: string; points: WorldPoint[] }[] = [];
  for (const p of places) {
    const site = sites.find((s) => tileDistance(s.points[0]!, p.point) <= radius);
    if (site) site.points.push(p.point);
    else sites.push({ name: p.name, points: [p.point] });
  }
  return sites
    .filter((s) => s.points.length >= min)
    .map((s) => ({ name: `${s.name} (${s.points.length})`, point: s.points[0]! }));
}

export interface LoopChoice {
  sites: Site[];
  /** Total cycle cost (tiles). */
  cost: number;
}

/**
 * Cheapest cycle visiting one site from each stage in order and returning to the first. Stages are
 * small (a few candidates each), so exhaustive search is fine.
 */
export async function cheapestLoop(stages: Site[][], costs: CostTable): Promise<LoopChoice | null> {
  if (stages.some((s) => s.length === 0)) return null;
  let best: LoopChoice | null = null;
  const pick: Site[] = [];
  const walk = async (i: number, acc: number): Promise<void> => {
    if (best && acc >= best.cost) return;
    if (i === stages.length) {
      const back = await costs.cost(pick[pick.length - 1]!.point, pick[0]!.point);
      if (back === null) return;
      const total = acc + back;
      if (!best || total < best.cost) best = { sites: [...pick], cost: total };
      return;
    }
    for (const site of stages[i]!) {
      let step = 0;
      if (i > 0) {
        const c = await costs.cost(pick[i - 1]!.point, site.point);
        if (c === null) continue;
        step = c;
      }
      pick.push(site);
      await walk(i + 1, acc + step);
      pick.pop();
    }
  };
  await walk(0, 0);
  return best;
}

/** Candidate sites for a stage from the knowledge base, around `from`. */
export function candidateSites(
  kb: KnowledgeBase,
  from: WorldPoint,
  what: { object?: string; action?: string; bank?: boolean; exclude?: string[]; min?: number },
  limit = 4,
  radius = 250,
): Site[] {
  if (what.bank) {
    return kb
      .nearestBanks(from, limit, false)
      .filter((b) => b.kind === 'bank')
      .map((b) => ({ name: b.name, point: b.point }));
  }
  const places = kb
    .nearestObjects(what.object!, from, { action: what.action, radius, limit: 400 })
    .filter((p) => !what.exclude?.includes(p.name));
  return cluster(places, 12, what.min ?? 1).slice(0, limit);
}
