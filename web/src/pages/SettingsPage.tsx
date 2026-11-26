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
import { holdAnchor } from '@/components/settings/hold-anchor'
import { recordVisit, settingsVisitKey } from '@/api/page-visits'
import { rememberLocation } from '@/utils/last-location'
import { useSettingsGutter } from '@/components/settings/useSettingsGutter'

const SKELETON_DELAY_MS = 150

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
            help={<code className="settings-crash-message">{error.message}</code>}
            control={<SettingsButton onClick={() => this.setState({ error: null })}>Try again</SettingsButton>}
            data-testid="settings-section-crash"
          />
        </SettingsGroup>
      </SettingsSection>
    )
  }
}

function ConfigErrorPane({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="settings-pane-state settings-pane-state-centered" data-testid="settings-config-error">
      <SettingsGroup>
        <SettingsRow
          label="Settings couldn't load."
          help={<code className="settings-config-error-message">{message}</code>}
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
  // The router's hash, not the window's: in an app's own window (popout/PopoutAppView.tsx)
  // Settings has a router of its own and the window's address never changes.
  const [nativeHash, setNativeHash] = useState(() => location.hash)
  useEffect(() => {
    const onHash = () => setNativeHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  useEffect(() => setNativeHash(location.hash), [location.hash])
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
  // The nav list and pane keep their scrollbar gutter out of their own right padding (settings-nav.css).
  const containerRef = useRef<HTMLDivElement>(null)
  useSettingsGutter(containerRef)
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

  const { pathname, search } = useLocation()
  const openPane = useCallback((id: string) => {
    navigate({ hash: `#${id}` }, { replace: true })
    // Kept for the sidebar link now, not when the new pane commits: a router navigation renders
    // in a transition, and a click away (Home) before a heavy pane finishes drops that render,
    // so App's record of the committed location never saw this pane.
    rememberLocation({ pathname, search, hash: `#${id}` })
  }, [navigate, pathname, search])

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
    <div className="settings-container" ref={containerRef}>
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
