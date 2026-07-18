import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'

interface SessionInternals {
  _transport: {
    writeRaw: (json: string) => Promise<boolean>
    setMode: (mode: string) => Promise<boolean>
  }
  _mode: 'bypass' | 'accept' | 'default' | 'plan'
  handleStreamLine: (line: string) => void
}

function makeSession() {
  const session = new ClaudeCodeSession('permission-mode-task', 'Test')
  const writes: string[] = []
  const daemonModes: string[] = []
  const internals = session as unknown as SessionInternals
  internals._mode = 'plan'
  internals._transport = {
    writeRaw: async (json: string) => {
      writes.push(json)
      return true
    },
    setMode: async (mode: string) => {
      daemonModes.push(mode)
      return true
    },
  }
  return { session, internals, writes, daemonModes }
}

function respond(internals: SessionInternals, response: Record<string, unknown>): void {
  internals.handleStreamLine(JSON.stringify({ type: 'control_response', response }))
}

describe('ClaudeCodeSession.applyPermissionMode', () => {
  it('propagates the CLI error and keeps the last confirmed mode', async () => {
    const { session, internals, writes, daemonModes } = makeSession()
    const changing = session.applyPermissionMode('bypass')
    const requestId = JSON.parse(writes[0]!).request_id as string

    respond(internals, {
      subtype: 'error',
      request_id: requestId,
      error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
    })

    await expect(changing).rejects.toThrow(
      'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
    )
    expect(session.mode).toBe('plan')
    expect(daemonModes).toEqual([])
  })

  it('updates local and daemon policy only after the CLI confirms the requested mode', async () => {
    const { session, internals, writes, daemonModes } = makeSession()
    const changing = session.applyPermissionMode('bypass')
    const requestId = JSON.parse(writes[0]!).request_id as string

    expect(session.mode).toBe('plan')
    respond(internals, {
      subtype: 'success',
      request_id: requestId,
      response: { mode: 'bypassPermissions' },
    })

    await expect(changing).resolves.toBe(true)
    expect(session.mode).toBe('bypass')
    expect(daemonModes).toEqual(['bypass'])
  })

  it('reinitializes an old live process when bypass capability was absent at startup', async () => {
    const runner = new SessionRunner()
    const live = {
      applyPermissionMode: vi.fn().mockRejectedValue(new Error(
        'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
      )),
    }
    vi.spyOn(runner, 'getOrAttachLiveSession').mockResolvedValue(live as unknown as ClaudeCodeSession)
    const reinitialize = vi.spyOn(runner, 'reinitialize').mockResolvedValue()

    await expect(runner.changePermissionMode('old-session', 'bypass')).resolves.toBe('reinitialized')
    expect(reinitialize).toHaveBeenCalledWith('old-session', 'bypass')
  })
})
