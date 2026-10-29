/**
 * How often a remote host's read copy (`host.slice`) may cross its link.
 *
 * The copy is pushed whole: the host's sessions, their tasks and the team
 * Boards' html, about 1.5 MB for a busy host (measured 2026-10-29: boards 1.0 MB,
 * tasks 390 KB, sessions 130 KB). Task churn re-pushed it after every 3 s
 * debounce, so a busy day sent a host 1,350 to 2,030 copies, 2 to 3 GB of
 * upload. An SSH path through a WebSocket relay drops the whole connection when
 * it carries an upload burst (the relay closes it abnormally, 1006; a 30 MB
 * download on the same path passes), and the copy rides the ControlMaster every
 * session link to the host shares: 330 of 492 link drops to one host in three
 * days had a copy in flight, a copy being in flight a few percent of the time.
 *
 * So after a copy went out, the next waits in proportion to its size: a small
 * copy keeps the debounce's pace, a large one goes at most once a minute. The
 * first copy of a connection never waits (it also tells the daemon which socket
 * is ours), and neither does one naming a session the last copy did not: a host
 * answers a session's calls while the Mac is away only once its copy names it.
 */

/** Average upload a host's copies may use (bytes per second). */
export const HOST_SLICE_UPLOAD_BYTES_PER_SEC = 25_000
/** The longest a changed copy waits behind the last one. */
export const HOST_SLICE_MAX_GAP_MS = 60_000

export interface HostSlicePaceInput {
  /** When the last copy on this connection went out (0: none yet). */
  lastSentAt: number
  /** Its size in bytes. */
  lastBytes: number
  now: number
  /** The copy about to go names a session the last one did not. */
  namesNewSession: boolean
}

/** How long the copy about to go waits (0: send it now). */
export function hostSliceWaitMs(p: HostSlicePaceInput): number {
  if (p.lastSentAt <= 0 || p.namesNewSession) return 0
  const gap = Math.min(HOST_SLICE_MAX_GAP_MS, (p.lastBytes / HOST_SLICE_UPLOAD_BYTES_PER_SEC) * 1000)
  return Math.max(0, Math.ceil(p.lastSentAt + gap - p.now))
}
