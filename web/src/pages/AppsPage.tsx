/**
 * /apps: everything Walnut can do, in one place the sidebar points at.
 *
 * Top to bottom: the built-in apps (each with the switch that keeps it on the rail
 * or takes it off), then the plugins grouped by category, each group led by the Apps
 * its plugins add, then Get more (the catalog, a git or npm link, the sources), then
 * Make your own. The chips filter the page to one of those; the search box narrows
 * every part at once.
 *
 * Plugins used to live in Settings (`#plugin-store`), which still forwards here.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppCatalog } from '@/apps/hooks'
import { AppsIcon } from '@/apps/icons'
import { getAppPreferences, subscribeAppPreferences } from '@/apps/store'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import { usePhoneLayout } from '@/hooks/usePhoneLayout'
import { peekPendingInstall, subscribeOpenLinks } from '@/utils/open-link'
import { BuiltinAppsGrid } from '@/components/apps-page/BuiltinAppsGrid'
import { MakeAppCard } from '@/components/apps-page/MakeAppCard'
import { builtinEntries, builtinMatches } from '@/components/apps-page/builtin-apps'
import { PLUGIN_CATEGORY_LABELS, type AppsFilter } from '@/components/apps-page/categories'
import { PluginStoreSection, type PluginStoreSummary } from '@/components/settings/sections/PluginStoreSection'
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
    const show = () => { if (peekPendingInstall()) { setFilter('all'); setQuery('') } }
    show()
    return subscribeOpenLinks(show)
  }, [])
  const phone = usePhoneLayout()

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
    { id: 'builtin', label: 'Built in' },
    ...summary.categories.map((category) => ({ id: category, label: PLUGIN_CATEGORY_LABELS[category] })),
    { id: 'get', label: 'Get more' },
  ]

  return (
    <div className="apps-page" data-testid="apps-page">
      <div className="apps-page-inner">
        <header className="apps-hero">
          <span className="apps-hero-icon" aria-hidden="true"><AppsIcon size={26} /></span>
          <div className="apps-hero-text">
            <h1>Apps</h1>
            <p>What Walnut can do, what sits in your sidebar, and where to get more.</p>
          </div>
          <SettingsSavedIndicator placement="header" />
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

        {showBuiltin && builtinHits > 0 && (
          <section className="apps-section" data-testid="apps-builtin" aria-labelledby="apps-builtin-title">
            <h2 className="apps-section-title" id="apps-builtin-title">
              Built in
              <span className="apps-section-count">{`${onRail} of ${builtins.length} on the sidebar`}</span>
            </h2>
            <p className="apps-section-sub">
              Switch one off to take its icon off the sidebar. It keeps working from links and
              the Command Palette, and you can switch it back on here.
            </p>
            <BuiltinAppsGrid query={query} />
          </section>
        )}

        {showPlugins && (config ? (
          <PluginStoreSection config={config} onSave={paneSave} filter={filter} query={query} onSummary={onSummary} />
        ) : (
          <SettingsLoadingRow>Loading plugins...</SettingsLoadingRow>
        ))}

        {showMake && !searching && (
          <section className="apps-section" data-testid="apps-make" aria-labelledby="apps-make-title">
            <h2 className="apps-section-title" id="apps-make-title">Make your own</h2>
            <MakeAppCard />
          </section>
        )}
      </div>
    </div>
  )
}
