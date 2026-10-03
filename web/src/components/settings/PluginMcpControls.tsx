/**
 * The MCP servers a plugin runs, as indented rows under that plugin's row in the Plugins section
 * (next to its App rows): what state the process is in, the reason when it failed, what sessions
 * may call, and a Start / Restart button. Live: the list follows `mcp:status-changed`.
 */
import { useState } from 'react'
import { noteMcpStatus, restartMcpServer, useMcpServers, type McpServerStatus } from '@/api/mcp'
import { MCP_STATE_TAG, mcpServerHelp } from './plugin-mcp-model'
import { SettingsRow, SettingsTag } from './SettingsSection'
import { SettingsButton } from './inputs/SettingsButton'
import '@/styles/settings-sections-addons.css'

function McpServerRow({ server }: { server: McpServerStatus }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tag = MCP_STATE_TAG[server.state]
  const restart = async () => {
    setBusy(true)
    setError(null)
    try {
      noteMcpStatus((await restartMcpServer(server.name)).server)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const verb = server.state === 'ready' ? 'Restart' : 'Start'
  return (
    <SettingsRow
      indent
      className="plugin-app-controls-row"
      state={server.state === 'failed' ? 'error' : undefined}
      data-testid={`plugin-mcp-row-${server.name}`}
      data-state={server.state}
      label={
        <span className="settings-addons-inline plugin-app-controls-label">
          <span className="settings-addons-ellipsis" title={server.name}>{`MCP server: ${server.title}`}</span>
          <SettingsTag tone={tag.tone}>{tag.label}</SettingsTag>
        </span>
      }
      help={<span data-testid={`plugin-mcp-help-${server.name}`}>{mcpServerHelp(server)}</span>}
      error={error ?? undefined}
      control={
        <SettingsButton
          data-testid={`plugin-mcp-restart-${server.name}`}
          reserve={['Restart', 'Start']}
          busy={busy || server.state === 'starting'}
          busyLabel="Starting..."
          disabled={busy || server.state === 'starting'}
          onClick={() => void restart()}
        >
          {verb}
        </SettingsButton>
      }
    />
  )
}

export function PluginMcpControls({ pluginId }: { pluginId: string }) {
  const servers = useMcpServers().filter((server) => server.owner === pluginId)
  if (servers.length === 0) return null
  return (
    <div className="settings-addons-rows plugin-app-controls" data-testid={`plugin-mcp-${pluginId}`}>
      {servers.map((server) => <McpServerRow key={server.name} server={server} />)}
    </div>
  )
}
