/**
 * The candidate's way to the machine that leads, over this machine's EXISTING host link
 * (docs/reference/leader-switch.md, "The leader relay"). A machine that is a host of the leader runs
 * this Walnut's host service, whose follower link to its own daemon can open a stream to the leader
 * (`link.openStream('primary', LEADER_RELAY_PURPOSE)`, src/host-server/daemon-link.ts). The service
 * serves that as a unix socket, `<daemon dir>/leader-relay/<16 hex>.sock` (0600 in a 0700 dir: only
 * this account connects, as with the host call entry), each connection spliced into one such stream
 * (src/replica/leader-relay-entry.ts). The leader's server takes a stream of that purpose only into
 * its relay door (leader-relay-door.ts), never into its tunnel port, so nothing a host's public
 * listener forwards can reach it.
 *
 * Over it the candidate's processes (the switch command run on the new machine, its check, the
 * target job) reach:
 *   - `POST /leader-switch/begin`: the forwarded begin (the leader's trust rule: the link's machine id is `to`);
 *   - `GET /leader-switch/job`: the lines of the source job that begin started on the leader's machine;
 *   - `/leader-witness/challenge|request`: the witness door of the leader's machine, proven with that
 *     witness's own key as on way b (the `host-link` way of witness-transport.ts).
 * No process here builds a link: the stream is the host service's, and a candidate, a standby, a
 * trial or a commit start only opens a unix socket. The opener is injected everywhere (StreamOpener),
 * so the transport does not care how the stream is made.
 *
 * It lives only while the leader's server does: at the leader's switch stop its links close, so the
 * way ends before the new leader's commit (see "The leader relay ends at the stop" in the doc).
 */
import fs from 'node:fs'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { leaderRelaySocketPath, leaderRelayWhyPath } from '../../../lib/leader-relay-names.js'
import { requestOver } from '../../host-server/request-over.js'
import { directWitnessCall, type DoorPost } from './witness-direct.js'
import { WITNESS_DOOR_PATH } from './witness-wire.js'
import type { HostLink, RemoteCall } from './witness-transport.js'

export { LEADER_RELAY_PURPOSE, LEADER_RELAY_SOCKET_DIR, leaderRelaySocketPath } from '../../../lib/leader-relay-names.js'

export const RELAY_BEGIN_PATH = '/leader-switch/begin'
export const RELAY_JOB_PATH = '/leader-switch/job'
export const RELAY_WHOAMI_PATH = '/leader-switch/whoami'

/** A way to make one byte stream to the leader's relay door. */
export type StreamOpener = () => Promise<Duplex>

/** The host daemon's dir as a process of this machine sees it (WALNUT_DAEMON_DIR, else the machine's default). */
export async function relayDaemonDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = (env.WALNUT_DAEMON_DIR ?? '').trim()
  if (explicit) return explicit
  return (await import('../../../lib/daemon-dir.js')).localDaemonDirChoice().dir
}

/** Why there is no relay at `socketPath`, or null when a socket is there to try. */
export function relayAbsent(socketPath: string): string | null {
  try {
    if (!fs.lstatSync(socketPath).isSocket()) return `${socketPath} is not a socket`
    return null
  } catch {
    // The service is there but refused to serve it (a daemon dir too deep for a unix socket, say): its own words.
    let why = ''
    try { why = fs.readFileSync(leaderRelayWhyPath(socketPath), 'utf8').trim() } catch { /* none */ }
    if (why) return `this Walnut's service on this machine does not serve its leader relay: ${why} (${socketPath})`
    return `no Walnut service of this Walnut runs on this machine as a host of the leader (no relay socket ${socketPath})`
  }
}

/** The opener of a relay socket: one connection, made within `timeoutMs`. */
export function relaySocketOpener(socketPath: string, timeoutMs = 5_000): StreamOpener {
  return () => new Promise<Duplex>((resolve, reject) => {
    const s = net.connect({ path: socketPath })
    const timer = setTimeout(() => { s.destroy(); reject(new Error('the relay socket did not take the connection in time')) }, timeoutMs)
    timer.unref?.()
    s.once('connect', () => { clearTimeout(timer); resolve(s) })
    s.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

export interface RelayAnswer { status: number; json: unknown }

/** One request to the leader's relay door; rejects when no answer came (no stream, a cut, a timeout). */
export async function relayRequest(open: StreamOpener, method: string, route: string, body: unknown, timeoutMs: number): Promise<RelayAnswer> {
  const stream = await open()
  stream.on('error', () => { /* answered below by the request's own error */ })
  try {
    const res = await requestOver(stream, method, route, body === undefined ? null : Buffer.from(JSON.stringify(body)), timeoutMs)
    return { status: res.status, json: await res.json().catch(() => null) }
  } finally {
    stream.destroy()
  }
}

/**
 * The DoorPost of the `host-link` way: each post one stream from `open`, one HTTP request on it, the
 * answer or `null` (no stream, a cut, a timeout: no answer, as a lost post is on way b). Abandoning it
 * destroys its stream.
 */
export function streamDoorPost(open: StreamOpener, timeoutMs = 15_000): DoorPost {
  return (url, body, done) => {
    let stream: Duplex | null = null
    let settled = false
    const finish = (r: { status: number; json: unknown } | null): void => {
      if (settled) return
      settled = true
      stream?.destroy()
      done(r)
    }
    void open().then(async (s) => {
      if (settled) { s.destroy(); return }
      stream = s
      s.on('error', () => { /* the request's own error answers */ })
      const res = await requestOver(s, 'POST', url, Buffer.from(JSON.stringify(body)), timeoutMs)
      const json = await res.json().catch(() => null)
      finish({ status: res.status, json })
    }).catch(() => finish(null))
    return () => { settled = true; stream?.destroy() }
  }
}

/**
 * The `host-link` way as a RemoteCall: the witness door of the leader's machine at WITNESS_DOOR_PATH,
 * reached by `post` (production: streamDoorPost over the relay), the call and its proofs exactly way b's
 * (witness-direct.ts): the witness's own key proves both sides, so the relay is trusted with nothing.
 * A witness the leader's machine does not keep answers no_witness_here there, which is no answer.
 */
export function hostLinkWitnessCall(post: DoorPost): RemoteCall {
  const inner = directWitnessCall({ post })
  return (place, p, body, done) => inner({ ...place, url: WITNESS_DOOR_PATH }, p, body, done)
}

/** The machine the relay reaches (its leader's, GET /leader-switch/whoami), or null when nothing leads there. */
export async function relayMachine(open: StreamOpener, timeoutMs = 5_000): Promise<string | null> {
  const r = await relayRequest(open, 'GET', RELAY_WHOAMI_PATH, undefined, timeoutMs).catch(() => null)
  const m = (r?.json as { machine?: unknown } | null)?.machine
  return r?.status === 200 && typeof m === 'string' && m ? m : null
}

/**
 * The production `host-link` way of a process of this machine for Walnut `walnutId`: the call, and the leader's
 * machine it reaches (its witness is the only one asked there). Null when no relay socket is here, or nothing
 * that leads answers over it.
 */
export async function hostLinkCallHere(walnutId: string, env: NodeJS.ProcessEnv = process.env): Promise<HostLink | null> {
  const socket = leaderRelaySocketPath(await relayDaemonDir(env), walnutId)
  if (relayAbsent(socket)) return null
  const open = relaySocketOpener(socket)
  const machine = await relayMachine(open)
  return machine ? { call: hostLinkWitnessCall(streamDoorPost(open)), machine } : null
}
