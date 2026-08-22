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
 * Wiring: server.ts installs via installLogErrorNotifications() at startup and
 * uninstalls in stopServer(). The logging layer only sees an opaque sink
 * (logging must not import this module — everything imports logging, so that
 * edge would be a cycle).
 */

import { setErrorNotificationSink, type ErrorNotifyPayload } from '../../logging/subsystem.js';
import { redactSensitiveText } from '../../logging/redact.js';
import { upsertNotification } from './store.js';
import { log } from '../../logging/index.js';

/** Storm absorber: skip repeat sink calls for the same key within this window. */
const REPEAT_TTL_MS = 60_000;
/** Keep the body within the feed's read-time bound (MAX_BODY_CHARS = 600). */
const MAX_BODY = 600;

const recentKeys = new Map<string, number>();

function pruneRecent(now: number): void {
  if (recentKeys.size < 500) return;
  for (const [k, ts] of recentKeys) {
    if (now - ts > REPEAT_TTL_MS) recentKeys.delete(k);
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

function buildBody(payload: ErrorNotifyPayload): string | undefined {
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
  'agent', 'audio', 'browser', 'bus', 'calendar', 'cron', 'daemon', 'git',
  'heartbeat', 'hook', 'memory', 'notif', 'obs', 'session', 'stt', 'subagent',
  'task', 'usage', 'web', 'ws',
  // plugin INFRASTRUCTURE, not one plugin's condition: a loader/registry failure
  // is not retired by any single plugin's sync succeeding.
  'plugin-loader', 'plugin-sources',
]);

/**
 * Which recoverable condition a log error belongs to, or undefined for "no
 * lifecycle" (the record behaves exactly as it did before this feature).
 *
 * Precedence: an explicit `meta.recoveryKey` (a producer that knows best) →
 * `meta.pluginId` → the subsystem's first path segment when it isn't core.
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
  if (!root || CORE_SUBSYSTEM_ROOTS.has(root)) return undefined;
  // `plugin/<id>` (integration-loader's per-plugin logger) names the plugin in
  // the SECOND segment — its root is the generic word, so read one deeper.
  if (root === 'plugin') {
    const id = payload.subsystem.split('/')[1]?.trim();
    return id ? `plugin:${id}` : undefined;
  }
  return `plugin:${root}`;
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

    const title = payload.message.length > 120
      ? `${payload.message.slice(0, 120)}…`
      : payload.message;
    const body = buildBody(payload);
    // sessionId/taskId in meta → deep-link targets on the card
    const sessionId = typeof payload.meta?.sessionId === 'string' ? payload.meta.sessionId : undefined;
    const taskId = typeof payload.meta?.taskId === 'string' ? payload.meta.taskId : undefined;
    // The condition this error belongs to, so a later success can retire it.
    const recoveryKey = recoveryKeyOf(payload);

    void upsertNotification({
      kind: 'operation-error', severity: 'error', title, body,
      timestamp: now, dedupKey,
      ...(sessionId ? { sessionId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(recoveryKey ? { recoveryKey } : {}),
    }).then(({ record, outcome }) => {
      // A first occurrence toasts; a later one (after the TTL window) patches the
      // existing card's count/body in place rather than re-toasting the UI.
      if (!broadcast) return;
      broadcast(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record);
    }).catch((err) => {
      // Persist failed → drop the TTL entry so the next occurrence retries
      // instead of being suppressed for a full window with nothing durable.
      if (recentKeys.get(dedupKey) === now) recentKeys.delete(dedupKey);
      // notif-subsystem logs are excluded from the sink, so this cannot loop.
      log.notif.warn('log-error bridge: failed to persist notification', {
        dedupKey, error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/** Remove the bridge (stopServer / tests). */
export function uninstallLogErrorNotifications(): void {
  setErrorNotificationSink(null);
  recentKeys.clear();
}
