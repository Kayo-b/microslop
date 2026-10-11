/**
 * Runs a Microbot Hub plugin (a sideloaded jar in <client home>/.runelite/microbot-plugins) as a
 * training method: the engine does what the plugin cannot (restock at the Grand Exchange, sell the
 * products, walk to the start), then sets the plugin's config, starts it and watches the XP.
 *
 *   level reached -> stop the plugin, complete
 *   supplies short -> GE bank: deposit, withdraw coins + products as notes -> GE: sell, buy -> bank
 *   ready -> walk to the start -> config -> start -> wait while the XP climbs
 *   no XP for `stallMinutes` -> stop, re-check the bank (a plugin stops itself when out of inputs)
 *
 * The specs (which plugin, config and supplies for a level) live in hubSpecs.ts.
 */
import type { MicrobotBackend } from '../backend/MicrobotBackend.ts';
import { compile, type DoneCondition } from '../planner/conditions.ts';
import type { Planner, PlannerContext, PlanStep } from '../planner/types.ts';
import type { Snapshot, WorldPoint } from '../types.ts';
import { GRAND_EXCHANGE } from './AcquirePlanner.ts';
import { HUB_PLUGIN_CLASSES } from './hubSpecs.ts';
import { GRAND_EXCHANGE_BANK } from './SellPlanner.ts';

export interface Supply {
  name: string;
  /** Owned (bank + inventory + worn) after a restock. */
  want: number;
  /** A restock is due below this; default `want`. */
  min?: number;
  /** Matches any item whose name contains `name` (a pickaxe of any metal); bought as `name` otherwise. */
  anyOf?: string[];
}

export interface HubRun {
  /** Shown in logs: "superheat steel", "Varrock rooftop". */
  label: string;
  /** Another plugin than the spec's for this run (a spec switching between two plugins). */
  className?: string;
  group?: string;
  /** Plugin config for this run (key -> value, the spec's group). */
  config: Record<string, string>;
  supplies: Supply[];
  /** Products sold at every restock. */
  sell: string[];
  /** Where the plugin expects to start. */
  start?: { name: string; point: WorldPoint; radius?: number };
  /** Taken from the bank before starting, for plugins that never bank (alching: notes and runes). */
  carry?: { name: string; noted?: boolean }[];
  /** Worn before starting (a staff for its runes, a pickaxe). */
  wear?: string[];
}

export interface HubSpec {
  id: string;
  className: string;
  /** Config group of the plugin. */
  group: string;
  skill: string;
  /** This run's settings from the account; a string says why it cannot run. */
  plan(a: { level: number; levels: (skill: string) => number; coins: number; owned: (name: string) => number; price: (item: string) => number | null; members: boolean }): HubRun | string;
  /** Minutes without XP before the plugin is stopped and the supplies re-checked (default 4). */
  stallMinutes?: number;
}

export interface HubOptions {
  backend: Pick<MicrobotBackend, 'pluginConfig' | 'pluginStart' | 'pluginStop' | 'pluginState'>;
  untilLevel?: number;
  price: (item: string) => number | null;
  /** Bank last seen before this run (name -> count); null when never seen. */
  bank?: () => Map<string, number> | null;
  now?: () => number;
  members?: boolean;
}

/** GE buy offers go in at the guide price +30% (see the ge_buy action). */
const GE_MARKUP = 1.3;
/** Coins left in the bank after a restock, for teleports and fees. */
const KEEP_COINS = 20_000;
/** Products worth this much are sold even when no supply is short. */
const SELL_AT = 100_000;
/** Stalls in a row (no XP at all between them) before the method is given up. */
const MAX_STALLS = 3;

/** The plugin started by this process, stopped on exit (SIGTERM, Ctrl+C) so it never runs on alone. */
let running: { backend: HubOptions['backend']; className: string } | null = null;

export async function stopRunningHubPlugin(): Promise<void> {
  const r = running;
  running = null;
  if (r) await stopPlugin(r.backend, r.className);
}

/** Stops a plugin, retrying once; a failed stop is logged, never silent (a plugin left enabled restarts with the client). */
async function stopPlugin(backend: Pick<MicrobotBackend, 'pluginStop'>, className: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await backend.pluginStop(className);
      return true;
    } catch (e) {
      if (attempt === 2) console.warn(`[hub] could not stop ${className}: ${(e as Error).message}`);
    }
  }
  return false;
}

/**
 * Stops every hub plugin that is running or enabled, whoever started it. A plugin left over from an
 * earlier run (killed agent, restarted client: its enabled flag survives) otherwise keeps walking
 * and clicking alongside the agent. Call before a run starts its own.
 */
export async function stopStrayHubPlugins(backend: Pick<MicrobotBackend, 'pluginList' | 'pluginStop'>): Promise<string[]> {
  const stopped: string[] = [];
  const all = await backend.pluginList().catch(() => []);
  for (const p of all) {
    if (!HUB_PLUGIN_CLASSES.includes(p.className) || !(p.active || p.enabled)) continue;
    if (await stopPlugin(backend, p.className)) stopped.push(p.className);
  }
  if (stopped.length) console.log(`[hub] stopped leftover hub plugin(s): ${stopped.map((c) => c.split('.').pop()).join(', ')}`);
  return stopped;
}

function step(text: string, targets: string[], actions: string[], doneWhen: DoneCondition, maxSteps: number, extra: object = {}): PlanStep {
  return { kind: 'subgoal', subgoal: { text, targets, actions, doneWhen, isDone: compile(doneWhen), maxSteps, keep: ['Coins'], ...extra } };
}

const lc = (s: string) => s.toLowerCase();

/** How many of `sup` the account owns, given the bank and what is carried and worn. */
export function ownedCount(sup: Pick<Supply, 'name' | 'anyOf'>, s: Snapshot, bank: Map<string, number>): number {
  const match = (name: string) => (sup.anyOf ? sup.anyOf.some((p) => lc(name).includes(lc(p))) : lc(name) === lc(sup.name));
  let n = 0;
  for (const i of s.inventory.items) if (match(i.name)) n += i.quantity;
  for (const e of s.equipment) if (match(e.name)) n += e.quantity ?? 1;
  for (const [name, q] of bank) if (match(name)) n += q;
  return n;
}

function skillOf(s: Snapshot, skill: string): { level: number; xp: number } {
  const k = s.skills.find((x) => lc(x.name) === lc(skill));
  return { level: k?.level ?? 1, xp: k?.xp ?? 0 };
}

export class HubPluginPlanner implements Planner {
  readonly name: string;
  private readonly spec: HubSpec;
  private readonly o: HubOptions;
  private readonly now: () => number;
  private bank: Map<string, number> | null;
  /** The bank changed since it was last seen open (the plugin banks while it runs). */
  private bankStale = false;
  private phase: 'prep' | 'restock' | 'running' = 'prep';
  private restock: { buy: { name: string; quantity: number }[]; sell: string[]; stage: 'bank1' | 'ge' | 'bank2' } | null = null;
  private lastXp = 0;
  private lastXpAt = 0;
  private stalls = 0;
  private run: HubRun | null = null;
  /** Plugin this planner started and has not stopped yet. */
  private active: string | null = null;

  constructor(spec: HubSpec, o: HubOptions) {
    this.spec = spec;
    this.o = o;
    this.name = `hub:${spec.id}`;
    this.now = o.now ?? Date.now;
    this.bank = o.bank?.() ?? null;
  }

  async next(ctx: PlannerContext): Promise<PlanStep> {
    const s = ctx.snapshot;
    if (s.bank.open) {
      this.bank = new Map(s.bank.items.map((b) => [b.name, b.quantity]));
      this.bankStale = false;
    }
    const { level, xp } = skillOf(s, this.spec.skill);
    if (this.o.untilLevel && level >= this.o.untilLevel) {
      await this.stop();
      return { kind: 'complete', reason: `${this.spec.skill} ${level} reached` };
    }

    if (this.phase === 'running') {
      if (xp > this.lastXp) {
        this.lastXp = xp;
        this.lastXpAt = this.now();
        this.stalls = 0;
      }
      const stalledFor = this.now() - this.lastXpAt;
      if (stalledFor < (this.spec.stallMinutes ?? 4) * 60_000) {
        return { kind: 'wait', reason: `${this.run?.label ?? this.spec.id} running (${this.spec.skill} ${level})`, until: this.o.untilLevel ? { skillLevel: { skill: this.spec.skill, level: this.o.untilLevel } } : {}, maxSeconds: 60 };
      }
      await this.stop();
      this.phase = 'prep';
      this.bankStale = true;
      if (++this.stalls > MAX_STALLS) return { kind: 'impossible', reason: `${this.run?.label ?? this.spec.id}: no ${this.spec.skill} XP after ${MAX_STALLS} restarts` };
      console.log(`[hub] ${this.spec.id}: no XP for ${Math.round(stalledFor / 60_000)} min, stopped (${this.stalls}/${MAX_STALLS}); re-checking supplies`);
    }

    if (this.phase === 'restock' && this.restock) return this.restockStep(s);

    // prep: the bank must be known (and fresh after the plugin ran) before supplies are judged.
    if (this.bank === null || this.bankStale) return this.openBank(ctx, 'see the supplies');
    const coins = ownedCount({ name: 'Coins' }, s, this.bank);
    const plan = this.spec.plan({
      level,
      levels: (k) => skillOf(s, k).level,
      coins,
      owned: (name) => ownedCount({ name }, s, this.bank!),
      price: this.o.price,
      members: this.o.members ?? false,
    });
    if (typeof plan === 'string') return { kind: 'impossible', reason: plan };
    this.run = plan;

    const short = plan.supplies.filter((sup) => ownedCount(sup, s, this.bank!) < (sup.min ?? sup.want));
    const sellable = plan.sell.filter((p) => ownedCount({ name: p }, s, this.bank!) > 0);
    const sellValue = sellable.reduce((v, p) => v + ownedCount({ name: p }, s, this.bank!) * (this.o.price(p) ?? 0), 0);
    if (short.length || sellValue >= SELL_AT) {
      let budget = coins - KEEP_COINS;
      const buy: { name: string; quantity: number }[] = [];
      for (const sup of short) {
        const missing = sup.want - ownedCount(sup, s, this.bank);
        const each = Math.ceil((this.o.price(sup.name) ?? 0) * GE_MARKUP) || 1;
        const quantity = Math.min(missing, Math.floor(budget / each));
        if (quantity <= 0) continue;
        buy.push({ name: sup.name, quantity });
        budget -= quantity * each;
      }
      const unbuyable = short.filter((sup) => !buy.some((b) => b.name === sup.name) && ownedCount(sup, s, this.bank!) < (sup.min ?? sup.want));
      if (unbuyable.length && !sellable.length) {
        return { kind: 'impossible', reason: `${plan.label}: ${coins} coins do not buy ${unbuyable.map((u) => u.name).join(', ')}` };
      }
      this.restock = { buy, sell: sellable, stage: 'bank1' };
      this.phase = 'restock';
      console.log(`[hub] ${this.spec.id}: restock ${buy.map((b) => `${b.quantity} ${b.name}`).join(', ') || 'nothing'}${sellable.length ? `; sell ${sellable.join(', ')}` : ''}`);
      return this.restockStep(s);
    }

    const loadout = this.loadoutStep(s, plan);
    if (loadout) return loadout;
    if (s.bank.open) return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank before starting' };
    if (s.grandExchange?.open) return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    const pos = s.player?.position;
    const st = plan.start;
    if (st && pos && (pos.plane !== st.point.plane || Math.max(Math.abs(pos.x - st.point.x), Math.abs(pos.y - st.point.y)) > (st.radius ?? 12))) {
      return step(`walk to ${st.name} to start ${plan.label}`, [], [], { near: { ...st.point, radius: st.radius ?? 12 } }, 600, { destination: { name: st.name, point: st.point } });
    }

    const className = plan.className ?? this.spec.className;
    const state = await this.o.backend.pluginState(className);
    if (!state.loaded) return { kind: 'impossible', reason: `hub plugin ${className} is not loaded: put its jar in microbot-plugins and restart the client` };
    if (state.active) await stopPlugin(this.o.backend, className);
    for (const [key, value] of Object.entries(plan.config)) await this.o.backend.pluginConfig(plan.group ?? this.spec.group, key, value);
    await this.o.backend.pluginStart(className);
    running = { backend: this.o.backend, className };
    this.active = className;
    this.phase = 'running';
    this.lastXp = xp;
    this.lastXpAt = this.now();
    console.log(`[hub] ${this.spec.id}: started ${plan.label} (${this.spec.skill} ${level}) config ${JSON.stringify(plan.config)}`);
    return { kind: 'wait', reason: `started ${plan.label}`, until: {}, maxSeconds: 30 };
  }

  private async stop(): Promise<void> {
    if (!this.active) return;
    await stopPlugin(this.o.backend, this.active);
    if (running?.className === this.active) running = null;
    this.active = null;
  }

  /** Carried and worn items the plugin expects but does not fetch; null when all are in place. */
  private loadoutStep(s: Snapshot, plan: HubRun): PlanStep | null {
    const held = (name: string) => s.inventory.items.some((i) => lc(i.name) === lc(name));
    const worn = (name: string) => s.equipment.some((e) => lc(e.name) === lc(name));
    const inBank = (name: string) => (this.bank?.get(name) ?? 0) > 0;
    const carry = (plan.carry ?? []).filter((c) => !held(c.name) && inBank(c.name));
    const fetch = (plan.wear ?? []).filter((w) => !worn(w) && !held(w) && inBank(w));
    if (carry.length || fetch.length) {
      if (!s.bank.open) return step('open the Grand Exchange bank to take out the supplies', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 600, { destination: GRAND_EXCHANGE_BANK });
      const wanted = new Set([...(plan.carry ?? []).map((c) => lc(c.name)), ...(plan.wear ?? []).map(lc), 'coins']);
      if (s.inventory.items.some((i) => !wanted.has(lc(i.name)))) return { kind: 'act', action: { op: 'bank_deposit_all' }, reason: 'empty the inventory for the supplies' };
      const c = carry[0];
      const stack = c ? s.bank.items.find((b) => lc(b.name) === lc(c.name)) : s.bank.items.find((b) => lc(b.name) === lc(fetch[0]!));
      if (stack) return { kind: 'act', action: { op: 'bank_withdraw', itemId: stack.id, amount: c ? 'all' : 1, noted: c?.noted }, reason: `take out the ${stack.name}` };
    }
    const wield = (plan.wear ?? []).find((w) => !worn(w) && held(w));
    if (wield) {
      if (s.bank.open) return { kind: 'act', action: { op: 'bank_close' }, reason: `close the bank to wield the ${wield}` };
      return step(`wield the ${wield}`, [wield], ['Wield', 'Wear'], { equipped: [wield] }, 10);
    }
    return null;
  }

  private openBank(ctx: PlannerContext, why: string): PlanStep {
    const s = ctx.snapshot;
    const pos = s.player?.position;
    const near = pos && ctx.kb ? ctx.kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
    return step(`open the ${near?.name ?? 'nearest bank'} to ${why}`, ['Bank booth', 'Banker', 'Bank chest'], ['Bank', 'Use'], { bankOpen: true }, 400, near ? { destination: { name: near.name, point: near.point } } : {});
  }

  /** GE bank: deposit all, take coins and products as notes -> GE: sell, buy -> GE bank: deposit all. */
  private restockStep(s: Snapshot): PlanStep {
    const r = this.restock!;
    const inv = (name: string) => s.inventory.items.filter((i) => lc(i.name) === lc(name)).reduce((n, i) => n + i.quantity, 0);
    if (r.stage === 'bank1') {
      if (!s.bank.open) {
        if (s.grandExchange?.open) return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
        return step('open the Grand Exchange bank to restock', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 600, { destination: GRAND_EXCHANGE_BANK });
      }
      const junk = s.inventory.items.find((i) => i.name !== 'Coins' && !(i.noted && r.sell.includes(i.name)));
      if (junk) return { kind: 'act', action: { op: 'bank_deposit_all' }, reason: 'deposit the inventory' };
      for (const p of r.sell) {
        const stack = s.bank.items.find((b) => b.name === p);
        if (stack) return { kind: 'act', action: { op: 'bank_withdraw', itemId: stack.id, amount: 'all', noted: true }, reason: `withdraw the ${p} as notes to sell` };
      }
      const coins = s.bank.items.find((b) => b.name === 'Coins');
      if (r.buy.length && coins && coins.quantity > KEEP_COINS) return { kind: 'act', action: { op: 'bank_withdraw', itemId: coins.id, amount: coins.quantity - KEEP_COINS }, reason: 'withdraw coins for the supplies' };
      r.stage = 'ge';
      return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
    }
    if (r.stage === 'ge') {
      if (!s.grandExchange?.open) {
        if (s.bank.open) return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
        return step('open the Grand Exchange', ['Grand Exchange Clerk'], ['Exchange'], { geOpen: true }, 600, { destination: GRAND_EXCHANGE });
      }
      const toSell = r.sell.find((p) => inv(p) > 0);
      if (toSell) return { kind: 'act', action: { op: 'ge_sell', name: toSell }, reason: `sell ${inv(toSell)} ${toSell}` };
      const toBuy = r.buy.shift();
      if (toBuy) {
        const affordable = Math.min(toBuy.quantity, Math.floor(inv('Coins') / (Math.ceil((this.o.price(toBuy.name) ?? 0) * GE_MARKUP) || 1)));
        if (affordable > 0) return { kind: 'act', action: { op: 'ge_buy', name: toBuy.name, quantity: affordable }, reason: `buy ${affordable} ${toBuy.name}` };
      }
      if (r.buy.length) return { kind: 'wait', reason: 'next purchase', until: {}, maxSeconds: 1 };
      r.stage = 'bank2';
      return { kind: 'act', action: { op: 'ge_close' }, reason: 'close the Grand Exchange' };
    }
    // bank2: everything bought goes into the bank, where the plugins withdraw from.
    if (!s.bank.open) return step('open the Grand Exchange bank to store the supplies', ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 600, { destination: GRAND_EXCHANGE_BANK });
    if (s.inventory.items.length) return { kind: 'act', action: { op: 'bank_deposit_all' }, reason: 'deposit the supplies' };
    this.restock = null;
    this.phase = 'prep';
    return { kind: 'act', action: { op: 'bank_close' }, reason: 'close the bank' };
  }
}
