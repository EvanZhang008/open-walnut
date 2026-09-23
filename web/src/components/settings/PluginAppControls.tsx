/**
 * The apps a plugin contributes, rendered as indented rows under that plugin's
 * row in the Plugins section, because to the user an app IS the plugin, not a separate
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
import { SettingsRow, SettingsTag } from './SettingsSection'
import { SettingsButton } from './inputs/SettingsButton'
import '@/styles/settings-sections-addons.css'

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
    <div className="settings-addons-rows plugin-app-controls">
      {mine.map((app) => {
        const placement = effectiveAppPlacement(app, preferences)
        const isHidden = hidden.has(app.key)
        return (
          <SettingsRow
            key={app.key}
            indent
            className="plugin-app-controls-row"
            data-testid={`plugin-app-row-${app.key}`}
            label={
              <span className="settings-addons-inline plugin-app-controls-label">
                <span className="settings-addons-ellipsis" title={app.title}>{`App: ${app.title}`}</span>
                <SettingsTag>{isHidden ? 'Hidden' : placement === 'settings' ? 'In settings' : 'In sidebar'}</SettingsTag>
              </span>
            }
            control={
              <span className="settings-addons-inline plugin-app-controls-actions">
                <SettingsButton data-testid={`plugin-app-open-${app.key}`} onClick={() => navigate(app.path)}>
                  Open
                </SettingsButton>
                {/* Only a native plugin app can choose its surface; a legacy webview
                    has no settings placement (supportsPlacementOverride). Stays
                    available while hidden so the user picks where Show restores it. */}
                {supportsPlacementOverride(app) && (
                  <SettingsButton
                    data-testid={`plugin-app-placement-${app.key}`}
                    reserve={['Move to sidebar', 'Move to settings']}
                    onClick={() => updateAppPlacement(app.key, placement === 'settings' ? 'sidebar' : 'settings')}
                  >
                    {placement === 'settings' ? 'Move to sidebar' : 'Move to settings'}
                  </SettingsButton>
                )}
                <SettingsButton
                  data-testid={`plugin-app-visibility-${app.key}`}
                  reserve={['Show', 'Hide']}
                  onClick={() => updateAppDisposition(app.key, isHidden ? 'pinned' : 'hidden')}
                >
                  {isHidden ? 'Show' : 'Hide'}
                </SettingsButton>
              </span>
            }
          />
        )
      })}
    </div>
  )
}
