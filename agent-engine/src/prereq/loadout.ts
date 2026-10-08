/**
 * Wear what the account owns before an activity starts: wield carried gear that beats what is
 * worn, fetch better gear from the bank, close the bank. Combat tasks do the same in their own
 * readiness check; this covers every other activity (quests, skilling, trading loops).
 */
import type { KnowledgeBase } from '../kb/KnowledgeBase.ts';
import { upgradesFrom } from '../planner/gear.ts';
import { goal, NOT_BANKS } from '../planner/TaskTreePlanner.ts';
import type { PlanStep } from '../planner/types.ts';
import type { Snapshot } from '../types.ts';

/** The next step towards wearing the best usable gear, or null when nothing is left to equip. */
export function nextLoadoutStep(s: Snapshot, bankNames: string[], kb: KnowledgeBase | null): PlanStep | null {
  if (!s.loggedIn || s.player?.inCombat) return null;
  const inv = s.inventory.items.map((i) => i.name);
  const keep = [...inv];

  const wield = upgradesFrom(s, inv)[0];
  if (wield) return { kind: 'subgoal', subgoal: goal(`wield the ${wield.name} (${wield.slot})`, [wield.name], ['Wield', 'Wear'], { equipped: [wield.name] }, 10, keep) };

  const fetch = upgradesFrom(s, bankNames).filter((u) => !inv.includes(u.name));
  if (fetch.length) {
    const names = fetch.map((u) => u.name);
    if (s.bank.open) {
      return { kind: 'subgoal', subgoal: { ...goal(`withdraw ${names.join(', ')} to wear`, names, ['Withdraw'], { hasItems: names.map((name) => ({ name, count: 1 })) }, 20, [...keep, ...names]), want: names.map((name) => ({ name, count: 1 })) } };
    }
    const pos = s.player?.position;
    const bank = pos && kb ? kb.nearestBanks(pos, 3, false).find((b) => b.kind === 'bank') : undefined;
    if (!bank) return null;
    return { kind: 'subgoal', subgoal: { ...goal(`get better gear (${fetch.map((u) => u.slot).join(', ')}) at the ${bank.name}`, ['Bank booth', 'Banker'], ['Bank'], { bankOpen: true }, 300, keep), destination: { name: bank.name, point: bank.point }, avoid: NOT_BANKS } };
  }
  if (s.bank.open) return { kind: 'subgoal', subgoal: goal('close the bank', ['Bank'], ['Close'], { bankOpen: false }, 5, keep) };
  return null;
}
