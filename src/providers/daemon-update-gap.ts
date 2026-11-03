/**
 * At most one automatic daemon replacement per host per gap.
 *
 * Every server restart with a new daemon build replaced each remote host's daemon,
 * so a run of deploys replaced it once per build (2026-11-03: seven pushes to
 * clouddev in 20 minutes over a slow link, two of them failed uploads, while its
 * sessions lost their link at each swap). A daemon that started less than the gap
 * ago keeps serving; the update is decided again when the gap ends, with the build
 * the server runs then, so the builds in between are never pushed. Nothing is lost
 * by waiting: a server talks to an older daemon through its capabilities.
 *
 * Not held: a host with no daemon (that is a start, not a replacement), an update
 * someone asked for (host_daemon_update). WALNUT_DAEMON_UPDATE_MIN_GAP_MS sets the
 * gap; 0 turns the hold off.
 */

export const DAEMON_UPDATE_MIN_GAP_MS = 20 * 60_000

export function daemonUpdateMinGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WALNUT_DAEMON_UPDATE_MIN_GAP_MS ?? '').trim()
  if (!raw) return DAEMON_UPDATE_MIN_GAP_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DAEMON_UPDATE_MIN_GAP_MS
}

/**
 * How long to wait before replacing a daemon that has run `ageMs`; 0 = go now.
 * Unknown age: go now. `heldForMs`, how long this build's update has already been
 * held, caps it at one gap in all: a daemon that keeps restarting (a crash loop)
 * always looks young, and the build that would fix it must still go out.
 */
export function daemonUpdateWaitMs(ageMs: number | null | undefined, gapMs: number, heldForMs = 0): number {
  if (gapMs <= 0 || ageMs === null || ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return 0
  const wait = ageMs < gapMs ? gapMs - ageMs : 0
  return Math.max(0, Math.min(wait, gapMs - Math.max(0, heldForMs)))
}

/** The words for a held update, the same on every path. */
export function daemonUpdateGapWhy(ageMs: number, waitMs: number): string {
  const min = (ms: number) => Math.max(1, Math.round(ms / 60_000))
  return `its daemon started ${min(ageMs)} min ago; a host's daemon is replaced at most once per gap, so the update goes in ${min(waitMs)} min with the build of then`
}

/** `ps -o etime=` ([[DD-]HH:]MM:SS) in ms, or null. */
export function parseEtimeMs(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!m) return null
  const [days, hours, mins, secs] = [m[1], m[2], m[3], m[4]].map((v) => (v ? parseInt(v, 10) : 0))
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000
}
