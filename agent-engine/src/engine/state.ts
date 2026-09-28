/**
 * Compresses a snapshot into the short `state` object the decision engine sees. Laya's context is
 * 512-1024 tokens shared with the options, so this carries only what first-order decisions need:
 * the sub-goal, where/how the player is, a folded inventory, the relevant skills and what just
 * happened. Entity lists go in the options, not here.
 */
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import type { Snapshot, SubGoal } from '../types.ts';

export interface HistoryEntry {
  tick: number;
  action: string;
  outcome: string;
}

export interface DecisionState {
  subgoal: string;
  location: string;
  status: string;
  hp: string;
  prayer?: string;
  run: string;
  inventory: string;
  equipped: string;
  skills: string;
  recent_actions: string[];
  game_messages: string[];
  dialogue?: string;
}

/** "Raw shrimps x12; Small fishing net; 15 free slots" */
export function foldInventory(s: Snapshot): string {
  const counts = new Map<string, number>();
  for (const i of s.inventory.items) counts.set(i.name, (counts.get(i.name) ?? 0) + i.quantity);
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${name} x${n}` : name));
  parts.push(s.inventory.freeSlots === 0 ? 'FULL (0 free slots)' : `${s.inventory.freeSlots} free slots`);
  return parts.join('; ');
}

export function describeStatus(s: Snapshot): string {
  const p = s.player;
  if (!p) return 'logged out';
  if (s.walk.active) return `walking${s.walk.distanceToTarget != null ? ` (${s.walk.distanceToTarget} tiles to go)` : ''}`;
  const parts: string[] = [];
  if (p.interacting) parts.push(`interacting with ${p.interacting.name ?? p.interacting.type}`);
  if (p.animating) parts.push('busy (animating)');
  if (p.moving) parts.push('moving');
  if (p.inCombat) parts.push('in combat');
  return parts.length ? parts.join(', ') : 'idle';
}

export function buildDecisionState(
  s: Snapshot,
  goal: SubGoal,
  history: HistoryEntry[],
  kb: KnowledgeBase | null,
  relevantSkills: string[] = [],
): DecisionState {
  const p = s.player;
  const pos = p?.position;
  const area = pos && kb ? kb.labelsNear(pos, 40, 1)[0]?.name : undefined;
  const skills = s.skills
    .filter((sk) => relevantSkills.length === 0 ? sk.level > 1 || sk.name === 'Hitpoints' : relevantSkills.some((r) => r.toLowerCase() === sk.name.toLowerCase()))
    .slice(0, 8)
    .map((sk) => (sk.boosted !== sk.level ? `${sk.name} ${sk.boosted}/${sk.level}` : `${sk.name} ${sk.level}`))
    .join(', ');

  const state: DecisionState = {
    subgoal: goal.text,
    location: pos ? `${area ? `${area} ` : ''}(${pos.x}, ${pos.y}, floor ${pos.plane})` : 'unknown',
    status: describeStatus(s),
    hp: p ? `${p.hp.current}/${p.hp.max}` : '?',
    run: p ? `${p.runEnergy}% (${p.runEnabled ? 'on' : 'off'})` : '?',
    inventory: foldInventory(s),
    equipped: s.equipment.length ? s.equipment.map((e) => e.name).join(', ') : 'nothing',
    skills,
    recent_actions: history.slice(-4).map((h) => `${h.action} -> ${h.outcome}`),
    game_messages: s.messages.slice(-3).map((m) => m.text),
  };
  if (p && p.prayer.max > 1) state.prayer = `${p.prayer.current}/${p.prayer.max}`;
  if (s.dialogue.inDialogue) {
    state.dialogue = [s.dialogue.text, s.dialogue.question].filter(Boolean).join(' | ') || 'open';
  }
  return state;
}

/** Skills a sub-goal is likely about, from its hints and the resources the KB knows for them. */
export function relevantSkillsFor(goal: SubGoal, kb: KnowledgeBase | null): string[] {
  const skills = new Set<string>(['Hitpoints']);
  if (!kb) return [...skills];
  const hints = [...(goal.targets ?? []), goal.text].map((h) => h.toLowerCase());
  for (const r of kb.resources()) {
    if (hints.some((h) => h.includes(r.target.toLowerCase()) || r.products.some((p) => h.includes(p.toLowerCase())))) {
      skills.add(r.skill);
    }
  }
  return [...skills];
}
