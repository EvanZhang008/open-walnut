/**
 * "Configure with AI" on a plugin's page: what the ask about one plugin carries. Pure, so the words
 * the agent gets are testable without a drawer.
 *
 * The agent configures through the same ops every chat has (`plugin_settings`, `plugin_settings_set`,
 * skill `walnut-configure-plugin`); this block only says WHICH plugin the person is looking at, so
 * "add an endpoint" needs no "of which plugin".
 */
import type { AskObjectQuote } from '@/components/chat/AskObjectDrawer'

export interface PluginAskTarget {
  id: string
  name: string
  description?: string
}

/** One remembered conversation per plugin: reopening the drawer continues it. */
export function pluginAskKey(pluginId: string): string {
  return `plugin-settings:${pluginId}`
}

export function pluginContextBlock(plugin: PluginAskTarget, origin: string): string {
  return [
    `I am on the page of the Walnut plugin "${plugin.name}" (id: ${plugin.id}) in Apps and want to configure it by talking with you.`,
    `Its page: ${origin}/apps?plugin=${encodeURIComponent(plugin.id)}`,
    `Read its settings with plugin_settings {"plugin":"${plugin.id}"} and change them with plugin_settings_set, as skill walnut-configure-plugin says:`,
    'say in one sentence what you will change before you change it, tell me each setting that changed after,',
    'and never type a secret (an API key, a token, a password) yourself: tell me which field on this page to fill in.',
    '',
    '',
  ].join('\n')
}

export function pluginAskQuote(plugin: PluginAskTarget): AskObjectQuote {
  return {
    who: plugin.name,
    when: '',
    where: 'Plugin settings',
    preview: plugin.description?.trim() || `Settings of ${plugin.name}`,
  }
}
