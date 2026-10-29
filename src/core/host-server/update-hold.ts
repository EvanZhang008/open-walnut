/**
 * When a host that runs a working server gets this Mac's newer build
 * (manager.ts). Every deploy here starts a new server process with a new
 * build, and the host's file is tens of MB over an SSH path whose relay may
 * cut upload bursts: shipping each deploy kept the host's links busy and
 * dropping much of the day (2026-10-29: 27 to 76 deploys a day, 10+ minutes
 * and dozens of cut chunks per install).
 *
 * So a newer build waits until it has served here for a quiet window with no
 * newer deploy (a newer deploy replaces this process, so the window counts from
 * when it started), and never longer than a cap counted from when the host
 * first fell behind (kept in the state file, so constant deploys cannot hold it
 * forever). It goes at once when nothing works there to wait on, when the
 * person pressed Retry, when the settings ask for another program, and when
 * the program there is too old for this Mac's copies.
 */

export const DEFAULT_UPDATE_QUIET_MS = 30 * 60_000
export const DEFAULT_UPDATE_MAX_BEHIND_MS = 6 * 60 * 60_000

export interface UpdateHoldInput {
  now: number
  /** When this server process began serving its build. */
  servingSince: number
  /** When the host first ran an older build than this Mac's (the state file); unset: now. */
  behindSince?: number
  quietMs: number
  maxBehindMs: number
  /** The program the state file keeps as working is the one reporting now, as configured. */
  workingReports: boolean
  /** The person pressed Retry. */
  retry: boolean
  /** The settings ask for another program than the working one (replica or host server). */
  programChanged: boolean
  /** Why the running program cannot take this Mac's copies (its schema is older), or null. */
  tooOld: string | null
}

export type UpdateHold =
  | { hold: false; why: 'retry' | 'no-working-program' | 'program-changed' | 'too-old' | 'off' | 'quiet' | 'cap' }
  | { hold: true; until: number; latest: number; behindSince: number }

/** Whether this Mac's newer build waits, and until when. */
export function updateHold(i: UpdateHoldInput): UpdateHold {
  if (i.retry) return { hold: false, why: 'retry' }
  if (!i.workingReports) return { hold: false, why: 'no-working-program' }
  if (i.programChanged) return { hold: false, why: 'program-changed' }
  if (i.tooOld) return { hold: false, why: 'too-old' }
  if (!(i.quietMs > 0)) return { hold: false, why: 'off' }
  // A time ahead of this clock (another machine wrote it, or the clock moved back) counts from now.
  const behindSince = Math.min(i.behindSince ?? i.now, i.now)
  const latest = behindSince + Math.max(0, i.maxBehindMs)
  const quietEnds = i.servingSince + i.quietMs
  const until = Math.min(quietEnds, latest)
  if (i.now >= until) return { hold: false, why: quietEnds <= latest ? 'quiet' : 'cap' }
  return { hold: true, until, latest, behindSince }
}

/** A duration knob in minutes (a number, 0 or more); anything else: the default. */
export function minutesFromEnv(raw: string | undefined, fallbackMs: number): number {
  const s = raw?.trim()
  if (!s) return fallbackMs
  const n = Number(s)
  return Number.isFinite(n) && n >= 0 ? n * 60_000 : fallbackMs
}

/** A time of day on this computer's clock, `HH:MM`. */
export function clockTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function quietWords(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000))
  if (min % 60 === 0) return min === 60 ? 'a quiet hour' : `${min / 60} quiet hours`
  return min === 1 ? 'a quiet minute' : `${min} quiet minutes`
}

/** The view's notice while a newer build waits. */
export function heldNotice(older: string, mine: string, quietMs: number, latest: number): string {
  return `It runs Walnut ${older}; this computer's ${mine} goes out after ${quietWords(quietMs)} with no newer deploy here (at the latest by ${clockTime(latest)}). Retry sends it now.`
}
