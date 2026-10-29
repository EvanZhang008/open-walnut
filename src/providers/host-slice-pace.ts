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

/**
 * A link back to a daemon process that took a copy of ours before: its first
 * whole copy, when the probe said it does not hold this one, waits until the
 * link has been up this long. 2026-10-28/29: 139 of 289 drops of one host's
 * session link came within 3 s of a reconnect (median 0.27 s), each with the
 * connect's uploads in flight, the 0.9 MB copy most of all. A copy that never got through left the next probe missing too, so every
 * reconnect sent it again and dropped again, 5 to 13 times in a few minutes.
 * Meanwhile the Mac answers the host's calls (it is connected), the daemon
 * keeps the older copy for a drop, and leader.configure, which does not wait,
 * binds the socket as the copy would have. The host replica rounds follow the
 * copy, so they stay out of those seconds too. A daemon process that never had
 * a copy of ours gets it at once: it has nothing to answer from if the Mac goes.
 */
export const HOST_SLICE_FRESH_LINK_SETTLE_MS = 15_000

/** How long a send kept out of a new link's first seconds still waits (0: the link is old enough, or its age is unknown). */
export function freshLinkWaitMs(linkUpAt: number, now: number, settleMs = HOST_SLICE_FRESH_LINK_SETTLE_MS): number {
  if (linkUpAt <= 0) return 0
  return Math.max(0, Math.ceil(linkUpAt + settleMs - now))
}
