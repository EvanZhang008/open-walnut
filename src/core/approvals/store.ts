/**
 * The approvals store: WALNUT_HOME/approvals/approvals.json, on the primary only.
 *
 * Pending approvals live until they are answered, canceled by their asker or reach
 * expiresAt; decided ones are kept APPROVAL_KEEP_MS (at most APPROVAL_KEEP_MAX) as the
 * record of who answered what, when, on which device and how.
 *
 * Writes go through updateJsonFile (a cross-process file lock) behind an in-process FIFO,
 * the way the inbox store does. Waiters are in-process: wait() resolves on this module's
 * own change signal or its deadline, whichever is first, then re-reads the file.
 */

import { contextSummary, type AskerContext } from './asker-context.js'
import crypto from 'node:crypto'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile } from '../../utils/fs.js'
import { bus } from '../event-bus.js'
import { tellAskerLater } from './tell-asker.js'
import { FenceRefusal, fenceRefusal, fenceSkipped, fenced, notHeldNow, readActivity, type FenceSubject, type UserActivity } from './single-use-fence.js'
import {
  heldWords, holdAsk, holdMs, kick as kickHeld, markAsked, reservedHeld, startHeldSweep, stepKey, type HeldAsk, type HeldVerdict, type SweepDeps,
} from './held-asks.js'
import { log } from '../../logging/index.js'
import { approvalDigest } from './digest.js'
import { deviceLabel } from './device-name.js'
import {
  APPROVAL_DEFAULT_TIMEOUT_MS, APPROVAL_DETAIL_MAX, APPROVAL_KEEP_MAX, APPROVAL_KEEP_MS, APPROVAL_MAX_TIMEOUT_MS,
  APPROVAL_MIN_TIMEOUT_MS, APPROVAL_WAIT_MAX_MS, APPROVAL_WHAT_MAX, isTerminal,
  type ApprovalDecision, type ApprovalDeviceKind, type ApprovalRecord,
  type ApprovalRequester, type ApprovalsFile, type ApprovalView,
} from './types.js'

export const APPROVAL_CHANGED = 'approval:changed'
/** How long the asker may read a used decision again (a response lost on the way). */
export const APPROVAL_REREAD_MS = 60_000

function approvalsFile(): string {
  return path.join(WALNUT_HOME, 'approvals', 'approvals.json')
}

const EMPTY: ApprovalsFile = { version: 1, approvals: [] }
const signal = new EventEmitter()
signal.setMaxListeners(0)

let chain: Promise<unknown> = Promise.resolve()
function serial<R>(fn: () => Promise<R>): Promise<R> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

export class ApprovalError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export function viewOf(rec: ApprovalRecord): ApprovalView {
  const { waitTokenHash: _hidden, ...view } = rec
  // What an older Walnut wrote may name a device by a generated id (device-name.ts): the answer's
  // device, and the title of its "Let … sign your approvals" asks, still in the history (a decided
  // one only: the title is in the record's digest, and none of them stays pending past boot).
  const asked = view.enrollsKey && view.status !== 'pending' ? /^Let "(.+)" \((Mac app|iPhone)\) sign your approvals$/.exec(view.what) : null
  const what = asked ? `Let "${deviceLabel(asked[1], asked[2] === 'iPhone' ? 'iphone' : 'mac-app')}" (${asked[2]}) sign your approvals` : view.what
  const device = view.answer?.device
  const name = device && device.kind !== 'setting' ? deviceLabel(device.name, device.kind) : device?.name
  if (what === view.what && name === device?.name) return view
  return { ...view, what, ...(device ? { answer: { ...view.answer!, device: { ...device, name: name! } } } : {}) }
}

const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

function tokenMatches(rec: ApprovalRecord, token: string | undefined): boolean {
  if (!token) return false
  const a = Buffer.from(sha(token), 'hex')
  const b = Buffer.from(rec.waitTokenHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Pending ones past their deadline become expired; old decided ones age out. */
function settleClock(file: ApprovalsFile, now: number): ApprovalRecord[] {
  const changed: ApprovalRecord[] = []
  for (const a of file.approvals) {
    if (a.status === 'pending' && Date.parse(a.expiresAt) <= now) {
      a.status = 'expired'
      changed.push(a)
    }
  }
  const keep = file.approvals.filter((a) => a.status === 'pending' || now - Date.parse(a.answer?.at ?? a.expiresAt) < APPROVAL_KEEP_MS)
  const pending = keep.filter((a) => a.status === 'pending')
  const decided = keep.filter((a) => a.status !== 'pending').slice(-APPROVAL_KEEP_MAX)
  file.approvals = [...decided, ...pending].sort((x, y) => x.createdAt.localeCompare(y.createdAt))
  return changed
}

function announce(recs: ApprovalRecord[]): void {
  for (const rec of recs) {
    signal.emit(rec.id)
    const view = viewOf(rec)
    bus.emit(APPROVAL_CHANGED, { id: rec.id, status: rec.status, approval: view }, ['web-ui', 'approvals'], { source: 'approvals' })
    armExpiry(rec)
    // The asking session hears the decision when nothing of it is waiting to read it (tell-asker.ts).
    tellAskerLater(rec)
    // A single-use ask that ended frees the person's devices for the next held one (held-asks.ts).
    if (rec.singleUse && rec.status !== 'pending') kickHeld()
  }
}

const expiryTimers = new Map<string, NodeJS.Timeout>()
function armExpiry(rec: ApprovalRecord): void {
  const old = expiryTimers.get(rec.id)
  if (old) clearTimeout(old)
  expiryTimers.delete(rec.id)
  if (rec.status !== 'pending') return
  const ms = Math.max(0, Date.parse(rec.expiresAt) - Date.now()) + 50
  const t = setTimeout(() => {
    expiryTimers.delete(rec.id)
    void sweepExpired().catch((err) => log.web.warn('approvals: expiry sweep failed', { error: String(err) }))
  }, Math.min(ms, 2_147_000_000))
  t.unref?.()
  expiryTimers.set(rec.id, t)
}

export async function sweepExpired(): Promise<number> {
  const changed = await serial(async () => {
    let out: ApprovalRecord[] = []
    await updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
      out = settleClock(file, Date.now())
      return file
    })
    return out
  })
  announce(changed)
  return changed.length
}

/** On boot: arm the clock of every pending approval and expire the overdue ones. */
export async function initApprovals(): Promise<void> {
  // The switch Walnut set last (ask-me.ts): an off written by any other path never reads as off.
  const { loadAskMeLatch } = await import('./ask-me.js')
  await loadAskMeLatch().catch((err) => log.web.warn('approvals: reading the switch failed', { error: String(err) }))
  await sweepExpired()
  await withdrawDeviceKeyAsks().catch((err) => log.web.warn('approvals: withdrawing the device-key asks failed', { error: String(err) }))
  const file = await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)
  // A decision made just before a restart, inside the asker's grace, is still told.
  const { rearmAskerNotices } = await import('./tell-asker.js')
  rearmAskerNotices(file.approvals)
  for (const a of file.approvals) armExpiry(a)
  // Held single-use asks: the minute clock and the person's attention release the next (held-asks.ts).
  startHeldSweep(heldSweepDeps())
}

/**
 * Held single-use asks (held-asks.ts): one goes when a fresh ask of it would be let through now, by
 * the same checks createApproval makes (the fence, then the pending cap); one that never may is dropped.
 */
export function heldSweepDeps(tell?: SweepDeps['tell']): SweepDeps {
  return {
    verdict: async () => {
      const activity = await readActivity()
      const read = await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)
      const now = Date.now()
      // As createApproval sees it after settleClock: an ask past its time counts as expired (a view, never written).
      const file: ApprovalsFile = { ...read, approvals: read.approvals.map((a) => (a.status === 'pending' && Date.parse(a.expiresAt) <= now ? { ...a, status: 'expired' as const } : a)) }
      return (h: HeldAsk): HeldVerdict => {
        const subject = { singleUse: true, requester: { taskId: h.requester.taskId }, testRun: h.testRun, what: h.what }
        const never = notHeldNow(file, subject, now)
        if (never === 'denied' || never === 'unanswered') return never
        return fenceRefusal(file, subject, now, activity) === null && pendingCapMessage(file, h.testRun, now) === null ? 'go' : 'wait'
      }
    },
    tell: tell ?? (async (t) => (await import('./tell-asker.js')).tellHeldAsker(t)),
  }
}

/**
 * On boot: an older Walnut's asks about device keys that are still open (to let a device sign, to
 * remove one, to turn approvals off with a signature) are withdrawn. No device key exists any more
 * (types.ts), so approving one would do nothing.
 */
export async function withdrawDeviceKeyAsks(): Promise<number> {
  const file = await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)
  const legacy = file.approvals.filter((a) => {
    const old = a as ApprovalRecord & { removesKey?: string; turnsAskMeOff?: true }
    return a.status === 'pending' && (!!old.enrollsKey || !!old.removesKey || !!old.turnsAskMeOff)
  })
  for (const a of legacy) {
    await cancelInternal(a.id, 'Walnut no longer keeps device keys: any device you are signed in on approves').catch(() => undefined)
  }
  if (legacy.length) log.web.info('approvals: withdrew the asks about device keys', { asks: legacy.map((a) => a.id) })
  return legacy.length
}

export interface CreateInput {
  what: string
  detail?: string
  /** Whether `detail` is the request in words (shown whole) or technical (in Details): every creator says (approval-detail-role-ratchet). */
  detailRole?: 'summary' | 'technical'
  timeoutMs?: number
  requester: ApprovalRequester
  testRun?: string
  singleUse?: boolean
  /** Why it asks and where the task stands (asker-context.ts); kept in a single-use envelope. */
  context?: AskerContext
  requestOnly?: boolean
  /** Record it as done without asking (approvals off, ask-me.ts): the gate's name. */
  unasked?: string
  /** An ask the Approvals switch never answers (an explicit `walnut approve`, the person's site list). */
  outsideSwitch?: boolean
  /** Approving it needs Passwords unlocked in the answering window (an agent's ask for a locked note). */
  needsPasswords?: boolean
  /**
   * An agent's ask that waits for the person (it may end its turn and is told the answer): it stays
   * open until they answer, while they are away too, at most held-asks.ts HOLD_MS, not its short
   * clock (at most UNTIL_BACK_MAX such asks of one task, UNTIL_BACK_ALL_MAX in all). Every creator says yes or no
   * (the guard in tests/core/approvals/until-back.test.ts); a script that blocks on its own
   * --timeout keeps its clock, and so does a single-use ask (five minutes to use it).
   */
  untilBack?: boolean
}

const fenceError = (r: FenceRefusal) => new ApprovalError(r.code === 'too_many_pending' ? 429 : 409, r.code, r.message)

/** Whether a viewer (its test-run label, or none for the person) sees this approval. */
export function visibleTo(rec: Pick<ApprovalRecord, 'testRun'>, viewer: string | undefined): boolean {
  return (rec.testRun ?? undefined) === (viewer ?? undefined)
}

/**
 * A lone UTF-16 surrogate would survive JSON here but fail every Swift decoder, so one crafted
 * ask could empty the phone's list: each text is made well formed before it is kept or hashed.
 */
export function wellFormed(s: string): string {
  const f = (s as unknown as { toWellFormed?: () => string }).toWellFormed
  return f ? f.call(s) : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/** Pending approvals one asker class (the person's, or one test run's) may hold at once. */
export const APPROVAL_PENDING_MAX = 20
/**
 * Asks open until the person answers, at a time: per task, and in all (well under
 * APPROVAL_PENDING_MAX, so long asks never fill the cap a script's ask needs). Past either a new ask
 * keeps its own short clock.
 */
export const UNTIL_BACK_MAX = 3
export const UNTIL_BACK_ALL_MAX = 10

/** Whether one more ask may stay open until answered: under both caps, in its test-run class. */
function untilBackRoom(file: ApprovalsFile, rec: ApprovalRecord, now: number): boolean {
  const who = (a: ApprovalRecord) => a.requester.taskId ? `t:${a.requester.taskId}` : a.requester.sessionId ? `s:${a.requester.sessionId}` : ''
  const open = file.approvals.filter((a) => a.untilBack && a.status === 'pending' && Date.parse(a.expiresAt) > now
    && (a.testRun ?? null) === (rec.testRun ?? null))
  return open.length < UNTIL_BACK_ALL_MAX && open.filter((a) => who(a) === who(rec)).length < UNTIL_BACK_MAX
}

export function cleanWhat(raw: unknown): string {
  const what = typeof raw === 'string' ? wellFormed(raw).replace(/\s+/g, ' ').trim() : ''
  if (!what) throw new ApprovalError(400, 'bad_request', 'Say what is to be approved (what).')
  if (what.length > APPROVAL_WHAT_MAX) throw new ApprovalError(400, 'bad_request', `what is at most ${APPROVAL_WHAT_MAX} characters; put the rest in detail.`)
  return what
}

/** A single-use envelope (createApproval) for this asker: its session, task and host, a nonce, the context. */
/** A looping script must not flood the phone: the refusal past the cap of asks waiting, else null. */
function pendingCapMessage(file: ApprovalsFile, testRun: string | undefined, now: number): string | null {
  const open = file.approvals.filter((a) => a.status === 'pending' && Date.parse(a.expiresAt) > now && (a.testRun ?? null) === (testRun ?? null)).length
  return open >= APPROVAL_PENDING_MAX ? `${open} approvals are already waiting for an answer; answer or withdraw some first.` : null
}

function singleUseDetailMatches(detail: string | undefined, requester: ApprovalRequester): boolean {
  if (!detail || !requester.sessionId || !requester.taskId) return false
  try {
    const value = JSON.parse(detail)
    return value?.version === 'walnut-single-use-v1' && value.sessionId === requester.sessionId
      && value.taskId === requester.taskId && value.host === requester.host
      && typeof value.nonce === 'string' && /^[0-9a-f]{64}$/.test(value.nonce)
      && typeof value.context === 'string' && value.context.length > 0
  } catch { return false }
}

export async function createApproval(input: CreateInput): Promise<{ approval: ApprovalView; waitToken: string }> {
  const what = cleanWhat(input.what)
  if (input.singleUse && typeof input.detail === 'string' && wellFormed(input.detail) !== input.detail) {
    throw new ApprovalError(400, 'bad_request', 'Single-use operation context must be well-formed Unicode; it is never normalized.')
  }
  let detail = typeof input.detail === 'string' && input.detail.trim() ? wellFormed(input.detail) : undefined
  if (input.unasked && input.singleUse) throw new ApprovalError(400, 'bad_request', 'A single-use approval is always asked.')
  if (input.singleUse && detail) {
    detail = JSON.stringify({ version: 'walnut-single-use-v1', sessionId: input.requester.sessionId,
      taskId: input.requester.taskId, host: input.requester.host,
      nonce: crypto.randomBytes(32).toString('hex'), context: detail,
      // What the person read to decide rides in the envelope the digest covers, never only an unbound requester.
      ...(input.context?.why ? { why: input.context.why } : {}),
      ...(input.context && contextSummary(input.context) ? { context_summary: contextSummary(input.context) } : {}) })
  }
  if (detail && detail.length > APPROVAL_DETAIL_MAX) {
    throw new ApprovalError(400, 'bad_request', input.singleUse ? `The single-use context envelope exceeds ${APPROVAL_DETAIL_MAX} characters; shorten the operation context.` : `detail is at most ${APPROVAL_DETAIL_MAX} characters.`)
  }
  const timeout = Math.min(APPROVAL_MAX_TIMEOUT_MS, Math.max(APPROVAL_MIN_TIMEOUT_MS, input.timeoutMs ?? (input.singleUse ? 300_000 : APPROVAL_DEFAULT_TIMEOUT_MS)))
  if (input.singleUse && (!input.requester.sessionId
    || !singleUseDetailMatches(detail, input.requester) || !Number.isFinite(timeout) || timeout > 300_000)) {
    throw new ApprovalError(400, 'strict_approval_required', 'Single-use approvals need a task session and detail, with at most five minutes to use them.')
  }
  // One single-use ask per account at a time, only to a person who is there (single-use-fence.ts).
  const subject: FenceSubject & { detail?: string } = { singleUse: input.singleUse, unasked: input.unasked, requester: input.requester, testRun: input.testRun, detail, what }
  const fence = fenced(subject) && !fenceSkipped()
  const activity: UserActivity | null = fence ? await readActivity() : null
  const now = Date.now()
  // An agent's ask that waits for the person stays open until they answer, while they are away too
  // (at most a held ask's hold), never its short clock: it is on their devices when they come back,
  // one tap, and the asking session is told the answer (2026-11-26: a $30 payment's ask expired
  // twice in 10 minutes while the person was away, and the task went back to waiting on them).
  const long = !!input.untilBack && !input.singleUse && !input.unasked && !!(input.requester.taskId || input.requester.sessionId) && !fenceSkipped()
  const id = 'apr-' + crypto.randomBytes(9).toString('base64url')
  const createdAt = new Date(now).toISOString()
  const waitToken = crypto.randomBytes(24).toString('base64url')
  const requester = Object.fromEntries(Object.entries({ ...input.requester, host: input.requester.host || 'unknown' })
    .map(([k, v]) => [k, typeof v === 'string' ? wellFormed(v) : v])) as unknown as ApprovalRequester
  // The digest covers expiresAt, so the record is built once its end is known (the brake is read in the locked write).
  const build = (untilBack: boolean): ApprovalRecord => {
    const expiresAt = new Date(now + (untilBack ? Math.max(holdMs(), timeout) : timeout)).toISOString()
    return {
      id, what, ...(detail ? { detail } : {}),
      // A single-use envelope's detail is the operation's context: technical, whatever the creator said.
      ...(detail && input.detailRole === 'summary' && !input.singleUse ? { detailRole: 'summary' as const } : {}),
      digest: approvalDigest({ id, mode: 'tap', createdAt, expiresAt, host: requester.host, taskId: requester.taskId, what, detail }),
      mode: 'tap',
      requester, createdAt, expiresAt, status: 'pending', waitTokenHash: sha(waitToken),
      ...(input.testRun ? { testRun: input.testRun } : {}),
      ...(input.singleUse ? { singleUse: true } : {}),
      ...(input.context && Object.keys(input.context).length ? { context: input.context } : {}),
      ...(input.requestOnly ? { requestOnly: true } : {}),
      ...(input.outsideSwitch ? { outsideSwitch: true } : {}),
      ...(input.needsPasswords ? { needsPasswords: true } : {}),
      ...(untilBack ? { untilBack: true as const } : {}),
      // Approvals off: nobody is asked; the record says the step went ahead and who took it.
      ...(input.unasked ? {
        unasked: input.unasked, status: 'approved' as const, readAt: createdAt,
        answer: { decision: 'approve' as const, at: createdAt, mode: 'tap' as const, device: { name: 'Approvals off', kind: 'setting' as const } },
      } : {}),
    }
  }
  let rec = build(long)
  // A held ask of another task released just now keeps the person's devices for its ask (held-asks.ts).
  const reserved = fence ? await reservedHeld(input.testRun, now) : null
  let settled: ApprovalRecord[] = []
  let refused: FenceRefusal | null = null
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    settled = settleClock(file, now)
    // Too many asks already open until the person answers (this task's, or all): this one keeps its own clock.
    if (rec.untilBack && !untilBackRoom(file, rec, now)) rec = build(false)
    refused = fence ? fenceRefusal(file, subject, now, activity, reserved) : null
    if (refused) throw fenceError(refused)
    // Past the cap a new ask is refused (the held sweep makes this same check before a release).
    const message = rec.unasked ? null : pendingCapMessage(file, rec.testRun, now)
    if (message) {
      // A single-use ask of a task is "not now" here too: held until the person is back.
      if (fence) { refused = new FenceRefusal('too_many_pending', message, undefined, notHeldNow(file, subject, now)); throw fenceError(refused) }
      throw new ApprovalError(429, 'too_many_pending', message)
    }
    file.approvals.push(rec)
    return file
  })).catch(async (err) => {
    const r = refused as FenceRefusal | null
    if (!r || !r.holdable) throw err
    // "Not now": kept until the person is back, and its task is told then (held-asks.ts). A hold
    // that cannot be kept (full, the disk refused it, void after its deadline) answers the fence's refusal.
    const status = err instanceof ApprovalError ? err.status : 409
    const held = await holdAsk({ ...subject, what, requester }, r.code, now).catch((e) => {
      log.web.warn('approvals: holding a refused single-use ask failed', { taskId: requester.taskId, error: String(e) })
      return { full: true } as const
    })
    if ('void' in held) {
      throw new ApprovalError(status, r.code, `${r.message} Walnut held this same step until ${held.void.until} and the user did not come back, so it is void and Walnut does not hold it again now: do not ask again by yourself; say in your report that the step waits for the user's approval.`)
    }
    if (!('id' in held)) throw new ApprovalError(status, r.code, `${r.message} Walnut could not hold it either: do not ask again by yourself; say in your report that the step waits for the user's approval.`)
    throw new ApprovalError(status, r.code, `${r.message} ${heldWords(held)}`)
  })
  if (fence) await markAsked({ testRun: rec.testRun, taskId: requester.taskId, step: stepKey(what, requester) }, id, now)
  log.web.info(rec.unasked ? 'approval not asked: approvals are off' : 'approval created', { approvalId: id, mode: rec.mode, host: requester.host, taskId: requester.taskId, ...(rec.unasked ? { gate: rec.unasked } : {}) })
  // One done without asking pops up nowhere and tells no one; the history lists it.
  const out = !rec.unasked
  announce(out ? [...settled, rec] : settled)
  return { approval: viewOf(rec), waitToken }
}

export async function getApproval(id: string): Promise<ApprovalRecord | undefined> {
  const file = await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)
  const rec = file.approvals.find((a) => a.id === id)
  if (rec && rec.status === 'pending' && Date.parse(rec.expiresAt) <= Date.now()) {
    await sweepExpired()
    return (await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)).approvals.find((a) => a.id === id)
  }
  return rec
}

export async function listApprovals(opts: { status?: 'pending' | 'all'; limit?: number; viewer?: string } = {}): Promise<ApprovalView[]> {
  const file = await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)
  const now = Date.now()
  const rows = file.approvals
    .filter((a) => visibleTo(a, opts.viewer))
    .filter((a) => opts.status === 'all' || (a.status === 'pending' && Date.parse(a.expiresAt) > now))
  return rows.reverse().slice(0, opts.limit ?? 200).map(viewOf)
}

export interface AnswerInput {
  decision: ApprovalDecision
  /** The digest of the request the answering device showed: another one is refused (it changed). */
  digest?: string
  device: { name: string; kind: ApprovalDeviceKind }
}

/**
 * Record a person's answer: the route let only a person through (routes/approvals-v1.ts), from any
 * device they are signed in on, and one tap is enough for every approval. The first answer wins.
 */
export async function answerApproval(id: string, input: AnswerInput): Promise<ApprovalView> {
  if (input.decision !== 'approve' && input.decision !== 'deny') throw new ApprovalError(400, 'bad_request', 'decision is approve or deny.')
  const current = await getApproval(id)
  if (!current) throw new ApprovalError(404, 'not_found', 'No such approval.')
  if (input.digest !== undefined && input.digest !== current.digest) {
    throw new ApprovalError(409, 'changed', 'This approval is not the one your device showed; reload it.')
  }
  let out: ApprovalRecord | undefined
  let conflict: ApprovalError | undefined
  let settled: ApprovalRecord[] = []
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    settled = settleClock(file, Date.now())
    const rec = file.approvals.find((a) => a.id === id)
    if (!rec) { conflict = new ApprovalError(404, 'not_found', 'No such approval.'); return file }
    if (rec.digest !== current.digest) { conflict = new ApprovalError(409, 'changed', 'The approval changed; reload it.'); return file }
    if (isTerminal(rec.status)) {
      conflict = new ApprovalError(409, `already_${rec.status}`, `This approval is already ${rec.status}.`)
      return file
    }
    rec.status = input.decision === 'approve' ? 'approved' : 'denied'
    rec.answer = {
      decision: input.decision,
      at: new Date().toISOString(),
      mode: 'tap',
      device: { name: deviceLabel(input.device.name.slice(0, 80), input.device.kind), kind: input.device.kind },
    }
    out = rec
    return file
  }))
  // Approvals this write found past their deadline are as expired as the sweep would make them.
  announce(settled)
  if (conflict) throw conflict
  log.web.info('approval answered', { approvalId: id, decision: input.decision, mode: out!.answer!.mode, device: out!.answer!.device.name })
  announce([out!])
  return viewOf(out!)
}

export interface WaitResult {
  approval: ApprovalView
  /** True on the one read that used the decision; a later read is refused. */
  used: boolean
}

/**
 * The asker's read: holds until the approval is decided or `waitMs` passes (at most
 * APPROVAL_WAIT_MAX_MS), then answers its state. The first read of a decision uses it
 * (consumedAt); a read more than APPROVAL_REREAD_MS later is 409 approval_used, so one
 * approval lets one run through, while a retry of a lost response still gets its answer.
 */
export async function waitApproval(id: string, token: string | undefined, waitMs: number): Promise<WaitResult> {
  return waitFor(id, (rec) => tokenMatches(rec, token), waitMs)
}

/**
 * waitApproval for this server's own ask that a restart carried over (core/kept-asks.ts keeps only
 * the wait token's hash, never the token): the hash must be the one the approval holds. Server
 * code only; no route takes a hash.
 */
export async function waitApprovalByTokenHash(id: string, tokenHash: string, waitMs: number): Promise<WaitResult> {
  return waitFor(id, (rec) => {
    const a = Buffer.from(tokenHash, 'hex')
    const b = Buffer.from(rec.waitTokenHash, 'hex')
    return a.length === 32 && a.length === b.length && crypto.timingSafeEqual(a, b)
  }, waitMs)
}

/** The sha256 a wait token is kept as. */
export const waitTokenHashOf = (token: string): string => sha(token)

async function waitFor(id: string, matches: (rec: ApprovalRecord) => boolean, waitMs: number): Promise<WaitResult> {
  const first = await getApproval(id)
  if (!first) throw new ApprovalError(404, 'not_found', 'No such approval.')
  if (!matches(first)) throw new ApprovalError(403, 'bad_token', 'Only the process that asked reads this approval\'s answer.')
  if (first.status === 'pending' && waitMs > 0) {
    await new Promise<void>((resolve) => {
      const ms = Math.min(APPROVAL_WAIT_MAX_MS, waitMs)
      const done = () => { clearTimeout(t); signal.off(id, done); resolve() }
      const t = setTimeout(done, ms)
      t.unref?.()
      signal.on(id, done)
    })
  }
  const rec = await getApproval(id)
  if (!rec) throw new ApprovalError(404, 'not_found', 'No such approval.')
  if (rec.status !== 'approved' && rec.status !== 'denied') {
    if (isTerminal(rec.status)) await noteAskerRead(id)
    return { approval: viewOf(rec), used: false }
  }
  if (rec.singleUse) {
    await noteAskerRead(id)
    return { approval: viewOf(rec), used: false }
  }
  let used = false
  let refused = false
  let consumedAt = rec.consumedAt
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    const r = file.approvals.find((a) => a.id === id)
    if (!r) return file
    if (r.consumedAt) {
      // The same asker reading again right away (its answer lost on the way, a relay retry)
      // gets the same decision; a later read is a second use.
      refused = Date.now() - Date.parse(r.consumedAt) > APPROVAL_REREAD_MS
      consumedAt = r.consumedAt
      return file
    }
    r.consumedAt = consumedAt = new Date().toISOString()
    r.readAt ??= consumedAt
    used = true
    return file
  }))
  if (refused) throw new ApprovalError(409, 'approval_used', 'This approval\'s answer was already used; ask again.')
  return { approval: viewOf({ ...rec, consumedAt }), used }
}

export interface ConsumeInput {
  token: string
  digest: string
  detail: string
  requester: ApprovalRequester
}

/**
 * The asker spends a single-use approval, once: the same session's own process (the route checked
 * it), with the context it rebuilt from what it is about to run, inside the five-minute life.
 */
export async function consumeApproval(id: string, input: ConsumeInput): Promise<WaitResult> {
  let out: ApprovalRecord | undefined
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, async (file) => {
    const rec = file.approvals.find((a) => a.id === id)
    if (!rec) throw new ApprovalError(404, 'not_found', 'No such approval.')
    if (!tokenMatches(rec, input.token)) throw new ApprovalError(403, 'bad_token', 'Only the asker can consume this approval.')
    const owner = rec.requester
    if (!owner.sessionId || !owner.taskId || owner.sessionId !== input.requester.sessionId
      || owner.taskId !== input.requester.taskId || owner.host !== input.requester.host) {
      throw new ApprovalError(403, 'wrong_asker', 'This approval belongs to another task session or host.')
    }
    const digest = approvalDigest({ ...rec, host: owner.host, taskId: owner.taskId })
    if (!rec.singleUse || rec.digest !== digest
      || input.digest !== digest || !singleUseDetailMatches(rec.detail, owner)
      || JSON.parse(rec.detail!).context !== input.detail) {
      throw new ApprovalError(409, 'changed', 'The approval does not match this operation.')
    }
    const created = Date.parse(rec.createdAt), expires = Date.parse(rec.expiresAt), now = Date.now()
    if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now || expires <= now
      || expires <= created || expires - created > 300_000) {
      throw new ApprovalError(409, 'approval_expired', 'The approval expired; ask again.')
    }
    if (rec.consumedAt) throw new ApprovalError(409, 'approval_used', 'This approval was already used; ask again.')
    if (rec.status !== 'approved' || rec.answer?.decision !== 'approve' || rec.answer.device.kind === 'setting') {
      throw new ApprovalError(403, 'not_approved', 'Nobody approved this operation.')
    }
    const spentAt = Date.now()
    if (expires <= spentAt) throw new ApprovalError(409, 'approval_expired', 'The approval expired; ask again.')
    rec.consumedAt = new Date(spentAt).toISOString()
    rec.readAt ??= rec.consumedAt
    out = rec
    return file
  }, { durable: true }))
  return { approval: viewOf(out!), used: true }
}

/**
 * The asker read how its approval ended, by a way of its own (a browser step holding for the
 * answer, an expiry read in a wait): Walnut need not tell its session (tell-asker.ts).
 */
export async function noteAskerRead(id: string): Promise<void> {
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    const r = file.approvals.find((a) => a.id === id)
    if (r && isTerminal(r.status) && !r.readAt) r.readAt = new Date().toISOString()
    return file
  }))
}

/**
 * The summary Walnut wrote for a request still waiting (summary.ts): kept on its context, and every
 * screen showing it hears the change. Never a decided one, never over the asker's own words. True when kept.
 */
export async function setApprovalSummary(id: string, summary: string): Promise<boolean> {
  let kept: ApprovalRecord | undefined
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    const r = file.approvals.find((a) => a.id === id)
    // Past its deadline it is expired, even before the sweep says so: no screen shows it again.
    if (!r || r.status !== 'pending' || Date.parse(r.expiresAt) <= Date.now() || r.context?.whyFrom === 'asker') return file
    r.context = { ...(r.context ?? {}), summary: wellFormed(summary) }
    kept = r
    return file
  }))
  // Only the screens: not the 'approvals' channel, whose push sender (notify.ts) reads a pending one
  // as new and would ring the phone again, and not the signal, so nobody waiting on it wakes.
  if (kept) bus.emit(APPROVAL_CHANGED, { id, status: kept.status, approval: viewOf(kept) }, ['web-ui'], { source: 'approvals' })
  return !!kept
}

/** Walnut told the asking session; true only for the one write that marked it (never twice). */
export async function markAskerTold(id: string): Promise<boolean> {
  let first = false
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    const r = file.approvals.find((a) => a.id === id)
    if (r && !r.askerToldAt && !r.readAt && !r.consumedAt) { r.askerToldAt = new Date().toISOString(); first = true }
    return file
  }))
  return first
}

/** The asker gave up (Ctrl-C, its own deadline): the card goes away on every device. */
export async function cancelApproval(id: string, token: string | undefined, reason: string): Promise<ApprovalView> {
  const first = await getApproval(id)
  if (!first) throw new ApprovalError(404, 'not_found', 'No such approval.')
  if (!tokenMatches(first, token)) throw new ApprovalError(403, 'bad_token', 'Only the process that asked cancels this approval.')
  return cancelInternal(id, reason)
}

/** Cancel without the asker's token: for Walnut's own approvals (one whose step ended, an old device-key ask). */
export async function cancelInternal(id: string, reason: string): Promise<ApprovalView> {
  let out: ApprovalRecord | undefined
  let settled: ApprovalRecord[] = []
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    settled = settleClock(file, Date.now())
    const rec = file.approvals.find((a) => a.id === id)
    if (!rec) return file
    if (rec.status === 'pending') {
      rec.status = 'canceled'
      rec.canceledReason = reason.slice(0, 200)
      rec.canceledAt = new Date().toISOString()
      out = rec
    }
    return file
  }))
  announce(out ? [...settled, out] : settled)
  const now = await getApproval(id)
  if (!now) throw new ApprovalError(404, 'not_found', 'No such approval.')
  return viewOf(now)
}

/** For tests: forget timers. */
export function _resetApprovalTimersForTesting(): void {
  for (const t of expiryTimers.values()) clearTimeout(t)
  expiryTimers.clear()
}
