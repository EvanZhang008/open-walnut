/**
 * /apps: everything Walnut can do, as a store the sidebar points at.
 *
 * Every built-in app and every plugin is one card of the same shape, in its section: the
 * built-in apps, the plugins by category, then Get more (what you can add, a git or npm
 * link, the sources), then Make your own. The chips filter the page to one of those; the
 * search box narrows every part at once. A card opens its detail page (`?plugin=<id>` or
 * `?app=<key>`), which holds the switch, the settings, the parts, where the code comes
 * from and Update. The grid stays mounted under it, so going back keeps its place.
 *
 * Plugins used to live in Settings (`#plugin-store`, and a plugin's own panel at
 * `#<plugin>:<panel>`), which still forward here (settings-routing legacyPluginTarget).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSearchParamsNow } from '@/hooks/useSearchParamsNow'
import { useAppActivity, useAppCatalog } from '@/apps/hooks'
import { AppsIcon } from '@/apps/icons'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import { peekPendingInstall, subscribeOpenLinks } from '@/utils/open-link'
import { BuiltinAppsGrid, BuiltinDetail, foldedPluginRows, heldPlugins, useBuiltinEntries } from '@/components/apps-page/BuiltinAppsGrid'
import { MakeAppCard } from '@/components/apps-page/MakeAppCard'
import { AppQuickOpen } from '@/components/apps-page/AppQuickOpen'
import { BUILTIN_APPS_TITLE, builtinParts, builtinsMatching, builtinsShown } from '@/components/apps-page/builtin-apps'
import { GET_MORE_TITLE, PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER, isAppsFilter, type AppsFilter } from '@/components/apps-page/categories'
import { usePageView } from '@/utils/view-memory'
import { PluginStoreGrid, type PluginStoreSummary } from '@/components/apps-page/PluginStoreGrid'
import { AppsHome } from '@/components/apps-page/AppsHome'
import { PluginDetail } from '@/components/apps-page/PluginDetail'
import { usePluginStore } from '@/components/apps-page/usePluginStore'
import { PluginAskDrawer } from '@/components/apps-page/PluginAskDrawer'
import { useExperimental } from '@/hooks/useExperimental'
import { useLeanCallback } from '@/hooks/useLeanCallback'
import { EmptyState, LoadingState } from '@/components/common/EmptyState'
import {
  SettingsPaneProvider,
  SettingsSavedIndicator,
  saveErrorMessage,
  useSettingsSaveNotifier,
} from '@/components/settings/settings-pane-context'
import type { Config } from '@open-walnut/core'
import '@/plugins/dev-test-hooks'
import '@/styles/settings-shell.css'
import '@/styles/settings-controls.css'
import '@/styles/apps-page.css'
import { SearchField } from '@/components/common/SearchField'
import { Chip, ChipGroup } from '@/components/controls'

/** Saves from this page report Saved / Not saved like a Settings pane does. */
const APPS_PANE_ID = 'apps'
const NO_META = () => undefined

export function AppsPage() {
  return (
    <SettingsPaneProvider paneId={APPS_PANE_ID} leadSectionId={null} metaFor={NO_META}>
      <AppsPageBody />
    </SettingsPaneProvider>
  )
}

function AppsPageBody() {
  const { config, saveSection } = useSettingsConfig()
  const { notifySaved, notifySaveFailed } = useSettingsSaveNotifier()
  const paneSave = useCallback(async (partial: Partial<Config>) => {
    try {
      await saveSection(partial)
      notifySaved(APPS_PANE_ID)
    } catch (err) {
      notifySaveFailed(APPS_PANE_ID, saveErrorMessage(err))
      throw err
    }
  }, [saveSection, notifySaved, notifySaveFailed])
  const apps = useAppCatalog()
  // Experiment apps_stay_open: Pinned and Recently used lead the page (empty when off).
  const activity = useAppActivity(apps)
  // The category picked stays picked when the page is left and opened again (utils/view-memory.ts).
  const [kept, setFilter] = usePageView<AppsFilter>('apps', 'filter', 'all', isAppsFilter)
  const [query, setQuery] = useState('')
  const [summary, setSummary] = useState<PluginStoreSummary>({ loaded: false, categories: [], matches: 0 })
  const store = usePluginStore()
  const builtins = useBuiltinEntries()
  // Calendar and Mail are one card with their plugin: the plugin list leaves those plugins out.
  const folded = foldedPluginRows(builtins, store.installed)
  const foldedIds = new Set([...folded.values()].map((row) => row.id))
  const { facts: heldFacts, held } = heldPlugins(folded, store)
  const shownBuiltins = builtinsShown(builtins, held)
  const allParts = builtinParts(shownBuiltins)
  const onRail = allParts.filter((part) => part.shown).length
  // The categories with a chip: the plugin list's, and those of a plugin a built-in card holds.
  const chipCategories = PLUGIN_CATEGORY_ORDER.filter((category) => summary.categories.includes(category) || [...held.values()].some((plugin) => plugin.category === category))
  // A kept category with no plugins now (a list still loading, another device's plugins) has no
  // chip: the page shows All, and the kept choice stays for when it is back.
  const filter: AppsFilter = summary.loaded && kept !== 'all' && kept !== 'get' && kept !== 'builtin' && !(chipCategories as readonly string[]).includes(kept) ? 'all' : kept
  const onSummary = useCallback((next: PluginStoreSummary) => setSummary(next), [])
  // An install link lands here (App.tsx); its card lives in the plugin part, so a
  // filter or a search that hides that part gives way.
  useEffect(() => {
    const show = () => { if (peekPendingInstall()) { setFilter('all'); setQuery(''); setParams({}, { replace: true }) } }
    show()
    return subscribeOpenLinks(show)
  }, [])
  const navigate = useNavigate()
  const [params, setParams] = useSearchParamsNow()
  const pluginId = params.get('plugin')
  const appKey = params.get('app')
  const detailOpen = Boolean(pluginId || appKey)
  // The grid's scroll position, kept while a detail page is open and put back on return.
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridScroll = useRef(0)
  const openDetail = useCallback((key: 'plugin' | 'app', value: string, panel?: string) => {
    if (!detailOpen) gridScroll.current = scrollRef.current?.scrollTop ?? 0
    setParams({ [key]: value, ...(panel ? { panel } : {}) }, { state: { fromApps: true } })
  }, [detailOpen, setParams])
  const openPlugin = useCallback((id: string, panel?: string) => openDetail('plugin', id, panel), [openDetail])
  // Experiment apps_home: the page is a home screen of everything installed, and a Store beside it.
  const home = useExperimental('apps_home')
  // "Configure with AI" (experiment plugin_ai_configure): a chat about the open plugin beside its
  // page, kept in the address (`&ask=1`) so a reload or a link opens it again.
  const aiConfigure = useExperimental('plugin_ai_configure')
  const askRow = aiConfigure && pluginId && params.get('ask') === '1' ? store.rows.find((row) => row.id === pluginId && row.installed) : undefined
  const setAsk = useLeanCallback((open: boolean) => {
    if (!pluginId) return
    // Only `ask` changes: the other params (`panel`) and the entry's own state (`fromApps`) stay, so
    // Back still returns to the grid.
    const next = new URLSearchParams(params)
    if (open) next.set('ask', '1')
    else next.delete('ask')
    setParams(next, { replace: true, state: window.history.state?.usr })
  }, [pluginId, params, setParams])
  const openApp = useCallback((key: string) => openDetail('app', key), [openDetail])
  // Back goes back when the grid is what came before (so the browser's Back agrees), and
  // to the grid otherwise (a deep link, a reload).
  const closeDetail = useCallback(() => {
    if ((window.history.state?.usr as { fromApps?: boolean } | undefined)?.fromApps) navigate(-1)
    else setParams({}, { replace: true })
  }, [navigate, setParams])
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = detailOpen ? 0 : gridScroll.current
  }, [detailOpen, pluginId, appKey])

  // An app's old address (`?app=core:calendar`) opens its plugin's page, which holds its parts.
  const heldPlugin = appKey ? folded.get(builtins.find((entry) => entry.key === appKey || entry.parts.some((part) => part.key === appKey))?.key ?? '') : undefined
  const detailPlugin = pluginId ?? heldPlugin?.id ?? null
  // ...and the address follows, so Back, `panel` and `ask` all read the one `?plugin=`.
  const heldPluginId = !pluginId ? heldPlugin?.id : undefined
  useEffect(() => {
    if (!heldPluginId) return
    const next = new URLSearchParams(window.location.search)
    next.delete('app')
    next.set('plugin', heldPluginId)
    setParams(next, { replace: true, state: window.history.state?.usr })
  }, [heldPluginId, setParams])
  // A plugin category chip also shows the built-in cards that hold a plugin of it (Calendar under Time).
  const pluginCategory = filter !== 'all' && filter !== 'builtin' && filter !== 'get' ? filter : undefined
  const visibleBuiltins = builtinsMatching(shownBuiltins, held, query, pluginCategory)
  const builtinHits = visibleBuiltins.length
  const categoryHits = pluginCategory ? builtinsMatching(shownBuiltins, held, '', pluginCategory).length : 0
  const showBuiltin = filter === 'all' || filter === 'builtin' || categoryHits > 0
  const showPlugins = filter !== 'builtin'
  const showMake = filter === 'all'
  const searching = query.trim() !== ''
  const nothing = searching && (!showPlugins || (summary.loaded && summary.matches === 0)) && (!showBuiltin || builtinHits === 0)

  const chips: { id: AppsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    ...chipCategories.map((category) => ({ id: category, label: PLUGIN_CATEGORY_LABELS[category] })),
    { id: 'get', label: GET_MORE_TITLE },
    { id: 'builtin', label: BUILTIN_APPS_TITLE },
  ]

  return (
    <div className="apps-page-shell" data-ask-open={askRow ? 'true' : undefined}>
    <div className="apps-page" data-testid="apps-page" ref={scrollRef}>
      {detailOpen && (
        <div className="apps-page-inner apps-page-inner--detail">
          <div className="apps-detail-saved"><SettingsSavedIndicator placement="header" /></div>
          {detailPlugin && config ? (
            <PluginDetail store={store} pluginId={detailPlugin} config={config} onSave={paneSave} onBack={closeDetail} onOpen={openPlugin} focusPanel={params.get('panel')} onConfigureWithAi={aiConfigure ? () => setAsk(!askRow) : undefined} askOpen={!!askRow} />
          ) : detailPlugin ? (
            <LoadingState title="Loading plugin…" />
          ) : (
            <BuiltinDetail entryKey={appKey!} onBack={closeDetail} />
          )}
        </div>
      )}
      {home ? (
        <div className="apps-page-inner" hidden={detailOpen}>
          <AppsHome store={store} builtins={shownBuiltins} folded={folded} heldFacts={heldFacts} held={held} onOpenPlugin={openPlugin} onOpenApp={openApp} showSaved={!detailOpen} />
        </div>
      ) : (
      <div className="apps-page-inner" hidden={detailOpen}>
        <header className="apps-hero">
          <span className="apps-hero-icon" aria-hidden="true"><AppsIcon size={26} /></span>
          <div className="apps-hero-text">
            <h1>Apps</h1>
            <p>Plugins add features to Walnut, and apps are its pages on the sidebar. Open one to set it up.</p>
          </div>
          {/* One indicator, in whichever view is showing (the grid stays mounted, hidden). */}
          {!detailOpen && <SettingsSavedIndicator placement="header" />}
          <SearchField fieldClassName="apps-search" data-no-draft="search"
            type="search"
            value={query}
            setText={setQuery}
            onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
            onClear={() => setQuery('')}
            placeholder="Search apps and plugins"
            aria-label="Search apps and plugins"
            data-testid="apps-search"
          />
        </header>

        <ChipGroup className="apps-chips" role="group" aria-label="Show">
          {chips.map((chip) => (
            <Chip
              key={chip.id}
              pressed={filter === chip.id}
              onClick={() => setFilter(chip.id)}
              data-testid={`apps-chip-${chip.id}`}
            >
              {chip.label}
            </Chip>
          ))}
        </ChipGroup>

        {nothing && (
          <EmptyState
            title={`Nothing matches “${query.trim()}”`}
            action={{ label: 'Clear search', onClick: () => setQuery('') }}
            testId="apps-no-match"
          />
        )}

        {filter === 'all' && !searching && <AppQuickOpen activity={activity} />}

        {showPlugins && <PluginStoreGrid store={store} filter={filter} query={query} onSummary={onSummary} onOpen={openPlugin} folded={foldedIds} heldInFilter={categoryHits} />}

        {showMake && !searching && (
          <section className="apps-section" data-testid="apps-make" aria-labelledby="apps-make-title">
            <h2 className="apps-section-title" id="apps-make-title">Make your own</h2>
            <MakeAppCard />
          </section>
        )}

        {/* Last: the built-ins are already on the sidebar, so the page opens on what you can
            add, set up or turn off, and the built-ins sit below for hiding one. */}
        {showBuiltin && builtinHits > 0 && (
          <section className="apps-section" data-testid="apps-builtin" aria-labelledby="apps-builtin-title">
            <h2 className="apps-section-title" id="apps-builtin-title">
              {BUILTIN_APPS_TITLE}
              <span className="apps-section-count">{`${onRail} of ${allParts.length} parts on the sidebar`}</span>
            </h2>
            <BuiltinAppsGrid entries={visibleBuiltins} folded={folded} facts={heldFacts} onOpen={openApp} onOpenPlugin={openPlugin} />
          </section>
        )}
      </div>
      )}
    </div>
    {askRow && (
      <aside className="apps-ask-panel" data-testid="plugin-ask-panel" aria-label={`Configure ${askRow.name} with AI`}>
        <PluginAskDrawer plugin={{ id: askRow.id, name: askRow.name, description: askRow.description }} onClose={() => setAsk(false)} />
      </aside>
    )}
    </div>
  )
}
