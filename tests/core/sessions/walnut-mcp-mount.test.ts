/**
 * Which Walnut MCP mount a new Claude Code session gets (src/core/sessions/walnut-mcp-mount.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { currentHubMounts, isHubMount, withWalnutMcpMount, liveWalnutMcpServers, hostWalnutMcpServer, WALNUT_MCP_DEFAULT, type WalnutMcpMountInput } from '../../../src/core/sessions/walnut-mcp-mount.js'
import type { SessionMcpServer, SessionProfile } from '../../../src/core/types.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')

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

  it('a process whose profile names walnut but has none gets that profile\'s own set', () => {
    const host = hostWalnutMcpServer()
    expect(liveWalnutMcpServers(base({ profile: { mcpServers: { walnut: host } } }))).toEqual({ walnut: { type: 'stdio', ...host } })
    expect(liveWalnutMcpServers(base({ profile: { mcpServers: { walnut: { command: 'hub' }, other: { command: 'o' } } } })))
      .toEqual({ walnut: { type: 'stdio', command: 'hub' }, other: { type: 'stdio', command: 'o' } })
    // The host mount from a daemon that no longer serves it: nothing to start.
    expect(liveWalnutMcpServers(base({ hostServesMcp: false, profile: { mcpServers: { walnut: host } } }))).toBeNull()
    expect(liveWalnutMcpServers(base({ cloud: true, profile: { mcpServers: { walnut: host } } }))).toBeNull()
  })
})

// 2026-11-24 and 25: Main's record named the hub mount of a deploy's stage the next deploy removed, and a
// Main AI chat's named one from about 2026-10-11. Each resume replayed it, it did not start, and the
// session ran with none of its Walnut tools. The real records' shapes, as the Mac had them.
describe('a hub mount a record kept names this install at every spawn', () => {
  const STAGE_BIN: SessionMcpServer = {
    command: '/private/var/folders/ab/c1/T/open-walnut-stage.1795620328.48485/dist-bin/walnut-darwin-arm64',
    args: ['/$bunfs/root/walnut', 'mcp'], env: { WALNUT_MCP_ROLE: 'org' },
  }
  const STAGE_NODE: SessionMcpServer = { command: '/opt/homebrew/bin/node', args: ['/var/folders/ab/c1/T/open-walnut-stage.1791772035.37280/dist/cli.js', 'mcp'] }
  const NOW: SessionMcpServer = { command: '/private/var/folders/ab/c1/T/open-walnut-stage.1795627029.46744/dist-bin/walnut-darwin-arm64', args: ['/$bunfs/root/walnut', 'mcp'] }
  const now = (server: SessionMcpServer | null = NOW) => ({ local: true, hubMount: () => (server ? { mcpServers: { walnut: server } } : {}) })

  it('tells the hub\'s mount, as any install built it, from every other', () => {
    for (const hub of [STAGE_BIN, STAGE_NODE, NOW, { command: 'open-walnut', args: ['mcp'] }, { command: 'bun', args: ['/repo/src/cli.ts', 'mcp'] }]) expect(isHubMount(hub), hub.command).toBe(true)
    for (const other of [hostWalnutMcpServer(), { command: 'hub', args: ['mcp'] }, { command: 'o' }, { command: 'node', args: ['/repo/scripts/x.mjs', 'mcp'] }, { command: 'walnut', args: ['mcp-server'] }]) expect(isHubMount(other), other.command).toBe(false)
  })

  it('a stage the record named becomes this install\'s entry, its role and the other servers kept', () => {
    const servers = { walnut: STAGE_BIN, other: { command: 'o' } }
    expect(currentHubMounts(servers, now())).toEqual({ walnut: { ...NOW, env: { WALNUT_MCP_ROLE: 'org' } }, other: { command: 'o' } })
    expect(currentHubMounts({ walnut: STAGE_NODE }, now())).toEqual({ walnut: NOW })
    // Never the record's own object.
    expect(servers.walnut.command).toBe(STAGE_BIN.command)
  })

  it('nothing to change: already this install, not the hub\'s mount, another host, or no entry of its own', () => {
    expect(currentHubMounts({ walnut: NOW }, now())).toBeNull()
    expect(currentHubMounts({ walnut: hostWalnutMcpServer() }, now())).toBeNull()
    expect(currentHubMounts({ other: { command: 'o' } }, now())).toBeNull()
    expect(currentHubMounts(undefined, now())).toBeNull()
    expect(currentHubMounts({ walnut: STAGE_BIN }, { ...now(), local: false })).toBeNull()
    expect(currentHubMounts({ walnut: STAGE_BIN }, now({ command: 'open-walnut', args: ['mcp'] }))).toBeNull()
    expect(currentHubMounts({ walnut: STAGE_BIN }, now(null))).toBeNull()
  })

  it('a running process given its profile\'s set live gets this install\'s too', () => {
    const live = liveWalnutMcpServers(base({ local: true, hubMount: now().hubMount, profile: { mcpServers: { walnut: STAGE_BIN } } }))
    expect(live).toEqual({ walnut: { type: 'stdio', ...NOW, env: { WALNUT_MCP_ROLE: 'org' } } })
  })

  // A new way to build a session's Walnut mount fails here until it is one of the two that hold across
  // deploys: the host daemon's (found from the session's socket at spawn), or the hub's (named again at
  // every spawn, above). Any other names a file that may be gone when the record is replayed.
  it('every Walnut mount the source builds is the host\'s or the hub\'s', () => {
    const walk = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith('.ts') ? [`${d}/${e.name}`] : [])
    const builders = walk('src').filter((f) => /mcpServers:\s*\{[^;]{0,80}?\bwalnut\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf-8').replace(/\/\/.*$/gm, '')))
    const KINDS: Record<string, string> = {
      'src/core/router/session-policy.ts': 'the host daemon\'s (hostWalnutMcpServer)',
      'src/core/sessions/profiles.ts': 'the hub\'s (walnutMcpProfile)',
      'src/core/sessions/walnut-mcp-mount.ts': 'adds one of the two to a profile',
    }
    expect(builders.filter((f) => !KINDS[f])).toEqual([])
    expect(builders.sort()).toEqual(Object.keys(KINDS).sort())
  })
})
