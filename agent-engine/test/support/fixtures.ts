import type { Snapshot, SnapshotNpc, SnapshotObject, InventoryItem } from '../../src/types.ts';
import { normalizeSnapshot } from '../../src/backend/MicrobotBackend.ts';

export const LUMBRIDGE_SWAMP = { x: 3243, y: 3152, plane: 0 };

export function fishingSpot(overrides: Partial<SnapshotNpc> = {}): SnapshotNpc {
  return {
    index: 1530,
    id: 1530,
    name: 'Fishing spot',
    combatLevel: 0,
    actions: ['Small Net', 'Bait'],
    position: { x: 3245, y: 3152, plane: 0 },
    distance: 2,
    healthRatio: -1,
    healthScale: -1,
    interactingWithPlayer: false,
    animation: -1,
    reachable: true,
    pathDistance: 1,
    ...overrides,
  };
}

export function goblin(overrides: Partial<SnapshotNpc> = {}): SnapshotNpc {
  return {
    index: 77,
    id: 3029,
    name: 'Goblin',
    combatLevel: 2,
    actions: ['Attack'],
    position: { x: 3249, y: 3155, plane: 0 },
    distance: 6,
    healthRatio: -1,
    healthScale: -1,
    interactingWithPlayer: false,
    animation: -1,
    reachable: true,
    pathDistance: 6,
    ...overrides,
  };
}

export function tree(overrides: Partial<SnapshotObject> = {}): SnapshotObject {
  return {
    id: 1276,
    name: 'Tree',
    type: 'GAME',
    actions: ['Chop down'],
    position: { x: 3240, y: 3150, plane: 0 },
    distance: 3,
    reachable: true,
    pathDistance: 2,
    ...overrides,
  };
}

export function item(slot: number, id: number, name: string, extra: Partial<InventoryItem> = {}): InventoryItem {
  return { slot, id, name, quantity: 1, noted: false, stackable: false, actions: ['Drop'], ...extra };
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const base = normalizeSnapshot({
    tick: 100,
    loggedIn: true,
    gameState: 'LOGGED_IN',
    player: {
      name: 'Tester',
      combatLevel: 3,
      position: { ...LUMBRIDGE_SWAMP },
      hp: { current: 10, max: 10 },
      prayer: { current: 1, max: 1 },
      runEnergy: 100,
      runEnabled: true,
      specialAttack: 100,
      animation: -1,
      animating: false,
      moving: false,
      inCombat: false,
      interacting: null,
    },
    skills: [
      { name: 'Hitpoints', level: 10, boosted: 10, xp: 1154 },
      { name: 'Fishing', level: 1, boosted: 1, xp: 0 },
      { name: 'Woodcutting', level: 1, boosted: 1, xp: 0 },
    ],
    inventory: { freeSlots: 27, items: [item(0, 303, 'Small fishing net')] },
    npcs: [fishingSpot(), goblin()],
    objects: [tree()],
  });
  return { ...base, ...overrides };
}
