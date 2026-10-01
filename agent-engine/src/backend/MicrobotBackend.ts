/**
 * Talks to the Microbot Agent Server plugin (127.0.0.1:8081 by default): GET /snapshot and
 * POST /act. Auth is the X-Agent-Token the plugin writes to ~/.runelite/.agent-token.
 *
 * Env: MICROBOT_HOST, MICROBOT_PORT, MICROBOT_TOKEN, MICROBOT_TOKEN_FILE (same as microbot-cli).
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ActResponse, GameAction, Snapshot, WorldPoint } from '../types.ts';

export interface GameBackend {
  snapshot(): Promise<Snapshot>;
  act(action: GameAction): Promise<ActResponse>;
  /** Web-walker route length between two points; null when unreachable. Optional. */
  pathLength?(from: WorldPoint, to: WorldPoint): Promise<number | null>;
  /** Logs in (or, when already logged in, dismisses the welcome screen). Optional. */
  login?(): Promise<void>;
}

export interface MicrobotBackendOptions {
  host?: string;
  port?: number;
  token?: string;
  tokenFile?: string;
  timeoutMs?: number;
  /** Extra /snapshot query params (radius, maxNpcs, maxObjects, maxGroundItems, bankItems, messages). */
  snapshotParams?: Record<string, number>;
  fetchImpl?: typeof fetch;
}

export class MicrobotApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export class MicrobotBackend implements GameBackend {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly snapshotParams: Record<string, number>;
  private readonly fetchImpl: typeof fetch;
  private token: string | undefined;
  private readonly fixedToken: boolean;

  constructor(opts: MicrobotBackendOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    const host = opts.host ?? env.MICROBOT_HOST ?? '127.0.0.1';
    const port = opts.port ?? Number(env.MICROBOT_PORT ?? 8081);
    this.baseUrl = `http://${host}:${port}`;
    this.token = opts.token ?? env.MICROBOT_TOKEN;
    this.fixedToken = this.token !== undefined;
    this.tokenFile = opts.tokenFile ?? env.MICROBOT_TOKEN_FILE ?? path.join(os.homedir(), '.runelite', '.agent-token');
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.snapshotParams = opts.snapshotParams ?? {};
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async snapshot(): Promise<Snapshot> {
    const qs = new URLSearchParams(Object.fromEntries(Object.entries(this.snapshotParams).map(([k, v]) => [k, String(v)])));
    const route = `/snapshot${qs.size ? `?${qs}` : ''}`;
    // A 503 means one client-thread read timed out (the client hitches under load); reads are
    // side-effect free, so retry a couple of times before failing the run.
    for (let attempt = 1; ; attempt++) {
      try {
        return normalizeSnapshot((await this.request('GET', route)) as Partial<Snapshot>);
      } catch (e) {
        const transient = e instanceof MicrobotApiError && (e.status === 503 || e.status === undefined);
        if (!transient || attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  async act(action: GameAction): Promise<ActResponse> {
    if (action.op === 'wait' || action.op === 'done') {
      throw new Error(`"${action.op}" is engine-side and is never sent to the client`);
    }
    return (await this.request('POST', '/act', toWire(action))) as ActResponse;
  }

  async pathLength(from: WorldPoint, to: WorldPoint): Promise<number | null> {
    const q = new URLSearchParams({ from: `${from.x},${from.y},${from.plane}`, to: `${to.x},${to.y},${to.plane}` });
    const r = (await this.request('GET', `/path?${q}`)) as { reachable: boolean; length: number };
    return r.reachable ? r.length : null;
  }

  async varp(id: number): Promise<number> {
    return ((await this.request('GET', `/varp?id=${id}`)) as { value: number }).value;
  }

  /** Every quest's state (NOT_STARTED / IN_PROGRESS / FINISHED), by Quest Helper display name. */
  async questStates(): Promise<{ displayName: string; state: string }[]> {
    return ((await this.request('GET', '/quest-helper/states')) as { quests: { displayName: string; state: string }[] }).quests;
  }

  async questHelperStatus(): Promise<{ selected: boolean; questName?: string; completed?: boolean; stepText?: string | string[]; stepPoint?: WorldPoint }> {
    return (await this.request('GET', '/quest-helper/status')) as { selected: boolean; questName?: string; completed?: boolean; stepText?: string | string[]; stepPoint?: WorldPoint };
  }

  async login(): Promise<void> {
    await this.request('POST', '/login', { wait: true });
  }

  /** Selects the quest in Quest Helper for its step text only: its own QuestScript stays off. */
  async questHelperStart(name: string): Promise<void> {
    await this.request('POST', '/quest-helper/start', { name, autoplay: false });
  }

  /** Deselects the quest, so no Quest Helper script walks or clicks alongside the agent. */
  async questHelperStop(): Promise<void> {
    await this.request('POST', '/quest-helper/stop', {});
  }

  private async request(method: 'GET' | 'POST', route: string, body?: unknown, retried = false): Promise<unknown> {
    const token = await this.loadToken();
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + route, {
        method,
        headers: {
          ...(token ? { 'X-Agent-Token': token } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MicrobotApiError(
        `Cannot reach Microbot agent server at ${this.baseUrl} (${err instanceof Error ? err.message : err}). ` +
          'Is the client running with the Agent Server plugin enabled?',
      );
    }
    // The server answers every auth failure with an opaque 404. The token rotates when the
    // plugin restarts, so re-read the token file once before giving up.
    if (res.status === 404 && !retried && !this.fixedToken) {
      this.token = undefined;
      return this.request(method, route, body, true);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new MicrobotApiError(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    return JSON.parse(text);
  }

  private async loadToken(): Promise<string | undefined> {
    if (this.token !== undefined) return this.token;
    try {
      this.token = (await readFile(this.tokenFile, 'utf8')).trim();
    } catch {
      this.token = undefined;
    }
    return this.token;
  }
}

/** The wire body for POST /act (see ActHandler.java). */
export function toWire(action: GameAction): Record<string, unknown> {
  switch (action.op) {
    case 'walk':
      return { op: 'walk', to: action.to, distance: action.distance ?? 1 };
    default:
      return { ...action };
  }
}

/** Fills the fields a logged-out snapshot omits so consumers never branch on undefined. */
export function normalizeSnapshot(raw: Partial<Snapshot>): Snapshot {
  return {
    tick: raw.tick ?? 0,
    timestamp: raw.timestamp ?? Date.now(),
    loggedIn: raw.loggedIn ?? false,
    welcomeScreen: raw.welcomeScreen ?? false,
    gameState: raw.gameState ?? 'UNKNOWN',
    player: raw.player ?? null,
    skills: raw.skills ?? [],
    inventory: raw.inventory ?? { freeSlots: 28, items: [] },
    equipment: raw.equipment ?? [],
    npcs: raw.npcs ?? [],
    objects: raw.objects ?? [],
    groundItems: raw.groundItems ?? [],
    dialogue: raw.dialogue ?? { inDialogue: false, hasContinue: false, hasOptions: false, options: [] },
    production: raw.production ?? { open: false, options: [] },
    bank: raw.bank ?? { open: false, items: [] },
    shop: raw.shop ?? { open: false, items: [] },
    walk: raw.walk ?? { active: false },
    messages: raw.messages ?? [],
  };
}
