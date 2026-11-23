/**
 * The Store half of the Apps home screen (experiment `apps_home`): what you can add, and the
 * sources you added from. On top, two ordinary buttons, Make your own and Add from a git or npm
 * link, each opening its form in place; then one card per plugin you can get, its icon, name and
 * what it does beside its Get, and its picture under it when the plugin ships one (manifest
 * `screenshot`; no picture, no room taken); then each installed source with its own verbs (Copy
 * install link, Update, Remove), which used to head its section of installed plugins.
 *
 * An optional plugin of a source you have gets in one press (its source is already trusted); any
 * other plugin's Get opens its page, which says where it comes from before Install.
 */
import { useState } from 'react'
import { PluginIcon, pluginTileTints, useIconSrc } from '@/components/settings/PluginIcon'
import { PluginSourceHead, UpdatesHead } from '@/components/settings/sections/PluginSourcesGroup'
import { firstSentence } from '@/components/settings/sections/plugin-row-view'
import { BUNDLED_AVAILABLE_TITLE, STORE_OPTIONAL_TITLE } from '@/components/settings/sections/plugin-bundled-actions'
import { usePageView } from '@/utils/view-memory'
import { EmptyState, LoadingState } from '@/components/common/EmptyState'
import { pluginMatches } from './categories'
import { MakeAppCard } from './MakeAppCard'
import { AddSourceForm, LinkRequestCards, PendingDependencies, StoreNotices, useAddSource } from './PluginAddFlows'
import { originKind, type RegistryRow } from './plugin-store-model'
import { SettingsTag } from '@/components/settings/SettingsSection'
import { sourceSections } from './source-sections'
import type { PluginStore } from './usePluginStore'

const isOpenForm = (v: unknown): v is 'none' | 'make' => v === 'none' || v === 'make'

/** A plugin's own picture under its card; one that fails to load takes no room. */
function StorePicture({ url, name, onOpen }: { url: string; name: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  const picture = useIconSrc(url)
  if (failed || picture.failed || !picture.src) return null
  return (
    // The card's name opens its page from the keys; the picture is the same for the pointer.
    <div className="apps-store-picture" onClick={onOpen} data-testid="apps-store-picture">
      <img src={picture.src} alt={`${name} screenshot`} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
    </div>
  )
}

function StoreItem({ row, tint, store, onOpen }: { row: RegistryRow; tint: string; store: PluginStore; onOpen: (id: string) => void }) {
  const oneStep = !!row.sourceSlug
  const busy = store.busy === row.id
  return (
    <div className="apps-store-card" data-testid={`apps-store-item-${row.id}`} data-has-picture={row.screenshotUrl ? 'true' : undefined}>
      <div className="apps-store-card-top">
        {/* The icon, name and line are one press that opens the plugin's page, as an Installed item; Get sits beside it, not in it. */}
        <div
          role="button"
          tabIndex={0}
          className="apps-store-card-open"
          onClick={() => onOpen(row.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(row.id) } }}
          aria-label={`${row.name}: details`}
          data-testid={`apps-store-details-${row.id}`}
        >
          <PluginIcon name={row.name} iconUrl={row.iconUrl} tint={tint} size="lg" />
          <div className="apps-store-card-text">
            <span className="apps-store-card-name wn-title">{row.name}</span>
            <span className="apps-store-card-line wn-title">
              {firstSentence(row.description) || (row.source.kind === 'bundled' ? BUNDLED_AVAILABLE_TITLE : STORE_OPTIONAL_TITLE)}
            </span>
            <span className="apps-store-card-kind"><SettingsTag tone="neutral">{originKind(row)}</SettingsTag></span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm apps-store-get"
          disabled={busy}
          onClick={() => (oneStep ? void store.handleBundled(row, 'install') : onOpen(row.id))}
          aria-label={`Get ${row.name}`}
          data-testid={`apps-store-get-${row.id}`}
        >
          {busy ? 'Installing...' : 'Get'}
        </button>
      </div>
      {row.screenshotUrl && <StorePicture url={row.screenshotUrl} name={row.name} onOpen={() => onOpen(row.id)} />}
    </div>
  )
}

export function AppsStore({ store, query, onOpen }: { store: PluginStore; query: string; onOpen: (pluginId: string) => void }) {
  const add = useAddSource(store)
  const [form, setForm] = usePageView<'none' | 'make'>('apps', 'store-form', 'none', isOpenForm)
  const tints = pluginTileTints(store.rows)
  // Optional plugins of a source you have first: they install in one press.
  const rows = [...store.available.filter((row) => !!row.sourceSlug), ...store.available.filter((row) => !row.sourceSlug)]
    .filter((row) => pluginMatches(row, query))
  const searching = query.trim() !== ''
  const sources = sourceSections(store.installed, store.sources).filter((section) => section.kind === 'source' && section.source)
  return (
    <div className="apps-store" data-testid="apps-store">
      <StoreNotices store={store} />
      <LinkRequestCards store={store} />

      <div className="apps-store-actions">
        <button type="button" className="btn btn-sm" aria-expanded={form === 'make'} onClick={() => setForm(form === 'make' ? 'none' : 'make')} data-testid="apps-store-make">
          Make your own
        </button>
        <button type="button" className="btn btn-sm" aria-expanded={add.open} onClick={add.toggle} data-testid="apps-add-from-link">
          Add from a git or npm link
        </button>
      </div>
      {form === 'make' && <div className="apps-store-form" data-testid="apps-make"><MakeAppCard /></div>}
      <AddSourceForm store={store} add={add} />
      <PendingDependencies store={store} />

      <section className="apps-section" aria-labelledby="apps-store-get-title" data-testid="plugin-store-available">
        <h2 className="apps-section-title" id="apps-store-get-title">Plugins to add</h2>
        {!store.registry ? (
          <LoadingState title="Loading plugins…" size="row" />
        ) : rows.length === 0 ? (
          <EmptyState
            testId="apps-store-empty"
            title={searching ? <>Nothing in the store matches &ldquo;{query.trim()}&rdquo;</> : 'Everything you can add is installed'}
            hint={searching ? undefined : 'Add more from a git or npm link.'}
          />
        ) : (
          <div className="apps-store-grid">
            {rows.map((row) => <StoreItem key={row.id} row={row} tint={tints.get(row.id) ?? 'var(--fg-muted)'} store={store} onOpen={onOpen} />)}
          </div>
        )}
      </section>

      {!searching && sources.length > 0 && (
        <section className="apps-section" aria-labelledby="apps-store-sources-title" data-testid="apps-store-sources">
          <div className="apps-store-sources-head">
            <h2 className="apps-section-title" id="apps-store-sources-title">Your sources</h2>
            {store.updatable.length > 0 && <span data-testid="apps-home-updates"><UpdatesHead updates={store.updates} slowLoad={store.slowLoad} onCheckAll={store.checkAll} /></span>}
          </div>
          <p className="apps-section-sub">Where your added plugins come from. Update or remove a source here.</p>
          {sources.map((section) => (
            <div key={section.id} className="apps-source" data-testid={`apps-source-${section.source!.slug}`}>
              <h3 className="apps-store-source-title">{section.title}</h3>
              <div className="apps-source-head">
                <PluginSourceHead
                  source={section.source!}
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
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
