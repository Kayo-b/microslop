/**
 * Reverse-generated goals: every logged decision state already lists ~16 concrete options (NPCs,
 * objects, drops, inventory and bank actions). Pick one as the answer and write the sub-goal that
 * would call for it; no teacher has to solve anything, so labels are clean (the recipe that took
 * the Laya browser head from chance to 0.66 top-1). Options that satisfy the goal equally (another
 * cow, a banker instead of a bank booth) share the soft label; the hard label is the nearest.
 *
 * Goal phrasings mirror the planners' own sub-goal texts, with paraphrases so the model reads the
 * goal rather than matching one template. Option order is shuffled per example.
 *
 * Run: node src/dataset/reverse.ts [--logs logs/agent] [--out data/dataset/reverse.jsonl]
 *      [--per-state 3] [--per-pattern 60] [--seed 1]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { StepRecord } from '../engine/log.ts';
import type { Example } from './export.ts';

export interface ParsedOption {
  id: string;
  label: string;
  kind: 'npc' | 'obj' | 'ground' | 'inv' | 'use' | 'bank' | 'shop' | 'production' | 'other';
  name: string;
  action: string;
  distance: number | null;
  /** Product named in the label, e.g. "gives Copper ore" or "Raw shrimps/Raw anchovies". */
  product?: string;
  amount?: string;
  unusable: boolean;
}

const lc = (s: string) => s.toLowerCase();

export function parseOption(id: string, label: string): ParsedOption {
  const distance = Number(/ - (\d+) tiles/.exec(label)?.[1] ?? NaN);
  const base = { id, label, distance: Number.isFinite(distance) ? distance : null, unusable: /missing |unreachable/.test(label) };
  const prefix = id.split(':')[0];
  const product = /gives ([^)]+?)(?:;|\))/.exec(label)?.[1] ?? /\((?:Fishing|Mining|Woodcutting) \d+, ([^;)]+)/.exec(label)?.[1];
  if (prefix === 'npc' || prefix === 'obj') {
    const m = /^(.+?): (.+?)(?: \(| - |$)/.exec(label);
    const name = (m?.[1] ?? label).replace(/ \(level \d+\)$/, '');
    const action = id.split('#')[1] ?? m?.[2] ?? '';
    return { ...base, kind: prefix, name, action, product: product?.split('/')[0] };
  }
  if (prefix === 'ground') {
    const name = (/^(.+?)(?: x\d+)? on the ground/.exec(label)?.[1] ?? label).trim();
    return { ...base, kind: 'ground', name, action: 'Take' };
  }
  if (prefix === 'inv') {
    const m = /^Inventory (.+?)(?: \(have \d+\))?: (.+)$/.exec(label);
    return { ...base, kind: 'inv', name: m?.[1] ?? label, action: m?.[2] ?? id.split('#')[1] ?? '' };
  }
  if (prefix === 'use') {
    const m = /^Use (.+) on (.+)$/.exec(label);
    return { ...base, kind: 'use', name: m?.[2] ?? label, action: `Use ${m?.[1] ?? ''}` };
  }
  if (prefix === 'bank') {
    let m = /^Withdraw (\S+) (.+?)(?: \(|$)/.exec(label);
    if (m) return { ...base, kind: 'bank', name: m[2]!, action: 'Withdraw', amount: m[1] };
    m = /^Deposit all (.+)$/.exec(label);
    if (m) return { ...base, kind: 'bank', name: m[1]!, action: 'Deposit' };
    if (/whole inventory/.test(label)) return { ...base, kind: 'bank', name: 'inventory', action: 'Deposit all' };
    if (/^Close/.test(label)) return { ...base, kind: 'bank', name: 'bank', action: 'Close' };
  }
  if (prefix === 'shop') {
    const m = /^Buy (\d+) (.+?)(?: \(|$)/.exec(label);
    if (m) return { ...base, kind: 'shop', name: m[2]!, action: 'Buy', amount: m[1] };
    if (/^Close/.test(label)) return { ...base, kind: 'shop', name: 'shop', action: 'Close' };
  }
  if (prefix === 'production') {
    const m = /^(.+?): (.+)$/.exec(label);
    if (m) return { ...base, kind: 'production', name: m[2]!, action: m[1]! };
  }
  return { ...base, kind: 'other', name: label, action: '' };
}

/** What the goal asks for; options with the same intent satisfy it equally. */
export function intentKey(o: ParsedOption): string {
  if (lc(o.action) === 'bank') return 'bank';
  if (o.kind === 'bank' || o.kind === 'shop') return `${o.kind}|${o.action}|${o.name}|${o.amount ?? ''}`;
  if (o.kind === 'inv' || o.kind === 'use') return `${o.kind}|${o.action}|${o.name}`;
  return `${o.action}|${o.name}`;
}

const pick = <T>(xs: T[], rnd: () => number): T => xs[Math.floor(rnd() * xs.length)]!;

/** Paraphrases for the goal that calls for option `o`; null when no sensible goal exists. */
export function goalsFor(o: ParsedOption): string[] | null {
  const n = o.name;
  const a = lc(o.action);
  const prod = o.product ? lc(o.product) : null;
  switch (o.kind) {
    case 'npc':
    case 'obj': {
      if (a === 'bank') return ['open the bank', 'open the nearest bank', 'bank your items'];
      if (a === 'attack') return [`attack a ${lc(n)}`, `kill a ${lc(n)}`, `fight the nearest ${lc(n)}`];
      if (a === 'talk-to' || a === 'talk to') return [`talk to ${n}`, `speak with ${n}`];
      if (a === 'trade') return [`trade with ${n}`, `open ${n}'s shop`];
      if (a === 'pickpocket') return [`pickpocket a ${lc(n)}`, `steal from a ${lc(n)}`];
      if (a === 'mine') return prod ? [`mine ${prod}`, `mine the ${lc(n)}`, `get some ${prod}`] : [`mine the ${lc(n)}`];
      if (a === 'chop down') return prod ? [`chop the ${lc(n)}`, `cut ${prod}`, `chop a ${lc(n)} for ${prod}`] : [`chop the ${lc(n)}`];
      if (/^(net|small net|bait|lure|cage|harpoon|big net)$/.test(a)) {
        return prod ? [`catch ${prod.replace(/^raw /, '')}`, `fish for ${prod.replace(/^raw /, '')}`, `${a} fish at the fishing spot`] : [`${a} fish at the fishing spot`];
      }
      if (a === 'open') return [`open the ${lc(n)}`, `go through the ${lc(n)}`];
      if (a === 'close') return [`close the ${lc(n)}`];
      if (a === 'climb-up') return [`climb up the ${lc(n)}`, 'go upstairs'];
      if (a === 'climb-down') return [`climb down the ${lc(n)}`, 'go downstairs'];
      if (a === 'smelt') return ['smelt the ore into bars at the furnace', 'use the furnace'];
      if (a === 'smith') return [`smith at the ${lc(n)}`, 'smith the bars into gear'];
      if (a === 'cook') return [`cook the raw food on the ${lc(n)}`, 'cook the food'];
      if (a === 'spin') return ['spin the wool into balls of wool', `use the ${lc(n)}`];
      if (a === 'pick-from') return [`pick from the ${lc(n)}`];
      if (a === 'search') return [`search the ${lc(n)}`];
      if (a === 'board') return [`board the ${lc(n)}`];
      if (a === 'deposit') return ['use the deposit box', `deposit items at the ${lc(n)}`];
      if (a === 'take') return [`take the ${lc(n)}`];
      if (a === 'collect' || a === 'check' || a === 'guide' || a === 'inspect' || a === 'claim') return [`${a} the ${lc(n)}`];
      return [`${a} the ${lc(n)}`];
    }
    case 'ground':
      return [`pick up the ${n}`, `take the ${n} from the ground`, `loot the ${n}`];
    case 'inv':
      if (a === 'eat') return [`eat the ${n}`, `eat some ${n} to heal`];
      if (a === 'bury') return [`bury the ${n}`, `bury the ${n} for Prayer`];
      if (a === 'drop') return [`drop the ${n}`, `get rid of the ${n}`];
      if (a === 'wield') return [`wield the ${n}`, `equip the ${n}`];
      if (a === 'wear') return [`wear the ${n}`, `put on the ${n}`];
      return [`${a} the ${n}`];
    case 'use': {
      const tool = o.action.replace(/^Use /, '');
      if (/tinderbox/i.test(tool) && /logs/i.test(n)) return [`light the ${n}`, 'light a fire'];
      return [`use the ${tool} on the ${n}`];
    }
    case 'bank':
      if (o.action === 'Withdraw') return [`withdraw ${o.amount === 'all' ? 'all the' : o.amount} ${n}`, `take ${o.amount === 'all' ? 'all the' : o.amount} ${n} out of the bank`];
      if (o.action === 'Deposit') return [`deposit the ${n}`, `put the ${n} in the bank`];
      if (o.action === 'Deposit all') return ['deposit everything', 'empty the inventory into the bank'];
      if (o.action === 'Close') return ['close the bank'];
      return null;
    case 'shop':
      if (o.action === 'Buy') return [`buy ${o.amount} ${n}`];
      if (o.action === 'Close') return ['close the shop'];
      return null;
    case 'production':
      if (/^smith/i.test(o.action)) return [`smith a ${n}`, `make a ${n} at the anvil`];
      return [`make ${n}`, `make all the ${n}`];
    default:
      return null;
  }
}

/** Small seeded PRNG so exports are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface ReverseOptions {
  perState?: number;
  perPattern?: number;
  seed?: number;
}

/** Reverse examples from one logged state; `usage` counts examples per intent across the export. */
export function reverseFromRecord(r: StepRecord, usage: Map<string, number>, freq: Map<string, number>, rnd: () => number, o: Required<ReverseOptions>): Example[] {
  const criteria = r.questions?.target?.type === 'choice' ? r.questions.target.criteria : null;
  if (!criteria || !r.state) return [];
  const options = Object.entries(criteria).map(([id, label]) => parseOption(id, label));
  if (options.length < 3) return [];
  const groups = new Map<string, ParsedOption[]>();
  for (const opt of options) groups.set(intentKey(opt), [...(groups.get(intentKey(opt)) ?? []), opt]);

  // Rare intents first (inverse frequency), skipping unusable options and saturated intents.
  const pattern = (k: string) => k.replace(/\d+/g, '#');
  const eligible = [...groups.entries()].filter(([k, g]) => !g.every((x) => x.unusable) && goalsFor(g[0]!) && (usage.get(pattern(k)) ?? 0) < o.perPattern);
  const weighted = eligible.map(([k, g]) => ({ k, g, w: rnd() / (freq.get(pattern(k)) ?? 1) })).sort((a, b) => b.w - a.w).slice(0, o.perState);

  const out: Example[] = [];
  for (const { k, g } of weighted) {
    const usable = g.filter((x) => !x.unusable);
    const hard = [...usable].sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0]!;
    const goal = pick(goalsFor(hard)!, rnd);
    const soft = Object.fromEntries(options.map((x) => [x.id, usable.some((u) => u.id === x.id) ? 1 / usable.length : 0]));
    // "you need N more" hints were computed from the original sub-goal; they would contradict this one.
    const relabel = (label: string) => label.replace(/; you need \d+ more/, '').replace(/ \(you need \d+ more\)/, '');
    const shuffled = Object.fromEntries(shuffle(Object.entries(criteria), rnd).map(([id, label]) => [id, relabel(label)]));
    const state = { ...(r.state as unknown as Record<string, unknown>), subgoal: goal };
    out.push({
      state,
      questions: { target: { type: 'choice', instructions: `Which action best serves the sub-goal "${goal}"?`, criteria: shuffled } } as Example['questions'],
      labels: { target: hard.id },
      soft: { target: soft },
      source: 'reverse' as Example['source'],
      outcome: 'reverse-generated',
      subgoal: goal,
      engine: 'none',
      runId: r.runId,
      step: r.step,
    });
    usage.set(pattern(k), (usage.get(pattern(k)) ?? 0) + 1);
  }
  return out;
}

export function reverseDataset(logsDir: string, opts: ReverseOptions = {}): { examples: Example[]; states: number } {
  const o = { perState: opts.perState ?? 3, perPattern: opts.perPattern ?? 60, seed: opts.seed ?? 1 };
  const rnd = rng(o.seed);
  const records: StepRecord[] = [];
  if (existsSync(logsDir)) {
    for (const run of readdirSync(logsDir).sort()) {
      const file = path.join(logsDir, run, 'steps.jsonl');
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) if (line.trim()) records.push(JSON.parse(line) as StepRecord);
    }
  }
  // Intent frequencies over all logged options, so rare actions get picked first.
  const freq = new Map<string, number>();
  for (const r of records) {
    const c = r.questions?.target?.type === 'choice' ? r.questions.target.criteria : null;
    for (const [id, label] of Object.entries(c ?? {})) {
      const k = intentKey(parseOption(id, label)).replace(/\d+/g, '#');
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
  }
  const usage = new Map<string, number>();
  const examples: Example[] = [];
  let states = 0;
  // Visit states in random order so the per-pattern cap does not favour early runs.
  for (const r of shuffle(records, rnd)) {
    const ex = reverseFromRecord(r, usage, freq, rnd, o);
    if (ex.length) states++;
    examples.push(...ex);
  }
  return { examples, states };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      logs: { type: 'string', default: 'logs/agent' },
      out: { type: 'string', default: 'data/dataset/reverse.jsonl' },
      'per-state': { type: 'string', default: '3' },
      'per-pattern': { type: 'string', default: '60' },
      seed: { type: 'string', default: '1' },
    },
  });
  const { examples, states } = reverseDataset(path.resolve(values.logs!), {
    perState: Number(values['per-state']),
    perPattern: Number(values['per-pattern']),
    seed: Number(values.seed),
  });
  mkdirSync(path.dirname(path.resolve(values.out!)), { recursive: true });
  writeFileSync(values.out!, examples.map((e) => JSON.stringify(e)).join('\n') + (examples.length ? '\n' : ''));
  const byKind = examples.reduce<Record<string, number>>((m, e) => {
    const k = e.labels.target!.split(':')[0]!;
    return (m[k] = (m[k] ?? 0) + 1), m;
  }, {});
  console.log(`${examples.length} reverse-generated examples from ${states} states -> ${values.out} ${JSON.stringify(byKind)}`);
}
