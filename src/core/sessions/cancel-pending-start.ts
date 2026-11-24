/**
 * Cancel a start whose outcome was never confirmed, on the host that took it: the one way both a
 * task start's retry (task-start.ts cancelUnconfirmedStart) and a routine's (routines/run-start-deps.ts)
 * ask it. The answer says whether a process of it came up (`alive`) or the start is cancelled for good.
 *
 * A session its host runs and judges is asked of that host's service (a `lifecycle` call, carried out
 * there against its own daemon), never of its daemon from here (session-command-gate.ts).
 */
import { sessionCommandTarget } from './session-command-gate.js'

export interface CancelPendingAnswer { ok?: boolean; alive?: boolean; cancelled?: boolean; error?: unknown }

export const CANCEL_PENDING_START_CAPABILITY = 'cancel-pending-start-v1'

/** Nothing was asked: no link to the host, or a daemon or host service too old to cancel. The start's outcome stays unknown. */
export class CancelNotAskableError extends Error {
  readonly code = 'cancel_not_askable'
  constructor(message: string) { super(message); this.name = 'CancelNotAskableError' }
}

/**
 * `sid`: the start's runtime identity (its session id, or an ACP worker's runtime id); `sessionId`:
 * its session, when known. `dial`: link the host when it is not linked yet (else no link is no answer).
 * Throws when the host cannot be asked (no link, a daemon too old to cancel).
 */
export async function cancelPendingStartOf(input: { sid: string; sessionId?: string; host?: string | null; dial?: boolean }): Promise<CancelPendingAnswer> {
  const target = sessionCommandTarget(input.sessionId || input.sid)
  if (target.to === 'host') {
    const { onJudgingHost, HostNeedsUpdateError } = await import('./host-judged-controls.js')
    try {
      return (await onJudgingHost(input.sessionId || input.sid, 'cancelPendingStart', [input.sid])) as CancelPendingAnswer
    } catch (err) {
      throw err instanceof HostNeedsUpdateError ? new CancelNotAskableError(`This start cannot be retried yet: ${err.message}`) : err
    }
  }
  const host = input.host && input.host !== 'local' ? input.host : '__local__'
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  let conn = getConnectedDaemonConnection(host)
  if (!conn && input.dial) conn = await (await import('../hosts/link.js')).link(host)
  if (!conn) throw new CancelNotAskableError(`no link to ${host}`)
  if (!conn.hasCapability(CANCEL_PENDING_START_CAPABILITY)) throw new CancelNotAskableError('The execution host needs a daemon upgrade before this start can be retried')
  return await conn.send('cancelPendingStart', { sid: input.sid }, 5_000) as CancelPendingAnswer
}
