/**
 * The Apps a group of plugins adds, as tiles above those plugins' rows. An App is
 * either on the Sidebar or only here, so each tile has the same one switch as a
 * built-in tile: on puts its row on the Sidebar, off leaves it on this page (and in
 * the Command Palette). Its route and links work either way.
 *
 * This is the one place a plugin App can always be brought back from, so an App taken
 * off the Sidebar by any path (this switch, the Sidebar's Unpin or Hide, a plugin that
 * declared no Sidebar row) shows here switched off. One left by the Sidebar's Hide also
 * reads off; switching it on and off again brings back its Command Palette entry, which
 * Hide alone takes away. Its badge shows here too, wherever its row is. A web build that failed to load
 * registered nothing, and its plugin row says so (PluginAppFailure).
 */
import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { PuzzleIcon } from '@/apps/icons'
import { appOnSidebar } from '@/apps/preferences'
import type { RegisteredApp } from '@/apps/registry'
import { getAppPreferences, subscribeAppPreferences, updateAppOnSidebar } from '@/apps/store'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { ToggleSwitch } from '@/components/settings/inputs/ToggleSwitch'

const APP_TINT = '#30B0C7'

/** The App's badge, drawn like the Sidebar's, so an App off the Sidebar still shows it here. */
function TileBadge({ app }: { app: RegisteredApp }) {
  const badge = app.badge
  if (badge === 'dot') return <span className="notification-badge-dot apps-tile-badge" data-testid={`apps-app-badge-${app.key}`} />
  if (typeof badge === 'number' && badge > 0) {
    return <span className="notification-badge-count apps-tile-badge" data-testid={`apps-app-badge-${app.key}`}>{badge > 99 ? '99+' : badge}</span>
  }
  if (badge && typeof badge === 'object') {
    return <span className="notification-badge-count notification-badge-muted apps-tile-badge" data-testid={`apps-app-badge-${app.key}`}>{badge.text}</span>
  }
  return null
}

function AppGlyph({ app }: { app: RegisteredApp }) {
  const Icon = app.icon
  if (Icon && app.kind === 'native' && app.pluginId) {
    return (
      <PluginBoundary pluginId={app.pluginId} pluginName={app.pluginName ?? app.title} resetKey={app.generation} compact fallback={<PuzzleIcon size={19} />}>
        <Icon size={19} />
      </PluginBoundary>
    )
  }
  if (Icon) return <Icon size={19} />
  if (app.iconUrl) return <img src={app.iconUrl} alt="" className="apps-tile-img" />
  return <PuzzleIcon size={19} />
}

export function PluginAppTiles({ pluginIds, tints, query }: {
  pluginIds: readonly string[]
  /** Plugin id → its tile tint, so an App reads in its plugin's colour. */
  tints?: ReadonlyMap<string, string>
  query?: string
}) {
  const navigate = useNavigate()
  const apps = useAppCatalog()
  const preferences = useSyncExternalStore(subscribeAppPreferences, getAppPreferences, getAppPreferences)
  const ids = new Set(pluginIds)
  const q = (query ?? '').trim().toLowerCase()
  const mine = apps.all.filter((app) => app.kind !== 'core' && app.pluginId && ids.has(app.pluginId)
    && (!q || app.title.toLowerCase().includes(q) || (app.pluginName ?? '').toLowerCase().includes(q)))
  if (mine.length === 0) return null
  return (
    <div className="apps-grid apps-grid-plugin-apps" data-testid="apps-plugin-app-tiles">
      {mine.map((app) => {
        const shown = appOnSidebar(app, preferences)
        return (
          <div key={app.key} className={`apps-tile${shown ? '' : ' apps-tile-off'}`} data-testid={`apps-app-${app.key}`} data-shown={shown}>
            <div className="apps-tile-top">
              <button
                type="button"
                className="apps-tile-icon"
                style={{ background: (app.pluginId && tints?.get(app.pluginId)) || APP_TINT }}
                aria-label={`Open ${app.title}`}
                title={`Open ${app.title}`}
                onClick={() => navigate(app.path)}
                data-testid={`apps-app-open-${app.key}`}
              >
                <AppGlyph app={app} />
              </button>
              <div className="apps-tile-text">
                <div className="apps-tile-name">{app.title}<TileBadge app={app} /></div>
                <div className="apps-tile-line">{app.pluginName ? `App from ${app.pluginName}` : 'Plugin App'}</div>
              </div>
            </div>
            <div className="apps-tile-foot">
              <span className="apps-tile-status">{shown ? 'On the sidebar' : 'Only in Apps'}</span>
              <ToggleSwitch
                checked={shown}
                onChange={(next) => updateAppOnSidebar(app, next)}
                aria-label={`Show ${app.title} on the sidebar`}
                data-testid={`apps-app-toggle-${app.key}`}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
