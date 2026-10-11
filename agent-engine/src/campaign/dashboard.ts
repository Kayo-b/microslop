/**
 * One screen for every running character: unit state, current activity and recent results, the
 * latest agent steps, how many decisions Jev made, the watcher's last verdict and the rescues of the
 * last hour. Reads both data homes (char 1 in the checkout, char 2 in ~/.microbot-char2-home/agent-engine), so nothing needs to be
 * opened one character at a time.
 *
 *   node src/campaign/dashboard.ts [--hours 1] [--live [--interval 5]]
 *
 * --live redraws in place every few seconds and shows a feed of the newest events (agent steps,
 * watcher verdicts, rescues) from both characters, so the screen follows the runs as they go.
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MicrobotBackend } from '../backend/MicrobotBackend.ts';

const run = promisify(execFile);

interface Char {
  n: 1 | 2;
  name: string;
  root: string;
  unit: string;
  watcher: string;
  port: number;
  tokenFile: string;
}

const HOME = os.homedir();
const MAIN = path.resolve(import.meta.dirname, '..', '..');
const CHARS: Char[] = [
  { n: 1, name: 'char 1 (free)', root: MAIN, unit: 'microbot-jev-data', watcher: 'watch-char1', port: 8081, tokenFile: path.join(HOME, '.runelite', '.agent-token') },
  { n: 2, name: 'char 2 (members)', root: process.env.MICROBOT_ENGINE_HOME_CHAR2 ?? path.join(HOME, '.microbot-char2-home', 'agent-engine'), unit: 'microbot-char2', watcher: 'watch-char2', port: 8082, tokenFile: path.join(HOME, '.microbot-char2-home', '.runelite', '.agent-token') },
];

const hoursArg = process.argv.indexOf('--hours');
const HOURS = hoursArg > 0 ? Number(process.argv[hoursArg + 1]) : 1;
const LIVE = process.argv.includes('--live');
const intervalArg = process.argv.indexOf('--interval');
const INTERVAL_S = Math.max(1, intervalArg > 0 ? Number(process.argv[intervalArg + 1]) : 5);
const FEED_ROWS = 14;

interface FeedEvent { t: number; text: string }

const tail = (file: string, n: number): string[] => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
};
const newest = (dir: string): string | null => {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((x) => !x.startsWith('.'));
  names.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
  return names[0] ?? null;
};
const json = <T>(l: string): T | null => {
  try {
    return JSON.parse(l) as T;
  } catch {
    return null;
  }
};
const ago = (iso: string | number | undefined): string => {
  const t = typeof iso === 'number' ? iso : Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '?';
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'now' : m < 90 ? `${m} min ago` : `${(m / 60).toFixed(1)} h ago`;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function active(unit: string): Promise<string> {
  try {
    return (await run('systemctl', ['--user', 'is-active', unit])).stdout.trim();
  } catch (e) {
    return (e as { stdout?: string }).stdout?.trim() || 'inactive';
  }
}

interface Step { time?: string; source?: string; model?: string; subgoal?: string; state?: { location?: string; status?: string } }

async function show(c: Char, feed: FeedEvent[]): Promise<string[]> {
  const out: string[] = [];
  const tag = `c${c.n}`;
  const since = Date.now() - HOURS * 3_600_000;
  const [unit, watcher] = await Promise.all([active(c.unit), active(c.watcher)]);
  out.push(`== ${c.name}: campaign ${unit}, watcher ${watcher} ==`);

  const campDir = newest(path.join(c.root, 'logs', 'campaign'));
  if (campDir) {
    const lines = tail(path.join(c.root, 'logs', 'campaign', campDir, 'campaign.log'), 400);
    const started = lines.filter((l) => l.includes('▶')).at(-1);
    const results = lines.filter((l) => l.includes('■')).slice(-4);
    out.push(`  activity : ${clip(started?.replace(/^.*?▶\s*/, '') ?? 'none yet', 110)}`);
    for (const r of results) out.push(`  result   : ${clip(r, 120)}`);
    const notable = lines.filter((l) => /relaunching|logged out|every activity is on cooldown/.test(l)).at(-1);
    if (notable) out.push(`  note     : ${clip(notable, 110)}`);
  } else out.push('  no campaign logs');

  const run = newest(path.join(c.root, 'logs', 'agent'));
  const steps = run ? tail(path.join(c.root, 'logs', 'agent', run, 'steps.jsonl'), 200).map((l) => json<Step>(l)).filter((s): s is Step => !!s) : [];
  const last = steps.at(-1);
  for (const st of steps.slice(-FEED_ROWS)) {
    const t = Date.parse(st.time ?? '');
    if (Number.isFinite(t)) feed.push({ t, text: `${tag} step    ${st.source === 'model' ? (st.model?.startsWith('jev') ? 'jev' : (st.model ?? 'model')) : (st.source ?? '?')} @ ${st.state?.location ?? '?'}: ${clip(st.subgoal ?? '', 80)}` });
  }
  if (last) {
    out.push(`  last step: ${ago(last.time)} at ${last.state?.location ?? '?'} [${last.state?.status ?? ''}] "${clip(last.subgoal ?? '', 70)}"`);
    const bySource = new Map<string, number>();
    for (const s of steps) {
      const k = s.source === 'model' ? (s.model?.startsWith('jev') ? 'jev' : (s.model ?? 'model')) : (s.source ?? '?');
      bySource.set(k, (bySource.get(k) ?? 0) + 1);
    }
    out.push(`  decisions: last ${steps.length}: ${[...bySource].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }

  try {
    const backend = new MicrobotBackend({ port: c.port, token: readFileSync(c.tokenFile, 'utf8').trim() });
    const s = await backend.snapshot();
    const coins = s.inventory.items.filter((i) => i.name === 'Coins').reduce((n, i) => n + i.quantity, 0);
    const p = s.player?.position;
    out.push(`  live     : ${s.loggedIn ? 'logged in' : 'LOGGED OUT'} at ${p ? `${p.x},${p.y}` : '?'} hp ${s.player?.hp?.current}/${s.player?.hp?.max}, ${coins.toLocaleString()} coins carried, ${s.inventory.freeSlots} free slots`);
  } catch {
    out.push('  live     : client not reachable');
  }

  type Review = { ts: string; status: string; severity: number; diagnosis: string; acted?: string };
  const reviews = tail(path.join(c.root, 'data', 'watch', 'reviews.jsonl'), FEED_ROWS).map((l) => json<Review>(l)).filter((r): r is Review => !!r);
  const review = reviews.at(-1);
  for (const r of reviews) {
    const t = Date.parse(r.ts);
    if (Number.isFinite(t)) feed.push({ t, text: `${tag} watcher ${r.status} (sev ${r.severity})${r.acted ? ` acted: ${clip(r.acted, 40)}` : ''} - ${clip(r.diagnosis, 100)}` });
  }
  if (review) out.push(`  watcher  : ${ago(review.ts)} ${review.status} (sev ${review.severity})${review.acted ? ` acted: ${clip(review.acted, 40)}` : ''} - ${clip(review.diagnosis, 140)}`);

  const rescues = tail(path.join(c.root, 'data', 'rescues.jsonl'), 400).map((l) => json<{ kind: string; ts: string; trigger?: string }>(l)).filter((r): r is { kind: string; ts: string; trigger?: string } => !!r && r.kind === 'rescue' && Date.parse(r.ts) >= since);
  for (const r of rescues.slice(-FEED_ROWS)) feed.push({ t: Date.parse(r.ts), text: `${tag} rescue  ${r.trigger ?? '?'}` });
  if (rescues.length) {
    const by = new Map<string, number>();
    for (const r of rescues) by.set(r.trigger ?? '?', (by.get(r.trigger ?? '?') ?? 0) + 1);
    out.push(`  rescues  : ${rescues.length} in the window: ${[...by].map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  return out;
}

async function frame(): Promise<string[]> {
  const feed: FeedEvent[] = [];
  const blocks = await Promise.all(CHARS.map((c) => show(c, feed)));
  const lines = [`Microbot runs, ${new Date().toLocaleTimeString()} (rescues over the last ${HOURS} h)${LIVE ? `, live every ${INTERVAL_S} s, Ctrl+C to leave` : ''}`, ''];
  for (const b of blocks) lines.push(...b, '');
  feed.sort((a, b) => a.t - b.t);
  lines.push('== latest events ==');
  for (const e of feed.slice(-FEED_ROWS)) lines.push(`  ${new Date(e.t).toLocaleTimeString()} ${e.text}`);
  return lines;
}

if (!LIVE) {
  console.log((await frame()).join('\n'));
} else {
  const out = process.stdout;
  const restore = () => out.write('\x1b[?25h\x1b[?1049l');
  out.write('\x1b[?1049h\x1b[?25l');
  process.on('SIGINT', () => { restore(); process.exit(0); });
  process.on('SIGTERM', () => { restore(); process.exit(0); });
  const cols = () => out.columns || 200;
  for (;;) {
    let lines: string[];
    try {
      lines = await frame();
    } catch (e) {
      lines = [`dashboard error: ${e instanceof Error ? e.message : e}`];
    }
    // One write per frame, overwriting in place: no flicker.
    out.write(`\x1b[H${lines.map((l) => `${clip(l, cols())}\x1b[K`).join('\n')}\n\x1b[J`);
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
  }
}
