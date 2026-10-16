/**
 * The follower's side of the generic replication kinds
 * (docs/plan/walnut-replica-servers-impl.md, section 4), behind
 * POST /bridge/replica (web/routes/bridge-replica.ts dispatches here).
 *
 * Each kind registers a handler; a step names its kind and the handler's
 * schema. An unknown kind is `404 unknown_kind`, a step built with a newer
 * schema than this code knows `409 schema_newer` (the leader rests that kind
 * for this follower). createRowSetFollower is the common store side: the
 * manifest step (need, held, removed, the half rule, the order) and the
 * bodies step, over hooks the kind gives (its local keys, its apply, its held
 * rows). Each kind's steps run on one serial chain, persisted before they
 * answer.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeJsonFile } from '../../utils/fs.js'
import { DigestMap } from './search-digest.js'
import {
  OPS, REFUSAL_ERROR, confirmMatches, entriesOf, removesMost, sameOrder, sha12, stepSchemaVersion, type ReplicaOp, type ReplicaStepResult,
} from './kind.js'

export interface FollowerKindHandler {
  kind: string
  /** The newest schema of this kind this code stores. */
  schemaVersion: number
  step(op: ReplicaOp, body: Record<string, unknown>): Promise<ReplicaStepResult> | ReplicaStepResult
}

const handlers = new Map<string, FollowerKindHandler>()

export function registerFollowerKind(handler: FollowerKindHandler): () => void {
  handlers.set(handler.kind, handler)
  return () => { if (handlers.get(handler.kind) === handler) handlers.delete(handler.kind) }
}

export function followerKindNames(): string[] {
  return [...handlers.keys()]
}

/**
 * One step, dispatched by its kind. `extra` are handlers only this route
 * serves (the device copy of a host server); they win over the registered ones.
 */
export async function followerStep(body: Record<string, unknown>, extra: readonly FollowerKindHandler[] = []): Promise<ReplicaStepResult> {
  const op = body.op
  if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return { ok: false, status: 400, error: 'unknown_op' }
  if (typeof body.kind !== 'string' || !body.kind) return { ok: false, status: 400, error: 'unknown_kind' }
  const handler = extra.find((h) => h.kind === body.kind) ?? handlers.get(body.kind)
  if (!handler) return { ok: false, status: 404, error: 'unknown_kind' }
  if (stepSchemaVersion(body) > handler.schemaVersion) {
    return { ok: false, status: 409, error: 'schema_newer', have: handler.schemaVersion }
  }
  return handler.step(op as ReplicaOp, body)
}

/** A copy's file: 0600, in dirs at 0700 (made here when missing). */
export async function writeCopyFile(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeJsonFile(file, data, { mode: 0o600 })
}

/** One replica step at a time per chain: a put must never interleave with the sync it answers. */
export function serialChain(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn)
    chain = run.catch(() => {})
    return run
  }
}

/** What a row-set kind keeps about the leader's rows (persisted by the kind). */
export interface RowSetState {
  /** The leader's clock when it built the last manifest (or a delta or status this side matched). */
  asOf: number
  /** This box's clock when that manifest arrived. */
  at: number
  order: string[]
  /** Each row's hash as the leader sent it. */
  hashes: Record<string, string>
}

/** Rows this box wrote itself and the leader may not have yet. */
export interface HeldSource {
  has(key: string): boolean
  /** A reorder made here is still on its way to the leader: keep the local order. */
  orderWriteRecent(): boolean
}

export const NOTHING_HELD: HeldSource = { has: () => false, orderWriteRecent: () => false }

export interface RowSetSpec<Row> {
  kind: string
  schemaVersion: number
  /** Log prefix ('task replica'). */
  label: string
  log: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }
  removalFloor: number
  ordered: boolean
  serial: <T>(fn: () => Promise<T>) => Promise<T>
  /** Refuse every step: a string is `400 <error>` (not a follower), an object names its status. */
  refuse?(): Refusal | Promise<Refusal>
  load(): Promise<RowSetState>
  save(): Promise<void>
  isRow(v: unknown): v is Row
  key(row: Row): string
  localKeys(): Promise<string[]>
  apply(change: { rows?: readonly Row[]; removeIds?: readonly string[]; order?: readonly string[] }): Promise<{ skipped: readonly string[] }>
  held(): Promise<HeldSource>
  changed(): void
  /**
   * The row's hash as the leader worked it out (default sha256-12 of the row).
   * A kind whose hash leaves volatile fields out (sessions) gives the same
   * function on both sides, or every manifest would ask for every row again.
   */
  hash?(row: Row): string
  /**
   * A digest kind (WP4): answers `status {digest}` with its own digest (count
   * plus 48-bit sum over each stored row's key and hash, search-digest.ts), and
   * a put that names `digest` answers this side's digest after it stored.
   */
  digest?: boolean
  /**
   * The host's choice turned this kind off (WP4, replication/kinds/gate.ts):
   * remove the kind's store and its copy state, leave the off marker. A kind
   * without one answers `purge` with `400 unknown_op`.
   */
  purge?(): Promise<{ removed: number }>
}

export type Refusal = string | { status: 400 | 404 | 409; error: string } | null

/** A refusal as a step's answer (null: go on). */
export function refusalAnswer(r: Refusal): ReplicaStepResult | null {
  if (!r) return null
  return typeof r === 'string' ? { ok: false, status: 400, error: r } : { ok: false, status: r.status, error: r.error }
}

export interface RowSetFollower extends FollowerKindHandler {
  sync(body: Record<string, unknown>): Promise<ReplicaStepResult>
  put(body: Record<string, unknown>): Promise<ReplicaStepResult>
}

/**
 * The digest of what this side stores: every local row with the hash the
 * leader sent for it (a row with none counts as an empty hash, so it never
 * matches). Equal digests on both sides mean the same keys at the same hashes.
 */
export function rowSetDigest(localKeys: readonly string[], hashes: Readonly<Record<string, string>>, ordered = false): string {
  const map = new DigestMap()
  let i = 0
  for (const k of localKeys) map.set(i++, k, hashes[k] ?? '')
  // An ordered kind's digest names its order too: a move alone changes no row's hash.
  return ordered ? `${map.digest}.${sha12(localKeys.join('\n'))}` : map.digest
}

/**
 * The store side of a row-set kind. The manifest step answers the keys this
 * box lacks or holds at another hash, removes the rows the manifest no longer
 * names, and takes the leader's order; the bodies step stores rows as they
 * are. A held row is neither replaced nor removed and counts in `held`, so the
 * leader sends the manifest again. New rows go after the others until the
 * round's `last` batch, which takes the manifest's order.
 */
export function createRowSetFollower<Row>(spec: RowSetSpec<Row>): RowSetFollower {
  const sync = (body: Record<string, unknown>): Promise<ReplicaStepResult> => spec.serial(async () => {
    const refused = refusalAnswer(await spec.refuse?.() ?? null)
    if (refused) return refused
    const entries = entriesOf(body.entries)
    if (!entries) return { ok: false, status: 400, error: 'bad_entries' }
    const s = await spec.load()
    const held = await spec.held()
    const local = await spec.localKeys()
    const localSet = new Set(local)
    const wanted = new Set(entries.map((e) => e.k))
    const need: string[] = []
    let heldCount = 0
    for (const e of entries) {
      if (held.has(e.k)) { if (s.hashes[e.k] !== e.h || !localSet.has(e.k)) heldCount++; continue }
      if (!localSet.has(e.k) || s.hashes[e.k] !== e.h) need.push(e.k)
    }
    const removeIds: string[] = []
    for (const id of local) {
      if (wanted.has(id)) continue
      if (held.has(id)) { heldCount++; continue }
      removeIds.push(id)
    }
    // A leader that lost its store (an empty or damaged database at boot) must
    // not empty this one, which may then be the only copy left. The leader may
    // confirm a real prune after three refused rounds (the Settings row). A
    // confirm names the manifest it was given for (`confirmFor`, kind.ts): one
    // with no binding, or bound to another manifest, is refused like none.
    if (removesMost(local.length, removeIds.length, spec.removalFloor)) {
      const confirmed = body.confirm === true && confirmMatches(body.confirmFor, entries)
      if (!confirmed) {
        spec.log.warn(`${spec.label}: refused a manifest that removes most rows`, {
          kind: spec.kind, entries: entries.length, local: local.length, removing: removeIds.length, ...(body.confirm === true ? { confirmUnbound: true } : {}),
        })
        // The size of the removal goes back with the refusal: the user confirms knowing it.
        return { ok: false, status: 400, error: REFUSAL_ERROR, local: local.length, removing: removeIds.length }
      }
      spec.log.warn(`${spec.label}: the leader confirmed a manifest that removes most rows`, { kind: spec.kind, entries: entries.length, local: local.length, removing: removeIds.length })
    }
    const order = entries.map((e) => e.k)
    const reorder = spec.ordered && !held.orderWriteRecent() && !sameOrder(local, order)
    if (removeIds.length > 0 || reorder) {
      await spec.apply({ removeIds, ...(reorder ? { order } : {}) })
      spec.changed()
    }
    for (const id of removeIds) delete s.hashes[id]
    s.order = order
    s.asOf = Number(body.asOf) || Date.now()
    s.at = Date.now()
    await spec.save()
    if (removeIds.length > 0 || need.length > 0) {
      spec.log.info(`${spec.label}: manifest`, { kind: spec.kind, entries: entries.length, need: need.length, held: heldCount, removed: removeIds.length, reordered: reorder })
    }
    return { ok: true, need, held: heldCount, removed: removeIds.length }
  })

  const put = (body: Record<string, unknown>): Promise<ReplicaStepResult> => spec.serial(async () => {
    const refused = refusalAnswer(await spec.refuse?.() ?? null)
    if (refused) return refused
    const s = await spec.load()
    if (!Array.isArray(body.rows) || !body.rows.every((r) => spec.isRow(r))) return { ok: false, status: 400, error: 'bad_rows' }
    const sentRows = body.rows as Row[]
    const held = await spec.held()
    const rows = sentRows.filter((r) => !held.has(spec.key(r)))
    let order: string[] | undefined
    if (spec.ordered && body.last === true && !held.orderWriteRecent()) {
      // The order this batch would leave: rows already here keep their place, new ones go last.
      const ids = await spec.localKeys()
      const here = new Set(ids)
      if (!sameOrder([...ids, ...rows.map((r) => spec.key(r)).filter((id) => !here.has(id))], s.order)) order = s.order
    }
    let stored = 0
    if (rows.length > 0 || order) {
      const { skipped } = await spec.apply({ rows, ...(order ? { order } : {}) })
      const refusedRows = new Set(skipped)
      for (const r of rows) {
        const k = spec.key(r)
        if (refusedRows.has(k)) continue // not stored: asked for again next round
        s.hashes[k] = hashRow(r)
        stored++
      }
      await spec.save()
      spec.changed()
    }
    // A refused row counts as held: the leader sends the manifest again.
    const answer: ReplicaStepResult = { ok: true, stored, held: sentRows.length - stored }
    // A put sent without a manifest (the leader's delta) asks whether this side now matches.
    if (spec.digest && typeof body.digest === 'string') {
      answer.digest = rowSetDigest(await spec.localKeys(), s.hashes, spec.ordered)
      if (answer.digest === body.digest) await heardAsOf(s, body.asOf)
    }
    return answer
  })

  const hashRow = (r: Row): string => (spec.hash ? spec.hash(r) : sha12(JSON.stringify(r)))

  /**
   * A delta's last put or a status step whose digest matched: this side holds
   * the leader's rows as of the leader's `asOf`, as after a manifest (the hold
   * after ack of WP10 reads it). Never moves back.
   */
  const heardAsOf = async (s: RowSetState, raw: unknown): Promise<void> => {
    const asOf = Number(raw)
    if (!Number.isFinite(asOf) || asOf <= s.asOf) return
    s.asOf = asOf
    s.at = Date.now()
    await spec.save()
  }

  /** Digest kinds: this side's digest, so an equal round ends without a manifest. */
  const status = (body: Record<string, unknown>): Promise<ReplicaStepResult> => spec.serial(async () => {
    const refused = refusalAnswer(await spec.refuse?.() ?? null)
    if (refused) return refused
    const s = await spec.load()
    const digest = rowSetDigest(await spec.localKeys(), s.hashes, spec.ordered)
    const inSync = typeof body.digest === 'string' && body.digest === digest
    if (inSync) await heardAsOf(s, body.asOf)
    return { ok: true, digest, inSync }
  })

  /** The kind turned off by the host's choice: no half rule, the user asked for it on the Mac. */
  const purge = (): Promise<ReplicaStepResult> => spec.serial(async () => {
    const refused = refusalAnswer(await spec.refuse?.() ?? null)
    if (refused) return refused
    const { removed } = await spec.purge!()
    spec.changed()
    spec.log.info(`${spec.label}: purged, the host's choice turned this kind off`, { kind: spec.kind, removed })
    return { ok: true, purged: true, removed }
  })

  return {
    kind: spec.kind,
    schemaVersion: spec.schemaVersion,
    sync,
    put,
    step: (op, body) => (op === 'sync' ? sync(body) : op === 'put' ? put(body) : op === 'status' && spec.digest ? status(body)
      : op === 'purge' && spec.purge ? purge() : { ok: false, status: 400, error: 'unknown_op' }),
  }
}

/** Tests only. */
export function _resetFollowerKindsForTesting(): void {
  handlers.clear()
}
