/**
 * Which Walnut MCP mount a new Claude Code session gets (src/core/sessions/walnut-mcp-mount.ts).
 */
import { describe, it, expect } from 'vitest'
import { withWalnutMcpMount, liveWalnutMcpServers, hostWalnutMcpServer, WALNUT_MCP_DEFAULT, type WalnutMcpMountInput } from '../../../src/core/sessions/walnut-mcp-mount.js'
import type { SessionProfile } from '../../../src/core/types.js'

const HUB: SessionProfile = { mcpServers: { walnut: { command: '/hub/walnut', args: ['mcp'] } } }
const base = (over: Partial<WalnutMcpMountInput>): WalnutMcpMountInput => ({
  setting: undefined, profile: undefined, hostServesMcp: true, local: false, hubMount: () => HUB, ...over,
})

describe('walnut MCP mount', () => {
  it('is on by default and mounts the host daemon\'s own server, found from the session socket', () => {
    expect(WALNUT_MCP_DEFAULT).toBe(true)
    const p = withWalnutMcpMount(base({}))
    expect(p?.mcpServers?.walnut).toEqual(hostWalnutMcpServer())
    const cmd = hostWalnutMcpServer().args?.join(' ') ?? ''
    expect(cmd).toContain('$(dirname "$WALNUT_AGENT_SOCKET")/bin/walnut')
    expect(cmd).toContain('mcp-server')
    // Claude Code expands `${VAR}` in --mcp-config before the shell sees it.
    expect(cmd).not.toContain('${')
  })

  it('the same on this Mac and on a remote host (the gateway answers on both)', () => {
    expect(withWalnutMcpMount(base({ local: true }))?.mcpServers?.walnut).toEqual(hostWalnutMcpServer())
    expect(withWalnutMcpMount(base({ local: false }))?.mcpServers?.walnut).toEqual(hostWalnutMcpServer())
  })

  it('config false turns it off', () => {
    expect(withWalnutMcpMount(base({ setting: false }))).toBeUndefined()
  })

  it('never mounts twice: a caller\'s own walnut mount is kept as it is', () => {
    const own: SessionProfile = { systemPrompt: 'p', mcpServers: { walnut: { command: 'x' } } }
    expect(withWalnutMcpMount(base({ profile: own }))).toBe(own)
  })

  it('a caller\'s own profile is its choice of tools (the companion chat lane drops walnut on purpose)', () => {
    const own: SessionProfile = { systemPrompt: 'p', mcpServers: { other: { command: 'o' } } }
    expect(withWalnutMcpMount(base({ profile: own }))).toBe(own)
  })

  it('the explicit opt-in adds to a caller\'s profile and keeps its other mounts and fields', () => {
    const p = withWalnutMcpMount(base({ setting: true, profile: { systemPrompt: 'p', mcpServers: { other: { command: 'o' } } } }))
    expect(p?.systemPrompt).toBe('p')
    expect(Object.keys(p?.mcpServers ?? {}).sort()).toEqual(['other', 'walnut'])
  })

  it('never on a cloud replica, whose gateway runs no op', () => {
    expect(withWalnutMcpMount(base({ cloud: true }))).toBeUndefined()
    expect(withWalnutMcpMount(base({ cloud: true, setting: true }))).toBeUndefined()
  })

  it('a slim profile grants only what it lists', () => {
    const slim: SessionProfile = { slim: true }
    expect(withWalnutMcpMount(base({ profile: slim }))).toBe(slim)
  })

  it('a daemon without the server: nothing by default; the old explicit opt-in still mounts the hub server locally', () => {
    expect(withWalnutMcpMount(base({ hostServesMcp: false, local: true }))).toBeUndefined()
    expect(withWalnutMcpMount(base({ hostServesMcp: false, local: false, setting: true }))).toBeUndefined()
    expect(withWalnutMcpMount(base({ hostServesMcp: false, local: true, setting: true }))?.mcpServers?.walnut)
      .toEqual(HUB.mcpServers!.walnut)
  })

  it('does not mutate the caller\'s profile', () => {
    const profile: SessionProfile = { mcpServers: { other: { command: 'o' } } }
    withWalnutMcpMount(base({ profile, setting: true }))
    expect(Object.keys(profile.mcpServers!)).toEqual(['other'])
  })

  it('a running process that has none gets the same mount live, as a stdio server; never one with its own servers', () => {
    expect(liveWalnutMcpServers(base({}))).toEqual({ walnut: { type: 'stdio', ...hostWalnutMcpServer() } })
    expect(liveWalnutMcpServers(base({ profile: { mcpServers: { other: { command: 'o' } } } }))).toBeNull()
    expect(liveWalnutMcpServers(base({ setting: false }))).toBeNull()
    expect(liveWalnutMcpServers(base({ cloud: true }))).toBeNull()
    expect(liveWalnutMcpServers(base({ hostServesMcp: false }))).toBeNull()
    expect(liveWalnutMcpServers(base({ profile: { slim: true } }))).toBeNull()
  })
})
