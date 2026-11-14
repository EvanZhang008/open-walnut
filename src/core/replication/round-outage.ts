/**
 * One place for how a leader's replication round reports a failure (copies, task
 * replica, search replica, device list, the host replica's kinds and pictures).
 *
 * A round whose target cannot be reached right now (its stream lane is not up,
 * the host is not connected, the companion's name does not resolve) fails with
 * nothing sent, and the next round sends it once the target is back: that is a
 * wait, not a fault. Rounds run on every store write, so a host that stayed away
 * for five hours wrote a warn per kind per round, about a thousand an hour
 * (2026-11-14: clouddev's SSH key was refused from 07:00 to 12:00 UTC and
 * "copies: round failed" spiked to 1,191 lines an hour). The link's own log
 * already says why it is down ("stream lane: dial failed"), so here an outage is
 * one info line when it starts and one when the target answers again, per round
 * kind and target. Any other failure is still a warn on every round.
 */

/**
 * The failures that mean "the target is not reachable now", each pinned to the
 * wording of its producer (tests/core/replication/round-outage.test.ts checks
 * the producers still say it). A timeout or a reset is not here: the target was
 * reached and something went wrong on the way. Each one is anchored to the
 * whole sentence its producer writes, so a follower's own reply that merely
 * mentions such an error (its downstream call refused) stays a fault.
 */
export const UNREACHABLE_SIGNATURES: ReadonlyArray<{ re: RegExp; producer: string; literal: string }> = [
  // DaemonConnection.openStream: a background stream never takes the session link.
  { re: /^the stream lane to \S+ is not up; a background copy waits for it$/, producer: 'src/providers/daemon-connection.ts', literal: 'a background copy waits for it' },
  // host-server/manager.ts: the copy target's post before it opens a stream.
  { re: /^the host is not connected$/, producer: 'src/core/host-server/manager.ts', literal: "'the host is not connected'" },
  // stream-lane.ts: the lane closed under a stream, or a stream asked while it was down.
  { re: /^the lane was closed$/, producer: 'src/providers/stream-lane.ts', literal: "'the lane was closed'" },
  { re: /^the stream lane to \S+ (?:closed|is not up)$/, producer: 'src/providers/stream-lane.ts', literal: 'the stream lane to ${this.opts.hostKey}' },
  // DaemonConnection: the session link's streams when the link itself closed.
  { re: /^the link to \S+ closed$/, producer: 'src/providers/daemon-connection.ts', literal: 'the link to ${this.hostKey} closed' },
  // DaemonConnection: the host replica's upload channel (its own SSH connection) is down.
  { re: /^[\w.]+: the upload channel to \S+ is not up\b.*; nothing was sent, try again$/, producer: 'src/providers/daemon-connection.ts', literal: 'the upload channel to ${this.hostKey} is not up' },
  // The daemon twins: nothing on the host follows this Walnut (its server is restarting).
  { re: /^no server on this host follows that Walnut$/, producer: 'src/providers/daemon-standalone.ts', literal: 'no server on this host follows that Walnut' },
  // DaemonConnection.send on a link that is down.
  { re: /^DaemonConnection not connected to [\w.-]+(?::.*)?$/, producer: 'src/providers/daemon-connection.ts', literal: 'DaemonConnection not connected to ' },
  // The companion over the network: no name, no route, nothing listening.
  { re: /^(?:getaddrinfo E(?:NOTFOUND|AI_AGAIN)|connect E(?:CONNREFUSED|HOSTUNREACH|NETUNREACH)) \S+$/, producer: 'node:net', literal: '' },
]

/** True when a round's error says the target is not reachable now (UNREACHABLE_SIGNATURES). */
export function targetUnreachable(error: string): boolean {
  return UNREACHABLE_SIGNATURES.some((s) => s.re.test(error))
}

interface RoundLog {
  warn(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
}

interface Outage { since: number; error: string; rounds: number; noted: number }
/** A long outage says so again this often, so a host that never comes back is not silent. */
export const OUTAGE_RENOTE_MS = 60 * 60_000
/** `<scope>\0<target>` → the outage that scope's rounds have seen on that target since its last answer. */
const outages = new Map<string, Outage>()
const keyOf = (scope: string, target: string): string => `${scope}\0${target}`

/**
 * A round of `scope` (the line's prefix: 'copies', 'task replica') failed on
 * `target`. Unreachable: an info line at the start of the outage, nothing after.
 * Anything else: `<scope>: round failed`, a warn every time. Returns whether the
 * target was unreachable, so a round can skip its other kinds for that target.
 */
export function noteRoundFailure(
  log: RoundLog, scope: string, target: string, error: string,
  fields: Record<string, unknown> = {}, opts: { now?: number; message?: string } = {},
): boolean {
  if (!targetUnreachable(error)) {
    log.warn(opts.message ?? `${scope}: round failed`, { target, ...fields, error })
    return false
  }
  const key = keyOf(scope, target)
  const at = opts.now ?? Date.now()
  const known = outages.get(key)
  if (known) {
    known.rounds++
    if (at - known.noted >= OUTAGE_RENOTE_MS) {
      known.noted = at
      log.info(`${scope}: a target is still not reachable, its rounds wait for it`, { target, ...fields, error, waitedS: Math.round((at - known.since) / 1000), rounds: known.rounds })
    }
    return true
  }
  outages.set(key, { since: at, error, rounds: 1, noted: at })
  log.info(`${scope}: a target is not reachable, its rounds wait for it`, { target, ...fields, error })
  return true
}

/** A round of `scope` reached `target` (it answered): an outage noted before ends, with one info line. */
export function noteRoundReached(log: RoundLog, scope: string, target: string, opts: { now?: number } = {}): void {
  const key = keyOf(scope, target)
  const known = outages.get(key)
  if (!known) return
  outages.delete(key)
  log.info(`${scope}: a target is reachable again`, {
    target, waitedS: Math.round(((opts.now ?? Date.now()) - known.since) / 1000), rounds: known.rounds, error: known.error,
  })
}

/** The target itself answered this post (a gateway's 502/503/504 is not the target). */
export function answered(r: { ok: boolean; status?: number }): boolean {
  return r.ok || (r.status !== undefined && r.status !== 502 && r.status !== 503 && r.status !== 504)
}

/**
 * `target` with its post watched: any answer of the target (a reply, or an HTTP
 * status other than a proxy's 502/503/504 for it) ends the outage `scope` noted on it. Only an answer proves the target
 * is back; a round can end `unchanged` from the leader's memo without asking it.
 */
export function answeredBy<T extends { id: string; post(payload: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<{ ok: boolean; status?: number }> }>(
  log: RoundLog, scope: string, target: T,
): T {
  return {
    ...target,
    post: async (payload: Record<string, unknown>, opts?: { timeoutMs?: number }) => {
      const r = await target.post(payload, opts)
      if (answered(r)) noteRoundReached(log, scope, target.id)
      return r
    },
  }
}

/** Tests only. */
export function _resetRoundOutagesForTesting(): void {
  outages.clear()
}
