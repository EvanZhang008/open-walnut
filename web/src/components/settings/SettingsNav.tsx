/**
 * The settings sidebar: `Settings` title, Find a setting, and four groups
 * (Manage / Plugins / Configure / Diagnostics; the heading uses the same word
 * as the Plugins pane and the Plugins page, never a synonym). One pane shows at
 * a time; a nav click only changes the hash (replace), SettingsPage mounts that
 * pane.
 *
 * Off-page links (Agents, Skills, Commands, Memory, settings-placed plugin
 * apps) route away and carry an arrow-up-right mark. Plugin rows arrive
 * asynchronously, so until the plugin runtime is ready the Plugins group
 * renders as many quiet placeholders as last time (localStorage) and the
 * Configure group does not jump when the real rows land.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { usePluginUi, useWebPluginRuntime } from '@/plugins/hooks'
import { CORE_SETTINGS_CONTRIBUTIONS, type CoreSettingsContribution } from './core-settings-registry'
import { corePaneFilterEntry } from './settings-routing'
import { compareHits, filterEntries, primaryHit, PAGE_LINK_KEYWORDS, type FilterEntry, type FilterHit } from './settings-filter'
import { SettingsIcon, assignPluginTint, monogramFor, tileKey, type SettingsGlyphName } from './settings-icons'
import { SettingsPaneTile, useFailedPanes, type SettingsPaneMeta } from './settings-pane-context'
import '@/styles/settings-nav.css'
import '@/styles/settings-nav-state.css'

export { NAV_OWNER, resolvePane } from './settings-routing'

export type NavGroup = CoreSettingsContribution['group']

export const NAV_GROUPS: readonly NavGroup[] = ['manage', 'plugins', 'configure', 'diagnostics']

/** Displayed group headings (sentence case, no uppercase transform). */
export const NAV_GROUP_LABELS: Readonly<Record<NavGroup, string>> = {
  manage: 'Manage',
  plugins: 'Plugins',
  configure: 'Configure',
  diagnostics: 'Diagnostics',
}

export const PLUGIN_COUNT_KEY = 'walnut.settings.nav.pluginCount'

/** Tint for a settings-placed plugin app tile (its own icon on top). */
const APP_TINT = '#30B0C7'

const MANAGE_PAGES: ReadonlyArray<{ id: string; to: string; label: string; glyph: SettingsGlyphName; tint: string }> = [
  { id: 'agents', to: '/agents', label: 'Agents', glyph: 'two-person', tint: '#5856D6' },
  { id: 'skills', to: '/skills', label: 'Skills', glyph: 'sparkles', tint: '#AF52DE' },
  { id: 'commands', to: '/commands', label: 'Commands', glyph: 'slash-in-square', tint: '#636366' },
  { id: 'memory', to: '/memory', label: 'Memory', glyph: 'bookmark-stack', tint: '#FF2D55' },
]

export interface NavRow {
  /** Pane id for panes; `link:<id>` for off-page links. */
  key: string
  kind: 'pane' | 'link'
  group: NavGroup
  testId: string
  label: string
  to?: string
  appKind?: string
  badge?: 'dot' | number | null
  /** True for rows a plugin contributed (counted for the placeholder cache). */
  fromPlugin?: boolean
  meta: SettingsPaneMeta
  filter: FilterEntry
}

export interface PluginPaneInfo {
  pluginId: string
  pluginName: string
}

export interface SettingsNavModel {
  rows: NavRow[]
  /** Plugin runtime answered and webview apps loaded: plugin rows are final. */
  ready: boolean
  /** Plugin settings panel keys now registered. */
  pluginKeys: string[]
  pluginPanes: ReadonlyMap<string, PluginPaneInfo>
  metaFor: (sectionId: string) => SettingsPaneMeta | undefined
}

function coreMeta(entry: CoreSettingsContribution): SettingsPaneMeta {
  return {
    id: entry.id,
    label: entry.label,
    title: entry.title,
    description: entry.description,
    icon: <SettingsIcon glyph={entry.icon} />,
    tint: entry.tint,
    glyph: entry.icon,
  }
}

const CORE_META: ReadonlyMap<string, SettingsPaneMeta> = new Map(
  CORE_SETTINGS_CONTRIBUTIONS.map((entry) => [entry.id, coreMeta(entry)]),
)

const CORE_VISIBLE = CORE_SETTINGS_CONTRIBUTIONS.filter((entry) => !entry.navHidden)

function coreRow(entry: CoreSettingsContribution): NavRow {
  return {
    key: entry.id,
    kind: 'pane',
    group: entry.group,
    testId: `settings-nav-${entry.id}`,
    label: entry.label,
    meta: CORE_META.get(entry.id)!,
    filter: corePaneFilterEntry(entry.id),
  }
}

const CORE_ROWS: readonly NavRow[] = CORE_VISIBLE.map(coreRow)

const PAGE_ROWS: readonly NavRow[] = MANAGE_PAGES.map((page) => ({
  key: `link:${page.id}`,
  kind: 'link' as const,
  group: 'manage' as const,
  testId: `settings-nav-${page.id}`,
  label: page.label,
  to: page.to,
  meta: {
    id: page.id, label: page.label, title: page.label, description: '',
    icon: <SettingsIcon glyph={page.glyph} />, tint: page.tint, glyph: page.glyph,
  },
  filter: { key: `link:${page.id}`, kind: 'link' as const, label: page.label, keywords: PAGE_LINK_KEYWORDS[page.id] ?? [] },
}))

function Monogram({ letter }: { letter: string }) {
  return <span className="settings-tile-monogram">{letter}</span>
}

/** Every nav row, its tile, and pane metadata for the page. One computation, two consumers. */
export function useSettingsNavModel(): SettingsNavModel {
  const pluginUi = usePluginUi()
  const apps = useAppCatalog()
  const runtime = useWebPluginRuntime()
  const ready = runtime.ready && !apps.loadingWebviews

  const dynamic = useMemo(() => {
    // Seed with every core and page tile so plugin tiles shift away from them.
    const taken = new Set<string>([...PAGE_ROWS, ...CORE_ROWS].map((r) => tileKey(r.meta.tint, r.meta.glyph)))
    const appRows: NavRow[] = apps.settings.map((app) => {
      const AppIcon = app.icon
      const glyph = AppIcon ? `app-${app.key}` : 'app-window'
      let tint = APP_TINT
      if (taken.has(tileKey(tint, glyph))) tint = assignPluginTint(app.key, glyph, taken)
      else taken.add(tileKey(tint, glyph))
      return {
        key: `link:app:${app.key}`,
        kind: 'link' as const,
        group: 'plugins' as const,
        testId: `settings-nav-app-${app.key}`,
        label: app.title,
        to: app.path,
        appKind: app.kind,
        badge: app.badge,
        fromPlugin: true,
        meta: {
          id: app.key, label: app.title, title: app.title, description: '',
          icon: AppIcon ? <AppIcon size={13} /> : <SettingsIcon glyph="app-window" />, tint, glyph,
        },
        filter: {
          key: `link:app:${app.key}`, kind: 'link' as const, label: app.title,
          keywords: [app.pluginName, app.pluginId].filter((k): k is string => !!k).map((k) => k.toLowerCase()),
        },
      }
    })
    const pluginPanes = new Map<string, PluginPaneInfo>()
    const panelRows: NavRow[] = pluginUi.settings.map((entry) => {
      pluginPanes.set(entry.key, { pluginId: entry.pluginId, pluginName: entry.pluginName })
      const app = apps.all.find((a) => a.pluginId === entry.pluginId && a.icon)
      const AppIcon = app?.icon
      const letter = monogramFor(entry.pluginName || entry.value.label)
      const glyph = AppIcon && app ? `app-${app.key}` : `monogram-${letter}`
      const tint = assignPluginTint(entry.pluginId, glyph, taken)
      const description = `Provided by the ${entry.pluginName} plugin.`
      return {
        key: entry.key,
        kind: 'pane' as const,
        group: 'plugins' as const,
        testId: `settings-nav-${entry.key}`,
        label: entry.value.label,
        fromPlugin: true,
        meta: {
          id: entry.key, label: entry.value.label, title: entry.value.label, description,
          icon: AppIcon ? <AppIcon size={13} /> : <Monogram letter={letter} />, tint, glyph,
        },
        filter: {
          key: entry.key, kind: 'pane' as const, label: entry.value.label,
          descriptions: [description],
          keywords: [entry.pluginName.toLowerCase(), entry.pluginId.toLowerCase()],
        },
      }
    })
    return { appRows, panelRows, pluginPanes }
  }, [apps.settings, apps.all, pluginUi.settings])

  return useMemo(() => {
    const byGroup = (g: NavGroup) => CORE_ROWS.filter((r) => r.group === g)
    const rows: NavRow[] = [
      ...PAGE_ROWS,
      ...byGroup('manage'),
      ...byGroup('plugins'),
      ...dynamic.appRows,
      ...dynamic.panelRows,
      ...byGroup('configure'),
      ...byGroup('diagnostics'),
    ]
    const metaByKey = new Map<string, SettingsPaneMeta>(CORE_META)
    for (const r of dynamic.panelRows) metaByKey.set(r.key, r.meta)
    return {
      rows,
      ready,
      pluginKeys: [...dynamic.pluginPanes.keys()],
      pluginPanes: dynamic.pluginPanes,
      metaFor: (sectionId: string) => metaByKey.get(sectionId),
    }
  }, [dynamic, ready])
}

function readPluginCount(): number {
  try {
    const n = Number(window.localStorage.getItem(PLUGIN_COUNT_KEY))
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 40) : 0
  } catch {
    return 0
  }
}

function writePluginCount(n: number): void {
  try {
    window.localStorage.setItem(PLUGIN_COUNT_KEY, String(n))
  } catch {
    /* storage blocked: the next open just may jump once */
  }
}

/** DOM id for a row, safe for aria-activedescendant (plugin keys contain `:`). */
export function navRowDomId(key: string): string {
  return `settings-nav-opt-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

function renderLabel(label: string, ranges: ReadonlyArray<[number, number]> | undefined): ReactNode {
  if (!ranges || ranges.length === 0) return label
  const out: ReactNode[] = []
  let at = 0
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(label.slice(at, s))
    out.push(<b key={i} className="settings-nav-mark">{label.slice(s, e)}</b>)
    at = e
  })
  if (at < label.length) out.push(label.slice(at))
  return out
}

interface SettingsNavProps {
  model: SettingsNavModel
  activePane: string
  /** Open a pane: `anchor` scrolls to a row, `focusTitle` moves focus to the pane title. */
  onOpenPane: (paneId: string, opts?: { anchor?: string | null; focusTitle?: boolean }) => void
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return el.isContentEditable || !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

export function SettingsNav({ model, activePane, onOpenPane }: SettingsNavProps) {
  const navigate = useNavigate()
  const failedPanes = useFailedPanes()
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<string | null>(null)
  const [overlay, setOverlay] = useState(false)
  // A scrolled list gets a hairline under the pinned filter (N3-14).
  const [listScrolled, setListScrolled] = useState(false)
  const [cachedCount] = useState(readPluginCount)
  const inputRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)

  const filtering = query.trim() !== ''
  const hits = useMemo(() => filterEntries(model.rows.map((r) => r.filter), query), [model.rows, query])
  const hitByKey = useMemo(() => new Map<string, FilterHit>(hits.map((h) => [h.key, h])), [hits])

  // Display order: groups keep their order; inside a group, rank order while filtering.
  const groups = useMemo(() => NAV_GROUPS.map((group) => {
    let rows = model.rows.filter((r) => r.group === group)
    if (filtering) {
      rows = rows.filter((r) => hitByKey.has(r.key))
        .sort((a, b) => compareHits(hitByKey.get(a.key)!, hitByKey.get(b.key)!))
    }
    return { group, rows }
  }), [model.rows, filtering, hitByKey])
  const visibleRows = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  useEffect(() => {
    setHighlight(filtering ? primaryHit(hits)?.key ?? null : null)
  }, [hits, filtering])

  // Plugin rows are final: remember how many so the next open reserves the space.
  const pluginRowCount = model.rows.filter((r) => r.fromPlugin).length
  useEffect(() => {
    if (model.ready) writePluginCount(pluginRowCount)
  }, [model.ready, pluginRowCount])
  const placeholders = model.ready || filtering ? 0 : Math.max(0, cachedCount - pluginRowCount)

  // The current entry stays in view in a short window.
  useEffect(() => {
    const item = navRef.current?.querySelector<HTMLElement>('.settings-nav-active')
    item?.scrollIntoView?.({ block: 'nearest' })
  }, [activePane])

  const focusFilter = () => {
    setOverlay(true)
    const focus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    focus()
    requestAnimationFrame(focus)
  }

  // `/` anywhere outside a text field focuses Find a setting. Window capture
  // plus stopPropagation: the Home page stays mounted (hidden) under Settings
  // and its task search also claims `/` from a document listener.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isTypingTarget(e.target)) return
      if (!navRef.current || navRef.current.getClientRects().length === 0) return
      e.preventDefault()
      e.stopPropagation()
      focusFilter()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // The narrow-width overlay closes on any press outside the nav.
  useEffect(() => {
    if (!overlay) return
    const onDown = (e: PointerEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) setOverlay(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [overlay])

  const activate = (row: NavRow, via: 'click' | 'enter') => {
    setOverlay(false)
    if (row.kind === 'link') {
      if (via === 'enter' && row.to) navigate(row.to)
      return
    }
    onOpenPane(row.key, { anchor: hitByKey.get(row.key)?.anchor ?? null, focusTitle: via === 'enter' })
  }

  const clearQuery = () => {
    setQuery('')
    inputRef.current?.focus()
  }

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!filtering || visibleRows.length === 0) return
      e.preventDefault()
      const at = visibleRows.findIndex((r) => r.key === highlight)
      const next = e.key === 'ArrowDown'
        ? Math.min(visibleRows.length - 1, at + 1)
        : Math.max(0, at === -1 ? 0 : at - 1)
      setHighlight(visibleRows[next].key)
      document.getElementById(navRowDomId(visibleRows[next].key))?.scrollIntoView?.({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = visibleRows.find((r) => r.key === highlight)
      if (row) activate(row, 'enter')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (query) setQuery('')
      else {
        inputRef.current?.blur()
        setOverlay(false)
      }
    }
  }

  const renderRow = (row: NavRow) => {
    const hit = filtering ? hitByKey.get(row.key) : undefined
    const active = row.kind === 'pane' && row.key === activePane
    const highlighted = filtering && row.key === highlight
    const className = 'settings-nav-item'
      + (row.kind === 'link' ? ' settings-nav-page-link' : '')
      + (active ? ' settings-nav-active' : '')
      + (highlighted ? ' is-highlighted' : '')
    const body = (
      <>
        <SettingsPaneTile meta={row.meta} size={20} />
        <span className="settings-nav-text">
          <span className="settings-nav-label">{renderLabel(row.label, hit?.labelRanges)}</span>
          {hit?.hint && <span className="settings-nav-hint">Matches &quot;{hit.hint}&quot;</span>}
        </span>
        <span className="settings-nav-trailing">
          {row.badge === 'dot' ? (
            <span className="notification-badge-dot" />
          ) : typeof row.badge === 'number' && row.badge > 0 ? (
            <span className="notification-badge-count">{row.badge > 99 ? '99+' : row.badge}</span>
          ) : null}
          {failedPanes.has(row.key) && (
            <span
              className="settings-nav-error-dot"
              data-testid={`settings-nav-error-${row.key}`}
              role="img"
              aria-label="A change here wasn't saved."
              title="A change here wasn't saved."
            />
          )}
          {row.kind === 'link' && <SettingsIcon glyph="arrow-up-right" size={12} className="settings-nav-arrow" />}
        </span>
      </>
    )
    if (row.kind === 'link' && row.to) {
      return (
        <NavLink
          key={row.key}
          id={navRowDomId(row.key)}
          to={row.to}
          className={className}
          data-testid={row.testId}
          data-app-kind={row.appKind}
          title={`Opens the ${row.label} page`}
          onClick={() => setOverlay(false)}
        >
          {body}
        </NavLink>
      )
    }
    return (
      <button
        key={row.key}
        id={navRowDomId(row.key)}
        type="button"
        className={className}
        data-testid={row.testId}
        aria-current={active ? 'page' : undefined}
        title={row.label}
        // WebKit (the Mac app) skips buttons on Tab unless they carry a tabindex (N20).
        tabIndex={0}
        onClick={() => activate(row, 'click')}
      >
        {body}
      </button>
    )
  }

  const highlightId = filtering && highlight ? navRowDomId(highlight) : undefined
  return (
    <nav
      ref={navRef}
      className={`settings-nav${overlay ? ' is-overlay-open' : ''}${listScrolled ? ' is-list-scrolled' : ''}`}
      aria-label="Settings sections"
    >
      <h1 className="settings-nav-title">Settings</h1>
      <button
        type="button"
        className="settings-nav-find-button"
        aria-label="Find a setting"
        title="Find a setting"
        onClick={focusFilter}
      >
        <SettingsIcon glyph="magnifier" size={16} />
      </button>
      <div className="settings-filter-wrap">
        <SettingsIcon glyph="magnifier" size={13} className="settings-filter-glyph" />
        <input
          ref={inputRef}
          type="search"
          className="settings-filter"
          data-testid="settings-filter"
          placeholder="Find a setting"
          aria-label="Find a setting"
          role="combobox"
          aria-expanded={filtering}
          aria-controls="settings-nav-list"
          aria-autocomplete="list"
          aria-activedescendant={highlightId}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
        />
        {query && (
          <button type="button" className="settings-filter-clear" aria-label="Clear" onClick={clearQuery}>
            <SettingsIcon glyph="circle-x" size={14} />
          </button>
        )}
      </div>
      <div
        id="settings-nav-list"
        className="settings-nav-list"
        onScroll={(e) => setListScrolled(e.currentTarget.scrollTop > 0)}
      >
        {groups.map(({ group, rows }) => (rows.length === 0 && !(group === 'plugins' && placeholders > 0) ? null : (
          <div key={group} className="settings-nav-group" data-group={group}>
            <span className="settings-nav-group-label">{NAV_GROUP_LABELS[group]}</span>
            {group === 'plugins'
              ? (
                <>
                  {rows.filter((r) => !r.fromPlugin).map(renderRow)}
                  {rows.filter((r) => r.fromPlugin).map(renderRow)}
                  {Array.from({ length: placeholders }, (_, i) => (
                    <span key={`ph-${i}`} className="settings-nav-item settings-nav-placeholder" aria-hidden="true">
                      <span className="settings-nav-placeholder-tile" />
                      <span className="settings-nav-placeholder-bar" />
                    </span>
                  ))}
                </>
              )
              : rows.map(renderRow)}
          </div>
        )))}
        {filtering && hits.length === 0 && (
          <div className="settings-nav-empty" data-testid="settings-filter-empty">
            <p>No settings match &quot;{query.trim()}&quot;.</p>
            <button type="button" className="settings-nav-clear-search" onClick={clearQuery}>Clear search</button>
          </div>
        )}
      </div>
    </nav>
  )
}
