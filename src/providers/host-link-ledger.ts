/**
 * When each host's daemon link was down, so a wait measured on the wall clock
 * can leave that time out (delivery-latency.ts), the way sleep-ledger.ts leaves
 * out the machine's sleep.
 *
 * 2026-11-11, the send.resume health alarm: two messages to clouddev sessions
 * read 65 s and 90 s "slow to wake", but the link to clouddev was down from
 * 17:25:30 to 17:28:00; once it was back, each resume took about 5 s. The
 * outage is the host link's (its own alarm and banner), not the resume path's.
 *
 * DaemonConnection.setConnected records each edge of a link that was up: down
 * opens an interval, up closes it. An open interval counts up to the moment
 * asked. Only this process's edges are known.
 */

export interface DownInterval { start: number; end: number }

/** The most intervals kept per host: a flapping link drops a few hundred times a day. */
export const LINK_LEDGER_MAX = 500

const closed = new Map<string, DownInterval[]>()
const open = new Map<string, number>()

/** The link to `host` went down at `at` (ms). A second down edge keeps the first start. */
export function noteHostLinkDown(host: string, at: number = Date.now()): void {
  if (!host || open.has(host)) return
  open.set(host, at)
}

/** The link to `host` is up again at `at` (ms). */
export function noteHostLinkUp(host: string, at: number = Date.now()): void {
  const start = open.get(host)
  if (start === undefined) return
  open.delete(host)
  if (!(at > start)) return
  const list = closed.get(host) ?? []
  list.push({ start, end: at })
  if (list.length > LINK_LEDGER_MAX) list.splice(0, list.length - LINK_LEDGER_MAX)
  closed.set(host, list)
}

/** The parts of `[from, to]` (wall clock, ms) the link to `host` was down, as far as this process saw. */
export function linkDownIntervals(host: string, from: number, to: number, now: number = Date.now()): DownInterval[] {
  if (!host || !(to > from)) return []
  const out: DownInterval[] = []
  const add = (s: number, e: number) => {
    const a = Math.max(from, s)
    const b = Math.min(to, e)
    if (b > a) out.push({ start: a, end: b })
  }
  for (const d of closed.get(host) ?? []) add(d.start, d.end)
  const o = open.get(host)
  if (o !== undefined) add(o, Math.max(o, now))
  return out
}

/** Tests: forget every host's intervals. */
export function __resetHostLinkLedgerForTest(): void {
  closed.clear()
  open.clear()
}
