import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AcquirePlanner } from '../src/goalplan/AcquirePlanner.ts';
import { freshProfile, levelForXp, nextMilestone, roadmap, xpForLevel } from '../src/goalplan/compiler.ts';
import { observedRates, type LedgerRecord } from '../src/goalplan/ledger.ts';
import { llmReport } from '../src/goalplan/report.ts';
import { parsePlan } from '../src/goalplan/spec.ts';
import { chooseOption, stageFor, TutorialPlanner } from '../src/goalplan/TutorialPlanner.ts';
import { BankMemory, type Profile } from '../src/strategy/account.ts';
import { StrategyPlanner } from '../src/strategy/StrategyPlanner.ts';
import type { PlannerContext } from '../src/planner/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const tmp = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : '/tmp';
const COMBAT_90S = parsePlan({ name: 'c', targets: { Attack: 90, Strength: 90, Defence: 90, Ranged: 90, Magic: 90, Slayer: 70 } });

function profile(levels: Record<string, number>, o: { members?: boolean; finished?: string[]; tutorial?: number; owned?: string[]; coins?: number } = {}): Profile {
  return {
    account: { members: o.members ?? true, questPoints: (o.finished ?? []).length, quests: new Map((o.finished ?? []).map((q) => [q, 'FINISHED'])), tutorial: o.tutorial },
    levels: new Map(Object.entries({ Hitpoints: 10, ...levels })),
    combatLevel: 3,
    owned: new Set(o.owned ?? []),
    coins: o.coins ?? 0,
    bankKnown: true,
  };
}

test('xp table matches OSRS (level 99 = 13,034,431 xp)', () => {
  assert.equal(xpForLevel(2), 83);
  assert.equal(xpForLevel(99), 13_034_431);
  assert.equal(levelForXp(13_034_430), 98);
  assert.equal(levelForXp(xpForLevel(50)), 50);
});

test('compiler: a fresh account does the tutorial, then XP-reward quests, then balanced training', () => {
  const r = roadmap(COMBAT_90S, freshProfile(true));
  const ids = r.milestones.map((m) => m.id);
  assert.equal(ids[0], 'tutorial');
  assert.ok(ids.slice(1, 7).every((id) => id.startsWith('quest:')), ids.slice(1, 7).join(', '));
  assert.ok(ids.includes('quest:Waterfall Quest'));
  // No skill trains more than 10 levels in one phase.
  for (const m of r.milestones.filter((x) => x.kind === 'skill')) assert.ok(/(\d+) -> (\d+)/.exec(m.text)!.slice(1).map(Number).reduce((a, b) => b - a) <= 10, m.text);
  // Every milestone after the tutorial says how it runs.
  assert.ok(r.milestones.every((m) => ['scripted', 'quest-helper+llm', 'llm'].includes(m.coverage)));
});

test('compiler: the first milestone follows the live account', () => {
  // Tutorial done, quests done, Attack far ahead: Defence is the furthest behind.
  const p = profile({ Attack: 60, Strength: 55, Defence: 20, Ranged: 50, Magic: 50, Slayer: 40 }, { tutorial: 1000, finished: ['Waterfall Quest', 'Fight Arena', 'Tree Gnome Village', 'Vampyre Slayer', 'Imp Catcher', "Witch's Potion"] });
  const m = nextMilestone(COMBAT_90S, p);
  assert.ok(m && !('done' in m));
  assert.equal(m.until?.skill, 'Defence');
  assert.equal(m.until?.level, 30);
});

test('compiler: reached plans are done; skipped methods fall through to the next viable one', () => {
  const small = parsePlan({ name: 's', targets: { Attack: 10 } });
  assert.deepEqual(nextMilestone(small, profile({ Attack: 10 }, { tutorial: 1000 })), { done: 'plan "s" reached' });

  const p = profile({ Attack: 25, Strength: 25, Defence: 25 }, { tutorial: 1000, members: true, finished: ['Waterfall Quest', 'Fight Arena', 'Tree Gnome Village', 'Vampyre Slayer'] });
  const first = nextMilestone(small.targets.Attack ? parsePlan({ name: 'a', targets: { Attack: 40 } }) : small, p);
  assert.ok(first && !('done' in first) && first.id === 'train:Attack:sand crabs (Hosidius coast)');
  const next = nextMilestone(parsePlan({ name: 'a', targets: { Attack: 40 } }), p, { skip: new Set([first.id]) });
  assert.ok(next && !('done' in next) && next.id === 'train:Attack:barbarians in Barbarian Village', JSON.stringify(next));
});

test('compiler: F2P accounts never get members methods; unreachable skills are reported', () => {
  const r = roadmap(COMBAT_90S, profile({}, { members: false, tutorial: 1000 }));
  assert.ok(!r.milestones.some((m) => /sand crabs|Waterfall|Slayer tasks/.test(m.text)));
  assert.equal(r.complete, false);
  assert.ok(r.blocked.includes('skill Slayer'));
});

test('compiler: method requirements become milestones before the method', () => {
  // Moss giants (F2P, melee 40-60) need a knife: buy it (coins first) before training.
  const plan = parsePlan({ name: 'm', targets: { Strength: 50 }, policy: { boosterQuests: false } });
  const p = profile({ Attack: 45, Strength: 45, Defence: 45 }, { members: false, tutorial: 1000 });
  const r = roadmap(plan, p, { skip: new Set(['train:Strength:hill giants (Edgeville Dungeon)', 'train:Strength:flesh crawlers (Stronghold of Security, level 2)']) });
  const ids = r.milestones.map((m) => m.id);
  const knife = ids.indexOf('acquire:Knife');
  assert.ok(knife >= 0, ids.join(', '));
  assert.ok(ids.indexOf('train:Strength:moss giants (Varrock Sewers)') > knife);
  assert.ok(ids.slice(0, knife).some((id) => id.startsWith('money:')), 'coins before buying with 0 coins');
});

test('ledger: observed XP/hour per phase replaces the estimate', () => {
  const rec = (minutes: number, xp: number, outcome: LedgerRecord['outcome'] = 'done'): LedgerRecord => ({ ts: 't', plan: 'p', phase: 'train:Attack:x', text: '', outcome, reason: '', minutes, xp: { Attack: xp }, skill: 'Attack' });
  const rates = observedRates([rec(30, 15_000), rec(30, 25_000), rec(2, 99_999), rec(60, 1, 'gave_up')]);
  assert.equal(Math.round(rates.get('train:Attack:x')!), 40_000);
});

test('tutorial: stage lookup, dialogue answers, and varp-driven actions', async () => {
  assert.equal(stageFor(0).step.kind, 'design');
  assert.equal(stageFor(45).what, 'net some shrimps');
  assert.equal(stageFor(675).step.kind, 'talk');
  assert.equal(chooseOption(['Yes, I want to be an Ironman.', 'No, I do not want to be an Ironman.']), 'No, I do not want to be an Ironman.');
  assert.equal(chooseOption(['I am brand new! This is my first time here.', 'I\'ve played in the past, but not recently.']), 'I am brand new! This is my first time here.');

  let varp = 30;
  const t = new TutorialPlanner({ varp: async () => varp });
  const ctx = (s = snapshot()): PlannerContext => ({ goal: 'g', snapshot: s, kb: null, reports: [] });
  assert.deepEqual(await t.next(ctx()), { kind: 'act', action: { op: 'tab_open', tab: 'INVENTORY' }, reason: 'open the inventory' });
  varp = 40;
  const fish = await t.next(ctx());
  assert.ok(fish.kind === 'act' && fish.action.op === 'interact' && fish.action.action === 'Net');
  const talking = snapshot();
  talking.dialogue = { inDialogue: true, hasContinue: true, hasOptions: false, options: [] };
  assert.deepEqual(await t.next(ctx(talking)), { kind: 'act', action: { op: 'dialogue_continue' }, reason: 'continue the dialogue' });
  varp = 1000;
  assert.equal((await t.next(ctx())).kind, 'complete');
});

test('tutorial: gives up after too many attempts at one stage (hands over to the rescue)', async () => {
  const t = new TutorialPlanner({ varp: async () => 30 }, { maxAttemptsPerStage: 2 });
  const ctx: PlannerContext = { goal: 'g', snapshot: snapshot(), kb: null, reports: [] };
  await t.next(ctx);
  await t.next(ctx);
  const step = await t.next(ctx);
  assert.ok(step.kind === 'impossible' && /stage 30/.test(step.reason));
});

test('acquire: fetches coins, then buys at the Grand Exchange, then completes', async () => {
  let bank: Map<string, number> | null = new Map([['Coins', 500]]);
  const a = new AcquirePlanner({ item: 'Knife', count: 1, price: 10, source: { kind: 'ge' }, bank: () => bank });
  const ctx = (s = snapshot()): PlannerContext => ({ goal: 'g', snapshot: s, kb: null, reports: [] });
  const toBank = await a.next(ctx());
  assert.ok(toBank.kind === 'subgoal' && toBank.subgoal.doneWhen?.bankOpen === true);
  const withCoins = snapshot({ inventory: { freeSlots: 26, items: [item(0, 995, 'Coins', { quantity: 100, stackable: true })] } });
  const buy = await a.next(ctx(withCoins));
  assert.ok(buy.kind === 'subgoal' && buy.subgoal.want?.[0]?.name === 'Knife' && buy.subgoal.destination?.name === 'Grand Exchange');
  bank = new Map([['Knife', 1]]);
  assert.equal((await a.next(ctx())).kind, 'complete');
  bank = new Map([['Coins', 2]]);
  assert.equal((await a.next(ctx())).kind, 'impossible');
});

test('strategy planner runs a plan: tutorial first (no bank survey on the island), then the roadmap', async () => {
  let tutorial = 40;
  const api = { varp: async (id: number) => (id === 281 ? tutorial : id === 1780 ? 30 : 0), questStates: async () => [] };
  const phases: string[] = [];
  const ends: string[] = [];
  const bank = new BankMemory(path.join(tmp, `bank-${Math.random()}.json`));
  const planner = new StrategyPlanner(
    { kind: 'plan', spec: parsePlan({ name: 'p', targets: { Attack: 20 } }) },
    {
      account: api,
      bank,
      tutorialPlanner: () => new TutorialPlanner(api),
      onPhase: (p) => phases.push(p.id),
      onPhaseEnd: (p, e) => ends.push(`${p.id}:${e.outcome}`),
    },
  );
  const ctx: PlannerContext = { goal: 'g', snapshot: snapshot(), kb: null, reports: [] };
  const first = await planner.next(ctx);
  assert.ok(first.kind === 'act' && first.action.op === 'interact', JSON.stringify(first));
  assert.deepEqual(phases, ['tutorial']);

  tutorial = 1000;
  const after = await planner.next(ctx);
  // Off the island: survey the bank before choosing the next milestone.
  assert.ok(after.kind === 'subgoal' && after.subgoal.doneWhen?.bankOpen === true);
  // Bank seen: the finished tutorial phase is closed out and training starts.
  bank.seenAt = 'test';
  const training = await planner.next(ctx);
  assert.equal(training.kind, 'subgoal');
  assert.deepEqual(ends, ['tutorial:done']);
  // Vampyre Slayer (Attack XP) comes first but needs an LLM, which this test has none of.
  assert.equal(phases[1], 'quest:Vampyre Slayer');
  assert.match(phases.at(-1)!, /^train:Attack:/);
});

test('llm report: calls per purpose, rescue success, recurring reasons', () => {
  const lines = llmReport(
    [
      { ts: 't', purpose: 'quest', tier: 1, model: 'm', schemaName: 'plan', user: 'u', result: 'ok', latencyMs: 1000 },
      { ts: 't', purpose: 'rescue', tier: 2, model: 'm', schemaName: 'plan', user: 'u', result: 'over_budget', latencyMs: 0 },
    ],
    [
      { kind: 'rescue', id: 'a', ts: 't', goal: 'g', trigger: 'stuck', reason: 'stuck: no progress for 30 steps', planner: 'kill-cows', rescuer: 'r', situation: { inventory: '', equipped: '', nearby: [], recent: [] }, proposal: { kind: 'complete', reason: '' } },
      { kind: 'outcome', id: 'a', ts: 't', result: 'done', reason: '', steps: 3 },
    ],
    [{ ts: 't', plan: 'p', phase: 'quest:X', text: '', outcome: 'gave_up', reason: '', minutes: 30, xp: {} }],
  );
  const text = lines.join('\n');
  assert.match(text, /tier 1 quest\s+1 calls/);
  assert.match(text, /stuck\s+1\s+100% done/);
  assert.match(text, /kill-cows: stuck: no progress for # steps/);
  assert.match(text, /1x\s+quest:X/);
});

test('melee training selects the attack style of the trained skill before fighting', async () => {
  const { TaskTreePlanner } = await import('../src/planner/TaskTreePlanner.ts');
  const s = snapshot();
  s.player!.attackStyle = 1;
  const ctx: PlannerContext = { goal: 'g', snapshot: s, kb: null, reports: [] };
  const defence = await TaskTreePlanner.fromPreset('kill-cows', { skill: 'Defence', setStyle: true, untilLevel: 20 }).next(ctx);
  assert.deepEqual(defence.kind === 'act' && defence.action, { op: 'attack_style', index: 3 });
  // Without setStyle (plain --task runs) the style is left alone.
  const plain = await TaskTreePlanner.fromPreset('kill-cows').next(ctx);
  assert.ok(plain.kind !== 'act' || plain.action.op !== 'attack_style');
});
