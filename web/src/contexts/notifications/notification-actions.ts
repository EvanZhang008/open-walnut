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
import { isPluginDialogId } from '@/plugins/dialog-store';
import { deadlineSignal } from '../../utils/deadline-signal';

/** The console renders at most this many buttons per notice. */
export const MAX_NOTIFICATION_ACTIONS = 3;

/** How long a button waits on its op before calling it failed. */
const OP_TIMEOUT_MS = 20_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A wire button's expiry, kept only when it is a real moment (an older record has none). */
function expiryOf(raw: Record<string, unknown>): { expiresAt?: number } {
  const at = raw.expiresAt;
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? { expiresAt: at } : {};
}

/** One wire button → a client action, or null for anything malformed or unknown. */
function wireActionOf(raw: unknown): NotificationAction | null {
  const action = wireActionBody(raw);
  return action && isPlainObject(raw) ? { ...action, ...expiryOf(raw) } : action;
}

function wireActionBody(raw: unknown): NotificationAction | null {
  if (!isPlainObject(raw)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) return null;
  if (raw.kind === 'dialog') {
    if (!isPluginDialogId(raw.pluginId) || !isPluginDialogId(raw.slot)) return null;
    if (raw.op !== undefined || raw.to !== undefined || raw.dialog !== undefined) return null;
    if (raw.args !== undefined && !isPlainObject(raw.args)) return null;
    return {
      label, kind: 'dialog', pluginId: raw.pluginId, slot: raw.slot,
      ...(raw.args !== undefined ? { args: raw.args } : {}),
    };
  }
  if (raw.kind === 'op') {
    if (raw.slot !== undefined || raw.dialog !== undefined) return null;
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

/** Has this button's moment passed (its `expiresAt`)? A button with no expiry never expires. */
export function actionExpired(a: Pick<NotificationAction, 'expiresAt'>, now: number = Date.now()): boolean {
  return typeof a.expiresAt === 'number' && a.expiresAt <= now;
}

/**
 * The buttons a toast or feed card renders, primary first. A button whose moment passed is left
 * out (2026-11-21: a "Focus block done" notice still offered End break and Another block 23 hours
 * later); when every listed button expired the notice has none, never the older single `action`.
 */
export function displayActionsOf(n: Pick<Notification, 'action' | 'actions'>, now: number = Date.now()): NotificationAction[] {
  if (n.actions && n.actions.length > 0) return n.actions.filter((a) => !actionExpired(a, now)).slice(0, MAX_NOTIFICATION_ACTIONS);
  return n.action && !actionExpired(n.action, now) ? [n.action] : [];
}

/** When the next of a notice's buttons expires (a card re-renders then), or null when none will. */
export function nextActionExpiry(n: Pick<Notification, 'action' | 'actions'>, now: number = Date.now()): number | null {
  const list = n.actions && n.actions.length > 0 ? n.actions : n.action ? [n.action] : [];
  let next: number | null = null;
  for (const a of list) if (typeof a.expiresAt === 'number' && a.expiresAt > now && (next === null || a.expiresAt < next)) next = a.expiresAt;
  return next;
}

/**
 * How long until a card showing `n` must draw its buttons again (the next one expires), or null
 * when none will. A beat past the moment so the expired button is gone when it redraws, and capped
 * so a far-off expiry never overflows setTimeout's 32-bit delay.
 */
export function actionExpiryDelayMs(next: number | null, now: number = Date.now()): number | null {
  if (next === null) return null;
  return Math.min(Math.max(0, next - now) + 50, 2 ** 30);
}

/**
 * The header an `op` button sends its expiry in: the server refuses the op past it
 * (plugin-runtime.ts), so a click that raced the moment, or a page that missed its redraw, never
 * runs a button whose moment passed. The value came from the server's own record.
 */
export const ACTION_EXPIRES_HEADER = 'x-walnut-action-expires-at';

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
      headers: {
        'Content-Type': 'application/json',
        ...(typeof a.expiresAt === 'number' ? { [ACTION_EXPIRES_HEADER]: String(a.expiresAt) } : {}),
      },
      body: JSON.stringify(a.args ?? {}),
      signal: deadlineSignal(OP_TIMEOUT_MS),
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
