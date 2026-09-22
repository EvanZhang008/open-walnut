/**
 * Human-readable schedule formatting for routine cards, in the style of the
 * Claude cloud app: "Weekdays at 5:30 AM · Next run tomorrow at 5:30 AM".
 * Lives in the frontend so phrasing uses the viewer's locale/clock.
 */

import type { RoutineAuditEntry, RoutineCheck, RoutineLastCheck, RoutineSchedule, RoutineState, RoutineWake } from '@/api/routines';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime(hour: number, minute: number): string {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Describe a 5-field cron expr in plain English; null if it's not a simple daily/weekly pattern. */
function describeCronExpr(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d{1,2}$/.test(min)) return null;
  if (dom !== '*' || mon !== '*') return null;
  // Hourly pattern: fixed minute, any hour
  if (hour === '*') {
    return dow === '*' ? `Hourly at :${min.padStart(2, '0')}` : null;
  }
  if (!/^\d{1,2}$/.test(hour)) return null;
  const time = formatTime(Number(hour), Number(min));

  if (dow === '*') return `Every day at ${time}`;
  if (dow === '1-5') return `Weekdays at ${time}`;
  if (dow === '0,6' || dow === '6,0') return `Weekends at ${time}`;
  if (/^\d$/.test(dow)) return `${DAY_NAMES[Number(dow)]}s at ${time}`;
  if (/^\d(,\d)+$/.test(dow)) {
    const days = dow.split(',').map((d) => DAY_NAMES[Number(d)]?.slice(0, 3)).filter(Boolean);
    return `${days.join('/')} at ${time}`;
  }
  return null;
}

export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === 'at') {
    const d = new Date(schedule.at);
    return `Once at ${d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
  }
  if (schedule.kind === 'every') {
    // A check may poll faster than a minute (floor 10s); rounding 30s up to
    // "1 min" misstated the cadence the user asked for.
    if (schedule.everyMs < 60_000) return `Every ${Math.round(schedule.everyMs / 1000)}s`;
    const mins = Math.round(schedule.everyMs / 60_000);
    if (mins < 60) return `Every ${mins} min`;
    const hours = mins / 60;
    return Number.isInteger(hours) ? `Every ${hours} hour${hours > 1 ? 's' : ''}` : `Every ${mins} min`;
  }
  return describeCronExpr(schedule.expr) ?? `Cron: ${schedule.expr}`;
}

export function describeNextRun(state: RoutineState | undefined): string | null {
  const next = state?.nextRunAtMs;
  if (!next) return null;
  const d = new Date(next);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const target = new Date(d); target.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  if (dayDiff === 0) {
    const inMs = next - now.getTime();
    if (inMs < 60_000) return 'Next run in <1 min';
    if (inMs < 3_600_000) return `Next run in ${Math.round(inMs / 60_000)} min`;
    return `Next run today at ${time}`;
  }
  if (dayDiff === 1) return `Next run tomorrow at ${time}`;
  if (dayDiff < 7) return `Next run ${DAY_NAMES[d.getDay()]} at ${time}`;
  return `Next run ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/**
 * "after 20 new items" — the counter half of a wake routine's trigger.
 * Null when there is nothing to say: no events, or a threshold of 0 (clock only).
 */
export function describeWake(wake: RoutineWake | undefined): string | null {
  if (!wake || !Array.isArray(wake.events) || wake.events.length === 0) return null;
  const n = wake.threshold;
  if (!Number.isFinite(n) || n <= 0) return null;
  return `after ${n} new item${n === 1 ? '' : 's'}`;
}

/** "Weekdays at 5:30 AM · Next run tomorrow at 5:30 AM · or after 20 new items" */
export function describeRoutineTiming(
  schedule: RoutineSchedule,
  state?: RoutineState,
  wake?: RoutineWake,
): string {
  const parts = [describeSchedule(schedule)];
  const next = describeNextRun(state);
  if (next) parts.push(next);
  // The clock is not the whole trigger for a wake routine, and a card that shows
  // only the interval reads as "this runs twice a day" when it can run any time.
  const counter = describeWake(wake);
  if (counter) parts.push(`or ${counter}`);
  return parts.join(' · ');
}

/** "3m ago" / "just now" / "2h ago" for the card's last-check line. */
export function describeAgo(atMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(atMs)) return 'at an unknown time';
  const diff = Math.max(0, nowMs - atMs);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/** "fired, 2 items, 3m ago" / "quiet, 3m ago" / "error: exit 1: ..., 3m ago" / "not checked yet". */
export function describeLastCheck(last: RoutineLastCheck | undefined, nowMs = Date.now()): string {
  if (!last) return 'not checked yet';
  const ago = describeAgo(last.atMs, nowMs);
  if (last.outcome === 'fired') {
    const n = last.items ?? 0;
    const what = n > 0 ? `fired, ${n} item${n === 1 ? '' : 's'}` : 'fired';
    // The delivery failed transiently and the daemon will replay the fire.
    if (last.retryPending) return `${what}, delivery retrying, ${ago}`;
    // A fire that fired but never landed said only "fired, 2 items" here while the
    // audit row said "not delivered": the card was the one a user sees first.
    if (last.error) return `${what} but not delivered, ${ago}`;
    return `${what}, ${ago}`;
  }
  if (last.outcome === 'error') {
    const msg = (last.error ?? 'check failed').replace(/\s+/g, ' ').trim();
    return `error: ${msg.length > 80 ? `${msg.slice(0, 80)}…` : msg}, ${ago}`;
  }
  return last.reason === 'rate-limited' ? `quiet (daily fire limit), ${ago}` : `quiet, ${ago}`;
}

/** The check command as a one-line label: "$ gh pr view … @ clouddev". */
export function describeCheck(check: RoutineCheck): string {
  const run = check.run.replace(/\s+/g, ' ').trim();
  const short = run.length > 60 ? `${run.slice(0, 60)}…` : run;
  const host = check.host && check.host !== '__local__' ? check.host : 'local';
  return `$ ${short} @ ${host}`;
}

/** Badge text: "Claude Code @ clouddev" / "Home Chat" / "Walnut Agent". */
export function describeExecutorBadge(
  executor: { type: string; config: Record<string, unknown> } | undefined,
  executorLabels: Record<string, string>,
): string {
  if (!executor) return 'Walnut Agent';
  const label = executorLabels[executor.type] ?? executor.type;
  const host = executor.config?.host;
  if (executor.type === 'claude-code') {
    return typeof host === 'string' && host ? `${label} @ ${host}` : `${label} @ local`;
  }
  return label;
}

// ── Trigger audit trail (state.checkLog / state.fireLog) ──

/** Local clock time for an audit row: the "when" a human scans for. */
export function auditClock(atMs: number): string {
  if (!Number.isFinite(atMs)) return '--:--';
  return new Date(atMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * One audit row as a sentence: what the check decided and, for a fire, where the
 * message went. Never says "delivered" for a fire the daemon still owns — a
 * retrying delivery has not landed, and reading it as landed is how a lost fire
 * gets mistaken for a delivered one.
 */
export function describeAuditEntry(entry: RoutineAuditEntry): string {
  if (entry.outcome === 'error') {
    const msg = (entry.error ?? 'check failed').replace(/\s+/g, ' ').trim();
    return `check error: ${msg.length > 90 ? `${clip(msg, 90)}…` : msg}`;
  }
  if (entry.outcome === 'quiet') {
    if (entry.reason === 'rate-limited') return 'quiet — daily fire limit reached';
    if (entry.reason === 'all-seen') return 'quiet — nothing new (all items already seen)';
    return 'quiet — the script said no';
  }
  const n = entry.items ?? 0;
  const what = n > 0 ? `fired, ${n} new item${n === 1 ? '' : 's'}` : 'fired';
  const d = entry.delivery;
  if (!d) return what;
  const tries = (entry.attempts ?? 1) > 1 ? ` after ${entry.attempts} tries` : '';
  if (d.status === 'retrying') return `${what} → delivery retrying${tries}`;
  if (d.status === 'error') {
    const why = (d.error ?? entry.error ?? 'unknown error').replace(/\s+/g, ' ').trim();
    const short = why.length > 80 ? `${clip(why, 80)}…` : why;
    return `${what} → not delivered${tries}: ${short}`;
  }
  return `${what} → ${auditTarget(d.summary)}${tries}`;
}

/** Longest "where it went" clause an audit row prints before clamping. */
const AUDIT_TARGET_MAX = 56;

/**
 * The "where it went" half of an audit line, kept to one readable clause.
 *
 * The summary names a session by its handle, and a session title is whatever the
 * user or the launch put there, so the clause needs a bound. The envelope cut is
 * for the rows already on disk: a session a trigger started used to be named
 * after its launch message, which for a trigger IS the `<walnut-message>`
 * envelope, so those stored summaries bury the verdict behind markup (measured on
 * prod: a 100-character row). New launches are titled after the trigger instead.
 */
export function auditTarget(summary: string | undefined): string {
  const raw = (summary ?? 'delivered').replace(/\s+/g, ' ').trim();
  const cut = raw.split('<walnut-message')[0].replace(/[—-]\s*$/, '').trim() || 'delivered';
  if (cut.length <= AUDIT_TARGET_MAX) return cut;
  // A session handle ends in the id that identifies it, so the id is the one
  // part a clamp may not eat: cutting mid-id ("… [42eb…") names no session at
  // all. Same rule sessionHandle applies on the server - cap the title, then
  // append the id - and the reason a long title cannot push it off the line.
  // The bracket run is bounded, so there is always room for words in front of it.
  const handle = /\s(\[[^\s\]]{1,12}\])$/.exec(cut);
  if (handle) {
    const head = cut.slice(0, cut.length - handle[0].length);
    return `${clip(head, AUDIT_TARGET_MAX - handle[1].length - 2)}… ${handle[1]}`;
  }
  return `${clip(cut, AUDIT_TARGET_MAX)}…`;
}

/** Slice that never leaves half an astral character behind (a session title can
 *  hold an emoji, and a lone surrogate renders as a replacement glyph). */
function clip(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The pill/flyout headline: has this trigger ever actually fired, and when. This
 * is the single line that answers "not sure if this works" — a trigger that has
 * only ever been quiet says so plainly rather than looking untested.
 */
export function describeFireTally(state: RoutineState | undefined, nowMs = Date.now()): string {
  // `lastFireSeq` is the fallback for a trigger that was already firing before the
  // audit trail existed: the daemon's seq counts fires in the current epoch, so it
  // is a floor on the total. It can also be a FLOOR ONLY - an epoch reset starts
  // the daemon's counter over - so this line says "at least" nothing and simply
  // prints the best number available.
  const fires = state?.fireLog ?? [];
  // The row-count fallback counts only fires the server RECORDED: a row still
  // being retried is not one of them, so counting it would claim a delivery the
  // daemon has not been acked for.
  const count = state?.fireCount ?? state?.lastFireSeq
    ?? fires.filter((f) => f.delivery?.status !== 'retrying').length;
  // A fire whose delivery is still being retried is NOT counted by the server
  // (the daemon still owns it), so it must not supply the "last" time either:
  // reading an unlanded fire as the newest landed one is the exact mistake this
  // line exists to prevent.
  const retrying = fires.some((f) => f.delivery?.status === 'retrying');
  if (!count) return retrying ? 'fired, delivery retrying' : 'never fired yet';
  const landed = fires.find((f) => f.delivery?.status !== 'retrying')?.atMs;
  const when = typeof landed === 'number' ? `, last ${describeAgo(landed, nowMs)}` : '';
  return `fired ${count}×${when}${retrying ? ', one delivery retrying' : ''}`;
}

/**
 * The rows the History fold shows, newest first: the recent checks, with each
 * fire appearing ONCE.
 *
 * Why a merge and not just `checkLog`: checkLog is short (recent activity) and a
 * fire's replayed attempt can arrive after the fire's own row has been pushed out
 * by quiet checks, which appends a second `fired` row for one fire. fireLog holds
 * only fires, so it keeps the surviving copy - preferring it makes one fire read
 * as one fire, at whatever attempt count it has reached.
 */
export function auditHistory(state: RoutineState | undefined): RoutineAuditEntry[] {
  const checks = state?.checkLog ?? [];
  const fires = state?.fireLog ?? [];
  const rows = checks.length ? checks : fires;
  const seen = new Set<string>();
  const out: RoutineAuditEntry[] = [];
  for (const row of rows) {
    if (row.outcome !== 'fired') { out.push(row); continue; }
    const key = `${row.epoch ?? ''}#${row.seq ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The fire-only list is never thinned by quiet checks, so its copy is the one
    // that carries the newest attempt count and delivery verdict.
    out.push(fires.find((f) => `${f.epoch ?? ''}#${f.seq ?? ''}` === key) ?? row);
  }
  return out;
}
