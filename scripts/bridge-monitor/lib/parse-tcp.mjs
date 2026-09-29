/**
 * Kernel `tcp_connection_summary` parser (port of the investigation's
 * tcpsum.py). The kernel logs TWO entries per closed socket, both keyed by
 * `so_gencnt`: the first carries the close function and the counters, the
 * second the SYN/FIN/RST tallies. Rows are merged by so_gencnt, so an
 * overlapping `log show` window never double-counts a connection.
 *
 * Accepts `log show --style ndjson` (what the collector uses) and the plain
 * text styles (`default` with a zone offset, `compact` without one).
 *
 * IP addresses are redacted by the kernel log ("<IPv4-redacted>"), and this
 * parser never keeps them anyway: only the ports.
 */

const HEAD_RE = /tcp_connection_summary (?:\((\w+):\d+\))?\[(.*?):(\d+)<->(.*?):(\d+)\] interface: (\S+)/

const NUM_FIELDS = [
  ['durS', /Duration: ([\d.]+) sec/, Number],
  ['connS', /Conn_Time: ([\d.]+) sec/, Number],
  ['rxmit', /pkt rxmit: (\d+)/, Number],
  ['ooo', /ooo pkts: (\d+)/, Number],
  ['rttMs', /(?:^|\s)rtt: ([\d.]+) ms/, Number],
  ['rttvarMs', /rttvar: ([\d.]+) ms/, Number],
  ['baseRttMs', /base rtt: (\d+) ms/, Number],
  ['soError', /so_error: (-?\d+)/, Number],
]

const PAIR_FIELDS = [
  ['bytes', /bytes in\/out: (\d+)\/(\d+)/],
  ['pkts', /pkts in\/out: (\d+)\/(\d+)/],
  ['syn', /SYN in\/out: (\d+)\/(\d+)/],
  ['fin', /FIN in\/out: (\d+)\/(\d+)/],
  ['rst', /RST in\/out: (\d+)\/(\d+)/],
]

/** Parse one entry's message into a partial row (null when not a summary). */
export function parseSummaryMessage(msg) {
  const head = HEAD_RE.exec(msg)
  if (!head) return null
  const so = /so_gencnt: (\d+)/.exec(msg)
  if (!so) return null
  const proc = /process: (.+?):(\d+)(?:\s|$)/.exec(msg)
  const row = {
    soGen: so[1],
    localPort: Number(head[3]),
    remotePort: Number(head[5]),
    iface: head[6],
  }
  if (head[1]) row.closefn = head[1]
  const state = /t_state: (\S+)/.exec(msg)
  if (state) row.state = state[1]
  if (proc) { row.proc = proc[1]; row.pid = Number(proc[2]) }
  for (const [key, re, conv] of NUM_FIELDS) {
    const m = re.exec(msg)
    if (m) row[key] = conv(m[1])
  }
  for (const [key, re] of PAIR_FIELDS) {
    const m = re.exec(msg)
    if (m) { row[`${key}In`] = Number(m[1]); row[`${key}Out`] = Number(m[2]) }
  }
  return row
}

/** "2026-09-26 10:19:34.204295-0700" (or no offset + tz fallback) -> ISO. */
function isoFromLogStamp(stamp, fallbackOffsetMin) {
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d{4})?$/.exec(stamp.trim())
  if (!m) return null
  const frac = m[3] ? m[3].slice(0, 4) : ''
  let offMin = fallbackOffsetMin
  if (m[4]) {
    const sign = m[4][0] === '-' ? -1 : 1
    offMin = sign * (Number(m[4].slice(1, 3)) * 60 + Number(m[4].slice(3, 5)))
  }
  const utc = Date.parse(`${m[1]}T${m[2]}${frac}Z`) - offMin * 60_000
  return Number.isNaN(utc) ? null : new Date(utc).toISOString()
}

/** Split raw `log show` output into [{stamp, msg}] entries. */
function entries(text) {
  const out = []
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    for (const line of text.split('\n')) {
      const s = line.trim().replace(/^\[|,$|\]$/g, '')
      if (!s.startsWith('{')) continue
      try {
        const o = JSON.parse(s)
        if (typeof o.eventMessage === 'string') out.push({ stamp: o.timestamp, msg: o.eventMessage })
      } catch { /* partial line */ }
    }
    return out
  }
  // Text styles: an entry starts at a line beginning with a timestamp.
  const parts = text.split(/\n(?=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/)
  for (const part of parts) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?(?:[+-]\d{4})?)/.exec(part)
    if (m) out.push({ stamp: m[1], msg: part })
  }
  return out
}

/**
 * Parse `log show` output into merged rows keyed by so_gencnt.
 * @param {object} opts
 * @param {(row) => boolean} [opts.keep]  filter on the merged row (e.g. by proc)
 * @param {number} [opts.offsetMin]  zone offset for stamps without one (compact style)
 */
export function parseTcpSummaries(text, { keep = () => true, offsetMin = -new Date().getTimezoneOffset() } = {}) {
  const rows = new Map()
  for (const { stamp, msg } of entries(text)) {
    const part = parseSummaryMessage(msg)
    if (!part) continue
    const t = isoFromLogStamp(String(stamp ?? ''), offsetMin)
    const row = rows.get(part.soGen) ?? { t }
    if (t && (!row.t || t < row.t)) row.t = t
    Object.assign(row, part)
    rows.set(part.soGen, row)
  }
  return [...rows.values()].filter(keep).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
}

/** Row filter: process name starts with one of `names`, or pid in `pids`. */
export function processFilter(names = [], pids = []) {
  const pidSet = new Set(pids.map(Number))
  return (row) => (row.proc && names.some((n) => row.proc.startsWith(n.slice(0, 16)))) || pidSet.has(row.pid)
}

/**
 * How the socket ended, from the kernel's point of view:
 *  'drop'         the kernel gave up on it: a timeout (so_error 60, retransmit
 *                 or keepalive) or a lost local address (so_error 49)
 *  'local-abort'  this side aborted it: tcp_drop with no error, i.e. a close
 *                 with linger 0 or a destroyed socket, which sends a RST OUT.
 *                 The kernel sets an errno on every drop it starts itself, so
 *                 so_error 0 means a local process asked for it. Not a
 *                 network drop (seen live: 3 such rows were counted as M2).
 *  'local'        this side closed first (FIN_WAIT / TIME_WAIT), even if RSTs followed
 *  'peer-reset'   the far side (or a middlebox) sent RST while the socket was open
 *  'peer-fin'     the far side closed first (FIN in, LAST_ACK / CLOSE_WAIT)
 */
const LOCAL_FIRST_STATES = new Set(['FIN_WAIT_1', 'FIN_WAIT_2', 'TIME_WAIT', 'CLOSING'])

export function tcpEnding(row) {
  if (!row) return null
  if (row.soError === 60) return 'drop'
  if (row.closefn === 'tcp_drop') {
    if (!row.soError) return 'local-abort'
    if (row.soError === 54 || (row.rstIn ?? 0) > 0) return 'peer-reset'
    return 'drop'
  }
  if (LOCAL_FIRST_STATES.has(row.state)) return 'local'
  if ((row.rstIn ?? 0) > 0) return 'peer-reset'
  if ((row.finIn ?? 0) > 0) return 'peer-fin'
  return 'local'
}

/**
 * Minutes of kernel log the next sweep reads. Normally the configured window
 * (a little over the sweep period, so sweeps overlap and so_gencnt dedupes);
 * after skipped or failed sweeps, back to the last good one plus 2 minutes;
 * and on the very first sweep, as far back as allowed, like the daemon log
 * backfill. Capped at maxWindowMin. The unified log itself only holds these
 * entries for about 2 hours on a busy Mac, so older minutes come back empty.
 */
export function sweepWindowMin(lastGoodEndMs, nowMs, { windowMin, maxWindowMin }) {
  const sinceMin = lastGoodEndMs ? Math.ceil((nowMs - lastGoodEndMs) / 60_000) + 2 : maxWindowMin
  return Math.min(maxWindowMin, Math.max(windowMin, sinceMin))
}
