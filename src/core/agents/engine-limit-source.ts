/**
 * Where the fallback engine (fallback-engine.ts) reads whether an engine is out of usage, and the
 * words for that limit: one small seam, so the launch rule does not depend on how a usage limit is
 * tracked.
 *
 *   sessionLimitOf  one session's own usage-limit stop: none yet (a session row records no
 *                   limit), so only the host's reading counts until the usage-limit wait records
 *                   its stops here
 *   blockedLimitOf  the host's Claude subscription reading (sessions/subscription-limits.ts)
 *                   blocks a turn: rejected, with no extra usage to go on
 *   limitName       "Claude 5-hour limit", "Codex usage limit"
 *   limitTimeWords  "3:00 PM", "Thu 3:00 PM"
 *
 * Tests hand fallback-engine.ts their own sessionLimit (FallbackDeps), or set one for the whole
 * server with __setSessionLimitForTesting.
 */
import type { SessionRecord } from '../types.js';

/** One session's usage-limit stop, while it may still hold its engine. */
export interface SessionLimitReading {
  /** The window that limits ('five_hour', 'seven_day', 'seven_day_opus', ...). */
  window?: string;
  /** When the window resets (ISO); absent = the engine did not say. */
  resetsAt?: string;
  resetsFrom?: 'event' | 'text' | 'host';
  /** When the limit first stopped it, and the later words on it (ISO). */
  since: string;
  resumedAt?: string;
  offAt?: string;
  gaveUpAt?: string;
  /** When it is tried again (ISO), while it waits. */
  dueAt?: string;
}

type SessionLimitFn = (rec: SessionRecord, now: number) => SessionLimitReading | undefined;

let sessionLimitForTesting: SessionLimitFn | null = null;

/** A test's limits for every read of this server (null = the real reading). */
export function __setSessionLimitForTesting(fn: SessionLimitFn | null): void {
  sessionLimitForTesting = fn;
}

/** The usage-limit stop of one session, or undefined when the limit does not hold it. */
export function sessionLimitOf(rec: SessionRecord, now: number = Date.now()): SessionLimitReading | undefined {
  return sessionLimitForTesting ? sessionLimitForTesting(rec, now) : undefined;
}

/** A Claude `rate_limit_info` that blocks the turn: rejected, with no extra usage to fall back on. */
export function blockedLimitOf(info: {
  status: string; rateLimitType?: string; resetsAt?: number; overageStatus?: string; isUsingOverage?: boolean;
} | null | undefined): { resetsAt?: number; window?: string } | 'allowed' | null {
  if (!info) return null;
  if (info.status !== 'rejected') return 'allowed';
  if (info.overageStatus === 'allowed' || info.overageStatus === 'allowed_warning' || info.isUsingOverage) return 'allowed';
  return { ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}), ...(info.rateLimitType ? { window: info.rateLimitType } : {}) };
}

const ENGINE_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', goose: 'Goose', gemini: 'Gemini' };

function engineWords(engine: string | undefined): string {
  if (!engine) return 'The';
  return ENGINE_NAMES[engine] ?? `${engine.charAt(0).toUpperCase()}${engine.slice(1)}`;
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet',
  seven_day_overage_included: 'weekly', overage: 'extra usage',
};

/** "Claude 5-hour limit", "Codex usage limit". */
export function limitName(w: { engine: string; window?: string }): string {
  const win = w.window ? WINDOW_NAMES[w.window] ?? w.window.replace(/_/g, ' ') : '';
  if (win === 'extra usage') return `${engineWords(w.engine)} extra usage`;
  return `${engineWords(w.engine)} ${win ? `${win} ` : 'usage '}limit`;
}

/** "3:00 PM", "Thu 3:00 PM" past today, in this process's zone (the server's, the user's Mac). */
export function limitTimeWords(iso: string | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  // No-break spaces: "12:52 PM" and "Thu 12:52 PM" never wrap apart.
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, '\u00a0');
  return sameDay ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })}\u00a0${time}`;
}
