/**
 * The mark a production daemon leaves in its dir while it stops for a successor
 * (an update, a handover, a service restart): `<daemon dir>/restarting`, holding
 * the epoch second it was written. The successor removes it once its gateway
 * socket listens and its `bin/walnut` is written.
 *
 * Between the two daemons there is no `bin/walnut` and no socket for a few
 * seconds (2026-11-03 on a dev box: 6 s, every call in it failed at once with
 * "no Walnut daemon on this host"). While the mark is fresh, a `walnut` call that
 * finds no daemon there waits for the next one instead; a mark older than
 * RESTART_MARK_FRESH_SECS means no successor came, and the call fails as before.
 * Nothing was sent in any of those cases, so waiting and sending again is safe
 * for every op.
 *
 * Readers: wn-cli.ts (connect refused, a call the exiting daemon never read, or the
 * stopping daemon's answer) and the
 * user PATH shim (daemon-standalone.ts userWalnutShimText, the same file name and
 * age in shell). daemon-source.ts mirrors all of it.
 */

export const RESTART_MARK_NAME = 'restarting'
/** How long a mark means "a successor is on its way". */
export const RESTART_MARK_FRESH_SECS = 45
/** The longest one call rides restarts, however many marks it meets. */
export const RESTART_RIDE_MAX_MS = 60_000
/** Between two looks at the daemon while it restarts. */
export const RESTART_POLL_MS = 500

/** The mark's text says a successor is due: written under RESTART_MARK_FRESH_SECS ago (a clock a little ahead is tolerated). */
export function restartMarkFresh(text: string | null | undefined, nowMs: number): boolean {
  const t = (text ?? '').trim()
  if (!/^\d{1,12}$/.test(t)) return false
  const age = Math.floor(nowMs / 1000) - Number(t)
  return age >= -5 && age < RESTART_MARK_FRESH_SECS
}

/** The text a stopping daemon writes. */
export function restartMarkText(nowMs: number): string {
  return String(Math.floor(nowMs / 1000))
}
