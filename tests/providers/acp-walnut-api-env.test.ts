/**
 * ACP sessions (codex, pi, goose, …) get the same "talk to the server that
 * launched you" env the native claude spawn gets (src/lib/self-api-root.ts):
 * on the adapter's env, which every shell the provider spawns inherits, and on
 * the walnut MCP mount, whose env the provider takes from the list it is given.
 */

import { describe, it, expect } from 'vitest'
import { buildAcpAdapterEnv, withWalnutApiEnv } from '../../src/providers/acp-session.js'
import type { AcpMcpServer } from '../../src/providers/acp-worker/protocol.js'

const API_ENV = { OPEN_WALNUT_API_URL: 'http://127.0.0.1:45678' }

describe('buildAcpAdapterEnv walnutApiEnv', () => {
  it('adds the launching server URL next to the managed session id', () => {
    expect(buildAcpAdapterEnv(undefined, { sessionId: 'rt-1', walnutApiEnv: API_ENV })).toEqual({
      WALNUT_SESSION_ID: 'rt-1',
      OPEN_WALNUT_API_URL: 'http://127.0.0.1:45678',
    })
  })

  it('is unchanged when there is nothing to add (no listening server)', () => {
    expect(buildAcpAdapterEnv(undefined, { sessionId: 'rt-1', walnutApiEnv: {} })).toEqual({ WALNUT_SESSION_ID: 'rt-1' })
    expect(buildAcpAdapterEnv(undefined, {})).toBeUndefined()
  })
})

describe('withWalnutApiEnv', () => {
  const walnut: AcpMcpServer = {
    name: 'walnut',
    command: '/usr/bin/node',
    args: ['cli.js', 'mcp'],
    env: [{ name: 'KEEP', value: '1' }, { name: 'OPEN_WALNUT_API_URL', value: 'http://127.0.0.1:3456' }],
  }
  const other: AcpMcpServer = { name: 'github', command: 'gh-mcp', args: [], env: [] }

  it('sets the URL on the walnut mount only, replacing a stale value', () => {
    const [w, o] = withWalnutApiEnv([walnut, other], API_ENV)
    expect(w.env).toEqual([
      { name: 'KEEP', value: '1' },
      { name: 'OPEN_WALNUT_API_URL', value: 'http://127.0.0.1:45678' },
    ])
    expect(o).toBe(other)
    // Input untouched: resolveMcpServers must not mutate cfg.walnutMcpServer.
    expect(walnut.env).toHaveLength(2)
    expect(walnut.env[1].value).toBe('http://127.0.0.1:3456')
  })

  it('returns the set as-is when there is nothing to add', () => {
    const servers = [walnut, other]
    expect(withWalnutApiEnv(servers, {})).toBe(servers)
  })
})
