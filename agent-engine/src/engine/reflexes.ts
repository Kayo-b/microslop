/**
 * Deterministic reflexes, checked before the decision engine every step. Survival and UI
 * housekeeping must not depend on a classifier's confidence.
 */
import type { GameAction, Snapshot } from '../types.ts';

export interface ReflexConfig {
  /** Eat when HP falls below this fraction of max (0-1). Default 0.5. */
  eatBelow: number;
  /** Halt when HP is below this fraction and there is no food. Default 0.3. */
  haltBelow: number;
  /** Turn run on while walking once energy reaches this. Default 30. */
  runAbove: number;
}

export const DEFAULT_REFLEXES: ReflexConfig = { eatBelow: 0.5, haltBelow: 0.3, runAbove: 30 };

export type ReflexResult =
  | { kind: 'act'; reason: string; action: GameAction }
  | { kind: 'halt'; reason: string }
  | null;

const LEVEL_UP = /congratulations|you've just advanced|you have reached level|level-up/i;

export function checkReflexes(s: Snapshot, cfg: ReflexConfig = DEFAULT_REFLEXES): ReflexResult {
  const p = s.player;
  if (!p) return null;

  // Level-up and other "click to continue" messages block every other interaction.
  if (s.dialogue.inDialogue && s.dialogue.hasContinue && !s.dialogue.hasOptions && LEVEL_UP.test(s.dialogue.text ?? '')) {
    return { kind: 'act', reason: 'dismiss level-up', action: { op: 'dialogue_continue' } };
  }

  const hpFraction = p.hp.max > 0 ? p.hp.current / p.hp.max : 1;
  if (hpFraction < cfg.eatBelow && !s.bank.open) {
    const food = s.inventory.items.find((i) => i.actions.some((a) => a.toLowerCase() === 'eat'));
    if (food) {
      return {
        kind: 'act',
        reason: `hp ${p.hp.current}/${p.hp.max} below ${Math.round(cfg.eatBelow * 100)}%`,
        action: { op: 'interact', target: { kind: 'inventory', slot: food.slot, id: food.id }, action: 'Eat' },
      };
    }
    // Only a fight makes low HP without food an emergency; out of combat the planner decides
    // (restock at a bank, or rest), and halting here would block even walking to that bank.
    if (hpFraction < cfg.haltBelow && (p.inCombat || p.interacting?.type === 'npc')) {
      return { kind: 'halt', reason: `hp ${p.hp.current}/${p.hp.max} and no food` };
    }
  }

  if (s.walk.active && !p.runEnabled && p.runEnergy >= cfg.runAbove) {
    return { kind: 'act', reason: 'enable run while walking', action: { op: 'toggle_run', enabled: true } };
  }
  return null;
}
