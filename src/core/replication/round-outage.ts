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
 *
 * The same holds for a background push lane to the companion (cloud-ingest.ts):
 * 2026-11-17 the Mac's DNS was down and each push wrote "cloud ingest: push failed".
 *
 * A refusal by the half rule (`manifest_removes_most_rows`) is not a fault either: the
 * target was reached and keeps its copy on purpose until the leader's list changes enough,
 * the target's build takes moves, or the user confirms on the Settings row. Its producer
 * (the host replica's removal guard, kind-leader.ts) writes the warn when the refusal
 * starts; here it is one info line per refusal, kind and target, until that kind's round
 * is taken again (2026-11-20: the one tree moved every note, the companion's build could
 * not take moves, and each round wrote "host replica: round failed", up to 178 an hour).
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
  // The same under bun's fetch, which words a refused or unroutable connection its own way.
  { re: /^E(?:CONNREFUSED|HOSTUNREACH|NETUNREACH): Unable to connect\. Is the computer able to access the url\?$/, producer: 'bun:fetch', literal: '' },
]

/** The half rule's refusal (replication/kind.ts REFUSAL_ERROR), as an error message words it. */
const REFUSAL_RE = /^(?:[\w.]+: )?manifest_removes_most_rows\b/

/** True when a round's error is the target's half-rule refusal: it answered and keeps its copy. */
export function targetRefused(error: string): boolean {
  return REFUSAL_RE.test(error)
}

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
/** `<scope>\0<target>\0<kind>` → the refusal that kind's rounds have met there since it was last taken. */
const refusals = new Map<string, Outage>()
const refusalKeyOf = (scope: string, target: string, kind: unknown): string => `${keyOf(scope, target)}\0${typeof kind === 'string' ? kind : ''}`

/**
 * A round of `scope` (the line's prefix: 'copies', 'task replica') failed on
 * `target`. Unreachable: an info line at the start of the outage, nothing after.
 * A half-rule refusal: an info line when it starts (per `fields.kind`), nothing after
 * until noteRefusalEnded names that kind. Anything else: `<scope>: round failed`, a
 * warn every time. Returns whether the target was unreachable, so a round can skip its
 * other kinds for that target (a refusal is the target answering: false).
 */
export function noteRoundFailure(
  log: RoundLog, scope: string, target: string, error: string,
  fields: Record<string, unknown> = {}, opts: { now?: number; message?: string } = {},
): boolean {
  if (targetRefused(error)) {
    noteStanding(refusals, refusalKeyOf(scope, target, fields.kind), opts.now ?? Date.now(), error, (known, at) => {
      if (!known) log.info(`${scope}: a target refused a manifest that removes most of its copy, its rounds keep it until that changes`, { target, ...fields, error })
      else log.info(`${scope}: a target still refuses a manifest that removes most of its copy`, { target, ...fields, error, waitedS: Math.round((at - known.since) / 1000), rounds: known.rounds })
    })
    return false
  }
  if (!targetUnreachable(error)) {
    log.warn(opts.message ?? `${scope}: round failed`, { target, ...fields, error })
    return false
  }
  noteStanding(outages, keyOf(scope, target), opts.now ?? Date.now(), error, (known, at) => {
    if (!known) log.info(`${scope}: a target is not reachable, its rounds wait for it`, { target, ...fields, error })
    else log.info(`${scope}: a target is still not reachable, its rounds wait for it`, { target, ...fields, error, waitedS: Math.round((at - known.since) / 1000), rounds: known.rounds })
  })
  return true
}

/** A standing state (an outage, a refusal) met again: `say` runs when it starts and once an hour after. */
function noteStanding(map: Map<string, Outage>, key: string, at: number, error: string, say: (known: Outage | null, at: number) => void): void {
  const known = map.get(key)
  if (!known) {
    map.set(key, { since: at, error, rounds: 1, noted: at })
    say(null, at)
    return
  }
  known.rounds++
  if (at - known.noted >= OUTAGE_RENOTE_MS) {
    known.noted = at
    say(known, at)
  }
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

/**
 * `target` holds `kind`'s current manifest (its round was taken, or it already held it:
 * a memo or digest `unchanged`, never a refusal the leader holds back): a refusal noted
 * for that kind ends, with one info line.
 */
export function noteRefusalEnded(log: RoundLog, scope: string, target: string, kind: string, opts: { now?: number } = {}): void {
  const key = refusalKeyOf(scope, target, kind)
  const refused = refusals.get(key)
  if (!refused) return
  refusals.delete(key)
  log.info(`${scope}: a target took a manifest it had refused`, {
    target, kind, waitedS: Math.round(((opts.now ?? Date.now()) - refused.since) / 1000), rounds: refused.rounds,
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
  refusals.clear()
}
