import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityNeeds } from '../src/prereq/needs.ts';
import { PrereqPlanner } from '../src/prereq/PrereqPlanner.ts';
import { resolveSetup, type AccountView } from '../src/prereq/resolve.ts';
import type { Planner, PlanStep } from '../src/planner/types.ts';
import { BankMemory, type Profile } from '../src/strategy/account.ts';
import { item, snapshot } from './support/fixtures.ts';

function view(o: { levels?: Record<string, number>; counts?: Record<string, number>; coins?: number; members?: boolean } = {}): AccountView {
  const counts = new Map(Object.entries(o.counts ?? {}));
  if (o.coins) counts.set('Coins', o.coins);
  const levels = new Map(Object.entries({ Attack: 30, Strength: 30, Defence: 25, Hitpoints: 34, Ranged: 10, Magic: 10, Fishing: 20, Cooking: 20, Woodcutting: 20, Mining: 10, ...o.levels }));
  const profile: Profile = {
    account: { members: o.members ?? false, questPoints: 5, quests: new Map(), tutorial: 1000 },
    levels,
    combatLevel: 40,
    owned: new Set(counts.keys()),
    coins: o.coins ?? 0,
    bankKnown: true,
  };
  return { profile, counts };
}

const shop = (item: string) => {
  const prices: Record<string, number> = { 'Bronze chainbody': 60, 'Iron chainbody': 210, 'Steel chainbody': 750, 'Bronze platelegs': 80, 'Bronze full helm': 44, 'Bronze kiteshield': 68 };
  return prices[item] ? { source: { kind: 'shop' as const, name: 'Test shop', keeper: 'Keeper', point: { x: 3200, y: 3200, plane: 0 } }, price: prices[item]! } : null;
};
const ids = (steps: { phase: { id: string } }[]) => steps.map((s) => s.phase.id);
const fullMelee = { 'Iron scimitar': 1, 'Bronze full helm': 1, 'Bronze platelegs': 1, 'Bronze kiteshield': 1 };

test('prereq: a broke account without body armour earns coins, sells, then buys a chainbody', () => {
  const needs = activityNeeds({ kind: 'preset', preset: 'kill-barbarians' })!;
  const setup = resolveSetup(needs, view({ counts: { ...fullMelee, Shrimps: 10 }, coins: 2 }), { shop });
  assert.deepEqual(setup.blocked, []);
  assert.deepEqual(ids(setup.steps), ['money:cowhides', 'sell:cowhides', 'acquire:Bronze chainbody']);
  assert.ok(setup.minutes <= 30, `~${setup.minutes} min`);
});

test('prereq: an empty gear slot gets the cheapest piece, even with coins', () => {
  const needs = activityNeeds({ kind: 'preset', preset: 'kill-barbarians' })!;
  const setup = resolveSetup(needs, view({ counts: { ...fullMelee, Shrimps: 10 }, coins: 1000 }), { shop });
  assert.deepEqual(ids(setup.steps), ['acquire:Bronze chainbody'], 'the cheapest piece fills an empty slot; better ones are smithed');
});

test('prereq: gear is never bought as an upgrade; coins are kept for making money', () => {
  const needs = activityNeeds({ kind: 'preset', preset: 'kill-barbarians' })!;
  const ge = (item: string) => ({ 'Rune scimitar': 15_000, 'Mithril platebody': 3_000 } as Record<string, number>)[item] ?? null;
  const geared = { ...fullMelee, 'Bronze chainbody': 1, Shrimps: 10 };
  assert.deepEqual(ids(resolveSetup(needs, view({ levels: { Attack: 40, Defence: 28 }, counts: geared, coins: 55_000 }), { shop, gePrice: ge }).steps), []);
});

test('prereq: met needs give an empty setup', () => {
  const needs = activityNeeds({ kind: 'preset', preset: 'kill-barbarians' })!;
  const setup = resolveSetup(needs, view({ counts: { ...fullMelee, 'Bronze chainbody': 1, Shrimps: 10 } }), { shop });
  assert.deepEqual(setup.steps, []);
});

test('prereq: no food for a dangerous fight means fishing and cooking shrimp first', () => {
  const needs = activityNeeds({ kind: 'preset', preset: 'kill-barbarians' })!;
  const setup = resolveSetup(needs, view({ counts: { ...fullMelee, 'Bronze chainbody': 1, 'Small fishing net': 1, 'Bronze axe': 1, Tinderbox: 1 } }), { shop });
  assert.deepEqual(ids(setup.steps), ['food:fish-shrimp', 'food:cook-shrimps']);
});

test('prereq: a missing tool is bought (coins earned first when short)', () => {
  const chop = activityNeeds({ kind: 'preset', preset: 'chop-trees', bank: true })!;
  assert.deepEqual(ids(resolveSetup(chop, view({ coins: 100 })).steps), ['acquire:Bronze axe']);
  assert.deepEqual(ids(resolveSetup(chop, view({ coins: 0 })).steps), ['money:cowhides', 'sell:cowhides', 'acquire:Bronze axe']);
});

test('prereq: a level requirement becomes a training phase, with that phase\'s own tool', () => {
  const oaks = activityNeeds({ kind: 'preset', preset: 'chop-oaks', bank: true })!;
  const setup = resolveSetup(oaks, view({ levels: { Woodcutting: 8 }, coins: 100 }));
  assert.deepEqual(ids(setup.steps)[0], 'acquire:Bronze axe');
  assert.ok(setup.steps.some((s) => s.phase.until?.skill === 'Woodcutting' && s.phase.until.level === 15), JSON.stringify(ids(setup.steps)));
});

test('prereq: a ranged kit with no coins needs a money run', () => {
  const range = activityNeeds({ kind: 'preset', preset: 'range-cows' })!;
  const setup = resolveSetup(range, view({ counts: { 'Bronze full helm': 1, 'Bronze chainbody': 1, 'Bronze platelegs': 1 }, coins: 2 }), { shop });
  assert.deepEqual(ids(setup.steps).slice(0, 2), ['money:cowhides', 'sell:cowhides']);
});

class Inner implements Planner {
  readonly name = 'inner';
  calls = 0;
  async next(): Promise<PlanStep> {
    this.calls++;
    return { kind: 'complete', reason: 'activity done' };
  }
}

const account = { varp: async () => 0, questStates: async () => [] };

function memory(items: [string, number][]): BankMemory {
  const b = new BankMemory('/nonexistent/bank-seen.json');
  b.items = new Map(items);
  b.seenAt = new Date().toISOString();
  return b;
}

test('prereq planner: setup longer than the budget skips the activity with the plan as the reason', async () => {
  const inner = new Inner();
  const needs = activityNeeds({ kind: 'preset', preset: 'chop-willows', bank: true })!;
  const s = snapshot();
  s.skills = [{ name: 'Woodcutting', level: 1, boosted: 1, xp: 0 }] as never;
  const p = new PrereqPlanner(inner, needs, { account, bank: memory([['Bronze axe', 1]]), budgetMinutes: 30 });
  const step = await p.next({ goal: 'x', snapshot: s, kb: null, reports: [] });
  assert.ok(step.kind === 'impossible' && /setup for chop-willows takes ~\d+ min \(budget 30\): train Woodcutting/.test(step.reason), JSON.stringify(step));
  assert.equal(inner.calls, 0);
});

test('prereq planner: met prerequisites hand over to the activity', async () => {
  const inner = new Inner();
  const needs = activityNeeds({ kind: 'preset', preset: 'chop-trees', bank: true })!;
  const s = snapshot({ inventory: { freeSlots: 27, items: [item(0, 1351, 'Bronze axe')] } });
  const p = new PrereqPlanner(inner, needs, { account, bank: memory([['Logs', 3]]) });
  const step = await p.next({ goal: 'x', snapshot: s, kb: null, reports: [] });
  assert.equal(step.kind, 'complete');
  assert.equal(inner.calls, 1);
});

test('prereq planner: an unseen bank is surveyed first', async () => {
  const needs = activityNeeds({ kind: 'preset', preset: 'chop-trees', bank: true })!;
  const p = new PrereqPlanner(new Inner(), needs, { account, bank: new BankMemory('/nonexistent/bank-seen.json') });
  const step = await p.next({ goal: 'x', snapshot: snapshot(), kb: null, reports: [] });
  assert.ok(step.kind === 'subgoal' && /to see what the account owns/.test(step.subgoal.text));
});

test('loadout: every non-combat activity wants gear, softly; owned gear is wielded, banked upgrades fetched', async () => {
  const quest = activityNeeds({ kind: 'quest', quest: "Cook's Assistant" })!;
  assert.ok(quest.gear?.soft && quest.gear.slots.includes('weapon'));
  assert.ok(activityNeeds({ kind: 'llm', goal: 'pickpocket men' })?.gear?.soft, 'llm phases get a loadout too');
  assert.equal(activityNeeds({ kind: 'sell', items: ['Cowhide'] }), null, 'selling starts without a loadout');

  // Soft: a poor account is neither blocked nor sent to earn coins for armour.
  const poor = resolveSetup(quest, view({ counts: { Shrimps: 1 }, coins: 5 }), { shop, earnCoins: false });
  assert.deepEqual(poor.blocked, []);
  assert.deepEqual(ids(poor.steps), []);
  // Affordable pieces are bought.
  const rich = resolveSetup(quest, view({ counts: { Shrimps: 1 }, coins: 5000 }), { shop });
  assert.ok(ids(rich.steps).includes('acquire:Bronze full helm'));

  const { nextLoadoutStep } = await import('../src/prereq/loadout.ts');
  const carried = snapshot({ inventory: { freeSlots: 26, items: [item(0, 1323, 'Iron scimitar')] } });
  const wield = nextLoadoutStep(carried, [], null);
  assert.ok(wield?.kind === 'subgoal' && /wield the Iron scimitar/.test(wield.subgoal.text));
  assert.equal(nextLoadoutStep(snapshot(), [], null), null, 'nothing to wear: done');
});

test('no-drop: materials are banked, never offered for dropping; quests start with materials banked', async () => {
  const { isDroppable, isMaterial } = await import('../src/engine/drops.ts');
  assert.ok(!isDroppable('Harralander potion (unf)') && !isDroppable('Oak logs') && !isDroppable('Raw shrimps'));
  assert.ok(isDroppable('Burnt shrimp') && isDroppable('Ashes'));
  assert.ok(isMaterial('Harralander potion (unf)') && !isMaterial('Wool') && !isMaterial('Shears'));

  const { nextLoadoutStep } = await import('../src/prereq/loadout.ts');
  const carrying = snapshot({ inventory: { freeSlots: 20, items: [item(0, 97, 'Harralander potion (unf)'), item(1, 1735, 'Shears'), item(2, 1737, 'Wool')] }, bank: { open: true, items: [] } });
  const step = nextLoadoutStep(carrying, [], null, { bankMaterials: true });
  assert.ok(step?.kind === 'subgoal' && /deposit the Harralander potion \(unf\)/.test(step.subgoal.text) && !step.subgoal.targets?.includes('Wool'));
  assert.equal(nextLoadoutStep(carrying, [], null)?.kind === 'subgoal' && /deposit/.test((nextLoadoutStep(carrying, [], null) as { subgoal: { text: string } }).subgoal.text), false, 'materials are only banked when asked');
});
