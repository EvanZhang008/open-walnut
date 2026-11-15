/**
 * One Face ID or Touch ID ask at a time per account, and only to a user who is there.
 *
 * Why (2026-11-15): a signed single-use approval (a Git push the Git gate asks, `walnut approve`
 * with single_use) puts a biometric prompt on the person's device. A second task asked another one
 * for the same remote while the first was still pending, and the person was away, so neither got
 * an answer, and a retry after the first expired asked again with nobody there.
 *
 * Applies to createApproval (store.ts) of a single-use biometric approval from a task: never to a
 * tap, an unasked record, a key enrollment or removal, and it changes nothing of how an approval is
 * signed, waited on or used. A refusal creates nothing (no record, no push to a device):
 *  1. pending: no other pending single-use biometric approval (same task included) on an
 *     overlapping account;
 *  2. presence: the person did something in Walnut within PRESENT_MS (typed in any chat, or an
 *     attention heartbeat: org/user-away.ts userActivityAnywhere; no title is read), or a phone
 *     streams a session now. Cannot tell: refused (fail closed);
 *  3. retry fence: when an ask on an overlapping account ended without going through (expired,
 *     denied or withdrawn) within RETRY_FENCE_MS, the person must have done something after it
 *     ended (streaming alone is not that), so nothing asks him again on its own.
 * All three are decided inside the store's locked write on one snapshot of the file, with the
 * activity read just before it, so two asks at once never both pass.
 *
 * The account: the operation context's `remoteUrl` (a `walnut-git-operation-v1` context), reduced
 * to its host and user, each hashed (never its path, ref or commit: another repository on the same
 * host signs in the same way). Two asks overlap on the same host, whatever users they name, and on
 * a shared signer key whatever their accounts (one device, one prompt at a time): coarser, never looser.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import crypto from 'node:crypto'
import { APPROVAL_KEEP_MS, type ApprovalRecord, type ApprovalRequester, type ApprovalsFile } from './types.js'

export const PRESENT_MS = 10 * 60_000
// A clock passing is not the user returning. Hold throughout the store's retained history.
export const RETRY_FENCE_MS = APPROVAL_KEEP_MS

function presentMs(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.WALNUT_APPROVAL_PRESENT_MINUTES)
  return Number.isFinite(m) && m > 0 ? m * 60_000 : PRESENT_MS
}

export interface FenceSubject {
  singleUse?: boolean
  mode: string
  unasked?: string
  requester: Pick<ApprovalRequester, 'taskId'>
  testRun?: string
  signingKeyId?: string
  signingKeyIds?: string[]
}

export function fenced(rec: FenceSubject): boolean {
  return rec.singleUse === true && rec.mode === 'biometric' && !rec.unasked && !!rec.requester.taskId
}

/** Host and user of a remote URL (`scheme://user:secret@host:port/path` or `user@host:path`); null otherwise. */
export function remoteAccount(url: string): { host: string; user: string } | null {
  const u = url.trim()
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(u)
  if (scheme) {
    if (/^file:/i.test(u)) return null
    const auth = scheme[1]
    const at = auth.lastIndexOf('@')
    const user = at >= 0 ? auth.slice(0, at).split(':')[0] : ''
    const host = (at >= 0 ? auth.slice(at + 1) : auth).replace(/:\d*$/, '').toLowerCase()
    return host ? { host, user } : null
  }
  const scp = /^(?:([^@/:]+)@)?([^/:]+):(?!\/\/)/.exec(u)
  if (scp && !u.startsWith('/') && !u.startsWith('.')) return { host: scp[2].toLowerCase(), user: scp[1] ?? '' }
  return null
}

/** An account as hashes: its host, and its user when the URL names one (null: any user of that host). */
export interface AccountScope { host: string; user: string | null }

const h = (kind: string, v: string) => crypto.createHash('sha256').update(`approval-account:${kind}:${v}`).digest('hex')

/** The account of an operation context (the asker's own text, or the envelope around it), or null. */
export function accountOf(detail: string | undefined): AccountScope | null {
  if (!detail) return null
  try {
    let value = JSON.parse(detail) as Record<string, unknown>
    if (value?.version === 'walnut-single-use-v1' && typeof value.context === 'string') value = JSON.parse(value.context) as Record<string, unknown>
    const url = typeof value?.remoteUrl === 'string' ? value.remoteUrl : ''
    const acct = url ? remoteAccount(url) : null
    return acct ? { host: h('host', acct.host), user: acct.user ? h('user', acct.user) : null } : null
  } catch { return null }
}

const signersOf = (r: Pick<FenceSubject, 'signingKeyId' | 'signingKeyIds'>): string[] =>
  r.signingKeyIds?.length ? r.signingKeyIds : r.signingKeyId ? [r.signingKeyId] : []

/**
 * Whether two asks may collide: the same host (whatever user each names: a URL may leave its user
 * out, and one host's sign-in may be the same check), or a shared signer key (the same device would
 * show both prompts). Coarser than an account, never looser.
 */
export function overlaps(a: { account: AccountScope | null; signers: string[] }, b: { account: AccountScope | null; signers: string[] }): boolean {
  if (a.account && b.account && a.account.host === b.account.host) return true
  return a.signers.some((k) => b.signers.includes(k))
}

const shapeOf = (r: Pick<ApprovalRecord, 'detail' | 'signingKeyId' | 'signingKeyIds'>) => ({ account: accountOf(r.detail), signers: signersOf(r) })

/** When an ask that did not go through ended: expired, denied, or withdrawn (null for one approved, or still pending). */
function endedUnused(a: ApprovalRecord): number | null {
  if (a.status === 'expired') return Date.parse(a.expiresAt)
  if (a.status === 'denied') return Date.parse(a.answer?.at ?? a.expiresAt)
  if (a.status === 'canceled') return Date.parse(a.canceledAt ?? a.expiresAt)
  return null
}

const DONT = 'Do not ask again by yourself and do not ask the user about it; nothing was sent to his devices. Ask again only once the user has done something new in Walnut.'

export class FenceRefusal extends Error {
  constructor(readonly code: 'biometric_pending' | 'user_away' | 'presence_unknown' | 'unanswered_retry', message: string, readonly owner?: { approvalId: string; taskId?: string }) {
    super(message)
  }
}

/** The person's latest activity anywhere (epoch ms; null: never seen), and whether a phone streams a session now. */
export interface UserActivity { lastSeenAt: number | null; streaming: boolean }

/** Seam for tests: the person's activity, or null when it cannot be read. */
export interface FenceDeps { activity(now: number): Promise<UserActivity | null> }

async function activityAnywhere(now: number): Promise<UserActivity | null> {
  try {
    const { listSessions } = await import('../session-tracker.js')
    const { userActivityAnywhere } = await import('../org/user-away.js')
    return await userActivityAnywhere(await listSessions(), now)
  } catch { return null }
}

let deps: FenceDeps = { activity: activityAnywhere }
export function _setFenceDepsForTest(d: FenceDeps | null): void { deps = d ?? { activity: activityAnywhere } }

/** Read before the store's write: the person's activity (null: cannot tell). */
export async function readActivity(now = Date.now()): Promise<UserActivity | null> {
  return deps.activity(now).catch(() => null)
}

/** A fixture server's dialog asks skip the fence (routes/test-host-fixture.ts only; no caller input reaches it). */
const unfenced = new AsyncLocalStorage<true>()
export function _unfencedForFixture<T>(fn: () => Promise<T>): Promise<T> { return unfenced.run(true, fn) }
export function fenceSkipped(): boolean { return unfenced.getStore() === true }

/**
 * Inside the store's locked write, on that one snapshot: another pending ask on an overlapping
 * account; then the person's presence; then, after an ask on that account expired unanswered,
 * activity of his since it was made (a phone only streaming a session is not new activity).
 */
export function fenceRefusal(file: ApprovalsFile, input: FenceSubject & { detail?: string }, now: number, activity: UserActivity | null): FenceRefusal | null {
  const mine = { account: accountOf(input.detail), signers: signersOf(input) }
  const sameClass = (a: ApprovalRecord) => (a.testRun ?? null) === (input.testRun ?? null) && fenced(a) && overlaps(mine, shapeOf(a))
  const other = file.approvals.find((a) => a.status === 'pending' && Date.parse(a.expiresAt) > now && sameClass(a))
  if (other) {
    const whose = other.requester.taskId === input.requester.taskId ? 'This task already has' : `Task ${other.requester.taskId} already has`
    return new FenceRefusal('biometric_pending',
      `${whose} a Face ID or Touch ID approval pending for the same account (${other.id}, until ${other.expiresAt}). ${DONT}`,
      { approvalId: other.id, taskId: other.requester.taskId })
  }
  if (!activity) return new FenceRefusal('presence_unknown', `Walnut could not tell whether the user is at hand, so it did not send a Face ID or Touch ID approval to his devices. ${DONT}`)
  // The newest ask on this account that ended without going through: he must have done something after it ended.
  const ended = file.approvals
    .filter((a) => sameClass(a)).map(endedUnused)
    .filter((t): t is number => t !== null && Number.isFinite(t) && now - t < RETRY_FENCE_MS)
  const endedAt = ended.length ? Math.max(...ended) : null
  const last = activity.lastSeenAt
  if (endedAt !== null && !(last !== null && last > endedAt)) {
    return new FenceRefusal('unanswered_retry', `The last Face ID or Touch ID approval for this account ended without going through (expired, denied or withdrawn), and the user has done nothing in Walnut since. ${DONT}`)
  }
  const present = activity.streaming || (last !== null && now - last < presentMs())
  if (!present) return new FenceRefusal('user_away', `The user has not been in any Walnut chat for ${Math.round(presentMs() / 60_000)} minutes, so nobody would answer a Face ID or Touch ID approval. ${DONT} `)
  return null
}
