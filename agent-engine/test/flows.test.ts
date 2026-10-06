import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chooseOption, FlowPlanner, FLOWS, flowStatus, optionNeeds } from '../src/flows/FlowPlanner.ts';
import type { AccountView } from '../src/prereq/resolve.ts';
import { BankMemory, type Profile } from '../src/strategy/account.ts';
import { snapshot } from './support/fixtures.ts';

const tmp = process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : '/tmp';

function view(levels: Record<string, number>, counts: Record<string, number>, combatLevel = 43): AccountView {
  const c = new Map(Object.entries(counts));
  const profile: Profile = {
    account: { members: false, questPoints: 13, quests: new Map(), tutorial: 1000 } as never,
    levels: new Map(Object.entries({ Attack: 40, Strength: 33, Defence: 30, Hitpoints: 36, Mining: 36, Smithing: 27, Woodcutting: 35, Fishing: 31, ...levels })),
    combatLevel,
    owned: new Set(c.keys()),
    coins: counts.Coins ?? 0,
    bankKnown: true,
  };
  return { profile, counts: c };
}
const gear = { 'Iron scimitar': 1, 'Bronze full helm': 1, 'Bronze chainbody': 1, 'Bronze platelegs': 1, 'Bronze kiteshield': 1, Trout: 20, Hammer: 1, 'Bronze pickaxe': 1 };
const optionSetup = (st: ReturnType<typeof flowStatus>, id: string) => st.find((x) => x.option.id === id)!.setup;

test('flows: each gold option lists the sub-flows its requirements trigger, and nothing unrelated', () => {
  const st = flowStatus(FLOWS.gold!, view({}, { ...gear, Coins: 50_000 }), { members: false });
  assert.deepEqual(optionSetup(st, 'tan-hides').steps, [], 'coins in hand: ready');
  const smelt = optionSetup(st, 'smelt-steel');
  assert.deepEqual(smelt.steps.map((s) => s.phase.until), [{ skill: 'Smithing', level: 30 }], 'Smithing 27 -> 30 first');
  const moss = optionSetup(st, 'moss-giants');
  assert.ok(moss.steps.every((s) => s.phase.exec.kind !== 'llm'), 'levelled with scripted methods, never the Stronghold');
  assert.deepEqual(moss.steps.map((s) => s.phase.until?.skill), ['Strength', 'Defence']);
  assert.ok(st.every((x) => x.setup.steps.every((s) => !s.phase.id.startsWith('money:'))), 'no money route detours');
});

test('flows: a coin shortfall blocks the option instead of earning coins elsewhere', () => {
  const gePrice = (item: string) => (/scimitar|chainbody|platelegs|kiteshield|sq shield|sword|platebody/i.test(item) ? 500 : null);
  const needsCoins = flowStatus(FLOWS.gold!, view({}, { 'Bronze full helm': 1, Trout: 20 }), { members: false, gePrice });
  const cows = optionSetup(needsCoins, 'cowhides');
  assert.deepEqual(cows.steps, [], 'harmless cows need no gear');
  const guards = optionSetup(needsCoins, 'guard-coins');
  assert.ok(guards.blocked.some((b) => /not earned inside this flow/.test(b)), JSON.stringify(guards));
});

test('flows: a goal run takes the best option that can be set up', () => {
  const st = flowStatus(FLOWS.gold!, view({}, { ...gear, Coins: 50_000 }), { members: false });
  assert.equal(chooseOption(st, new Set())?.id, 'tan-hides');
  assert.equal(chooseOption(st, new Set(['flow:gold:tan-hides']))?.id, 'moss-giants', 'next by gp/h; sub-flows allowed');
  assert.equal(optionNeeds(FLOWS.gold!.options.find((o) => o.id === 'moss-giants')!).req.skills?.Defence, 35, 'recommended levels become requirements');
});

test('flow planner: an unknown option, and strict prerequisites for a named one', async () => {
  const bank = new BankMemory(path.join(tmp, `bank-${Math.random()}.json`));
  bank.seenAt = 'test';
  const api = { varp: async () => 0, questStates: async () => [] };
  const deps = { view: async () => view({}, {}), members: async () => false, strategy: { account: api, bank }, prereq: { account: api, bank } };
  const ctx = { goal: 'x', snapshot: snapshot(), kb: null, reports: [] };
  const bad = await new FlowPlanner(FLOWS.gold!, 'nope', deps).next(ctx);
  assert.ok(bad.kind === 'impossible' && /has no option "nope"/.test(bad.reason));
});
