/**
 * One host outage, told once per kind of line.
 *
 * While a remote host's link is down, every session on it that tries to start,
 * resume or attach fails with the same host fact (the pool's cached "Connection
 * to <host> failed 0s ago: ..."). Each of those sessions logged it again at warn
 * or error: on 2026-11-14 an expired SSH proxy login on one host gave 280
 * "session: transport start failed" errors in four hours from 27 sessions, every
 * one the same replay of one cause, and the health monitor's log-spike alarm
 * rang for it. The outage itself is told once already: the notification bridge
 * folds such lines into one host card (log-error-bridge.ts, keyed by the same
 * causeKeyForError), the host's status and its sign-in alert say it.
 *
 * So the first line of each (host, level, subsystem, message) inside a window
 * keeps its level; a repeat of it within the window is written at info, carrying
 * `outageRepeat: 'host:<alias>'` so a reader of the log sees why. Only lines
 * whose text names the link being down (the same test the bridge's host card
 * uses) and a non-local host are touched; an error only when the bridge would
 * fold it into that card anyway (inHostCard), so no card is lost. Every other
 * line is unchanged.
 *
 * The dial of a host's link says so itself: a line that carries `linkFailure` (the
 * one-line summary of why the link would not come up) and `host` is the producer of
 * that outage, whatever its words. A host whose SSH login expired is dialled again
 * every minute by whoever needs it (the pool caches a failure for 60s), and on
 * 2026-11-14 each of those dials wrote "DaemonConnection: connect failed" at warn
 * again, 50 an hour for one expired certificate, and the log-spike alarm rang. Its
 * repeats are folded the same way, keyed by the summary too, so a NEW cause (the
 * login renewed, now the network is down) is told at once.
 *
 * A name this machine cannot look up is one outage too, whoever asks for it. When
 * the Mac lost its DNS for six hours (2026-11-19), git-sync's fetch, its bundle
 * push, a task plugin's HTTP client and the host probes each warned on every
 * retry ("Could not resolve host: <name>", "getaddrinfo ENOTFOUND <name>"), ~110
 * an hour per kind, and six log-spike alarms rang for one cause. A warn whose
 * text names a failed lookup of a name is folded the same way, keyed `dns:<name>`
 * (errors keep their level: they raise cards of their own).
 *
 * The memory lives on globalThis, as the logger's sink and tap do (subsystem.ts):
 * a plugin bundle has its own copy of this module and must share one outage.
 * The error-cause helpers it reads are pure.
 */
import { causeKeyForError, linkCauseKey, namesLinkDown } from '../core/notifications/error-cause.js';

/** How long one told line covers its repeats. Past it the outage is told again (twice an hour at most per kind). */
export const OUTAGE_REPEAT_WINDOW_MS = 30 * 60_000;
/** Bound on remembered kinds: a runaway set of messages must not grow this map without end. */
const MAX_REMEMBERED = 2_000;
/** Bound on the text read per string field: the test needs only the head of an error. */
const MAX_FIELD_CHARS = 2_000;

const TOLD_KEY = Symbol.for('open-walnut.outageRepeats');
type GlobalWithTold = { [TOLD_KEY]?: Map<string, number> };
function toldMap(): Map<string, number> {
  const g = globalThis as GlobalWithTold;
  return (g[TOLD_KEY] ??= new Map());
}

/** The meta fields the bridge reads a cause from (log-error-bridge.ts causeText), the same here. */
const CAUSE_FIELDS = ['error', 'err', 'reason', 'cause', 'detail', 'message'] as const;

function outageText(message: string, meta?: Record<string, unknown>): string {
  const parts = [message];
  for (const k of CAUSE_FIELDS) {
    const v = meta?.[k];
    if (typeof v === 'string' && v) parts.push(v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) : v);
  }
  return parts.join('\n');
}

/**
 * A failed name lookup and the name it was for: node's resolver (getaddrinfo, also
 * inside a DNSException), curl's (git over https: "Could not resolve host: <name>")
 * and ssh's ("Could not resolve hostname <name>: ...").
 */
const DNS_FAILURE_RES: RegExp[] = [
  /getaddrinfo E(?:NOTFOUND|AI_AGAIN) ([\w.-]+)/i,
  /could not resolve host(?:name)?:? ([\w.-]+)/i,
];

/** The name a failed lookup in `text` was for, or null when the text names none. */
export function failedLookupName(text: string): string | null {
  for (const re of DNS_FAILURE_RES) {
    const name = re.exec(text)?.[1]?.replace(/\.+$/, '').toLowerCase();
    if (name && name !== 'localhost') return name;
  }
  return null;
}

/**
 * An error line the bridge folds into the host's one outage card: a session-family
 * condition (its recoveryKeyOf: no explicit key or plugin of its own, a `session`/`obs`
 * line naming its session or task). Any other error keeps a card of its own, so it is
 * never folded here; a warn makes no card, so any warn may be.
 */
function inHostCard(subsystem: string, meta?: Record<string, unknown>): boolean {
  const explicit = meta?.recoveryKey;
  if (typeof explicit === 'string' && explicit.trim()) return /^(session|task):/.test(explicit.trim());
  if (typeof meta?.pluginId === 'string' && meta.pluginId.trim()) return false;
  const root = subsystem.split('/')[0]?.trim();
  if (root !== 'session' && root !== 'obs') return false;
  const id = (v: unknown) => typeof v === 'string' && !!v.trim();
  return id(meta?.sessionId) || id(meta?.taskId);
}

/**
 * The cause this warn/error line only repeats (`host:<alias>`, or `dns:<name>` for a
 * warn about a name that will not resolve), or null when it is news: about neither, the first of its kind in the window, or the
 * window ran out. Records the line as told when it is news about a link.
 */
export function outageRepeatOf(
  level: 'warn' | 'error',
  subsystem: string,
  message: string,
  meta: Record<string, unknown> | undefined,
  now: number = Date.now(),
): string | null {
  if (level === 'error' && !inHostCard(subsystem, meta)) return null;
  const hostHint = typeof meta?.host === 'string' ? meta.host : undefined;
  const linkFailure = meta?.linkFailure;
  if (typeof linkFailure === 'string') {
    const cause = linkCauseKey(hostHint);
    // Digits differ between two tellings of one cause (a port, a timeout, "42s ago").
    const sameCause = linkFailure.slice(0, MAX_FIELD_CHARS).replace(/\d+/g, '#');
    return cause ? toldRepeat(`${cause}\u0000${level}\u0000${subsystem}\u0000${message}\u0000${sameCause}`, cause, now) : null;
  }
  const text = outageText(message, meta);
  // The bridge's own test for a host card (log-error-bridge.ts): the text says the link is
  // down, not just an errno one command can hit on a connected host (that stays its session's).
  if (namesLinkDown(text)) {
    const cause = causeKeyForError({ text, ...(hostHint ? { host: hostHint } : {}) });
    // By level too: a quiet warn told first must not quiet the error that raises the card.
    if (cause) return toldRepeat(`${cause}\u0000${level}\u0000${subsystem}\u0000${message}`, cause, now);
  }
  // A name that will not resolve: one outage for every warn that retries it.
  const name = level === 'warn' ? failedLookupName(text) : null;
  return name ? toldRepeat(`dns:${name}\u0000${level}\u0000${subsystem}\u0000${message}`, `dns:${name}`, now) : null;
}

/** `cause` when `key` (which starts with it) was told inside the window; else records it as told now. */
function toldRepeat(key: string, cause: string, now: number): string | null {
  const told = toldMap();
  const last = told.get(key);
  if (last !== undefined && now - last < OUTAGE_REPEAT_WINDOW_MS) return cause;
  if (told.size >= MAX_REMEMBERED) {
    for (const [k, at] of told) if (now - at >= OUTAGE_REPEAT_WINDOW_MS) told.delete(k);
    if (told.size >= MAX_REMEMBERED) told.clear();
  }
  told.set(key, now);
  return null;
}

/**
 * The causes recovered (`host:<alias>` keys, from the recovery that retires the host's
 * card, log-error-bridge.ts releaseAbsorbedKeys): a link that drops again right after
 * is a new outage, and its first line is told again (the card must not sit green).
 */
export function releaseOutageRepeats(causeKeys: string[]): void {
  if (causeKeys.length === 0) return;
  const told = toldMap();
  for (const key of told.keys()) {
    const cause = key.slice(0, key.indexOf('\u0000'));
    if (causeKeys.includes(cause)) told.delete(key);
  }
}

/** Tests only: forget every told line (tests/setup/outage-repeat-reset.ts does it before each test). */
export function resetOutageRepeatsForTests(): void {
  toldMap().clear();
}
