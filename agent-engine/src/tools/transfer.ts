/**
 * Moves coins from one of the account's characters to the other with a normal trade at the Grand
 * Exchange (Jagex allows trading between your own characters; no drop or trust trades). Both
 * clients must be logged in on the same world; their campaigns must be stopped first.
 *
 *   npm run agent -- transfer --from-port 8081 --from-name <char1-name> \
 *     --to-port 8082 --to-name <char2-name> --to-token ~/.microbot-char2-home/.runelite/.agent-token \
 *     --keep-coins 50000
 *
 * Steps: both walk to the GE; the giver withdraws all its coins but --keep-coins; giver and receiver
 * trade each other; the giver offers all its coins; both accept both screens; the receiver's
 * coins are checked.
 */
import { MicrobotBackend } from '../backend/MicrobotBackend.ts';
import type { GameAction, Snapshot } from '../types.ts';

const MEET = { x: 3165, y: 3485, plane: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const coins = (s: Snapshot) => s.inventory.items.filter((i) => i.name === 'Coins').reduce((n, i) => n + i.quantity, 0);

export interface Side {
  name: string;
  backend: MicrobotBackend;
}

async function until(b: MicrobotBackend, test: (s: Snapshot) => boolean, timeoutMs: number, what: string): Promise<Snapshot> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const s = await b.snapshot();
    if (test(s)) return s;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}

async function act(side: Side, action: GameAction, what: string): Promise<void> {
  const r = await side.backend.act(action);
  if (!r.success) throw new Error(`${side.name}: ${what} failed (${r.reason ?? 'unknown'})`);
}

export async function transferCoins(from: Side, to: Side, keep: number, log: (m: string) => void): Promise<number> {
  for (const side of [from, to]) {
    const s = await side.backend.snapshot();
    if (!s.loggedIn) throw new Error(`${side.name} is not logged in`);
    const p = s.player?.position;
    if (!p || Math.max(Math.abs(p.x - MEET.x), Math.abs(p.y - MEET.y)) > 6) {
      log(`${side.name}: walking to the Grand Exchange`);
      await act(side, { op: 'walk', to: MEET, distance: 4 }, 'walk');
    }
  }
  for (const side of [from, to]) {
    await until(side.backend, (s) => !!s.player && Math.max(Math.abs(s.player.position.x - MEET.x), Math.abs(s.player.position.y - MEET.y)) <= 6 && !s.walk.active, 300_000, `${side.name} at the GE`);
  }

  // Giver: everything but `keep` into the inventory.
  await act(from, { op: 'bank_open' }, 'open the bank');
  const bank = await until(from.backend, (s) => s.bank.open, 20_000, 'the bank');
  const stack = bank.bank.items.find((b) => b.name === 'Coins');
  const carried = coins(bank);
  const banked = stack?.quantity ?? 0;
  const give = carried + banked - keep;
  if (give <= 0) throw new Error(`${from.name} has ${carried + banked} coins, nothing above the ${keep} kept`);
  const withdraw = give - carried;
  if (withdraw > 0) await act(from, { op: 'bank_withdraw', itemId: stack!.id, amount: withdraw }, 'withdraw coins');
  if (withdraw < 0) await act(from, { op: 'bank_deposit', itemId: 995, amount: -withdraw }, 'deposit the coins kept');
  await until(from.backend, (s) => coins(s) === give, 10_000, `${give} coins carried`);
  await act(from, { op: 'bank_close' }, 'close the bank');
  log(`${from.name}: carrying ${give} coins to give`);
  const before = coins(await to.backend.snapshot());

  // Trade each other: the receiver trading back accepts the request.
  await act(from, { op: 'trade_player', name: to.name }, 'trade request');
  await sleep(2500);
  await act(to, { op: 'trade_player', name: from.name }, 'trade back');
  for (const side of [from, to]) await until(side.backend, (s) => s.trade?.stage === 'offer', 20_000, `${side.name} trade screen`);

  await act(from, { op: 'trade_offer', name: 'Coins', option: 'Offer-All' }, 'offer the coins');
  await until(to.backend, (s) => (s.trade?.theirs?.length ?? 0) > 0, 15_000, 'the offer on the receiving side');
  await sleep(1500);
  for (const side of [from, to]) await act(side, { op: 'trade_accept' }, 'accept');
  for (const side of [from, to]) await until(side.backend, (s) => s.trade?.stage === 'confirm' || !s.trade?.open, 20_000, `${side.name} confirm screen`);
  await sleep(1500);
  for (const side of [from, to]) {
    const s = await side.backend.snapshot();
    if (s.trade?.stage === 'confirm') await act(side, { op: 'trade_accept' }, 'confirm');
  }
  const after = await until(to.backend, (s) => !s.trade?.open && coins(s) > before, 20_000, 'the coins to arrive');
  const received = coins(after) - before;
  log(`${to.name}: received ${received} coins`);
  return received;
}
