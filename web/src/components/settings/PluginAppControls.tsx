/**
 * The apps a plugin contributes, rendered INSIDE that plugin's row in the
 * Plugins section — because to the user an app IS the plugin, not a separate
 * thing to manage on another panel. Open it, choose whether its entry lives in
 * the Sidebar or here in Settings, or hide the entry (a hidden app keeps its
 * deep link; the plugin itself stays on).
 */
import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { effectiveAppPlacement, supportsPlacementOverride } from '@/apps/preferences'
import {
  getAppPreferences,
  subscribeAppPreferences,
  updateAppDisposition,
  updateAppPlacement,
} from '@/apps/store'

export function PluginAppControls({ pluginId }: { pluginId: string }) {
  const navigate = useNavigate()
  const apps = useAppCatalog()
  const preferences = useSyncExternalStore(
    subscribeAppPreferences,
    getAppPreferences,
    getAppPreferences,
  )
  // `pluginId` is set for both natives (registerPlugin) and webviews
  // (adaptWebviewApps), always from the manifest id the registry row carries.
  const mine = apps.all.filter((app) => app.kind !== 'core' && app.pluginId === pluginId)
  if (mine.length === 0) return null
  const hidden = new Set(preferences.hidden)

  return (
    <div className="plugin-app-controls">
      {mine.map((app) => {
        const placement = effectiveAppPlacement(app, preferences)
        const isHidden = hidden.has(app.key)
        return (
          <div key={app.key} className="plugin-app-controls-row" data-testid={`plugin-app-row-${app.key}`}>
            <span className="plugin-app-controls-label">
              App: <strong>{app.title}</strong>
              {isHidden && <span className="plugin-app-chip">Hidden</span>}
              {!isHidden && <span className="plugin-app-chip">{placement === 'settings' ? 'In Settings' : 'In Sidebar'}</span>}
            </span>
            <span className="plugin-app-controls-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid={`plugin-app-open-${app.key}`}
                onClick={() => navigate(app.path)}
              >
                Open
              </button>
              {/* Only a native plugin app can choose its surface; a legacy webview
                  has no settings placement (supportsPlacementOverride). Stays
                  available while hidden so the user picks where Show restores it. */}
              {supportsPlacementOverride(app) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-testid={`plugin-app-placement-${app.key}`}
                  onClick={() => updateAppPlacement(app.key, placement === 'settings' ? 'sidebar' : 'settings')}
                >
                  {placement === 'settings' ? 'Move to Sidebar' : 'Move to Settings'}
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid={`plugin-app-visibility-${app.key}`}
                onClick={() => updateAppDisposition(app.key, isHidden ? 'pinned' : 'hidden')}
              >
                {isHidden ? 'Show' : 'Hide'}
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}
