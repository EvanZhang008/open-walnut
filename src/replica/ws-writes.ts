/**
 * WebSocket RPC writes of a host replica while the Mac is away
 * (docs/plan/walnut-replica-servers-impl.md, section 3 "WebSocket RPC writes"
 * and WP10). While the Mac answers, /ws is spliced to it; a socket on this
 * replica is an away one, and its write RPCs follow the RPC table
 * (ws-rpc-table.ts). A row whose away journals (`host-write`) is answered here
 * through the same write port as the HTTP routes, with the frame's client op id
 * (web/src/api/ws.ts sends one per request; minted here when absent):
 *
 *   session:send {sessionId, message, messageId?}   a session that runs on this
 *       host gets the message through `follower.send`; a session on the Mac is
 *       refused `needs_leader: session_on_mac` (its composer stays blocked, WP7)
 *
 * A write has no HTTP request to forward when the daemon says the Mac answers
 * again: it is refused `leader_unsure` (nothing was sent), and the socket is
 * moved to the Mac by the 4002 close that follows.
 */

import { wasNotSent } from '../host-server/daemon-link.js'
import { mintOpId, type ReplicaWrite, type ReplicaWriteResult } from './dispatch.js'
import { rpcAway } from './ws-rpc-table.js'
import type { PortAnswer, WritePort } from './write-port.js'

const TRIES = 3
const TIMEOUT_MS = 5_000
const RELINK_POLL_MS = 50
const OP_ID_RE = /^[A-Za-z0-9_-]{6,80}$/

export interface LinkWriteDeps {
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  linked(): boolean
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

/** A ReplicaWrite with no HTTP request behind it: lost answers asked again under the same op id. */
export function linkWrite(deps: LinkWriteDeps, given?: string): ReplicaWrite {
  const opId = given && OP_ID_RE.test(given) ? given : mintOpId()
  const run = async (cmd: string, params: Record<string, unknown>): Promise<ReplicaWriteResult> => {
    let lost = false
    const by = Date.now() + TIMEOUT_MS
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      if (attempt > 1) while (!deps.linked() && Date.now() < by) await new Promise((r) => setTimeout(r, RELINK_POLL_MS))
      let r: Record<string, unknown>
      try {
        r = await deps.request(cmd, params, TIMEOUT_MS)
      } catch (err) {
        if (!wasNotSent(err)) lost = true
        deps.log('warn', 'replica: a follower write over /ws got no answer, asking again', { cmd, opId, attempt, error: err instanceof Error ? err.message : String(err) })
        continue
      }
      if (r.ok === false && r.error === 'closed') { lost = true; continue }
      if (r.ok === true) return { kind: 'applied', reply: r }
      if (r.errorKind === 'leader_answers') {
        return lost
          ? { kind: 'refused', code: 'leader_unsure', message: 'Your Mac just came back, and this host may have kept the change; check it before you try again.', detail: { why: 'lost_answer' } }
          : { kind: 'refused', code: 'leader_unsure', message: 'Your Mac just came back; try again in a few seconds.' }
      }
      return {
        kind: 'refused', code: typeof r.errorKind === 'string' ? r.errorKind : 'refused', message: String(r.error ?? 'the daemon refused the write'),
        ...(r.detail !== undefined ? { detail: r.detail } : {}), ...(typeof r.retryAfterMs === 'number' ? { retryAfterMs: r.retryAfterMs } : {}),
      }
    }
    return lost
      ? { kind: 'refused', code: 'journal_unwritable', message: 'This host did not answer, and it may have kept the change; check it before you try again.', detail: { why: 'no_answer' } }
      : { kind: 'refused', code: 'needs_leader', message: 'This host\'s Walnut daemon did not answer.', detail: { why: 'daemon_unreachable' } }
  }
  return {
    opId, away: 'host-write', raw: Buffer.alloc(0),
    submit: (op, args, base, actor) => run('follower.op', { op, args, opId, ...(base === undefined ? {} : { base }), ...(actor ? { actor } : {}) }),
    call: (cmd, params) => run(cmd, { ...params, opId }),
  }
}

/** A port answer as an RPC result, or an Error whose text the console reads (`needs_leader: <why>`, or the message). */
export function rpcResult(a: PortAnswer): unknown {
  if (a.answered) throw new Error('needs_leader: needs_mac')
  if (a.status < 300) return a.body
  const e = (a.body.error ?? {}) as { code?: unknown; why?: unknown; message?: unknown }
  if (e.code === 'needs_leader') throw new Error(`needs_leader: ${typeof e.why === 'string' ? e.why : 'needs_mac'}`)
  throw new Error(typeof e.message === 'string' ? e.message : String(e.code ?? 'refused'))
}

export interface WsWritesDeps extends LinkWriteDeps {
  port: WritePort
  sessionHere(sid: string): Promise<boolean>
}

/** The replica's `setRpcAnswer` (src/web/ws/handler.ts): the journaling rows of the RPC table. */
export function wsWrites(deps: WsWritesDeps): (method: string, payload: unknown, opId: string | undefined) => Promise<unknown> | null {
  return (method, payload, opId) => {
    if (rpcAway(method).away !== 'host-write') return null
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
    if (method === 'session:send') {
      return (async () => {
        const sid = typeof p.sessionId === 'string' ? p.sessionId : ''
        if (!sid || !(await deps.sessionHere(sid))) throw new Error('needs_leader: session_on_mac')
        // The daemon delivers text: a picture rides only through the Mac.
        if (Array.isArray(p.images) && p.images.length) throw new Error('needs_leader: images_need_mac')
        const text = typeof p.message === 'string' ? p.message : typeof p.text === 'string' ? p.text : ''
        const w = linkWrite(deps, opId)
        return rpcResult(await deps.port.send(w, sid, text, typeof p.messageId === 'string' ? p.messageId : undefined))
      })()
    }
    return null
  }
}
