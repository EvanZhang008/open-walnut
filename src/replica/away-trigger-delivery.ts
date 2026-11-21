/**
 * A trigger fire no server claimed, delivered on this host while the Mac is away
 * ('follower-trigger-delivery-v1'; the daemon's half is
 * providers/follower-trigger-delivery-core.ts). The daemon offers each due delivery as a
 * `trigger-delivery {deliveryId, home, triggerId, taskId, messageId, live}` event on the
 * follower link. This server picks the session with ITS copies (the task as copy plus
 * overlay shows it, the task's sessions on this host as its session copy lists them, and
 * the daemon's word on which CLIs run here now), by the one rule the daemon's own away code
 * applies to its copy (core/routines/host-trigger-target.ts), and answers:
 *
 *   follower.trigger.deliver {deliveryId, sid, resume}   the daemon writes it (the FIFO, or a
 *                                                       resume journaled `resume`) and marks
 *                                                       the fire host-delivered
 *   follower.trigger.deliver {deliveryId, declined}      no session here takes it (the task is
 *                                                       complete, on ACP, has none here): the
 *                                                       fire stays for the Mac
 *   follower.trigger.deliver {deliveryId, error}         it could not tell: the daemon counts a
 *                                                       failure (three, and it delivers itself)
 *
 * The daemon takes only the live attempt's answer (a late one is `stale`), so this side keeps
 * no state: it answers each event once and logs what the daemon said.
 */

import { pickHostTriggerTarget, type HostTriggerTarget } from '../core/routines/host-trigger-target.js'

/** A follower.trigger.deliver may wait for a resume (a CLI start) before it is answered. */
const ANSWER_TIMEOUT_MS = 60_000

/** One session of the task, as this server's copy lists it, with what the host's copy would say of it. */
export interface AwayTriggerSession {
  sid: string
  host?: string | null
  lastActiveAt?: string
  aside?: boolean
  noResume?: boolean
  acp?: boolean
}

export interface AwayTriggerDeliveryDeps {
  /** The Mac's name for this host (WALNUT_HOST_KEY). */
  hostKey: string | null
  /** A task as this replica shows it (copy plus overlay), or null. */
  task(id: string): Promise<Record<string, unknown> | null>
  /** The task's sessions this replica knows (the copy, and those started here), any host. */
  sessionsOfTask(taskId: string): Promise<AwayTriggerSession[]>
  /** A follower link request. */
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function createAwayTriggerDelivery(deps: AwayTriggerDeliveryDeps) {
  /** The session of `taskId` on this host that takes the fire, by this server's copies. */
  async function pick(taskId: string, liveSids: readonly string[]): Promise<HostTriggerTarget> {
    const task = await deps.task(taskId)
    const live = new Set(liveSids)
    const here = (await deps.sessionsOfTask(taskId))
      .filter((s) => !!deps.hostKey && str(s.host) === deps.hostKey)
      // Newest first, as the host's copy lists them.
      .sort((a, b) => str(b.lastActiveAt).localeCompare(str(a.lastActiveAt)))
      .map((s) => ({ sid: s.sid, live: live.has(s.sid), ...(s.aside ? { aside: true } : {}), ...(s.noResume ? { noResume: true } : {}), ...(s.acp ? { acp: true } : {}) }))
    const slot = str(task?.session_id)
    return pickHostTriggerTarget(task ? { phase: str(task.phase), ...(slot ? { session_id: slot } : {}) } : undefined, here, { resume: true })
  }

  /** One `trigger-delivery` event: pick, answer once. */
  async function handle(event: Record<string, unknown>): Promise<void> {
    const deliveryId = str(event.deliveryId)
    const taskId = str(event.taskId)
    if (!deliveryId) return
    const tags = { deliveryId, taskId, triggerId: str(event.triggerId), messageId: str(event.messageId) }
    let params: Record<string, unknown>
    try {
      if (!taskId) throw new Error('the fire names no task')
      if (!deps.hostKey) throw new Error('this server does not know this host\'s name')
      const live = Array.isArray(event.live) ? event.live.filter((x): x is string => typeof x === 'string') : []
      const t = await pick(taskId, live)
      params = t.ok ? { deliveryId, sid: t.sid, resume: t.resume } : { deliveryId, declined: t.reason }
    } catch (err) {
      params = { deliveryId, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      const r = await deps.request('follower.trigger.deliver', params, ANSWER_TIMEOUT_MS)
      if (r.ok === false) {
        deps.log('warn', 'replica: the daemon did not take a trigger delivery pick', { ...tags, error: String(r.error ?? ''), errorKind: r.errorKind })
        return
      }
      deps.log('info', params.sid ? 'replica: a trigger fire was delivered on this host while the Mac is away' : 'replica: a trigger fire was left for the Mac', {
        ...tags, ...(params.sid ? { sessionId: params.sid, resume: params.resume === true } : {}),
        ...(typeof params.declined === 'string' ? { reason: params.declined } : {}), ...(typeof params.error === 'string' ? { error: params.error } : {}),
        delivered: r.delivered === true,
      })
    } catch (err) {
      deps.log('warn', 'replica: a trigger delivery pick could not be sent', { ...tags, error: err instanceof Error ? err.message : String(err) })
    }
  }

  return { pick, handle }
}

/** The real dependencies on a host replica (server.ts wires it to the front's trigger-delivery events). */
export function wireAwayTriggerDelivery(o: {
  task(id: string): Promise<Record<string, unknown> | null>
  hostKey: string | null
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  log: AwayTriggerDeliveryDeps['log']
}) {
  return createAwayTriggerDelivery({
    hostKey: o.hostKey,
    task: (id) => o.task(id),
    request: o.request,
    log: o.log,
    sessionsOfTask: async (taskId) => {
      const [{ getSessionsForTask, isListableSession }, { hostSessionFlags, inHostCopy }] = await Promise.all([
        import('../core/session-tracker.js'), import('../core/host-slice.js'),
      ])
      const now = Date.now()
      // The sessions the host's copy would hold: recent, not archived, a CLI's.
      return (await getSessionsForTask(taskId)).filter((r) => inHostCopy(r, now)).map((r) => ({
        sid: r.claudeSessionId, host: r.host ?? null, ...(r.lastActiveAt ? { lastActiveAt: r.lastActiveAt } : {}),
        ...hostSessionFlags(r, isListableSession(r)),
      }))
    },
  })
}
