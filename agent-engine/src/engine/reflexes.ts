/**
 * Deterministic reflexes, checked before the decision engine every step. Survival and UI
 * housekeeping must not depend on a classifier's confidence.
 */
import type { GameAction, Snapshot, SubGoal } from '../types.ts';

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

export function checkReflexes(s: Snapshot, cfg: ReflexConfig = DEFAULT_REFLEXES, goal?: SubGoal): ReflexResult {
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
    // Attacked by something the sub-goal is not about (a Black Knight wandering through Draynor
    // while hunting imps): retaliating with no food only ends in the halt below. Walk away from it.
    const attacker = s.npcs.find((n) => n.interactingWithPlayer && n.combatLevel > 0 && !(goal?.targets ?? []).some((t) => t.toLowerCase() === n.name.toLowerCase()));
    if (attacker && p.inCombat && !s.walk.active) {
      const dx = p.position.x - attacker.position.x;
      const dy = p.position.y - attacker.position.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      const to = { x: Math.round(p.position.x + (dx / len) * 14), y: Math.round(p.position.y + (dy / len) * 14), plane: p.position.plane };
      return { kind: 'act', reason: `hp ${p.hp.current}/${p.hp.max}, no food: flee from ${attacker.name}`, action: { op: 'walk', to, distance: 3 } };
    }
    // Only a fight makes low HP without food an emergency; out of combat the planner decides
    // (restock at a bank, or rest), and halting here would block even walking to that bank.
    if (hpFraction < cfg.haltBelow && (p.inCombat || p.interacting?.type === 'npc')) {
      return { kind: 'halt', reason: `hp ${p.hp.current}/${p.hp.max} and no food` };
    }
  }

  // Random events (Genie, Drunken Dwarf, Rick Turpentine, Mysterious Old Man, ...) walk up, say
  // the player's name and offer a "game" or a gift. Every one has a Dismiss option; declining is
  // always safe, while ignoring or accepting some of them teleports the player away.
  const randomEvent = s.npcs.find((n) => n.interactingWithPlayer && n.actions.some((a) => a.toLowerCase() === 'dismiss'));
  if (randomEvent) {
    return {
      kind: 'act',
      reason: `dismiss random event ${randomEvent.name}`,
      action: { op: 'interact', target: { kind: 'npc', index: randomEvent.index, id: randomEvent.id }, action: 'Dismiss' },
    };
  }

  if (s.walk.active && !p.runEnabled && p.runEnergy >= cfg.runAbove) {
    return { kind: 'act', reason: 'enable run while walking', action: { op: 'toggle_run', enabled: true } };
  }
  return null;
}
