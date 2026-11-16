/**
 * "Configure with AI" on a plugin's page: an Ask Walnut conversation about this one plugin, in the
 * same drawer a mail or a Slack message is asked about in (AskObjectDrawer). The general agent
 * answers, with the ops every chat has; the page's settings form shows what it changed at once
 * (PluginConfigCards rereads on `config:changed`).
 */
import { AskObjectDrawer } from '@/components/chat/AskObjectDrawer'
import { pluginAskKey, pluginAskQuote, pluginContextBlock, type PluginAskTarget } from './plugin-ask'

/** The console's own Walnut, the one the Ask Walnut slot talks to. */
export const PLUGIN_ASK_AGENT = 'general'

export function PluginAskDrawer({ plugin, onClose }: { plugin: PluginAskTarget; onClose: () => void }) {
  const objectKey = pluginAskKey(plugin.id)
  return (
    <AskObjectDrawer
      key={objectKey}
      objectKey={objectKey}
      title={`Configure ${plugin.name} with AI`}
      quote={pluginAskQuote(plugin)}
      agentId={PLUGIN_ASK_AGENT}
      // `window.location.origin`: the link back must be THIS console's, never a hard-coded host.
      contextBlock={pluginContextBlock(plugin, window.location.origin)}
      contextName="Plugin you are configuring"
      onClose={onClose}
      restoreFocusTo={`[data-testid="plugin-configure-ai-${plugin.id}"]`}
    />
  )
}
