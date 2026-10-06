/**
 * One-screen status of a running campaign for whoever watches it (a person or a monitoring agent):
 * what is running, how the LLM rescues are doing (by model, trigger and reason), what the gold
 * routes earn, what is being skipped, and alerts that need a look. Read-only.
 *
 *   npm run agent -- monitor [--since 2026-10-06T10:00] [--hours 2]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { type LedgerRecord, readJsonl } from '../goalplan/ledger.ts';
import type { RescueOutcomeRecord, RescueRecord } from '../llm/rescue.ts';
import { recentFailures } from '../strategy/skips.ts';

export interface MonitorInput {
  now: number;
  since: number;
  unitActive: string;
  campaignDir: string | null;
  campaignLog: string[];
  /** Latest activity log of the campaign: name and lines. */
  activity: { name: string; lines: string[]; modifiedAt: number } | null;
  rescues: (RescueRecord | RescueOutcomeRecord)[];
  gold: LedgerRecord[];
  skipping: string[];
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const short = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (now: number, t: number) => `${Math.round((now - t) / 60_000)} min ago`;

function proposalText(r: RescueRecord): string {
  const p = r.proposal;
  if (p.kind === 'subgoal') return p.subgoal.text;
  return `${p.kind}${'reason' in p && p.reason ? `: ${p.reason}` : ''}`;
}

export function monitorReport(m: MonitorInput): string[] {
  const out: string[] = [];
  const alerts: string[] = [];
  out.push(`== Campaign (unit microbot-jev-data: ${m.unitActive}) since ${new Date(m.since).toISOString().slice(0, 16)}Z`);
  if (m.campaignDir) out.push(`logs: ${m.campaignDir}`);
  for (const l of m.campaignLog.slice(-4)) out.push(`  ${short(l, 160)}`);

  if (m.activity) {
    const phase = [...m.activity.lines].reverse().find((l) => l.startsWith('[strategy]') && !l.includes('phase ended'));
    out.push('', `== Current activity: ${m.activity.name} (log updated ${ago(m.now, m.activity.modifiedAt)})`);
    if (phase) out.push(`  phase: ${short(phase.replace(/^\[strategy\] /, ''), 160)}`);
    for (const l of m.activity.lines.filter((x) => x.trim()).slice(-6)) out.push(`  ${short(l, 160)}`);
    if (m.unitActive === 'active' && m.now - m.activity.modifiedAt > 10 * 60_000) alerts.push(`activity log silent for ${ago(m.now, m.activity.modifiedAt).replace(' ago', '')}: the agent may be hung`);
  }

  const asked = m.rescues.filter((r): r is RescueRecord => r.kind === 'rescue' && Date.parse(r.ts) >= m.since);
  const outcomes = new Map(m.rescues.filter((r): r is RescueOutcomeRecord => r.kind === 'outcome').map((o) => [o.id, o]));
  const done = (rs: RescueRecord[]) => rs.filter((r) => outcomes.get(r.id)?.result === 'done').length;
  const settled = (rs: RescueRecord[]) => rs.filter((r) => outcomes.has(r.id)).length;
  out.push('', `== LLM rescues: ${asked.length} (${done(asked)} done of ${settled(asked)} settled, ${pct(done(asked), settled(asked))})`);
  const group = (key: (r: RescueRecord) => string) => {
    const g = new Map<string, RescueRecord[]>();
    for (const r of asked) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
    return [...g].sort((a, b) => b[1].length - a[1].length);
  };
  for (const [model, rs] of group((r) => r.rescuer)) out.push(`  model ${model.padEnd(28)} ${String(rs.length).padStart(3)}  ${pct(done(rs), settled(rs)).padStart(4)} done`);
  for (const [trigger, rs] of group((r) => r.trigger)) out.push(`  trigger ${trigger.padEnd(26)} ${String(rs.length).padStart(3)}  ${pct(done(rs), settled(rs)).padStart(4)} done`);
  const errors = asked.filter((r) => r.proposal.kind === 'error');
  if (errors.length) {
    out.push(`  LLM errors: ${errors.length} (last: ${short((errors.at(-1)!.proposal as { reason: string }).reason)})`);
    if (errors.length >= 3) alerts.push(`${errors.length} rescue calls errored (model unavailable or timing out?)`);
  }
  const reasons = group((r) => r.reason.replace(/\d+/g, '#').slice(0, 80)).filter(([, rs]) => rs.length >= 2).slice(0, 5);
  if (reasons.length) out.push('  recurring:');
  for (const [reason, rs] of reasons) {
    out.push(`    ${String(rs.length).padStart(2)}x ${pct(done(rs), settled(rs)).padStart(4)} done  ${reason}`);
    if (rs.length >= 3 && done(rs) === 0) alerts.push(`rescue never helps with "${short(reason, 70)}" (${rs.length}x): needs a code fix`);
  }
  if (asked.length) out.push('  latest:');
  for (const r of asked.slice(-5)) {
    const o = outcomes.get(r.id);
    out.push(`    ${r.ts.slice(11, 16)} ${r.trigger}: ${short(r.reason, 60)}`);
    out.push(`          -> ${short(proposalText(r), 80)} => ${o ? `${o.result}${o.result === 'done' ? '' : ` (${short(o.reason, 50)})`}` : 'pending'}`);
  }
  if (settled(asked) >= 5 && done(asked) / settled(asked) < 0.3) alerts.push(`rescue success ${pct(done(asked), settled(asked))} (under 30%)`);

  const gold = m.gold.filter((r) => Date.parse(r.ts) >= m.since);
  if (gold.length) {
    out.push('', '== Gold phases (coins change carried + last seen banked):');
    const byPhase = new Map<string, LedgerRecord[]>();
    for (const r of gold) byPhase.set(r.phase, [...(byPhase.get(r.phase) ?? []), r]);
    let coins = 0;
    let minutes = 0;
    for (const [phase, rs] of [...byPhase].sort()) {
      const c = rs.reduce((n, r) => n + (r.coins ?? 0), 0);
      const min = rs.reduce((n, r) => n + r.minutes, 0);
      coins += c;
      minutes += min;
      const outs = ['done', 'over', 'gave_up'].map((k) => `${rs.filter((r) => r.outcome === k).length}${k[0]}`).join('/');
      out.push(`  ${phase.padEnd(26)} ${String(rs.length).padStart(2)} runs ${outs.padEnd(9)} ${String(Math.round(min)).padStart(4)} min ${String(c).padStart(8)} coins ${min > 1 ? `${Math.round((c / min) * 60)}/h` : ''}`);
    }
    out.push(`  total ${Math.round(minutes)} min, ${coins} coins${minutes > 1 ? ` (${Math.round((coins / minutes) * 60)}/h)` : ''}`);
  }

  if (m.skipping.length) out.push('', `== Skipped (failed twice in 12 h): ${m.skipping.join(', ')}`);
  if (m.unitActive !== 'active' && m.unitActive !== 'activating') alerts.push(`campaign unit is ${m.unitActive}`);
  out.push('', alerts.length ? '== ALERTS' : '== No alerts');
  for (const a of alerts) out.push(`  ! ${a}`);
  return out;
}

/** Gathers the monitor input from the engine directory and systemd. */
export function readMonitorInput(root: string, o: { since?: number; now?: number } = {}): MonitorInput {
  const now = o.now ?? Date.now();
  const campaigns = path.join(root, 'logs', 'campaign');
  const dirs = existsSync(campaigns) ? readdirSync(campaigns).filter((d) => /^\d{4}-/.test(d)).sort() : [];
  const latest = dirs.at(-1);
  const dir = latest ? path.join(campaigns, latest) : null;
  // Campaign directories are named after their start: 2026-10-06T05-57-51-601Z.
  const started = latest ? Date.parse(latest.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z/, 'T$1:$2:$3.$4Z')) : now - 6 * 3_600_000;
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n') : []);
  const logs = dir ? readdirSync(dir).filter((f) => /^\d{3}-.*\.log$/.test(f)).sort() : [];
  const last = logs.at(-1);
  let unitActive = 'unknown';
  try {
    unitActive = execFileSync('systemctl', ['--user', 'is-active', 'microbot-jev-data'], { encoding: 'utf8' }).trim();
  } catch (e) {
    unitActive = (e as { stdout?: string }).stdout?.trim() || 'inactive';
  }
  return {
    now,
    since: o.since ?? started,
    unitActive,
    campaignDir: dir,
    campaignLog: dir ? read(path.join(dir, 'campaign.log')).filter(Boolean) : [],
    activity: dir && last ? { name: last.replace(/\.log$/, ''), lines: read(path.join(dir, last)), modifiedAt: statSync(path.join(dir, last)).mtimeMs } : null,
    rescues: readJsonl<RescueRecord | RescueOutcomeRecord>(path.join(root, 'data', 'rescues.jsonl')),
    gold: readJsonl<LedgerRecord>(path.join(root, 'data', 'gold-ledger.jsonl')),
    skipping: [...recentFailures(path.join(root, 'data', 'strategy-failures.json'), now)],
  };
}
