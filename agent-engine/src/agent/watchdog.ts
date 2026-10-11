/**
 * Progress watchdog: catches loops where every action "succeeds" but nothing moves forward
 * (re-clicking a banker behind a counter, pacing between two tiles, a menu that never closes,
 * waiting on an animation that never ends).
 *
 * Progress = any XP gained, the inventory contents changing, new dialogue text, the player moving more than
 * `moveTiles` from where progress was last seen, or a sub-goal completing. The watchdog trips when
 * there has been no progress for `windowMs`, or when the same action repeats `repeatLimit` times
 * since the last progress (clicks that start an animation do not count as repeats).
 */
import type { StepResult } from '../engine/GameIntentEngine.ts';
import type { GameAction, Snapshot, WorldPoint } from '../types.ts';

export interface WatchdogOptions {
  /** Longest stretch without progress before tripping. Default 180 s. */
  windowMs?: number;
  /** Same action this many times without progress trips it. Default 6. */
  repeatLimit?: number;
  /** Moving this far from the last progress point counts as progress. Default 3 tiles. */
  moveTiles?: number;
  now?: () => number;
}

export interface StuckVerdict {
  reason: string;
  /** The action that kept repeating, when the trip was a loop. */
  action?: GameAction;
}

function inventoryKey(s: Snapshot): string {
  const counts = new Map<string, number>();
  for (const i of s.inventory.items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.quantity);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => `${n}:${c}`).join('|');
}

function dialogueKey(s: Snapshot): string {
  const d = s.dialogue;
  return d.inDialogue ? `${d.text ?? ''}|${d.question ?? ''}|${d.options.join('/')}` : '';
}

function totalXp(s: Snapshot): number {
  return s.skills.reduce((sum, k) => sum + k.xp, 0);
}

export class ProgressWatchdog {
  private readonly windowMs: number;
  private readonly repeatLimit: number;
  private readonly moveTiles: number;
  private readonly now: () => number;
  private lastProgressAt: number;
  private xp = -1;
  private inv = '';
  /** Dialogue lines seen since the last progress: only an unseen line is progress. */
  private dialogues = new Set<string>();
  /** Recent progress points; returning to one of them (pacing) is not progress. */
  private anchors: WorldPoint[] = [];
  private repeats = new Map<string, { n: number; action: GameAction }>();

  constructor(opts: WatchdogOptions = {}) {
    this.windowMs = opts.windowMs ?? 180_000;
    this.repeatLimit = opts.repeatLimit ?? 6;
    this.moveTiles = opts.moveTiles ?? 3;
    this.now = opts.now ?? Date.now;
    this.lastProgressAt = this.now();
  }

  /** Call when a sub-goal starts or completes: both are progress. */
  reset(s?: Snapshot): void {
    this.lastProgressAt = this.now();
    this.repeats.clear();
    if (s) this.baseline(s);
  }

  private baseline(s: Snapshot): void {
    this.xp = totalXp(s);
    this.inv = inventoryKey(s);
    this.dialogues = new Set([dialogueKey(s)]);
    const p = s.player?.position;
    if (p) this.anchors = [...this.anchors.slice(-5), p];
  }

  /**
   * The most repeated action that has a world/inventory target. A loop often alternates a
   * targeted click with an untargeted one (chop a "tree" -> its NPC talks -> continue the
   * dialogue); only the targeted one can be withheld.
   */
  private culprit(): GameAction | undefined {
    return [...this.repeats.values()]
      .filter((r) => r.action.op === 'interact' || r.action.op === 'use_item_on')
      .sort((a, b) => b.n - a.n)[0]?.action;
  }

  /** Feed every engine step; returns a verdict when the agent looks stuck. */
  observe(result: StepResult): StuckVerdict | null {
    const s = result.kind === 'acted' ? result.outcome.after : result.snapshot;
    if (!s || !s.loggedIn) return null;
    if (this.xp < 0) this.baseline(s);

    const pos = s.player?.position;
    const moved =
      !!pos && this.anchors.length > 0 &&
      // Floors do not count: climbing a staircase up and down (Draynor Manor) stays in one spot.
      this.anchors.every((a) => Math.max(Math.abs(pos.x - a.x), Math.abs(pos.y - a.y)) > this.moveTiles);
    // A long NPC explanation is clicked through one line at a time: a line not seen yet is
    // progress. The same line again ("The trapdoor is locked." after every Open) is not.
    const line = dialogueKey(s);
    const talked = s.dialogue.inDialogue && !this.dialogues.has(line);
    if (talked) this.dialogues.add(line);
    if (totalXp(s) > this.xp || inventoryKey(s) !== this.inv || moved || result.kind === 'done') {
      this.reset(s);
      return null;
    }
    if (talked) {
      this.lastProgressAt = this.now();
      this.repeats.clear();
      return null;
    }

    // A click that starts the skilling animation took effect; a slow catch (shrimp at Fishing 5
    // can take 20 s) re-clicks the same spot many times. The idle window still bounds it.
    const started = result.kind === 'acted' && result.outcome.success && result.outcome.changes?.includes('animation');
    if (result.kind === 'acted' && !started) {
      const key = result.label ?? result.action.op;
      const n = (this.repeats.get(key)?.n ?? 0) + 1;
      this.repeats.set(key, { n, action: result.action });
      if (n >= this.repeatLimit) return { reason: `loop: "${key}" ${n} times without progress`, action: this.culprit() };
    }
    const idle = this.now() - this.lastProgressAt;
    if (idle >= this.windowMs) {
      // Blame the most repeated targeted action, if any.
      return { reason: `no progress for ${Math.round(idle / 1000)} s`, action: this.culprit() };
    }
    return null;
  }
}
