import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildKnowledgeBase, parseWikiCoordinate, parseWorldPointEnum } from '../src/kb/build.ts';
import { KnowledgeBase, tileDistance } from '../src/kb/KnowledgeBase.ts';

test('parseWikiCoordinate handles both wiki formats', () => {
  assert.deepEqual(parseWikiCoordinate('x:3202,y:3253'), { x: 3202, y: 3253 });
  assert.deepEqual(parseWikiCoordinate('1512,3423'), { x: 1512, y: 3423 });
  assert.equal(parseWikiCoordinate('somewhere'), null);
});

test('parseWorldPointEnum reads Microbot location enums', () => {
  const src = `
    AL_KHARID(new WorldPoint(3270, 3166, 0), false),
    CAM_TORUM(new WorldPoint(1453, 9568, 1), true),
    LUMBRIDGE(new WorldPoint(3210, 3217, 2)),
  `;
  assert.deepEqual(parseWorldPointEnum(src), [
    { name: 'AL_KHARID', x: 3270, y: 3166, plane: 0, members: false },
    { name: 'CAM_TORUM', x: 1453, y: 9568, plane: 1, members: true },
    { name: 'LUMBRIDGE', x: 3210, y: 3217, plane: 2, members: false },
  ]);
});

test('tileDistance is Chebyshev plus a per-floor stairs cost', () => {
  assert.equal(tileDistance({ x: 0, y: 0, plane: 0 }, { x: 3, y: 5, plane: 0 }), 5);
  assert.equal(tileDistance({ x: 0, y: 0, plane: 0 }, { x: 0, y: 3, plane: 2 }), 43);
});

test('parseRequirementCases reads conditional banks, including fall-through cases', async () => {
  const { parseRequirementCases } = await import('../src/kb/build.ts');
  const src = `
    public boolean hasRequirements() {
        switch (this) {
            case LUMBRIDGE_FRONT:
                // Requires to be in a PvP World
                return isPvp();
            case FOO:
            case BAR:
                return quest();
            default:
                return true;
        }
    }`;
  const req = parseRequirementCases(src);
  assert.equal(req.get('LUMBRIDGE_FRONT'), 'Requires to be in a PvP World');
  assert.equal(req.get('FOO'), 'conditional');
  assert.equal(req.get('BAR'), 'conditional');
  assert.equal(req.has('LUMBRIDGE_TOP'), false);
});

function fixtureKb(): KnowledgeBase {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-'));
  const raw = path.join(dir, 'raw');
  mkdirSync(raw);
  const jsonl = (file: string, rows: unknown[]) => writeFileSync(path.join(raw, file), rows.map((r) => JSON.stringify(r)).join('\n'));
  jsonl('items.jsonl', [{ id: 303, name: 'Small fishing net', stackable: false, noted: false, inventoryActions: ['Drop'], groundActions: ['Take'] }]);
  jsonl('npcs.jsonl', [{ id: 1530, name: 'Fishing spot', combatLevel: 0, size: 1, actions: ['Small Net', 'Bait'] }]);
  jsonl('objects.jsonl', [
    { id: 11364, name: 'Iron rocks', sizeX: 1, sizeY: 1, actions: ['Mine'] },
    { id: 900, sizeX: 1, sizeY: 1, actions: [], transforms: [-1, 11364] },
  ]);
  jsonl('locations.jsonl', [[11364, 3285, 3368, 0, 10, 0], [900, 3300, 3300, 0, 10, 0]]);
  jsonl('map_elements.jsonl', [{ name: 'Varrock', x: 3211, y: 3450, plane: 0, members: false }]);
  jsonl('wiki_locline.jsonl', [{ page_name: 'Goblin', coordinates: ['x:3242,y:3242', '3246,3235'], plane: 0 }]);
  jsonl('wiki_infobox_npc.jsonl', [{ page_name: 'Goblin', npc_id: ['3029'] }]);
  const out = path.join(dir, 'kb.sqlite');
  buildKnowledgeBase(raw, out);
  assert.ok(existsSync(out));
  return new KnowledgeBase(out);
}

test('knowledge base resolves places, placements, spawns and multi-loc names', () => {
  const kb = fixtureKb();
  const from = { x: 3290, y: 3370, plane: 0 };
  assert.equal(kb.findPlaces('varrock')[0]?.name, 'Varrock');
  const rocks = kb.nearestObjects('Iron rocks', from, { action: 'mine' });
  assert.equal(rocks.length, 2, 'unnamed multi-loc resolves to its named transform');
  assert.deepEqual(rocks[0]?.point, { x: 3285, y: 3368, plane: 0 });
  assert.equal(kb.nearestSpawns('goblin', from).length, 2);
  assert.ok(kb.nearestBanks(from).length > 0, 'Microbot BankLocation enum is imported');
  const nearFerox = { x: 3134, y: 3600, plane: 0 };
  assert.ok(kb.nearestBanks(nearFerox, 5).every((b) => !/ferox/i.test(b.name)), 'no Wilderness banks');
  kb.close();
});

test('unmetRequirements reports missing level and tool', () => {
  const kb = fixtureKb();
  const rule = kb.resourceFor('object', 'Iron rocks', 'Mine')!;
  const unmet = kb.unmetRequirements(rule, {
    skills: [{ name: 'Mining', level: 10, boosted: 10, xp: 1200 }],
    inventory: [],
    equipment: [],
  });
  assert.deepEqual(unmet, ['Mining 15', 'pickaxe']);
  const met = kb.unmetRequirements(rule, {
    skills: [{ name: 'Mining', level: 20, boosted: 20, xp: 5000 }],
    inventory: [],
    equipment: [{ slot: 'WEAPON', id: 1275, name: 'Rune pickaxe' }],
  });
  assert.deepEqual(met, []);
  kb.close();
});
