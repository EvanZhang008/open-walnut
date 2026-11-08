/**
 * The settings sidebar: `Settings` title, Find a setting, and three groups
 * (Manage / Configure / Diagnostics). One pane shows at a time; a nav click only
 * changes the hash (replace), SettingsPage mounts that pane.
 *
 * Every row is Walnut's own (core-settings-registry, owner 'walnut'). Plugins are
 * not in Settings at all: each plugin, its settings panels (`walnut.ui.settings`)
 * and its sign-in live on its own page in Apps (components/apps-page/PluginDetail),
 * and Apps is its own entry on the main side bar (2026-11-05, the user: "plugin
 * shodl be all in apps, and app is not in seting"). An old `#<plugin>:<panel>` link
 * forwards there (SettingsPage). Guard: tests/web/plugins-not-in-settings.test.ts.
 *
 * Off-page links (Agents, Commands, Memory) route away and carry an arrow-up-right mark.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { isPhoneLayout, usePhoneLayout } from '@/hooks/usePhoneLayout'
import { CORE_SETTINGS_CONTRIBUTIONS, type CoreSettingsContribution } from './core-settings-registry'
import { useClosedPaneGates, type SettingsPaneGate } from './settings-pane-gates'
import { corePaneFilterEntry, navRowShown, tabParent } from './settings-routing'
import { compareHits, filterEntries, primaryHit, PAGE_LINK_KEYWORDS, type FilterEntry, type FilterHit } from './settings-filter'
import { SettingsIcon, type SettingsGlyphName } from './settings-icons'
import { SettingsPaneTile, useFailedPanes, type SettingsPaneMeta } from './settings-pane-context'
import { WAY_PANES } from './settings-way-panes'
import { browserLinkSubtitle, useBrowserLinkName } from './sections/cloud/browser-link-name'
import { APPS_PATH } from '@/utils/open-link'
import { pageShortcutBlocked } from '@/utils/page-shortcut'
import '@/styles/settings-nav.css'
import '@/styles/settings-nav-state.css'

export { NAV_OWNER, resolvePane } from './settings-routing'

export type NavGroup = CoreSettingsContribution['group']

export const NAV_GROUPS: readonly NavGroup[] = ['manage', 'configure', 'diagnostics']

/** Displayed group headings (sentence case, no uppercase transform). */
export const NAV_GROUP_LABELS: Readonly<Record<NavGroup, string>> = {
  manage: 'Manage',
  configure: 'Configure',
  diagnostics: 'Diagnostics',
}

const MANAGE_PAGES: ReadonlyArray<{ id: string; to: string; label: string; glyph: SettingsGlyphName; tint: string }> = [
  { id: 'agents', to: '/agents', label: 'Agents', glyph: 'two-person', tint: '#5856D6' },
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
  /** A sub-page's row: indented under this pane's row (core-settings-registry `parent`). */
  parent?: string
  meta: SettingsPaneMeta
  filter: FilterEntry
}

export interface SettingsNavModel {
  rows: NavRow[]
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
    parent: entry.parent,
    meta: CORE_META.get(entry.id)!,
    filter: corePaneFilterEntry(entry.id),
  }
}

const CORE_ROWS: readonly NavRow[] = CORE_VISIBLE.map(coreRow)
/** Pane id -> the server fact its entry waits on (core-settings-registry `requires`). */
const CORE_GATES: ReadonlyMap<string, SettingsPaneGate> = new Map(
  CORE_VISIBLE.flatMap((entry) => (entry.requires ? [[entry.id, entry.requires] as const] : [])),
)

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

/** Every nav row, its tile, and pane metadata for the page. One computation, two consumers. */
export function useSettingsNavModel(): SettingsNavModel {
  const closedGates = useClosedPaneGates()
  // A plugin's tunnel names the browser link after itself (browser-link-name.ts).
  const linkName = useBrowserLinkName()

  return useMemo(() => {
    const byGroup = (g: NavGroup) => CORE_ROWS.filter((r) => {
      const gate = CORE_GATES.get(r.key)
      return r.group === g && !(gate && closedGates.has(gate))
    })
    const rows: NavRow[] = [
      ...PAGE_ROWS,
      ...byGroup('manage'),
      ...byGroup('configure'),
      ...byGroup('diagnostics'),
    ]
    const metaByKey = new Map<string, SettingsPaneMeta>(CORE_META)
    const named = rows.map((r) => {
      if (r.key !== WAY_PANES.browser || !linkName.plugin) return r
      const meta = { ...r.meta, label: linkName.title, title: linkName.title, description: browserLinkSubtitle(linkName) }
      metaByKey.set(r.key, meta)
      return { ...r, label: linkName.title, meta }
    })
    return {
      rows: named,
      metaFor: (sectionId: string) => metaByKey.get(sectionId),
    }
  }, [closedGates, linkName])
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
  const inputRef = useRef<HTMLInputElement>(null)
  const navRef = useRef<HTMLElement>(null)

  const filtering = query.trim() !== ''
  const hits = useMemo(() => filterEntries(model.rows.map((r) => r.filter), query), [model.rows, query])
  const hitByKey = useMemo(() => new Map<string, FilterHit>(hits.map((h) => [h.key, h])), [hits])

  // Display order: groups keep their order; inside a group, rank order while filtering.
  // A phone drills in from the pane itself (iOS Settings): its list keeps sub-pages folded.
  const phone = usePhoneLayout()
  const navOpenPane = phone ? '' : activePane
  const groups = useMemo(() => NAV_GROUPS.map((group) => {
    let rows = model.rows.filter((r) => r.group === group && navRowShown(r.key, navOpenPane, filtering))
    if (filtering) {
      rows = rows.filter((r) => hitByKey.has(r.key))
        .sort((a, b) => compareHits(hitByKey.get(a.key)!, hitByKey.get(b.key)!))
    }
    return { group, rows }
  }), [model.rows, filtering, hitByKey, navOpenPane])
  const visibleRows = useMemo(() => groups.flatMap((g) => g.rows), [groups])

  useEffect(() => {
    setHighlight(filtering ? primaryHit(hits)?.key ?? null : null)
  }, [hits, filtering])

  // The current entry stays in view in a short window. Not on a phone: there
  // the list is the page under the open pane, and back must find it where the
  // finger left it.
  useEffect(() => {
    if (isPhoneLayout()) return
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
      if (e.key !== '/') return
      // Never while a sheet, an editor or a menu has the reader (utils/page-shortcut.ts).
      if (isTypingTarget(e.target) || pageShortcutBlocked(e, navRef.current)) return
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
    const active = row.kind === 'pane' && (row.key === activePane || (!filtering && tabParent(activePane) === row.key))
    const highlighted = filtering && row.key === highlight
    const className = 'settings-nav-item'
      + (row.kind === 'link' ? ' settings-nav-page-link' : '')
      + (row.parent ? ' settings-nav-subitem' : '')
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
        data-parent={row.parent}
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
          data-no-draft="search"
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
        {groups.map(({ group, rows }) => (rows.length === 0 ? null : (
          <div key={group} className="settings-nav-group" data-group={group}>
            <span className="settings-nav-group-label">{NAV_GROUP_LABELS[group]}</span>
            {rows.map(renderRow)}
          </div>
        )))}
        {filtering && hits.length === 0 && (
          <div className="settings-nav-empty" data-testid="settings-filter-empty">
            <p>No settings match &quot;{query.trim()}&quot;.</p>
            <button type="button" className="settings-nav-clear-search" onClick={clearQuery}>Clear search</button>
          </div>
        )}
        {/* A plugin's settings are on its page in Apps, so a search for one is pointed there. */}
        {filtering && (
          <p className="settings-nav-empty settings-nav-empty-apps" data-testid="settings-filter-apps-hint">
            A plugin&apos;s settings and sign-in are on its page in{' '}
            <button type="button" className="settings-nav-clear-search" data-testid="settings-filter-open-apps" onClick={() => navigate(APPS_PATH)}>Apps</button>.
          </p>
        )}
      </div>
    </nav>
  )
}
