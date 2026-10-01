/**
 * Unattended data-gathering campaign: rotates activities, each one an ordinary `agent run` in its
 * own process with a time budget, and keeps the client alive in between.
 *
 * Per round: health check (agent server up? logged in? -> relaunch / log in) -> pick an activity
 * (weighted, skipping ones on cooldown or needing an LLM that is not configured) -> run it until it
 * ends or its time is up (SIGTERM, which also cancels the client's walk) -> record the outcome ->
 * short random break -> every few rounds rebuild the dataset. An activity that ends "impossible"
 * or "error" sits out a few rounds; three failed logins in a row stop the campaign (the Jagex
 * session probably expired and needs Bolt).
 *
 * Run: npm run campaign -- [--hours 4] [--config campaign.json] [--only a,b] [--llm P]
 *      [--llm-model M] [--rescue] [--world 316] [--restart-client] [--dry-run]
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { appendFileSync, closeSync, createWriteStream, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export interface Activity {
  name: string;
  /** Arguments after `agent run`. */
  args: string[];
  weight?: number;
  /** Needs an LLM (quests, --goal): skipped when none is configured. */
  needsLlm?: boolean;
  /** Minutes before the activity is stopped. Default: the campaign's minutesPerActivity. */
  minutes?: number;
}

export interface CampaignConfig {
  hours: number;
  minutesPerActivity: number;
  /** Random pause between activities, minutes [min, max]. */
  breakMinutes: [number, number];
  /** Rounds an activity sits out after ending impossible / error. */
  cooldownRounds: number;
  /** Rebuild data/dataset/{train,eval}.jsonl every N activities (0 = never). */
  rebuildEvery: number;
  world: number;
  /** Relaunch the client (microbot-run) when the agent server is unreachable. */
  restartClient: boolean;
  rescue: boolean;
  llm?: string;
  llmModel?: string;
  activities: Activity[];
}

export const DEFAULT_ACTIVITIES: Activity[] = [
  { name: 'level-lowest-skill', args: ['--strategy', 'level'], weight: 3 },
  { name: 'fish-shrimp', args: ['--task', 'fish-shrimp', '--bank'], weight: 2 },
  { name: 'chop-trees', args: ['--task', 'chop-trees', '--bank'], weight: 2 },
  { name: 'chop-oaks', args: ['--task', 'chop-oaks', '--bank'], weight: 1 },
  { name: 'mine-iron', args: ['--task', 'mine-iron', '--bank'], weight: 2 },
  { name: 'cook-shrimps', args: ['--task', 'cook-shrimps'], weight: 1 },
  { name: 'kill-barbarians', args: ['--task', 'kill-barbarians'], weight: 2 },
  { name: 'range-cows', args: ['--task', 'range-cows'], weight: 2 },
  { name: 'mage-chickens', args: ['--task', 'mage-chickens'], weight: 1 },
  { name: 'smith-progression', args: ['--task', 'smith-progression'], weight: 1 },
  { name: 'money', args: ['--strategy', 'money'], weight: 1 },
  { name: 'quests', args: ['--strategy', 'quest'], weight: 3, needsLlm: true, minutes: 45 },
];

export const DEFAULT_CONFIG: CampaignConfig = {
  hours: 4,
  minutesPerActivity: 25,
  breakMinutes: [1, 4],
  cooldownRounds: 3,
  rebuildEvery: 4,
  world: 316,
  restartClient: false,
  rescue: false,
  activities: DEFAULT_ACTIVITIES,
};

export type ActivityStatus = 'complete' | 'impossible' | 'stopped' | 'halted' | 'error' | 'timeout' | 'crashed';

export interface ActivityResult {
  activity: string;
  status: ActivityStatus;
  reason: string;
  startedAt: string;
  minutes: number;
}

/** Parses the agent's final line: "[agent] complete: reason (3 sub-goals, 40 steps)". */
export function parseOutcome(output: string): { status: ActivityStatus; reason: string } | null {
  const lines = output.trim().split('\n').reverse();
  for (const l of lines) {
    const m = /^\[agent\] (complete|impossible|stopped|halted|error): (.*)$/.exec(l.trim());
    if (m) return { status: m[1] as ActivityStatus, reason: m[2]! };
  }
  return null;
}

/** Weighted pick among activities not on cooldown and runnable with the current LLM setup. */
export function chooseActivity(acts: Activity[], cooldowns: Map<string, number>, hasLlm: boolean, rnd: () => number, last?: string): Activity | null {
  let pool = acts.filter((a) => (cooldowns.get(a.name) ?? 0) <= 0 && (!a.needsLlm || hasLlm));
  // Avoid running the same activity twice in a row when there is a choice.
  if (pool.length > 1) pool = pool.filter((a) => a.name !== last);
  const total = pool.reduce((s, a) => s + (a.weight ?? 1), 0);
  let x = rnd() * total;
  for (const a of pool) {
    x -= a.weight ?? 1;
    if (x <= 0) return a;
  }
  return pool.at(-1) ?? null;
}

export interface Health {
  reachable: boolean;
  loggedIn: boolean;
}

export interface CampaignDeps {
  health(): Promise<Health>;
  login(world: number): Promise<boolean>;
  relaunchClient(): Promise<void>;
  runActivity(a: Activity, minutes: number): Promise<{ output: string; timedOut: boolean; code: number | null }>;
  rebuildDataset(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
  random(): number;
  log(line: string): void;
  record(r: ActivityResult): void;
  hasLlm: boolean;
  stopped(): boolean;
}

/** Makes sure the client is up and logged in; false when it cannot be recovered. */
export async function ensureReady(cfg: CampaignConfig, d: CampaignDeps): Promise<boolean> {
  let h = await d.health();
  if (!h.reachable) {
    if (!cfg.restartClient) {
      d.log('agent server unreachable (start the client, or pass --restart-client)');
      return false;
    }
    d.log('agent server unreachable: relaunching the client');
    await d.relaunchClient();
    for (let i = 0; i < 60 && !h.reachable; i++) {
      await d.sleep(5000);
      h = await d.health();
    }
    if (!h.reachable) return false;
  }
  for (let attempt = 0; attempt < 3 && !h.loggedIn; attempt++) {
    d.log(`logged out: logging in to world ${cfg.world}`);
    await d.login(cfg.world);
    await d.sleep(5000);
    h = await d.health();
  }
  return h.loggedIn;
}

export async function runCampaign(cfg: CampaignConfig, d: CampaignDeps): Promise<ActivityResult[]> {
  const results: ActivityResult[] = [];
  const cooldowns = new Map<string, number>();
  const deadline = d.now() + cfg.hours * 3_600_000;
  let last: string | undefined;
  let failedReady = 0;
  while (!d.stopped() && d.now() < deadline) {
    if (!(await ensureReady(cfg, d))) {
      failedReady++;
      if (failedReady >= 3) {
        d.log('client could not be made ready 3 times in a row: stopping (re-capture the Jagex session with Bolt?)');
        break;
      }
      await d.sleep(60_000);
      continue;
    }
    failedReady = 0;
    const act = chooseActivity(cfg.activities, cooldowns, d.hasLlm, d.random, last);
    if (!act) {
      d.log('every activity is on cooldown: waiting a round');
      for (const [k, v] of cooldowns) cooldowns.set(k, v - 1);
      await d.sleep(60_000);
      continue;
    }
    const minutes = Math.min(act.minutes ?? cfg.minutesPerActivity, Math.max(1, (deadline - d.now()) / 60_000));
    const startedAt = new Date(d.now()).toISOString();
    const t0 = d.now();
    d.log(`▶ ${act.name} (${minutes.toFixed(0)} min): agent run ${act.args.join(' ')}`);
    const run = await d.runActivity(act, minutes);
    const parsed = parseOutcome(run.output);
    const status: ActivityStatus = run.timedOut ? 'timeout' : (parsed?.status ?? 'crashed');
    const reason = run.timedOut ? 'time budget used' : (parsed?.reason ?? `exit code ${run.code}`);
    const result = { activity: act.name, status, reason, startedAt, minutes: Math.round((d.now() - t0) / 600) / 100 };
    results.push(result);
    d.record(result);
    d.log(`■ ${act.name}: ${status} - ${reason}`);

    for (const [k, v] of cooldowns) cooldowns.set(k, v - 1);
    if (status === 'impossible' || status === 'error' || status === 'crashed') cooldowns.set(act.name, cfg.cooldownRounds);
    last = act.name;

    if (cfg.rebuildEvery > 0 && results.length % cfg.rebuildEvery === 0) {
      d.log('rebuilding the dataset');
      await d.rebuildDataset().catch((e) => d.log(`dataset rebuild failed: ${e instanceof Error ? e.message : e}`));
    }
    if (!d.stopped() && d.now() < deadline) {
      const [lo, hi] = cfg.breakMinutes;
      await d.sleep((lo + d.random() * (hi - lo)) * 60_000);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Process wiring
// ---------------------------------------------------------------------------------------------

const ENGINE_DIR = path.resolve(import.meta.dirname, '..', '..');

async function agentRequest(method: 'GET' | 'POST', route: string, body?: unknown, timeoutMs = 10_000): Promise<unknown> {
  const token = (await readFile(path.join(os.homedir(), '.runelite', '.agent-token'), 'utf8').catch(() => '')).trim();
  const res = await fetch(`http://127.0.0.1:8081${route}`, {
    method,
    headers: { ...(token ? { 'X-Agent-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}

function processDeps(cfg: CampaignConfig, dir: string, hasLlm: boolean, stop: { flag: boolean; child: ChildProcess | null }): CampaignDeps {
  let n = 0;
  const logFile = path.join(dir, 'campaign.log');
  return {
    hasLlm,
    stopped: () => stop.flag,
    now: () => Date.now(),
    random: Math.random,
    // Interruptible: a stop request ends the wait within a second.
    sleep: async (ms) => {
      const end = Date.now() + ms;
      while (!stop.flag && Date.now() < end) await new Promise((r) => setTimeout(r, Math.min(1000, end - Date.now())));
    },
    log: (line) => {
      const l = `${new Date().toLocaleTimeString()} ${line}`;
      console.log(l);
      appendFileSync(logFile, `${l}\n`);
    },
    record: (r) => appendFileSync(path.join(dir, 'summary.jsonl'), `${JSON.stringify(r)}\n`),
    health: async () => {
      try {
        const s = (await agentRequest('GET', '/state')) as { loggedIn?: boolean };
        return { reachable: true, loggedIn: !!s.loggedIn };
      } catch {
        return { reachable: false, loggedIn: false };
      }
    },
    login: async (world) => {
      try {
        const r = (await agentRequest('POST', '/login', { wait: true, world, timeout: 60 }, 90_000)) as { success?: boolean };
        return !!r.success;
      } catch {
        return false;
      }
    },
    relaunchClient: async () => {
      // The client writes straight to the log file: piping it through this process would keep the
      // campaign alive for as long as the client runs.
      const fd = openSync(path.join(os.homedir(), '.cache', 'microbot-run.log'), 'a');
      const child = spawn(process.env.MICROBOT_RUN ?? 'microbot-run', [], { detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      child.unref();
    },
    runActivity: (a, minutes) =>
      new Promise((resolve) => {
        n++;
        const args = ['--disable-warning=ExperimentalWarning', '--env-file-if-exists=../.env', 'src/cli.ts', 'run', ...a.args, '--max-subgoals', '1000'];
        if (cfg.rescue && hasLlm) args.push('--rescue');
        if (cfg.llm) args.push('--llm', cfg.llm);
        if (cfg.llmModel) args.push('--llm-model', cfg.llmModel);
        const out = createWriteStream(path.join(dir, `${String(n).padStart(3, '0')}-${a.name}.log`));
        const child = spawn(process.execPath, args, { cwd: ENGINE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
        stop.child = child;
        let tail = '';
        const onData = (d: Buffer) => {
          out.write(d);
          tail = (tail + d.toString()).slice(-4000);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 20_000).unref();
        }, minutes * 60_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          stop.child = null;
          out.end();
          resolve({ output: tail, timedOut, code });
        });
      }),
    rebuildDataset: () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/dataset/build.ts'], { cwd: ENGINE_DIR, stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', (code) => {
          if (code === 0) {
            appendFileSync(path.join(dir, 'campaign.log'), `dataset: ${out.trim()}\n`);
            resolve();
          } else reject(new Error(`build exited ${code}`));
        });
      }),
  };
}

if (import.meta.main) {
  const { createLlmClient } = await import('../llm/providers.ts');
  const { values } = parseArgs({
    options: {
      hours: { type: 'string' },
      config: { type: 'string' },
      only: { type: 'string' },
      llm: { type: 'string' },
      'llm-model': { type: 'string' },
      rescue: { type: 'boolean', default: false },
      world: { type: 'string' },
      'restart-client': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const file = values.config ? (JSON.parse(readFileSync(values.config, 'utf8')) as Partial<CampaignConfig>) : {};
  const cfg: CampaignConfig = { ...DEFAULT_CONFIG, ...file };
  if (values.hours) cfg.hours = Number(values.hours);
  if (values.world) cfg.world = Number(values.world);
  if (values['restart-client']) cfg.restartClient = true;
  if (values.rescue) cfg.rescue = true;
  if (values.llm) cfg.llm = values.llm;
  if (values['llm-model']) cfg.llmModel = values['llm-model'];
  if (values.only) {
    const only = new Set(values.only.split(',').map((x) => x.trim()));
    cfg.activities = cfg.activities.filter((a) => only.has(a.name));
  }
  const llm = createLlmClient({ provider: cfg.llm, model: cfg.llmModel });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(ENGINE_DIR, 'logs', 'campaign', id);
  console.log(`[campaign] ${cfg.hours} h, ${cfg.activities.length} activities, LLM: ${llm?.name ?? 'none'}${cfg.rescue ? ' (rescue on)' : ''}; logs: ${dir}`);
  for (const a of cfg.activities) console.log(`  ${a.name.padEnd(20)} w${a.weight ?? 1}${a.needsLlm && !llm ? '  (skipped: needs an LLM)' : ''}  agent run ${a.args.join(' ')}`);
  if (values['dry-run']) process.exit(0);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(path.join(ENGINE_DIR, 'data', 'kb.sqlite'))) console.warn('[campaign] no data/kb.sqlite: planners that need the KB will be weaker');

  const stop = { flag: false, child: null as ChildProcess | null };
  const onStop = () => {
    if (stop.flag) process.exit(130);
    stop.flag = true;
    console.log('\n[campaign] stopping: ending the current activity (again to force)');
    stop.child?.kill('SIGTERM');
  };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);
  const results = await runCampaign(cfg, processDeps(cfg, dir, llm !== null, stop));
  const by = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`[campaign] done: ${results.length} activities ${JSON.stringify(by)}; summary: ${path.join(dir, 'summary.jsonl')}`);
  process.exit(0);
}
