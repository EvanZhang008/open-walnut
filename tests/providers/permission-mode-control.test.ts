import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import vm from 'node:vm'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { observedPermissionMode, shouldAutoRespond } from '../../src/providers/daemon-core.js'

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

  it('an init line from before a confirmed switch does not revert it; the next one that shows the new mode is read again', async () => {
    const { session, internals, writes } = makeSession()
    ;(internals as unknown as { _spawnedAtMs: number })._spawnedAtMs = Date.now()
    // An init names the session: the transport would rename its stream files.
    ;(internals._transport as unknown as { renameForSession: () => void }).renameForSession = () => {}
    const init = (permissionMode: string) => internals.handleStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-pm', permissionMode }))
    const changing = session.applyPermissionMode('default')
    respond(internals, { subtype: 'success', request_id: JSON.parse(writes[0]!).request_id, response: { mode: 'default' } })
    await expect(changing).resolves.toBe(true)
    // Written before the switch, read after it.
    init('plan')
    expect(session.mode).toBe('default')
    init('default')
    expect(session.mode).toBe('default')
    // Past the fence, the engine's init is ground truth again.
    init('plan')
    expect(session.mode).toBe('plan')
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

describe('daemon approval follows confirmed engine mode', () => {
  it('the plain source daemon reconstructs the same mode observer', () => {
    const source = getDaemonSource()
    const start = source.indexOf('var observedPermissionMode = (')
    const end = source.indexOf('function shouldAutoRespond', start)
    expect(start).toBeGreaterThan(0)
    const context = vm.createContext({ MODE_CLI: { default: 'default', auto: 'auto', bypass: 'bypassPermissions' } })
    vm.runInContext(source.slice(start, end), context)
    expect(vm.runInContext('observedPermissionMode({type:"system",subtype:"init",permissionMode:"default"})', context)).toBe('default')
  })
  it('replaces a stale bypass preview with the actual restrictive init before a request', () => {
    const mode = observedPermissionMode({ type: 'system', subtype: 'init', permissionMode: 'default' })
    expect(mode).toBe('default')
    expect(shouldAutoRespond(mode!, 'Bash')).toBe(false)
    expect(observedPermissionMode({ type: 'system', subtype: 'status', permissionMode: 'auto' })).toBe('auto')
    expect(observedPermissionMode({ type: 'assistant', permissionMode: 'bypassPermissions' })).toBeNull()
  })
})
