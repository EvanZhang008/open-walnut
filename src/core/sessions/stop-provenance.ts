/**
 * stop-provenance: the ownership fields every server-originated daemon `stop`
 * carries (daemon capability owner-home-v1).
 *
 * A session id or pid in this server's database proves nothing about which
 * Walnut started the session. An ephemeral test server runs over a copy of the
 * production data, so it holds the user's session ids, and with remote hosts on
 * it reaches the SAME shared remote daemon as production. So each stop names the
 * asking Walnut (`home`, its data dir) and says who decided it (`initiator`). The
 * daemon refuses the stop when its spawn journal records the session for another
 * Walnut (stopOwnerRefusal in both daemon twins). An ephemeral server adds
 * `strict`: it never started a session the journal names no Walnut for, so it may
 * stop none of those.
 *
 * `initiator` is 'automatic' for a reaper or sweep deciding from records (idle
 * timeout, capacity eviction, task completion, orphan sweep) and 'human' for a
 * person's stop, terminate or restart, and for the server driving a live session
 * it holds (a respawn to deliver a message). It only matters for a session with
 * no journal line at all, which only a human may stop.
 */

import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'

/** Daemon capability that checks a stop's `home` against the spawn journal. */
export const OWNER_HOME_CAPABILITY = 'owner-home-v1'

export type StopInitiator = 'human' | 'automatic'

export interface ProvenanceConnection {
  hasCapability?(cap: string): boolean
}

export interface StopProvenanceOptions {
  /** Defaults to this process: IS_EPHEMERAL. */
  ephemeral?: boolean
  /** Defaults to this process: WALNUT_HOME. */
  home?: string
}

/**
 * The fields to spread into a `stop` request, or null when this server must not
 * send the stop at all: an ephemeral server never stops anything on a daemon that
 * cannot check ownership (fail closed). The production server keeps sending the
 * old unlabelled stop to such a daemon (`{}`), which is today's behaviour.
 */
export function stopProvenance(
  conn: ProvenanceConnection | null | undefined,
  initiator: StopInitiator,
  opts: StopProvenanceOptions = {},
): Record<string, unknown> | null {
  const ephemeral = opts.ephemeral ?? IS_EPHEMERAL
  const checks = typeof conn?.hasCapability === 'function' && conn.hasCapability(OWNER_HOME_CAPABILITY)
  if (!checks) return ephemeral ? null : {}
  return { home: opts.home ?? WALNUT_HOME, initiator, ...(ephemeral ? { strict: true } : {}) }
}

/** The sentence a caller reports when stopProvenance said "do not send". */
export const STOP_NOT_SENT_NO_OWNERSHIP_CHECK =
  'Not stopped: this test server only stops sessions on a host whose daemon can check who started them (owner-home-v1)'

/** A daemon refusal reply, as one sentence for logs and pending-stop errors. */
export function describeStopRefusal(reply: Record<string, unknown>): string {
  if (typeof reply.error === 'string') return reply.error
  if (reply.reason === 'not_owned') {
    return reply.detail === 'other_walnut'
      ? 'Not stopped: the host\'s daemon records this session as started by another Walnut'
      : `Not stopped: the host's daemon has no record that this Walnut started this session (${String(reply.detail ?? 'not_owned')})`
  }
  if (typeof reply.reason === 'string') return `Daemon did not stop the session (${reply.reason}${typeof reply.detail === 'string' ? `: ${reply.detail}` : ''})`
  return 'Daemon did not confirm the stop'
}
