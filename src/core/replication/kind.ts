/**
 * One generic replication kind (docs/plan/walnut-replica-servers-impl.md,
 * section 4). A kind is a set of rows the leader (the Mac) owns and every
 * follower (the cloud companion, each host replica) keeps a copy of, over
 * POST /bridge/replica. The protocol is the task copy's:
 *
 *   status  digest kinds only (WP4): count + 48-bit sum, ends an equal round
 *   sync    {kind, schemaVersion, entries:[{k,h}], asOf, confirm?, confirmFor?, keep?} -> {need, held, removed}
 *   put     {kind, schemaVersion, rows, last?}                    -> {stored, held}
 *
 * The leader side runs per target (kind-leader.ts), the follower side behind
 * the route (kind-follower.ts). This file holds what both sides agree on.
 *
 *   - a row's hash is sha256-12 of what is sent (the kind's projection);
 *   - an unchanged manifest (hash over every `k:h`) is not sent again; the
 *     5-minute sweep sends it anyway;
 *   - puts go in batches of at most 512 KB; a reply with held > 0 means the
 *     follower keeps a row of its own and the round runs again after 35 s;
 *   - the half rule: once the follower holds `removalFloor` rows, a manifest
 *     that would remove more than half of them is refused
 *     (`manifest_removes_most_rows`) unless the leader sends `confirm:true`
 *     after 3 refused rounds with a stable count (driven by the Settings row).
 *     The confirm is bound to the manifest the user confirmed: it rides along
 *     with `confirmFor:{entries, keys}` only while the leader's manifest still
 *     names that many rows and that set of keys, and only for CONFIRM_TTL_MS;
 *     a follower refuses a confirm whose `confirmFor` does not match the
 *     manifest it came with. A follower that refuses a matching confirm runs a
 *     build older than the confirm (one without it names no `local`/`removing`
 *     either): the leader stops offering it there until a refusal names them;
 *   - `keep` (WP4): keys the leader has but could not read this round (a board
 *     file it failed to open or parse). The follower neither asks for them nor
 *     removes them, so a read error on the Mac never deletes the copy. The
 *     manifest hash takes them in (keptManifestHash), so a key leaving `keep`
 *     runs the round again;
 *   - a follower that does not know a kind answers `404 unknown_kind`, one
 *     whose code is older than the kind's schema `409 schema_newer`; the
 *     leader rests that kind for that target 10 minutes.
 */

import crypto from 'node:crypto'

export const PUT_BATCH_BYTES = 512 * 1024
export const PUT_TIMEOUT_MS = 60_000
/** Hash this many rows, then let the event loop run. */
export const HASH_SLICE = 300
/** A round a follower answered with held rows runs again after their hold ends (30s there). */
export const HELD_RETRY_MS = 35_000
/** A follower without a kind (or with an older schema of it) is asked again after this. */
export const UNSUPPORTED_REST_MS = 10 * 60_000
/** Refused rounds in a row (with a stable leader count) before `confirm:true` may be sent. */
export const CONFIRM_AFTER_REFUSALS = 3
/**
 * A confirm the user gave and no round has sent yet expires after this: two
 * sweeps, so a confirm whose step was lost on the way still has its retries
 * (CONFIRM_RETRY_MS) and at least one sweep before it lapses.
 */
export const CONFIRM_TTL_MS = 10 * 60_000
/** A kept confirm whose step was lost goes again after this, doubling up to CONFIRM_RETRY_MAX_MS. */
export const CONFIRM_RETRY_MS = 5_000
export const CONFIRM_RETRY_MAX_MS = 60_000

/** The wait before the `tries`-th retry of a lost confirm (1, 2, ...). */
export function confirmRetryMs(tries: number): number {
  return Math.min(CONFIRM_RETRY_MS * 2 ** Math.max(0, tries - 1), CONFIRM_RETRY_MAX_MS)
}

/**
 * `purge` (WP4): the host's choice turned a copy kind off, the follower drops
 * that kind's store (replication/kinds/gate.ts). A kind without one answers
 * `400 unknown_op`, as an older follower does.
 */
export const OPS = ['status', 'sync', 'put', 'purge'] as const
export type ReplicaOp = (typeof OPS)[number]

/**
 * Errors that rest a kind for a target instead of failing the round: a kind it
 * does not keep, an older schema, a step it does not know (an older follower's
 * `400 unknown_op`), a host server on the build before this one (`400
 * not_a_replica`), a copy that belongs to another Walnut (`409 other_leader`).
 */
export const REST_ERRORS = new Set(['unknown_kind', 'schema_newer', 'unknown_op', 'not_a_replica', 'other_leader'])
export const REFUSAL_ERROR = 'manifest_removes_most_rows'

export function sha12(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)
}

export interface ManifestEntry { k: string; h: string }

/** A manifest's entries, or null when any entry is malformed. */
export function entriesOf(raw: unknown): ManifestEntry[] | null {
  if (!Array.isArray(raw)) return null
  const out: ManifestEntry[] = []
  for (const e of raw) {
    const k = (e as { k?: unknown })?.k
    const h = (e as { h?: unknown })?.h
    if (typeof k !== 'string' || !k || typeof h !== 'string' || !/^[0-9a-f]{12}$/.test(h)) return null
    out.push({ k, h })
  }
  return out
}

/** The rows both lists name are in the same order (rows only one names are not an order change). */
export function sameOrder(local: readonly string[], manifest: readonly string[]): boolean {
  const have = new Set(local)
  const want = new Set(manifest)
  const a = local.filter((id) => want.has(id))
  const b = manifest.filter((id) => have.has(id))
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** The half rule: a manifest removing more than half of `local` rows, once there are `floor` of them. */
export function removesMost(local: number, removing: number, floor: number): boolean {
  return local >= floor && removing * 2 > local
}

/** The manifest hash: one value over every entry, in order. */
export function manifestHashOf(entries: readonly ManifestEntry[]): string {
  return sha12(entries.map((e) => `${e.k}:${e.h}`).join('\n'))
}

/** A sync's `keep` keys ([] when it names none), or null when it is malformed. */
export function keepOf(raw: unknown): string[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every((k) => typeof k === 'string' && k.length > 0)) return null
  return raw as string[]
}

/** A manifest hash with its `keep` keys in it (unchanged when there are none). */
export function keptManifestHash(hash: string, keep: readonly string[]): string {
  return keep.length === 0 ? hash : sha12(`${hash}\nkeep:${[...keep].sort().join('\n')}`)
}

/** The set of keys a manifest names, order aside: what a confirmed removal is bound to. */
export function manifestKeysHashOf(entries: readonly ManifestEntry[]): string {
  return sha12(entries.map((e) => e.k).sort().join('\n'))
}

/** What a confirm is for: the leader's row count and key set the user confirmed. */
export interface ConfirmFor { entries: number; keys: string }

/** Whether a step's `confirmFor` names exactly these entries (false when it is malformed). */
export function confirmMatches(raw: unknown, entries: readonly ManifestEntry[]): boolean {
  const c = raw as Partial<ConfirmFor> | null
  if (!c || typeof c !== 'object' || typeof c.entries !== 'number' || typeof c.keys !== 'string') return false
  return c.entries === entries.length && c.keys === manifestKeysHashOf(entries)
}

/** A follower step's answer: the route sends `status` and the rest of a refusal as JSON. */
export type ReplicaStepResult =
  | { ok: true; [k: string]: unknown }
  | { ok: false; status: 400 | 404 | 409; error: string; [k: string]: unknown }

/** The schema a step was built with (an older leader sends none: 1). */
export function stepSchemaVersion(body: { schemaVersion?: unknown }): number {
  const v = Number(body.schemaVersion)
  return Number.isInteger(v) && v > 0 ? v : 1
}
