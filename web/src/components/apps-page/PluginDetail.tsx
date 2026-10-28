/**
 * One plugin's page on the Apps page, the way a store shows one app: its name, what it
 * does and its switch on top, then the App it adds, its settings (always open here, never
 * expanded inside a list), the plugins that are its parts, where its code comes from
 * (kind, folder, remote, branch), whether it is current, and Remove.
 *
 * A plugin that is a part of another (`slack-mcp` of Slack) has a page too, reached from
 * its parent's Parts, and says whose part it is.
 */
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Config } from '@open-walnut/core'
import { useAppCatalog } from '@/apps/hooks'
import { appOnSidebar } from '@/apps/preferences'
import { getAppPreferences, subscribeAppPreferences, updateAppOnSidebar } from '@/apps/store'
import { SettingsGroup, SettingsLoadingRow, SettingsRow, SettingsTag } from '@/components/settings/SettingsSection'
import { SettingsButton } from '@/components/settings/inputs/SettingsButton'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'
import { InlineConfirmButton } from '@/components/settings/inputs/InlineConfirmButton'
import { couldntSave } from '@/components/settings/inputs/useOptimisticSetting'
import { PluginIcon, pluginTileTints } from '@/components/settings/PluginIcon'
import { PluginAppFailure } from '@/components/settings/PluginAppFailure'
import { PluginMcpControls } from '@/components/settings/PluginMcpControls'
import { PluginAiControls } from '@/components/settings/PluginAiControls'
import { PluginConnectionPanel, CONNECTION_BADGE } from '@/components/settings/PluginConnectionPanel'
import { PluginConfigCards } from '@/components/settings/sections/PluginConfigCards'
import { PluginAlsoNeeds, PluginCascadeConfirm, PluginDependencyNeeds, PluginPendingDependencies, dependencyBusyKey } from '@/components/settings/sections/PluginDependencyRows'
import { BUNDLED_AVAILABLE_TITLE } from '@/components/settings/sections/plugin-bundled-actions'
import { firstSentence, needsSetupHelp, rowTags } from '@/components/settings/sections/plugin-row-view'
import { RESTART_PENDING_STATE } from '@/components/settings/plugin-update-types'
import { plainText } from '@/components/settings/plugin-update-view'
import { AppBadge, AppGlyph } from './app-bits'
import { appsOfPlugin, StoreNotices } from './PluginStoreGrid'
import { PartsSection, SourceSection, VersionSection } from './plugin-detail-sections'
import { isRunning, originKind, partParents, type RegistryRow } from './plugin-store-model'
import type { PluginStore } from './usePluginStore'

export function PluginDetail({ store, pluginId, config, onSave, onBack, onOpen }: {
  store: PluginStore
  pluginId: string
  config: Config
  onSave: (partial: Partial<Config>) => Promise<void>
  onBack: () => void
  /** Opens another plugin's page (a part, or the parent of one). */
  onOpen: (pluginId: string) => void
}) {
  const row = store.rows.find((entry) => entry.id === pluginId)
  const back = (
    <button type="button" className="apps-back" onClick={onBack} data-testid="plugin-detail-back">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      Apps
    </button>
  )
  if (!store.registry) {
    return <div className="apps-detail" data-testid="plugin-detail">{back}<SettingsGroup><SettingsLoadingRow>Loading plugin...</SettingsLoadingRow></SettingsGroup></div>
  }
  if (!row) {
    return (
      <div className="apps-detail" data-testid="plugin-detail" data-plugin-id={pluginId}>
        {back}
        <SettingsGroup>
          <SettingsRow label="This plugin is not on this computer" help="It may have been removed. Everything you can add is under Get more." />
        </SettingsGroup>
      </div>
    )
  }
  // Keyed by plugin: moving to another plugin's page (a part, a dependency) must never carry
  // this one's trust switch or an armed Remove along with it.
  return <PluginDetailBody key={row.id} store={store} row={row} config={config} onSave={onSave} onBack={onBack} onOpen={onOpen} back={back} />
}

function PluginDetailBody({ store, row, config, onSave, onBack, onOpen, back }: {
  store: PluginStore
  row: RegistryRow
  config: Config
  onSave: (partial: Partial<Config>) => Promise<void>
  onBack: () => void
  onOpen: (pluginId: string) => void
  back: ReactNode
}) {
  const navigate = useNavigate()
  const catalog = useAppCatalog()
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  const [trusted, setTrusted] = useState(false)
  const tints = pluginTileTints(store.rows)
  const parentOf = partParents(store.installed)
  const parentId = parentOf.get(row.id)
  const parts = store.installed.filter((other) => parentOf.get(other.id) === row.id)
  const apps = row.installed ? appsOfPlugin(catalog.all, row.id) : []
  const restartPending = row.state === RESTART_PENDING_STATE
  const on = isRunning(row)
  const asking = store.cascadeAsk?.target.id === row.id
  const switchOn = asking ? true : (store.pendingToggle[row.id] ?? on)
  const failed = row.status === 'failed' || row.status === 'quarantined'
  const needsSetup = row.status === 'needs-config'
  const reason = row.error ?? row.reason
  // A plugin whose App draws its own settings keeps them there, so the form has one home.
  // Falls back to the form here when the App is not registered (its web entry failed).
  const settingsApp = row.settingsIn === 'app' ? apps[0] : undefined
  const connection = store.connections[row.id]
  const connectionBadge = connection && connection.state !== 'connected' ? CONNECTION_BADGE[connection.state] : null
  const warning = failed && reason ? firstSentence(reason)
    : needsSetup ? needsSetupHelp(row.missingConfig)
      : row.status !== 'active' && row.status !== 'needs-dependency' && reason ? firstSentence(reason) : ''

  const lead = firstSentence(row.description)
  const tagline = lead && plainText(row.description ?? '').trim().replace(/[.!?]$/, '') !== lead.replace(/[.!?]$/, '') ? lead : ''

  const settings = row.installed && (row.configurable || settingsApp) ? (
    <SettingsGroup heading="Settings" className="apps-detail-group" data-testid={`plugin-settings-${row.id}`}>
      {settingsApp ? (
        <SettingsRow
          label={`Its settings are in the ${settingsApp.title} App`}
          control={
            <SettingsButton variant={needsSetup ? 'primary' : 'default'} data-testid={`plugin-open-settings-${row.id}`} onClick={() => navigate(settingsApp.path)}>
              Open {settingsApp.title} settings
            </SettingsButton>
          }
        />
      ) : (
        <div className="settings-addons-rows plugin-store-config" data-testid={`plugin-config-${row.id}`}>
          <PluginConfigCards
            config={config}
            onSave={onSave}
            onlyIds={[row.id]}
            bare
            renderEmpty={(why) => (why === 'loading'
              ? <SettingsLoadingRow>Loading settings...</SettingsLoadingRow>
              : <SettingsRow label={why === 'failed' ? "Couldn't load its settings" : 'Nothing to set up'} help={why === 'failed' ? 'Reload the page to try again.' : undefined} />)}
          />
        </div>
      )}
    </SettingsGroup>
  ) : null

  const about = (
    <SettingsGroup heading="About" className="apps-detail-group" data-testid={`plugin-about-${row.id}`}>
      <div className="apps-about">
        <p>{plainText(row.description ?? '') || (row.builtin ? 'Ships with Walnut.' : 'This plugin has no description.')}</p>
        {(row.adds?.length || row.capabilities?.length) ? (
          <div className="apps-about-adds">
            {(row.adds?.length ? row.adds : row.capabilities ?? []).map((what) => <SettingsTag key={what} tone="neutral">{what}</SettingsTag>)}
          </div>
        ) : null}
        {row.homepage && (
          <div className="apps-about-links">
            {row.homepage && <a className="settings-addons-link" href={row.homepage} target="_blank" rel="noreferrer">Website</a>}
          </div>
        )}
      </div>
    </SettingsGroup>
  )

  const appsSection = apps.length > 0 ? (
    <SettingsGroup heading={apps.length === 1 ? 'App' : 'Apps'} className="apps-detail-group" data-testid={`plugin-apps-${row.id}`}>
      {apps.map((app) => {
        const shown = appOnSidebar(app, preferences)
        return (
          <SettingsRow
            key={app.key}
            data-testid={`apps-app-${app.key}`}
            data-shown={shown}
            className="apps-app-row"
            label={
              <span className="settings-addons-inline">
                <span className="apps-app-glyph" style={{ background: tints.get(row.id) ?? 'var(--fg-muted)' }}><AppGlyph app={app} size={16} /></span>
                <span>{app.title}</span>
                <AppBadge app={app} />
              </span>
            }
            help={shown ? 'On the sidebar' : 'Only in Apps and the Command Palette'}
            control={
              <>
                <span className="apps-app-switch-label">Show on the sidebar</span>
                <ToggleSwitch checked={shown} onChange={(next) => updateAppOnSidebar(app, next)} aria-label={`Show ${app.title} on the sidebar`} data-testid={`apps-app-toggle-${app.key}`} />
                <SettingsButton variant="primary" onClick={() => navigate(app.path)} data-testid={`apps-app-open-${app.key}`}>Open</SettingsButton>
              </>
            }
          />
        )
      })}
    </SettingsGroup>
  ) : null

  // What it runs and spends, and its account: only while it is on.
  const running = on && (
    <>
      <PluginMcpControls pluginId={row.id} />
      <PluginAiControls pluginId={row.id} />
      {connection && <PluginConnectionPanel pluginId={row.id} initial={connection} onReport={store.onConnectionReport} />}
    </>
  )

  const removable = row.installed && (row.sourceSlug || row.source.kind === 'bundled')
  const remove = removable ? (
    <SettingsGroup className="apps-detail-group" data-testid={`plugin-remove-group-${row.id}`}>
      <SettingsRow
        label={`Remove ${row.name}`}
        help={row.sourceSlug
          ? 'Deletes the files Walnut installed for it. Plugins from the same source go with it.'
          : 'Turns it off and forgets its settings. It stays under Get more.'}
        control={
          <InlineConfirmButton
            disabled={store.busy === (row.sourceSlug ?? row.id)}
            aria-label={`Remove ${row.name}`}
            data-testid={`plugin-remove-${row.id}`}
            onConfirm={async () => {
              if (row.sourceSlug) { if (await store.handleRemove(row.sourceSlug)) onBack() }
              else if (await store.handleBundled(row, 'remove')) onBack()
            }}
          />
        }
      />
    </SettingsGroup>
  ) : null

  const installAction = !row.installed ? (
    <>
      {row.source.kind === 'bundled' && (
        <SettingsButton variant="primary" data-testid={`plugin-install-${row.id}`} title={BUNDLED_AVAILABLE_TITLE} busy={store.busy === row.id} busyLabel="Installing..." onClick={() => void store.handleBundled(row, 'install')}>
          Install
        </SettingsButton>
      )}
      {row.source.kind === 'example' && row.source.path && (
        <SettingsButton variant="primary" onClick={() => store.copy(`walnut-plugin link ${row.source.path}`, `example:${row.id}`)} title={`walnut-plugin link ${row.source.path}`}>
          {store.copiedKey === `example:${row.id}` ? 'Copied' : 'Copy link command'}
        </SettingsButton>
      )}
      {(row.source.kind === 'git' || row.source.kind === 'npm') && (
        <>
          <label className="apps-trust">
            <ToggleSwitch id={`plugin-trust-${row.id}`} data-testid={`plugin-trust-${row.id}`} checked={trusted} onChange={setTrusted} />
            I trust this source
          </label>
          <SettingsButton
            variant="primary"
            data-testid={`plugin-install-${row.id}`}
            disabled={!trusted}
            title={!trusted ? 'Turn on the trust switch first: its code runs inside Walnut with full access to your tasks, notes, credentials and this computer.' : undefined}
            busy={store.busy === 'add'}
            busyLabel="Installing..."
            onClick={async () => {
              store.setBusy('add')
              store.setError(null)
              try {
                // Anything it needs is asked on this page, where the install was pressed.
                await store.installSource(row.source.kind === 'npm' ? { spec: row.source.spec ?? row.id } : { url: row.source.url ?? '' }, { rowId: row.id })
                setTrusted(false)
              } catch (err) {
                store.setError(err instanceof Error ? err.message : String(err))
              } finally {
                store.setBusy(null)
              }
            }}
          >
            Install
          </SettingsButton>
        </>
      )}
    </>
  ) : null

  return (
    <div className="apps-detail" data-testid="plugin-detail" data-plugin-id={row.id}>
      {back}
      <StoreNotices store={store} />
      <header className="apps-detail-head plugin-store-row" data-testid={`plugin-row-${row.id}`} data-plugin-status={row.status}>
        <PluginIcon name={row.name} iconUrl={row.iconUrl} tint={tints.get(row.id) ?? 'var(--fg-muted)'} size="xl" />
        <div className="apps-detail-title">
          {parentId && (
            <button type="button" className="apps-detail-parent" onClick={() => onOpen(parentId)} data-testid="plugin-detail-parent">
              Part of {store.nameOf(parentId)}
            </button>
          )}
          <h1>{row.name}</h1>
          {/* A tagline only when the description says more than its first sentence (About has it all). */}
          {tagline && <p className="apps-detail-line">{tagline}</p>}
          <div className="apps-detail-actions">
            {row.installed && (row.toggleable ? (
              <label className="apps-onoff">
                <span>{switchOn ? 'On' : 'Off'}</span>
                <ToggleSwitch
                  id={`plugin-toggle-${row.id}`}
                  checked={switchOn}
                  busy={asking || row.id in store.pendingToggle}
                  aria-label={`Turn ${row.name} ${switchOn ? 'off' : 'on'}`}
                  onChange={(next) => void store.handleToggle(row, next)}
                />
              </label>
            ) : null)}
            {apps[0] && <SettingsButton variant="primary" onClick={() => navigate(apps[0].path)} data-testid={`plugin-open-app-${row.id}`}>Open App</SettingsButton>}
            {failed && (
              <SettingsButton
                data-testid={`plugin-try-again-${row.id}`}
                busy={store.busy === row.id}
                busyLabel="Trying..."
                onClick={() => (row.status === 'quarantined' ? void store.handleClearQuarantine(row) : void store.handleToggle(row, true))}
              >
                Try again
              </SettingsButton>
            )}
            {installAction}
            {rowTags({ status: row.status, restartPending }).map((tag) => <SettingsTag key={tag.text} tone={tag.tone}>{tag.text}</SettingsTag>)}
            {connectionBadge && <span data-testid={`plugin-row-connection-${row.id}`}><SettingsTag tone={connectionBadge.tone}>{connectionBadge.label}</SettingsTag></span>}
            <SettingsTag tone="neutral">{originKind(row)}</SettingsTag>
            {row.version && <span className="settings-addons-muted plugin-store-version">v{row.version}</span>}
          </div>
          {warning && <p className="apps-detail-warning" title={failed && reason ? plainText(reason) : undefined}>{warning}</p>}
          {store.toggleError[row.id] && <p className="apps-detail-warning" role="alert">{couldntSave(store.toggleError[row.id])}</p>}
          {!row.installed && row.dependencyPlan?.length ? (
            <p className="apps-detail-line"><PluginAlsoNeeds rowId={row.id} plan={row.dependencyPlan} blockedBy={row.blockedBy} nameFor={store.nameOf} /></p>
          ) : null}
        </div>
      </header>

      {(asking && store.cascadeAsk) || row.status === 'needs-dependency' || store.pending?.rowId === row.id ? (
        <SettingsGroup className="apps-detail-group">
          {asking && store.cascadeAsk && (
            <PluginCascadeConfirm
              name={row.name}
              dependents={store.cascadeAsk.dependents.map(store.nameOf).sort((a, b) => a.localeCompare(b))}
              busy={store.busy === row.id}
              onConfirm={() => void store.handleToggle(row, false, { cascade: true })}
              onCancel={() => store.setCascadeAsk(null)}
            />
          )}
          {row.status === 'needs-dependency' && (
            <PluginDependencyNeeds
              rowId={row.id}
              missing={row.missingDependencies}
              plan={row.dependencyPlan}
              busyKey={store.busy}
              copiedKey={store.copiedKey}
              nameFor={store.nameOf}
              // "Install..." ASKS: it opens the consent rows for this source instead of cloning on one click.
              onInstall={(item) => {
                if (item.source?.kind === 'bundled') {
                  void store.handleBundled({ id: item.id, name: store.nameOf(item.id) }, 'install', dependencyBusyKey(row.id, item.id))
                } else if (row.sourceSlug) {
                  store.setError(null)
                  store.setNotice(null)
                  store.setPending({ slug: row.sourceSlug, plan: row.dependencyPlan ?? [], rowId: row.id })
                } else {
                  onOpen(item.id)
                }
              }}
              onTurnOn={(item) => void store.handleToggle({ id: item.id, name: store.nameOf(item.id) }, true, { busyKey: dependencyBusyKey(row.id, item.id) })}
              onCopy={store.copy}
            />
          )}
          {store.pending?.rowId === row.id && (
            <PluginPendingDependencies
              plan={store.pending.plan}
              busy={store.busy === `pending:${store.pending.slug}`}
              nameFor={store.nameOf}
              onInstall={() => void store.installDependencies(store.pending!.slug, `pending:${store.pending!.slug}`)}
              onDismiss={() => store.setPending(null)}
            />
          )}
        </SettingsGroup>
      ) : null}

      {/* Each holds a few rows or nothing at all; an empty box hides itself (apps-page.css). */}
      <div className="settings-group apps-detail-group apps-detail-box"><PluginAppFailure pluginId={row.id} /></div>
      {/* A plugin that cannot start until it is set up leads with what it needs. */}
      {needsSetup && settings}
      {about}
      {appsSection}
      {!needsSetup && settings}
      {running && <div className="settings-group apps-detail-group apps-detail-box" data-testid={`plugin-running-${row.id}`}>{running}</div>}
      <PartsSection store={store} row={row} parts={parts} tints={tints} onOpen={onOpen} />
      <SourceSection store={store} row={row} />
      {row.installed && <VersionSection store={store} row={row} />}
      {remove}
    </div>
  )
}
