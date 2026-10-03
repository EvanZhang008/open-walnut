/**
 * The words a plugin's MCP server row says in Settings (web/src/components/settings/plugin-mcp-model.ts).
 */
import { describe, expect, it } from 'vitest'
import { MCP_STATE_TAG, mcpServerHelp } from '../../web/src/components/settings/plugin-mcp-model'

const base = { name: 'docs', title: 'Docs', owner: 'docs-plugin', since: 0 }

describe('mcpServerHelp', () => {
  it('says what each state means and what sessions may call', () => {
    expect(mcpServerHelp({ ...base, state: 'idle', sessions: 'read-only' })).toBe('Starts when something uses it. Sessions can use its read-only tools.')
    expect(mcpServerHelp({ ...base, state: 'starting', sessions: 'all' })).toBe('Starting. Sessions on this Mac can use all its tools.')
    expect(mcpServerHelp({ ...base, state: 'ready', sessions: 'none', toolCount: 12 })).toBe('12 tools. Only its plugin uses it.')
    expect(mcpServerHelp({ ...base, state: 'ready', sessions: 'none' })).toBe('Ready. Only its plugin uses it.')
  })

  it('a failed server says why, in the server\'s own sentence', () => {
    const lastError = 'The MCP server "Docs" could not start: its command was not found (/opt/docs).'
    expect(mcpServerHelp({ ...base, state: 'failed', sessions: 'read-only', lastError })).toBe(lastError)
  })

  it('tags every state, and only a running one is green', () => {
    expect(Object.keys(MCP_STATE_TAG).sort()).toEqual(['failed', 'idle', 'ready', 'starting'])
    expect(MCP_STATE_TAG.ready.tone).toBe('success')
    expect(MCP_STATE_TAG.failed.tone).toBe('error')
  })
})
