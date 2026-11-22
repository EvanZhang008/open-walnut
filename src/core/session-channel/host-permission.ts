/**
 * The host's check on an answer to a permission prompt of a session it runs (plan section 8: the
 * permission path keeps its proof after the move).
 *
 *   ask      the CLI's request reaches the session object inside this host's service (the CLI's
 *            own stream for a native session, the ACP worker's for an ACP one, both through this
 *            host's runtime); the kernel's word on a local caller (socket-peer-pid.ts, read on
 *            the daemon's gateway socket) stays where it is. The leader hears of the prompt only
 *            as a fact on the authenticated channel, and nothing it may call creates one
 *            (host-calls.ts lists only members that answer or settle).
 *   answer   comes back as `resolvePermissionRequest` on POST /host-api/sessions/call, served only
 *            on the leader door. Before the session is asked, the request id must be pending on
 *            THAT session now: an id never asked (forged), one already answered or settled
 *            (stale), or one pending on another session is refused with NOT_PENDING, logged, and
 *            the session is never called.
 *
 * "Pending" is what the session itself lists (getPendingPermissionRequests): what it showed to a
 * person and still waits on. An answer whose write is in flight is still listed, so a second
 * click joins the first (the session's own dedupe) instead of being refused. An ACP request that
 * Walnut answers itself on the host is not listed: it is not the leader's to answer.
 *
 * Read in the same synchronous step as the call that follows (host-routes.ts `call`), so the
 * answer cannot slip between the check and the session's own lookup.
 */

/** The answer of a refused permission answer (POST /host-api/sessions/call `error`). */
export const PERMISSION_NOT_PENDING = 'not_pending'

/** The members whose first argument names a request the session must hold. */
const ANSWER_MEMBERS: ReadonlySet<string> = new Set(['resolvePermissionRequest'])

export interface PermissionHolder {
  getPendingPermissionRequests?(): unknown[]
}

export type PermissionAnswerCheck =
  | { ok: true }
  | { ok: false; status: number; error: string }

function pendingIdsOf(target: PermissionHolder): Set<string> | null {
  if (typeof target.getPendingPermissionRequests !== 'function') return null
  try {
    const list = target.getPendingPermissionRequests()
    if (!Array.isArray(list)) return null
    return new Set(list.map((p) => (p && typeof p === 'object' ? (p as { requestId?: unknown }).requestId : undefined)).filter((id): id is string => typeof id === 'string'))
  } catch {
    return null
  }
}

/**
 * May `member` with `args` run on `target`, the live session of `sid` on this host? Every member
 * other than a permission answer passes. A session that cannot list its prompts holds none.
 */
export function checkPermissionAnswer(
  sid: string,
  member: string,
  args: readonly unknown[],
  target: PermissionHolder,
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void,
): PermissionAnswerCheck {
  if (!ANSWER_MEMBERS.has(member)) return { ok: true }
  const requestId = args[0]
  if (typeof requestId !== 'string' || !requestId) return { ok: false, status: 400, error: 'requestId is required' }
  const pending = pendingIdsOf(target)
  if (pending?.has(requestId)) return { ok: true }
  log?.('warn', 'host sessions: a permission answer for a request this session does not hold was refused', {
    sessionId: sid, requestId, pendingRequestIds: pending ? [...pending] : [],
  })
  return { ok: false, status: 200, error: PERMISSION_NOT_PENDING }
}

/** Is `err` the leader's word for a host that refused an answer as not pending (leader-side.ts callHost)? */
export function isNotPendingRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.endsWith(`: ${PERMISSION_NOT_PENDING}`)
}
