/**
 * Quiet mode (Walnut-level do not disturb), web side: pure model (no React).
 *
 * The server owns the state (src/core/quiet/quiet-state.ts): several sources may
 * hold quiet at once (the human's toggle, a plugin's focus timer). While any hold
 * is live the console stops toasting, chiming and raising browser notifications,
 * but the feed keeps collecting and the badge keeps counting. Permission asks
 * still toast while `allowPermissions` holds, because an agent is blocked on them.
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
