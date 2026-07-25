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
 * Wiring: server.ts installs via installLogErrorNotifications() at startup and
 * uninstalls in stopServer(). The logging layer only sees an opaque sink
 * (logging must not import this module — everything imports logging, so that
 * edge would be a cycle).
 */

import { setErrorNotificationSink, type ErrorNotifyPayload } from '../../logging/subsystem.js';
import { redactSensitiveText } from '../../logging/redact.js';
import { addNotification } from './store.js';
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
 *  Shared by every notification dedupKey producer (this bridge + server.ts's
 *  hand-published error notifications) so identical bodies hash identically. */
export function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function buildBody(payload: ErrorNotifyPayload): string | undefined {
  let metaStr = '';
  if (payload.meta && Object.keys(payload.meta).length > 0) {
    try {
      metaStr = JSON.stringify(payload.meta);
    } catch {
      metaStr = '[unserializable meta]';
    }
  }
  const raw = metaStr ? `[${payload.subsystem}] ${metaStr}` : `[${payload.subsystem}]`;
  const clean = redactSensitiveText(raw);
  return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)}…` : clean;
}

const DEDUP_META_KEYS = [
  'error', 'err', 'reason', 'cause', 'code', 'status',
  'sessionId', 'taskId', 'runId', 'conversationId', 'agentId',
  'pluginId', 'jobName', 'host',
] as const;

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

    void addNotification({
      kind: 'operation-error', severity: 'error', title, body,
      timestamp: now, dedupKey,
      ...(sessionId ? { sessionId } : {}),
      ...(taskId ? { taskId } : {}),
    }).then((record) => {
      // Only broadcast when this call actually created the record (dedup
      // returns the existing one) — repeats must not re-toast the UI.
      if (record.timestamp === now && broadcast) {
        broadcast('notification:new', record);
      }
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
