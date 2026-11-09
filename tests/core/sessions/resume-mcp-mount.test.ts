/**
 * A session that started without the Walnut MCP tools gets them at a cold resume whose
 * cache expired (src/core/sessions/resume-mcp-mount.ts). 2026-11-09: the Walnut VP, spawned
 * before the mount existed, resumed for two weeks with no --mcp-config and `mcp_servers: []`.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-resume-mcp-mount'))
import { mountOnResume } from '../../../src/core/sessions/resume-mcp-mount.js'
import { hostWalnutMcpServer, type WalnutMcpMountInput } from '../../../src/core/sessions/walnut-mcp-mount.js'
import type { SessionProfile } from '../../../src/core/types.js'

const NOW = Date.parse('2026-11-09T12:00:00Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const expired = { tokens: 400_000, ttlMs: 3_600_000, requestAt: at(-2 * 3_600_000), expiresAt: at(-3_600_000) }
const warm = { tokens: 400_000, ttlMs: 3_600_000, requestAt: at(-60_000), expiresAt: at(3_540_000) }
const HUB: SessionProfile = { mcpServers: { walnut: { command: '/hub/walnut', args: ['mcp'] } } }
const input = (over: Partial<Omit<WalnutMcpMountInput, 'profile'>> = {}): Omit<WalnutMcpMountInput, 'profile'> => ({
  setting: undefined, hostServesMcp: true, local: true, hubMount: () => HUB, ...over,
})

describe('mountOnResume', () => {
  it('a session spawned with no profile gets the host mount once its cache expired', () => {
    const next = mountOnResume({ profile: undefined, promptCache: expired }, input(), NOW)
    expect(next?.mcpServers?.walnut).toEqual(hostWalnutMcpServer())
  })

  it('a warm cache replays the stored profile (the tool list is part of the cached prefix)', () => {
    expect(mountOnResume({ profile: undefined, promptCache: warm }, input(), NOW)).toBeNull()
    // No cache facts: nothing proves the replay is free, so it replays.
    expect(mountOnResume({ profile: undefined }, input(), NOW)).toBeNull()
  })

  it('a respawn someone asked for (Restart) takes the mount even on a warm cache', () => {
    const next = mountOnResume({ profile: undefined, promptCache: warm }, input(), NOW, { ignoreCache: true })
    expect(next?.mcpServers?.walnut).toBeTruthy()
    // Still never for a session that may not have it.
    expect(mountOnResume({ profile: { slim: true }, promptCache: warm }, input(), NOW, { ignoreCache: true })).toBeNull()
  })

  it('a session that already has the mount, or a lane, or an ACP engine, is left alone', () => {
    const own: SessionProfile = { mcpServers: { walnut: { command: 'x' } } }
    expect(mountOnResume({ profile: own, promptCache: expired }, input(), NOW)).toBeNull()
    expect(mountOnResume({ profile: undefined, lane: 'main', promptCache: expired }, input(), NOW)).toBeNull()
    expect(mountOnResume({ profile: undefined, engine: 'codex', promptCache: expired }, input(), NOW)).toBeNull()
  })

  it('follows the fresh-start decision: config off, the companion, a slim or caller profile, an old daemon', () => {
    expect(mountOnResume({ profile: undefined, promptCache: expired }, input({ setting: false }), NOW)).toBeNull()
    expect(mountOnResume({ profile: undefined, promptCache: expired }, input({ cloud: true }), NOW)).toBeNull()
    expect(mountOnResume({ profile: { slim: true }, promptCache: expired }, input(), NOW)).toBeNull()
    const lane: SessionProfile = { systemPrompt: 'p', mcpServers: { other: { command: 'o' } } }
    expect(mountOnResume({ profile: lane, promptCache: expired }, input(), NOW)).toBeNull()
    expect(mountOnResume({ profile: undefined, promptCache: expired }, input({ hostServesMcp: false }), NOW)).toBeNull()
  })

  it('keeps the rest of a stored profile when the old opt-in adds to it', () => {
    const stored: SessionProfile = { systemPrompt: 'p', allowedTools: ['Bash'] }
    const next = mountOnResume({ profile: stored, promptCache: expired }, input({ setting: true }), NOW)
    expect(next).toMatchObject({ systemPrompt: 'p', allowedTools: ['Bash'] })
    expect(next?.mcpServers?.walnut).toEqual(hostWalnutMcpServer())
  })

  it('WALNUT_MCP_ON_RESUME=0 turns it off', () => {
    process.env.WALNUT_MCP_ON_RESUME = '0'
    try {
      expect(mountOnResume({ profile: undefined, promptCache: expired }, input(), NOW)).toBeNull()
    } finally {
      delete process.env.WALNUT_MCP_ON_RESUME
    }
  })
})
