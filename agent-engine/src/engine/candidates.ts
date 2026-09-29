/**
 * Turns a snapshot into the decision engine's option lists:
 *
 *   - candidates:   one entry per (target, action) pair the player could perform right now,
 *                   labelled with knowledge-base hints ("Iron rocks: Mine (Mining 15, needs pickaxe)")
 *   - destinations: places the player could walk to (sub-goal destination, nearest bank, nearest
 *                   known placements of the sub-goal's targets)
 *
 * The lists are deliberately short (System 1 models share a small token budget across options):
 * identical targets are collapsed to the nearest few, and entities matching the sub-goal's hints
 * are ranked first.
 */
import type { KnowledgeBase, PlayerContext } from '../kb/KnowledgeBase.ts';
import { tileDistance } from '../kb/KnowledgeBase.ts';
import type { Candidate, Destination, Snapshot, SubGoal, WorldPoint } from '../types.ts';

export interface CandidateOptions {
  maxCandidates?: number;
  maxDestinations?: number;
  /** Keep this many instances of the same (name, action) pair, nearest first. */
  maxPerGroup?: number;
  /** Include unreachable entities (labelled as such). Default false. */
  includeUnreachable?: boolean;
}

export interface CandidateSet {
  candidates: Candidate[];
  destinations: Destination[];
}

/** Items that are "used on" other items rather than having their own inventory action. */
// Not the hammer: smithing happens at an anvil, and "use hammer on bar" does nothing.
const TOOLS = ['tinderbox', 'knife', 'chisel', 'needle', 'pestle and mortar', 'glassblowing pipe'];
/** Inventory actions that never help a sub-goal and just burn option budget. */
const IGNORED_INVENTORY_ACTIONS = new Set(['examine', 'check', 'rub', 'commune', 'check-charges']);

const lc = (s: string) => s.toLowerCase();

export function matchesAny(name: string, hints: string[] | undefined): boolean {
  if (!hints || hints.length === 0) return false;
  // One direction only: "Dead tree" matches hint "Tree", but "Rocks" (a depleted rock) must not
  // match hint "Iron rocks".
  const n = lc(name);
  return hints.some((h) => n.includes(lc(h)));
}

function isKept(name: string, keep: string[] | undefined): boolean {
  const n = lc(name);
  return !!keep?.some((k) => n.includes(lc(k)));
}

function actionHinted(action: string, hints: string[] | undefined): boolean {
  return !!hints?.some((h) => lc(h) === lc(action));
}

export function playerContext(s: Snapshot): PlayerContext {
  return { skills: s.skills, inventory: s.inventory.items, equipment: s.equipment };
}

export function buildCandidates(s: Snapshot, kb: KnowledgeBase | null, goal: SubGoal, opts: CandidateOptions = {}): CandidateSet {
  const maxCandidates = opts.maxCandidates ?? 24;
  const maxPerGroup = opts.maxPerGroup ?? 2;
  const ctx = playerContext(s);
  const out: Candidate[] = [];

  // Modal interfaces replace the world: while one is open, only its options make sense.
  if (s.dialogue.inDialogue && (s.dialogue.hasOptions || s.dialogue.hasContinue)) {
    return { candidates: dialogueCandidates(s), destinations: [] };
  }
  if (s.production.open) {
    return { candidates: productionCandidates(s, goal), destinations: [] };
  }
  if (s.bank.open) {
    return { candidates: bankCandidates(s, goal, maxCandidates), destinations: [] };
  }
  if (s.shop.open) {
    return { candidates: shopCandidates(s, goal, maxCandidates), destinations: [] };
  }

  const groups = new Map<string, number>();
  const admit = (groupKey: string): boolean => {
    const n = groups.get(groupKey) ?? 0;
    if (n >= maxPerGroup) return false;
    groups.set(groupKey, n + 1);
    return true;
  };

  // Something already fighting us: finish it before picking a new fight. Eating drops the
  // player's target, and attacking a fresh NPC then leaves two hitting us.
  const attackers = new Set(s.npcs.filter((n) => n.interactingWithPlayer && !(n.healthScale > 0 && n.healthRatio === 0)).map((n) => n.index));

  for (const npc of [...s.npcs].sort((a, b) => a.distance - b.distance)) {
    if (!npc.reachable && !opts.includeUnreachable) continue;
    // A killed NPC lingers for a few ticks during its death animation with an empty health bar;
    // clicking it does nothing.
    if (npc.healthScale > 0 && npc.healthRatio === 0) continue;
    for (const action of npc.actions) {
      if (lc(action) === 'attack' && npc.interactingWithOther && !npc.interactingWithPlayer) continue;
      if (lc(action) === 'attack' && attackers.size > 0 && !attackers.has(npc.index)) continue;
      if (lc(action) === 'attack' && goal.maxTargetLevel !== undefined && npc.combatLevel > goal.maxTargetLevel) continue;
      if (!admit(`npc|${npc.name}|${action}`)) continue;
      const hint = kb ? npcHint(kb, ctx, npc.name, npc.id, action) : { text: '', unmet: [] };
      out.push({
        id: `npc:${npc.index}#${action}`,
        kind: 'npc',
        name: npc.name,
        action,
        label: `${npc.name}${npc.combatLevel > 0 ? ` (level ${npc.combatLevel})` : ''}: ${action}${hint.text} - ${npc.distance} tiles${npc.reachable ? '' : ', unreachable'}${npc.interactingWithPlayer ? ', targeting you' : ''}`,
        gameAction: { op: 'interact', target: { kind: 'npc', index: npc.index, id: npc.id }, action },
        distance: npc.distance,
        unmet: hint.unmet,
      });
    }
  }

  for (const obj of [...s.objects].sort((a, b) => a.distance - b.distance)) {
    if (!obj.reachable && !opts.includeUnreachable) continue;
    // Action-less objects (a fire) are only useful as "use item on" targets.
    if (obj.actions.length === 0) {
      const p = obj.position;
      const seenItem = new Set<string>();
      for (const it of s.inventory.items) {
        if (seenItem.has(it.name) || !(matchesAny(it.name, goal.targets) || /^raw /i.test(it.name))) continue;
        seenItem.add(it.name);
        if (!admit(`use|${it.name}|${obj.name}`)) continue;
        out.push({
          id: `use:${it.slot}>obj:${obj.id}@${p.x},${p.y},${p.plane}`,
          kind: 'object',
          name: obj.name,
          action: `Use ${it.name}`,
          label: `Use ${it.name} on the ${obj.name} - ${obj.distance} tiles`,
          gameAction: { op: 'use_item_on', itemSlot: it.slot, target: { kind: 'object', id: obj.id, x: p.x, y: p.y, plane: p.plane } },
          distance: obj.distance,
        });
      }
      continue;
    }
    for (const action of obj.actions) {
      if (!admit(`obj|${obj.name}|${action}`)) continue;
      const hint = kb ? objectHint(kb, ctx, obj.name, action) : { text: '', unmet: [] };
      const p = obj.position;
      out.push({
        id: `obj:${obj.id}@${p.x},${p.y},${p.plane}#${action}`,
        kind: 'object',
        name: obj.name,
        action,
        label: `${obj.name}: ${action}${hint.text} - ${obj.distance} tiles${obj.reachable ? '' : ', unreachable'}`,
        gameAction: { op: 'interact', target: { kind: 'object', id: obj.id, x: p.x, y: p.y, plane: p.plane }, action },
        distance: obj.distance,
        unmet: hint.unmet,
      });
    }
  }

  for (const item of [...s.groundItems].sort((a, b) => a.distance - b.distance)) {
    if (!item.reachable && !opts.includeUnreachable) continue;
    if (!item.lootable) continue;
    if (!admit(`ground|${item.name}`)) continue;
    const p = item.position;
    out.push({
      id: `ground:${item.id}@${p.x},${p.y},${p.plane}#Take`,
      kind: 'ground_item',
      name: item.name,
      action: 'Take',
      label: `${item.name}${item.quantity > 1 ? ` x${item.quantity}` : ''} on the ground: Take (worth ${item.geValue} gp) - ${item.distance} tiles`,
      gameAction: { op: 'interact', target: { kind: 'ground_item', id: item.id, x: p.x, y: p.y, plane: p.plane }, action: 'Take' },
      distance: item.distance,
    });
  }

  out.push(...inventoryCandidates(s, goal.keep));
  out.push(...equipmentCandidates(s, goal));

  const destinations = kb ? buildDestinations(s, kb, goal, opts.maxDestinations ?? 5) : goalDestination(s, goal);
  const avoid = new Set((goal.avoid ?? []).map(lc));
  const avoidAt = goal.avoidAt ?? [];
  const at = (c: Candidate): WorldPoint | null => {
    const t = c.gameAction.op === 'interact' || c.gameAction.op === 'use_item_on' ? c.gameAction.target : null;
    return t && 'x' in t ? { x: t.x, y: t.y, plane: t.plane } : null;
  };
  const allowed = out.filter((c) => {
    if (avoid.has(lc(c.name))) return false;
    const p = at(c);
    return !p || !avoidAt.some((a) => a.plane === p.plane && Math.abs(a.x - p.x) <= 1 && Math.abs(a.y - p.y) <= 1);
  });
  return { candidates: rank(allowed, goal, maxCandidates), destinations };
}

function npcHint(kb: KnowledgeBase, ctx: PlayerContext, name: string, id: number, action: string): { text: string; unmet: string[] } {
  const rule = kb.resourceFor('npc', name, action);
  if (rule) {
    const unmet = kb.unmetRequirements(rule, ctx);
    return { text: ` (${rule.skill} ${rule.level}, ${rule.products.join('/')}${unmet.length ? `; missing ${unmet.join(', ')}` : ''})`, unmet };
  }
  if (lc(action) === 'attack') {
    const m = kb.monster(id);
    if (m) {
      const parts = [m.hitpoints != null ? `${m.hitpoints} hp` : null, m.maxHit.length ? `max hit ${m.maxHit[0]}` : null, m.attackStyle[0] ?? null];
      const txt = parts.filter(Boolean).join(', ');
      return { text: txt ? ` (${txt})` : '', unmet: [] };
    }
  }
  return { text: '', unmet: [] };
}

function objectHint(kb: KnowledgeBase, ctx: PlayerContext, name: string, action: string): { text: string; unmet: string[] } {
  const rule = kb.resourceFor('object', name, action);
  if (rule) {
    const unmet = kb.unmetRequirements(rule, ctx);
    return { text: ` (${rule.skill} ${rule.level}, gives ${rule.products.join('/')}${unmet.length ? `; missing ${unmet.join(', ')}` : ''})`, unmet };
  }
  const station = kb.stationFor(name, action);
  if (station) return { text: ` (${station.skill})`, unmet: [] };
  return { text: '', unmet: [] };
}

function inventoryCandidates(s: Snapshot, keep?: string[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const items = s.inventory.items;
  for (const item of items) {
    for (const action of item.actions) {
      if (IGNORED_INVENTORY_ACTIONS.has(lc(action))) continue;
      if (action === 'Drop' && isKept(item.name, keep)) continue;
      const key = `${item.name}|${action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const count = items.filter((i) => i.name === item.name).reduce((n, i) => n + i.quantity, 0);
      out.push({
        id: `inv:${item.slot}#${action}`,
        kind: 'inventory',
        name: item.name,
        action,
        label: `Inventory ${item.name}${count > 1 ? ` (have ${count})` : ''}: ${action}`,
        gameAction: action === 'Drop' ? { op: 'drop', slot: item.slot } : { op: 'interact', target: { kind: 'inventory', slot: item.slot, id: item.id }, action },
      });
    }
  }
  // "Use tool on item" pairs (tinderbox on logs, knife on logs, chisel on gems...).
  for (const tool of items.filter((i) => TOOLS.some((t) => lc(i.name).includes(t)))) {
    const targets = new Set<string>();
    for (const other of items) {
      if (other.slot === tool.slot || other.name === tool.name || targets.has(other.name)) continue;
      if (TOOLS.some((t) => lc(other.name).includes(t))) continue;
      targets.add(other.name);
      out.push({
        id: `use:${tool.slot}>inv:${other.slot}`,
        kind: 'inventory',
        name: other.name,
        action: `Use ${tool.name}`,
        label: `Use ${tool.name} on ${other.name}`,
        gameAction: { op: 'use_item_on', itemSlot: tool.slot, target: { kind: 'inventory', slot: other.slot, id: other.id } },
      });
    }
  }
  return out;
}

function equipmentCandidates(s: Snapshot, goal: SubGoal): Candidate[] {
  // Unequipping is rarely useful; only offer it when the sub-goal names the item.
  return s.equipment
    .filter((e) => matchesAny(e.name, goal.targets))
    .map((e) => ({
      id: `equip:${e.slot}#Remove`,
      kind: 'equipment' as const,
      name: e.name,
      action: 'Remove',
      label: `Equipped ${e.name}: Remove`,
      gameAction: { op: 'interact' as const, target: { kind: 'equipment' as const, slot: e.slot, id: e.id }, action: 'Remove' },
    }));
}

function dialogueCandidates(s: Snapshot): Candidate[] {
  if (s.dialogue.hasOptions) {
    return s.dialogue.options.map((option, i) => ({
      id: `dialogue:${i}`,
      kind: 'dialogue' as const,
      name: option,
      action: 'Select',
      label: `Say: "${option}"`,
      gameAction: { op: 'dialogue_select' as const, option },
    }));
  }
  return [{
    id: 'dialogue:continue',
    kind: 'dialogue',
    name: 'Continue',
    action: 'Continue',
    label: 'Click to continue the dialogue',
    gameAction: { op: 'dialogue_continue' },
  }];
}

function productionCandidates(s: Snapshot, goal: SubGoal): Candidate[] {
  return s.production.options.map((option) => {
    // On the anvil grid, never queue more than the sub-goal still needs: a queued batch keeps
    // running after the sub-goal ends and eats bars meant for the next item.
    let amount: 1 | 5 | 10 | undefined = goal.makeAmount;
    if (s.production.interface === 'smithing') {
      const need = stillNeeded(s, goal, option);
      if (need !== null) amount = need >= 10 ? 10 : need >= 5 ? 5 : 1;
    }
    const smithing = s.production.interface === 'smithing';
    return {
      id: `production:${option}`,
      kind: 'production' as const,
      name: option,
      action: 'Make',
      label: smithing ? `Smith ${amount ?? 'all'}: ${option}` : `Make all: ${option}`,
      gameAction: { op: 'production_select' as const, option, ...(smithing && amount ? { amount } : {}) },
      score: matchesAny(option, goal.targets) ? 1 : 0,
    };
  });
}

/** Held count of an item (substring match, stacks summed). */
function heldCount(s: Snapshot, name: string): number {
  const n = lc(name);
  return s.inventory.items.filter((i) => lc(i.name).includes(n)).reduce((sum, i) => sum + i.quantity, 0);
}

/** How many more of `name` the sub-goal wants, or null when it sets no count for it. */
function stillNeeded(s: Snapshot, goal: SubGoal, name: string): number | null {
  const w = goal.want?.find((x) => lc(name).includes(lc(x.name)) || lc(x.name).includes(lc(name)));
  return w ? Math.max(0, w.count - heldCount(s, w.name)) : null;
}

/** Modal screens: when the sub-goal names actions, only offer those (plus closing). */
function allowedAction(action: string, goal: SubGoal): boolean {
  if (!goal.actions?.length || action === 'Close') return true;
  const a = lc(action);
  return goal.actions.some((g) => a.startsWith(lc(g).split('-')[0]!));
}

function bankCandidates(s: Snapshot, goal: SubGoal, max: number): Candidate[] {
  return bankCandidatesAll(s, goal, max * 2).filter((c) => allowedAction(c.action, goal)).slice(0, max);
}

function bankCandidatesAll(s: Snapshot, goal: SubGoal, max: number): Candidate[] {
  const out: Candidate[] = [];
  // "Deposit inventory" would take the protected tools with it.
  if (s.inventory.items.length > 0 && !s.inventory.items.some((i) => isKept(i.name, goal.keep))) {
    out.push({
      id: 'bank:deposit_all',
      kind: 'bank_item',
      name: 'Inventory',
      action: 'Deposit all',
      label: 'Deposit the whole inventory',
      gameAction: { op: 'bank_deposit_all' },
    });
  }
  const seenInv = new Set<string>();
  for (const item of s.inventory.items) {
    if (seenInv.has(item.name) || isKept(item.name, goal.keep)) continue;
    seenInv.add(item.name);
    out.push({
      id: `bank:deposit:${item.id}`,
      kind: 'bank_item',
      name: item.name,
      action: 'Deposit',
      label: `Deposit all ${item.name}`,
      gameAction: { op: 'bank_deposit', itemId: item.id, amount: 'all' },
    });
  }
  // Only withdraw what the sub-goal asks for; a bank can hold hundreds of items.
  const wanted = s.bank.items.filter((b) => matchesAny(b.name, goal.targets));
  for (const b of wanted.slice(0, 4)) {
    const need = stillNeeded(s, goal, b.name);
    if (need === 0) continue;
    const needText = need === null ? '' : `; you need ${need} more`;
    for (const n of [1, 5, 10] as const) {
      if (b.quantity >= n && (need === null || n <= need)) {
        out.push({ id: `bank:withdraw${n}:${b.id}`, kind: 'bank_item', name: b.name, action: `Withdraw-${n}`, label: `Withdraw ${n} ${b.name} (bank has ${b.quantity}${needText})`, gameAction: { op: 'bank_withdraw', itemId: b.id, amount: n } });
      }
    }
    // "All" only when it cannot overshoot the wanted count (or no count was given). Wanting more
    // than an inventory holds means the item stacks (coins, runes), where overshooting is free.
    if (need === null || b.quantity <= need || need > 28) {
      out.push({ id: `bank:withdrawAll:${b.id}`, kind: 'bank_item', name: b.name, action: 'Withdraw-All', label: `Withdraw all ${b.name} (bank has ${b.quantity}${needText})`, gameAction: { op: 'bank_withdraw', itemId: b.id, amount: 'all' } });
    }
  }
  out.push({ id: 'bank:close', kind: 'bank_item', name: 'Bank', action: 'Close', label: 'Close the bank', gameAction: { op: 'bank_close' } });
  return out.slice(0, max);
}

function shopCandidates(s: Snapshot, goal: SubGoal, max: number): Candidate[] {
  const out: Candidate[] = [];
  // Offer what the sub-goal names; with no hints, the first few stocked items.
  const stocked = s.shop.items.filter((i) => i.quantity > 0);
  const wanted = goal.targets?.length ? stocked.filter((i) => matchesAny(i.name, goal.targets)) : stocked.slice(0, 8);
  for (const i of wanted.slice(0, 8)) {
    const need = stillNeeded(s, goal, i.name);
    if (need === 0) continue;
    const needText = need === null ? '' : `; you need ${need} more`;
    for (const n of [1, 5] as const) {
      if (i.quantity >= n && (need === null || n <= need)) {
        out.push({ id: `shop:buy${n}:${i.id}`, kind: 'shop_item', name: i.name, action: `Buy-${n}`, label: `Buy ${n} ${i.name} (shop has ${i.quantity}${needText})`, gameAction: { op: 'shop_buy', itemId: i.id, amount: n } });
      }
    }
  }
  out.push({ id: 'shop:close', kind: 'shop_item', name: 'Shop', action: 'Close', label: 'Close the shop', gameAction: { op: 'shop_close' } });
  return out.slice(0, max);
}

/**
 * Hint matches first, then met requirements, then distance. Candidates with unmet requirements
 * stay in the list (the label says what is missing) but sink to the bottom.
 */
function rank(cands: Candidate[], goal: SubGoal, max: number): Candidate[] {
  for (const c of cands) {
    let score = 0;
    if (matchesAny(c.name, goal.targets)) score += 10;
    if (actionHinted(c.action, goal.actions)) score += 5;
    if (c.unmet && c.unmet.length > 0) score -= 8;
    if (c.kind === 'inventory' && c.action === 'Drop') score -= 2;
    score -= Math.min(c.distance ?? 0, 30) / 10;
    c.score = score;
  }
  return [...cands].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, max);
}

function goalDestination(s: Snapshot, goal: SubGoal): Destination[] {
  const me = s.player?.position;
  const p = goal.destination?.point;
  if (!me || !p) return [];
  return [{ id: 'dest:goal', label: `${goal.destination?.name ?? 'Sub-goal destination'} (${tileDistance(me, p)} tiles)`, to: p, distance: tileDistance(me, p) }];
}

export function buildDestinations(s: Snapshot, kb: KnowledgeBase, goal: SubGoal, max: number): Destination[] {
  const me = s.player?.position;
  if (!me) return [];
  const out: Destination[] = [];
  const push = (label: string, to: WorldPoint) => {
    const distance = tileDistance(me, to);
    if (distance <= 2) return; // already there
    if (out.some((d) => tileDistance(d.to, to) <= 3)) return;
    const floor = to.plane !== me.plane ? `, floor ${to.plane}` : '';
    out.push({ id: `dest:${out.length}`, label: `${label} (${distance} tiles${floor})`, to, distance });
  };

  if (goal.destination?.point) {
    // An exact destination from the planner is authoritative: offering "nearest X" alternatives
    // let the classifier walk to a spurious placement instead of the bank it was sent to.
    push(goal.destination.name ?? 'Sub-goal destination', goal.destination.point);
    return out;
  }
  if (goal.destination?.name && !goal.destination.point) {
    for (const p of kb.findPlaces(goal.destination.name, me, 2)) push(p.name, p.point);
  }
  for (const target of goal.targets ?? []) {
    for (const p of kb.nearestObjects(target, me, { limit: 1 })) push(`Nearest ${p.name}`, p.point);
    for (const p of kb.nearestSpawns(target, me, { limit: 1 })) push(`Nearest ${p.name}`, p.point);
  }
  const bank = kb.nearestBanks(me, 1)[0];
  if (bank) push(`Nearest bank: ${bank.name}`, bank.point);
  return out.slice(0, max);
}
