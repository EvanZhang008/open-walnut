/**
 * What Settings > Real Use (RealUseSection.tsx, RealUseTables.tsx, RealUseWatches.tsx) draws
 * from the real-use report (api/usage-watch.ts): the summary, the order of the rows, the words
 * of a row's detail, the watches' checks and states. Pure, so each rule has a unit test
 * (tests/web/real-use-model.test.ts).
 */
import type { NoticeTone } from '@/components/common/NoticeCard';
import { fmtTokenCount } from '@/components/sessions/session-cost-format';
import type { UsageKind, UsageNote, UsageRange, UsageRow, UsageRowAlarm, UsageTargetResult, UsageWatch, UsageWatchState } from '@/api/usage-watch';

/** Rows a table shows before its "Show all" (f1/f2 of the design). */
export const ROWS_SHOWN = 15;

export type ToolSort = 'problems' | 'calls' | 'name';
export const isToolSort = (v: unknown): v is ToolSort => v === 'problems' || v === 'calls' || v === 'name';
export const isUsageRange = (v: unknown): v is UsageRange => v === '24h' || v === '7d';

/**
 * The checks a watch runs when it names none (src/core/usage-watch/watches.ts DEFAULT_CHECKS; the
 * web build cannot import that file, and tests/web/real-use-model.test.ts keeps the two equal).
 */
export const DEFAULT_WATCH_CHECKS = { max_answer_chars: 20_000, max_fail_pct: 5, no_new_codes: true, max_p95_ms: 2_000, min_uses: 20 } as const;

export const rowKey = (r: Pick<UsageRow, 'kind' | 'name'>): string => `${r.kind}\t${r.name}`;
/** Errors and timeouts: the failures that are Walnut's, not the caller's or a host's. */
export const realErrors = (r: Pick<UsageRow, 'errors' | 'timeouts'>): number => r.errors + r.timeouts;
const inAlarm = (r: UsageRow): number => (r.alarm?.state === 'ALARM' ? 1 : 0);

const num = (n: number): string => n.toLocaleString('en-US');

/** A size in characters: 640, 12.6K, 1.2M; '-' when there is none. */
export function sizeText(n: number | null): string {
  return n === null ? '-' : fmtTokenCount(Math.round(n));
}

/** A time: 420 ms, 1.3 s, 2 s; '-' when there is none. */
export function msText(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`;
}

/** A share with one decimal (4.8%), or '' when there is nothing to share. */
export function pctText(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '';
  const v = (part / whole) * 100;
  return v < 0.1 ? '<0.1%' : `${v.toFixed(1)}%`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** A local time as `11-21 13:05`, or only `13:05` when it falls on the same day as `now`. */
export function stamp(ms: number, now?: number): string {
  const d = new Date(ms);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (now !== undefined) {
    const n = new Date(now);
    if (n.getFullYear() === d.getFullYear() && n.getMonth() === d.getMonth() && n.getDate() === d.getDate()) return clock;
  }
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

export const rangeWord = (range: UsageRange): string => (range === '7d' ? '7 days' : '24 hours');
export const stepWord = (range: UsageRange): string => (range === '7d' ? 'per day' : 'per 4 hours');

/** "recorded 93% of the time", only when part of the range was not recorded. */
export function recordedText(share: number): string | null {
  return share < 1 ? `recorded ${Math.floor(share * 100)}% of the time` : null;
}

/** Whether a find box's words match a name: case and the spaces, dashes or underscores between words do not matter (a dictated "thread update" finds thread_update). */
export function matchesFind(name: string, query: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const q = norm(query);
  return !q || norm(name).includes(q);
}

/**
 * What puts a row higher in "Problems first", most important first. A tool's bad arguments are the
 * caller's, not a problem of the tool's (core/usage-watch/agg.ts OUTCOME_SIDE): they never rank it.
 */
function problemKeys(r: UsageRow): number[] {
  if (r.kind === 'op') return [inAlarm(r), r.cut, realErrors(r), r.overLimit, r.calls];
  if (r.kind === 'http') return [inAlarm(r), r.serverErrors, r.slow, r.calls];
  return [inAlarm(r), r.calls];
}

/** The rows in the asked order; ties by name. Problems first: alarm, then cut, errors, over budget, then calls (for a tool). */
export function sortRows(rows: readonly UsageRow[], sort: ToolSort): UsageRow[] {
  const byName = (a: UsageRow, b: UsageRow) => a.name.localeCompare(b.name);
  const out = [...rows];
  if (sort === 'name') return out.sort(byName);
  if (sort === 'calls') return out.sort((a, b) => b.calls - a.calls || byName(a, b));
  return out.sort((a, b) => {
    const ka = problemKeys(a);
    const kb = problemKeys(b);
    for (let i = 0; i < ka.length; i++) if (kb[i]! !== ka[i]!) return kb[i]! - ka[i]!;
    return byName(a, b);
  });
}

export interface RealUseSummary { toolCalls: number; realErrors: number; cuts: number; overBudget: number; slowReads: number; pageErrors: number; alarms: number }

export function summaryOf(rows: readonly UsageRow[]): RealUseSummary {
  const s: RealUseSummary = { toolCalls: 0, realErrors: 0, cuts: 0, overBudget: 0, slowReads: 0, pageErrors: 0, alarms: 0 };
  for (const r of rows) {
    if (r.alarm?.state === 'ALARM') s.alarms++;
    if (r.kind === 'op') {
      s.toolCalls += r.calls;
      s.realErrors += realErrors(r);
      s.cuts += r.cut;
      s.overBudget += r.overLimit;
    } else if (r.kind === 'http') s.slowReads += r.slow;
    else s.pageErrors += r.calls;
  }
  return s;
}

/** A request whose slow reads are a tenth or more of it reads red. */
export const slowIsHigh = (r: Pick<UsageRow, 'calls' | 'slow'>): boolean => r.calls > 0 && r.slow / r.calls >= 0.1;

/**
 * "All 82 failures: host_unreachable 25, user_kind 11, ...": every code, most first. A request's
 * failures are its error answers (4xx, 5xx): a slow read is no failure, so it never says "No failures".
 */
export function failuresText(codes: Record<string, number>, what: 'failure' | 'error answer' = 'failure'): string {
  const list = Object.entries(codes).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = list.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return `No ${what}s.`;
  const words = list.map(([code, n]) => `${code} ${num(n)}`).join(', ');
  return total === 1 ? `1 ${what}: ${words}.` : `All ${num(total)} ${what}s: ${words}.`;
}

/** A request's reads that took 5 s or more, with its p95: "Slow: 2 of 7 reads took 5 s or more. 95% answered within 8.2 s." */
export function slowText(r: Pick<UsageRow, 'calls' | 'slow' | 'msP95'>): string | null {
  if (r.calls <= 0) return null;
  const p95 = r.msP95 === null ? '' : ` 95% answered within ${msText(r.msP95)}.`;
  if (r.slow <= 0) return `No read took 5 s or more.${p95}`;
  return `Slow: ${num(r.slow)} of ${num(r.calls)} read${r.calls === 1 ? '' : 's'} took 5 s or more.${p95}`;
}

export function sizesText(r: Pick<UsageRow, 'sizeP50' | 'sizeP95'>): string | null {
  if (r.sizeP50 === null || r.sizeP95 === null) return null;
  return `Half under ${sizeText(r.sizeP50)} characters, 95% under ${sizeText(r.sizeP95)}.`;
}

export function spilledText(n: number): string | null {
  if (n <= 0) return null;
  return `${num(n)} answer${n === 1 ? '' : 's'} over 60,000 characters ${n === 1 ? 'was' : 'were'} saved to a file by Walnut's MCP server.`;
}

/** The row's alarm in one sentence, with what Walnut did about it. */
export function alarmLine(a: UsageRowAlarm | null, now: number): string {
  if (!a) return 'No alarm has read it yet.';
  const since = stamp(a.since, now);
  const state = a.state === 'ALARM' ? `In alarm since ${since}` : a.state === 'OK' ? `No alarm since ${since}` : `Too little data for its alarms since ${since}`;
  return a.did ? `${state}. What Walnut did: ${a.did}` : `${state}.`;
}

export function alarmStatus(a: UsageRowAlarm | null): { tone: NoticeTone; text: string } {
  if (a?.state === 'ALARM') return { tone: 'error', text: 'Alarm' };
  if (a?.state === 'OK') return { tone: 'ok', text: 'No alarm' };
  return { tone: 'muted', text: 'No data' };
}

/**
 * A page error's kind in parts, the code-like ones monospace: "GET /api/x" + " failed in the page",
 * or "TypeError" + " in the " + "ThreadCard" + " code bundle" (the server says "chunk").
 */
export function pageKindParts(name: string): Array<{ text: string; mono: boolean }> {
  const req = /^((?:GET|POST|PUT|PATCH|DELETE) \/\S*) (.+)$/.exec(name);
  if (req) return [{ text: req[1]!, mono: true }, { text: ` ${req[2]}`, mono: false }];
  const thrown = /^(\S+) in the (\S+) chunk$/.exec(name);
  if (thrown) {
    return [{ text: thrown[1]!, mono: true }, { text: ' in the ', mono: false }, { text: thrown[2]!, mono: thrown[2] !== 'unknown' }, { text: ' code bundle', mono: false }];
  }
  return [{ text: name.replace(/ chunk$/, ' code bundle'), mono: false }];
}

const targetKind = (t: string): UsageKind => (t.startsWith('op:') ? 'op' : t.startsWith('route:') ? 'http' : 'page');

/** What a watch checks, in one sentence: the defaults for what it did not name. */
export function checksText(w: Pick<UsageWatch, 'checks' | 'targets' | 'exempt'> & { state?: UsageWatch['state'] }): string {
  if (w.state === 'unwatched') return 'Closed after it shipped, with nothing watching its real use';
  if (w.exempt) return `Exempt: ${w.exempt.kind.replace(/_/g, ' ')} · ${w.exempt.reason}`;
  const c = { ...DEFAULT_WATCH_CHECKS, ...w.checks };
  const kinds = new Set(w.targets.map(targetKind));
  const calls = kinds.has('op') || kinds.has('http');
  const out: string[] = [];
  if (kinds.has('op')) out.push(`largest answer ≤ ${num(c.max_answer_chars)} chars`);
  if (calls) out.push(`failures ≤ ${c.max_fail_pct}%`);
  if (calls && c.no_new_codes) out.push('no new error code');
  if (kinds.has('http')) out.push(`p95 ≤ ${msText(c.max_p95_ms)}`);
  if (kinds.has('page')) out.push('no page error');
  if (calls && c.min_uses !== DEFAULT_WATCH_CHECKS.min_uses) out.push(`at least ${num(c.min_uses)} uses each`);
  const text = out.join('; ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : '';
}

/** One target's result: "412 uses ✓", "9 uses: failures 11% over 5%", "no result yet". */
export function targetResultText(target: string, result: UsageTargetResult | undefined, state: UsageWatchState): string {
  if (!result) return state === 'watching' ? 'no result yet' : '';
  if (targetKind(target) === 'page') return result.ok ? 'no page error ✓' : result.notes.join('; ');
  const uses = `${num(result.uses)} use${result.uses === 1 ? '' : 's'}`;
  return result.ok ? `${uses} ✓` : `${uses}${result.notes.length ? `: ${result.notes.join('; ')}` : ''}`;
}

const WATCH_STATUS: Record<UsageWatchState, { tone: NoticeTone; text: string }> = {
  watching: { tone: 'live', text: 'Watching' },
  passed: { tone: 'ok', text: 'Passed' },
  failed: { tone: 'error', text: 'Failed' },
  too_little_use: { tone: 'muted', text: 'Too little use' },
  unknown: { tone: 'muted', text: 'Unknown' },
  exempt: { tone: 'muted', text: 'Exempt' },
  dropped: { tone: 'muted', text: 'Dropped' },
  unwatched: { tone: 'warn', text: 'Closed unwatched' },
};

export function watchStatus(state: UsageWatchState): { tone: NoticeTone; text: string } {
  return WATCH_STATUS[state] ?? { tone: 'muted', text: state };
}

/** "checks 11-22 13:02" while it watches, "checked 11-21 10:02" once judged. */
export function watchWhen(w: Pick<UsageWatch, 'state' | 'checkAt' | 'checkedAt'>, now: number): string {
  if (w.state === 'watching') return `checks ${stamp(w.checkAt, now)}`;
  return w.checkedAt ? `checked ${stamp(w.checkedAt, now)}` : '';
}

/**
 * Whom a note went to, when its task's title is not at hand (a task gone or archived, a copy of
 * the data): the name the send itself recorded (`told "Walnut VP"`), else the task's id.
 */
export function noteRecipientName(n: Pick<UsageNote, 'recipient' | 'recipientTitle' | 'detail'>): string {
  if (n.recipientTitle) return n.recipientTitle;
  const told = /^told "(.+)"$/.exec(n.detail ?? '');
  return told ? told[1]! : n.recipient;
}

export function noteStatus(n: Pick<UsageNote, 'state' | 'dueAt' | 'tries' | 'detail'>, now: number): { tone: NoticeTone; text: string } {
  if (n.state === 'sent') return { tone: 'ok', text: 'Sent' };
  if (n.state === 'pending') return { tone: 'live', text: `Next at ${stamp(n.dueAt, now)}` };
  const tries = `${n.tries} ${n.tries === 1 ? 'try' : 'tries'}`;
  return { tone: 'error', text: `Not delivered after ${tries}${n.detail ? `: ${n.detail}` : ''}` };
}

/** The hover text of a row's spark: each step's uses and problems. */
export function seriesTitle(r: Pick<UsageRow, 'kind' | 'series'>, range: UsageRange): string {
  const uses = r.series.map((p) => p.uses).join(', ');
  if (r.kind === 'page') return `Errors ${stepWord(range)}: ${uses}`;
  return `Uses ${stepWord(range)}: ${uses}. Problems: ${r.series.map((p) => p.bad).join(', ')}`;
}
