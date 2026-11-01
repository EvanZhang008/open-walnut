/**
 * Quiet mode (Walnut-level do not disturb), web side: pure model (no React).
 *
 * The server owns the state (src/core/quiet/quiet-state.ts): several sources may
 * hold quiet at once (the human's toggle, a plugin's focus timer). While any hold
 * is live, NOTHING OUTSIDE A PAGE asks for attention (2026-11-01, the user during a
 * focus block: "the notification should also not show any number", "all plugin
 * notification in the side bar should follow this", "but inside the app it is fine"):
 * no toast, chime or system notification, and no count or dot on the rail (the bell,
 * every app's and plugin's badge, the Settings warn dot, a plugin ring's warning look)
 * or on the phone's bell. The feed keeps collecting and every badge keeps its value,
 * so all of it is back, with what arrived meanwhile, the moment quiet ends; inside a
 * page (the mail page, a plugin's App, the open notification panel) everything shows
 * as usual. Permission asks still toast while `allowPermissions` holds, because an
 * agent is blocked on them. The rail's gates are `railCount` / `railBadge` /
 * `railDot` / `railTone` below; tests/web/quiet-attention-ratchet.test.ts fails on a
 * new attention renderer outside a page that does not go through them.
 */
import { IS_PERSISTENT, type NotificationKind } from './types';

export interface QuietHold {
  source: string;
  until?: number;
  reason?: string;
  since: number;
}

export interface QuietState {
  active: boolean;
  allowPermissions: boolean;
  holds: QuietHold[];
}

export const NOT_QUIET: QuietState = { active: false, allowPermissions: true, holds: [] };

/** localStorage switch for the reminder chime ('off' mutes it; anything else plays). */
export const REMINDER_SOUND_KEY = 'open-walnut-reminder-sound';

/** Wire shape → state, dropping anything malformed (an older server sends nothing). */
export function normalizeQuiet(raw: unknown): QuietState {
  if (!raw || typeof raw !== 'object') return NOT_QUIET;
  const r = raw as Record<string, unknown>;
  const holds = Array.isArray(r.holds)
    ? r.holds.flatMap((h): QuietHold[] => {
        if (!h || typeof h !== 'object') return [];
        const o = h as Record<string, unknown>;
        if (typeof o.source !== 'string' || typeof o.since !== 'number') return [];
        return [{
          source: o.source, since: o.since,
          ...(typeof o.until === 'number' ? { until: o.until } : {}),
          ...(typeof o.reason === 'string' && o.reason ? { reason: o.reason } : {}),
        }];
      })
    : [];
  return { active: r.active === true && holds.length > 0, allowPermissions: r.allowPermissions !== false, holds };
}

/**
 * The state as of `now`: holds whose `until` passed are gone even if the server's
 * `quiet:changed` for that moment has not arrived (a dropped WebSocket must not
 * keep the console silent past the end of a focus block).
 */
export function effectiveQuiet(q: QuietState, now = Date.now()): QuietState {
  if (!q.active) return q;
  const live = q.holds.filter(h => h.until === undefined || h.until > now);
  if (live.length === q.holds.length) return q;
  return live.length === 0 ? NOT_QUIET : { ...q, holds: live };
}

/**
 * May a toast of this kind interrupt right now? Ephemeral kinds (a sort hint, a
 * voice-capture error) always may: they answer something the human JUST did and
 * have no feed copy, so holding them back would lose them rather than defer them.
 */
export function quietAllowsToast(q: QuietState, kind: NotificationKind, now = Date.now()): boolean {
  if (!IS_PERSISTENT[kind]) return true;
  const e = effectiveQuiet(q, now);
  if (!e.active) return true;
  return kind === 'permission' && e.allowPermissions;
}

function holdName(h: QuietHold): string {
  if (h.reason) return h.reason;
  if (h.source === 'user') return 'you';
  return h.source.startsWith('plugin:') ? h.source.slice('plugin:'.length) : h.source;
}

/** The bell tooltip, e.g. "Quiet: Focus block until 3:40 PM, you". */
export function quietLabel(q: QuietState, now = Date.now()): string {
  const e = effectiveQuiet(q, now);
  if (!e.active) return 'Notifications';
  const parts = e.holds.map((h) => {
    const until = h.until
      ? ` until ${new Date(h.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : '';
    return `${holdName(h)}${until}`;
  });
  return `Quiet: ${parts.join(', ')}`;
}

/** Whether the human muted the reminder chime. Never throws (storage may be blocked). */
export function reminderSoundMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(REMINDER_SOUND_KEY) === 'off';
  } catch {
    return false;
  }
}

// ── Outside a page: the rail, the phone bell, system notifications ──

/** Is attention outside a page held back right now? */
export function attentionHeld(q: QuietState, now = Date.now()): boolean {
  return effectiveQuiet(q, now).active;
}

/** A count shown outside a page: none while quiet. */
export function railCount(count: number, held: boolean): number {
  return held ? 0 : count;
}

/**
 * An app's rail badge: no number and no dot while quiet. A `{ text }` badge is a
 * status, not something waiting, so it stays. The stored badge is untouched.
 */
export function railBadge<B>(badge: B, held: boolean): B | null {
  if (!held) return badge;
  return badge === 'dot' || typeof badge === 'number' ? null : badge;
}

/** A dot outside a page: none while quiet. */
export function railDot(on: boolean, held: boolean): boolean {
  return on && !held;
}

/** A plugin ring's look: "this needs you now" reads as the quiet default while quiet. */
export function railTone<T extends string>(tone: T | undefined, held: boolean): T | 'neutral' | undefined {
  return held && tone === 'warning' ? 'neutral' : tone;
}
