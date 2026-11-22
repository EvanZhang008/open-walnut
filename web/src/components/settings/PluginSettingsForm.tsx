/**
 * One plugin's generated Settings form, standing on its own: the same rows its page in
 * Apps draws under Settings, with their Save, for a plugin App that renders its
 * settings itself (`walnut.ui.views.PluginSettingsView`, manifest `settingsIn: 'app'`).
 *
 * It owns its config read and save (useSettingsConfig), because outside the Settings page
 * there is no pane context to borrow one from. Its rows are top-level here, not nested
 * under a plugin row, so they start at the row edge (settings-plugin-form.css).
 */
import type { Config } from '@open-walnut/core'
import { useSettingsConfig } from '@/hooks/useSettingsConfig'
import { PluginConfigCards } from './sections/PluginConfigCards'
import { SettingsGroup } from './SettingsSection'
import { EmptyState, LoadingState, UnavailableState } from '../common/EmptyState'
import '@/styles/settings-plugin-form.css'

export function PluginSettingsForm({ pluginId }: { pluginId: string }) {
  const { config, loading, error, saveSection } = useSettingsConfig()
  if (!config) {
    return (
      <div className="plugin-settings-form" data-testid={`plugin-settings-form-${pluginId}`} data-state={loading ? 'loading' : 'error'}>
        <SettingsGroup>
          {loading ? <LoadingState title="Loading settings…" /> : <UnavailableState title="Settings did not load" detail={error ?? undefined} />}
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
            ? <LoadingState title="Loading the settings form…" />
            : why === 'failed'
              ? <UnavailableState title="The settings form did not load" hint="Reload the page to try again." />
              : <EmptyState title="This plugin has no settings to change right now" hint="Check that it is on in Apps." />}
        />
      </SettingsGroup>
    </div>
  )
}
