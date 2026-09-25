/**
 * The host capabilities Rhythm uses beyond the published API, reached through ONE cast.
 *
 * Quiet mode, reminder-kind notices with action buttons, and `dismiss` are newer than
 * the oldest Walnut this plugin runs on (`engines.walnut`). Every member here is
 * therefore OPTIONAL and feature-detected at the call: an older host still gets
 * plain notices, and a missing quiet API reads as "not quiet" rather than throwing.
 */
import type { PluginNotice, WalnutServerApi } from '@open-walnut/plugin-api/server'

export interface QuietHold {
  source: string
  /** Epoch ms. Absent means "until cleared". */
  until?: number
  reason?: string
  since?: number
}

export interface QuietState {
  active: boolean
  allowPermissions?: boolean
  holds: QuietHold[]
}

export interface QuietApi {
  get(): Promise<QuietState>
  /** Replaces THIS plugin's one hold. `until` is epoch ms; absent means until cleared. */
  set(input: { until?: number; reason?: string }): Promise<void>
  /** Removes only this plugin's hold. */
  clear(): Promise<void>
}

export interface NoticeAction {
  label: string
  /** The LOCAL op name; the host prefixes it with the plugin's op namespace. */
  op: string
  args?: Record<string, unknown>
}

export interface RhythmNotice extends PluginNotice {
  kind?: 'skill' | 'reminder'
  actions?: NoticeAction[]
}

export interface RhythmNotifications {
  notify(notice: RhythmNotice): Promise<void>
  dismiss?(dedupKey: string): Promise<void>
  quiet?: QuietApi
}

/**
 * The published notification service with the three newer members replaced by the
 * optional shapes above. Omit (not an intersection) so this compiles the same whether
 * the installed `@open-walnut/plugin-api` already declares them or not.
 */
export interface RhythmHostApi extends Omit<WalnutServerApi, 'notifications'> {
  readonly notifications: Omit<WalnutServerApi['notifications'], 'notify' | 'dismiss' | 'quiet'> & RhythmNotifications
}

/** The one cast. Everything below it is typed against the optional members. */
export function asRhythmHost(walnut: WalnutServerApi): RhythmHostApi {
  return walnut as unknown as RhythmHostApi
}

/** Quiet mode through whichever shape the host offers, or a stand-in that is never quiet. */
export function quietOf(walnut: RhythmHostApi): { available: boolean; api: QuietApi } {
  const quiet = walnut.notifications.quiet
  if (quiet && typeof quiet.get === 'function' && typeof quiet.set === 'function' && typeof quiet.clear === 'function') {
    return { available: true, api: quiet }
  }
  return {
    available: false,
    api: {
      async get() { return { active: false, holds: [] } },
      async set() { /* no quiet mode on this host */ },
      async clear() { /* no quiet mode on this host */ },
    },
  }
}

export async function dismissNotice(walnut: RhythmHostApi, dedupKey: string): Promise<void> {
  const dismiss = walnut.notifications.dismiss
  if (typeof dismiss === 'function') await dismiss.call(walnut.notifications, dedupKey)
}

/** A QuietState read that never throws and never returns junk. */
export function normalizeQuietState(raw: unknown): QuietState {
  if (!raw || typeof raw !== 'object') return { active: false, holds: [] }
  const value = raw as Partial<QuietState>
  const holds = Array.isArray(value.holds)
    ? value.holds.filter((hold): hold is QuietHold => !!hold && typeof hold === 'object' && typeof hold.source === 'string')
    : []
  return { active: value.active === true, allowPermissions: value.allowPermissions, holds }
}
