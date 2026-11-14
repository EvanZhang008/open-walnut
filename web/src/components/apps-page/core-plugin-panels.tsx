/**
 * Settings sections a built-in plugin's page shows that core code draws, the way the Mail App is
 * core code gated on the mail plugin (core-apps.tsx): Mail's routers need host components and the
 * Org page's router API, which a plugin bundle cannot reach. Kept apart from `walnut.ui.settings`,
 * whose entries belong to a plugin's web bundle and are swept with it; these never are.
 */
import type { ComponentType } from 'react'
import { MailRouterSettings } from '@/apps/mail/MailRouterSettings'
import { pluginPanelDomId } from './PluginSettingsPanels'

interface CorePanel { id: string; label: string; component: ComponentType }

const CORE_PLUGIN_PANELS: Readonly<Record<string, CorePanel>> = {
  mail: { id: 'routers', label: 'Routers', component: MailRouterSettings },
}

export const hasCorePluginPanel = (pluginId: string): boolean => pluginId in CORE_PLUGIN_PANELS

export function CorePluginPanel({ pluginId }: { pluginId: string }) {
  const panel = CORE_PLUGIN_PANELS[pluginId]
  if (!panel) return null
  const Panel = panel.component
  const key = `${pluginId}:${panel.id}`
  return (
    <div id={pluginPanelDomId(key)} className="plugin-settings-panel settings-plugin-body" data-testid={`plugin-panel-${key}`} data-plugin-id={pluginId}>
      <h3 className="plugin-settings-panel-title">{panel.label}</h3>
      <Panel />
    </div>
  )
}
