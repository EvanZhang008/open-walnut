/**
 * The Apps a group of plugins adds, as tiles above those plugins' rows. Each tile
 * says where its entry lives and moves it: Sidebar, Settings (the Settings nav's
 * Plugins group) or Hidden (no entry anywhere; the route and its links still work).
 *
 * This is the one place a plugin App can always be brought back from, so a Hidden
 * or unpinned App always shows here with the way back. A web build that failed to
 * load registered nothing, and its plugin row says so (PluginAppControls).
 */
import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { PuzzleIcon } from '@/apps/icons'
import { effectiveAppPlacement, supportsPlacementOverride } from '@/apps/preferences'
import type { RegisteredApp } from '@/apps/registry'
import { getAppPreferences, subscribeAppPreferences, updateAppDisposition, updateAppPlacement } from '@/apps/store'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { SegmentedControl } from '@/components/settings/inputs/SegmentedControl'

type Where = 'sidebar' | 'settings' | 'hidden'

const APP_TINT = '#30B0C7'

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
        const placement = effectiveAppPlacement(app, preferences)
        const hidden = !app.lockVisibility && (preferences.hidden.includes(app.key)
          || (placement === 'sidebar' && preferences.unpinned.includes(app.key)))
        const where: Where = hidden ? 'hidden' : placement
        const movable = supportsPlacementOverride(app)
        const options: { value: Where; label: string; testId: string }[] = [
          { value: 'sidebar', label: 'Sidebar', testId: `apps-app-where-sidebar-${app.key}` },
          ...(movable ? [{ value: 'settings' as const, label: 'Settings', testId: `apps-app-where-settings-${app.key}` }] : []),
          { value: 'hidden', label: 'Hidden', testId: `apps-app-where-hidden-${app.key}` },
        ]
        const choose = (next: Where) => {
          if (next === 'hidden') { updateAppDisposition(app.key, 'hidden'); return }
          updateAppDisposition(app.key, 'pinned')
          if (movable) updateAppPlacement(app.key, next)
        }
        return (
          <div key={app.key} className={`apps-tile${where === 'hidden' ? ' apps-tile-off' : ''}`} data-testid={`apps-app-${app.key}`} data-where={where}>
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
                <div className="apps-tile-name">{app.title}</div>
                <div className="apps-tile-line">{app.pluginName ? `App from ${app.pluginName}` : 'Plugin App'}</div>
              </div>
            </div>
            <div className="apps-tile-foot">
              <SegmentedControl<Where>
                value={where}
                options={options}
                onChange={choose}
                aria-label={`Where ${app.title} lives`}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
