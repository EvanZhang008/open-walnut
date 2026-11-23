/**
 * The plugin half of the Apps page, as a store: one card per plugin, grouped by where it
 * comes from (source-sections.ts): built into Walnut, one section per installed source with
 * that source's verbs on its head, and plugins in a folder on this computer; a category chip
 * narrows them all. Then Get more (what you can add, a git or npm link). A card says
 * what it is and its one status; everything else (settings, the switch, where it comes
 * from, Update) lives on its detail page. A plugin that is a part of another (`slack-mcp`
 * of Slack, a mail account of Mail) has no card of its own: its parent's card names it,
 * and its parent's detail page holds it. A plugin a built-in app carries (Calendar, Mail) is
 * that app's card in Built-in sidebar apps, never a second card here. A plugin with an App has Open and
 * that App's sidebar switch on its card, as a built-in app has.
 */
import { useEffect, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import type { RegisteredApp } from '@/apps/registry'
import { SettingsGroup, SettingsRow } from '@/components/settings/SettingsSection'
import { EmptyState, LoadingState } from '@/components/common/EmptyState'
import { PluginIcon, pluginTileTints } from '@/components/settings/PluginIcon'
import { PluginSourceHead, UpdatesHead } from '@/components/settings/sections/PluginSourcesGroup'
import { firstSentence } from '@/components/settings/sections/plugin-row-view'
import { BUNDLED_AVAILABLE_TITLE, STORE_OPTIONAL_TITLE } from '@/components/settings/sections/plugin-bundled-actions'
import { GET_MORE_TITLE, PLUGIN_CATEGORY_ORDER, categoryOf, pluginMatches, type AppsFilter, type PluginCategoryId } from './categories'
import { AppBadge, AppsGrid, SidebarSwitch } from './app-bits'
import { StoreCard, type StoreCardPart } from './StoreCard'
import { appsOfPlugin, originKind, partParents, type RegistryRow } from './plugin-store-model'
import { pluginCardFacts } from './plugin-card-facts'
import { updateAppOnSidebar } from '@/apps/store'
import type { PluginStore } from './usePluginStore'
import { sourceSections, type SourceSection } from './source-sections'
import { AddSourceForm, LinkRequestCards, PendingDependencies, StoreNotices, useAddSource } from './PluginAddFlows'
import '@/styles/settings-sections-addons.css'

export interface PluginStoreSummary {
  loaded: boolean
  categories: PluginCategoryId[]
  matches: number
}

/** What a section of installed plugins says under its title (a source's head says it for a source). */
const SECTION_SUB: Record<'builtin' | 'local', string> = {
  builtin: 'They ship with Walnut. Open one to turn it on or off, or to set it up.',
  local: 'In a folder on this computer that no source installed, so nothing updates them.',
}

/** A card's line for a plugin with no description: where it comes from, said plainly. */
function fallbackLine(row: RegistryRow): string {
  if (row.installed) return originKind(row)
  if (row.source.kind === 'builtin') return 'Ships with Walnut, but not in this build.'
  if (row.source.kind === 'bundled') return BUNDLED_AVAILABLE_TITLE
  if (row.sourceSlug) return STORE_OPTIONAL_TITLE
  return originKind(row)
}

export function PluginStoreGrid({ store, filter, query, onSummary, onOpen, folded, heldInFilter = 0 }: {
  store: PluginStore
  /** Built-in cards the picked chip shows (Calendar under Time): an empty plugin group says nothing. */
  heldInFilter?: number
  /** Plugins a built-in app's card holds (Calendar, Mail): they have no card here. */
  folded?: ReadonlySet<string>
  filter: AppsFilter
  query: string
  onSummary?: (summary: PluginStoreSummary) => void
  /** Opens a plugin's detail page. */
  onOpen: (pluginId: string) => void
}) {
  const navigate = useNavigate()
  const catalog = useAppCatalog()
  const { registry, installed, available } = store
  const add = useAddSource(store)

  // One tint per plugin across both lists, picked the way the Settings sidebar picks them.
  const tints = pluginTileTints(store.rows)
  const parentOf = partParents(installed)
  const partsOf = (id: string) => installed.filter((row) => parentOf.get(row.id) === id)
  const topLevel = installed.filter((row) => !parentOf.has(row.id) && !folded?.has(row.id))
  // A held plugin (Calendar, Mail) is a built-in app's card, not a part.
  const partCount = installed.filter((row) => parentOf.has(row.id)).length
  // An optional plugin of an installed source waits under that source, not under Get more.
  const waiting = available.filter((row) => !!row.sourceSlug)
  // A search finds a plugin by its parts too: "MCP" finds Slack, which holds its MCP server.
  const matches = (row: RegistryRow) => pluginMatches(row, query) || partsOf(row.id).some((part) => pluginMatches(part, query))

  const showGroups = filter === 'all' || (PLUGIN_CATEGORY_ORDER as readonly string[]).includes(filter)
  const showGetMore = filter === 'all' || filter === 'get'
  const categoryRank = (row: RegistryRow) => PLUGIN_CATEGORY_ORDER.indexOf(categoryOf(row))
  const shown = [...topLevel, ...waiting]
    .filter((row) => matches(row) && (filter === 'all' || categoryOf(row) === filter))
    .map((row, index) => ({ row, index }))
    .sort((a, b) => categoryRank(a.row) - categoryRank(b.row) || a.index - b.index)
    .map(({ row }) => row)
  const narrowed = filter !== 'all' || query.trim() !== ''
  // A source whose plugins did not load keeps its section on the full page (its Restore and
  // Remove live on its head); a filter or a search shows only sections with a match.
  const groups = sourceSections(shown, store.sources)
    .filter((section) => section.rows.length > 0 || (section.kind === 'source' && !narrowed))
  const matchingAvailable = available.filter((row) => !row.sourceSlug && pluginMatches(row, query))
  const searching = query.trim() !== ''
  const presentKey = PLUGIN_CATEGORY_ORDER.filter((category) => [...topLevel, ...waiting].some((row) => categoryOf(row) === category)).join(',')
  const matchCount = (showGroups ? groups.reduce((n, group) => n + group.rows.length, 0) : 0) + (showGetMore ? matchingAvailable.length : 0)
  const loaded = registry !== null
  useEffect(() => {
    onSummary?.({ loaded, categories: presentKey ? presentKey.split(',') as PluginCategoryId[] : [], matches: matchCount })
  }, [onSummary, loaded, presentKey, matchCount])

  const onSidebar = new Set(catalog.sidebar.map((app) => app.key))
  const card = (row: RegistryRow) => {
    const apps = row.installed ? appsOfPlugin(catalog.all, row.id) : []
    const app = apps[0]
    const { status, note } = pluginCardFacts(store, row)
    // Every App of a plugin has its sidebar switch on the card, as a built-in app has (one App:
    // in the footer; several: a row each).
    const appSwitch = (target: RegisteredApp, labelled = false) => (
      <SidebarSwitch name={target.title} shown={onSidebar.has(target.key)} onChange={(next) => updateAppOnSidebar(target, next)} testId={`plugin-card-toggle-${target.key}`} labelled={labelled} />
    )
    const parts: StoreCardPart[] | undefined = apps.length > 1
      ? apps.map((target) => ({ id: target.key, title: target.title, kind: 'App', shown: onSidebar.has(target.key), control: appSwitch(target) }))
      : undefined
    return (
      <StoreCard
        key={row.id}
        testId={`plugin-card-${row.id}`}
        data={{ 'data-plugin-status': row.status }}
        icon={<PluginIcon name={row.name} iconUrl={row.iconUrl} tint={tints.get(row.id) ?? 'var(--fg-muted)'} size="lg" />}
        name={row.name}
        badge={app ? <AppBadge app={app} /> : undefined}
        line={firstSentence(row.description) || fallbackLine(row)}
        note={note}
        parts={parts}
        status={status}
        kind={originKind(row)}
        dim={row.installed && (row.status === 'disabled' || row.status === 'unsupported')}
        onSelect={() => onOpen(row.id)}
        control={!row.installed && row.sourceSlug ? (
          <button
            type="button"
            className="apps-card-open"
            disabled={store.busy === row.id}
            onClick={() => void store.handleBundled(row, 'install')}
            data-testid={`plugin-card-install-${row.id}`}
            aria-label={`Install ${row.name}`}
          >
            {store.busy === row.id ? 'Installing...' : 'Install'}
          </button>
        ) : apps.length === 1 ? appSwitch(apps[0], true) : undefined}
        // An App is registered only while its plugin runs, so Open is never a dead button.
        open={app ? { label: 'Open', onClick: () => navigate(app.path), testId: `plugin-card-open-${row.id}` } : undefined}
      />
    )
  }

  return (
    <div id="plugin-store" className="apps-plugins" data-testid="apps-plugins">
      <StoreNotices store={store} />

      <LinkRequestCards store={store} />

      {showGroups && (
        <div className="apps-plugin-groups plugin-store-installed" data-testid="plugin-store-installed">
          <div className="apps-plugins-bar">
            <span className="apps-plugins-count" data-testid="apps-plugins-count">
              {!registry ? '' : `${topLevel.length} plugin${topLevel.length === 1 ? '' : 's'} installed${partCount > 0 ? `, plus ${partCount} included in them` : ''}`}
            </span>
            {store.updatable.length > 0 && <UpdatesHead updates={store.updates} slowLoad={store.slowLoad} onCheckAll={store.checkAll} />}
          </div>
          {!registry ? (
            <SettingsGroup className="plugin-store-group"><LoadingState title="Loading plugins…" /></SettingsGroup>
          ) : installed.length === 0 ? (
            <SettingsGroup className="plugin-store-group"><EmptyState title="No plugins installed yet" /></SettingsGroup>
          ) : groups.length === 0 ? (
            searching || heldInFilter > 0 ? null : <SettingsGroup className="plugin-store-group"><EmptyState title="No plugins in this group yet" /></SettingsGroup>
          ) : (
            groups.map((section) => (
              <SourceSectionView key={section.id} section={section} store={store} card={card} />
            ))
          )}
        </div>
      )}

      {showGetMore && (
        <section className="apps-section apps-get-more" data-testid="apps-get-more" aria-labelledby="apps-get-more-title">
          <h2 className="apps-section-title" id="apps-get-more-title">{GET_MORE_TITLE}</h2>
          <p className="apps-section-sub">Plugins you can add in one click, or from any git or npm link.</p>
          <AppsGrid data-testid="plugin-store-available">
            {matchingAvailable.map(card)}
            {!searching && (
              <button
                type="button"
                className="apps-card apps-card-add"
                aria-expanded={add.open}
                onClick={add.toggle}
                data-testid="apps-add-from-link"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                <span>Add from a git or npm link</span>
              </button>
            )}
          </AppsGrid>

          <AddSourceForm store={store} add={add} />
          <PendingDependencies store={store} />

        </section>
      )}
    </div>
  )
}

/**
 * One section of installed plugins: its title (the source's name), the source's head with
 * its verbs (a source only), and the plugins' cards.
 */
function SourceSectionView({ section, store, card }: {
  section: SourceSection
  store: PluginStore
  card: (row: RegistryRow) => ReactElement
}) {
  const testId = section.source ? `apps-source-${section.source.slug}` : `apps-source-${section.id}`
  const titleId = `${testId}-title`
  return (
    <section className="apps-section apps-source" data-testid={testId} data-source-kind={section.kind} aria-labelledby={titleId}>
      <h2 className="apps-section-title" id={titleId}>
        {section.title}
        {section.rows.length > 0 && <span className="apps-section-count">{section.rows.length}</span>}
      </h2>
      {section.source ? (
        <div className="apps-source-head">
          <PluginSourceHead
            source={section.source}
            ownedSlugs={store.ownedSlugs}
            updates={store.updates}
            busy={store.busy}
            copiedKey={store.copiedKey}
            feedback={store.feedback}
            cardsShown={section.rows.length > 0}
            onCopy={store.copy}
            onUpdate={(slug, kind, feedbackId) => void store.handleUpdate(slug, kind, feedbackId)}
            onRemove={(slug) => void store.handleRemove(slug)}
            setRowFeedback={store.setRowFeedback}
          />
        </div>
      ) : (
        <p className="apps-section-sub">{SECTION_SUB[section.kind as 'builtin' | 'local']}</p>
      )}
      {section.rows.length > 0 && <AppsGrid>{section.rows.map(card)}</AppsGrid>}
    </section>
  )
}
