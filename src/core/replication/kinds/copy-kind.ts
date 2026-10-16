/**
 * The leader's side of the WP4 copies (docs/plan/walnut-replica-servers-impl.md,
 * section 4 and WP4): sessions, requests, boards and inbox, each a generic
 * replication kind (kind-leader.ts runs the manifest round). This file adds
 * what those kinds share:
 *
 *   - the digest shortcut for digest kinds: a round whose target took a
 *     manifest before and whose rows only changed (none removed) puts just the
 *     changed rows and asks the follower's digest on the last put; equal, the
 *     round ends without a manifest. With nothing changed (the 5-minute sweep,
 *     or the first round after a restart of this server) a `status` step
 *     compares digests and an equal one ends the round. Anything else runs
 *     the full manifest round;
 *   - the targets: HOST replicas only, and only a host whose program is the
 *     replica (D13's per-host opt-in; the plain host server and the daemon's
 *     fallback keep no copies). The companion keeps its own session projection
 *     and has no copy of the others yet (WP13 moves it to this path), so it is
 *     never sent these kinds;
 *   - the per-host choice of copied kinds (hosts.<key>.server.copies, the
 *     host's Settings row; core/host-server/manager.ts passes it on the target).
 *     A kind turned off gets one `purge` step: the host drops that kind's store
 *     (kinds/gate.ts) and answers it `needs_leader` while the Mac is away;
 *   - the scheduler: a round a few seconds after the kind's own store wrote,
 *     one more after rows a follower held, and the sweep every 5 minutes.
 *     Targets one after another, never in parallel.
 */

import { log } from '../../../logging/index.js'
import { isFollower } from '../../server-role.js'
import { HELD_RETRY_MS, PUT_BATCH_BYTES, PUT_TIMEOUT_MS, REST_ERRORS, keptManifestHash, sha12 } from '../kind.js'
import { buildKindManifest, confirmKindRemoval, putRow, runKindRound, StepFailed, type KindManifest, type KindRoundResult, type LeaderKind } from '../kind-leader.js'
import { DigestMap } from '../search-digest.js'
import { forgetKindManifests, kindState, peekKindState, type KindState } from '../replica-status.js'
import type { ReplicaTarget } from '../replica-targets.js'

export const COPY_DEBOUNCE_MS = 3_000
export const COPY_SWEEP_MS = 5 * 60_000
export const COPY_FIRST_ROUND_MS = 15_000
/** A delta of more rows than this goes as a manifest round instead. */
export const DELTA_MAX_ROWS = 1_000

/**
 * Which kinds a host copies (hosts.<key>.server.copies). Inbox bodies are off unless chosen.
 * WP5 adds routines, conversations (the Ask lists), prefs (ui prefs and favorites) and the
 * allowlisted config, all on by default.
 */
export interface CopyChoice {
  sessions: boolean; requests: boolean; boards: boolean; inbox: boolean; inbox_bodies: boolean
  routines: boolean; conversations: boolean; prefs: boolean; config: boolean
}
export const DEFAULT_COPY_CHOICE: Readonly<CopyChoice> = Object.freeze({
  sessions: true, requests: true, boards: true, inbox: true, inbox_bodies: false,
  routines: true, conversations: true, prefs: true, config: true,
})

/** The choice from config, defaults filled in (anything but a boolean keeps the default). */
export function copyChoiceFrom(raw: unknown): CopyChoice {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out = { ...DEFAULT_COPY_CHOICE }
  for (const k of Object.keys(out) as Array<keyof CopyChoice>) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  // Bodies ride with the index: a host that keeps no inbox keeps no letter bodies either.
  if (!out.inbox) out.inbox_bodies = false
  return out
}

export interface CopyKind<Row> extends LeaderKind<Row> {
  /** The leader's rows, in store order when the kind is ordered. */
  rows(): Promise<readonly Row[]>
  ordered: boolean
  digest: boolean
  /** The choice that turns this kind on for a host (inbox: 'inbox'). */
  choice: keyof CopyChoice
  /** Calls `soon` whenever the kind's store wrote. Returns the stop. */
  watch(soon: () => void): () => void
  /**
   * Keys this `rows()` answer found but could not read (boards: a file that did
   * not open or parse). The round names them in `keep` (kind.ts), so the host
   * keeps its copy of each instead of removing it. None: every row was read.
   */
  keep?(rows: readonly Row[]): readonly string[]
}

/** A kind's manifest for this round: its rows, plus the keys it could not read (`keep`, in the manifest hash). */
export async function buildCopyManifest<Row>(kind: CopyKind<Row>): Promise<KindManifest<Row>> {
  const rows = await kind.rows()
  const manifest = await buildKindManifest(kind, [...rows])
  const keep = [...(kind.keep?.(rows) ?? [])].sort()
  if (keep.length > 0) {
    manifest.keep = keep
    manifest.hash = keptManifestHash(manifest.hash, keep)
  }
  return manifest
}

export type CopyTarget = Pick<ReplicaTarget, 'id' | 'kind' | 'label' | 'post' | 'available' | 'copies' | 'program'>

/** A target that keeps the copies: a host running the replica program (not the host server, not its fallback). */
export function keepsCopiesTarget(t: CopyTarget): boolean {
  return t.kind === 'host' && t.program?.() === 'replica'
}

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

/** What each target took whole last (key -> hash), kept against its kind state. */
const taken = new WeakMap<KindState, Map<string, string>>()
/** The kind is off for this target and the target dropped its store (or cannot): no purge again until it is turned on. */
const purged = new WeakSet<KindState>()

function entriesMap(manifest: KindManifest<unknown>): Map<string, string> {
  return new Map(manifest.entries.map((e) => [e.k, e.h]))
}

/** One step; null on any failure (the full manifest round then runs and notes it). */
async function quietStep(target: CopyTarget, payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> | null> {
  try {
    const r = await target.post(payload, timeoutMs ? { timeoutMs } : undefined)
    return r.ok && r.reply.ok === true ? r.reply : null
  } catch { return null }
}

function encode<Row>(kind: CopyKind<Row>, rows: readonly Row[], last: boolean): Record<string, unknown> {
  return kind.encodePut ? kind.encodePut(rows, last) : { rows, ...(last ? { last: true } : {}) }
}

function noteTaken(st: KindState, manifest: KindManifest<unknown>, asOf: number, at: number, action: 'synced' | 'unchanged', sent: number): void {
  st.manifest = manifest.hash
  taken.set(st, entriesMap(manifest))
  st.refusals = 0
  st.lastRefusal = undefined
  Object.assign(st, { action, entries: manifest.entries.length, held: 0, sent, removed: 0, asOf, syncedAt: at, error: undefined })
}

/** The rows a delta must put, or null when only a manifest round can bring the target up to date. */
function deltaKeys(kind: CopyKind<unknown>, manifest: KindManifest<unknown>, prev: Map<string, string>): string[] | null {
  const changed: string[] = []
  let shared = 0
  for (const e of manifest.entries) {
    if (prev.has(e.k)) shared++
    if (prev.get(e.k) !== e.h) changed.push(e.k)
  }
  if (shared < prev.size) return null // a row went: only a manifest removes (and the half rule guards it)
  if (changed.length > DELTA_MAX_ROWS) return null
  if (kind.ordered) {
    // A new row's place, or a move, needs the manifest's order.
    if (manifest.entries.length !== prev.size) return null
    let i = 0
    for (const k of prev.keys()) if (manifest.entries[i++].k !== k) return null
  }
  return changed
}

/**
 * The digest shortcut of a digest kind (see the header), or null when the full
 * manifest round must run. Never throws: a failed step falls back to the round.
 */
async function digestShortcut<Row>(
  kind: CopyKind<Row>, manifest: KindManifest<Row>, target: CopyTarget, st: KindState, asOf: number, now: () => number,
): Promise<KindRoundResult | null> {
  // A kind turned on again after a purge takes the manifest: only a sync replaces the host's off marker
  // (kinds/gate.ts), even when both sides are empty and the digests agree.
  // Rows the leader could not read ride only on a sync (`keep`), never on a delta.
  if (!kind.digest || st.confirmNext || st.manifest === manifest.hash || st.action === 'off' || (manifest.keep?.length ?? 0) > 0) return null
  const digest = manifestDigest(manifest, kind.ordered)
  const prev = taken.get(st)
  const changed = prev ? deltaKeys(kind as CopyKind<unknown>, manifest, prev) : []
  if (changed === null) return null
  const base = { kind: kind.kind, schemaVersion: kind.schemaVersion }
  if (changed.length === 0) {
    // asOf rides along: an equal digest means the follower holds the leader's rows as of now (hold after ack, WP10).
    const r = await quietStep(target, { op: 'status', ...base, digest, asOf })
    if (!r || r.digest !== digest) return null
    noteTaken(st, manifest, asOf, now(), 'unchanged', 0)
    return { kind: kind.kind, action: 'unchanged', entries: manifest.entries.length }
  }
  let batch: Row[] = []
  let bytes = 0
  let sent = 0
  let held = 0
  let lastReply: Record<string, unknown> | null = null
  const flush = async (last: boolean): Promise<boolean> => {
    const r = await quietStep(target, { op: 'put', ...base, ...encode(kind, batch, last), ...(last ? { digest, asOf } : {}) }, PUT_TIMEOUT_MS)
    if (!r) return false
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
  if (held > 0 || (lastReply as Record<string, unknown> | null)?.digest !== digest) return null
  noteTaken(st, manifest, asOf, now(), 'synced', sent)
  return { kind: kind.kind, action: 'synced', entries: manifest.entries.length, sent, held: 0, removed: 0 }
}

/** One copy kind on one host target: the digest shortcut, else the manifest round. */
export async function runCopyRound<Row>(
  kind: CopyKind<Row>, manifest: KindManifest<Row>, target: CopyTarget, opts: { asOf: number; now?: () => number },
): Promise<KindRoundResult> {
  const now = opts.now ?? Date.now
  const st = kindState(target, kind.kind)
  if (st.restUntil > now()) return { kind: kind.kind, action: 'unsupported', error: st.restWhy }
  const quick = await digestShortcut(kind, manifest, target, st, opts.asOf, now)
  if (quick) return quick
  const r = await runKindRound(kind, manifest, target, { asOf: opts.asOf, now, log: log.session })
  if (r.action === 'synced' && st.manifest === manifest.hash) taken.set(st, entriesMap(manifest))
  return r
}

export interface CopyRoundResult extends KindRoundResult { target: string }

export interface CopyKindsDeps {
  /** Every follower (replica-targets.ts); only the host ones take these kinds. */
  targets?: () => CopyTarget[]
  now?: () => number
}

async function defaultTargets(): Promise<() => CopyTarget[]> {
  return (await import('../replica-targets.js')).replicaTargets
}

async function choiceOf(target: CopyTarget): Promise<CopyChoice> {
  try { return target.copies ? copyChoiceFrom(await target.copies()) : { ...DEFAULT_COPY_CHOICE } } catch { return { ...DEFAULT_COPY_CHOICE } }
}

/**
 * One round of `kinds` over every host target, one target after another.
 * Builds a kind's manifest once for all targets, and only when a target that
 * takes the kind is up. Never throws: a kind that failed on a target is
 * noted and the next one goes on (the kinds do not depend on each other).
 */
export async function syncCopyKinds(kinds: readonly CopyKind<any>[], deps: CopyKindsDeps = {}): Promise<CopyRoundResult[]> {
  const now = deps.now ?? Date.now
  const all = (deps.targets ?? await defaultTargets())().filter(keepsCopiesTarget)
  const ready: Array<{ target: CopyTarget; choice: CopyChoice }> = []
  for (const target of all) if (await target.available()) ready.push({ target, choice: await choiceOf(target) })
  const results: CopyRoundResult[] = []
  if (ready.length === 0) return results
  const asOf = now()
  const manifests = new Map<string, KindManifest<unknown>>()
  for (const kind of kinds) {
    if (!ready.some((r) => r.choice[kind.choice])) continue
    try {
      manifests.set(kind.kind, await buildCopyManifest(kind))
    } catch (err) {
      // No manifest, no step: a store this leader failed to read never reads as an empty one.
      log.session.warn('copies: could not read the leader rows of a kind', { kind: kind.kind, error: err instanceof Error ? err.message : String(err) })
    }
  }
  for (const { target, choice } of ready) {
    for (const kind of kinds) {
      const manifest = manifests.get(kind.kind)
      const st = kindState(target, kind.kind)
      if (!choice[kind.choice]) {
        // Turned off for this host: it drops what it holds of the kind (once), and its state says so.
        const removed = purged.has(st) ? undefined : await purgeKind(kind, target, st)
        Object.assign(st, { action: 'off', manifest: null })
        taken.delete(st)
        results.push({ target: target.id, kind: kind.kind, action: 'unsupported', error: 'kind_not_copied', ...(removed !== undefined ? { removed } : {}) })
        continue
      }
      purged.delete(st)
      if (!manifest) continue
      const startedAt = now()
      try {
        const r = await runCopyRound(kind, manifest, target, { asOf, now })
        results.push({ target: target.id, ...r })
        if (r.action === 'synced') log.session.info('copies: round', { target: target.id, ...r, ms: now() - startedAt })
      } catch (err) {
        const outcome = err instanceof StepFailed ? err.outcome : 'failed'
        const error = err instanceof Error ? err.message : String(err)
        results.push({ target: target.id, kind: kind.kind, action: outcome, error })
        if (outcome === 'failed') log.session.warn('copies: round failed', { target: target.id, kind: kind.kind, error })
      }
    }
  }
  return results
}

/**
 * The `purge` step of a kind the host turned off. The target dropped its store
 * (or answered a rest error: an older follower that has no purge): noted, not
 * sent again until the kind is turned on and off again. A failed step goes
 * again next round. Returns the rows removed, when the target says.
 */
async function purgeKind(kind: CopyKind<unknown>, target: CopyTarget, st: KindState): Promise<number | undefined> {
  try {
    const r = await target.post({ op: 'purge', kind: kind.kind, schemaVersion: kind.schemaVersion })
    if (r.ok && r.reply.ok === true) {
      purged.add(st)
      const removed = Number(r.reply.removed) || 0
      if (removed > 0) log.session.info('copies: the host dropped a kind its choice turned off', { target: target.id, kind: kind.kind, removed })
      return removed
    }
    if (!r.ok && (r.outcome === 'unsupported' || REST_ERRORS.has(r.error ?? ''))) purged.add(st)
    else log.session.warn('copies: purge of a kind turned off failed, again next round', { target: target.id, kind: kind.kind, error: r.ok ? String(r.reply.error ?? '') : r.error })
  } catch (err) {
    log.session.warn('copies: purge of a kind turned off failed, again next round', { target: target.id, kind: kind.kind, error: err instanceof Error ? err.message : String(err) })
  }
  return undefined
}

let schedulers = 0
/** The running scheduler's "round soon" (one per leader), for a confirm the user gave. */
let copySoon: ((kind?: string) => void) | null = null

/** Every copy kind's name (web/routes/replicas-status.ts accepts a confirm for these). */
export const COPY_KIND_NAMES = ['sessions', 'requests', 'boards', 'inbox', 'inbox-bodies', 'routines', 'conversations', 'prefs', 'config'] as const

/**
 * The user confirmed a removal the half rule refused three rounds in a row (the
 * Settings row): the next round of that kind on that target sends
 * `confirm:true`, bound to the count and keys the user saw (kind-leader.ts).
 * The round runs within the debounce, well inside the confirm's 5 minutes.
 */
export async function confirmCopyKindRemoval(targetId: string, kind: string, opts: { entries?: number; keys?: string } = {}): Promise<boolean> {
  const { replicaTargets } = await import('../replica-targets.js')
  const target = replicaTargets().find((t) => t.id === targetId)
  if (!target || target.kind !== 'host' || !peekKindState(targetId, kind)) return false
  if (!confirmKindRemoval(target, kind, opts)) return false
  log.session.warn('copies: the user confirmed a removal of most rows', { target: targetId, kind, entries: peekKindState(targetId, kind)?.confirmFor?.entries })
  copySoon?.(kind)
  return true
}

/**
 * A host's choice of copied kinds changed (its Settings row): a round of every
 * kind within the debounce, so a kind turned on copies and one turned off is
 * purged now, not at the next store write or sweep.
 */
export function copyChoiceChanged(): void {
  copySoon?.()
}

/**
 * Leader only: rounds of the copy kinds. A kind's store write brings a round
 * of that kind within COPY_DEBOUNCE_MS, a follower joining or becoming
 * reachable one of every kind, a round with held rows one more after
 * HELD_RETRY_MS, and the sweep every 5 minutes asks every target again (by
 * digest where the kind has one). One round at a time; a request during a
 * round runs one more after it. Returns the stop.
 */
export function startCopyKindsSync(kinds: readonly CopyKind<any>[], deps: CopyKindsDeps = {}): { stop: () => void } {
  if (isFollower() || kinds.length === 0) return { stop: () => {} }
  const id = ++schedulers
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  const dirty = new Set<string>()
  /** Kinds a follower held rows of, in any round since the retry was set: all go again with it. */
  const pendingHeld = new Set<string>()
  let running = false
  const round = async (): Promise<void> => {
    if (stopped || running || dirty.size === 0) return
    running = true
    try {
      while (!stopped && dirty.size > 0) {
        const want = kinds.filter((k) => dirty.has(k.kind))
        dirty.clear()
        const results = await syncCopyKinds(want, deps)
        for (const r of results) if ((r.held ?? 0) > 0) pendingHeld.add(r.kind)
        if (pendingHeld.size > 0 && !retry && !stopped) {
          retry = setTimeout(() => {
            retry = null
            for (const k of pendingHeld) dirty.add(k)
            pendingHeld.clear()
            void round()
          }, HELD_RETRY_MS)
          retry.unref?.()
        }
      }
    } catch (err) {
      log.session.warn('copies: scheduler round failed', { scheduler: id, error: err instanceof Error ? err.message : String(err) })
    } finally {
      running = false
    }
  }
  const soon = (kind?: string): void => {
    if (stopped) return
    for (const k of kind ? [kind] : kinds.map((x) => x.kind)) dirty.add(k)
    if (timer) return
    timer = setTimeout(() => { timer = null; void round() }, COPY_DEBOUNCE_MS)
    timer.unref?.()
  }
  copySoon = soon
  const unwatch = kinds.map((k) => k.watch(() => soon(k.kind)))
  let unlistenTargets: (() => void) | null = null
  void import('../replica-targets.js').then(({ onReplicaTargetsChanged }) => {
    if (!stopped) unlistenTargets = onReplicaTargetsChanged(() => soon())
  })
  const first = setTimeout(() => soon(), COPY_FIRST_ROUND_MS)
  first.unref?.()
  const sweep = setInterval(() => { forgetKindManifests(kinds.map((k) => k.kind)); soon() }, COPY_SWEEP_MS)
  sweep.unref?.()
  return {
    stop: () => {
      stopped = true
      if (copySoon === soon) copySoon = null
      for (const u of unwatch) { try { u() } catch { /* best effort */ } }
      unlistenTargets?.()
      if (timer) clearTimeout(timer)
      if (retry) clearTimeout(retry)
      clearTimeout(first)
      clearInterval(sweep)
    },
  }
}

/** Tests only: forget what every target took (the shortcut asks the digest again). */
export function _forgetCopyTakenForTesting(st: KindState): void {
  taken.delete(st)
}
