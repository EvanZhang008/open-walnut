/**
 * The plugin half of the Apps page, as a store: one card per plugin in its category,
 * then Get more (what you can add, a git or npm link, the installed sources). A card says
 * what it is and its one status; everything else (settings, the switch, where it comes
 * from, Update) lives on its detail page. A plugin that is a part of another (`slack-mcp`
 * of Slack, a mail account of Mail) has no card of its own: its parent's card names it,
 * and its parent's detail page holds it.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import type { RegisteredApp } from '@/apps/registry'
import { SettingsGroup, SettingsLoadingRow, SettingsNotice, SettingsRow } from '@/components/settings/SettingsSection'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'
import { PluginIcon, pluginTileTints } from '@/components/settings/PluginIcon'
import { CONNECTION_BADGE } from '@/components/settings/PluginConnectionPanel'
import { PluginPendingDependencies } from '@/components/settings/sections/PluginDependencyRows'
import { PluginSourcesGroup, UpdatesHead } from '@/components/settings/sections/PluginSourcesGroup'
import { firstSentence } from '@/components/settings/sections/plugin-row-view'
import { BUNDLED_AVAILABLE_TITLE } from '@/components/settings/sections/plugin-bundled-actions'
import { buildInstallLink, INSTALL_LINK_SCHEME, type InstallLinkTarget } from '../../../../src/core/plugin-install-link'
import { peekPendingInstall, settlePendingInstall, subscribeOpenLinks } from '@/utils/open-link'
import { useDraft } from '@/hooks/useDraft'
import { draftKey } from '@/utils/drafts'
import { PLUGIN_CATEGORY_LABELS, PLUGIN_CATEGORY_ORDER, categoryOf, pluginMatches, type AppsFilter, type PluginCategoryId } from './categories'
import { AppBadge } from './app-bits'
import { StoreCard } from './StoreCard'
import { cardStatus, originKind, partParents, type RegistryRow } from './plugin-store-model'
import type { PluginStore } from './usePluginStore'
import '@/styles/settings-sections-addons.css'

export interface PluginStoreSummary {
  loaded: boolean
  categories: PluginCategoryId[]
  matches: number
}

/** A git remote the local git can clone; anything else is treated as an npm spec. */
function looksLikeGitUrl(value: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/.test(value)
}

/** What the link card says when its install fails: the reason in plain words first. */
function linkFailureText(err: unknown): string {
  const e = err as { message?: string; gitCause?: unknown; sentence?: unknown }
  if (e?.gitCause === 'auth') return "Couldn't get the plugins: this account has no access to that repository. Ask whoever shared the link for access, then try again."
  if (e?.gitCause === 'network') return "Couldn't get the plugins: the repository could not be reached. Check the network or VPN, then try again."
  if (typeof e?.sentence === 'string' && e.gitCause && e.gitCause !== 'unknown') return `Couldn't get the plugins: ${e.sentence}`
  return `Couldn't get the plugins from that source. ${e?.message ?? String(err)}`
}

/** A card's line for a plugin with no description: where it comes from, said plainly. */
function fallbackLine(row: RegistryRow): string {
  if (row.installed) return originKind(row)
  if (row.source.kind === 'builtin') return 'Ships with Walnut, but not in this build.'
  if (row.source.kind === 'bundled') return BUNDLED_AVAILABLE_TITLE
  return originKind(row)
}

/** The Apps a plugin adds, in catalog order. */
export function appsOfPlugin(apps: readonly RegisteredApp[], pluginId: string): RegisteredApp[] {
  return apps.filter((app) => app.kind !== 'core' && app.pluginId === pluginId)
}

export function StoreNotices({ store }: { store: PluginStore }) {
  return (
    <>
      {/* Only Remove needs a page-level word: no plugin survives to carry the tag. */}
      {store.restartNeeded && <SettingsNotice kind="warn">Restart Walnut to finish removing that plugin&apos;s code.</SettingsNotice>}
      {store.error && <SettingsNotice kind="error" role="alert">{store.error}</SettingsNotice>}
      {store.notice && <SettingsNotice kind="success">{store.notice}</SettingsNotice>}
    </>
  )
}

export function PluginStoreGrid({ store, filter, query, onSummary, onOpen }: {
  store: PluginStore
  filter: AppsFilter
  query: string
  onSummary?: (summary: PluginStoreSummary) => void
  /** Opens a plugin's detail page. */
  onOpen: (pluginId: string) => void
}) {
  const navigate = useNavigate()
  const catalog = useAppCatalog()
  const { registry, installed, available } = store
  // A source typed or pasted and not installed yet survives leaving the page; a successful Add ends it.
  const urlDraft = useDraft(draftKey('plugin-source', 'new'))
  const { text: url, setText: setUrl } = urlDraft
  const [trusted, setTrusted] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const urlInputRef = useRef<HTMLInputElement>(null)
  // A source an install link asked for (utils/open-link.ts), shown in its own card.
  const [linkRequest, setLinkRequest] = useState<InstallLinkTarget | null>(null)
  const [linkTrusted, setLinkTrusted] = useState(false)
  const [linkError, setLinkError] = useState<string | null>(null)

  // An install link someone clicked: its own card at the top, where the page lands, with
  // trust off. A newer link replaces it. It stays pending until Install or Cancel.
  useEffect(() => {
    const take = () => {
      const target = peekPendingInstall()
      if (!target) return
      setLinkRequest(target)
      setLinkTrusted(false)
      setLinkError(null)
      store.setNotice(null)
      store.setError(null)
    }
    take()
    return subscribeOpenLinks(take)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A source typed earlier and not installed yet keeps the form open.
  useEffect(() => { if (url.trim()) setAddOpen(true) }, [url])

  const handleAdd = async () => {
    const value = url.trim()
    if (!value || !trusted) return
    store.setBusy('add')
    store.setError(null)
    store.setNotice(null)
    const sentKey = urlDraft.key
    try {
      const isSnippet = value.startsWith('{')
      const isInstallLink = value.toLowerCase().startsWith(INSTALL_LINK_SCHEME)
      await store.installSource(isSnippet || isInstallLink || looksLikeGitUrl(value) ? { url: value } : { spec: value })
      urlDraft.clear(sentKey)
      setTrusted(false) // trust is granted per install, never sticky
    } catch (err) {
      store.setError(err instanceof Error ? err.message : String(err))
    } finally {
      store.setBusy(null)
    }
  }

  const handleLinkInstall = async () => {
    if (!linkRequest || !linkTrusted) return
    const target = linkRequest
    store.setBusy('link')
    setLinkError(null)
    store.setNotice(null)
    store.setError(null)
    try {
      await store.installSource({ url: buildInstallLink(target) })
      settlePendingInstall(target)
      setLinkRequest((current) => (current === target ? null : current))
      setLinkTrusted(false)
    } catch (err) {
      setLinkError(linkFailureText(err))
    } finally {
      store.setBusy(null)
    }
  }

  // One tint per plugin across both lists, picked the way the Settings sidebar picks them.
  const tints = pluginTileTints(store.rows)
  const parentOf = partParents(installed)
  const partsOf = (id: string) => installed.filter((row) => parentOf.get(row.id) === id)
  const topLevel = installed.filter((row) => !parentOf.has(row.id))
  // A search finds a plugin by its parts too: "MCP" finds Slack, which holds its MCP server.
  const matches = (row: RegistryRow) => pluginMatches(row, query) || partsOf(row.id).some((part) => pluginMatches(part, query))

  const showGroups = filter === 'all' || (PLUGIN_CATEGORY_ORDER as readonly string[]).includes(filter)
  const showGetMore = filter === 'all' || filter === 'get'
  const groups = PLUGIN_CATEGORY_ORDER
    .filter((category) => filter === 'all' || filter === category)
    .map((category) => ({ category, rows: topLevel.filter((row) => matches(row) && categoryOf(row) === category) }))
    .filter((group) => group.rows.length > 0)
  const matchingAvailable = available.filter((row) => pluginMatches(row, query))
  const searching = query.trim() !== ''
  const presentKey = PLUGIN_CATEGORY_ORDER.filter((category) => topLevel.some((row) => categoryOf(row) === category)).join(',')
  const matchCount = (showGroups ? groups.reduce((n, group) => n + group.rows.length, 0) : 0) + (showGetMore ? matchingAvailable.length : 0)
  const loaded = registry !== null
  useEffect(() => {
    onSummary?.({ loaded, categories: presentKey ? presentKey.split(',') as PluginCategoryId[] : [], matches: matchCount })
  }, [onSummary, loaded, presentKey, matchCount])

  const card = (row: RegistryRow) => {
    const parts = partsOf(row.id)
    const apps = row.installed ? appsOfPlugin(catalog.all, row.id) : []
    const app = apps[0]
    const connection = store.connections[row.id]
    const connectionAlert = connection && connection.state !== 'connected' && connection.state !== 'signing-in'
      ? CONNECTION_BADGE[connection.state]?.label
      : undefined
    const own = cardStatus(row, { update: store.stateFor(row), connectionAlert })
    // A part has no card, so a part that fails or needs setup speaks on its parent's card.
    const partAlert = own.tone === 'on' || own.tone === 'update'
      ? parts.map((part) => ({ part, status: cardStatus(part) })).find(({ status }) => status.tone === 'bad')
        ?? parts.map((part) => ({ part, status: cardStatus(part) })).find(({ status }) => status.tone === 'warn')
      : undefined
    const status = partAlert ? { text: `${partAlert.part.name}: ${partAlert.status.text}`, tone: partAlert.status.tone } : own
    return (
      <StoreCard
        key={row.id}
        testId={`plugin-card-${row.id}`}
        data={{ 'data-plugin-status': row.status }}
        icon={<PluginIcon name={row.name} iconUrl={row.iconUrl} tint={tints.get(row.id) ?? 'var(--fg-muted)'} size="lg" />}
        name={row.name}
        badge={app ? <AppBadge app={app} /> : undefined}
        line={firstSentence(row.description) || fallbackLine(row)}
        note={parts.length > 0 ? `Includes ${parts.map((part) => part.name).join(', ')}` : undefined}
        status={status}
        kind={originKind(row)}
        dim={row.installed && (row.status === 'disabled' || row.status === 'unsupported')}
        onSelect={() => onOpen(row.id)}
        // An App is registered only while its plugin runs, so Open is never a dead button.
        open={app ? { label: 'Open', onClick: () => navigate(app.path), testId: `plugin-card-open-${row.id}` } : undefined}
      />
    )
  }

  return (
    <div id="plugin-store" className="apps-plugins" data-testid="apps-plugins">
      <StoreNotices store={store} />

      {linkRequest && (
        <SettingsGroup heading="Install from a link" className="plugin-store-group plugin-link-request" data-testid="plugin-link-request">
          <SettingsRow
            label="Source"
            help={
              <code className="settings-addons-mono" data-testid="plugin-link-source">
                {linkRequest.kind === 'npm' ? linkRequest.spec : linkRequest.url}
                {linkRequest.kind === 'git' && linkRequest.ref ? ` (branch ${linkRequest.ref})` : ''}
              </code>
            }
            error={linkError ?? undefined}
            control={
              <span className="settings-addons-inline">
                <SettingsButton variant="text" disabled={store.busy === 'link'} onClick={() => { settlePendingInstall(linkRequest); setLinkRequest(null); setLinkError(null) }} data-testid="plugin-link-cancel">
                  Cancel
                </SettingsButton>
                <SettingsButton
                  variant="primary"
                  disabled={!linkTrusted}
                  title={!linkTrusted ? 'Turn on the trust switch first.' : undefined}
                  busy={store.busy === 'link'}
                  busyLabel="Installing..."
                  onClick={() => void handleLinkInstall()}
                  data-testid="plugin-link-install"
                >
                  Install
                </SettingsButton>
              </span>
            }
          />
          <SettingsRow
            label={<span className="plugin-trust-label">I trust this source</span>}
            htmlFor="plugin-link-trust"
            help="A link only names the source. Its code runs inside Walnut with full access to your tasks, notes, credentials and this computer."
            control={<ToggleSwitch id="plugin-link-trust" data-testid="plugin-link-trust" checked={linkTrusted} onChange={setLinkTrusted} />}
          />
        </SettingsGroup>
      )}

      {showGroups && (
        <div className="apps-plugin-groups plugin-store-installed" data-testid="plugin-store-installed">
          <div className="apps-plugins-bar">
            <span className="apps-plugins-count" data-testid="apps-plugins-count">
              {!registry ? '' : `${topLevel.length} plugin${topLevel.length === 1 ? '' : 's'} installed${installed.length > topLevel.length ? `, plus ${installed.length - topLevel.length} part${installed.length - topLevel.length === 1 ? '' : 's'}` : ''}`}
            </span>
            {store.updatable.length > 0 && <UpdatesHead updates={store.updates} slowLoad={store.slowLoad} onCheckAll={store.checkAll} />}
          </div>
          {!registry ? (
            <SettingsGroup className="plugin-store-group"><SettingsLoadingRow>Loading plugins...</SettingsLoadingRow></SettingsGroup>
          ) : installed.length === 0 ? (
            <SettingsGroup className="plugin-store-group"><SettingsRow label="No plugins yet." /></SettingsGroup>
          ) : groups.length === 0 ? (
            searching ? null : <SettingsGroup className="plugin-store-group"><SettingsRow label="No plugins in this group yet." /></SettingsGroup>
          ) : (
            groups.map((group) => (
              <section key={group.category} className="apps-section apps-category" data-testid={`apps-category-${group.category}`} aria-labelledby={`apps-category-${group.category}-title`}>
                <h2 className="apps-section-title" id={`apps-category-${group.category}-title`}>
                  {PLUGIN_CATEGORY_LABELS[group.category]}
                  <span className="apps-section-count">{group.rows.length}</span>
                </h2>
                <div className="apps-grid">{group.rows.map(card)}</div>
              </section>
            ))
          )}
        </div>
      )}

      {showGetMore && (
        <section className="apps-section apps-get-more" data-testid="apps-get-more" aria-labelledby="apps-get-more-title">
          <h2 className="apps-section-title" id="apps-get-more-title">Get more</h2>
          <p className="apps-section-sub">Plugins you can add in one click, or from any git or npm link.</p>
          <div className="apps-grid" data-testid="plugin-store-available">
            {matchingAvailable.map(card)}
            {!searching && (
              <button
                type="button"
                className="apps-card apps-card-add"
                aria-expanded={addOpen}
                onClick={() => {
                  setAddOpen((open) => !open)
                  if (!addOpen) requestAnimationFrame(() => urlInputRef.current?.focus())
                }}
                data-testid="apps-add-from-link"
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                <span>Add from a git or npm link</span>
              </button>
            )}
          </div>

          {/* The free-form install, for anything the catalog does not list. */}
          {(addOpen || url.trim() !== '') && (
            <SettingsGroup
              heading="Install from git or npm"
              className="apps-add-form"
              footer={registry?.cloud
                ? 'Read from your Mac over the bridge; installing and removing sources happens on the Mac.'
                : registry?.sourcesUnavailable
                  ? "The installed-source list couldn't be read, so Update and Remove are unavailable here."
                  : 'Neither kind ever updates itself: you press Update.'}
            >
              <SettingsRow
                label="Git URL or npm package"
                htmlFor="plugin-source-url"
                help="A repo holds one plugin or one per folder; npm installs pin an exact version with scripts off."
                wide
                className="settings-row-stacked"
                control={
                  <span className="settings-addons-inline">
                    <input
                      id="plugin-source-url"
                      ref={urlInputRef}
                      type="text"
                      data-draft-key={urlDraft.key ?? undefined}
                      className="settings-input settings-input--long settings-input--mono"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd() } }}
                      placeholder="https://github.com/example/walnut-plugin"
                      spellCheck={false}
                    />
                    <SettingsButton
                      variant="primary"
                      disabled={!url.trim() || !trusted}
                      title={!url.trim() ? 'Paste a Git URL or an npm package first.' : !trusted ? 'Turn on the trust switch first.' : undefined}
                      busy={store.busy === 'add'}
                      busyLabel="Installing..."
                      onClick={() => void handleAdd()}
                    >
                      Add
                    </SettingsButton>
                  </span>
                }
              />
              <SettingsRow
                label={<span className="plugin-trust-label">I trust this source</span>}
                htmlFor="plugin-trust-confirm"
                help="Its code runs inside Walnut with full access to your tasks, notes, credentials and this computer."
                control={<ToggleSwitch id="plugin-trust-confirm" data-testid="plugin-trust-confirm" checked={trusted} onChange={setTrusted} />}
              />
            </SettingsGroup>
          )}

          {/* Phase two of an install from the form: the plugin that just arrived needs
              another one. These rows name every source it would add and ARE the consent. */}
          {store.pending && !store.pending.rowId && (
            <SettingsGroup heading="Dependencies">
              <PluginPendingDependencies
                plan={store.pending.plan}
                busy={store.busy === `pending:${store.pending.slug}`}
                nameFor={store.nameOf}
                onInstall={() => void store.installDependencies(store.pending!.slug, `pending:${store.pending!.slug}`)}
                onDismiss={() => store.setPending(null)}
              />
            </SettingsGroup>
          )}

          {/* A source is not a plugin: one repo can carry several, and it is the source that
              gets updated or removed, so it keeps its own group. */}
          <PluginSourcesGroup
            sources={store.sources}
            ownedSlugs={store.ownedSlugs}
            updates={store.updates}
            busy={store.busy}
            copiedKey={store.copiedKey}
            feedback={store.feedback}
            onCopy={store.copy}
            onUpdate={(slug, kind, feedbackId) => void store.handleUpdate(slug, kind, feedbackId)}
            onRemove={(slug) => void store.handleRemove(slug)}
            setRowFeedback={store.setRowFeedback}
          />
        </section>
      )}
    </div>
  )
}
