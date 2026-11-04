/// <reference types="vite/client" />
/**
 * /settings in pane mode: the nav on the left, ONE pane on the right. Only the
 * current pane's sections mount (its lead plus the navHidden sections folded
 * under it), so a pane that is not open makes no requests.
 *
 * The URL hash picks the pane (resolvePane): the router's hash and the native
 * hashchange both drive it, nav clicks and same-page `#x` links replace the
 * history entry (Back leaves Settings in one step), and a hash naming a folded
 * section opens its owner and holds that section in view for a bounded time.
 * On a phone it is two layers, list then pane (usePhoneSettingsPane).
 *
 * No plugin has a pane here: a plugin's settings panels live on its page in Apps
 * (PluginDetail). An old `#<plugin>:<panel>` link or bookmark, and `#plugin-store`,
 * forward to that page (settingsHashMovedTo).
 */
import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import type { Config } from '@open-walnut/core'
import { SettingsNav, useSettingsNavModel, type SettingsNavModel } from '@/components/settings/SettingsNav'
import { SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { SettingsBuildLine } from '@/components/settings/SettingsBuildLine'
import { hasStatusHosts } from '@/components/settings/diagnostics-copy'
import { SettingsPaneBack } from '@/components/settings/SettingsPaneBack'
import type { SaveSectionOptions } from '@/components/settings/core-settings-registry'
import {
  DEFAULT_PANE_ID,
  resolvePane,
  sectionsForPane,
  settingsHashMovedTo,
  tabParent,
} from '@/components/settings/settings-routing'
import {
  SettingsPaneProvider,
  SettingsPaneSkeleton,
  SettingsPaneStickyBar,
  saveErrorMessage,
  useSettingsSaveNotifier,
} from '@/components/settings/settings-pane-context'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import '@/plugins/dev-test-hooks'
import { log } from '@/utils/log'
import { usePhoneSettingsPane } from '@/components/settings/usePhoneSettingsPane'
import '@/styles/phone-settings.css'
import { announceSettingsAnchor } from '@/components/settings/settings-anchor-event'
import { recordVisit, settingsVisitKey } from '@/api/page-visits'

/** Any of these means the person took the wheel: hash anchoring lets go. */
const USER_TAKEOVER_EVENTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const

/** Under the 44px compact header, matching `scroll-margin-top: 52px`. */
const ANCHOR_MARGIN = 52

const SKELETON_DELAY_MS = 150

/**
 * Anchor hold: it ends once the content above the target has been still for
 * HOLD_QUIET_MS (and at least HOLD_MIN_MS in), never later than HOLD_MAX_MS.
 * Quiet-based rather than a flat 2s: under load a slow list above the target
 * can land after 2s and would otherwise push it out of view.
 */
const HOLD_MIN_MS = 2000
const HOLD_QUIET_MS = 1000
const HOLD_MAX_MS = 5000

// Dev-only: make one core section throw (the Playwright fixture runs Vite dev).
// The fake plugin panel and App hooks live in plugins/dev-test-hooks.
declare global {
  interface Window {
    __walnutSettingsCrash?: string
  }
}

function CrashProbe({ sectionId }: { sectionId: string }) {
  if (import.meta.env.DEV && typeof window !== 'undefined' && window.__walnutSettingsCrash === sectionId) {
    throw new Error(`Injected crash in ${sectionId}`)
  }
  return null
}

/** One section crashing shows its own shell and a retry; the rest of the page lives on. */
class SectionErrorBoundary extends Component<
  { sectionId: string; title: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    log.warn('settings', 'section crashed', { sectionId: this.props.sectionId, message: error.message })
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <SettingsSection id={this.props.sectionId} title={this.props.title} data-crashed="true">
        <SettingsGroup>
          <SettingsRow
            label="This section couldn't load."
            help={<code className="settings-crash-message" title={error.message}>{error.message}</code>}
            control={<SettingsButton onClick={() => this.setState({ error: null })}>Try again</SettingsButton>}
            data-testid="settings-section-crash"
          />
        </SettingsGroup>
      </SettingsSection>
    )
  }
}

/** Where the pane is (paneId) and which element it should hold in view. */
interface AnchorRequest {
  id: string
  /** `start`: under the compact header; `third`: a Find a setting row hit, a third down. */
  mode: 'start' | 'third'
  /** `strong`: a deep link from another page, where the person has not seen the
   *  pane yet, so the row pulses longer than a Find a setting hit flashes. */
  flash: boolean | 'strong'
}

/**
 * Scroll `id` into place inside `scroller` and keep it there while the content
 * above it is still growing: retry every 100ms (20x) until the element exists,
 * re-scroll whenever it drifts > 2px (checked every frame), stop once the
 * content above it has been still for a second (see HOLD_*), and let go at
 * once when the person scrolls or types.
 */
function holdAnchor(scroller: HTMLElement, req: AnchorRequest): () => void {
  // A section that folds this row away opens it now; the retries below then find it.
  announceSettingsAnchor(req.id)
  let stopped = false
  let el: HTMLElement | null = null
  let tries = 0
  let foundAt = 0
  let lastMoveAt = 0
  let stable = 0
  let lastPos: number | null = null
  let raf = 0
  const offset = () => (req.mode === 'start' ? ANCHOR_MARGIN : Math.round(scroller.clientHeight / 3))
  const viewTop = () => el!.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  const correct = () => {
    if (!el) return
    const d = viewTop() - offset()
    if (Math.abs(d) > 2) scroller.scrollTop += d
  }
  const frame = () => {
    if (stopped) return
    correct()
    raf = requestAnimationFrame(frame)
  }
  const stop = () => {
    stopped = true
    clearInterval(timer)
    cancelAnimationFrame(raf)
    for (const ev of USER_TAKEOVER_EVENTS) window.removeEventListener(ev, stop, true)
  }
  const check = () => {
    if (stopped) return
    const now = performance.now()
    if (!el) {
      el = document.getElementById(req.id)
      if (!el || !scroller.contains(el)) {
        el = null
        if (++tries >= 20) stop()
        return
      }
      foundAt = now
      lastMoveAt = now
      correct()
      if (req.flash) flashRow(el, req.flash === 'strong')
      raf = requestAnimationFrame(frame)
      return
    }
    // Position in the content (not the viewport): it moves only when content
    // above the target grows or shrinks, which is what the hold waits out.
    const pos = viewTop() + scroller.scrollTop
    if (lastPos !== null && Math.abs(pos - lastPos) > 1) {
      stable = 0
      lastMoveAt = now
    } else {
      stable += 1
    }
    lastPos = pos
    const quiet = now - lastMoveAt
    if ((stable >= 3 && quiet >= HOLD_QUIET_MS && now - foundAt >= HOLD_MIN_MS) || now - foundAt >= HOLD_MAX_MS) stop()
  }
  const timer = setInterval(check, 100)
  for (const ev of USER_TAKEOVER_EVENTS) window.addEventListener(ev, stop, { capture: true, passive: true })
  check()
  return stop
}

function flashRow(el: HTMLElement, strong = false) {
  const row = el.closest<HTMLElement>('.settings-row') ?? el
  const cls = strong ? 'settings-anchor-flash-strong' : 'settings-anchor-flash'
  row.classList.remove('settings-anchor-flash', 'settings-anchor-flash-strong')
  void row.offsetWidth
  row.classList.add(cls)
  window.setTimeout(() => row.classList.remove(cls), strong ? 3100 : 1300)
}

function ConfigErrorPane({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="settings-pane-state settings-pane-state-centered" data-testid="settings-config-error">
      <SettingsGroup>
        <SettingsRow
          label="Settings couldn't load."
          help={<code className="settings-config-error-message" title={message}>{message}</code>}
          control={<SettingsButton onClick={onRetry}>Try again</SettingsButton>}
        />
      </SettingsGroup>
    </div>
  )
}

export function SettingsPage() {
  const model = useSettingsNavModel()
  const location = useLocation()
  // Router navigations update location.hash; a native `#x` link (or code
  // setting window.location.hash) fires hashchange. Either one drives the pane.
  const [nativeHash, setNativeHash] = useState(() => window.location.hash)
  useEffect(() => {
    const onHash = () => setNativeHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => setNativeHash(window.location.hash), [location.hash])
  const hash = nativeHash
  // Plugins live on the Apps page: an old `#plugin-store` or `#<plugin>:<panel>` link (a
  // notification, a bookmark, a plugin's own link) lands on that plugin's page there.
  const movedTo = settingsHashMovedTo(hash)

  const resolved = useMemo(() => resolvePane(hash), [hash])
  const paneId = resolved.paneId

  // Local page-use counts (Settings > Page use): one visit per pane shown.
  const visitKey = movedTo ? null : settingsVisitKey(paneId)
  useEffect(() => { recordVisit(visitKey) }, [visitKey])

  // <Navigate>, not navigate() in a layout effect: on a first load that effect runs before
  // the router subscribes to history, so the URL changed and the screen stayed on Settings.
  if (movedTo) return <Navigate to={movedTo} replace />
  return (
    <SettingsPaneProvider paneId={paneId} leadSectionId={paneId} metaFor={model.metaFor}>
      <SettingsPageLayout model={model} paneId={paneId} targetId={resolved.targetId} rowTarget={!!resolved.row} hash={hash} />
    </SettingsPaneProvider>
  )
}

interface LayoutProps {
  model: SettingsNavModel
  paneId: string
  targetId: string | null
  /** `targetId` is one row reached by deep link (ROW_TARGETS): land it a third
   *  down and flash it, as a Find a setting hit does. */
  rowTarget: boolean
  hash: string
}

function SettingsPageLayout({ model, paneId, targetId, rowTarget, hash }: LayoutProps) {
  const { config, loading, error, saveSection, reload } = useSettingsConfig()
  const navigate = useNavigate()
  const { notifySaved, notifySaveFailed } = useSettingsSaveNotifier()
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const meta = model.metaFor(paneId) ?? model.metaFor(DEFAULT_PANE_ID)!

  // Saves are booked to the pane that was showing when the save STARTED:
  // the wrapper is rebuilt per pane, so a late result lands on its own pane.
  const paneSave = useMemo(() => {
    const pid = paneId
    return async (partial: Partial<Config>, opts?: SaveSectionOptions) => {
      try {
        await saveSection(partial)
        notifySaved(pid)
      } catch (err) {
        notifySaveFailed(pid, saveErrorMessage(err), opts?.rowKey)
        throw err
      }
    }
  }, [paneId, saveSection, notifySaved, notifySaveFailed])

  // Skeleton only after 150ms of waiting, so a fast config read never flashes one.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (config) return
    const t = setTimeout(() => setSlow(true), SKELETON_DELAY_MS)
    return () => clearTimeout(t)
  }, [config])

  const openPane = useCallback((id: string) => {
    navigate({ hash: `#${id}` }, { replace: true })
  }, [navigate])

  // Pending work from a nav open (focus the title, scroll to a filter row hit).
  const phoneOpen = useRef<() => void>(() => {})
  const pendingOpen = useRef<{ paneId: string; anchor: string | null; focusTitle: boolean } | null>(null)
  const [openSeq, setOpenSeq] = useState(0)
  const onOpenPane = useCallback((id: string, opts?: { anchor?: string | null; focusTitle?: boolean }) => {
    pendingOpen.current = { paneId: id, anchor: opts?.anchor ?? null, focusTitle: !!opts?.focusTitle }
    openPane(id)
    setOpenSeq((n) => n + 1)
    phoneOpen.current()
  }, [openPane])

  // Same-page `#x` links inside Settings behave like a nav click (replace, no reload).
  useEffect(() => {
    const root = layoutRef.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null
      if (!a || (a.target && a.target !== '_self')) return
      const href = a.getAttribute('href') ?? ''
      if (href.length < 2) return
      e.preventDefault()
      navigate({ hash: href }, { replace: true })
    }
    root.addEventListener('click', onClick)
    return () => root.removeEventListener('click', onClick)
  }, [navigate])

  // Cmd/Ctrl+S never opens the browser's save dialog; it submits the focused
  // settings form, else the pane's lead section when that one is a form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      const active = document.activeElement as HTMLElement | null
      const focused = active?.closest?.('form.settings-section') as HTMLFormElement | null
      const lead = document.getElementById(paneId)
      const form = focused ?? (lead instanceof HTMLFormElement && lead.classList.contains('settings-section') ? lead : null)
      form?.requestSubmit?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [paneId])

  // Document title follows the pane.
  useEffect(() => {
    const previous = document.title
    return () => { document.title = previous }
  }, [])
  // A tab is named by its entry (the tab bar names the tab): "Phones & Cloud" in the phone bar and the window.
  const titleLabel = model.metaFor(tabParent(paneId) ?? paneId)?.label ?? meta.label
  useEffect(() => {
    document.title = `Settings: ${titleLabel}`
  }, [titleLabel])

  // The phone's one bar holds the pane's actions once its header scrolled away (2026-11-04
  // review: at 700 px they made a second, button-only strip under the bar).
  const [phoneActions, setPhoneActions] = useState<HTMLElement | null>(null)
  const phoneBarAction = useMemo(() => <span ref={setPhoneActions} className="settings-phone-bar-actions" />, [])
  const phonePane = usePhoneSettingsPane(paneId, titleLabel, scroller, phoneBarAction)
  phoneOpen.current = phonePane.open

  // Switching panes starts at the top.
  useLayoutEffect(() => {
    if (scroller) scroller.scrollTop = 0
  }, [paneId, scroller])

  // A deep link to a folded section near the end of a short pane could never
  // reach the top; one viewport of room below it lets it, until the pane changes.
  const [anchorRoom, setAnchorRoom] = useState(0)
  useLayoutEffect(() => {
    setAnchorRoom(targetId && scroller ? scroller.clientHeight : 0)
  }, [targetId, scroller, paneId])

  const configReady = !!config
  const paneReady = configReady

  // A deep link to a folded section (or a lead) holds it in view while the pane settles.
  useEffect(() => {
    if (!scroller || !paneReady || !targetId) return
    return holdAnchor(scroller, rowTarget
      ? { id: targetId, mode: 'third', flash: 'strong' }
      : { id: targetId, mode: 'start', flash: false })
  }, [scroller, paneReady, targetId, rowTarget, hash])

  // After a nav open: focus the pane title (Enter in Find a setting) and scroll to a row hit.
  useEffect(() => {
    const pending = pendingOpen.current
    if (!pending || pending.paneId !== paneId || !scroller || !paneReady) return
    pendingOpen.current = null
    if (pending.focusTitle) {
      requestAnimationFrame(() => document.getElementById(`${paneId}-title`)?.focus({ preventScroll: true }))
    }
    if (pending.anchor) return holdAnchor(scroller, { id: pending.anchor, mode: 'third', flash: true })
  }, [openSeq, paneId, scroller, paneReady])

  let body: ReactNode = null
  let labelled = false
  if (!config && loading) {
    body = slow ? <SettingsPaneSkeleton meta={meta} /> : null
  } else if (!config) {
    body = error ? <ConfigErrorPane message={error} onRetry={() => { void reload() }} /> : null
  } else {
    labelled = true
    body = sectionsForPane(paneId).map((entry) => (
      <SectionErrorBoundary key={`${entry.owner}:${entry.id}`} sectionId={entry.id} title={entry.title}>
        <CrashProbe sectionId={entry.id} />
        {entry.render({ config, saveSection: paneSave, reload })}
      </SectionErrorBoundary>
    ))
  }

  return (
    <div className="settings-container">
      <div
        className="settings-layout"
        ref={layoutRef}
        data-phone-settings={phonePane.layer}
      >
        <SettingsNav model={model} activePane={paneId} onOpenPane={onOpenPane} />
        <div
          ref={setScroller}
          className="settings-pane settings-content"
          role="region"
          data-pane={paneId}
          aria-labelledby={labelled ? `${paneId}-title` : undefined}
          aria-label={labelled ? undefined : `Settings: ${titleLabel}`}
        >
          <SettingsPaneStickyBar phoneHost={phonePane.layer === 'pane' ? phoneActions : null} />
          <div className="settings-pane-inner" key={paneId}>
            <SettingsPaneBack paneId={paneId} metaFor={model.metaFor} />
            {body}
            {/* On Remote Hosts, while it has a host to report, its Copy diagnostics copies the hosts. */}
            {labelled && <SettingsBuildLine section={paneId === 'remote-hosts' && config && hasStatusHosts(config) ? 'hosts' : 'all'} />}
            {anchorRoom > 0 && <div className="settings-pane-anchor-room" aria-hidden="true" style={{ height: anchorRoom }} />}
          </div>
        </div>
      </div>
    </div>
  )
}
