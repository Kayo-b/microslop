import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextKitStep, planKit } from '../src/planner/kit.ts';
import { nextCombatStep, COMBAT_PRESETS } from '../src/planner/TaskTreePlanner.ts';
import type { Snapshot } from '../src/types.ts';
import { item, snapshot } from './support/fixtures.ts';

const bank = { name: 'Varrock West bank', point: { x: 3185, y: 3436, plane: 0 } };

function char(extra: Partial<Snapshot> = {}): Snapshot {
  const s = snapshot({ groundItems: [], ...extra });
  s.skills = [
    { name: 'Attack', level: 32, boosted: 32, xp: 0 },
    { name: 'Defence', level: 24, boosted: 24, xp: 0 },
    { name: 'Ranged', level: 3, boosted: 3, xp: 0 },
    { name: 'Magic', level: 1, boosted: 1, xp: 0 },
  ] as never;
  s.player!.hp = { current: 31, max: 31 };
  return s;
}

test('kit: ranged buys a shortbow and arrows within the coins owned', () => {
  const s = char({ inventory: { freeSlots: 27, items: [item(0, 995, 'Coins', { quantity: 203, stackable: true })] } });
  const kit = planKit('ranged', s, { bank: new Map([['Coins', 100]]) });
  assert.deepEqual(kit.buy.map((b) => [b.name, b.count]), [['Shortbow', 1], ['Bronze arrow', 183]]);
  assert.equal(kit.cost, 233, 'sized to the coins owned less a 30% price margin');

  // Coins partly banked: fetch them first; then shop at Lowe's.
  const fetch = nextKitStep('ranged', s, { bank: new Map([['Coins', 100]]) }, bank);
  assert.ok(fetch?.kind === 'subgoal' && /get 233 coins/.test(fetch.subgoal.text));
  const rich = char({ inventory: { freeSlots: 27, items: [item(0, 995, 'Coins', { quantity: 1000, stackable: true })] } });
  const shop = nextKitStep('ranged', rich, { bank: new Map() }, bank);
  assert.ok(shop?.kind === 'subgoal' && shop.subgoal.targets?.[0] === 'Lowe' && shop.subgoal.doneWhen?.shopOpen, JSON.stringify(shop));
});

test('kit: magic wields the staff, then sets Wind Strike autocast', () => {
  const runes = [item(1, 556, 'Air rune', { quantity: 200, stackable: true }), item(2, 558, 'Mind rune', { quantity: 200, stackable: true })];
  const s = char({ inventory: { freeSlots: 25, items: [item(0, 1379, 'Staff', { actions: ['Wield', 'Drop'] }), ...runes] }, equipment: [{ slot: 'WEAPON', id: 1323, name: 'Iron scimitar' }] });
  const wield = nextKitStep('magic', s, { bank: new Map() }, bank);
  assert.ok(wield?.kind === 'subgoal' && /wield the Staff/.test(wield.subgoal.text), JSON.stringify(wield));

  const armed = char({ inventory: { freeSlots: 26, items: runes }, equipment: [{ slot: 'WEAPON', id: 1379, name: 'Staff' }] });
  const cast = nextKitStep('magic', armed, { bank: new Map() }, bank);
  assert.ok(cast?.kind === 'act' && cast.action.op === 'autocast' && cast.action.spell === 'WIND_STRIKE');
  armed.player!.autocast = 'WIND_STRIKE';
  assert.equal(nextKitStep('magic', armed, { bank: new Map() }, bank), null);
});

test('kit: the combat planner does not swap the bow back for a scimitar, and restocks arrows into the quiver', () => {
  const s = char({
    inventory: { freeSlots: 25, items: [item(0, 1323, 'Iron scimitar', { actions: ['Wield'] }), item(1, 882, 'Bronze arrow', { quantity: 25, stackable: true })] },
    equipment: [{ slot: 'WEAPON', id: 841, name: 'Shortbow' }, { slot: 'AMMO', id: 882, name: 'Bronze arrow', quantity: 200 }],
  });
  const step = nextCombatStep(COMBAT_PRESETS['range-cows']!, s, { bankItems: [], bankCounts: new Map() });
  assert.ok(step.kind === 'subgoal' && /wield the Bronze arrow/.test(step.subgoal.text), JSON.stringify(step));
  s.inventory.items.pop();
  const fight = nextCombatStep(COMBAT_PRESETS['range-cows']!, s, { bankItems: [], bankCounts: new Map() });
  assert.ok(fight.kind === 'subgoal' && /attack|walk to/.test(fight.subgoal.text), JSON.stringify(fight));
});

test('kit: an empty quiver ends the fight and the next step re-equips the carried arrows', () => {
  const s = char({
    npcs: [{ index: 5, id: 2790, name: 'Cow', combatLevel: 2, actions: ['Attack'], position: { x: 3257, y: 3265, plane: 0 }, distance: 3, healthRatio: -1, healthScale: -1, interactingWithPlayer: false, animation: -1, reachable: true, pathDistance: 3 }] as never,
    inventory: { freeSlots: 27, items: [item(0, 882, 'Bronze arrow', { quantity: 10, stackable: true, actions: ['Wield', 'Drop'] })] },
    equipment: [{ slot: 'WEAPON', id: 841, name: 'Shortbow' }, { slot: 'AMMO', id: 882, name: 'Bronze arrow', quantity: 60 }],
  });
  const fight = nextCombatStep(COMBAT_PRESETS['range-cows']!, s, { bankItems: [], bankCounts: new Map() });
  assert.ok(fight.kind === 'subgoal' && /attack/.test(fight.subgoal.text));
  assert.equal(fight.subgoal.isDone!(s), false);
  s.equipment = s.equipment.filter((e) => e.slot !== 'AMMO');
  assert.equal(fight.subgoal.isDone!(s), true, 'quiver empty');
  const next = nextCombatStep(COMBAT_PRESETS['range-cows']!, s, { bankItems: [], bankCounts: new Map() });
  assert.ok(next.kind === 'subgoal' && /wield the Bronze arrow/.test(next.subgoal.text), JSON.stringify(next));
});
