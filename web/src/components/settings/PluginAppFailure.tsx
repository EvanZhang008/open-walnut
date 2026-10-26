/**
 * The one App line under a plugin's row on the Apps page: "App didn't load", when the
 * plugin's web build failed in this window. The App tiles themselves (open, on the
 * Sidebar or only in Apps) are apps-page/PluginAppTiles; a build that failed registered
 * nothing, so no tile can say so.
 */
import { useAppCatalog } from '@/apps/hooks'
import { useWebPluginRuntime } from '@/plugins/runtime-store'
import { SettingsRow } from './SettingsSection'
import '@/styles/settings-sections-addons.css'

export function PluginAppFailure({ pluginId }: { pluginId: string }) {
  const apps = useAppCatalog()
  const runtime = useWebPluginRuntime()
  // `pluginId` is set for both natives (registerPlugin) and webviews
  // (adaptWebviewApps), always from the manifest id the registry row carries.
  if (apps.all.some((app) => app.kind !== 'core' && app.pluginId === pluginId)) return null
  // No retry button: the loader already retried a passing failure, and a build that refused
  // to start is skipped until a new one arrives (an update or a reload of the plugin). A
  // module that is running and simply ships no App is not a failure, whatever its cleanup
  // reported.
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
