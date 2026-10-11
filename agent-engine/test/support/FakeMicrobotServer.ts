/**
 * A tiny HTTP stand-in for the Microbot agent server: GET /snapshot and POST /act with the same
 * token check, backed by a toy simulation (fishing, chopping, banking, walking, eating). Each
 * /snapshot call advances the game one tick, so engine loops progress without real time.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Snapshot } from '../../src/types.ts';
import { item, snapshot } from './fixtures.ts';

export interface FakeGameOptions {
  initial?: Snapshot;
  /** Ticks an interaction animates before producing its item. */
  actionTicks?: number;
}

export class FakeGame {
  state: Snapshot;
  readonly acts: Record<string, unknown>[] = [];
  private busyUntil = -1;
  private pending: (() => void) | null = null;
  private walkArrive = -1;
  private walkTo: { x: number; y: number; plane: number } | null = null;
  private readonly actionTicks: number;

  constructor(opts: FakeGameOptions = {}) {
    this.state = structuredClone(opts.initial ?? snapshot());
    this.actionTicks = opts.actionTicks ?? 2;
  }

  tick(): void {
    const s = this.state;
    s.tick++;
    const p = s.player!;
    if (this.busyUntil >= 0 && s.tick >= this.busyUntil) {
      this.pending?.();
      this.pending = null;
      this.busyUntil = -1;
      p.animating = false;
      p.animation = -1;
      p.interacting = null;
    }
    if (this.walkTo && s.tick >= this.walkArrive) {
      p.position = { ...this.walkTo };
      this.walkTo = null;
      s.walk = { active: false };
      p.moving = false;
    }
  }

  private message(text: string) {
    this.state.messages.push({ tick: this.state.tick, type: 'GAMEMESSAGE', text });
  }

  private addItem(id: number, name: string) {
    const inv = this.state.inventory;
    if (inv.freeSlots === 0) {
      this.message("You can't carry any more.");
      return;
    }
    const used = new Set(inv.items.map((i) => i.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    inv.items.push(item(slot, id, name));
    inv.freeSlots--;
  }

  act(body: Record<string, unknown>): { success: boolean; reason?: string } {
    this.acts.push(body);
    const s = this.state;
    const p = s.player!;
    switch (body.op) {
      case 'interact': {
        const target = body.target as Record<string, unknown>;
        const action = body.action as string;
        if (target.kind === 'npc') {
          const npc = s.npcs.find((n) => n.index === target.index);
          if (!npc) return { success: false, reason: 'target_not_found' };
          if (npc.name === 'Fishing spot' && action === 'Small Net') {
            if (!s.inventory.items.some((i) => i.name === 'Small fishing net')) {
              this.message('You need a net to catch these fish.');
              return { success: true };
            }
            this.startBusy(() => this.addItem(317, 'Raw shrimps'));
            p.interacting = { type: 'npc', name: npc.name, index: npc.index };
            return { success: true };
          }
          if (npc.name === 'Fishing spot' && action === 'Bait') {
            this.message('You need a Fishing rod to bait these fish.');
            return { success: true };
          }
          return { success: true };
        }
        if (target.kind === 'object') {
          const obj = s.objects.find((o) => o.id === target.id && o.position.x === target.x && o.position.y === target.y);
          if (!obj) return { success: false, reason: 'target_not_found' };
          if (obj.name === 'Tree' && action === 'Chop down') {
            if (!s.inventory.items.some((i) => /axe/i.test(i.name)) && !s.equipment.some((e) => /axe/i.test(e.name))) {
              this.message('You do not have an axe which you have the woodcutting level to use.');
              return { success: true };
            }
            this.startBusy(() => this.addItem(1511, 'Logs'));
            return { success: true };
          }
          if (obj.name === 'Bank booth' && action === 'Bank') {
            s.bank.open = true;
            return { success: true };
          }
          return { success: true };
        }
        if (target.kind === 'inventory' && action === 'Eat') {
          const food = s.inventory.items.find((i) => i.slot === target.slot);
          if (!food) return { success: false, reason: 'slot_changed' };
          s.inventory.items = s.inventory.items.filter((i) => i.slot !== food.slot);
          s.inventory.freeSlots++;
          p.hp.current = Math.min(p.hp.max, p.hp.current + 3);
          return { success: true };
        }
        return { success: true };
      }
      case 'walk': {
        const to = body.to as { x: number; y: number; plane: number };
        this.walkTo = to;
        this.walkArrive = s.tick + 3;
        s.walk = { active: true, target: to, distanceToTarget: 10 };
        p.moving = true;
        return { success: true };
      }
      case 'bank_open':
        s.bank.open = true;
        return { success: true };
      case 'bank_close':
        s.bank.open = false;
        return { success: true };
      case 'bank_deposit_all':
        if (!s.bank.open) return { success: false, reason: 'bank_not_open' };
        s.inventory = { freeSlots: 28, items: [] };
        return { success: true };
      case 'bank_deposit': {
        if (!s.bank.open) return { success: false, reason: 'bank_not_open' };
        const id = body.itemId as number;
        const removed = s.inventory.items.filter((i) => i.id === id).length;
        s.inventory.items = s.inventory.items.filter((i) => i.id !== id);
        s.inventory.freeSlots += removed;
        return { success: true };
      }
      case 'drop': {
        const slot = body.slot as number;
        const before = s.inventory.items.length;
        s.inventory.items = s.inventory.items.filter((i) => i.slot !== slot);
        s.inventory.freeSlots += before - s.inventory.items.length;
        return { success: true };
      }
      case 'dialogue_continue':
        s.dialogue = { inDialogue: false, hasContinue: false, hasOptions: false, options: [] };
        return { success: true };
      case 'toggle_run':
        p.runEnabled = body.enabled === true;
        return { success: true };
      default:
        return { success: true };
    }
  }

  private startBusy(onDone: () => void) {
    const p = this.state.player!;
    p.animating = true;
    p.animation = 621;
    this.busyUntil = this.state.tick + this.actionTicks;
    this.pending = onDone;
  }
}

export interface FakeServer {
  url: string;
  port: number;
  game: FakeGame;
  close(): Promise<void>;
}

export async function startFakeServer(game: FakeGame, token = 'test-token'): Promise<FakeServer> {
  const server: Server = createServer((req, res) => {
    if (req.headers['x-agent-token'] !== token) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/snapshot')) {
      game.tick();
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(game.state));
      return;
    }
    if (req.method === 'POST' && req.url === '/act') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const result = game.act(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...result, op: JSON.parse(body).op, tick: game.state.tick }));
      });
      return;
    }
    res.writeHead(404).end('Not Found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    game,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
