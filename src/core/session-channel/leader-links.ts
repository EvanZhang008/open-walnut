/**
 * The two ways the leader's side (leader-side.ts) reaches a host's server, and what each carries:
 *
 *   leader-dialed  the leader opens a stream through the host's daemon link (`openStream('follower',
 *                  ...)`): the channel is a WebSocket on one stream (`session-channel`), each host
 *                  call one HTTP request on a stream of its own (`session-call`)
 *   host-dialed    the host opened a socket into the leader's door (host-door.ts) and both proved
 *                  who they are: the channel's frames and the host calls ride that one socket, the
 *                  calls as `door` call/reply frames the host answers from the same route table
 *                  (host-routes.ts call)
 *
 * SESSION_LINK_KINDS names them for the connection-kind matrix
 * (tests/core/hosts/every-feature-every-connection.test.ts).
 */
import type { Duplex } from 'node:stream'
import { HOST_CHANNEL_PATH } from './host-api.js'

export const SESSION_LINK_KINDS = ['leader-dialed', 'host-dialed'] as const
export type SessionLinkKind = typeof SESSION_LINK_KINDS[number]

/** A text link: a WebSocket in production, anything that carries whole frames in tests. */
export interface ChannelSocket {
  send(text: string): void
  close(why?: string): void
  onMessage(fn: (text: string) => void): void
  onClose(fn: () => void): void
  /** Which side opened it (leader-dialed when absent). */
  kind?: SessionLinkKind
  /**
   * A host-dialed socket: one HTTP-shaped request to the host's routes, as frames on this socket.
   * Throws HostRequestNotSent when the frame could not be sent (the socket is gone).
   */
  call?(method: string, route: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }>
}

export interface HostCallAnswer { ok: boolean; value?: unknown; error?: string; why?: string; [k: string]: unknown }

/** A request that never left this server (no stream to the host): the host cannot have taken it. */
export class HostRequestNotSent extends Error {
  readonly notSent = true
  constructor(hostKey: string, cause: unknown) {
    super(`the request did not reach the host ${hostKey}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'HostRequestNotSent'
  }
}

/** Did this error come from a request that never left this server? */
export function requestNotSent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { notSent?: unknown }).notSent === true
}

/** A host's answer as a call's answer: its JSON, or an error naming the status. */
export function answerOf(status: number, text: string): HostCallAnswer {
  let answer: HostCallAnswer
  try { answer = JSON.parse(text) as HostCallAnswer } catch { answer = { ok: false, error: `HTTP ${status}: ${text.slice(0, 200)}` } }
  if (!answer || typeof answer !== 'object') answer = { ok: false, error: `HTTP ${status}` }
  return answer
}

/** The channel's link to `hostKey`, leader-dialed: a WebSocket over a stream through the host's daemon. */
export async function dialOverStream(openStream: (hostKey: string, purpose: string) => Promise<Duplex>, hostKey: string): Promise<ChannelSocket> {
  const stream = await openStream(hostKey, 'session-channel')
  const { WebSocket } = await import('#ws')
  const ws = new WebSocket(`ws://host-server${HOST_CHANNEL_PATH}`, { createConnection: () => stream } as never)
  // The host speaks first (its hello), possibly in the same read as the upgrade's answer: frames
  // are held from the start until the channel takes them, and so is a close.
  const held: string[] = []
  let onText: ((text: string) => void) | null = null
  let closed = false
  let onGone: (() => void) | null = null
  ws.on('message', (data) => { const text = String(data); if (onText) onText(text); else held.push(text) })
  ws.on('close', () => { closed = true; onGone?.() })
  ws.on('error', () => { /* a close follows */ })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
    ws.once('unexpected-response', (_req: unknown, res: { statusCode?: number }) => reject(new Error(`the host refused the session channel (HTTP ${res.statusCode ?? '?'})`)))
    ws.once('close', () => reject(new Error('the host closed the session channel before it opened')))
  })
  return {
    kind: 'leader-dialed',
    send: (text) => ws.send(text),
    close: (why) => { try { ws.close(1000, (why ?? '').slice(0, 100)) } catch { ws.terminate() } },
    onMessage: (fn) => { onText = fn; for (const text of held.splice(0)) fn(text) },
    onClose: (fn) => { onGone = fn; if (closed) fn() },
  }
}

/** One POST to the host's server on a stream of its own (`session-call`). */
export async function requestOverStream(openStream: (hostKey: string, purpose: string) => Promise<Duplex>, hostKey: string, route: string, body: unknown, timeoutMs: number): Promise<HostCallAnswer> {
  let stream: Duplex
  // No stream: nothing reached the host (not connected, the stream refused). The caller knows the
  // host never saw it, unlike a request sent whose answer was lost.
  try { stream = await openStream(hostKey, 'session-call') } catch (err) { throw new HostRequestNotSent(hostKey, err) }
  const { requestOver } = await import('../host-server/request-over.js')
  const res = await requestOver(stream, 'POST', route, Buffer.from(JSON.stringify(body ?? {})), timeoutMs)
  return answerOf(res.status, await res.text())
}
