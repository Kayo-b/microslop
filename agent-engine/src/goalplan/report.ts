/**
 * `llm-report`: how much a plan run still leans on the LLM, and what to script next. Reads the
 * account's llm-calls.jsonl, rescues.jsonl and ledger.jsonl.
 */
import type { LlmCallRecord } from '../llm/tiered.ts';
import type { RescueOutcomeRecord, RescueRecord } from '../llm/rescue.ts';
import type { LedgerRecord } from './ledger.ts';

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-');

export function llmReport(calls: LlmCallRecord[], rescues: (RescueRecord | RescueOutcomeRecord)[], ledger: LedgerRecord[]): string[] {
  const out: string[] = [];
  const playedHours = ledger.reduce((h, r) => h + r.minutes / 60, 0);
  out.push(`Played: ${playedHours.toFixed(1)} h over ${ledger.length} phases; LLM calls: ${calls.length}${playedHours > 0 ? ` (${(calls.length / playedHours).toFixed(1)}/h)` : ''}`);

  const groups = new Map<string, LlmCallRecord[]>();
  for (const c of calls) groups.set(`tier ${c.tier} ${c.purpose}`, [...(groups.get(`tier ${c.tier} ${c.purpose}`) ?? []), c]);
  if (groups.size) out.push('', 'Calls by tier and purpose:');
  for (const [k, cs] of [...groups].sort()) {
    const ok = cs.filter((c) => c.result === 'ok').length;
    const latency = cs.reduce((n, c) => n + c.latencyMs, 0) / cs.length;
    const failed = cs.length - ok;
    out.push(`  ${k.padEnd(18)} ${String(cs.length).padStart(5)} calls  ${pct(ok, cs.length).padStart(4)} ok  ${failed ? `${failed} refused/over budget/error  ` : ''}avg ${(latency / 1000).toFixed(1)} s`);
  }

  const asked = rescues.filter((r): r is RescueRecord => r.kind === 'rescue');
  const outcomes = new Map(rescues.filter((r): r is RescueOutcomeRecord => r.kind === 'outcome').map((o) => [o.id, o]));
  if (asked.length) {
    out.push('', 'Rescues by trigger (sub-goal result after the rescue):');
    for (const trigger of ['impossible', 'stuck', 'loop'] as const) {
      const rs = asked.filter((r) => r.trigger === trigger);
      if (!rs.length) continue;
      const done = rs.filter((r) => outcomes.get(r.id)?.result === 'done').length;
      out.push(`  ${trigger.padEnd(10)} ${String(rs.length).padStart(4)}  ${pct(done, rs.length)} done`);
    }
    // Problems that keep coming back are the ones worth scripting.
    const byReason = new Map<string, RescueRecord[]>();
    for (const r of asked) {
      const key = `${r.planner}: ${r.reason.replace(/\d+/g, '#').slice(0, 110)}`;
      byReason.set(key, [...(byReason.get(key) ?? []), r]);
    }
    const top = [...byReason].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
    out.push('', 'Most frequent rescue reasons (script these next):');
    for (const [reason, rs] of top) {
      const done = rs.filter((r) => outcomes.get(r.id)?.result === 'done').length;
      out.push(`  ${String(rs.length).padStart(3)}x  ${pct(done, rs.length).padStart(4)} done  ${reason}`);
    }
  }

  const gaveUp = new Map<string, number>();
  for (const r of ledger) if (r.outcome === 'gave_up') gaveUp.set(r.phase, (gaveUp.get(r.phase) ?? 0) + 1);
  if (gaveUp.size) {
    out.push('', 'Phases that gave up:');
    for (const [phase, n] of [...gaveUp].sort((a, b) => b[1] - a[1]).slice(0, 10)) out.push(`  ${String(n).padStart(3)}x  ${phase}`);
  }
  return out;
}
