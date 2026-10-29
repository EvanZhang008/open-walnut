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
 * Plugins used to live in Settings (`#plugin-store`), which still forwards here.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { AppsIcon } from '@/apps/icons'
import { getAppPreferences, subscribeAppPreferences } from '@/apps/store'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { peekPendingInstall, subscribeOpenLinks } from '@/utils/open-link'
import { BuiltinAppsGrid, BuiltinDetail } from '@/components/apps-page/BuiltinAppsGrid'
import { MakeAppCard } from '@/components/apps-page/MakeAppCard'
import { builtinEntries, builtinMatches } from '@/components/apps-page/builtin-apps'
import { PLUGIN_CATEGORY_LABELS, type AppsFilter } from '@/components/apps-page/categories'
import { PluginStoreGrid, type PluginStoreSummary } from '@/components/apps-page/PluginStoreGrid'
import { PluginDetail } from '@/components/apps-page/PluginDetail'
import { usePluginStore } from '@/components/apps-page/usePluginStore'
import { SettingsLoadingRow } from '@/components/settings/SettingsSection'
import {
  SettingsPaneProvider,
  SettingsSavedIndicator,
  saveErrorMessage,
  useSettingsSaveNotifier,
} from '@/components/settings/settings-pane-context'
import type { Config } from '@open-walnut/core'
import '@/styles/settings-shell.css'
import '@/styles/settings-controls.css'
import '@/styles/apps-page.css'

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
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  const [filter, setFilter] = useState<AppsFilter>('all')
  const [query, setQuery] = useState('')
  const [summary, setSummary] = useState<PluginStoreSummary>({ loaded: false, categories: [], matches: 0 })
  const onSummary = useCallback((next: PluginStoreSummary) => setSummary(next), [])
  // An install link lands here (App.tsx); its card lives in the plugin part, so a
  // filter or a search that hides that part gives way.
  useEffect(() => {
    const show = () => { if (peekPendingInstall()) { setFilter('all'); setQuery(''); setParams({}, { replace: true }) } }
    show()
    return subscribeOpenLinks(show)
  }, [])
  const phone = usePhoneLayout()
  const store = usePluginStore()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const pluginId = params.get('plugin')
  const appKey = params.get('app')
  const detailOpen = Boolean(pluginId || appKey)
  // The grid's scroll position, kept while a detail page is open and put back on return.
  const scrollRef = useRef<HTMLDivElement>(null)
  const gridScroll = useRef(0)
  const openDetail = useCallback((key: 'plugin' | 'app', value: string) => {
    if (!detailOpen) gridScroll.current = scrollRef.current?.scrollTop ?? 0
    setParams({ [key]: value }, { state: { fromApps: true } })
  }, [detailOpen, setParams])
  const openPlugin = useCallback((id: string) => openDetail('plugin', id), [openDetail])
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

  const builtins = useMemo(
    () => builtinEntries(apps.all.filter((app) => app.kind === 'core'), preferences, { phone }),
    [apps.all, preferences, phone],
  )
  const onRail = builtins.filter((entry) => entry.shown).length
  const builtinHits = builtins.filter((entry) => builtinMatches(entry, query)).length
  const showBuiltin = filter === 'all' || filter === 'builtin'
  const showPlugins = filter !== 'builtin'
  const showMake = filter === 'all'
  const searching = query.trim() !== ''
  const nothing = searching && (!showPlugins || (summary.loaded && summary.matches === 0)) && (!showBuiltin || builtinHits === 0)

  const chips: { id: AppsFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    ...summary.categories.map((category) => ({ id: category, label: PLUGIN_CATEGORY_LABELS[category] })),
    { id: 'get', label: 'Get more' },
    { id: 'builtin', label: 'Built in' },
  ]

  return (
    <div className="apps-page" data-testid="apps-page" ref={scrollRef}>
      {detailOpen && (
        <div className="apps-page-inner apps-page-inner--detail">
          <div className="apps-detail-saved"><SettingsSavedIndicator placement="header" /></div>
          {pluginId && config ? (
            <PluginDetail store={store} pluginId={pluginId} config={config} onSave={paneSave} onBack={closeDetail} onOpen={openPlugin} />
          ) : pluginId ? (
            <SettingsLoadingRow>Loading plugin...</SettingsLoadingRow>
          ) : (
            <BuiltinDetail entryKey={appKey!} onBack={closeDetail} />
          )}
        </div>
      )}
      <div className="apps-page-inner" hidden={detailOpen}>
        <header className="apps-hero">
          <span className="apps-hero-icon" aria-hidden="true"><AppsIcon size={26} /></span>
          <div className="apps-hero-text">
            <h1>Apps</h1>
            <p>What Walnut can do. Open one to set it up and see where it comes from.</p>
          </div>
          {/* One indicator, in whichever view is showing (the grid stays mounted, hidden). */}
          {!detailOpen && <SettingsSavedIndicator placement="header" />}
          <label className="apps-search">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
            <input data-no-draft="search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery('') } }}
              placeholder="Search apps and plugins"
              aria-label="Search apps and plugins"
              data-testid="apps-search"
            />
          </label>
        </header>

        <div className="apps-chips" role="group" aria-label="Show">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              aria-pressed={filter === chip.id}
              className={`apps-chip${filter === chip.id ? ' is-on' : ''}`}
              onClick={() => setFilter(chip.id)}
              data-testid={`apps-chip-${chip.id}`}
            >
              {chip.label}
            </button>
          ))}
        </div>

        {nothing && (
          <div className="apps-empty" data-testid="apps-no-match">
            Nothing matches &ldquo;{query.trim()}&rdquo;.
            <button type="button" onClick={() => setQuery('')}>Clear search</button>
          </div>
        )}

        {showPlugins && <PluginStoreGrid store={store} filter={filter} query={query} onSummary={onSummary} onOpen={openPlugin} />}

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
              Built in
              <span className="apps-section-count">{`${onRail} of ${builtins.length} on the sidebar`}</span>
            </h2>
            <BuiltinAppsGrid query={query} onOpen={openApp} />
          </section>
        )}
      </div>
    </div>
  )
}
