/**
 * Whether Walnut saw the asking process inside the session it names (`identity`, set by
 * web/routes/approvals-v1.ts proveIdentity), in words. One rule for every step that is a session's
 * own: a single-use approval (approvals-v1.ts) and a locked note's ask (notes/locked-note-ask.ts).
 * A session id is a name, not a proof: another process (a lead that read its child's history)
 * can name it.
 */
import type { ApprovalRequester } from './types.js'

/** Why the request is not seen inside the session it names, or undefined when it is. */
export function notSeenInsideWhy(r: Pick<ApprovalRequester, 'identity' | 'sessionId' | 'check'>): string | undefined {
  if (r.identity === 'verified' && r.sessionId) return undefined
  if (!r.sessionId) return 'the request names no session Walnut can check'
  return r.check === 'outside'
    ? 'the asking process is not inside the session it names'
    : 'Walnut could not check that the asking process is inside the session it names (a call through a host daemon\'s socket, a remote host, or a check that timed out)'
}
