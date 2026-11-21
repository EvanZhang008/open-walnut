/**
 * One single-use ask at a time, and only to a user who is there.
 *
 * Why (2026-11-15): a single-use approval (a Git push the Git gate asks, `walnut approve` with
 * single_use) rings the person's devices. A second task asked another one for the same remote
 * while the first was still pending, and the person was away, so neither got an answer, and a
 * retry after the first expired asked again with nobody there.
 *
 * Applies to createApproval (store.ts) of a single-use approval from a task: never to an ordinary
 * ask or an unasked record, and it changes nothing of how an approval is answered, waited on or
 * used. A refusal creates nothing (no record, no push to a device):
 *  1. pending: no other pending single-use approval (same task included);
 *  2. presence: the person did something in Walnut within PRESENT_MS (typed in any chat, or an
 *     attention heartbeat: org/user-away.ts userActivityAnywhere; no title is read), or a phone
 *     streams a session now. Cannot tell: refused (fail closed);
 *  3. retry fence: when a single-use ask ended without going through (expired, denied or
 *     withdrawn) within RETRY_FENCE_MS, the person must have done something after it ended
 *     (streaming alone is not that), so nothing asks him again on its own.
 * All three are decided inside the store's locked write on one snapshot of the file, with the
 * activity read just before it, so two asks at once never both pass.
 *
 * Every single-use ask reaches the same devices (every device the person is signed in on; no
 * device is named by an ask since 2026-11-21), so any two of the same test-run class collide.
 * Before, they collided on a shared device key, and every real ask named the same keys: the same.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
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
  unasked?: string
  requester: Pick<ApprovalRequester, 'taskId'>
  testRun?: string
}

export function fenced(rec: FenceSubject): boolean {
  return rec.singleUse === true && !rec.unasked && !!rec.requester.taskId
}

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
 * Inside the store's locked write, on that one snapshot: another pending single-use ask; then the
 * person's presence; then, after one expired unanswered, activity of his since it was made (a phone
 * only streaming a session is not new activity).
 */
export function fenceRefusal(file: ApprovalsFile, input: FenceSubject & { detail?: string }, now: number, activity: UserActivity | null): FenceRefusal | null {
  // Every single-use ask rings the same devices (see the file comment): one class per test run.
  const sameClass = (a: ApprovalRecord) => (a.testRun ?? null) === (input.testRun ?? null) && fenced(a)
  const other = file.approvals.find((a) => a.status === 'pending' && Date.parse(a.expiresAt) > now && sameClass(a))
  if (other) {
    const whose = other.requester.taskId === input.requester.taskId ? 'This task already has' : `Task ${other.requester.taskId} already has`
    // The code stays `biometric_pending`: askers older than this one key on it.
    return new FenceRefusal('biometric_pending',
      `${whose} a single-use approval pending on the person's devices (${other.id}, until ${other.expiresAt}). ${DONT}`,
      { approvalId: other.id, taskId: other.requester.taskId })
  }
  if (!activity) return new FenceRefusal('presence_unknown', `Walnut could not tell whether the user is at hand, so it did not send this approval to his devices. ${DONT}`)
  // The newest single-use ask that ended without going through: he must have done something after it ended.
  const ended = file.approvals
    .filter((a) => sameClass(a)).map(endedUnused)
    .filter((t): t is number => t !== null && Number.isFinite(t) && now - t < RETRY_FENCE_MS)
  const endedAt = ended.length ? Math.max(...ended) : null
  const last = activity.lastSeenAt
  if (endedAt !== null && !(last !== null && last > endedAt)) {
    return new FenceRefusal('unanswered_retry', `The last single-use approval ended without going through (expired, denied or withdrawn), and the user has done nothing in Walnut since. ${DONT}`)
  }
  const present = activity.streaming || (last !== null && now - last < presentMs())
  if (!present) return new FenceRefusal('user_away', `The user has not been in any Walnut chat for ${Math.round(presentMs() / 60_000)} minutes, so nobody would answer this approval. ${DONT} `)
  return null
}
