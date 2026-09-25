/**
 * Notification buttons: pure helpers, no React.
 *
 * A record may carry a list of `actions` (primary first, at most three). When it
 * does, the list is authoritative; a record without one falls back to the older
 * single `action` (a producer's "Sign in", the session deep link). An `op`
 * button runs a plugin op through the existing plugin-runtime route; the server
 * stamped its `pluginId`, so a notice can only ever run its own plugin's ops.
 */
import type { Notification, NotificationAction } from './types';

/** The console renders at most this many buttons per notice. */
export const MAX_NOTIFICATION_ACTIONS = 3;

/** How long a button waits on its op before calling it failed. */
const OP_TIMEOUT_MS = 20_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** One wire button → a client action, or null for anything malformed or unknown. */
function wireActionOf(raw: unknown): NotificationAction | null {
  if (!isPlainObject(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return null;
  if (raw.kind === 'op') {
    if (typeof raw.pluginId !== 'string' || !raw.pluginId) return null;
    if (typeof raw.op !== 'string' || !raw.op) return null;
    return {
      label, kind: 'op', pluginId: raw.pluginId, op: raw.op,
      ...(isPlainObject(raw.args) ? { args: raw.args } : {}),
    };
  }
  if ((raw.kind === undefined || raw.kind === 'navigate') && typeof raw.to === 'string' && raw.to) {
    return { label, kind: 'navigate', to: raw.to };
  }
  return null;
}

/**
 * The record's `actions` list, validated and capped. Degrades instead of
 * throwing: an older server sends none, a newer one may send a kind this build
 * does not know, and neither may break the toast that carries it.
 */
export function wireActionsOf(raw: unknown): NotificationAction[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationAction[] = [];
  for (const one of raw) {
    const action = wireActionOf(one);
    if (action) out.push(action);
    if (out.length === MAX_NOTIFICATION_ACTIONS) break;
  }
  return out;
}

/** The buttons a toast or feed card renders, primary first. */
export function displayActionsOf(n: Pick<Notification, 'action' | 'actions'>): NotificationAction[] {
  if (n.actions && n.actions.length > 0) return n.actions.slice(0, MAX_NOTIFICATION_ACTIONS);
  return n.action ? [n.action] : [];
}

/** Where an `op` button POSTs. Null when the action is not a runnable op. */
export function opActionPath(a: NotificationAction): string | null {
  if (a.kind !== 'op' || !a.pluginId || !a.op) return null;
  return `/api/plugin-runtime/${encodeURIComponent(a.pluginId)}/ops/${encodeURIComponent(a.op)}`;
}

export type OpActionResult = { ok: true } | { ok: false; message: string };

/**
 * Run an `op` button. The route answers 200 with `{ ok: false, message }` when the
 * op itself failed, so the body decides, not just the status.
 */
export async function runOpAction(
  a: NotificationAction,
  fetchImpl: typeof fetch = fetch,
): Promise<OpActionResult> {
  const path = opActionPath(a);
  if (!path) return { ok: false, message: 'This button has nothing to run' };
  try {
    const res = await fetchImpl(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(a.args ?? {}),
      signal: AbortSignal.timeout(OP_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null) as { ok?: unknown; message?: unknown; error?: unknown } | null;
    if (!res.ok) {
      const message = typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`;
      return { ok: false, message };
    }
    if (body?.ok === false) {
      return { ok: false, message: typeof body.message === 'string' ? body.message : 'The action failed' };
    }
    return { ok: true };
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, message: timedOut ? 'The action timed out' : 'Walnut is unreachable' };
  }
}
