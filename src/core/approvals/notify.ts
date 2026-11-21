/**
 * What follows an approval's change, on the leader: a new pending approval pushes to every paired
 * phone like a permission prompt: a script is blocked on it, so it passes quiet mode while quiet
 * allows permissions (allowPermissions), with the category that gives the banner its Approve /
 * Deny actions (every approval is a tap on any device the person is signed in on: types.ts).
 * The web console hears the same change on the `approval:changed` event (store.ts).
 */

import { bus } from '../event-bus.js'
import { log } from '../../logging/index.js'
import { APPROVAL_CHANGED } from './store.js'
import { firstSentence, needsSummary, summaryWithin } from './summary.js'
import type { ApprovalView } from './types.js'

export const APPROVAL_PUSH_TYPE = 'approval_request'
export const APPROVAL_CATEGORY_TAP = 'WALNUT_APPROVAL'

/** Who asks, on which host: `hostName` is the host's display name (never a raw alias such as `__cloudbox__`). */
export function requesterLine(a: Pick<ApprovalView, 'requester'>, hostName: string = a.requester.host): string {
  const r = a.requester
  const who = r.taskTitle ? `task "${r.taskTitle}"` : r.command ? r.command : 'a script'
  return `${who} on ${hostName}`
}

/** How long a new request's push waits for the summary Walnut writes (summary.ts takes 2 to 4 s). */
export const PUSH_SUMMARY_WAIT_MS = 6_000

/**
 * The push: its title the request's own line; its body the summary's first sentence when there is
 * one (the asker's own why, else Walnut's), then who asks (2026-11-14, Walnut VP: the phone shows
 * the summary the dialog leads with). The app reads only `data`, so an older app is unaffected.
 */
export function approvalPushContent(a: ApprovalView, hostName?: string, summary?: string) {
  const own = a.context?.whyFrom === 'asker' ? a.context.why : undefined
  const lead = own || summary || (a.context?.whyFrom !== 'asker' ? a.context?.summary : undefined)
  const who = requesterLine(a, hostName)
  return {
    title: `Approve? ${a.what}`.slice(0, 120),
    body: (lead ? `${firstSentence(lead)}\n${who}` : who).slice(0, 240),
    // `mode: 'tap'`: an iPhone app built before approvals took a tap everywhere reads it.
    data: { type: APPROVAL_PUSH_TYPE, approvalId: a.id, mode: 'tap' },
    priority: 10,
    collapseId: a.id,
    category: APPROVAL_CATEGORY_TAP,
    interruptionLevel: 'time-sensitive' as const,
  }
}

async function pushNew(a: ApprovalView): Promise<void> {
  // A test run's approval never reaches the user's phone (store.ts visibleTo).
  if (a.testRun) return
  const { getConfig } = await import('../config-manager.js')
  const { deliverPush } = await import('../push/deliver.js')
  const { holdPushForQuiet } = await import('../push/quiet-hold.js')
  const { hostDisplayNameFor } = await import('../hosts/host-display-name.js')
  const tokens = (await getConfig()).push_tokens ?? []
  if (tokens.length === 0) {
    log.notif.info('approval push: no phone registered', { approvalId: a.id })
    return
  }
  // Quiet holds it with every push; the one push after quiet says it waited (quiet-hold.ts).
  if (await holdPushForQuiet('approval-push', { key: `approval:${a.id}`, title: 'An approval waits for you' }, { taskId: a.requester?.taskId })) return
  // One push, with the summary when it comes in time: a second push for it would ring the phone again.
  const waited = !a.context?.summary && needsSummary(a)
  const summary = a.context?.summary || (waited ? await summaryWithin(a.id, PUSH_SUMMARY_WAIT_MS) : '')
  if (waited) {
    // Answered or withdrawn on the Mac while it waited: nothing to ring the phone for.
    const { getApproval } = await import('./store.js')
    const now = await getApproval(a.id).catch(() => undefined)
    if (now && now.status !== 'pending') return
  }
  const out = await deliverPush(tokens, approvalPushContent(a, await hostDisplayNameFor(a.requester.host), summary || undefined))
  log.notif.info('approval push', { approvalId: a.id, attempted: out.attempted, sent: out.sent, failed: out.failed, ...(out.reason ? { reason: out.reason } : {}) })
}

let started = false
export function initApprovalNotify(): void {
  if (started) return
  started = true
  bus.subscribe('approvals', (event) => {
    if (event.name !== APPROVAL_CHANGED) return
    const a = (event.data as { approval?: ApprovalView }).approval
    if (!a || a.status !== 'pending') return
    void pushNew(a).catch((err) => log.notif.warn('approval push failed', { approvalId: a.id, error: String(err) }))
  })
}
