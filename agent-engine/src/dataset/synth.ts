/**
 * Rule-labelled knowledge decisions: questions whose correct answer follows from game data (the KB
 * built from the cache and the wiki), so no teacher is needed. They teach the OSRS vocabulary and
 * relations Laya lacks zero-shot: which monster is weakest, which tree a level allows, which tool a
 * resource needs, which food heals most, which drop is worth most, which weapon is best usable.
 *
 * Options are written in the engine's own label format and states are real logged states with the
 * sub-goal (and, where relevant, inventory/skills) replaced, so the examples look like runtime ones.
 *
 * Run: node src/dataset/synth.ts [--kb data/kb.sqlite] [--states data/dataset/decisions.jsonl]
 *      [--out data/dataset/synthetic.jsonl] [--per-family 600] [--seed 7]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { FOOD_HEAL, RESOURCES, STATIONS } from '../kb/resources.ts';
import { classifyGear, type CombatStyle } from '../planner/gear.ts';
import type { Example } from './export.ts';
import { rng } from './reverse.ts';

type Rnd = () => number;
interface Option {
  id: string;
  label: string;
}
interface Built {
  goal: string;
  options: Option[];
  /** Option ids that satisfy the goal (soft label); the first is the hard label. */
  answers: string[];
  inventory?: string;
  skills?: string;
}

const pick = <T>(xs: T[], r: Rnd): T => xs[Math.floor(r() * xs.length)]!;
const int = (lo: number, hi: number, r: Rnd) => lo + Math.floor(r() * (hi - lo + 1));
function sample<T>(xs: T[], n: number, r: Rnd): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]!);
  return out;
}
const tiles = (r: Rnd) => ` - ${int(1, 14, r)} tiles`;

// --- families -------------------------------------------------------------------------------

interface Monster {
  id: number;
  name: string;
  level: number;
  hp: number;
  maxHit: string;
  style: string;
}

function monsters(db: DatabaseSync): Monster[] {
  const rows = db.prepare("SELECT npc_id, name, combat_level, hitpoints, max_hit, attack_style FROM monsters WHERE combat_level BETWEEN 1 AND 120 AND hitpoints > 0 AND name NOT LIKE '%(%'").all();
  const seen = new Set<string>();
  const out: Monster[] = [];
  for (const r of rows) {
    const key = `${r.name}|${r.combat_level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const parse = (v: unknown) => { try { return (JSON.parse(String(v)) as string[])[0] ?? '?'; } catch { return '?'; } };
    out.push({ id: r.npc_id as number, name: r.name as string, level: r.combat_level as number, hp: r.hitpoints as number, maxHit: parse(r.max_hit), style: parse(r.attack_style) });
  }
  return out;
}

function monsterFamily(ms: Monster[], r: Rnd): Built | null {
  const set = sample(ms, int(4, 7, r), r);
  if (new Set(set.map((m) => m.level)).size !== set.length) return null;
  const options = set.map((m, i) => ({ id: `npc:${1000 + i}#Attack`, label: `${m.name} (level ${m.level}): Attack (${m.hp} hp, max hit ${m.maxHit}, ${m.style})${tiles(r)}` }));
  const byLevel = set.map((m, i) => ({ m, id: options[i]!.id })).sort((a, b) => a.m.level - b.m.level);
  const kind = int(0, 2, r);
  if (kind === 0) return { goal: pick(['attack the weakest monster here', 'fight the lowest-level monster nearby', 'attack the easiest target'], r), options, answers: [byLevel[0]!.id] };
  if (kind === 1) return { goal: pick(['attack the strongest monster here', 'fight the highest-level monster nearby'], r), options, answers: [byLevel.at(-1)!.id] };
  const cap = byLevel[int(1, byLevel.length - 1, r)]!.m.level;
  const below = byLevel.filter((x) => x.m.level < cap);
  return { goal: `attack the strongest monster below combat level ${cap}`, options, answers: [below.at(-1)!.id] };
}

function resourceFamily(r: Rnd): Built | null {
  const skill = pick(['Woodcutting', 'Mining', 'Fishing'], r);
  const rules = RESOURCES.filter((x) => x.skill === skill && !x.members);
  const set = sample(rules, int(3, 6, r), r);
  if (set.length < 3) return null;
  const level = int(1, 60, r);
  const options = set.map((x, i) => {
    const missing = x.level > level ? `; missing ${skill} ${x.level}` : '';
    const prefix = x.kind === 'npc' ? `npc:${2000 + i}` : `obj:${3000 + i}@0,0,0`;
    return { id: `${prefix}#${x.action}`, label: `${x.target}: ${x.action} (${skill} ${x.level}, ${x.kind === 'npc' ? '' : 'gives '}${x.products.join('/')}${missing})${tiles(r)}`, rule: x };
  });
  const skills = `${skill} ${level}, Hitpoints 20`;
  if (r() < 0.5) {
    const usable = options.filter((o) => o.rule.level <= level);
    if (!usable.length) return null;
    const best = Math.max(...usable.map((o) => o.rule.level));
    const verb = skill === 'Woodcutting' ? 'chop the best tree' : skill === 'Mining' ? 'mine the best rock' : 'fish at the best spot';
    return { goal: `${verb} you can with ${skill} ${level}`, options, answers: usable.filter((o) => o.rule.level === best).map((o) => o.id), skills };
  }
  const target = pick(options.filter((o) => o.rule.level <= level), r);
  if (!target) return null;
  const product = target.rule.products[0]!;
  const answers = options.filter((o) => o.rule.products.includes(product) && o.rule.level <= level).map((o) => o.id);
  return { goal: pick([`get some ${product.toLowerCase()}`, `gather ${product.toLowerCase()}`], r), options, answers: [target.id, ...answers.filter((a) => a !== target.id)], skills };
}

function foodFamily(r: Rnd): Built | null {
  const foods = sample(Object.entries(FOOD_HEAL), int(2, 5, r), r);
  if (new Set(foods.map(([, h]) => h)).size !== foods.length) return null;
  const options = foods.map(([name], i) => ({ id: `inv:${i}#Eat`, label: `Inventory ${name}${r() < 0.5 ? ` (have ${int(2, 9, r)})` : ''}: Eat` }));
  const best = foods.map(([, h], i) => ({ h, i })).sort((a, b) => b.h - a.h)[0]!;
  const inventory = foods.map(([n]) => n).join('; ') + `; ${int(5, 20, r)} free slots`;
  return { goal: pick(['eat the food that heals the most', 'heal as much as possible with one bite', 'eat your best food'], r), options, answers: [options[best.i]!.id], inventory };
}

function lootFamily(items: { name: string; cost: number }[], r: Rnd): Built | null {
  const set = sample(items, int(3, 6, r), r);
  if (new Set(set.map((x) => x.cost)).size !== set.length) return null;
  const options = set.map((x, i) => ({ id: `ground:${4000 + i}@0,0,0#Take`, label: `${x.name} on the ground: Take (worth ${x.cost} gp)${tiles(r)}` }));
  const best = set.map((x, i) => ({ c: x.cost, i })).sort((a, b) => b.c - a.c)[0]!;
  return { goal: pick(['pick up the most valuable drop', 'loot the drop worth the most', 'take the most valuable item on the ground'], r), options, answers: [options[best.i]!.id] };
}

const METALS = ['Bronze', 'Iron', 'Steel', 'Black', 'Mithril', 'Adamant', 'Rune'];
const WEAPONS = ['scimitar', 'longsword', 'sword', 'mace', 'dagger', 'battleaxe'];
const BOWS = ['Shortbow', 'Oak shortbow', 'Willow shortbow', 'Maple shortbow', 'Yew shortbow', 'Longbow', 'Oak longbow'];

function gearFamily(r: Rnd): Built | null {
  const style: CombatStyle = r() < 0.7 ? 'melee' : 'ranged';
  const names = style === 'melee'
    ? sample(METALS.flatMap((m) => WEAPONS.map((w) => `${m} ${w}`)), int(3, 5, r), r)
    : sample(BOWS, int(3, 5, r), r);
  const skill = style === 'melee' ? 'Attack' : 'Ranged';
  const level = int(1, 45, r);
  const info = names.map((n) => ({ n, g: classifyGear(n, style)! }));
  const usable = info.filter((x) => x.g.req <= level);
  if (!usable.length) return null;
  const best = usable.sort((a, b) => b.g.score - a.g.score)[0]!;
  const options = names.map((n, i) => ({ id: `inv:${i}#Wield`, label: `Inventory ${n}: Wield` }));
  const id = options[names.indexOf(best.n)]!.id;
  return {
    goal: style === 'melee' ? pick([`wield the best weapon you can use with Attack ${level}`, `equip your strongest usable weapon (Attack ${level})`], r) : `wield the best bow you can use with Ranged ${level}`,
    options,
    answers: [id],
    inventory: names.join('; ') + `; ${int(5, 20, r)} free slots`,
    skills: `${skill} ${level}, Defence ${int(1, 40, r)}`,
  };
}

const TOOL_ITEMS: Record<string, string[]> = {
  axe: ['Bronze axe', 'Iron axe', 'Steel axe'],
  pickaxe: ['Bronze pickaxe', 'Iron pickaxe', 'Steel pickaxe'],
  'small fishing net': ['Small fishing net'],
  'fishing rod': ['Fishing rod'],
  'fly fishing rod': ['Fly fishing rod'],
  'lobster pot': ['Lobster pot'],
  harpoon: ['Harpoon'],
};
const DISTRACTORS = ['Hammer', 'Tinderbox', 'Chisel', 'Needle', 'Knife', 'Bucket', 'Pot', 'Shears', 'Bronze bar', 'Coins', 'Feather'];

function toolFamily(r: Rnd): Built | null {
  const rule = pick(RESOURCES.filter((x) => !x.members && TOOL_ITEMS[x.tools[0] ?? '']), r);
  const tool = pick(TOOL_ITEMS[rule.tools[0]!]!, r);
  const others = sample(DISTRACTORS, int(3, 5, r), r);
  const where = r() < 0.5 ? 'bank' : 'shop';
  const names = [tool, ...others].sort(() => r() - 0.5);
  const options = names.map((n, i) =>
    where === 'bank'
      ? { id: `bank:w1:${5000 + i}`, label: `Withdraw 1 ${n} (bank has ${int(1, 30, r)})` }
      : { id: `shop:buy1:${5000 + i}`, label: `Buy 1 ${n} (shop has ${int(1, 10, r)})` },
  );
  const act = rule.skill === 'Woodcutting' ? `chop ${rule.target.toLowerCase()}s` : rule.skill === 'Mining' ? `mine ${rule.target.toLowerCase()}` : `catch ${rule.products[0]!.replace(/^Raw /, '').toLowerCase()}`;
  const verb = where === 'bank' ? 'withdraw' : 'buy';
  return { goal: pick([`${verb} the tool you need to ${act}`, `${verb} what you need to ${act}`], r), options, answers: [options[names.indexOf(tool)]!.id] };
}

function stationFamily(r: Rnd): Built | null {
  const set = sample(STATIONS.filter((s) => s.target !== 'Altar'), int(3, 5, r), r);
  const target = pick(set, r);
  const want: Record<string, string[]> = {
    Cook: ['cook the raw fish', 'cook your raw food'],
    Smelt: ['smelt the ore into bars', 'turn the ore into bars'],
    Smith: ['smith the bars into armour', 'hammer the bars into a weapon'],
    Spin: ['spin the wool into balls of wool', 'spin the flax into bow strings'],
    Use: ['shape the soft clay into pots'],
    Fire: ['fire the unfired pottery'],
  };
  const goals = want[target.action];
  if (!goals) return null;
  const options = set.map((s, i) => ({ id: `obj:${6000 + i}@0,0,0#${s.action}`, label: `${s.target}: ${s.action} (${s.skill})${tiles(r)}` }));
  const answers = set.map((s, i) => (s.action === target.action ? options[i]!.id : null)).filter((x): x is string => !!x);
  return { goal: pick(goals, r), options, answers };
}

// --- assembly ----------------------------------------------------------------------------------

export function synthesize(db: DatabaseSync, baseStates: Record<string, unknown>[], perFamily: number, seed: number): Example[] {
  const r = rng(seed);
  const ms = monsters(db);
  const items = db.prepare("SELECT name, cost FROM items WHERE tradeable = 1 AND noted = 0 AND members = 0 AND cost BETWEEN 1 AND 50000 AND name NOT LIKE '%(%'").all().map((x) => ({ name: x.name as string, cost: x.cost as number }));
  const families: [string, () => Built | null][] = [
    ['monster', () => monsterFamily(ms, r)],
    ['resource', () => resourceFamily(r)],
    ['food', () => foodFamily(r)],
    ['loot', () => lootFamily(items, r)],
    ['gear', () => gearFamily(r)],
    ['tool', () => toolFamily(r)],
    ['station', () => stationFamily(r)],
  ];
  const out: Example[] = [];
  for (const [family, make] of families) {
    const seen = new Set<string>();
    for (let tries = 0, n = 0; n < perFamily && tries < perFamily * 20; tries++) {
      const b = make();
      if (!b || !b.answers.length) continue;
      const key = `${b.goal}|${b.options.map((o) => o.label.replace(/ - \d+ tiles/, '')).sort().join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = pick(baseStates, r);
      const state: Record<string, unknown> = { ...base, subgoal: b.goal, recent_actions: [], dialogue: undefined };
      if (b.inventory) state.inventory = b.inventory;
      if (b.skills) state.skills = b.skills;
      const soft = Object.fromEntries(b.options.map((o) => [o.id, b.answers.includes(o.id) ? 1 / b.answers.length : 0]));
      out.push({
        state,
        questions: { target: { type: 'choice', instructions: `Which action best serves the sub-goal "${b.goal}"?`, criteria: Object.fromEntries(b.options.map((o) => [o.id, o.label])) } } as Example['questions'],
        labels: { target: b.answers[0]! },
        soft: { target: soft },
        source: 'synthetic' as Example['source'],
        outcome: `rule:${family}`,
        subgoal: b.goal,
        engine: 'none',
        runId: `synthetic-${family}`,
        step: n,
      });
      n++;
    }
  }
  return out;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      kb: { type: 'string', default: 'data/kb.sqlite' },
      states: { type: 'string', default: 'data/dataset/decisions.jsonl' },
      out: { type: 'string', default: 'data/dataset/synthetic.jsonl' },
      'per-family': { type: 'string', default: '600' },
      seed: { type: 'string', default: '7' },
    },
  });
  const db = new DatabaseSync(values.kb!, { readOnly: true });
  const baseStates = readFileSync(values.states!, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as Example).state as Record<string, unknown>);
  const examples = synthesize(db, baseStates, Number(values['per-family']), Number(values.seed));
  mkdirSync(path.dirname(path.resolve(values.out!)), { recursive: true });
  writeFileSync(values.out!, examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const by = examples.reduce<Record<string, number>>((m, e) => ((m[e.outcome] = (m[e.outcome] ?? 0) + 1), m), {});
  console.log(`${examples.length} rule-labelled examples -> ${values.out} ${JSON.stringify(by)}`);
}
