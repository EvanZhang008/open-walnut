/**
 * What the cloud companion answers for a host's sessions while it leads
 * (docs/plan/walnut-control-plane.md). Cloud box only.
 *
 * A host's daemon answers everything it can from its own copy first (the
 * offline host). Only what it cannot answer reaches here, as a
 * `gateway-request` over the bridge:
 *   - a message to a session on another host (task_send): routed to that
 *     host's daemon with `leader.deliver`, which owns the reply request;
 *   - a reply or a notice another host built for a session here
 *     (`leader.deliverText`): handed to the asker's host the same way;
 *   - reads and task writes outside the host's copy: run against this box's
 *     replica through the op registry, on the same routes the phone's calls
 *     reach (writes reach the primary through the replica's own task queue;
 *     the calls prove themselves with this server's self-call credential).
 * Everything else needs the primary and says so.
 */

import { log } from '../../logging/index.js'
import type { BackupLeader } from './backup-leader.js'

export interface GatewayRequestFrame {
  relayId?: unknown
  capability?: unknown
  callerSid?: unknown
  payload?: unknown
  walnutId?: unknown
  epoch?: unknown
  caller?: unknown
}

type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: string; message: string; detail?: unknown }

export interface BackupGatewayDeps {
  leader: BackupLeader
  request: (host: string, cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** This box's sessions as the primary last pushed them. */
  sessions: () => Promise<Array<{ id: string; host: string; task_id?: string; title?: string; task_title?: string; process_status: string; last_active_at?: string }>>
  /** A task of this box's replica by id or unique prefix, with its current session (`sessionId`). */
  findTask: (ref: string) => Promise<{ id: string; title: string; sessionId?: string } | { ambiguous: number } | null>
  executeOp: (name: string, args: Record<string, unknown>, ctx: { callerSid: string; callerHost: string }) => Promise<{ ok: boolean; result?: unknown; message?: string }>
}

/** Ops the companion runs on its replica for a host while it leads. */
export const LEADER_OPS = [
  'task_get', 'task_get_bulk', 'task_list', 'search', 'project_list',
  'task_create', 'task_update', 'task_complete', 'task_update_bulk', 'task_complete_bulk',
  'note_read', 'note_search', 'memory_read', 'skill_read',
] as const

const DELIVER_TIMEOUT_MS = 15_000
const LIVE_STATUSES = new Set(['running', 'idle', 'processing', 'waiting', 'starting'])

/** How the Walnut names a host in envelopes ('local' = the primary box) → its bridge alias. */
export function bridgeAliasOf(host: string): string {
  return !host || host === 'local' ? '__local__' : host
}

function needsPrimary(what: string): Outcome {
  return {
    ok: false, code: 'hub_unreachable',
    message: `${what} needs the Walnut server, which is away. The cloud companion leads meanwhile and answers: messages to sessions on other hosts, ${LEADER_OPS.join(', ')}.`,
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

export function createBackupGateway(deps: BackupGatewayDeps) {
  /** The lead this companion holds on `host` for this frame's Walnut, or why not. */
  function leadOf(host: string, frame: GatewayRequestFrame): { walnutId: string; epoch: number } | Outcome {
    const lead = deps.leader.leadFor(host)
    if (!lead || lead.walnutId !== frame.walnutId || lead.epoch !== frame.epoch) {
      return { ok: false, code: 'hub_unreachable', message: 'the cloud companion does not lead this host right now; retry in a minute' }
    }
    return lead
  }

  async function deliver(targetAlias: string, delivery: Record<string, unknown>): Promise<Outcome> {
    const lead = deps.leader.leadFor(targetAlias)
    if (!lead) {
      return { ok: false, code: 'hub_unreachable', message: `the host ${targetAlias === '__local__' ? 'of the Walnut server' : targetAlias} is not reachable while the Walnut server is away` }
    }
    let reply: Record<string, unknown>
    try {
      reply = await deps.request(targetAlias, 'leader.deliver', { walnutId: lead.walnutId, epoch: lead.epoch, delivery }, DELIVER_TIMEOUT_MS)
    } catch (err) {
      return { ok: false, code: 'hub_unreachable', message: `could not reach ${targetAlias}: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (reply.ok === true) return { ok: true, result: asRecord(reply.result) }
    const kind = String(reply.errorKind ?? 'internal')
    if (kind === 'stale_epoch' || kind === 'not_leader') deps.leader.lostHost(targetAlias, kind)
    return { ok: false, code: kind === 'stale_epoch' || kind === 'not_leader' ? 'hub_unreachable' : kind, message: String(reply.error ?? 'delivery refused'), ...(reply.detail !== undefined ? { detail: reply.detail } : {}) }
  }

  /** task_send from a session on `host` to a session that does not run there. */
  async function routeSend(host: string, frame: GatewayRequestFrame, args: Record<string, unknown>): Promise<Outcome> {
    const callerSid = typeof frame.callerSid === 'string' ? frame.callerSid : ''
    if (args.in_reply_to !== undefined) return needsPrimary('Answering a request this host does not hold')
    const to = typeof args.to === 'string' ? args.to.trim() : ''
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    if (!to) return { ok: false, code: 'bad_request', message: '`to` is required (or pass in_reply_to)' }
    if (!text) return { ok: false, code: 'bad_request', message: 'text must be a non-empty string' }
    const all = await deps.sessions()
    let candidates = all.filter((s) => s.id === to || (to.length >= 8 && s.id.startsWith(to)))
    let targetTitle: string | undefined
    let current: string | undefined
    if (candidates.length !== 1) {
      const task = await deps.findTask(to)
      if (task && 'ambiguous' in task) return { ok: false, code: 'ambiguous_peer', message: `"${to}" matches ${task.ambiguous} tasks` }
      if (!task) return { ok: false, code: 'unknown_peer', message: `no task or session "${to}"` }
      targetTitle = task.title
      current = task.sessionId
      candidates = all.filter((s) => s.task_id === task.id)
    }
    const live = candidates
      .filter((s) => LIVE_STATUSES.has(s.process_status))
      .sort((a, b) => (b.last_active_at ?? '').localeCompare(a.last_active_at ?? ''))
    // As the server picks (session-send-core.ts): the task's current session, else the newest.
    const target = live.find((s) => s.id === current) ?? live[0]
    if (!target) return needsPrimary(`"${to}" has no running session; starting one`)
    if (target.id === callerSid) return { ok: false, code: 'self_send', message: 'target resolves to the calling session itself' }
    const caller = asRecord(frame.caller)
    const alias = bridgeAliasOf(target.host)
    const r = await deliver(alias, {
      kind: 'peer',
      from: {
        sid: callerSid,
        ...(typeof caller.taskId === 'string' ? { taskId: caller.taskId } : {}),
        title: typeof caller.title === 'string' ? caller.title : '',
        host: typeof caller.host === 'string' && caller.host ? caller.host : host,
      },
      to: target.id,
      text,
      ...(typeof args.title === 'string' ? { title: args.title } : {}),
      ...(typeof args.expect_reply === 'boolean' ? { expect_reply: args.expect_reply } : {}),
      ...(typeof args.reply_timeout === 'number' ? { reply_timeout: args.reply_timeout } : {}),
      ...(typeof args.messageId === 'string' ? { messageId: args.messageId } : {}),
    })
    if (!r.ok) return r
    const res = r.result
    const name = targetTitle ?? target.task_title ?? target.title ?? target.id
    const requestId = typeof res.requestId === 'string' ? res.requestId : undefined
    return {
      ok: true,
      result: {
        ...res,
        viaLeader: true,
        outcome: `Message delivered to "${name}" on ${target.host || 'the Walnut server\'s host'} through the cloud companion, which leads while the Walnut server is away. Do NOT resend.`,
        next: requestId
          ? `You asked for a reply (${requestId}). It arrives in your session on its own; do not poll.`
          : 'Its reply arrives in your session on its own; do not poll.',
      },
    }
  }

  async function answer(host: string, frame: GatewayRequestFrame): Promise<Outcome> {
    const lead = leadOf(host, frame)
    if ('ok' in lead) return lead
    const payload = asRecord(frame.payload)
    if (frame.capability === 'leader.deliverText') {
      const toHost = typeof payload.toHost === 'string' ? payload.toHost : ''
      if (!toHost || typeof payload.toSid !== 'string' || typeof payload.text !== 'string') {
        return { ok: false, code: 'bad_request', message: 'leader.deliverText needs toHost, toSid and text' }
      }
      return deliver(bridgeAliasOf(toHost), {
        kind: 'text', toSid: payload.toSid, text: payload.text,
        ...(typeof payload.messageId === 'string' ? { messageId: payload.messageId } : {}),
        ...(typeof payload.requestId === 'string' ? { requestId: payload.requestId } : {}),
        ...(payload.reply === true ? { reply: true } : {}),
        ...(typeof payload.fromSessionId === 'string' ? { fromSessionId: payload.fromSessionId } : {}),
      })
    }
    if (frame.capability !== 'tools.call') return needsPrimary(`"${String(frame.capability)}"`)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const args = asRecord(payload.args)
    if (typeof payload.argsFile === 'string') return needsPrimary('A call whose arguments ride in a file')
    if (name === 'task_send' || name === 'session_send') return routeSend(host, frame, args)
    if (!(LEADER_OPS as readonly string[]).includes(name)) return needsPrimary(name ? `"${name}"` : 'That call')
    const callerSid = typeof frame.callerSid === 'string' ? frame.callerSid : ''
    const r = await deps.executeOp(name, args, { callerSid, callerHost: host })
    if (!r.ok) return { ok: false, code: 'internal', message: r.message ?? `${name} failed`, ...(r.result !== undefined ? { detail: r.result } : {}) }
    const result = r.result && typeof r.result === 'object' && !Array.isArray(r.result) ? r.result as Record<string, unknown> : { value: r.result }
    return { ok: true, result: { ...result, viaLeader: true } }
  }

  /** One frame from `host`'s daemon. Answers with gateway-result; never throws. */
  async function handle(host: string, frame: GatewayRequestFrame): Promise<void> {
    const relayId = frame.relayId
    if (typeof relayId !== 'number') return
    let out: Outcome
    try {
      out = await answer(host, frame)
    } catch (err) {
      out = { ok: false, code: 'internal', message: err instanceof Error ? err.message : String(err) }
    }
    log.leader.info('backup leader: answered a host', {
      host, relayId, capability: String(frame.capability ?? ''), op: String(asRecord(frame.payload).name ?? ''),
      ok: out.ok, code: out.ok ? undefined : out.code,
    })
    const params = out.ok
      ? { relayId, result: out.result }
      : { relayId, error: out.message, errorCode: out.code, ...(out.detail !== undefined ? { detail: out.detail } : {}) }
    try {
      await deps.request(host, 'gateway-result', params)
    } catch (err) {
      log.leader.warn('backup leader: could not answer a host', { host, relayId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { handle }
}

// ── The cloud box's wiring ──

/** Answer one `gateway-request` frame a host's bridge carried (bridge-registry.ts). */
export async function handleBackupGatewayFrame(host: string, frame: GatewayRequestFrame): Promise<void> {
  const { getBackupLeader } = await import('./backup-leader.js')
  const leader = await getBackupLeader()
  const registry = await import('../../web/ws/bridge-registry.js')
  if (!leader) return
  const gateway = createBackupGateway({
    leader,
    request: (h, cmd, params, timeoutMs) => registry.bridgeRequest(h, cmd, params, timeoutMs),
    sessions: async () => {
      const { readSessionProjection } = await import('../session-projection.js')
      return (await readSessionProjection())?.sessions ?? []
    },
    findTask: async (ref) => {
      const { getTask } = await import('../task-manager.js')
      try {
        const t = await getTask(ref)
        const sessionId = t.session_id || t.exec_session_id
        return { id: t.id, title: t.title, ...(sessionId ? { sessionId } : {}) }
      } catch (err) {
        // getTask resolves a unique prefix and names an ambiguous one.
        const m = /matches (\d+) tasks/.exec(err instanceof Error ? err.message : '')
        return m ? { ambiguous: Number(m[1]) } : null
      }
    },
    executeOp: async (name, args, ctx) => {
      const [{ executeOp }, { hostOrigin }] = await Promise.all([import('../../ops/index.js'), import('../../lib/caller-origin.js')])
      return executeOp(name, args, { callerSid: ctx.callerSid, callerHost: ctx.callerHost, origin: hostOrigin(ctx.callerHost) })
    },
  })
  await gateway.handle(host, frame)
}
