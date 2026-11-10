/**
 * The digest shortcut of a replication kind (docs/plan/walnut-replica-servers-impl.md,
 * section 4 and WP4), shared by every kind of many rows: the copy kinds
 * (kinds/copy-kind.ts) and the tasks (task-replica.ts).
 *
 * A manifest names every row, so it costs the whole kind on every round: the
 * tasks' is about 450 KB for 7,300 rows, and a round ran a few seconds after
 * every task change. A host's link is an SSH connection, and on 2026-11-10 the
 * path to one host ended the connection every few MB it carried up (a plain
 * upload test ended the same way, a 1.5 GB download did not): those manifests
 * were most of what went up, and the host's link dropped 15 times an hour.
 *
 * So a round whose target took a manifest before, and whose rows only changed
 * or were added at the end (none removed, none moved), puts just those rows and
 * asks the follower's digest on the last put; equal, the round ends without a
 * manifest. With nothing changed (the 5-minute sweep, or the first round after
 * this server restarted) a `status` step compares digests and an equal one
 * ends the round. Anything else runs the full manifest round (kind-leader.ts),
 * which alone removes rows (the half rule guards it) and sets an order.
 *
 * A follower whose build has no digest for the kind answers the step without
 * one (or `unknown_op` to `status`): that target takes manifest rounds only for
 * UNSUPPORTED_REST_MS, so it pays one extra put, not one per round.
 */

import { PUT_BATCH_BYTES, PUT_TIMEOUT_MS, UNSUPPORTED_REST_MS, sha12 } from './kind.js'
import { putRow, type KindManifest, type KindRoundResult, type LeaderKind } from './kind-leader.js'
import { DigestMap } from './search-digest.js'
import type { KindState } from './replica-status.js'
import type { ReplicaTarget } from './replica-targets.js'

/** A delta of more rows than this goes as a manifest round instead. */
export const DELTA_MAX_ROWS = 1_000

/** A kind that may take the shortcut: its follower answers digests (`digest`), in store order or not. */
export interface DeltaKind<Row> extends LeaderKind<Row> {
  ordered: boolean
  digest: boolean
}

type DeltaTarget = Pick<ReplicaTarget, 'id' | 'post'>

/** The digest of a manifest, worked out once per manifest object. */
const manifestDigests = new WeakMap<object, string>()
/** An ordered kind's digest also names its order (kind-follower.ts rowSetDigest works it out the same way). */
export function manifestDigest(manifest: KindManifest<unknown>, ordered = false): string {
  let d = manifestDigests.get(manifest)
  if (d === undefined) {
    const map = new DigestMap()
    let i = 0
    for (const e of manifest.entries) map.set(i++, e.k, e.h)
    d = ordered ? `${map.digest}.${sha12(manifest.entries.map((e) => e.k).join('\n'))}` : map.digest
    manifestDigests.set(manifest, d)
  }
  return d
}

/** What each target took whole last (key -> hash, in the manifest's order), kept against its kind state. */
const taken = new WeakMap<KindState, Map<string, string>>()

function entriesMap(manifest: KindManifest<unknown>): Map<string, string> {
  return new Map(manifest.entries.map((e) => [e.k, e.h]))
}

/** The target took this manifest whole (a manifest round that held nothing back): later rounds may go as deltas. */
export function noteManifestTaken(st: KindState, manifest: KindManifest<unknown>): void {
  if (st.manifest === manifest.hash) taken.set(st, entriesMap(manifest))
}

/** Nothing is known of what the target holds (a kind turned off there): the next round sends a manifest. */
export function forgetTaken(st: KindState): void {
  taken.delete(st)
}

function noteTaken(st: KindState, manifest: KindManifest<unknown>, asOf: number, at: number, action: 'synced' | 'unchanged', sent: number): void {
  st.manifest = manifest.hash
  taken.set(st, entriesMap(manifest))
  st.refusals = 0
  st.lastRefusal = undefined
  Object.assign(st, { action, entries: manifest.entries.length, held: 0, sent, removed: 0, asOf, syncedAt: at, error: undefined })
}

/**
 * The rows a delta must put, or null when only a manifest round can bring the
 * target up to date. An ordered kind takes rows added after the ones the target
 * holds (a follower puts a new row last, kind-follower.ts); a row added
 * anywhere else, or a move, needs the manifest's order.
 */
export function deltaKeys(ordered: boolean, manifest: KindManifest<unknown>, prev: ReadonlyMap<string, string>): string[] | null {
  const changed: string[] = []
  let shared = 0
  for (const e of manifest.entries) {
    if (prev.has(e.k)) shared++
    if (prev.get(e.k) !== e.h) changed.push(e.k)
  }
  if (shared < prev.size) return null // a row went: only a manifest removes (and the half rule guards it)
  if (changed.length > DELTA_MAX_ROWS) return null
  if (ordered) {
    let i = 0
    for (const k of prev.keys()) if (manifest.entries[i++].k !== k) return null
  }
  return changed
}

type StepAnswer = { reply: Record<string, unknown> } | { error?: string }

/** One step; never throws. A refusal carries the follower's error code. */
async function deltaStep(target: DeltaTarget, payload: Record<string, unknown>, timeoutMs?: number): Promise<StepAnswer> {
  try {
    const r = await target.post(payload, timeoutMs ? { timeoutMs } : undefined)
    if (r.ok) return r.reply.ok === true ? { reply: r.reply } : { error: typeof r.reply.error === 'string' ? r.reply.error : undefined }
    return { error: r.error }
  } catch { return {} }
}

/** The follower's build has no digest for this kind: manifest rounds only, for a while. */
function restDelta(st: KindState, now: number, target: DeltaTarget, kind: string, log?: DeltaOptions['log']): void {
  st.deltaRestUntil = now + UNSUPPORTED_REST_MS
  log?.info('replica: this follower answers no digest for this kind, sending manifests for 10 minutes', { target: target.id, kind })
}

export interface DeltaOptions {
  asOf: number
  now: () => number
  log?: { info(msg: string, data?: Record<string, unknown>): void }
}

/**
 * The shortcut for `kind` on one target, or null when the full manifest round
 * must run. Never throws: a failed step falls back to the round.
 */
export async function runDeltaRound<Row>(
  kind: DeltaKind<Row>, manifest: KindManifest<Row>, target: DeltaTarget, st: KindState, opts: DeltaOptions,
): Promise<KindRoundResult | null> {
  const { asOf, now } = opts
  // A kind turned on again after a purge takes the manifest: only a sync replaces the host's off marker
  // (kinds/gate.ts), even when both sides are empty and the digests agree.
  // Rows the leader could not read ride only on a sync (`keep`), never on a delta.
  if (!kind.digest || st.confirmNext || st.manifest === manifest.hash || st.action === 'off' || (manifest.keep?.length ?? 0) > 0) return null
  if ((st.deltaRestUntil ?? 0) > now()) return null
  const digest = manifestDigest(manifest, kind.ordered)
  const prev = taken.get(st)
  const changed = prev ? deltaKeys(kind.ordered, manifest, prev) : []
  if (changed === null) return null
  const base = { kind: kind.kind, schemaVersion: kind.schemaVersion }
  if (changed.length === 0) {
    // asOf rides along: an equal digest means the follower holds the leader's rows as of now (hold after ack, WP10).
    const a = await deltaStep(target, { op: 'status', ...base, digest, asOf })
    if (!('reply' in a)) {
      if (a.error === 'unknown_op') restDelta(st, now(), target, kind.kind, opts.log)
      return null
    }
    if (typeof a.reply.digest !== 'string') { restDelta(st, now(), target, kind.kind, opts.log); return null }
    if (a.reply.digest !== digest) return null
    noteTaken(st, manifest, asOf, now(), 'unchanged', 0)
    return { kind: kind.kind, action: 'unchanged', entries: manifest.entries.length }
  }
  let batch: Row[] = []
  let bytes = 0
  let sent = 0
  let held = 0
  let lastReply: Record<string, unknown> | null = null
  const flush = async (last: boolean): Promise<boolean> => {
    const encoded = kind.encodePut ? kind.encodePut(batch, last) : { rows: batch, ...(last ? { last: true } : {}) }
    const a = await deltaStep(target, { op: 'put', ...base, ...encoded, ...(last ? { digest, asOf } : {}) }, PUT_TIMEOUT_MS)
    if (!('reply' in a)) return false
    const r = a.reply
    const stored = Number(r.stored) || 0
    sent += stored
    held += Math.max(Number(r.held) || 0, batch.length - stored)
    if (last) lastReply = r
    batch = []
    bytes = 0
    return true
  }
  for (const k of changed) {
    const row = await putRow(kind, manifest, k)
    if (row === undefined) return null // went away since the manifest: the round decides
    const size = Buffer.byteLength(JSON.stringify(row))
    if (batch.length > 0 && bytes + size > PUT_BATCH_BYTES && !(await flush(false))) return null
    batch.push(row)
    bytes += size
  }
  if (!(await flush(true))) return null
  const answered = (lastReply as Record<string, unknown> | null)?.digest
  if (typeof answered !== 'string') { restDelta(st, now(), target, kind.kind, opts.log); return null }
  if (held > 0 || answered !== digest) return null
  noteTaken(st, manifest, asOf, now(), 'synced', sent)
  return { kind: kind.kind, action: 'synced', entries: manifest.entries.length, sent, held: 0, removed: 0 }
}
