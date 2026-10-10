/**
 * Run watcher: a Haiku reviewer that looks over a running character every few minutes, says whether
 * the run is healthy, and records what it saw for later improvements (planner fixes, scripted
 * replacements for LLM-driven methods, training data).
 *
 *   node src/campaign/watcher.ts [--interval 180] [--model claude-haiku-4-5-20251001] [--char 2] [--once]
 *
 * Run it from a character's agent-engine directory (it uses MICROBOT_PORT / MICROBOT_TOKEN_FILE like
 * the other tools). It only observes: findings go to data/watch/reviews.jsonl, and the journal (the
 * dashboard shows the latest one; no desktop popups). It never clicks.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { MicrobotBackend } from '../backend/MicrobotBackend.ts';
import { foldInventory } from '../engine/state.ts';
import { createLlmClient } from '../llm/providers.ts';

const { values } = parseArgs({
  strict: false,
  options: {
    interval: { type: 'string', default: '180' },
    model: { type: 'string', default: process.env.WATCH_MODEL ?? 'claude-haiku-4-5-20251001' },
    char: { type: 'string', default: process.env.MICROBOT_CHARACTER_NO ?? '?' },
    once: { type: 'boolean', default: false },
    'no-act': { type: 'boolean', default: process.env.WATCH_ACT === '0' },
  },
});

export const ACTIONS = ['none', 'close_interfaces', 'cancel_walk', 'skip_activity'] as const;
export type WatchAction = (typeof ACTIONS)[number];

const ReviewSchema = z.object({
  status: z.enum(['ok', 'slow', 'stuck', 'wrong']).describe('ok: progressing as intended; slow: progressing badly; stuck: no progress or looping; wrong: doing something it should not (members area, dropping items, wrong target)'),
  severity: z.number().int().min(0).max(3).describe('0 fine, 1 note, 2 needs attention soon, 3 act now'),
  diagnosis: z.string().describe('What is happening and why, in two or three sentences, naming the sub-goals and places involved'),
  suggestion: z.string().describe('The concrete fix: a manual action now, and the code change (planner, engine, catalog or prompt) that would prevent it'),
  lesson: z.string().describe('One reusable lesson for the agent, or empty'),
  action: z.enum(ACTIONS).describe('What the watcher should do now: none (healthy or a fix needs code); close_interfaces (an open bank, shop or Grand Exchange window is in the way); cancel_walk (the walker is stalled or heading the wrong way); skip_activity (ends the current activity so the campaign starts the next one with a fresh planner: looping, wrong target, stuck for several reviews)'),
});

export type Review = z.infer<typeof ReviewSchema>;

const SYSTEM = `You supervise an automated Old School RuneScape agent (planners + a fast click classifier) running one character. You see the last minutes of its log. Judge whether the run is healthy. Typical failures: loops (same action repeated), walking the wrong way or to members areas on a free account, opening and closing interfaces, dropping valuable items, planning to buy items from shops that do not sell them, using the wrong object of the same name, doing a slow LLM-driven loop that a script would do better, being logged out. Be specific: quote sub-goal texts and coordinates. If the run is fine, say ok with severity 0, action none, and keep the other fields short. Choose the gentlest action that unsticks the run; use skip_activity only when the same problem has lasted more than one review or the agent is clearly doing something harmful.`;

function newest(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((n) => !n.startsWith('.'));
  names.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
  return names[0] ?? null;
}

function tail(file: string, n: number): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

interface Step { time?: string; subgoal?: string; source?: string; action?: unknown; outcome?: { effect?: string; messages?: string[] }; state?: { location?: string; status?: string; inventory?: string } }

function stepLine(s: Step): string {
  const a = s.action as { op?: string; label?: string; action?: string; to?: { x: number; y: number } } | undefined;
  const act = a ? [a.op, a.action, a.label ?? (a.to ? `${a.to.x},${a.to.y}` : '')].filter(Boolean).join(' ') : '-';
  return `${(s.time ?? '').slice(11, 19)} ${s.state?.location ?? '?'} [${s.state?.status ?? ''}] "${(s.subgoal ?? '').slice(0, 110)}" ${s.source ?? ''}: ${act.slice(0, 90)} -> ${(s.outcome?.effect ?? '').slice(0, 70)}${s.outcome?.messages?.length ? ` (${s.outcome.messages.slice(-1)[0]})` : ''}`;
}

export interface Evidence {
  run: string | null;
  activity: string;
  text: string;
  fingerprint: string;
}

export async function gather(root = process.cwd(), backend = new MicrobotBackend()): Promise<Evidence> {
  const campDir = newest(path.join(root, 'logs', 'campaign'));
  const campaign = campDir ? tail(path.join(root, 'logs', 'campaign', campDir, 'campaign.log'), 8) : [];
  const run = newest(path.join(root, 'logs', 'agent'));
  const steps = run ? tail(path.join(root, 'logs', 'agent', run, 'steps.jsonl'), 30).map((l) => JSON.parse(l) as Step) : [];
  let live = 'client not reachable';
  try {
    const s = await backend.snapshot();
    const p = s.player?.position;
    live = `loggedIn=${s.loggedIn} at ${p ? `${p.x},${p.y},${p.plane}` : '?'} hp=${s.player?.hp?.current}/${s.player?.hp?.max} anim=${s.player?.animating} moving=${s.player?.moving} bank=${s.bank.open} ge=${s.grandExchange?.open} shop=${s.shop.open} inventory: ${foldInventory(s)}`;
  } catch (e) {
    live = `snapshot failed: ${e instanceof Error ? e.message : e}`;
  }
  const rescues = tail(path.join(root, 'data', 'rescues.jsonl'), 3).map((l) => {
    try {
      const r = JSON.parse(l) as { trigger?: string; reason?: string; result?: string; proposal?: { subgoal?: { text?: string } } };
      return `${r.trigger ?? r.result ?? ''}: ${String(r.reason ?? '').slice(0, 100)} ${r.proposal?.subgoal?.text ? `-> ${r.proposal.subgoal.text.slice(0, 100)}` : ''}`;
    } catch {
      return '';
    }
  });
  const last = steps.at(-1);
  const activity = campaign.filter((l) => l.includes('▶')).at(-1) ?? '';
  const text = [
    `CAMPAIGN LOG (latest):\n${campaign.join('\n')}`,
    `LIVE STATE: ${live}`,
    `LAST ${steps.length} AGENT STEPS (${run}):\n${steps.map(stepLine).join('\n')}`,
    `RECENT LLM RESCUES:\n${rescues.join('\n')}`,
  ].join('\n\n');
  return { run, activity, text, fingerprint: `${run}|${last?.time ?? ''}|${campaign.at(-1) ?? ''}` };
}

/** Gate for acting on a review: only stuck/wrong at severity 2+, soft actions first, skipping an activity only on a repeat and not more often than every 8 minutes. */
export function decideIntervention(review: Pick<Review, 'status' | 'severity' | 'action'>, consecutiveBad: number, msSinceSkip: number): WatchAction {
  // The first stuck verdict goes to the rescue (src/llm/watchFeed.ts); the watcher itself steps in
  // only when the same problem is still there at the next review, and ends the activity at the third.
  if ((review.status !== 'stuck' && review.status !== 'wrong') || review.severity < 2 || review.action === 'none' || consecutiveBad < 2) return 'none';
  if (review.action === 'skip_activity') {
    if (consecutiveBad < 3) return 'close_interfaces';
    return msSinceSkip >= 8 * 60_000 ? 'skip_activity' : 'none';
  }
  return review.action;
}

/** Pids of this checkout's processes whose command line matches `pattern`. */
function processesOf(pattern: RegExp, root: string): number[] {
  const found: number[] = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
      if (pattern.test(cmd) && readlinkSync(`/proc/${pid}/cwd`) === root) found.push(Number(pid));
    } catch {
      // Gone or not ours.
    }
  }
  return found;
}

/** File where the watcher notes the agent it ended, so the campaign records "ended by the watcher", not a crash. */
export const SKIP_FILE = path.join('data', 'watch', 'skipped.json');

/** Ends the running `agent run` of this checkout; the campaign records it and starts the next activity. */
export function skipActivity(reason: string, root = process.cwd()): string {
  for (const pid of processesOf(/src\/cli\.ts run /, root)) {
    try {
      writeFileSync(path.join(root, SKIP_FILE), JSON.stringify({ pid, ts: new Date().toISOString(), reason: reason.slice(0, 300) }));
      process.kill(pid, 'SIGTERM');
      return `ended the running agent (pid ${pid})`;
    } catch {
      // Gone already.
    }
  }
  return 'no running agent process found';
}

/** True while a campaign (runner.ts) of this checkout is running. */
export function campaignRunning(root = process.cwd()): boolean {
  return processesOf(/src\/campaign\/runner\.ts/, root).length > 0;
}

async function intervene(action: WatchAction, backend: MicrobotBackend, reason: string): Promise<string> {
  switch (action) {
    case 'none':
      return '';
    case 'close_interfaces': {
      const results: string[] = [];
      for (const op of ['bank_close', 'shop_close', 'ge_close'] as const) {
        const r = await backend.act({ op }).catch((e) => ({ success: false, reason: String(e) }));
        results.push(`${op}:${r.success ? 'ok' : (r as { reason?: string }).reason ?? 'failed'}`);
      }
      return results.join(' ');
    }
    case 'cancel_walk': {
      const r = await backend.act({ op: 'walk_cancel' }).catch((e) => ({ success: false, reason: String(e) }));
      return `walk_cancel:${r.success ? 'ok' : (r as { reason?: string }).reason ?? 'failed'}`;
    }
    case 'skip_activity':
      return skipActivity(reason);
  }
}

async function main(): Promise<void> {
  const interval = Number(values.interval) * 1000;
  const llm = createLlmClient({ provider: 'claude-code', model: String(values.model) });
  if (!llm) throw new Error('no LLM available for the watcher');
  const outDir = path.join(process.cwd(), 'data', 'watch');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'reviews.jsonl');
  console.log(`[watch] char ${values.char}, ${llm.name}, every ${values.interval}s -> ${outFile}`);
  let prev = '';
  let unchanged = 0;
  let consecutiveBad = 0;
  let lastSkip = 0;
  let noCampaign = 0;
  for (;;) {
    // The watcher belongs to a campaign: once none has run here for three reviews, it is done.
    noCampaign = campaignRunning() ? 0 : noCampaign + 1;
    if (noCampaign >= 3) {
      console.log('[watch] no campaign running in this checkout for three reviews: exiting');
      return;
    }
    try {
      const ev = await gather();
      unchanged = ev.fingerprint === prev ? unchanged + 1 : 0;
      prev = ev.fingerprint;
      let review: Review;
      if (unchanged >= 3) {
        review = { status: 'stuck', severity: 3, diagnosis: `No new agent step or campaign line for ${Math.round((unchanged * interval) / 60000)} minutes (run ${ev.run}).`, suggestion: 'The agent process may be hung or the client closed: check the unit and the client window.', lesson: '', action: 'skip_activity' };
      } else if (unchanged >= 1) {
        review = { status: 'ok', severity: 0, diagnosis: 'no new activity since the last review', suggestion: '', lesson: '', action: 'none' };
      } else {
        const res = await llm.structured({ system: SYSTEM, user: ev.text, schema: ReviewSchema, schemaName: 'review', effort: 'medium', maxTokens: 700 });
        review = res.kind === 'ok' ? res.value : { status: 'ok', severity: 0, diagnosis: `reviewer refused: ${res.reason}`, suggestion: '', lesson: '', action: 'none' };
      }
      consecutiveBad = (review.status === 'stuck' || review.status === 'wrong') && review.severity >= 2 ? consecutiveBad + 1 : 0;
      // A silent agent (no steps for ~9 minutes) is hung already: no need to wait for a repeat.
      const chosen = unchanged >= 3 ? (Date.now() - lastSkip >= 8 * 60_000 ? 'skip_activity' : 'none') : decideIntervention(review, consecutiveBad, Date.now() - lastSkip);
      let acted = '';
      if (chosen !== 'none' && !values['no-act']) {
        acted = `${chosen}: ${await intervene(chosen, new MicrobotBackend(), review.diagnosis)}`;
        if (chosen === 'skip_activity') {
          lastSkip = Date.now();
          consecutiveBad = 0;
        }
        console.log(`[watch] acted -> ${acted}`);
      }
      const record = { acted: acted || undefined, ts: new Date().toISOString(), char: values.char, run: ev.run, activity: ev.activity.replace(/^.*?▶\s*/, '').slice(0, 160), model: llm.name, ...review, evidence: unchanged === 0 ? ev.text.slice(-6000) : undefined };
      appendFileSync(outFile, `${JSON.stringify(record)}\n`);
      // The rescue inside the run reads this (src/llm/watchFeed.ts).
      writeFileSync(path.join(outDir, 'latest.json'), JSON.stringify(record));
      console.log(`[watch] ${record.ts.slice(11, 19)} ${review.status} (sev ${review.severity}) ${review.diagnosis}${review.suggestion ? ` => ${review.suggestion}` : ''}`);
    } catch (e) {
      console.error(`[watch] review failed: ${e instanceof Error ? e.message : e}`);
    }
    if (values.once) return;
    await new Promise((r) => setTimeout(r, interval));
  }
}

if (process.argv[1]?.endsWith('watcher.ts')) await main();
