/**
 * The Apps page as a home screen (experiment `apps_home`; Evan's pick A of 2026-11-23). Two
 * halves on one switch: Installed, every built-in app and installed plugin together, and Store,
 * what you can add. Installed opens on Recently used (what you opened last, most recent first),
 * All beside it sorted by name or category; Icons or List; chips narrow it to plugins, built-ins,
 * what is on the Sidebar, what works in the background, or one category. Every choice is kept
 * (usePageView). The Sidebar is the first level, this page the second.
 *
 * Each item has one main action and one menu (HomeTile.tsx); its details page (the plugin's or
 * the built-in app's, as before) holds its switches, settings, parts and Remove.
 */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog, useAppPagePins, useRecentAppKeys } from '@/apps/hooks'
import { markAppUsed, updateAppOnSidebar, updateAppPinned } from '@/apps/store'
import { useExperimental } from '@/hooks/useExperimental'
import { linkTargetFor } from '@/utils/last-location'
import { peekPendingInstall, subscribeOpenLinks } from '@/utils/open-link'
import { usePageView } from '@/utils/view-memory'
import { SearchField } from '@/components/common/SearchField'
import type { ContextMenuItem } from '@/components/common/ContextMenu'
import { NoticeStatus, type NoticeTone } from '@/components/common/NoticeCard'
import { EmptyState, LoadingState } from '@/components/common/EmptyState'
import { Chip, ChipGroup, SegmentedControl } from '@/components/controls'
import { pluginTileTints } from '@/components/settings/PluginIcon'
import { SettingsSavedIndicator } from '@/components/settings/settings-pane-context'
import { setPartOnRail } from './BuiltinAppsGrid'
import { PLUGIN_CATEGORY_LABELS } from './categories'
import {
  effectiveFilter, isAppsLayout, isAppsScope, isAppsSort, isAppsTab, isInstalledFilter, matchesFilter, matchesQuery,
  presentCategories, primaryOf, recentItems, sortedGroups,
  type AppsLayout, type AppsScope, type AppsSort, type AppsTab, type HomeItem, type InstalledFilter,
} from './apps-home-model'
import { HomeRow, HomeTile, type HomeItemActions } from './HomeTile'
import { homeEntries, pluginUseKey, type HomeEntry } from './home-items'
import type { BuiltinEntry, HeldPlugin } from './builtin-apps'
import type { PluginCardFacts } from './plugin-card-facts'
import { pluginCardFacts } from './plugin-card-facts'
import { appsOfPlugin, isRemovable, partParents, type RegistryRow } from './plugin-store-model'
import { AppsStore } from './AppsStore'
import type { PluginStore } from './usePluginStore'
import '@/styles/apps-home.css'

const GridGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><rect x="14" y="14" width="6" height="6" rx="1.5" />
  </svg>
)
const ListGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" />
  </svg>
)

const FIXED_CHIPS: readonly { id: InstalledFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'builtin', label: 'Built-in' },
  { id: 'sidebar', label: 'On the sidebar' },
  { id: 'background', label: 'In the background' },
]

export function AppsHome({ store, builtins, folded, heldFacts, held, onOpenPlugin, onOpenApp, showSaved }: {
  /** One Saved indicator, in whichever view is showing (this one stays mounted under a details page). */
  showSaved: boolean
  store: PluginStore
  /** The built-in entries the page shows (builtinsShown). */
  builtins: readonly BuiltinEntry[]
  folded: ReadonlyMap<string, RegistryRow>
  heldFacts: ReadonlyMap<string, PluginCardFacts>
  held: ReadonlyMap<string, HeldPlugin>
  onOpenPlugin: (pluginId: string, panel?: string) => void
  onOpenApp: (key: string) => void
}) {
  const navigate = useNavigate()
  const catalog = useAppCatalog()
  const quietRail = useExperimental('quiet_rail')
  const recentKeys = useRecentAppKeys()
  const pins = useAppPagePins()
  const [tab, setTab] = usePageView<AppsTab>('apps', 'home-tab', 'installed', isAppsTab)
  const [scope, setScope] = usePageView<AppsScope>('apps', 'home-scope', 'recent', isAppsScope)
  const [layout, setLayout] = usePageView<AppsLayout>('apps', 'home-layout', 'icons', isAppsLayout)
  const [kept, setFilter] = usePageView<InstalledFilter>('apps', 'home-filter', 'all', isInstalledFilter)
  const [sort, setSort] = usePageView<AppsSort>('apps', 'home-sort', 'name', isAppsSort)
  // Each half searches its own things.
  const [installedQuery, setInstalledQuery] = useState('')
  const [storeQuery, setStoreQuery] = useState('')
  const query = tab === 'store' ? storeQuery : installedQuery
  const setQuery = tab === 'store' ? setStoreQuery : setInstalledQuery

  // An install link's card is in the Store: a link that lands here opens it.
  useEffect(() => {
    const show = () => { if (peekPendingInstall()) { setTab('store'); setStoreQuery('') } }
    show()
    return subscribeOpenLinks(show)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Built each render: the inputs (the store's rows, the page's folded maps) are new objects each time anyway.
  const entries = (() => {
    const onSidebar = new Set(catalog.sidebar.map((app) => app.key))
    const parentOf = partParents(store.installed)
    const foldedIds = new Set([...folded.values()].map((row) => row.id))
    return homeEntries({
      builtins, folded, heldFacts, held,
      plugins: store.installed.filter((row) => !parentOf.has(row.id) && !foldedIds.has(row.id)),
      appsOf: (id) => appsOfPlugin(catalog.all, id),
      factsOf: (row) => pluginCardFacts(store, row),
      onSidebar,
    })
  })()
  const byId = new Map(entries.map((entry) => [entry.item.id, entry]))
  const items = entries.map((entry) => entry.item)
  const filter = effectiveFilter(kept, items, store.registry !== null)
  const chips = [...FIXED_CHIPS, ...presentCategories(items).map((id) => ({ id: id as InstalledFilter, label: PLUGIN_CATEGORY_LABELS[id] }))]
  const visible = items.filter((item) => matchesFilter(item, filter) && matchesQuery(item, installedQuery))
  const tints = pluginTileTints(store.rows)
  const tintOf = (entry: HomeEntry) => tints.get(entry.item.id) ?? 'var(--fg-muted)'

  const openDetail = (entry: HomeEntry, panel?: string) => {
    const { item } = entry
    if (item.detail.kind === 'plugin') onOpenPlugin(item.detail.id, panel)
    else onOpenApp(item.detail.id)
  }
  const open = (entry: HomeEntry) => {
    const { item } = entry
    if (!item.openPath) return openDetail(entry)
    markAppUsed(item.useKeys[0])
    navigate(linkTargetFor(item.openPath))
  }
  const setOnSidebar = (entry: HomeEntry, next: boolean) => {
    if (entry.entry) setPartOnRail(entry.entry.parts[0], next, quietRail)
    else if (entry.apps[0]) updateAppOnSidebar(entry.apps[0], next)
  }
  const actions: HomeItemActions = {
    run: (entry) => {
      if (primaryOf(entry.item) === 'open') return open(entry)
      // A plugin without a screen is used through its page: its main action counts as using it.
      if (entry.item.background) markAppUsed(pluginUseKey(entry.item.id))
      openDetail(entry)
    },
    menuFor: (entry) => menuRows(entry, { open, openDetail, setOnSidebar, pins }),
  }

  const recent = scope === 'recent' ? recentItems(visible, recentKeys, pins ?? []) : []
  const narrowed = filter !== 'all' || installedQuery.trim() !== ''
  const draw = (list: readonly HomeItem[]) => {
    const drawn = list.map((item) => byId.get(item.id)!).filter(Boolean)
    return layout === 'icons'
      ? <div className="apps-home-grid" data-testid="apps-home-grid">{drawn.map((entry) => <HomeTile key={entry.item.id} entry={entry} tint={tintOf(entry)} actions={actions} />)}</div>
      : <div className="apps-home-list" data-testid="apps-home-list">{drawn.map((entry) => <HomeRow key={entry.item.id} entry={entry} tint={tintOf(entry)} actions={actions} status={rowStatus(entry.item)} />)}</div>
  }

  return (
    <div className="apps-home" data-testid="apps-home" data-tab={tab}>
      <header className="apps-home-head" data-fit-header>
        <h1 data-fit-title>Apps</h1>
        <SegmentedControl<AppsTab>
          value={tab}
          onChange={setTab}
          aria-label="Installed or Store"
          data-testid="apps-home-tab"
          options={[{ value: 'installed', label: 'Installed', testId: 'apps-home-tab-installed' }, { value: 'store', label: 'Store', testId: 'apps-home-tab-store' }]}
        />
        <span className="apps-home-grow" />
        {showSaved && <SettingsSavedIndicator placement="header" />}
        {tab === 'installed' && (
          <SegmentedControl<AppsLayout>
            value={layout}
            onChange={setLayout}
            aria-label="View"
            data-testid="apps-home-layout"
            options={[
              { value: 'icons', label: <GridGlyph />, icon: true, ariaLabel: 'Icons', title: 'Icons', testId: 'apps-home-layout-icons' },
              { value: 'list', label: <ListGlyph />, icon: true, ariaLabel: 'List', title: 'List', testId: 'apps-home-layout-list' },
            ]}
          />
        )}
        <SearchField
          small
          fieldClassName="apps-search apps-home-search"
          data-no-draft="search"
          type="search"
          value={query}
          setText={setQuery}
          onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
          onClear={() => setQuery('')}
          placeholder={tab === 'store' ? 'Search the store' : 'Search apps'}
          aria-label={tab === 'store' ? 'Search the store' : 'Search apps'}
          data-testid="apps-search"
        />
      </header>

      {tab === 'store' ? (
        <AppsStore store={store} query={storeQuery} onOpen={(id) => onOpenPlugin(id)} />
      ) : (
        <>
          <div className="apps-home-bar">
            <SegmentedControl<AppsScope>
              value={scope}
              onChange={setScope}
              size="sm"
              aria-label="Recently used or all"
              data-testid="apps-home-scope"
              options={[{ value: 'recent', label: 'Recently used', testId: 'apps-home-scope-recent' }, { value: 'all', label: 'All', testId: 'apps-home-scope-all' }]}
            />
            <span className="apps-home-grow" />
            {scope === 'all' && (
              <SegmentedControl<AppsSort>
                value={sort}
                onChange={setSort}
                size="sm"
                aria-label="Sort"
                data-testid="apps-home-sort"
                options={[{ value: 'name', label: 'Name', testId: 'apps-home-sort-name' }, { value: 'category', label: 'Category', testId: 'apps-home-sort-category' }]}
              />
            )}
          </div>
          {/* The chips on a line of their own, so the scope's All and the kinds' All never sit side by side. */}
          <ChipGroup className="apps-home-chips" role="group" aria-label="Show">
            {chips.map((chip) => (
              <Chip key={chip.id} pressed={filter === chip.id} onClick={() => setFilter(chip.id)} data-testid={`apps-home-chip-${chip.id}`}>{chip.label}</Chip>
            ))}
          </ChipGroup>

          {scope === 'recent' ? (
            recent.length > 0 ? draw(recent) : (
              <EmptyState
                testId="apps-home-recent-empty"
                title={narrowed ? 'Nothing you used lately matches' : 'Nothing used yet'}
                hint={narrowed ? undefined : 'The apps you open show up here, the most recent first.'}
                action={{ label: 'Show all apps', onClick: () => setScope('all'), testId: 'apps-home-show-all' }}
              />
            )
          ) : visible.length === 0 ? (
            <EmptyState
              testId="apps-no-match"
              title={installedQuery.trim() ? 'Nothing matches \u201c' + installedQuery.trim() + '\u201d' : filter !== 'all' ? 'Nothing here under this filter' : 'Nothing installed yet'}
              action={installedQuery.trim()
                ? { label: 'Clear search', onClick: () => setInstalledQuery('') }
                : filter !== 'all' ? { label: 'Show all', onClick: () => setFilter('all') } : undefined}
            />
          ) : (
            sortedGroups(visible, sort).map((group) => (
              <section key={group.id} className="apps-home-group" data-testid={`apps-home-group-${group.id}`} aria-label={group.title || 'All apps'}>
                {group.title && <h2 className="apps-section-title">{group.title}</h2>}
                {draw(group.items)}
              </section>
            ))
          )}
          {!store.registry && <LoadingState title="Loading plugins…" size="row" testId="apps-home-loading" />}
          {(scope === 'recent' ? recent : visible).some((item) => item.onSidebar) && (
            <p className="apps-home-legend" data-testid="apps-home-legend"><span className="apps-home-docked-sample" aria-hidden="true" />A dot under an icon: it is kept on the sidebar.</p>
          )}
        </>
      )}
    </div>
  )
}

/** A row's status, only when it says something the item's look does not (needs setup, off, an update). */
function rowStatus(item: HomeItem) {
  const { tone, text } = item.status
  if (tone === 'on' || tone === 'fixed' || tone === 'get' || (tone === 'off' && !item.dim)) return undefined
  return <NoticeStatus tone={ROW_TONE[tone]} whole className="apps-home-row-status"><span data-testid={`apps-home-status-${item.id}`}>{text}</span></NoticeStatus>
}

const ROW_TONE: Record<HomeItem['status']['tone'], NoticeTone> = {
  on: 'ok', fixed: 'muted', get: 'muted', off: 'muted', warn: 'warn', bad: 'error', update: 'live',
}

/** The one menu every item has: Open, its place on the Sidebar, Pin, its details, Remove. */
function menuRows(entry: HomeEntry, ctx: {
  open: (entry: HomeEntry) => void
  openDetail: (entry: HomeEntry, panel?: string) => void
  setOnSidebar: (entry: HomeEntry, next: boolean) => void
  pins: readonly string[] | null
}): ContextMenuItem[] {
  const { item, row } = entry
  const parts = item.sidebarParts
  const pinKey = entry.entry?.app?.key ?? entry.apps[0]?.key
  const pinned = !!pinKey && !!ctx.pins?.includes(pinKey)
  const removable = item.kind === 'plugin' && !!row && isRemovable(row)
  return [
    { key: 'open', label: 'Open', onSelect: () => ctx.open(entry), when: !!item.openPath },
    parts.total === 1
      ? {
        key: 'sidebar', label: 'Show on the sidebar', toggle: true, checked: item.onSidebar,
        ...(item.locked ? { disabled: true, title: 'Always on the sidebar' } : { onSelect: () => ctx.setOnSidebar(entry, !item.onSidebar) }),
      }
      : { key: 'sidebar', label: 'Choose sidebar entries...', onSelect: () => ctx.openDetail(entry), when: parts.total > 1 },
    {
      key: 'pin', label: pinned ? 'Unpin from Recently used' : 'Pin to Recently used',
      onSelect: () => updateAppPinned(pinKey!, !pinned), when: ctx.pins !== null && !!pinKey && !!item.openPath,
    },
    { key: 'details', label: 'Details and settings', onSelect: () => ctx.openDetail(entry) },
    { divider: true, when: removable },
    { key: 'remove', label: 'Remove...', danger: true, onSelect: () => ctx.openDetail(entry, 'remove'), when: removable },
  ]
}
