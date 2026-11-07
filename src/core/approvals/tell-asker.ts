/**
 * The session that asked hears the answer (2026-11-07, the user: "I approved the approval request
 * but the source session didn't get notified, it should get notified"). A `walnut approve` still
 * waiting, an approval_wait call and a browser step holding for its answer read the decision
 * themselves (the store marks `readAt` / `consumedAt`); a session that asked with the
 * approval_request op and ended its turn, or whose command was stopped meanwhile, has nothing
 * reading it, so Walnut tells it: one Walnut note into the asking session, which wakes it when
 * idle (it waits on exactly this). Every way of answering ends here, because every decision goes
 * through the store's announce(): Approve or Deny in the web notice, the phone, Touch ID, the
 * clock running out. A withdrawal is the asker's own (or its script's) and tells no one. The note
 * goes once (`askerToldAt`), survives a restart inside the grace (rearmAskerNotices), and skips a
 * task that is closed.
 */
import { log } from '../../logging/index.js'
import type { ApprovalRecord } from './types.js'

/** How long a waiting command has to read the decision itself before Walnut tells the session. */
export const ASKER_GRACE_MS = 15_000
/** A decision older than this at boot is history: its asker has moved on. */
const REARM_WITHIN_MS = 30 * 60_000

const pending = new Set<string>()
let graceMs = ASKER_GRACE_MS

type NoticeInput = Pick<ApprovalRecord, 'id' | 'what' | 'status' | 'answer' | 'requester' | 'consumedAt' | 'readAt' | 'askerToldAt' | 'singleUse' | 'requestOnly'>

/** Whether this decision is one the asking session must hear about, and in which words. */
export function askerNoticeFor(rec: NoticeInput): { outcome: 'approved' | 'denied' | 'expired'; body: string } | null {
  if (!rec.requester.sessionId && !rec.requester.taskId) return null
  if (rec.consumedAt || rec.readAt || rec.askerToldAt) return null
  const what = rec.what.length > 300 ? `${rec.what.slice(0, 297)}...` : rec.what
  const step = rec.requester.command ? ` (${rec.requester.command})` : ''
  // A command of its own may still be waiting (back from a lost link): it goes on by itself, and
  // the session must not take the step a second time.
  const once = ' If a command of yours is still waiting on this approval (walnut approve), it goes on by itself: never take the step twice.'
  if (rec.status === 'approved' || rec.status === 'denied') {
    const by = rec.answer?.mode === 'biometric' ? (rec.answer.device.kind === 'iphone' ? 'Face ID' : 'Touch ID') : 'a tap'
    const where = rec.answer?.device.name ? ` on ${rec.answer.device.name}` : ''
    const at = rec.answer?.at ? ` at ${rec.answer.at}` : ''
    if (rec.status === 'approved') {
      // Asked with --request-only: the command ended, so the session runs it again to go on.
      const rerun = rec.requestOnly
        ? `Run the same command again with \`--approval ${rec.id}\` added${step}: it re-reads what it is about to do and goes on only if nothing changed${rec.singleUse ? ' and its signed approval is consumed once' : ''}. Never take the step any other way; a changed or expired operation needs a new approval.`
        : undefined
      if (rerun) return { outcome: 'approved', body: `Approved: "${what}". Your approval request ${rec.id} was approved by the person, with ${by}${where}${at}. The command that asked has ended, so the step has not run.${rec.singleUse ? " Do not run yet by hand." : ""} ${rerun}` }
      if (rec.singleUse) return { outcome: 'approved', body: `Approved: "${what}". Request ${rec.id} was signed with ${by}${where}${at}. Do not run yet: verify the signed record, rebuild the current operation context and call approval_consume. Run only after used:true; a changed or expired operation needs a new approval.${once}` }
      return { outcome: 'approved', body: `Approved: "${what}". Your approval request ${rec.id} was approved by the person, with ${by}${where}${at}. Go ahead with that step now${step}, then report the result where you planned to.${once}` }
    }
    return { outcome: 'denied', body: `Denied: "${what}". Your approval request ${rec.id} was denied by the person, with ${by}${where}${at}. Do not take that step${step}; carry on without it, or ask again only if something changed.` }
  }
  if (rec.status === 'expired') {
    return { outcome: 'expired', body: `Expired, not approved: "${what}". Your approval request ${rec.id} got no answer in time. It is not approved: do not take that step${step}. Ask again (approval_request) if it is still needed.` }
  }
  return null
}

/** Called for each record the store announces; tells the asker once, after the grace. */
export function tellAskerLater(rec: ApprovalRecord, delayMs = graceMs): void {
  if (rec.status !== 'approved' && rec.status !== 'denied' && rec.status !== 'expired') return
  if (pending.has(rec.id) || !askerNoticeFor(rec)) return
  pending.add(rec.id)
  const t = setTimeout(() => { void tellAsker(rec.id).finally(() => pending.delete(rec.id)) }, delayMs)
  t.unref?.()
}

/** On boot: a decision of the last half hour that nobody read and nobody was told is told now. */
export function rearmAskerNotices(recs: ApprovalRecord[], now = Date.now()): void {
  for (const rec of recs) {
    const at = Date.parse(rec.answer?.at ?? (rec.status === 'expired' ? rec.expiresAt : ''))
    if (Number.isNaN(at) || now - at > REARM_WITHIN_MS) continue
    tellAskerLater(rec, Math.max(0, at + graceMs - now))
  }
}

export async function tellAsker(id: string): Promise<'told' | 'read' | 'none'> {
  try {
    const { getApproval, markAskerTold } = await import('./store.js')
    const rec = await getApproval(id)
    const notice = rec ? askerNoticeFor(rec) : null
    if (!rec || !notice) return rec && (rec.consumedAt || rec.readAt || rec.askerToldAt) ? 'read' : 'none'
    const target = await targetSession(rec)
    if (!target) {
      log.web.info('approval answered: no open task session of the asker to tell', { approvalId: id, taskId: rec.requester.taskId })
      return 'none'
    }
    // One note per decision, also when a restart's re-arm and a late timer race to it.
    if (!(await markAskerTold(id))) return 'read'
    const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js')
    const { sendMessageToSession } = await import('../session-message-queue.js')
    const text = buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut: approvals', outcome: notice.outcome, note: `the answer to your approval request ${rec.id}` },
      body: notice.body,
    })
    // A Walnut notice about the session's own request: it reaches Main and a VP with the org off
    // too (org-enabled.ts), and an answer ends a wait the task parked on it, an expiry does not.
    await sendMessageToSession(target.sessionId, text, {
      source: 'walnut-notify',
      ...(target.taskId ? { taskId: target.taskId } : {}),
      ...(notice.outcome === 'expired' ? {} : { endsWait: true }),
    })
    log.web.info('approval answered: asking session told', { approvalId: id, sessionId: target.sessionId, outcome: notice.outcome })
    return 'told'
  } catch (err) {
    log.web.warn('approval answered: telling the asking session failed', { approvalId: id, error: err instanceof Error ? err.message : String(err) })
    return 'none'
  }
}

/** The session that asked, else the task's own live session; none for a closed task. */
async function targetSession(rec: ApprovalRecord): Promise<{ sessionId: string; taskId?: string } | null> {
  const { getSessionByClaudeId, getSessionsForTask } = await import('../session-tracker.js')
  const sid = rec.requester.sessionId
  const own = sid ? await getSessionByClaudeId(sid).catch(() => null) : null
  const taskId = own?.taskId ?? rec.requester.taskId
  if (taskId) {
    const { getTask } = await import('../task-manager.js')
    const task = await getTask(taskId).catch(() => null)
    if (task?.phase === 'COMPLETE') return null
  }
  if (own && !own.archived) return { sessionId: own.claudeSessionId, ...(taskId ? { taskId } : {}) }
  if (!taskId) return null
  const { pickDeliverySession } = await import('../routines/session-target.js')
  const picked = pickDeliverySession(await getSessionsForTask(taskId).catch(() => []))
  return picked ? { sessionId: picked.claudeSessionId, taskId } : null
}

export function _resetToldForTesting(grace = ASKER_GRACE_MS): void {
  pending.clear()
  graceMs = grace
}
