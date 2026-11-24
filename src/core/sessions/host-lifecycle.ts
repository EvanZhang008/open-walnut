/**
 * The `lifecycle` members a host carries out whole for a session it runs and judges
 * (session-channel/host-calls.ts, answered by host-routes.ts `call`). The leader hands each one over
 * (host-judged-controls.ts onJudgingHost) instead of doing it itself or asking the host's daemon
 * (session-command-gate.ts); here each runs the same function the leader runs for its own sessions,
 * against this host's own daemon. Every member takes the session id first (host-calls.ts hostCallArgs).
 */
export { terminateSession, changeSessionModeOf } from './session-lifecycle.js'
export { readSessionSupervision } from './session-supervision.js'
/** The folder is there again (its leader made the workspace again): what this host parked on it goes. */
export { sendFolderWaiting } from './folder-gone.js'
/** Its task is complete: stop it now, or when its turn ends, or no more (a reopen); and the leader's word that its last turn is summarized (host-judged-complete.ts; only asked of a host naming SESSION_COMPLETE_STOP_CAP). */
export { takeCompletionStop, completionSummaryDone } from './host-judged-complete.js'

/** Did the line already run in this host's CLI of `sid` (resend-already-ran.ts)? */
export async function lineAlreadyRan(sid: string, lineUuid?: string, messageIds?: string[]): Promise<boolean> {
  const { resendAlreadyRan } = await import('./resend-already-ran.js')
  return resendAlreadyRan({ sessionId: sid, host: null, ...(typeof lineUuid === 'string' ? { lineUuid } : {}), messageIds: Array.isArray(messageIds) ? messageIds.map(String) : [] })
}

/** Cancel an unconfirmed start of `sid` on this host's daemon (cancel-pending-start.ts); `runtimeId` when the start named one. */
export async function cancelPendingStart(sid: string, runtimeId?: string): Promise<unknown> {
  const { cancelPendingStartOf } = await import('./cancel-pending-start.js')
  return cancelPendingStartOf({ sid: typeof runtimeId === 'string' && runtimeId ? runtimeId : sid, sessionId: sid, host: null })
}

/**
 * The rows this host keeps parked for `sid` in its own queue, which its leader's panel lists beside
 * its own (host-queue-rows.ts): a row parked on the host never reaches the leader's queue.
 */
export async function readParkedRows(sid: string): Promise<unknown[]> {
  const { getQueue } = await import('../session-message-queue.js')
  return (await getQueue(sid)).filter((m) => m.status === 'parked')
}

/**
 * A Retry or Send now of a row this host keeps for `sid` (send-now.ts, as on the leader). `unpark`:
 * a person's, which puts a parked row back in line; an agent's leaves it parked.
 */
export async function sendQueuedRowNow(sid: string, messageId: string, source?: string, unpark?: boolean): Promise<unknown> {
  const { sendQueuedNow } = await import('./send-now.js')
  const asked = typeof source === 'string' ? source : ''
  return sendQueuedNow({ sessionId: sid, messageId: String(messageId), source: asked || 'leader-retry', unpark: unpark === true })
}

/** A person's Discard of a row this host keeps for `sid` (session-message-queue.ts deleteMessage). */
export async function discardQueuedRow(sid: string, messageId: string): Promise<boolean> {
  const { deleteMessage } = await import('../session-message-queue.js')
  return deleteMessage(sid, String(messageId), { discarded: true })
}
