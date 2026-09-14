/**
 * The update-status cache: network results remembered, local facts recomputed.
 *
 * `GET /api/plugin-updates` must answer in the time it takes to read a map, so the fetch
 * that discovers "3 commits behind" runs in the background, at most once per
 * `PLUGIN_UPDATE_MIN_INTERVAL_MS`, deduplicated per row, three at a time, with a deadline
 * per row and for the whole batch. What the cache KEEPS is only what a fetch produced
 * (the upstream commit, when, and the error if any). What the user can change by hand in
 * a linked checkout (a commit, a stash, a pull) is read again on every snapshot with
 * three no-network git commands, so the page never renders newer facts under an older
 * chip.
 *
 * Rules this file encodes:
 *
 *   - The file lives under TMP_DIR (`~/.open-walnut/tmp/`), never at the data root:
 *     git-sync commits the root every 30 s and mirrors it to every replica, and a
 *     last-writer-wins merge could then delete the cache from under the Mac. It holds
 *     row keys (hashes) and masked remote strings, never a checkout path.
 *   - A lock collision (`index.lock`, `cannot lock ref`) is not a state: the previous
 *     entry stays and the row is flagged `transient` so the client retries in 30 s.
 *   - Persistence failures warn and nothing else; a read-only disk must not turn a
 *     status page into a 500.
 *   - No synchronous child process, no blocking git: every command goes through the
 *     async `execGitArgsGroup` with a timeout.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { TMP_DIR } from '../../constants.js'
import { createSubsystemLogger } from '../../logging/index.js'
import type { CheckResult } from '../plugin-sources.js'
import type { LinkedCheckoutInfo, LinkedCheckoutStatus } from './linked-checkout.js'
import { maskMessage } from './linked-checkout.js'
import { readLocalFacts, type LocalFacts, type LocalFactsOptions } from './update-local-facts.js'
import {
  BATCH_DEADLINE_MS,
  CHECKOUT_MOVED_REASON,
  LOCAL_FACTS_DEADLINE_MS,
  PLUGIN_UPDATE_MIN_INTERVAL_MS,
  ROW_CHECK_DEADLINE_MS,
  ROW_TIMEOUT_REASON,
  classifyGitFailure,
  countsOf,
  deriveUpdateState,
  fetchEnv,
  npmToVersion,
  unreachableState,
  withDeadline,
  type GitFailureCause,
  type LastKnownKind,
  type PluginUpdatesResponse,
  type RawCheck,
  type UpdateKind,
  type UpdateState,
  type UpdateStatusRow,
} from './update-status.js'

const log = createSubsystemLogger('plugin-updates')

/** Re-exported so callers keep ONE import for the cache and the facts it recomputes. */
export { readLocalFacts, type LocalFacts, type LocalFactsOptions }

// ── Contracts ──

/**
 * One row's remembered NETWORK result: the whole persisted record. Never a checkout path;
 * remote strings already masked. Nothing a person can change by hand in a checkout lives
 * here: dirty, HEAD and the counts are read again on every snapshot (`readLocalFacts`).
 */
export interface CacheEntry {
  /** linked / git: the upstream commit sha at the last fetch. npm: the resolved `name@version`. */
  remoteRef: string | null
  /** When the last SUCCESSFUL check finished (the row's `checkedAt`). */
  fetchedAt: string | null
  /** linked / git: HEAD at the last fetch, the one comparison point the "checkout moved" rule needs (spec 5.1). */
  headAtFetch: string | null
  fetchError?: { cause: GitFailureCause; reason: string; detail: string }
}

/**
 * What the last check DERIVED for a row. In memory only, never persisted: a snapshot
 * recomputes it from local facts wherever it can (linked and git rows), and after a
 * restart a row without local facts (npm, or a clone the process cannot see) simply
 * reads `unchecked` until the background refresh lands.
 */
export interface RowMemo {
  state: UpdateState
  /** Kind of the last successful check; survives a failed one as `unreachable.lastKnown`. */
  lastKnown?: UpdateKind
  /** Masked raw text for the Details disclosure. */
  detail?: string
  /** The last check hit a git lock; the state above is the one before it. */
  transient?: boolean
}

export type UpdatableTarget =
  | { rowKey: string; kind: 'linked'; info: LinkedCheckoutInfo; pluginIds: string[] }
  | {
      rowKey: string
      kind: 'git' | 'npm'
      slug: string
      cloned: boolean
      pluginIds: string[]
      /** git: the clone directory, so local facts can be re-read against the cached upstream. */
      dir?: string
      /** npm: the `name@version` on disk right now, compared with the cached resolved one. */
      resolved?: string
    }

export interface UpdateCheckOps {
  checkLinked(info: LinkedCheckoutInfo, env: NodeJS.ProcessEnv): Promise<LinkedCheckoutStatus>
  checkSource(slug: string): Promise<CheckResult>
  readLocalFacts?(checkout: string, remoteRef: string, opts?: LocalFactsOptions): Promise<LocalFacts>
  now?(): number
}

export interface UpdateStatusCacheOptions {
  filePath?: string
  ops: UpdateCheckOps
  minIntervalMs?: number
  rowDeadlineMs?: number
  batchDeadlineMs?: number
  concurrency?: number
}

export const DEFAULT_CACHE_FILE = path.join(TMP_DIR, 'plugin-updates-cache.json')

/** A p-limit shaped gate: at most `n` bodies run at once, the rest wait in FIFO order. */
function semaphore(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    if (active >= n) return
    const run = queue.shift()
    if (run) run()
  }
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        active++
        fn().then(resolve, reject).finally(() => {
          active--
          next()
        })
      })
      next()
    })
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null
  for (const v of values) if (v && (!best || v > best)) best = v
  return best
}

// ── The cache ──

interface PersistedShape {
  version: 1
  lastBatchAt: string | null
  entries: Record<string, CacheEntry>
}

interface BatchStats {
  attempted: number
  failed: number
  networkFailed: number
}

export class UpdateStatusCache {
  readonly filePath: string
  private readonly ops: UpdateCheckOps
  private readonly minIntervalMs: number
  private readonly rowDeadlineMs: number
  private readonly batchDeadlineMs: number
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>
  private readonly entries = new Map<string, CacheEntry>()
  /** Derived per-row facts (state, lastKnown, detail, transient). Memory only; see RowMemo. */
  private readonly memos = new Map<string, RowMemo>()
  private readonly inFlightRows = new Map<string, Promise<UpdateStatusRow>>()
  private readonly busyKeys = new Set<string>()
  private batchInFlight: Promise<void> | null = null
  private lastBatchAt: string | null = null
  private lastBatch: BatchStats | null = null

  constructor(opts: UpdateStatusCacheOptions) {
    this.filePath = opts.filePath ?? DEFAULT_CACHE_FILE
    this.ops = opts.ops
    this.minIntervalMs = opts.minIntervalMs ?? PLUGIN_UPDATE_MIN_INTERVAL_MS
    this.rowDeadlineMs = opts.rowDeadlineMs ?? ROW_CHECK_DEADLINE_MS
    this.batchDeadlineMs = opts.batchDeadlineMs ?? BATCH_DEADLINE_MS
    this.limit = semaphore(opts.concurrency ?? 3)
  }

  private now(): number {
    return this.ops.now ? this.ops.now() : Date.now()
  }

  /** Read the persisted file. Absent is normal; unreadable only warns. */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await fsp.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('plugin update cache unreadable', { filePath: this.filePath, error: String(error) })
      }
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedShape>
      if (parsed.version !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return
      for (const [key, entry] of Object.entries(parsed.entries)) this.entries.set(key, entry)
      this.lastBatchAt = typeof parsed.lastBatchAt === 'string' ? parsed.lastBatchAt : null
    } catch (error) {
      log.warn('plugin update cache corrupt, ignoring', { filePath: this.filePath, error: String(error) })
    }
  }

  /** Write the file (tmp + rename). Failure warns; the in-memory map stays the truth. */
  async persist(): Promise<void> {
    const shape: PersistedShape = { version: 1, lastBatchAt: this.lastBatchAt, entries: Object.fromEntries(this.entries) }
    const tmp = `${this.filePath}.${process.pid}.tmp`
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true })
      await fsp.writeFile(tmp, JSON.stringify(shape, null, 2))
      await fsp.rename(tmp, this.filePath)
    } catch (error) {
      log.warn('plugin update cache not persisted', { filePath: this.filePath, error: String(error) })
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
    }
  }

  /** True when no batch ever ran, or the last one is older than the minimum interval. */
  isStale(): boolean {
    if (!this.lastBatchAt) return true
    return this.now() - Date.parse(this.lastBatchAt) > this.minIntervalMs
  }

  get refreshing(): boolean {
    return this.batchInFlight !== null || this.inFlightRows.size > 0
  }

  setBusy(rowKey: string, busy: boolean): void {
    if (busy) this.busyKeys.add(rowKey)
    else this.busyKeys.delete(rowKey)
  }

  /** The persisted network record plus the in-memory derived facts, as one read-only view. */
  entry(rowKey: string): (CacheEntry & Partial<RowMemo>) | undefined {
    const entry = this.entries.get(rowKey)
    const memo = this.memos.get(rowKey)
    if (!entry && !memo) return undefined
    return { ...(entry ?? { remoteRef: null, fetchedAt: null, headAtFetch: null }), ...(memo ?? {}) }
  }

  /** What an update would move the row to, for the chip tooltip: sha7 for git, the version for npm. */
  private static toRefOf(entry: CacheEntry | undefined, kind: 'linked' | 'git' | 'npm' | undefined, state: UpdateState): string | undefined {
    if (!entry?.remoteRef) return undefined
    const available = state.kind === 'available' || (state.kind === 'unreachable' && state.lastKnown === 'available')
    if (!available) return undefined
    return kind === 'npm' ? npmToVersion(entry.remoteRef) : entry.remoteRef.slice(0, 7)
  }

  private rowOf(rowKey: string, entry: CacheEntry | undefined, state: UpdateState, kind?: 'linked' | 'git' | 'npm'): UpdateStatusRow {
    const targetKind = kind ?? (rowKey.startsWith('linked:') ? 'linked' : undefined)
    const memo = this.memos.get(rowKey)
    const toRef = UpdateStatusCache.toRefOf(entry, targetKind, state)
    const detail = memo?.detail ?? entry?.fetchError?.detail
    return {
      state,
      checkedAt: entry?.fetchedAt ?? null,
      ...(targetKind ? { target: { kind: targetKind, ...(toRef ? { toRef } : {}) } } : {}),
      ...(detail ? { detail } : {}),
      ...(memo?.transient ? { transient: true } : {}),
      ...(this.busyKeys.has(rowKey) ? { busy: true } : {}),
    }
  }

  private baseEntry(rowKey: string): CacheEntry {
    return this.entries.get(rowKey) ?? { remoteRef: null, fetchedAt: null, headAtFetch: null }
  }

  /** The error text a raw check carries, if any (already credential-masked by the callers). */
  private static errorTextOf(raw: RawCheck): string | undefined {
    if (raw.kind === 'linked') return raw.status.fetched ? undefined : raw.status.reason
    return raw.result.error
  }

  /**
   * Fold a finished check into the cache and return the row. A lock collision keeps the
   * previous entry and flags the row transient instead of recording a failure.
   */
  recordCheck(rowKey: string, raw: RawCheck): UpdateStatusRow {
    const prev = this.entries.get(rowKey)
    const prevMemo = this.memos.get(rowKey)
    const errorText = UpdateStatusCache.errorTextOf(raw)
    const kind = raw.kind
    if (errorText && classifyGitFailure(errorText).cause === 'lock') {
      const kept: RowMemo = { ...(prevMemo ?? { state: { kind: 'unchecked' } }), transient: true, detail: maskMessage(errorText) }
      this.memos.set(rowKey, kept)
      return this.rowOf(rowKey, prev, kept.state, kind)
    }
    const state = deriveUpdateState(raw, prevMemo?.state)
    const failed = state.kind === 'unreachable'
    const entry: CacheEntry = {
      remoteRef: prev?.remoteRef ?? null,
      fetchedAt: failed ? prev?.fetchedAt ?? null : toIso(this.now()),
      headAtFetch: prev?.headAtFetch ?? null,
    }
    const memo: RowMemo = { state, lastKnown: failed ? (state.lastKnown ?? prevMemo?.lastKnown) : state.kind }
    if (raw.kind === 'linked') {
      if (raw.status.upstreamSha) entry.remoteRef = raw.status.upstreamSha
      if (raw.status.sha) entry.headAtFetch = raw.status.sha
    } else if (raw.kind === 'npm') {
      if (raw.result.resolved) entry.remoteRef = raw.result.resolved
    } else {
      if (raw.result.upstreamSha) entry.remoteRef = raw.result.upstreamSha
      if (raw.result.sha) entry.headAtFetch = raw.result.sha
    }
    if (failed && errorText) {
      const { cause } = classifyGitFailure(errorText)
      const detail = maskMessage(raw.kind === 'linked' ? errorText : (raw.result.detail ?? errorText))
      entry.fetchError = { cause, reason: state.reason, detail }
      memo.detail = detail
    }
    this.entries.set(rowKey, entry)
    this.memos.set(rowKey, memo)
    return this.rowOf(rowKey, entry, state, kind)
  }

  /** The row deadline passed: `unreachable` (timeout), last known answer kept. */
  private recordTimeout(rowKey: string, kind: 'linked' | 'git' | 'npm'): UpdateStatusRow {
    const prevMemo = this.memos.get(rowKey)
    const state = unreachableState('timeout', prevMemo?.state, ROW_TIMEOUT_REASON, prevMemo?.lastKnown as LastKnownKind | undefined)
    const entry: CacheEntry = {
      ...this.baseEntry(rowKey),
      fetchError: { cause: 'timeout', reason: ROW_TIMEOUT_REASON, detail: ROW_TIMEOUT_REASON },
    }
    this.entries.set(rowKey, entry)
    this.memos.set(rowKey, { state, lastKnown: prevMemo?.lastKnown, detail: ROW_TIMEOUT_REASON })
    return this.rowOf(rowKey, entry, state, kind)
  }

  /** An update landed: the row is current at `toRef` (full sha for linked and git, `name@version` for npm). */
  recordUpdated(rowKey: string, toRef: string): UpdateStatusRow {
    const prev = this.entries.get(rowKey)
    const isSha = /^[0-9a-f]{40}$/i.test(toRef)
    const entry: CacheEntry = {
      remoteRef: toRef || (prev?.remoteRef ?? null),
      fetchedAt: toIso(this.now()),
      headAtFetch: isSha ? toRef : prev?.headAtFetch ?? null,
    }
    this.entries.set(rowKey, entry)
    this.memos.set(rowKey, { state: { kind: 'current' }, lastKnown: 'current' })
    return this.rowOf(rowKey, entry, { kind: 'current' })
  }

  /** The update route just saw a dirty or diverged checkout; the row says so until the next snapshot recomputes. */
  recordRefusal(rowKey: string, code: 'dirty' | 'diverged'): UpdateStatusRow {
    const prevState = this.memos.get(rowKey)?.state
    const counts = countsOf(prevState)
    const behind = typeof counts.behind === 'number' ? counts.behind : null
    const ahead = typeof counts.ahead === 'number' ? counts.ahead : null
    const state: UpdateState = code === 'dirty'
      ? { kind: 'dirty', behind }
      : { kind: 'diverged', behind: behind ?? 1, ahead: ahead ?? 1 }
    this.memos.set(rowKey, { ...(this.memos.get(rowKey) ?? {}), state, lastKnown: code })
    return this.rowOf(rowKey, this.entries.get(rowKey), state)
  }

  private async runCheck(target: UpdatableTarget): Promise<RawCheck> {
    if (target.kind === 'linked') {
      try {
        await fsp.stat(target.info.checkout)
      } catch {
        return { kind: 'linked', status: { behind: null, ahead: null, dirty: false, sha: target.info.sha, branch: target.info.branch, fetched: false }, missing: true }
      }
      const status = await this.ops.checkLinked(target.info, fetchEnv())
      return { kind: 'linked', status }
    }
    const result = await this.ops.checkSource(target.slug)
    return { kind: target.kind, result, cloned: target.cloned }
  }

  /**
   * Check ONE row. A second call while the first is in flight gets the same promise, so
   * two fetches never race on the same `.git`. Bounded by the row deadline.
   */
  refreshRow(rowKey: string, target: UpdatableTarget): Promise<UpdateStatusRow> {
    const existing = this.inFlightRows.get(rowKey)
    if (existing) return existing
    const t0 = this.now()
    const TIMED_OUT = Symbol('timeout')
    const run = (async (): Promise<UpdateStatusRow> => {
      const work = this.runCheck(target).catch((error: unknown): RawCheck => {
        const message = maskMessage(error instanceof Error ? error.message : String(error))
        return target.kind === 'linked'
          ? { kind: 'linked', status: { behind: null, ahead: null, dirty: false, sha: target.info.sha, branch: target.info.branch, fetched: false, reason: message } }
          : { kind: target.kind, result: { behind: 0, updateAvailable: false, error: message, detail: message }, cloned: target.cloned }
      })
      const raw = await withDeadline<RawCheck | typeof TIMED_OUT>(work, this.rowDeadlineMs, () => TIMED_OUT)
      const row = raw === TIMED_OUT ? this.recordTimeout(rowKey, target.kind) : this.recordCheck(rowKey, raw)
      const state = row.state
      log.info('plugin update check', {
        rowKey,
        kind: target.kind,
        state: state.kind,
        behind: 'behind' in state ? state.behind : undefined,
        ahead: 'ahead' in state ? state.ahead : undefined,
        fetched: state.kind !== 'unreachable',
        transient: row.transient ?? false,
        ms: this.now() - t0,
      })
      return row
    })()
    this.inFlightRows.set(rowKey, run)
    void run.finally(() => {
      if (this.inFlightRows.get(rowKey) === run) this.inFlightRows.delete(rowKey)
    })
    return run
  }

  /**
   * Check every target, three at a time, one fetch per rowKey. Reuses the in-flight batch.
   * Without `force` a fresh cache is left alone. Rows still pending at the batch deadline
   * are recorded as timed out; their late results still land when they arrive.
   */
  refreshAll(targets: UpdatableTarget[], opts: { force?: boolean } = {}): Promise<void> {
    if (this.batchInFlight) return this.batchInFlight
    if (!opts.force && !this.isStale()) return Promise.resolve()
    const unique = new Map<string, UpdatableTarget>()
    for (const t of targets) if (!unique.has(t.rowKey)) unique.set(t.rowKey, t)
    const stats: BatchStats = { attempted: unique.size, failed: 0, networkFailed: 0 }
    const pending = new Set(unique.keys())
    const t0 = this.now()
    const batch = (async (): Promise<void> => {
      const rows = [...unique.values()].map((target) =>
        this.limit(() => this.refreshRow(target.rowKey, target)).then((row) => {
          // A row the batch deadline already wrote off is not counted twice.
          if (!pending.delete(target.rowKey)) return
          if (row.state.kind === 'unreachable') {
            stats.failed++
            if (row.state.cause === 'network') stats.networkFailed++
          }
        }),
      )
      await withDeadline(Promise.all(rows), this.batchDeadlineMs, () => {
        for (const key of pending) {
          const target = unique.get(key)!
          this.recordTimeout(key, target.kind)
          stats.failed++
        }
        return [] as void[]
      })
      this.lastBatchAt = toIso(this.now())
      this.lastBatch = stats
      log.info('plugin update batch done', { ...stats, ms: this.now() - t0 })
      await this.persist()
    })()
    this.batchInFlight = batch
    void batch.finally(() => {
      if (this.batchInFlight === batch) this.batchInFlight = null
    })
    return batch
  }

  /** The directory whose local facts describe a row: the linked checkout, or a git source's clone. */
  private static localDirOf(target: UpdatableTarget): string | undefined {
    if (target.kind === 'linked') return target.info.checkout
    return target.kind === 'git' && target.cloned ? target.dir : undefined
  }

  /**
   * Recompute the row from local facts against the cached upstream and re-derive. Null =
   * nothing local to read (npm, no upstream cached yet, or the read failed), in which case
   * the in-memory memo of the last check stands.
   */
  private async localState(target: UpdatableTarget, entry: CacheEntry): Promise<{ state: UpdateState; moved: boolean } | null> {
    if (target.kind === 'npm') {
      // npm has no local git facts: the row is current when what is on disk is what the
      // registry resolved to at the last check, and available otherwise.
      if (!entry.remoteRef || !target.resolved) return null
      const local: UpdateState = entry.remoteRef === target.resolved
        ? { kind: 'current' }
        : { kind: 'available', toVersion: npmToVersion(entry.remoteRef) }
      return { state: this.withFetchError(target.rowKey, entry, local), moved: false }
    }
    const dir = UpdateStatusCache.localDirOf(target)
    if (!dir || !entry.remoteRef) return null
    const read = this.ops.readLocalFacts ?? readLocalFacts
    const facts = await withDeadline(
      read(dir, entry.remoteRef, { headAtFetch: entry.headAtFetch, deadlineMs: LOCAL_FACTS_DEADLINE_MS }).catch(() => null),
      LOCAL_FACTS_DEADLINE_MS + 200,
      () => null,
    )
    if (!facts) return null
    if (facts.moved) return { state: { kind: 'unchecked', reason: CHECKOUT_MOVED_REASON }, moved: true }
    const status: LinkedCheckoutStatus = {
      behind: facts.behind,
      ahead: facts.ahead,
      // A source clone is Walnut's own tree: nobody edits it, so its dirtiness is not a state.
      dirty: target.kind === 'linked' ? facts.dirty : false,
      sha: facts.head,
      branch: target.kind === 'linked' ? target.info.branch : 'HEAD',
      fetched: true,
      upstreamSha: entry.remoteRef,
    }
    const local = deriveUpdateState({ kind: 'linked', status })
    return { state: this.withFetchError(target.rowKey, entry, local), moved: false }
  }

  /** A remembered fetch failure wraps the fresh local state as `unreachable`, counts and all. */
  private withFetchError(rowKey: string, entry: CacheEntry, local: UpdateState): UpdateState {
    if (!entry.fetchError) return local
    const memo = this.memos.get(rowKey)
    return unreachableState(entry.fetchError.cause, local, entry.fetchError.reason, memo?.lastKnown as LastKnownKind | undefined)
  }

  /**
   * What the page renders. Never waits on the network: rows without an entry read
   * `unchecked`, and a stale cache (or a moved checkout) kicks a background refresh whose
   * progress the response reports as `refreshing: true`.
   */
  async snapshot(targets: UpdatableTarget[], opts: { autoRefresh?: boolean } = {}): Promise<PluginUpdatesResponse> {
    const rows: Record<string, UpdateStatusRow> = {}
    const rowKeyOf: Record<string, string> = {}
    const needRefresh: UpdatableTarget[] = []
    const seen = new Map<string, UpdatableTarget>()
    for (const target of targets) {
      for (const id of target.pluginIds) rowKeyOf[id] = target.rowKey
      if (!seen.has(target.rowKey)) seen.set(target.rowKey, target)
    }
    for (const [rowKey, target] of seen) {
      // Rule 0 (spec 4, C47): a source whose directory is gone is `missing` before any
      // cache, memo or fetch error has a say. The memo of the last check said `current`
      // about files that no longer exist, and nothing here can fetch its way out of that.
      if (target.kind !== 'linked' && target.cloned === false) {
        rows[rowKey] = this.rowOf(rowKey, this.entries.get(rowKey), { kind: 'missing' }, target.kind)
        continue
      }
      const entry = this.entries.get(rowKey)
      if (!entry) {
        rows[rowKey] = this.rowOf(rowKey, undefined, { kind: 'unchecked' }, target.kind)
        needRefresh.push(target)
        continue
      }
      // Local facts first; the memo of the last check when there is nothing local to read;
      // and after a restart (entry on disk, no memo) a row without local facts is honest
      // about it: `unchecked`, refreshed in the background.
      const memo = this.memos.get(rowKey)
      let state: UpdateState = memo?.state ?? { kind: 'unchecked' }
      const local = await this.localState(target, entry)
      if (local) {
        state = local.state
        if (local.moved) needRefresh.push(target)
      } else if (!memo) {
        needRefresh.push(target)
      }
      rows[rowKey] = this.rowOf(rowKey, entry, state, target.kind)
    }
    if (opts.autoRefresh !== false) {
      if (this.isStale()) void this.refreshAll(targets).catch(() => undefined)
      else for (const target of needRefresh) void this.refreshRow(target.rowKey, target).catch(() => undefined)
    }
    const stats = this.lastBatch
    return {
      checkedAt: maxIso(Object.values(rows).map((row) => row.checkedAt)),
      minIntervalMs: this.minIntervalMs,
      refreshing: this.refreshing,
      rows,
      rowKeyOf,
      ...(stats ? {
        attempted: stats.attempted,
        failed: stats.failed,
        allNetworkFailed: stats.attempted > 0 && stats.networkFailed === stats.attempted,
      } : {}),
    }
  }
}
