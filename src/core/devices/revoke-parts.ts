/**
 * A revoke's parts beyond auth.json (device-auth.ts revokePairing and
 * rotateDevice): the revoked pairings' push rows, and their copies on the
 * other box. Written ahead to the revoke queue (revoke-queue.ts) inside the
 * auth lock, then run; what could not finish stays queued for the server.
 */

import { log } from '../../logging/index.js'
import { getSelfApiRoot } from '../../lib/self-api-root.js'
import { ownsMachineCredentials } from '../device-actor.js'
import type { DeviceRecord } from '../device-store.js'
import type { PushRevokeOutcome } from '../push/device-revoke.js'


/**
 * The phone and computer pairings among `gone`: what holds push rows and what
 * the other box may hold a copy of. Not machine credentials, and not the Mac
 * that owns them (a Mac registers no pushes, and its pairing is never copied:
 * device-twins.ts). Called on the records BEFORE they leave `devices`.
 */
export function pairingsOf(devices: readonly DeviceRecord[], gone: readonly DeviceRecord[]): DeviceRecord[] {
  return gone.filter((d) => d.kind !== 'machine' && !ownsMachineCredentials(devices, d))
}

/** How the other box's copy of a revoked pairing fared (`dropTwins`). */
export type TwinRemoval = 'done' | 'background' | 'queued' | 'failed'

/**
 * A revoke's parts on the other box, each with its revoke-queue entry (null =
 * the entry could not be written; the part still runs, with no fallback).
 */
export interface RevokePlan {
  /**
   * The push part's cutoff: rows registered before it go. Taken AFTER the
   * auth.json write (stampRevokeTime): a phone's registration that its token
   * authenticated just before that write can still land after it, and a cutoff
   * from before the write would keep that row. Until then, the write-ahead time.
   */
  revokedAt: string
  push: Array<{ name: string; opId: string | null }>
  twins: Array<{ tokenHash: string; opId: string | null }>
}

/**
 * Write ahead: every part a revoke must finish (the revoked pairings' push rows,
 * their copies on the other box) goes into the revoke queue BEFORE auth.json
 * loses the pairing, inside the auth lock. A process killed after the auth.json
 * write leaves the server a queue to finish instead of an orphaned row or copy;
 * one killed before it leaves entries for a pairing that is still here, which
 * the drain drops (revoke-queue.ts, judged under this same lock, so it never
 * sees a revoke in between). Each entry is cleared when its part finishes.
 */
export async function writeRevokeIntent(pairings: DeviceRecord[], twinHashes: string[]): Promise<RevokePlan> {
  const revokedAt = new Date().toISOString()
  const plan: RevokePlan = { revokedAt, push: [], twins: [] }
  if (pairings.length === 0 && twinHashes.length === 0) return plan
  const { enqueueRevokeStep } = await import('./revoke-queue.js')
  for (const d of pairings) {
    plan.push.push({ name: d.name, opId: await enqueueRevokeStep({ step: 'push', name: d.name, revokedAt, pairingHash: d.tokenHash }) })
  }
  for (const h of twinHashes) plan.twins.push({ tokenHash: h, opId: await enqueueRevokeStep({ step: 'twin', tokenHash: h }) })
  return plan
}

/**
 * Right after the auth.json write, inside its lock: the revoke time becomes
 * now, in the plan and in each queued push part. A registration that lands
 * before it is older than the cutoff. One after it sees the pairing gone
 * (web/routes/push.ts: the Mac checks and writes under this lock, so it never
 * writes; a companion checks again after its relayed write and takes that
 * write back). Never throws: an entry it could not stamp keeps the write-ahead time.
 */
export async function stampRevokeTime(intent: { plan: RevokePlan | null }): Promise<void> {
  const plan = intent.plan
  if (!plan || plan.push.length === 0) return
  plan.revokedAt = new Date().toISOString()
  try {
    const { stampRevokedAt } = await import('./revoke-queue.js')
    for (const { opId } of plan.push) if (opId) await stampRevokedAt(opId, plan.revokedAt)
  } catch (err) {
    log.web.warn('device-auth: could not stamp the revoke time on its queued push parts', { error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * The revoke's auth.json write failed after its intent was written (the pairing
 * stayed): take the intent back. Runs inside the auth lock (updateAuth's
 * `onFailure`): enqueueRevokeStep hands a second revoke of the same pairing the
 * entry already queued, so a take-back after the lock could remove the entry
 * that revoke reported as queued. Never throws.
 */
export async function dropRevokeIntent(intent: { plan: RevokePlan | null }): Promise<void> {
  const written = intent.plan
  if (!written) return
  try {
    const { clearRevokeStep } = await import('./revoke-queue.js')
    for (const s of [...written.push, ...written.twins]) if (s.opId) await clearRevokeStep(s.opId)
  } catch (err) {
    log.web.warn('device-auth: could not take back the queued parts of a revoke that did not land', { error: err instanceof Error ? err.message : String(err) })
  }
}

const revokeWork = new Set<Promise<unknown>>()
export function trackRevokeWork(p: Promise<unknown>): void {
  revokeWork.add(p)
  void p.finally(() => revokeWork.delete(p))
}

/** Tests: wait for the parts a rotation started in the background. */
export async function _settleRevokeWorkForTesting(): Promise<void> {
  while (revokeWork.size > 0) await Promise.allSettled([...revokeWork])
}

/** Run a revoke's parts now; each finished part's queue entry is cleared. Never throws. */
export async function finishRevoke(plan: RevokePlan, what: string): Promise<{ push: PushRevokeOutcome | null; twin: TwinRemoval | null }> {
  // The other box's copy first: a server only starts it, and it should be on its
  // way before the rows (the two do not depend on each other).
  const twinRemoval = dropTwins(plan.twins)
  const push = plan.push.length > 0 ? await dropPushRows(plan) : null
  const twin = await twinRemoval
  if (push?.pending || (twin && twin !== 'done' && twin !== 'background')) {
    log.web.warn('device-auth: a revoke\'s parts did not all finish where it ran', {
      what, ...(push ? { pushRevokePending: push.pending, pushRevokeQueued: !!push.queued, pushRevokePendingWhere: push.pendingWhere } : {}), ...(twin ? { twin } : {}),
    })
  }
  return { push, twin }
}

/**
 * The other box's copy of a revoked pairing goes too (device-twins.ts), or the
 * revoked token keeps working there and the phone can register for pushes
 * again through it. Its revoke-queue entry is already written (write ahead). A
 * running server tries at once, in process, and leaves the entry for its drain
 * ('background': its own retries end with the process). Any other process
 * (`walnut device revoke`) tries once and clears the entry when that worked
 * ('done'), else leaves it to the server ('queued'). Never throws.
 */
async function dropTwins(twinSteps: RevokePlan['twins']): Promise<TwinRemoval | null> {
  if (twinSteps.length === 0) return null
  try {
    const twins = await import('../../web/routes/device-twins.js')
    const { clearRevokeStep } = await import('./revoke-queue.js')
    if (getSelfApiRoot() !== null) {
      let result: TwinRemoval = 'background'
      for (const { tokenHash, opId } of twinSteps) {
        // At once, with the tombstone that stops an adoption already in flight
        // from bringing the copy back. A drain that finds the copy gone clears the entry.
        void twins.revokeAdoptionTwin(tokenHash)
        if (!opId) result = 'failed'
      }
      return result
    }
    let result: TwinRemoval = 'done'
    for (const { tokenHash, opId } of twinSteps) {
      if (await twins.removeTwinOnce(tokenHash)) {
        if (opId) await clearRevokeStep(opId)
        continue
      }
      if (opId) {
        if (result === 'done') result = 'queued'
      } else {
        result = 'failed'
      }
    }
    return result
  } catch (err) {
    log.web.warn('device-auth: the other box\'s copy of a revoked pairing was not removed', {
      error: err instanceof Error ? err.message : String(err),
    })
    return 'failed'
  }
}

/**
 * The push half of a revoke: the revoked devices' push rows registered before
 * the revoke go, wherever they live (core/push/device-revoke.ts, which relays to
 * the primary on a replica). Each finished part's queue entry is cleared; a part
 * that can still land keeps it ('queued'). Never throws: the pairing is already
 * gone, and a failure is reported in `pending` instead.
 */
async function dropPushRows(plan: RevokePlan): Promise<PushRevokeOutcome> {
  try {
    const { revokePushTokensForDevice } = await import('../push/device-revoke.js')
    const { clearRevokeStep } = await import('./revoke-queue.js')
    const outcomes = await Promise.all(plan.push.map(async ({ name, opId }) => {
      const o = await revokePushTokensForDevice(name, { queue: false, revokedAt: plan.revokedAt })
      const keep = !!o.pending && !!o.retry
      if (!keep && opId) await clearRevokeStep(opId)
      return keep ? { ...o, queued: opId !== null } : o
    }))
    const unfinished = outcomes.filter((o) => o.pending)
    const where = new Set<NonNullable<PushRevokeOutcome['pendingWhere']>>()
    for (const o of unfinished) if (o.pendingWhere) where.add(o.pendingWhere)
    const pendingWhere = where.size === 0 ? undefined : where.has('both') || where.size > 1 ? 'both' : [...where][0]
    return {
      removed: outcomes.reduce((sum, o) => sum + o.removed, 0),
      relayed: outcomes.length > 0 && outcomes.every((o) => o.relayed),
      ...(unfinished.length > 0 ? {
        pending: unfinished.map((o) => o.pending).join('; '),
        retry: unfinished.every((o) => o.retry),
        queued: unfinished.every((o) => o.queued),
        ...(pendingWhere ? { pendingWhere } : {}),
      } : {}),
    }
  } catch (err) {
    const pending = err instanceof Error ? err.message : String(err)
    log.web.warn('device-auth: push rows of a revoked device not removed, it may still receive letters', { devices: plan.push.map((p) => p.name), error: pending })
    return { removed: 0, relayed: false, pending, queued: plan.push.every((p) => p.opId !== null), retry: true }
  }
}
