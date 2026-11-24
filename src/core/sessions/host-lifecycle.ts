/**
 * The `lifecycle` members a host carries out whole for a session it runs and judges
 * (session-channel/host-calls.ts, answered by host-routes.ts `call`). The leader hands each one over
 * (host-judged-controls.ts onJudgingHost) instead of doing it itself or asking the host's daemon
 * (session-command-gate.ts); here each runs the same function the leader runs for its own sessions,
 * against this host's own daemon. Every member takes the session id first (host-calls.ts hostCallArgs).
 */
export { terminateSession, changeSessionModeOf } from './session-lifecycle.js'
export { readSessionSupervision } from './session-supervision.js'

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
