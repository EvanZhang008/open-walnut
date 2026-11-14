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
import { log } from '../../logging/index.js'
import { answerMessage, approvalDigest, verifySignature } from './digest.js'
import {
  APPROVAL_DEFAULT_TIMEOUT_MS, APPROVAL_DETAIL_MAX, APPROVAL_KEEP_MAX, APPROVAL_KEEP_MS, APPROVAL_MAX_TIMEOUT_MS,
  APPROVAL_MIN_TIMEOUT_MS, APPROVAL_WAIT_MAX_MS, APPROVAL_WHAT_MAX, isTerminal,
  type ApprovalAnswer, type ApprovalDecision, type ApprovalDeviceKind, type ApprovalMode, type ApprovalRecord,
  type ApprovalGuard, type ApprovalRequester, type ApprovalsFile, type ApprovalView,
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
  return view
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
  // The switch Walnut set last (ask-me.ts): an off it did not sign never reads as off.
  const { loadAskMeLatch } = await import('./ask-me.js')
  await loadAskMeLatch().catch((err) => log.web.warn('approvals: reading the switch failed', { error: String(err) }))
  await sweepExpired()
  // Keys an older Walnut kept for a Mac that has since enrolled a newer one (keys.ts).
  const { retireReplacedMacKeys } = await import('./keys.js')
  await retireReplacedMacKeys().catch((err) => log.web.warn('approvals: retiring replaced Mac keys failed', { error: String(err) }))
  const file = await readJsonFile<ApprovalsFile>(approvalsFile(), EMPTY)
  // A decision made just before a restart, inside the asker's grace, is still told.
  const { rearmAskerNotices } = await import('./tell-asker.js')
  rearmAskerNotices(file.approvals)
  for (const a of file.approvals) armExpiry(a)
}

export interface CreateInput {
  what: string
  detail?: string
  mode: ApprovalMode
  timeoutMs?: number
  requester: ApprovalRequester
  /** Set when `biometric` was asked but cannot be honored, with why (the caller decides). */
  downgraded?: string
  enrollsKey?: string
  removesKey?: string
  turnsAskMeOff?: true
  testRun?: string
  guard?: ApprovalGuard
  singleUse?: boolean
  signingKeyId?: string
  /** Any one of these keys may sign it (two or more; one key is `signingKeyId`). */
  signingKeyIds?: string[]
  /** Why it asks and where the task stands (asker-context.ts); signed in a single-use envelope. */
  context?: AskerContext
  requestOnly?: boolean
  /** Record it as done without asking (approvals off, ask-me.ts): the gate's name. */
  unasked?: string
  /** An ask the Approvals switch never answers (a new signing device, the person's site list). */
  outsideSwitch?: boolean
}

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

export function cleanWhat(raw: unknown): string {
  const what = typeof raw === 'string' ? wellFormed(raw).replace(/\s+/g, ' ').trim() : ''
  if (!what) throw new ApprovalError(400, 'bad_request', 'Say what is to be approved (what).')
  if (what.length > APPROVAL_WHAT_MAX) throw new ApprovalError(400, 'bad_request', `what is at most ${APPROVAL_WHAT_MAX} characters; put the rest in detail.`)
  return what
}

/**
 * The keys a single-use approval takes a signature from: one (`signingKeyId`), or a set of two or
 * more (`signingKeyIds`, sorted: a Git push the person may approve on the Mac or the iPhone). The
 * set rides in the signed envelope, so no one can widen it after it was asked.
 */
export function allowedSigners(rec: { signingKeyId?: string; signingKeyIds?: string[] }): string[] {
  return rec.signingKeyIds?.length ? rec.signingKeyIds : rec.signingKeyId ? [rec.signingKeyId] : []
}

/** Two or more distinct key ids, sorted; one id stays `signingKeyId`. Undefined when not that. */
export function signerSet(ids: readonly string[] | undefined): string[] | undefined {
  if (!ids) return undefined
  const set = [...new Set(ids)].sort()
  return set.length >= 2 ? set : undefined
}

function sameIds(a: unknown, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i])
}

function singleUseDetailMatches(detail: string | undefined, requester: ApprovalRequester, signers: { signingKeyId?: string; signingKeyIds?: string[] }): boolean {
  const allowed = allowedSigners(signers)
  if (!detail || !allowed.length || !requester.sessionId || !requester.taskId) return false
  try {
    const value = JSON.parse(detail)
    const keysMatch = allowed.length === 1
      ? value?.signingKeyId === allowed[0] && value.signingKeyIds === undefined
      : value?.signingKeyId === undefined && sameIds(value?.signingKeyIds, allowed)
    return value?.version === 'walnut-single-use-v1' && value.sessionId === requester.sessionId
      && value.taskId === requester.taskId && value.host === requester.host && keysMatch
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
  if (input.unasked && input.singleUse) throw new ApprovalError(400, 'bad_request', 'A signed single-use approval is always asked: only its device can sign it.')
  const keySet = signerSet(input.signingKeyIds)
  if (input.signingKeyIds && !keySet) throw new ApprovalError(400, 'bad_request', 'signing_key_ids names two or more different keys; one key is signing_key_id.')
  const signers = keySet ? { signingKeyIds: keySet } : { signingKeyId: input.signingKeyId }
  if (input.singleUse && detail) {
    detail = JSON.stringify({ version: 'walnut-single-use-v1', sessionId: input.requester.sessionId,
      taskId: input.requester.taskId, host: input.requester.host, ...signers,
      nonce: crypto.randomBytes(32).toString('hex'), context: detail,
      // What the person read to decide is signed with it, never only an unsigned requester.
      ...(input.context?.why ? { why: input.context.why } : {}),
      ...(input.context && contextSummary(input.context) ? { context_summary: contextSummary(input.context) } : {}) })
  }
  if (detail && detail.length > APPROVAL_DETAIL_MAX) {
    throw new ApprovalError(400, 'bad_request', input.singleUse ? `The signed context envelope exceeds ${APPROVAL_DETAIL_MAX} characters; shorten the operation context.` : `detail is at most ${APPROVAL_DETAIL_MAX} characters.`)
  }
  const timeout = Math.min(APPROVAL_MAX_TIMEOUT_MS, Math.max(APPROVAL_MIN_TIMEOUT_MS, input.timeoutMs ?? (input.singleUse ? 300_000 : APPROVAL_DEFAULT_TIMEOUT_MS)))
  if (input.singleUse && (input.mode !== 'biometric' || input.downgraded || !input.requester.sessionId
    || !singleUseDetailMatches(detail, input.requester, signers) || !Number.isFinite(timeout) || timeout > 300_000)) {
    throw new ApprovalError(400, 'strict_approval_required', 'Single-use approvals need a task session, a signing key, detail and biometric mode, with at most five minutes to use them.')
  }
  const now = Date.now()
  const id = 'apr-' + crypto.randomBytes(9).toString('base64url')
  const createdAt = new Date(now).toISOString()
  const expiresAt = new Date(now + timeout).toISOString()
  const waitToken = crypto.randomBytes(24).toString('base64url')
  const requester = Object.fromEntries(Object.entries({ ...input.requester, host: input.requester.host || 'unknown' })
    .map(([k, v]) => [k, typeof v === 'string' ? wellFormed(v) : v])) as unknown as ApprovalRequester
  const rec: ApprovalRecord = {
    id, what, ...(detail ? { detail } : {}),
    digest: approvalDigest({ id, mode: input.mode, createdAt, expiresAt, host: requester.host, taskId: requester.taskId, what, detail }),
    mode: input.mode,
    ...(input.downgraded ? { downgraded: input.downgraded } : {}),
    requester, createdAt, expiresAt, status: 'pending', waitTokenHash: sha(waitToken),
    ...(input.enrollsKey ? { enrollsKey: input.enrollsKey } : {}),
    ...(input.removesKey ? { removesKey: input.removesKey } : {}),
    ...(input.turnsAskMeOff ? { turnsAskMeOff: true as const } : {}),
    ...(input.testRun ? { testRun: input.testRun } : {}),
    ...(input.guard ? { guard: input.guard } : {}),
    ...(input.singleUse ? { singleUse: true, ...signers } : {}),
    ...(input.context && Object.keys(input.context).length ? { context: input.context } : {}),
    ...(input.requestOnly ? { requestOnly: true } : {}),
    ...(input.outsideSwitch ? { outsideSwitch: true } : {}),
    // Approvals off: nobody is asked; the record says the step went ahead and who took it.
    ...(input.unasked ? {
      unasked: input.unasked, status: 'approved' as const, readAt: createdAt,
      answer: { decision: 'approve' as const, at: createdAt, mode: 'tap' as const, device: { name: 'Approvals off', kind: 'setting' as const } },
    } : {}),
  }
  let settled: ApprovalRecord[] = []
  await serial(() => updateJsonFile<ApprovalsFile>(approvalsFile(), EMPTY, (file) => {
    settled = settleClock(file, now)
    // A looping script must not flood the phone: past the cap a new ask is refused.
    const open = file.approvals.filter((a) => a.status === 'pending' && (a.testRun ?? null) === (rec.testRun ?? null)).length
    if (!rec.unasked && open >= APPROVAL_PENDING_MAX) {
      throw new ApprovalError(429, 'too_many_pending', `${open} approvals are already waiting for an answer; answer or withdraw some first.`)
    }
    file.approvals.push(rec)
    return file
  }))
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
  /** For a biometric approve: the active device key and its signature over answerMessage(). */
  keyId?: string
  signature?: string
  device: { name: string; kind: ApprovalDeviceKind }
  /**
   * The route checked another proof only the person has (a Passwords unlock, for a vault ask:
   * approvals-v1.ts vaultApprover), so an unsigned Approve of a biometric approval is let through.
   */
  proven?: boolean
}

/** A key the answer check may use: active, with its SPKI. Injected so the store never imports keys.ts' file. */
export type KeyLookup = (keyId: string) => Promise<{ id: string; name: string; kind: 'iphone' | 'mac-app'; publicKey: string } | undefined>

/**
 * Record a person's answer. A biometric approval's Approve must carry a signature by an
 * active device key over this approval's digest; Deny never needs one, and a tap approval
 * takes a signed answer too (it is only stronger). The first answer wins.
 */
export async function answerApproval(id: string, input: AnswerInput, lookupKey: KeyLookup): Promise<ApprovalView> {
  if (input.decision !== 'approve' && input.decision !== 'deny') throw new ApprovalError(400, 'bad_request', 'decision is approve or deny.')
  const current = await getApproval(id)
  if (!current) throw new ApprovalError(404, 'not_found', 'No such approval.')
  let signed: ApprovalAnswer['device'] | undefined
  if (input.signature || input.keyId) {
    const key = input.keyId ? await lookupKey(input.keyId) : undefined
    if (!key || !input.signature) throw new ApprovalError(403, 'bad_signature', 'This device is not one that can sign approvals (enroll it first).')
    if (!verifySignature(key.publicKey, answerMessage(current.digest, input.decision), input.signature)) {
      throw new ApprovalError(403, 'bad_signature', 'The signature does not match this approval.')
    }
    signed = { id: key.id, name: key.name, kind: key.kind }
  }
  if (current.singleUse && input.decision === 'approve' && (!signed?.id || !allowedSigners(current).includes(signed.id))) {
    throw new ApprovalError(403, 'biometric_required', 'This approval needs a signature from its required signing device; an unsigned answer or another device cannot approve it.')
  }
  if (current.mode === 'biometric' && input.decision === 'approve' && !signed && !input.proven) {
    throw new ApprovalError(403, 'biometric_required', 'This approval needs Face ID or Touch ID on a device that signs approvals.')
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
      mode: signed ? 'biometric' : 'tap',
      device: signed ?? { name: input.device.name.slice(0, 80) || 'unknown', kind: input.device.kind },
      ...(signed ? { keyId: signed.id, signature: input.signature } : {}),
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
  const first = await getApproval(id)
  if (!first) throw new ApprovalError(404, 'not_found', 'No such approval.')
  if (!tokenMatches(first, token)) throw new ApprovalError(403, 'bad_token', 'Only the process that asked reads this approval\'s answer.')
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

export async function consumeApproval(id: string, input: ConsumeInput, lookupKey: KeyLookup): Promise<WaitResult> {
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
    if (!rec.singleUse || rec.mode !== 'biometric' || rec.downgraded || rec.digest !== digest
      || input.digest !== digest || !singleUseDetailMatches(rec.detail, owner, rec)
      || JSON.parse(rec.detail!).context !== input.detail) {
      throw new ApprovalError(409, 'changed', 'The signed approval does not match this operation.')
    }
    const created = Date.parse(rec.createdAt), expires = Date.parse(rec.expiresAt), now = Date.now()
    if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now || expires <= now
      || expires <= created || expires - created > 300_000) {
      throw new ApprovalError(409, 'approval_expired', 'The approval expired; ask again.')
    }
    if (rec.consumedAt) throw new ApprovalError(409, 'approval_used', 'This approval was already used; ask again.')
    if (rec.status !== 'approved' || rec.answer?.decision !== 'approve' || rec.answer.mode !== 'biometric'
      || !rec.answer.keyId || !rec.answer.signature || !allowedSigners(rec).includes(rec.answer.keyId)) {
      throw new ApprovalError(403, 'not_approved', 'There is no signed approval for this operation.')
    }
    const key = await lookupKey(rec.answer.keyId)
    if (!key || !verifySignature(key.publicKey, answerMessage(digest, 'approve'), rec.answer.signature)) {
      throw new ApprovalError(403, 'bad_signature', 'The approval signature is invalid or its signing device was removed.')
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

/** Cancel without the asker's token: for Walnut's own approvals (a key enrollment that ended). */
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
