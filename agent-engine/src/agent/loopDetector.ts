/**
 * Run-level loop detector. The per-sub-goal watchdog catches one sub-goal spinning; this catches
 * the run going in circles across sub-goals, whatever the mechanism: twelve minutes on a Draynor
 * Manor staircase, 54 Opens of a locked trapdoor, walking between the same three spots while the
 * planner re-issues near-identical sub-goals.
 *
 * Productive progress = XP gained, an item gained (count of some item went up), or leaving the
 * area. Gathering and fighting always produce it, so they never trip this. Without it for a while,
 * the detector trips when the player has stayed in one small area, or when the recent actions are
 * a handful of the same clicks over and over.
 */
import type { StepResult } from '../engine/GameIntentEngine.ts';
import type { Snapshot, WorldPoint } from '../types.ts';

export interface LoopDetectorOptions {
  /** Time without productive progress inside one area before tripping. Default 8 min. */
  areaMs?: number;
  /** Area radius in tiles (any floor). Default 20. */
  areaTiles?: number;
  /** Recent actions examined for repetition. Default 30. */
  window?: number;
  /** Tripping on repetition needs at most this many distinct actions in the window. Default 3. */
  maxDistinct?: number;
  now?: () => number;
}

export interface LoopVerdict {
  /** One line: what kind of loop. */
  reason: string;
  /** Evidence for whoever diagnoses it: most frequent actions, places, game messages. */
  evidence: string[];
}

interface Sample {
  at: number;
  pos?: WorldPoint;
  label?: string;
  effect?: string;
  messages: string[];
}

/** "walk to Nearest Imp (21 tiles)" and "... (17 tiles)" are the same action. */
export function actionKey(label: string): string {
  return label.replace(/\(\d+ tiles?[^)]*\)/g, '').replace(/ - \d+ tiles?.*$/, '').replace(/\d+/g, '#').trim();
}

function counts(s: Snapshot): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of s.inventory.items) m.set(i.name, (m.get(i.name) ?? 0) + i.quantity);
  return m;
}

const xpOf = (s: Snapshot) => s.skills.reduce((sum, k) => sum + k.xp, 0);

export class LoopDetector {
  private readonly o: Required<Omit<LoopDetectorOptions, 'now'>> & { now: () => number };
  private samples: Sample[] = [];
  private progressAt: number;
  private anchor: WorldPoint | null = null;
  private xp = -1;
  private inv = new Map<string, number>();

  constructor(opts: LoopDetectorOptions = {}) {
    this.o = {
      areaMs: opts.areaMs ?? 8 * 60_000,
      areaTiles: opts.areaTiles ?? 20,
      window: opts.window ?? 30,
      maxDistinct: opts.maxDistinct ?? 3,
      now: opts.now ?? Date.now,
    };
    this.progressAt = this.o.now();
  }

  /** Productive progress happened (or a rescue just started): forget the history. */
  reset(s?: Snapshot): void {
    this.samples = [];
    this.progressAt = this.o.now();
    this.anchor = s?.player?.position ?? null;
    if (s) {
      this.xp = xpOf(s);
      this.inv = counts(s);
    }
  }

  observe(result: StepResult): LoopVerdict | null {
    const s = result.kind === 'acted' ? result.outcome.after : result.snapshot;
    if (!s?.loggedIn || !s.player) return null;
    if (this.xp < 0) this.reset(s);

    const pos = s.player.position;
    const gained = [...counts(s)].some(([name, n]) => n > (this.inv.get(name) ?? 0));
    const left = !!this.anchor && Math.max(Math.abs(pos.x - this.anchor.x), Math.abs(pos.y - this.anchor.y)) > this.o.areaTiles;
    if (xpOf(s) > this.xp || gained || left) {
      this.reset(s);
      return null;
    }
    // Losses (eating, dropping, spending) are not progress, but the new counts are the baseline.
    this.inv = counts(s);

    const now = this.o.now();
    this.samples.push({
      at: now,
      pos,
      label: result.kind === 'acted' ? actionKey(result.label ?? result.action.op) : undefined,
      effect: result.kind === 'acted' ? result.outcome.effect : undefined,
      messages: result.kind === 'acted' ? result.outcome.messages : [],
    });
    if (this.samples.length > 400) this.samples.splice(0, this.samples.length - 400);

    const acted = this.samples.filter((x) => x.label);
    const recent = acted.slice(-this.o.window);
    const distinct = new Set(recent.map((x) => x.label));
    if (recent.length >= this.o.window && distinct.size <= this.o.maxDistinct) {
      return this.verdict(`the last ${recent.length} actions repeat ${distinct.size} click(s) with nothing gained`);
    }
    if (now - this.progressAt >= this.o.areaMs) {
      const mins = Math.round((now - this.progressAt) / 60_000);
      return this.verdict(`${mins} min within ${this.o.areaTiles} tiles of (${this.anchor?.x}, ${this.anchor?.y}) with no XP, items or way out`);
    }
    return null;
  }

  private verdict(reason: string): LoopVerdict {
    const acted = this.samples.filter((x) => x.label);
    const freq = new Map<string, { n: number; effect: string }>();
    for (const x of acted) freq.set(x.label!, { n: (freq.get(x.label!)?.n ?? 0) + 1, effect: x.effect ?? '' });
    const top = [...freq].sort((a, b) => b[1].n - a[1].n).slice(0, 6).map(([l, v]) => `${v.n}x ${l} -> ${v.effect}`);
    const places = [...new Set(this.samples.filter((x) => x.pos).map((x) => `${x.pos!.x},${x.pos!.y},${x.pos!.plane}`))];
    const msgs = [...new Set(this.samples.flatMap((x) => x.messages))].slice(-6);
    return {
      reason,
      evidence: [
        `most frequent actions: ${top.join('; ') || 'none'}`,
        `positions visited (${places.length}): ${places.slice(-8).join(' ')}`,
        `game messages: ${msgs.join(' | ') || 'none'}`,
      ],
    };
  }
}
