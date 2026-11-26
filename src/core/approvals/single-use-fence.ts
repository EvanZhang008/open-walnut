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
 * used. A refusal creates no approval and pushes nothing to a device; one that only means "not now"
 * (`holdable`) is held until the person is back, and its task is told then to ask again
 * (held-asks.ts, 2026-11-25: refused asks nobody re-asked held work up for days):
 *  1. pending: no other pending single-use approval (same task included);
 *  2. presence: the person did something in Walnut within PRESENT_MS (typed in any chat, or an
 *     attention heartbeat: org/user-away.ts userActivityAnywhere; no title is read), or a phone
 *     streams a session now. Cannot tell: refused (fail closed);
 *  3. retry fence: when a single-use ask ended without going through (expired, denied or
 *     withdrawn) within RETRY_FENCE_MS, the person must have done something after it ended
 *     (streaming alone is not that), so nothing asks him again on its own. A step he denied is
 *     never held for another try, nor is a second ask of the step its task already has pending.
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
  /** The request's line: the step it asks for (a denied step is never held for another try). */
  what?: string
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

/** A step that reached the person this many times and ended unanswered is not held for another try. */
export const MAX_UNANSWERED = 2

/** Why a refused step is not held: he denied it, he left it unanswered MAX_UNANSWERED times, or it is on his devices now. */
export type NotHeld = 'denied' | 'unanswered' | 'same_pending'

/** A refusal that only means "not now": Walnut holds the ask (held-asks.ts), and store.ts says so. */
const NOT_NOW = 'Nothing was sent to his devices.'
/** A refusal Walnut does not hold. */
const DONT = 'Nothing was sent to his devices, and Walnut does not hold it. Do not ask again by yourself and do not ask the user about it.'

export class FenceRefusal extends Error {
  constructor(
    readonly code: 'biometric_pending' | 'user_away' | 'presence_unknown' | 'unanswered_retry' | 'too_many_pending',
    message: string,
    readonly owner?: { approvalId: string; taskId?: string },
    /** Set when it is not only "not now": Walnut does not hold it. Unset: held until the person is back. */
    readonly notHeld?: NotHeld,
  ) {
    super(message)
  }
  get holdable(): boolean { return !this.notHeld }
}

/** The person's latest activity anywhere (epoch ms; null: never seen), and whether a phone streams a session now. */
export interface UserActivity { lastSeenAt: number | null; streaming: boolean }

/** Seam for tests: the person's activity, or null when it cannot be read. */
export interface FenceDeps { activity(now: number): Promise<UserActivity | null> }

async function activityAnywhere(now: number): Promise<UserActivity | null> {
  try {
    // The store's own view, read in one pass (a held ask's sweep reads it every minute; listSessions copies all).
    const { sessionStoreView } = await import('../session-tracker.js')
    const { userActivityAnywhere } = await import('../org/user-away.js')
    return await userActivityAnywhere(await sessionStoreView(), now)
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

/** Every single-use ask rings the same devices (see the file comment): one class per test run. */
const classOf = (input: Pick<FenceSubject, 'testRun'>) => (a: ApprovalRecord) => (a.testRun ?? null) === (input.testRun ?? null) && fenced(a)

/**
 * How far back a step's own denials and misses keep it from being held: as long as a held ask waits
 * (held-asks.ts HOLD_MS), and never past his last approval of it (2026-11-25 review: a "no" from 20
 * days ago, approved since, kept a recurring deploy from ever being held).
 */
export const STEP_MEMORY_MS = 72 * 60 * 60_000

/** What became of this task's earlier asks of the same step: denied, or unanswered how often. Pure. */
function stepHistory(file: ApprovalsFile, input: FenceSubject, now: number) {
  const sameClass = classOf(input)
  const sameStep = (a: ApprovalRecord) => a.requester.taskId === input.requester.taskId && input.what !== undefined && a.what === input.what
  const endedAsks = file.approvals
    .filter((a) => sameClass(a)).map((a) => ({ a, at: endedUnused(a) }))
    .filter((e): e is { a: ApprovalRecord; at: number } => e.at !== null && Number.isFinite(e.at) && now - e.at < RETRY_FENCE_MS)
  // Never held, whatever else refuses it: a step he denied, or one he left unanswered MAX_UNANSWERED
  // times, lately and since he last approved it.
  const approvedAt = file.approvals.filter((a) => sameClass(a) && sameStep(a) && a.status === 'approved')
    .reduce((m, a) => Math.max(m, Date.parse(a.answer?.at ?? a.createdAt) || 0), 0)
  const since = Math.max(now - STEP_MEMORY_MS, approvedAt)
  const recent = endedAsks.filter((e) => sameStep(e.a) && e.at > since)
  const denied = recent.filter((e) => e.a.status === 'denied').sort((x, y) => y.at - x.at)[0]
  const ignored = recent.filter((e) => e.a.status === 'expired').length
  const notHeld: NotHeld | undefined = denied ? 'denied' : ignored >= MAX_UNANSWERED ? 'unanswered' : undefined
  return { endedAsks, denied, ignored, notHeld }
}

/** Whether a held ask of this step must be dropped rather than asked again (held-asks.ts sweep). Pure. */
export function notHeldNow(file: ApprovalsFile, input: FenceSubject, now: number): NotHeld | undefined {
  return stepHistory(file, input, now).notHeld
}

/**
 * Inside the store's locked write, on that one snapshot: another pending single-use ask; then the
 * person's presence; then, after one expired unanswered, activity of his since it was made (a phone
 * only streaming a session is not new activity).
 */
export function fenceRefusal(
  file: ApprovalsFile, input: FenceSubject & { detail?: string }, now: number, activity: UserActivity | null,
  /** A held ask of another task released just now (held-asks.ts): the person's devices are kept for its ask. */
  reserved?: { heldId: string; taskId?: string } | null,
): FenceRefusal | null {
  const sameClass = classOf(input)
  const { endedAsks, denied, ignored, notHeld } = stepHistory(file, input, now)
  const tail = (n: NotHeld | undefined) => !n ? NOT_NOW
    : n === 'denied' ? `${DONT} The user denied this same step (${denied!.a.id}): ask again only if something changed.`
      : n === 'unanswered' ? `${DONT} This step reached the user ${ignored} times and got no answer: say in your report that it waits for his approval.`
        : `${DONT} Wait for that one's answer: it is this same step.`

  const other = file.approvals.find((a) => a.status === 'pending' && Date.parse(a.expiresAt) > now && sameClass(a))
  if (other) {
    const own = other.requester.taskId === input.requester.taskId
    const whose = own ? 'This task already has' : `Task ${other.requester.taskId} already has`
    // The same step already on his devices: answer that one, never a second.
    const n = own && input.what !== undefined && other.what === input.what ? 'same_pending' : notHeld
    // The code stays `biometric_pending`: askers older than this one key on it.
    return new FenceRefusal('biometric_pending',
      `${whose} a single-use approval pending on the person's devices (${other.id}, until ${other.expiresAt}). ${tail(n)}`,
      { approvalId: other.id, taskId: other.requester.taskId }, n)
  }
  if (reserved && reserved.taskId !== input.requester.taskId) {
    return new FenceRefusal('biometric_pending',
      `Walnut just told task ${reserved.taskId ?? 'another task'} to ask again for its held approval (${reserved.heldId}): the person's devices are kept for that one first. ${tail(notHeld)}`,
      undefined, notHeld)
  }
  if (!activity) return new FenceRefusal('presence_unknown', `Walnut could not tell whether the user is at hand, so it did not send this approval to his devices. ${tail(notHeld)}`, undefined, notHeld)
  // The newest single-use ask that ended without going through: he must have done something after it ended.
  const endedAt = endedAsks.reduce<number | null>((m, e) => (m === null || e.at > m ? e.at : m), null)
  const last = activity.lastSeenAt
  if (denied && !(last !== null && last > denied.at)) {
    return new FenceRefusal('unanswered_retry', `The user denied this same step and has done nothing in Walnut since. ${tail('denied')}`, undefined, 'denied')
  }
  if (endedAt !== null && !(last !== null && last > endedAt)) {
    return new FenceRefusal('unanswered_retry', `The last single-use approval ended without going through (expired, denied or withdrawn), and the user has done nothing in Walnut since. ${tail(notHeld)}`, undefined, notHeld)
  }
  const present = activity.streaming || (last !== null && now - last < presentMs())
  if (!present) return new FenceRefusal('user_away', `The user has not been in any Walnut chat for ${Math.round(presentMs() / 60_000)} minutes, so nobody would answer this approval now. ${tail(notHeld)}`, undefined, notHeld)
  return null
}
