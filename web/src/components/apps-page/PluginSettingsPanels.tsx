/**
 * The settings panels a plugin draws itself (`walnut.ui.settings`), on that plugin's page in
 * Apps. A plugin's settings, its sign-in included, have one home, the same for every plugin:
 * here, never a row or a pane of Settings (2026-11-05, the user: "plugin shodl be all in
 * apps"). A plugin built for the old API keeps working unchanged: the same call, shown here.
 *
 * An old Settings link (`/settings#<plugin>:<panel>`) lands here with `?panel=<panel>`, and
 * that panel is scrolled into view and flashed once it registers.
 */
import { useEffect, useRef } from 'react'
import { PluginBoundary } from '@/components/common/PluginBoundary'
import { usePluginUi } from '@/plugins/hooks'
import type { PluginSettingsContribution, RegisteredUiContribution } from '@/plugins/types'

/** DOM id of one panel on its plugin's page. */
export function pluginPanelDomId(key: string): string {
  return `plugin-panel-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** The panels one plugin registered, in registration order. */
export function usePluginSettingsPanels(pluginId: string): RegisteredUiContribution<PluginSettingsContribution>[] {
  const pluginUi = usePluginUi()
  return pluginUi.settings.filter((entry) => entry.pluginId === pluginId)
}

/** A panel's own label is a sub-heading only when it says more than the plugin's name. */
export function panelHeading(label: string, pluginName: string): string | null {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const plain = words(label)
  const name = words(pluginName)
  // "Plugin Demo" under "Walnut Plugin Demo", or "Slack" under "Slack MCP server": the name already says it.
  if (!plain || plain === 'settings' || (name && (name.includes(plain) || plain.includes(name)))) return null
  return label
}

export function PluginSettingsPanels({ panels, pluginName, focusPanel }: {
  panels: RegisteredUiContribution<PluginSettingsContribution>[]
  pluginName: string
  /** The panel id an old Settings link named (`?panel=`): scrolled to and flashed once. */
  focusPanel?: string | null
}) {
  const focused = useRef<string | null>(null)
  const target = focusPanel ? panels.find((entry) => entry.value.id === focusPanel) : undefined
  // Keyed by the panel and its generation, not the entry object: the registry rebuilds every
  // entry whenever any plugin registers, which must not cut the flash short.
  const targetKey = target ? `${target.key}:${target.generation}` : null
  useEffect(() => {
    if (!target || focused.current === target.key) return
    const el = document.getElementById(pluginPanelDomId(target.key))
    if (!el) return
    focused.current = target.key
    el.scrollIntoView?.({ block: 'start' })
    el.classList.add('settings-anchor-flash-strong')
    let done = false
    const t = window.setTimeout(() => { done = true; el.classList.remove('settings-anchor-flash-strong') }, 3100)
    return () => {
      window.clearTimeout(t)
      el.classList.remove('settings-anchor-flash-strong')
      // A flash cut short (StrictMode's second run, a panel reloaded mid-flash) is shown again.
      if (!done) focused.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  return (
    <>
      {panels.map((entry) => {
        const Panel = entry.value.component
        const heading = panels.length > 1 ? entry.value.label : panelHeading(entry.value.label, pluginName)
        return (
          <div
            key={`${entry.key}:${entry.generation}`}
            id={pluginPanelDomId(entry.key)}
            className="plugin-settings-panel settings-plugin-body"
            data-testid={`plugin-panel-${entry.key}`}
            data-plugin-id={entry.pluginId}
          >
            {heading && <h3 className="plugin-settings-panel-title">{heading}</h3>}
            <PluginBoundary pluginId={entry.pluginId} pluginName={entry.pluginName} resetKey={entry.generation}>
              <Panel />
            </PluginBoundary>
          </div>
        )
      })}
    </>
  )
}
