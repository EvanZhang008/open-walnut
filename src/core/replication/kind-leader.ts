/**
 * The leader's side of a generic replication kind, run for ONE target with
 * that target's own state (docs/plan/walnut-replica-servers-impl.md,
 * section 4; replica-status.ts keeps the state, kind.ts the protocol).
 *
 * A round for one kind on one target: build the manifest (once per round,
 * shared by every target: buildKindManifest), skip it when the target took the
 * same one, else `sync` and `put` what the target asks for in 512 KB batches.
 * The caller (task-replica.ts for tasks and registry) serves its targets one
 * after another, never in parallel.
 */

import type { CloudReplicaReply } from '../cloud-ingest.js'
import type { ReplicaTarget } from './replica-targets.js'
import {
  CONFIRM_AFTER_REFUSALS, CONFIRM_TTL_MS, HASH_SLICE, PUT_BATCH_BYTES, PUT_TIMEOUT_MS, REFUSAL_ERROR, REST_ERRORS,
  UNSUPPORTED_REST_MS, manifestHashOf, manifestKeysHashOf, type ConfirmFor, type ManifestEntry,
} from './kind.js'
import { kindState, type KindState } from './replica-status.js'

export interface LeaderKind<Row> {
  kind: string
  schemaVersion: number
  key(row: Row): string
  /** sha256-12 of what is sent (the projection); the kind may cache it per row object. */
  hash(row: Row): string
  /** What a put carries for these rows (default `{rows}`, plus `last` on the round's last batch). */
  encodePut?(rows: readonly Row[], last: boolean): Record<string, unknown>
  /** One document (the registry): a put only when the target names its key, never batched. */
  single?: boolean
  /**
   * The row as a put carries it, read only when a put needs it (WP4 inbox
   * bodies: a manifest row holds the hash, not the text). Undefined: the row
   * went away since the manifest, skip it (the next round asks again).
   */
  loadRow?(row: Row): Promise<Row | undefined>
}

/** The row a put sends for `k` (kind.loadRow when the kind has one). */
export async function putRow<Row>(kind: LeaderKind<Row>, manifest: KindManifest<Row>, k: string): Promise<Row | undefined> {
  const row = manifest.byKey.get(k)
  if (row === undefined || !kind.loadRow) return row
  return kind.loadRow(row)
}

export interface KindManifest<Row> {
  entries: ManifestEntry[]
  hash: string
  byKey: Map<string, Row>
  /** The key set's hash (manifestKeysHashOf), worked out only when a refusal or a confirm needs it. */
  keys?: string
}

function keysOf(manifest: KindManifest<unknown>): string {
  manifest.keys ??= manifestKeysHashOf(manifest.entries)
  return manifest.keys
}

/** The kind's manifest over `rows` (store order), hashing in slices so the event loop runs. */
export async function buildKindManifest<Row>(kind: LeaderKind<Row>, rows: readonly Row[], pause: () => Promise<void> = immediate): Promise<KindManifest<Row>> {
  const entries: ManifestEntry[] = []
  const byKey = new Map<string, Row>()
  for (let i = 0; i < rows.length; i++) {
    const k = kind.key(rows[i])
    entries.push({ k, h: kind.hash(rows[i]) })
    byKey.set(k, rows[i])
    if (i % HASH_SLICE === HASH_SLICE - 1) await pause()
  }
  return { entries, hash: manifestHashOf(entries), byKey }
}

function immediate(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

export interface KindRoundResult {
  kind: string
  action: 'synced' | 'unchanged' | 'unsupported' | 'failed'
  entries?: number
  sent?: number
  held?: number
  removed?: number
  error?: string
}

export class StepFailed extends Error {
  /** `body`: the follower's answer, when it sent one (a refusal names `local` and `removing`). */
  constructor(readonly outcome: 'failed' | 'unsupported', message: string, readonly code?: string, readonly body?: Record<string, unknown>) { super(message) }
}

async function step(target: Pick<ReplicaTarget, 'post'>, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
  const r: CloudReplicaReply = await target.post(payload, timeoutMs ? { timeoutMs } : undefined)
  if (r.ok) {
    if (r.reply.ok !== true) {
      const error = typeof r.reply.error === 'string' ? r.reply.error : 'refused'
      throw new StepFailed('failed', error, error, r.reply)
    }
    return r.reply
  }
  throw new StepFailed(r.outcome, r.error ?? (r.status ? `HTTP ${r.status}` : r.outcome), r.error, r.body)
}

/** Whether a failed step means "this target does not take this kind yet": rest it, do not fail. */
function restsKind(err: StepFailed): boolean {
  return err.outcome === 'unsupported' || (err.code !== undefined && REST_ERRORS.has(err.code))
}

export interface KindRoundOptions {
  /** The leader's clock for this manifest. */
  asOf?: number
  now?: () => number
  log?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }
}

/**
 * One kind on one target. Throws StepFailed on a step that failed (the
 * caller decides whether the next kind waits); a rested kind answers
 * `unsupported` without a step.
 */
export async function runKindRound<Row>(
  kind: LeaderKind<Row>, manifest: KindManifest<Row>, target: Pick<ReplicaTarget, 'id' | 'kind' | 'label' | 'post'>, opts: KindRoundOptions = {},
): Promise<KindRoundResult> {
  const now = opts.now ?? Date.now
  const st = kindState(target, kind.kind)
  if (st.restUntil > now()) return { kind: kind.kind, action: 'unsupported', error: st.restWhy }
  const confirm = confirmForRound(st, manifest, now(), target.id, kind.kind, opts)
  if (st.manifest === manifest.hash && !confirm) {
    st.action = 'unchanged'
    return { kind: kind.kind, action: 'unchanged', ...(kind.single ? {} : { entries: manifest.entries.length }) }
  }
  const asOf = opts.asOf ?? now()
  let reply: Record<string, unknown>
  try {
    reply = await step(target, {
      op: 'sync', kind: kind.kind, schemaVersion: kind.schemaVersion, entries: manifest.entries, asOf, ...(confirm ? { confirm: true, confirmFor: confirm } : {}),
    })
  } catch (err) {
    // A confirm is used up only by an answer (an older follower refusing it anyway);
    // a step lost on the way keeps it for the next round (while it still matches).
    if (confirm && err instanceof StepFailed && err.code === REFUSAL_ERROR) dropConfirm(st)
    throw noteFailure(st, kind.kind, target.id, manifest, err, now(), opts)
  }
  if (confirm) {
    dropConfirm(st)
    opts.log?.warn('replica: a removal of most rows was confirmed and sent', { target: target.id, kind: kind.kind, entries: manifest.entries.length })
  }
  st.refusals = 0
  st.lastRefusal = undefined
  const need = Array.isArray(reply.need) ? (reply.need as unknown[]).filter((k): k is string => typeof k === 'string') : []
  let held = Number(reply.held) || 0
  let sent = 0
  try {
    sent = kind.single ? await putSingle(kind, manifest, need, target) : await putBatches(kind, manifest, need, target, (h) => { held += h })
  } catch (err) {
    throw noteFailure(st, kind.kind, target.id, manifest, err, now(), opts)
  }
  // A held row comes back once the follower's own write reaches the leader.
  st.manifest = held === 0 ? manifest.hash : null
  const removed = Number(reply.removed) || 0
  Object.assign(st, { action: 'synced', entries: manifest.entries.length, held, sent, removed, asOf, syncedAt: now(), error: undefined })
  return kind.single
    ? { kind: kind.kind, action: 'synced', sent }
    : { kind: kind.kind, action: 'synced', entries: manifest.entries.length, sent, held, removed }
}

function dropConfirm(st: KindState): void {
  st.confirmNext = false
  st.confirmFor = undefined
}

/**
 * The confirm this round may carry: the user's, while the leader's manifest is
 * still the one they confirmed (the same row count and key set) and the
 * confirm is not past its time. Otherwise it is dropped and the half rule
 * refuses again: a store that changed after the click (it opened empty at a
 * boot, a restore) never rides on an old confirm.
 */
function confirmForRound(
  st: KindState, manifest: KindManifest<unknown>, at: number, targetId: string, kind: string, opts: KindRoundOptions,
): ConfirmFor | null {
  if (!st.confirmNext) return null
  const c = st.confirmFor
  const why = !c ? 'unbound' : c.expiresAt <= at ? 'expired' : c.entries !== manifest.entries.length || c.keys !== keysOf(manifest) ? 'changed' : null
  if (!why && c) return { entries: c.entries, keys: c.keys }
  dropConfirm(st)
  opts.log?.warn('replica: a confirmed removal was dropped: the leader no longer has the rows the user confirmed', {
    target: targetId, kind, why, confirmed: c?.entries, entries: manifest.entries.length,
  })
  return null
}

async function putSingle<Row>(kind: LeaderKind<Row>, manifest: KindManifest<Row>, need: string[], target: Pick<ReplicaTarget, 'post'>): Promise<number> {
  let sent = 0
  for (const k of need) {
    const row = await putRow(kind, manifest, k)
    if (row === undefined) continue
    await step(target, { op: 'put', kind: kind.kind, schemaVersion: kind.schemaVersion, ...encode(kind, [row], true) })
    sent++
  }
  return sent
}

async function putBatches<Row>(
  kind: LeaderKind<Row>, manifest: KindManifest<Row>, need: string[], target: Pick<ReplicaTarget, 'post'>, addHeld: (n: number) => void,
): Promise<number> {
  let sent = 0
  let batch: Row[] = []
  let bytes = 0
  const flush = async (last = false): Promise<void> => {
    if (batch.length === 0) return
    const r = await step(target, { op: 'put', kind: kind.kind, schemaVersion: kind.schemaVersion, ...encode(kind, batch, last) }, PUT_TIMEOUT_MS)
    const stored = Number(r.stored) || 0
    const held = Number(r.held) || 0
    sent += stored
    // An answer for fewer rows than were sent (a body cut short on the way) did
    // not take the rest: count them held, so the manifest goes again.
    addHeld(held + Math.max(0, batch.length - stored - held))
    batch = []
    bytes = 0
  }
  for (const k of need) {
    const row = await putRow(kind, manifest, k)
    if (row === undefined) continue
    const size = Buffer.byteLength(JSON.stringify(row))
    if (batch.length > 0 && bytes + size > PUT_BATCH_BYTES) await flush()
    batch.push(row)
    bytes += size
  }
  await flush(true)
  return sent
}

function encode<Row>(kind: LeaderKind<Row>, rows: readonly Row[], last: boolean): Record<string, unknown> {
  if (kind.encodePut) return kind.encodePut(rows, last)
  return { rows, ...(last ? { last: true } : {}) }
}

/** What the follower said it would remove (an older follower says nothing). */
function removalSize(body: Record<string, unknown> | undefined): { local?: number; removing?: number } {
  const n = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0
  return { ...(n(body?.local) ? { local: body!.local as number } : {}), ...(n(body?.removing) ? { removing: body!.removing as number } : {}) }
}

function noteFailure<Row>(st: KindState, kind: string, targetId: string, manifest: KindManifest<Row>, err: unknown, at: number, opts: KindRoundOptions): unknown {
  if (!(err instanceof StepFailed)) {
    st.manifest = null
    st.action = 'failed'
    st.error = err instanceof Error ? err.message : String(err)
    return err
  }
  st.manifest = null
  if (restsKind(err)) {
    st.restUntil = at + UNSUPPORTED_REST_MS
    st.restWhy = err.code ?? err.message
    st.action = 'unsupported'
    st.error = err.message
    opts.log?.info('replica: this follower does not take this kind yet, asking again in 10 minutes', { target: targetId, kind, why: st.restWhy })
    return new StepFailed('unsupported', err.message, err.code)
  }
  st.action = 'failed'
  st.error = err.message
  if (err.code === REFUSAL_ERROR) {
    const entries = manifest.entries.length
    const keys = keysOf(manifest)
    // A refusal counts toward the confirm only while the leader's manifest holds
    // still: the same count AND the same key set (another set of rows at the same
    // count is a new streak, never one the user already looked at).
    st.refusals = st.lastRefusal && st.lastRefusal.entries === entries && st.lastRefusal.keys === keys ? st.refusals + 1 : 1
    st.lastRefusal = { error: REFUSAL_ERROR, at, entries, keys, ...removalSize(err.body) }
    if (st.refusals === 1 || st.refusals === CONFIRM_AFTER_REFUSALS) {
      opts.log?.warn('replica: a follower refused a manifest that removes most of its rows', { target: targetId, kind, entries, refusals: st.refusals })
    }
  }
  return err
}

/**
 * The user confirmed a removal the half rule refused (the Settings row): the
 * next round on that target carries `confirm:true`, bound to the refused
 * manifest's row count and key set, for CONFIRM_TTL_MS. Only after 3 refused
 * rounds of the same manifest, and (when the caller names them) only for the
 * count and key set the user saw (the status they read); false otherwise.
 */
export function confirmKindRemoval(
  target: Pick<ReplicaTarget, 'id' | 'kind' | 'label'>, kind: string, opts: { entries?: number; keys?: string; now?: number } = {},
): boolean {
  const st = kindState(target, kind)
  const r = st.lastRefusal
  if (st.refusals < CONFIRM_AFTER_REFUSALS || !r?.keys) return false
  if (opts.entries !== undefined && opts.entries !== r.entries) return false
  if (opts.keys !== undefined && opts.keys !== r.keys) return false
  const at = opts.now ?? Date.now()
  st.confirmNext = true
  st.confirmFor = { entries: r.entries, keys: r.keys, at, expiresAt: at + CONFIRM_TTL_MS }
  st.manifest = null
  return true
}
