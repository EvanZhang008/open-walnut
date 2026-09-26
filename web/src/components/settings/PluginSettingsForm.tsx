/**
 * One plugin's generated Settings form, standing on its own: the same rows the Configure
 * card in Settings → Plugins draws, with their Save, for a plugin App that renders its
 * settings itself (`walnut.ui.views.PluginSettingsView`, manifest `settingsIn: 'app'`).
 *
 * It owns its config read and save (useSettingsConfig), because outside the Settings page
 * there is no pane context to borrow one from. Its rows are top-level here, not nested
 * under a plugin row, so they start at the row edge (settings-plugin-form.css).
 */
import type { Config } from '@open-walnut/core'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import { PluginConfigCards } from './sections/PluginConfigCards'
import { SettingsGroup, SettingsLoadingRow, SettingsNotice } from './SettingsSection'
import '@/styles/settings-plugin-form.css'

export function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const { config, loading, error, saveSection } = useSettingsConfig()
  if (!config) {
    return (
      <div className="plugin-settings-form" data-testid={`plugin-settings-form-${pluginId}`} data-state={loading ? 'loading' : 'error'}>
        <SettingsGroup>
          {loading ? <SettingsLoadingRow /> : <SettingsNotice kind="error">{error ?? 'Settings did not load.'}</SettingsNotice>}
        </SettingsGroup>
      </div>
    )
  }
  return (
    <div className="plugin-settings-form" data-testid={`plugin-settings-form-${pluginId}`} data-state="ready">
      <SettingsGroup>
        <PluginConfigCards
          config={config}
          onSave={(partial: Partial<Config>) => saveSection(partial)}
          onlyIds={[pluginId]}
          bare
          renderEmpty={(why) => why === 'loading'
            ? <SettingsLoadingRow />
            : why === 'failed'
              ? <SettingsNotice kind="error">The settings form did not load. Reload the page to try again.</SettingsNotice>
              : <SettingsNotice>This plugin has no settings to change right now. Check that it is on in Settings → Plugins.</SettingsNotice>}
        />
      </SettingsGroup>
    </div>
  )
}
