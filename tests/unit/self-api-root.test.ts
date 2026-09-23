/**
 * A server's own ops, and the local sessions it launches, talk to THAT server.
 *
 * Incident this pins (2026-09-23): a session launched by a `web --ephemeral`
 * server ran `walnut tools call task_create …` and the task landed on the
 * user's real Walnut (:3456). Every op client defaulted to :3456 and no server
 * told its sessions (or its own executor) where it actually listened.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { getSelfApiRoot, setSelfApiRoot, walnutApiEnvForSession } from '../../src/lib/self-api-root.js'
import { resolveApiBase } from '../../src/ops/executor.js'

const saved = process.env.OPEN_WALNUT_API_URL

afterEach(() => {
  setSelfApiRoot(null)
  if (saved === undefined) delete process.env.OPEN_WALNUT_API_URL
  else process.env.OPEN_WALNUT_API_URL = saved
})

describe('walnutApiEnvForSession', () => {
  it('is empty when no server listens in this process (CLI, MCP child, unit tests)', () => {
    expect(getSelfApiRoot()).toBeNull()
    expect(walnutApiEnvForSession(undefined)).toEqual({})
  })

  it('points a LOCAL session at the launching server', () => {
    setSelfApiRoot('http://127.0.0.1:45678')
    const expected = { OPEN_WALNUT_API_URL: 'http://127.0.0.1:45678' }
    expect(walnutApiEnvForSession(undefined)).toEqual(expected)
    expect(walnutApiEnvForSession(null)).toEqual(expected)
    expect(walnutApiEnvForSession('__local__')).toEqual(expected)
  })

  it('leaves remote sessions alone: 127.0.0.1 there is that host, not this server', () => {
    setSelfApiRoot('http://127.0.0.1:45678')
    expect(walnutApiEnvForSession('devbox')).toEqual({})
  })
})

describe('resolveApiBase precedence', () => {
  it('explicit override > this server > OPEN_WALNUT_API_URL > the :3456 default', () => {
    delete process.env.OPEN_WALNUT_API_URL
    expect(resolveApiBase()).toBe('http://127.0.0.1:3456/api/v1')

    process.env.OPEN_WALNUT_API_URL = 'http://127.0.0.1:3456'
    expect(resolveApiBase()).toBe('http://127.0.0.1:3456/api/v1')

    // Inside a test server whose env still names the real Walnut (inherited from
    // the agent session that launched it), the server's own ops stay home.
    setSelfApiRoot('http://127.0.0.1:45678')
    expect(resolveApiBase()).toBe('http://127.0.0.1:45678/api/v1')

    expect(resolveApiBase('http://127.0.0.1:9/')).toBe('http://127.0.0.1:9/api/v1')
  })
})
