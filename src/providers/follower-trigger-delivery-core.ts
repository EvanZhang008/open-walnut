/**
 * A trigger fire no server claimed, delivered on this host by the host's own Walnut
 * server while its leader is away ('follower-trigger-delivery-v1'). Shared by both
 * daemon twins (daemon-source.ts inlines it by `toString()`): self-contained, no
 * imports at runtime.
 *
 * The daemon's tick (deliverUnclaimedFires) builds the envelope and its message id as
 * before, then asks `deliver(fire)`:
 *
 *   no follower that said `deliversTriggers` at follower.hello, or the leader answers
 *     -> the daemon's own away delivery (offline-host-core.ts deliverTrigger), as before
 *   a follower that may write
 *     -> event `trigger-delivery {deliveryId, home, triggerId, taskId, messageId, live}`
 *        (`live`: this Walnut's sessions whose CLI runs here now, the daemon's registry).
 *        The follower picks the session with ITS copies (host-trigger-target.ts, the
 *        rule deliverTrigger applies to the daemon's copy) and answers
 *        `follower.trigger.deliver {deliveryId, sid, resume}` (or `{deliveryId, declined}`
 *        when no session here takes it, `{deliveryId, error}` when it could not tell);
 *        the daemon does the mechanics (offline-host-core.ts deliverTriggerTo: the FIFO
 *        write, or the resume and its `resume` record) and the tick marks the fire
 *        host-delivered exactly as before.
 *
 * Once per fire: one attempt per trigger is in flight at a time (the tick's
 * hostDeliveriesInFlight), and only the live attempt's answer is taken: an answer
 * after the attempt timed out, or from another socket, is `stale` and does nothing.
 * The attempt then counts as not delivered, the fire stays due and is tried again a
 * minute later under a new delivery id, with the message id the tick built (the
 * session's FIFO drops a second write of one id).
 *
 * A follower that keeps failing (no answer in time, an error, a pick the mechanics
 * could not deliver) FALLBACK_AFTER times in a row for one trigger: the next attempt
 * is the daemon's own, counted as a daemon offline answer (`ownAnswerUsed`: the twins'
 * followerGateway.noteOwnAnswer, op `trigger_delivery`, which logs it). A follower's
 * `declined` is an answer, not a failure (the daemon's own copy would decline it too).
 */

export const FOLLOWER_TRIGGER_DELIVERY_CAPABILITY = 'follower-trigger-delivery-v1'

export interface TriggerFire {
  home: string
  triggerId: string
  taskId: string
  /** The envelope the tick built. */
  text: string
  /** The tick's message id for the fires it carries. */
  messageId: string
}

export type TriggerDeliveryResult = { ok: true; sid: string; resumed?: true } | { ok: false; reason: string }

export interface FollowerTriggerDeliveryDeps<S> {
  /** The follower of `home` linked now that said it delivers triggers, or null. */
  follower(home: string): S | null
  /** Whether that follower may write now (the twin's followerMayWrite). */
  mayWrite(home: string): boolean
  /** Send an event on a socket; false when it could not be written. */
  send(ws: S, ev: string, data: Record<string, unknown>): boolean
  /** This Walnut's sessions whose CLI runs on this host now. */
  liveSids(home: string): string[]
  /** The daemon's own away delivery (offline-host-core.ts deliverTrigger). */
  own(fire: TriggerFire): Promise<TriggerDeliveryResult>
  /** The mechanics for a session picked already (offline-host-core.ts deliverTriggerTo). */
  deliverTo(fire: TriggerFire, target: { sid: string; resume: boolean }): Promise<TriggerDeliveryResult>
  nextId(): string
  /** How long the follower has to pick the session. */
  answerMs: number
  /** Failures in a row, per trigger, before the daemon delivers it itself (default 3). */
  fallbackAfter?: number
  /** The daemon delivers a fire itself although a follower was linked to: the offline answer count. */
  ownAnswerUsed?(fire: TriggerFire, failures: number): void
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
}

export type FollowerTriggerAnswer =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: 'stale' | 'wrong_socket' | 'bad_request'; message: string }

export function createFollowerTriggerDelivery<S>(deps: FollowerTriggerDeliveryDeps<S>) {
  const FALLBACK_AFTER = typeof deps.fallbackAfter === 'number' && deps.fallbackAfter > 0 ? deps.fallbackAfter : 3
  interface Attempt { ws: S; fire: TriggerFire; key: string; resolve: (r: TriggerDeliveryResult) => void; timer: unknown }
  const pending = new Map<string, Attempt>()
  /** Follower failures in a row, by home and trigger id. */
  const failures = new Map<string, number>()

  const keyOf = (fire: TriggerFire): string => fire.home + '\n' + fire.triggerId
  const failed = (key: string): void => { failures.set(key, (failures.get(key) || 0) + 1) }
  const tags = (fire: TriggerFire): Record<string, unknown> => ({ home: fire.home, triggerId: fire.triggerId, taskId: fire.taskId, messageId: fire.messageId })

  /** One delivery attempt of `fire`: the follower's pick when one answers, else the daemon's own. */
  function deliver(fire: TriggerFire): Promise<TriggerDeliveryResult> {
    const ws = deps.follower(fire.home)
    if (ws === null || !deps.mayWrite(fire.home)) return deps.own(fire)
    const key = keyOf(fire)
    const inRow = failures.get(key) || 0
    if (inRow >= FALLBACK_AFTER) {
      // The follower gets the next one again: a server that recovered takes over at once.
      failures.delete(key)
      deps.log('warn', 'trigger: this host\'s Walnut server kept failing, this daemon delivers the fire itself', { failures: inRow, ...tags(fire) })
      if (deps.ownAnswerUsed) deps.ownAnswerUsed(fire, inRow)
      return deps.own(fire)
    }
    return new Promise<TriggerDeliveryResult>((resolve) => {
      const deliveryId = deps.nextId()
      const attempt: Attempt = { ws, fire, key, resolve, timer: null }
      pending.set(deliveryId, attempt)
      const sent = deps.send(ws, 'trigger-delivery', {
        deliveryId, home: fire.home, triggerId: fire.triggerId, taskId: fire.taskId, messageId: fire.messageId, live: deps.liveSids(fire.home),
      })
      if (!sent) {
        pending.delete(deliveryId)
        failed(key)
        resolve({ ok: false, reason: 'this host\'s Walnut server could not be told of the fire' })
        return
      }
      attempt.timer = deps.setTimer(() => ended(deliveryId, 'timeout'), deps.answerMs)
      deps.log('info', 'trigger: delivery offered to this host\'s Walnut server', { deliveryId, ...tags(fire) })
    })
  }

  function ended(deliveryId: string, why: 'timeout' | 'closed'): void {
    const a = pending.get(deliveryId)
    if (!a) return
    pending.delete(deliveryId)
    deps.clearTimer(a.timer)
    failed(a.key)
    deps.log('warn', 'trigger: this host\'s Walnut server did not pick the session', { deliveryId, why, failures: failures.get(a.key), ...tags(a.fire) })
    a.resolve({ ok: false, reason: why === 'timeout' ? 'this host\'s Walnut server did not answer the fire in time' : 'the link to this host\'s Walnut server closed' })
  }

  /** The follower's answer (follower.trigger.deliver), taken only for the live attempt it was sent. */
  async function answer(ws: S, cmd: Record<string, unknown>): Promise<FollowerTriggerAnswer> {
    const deliveryId = typeof cmd.deliveryId === 'string' ? cmd.deliveryId : ''
    if (!deliveryId) return { ok: false, code: 'bad_request', message: 'deliveryId is required' }
    const a = pending.get(deliveryId)
    if (!a) {
      deps.log('info', 'trigger: a late or unknown delivery answer was dropped', { deliveryId })
      return { ok: false, code: 'stale', message: 'no delivery waits on that id: it ended, and the fire is tried again under a new one' }
    }
    if (a.ws !== ws) return { ok: false, code: 'wrong_socket', message: 'that delivery was offered to another socket' }
    pending.delete(deliveryId)
    deps.clearTimer(a.timer)
    if (typeof cmd.declined === 'string') {
      failures.delete(a.key)
      deps.log('info', 'trigger: this host\'s Walnut server left the fire to the leader', { deliveryId, reason: cmd.declined, ...tags(a.fire) })
      a.resolve({ ok: false, reason: cmd.declined })
      return { ok: true, result: { delivered: false, declined: true } }
    }
    const sid = typeof cmd.sid === 'string' ? cmd.sid : ''
    if (!sid) {
      failed(a.key)
      const reason = typeof cmd.error === 'string' && cmd.error ? cmd.error : 'this host\'s Walnut server named no session'
      deps.log('warn', 'trigger: this host\'s Walnut server could not pick the session', { deliveryId, reason, ...tags(a.fire) })
      a.resolve({ ok: false, reason })
      return { ok: true, result: { delivered: false } }
    }
    let r: TriggerDeliveryResult
    try {
      r = await deps.deliverTo(a.fire, { sid, resume: cmd.resume === true })
    } catch (err) {
      r = { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
    if (r.ok) failures.delete(a.key)
    else failed(a.key)
    a.resolve(r)
    return { ok: true, result: r.ok ? { delivered: true, sid: r.sid, ...(r.resumed ? { resumed: true } : {}) } : { delivered: false, reason: r.reason } }
  }

  /** A follower socket closed: what it was offered and never answered ends now. */
  function dropSocket(ws: S): void {
    for (const [deliveryId, a] of [...pending]) if (a.ws === ws) ended(deliveryId, 'closed')
  }

  return {
    deliver, answer, dropSocket,
    counts: () => ({ pending: pending.size }),
  }
}
