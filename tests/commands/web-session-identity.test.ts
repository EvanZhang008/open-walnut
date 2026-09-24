/**
 * A server is never a session (src/commands/web.ts forgetInheritedSessionIdentity).
 *
 * A server started from inside a Walnut session inherits WALNUT_SESSION_ID, and
 * the op executor falls back to it for in-process calls that name no caller, so
 * an action-card click would have been filed beside the deployer's task (and
 * moved that task into a new folder). The web command drops the identity first.
 */
import { describe, it, expect } from 'vitest'
import { forgetInheritedSessionIdentity } from '../../src/commands/web.js'

describe('forgetInheritedSessionIdentity', () => {
  it('drops the session id and agent socket, and nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      WALNUT_SESSION_ID: '11111111-2222-3333-4444-555555555555',
      WALNUT_AGENT_SOCKET: '/tmp/x/agent-gateway.sock',
      OPEN_WALNUT_HOME: '/data/walnut',
      PATH: '/usr/bin',
    }
    forgetInheritedSessionIdentity(env)
    expect(env).toEqual({ OPEN_WALNUT_HOME: '/data/walnut', PATH: '/usr/bin' })
  })

  it('is a no-op on a clean environment', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    forgetInheritedSessionIdentity(env)
    expect(env).toEqual({ PATH: '/usr/bin' })
  })
})
