/**
 * What the Switch Model popover and the model pill say about a host's Claude
 * subscription limits (pure: the frame and the clock in, text out).
 *
 * Rules, each a promise to the user:
 *  - A host without a reading shows NOTHING: no empty meter, no zero. A host
 *    whose newest sign-in check says Bedrock, Vertex or an API key shows
 *    nothing older than that check (those sign-ins have no subscription limits).
 *  - A window whose reset time has passed shows as reset, never as the old
 *    percentage.
 *  - A reading older than AGE_SHOWN_AFTER_MS says how old it is.
 *  - The pill hint exists only while the newest status is a warning or a
 *    rejection that has not reset; a warning under 70% stays quiet, as the CLI
 *    keeps it quiet (a stale warning right after a weekly reset).
 *  - Extra usage is mentioned only when it is in use, or when the limit is hit
 *    and extra usage is unavailable too.
 */
import type { HostLimitFrame, LimitStatus, LimitWindow } from '@/api/subscription-limits';

export const AGE_SHOWN_AFTER_MS = 10 * 60_000;
/** The CLI's own WARNING_THRESHOLD (services/rateLimitMessages.ts). */
export const WARNING_HINT_MIN_UTILIZATION = 0.7;
/** A status with no reset time to expire on stops counting after the shortest window. */
const STATUS_WITHOUT_RESET_TTL_MS = 5 * 60 * 60_000;

const ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included'];
const LABELS: Record<string, string> = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
  // The CLI names this per-model weekly bucket after the model it meters.
  seven_day_overage_included: 'Weekly Fable limit',
  // The limiting window is the account's extra usage itself (the CLI: "usage credit limit").
  overage: 'Usage credit limit',
};
const OVERAGE_REASONS: Record<string, string> = {
  out_of_credits: 'out of credits',
  org_level_disabled: 'off for your organization',
  org_level_disabled_until: 'paused for your organization',
  member_level_disabled: 'off for your account',
  overage_not_provisioned: 'not set up',
};

export type LimitRowState = 'ok' | 'warning' | 'rejected' | 'reset';

export interface LimitRow {
  type: string;
  label: string;
  /** "72%", "reached", or absent (the CLI did not report a number). */
  value?: string;
  /** "resets 3:40 PM", "resets Tue", "reset". */
  when?: string;
  /** "as of 2h ago" when the reading is old. */
  age?: string;
  state: LimitRowState;
  title: string;
}

export interface LimitReadout {
  rows: LimitRow[];
  overage?: { text: string; state: 'ok' | 'warning' | 'rejected' };
  /** The pill's dot: only for a live warning or rejection. */
  hint: { level: 'warning' | 'rejected'; text: string } | null;
}

export interface FormatOpts {
  locale?: string;
  timeZone?: string;
}

export function limitLabel(type: string | undefined): string {
  if (!type) return 'Usage limit';
  if (LABELS[type]) return LABELS[type];
  const words = type.replace(/_/g, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} limit`;
}

function fmt(at: number, opts: FormatOpts, parts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(opts.locale, { ...parts, ...(opts.timeZone ? { timeZone: opts.timeZone } : {}) }).format(new Date(at));
}

/** "3:40 PM" within the next 20 hours, "Tue" within the week, "Oct 9" beyond. */
export function formatResetTime(at: number, now: number, opts: FormatOpts = {}): string {
  const ahead = at - now;
  if (ahead < 20 * 60 * 60_000) return fmt(at, opts, { hour: 'numeric', minute: '2-digit' });
  if (ahead < 6.5 * 24 * 60 * 60_000) return fmt(at, opts, { weekday: 'short' });
  return fmt(at, opts, { month: 'short', day: 'numeric' });
}

function fullTime(at: number, opts: FormatOpts): string {
  return fmt(at, opts, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "12m ago", "3h ago", "2d ago". */
export function formatAge(ms: number): string {
  const m = Math.max(1, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const pctOf = (u: number) => `${Math.round(u * 100)}%`;

/** Readings the host's newest sign-in check rules out (Bedrock, an API key, ...). */
function ruledOut(frame: HostLimitFrame, seenAt: number): boolean {
  if (frame.signIn?.kind !== 'other') return false;
  // A reading newer than the check proves a subscription at that time: it wins.
  return frame.signIn.checkedAt === undefined || seenAt <= frame.signIn.checkedAt;
}

function liveStatus(frame: HostLimitFrame, now: number): { status: LimitStatus; type?: string; utilization?: number; resetsAt?: number } | null {
  const c = frame.current;
  if (!c || ruledOut(frame, c.seenAt)) return null;
  if (c.resetsAt !== undefined ? c.resetsAt <= now : now - c.seenAt > STATUS_WITHOUT_RESET_TTL_MS) return null;
  return c;
}

function rowFor(w: LimitWindow, live: ReturnType<typeof liveStatus>, now: number, opts: FormatOpts): LimitRow {
  const label = limitLabel(w.type);
  const expired = w.resetsAt !== undefined && w.resetsAt <= now;
  const status = live && live.type === w.type ? live.status : 'allowed';
  const u = w.utilization ?? live?.utilization;
  // A low-usage warning stays quiet here too, the same rule as the pill.
  const warns = status === 'allowed_warning' && !(u !== undefined && u < WARNING_HINT_MIN_UTILIZATION);
  const state: LimitRowState = expired ? 'reset' : status === 'rejected' ? 'rejected' : warns ? 'warning' : 'ok';
  const value = expired ? undefined
    : w.utilization !== undefined ? pctOf(w.utilization)
    : state === 'rejected' ? 'reached' : undefined;
  const when = expired ? 'reset'
    : w.resetsAt !== undefined ? `resets ${formatResetTime(w.resetsAt, now, opts)}` : undefined;
  const old = now - w.seenAt > AGE_SHOWN_AFTER_MS;
  const age = !expired && old ? `as of ${formatAge(now - w.seenAt)}` : undefined;
  const title = [
    expired
      ? `${label}: reset ${fullTime(w.resetsAt!, opts)}. A new window starts with the next request.`
      : `${label}: ${w.utilization !== undefined ? `${pctOf(w.utilization)} used` : state === 'rejected' ? 'reached' : 'usage not reported yet'}${w.resetsAt !== undefined ? `, resets ${fullTime(w.resetsAt, opts)}` : ''}.`,
    `Reported by Claude Code ${formatAge(Math.max(0, now - w.seenAt))}.`,
  ].join(' ');
  return { type: w.type, label, ...(value ? { value } : {}), ...(when ? { when } : {}), ...(age ? { age } : {}), state, title };
}

function overageLine(frame: HostLimitFrame, live: ReturnType<typeof liveStatus>, now: number, opts: FormatOpts): LimitReadout['overage'] {
  const o = frame.overage;
  if (!o || ruledOut(frame, o.seenAt)) return undefined;
  if (o.resetsAt !== undefined && o.resetsAt <= now) return undefined;
  const resets = o.resetsAt !== undefined ? ` · resets ${formatResetTime(o.resetsAt, now, opts)}` : '';
  if (o.isUsingOverage) {
    if (o.status === 'rejected') return { text: `Extra usage used up${resets}`, state: 'rejected' };
    if (o.status === 'allowed_warning') return { text: `Extra usage nearly used up${resets}`, state: 'warning' };
    return { text: `Using extra usage${resets}`, state: 'ok' };
  }
  if (live?.status === 'rejected' && o.status === 'rejected') {
    const why = o.disabledReason ? OVERAGE_REASONS[o.disabledReason] : undefined;
    return { text: `Extra usage unavailable${why ? `: ${why}` : ''}`, state: 'rejected' };
  }
  return undefined;
}

function hintFor(frame: HostLimitFrame, live: ReturnType<typeof liveStatus>, now: number, opts: FormatOpts): LimitReadout['hint'] {
  const overage = frame.overage && !ruledOut(frame, frame.overage.seenAt) ? frame.overage : undefined;
  if (live) {
    const label = limitLabel(live.type);
    const resets = live.resetsAt !== undefined ? ` · resets ${formatResetTime(live.resetsAt, now, opts)}` : '';
    if (live.status === 'rejected') {
      // Past the limit but running on extra usage: worth a look, not a stop.
      if (overage?.isUsingOverage && overage.status !== 'rejected') return { level: 'warning', text: `${label} reached · using extra usage` };
      return { level: 'rejected', text: `${label} reached${resets}` };
    }
    if (live.status === 'allowed_warning') {
      const u = live.utilization ?? (live.type ? frame.windows[live.type]?.utilization : undefined);
      if (u !== undefined && u < WARNING_HINT_MIN_UTILIZATION) return null;
      return { level: 'warning', text: `${label}${u !== undefined ? ` ${pctOf(u)} used` : ' nearly reached'}${resets}` };
    }
  }
  if (overage?.isUsingOverage && overage.status === 'allowed_warning' && !(overage.resetsAt !== undefined && overage.resetsAt <= now)) {
    return { level: 'warning', text: 'Extra usage nearly used up' };
  }
  return null;
}

/** The whole readout for one host, or null when there is nothing to show. */
export function computeLimitReadout(frame: HostLimitFrame | null | undefined, now: number, opts: FormatOpts = {}): LimitReadout | null {
  if (!frame) return null;
  const live = liveStatus(frame, now);
  const windows = Object.values(frame.windows ?? {})
    .filter((w) => w && typeof w.type === 'string' && !ruledOut(frame, w.seenAt))
    .sort((a, b) => {
      const ia = ORDER.indexOf(a.type);
      const ib = ORDER.indexOf(b.type);
      return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib) || a.type.localeCompare(b.type);
    });
  const rows = windows.map((w) => rowFor(w, live, now, opts));
  const overage = overageLine(frame, live, now, opts);
  if (rows.length === 0 && !overage) return null;
  return { rows, ...(overage ? { overage } : {}), hint: hintFor(frame, live, now, opts) };
}
