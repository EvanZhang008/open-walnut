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
import { useLocation, useNavigate } from 'react-router-dom'
import type { Config } from '@open-walnut/core'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { SettingsNav, useSettingsNavModel, type SettingsNavModel } from '@/components/settings/SettingsNav'
import { SettingsGroup, SettingsRow, SettingsSection } from '@/components/settings/SettingsSection'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import type { SaveSectionOptions } from '@/components/settings/core-settings-registry'
import {
  DEFAULT_PANE_ID,
  isCorePane,
  pluginIdOfKey,
  resolvePane,
  sectionsForPane,
} from '@/components/settings/settings-routing'
import {
  SettingsPaneProvider,
  SettingsPaneSkeleton,
  SettingsPaneStickyBar,
  saveErrorMessage,
  useSettingsSaveNotifier,
} from '@/components/settings/settings-pane-context'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import { usePluginUi, useWebPluginRuntime } from '@/plugins/hooks'
import { pluginUiRegistry } from '@/plugins/registry'
import { appRegistry } from '@/apps/registry'
import { log } from '@/utils/log'

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

// Dev-only test hooks (the Playwright fixture runs Vite dev): register a fake
// plugin panel or app, or make one core section throw. Stripped from builds.
declare global {
  interface Window {
    __walnutSettingsCrash?: string
    __walnutSettingsTestHooks?: { pluginUiRegistry: typeof pluginUiRegistry; appRegistry: typeof appRegistry }
  }
}
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__walnutSettingsTestHooks = { pluginUiRegistry, appRegistry }
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
  flash: boolean
}

/**
 * Scroll `id` into place inside `scroller` and keep it there while the content
 * above it is still growing: retry every 100ms (20x) until the element exists,
 * re-scroll whenever it drifts > 2px (checked every frame), stop once the
 * content above it has been still for a second (see HOLD_*), and let go at
 * once when the person scrolls or types.
 */
function holdAnchor(scroller: HTMLElement, req: AnchorRequest): () => void {
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
      if (req.flash) flashRow(el)
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

function flashRow(el: HTMLElement) {
  const row = el.closest<HTMLElement>('.settings-row') ?? el
  row.classList.remove('settings-anchor-flash')
  void row.offsetWidth
  row.classList.add('settings-anchor-flash')
  window.setTimeout(() => row.classList.remove('settings-anchor-flash'), 1300)
}

type PaneView =
  | { kind: 'core'; paneId: string }
  | { kind: 'plugin'; paneId: string }
  | { kind: 'plugin-off'; paneId: string; pluginName: string; wentAway: boolean }
  | { kind: 'pending'; paneId: string }

/** A group standing in for a plugin panel that is not there (plugin off or gone). */
function PluginOffPane({ view, onOpenPlugins }: { view: Extract<PaneView, { kind: 'plugin-off' }>; onOpenPlugins: () => void }) {
  const text = view.wentAway
    ? `This panel went away because ${view.pluginName} is off.`
    : `This panel is from ${view.pluginName}, which is off.`
  return (
    <div className="settings-pane-state" data-testid="settings-plugin-off">
      <SettingsGroup>
        <SettingsRow label={text} control={<SettingsButton onClick={onOpenPlugins}>Open Plugins</SettingsButton>} />
      </SettingsGroup>
    </div>
  )
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
  const runtime = useWebPluginRuntime()
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

  const resolved = useMemo(
    () => resolvePane(hash, model.pluginKeys, { silent: !model.ready }),
    [hash, model.pluginKeys, model.ready],
  )

  // Plugin names seen this session, so a panel that disappears can say whose it was.
  const seenPlugins = useRef(new Map<string, string>())
  for (const [key, info] of model.pluginPanes) {
    seenPlugins.current.set(key, info.pluginName)
    seenPlugins.current.set(info.pluginId, info.pluginName)
  }

  const view: PaneView = useMemo(() => {
    if (resolved.known) return { kind: isCorePane(resolved.paneId) ? 'core' : 'plugin', paneId: resolved.paneId }
    const key = hash.replace(/^#/, '')
    const decoded = (() => { try { return decodeURIComponent(key) } catch { return key } })()
    const pluginId = pluginIdOfKey(decoded)
    const seenName = seenPlugins.current.get(decoded)
    if (seenName) return { kind: 'plugin-off', paneId: decoded, pluginName: seenName, wentAway: true }
    // Only a `<plugin>:<panel>` key can still turn up once the runtime answers.
    if (!model.ready && pluginId) return { kind: 'pending', paneId: DEFAULT_PANE_ID }
    if (pluginId) {
      const installed = runtime.plugins.some((p) => p.id === pluginId)
        || runtime.errors.some((p) => p.id === pluginId)
        || runtime.tombstones.some((p) => p.id === pluginId)
      if (installed) {
        return { kind: 'plugin-off', paneId: decoded, pluginName: seenPlugins.current.get(pluginId) ?? pluginId, wentAway: false }
      }
    }
    return { kind: 'core', paneId: DEFAULT_PANE_ID }
  }, [resolved, hash, model.ready, runtime.plugins, runtime.errors, runtime.tombstones])

  const leadSectionId = view.kind === 'core' || view.kind === 'plugin' ? view.paneId : null
  return (
    <SettingsPaneProvider paneId={view.paneId} leadSectionId={leadSectionId} metaFor={model.metaFor}>
      <SettingsPageLayout model={model} view={view} targetId={resolved.known ? resolved.targetId : null} hash={hash} />
    </SettingsPaneProvider>
  )
}

interface LayoutProps {
  model: SettingsNavModel
  view: PaneView
  targetId: string | null
  hash: string
}

function SettingsPageLayout({ model, view, targetId, hash }: LayoutProps) {
  const { config, loading, error, saveSection, reload } = useSettingsConfig()
  const pluginUi = usePluginUi()
  const navigate = useNavigate()
  const { notifySaved, notifySaveFailed } = useSettingsSaveNotifier()
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const paneId = view.paneId
  const meta = model.metaFor(view.kind === 'plugin-off' ? DEFAULT_PANE_ID : paneId) ?? model.metaFor(DEFAULT_PANE_ID)!

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
  const pendingOpen = useRef<{ paneId: string; anchor: string | null; focusTitle: boolean } | null>(null)
  const [openSeq, setOpenSeq] = useState(0)
  const onOpenPane = useCallback((id: string, opts?: { anchor?: string | null; focusTitle?: boolean }) => {
    pendingOpen.current = { paneId: id, anchor: opts?.anchor ?? null, focusTitle: !!opts?.focusTitle }
    openPane(id)
    setOpenSeq((n) => n + 1)
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
  const titleLabel = view.kind === 'plugin-off' ? view.pluginName : model.metaFor(paneId)?.label ?? meta.label
  useEffect(() => {
    document.title = `Settings: ${titleLabel}`
  }, [titleLabel])

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
  const paneReady = view.kind === 'plugin' || (view.kind === 'core' && configReady)

  // A deep link to a folded section (or a lead) holds it in view while the pane settles.
  useEffect(() => {
    if (!scroller || !paneReady || !targetId) return
    return holdAnchor(scroller, { id: targetId, mode: 'start', flash: false })
  }, [scroller, paneReady, targetId, hash])

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
  if (view.kind === 'plugin-off') {
    body = <PluginOffPane view={view} onOpenPlugins={() => openPane('plugin-store')} />
  } else if (view.kind === 'plugin') {
    const entry = pluginUi.settings.find((e) => e.key === paneId)
    if (entry) {
      const PluginSettings = entry.value.component
      labelled = true
      body = (
        <SettingsSection
          key={`${entry.key}:${entry.generation}`}
          id={entry.key}
          title={entry.value.label}
          description={`Provided by the ${entry.pluginName} plugin.`}
          className="plugin-settings-section"
          data-plugin-id={entry.pluginId}
        >
          <SettingsGroup className="settings-plugin-group">
            <div className="settings-plugin-body">
              <PluginBoundary pluginId={entry.pluginId} pluginName={entry.pluginName} resetKey={entry.generation}>
                <PluginSettings />
              </PluginBoundary>
            </div>
          </SettingsGroup>
        </SettingsSection>
      )
    }
  } else if (view.kind === 'pending') {
    // A hash that may name a plugin panel still registering: hold a quiet skeleton.
    body = <SettingsPaneSkeleton meta={meta} />
  } else if (!config && loading) {
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

  const activeNav = view.kind === 'pending' ? DEFAULT_PANE_ID : paneId
  return (
    <div className="settings-container">
      <div className="settings-layout" ref={layoutRef}>
        <SettingsNav model={model} activePane={activeNav} onOpenPane={onOpenPane} />
        <div
          ref={setScroller}
          className="settings-pane settings-content"
          role="region"
          data-pane={paneId}
          aria-labelledby={labelled ? `${paneId}-title` : undefined}
          aria-label={labelled ? undefined : `Settings: ${titleLabel}`}
        >
          <SettingsPaneStickyBar />
          <div className="settings-pane-inner" key={`${view.kind}:${paneId}`}>
            {body}
            {anchorRoom > 0 && <div className="settings-pane-anchor-room" aria-hidden="true" style={{ height: anchorRoom }} />}
          </div>
        </div>
      </div>
    </div>
  )
}
