/**
 * What follows an approval's change, on the leader:
 *  - a new pending approval pushes to every paired phone like a permission prompt: a script
 *    is blocked on it, so it passes quiet mode while quiet allows permissions
 *    (allowPermissions), with the category that gives the banner its Approve / Deny actions
 *    (tap) or only Open (biometric: Face ID in the app);
 *  - a decided key enrollment activates or drops its key (keys.ts).
 * The web console hears the same change on the `approval:changed` event (store.ts).
 */

import { bus } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { APPROVAL_CHANGED } from './store.js'
import type { ApprovalView } from './types.js'

export const APPROVAL_PUSH_TYPE = 'approval_request'
export const APPROVAL_CATEGORY_TAP = 'WALNUT_APPROVAL'
export const APPROVAL_CATEGORY_BIOMETRIC = 'WALNUT_APPROVAL_BIOMETRIC'

/** Who asks, on which host: `hostName` is the host's display name (never a raw alias such as `__cloudbox__`). */
export function requesterLine(a: Pick<ApprovalView, 'requester'>, hostName: string = a.requester.host): string {
  const r = a.requester
  const who = r.taskTitle ? `task "${r.taskTitle}"` : r.command ? r.command : 'a script'
  return `${who} on ${hostName}`
}

export function approvalPushContent(a: ApprovalView, hostName?: string) {
  const biometric = a.mode === 'biometric'
  return {
    title: `Approve? ${a.what}`.slice(0, 120),
    body: `${requesterLine(a, hostName)}${biometric ? ' · Face ID needed' : ''}`.slice(0, 240),
    data: { type: APPROVAL_PUSH_TYPE, approvalId: a.id, mode: a.mode },
    priority: 10,
    collapseId: a.id,
    category: biometric ? APPROVAL_CATEGORY_BIOMETRIC : APPROVAL_CATEGORY_TAP,
    interruptionLevel: 'time-sensitive' as const,
  }
}

async function pushNew(a: ApprovalView): Promise<void> {
  // A test run's approval never reaches the user's phone (store.ts visibleTo).
  if (a.testRun) return
  const { getConfig } = await import('../config-manager.js')
  const { deliverPush } = await import('../push/deliver.js')
  const { getQuiet, quietSuppresses, logQuietSkipOnce } = await import('../quiet/quiet-state.js')
  const { hostDisplayNameFor } = await import('../hosts/host-display-name.js')
  const tokens = (await getConfig()).push_tokens ?? []
  if (tokens.length === 0) {
    log.notif.info('approval push: no phone registered', { approvalId: a.id })
    return
  }
  const quiet = await getQuiet()
  if (quietSuppresses(quiet, { permission: true })) {
    logQuietSkipOnce('push', quiet)
    return
  }
  const out = await deliverPush(tokens, approvalPushContent(a, await hostDisplayNameFor(a.requester.host)))
  log.notif.info('approval push', { approvalId: a.id, attempted: out.attempted, sent: out.sent, failed: out.failed, ...(out.reason ? { reason: out.reason } : {}) })
}

let started = false
export function initApprovalNotify(): void {
  if (started) return
  started = true
  bus.subscribe('approvals', (event) => {
    if (event.name !== APPROVAL_CHANGED) return
    const a = (event.data as { approval?: ApprovalView }).approval
    if (!a) return
    if (a.status === 'pending') {
      void pushNew(a).catch((err) => log.notif.warn('approval push failed', { approvalId: a.id, error: String(err) }))
      return
    }
    if (a.enrollsKey) {
      void import('./keys.js').then((k) => k.applyKeyApproval(a))
        .catch((err) => log.web.warn('approval key update failed', { approvalId: a.id, error: String(err) }))
    }
  })
}
