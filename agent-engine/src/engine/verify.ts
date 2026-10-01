/**
 * Effect verification. POST /act only says an interaction was dispatched, not that the game
 * accepted it, so after each action the engine polls /snapshot until it sees an expected change
 * (animation started, inventory changed, bank opened...) or a failure message ("I can't reach
 * that!", "You need a Mining level of 15..."), or the timeout passes.
 *
 * The verified outcome is also the automatic label for training data.
 */
import type { GameBackend } from '../backend/MicrobotBackend.ts';
import type { GameAction, Snapshot } from '../types.ts';

export type Change =
  | 'position'
  | 'animation'
  | 'moving'
  | 'interacting'
  | 'inventory'
  | 'equipment'
  | 'hp'
  | 'dialogue'
  | 'production'
  | 'bank'
  | 'walk'
  | 'run'
  | 'combat_style'
  | 'xp'
  | 'shop'
  | 'ge';

export interface Outcome {
  success: boolean;
  /** "changed: inventory,animation" | "failed: I can't reach that!" | "no effect" */
  effect: string;
  changes: Change[];
  ticks: number;
  messages: string[];
  after: Snapshot;
}

export const FAILURE_MESSAGE =
  /can't reach|cannot reach|you need|you do not have|you don't have|nothing interesting|inventory is too full|not enough space|you can't|you cannot|isn't anything|too far|someone else|out of reach|already|who said you could|not allowed|you're not allowed|you are not allowed|no ammo left|do not have enough/i;

const invKey = (s: Snapshot) => s.inventory.items.map((i) => `${i.slot}:${i.id}:${i.quantity}`).join(',');
const eqKey = (s: Snapshot) => s.equipment.map((e) => `${e.slot}:${e.id}`).join(',');
const dlgKey = (s: Snapshot) => `${s.dialogue.inDialogue}|${s.dialogue.text ?? ''}|${s.dialogue.options.join('/')}`;

export function diff(a: Snapshot, b: Snapshot): Change[] {
  const out: Change[] = [];
  const pa = a.player;
  const pb = b.player;
  if (pa && pb) {
    if (pa.position.x !== pb.position.x || pa.position.y !== pb.position.y || pa.position.plane !== pb.position.plane) out.push('position');
    if (!pa.animating && pb.animating) out.push('animation');
    if (!pa.moving && pb.moving) out.push('moving');
    if ((pa.interacting?.index ?? null) !== (pb.interacting?.index ?? null) || (pa.interacting?.name ?? null) !== (pb.interacting?.name ?? null)) out.push('interacting');
    if (pa.hp.current !== pb.hp.current) out.push('hp');
    if (pa.runEnabled !== pb.runEnabled) out.push('run');
    if (pa.attackStyle !== pb.attackStyle || pa.autocast !== pb.autocast) out.push('combat_style');
  }
  if (invKey(a) !== invKey(b)) out.push('inventory');
  if (eqKey(a) !== eqKey(b)) out.push('equipment');
  if (dlgKey(a) !== dlgKey(b)) out.push('dialogue');
  if (a.production.open !== b.production.open) out.push('production');
  if (a.bank.open !== b.bank.open) out.push('bank');
  if (a.shop.open !== b.shop.open) out.push('shop');
  if (!!a.grandExchange?.open !== !!b.grandExchange?.open) out.push('ge');
  if (!a.walk.active && b.walk.active) out.push('walk');
  if (xpGains(a, b).length > 0) out.push('xp');
  return out;
}

/** Skills whose XP rose between two snapshots, e.g. ["Attack", "Hitpoints"]. */
export function xpGains(a: Snapshot, b: Snapshot): string[] {
  const before = new Map(a.skills.map((s) => [s.name, s.xp]));
  return b.skills.filter((s) => s.xp > (before.get(s.name) ?? s.xp)).map((s) => s.name);
}

/** Which changes count as "the game accepted this action". */
export function expectedChanges(action: GameAction): Change[] {
  switch (action.op) {
    case 'interact':
      switch (action.target.kind) {
        case 'npc':
        case 'object':
          return ['animation', 'moving', 'position', 'interacting', 'inventory', 'dialogue', 'production', 'bank', 'shop', 'ge', 'xp'];
        case 'ground_item':
          return ['inventory', 'moving', 'position'];
        case 'inventory':
        case 'equipment':
          return ['inventory', 'equipment', 'hp', 'animation', 'dialogue', 'production', 'xp'];
        case 'dialogue':
          return ['dialogue'];
      }
      return [];
    case 'use_item_on':
      return ['animation', 'inventory', 'moving', 'position', 'dialogue', 'production'];
    case 'walk':
      return ['walk', 'position', 'moving'];
    case 'walk_cancel':
      return ['walk', 'position'];
    case 'dialogue_continue':
    case 'dialogue_select':
      return ['dialogue', 'inventory', 'production'];
    case 'production_select':
      return ['production', 'animation', 'inventory', 'xp'];
    case 'bank_open':
    case 'bank_close':
      return ['bank', 'moving', 'position'];
    case 'bank_deposit_all':
    case 'bank_deposit':
    case 'bank_withdraw':
    case 'drop':
      return ['inventory'];
    case 'toggle_run':
      return ['run'];
    case 'attack_style':
    case 'autocast':
      return ['combat_style'];
    case 'shop_buy':
      return ['inventory'];
    case 'shop_close':
      return ['shop'];
    case 'ge_buy':
    case 'ge_collect':
      return ['inventory'];
    case 'ge_close':
      return ['ge'];
    case 'wait':
    case 'done':
      return [];
  }
}

export interface VerifyOptions {
  timeoutTicks?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function verifyEffect(backend: GameBackend, before: Snapshot, action: GameAction, opts: VerifyOptions = {}): Promise<Outcome> {
  const timeoutTicks = opts.timeoutTicks ?? 5;
  const pollMs = opts.pollMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;
  const expected = new Set(expectedChanges(action));
  const seenMessages = new Set(before.messages.map((m) => `${m.tick}|${m.text}`));
  const deadline = Date.now() + timeoutTicks * 600 + 400;

  let after = before;
  for (;;) {
    await sleep(pollMs);
    after = await backend.snapshot();
    const fresh = after.messages.filter((m) => !seenMessages.has(`${m.tick}|${m.text}`)).map((m) => m.text);
    // Requirement failures often arrive as a sprite dialogue box rather than a chat message.
    const newDialogue = after.dialogue.inDialogue && after.dialogue.text !== before.dialogue.text ? after.dialogue.text : undefined;
    const failure = fresh.find((m) => FAILURE_MESSAGE.test(m)) ?? (newDialogue && FAILURE_MESSAGE.test(newDialogue) ? newDialogue : undefined);
    const changes = diff(before, after);
    const ticks = Math.max(0, after.tick - before.tick);
    if (failure) {
      return { success: false, effect: `failed: ${failure}`, changes, ticks, messages: fresh, after };
    }
    const hits = changes.filter((c) => expected.has(c));
    if (hits.length > 0) {
      // XP is the clearest evidence of progress (a kill, a catch) for the next decision.
      const gained = xpGains(before, after);
      const xp = gained.length ? ` (+xp ${gained.join(', ')})` : '';
      return { success: true, effect: `changed: ${hits.filter((h) => h !== 'xp').join(',') || 'xp'}${xp}`, changes, ticks, messages: fresh, after };
    }
    if (Date.now() >= deadline || ticks >= timeoutTicks + 2) {
      return { success: false, effect: 'no effect', changes, ticks, messages: fresh, after };
    }
  }
}
