/**
 * Log-error → notification bridge.
 *
 * Every `log.error()` / `log.fatal()` anywhere in the server lands in the
 * notification center automatically — producers no longer hand-wire
 * addNotification (which is why task-sync failures, daemon reattach storms
 * and external-plugin auth errors historically never surfaced outside the log file).
 *
 * Noise control (an error that repeats 1300×/day must be ONE feed entry):
 *   - dedupKey hashes the log title plus stable entity/error context. Identical
 *     failures collapse, while a later failure with a different root cause gets
 *     its own record even when both logs use the same fixed title.
 *   - a short in-memory TTL cache absorbs storms (600 errors/hour) without
 *     re-reading notifications.json on every repeat.
 *
 * Recovery: each record is tagged with the CONDITION it belongs to
 * (`recoveryKeyOf` below), so when that operation succeeds again every one of
 * its unresolved errors is stamped 'recovered' and leaves the Errors rail
 * instead of staying red forever after the user fixed the cause.
 *
 * Human copy: the log MESSAGE and its JSON meta are a developer's words, so they
 * go through humanize.ts on the way in — the card gets a readable title, a
 * one-sentence body and a CATEGORY to group by, while the old
 * `[subsystem] {json}` line moves to `detail` (a Details toggle). The dedup
 * fingerprint deliberately still hashes the RAW message: card identity must not
 * move when copy is reworded.
 *
 * Wiring: server.ts installs via installLogErrorNotifications() at startup and
 * uninstalls in stopServer(). The logging layer only sees an opaque sink
 * (logging must not import this module — everything imports logging, so that
 * edge would be a cycle).
 */

import { setErrorNotificationSink, type ErrorNotifyPayload } from '../../logging/subsystem.js';
import { redactSensitiveText } from '../../logging/redact.js';
import { upsertNotification } from './store.js';
import { humanizeErrorNotification } from './humanize.js';
import { causeKeyForError } from './error-cause.js';
import { log } from '../../logging/index.js';

/** Storm absorber: skip repeat sink calls for the same key within this window. */
const REPEAT_TTL_MS = 60_000;
/** Keep the body within the feed's read-time bound (MAX_BODY_CHARS = 600). */
const MAX_BODY = 600;

const recentKeys = new Map<string, number>();
/** dedupKey → the keys a recovery can arrive by (recoveryKey and/or causeKey),
 *  for the absorber release below. The absorber is keyed by dedupKey (a hash)
 *  and a recovery arrives by CONDITION or CAUSE, so the mapping is recorded as
 *  each record is published rather than reverse-engineered. Pruned in lockstep
 *  with recentKeys — it exists only to release entries in that map. */
const recentKeyConditions = new Map<string, string[]>();

function pruneRecent(now: number): void {
  if (recentKeys.size < 500) return;
  for (const [k, ts] of recentKeys) {
    if (now - ts > REPEAT_TTL_MS) {
      recentKeys.delete(k);
      recentKeyConditions.delete(k);
    }
  }
}

/**
 * Release the storm absorber for conditions that just recovered.
 *
 * Same reasoning as the server-side absorber release in publishRecovery: the
 * window suppresses repeats for 60s, and a condition that fails → recovers →
 * fails again INSIDE one window would have its re-failure swallowed, leaving the
 * card stamped 'recovered' (severity info, green chip) while the thing is broken
 * again. This matters most for the route family, which can flap within seconds.
 *
 * Called by the server's publishRecovery. Exported (not wired via a callback)
 * because the direction is safe: the server already imports this module to
 * install the bridge.
 */
export function releaseAbsorbedKeys(recoveryKeys: string[]): void {
  if (recoveryKeys.length === 0) return;
  const keys = new Set(recoveryKeys);
  for (const [dedupKey, conditions] of recentKeyConditions) {
    if (!conditions.some(c => keys.has(c))) continue;
    recentKeys.delete(dedupKey);
    recentKeyConditions.delete(dedupKey);
  }
}

/** djb2 — same cheap non-crypto hash external sync plugins use for comment dedup.
 *  Keys this bridge's dedup fingerprint so identical failures hash identically. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** Plumbing meta the CARD must not show — it steers the bridge, it isn't context.
 *  (`skipNotify` never reaches here: it returns early in the sink.) */
const BODY_META_OMIT = new Set(['recoveryKey']);

/**
 * The RAW technical line — `[subsystem] {json meta}`.
 *
 * This used to be the card's `body`, which is exactly the complaint that made
 * the Errors rail unreadable ("[web] {\"holders\":[{\"pid\":22198…"). It is now
 * the record's `detail`, shown only behind the card's Details toggle, and the
 * body carries the humanizer's one-sentence message instead. Kept byte-identical
 * so nothing a developer used to read from a card is lost.
 */
function buildDetail(payload: ErrorNotifyPayload): string | undefined {
  let metaStr = '';
  const meta = payload.meta
    ? Object.fromEntries(Object.entries(payload.meta).filter(([k]) => !BODY_META_OMIT.has(k)))
    : undefined;
  if (meta && Object.keys(meta).length > 0) {
    try {
      metaStr = JSON.stringify(meta);
    } catch {
      metaStr = '[unserializable meta]';
    }
  }
  const raw = metaStr ? `[${payload.subsystem}] ${metaStr}` : `[${payload.subsystem}]`;
  const clean = redactSensitiveText(raw);
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)}…` : clean;
}

/** Bound the humanized body to the same read-time cap the feed applies. */
function capBody(text: string): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…` : text;
}

// ALLOWLIST, not a denylist — anything absent here (including `recoveryKey`) is
// already out of the dedup fingerprint, so tagging a record for recovery can
// never split one failure into two cards.
const DEDUP_META_KEYS = [
  'error', 'err', 'reason', 'cause', 'code', 'status',
  'sessionId', 'taskId', 'runId', 'conversationId', 'agentId',
  'pluginId', 'jobName', 'host',
] as const;

/**
 * Subsystem roots that belong to Walnut itself, so a record from one is NOT a
 * plugin condition. Everything else with a root segment is treated as a plugin
 * (`plugin:<root>`), which is what makes an external sync plugin's wall of
 * `[<plugin>/http]` errors retire together the moment its next sync succeeds.
 *
 * DENYLIST rather than a registry lookup, on purpose: this bridge is installed
 * BY the logging layer's sink and must stay leaf-ish — its whole import closure
 * today is logging (subsystem, redact, index) + the store. Importing the plugin
 * registry (integration-loader) would pull in the config manager, task manager
 * and the plugin sandbox, and integration-loader itself logs through this very
 * sink, so the edge would be a cycle back into the module installing it. The
 * list is the complete set of `createSubsystemLogger` roots in src/ (plus the
 * `log.*` keys in logging/index.ts) — a new core subsystem must be added here,
 * and the cost of forgetting is only that its errors gain a recovery key nobody
 * ever signals (they behave exactly as they do today: they stay until dismissed).
 */
const CORE_SUBSYSTEM_ROOTS = new Set([
  // 'session' and 'obs' are core AND session-scoped: SESSION_SCOPED_ROOTS is
  // checked FIRST in recoveryKeyOf, so they get a `session:<sid>` key when the
  // log names one and fall through to "no lifecycle" here when it doesn't.
  'agent', 'audio', 'browser', 'bus', 'calendar', 'cron', 'daemon', 'git',
  'heartbeat', 'hook', 'memory', 'notif', 'obs', 'session', 'stt', 'subagent',
  'task', 'usage', 'web', 'ws',
  // plugin INFRASTRUCTURE, not one plugin's condition: a loader/registry failure
  // is not retired by any single plugin's sync succeeding.
  'plugin-loader', 'plugin-sources',
]);

/**
 * Subsystem roots whose errors belong to a SESSION rather than to a global
 * condition. A session error recovers when that session's next turn completes
 * cleanly, and expires when the session dies — so a `session:<sid>` key gives
 * the whole family (transport start, stream-convergence violations, unparseable
 * self-reports, and anything the session subsystem logs in future) a lifecycle
 * without each call site having to know about notifications.
 *
 * `obs` rides along because its session-scoped diagnostics (stream-convergence)
 * are about one session's stream, and are meaningless once it's gone.
 */
const SESSION_SCOPED_ROOTS = new Set(['session', 'obs']);

/**
 * Which recoverable condition a log error belongs to, or undefined for "no
 * lifecycle" (the record behaves exactly as it did before this feature).
 *
 * Precedence: an explicit `meta.recoveryKey` (a producer that knows best) →
 * `meta.pluginId` → a session/task scope for the session-family subsystems →
 * the subsystem's first path segment when it isn't core.
 * The subsystem fallback is what covers a plugin's own logger (`<plugin>/http`,
 * `plugin/<id>`) and its sync helpers without every log call having to remember
 * to pass pluginId.
 *
 * That fallback assumes a plugin's bespoke subsystem name IS its plugin id
 * (true today — the built-in one matches, and `plugin/<id>` from the loader is
 * read by id). A plugin that logs under some unrelated word would get a key its
 * own sync-success signal never sends, so its records would keep today's
 * behavior (stay until dismissed) rather than misbehave; the fix in that case is
 * to pass `pluginId` in the log meta.
 */
export function recoveryKeyOf(payload: ErrorNotifyPayload): string | undefined {
  const explicit = payload.meta?.recoveryKey;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const pluginId = payload.meta?.pluginId;
  if (typeof pluginId === 'string' && pluginId.trim()) return `plugin:${pluginId.trim()}`;

  const root = payload.subsystem.split('/')[0]?.trim();

  // Session family: scope to the session (a clean turn recovers it, death
  // expires it), else to the task when that's the only id the log carried —
  // 'transport start failed' knows its taskId but not yet a session id, because
  // the session it was trying to start never existed.
  if (root && SESSION_SCOPED_ROOTS.has(root)) {
    const sessionId = payload.meta?.sessionId;
    if (typeof sessionId === 'string' && sessionId.trim()) return `session:${sessionId.trim()}`;
    const taskId = payload.meta?.taskId;
    if (typeof taskId === 'string' && taskId.trim()) return `task:${taskId.trim()}`;
    // Neither id: nothing to recover against, so no lifecycle (today's behavior).
    return undefined;
  }

  if (!root || CORE_SUBSYSTEM_ROOTS.has(root)) return undefined;
  // `plugin/<id>` (integration-loader's per-plugin logger) names the plugin in
  // the SECOND segment — its root is the generic word, so read one deeper.
  if (root === 'plugin') {
    const id = payload.subsystem.split('/')[1]?.trim();
    return id ? `plugin:${id}` : undefined;
  }
  return `plugin:${root}`;
}

/** Tests: the exact string whose hash becomes the dedupKey. Exported so a producer
 *  can assert that two of its log lines fold into ONE card, rather than asserting
 *  on a paraphrase of the rule and drifting from it. */
export function dedupFingerprintForTest(payload: ErrorNotifyPayload): string {
  return dedupFingerprint(payload);
}

function dedupFingerprint(payload: ErrorNotifyPayload): string {
  const stableMeta: Record<string, unknown> = {};
  for (const key of DEDUP_META_KEYS) {
    const value = payload.meta?.[key];
    if (value !== undefined) stableMeta[key] = value;
  }

  let meta = '';
  try {
    meta = JSON.stringify(stableMeta);
  } catch {
    meta = '[unserializable]';
  }
  return redactSensitiveText(`${payload.message}\n${meta}`);
}

/**
 * Install the bridge. `broadcast` pushes the new record to connected UIs so the
 * bell updates live (the durable write alone only shows up after a refresh).
 */
export function installLogErrorNotifications(
  broadcast?: (name: string, data: unknown) => void,
): void {
  recentKeys.clear();
  recentKeyConditions.clear();
  setErrorNotificationSink((payload) => {
    // Producers that hand-publish a richer notification for the same failure
    // (e.g. server.ts's 'Subagent Error' with task ref + deep links) opt out
    // with `skipNotify: true` in the log meta — otherwise every such failure
    // lands in the feed TWICE under two different dedup keys.
    if (payload.meta?.skipNotify === true) return;
    const now = Date.now();
    const dedupKey = `logerr:${payload.subsystem}:${djb2(dedupFingerprint(payload))}`;

    const last = recentKeys.get(dedupKey);
    if (last && now - last < REPEAT_TTL_MS) return;
    pruneRecent(now);
    // Optimistically armed here (async persist below); re-armed OFF in the
    // catch so a failed write doesn't silence this error for a full TTL.
    recentKeys.set(dedupKey, now);

    // The RAW line the card keeps behind its Details toggle (was the body).
    const detail = buildDetail(payload);
    // sessionId/taskId in meta → deep-link targets on the card
    const sessionId = typeof payload.meta?.sessionId === 'string' ? payload.meta.sessionId : undefined;
    const taskId = typeof payload.meta?.taskId === 'string' ? payload.meta.taskId : undefined;
    // The condition this error belongs to, so a later success can retire it.
    const recoveryKey = recoveryKeyOf(payload);
    // The ROOT CAUSE it shares with other conditions (host link down), so one
    // daemon reconnect can retire the whole fan-out. Derived from the message
    // plus the error-ish meta strings — the route-5xx card's host is only ever
    // named inside meta.message, never structured.
    const causeText = [
      payload.message,
      ...['error', 'err', 'reason', 'cause', 'detail', 'message']
        .map((k) => payload.meta?.[k])
        .filter((v): v is string => typeof v === 'string'),
    ].join('\n');
    const metaHost = typeof payload.meta?.host === 'string' ? payload.meta.host : undefined;
    // Redacted first, like every other consumer of raw log text on this path:
    // a secret sitting where a pattern expects a host would otherwise be
    // persisted into the key and rendered as a group heading.
    const causeKey = causeKeyForError({
      text: redactSensitiveText(causeText),
      ...(metaHost ? { host: metaHost } : {}),
    });
    const releaseKeys = [recoveryKey, causeKey].filter((k): k is string => !!k);
    if (releaseKeys.length > 0) recentKeyConditions.set(dedupKey, releaseKeys);

    // Human copy. Note the ORDER relative to the dedupKey above: the fingerprint
    // hashes the RAW log message + stable meta and is computed BEFORE this, so
    // rewording a title here can never split one failure into two cards (nor
    // merge two). That independence is pinned by a test.
    //
    // `sanitize` is passed because this path reads RAW log meta, which can carry
    // a token inside an error string. The humanizer applies it to its inputs
    // before any rule runs — redacting the finished sentence instead would miss a
    // secret whose prefix got cut off by truncation.
    const human = humanizeErrorNotification({
      title: payload.message,
      subsystem: payload.subsystem,
      ...(recoveryKey ? { recoveryKey } : {}),
      ...(payload.meta ? { meta: payload.meta } : {}),
    }, { sanitize: redactSensitiveText });
    const title = human.title.length > 120 ? `${human.title.slice(0, 120)}…` : human.title;
    const body = human.message ? capBody(human.message) : undefined;

    // Async wrapper because the side-thread suppression needs an awaited record
    // read, which the old fire-and-forget `void upsertNotification(...)` could
    // not do. Its `.catch` makes a failed dynamic import a log line, never an
    // unhandledRejection (this sink is installed during boot, where one is fatal).
    void (async () => {
      // Side threads are hidden asides: no list can show the session a card
      // would name, and the thread's transcript renders a TURN error in place.
      // But a thread that never initialized has no transcript to render into —
      // an init/spawn failure must still reach the human. The log line stays
      // for forensics either way; only the bell card is suppressed.
      if (sessionId) {
        const [{ getSessionByClaudeId }, { isSideThreadLane }] = await Promise.all([
          import('../session-tracker.js'),
          import('../sessions/side-thread-fork.js'),
        ]);
        const rec = await getSessionByClaudeId(sessionId).catch(() => null);
        const initialized = !!rec && (!!rec.outputFile || rec.consumedOffset !== undefined);
        if (rec && isSideThreadLane(rec.lane) && initialized) return;
      }
      await upsertNotification({
        kind: 'operation-error', severity: 'error', title, body,
        timestamp: now, dedupKey,
        category: human.category,
        ...(detail ? { detail } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(recoveryKey ? { recoveryKey } : {}),
        ...(causeKey ? { causeKey } : {}),
      }).then(({ record, outcome }) => {
        // A first occurrence toasts; a later one (after the TTL window) patches the
        // existing card's count/body in place rather than re-toasting the UI.
        if (!broadcast) return;
        broadcast(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record);
      }).catch((err) => {
        // Persist failed → drop the TTL entry so the next occurrence retries
        // instead of being suppressed for a full window with nothing durable.
        if (recentKeys.get(dedupKey) === now) {
          recentKeys.delete(dedupKey);
          recentKeyConditions.delete(dedupKey);
        }
        // notif-subsystem logs are excluded from the sink, so this cannot loop.
        log.notif.warn('log-error bridge: failed to persist notification', {
          dedupKey, error: err instanceof Error ? err.message : String(err),
        });
      });
    })().catch((err) => {
      log.notif.warn('log-error bridge: suppression lookup failed', {
        dedupKey, error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/** Remove the bridge (stopServer / tests). */
export function uninstallLogErrorNotifications(): void {
  setErrorNotificationSink(null);
  recentKeys.clear();
  recentKeyConditions.clear();
}
