/**
 * The words a plugin's MCP server row says (PluginMcpControls): the state tag and the one help
 * sentence. Pure, so the copy is pinned without rendering.
 */
import type { McpServerStatus } from '@/api/mcp'

export const MCP_STATE_TAG: Record<McpServerStatus['state'], { label: string; tone: 'neutral' | 'success' | 'error' }> = {
  idle: { label: 'Not running', tone: 'neutral' },
  starting: { label: 'Starting...', tone: 'neutral' },
  ready: { label: 'Running', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
}

const SESSIONS: Record<McpServerStatus['sessions'], string> = {
  'read-only': 'Sessions can use its read-only tools',
  all: 'Sessions on this Mac can use all its tools',
  none: 'Only its plugin uses it',
}

export function mcpServerHelp(server: McpServerStatus): string {
  if (server.state === 'failed' && server.lastError) return server.lastError
  const lead = server.state === 'idle'
    ? 'Starts when something uses it'
    : server.state === 'starting'
      ? 'Starting'
      : typeof server.toolCount === 'number' ? `${server.toolCount} tools` : 'Ready'
  return `${lead}. ${SESSIONS[server.sessions]}.`
}
