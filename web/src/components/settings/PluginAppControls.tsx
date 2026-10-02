/**
 * The apps a plugin contributes, rendered as indented rows under that plugin's
 * row in the Plugins section, because to the user an app IS the plugin, not a separate
 * thing to manage on another panel. Open it, choose whether its entry lives in
 * the Sidebar or here in Settings, or hide the entry (a hidden app keeps its
 * deep link; the plugin itself stays on).
 *
 * This row is the one place every plugin app can always be brought back from, so its tag
 * says where the entry really is and its buttons always include the way to show it. An app
 * unpinned from the Sidebar's menu is in neither surface: it reads "Not in sidebar" and
 * offers "Pin to sidebar" (it used to read "In sidebar" with nothing to press).
 */
import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppCatalog } from '@/apps/hooks'
import { useWebPluginRuntime } from '@/plugins/runtime-store'
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
  const runtime = useWebPluginRuntime()
  // `pluginId` is set for both natives (registerPlugin) and webviews
  // (adaptWebviewApps), always from the manifest id the registry row carries.
  const mine = apps.all.filter((app) => app.kind !== 'core' && app.pluginId === pluginId)
  if (mine.length === 0) {
    // A web build that failed in THIS window registered nothing, so there is no app row to
    // show it from: say so on the plugin, in the loader's own words. No retry button: the loader
    // already retried a passing failure, and a build that refused to start is skipped until a new
    // one arrives (an update or a reload of the plugin). A module that is running and simply ships
    // no App is not a failure, whatever its cleanup reported.
    const running = runtime.modules.some((module) => module.id === pluginId)
    const failure = running ? undefined : runtime.errors.find((entry) => entry.id === pluginId)
    if (!failure) return null
    // The cause leads and wraps: the loader's wording starts with a 64-character build hash,
    // which pushed the reason out of an ellipsized line.
    return (
      <div className="settings-addons-rows plugin-app-controls">
        <SettingsRow
          indent
          state="error"
          className="plugin-app-controls-row"
          data-testid={`plugin-app-failed-${pluginId}`}
          label="App didn't load"
          help={<span title={failure.error}>{failure.cause ?? failure.error}</span>}
        />
      </div>
    )
  }
  const hidden = new Set(preferences.hidden)
  const unpinned = new Set(preferences.unpinned)

  return (
    <div className="settings-addons-rows plugin-app-controls">
      {mine.map((app) => {
        const placement = effectiveAppPlacement(app, preferences)
        const isHidden = !app.lockVisibility && hidden.has(app.key)
        // Unpinning only takes a row out of the Sidebar; a Settings row ignores it.
        const isUnpinned = !isHidden && !app.lockVisibility && placement === 'sidebar' && unpinned.has(app.key)
        const where = isHidden ? 'Hidden' : placement === 'settings' ? 'In settings' : isUnpinned ? 'Not in sidebar' : 'In sidebar'
        const visibility = isHidden ? 'Show' : isUnpinned ? 'Pin to sidebar' : 'Hide'
        return (
          <SettingsRow
            key={app.key}
            indent
            className="plugin-app-controls-row"
            data-testid={`plugin-app-row-${app.key}`}
            label={
              <span className="settings-addons-inline plugin-app-controls-label">
                <span className="settings-addons-ellipsis" title={app.title}>{`App: ${app.title}`}</span>
                <SettingsTag>{where}</SettingsTag>
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
                  reserve={['Show', 'Hide', 'Pin to sidebar']}
                  onClick={() => updateAppDisposition(app.key, visibility === 'Hide' ? 'hidden' : 'pinned')}
                >
                  {visibility}
                </SettingsButton>
              </span>
            }
          />
        )
      })}
    </div>
  )
}
