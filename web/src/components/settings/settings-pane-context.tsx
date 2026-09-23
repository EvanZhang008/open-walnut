/**
 * Pane-scoped state for /settings: which pane is showing, its header metadata,
 * the compact sticky header, and the `Saved` / `Not saved` feedback.
 *
 * Saves are booked by pane id captured when the save STARTED (not when it
 * resolves): a save that lands after the user switched panes must never flash
 * `Saved` on the pane now showing. A late success is dropped; a late failure
 * marks that pane's nav entry (useFailedPanes) and is replayed as a row error
 * (useRowFailure) the next time that pane opens.
 *
 * Every hook is a safe no-op outside a SettingsPaneProvider, so sections keep
 * rendering in tests and in any host that does not mount the provider.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AlertGlyph, CheckGlyph } from './settings-glyphs'
import '@/styles/settings-shell.css'
import '@/styles/settings-controls.css'

export interface SettingsPaneMeta {
  id: string
  label: string
  title: string
  description: string
  icon: ReactNode
  tint: string
  glyph: string
}

// ---------------------------------------------------------------------------
// Saved indicator state machine (pure, unit tested)
// ---------------------------------------------------------------------------

export const SAVED_FADE_IN_MS = 120
export const SAVED_HOLD_MS = 2000
export const SAVED_FADE_OUT_MS = 200
export const FAILED_HOLD_MS = 6000

export interface SavedStatus {
  kind: 'saved' | 'failed'
  /** Server error text for a failure (shown as the indicator's title). */
  message?: string
  /** True during the 200ms fade before the element leaves the DOM. */
  leaving: boolean
  /** Bumped on every notification so stale timers can be ignored. */
  seq: number
}

export type SavedEvent =
  | { type: 'success' }
  | { type: 'failure'; message: string }
  | { type: 'expire'; seq: number }
  | { type: 'removed'; seq: number }
  | { type: 'reset' }

export function savedStatusReducer(state: SavedStatus | null, event: SavedEvent): SavedStatus | null {
  const nextSeq = (state?.seq ?? 0) + 1
  switch (event.type) {
    case 'success':
      // A re-save inside the hold window restarts the timer without a flash:
      // the element stays mounted (same kind), only the seq moves.
      return { kind: 'saved', leaving: false, seq: nextSeq }
    case 'failure':
      return { kind: 'failed', message: event.message, leaving: false, seq: nextSeq }
    case 'expire':
      if (!state || state.seq !== event.seq || state.leaving) return state
      return { ...state, leaving: true }
    case 'removed':
      if (!state || state.seq !== event.seq || !state.leaving) return state
      return null
    case 'reset':
      return null
  }
}

/** How long the current phase lasts before the next timer event fires. */
export function savedStatusDelay(status: SavedStatus): number {
  if (status.leaving) return SAVED_FADE_OUT_MS
  return status.kind === 'saved' ? SAVED_FADE_IN_MS + SAVED_HOLD_MS : FAILED_HOLD_MS
}

/** The event the pending timer should dispatch for `status`. */
export function savedStatusTimerEvent(status: SavedStatus): SavedEvent {
  return status.leaving ? { type: 'removed', seq: status.seq } : { type: 'expire', seq: status.seq }
}

/** Error text for an unknown thrown value. */
export function saveErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err) return err
  return 'Unknown error'
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface PaneContextValue {
  paneId: string | null
  leadSectionId: string | null
  metaFor: (sectionId: string) => SettingsPaneMeta | undefined
  compact: boolean
  status: SavedStatus | null
  failedPanes: ReadonlySet<string>
  /** Row failures stored per pane, keyed by rowKey. */
  rowFailures: Readonly<Record<string, Readonly<Record<string, string>>>>
  notifySaved: (paneId: string) => void
  notifySaveFailed: (paneId: string, message: string, rowKey?: string) => void
  clearRowFailure: (paneId: string, rowKey: string) => void
  setLeadHeader: (el: HTMLElement | null) => void
  leadHeader: HTMLElement | null
  setCompact: (compact: boolean) => void
  stickyActionsHost: HTMLElement | null
  setStickyActionsHost: (el: HTMLElement | null) => void
}

const PaneContext = createContext<PaneContextValue | null>(null)

const EMPTY_SET: ReadonlySet<string> = new Set()
const noMeta = () => undefined

/** Pure helpers for the failure book (unit tested). */
export function withRowFailure(
  book: Readonly<Record<string, Readonly<Record<string, string>>>>,
  paneId: string,
  rowKey: string,
  message: string,
): Record<string, Record<string, string>> {
  return { ...book, [paneId]: { ...(book[paneId] ?? {}), [rowKey]: message } }
}

export function withoutRowFailure(
  book: Readonly<Record<string, Readonly<Record<string, string>>>>,
  paneId: string,
  rowKey: string,
): Readonly<Record<string, Readonly<Record<string, string>>>> {
  const rows = book[paneId]
  if (!rows || !(rowKey in rows)) return book
  const { [rowKey]: _dropped, ...rest } = rows
  return { ...book, [paneId]: rest }
}

export interface SettingsPaneProviderProps {
  paneId: string | null
  leadSectionId: string | null
  metaFor: (sectionId: string) => SettingsPaneMeta | undefined
  children?: ReactNode
}

export function SettingsPaneProvider({ paneId, leadSectionId, metaFor, children }: SettingsPaneProviderProps) {
  const [status, dispatch] = useReducer(savedStatusReducer, null)
  const [compact, setCompact] = useState(false)
  const [failedPanes, setFailedPanes] = useState<ReadonlySet<string>>(EMPTY_SET)
  const [rowFailures, setRowFailures] = useState<PaneContextValue['rowFailures']>({})
  const [leadHeader, setLeadHeader] = useState<HTMLElement | null>(null)
  const [stickyActionsHost, setStickyActionsHost] = useState<HTMLElement | null>(null)
  // A pane-level failure (no rowKey) that landed while its pane was hidden:
  // replayed as `Not saved` when the pane opens again.
  const pendingPaneFailure = useRef(new Map<string, string>())
  const currentPane = useRef(paneId)
  currentPane.current = paneId

  // Pane switch: the indicator belongs to the pane that was showing, and the
  // error dot of the pane now opening is cleared (its row errors take over).
  useEffect(() => {
    dispatch({ type: 'reset' })
    setCompact(false)
    if (!paneId) return
    setFailedPanes((prev) => {
      if (!prev.has(paneId)) return prev
      const next = new Set(prev)
      next.delete(paneId)
      return next
    })
    const replay = pendingPaneFailure.current.get(paneId)
    if (replay !== undefined) {
      pendingPaneFailure.current.delete(paneId)
      dispatch({ type: 'failure', message: replay })
    }
  }, [paneId])

  useEffect(() => {
    if (!status) return
    const t = setTimeout(() => dispatch(savedStatusTimerEvent(status)), savedStatusDelay(status))
    return () => clearTimeout(t)
  }, [status])

  const notifySaved = useCallback((pid: string) => {
    if (pid !== currentPane.current) return // a late success for a hidden pane is dropped
    dispatch({ type: 'success' })
  }, [])

  const notifySaveFailed = useCallback((pid: string, message: string, rowKey?: string) => {
    if (rowKey) setRowFailures((book) => withRowFailure(book, pid, rowKey, message))
    if (pid === currentPane.current) {
      dispatch({ type: 'failure', message })
      return
    }
    if (!rowKey) pendingPaneFailure.current.set(pid, message)
    setFailedPanes((prev) => (prev.has(pid) ? prev : new Set(prev).add(pid)))
  }, [])

  const clearRowFailure = useCallback((pid: string, rowKey: string) => {
    setRowFailures((book) => withoutRowFailure(book, pid, rowKey))
  }, [])

  const value = useMemo<PaneContextValue>(
    () => ({
      paneId,
      leadSectionId,
      metaFor,
      compact,
      status,
      failedPanes,
      rowFailures,
      notifySaved,
      notifySaveFailed,
      clearRowFailure,
      setLeadHeader,
      leadHeader,
      setCompact,
      stickyActionsHost,
      setStickyActionsHost,
    }),
    [paneId, leadSectionId, metaFor, compact, status, failedPanes, rowFailures, notifySaved,
      notifySaveFailed, clearRowFailure, leadHeader, stickyActionsHost],
  )
  return <PaneContext.Provider value={value}>{children}</PaneContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const NOOP = () => {}

export function useSettingsPane() {
  const ctx = useContext(PaneContext)
  return {
    paneId: ctx?.paneId ?? null,
    leadSectionId: ctx?.leadSectionId ?? null,
    metaFor: ctx?.metaFor ?? noMeta,
    compact: ctx?.compact ?? false,
  }
}

/** Internal: chrome hooks for SettingsSection and the sticky bar. */
export function useSettingsPaneChrome() {
  const ctx = useContext(PaneContext)
  return {
    inProvider: ctx !== null,
    setLeadHeader: ctx?.setLeadHeader ?? NOOP,
    leadHeader: ctx?.leadHeader ?? null,
    setCompact: ctx?.setCompact ?? NOOP,
    stickyActionsHost: ctx?.stickyActionsHost ?? null,
    setStickyActionsHost: ctx?.setStickyActionsHost ?? NOOP,
  }
}

/**
 * Save feedback bound to the pane this component rendered in. `track` wraps a
 * write promise: success -> Saved, rejection -> Not saved (+ row failure when
 * rowKey is given) and the rejection is rethrown so callers keep their flow.
 */
export function useSettingsSaved() {
  const ctx = useContext(PaneContext)
  const paneId = ctx?.paneId ?? null
  const notify = ctx?.notifySaved
  const notifyFail = ctx?.notifySaveFailed
  return useMemo(() => {
    const notifySaved = () => {
      if (paneId && notify) notify(paneId)
    }
    const notifySaveFailed = (message: string, rowKey?: string) => {
      if (paneId && notifyFail) notifyFail(paneId, message, rowKey)
    }
    const track = <T,>(p: Promise<T>, rowKey?: string): Promise<T> =>
      p.then(
        (v) => {
          notifySaved()
          return v
        },
        (err: unknown) => {
          notifySaveFailed(saveErrorMessage(err), rowKey)
          throw err
        },
      )
    return { paneId, notifySaved, notifySaveFailed, track }
  }, [paneId, notify, notifyFail])
}

/** For the page: wrap saveSection with the pane id captured at call time. */
export function useSettingsSaveNotifier() {
  const ctx = useContext(PaneContext)
  const notify = ctx?.notifySaved
  const notifyFail = ctx?.notifySaveFailed
  return useMemo(
    () => ({
      notifySaved: (paneId: string) => notify?.(paneId),
      notifySaveFailed: (paneId: string, message: string, rowKey?: string) =>
        notifyFail?.(paneId, message, rowKey),
    }),
    [notify, notifyFail],
  )
}

export function useFailedPanes(): ReadonlySet<string> {
  return useContext(PaneContext)?.failedPanes ?? EMPTY_SET
}

/**
 * A failure stored for `rowKey` on the current pane (a save that failed while
 * the pane was hidden, or one reported through the page notifier). Stays until
 * clear() is called: row errors never time out, so rows below never jump.
 */
export function useRowFailure(rowKey: string | undefined): [string | null, () => void] {
  const ctx = useContext(PaneContext)
  const paneId = ctx?.paneId ?? null
  const message = paneId && rowKey ? ctx?.rowFailures[paneId]?.[rowKey] ?? null : null
  const clearFn = ctx?.clearRowFailure
  const clear = useCallback(() => {
    if (paneId && rowKey && clearFn) clearFn(paneId, rowKey)
  }, [paneId, rowKey, clearFn])
  return [message, clear]
}

// ---------------------------------------------------------------------------
// Visible pieces
// ---------------------------------------------------------------------------

/**
 * `Saved` / `Not saved`. Exactly one instance exists in the DOM: the header
 * renders it with placement="header", the sticky bar with placement="sticky",
 * and only the one matching the compact state renders anything.
 */
export function SettingsSavedIndicator({ placement = 'header' }: { placement?: 'header' | 'sticky' }) {
  const ctx = useContext(PaneContext)
  if (!ctx?.status) return null
  if ((placement === 'sticky') !== ctx.compact) return null
  const { kind, message, leaving } = ctx.status
  return (
    <span
      data-testid="settings-saved-indicator"
      role="status"
      aria-live="polite"
      data-state={kind}
      title={kind === 'failed' ? message : undefined}
      className={`settings-saved-indicator is-${kind}${leaving ? ' is-leaving' : ''}`}
    >
      {kind === 'saved' ? (
        <>
          <CheckGlyph size={12} className="settings-saved-glyph" />
          Saved
        </>
      ) : (
        <>
          <AlertGlyph size={12} className="settings-saved-glyph" />
          Not saved
        </>
      )}
    </span>
  )
}

/** True when the lead header has scrolled up under the sticky bar. */
export function isHeaderAboveBar(headerBottom: number, rootTop: number, barHeight = 44): boolean {
  return headerBottom <= rootTop + barHeight
}

/**
 * Compact header. P2 places it as the FIRST child of the scroller
 * `.settings-pane`. Zero height in flow, so showing it never pushes content.
 * Driven by an IntersectionObserver on the lead header (no scroll listener).
 */
export function SettingsPaneStickyBar() {
  const ctx = useContext(PaneContext)
  const barRef = useRef<HTMLDivElement>(null)
  const leadHeader = ctx?.leadHeader ?? null
  const setCompact = ctx?.setCompact
  const compact = ctx?.compact ?? false

  useEffect(() => {
    if (!setCompact) return
    const bar = barRef.current
    if (!leadHeader || !bar || typeof IntersectionObserver === 'undefined') {
      setCompact(false)
      return
    }
    const root = bar.closest('.settings-pane')
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (!entry) return
        const rootTop = entry.rootBounds?.top ?? 0
        // rootMargin already trims the bar's 44px, so "not intersecting and
        // above" means the header is fully under or past the bar.
        setCompact(!entry.isIntersecting && isHeaderAboveBar(entry.boundingClientRect.bottom, rootTop, 0))
      },
      { root, rootMargin: '-44px 0px 0px 0px', threshold: 0 },
    )
    io.observe(leadHeader)
    return () => {
      io.disconnect()
      setCompact(false)
    }
  }, [leadHeader, setCompact])

  if (!ctx) return null
  const meta = ctx.leadSectionId ? ctx.metaFor(ctx.leadSectionId) : undefined
  return (
    <div ref={barRef} className={`settings-pane-stickybar${compact ? ' is-compact' : ''}`}>
      <div className="settings-pane-stickybar-inner" aria-hidden={compact ? undefined : true} inert={!compact}>
        <span className="settings-pane-stickybar-title">{meta?.title ?? meta?.label ?? ''}</span>
        <div className="settings-pane-stickybar-trailing">
          <SettingsSavedIndicator placement="sticky" />
          <div className="settings-pane-stickybar-actions settings-card-actions" ref={ctx.setStickyActionsHost} />
        </div>
      </div>
    </div>
  )
}

/** The pane header tile: 40px (header) or 20px (nav) square with the glyph. */
export function SettingsPaneTile({ meta, size = 40 }: { meta: SettingsPaneMeta; size?: 20 | 40 }) {
  return (
    <span
      className={`settings-pane-tile settings-pane-tile-${size}`}
      style={{ background: meta.tint }}
      data-glyph={meta.glyph}
      aria-hidden="true"
    >
      {meta.icon}
    </span>
  )
}

/** Pane placeholder while config loads: real header from meta + 3 quiet blocks. */
export function SettingsPaneSkeleton({ meta }: { meta: SettingsPaneMeta }) {
  return (
    <div className="settings-pane-skeleton" data-testid="settings-pane-skeleton" aria-busy="true">
      <header className="settings-pane-header">
        <SettingsPaneTile meta={meta} />
        <div className="settings-pane-heading">
          <h2 className="settings-pane-title" id={`${meta.id}-title`} tabIndex={-1}>
            {meta.title}
          </h2>
          {meta.description && <p className="settings-pane-desc">{meta.description}</p>}
        </div>
      </header>
      {[44, 132, 88].map((h) => (
        <div key={h} className="settings-skeleton-group" style={{ height: h }} aria-hidden="true">
          <span className="settings-skeleton-bar" />
          <span className="settings-skeleton-bar settings-skeleton-bar-short" />
        </div>
      ))}
    </div>
  )
}
