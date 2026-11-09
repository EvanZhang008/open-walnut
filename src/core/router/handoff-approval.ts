// The person's yes covers one frozen handoff, used once; this module owns the receipt of that use.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, updateJsonFile, writeJsonFile } from '../../utils/fs.js'
import { withFileLock } from '../../utils/file-lock.js'
import { approvalDigest } from '../approvals/digest.js'
import { APPROVAL_DETAIL_MAX, type ApprovalMode, type ApprovalRecord, type ApprovalStatus, type ApprovalView } from '../approvals/types.js'
import type { CreateInput, WaitResult } from '../approvals/store.js'
import type { RouterItemContent } from './source-registry.js'
import { ROUTER_RULE_ID_PATTERN } from './areas.js'
import { ROUTER_AREA_ID_PATTERN, routerKey } from './store.js'
import { ROUTER_SOURCE_KINDS, type RouterSource } from './types.js'

export interface HandoffSnapshot {
  areaId: string
  source: RouterSource
  canonicalKey: string
  targetTaskId: string
  targetScope: string
  byTaskId: string
  brief: string
  reason: string
  /** The confirmed rule the router named at the ask; absent in asks made before rules rode along. */
  ruleId?: string
  content: RouterItemContent
}

export type HandoffIdentity = Omit<HandoffSnapshot, 'content'> & {
  display?: HandoffDisplay
}

export type HandoffStatus = 'pending' | 'approved' | 'denied' | 'claimed'

export interface HandoffTicket { approvalId: string; digest: string; status: HandoffStatus }

interface Entry {
  approvalId: string
  digest: string
  approvalDigest: string
  waitToken: string
  mode: ApprovalMode
  testRun?: string
  state: 'pending' | 'claimed'
  createdAt: string
  expiresAt: string
  claimedAt?: string
  proof?: HandoffProof
  // Small and parsed whole on every read: the brief, reason and content live in the snapshot file.
  identity: HandoffKey
  display: HandoffDisplay
}

type HandoffCore = Omit<HandoffSnapshot, 'content'>
type HandoffKey = Omit<HandoffCore, 'brief' | 'reason'> & { briefHash: string; reasonHash: string }
interface SnapshotFile { version: 1; digest: string; snapshot: HandoffSnapshot }

interface HandoffProof {
  approvalId: string; approvalDigest: string; consumedAt: string; decision: 'approve'; answeredAt: string
  answerMode: ApprovalMode; mode: ApprovalMode; guard: 'person'; requesterTaskId: string
}

interface HandoffFile { version: 1; entries: Entry[] }

export class HandoffApprovalError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}

export interface HandoffDeps {
  home?: string
  now?: () => number
  createApproval?: (input: CreateInput) => Promise<{ approval: ApprovalView; waitToken: string }>
  getApproval?: (id: string) => Promise<ApprovalRecord | undefined>
  waitApproval?: (id: string, token: string, waitMs: number) => Promise<WaitResult>
  cancelApproval?: (id: string, reason: string) => Promise<unknown>
  activeKeyCount?: () => Promise<number>
  livePendingIds?: (testRun: string | undefined) => Promise<Set<string>>
}

export const HANDOFF_ASK_MS = 4 * 60 * 60_000
export const HANDOFF_CLAIM_GRACE_MS = 60 * 60_000
export const HANDOFF_SNAPSHOT_MAX_BYTES = 1_000_000
export const HANDOFF_PENDING_MAX = 10
export const HANDOFF_BRIEF_MAX = 20_000
export const HANDOFF_REASON_MAX = 500
const EMPTY: HandoffFile = { version: 1, entries: [] }

export function handoffApprovalsPath(home = WALNUT_HOME): string {
  return path.join(home, 'router', 'handoff-approvals.json')
}

/** Content-addressed by the snapshot digest, so the same frozen handoff is one file whoever asks again. */
export function handoffSnapshotPath(digest: string, home = WALNUT_HOME): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new HandoffApprovalError('bad_digest', 400, 'Not a handoff digest.')
  return path.join(home, 'router', 'handoffs', `${digest}.json`)
}

async function resolved(deps: HandoffDeps): Promise<Required<Omit<HandoffDeps, 'home'>> & { file: string; home: string }> {
  const lazy = async () => import('../approvals/store.js')
  return {
    file: handoffApprovalsPath(deps.home), home: deps.home ?? WALNUT_HOME,
    now: deps.now ?? Date.now,
    createApproval: deps.createApproval ?? (async (i) => (await lazy()).createApproval(i)),
    getApproval: deps.getApproval ?? (async (id) => (await lazy()).getApproval(id)),
    waitApproval: deps.waitApproval ?? (async (id, t, ms) => (await lazy()).waitApproval(id, t, ms)),
    cancelApproval: deps.cancelApproval ?? (async (id, r) => (await lazy()).cancelInternal(id, r)),
    activeKeyCount: deps.activeKeyCount ?? (async () => (await (await import('../approvals/keys.js')).activeKeys()).length),
    livePendingIds: deps.livePendingIds ?? (async (testRun) => new Set((await (await lazy()).listApprovals({ status: 'pending', viewer: testRun, limit: 1000 })).map((a) => a.id))),
  }
}

// Key-sorted, so the digest names the content and not the order an adapter built it in.
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}
const sha = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
export const handoffDigest = (snapshot: HandoffSnapshot): string => sha(stable(snapshot))

function identityOf(s: HandoffCore | HandoffIdentity): HandoffCore {
  return { areaId: s.areaId, source: { ...s.source },
    canonicalKey: s.canonicalKey, targetTaskId: s.targetTaskId, targetScope: s.targetScope, byTaskId: s.byTaskId,
    brief: s.brief, reason: s.reason, ...(s.ruleId !== undefined ? { ruleId: s.ruleId } : {}) }
}
function keyOf(s: HandoffCore | HandoffIdentity): HandoffKey {
  const { brief, reason, ...rest } = identityOf(s)
  return { ...rest, briefHash: sha(brief), reasonHash: sha(reason) }
}
const sameSource = (a: RouterSource, b: RouterSource) => a.kind === b.kind && a.account === b.account && a.message === b.message
  && (a.version ?? '') === (b.version ?? '')

function validate(s: HandoffSnapshot): HandoffSnapshot {
  const bad = (m: string): never => { throw new HandoffApprovalError('bad_snapshot', 400, m) }
  const text = (v: unknown, name: string) => { if (typeof v !== 'string' || !v.trim()) bad(`The handoff needs ${name}.`) }
  if (!s || typeof s !== 'object') bad('The handoff snapshot is missing.')
  for (const k of ['areaId', 'canonicalKey', 'targetTaskId', 'byTaskId', 'brief', 'reason'] as const) text(s[k], k)
  if (s.targetScope !== 'unscoped' && !(typeof s.targetScope === 'string' && ROUTER_AREA_ID_PATTERN.test(s.targetScope))) bad('targetScope is the target\'s area id or unscoped.')
  if (!s.source || !(ROUTER_SOURCE_KINDS as readonly string[]).includes(s.source.kind)) bad('The handoff names an unknown source kind.')
  text(s.source.account, 'source.account'); text(s.source.message, 'source.message')
  if (s.source.version !== undefined && (typeof s.source.version !== 'string' || !s.source.version || s.source.version.length > 200)) bad('The handoff needs a valid delivery version.')
  if (s.brief.length > HANDOFF_BRIEF_MAX) bad(`The brief is at most ${HANDOFF_BRIEF_MAX} characters.`)
  if (s.reason.length > HANDOFF_REASON_MAX) bad(`The reason is at most ${HANDOFF_REASON_MAX} characters.`)
  if (s.ruleId !== undefined && !(typeof s.ruleId === 'string' && ROUTER_RULE_ID_PATTERN.test(s.ruleId))) bad('The handoff names an invalid rule id.')
  if (!s.content?.item?.source || !sameSource(s.content.item.source, s.source) || s.content.item.key !== s.canonicalKey) {
    bad('The frozen content belongs to another item.')
  }
  const frozen = JSON.parse(JSON.stringify(s)) as HandoffSnapshot
  if (Buffer.byteLength(stable(frozen), 'utf8') > HANDOFF_SNAPSHOT_MAX_BYTES) {
    throw new HandoffApprovalError('snapshot_too_large', 413, `A handoff is at most ${HANDOFF_SNAPSHOT_MAX_BYTES} bytes.`)
  }
  return frozen
}

function excerpt(label: string, text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max))}\n[Excerpt of the ${label}: the first ${Math.max(0, max)} of ${text.length} characters. `
    + `The full ${label} is saved with this request, sha256 ${sha(text)}.]`
}

export interface HandoffDisplay { targetTitle?: string; routerTitle?: string; areaName?: string }

const namesOf = (d: HandoffDisplay): HandoffDisplay => ({
  targetTitle: d.targetTitle?.trim() || undefined, routerTitle: d.routerTitle?.trim() || undefined, areaName: d.areaName?.trim() || undefined,
})

export function handoffDetail(s: HandoffSnapshot, display: HandoffDisplay = {}): { what: string; detail: string } {
  const cut = (v: string | undefined, n: number) => (v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const target = cut(display.targetTitle, 80) || s.targetTaskId
  const router = cut(display.routerTitle, 80) || 'Router'
  const item = s.content.item
  const scope = s.targetScope === 'unscoped' ? 'an older task in no area, whose conversation is not isolated'
    : s.targetScope === s.areaId ? 'an existing conversation of this area that sits outside its isolated context'
      : `a task in another area (${s.targetScope})`
  const body = s.content.body?.text ?? s.content.body?.html ?? ''
  const head = [
    `"${router}" asks to hand ONE incoming item to ${scope}. Approve to deliver exactly this item with this brief, once. Deny and nothing is delivered.`,
    '',
    `Target: "${target}" (task ${s.targetTaskId}), target area: ${s.targetScope}`,
    `Item's area: ${cut(display.areaName, 120) || s.areaId} (${s.areaId})`,
    `Source: ${s.source.kind}, account ${cut(s.source.account, 200)}, message ${cut(s.source.message, 200)}`,
    `Item key: ${cut(s.canonicalKey, 300)}`,
    `From: ${cut(item.sender, 300)}`, `Subject: ${cut(item.subject, 300)}`,
    `Attachments: ${s.content.attachments.length ? s.content.attachments.map((a) => cut(a.filename, 80) || 'unnamed').join(', ').slice(0, 600) + ' (not handed over)' : 'none'}`,
    `Reason: ${cut(s.reason, 1000)}`,
    ...(s.ruleId ? [`Routing rule: ${cut(s.ruleId, 60)}`] : []),
    '', 'Brief for the receiving task:',
  ].join('\n')
  const bodyHead = `\n\nCached item body${s.content.body?.text ? '' : s.content.body?.html ? ' (HTML source)' : ''}, as received (untrusted):\n`
  let room = APPROVAL_DETAIL_MAX - head.length - bodyHead.length - 600
  // The brief keeps at least half the room when the body is long too; the note of a cut needs ~300.
  const brief = excerpt('brief', s.brief, Math.max(1000, room - Math.min(body.length, Math.floor(room / 2)) - 300))
  room -= brief.length + 300
  const shown = !s.content.bodyAvailable || !body ? '(No cached body.)' : excerpt('body', body, room)
  return { what: `Let "${router}" hand one ${s.source.kind} item to "${target}"?`, detail: `${head}\n${brief}${bodyHead}${shown}`.slice(0, APPROVAL_DETAIL_MAX) }
}

const indexed = (file: HandoffFile): Entry[] => file.entries.filter((e) => !!e?.identity?.source)

async function readSnapshot(home: string, entry: Entry, expected?: HandoffIdentity): Promise<HandoffSnapshot | undefined> {
  const saved = await readJsonFile<SnapshotFile | null>(handoffSnapshotPath(entry.digest, home), null, { readErrors: 'throw' }).catch(() => null)
  if (!saved?.snapshot || saved.digest !== entry.digest || handoffDigest(saved.snapshot) !== entry.digest
    || stable(keyOf(saved.snapshot)) !== stable(entry.identity)) return undefined
  if (expected && stable(identityOf(saved.snapshot)) !== stable(identityOf(expected))) return undefined
  return saved.snapshot
}

// Only asks long past their deadline leave the index, never a claimed one; returns their digests for the sweep.
function prune(file: HandoffFile, now: number): string[] {
  file.entries = indexed(file)
  const gone = file.entries.filter((e) => e.state !== 'claimed' && now >= Date.parse(e.expiresAt) + HANDOFF_CLAIM_GRACE_MS + 24 * 60 * 60_000)
  file.entries = file.entries.filter((e) => !gone.includes(e))
  return gone.map((e) => e.digest)
}

// After the index is saved, and under its lock: a snapshot goes only when the index on disk names it nowhere.
async function sweepSnapshots(d: { file: string; home: string }, digests: Set<string>): Promise<void> {
  if (!digests.size) return
  await withFileLock(d.file, async () => {
    // An index that cannot be read names everything: nothing is removed.
    const named = new Set((await readJsonFile<HandoffFile>(d.file, EMPTY, { readErrors: 'throw' })).entries.map((e) => e?.digest))
    for (const digest of digests) if (!named.has(digest)) await fs.rm(handoffSnapshotPath(digest, d.home), { force: true })
  }).catch(() => undefined)
}

export async function requestHandoffApproval(
  snapshot: HandoffSnapshot,
  opts: HandoffDisplay & { host?: string; testRun?: string; timeoutMs?: number } = {},
  deps: HandoffDeps = {},
): Promise<HandoffTicket> {
  const d = await resolved(deps)
  const frozen = validate(snapshot)
  const digest = handoffDigest(frozen)
  const shown = namesOf(opts)
  // Read once, outside the lock: which asks still wait, and whether a device signs.
  const live = await d.livePendingIds(opts.testRun)
  const keys = await d.activeKeyCount()
  let ticket: HandoffTicket | undefined
  let created: string | undefined
  const sweep = new Set<string>()
  try {
    await updateJsonFile<HandoffFile>(d.file, EMPTY, async (file) => {
      const now = d.now()
      for (const gone of prune(file, now)) sweep.add(gone)
      const open = file.entries.find((e) => e.state === 'pending' && e.digest === digest && stable(e.display ?? {}) === stable(shown)
        && e.identity.byTaskId === frozen.byTaskId && (e.testRun ?? null) === (opts.testRun ?? null))
      if (open) {
        const rec = await d.getApproval(open.approvalId)
        const status = rec?.status
        if (status === 'pending' || status === 'denied' || (status === 'approved' && !rec?.consumedAt)) {
          ticket = { approvalId: open.approvalId, digest, status }
          return file
        }
        file.entries = file.entries.filter((e) => e !== open)
      }
      const mine = file.entries.filter((e) => e.state === 'pending' && e.identity.byTaskId === frozen.byTaskId && live.has(e.approvalId)).length
      if (mine >= HANDOFF_PENDING_MAX) {
        throw new HandoffApprovalError('too_many_pending', 429, `${mine} handoffs from this router already wait for the person.`)
      }
      const { what, detail } = handoffDetail(frozen, shown)
      // Never downgraded: Face ID or Touch ID where a device signs, else a tap the `person` guard checks.
      const mode: ApprovalMode = keys > 0 ? 'biometric' : 'tap'
      // The content is on disk before any approval can name it.
      await writeJsonFile(handoffSnapshotPath(digest, d.home), { version: 1, digest, snapshot: frozen } satisfies SnapshotFile, { mode: 0o600, durable: true })
      const made = await d.createApproval({
        what, detail, mode, guard: 'person', timeoutMs: opts.timeoutMs ?? HANDOFF_ASK_MS,
        requester: { host: opts.host || 'unknown', taskId: frozen.byTaskId, ...(opts.routerTitle ? { taskTitle: opts.routerTitle.slice(0, 120) } : {}) },
        ...(opts.testRun ? { testRun: opts.testRun } : {}),
      })
      created = made.approval.id
      file.entries.push({
        approvalId: made.approval.id, digest, approvalDigest: made.approval.digest, waitToken: made.waitToken, mode,
        ...(opts.testRun ? { testRun: opts.testRun } : {}), state: 'pending',
        createdAt: new Date(now).toISOString(), expiresAt: made.approval.expiresAt, identity: keyOf(frozen), display: shown,
      })
      ticket = { approvalId: made.approval.id, digest, status: 'pending' }
      return file
    }, { mode: 0o600, durable: true })
  } catch (error) {
    // An approval whose payload was never saved must not stay approvable.
    if (created) await d.cancelApproval(created, 'The handoff could not be saved.').catch(() => undefined)
    sweep.add(digest)
    await sweepSnapshots(d, sweep)
    throw error
  }
  await sweepSnapshots(d, sweep)
  return ticket!
}

async function entryFor(d: { file: string; home: string }, approvalId: string, expected: HandoffIdentity): Promise<{ entry: Entry; snapshot: HandoffSnapshot }> {
  const entry = indexed(await readJsonFile<HandoffFile>(d.file, EMPTY)).find((e) => e.approvalId === approvalId)
  if (!entry) throw new HandoffApprovalError('not_found', 404, 'No handoff approval with this id: ask again.')
  if (entry.identity.byTaskId !== expected?.byTaskId) throw new HandoffApprovalError('not_owner', 403, 'Only the router that asked uses this approval.')
  if (stable(entry.identity) !== stable(keyOf(expected))) {
    throw new HandoffApprovalError('handoff_changed', 409, 'This handoff differs from the one the person was asked about: ask again.')
  }
  if (expected.display && stable(namesOf(expected.display)) !== stable(entry.display ?? {})) {
    throw new HandoffApprovalError('handoff_changed', 409, 'The target or router changed name since the person was asked: ask again.')
  }
  const snapshot = await readSnapshot(d.home, entry, expected)
  if (!snapshot) throw new HandoffApprovalError('payload_changed', 409, 'The saved handoff changed or is gone: ask again.')
  return { entry, snapshot }
}

export async function peekHandoff(approvalId: string, expected: HandoffIdentity, deps: HandoffDeps = {}):
  Promise<{ snapshot: HandoffSnapshot; display: HandoffDisplay; digest: string; state: Entry['state']; approvalStatus: ApprovalStatus | 'missing' }> {
  const d = await resolved(deps)
  const { entry, snapshot } = await entryFor(d, approvalId, expected)
  const rec = await d.getApproval(approvalId)
  return { snapshot, display: { ...entry.display }, digest: entry.digest, state: entry.state, approvalStatus: rec?.status ?? 'missing' }
}

function no(code: string, status: number, m: string): never { throw new HandoffApprovalError(code, status, m) }

function assertBound(rec: ApprovalView | undefined, entry: Entry): asserts rec is ApprovalView {
  if (!rec) return no('approval_missing', 409, 'The approval is gone: ask again.')
  const recomputed = approvalDigest({ id: rec.id, mode: rec.mode, createdAt: rec.createdAt, expiresAt: rec.expiresAt,
    host: rec.requester.host, taskId: rec.requester.taskId, what: rec.what, detail: rec.detail })
  if (rec.digest !== entry.approvalDigest || recomputed !== rec.digest) no('approval_changed', 409, 'The approval does not match the handoff asked: ask again.')
  if (rec.requester.taskId !== entry.identity.byTaskId || rec.requester.sessionId || (rec.testRun ?? null) !== (entry.testRun ?? null)) {
    no('approval_mismatch', 403, 'The approval belongs to another asker.')
  }
  if (rec.guard !== 'person' || rec.mode !== entry.mode || rec.downgraded) no('not_person', 403, 'The approval is not a person-guarded one.')
}

function checkApproval(rec: ApprovalRecord | undefined, entry: Entry, now: number): 'pending' | 'approved' {
  assertBound(rec, entry)
  if (rec.status === 'pending') {
    if (Date.parse(rec.expiresAt) <= now) no('expired', 409, 'Nobody answered in time: nothing was delivered.')
    return 'pending'
  }
  if (rec.status === 'denied') no('denied', 403, 'The person said no: nothing was delivered.')
  if (rec.status === 'expired') no('expired', 409, 'Nobody answered in time: nothing was delivered.')
  if (rec.status === 'canceled') no('canceled', 409, 'The ask was withdrawn: nothing was delivered.')
  const at = Date.parse(rec.answer?.at ?? '')
  if (rec.status !== 'approved' || rec.answer?.decision !== 'approve' || !(at <= Date.parse(rec.expiresAt))) {
    no('not_approved', 403, 'The approval is not a yes.')
  }
  if (now > at + HANDOFF_CLAIM_GRACE_MS) no('expired', 409, 'The yes is too old to use: ask again.')
  if (rec.consumedAt) no('approval_used', 409, 'This approval was already used: nothing is sent again.')
  return 'approved'
}

export async function claimHandoffApproval(approvalId: string, expected: HandoffIdentity, deps: HandoffDeps = {}):
  Promise<{ status: 'pending'; approvalId: string; digest: string } | { status: 'claimed'; approvalId: string; digest: string; snapshot: HandoffSnapshot }> {
  const d = await resolved(deps)
  const { entry, snapshot } = await entryFor(d, approvalId, expected)
  if (entry.state === 'claimed') throw new HandoffApprovalError('already_claimed', 409, 'This handoff was already used: it is not sent again.')
  const approved = await d.getApproval(approvalId)
  if (checkApproval(approved, entry, d.now()) === 'pending') return { status: 'pending', approvalId, digest: entry.digest }
  let won = false
  await updateJsonFile<HandoffFile>(d.file, EMPTY, async (file) => {
    const live = file.entries.find((e) => e.approvalId === approvalId)
    if (live && live.state === 'pending' && live.digest === entry.digest && live.waitToken === entry.waitToken
      && live.approvalDigest === entry.approvalDigest && await readSnapshot(d.home, live, expected)) {
      live.state = 'claimed'
      live.claimedAt = new Date(d.now()).toISOString()
      won = true
    }
    return file
  }, { mode: 0o600, durable: true })
  if (!won) throw new HandoffApprovalError('already_claimed', 409, 'This handoff was already used: it is not sent again.')
  // Claimed before consumed: a failure from here on leaves it claimed and undelivered, never reusable.
  const unused = (): never => no('approval_used', 409, 'The approval could not be used once: nothing was delivered; ask again.')
  const read = await d.waitApproval(approvalId, entry.waitToken, 0).catch(() => undefined)
  const a = read?.approval
  if (!read?.used || !a || !a.answer || !a.consumedAt || !approved?.answer) return unused()
  try { assertBound(a, entry) } catch { return unused() }
  // The used record must be the one checked before the claim, not a yes swapped in meanwhile.
  const at = Date.parse(a.answer.at)
  const signedOk = a.answer.mode === 'biometric' ? !!a.answer.keyId && !!a.answer.signature : a.answer.mode === 'tap'
  if (a.status !== 'approved' || a.answer.decision !== 'approve' || !(at <= Date.parse(a.expiresAt)) || !signedOk
    || a.answer.at !== approved.answer.at || a.answer.mode !== approved.answer.mode || a.expiresAt !== approved.expiresAt) return unused()
  const proof: HandoffProof = { approvalId, approvalDigest: a.digest, consumedAt: a.consumedAt, decision: 'approve', answeredAt: a.answer.at,
    answerMode: a.answer.mode, mode: a.mode, guard: 'person', requesterTaskId: entry.identity.byTaskId }
  let proven = false
  await updateJsonFile<HandoffFile>(d.file, EMPTY, async (file) => {
    const live = file.entries.find((e) => e.approvalId === approvalId)
    if (live && live.state === 'claimed' && !live.proof && live.digest === entry.digest && live.approvalDigest === entry.approvalDigest
      && live.waitToken === entry.waitToken && await readSnapshot(d.home, live, expected)) {
      live.proof = proof
      proven = true
    }
    return file
  }, { mode: 0o600, durable: true })
  if (!proven) throw new HandoffApprovalError('proof_not_saved', 409, 'The saved handoff changed while its yes was used: nothing was delivered.')
  return { status: 'claimed', approvalId, digest: entry.digest, snapshot }
}

function proofHolds(e: Entry): boolean {
  const p = e.proof
  return !!p && p.approvalId === e.approvalId && p.approvalDigest === e.approvalDigest && p.decision === 'approve' && p.guard === 'person'
    && p.mode === e.mode && p.requesterTaskId === e.identity.byTaskId && typeof p.consumedAt === 'string' && !!p.consumedAt
    && typeof p.answeredAt === 'string' && !!p.answeredAt && (p.answerMode === 'tap' || p.answerMode === 'biometric')
}

export async function ownedClaimedHandoff(source: RouterSource, targetTaskId: string, deps: HandoffDeps = {}): Promise<HandoffSnapshot | undefined> {
  const d = await resolved(deps)
  const hits = indexed(await readJsonFile<HandoffFile>(d.file, EMPTY))
    .filter((e) => e.state === 'claimed' && proofHolds(e) && sameSource(e.identity.source, source) && e.identity.targetTaskId === targetTaskId)
    .sort((a, b) => (b.claimedAt ?? '').localeCompare(a.claimedAt ?? ''))
  for (const e of hits) {
    const rec = await d.getApproval(e.approvalId)
    // A record still kept must agree with the receipt; once the approvals store drops it, the receipt stands.
    if (rec) {
      try { assertBound(rec, e) } catch { continue }
      const p = e.proof!
      if (rec.status !== 'approved' || rec.answer?.decision !== 'approve' || rec.answer.at !== p.answeredAt
        || rec.answer.mode !== p.answerMode || rec.consumedAt !== p.consumedAt) continue
    }
    const snap = await readSnapshot(d.home, e)
    if (snap) return snap
  }
  return undefined
}

export interface HandoffSummary {
  approvalId: string; canonicalKey: string; targetTaskId: string; targetScope: string; brief: string; reason: string; ruleId?: string
  status: ApprovalStatus | 'missing' | 'claimed' | 'claim_incomplete' | 'payload_missing'
}

// Lets the router's next turn reuse its ask instead of making another; reads only this item's snapshots, never the body out.
export async function routerHandoffsForItem(source: RouterSource, byTaskId: string, deps: HandoffDeps = {}): Promise<HandoffSummary[]> {
  const d = await resolved(deps)
  const out: HandoffSummary[] = []
  for (const e of indexed(await readJsonFile<HandoffFile>(d.file, EMPTY))) {
    if (!sameSource(e.identity.source, source) || e.identity.byTaskId !== byTaskId) continue
    const status = e.state === 'claimed' ? (proofHolds(e) ? 'claimed' as const : 'claim_incomplete' as const)
      : (await d.getApproval(e.approvalId))?.status ?? 'missing' as const
    const snap = await readSnapshot(d.home, e)
    const { canonicalKey, targetTaskId, targetScope, ruleId } = e.identity
    out.push({ approvalId: e.approvalId, canonicalKey, targetTaskId, targetScope, brief: snap?.brief ?? '', reason: snap?.reason ?? '',
      ...(ruleId !== undefined ? { ruleId } : {}), status: snap ? status : 'payload_missing' })
  }
  return out
}

// Sources (by routerKey) this router holds an ask for with no usable yes: quiet; index and approvals only, read errors throw.
export async function handoffWaitingSources(sources: readonly RouterSource[], byTaskId: string, deps: HandoffDeps = {}): Promise<Set<string>> {
  const d = await resolved(deps)
  const wanted = new Map(sources.map((source) => [routerKey(source), source]))
  const asks = new Map<string, Entry[]>()
  for (const e of indexed(await readJsonFile<HandoffFile>(d.file, EMPTY, { readErrors: 'throw' }))) {
    const key = e.identity.byTaskId === byTaskId ? routerKey(e.identity.source) : undefined
    const source = key === undefined ? undefined : wanted.get(key)
    if (key === undefined || !source || !sameSource(source, e.identity.source)) continue
    asks.set(key, [...(asks.get(key) ?? []), e])
  }
  const held = new Set<string>()
  for (const [key, entries] of asks) {
    let usable = false
    for (const e of entries) {
      if (e.state !== 'pending') continue
      try {
        usable = checkApproval(await d.getApproval(e.approvalId), e, d.now()) === 'approved'
      } catch (error) {
        if (!(error instanceof HandoffApprovalError)) throw error
      }
      if (usable) break
    }
    if (!usable) held.add(key)
  }
  return held
}

export type HandoffAskStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled' | 'missing' | 'claim_incomplete'
export interface HandoffAskView { approvalId: string; at: number; status: HandoffAskStatus; targetTitle?: string }

const ASK_STATUS_OF: Record<string, HandoffAskStatus> = { denied: 'denied', expired: 'expired', canceled: 'canceled', approval_used: 'claim_incomplete' }

async function askStatus(d: { getApproval: (id: string) => Promise<ApprovalRecord | undefined>; now: () => number }, e: Entry): Promise<HandoffAskStatus> {
  if (e.state === 'claimed') return 'claim_incomplete'
  try {
    return checkApproval(await d.getApproval(e.approvalId), e, d.now())
  } catch (error) {
    if (!(error instanceof HandoffApprovalError)) throw error
    return ASK_STATUS_OF[error.code] ?? 'missing'
  }
}

// The latest ask per exact source (by routerKey) of any of this area's routers, paused ones too; index and approval records only.
export async function handoffAsksForSources(areaId: string, routerTaskIds: readonly string[], sources: readonly RouterSource[], deps: HandoffDeps = {}): Promise<Map<string, HandoffAskView>> {
  const d = await resolved(deps)
  const wanted = new Map(sources.map((source) => [routerKey(source), source]))
  const latest = new Map<string, Entry>()
  for (const e of indexed(await readJsonFile<HandoffFile>(d.file, EMPTY, { readErrors: 'throw' }))) {
    if (e.identity.areaId !== areaId || !routerTaskIds.includes(e.identity.byTaskId)) continue
    const key = routerKey(e.identity.source)
    const source = wanted.get(key)
    if (!source || !sameSource(source, e.identity.source)) continue
    const prev = latest.get(key)
    if (!prev || e.createdAt > prev.createdAt) latest.set(key, e)
  }
  const out = new Map<string, HandoffAskView>()
  for (const [key, e] of latest) {
    out.set(key, { approvalId: e.approvalId, at: Date.parse(e.createdAt), status: await askStatus(d, e),
      ...(e.display?.targetTitle ? { targetTitle: e.display.targetTitle } : {}) })
  }
  return out
}
