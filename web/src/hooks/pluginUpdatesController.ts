/**
 * Client controller for Settings → Plugins update status. No React in here: the hook
 * (`usePluginUpdates`) subscribes through useSyncExternalStore, and the root vitest tier
 * (no jsdom) drives this module directly with fake timers and a counting fetch.
 *
 * Rules it encodes (spec 5.1, 6.1, 6.3):
 *  - ONE passive `GET /api/plugin-updates` per open, 10 s client deadline, one silent retry
 *    after 3 s, then `error: true` with the rows kept (the list never empties over this).
 *  - `refreshing: true` or HTTP 202 means the server is running a batch: poll every 2 s,
 *    at most 15 times, swap rows in place when it finishes; 15 misses = `error: true`.
 *  - `navigator.onLine === false` sends nothing (`offline: true`); `online` sends one GET.
 *  - visibilitychange (visible), window focus and a WS reconnect re-GET only when the
 *    newest `checkedAt` is older than the server's `minIntervalMs` (spec 8 rule 4, C60): a
 *    Mac app window stays open for days and the header must not read "Checked 1 h ago"
 *    with nothing ever re-read, but a window switch minutes after a check is not a reason
 *    to ask again. `online` always sends one GET (the chips were marked stale meanwhile).
 *    One GET at a time, and never two passive GETs within `PASSIVE_DEBOUNCE_MS` (focus and
 *    visibilitychange land together; `online` and the WS reconnect that follows it land
 *    seconds apart; browsers deliver `online` more than once).
 *  - `busy` is a Record per rowKey so two rows updating at once never share a label.
 */
import type { PluginUpdatesResponse, UpdateStatusRow } from '@/components/settings/plugin-update-types'
import { log } from '@/utils/log'

export type BusyKind = 'checking' | 'updating'
export type RowTarget = { kind: 'linked'; pluginId: string } | { kind: 'source'; slug: string }

export interface PluginUpdatesSnapshot {
  rows: Record<string, UpdateStatusRow>
  rowKeyOf: Record<string, string>
  /** Max checkedAt over rows (the header time). */
  checkedAt: string | null
  minIntervalMs: number
  refreshing: boolean
  loaded: boolean
  offline: boolean
  error: boolean
  busy: Record<string, BusyKind>
  attempted: number
  failed: number
  allNetworkFailed: boolean
}

export const PASSIVE_TIMEOUT_MS = 10_000
export const RETRY_DELAY_MS = 3_000
export const POLL_INTERVAL_MS = 2_000
export const POLL_MAX = 15
export const ROW_CHECK_TIMEOUT_MS = 20_000
export const TRANSIENT_RECHECK_MS = 30_000
export const DEFAULT_MIN_INTERVAL_MS = 10 * 60_000
/** Two passive GETs closer than this collapse into one (focus + visibilitychange, a doubled `online`, online + WS reconnect). */
export const PASSIVE_DEBOUNCE_MS = 5_000

export interface EventTargetLike {
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
}
export interface WindowLike extends EventTargetLike {
  document?: EventTargetLike & { visibilityState?: string }
  navigator?: { onLine?: boolean }
}
export interface WsClientLike {
  onConnectionChange(cb: (state: string) => void): void
  offConnectionChange(cb: (state: string) => void): void
}

export interface ControllerDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  /** Defaults to globalThis.window when present; pass null for a headless controller. */
  window?: WindowLike | null
  wsClient?: WsClientLike | null
  basePath?: string
}

export interface PluginUpdatesController {
  getSnapshot(): PluginUpdatesSnapshot
  subscribe(fn: () => void): () => void
  start(): void
  stop(): void
  /** Header Check now: every row busy, `GET ?refresh=1`, poll until the batch finishes. */
  checkAll(): Promise<void>
  /** Chip click: re-check ONE row through its action route and merge the result. */
  checkRow(rowKey: string, target: RowTarget): Promise<void>
  setBusy(rowKey: string, kind: BusyKind | null): void
  applyRow(rowKey: string, row: UpdateStatusRow, checkedAt?: string | null): void
  retry(): void
  /**
   * The set of rows changed (a source was added, removed or restored): one passive GET now,
   * polling as on open when the server is still checking the new row.
   */
  reload(): void
}

const EMPTY: PluginUpdatesSnapshot = {
  rows: {},
  rowKeyOf: {},
  checkedAt: null,
  minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
  refreshing: false,
  loaded: false,
  offline: false,
  error: false,
  busy: {},
  attempted: 0,
  failed: 0,
  allNetworkFailed: false,
}

const maxIso = (a: string | null, b: string | null): string | null => {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}

export function createPluginUpdatesController(deps: ControllerDeps = {}): PluginUpdatesController {
  const fetchImpl: typeof fetch = deps.fetchImpl ?? ((...args) => fetch(...args))
  const now = deps.now ?? (() => Date.now())
  const win: WindowLike | null = deps.window === undefined
    ? (typeof window !== 'undefined' ? (window as unknown as WindowLike) : null)
    : deps.window
  const wsClient = deps.wsClient ?? null
  const base = deps.basePath ?? '/api/plugin-updates'

  let snap: PluginUpdatesSnapshot = EMPTY
  const listeners = new Set<() => void>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let started = false
  let inFlight: AbortController | null = null
  let pollCount = 0
  let retried = false
  /** When the last passive (non-poll) GET started; the debounce clock. */
  let lastPassiveAt = Number.NEGATIVE_INFINITY
  /** Row keys marked busy=checking by checkAll; cleared when the batch ends. */
  const batchBusy = new Set<string>()
  const transientTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const set = (patch: Partial<PluginUpdatesSnapshot>) => {
    snap = { ...snap, ...patch }
    for (const fn of listeners) fn()
  }
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    timers.add(t)
    return t
  }
  const isOffline = () => win?.navigator?.onLine === false

  const setBusy = (rowKey: string, kind: BusyKind | null) => {
    const busy = { ...snap.busy }
    if (kind) busy[rowKey] = kind
    else delete busy[rowKey]
    set({ busy })
  }
  const clearBatchBusy = () => {
    if (batchBusy.size === 0) return
    const busy = { ...snap.busy }
    for (const key of batchBusy) if (busy[key] === 'checking') delete busy[key]
    batchBusy.clear()
    set({ busy })
  }

  const apply = (body: PluginUpdatesResponse) => {
    let checkedAt = body.checkedAt ?? null
    for (const row of Object.values(body.rows ?? {})) checkedAt = maxIso(checkedAt, row.checkedAt)
    set({
      rows: body.rows ?? {},
      rowKeyOf: body.rowKeyOf ?? {},
      checkedAt,
      minIntervalMs: body.minIntervalMs || DEFAULT_MIN_INTERVAL_MS,
      refreshing: body.refreshing === true,
      loaded: true,
      error: false,
      attempted: body.attempted ?? 0,
      failed: body.failed ?? 0,
      allNetworkFailed: body.allNetworkFailed === true,
    })
  }

  /**
   * ONE pending poll at a time. Two answers saying `refreshing: true` close together (a
   * reload after Add source and a Check now, both watching the same batch) used to arm two
   * timers, and the second fired one more GET AFTER the first had already seen the batch
   * finish: a trailing read that looked like a passive re-check nobody asked for.
   */
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const cancelPoll = () => {
    if (pollTimer === null) return
    clearTimeout(pollTimer)
    timers.delete(pollTimer)
    pollTimer = null
  }
  const schedulePoll = () => {
    cancelPoll()
    if (pollCount >= POLL_MAX) {
      // The server never said it finished: it is stuck, not slow. Keep the rows.
      log.warn('plugin-updates', 'batch never finished', { polls: pollCount })
      pollCount = 0
      set({ refreshing: false, error: true })
      clearBatchBusy()
      return
    }
    pollCount += 1
    pollTimer = later(POLL_INTERVAL_MS, () => { pollTimer = null; void get(false, true) })
  }

  /** One GET. `poll` marks a follow-up of an in-progress batch (no retry, no error flag). */
  const get = async (refresh: boolean, poll = false): Promise<boolean> => {
    if (!started) return false
    if (inFlight) inFlight.abort()
    const ctrl = new AbortController()
    inFlight = ctrl
    const deadline = later(PASSIVE_TIMEOUT_MS, () => ctrl.abort())
    const startedAt = now()
    if (!poll) lastPassiveAt = startedAt
    try {
      const res = await fetchImpl(refresh ? `${base}?refresh=1` : base, { signal: ctrl.signal })
      if (res.status === 202) {
        const body = (await res.json().catch(() => ({}))) as Partial<PluginUpdatesResponse>
        set({ refreshing: true, loaded: true, error: false, checkedAt: maxIso(snap.checkedAt, body.checkedAt ?? null) })
        schedulePoll()
        return true
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as PluginUpdatesResponse
      apply(body)
      retried = false
      if (body.refreshing) schedulePoll()
      else { cancelPoll(); pollCount = 0; clearBatchBusy() }
      log.info('plugin-updates', 'loaded', { refresh, poll, rows: Object.keys(body.rows ?? {}).length, ms: now() - startedAt })
      return true
    } catch (error) {
      // Superseded by a newer GET (or stopped): not a failure, just yield to it.
      if (ctrl.signal.aborted && (inFlight !== ctrl || !started)) return false
      log.warn('plugin-updates', 'load failed', { refresh, poll, error: error instanceof Error ? error.message : String(error) })
      if (poll) { schedulePoll(); return false }
      if (!retried && !refresh) {
        retried = true
        later(RETRY_DELAY_MS, () => { void get(false) })
        return false
      }
      retried = false
      set({ error: true, refreshing: false })
      clearBatchBusy()
      return false
    } finally {
      clearTimeout(deadline)
      timers.delete(deadline)
      if (inFlight === ctrl) inFlight = null
    }
  }

  const load = () => {
    if (isOffline()) { set({ offline: true }); return }
    if (snap.offline) set({ offline: false })
    void get(false)
  }

  /** No successful check yet, or the newest one is older than the server's interval. */
  const checkIsStale = () => !snap.checkedAt || now() - Date.parse(snap.checkedAt) > snap.minIntervalMs

  /**
   * Re-GET on visibility / focus / reconnect when the last check is older than the interval
   * (C60); `online` forces one. Never while a GET is in flight or within the debounce.
   */
  const maybeRefresh = (force = false) => {
    if (!started || isOffline() || inFlight) return
    if (now() - lastPassiveAt < PASSIVE_DEBOUNCE_MS) return
    if (!force && !checkIsStale()) return
    load()
  }

  const onVisibility = () => { if (win?.document?.visibilityState === 'visible') maybeRefresh() }
  const onFocus = () => maybeRefresh()
  const onOnline = () => { set({ offline: false }); maybeRefresh(true) }
  const onOffline = () => set({ offline: true })
  let wsWasConnected: boolean | null = null
  const onWs = (state: string) => {
    const connected = state === 'connected'
    if (connected && wsWasConnected === false) maybeRefresh()
    wsWasConnected = connected
  }

  const rowUrl = (target: RowTarget): string => target.kind === 'linked'
    ? `/api/plugin-runtime/${encodeURIComponent(target.pluginId)}/linked/check`
    : `/api/plugin-sources/${encodeURIComponent(target.slug)}/check`

  const applyRow = (rowKey: string, row: UpdateStatusRow, checkedAt?: string | null) => {
    const at = checkedAt === undefined ? row.checkedAt : checkedAt
    const next = { ...row, checkedAt: at ?? row.checkedAt ?? null }
    set({ rows: { ...snap.rows, [rowKey]: next }, checkedAt: maxIso(snap.checkedAt, next.checkedAt) })
  }

  const checkRow = async (rowKey: string, target: RowTarget): Promise<void> => {
    if (snap.busy[rowKey]) return
    setBusy(rowKey, 'checking')
    const ctrl = new AbortController()
    const deadline = later(ROW_CHECK_TIMEOUT_MS, () => ctrl.abort())
    const startedAt = now()
    try {
      const res = await fetchImpl(rowUrl(target), { method: 'POST', signal: ctrl.signal })
      const body = (await res.json().catch(() => null)) as (Partial<UpdateStatusRow> & { error?: string }) | null
      if (!body?.state) throw new Error(body?.error ?? `HTTP ${res.status}`)
      const prev = snap.rows[rowKey]
      // `checkedAt` is the last SUCCESSFUL comparison (the stale chip's "Last checked"): a
      // failed check keeps the previous stamp, and never invents "just now" for itself.
      const checkedAt = body.checkedAt
        ?? (body.state.kind === 'unreachable' ? (prev?.checkedAt ?? null) : new Date(now()).toISOString())
      applyRow(rowKey, {
        ...prev,
        state: body.state,
        checkedAt,
        ...(body.target ? { target: body.target } : {}),
        ...(body.detail !== undefined ? { detail: body.detail } : {}),
        transient: body.transient === true,
      })
      log.info('plugin-updates', 'check', { rowKey, kind: body.state.kind, ms: now() - startedAt })
      if (body.transient && !transientTimers.has(rowKey)) {
        // A lock collision is momentary; one automatic re-check, never a loop.
        const t = later(TRANSIENT_RECHECK_MS, () => { transientTimers.delete(rowKey); void checkRow(rowKey, target) })
        transientTimers.set(rowKey, t)
      }
    } catch (error) {
      log.warn('plugin-updates', 'check failed', { rowKey, kind: target.kind, error: error instanceof Error ? error.message : String(error) })
    } finally {
      clearTimeout(deadline)
      timers.delete(deadline)
      setBusy(rowKey, null)
    }
  }

  const checkAll = async (): Promise<void> => {
    if (!started || isOffline()) return
    const busy = { ...snap.busy }
    for (const key of Object.keys(snap.rows)) {
      if (!busy[key]) { busy[key] = 'checking'; batchBusy.add(key) }
    }
    pollCount = 0
    set({ busy, refreshing: true, error: false })
    await get(true)
  }

  const start = () => {
    if (started) return
    started = true
    win?.addEventListener('focus', onFocus)
    win?.addEventListener('online', onOnline)
    win?.addEventListener('offline', onOffline)
    win?.document?.addEventListener('visibilitychange', onVisibility)
    wsClient?.onConnectionChange(onWs)
    load()
  }

  const stop = () => {
    if (!started) return
    started = false
    win?.removeEventListener('focus', onFocus)
    win?.removeEventListener('online', onOnline)
    win?.removeEventListener('offline', onOffline)
    win?.document?.removeEventListener('visibilitychange', onVisibility)
    wsClient?.offConnectionChange(onWs)
    inFlight?.abort()
    inFlight = null
    for (const t of timers) clearTimeout(t)
    timers.clear()
    pollTimer = null
    transientTimers.clear()
    batchBusy.clear()
    pollCount = 0
    retried = false
    if (Object.keys(snap.busy).length || snap.refreshing) set({ busy: {}, refreshing: false })
  }

  const retry = () => { retried = true; set({ error: false }); load() }
  const reload = () => { if (started) load() }

  return {
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    start, stop, checkAll, checkRow, setBusy, applyRow, retry, reload,
  }
}
