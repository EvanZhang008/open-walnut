import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('permission-response-recovery'))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { createSessionRecord, _resetSessionTrackerForTesting, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { closeDb } from '../../src/core/session-db.js'
import { WALNUT_HOME } from '../../src/constants.js'

const SID = '30000000-0000-4000-8000-0000000000b1'
const request = { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' } }
let session: ClaudeCodeSession
let finish: (value: boolean) => void
let fail: (error: Error) => void
let requests: unknown[]
let resolved: unknown[]
let notices: unknown[]
let result: Promise<boolean>
let writeRaw: ReturnType<typeof vi.fn>

type Internals = {
  _resolvedPermissionRequestIds: Set<string>
  _awaitUserDecision(id: string, input: typeof request): void
  _clearAllPermissionReEmitTimers(): void
  handleStreamLine(line: string): void
}
const state = () => session as unknown as Internals

beforeEach(async () => {
  closeDb()
  _resetSessionTrackerForTesting()
  await createSessionRecord(SID, 'permission-task', 'test', WALNUT_HOME, { initialProcessStatus: 'running' })
  session = new ClaudeCodeSession('permission-task', 'test', '/bin/true')
  const gate = new Promise<boolean>((resolve, reject) => { finish = resolve; fail = reject })
  // No process, signals or sockets: the only transport operation is this promise.
  writeRaw = vi.fn(() => gate)
  const transport = { writeRaw, detach: vi.fn(), stopTail: vi.fn() }
  Object.assign(session, { claudeSessionId: SID, _active: true, _transport: transport })
  requests = []
  resolved = []
  notices = []
  bus.subscribe('permission-recovery-test', (event) => {
    if (event.name === EventNames.SESSION_PERMISSION_REQUEST) requests.push(event.data)
    if (event.name === EventNames.SESSION_PERMISSION_RESOLVED) resolved.push(event.data)
    if (event.name === EventNames.SESSION_SYSTEM_EVENT) notices.push(event.data)
  }, { global: true })
  state()._awaitUserDecision('req-1', request)
  await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.pendingPermission?.requestId).toBe('req-1'))
  requests = []
})
afterEach(() => {
  state()._clearAllPermissionReEmitTimers()
  bus.clear()
  closeDb()
  _resetSessionTrackerForTesting()
  vi.restoreAllMocks()
})

async function dispatched() {
  result = session.resolvePermissionRequest('req-1', true)
  expect(session.hasPendingPermission).toBe(true)
  expect(state()._resolvedPermissionRequestIds.has('req-1')).toBe(false)
  expect(resolved).toEqual([])
  expect(notices).toEqual([])
  await Promise.resolve()
}

describe('async permission responses settle only after confirmed delivery', () => {
  it.each(['false', 'throw'])('keeps the original prompt pending without a fake resolution after a delayed %s', async (outcome) => {
    await dispatched()
    if (outcome === 'throw') fail(new Error('connection lost'))
    else finish(false)
    await expect(result).resolves.toBe(false)
    expect(session.hasPendingPermission).toBe(true)
    expect(requests).toEqual([])
    expect(resolved).toEqual([])
    expect(notices).toEqual([])
    expect(session.getPendingPermissionRequests()).toEqual([{ requestId: 'req-1', toolName: 'Bash', input: { command: 'pwd' }, reason: undefined }])
    expect(state()._resolvedPermissionRequestIds.has('req-1')).toBe(false)
    expect((await getSessionByClaudeId(SID))?.pendingPermission?.requestId).toBe('req-1')
  })

  it.each(['stop', 'detach', 'turn', 'transport', 'cancel'])('a delayed failure after %s never revives the old prompt', async (change) => {
    await dispatched()
    if (change === 'stop') Object.assign(session, { _stopEpoch: session.stopEpoch + 1 })
    if (change === 'detach') session.detach()
    if (change === 'turn') Object.assign(session, { _turnGen: session.turnGen + 1 })
    if (change === 'transport') Object.assign(session, { _transport: { writeRaw: vi.fn() } })
    if (change === 'cancel') state().handleStreamLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'req-1' }))
    else (session as unknown as { _pendingPermissionRequests: Map<string, unknown> })._pendingPermissionRequests.clear()
    finish(false)
    await expect(result).resolves.toBe(false)
    expect(session.hasPendingPermission).toBe(false)
    expect(requests).toEqual([])
  })

  it('a replayed request while its answer is in flight cannot replace the pending card or lose the acknowledgement', async () => {
    await dispatched()
    state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-1', request }))
    expect(requests).toEqual([])
    finish(true)
    await expect(result).resolves.toBe(true)
    expect(resolved).toHaveLength(1)
    expect(session.hasPendingPermission).toBe(false)
  })

  it('same-turn state-running between dispatch and acknowledgement does not discard the permission owner', async () => {
    await dispatched()
    const before = session.turnGen
    state().handleStreamLine(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'running', session_id: SID }))
    expect(session.turnGen).toBeGreaterThan(before)
    finish(true)
    await expect(result).resolves.toBe(true)
    expect(session.hasPendingPermission).toBe(false)
    expect(resolved).toHaveLength(1)
  })

  it('duplicate answers join the same delivery promise and produce one resolution', async () => {
    await dispatched()
    const duplicate = session.resolvePermissionRequest('req-1', false)
    expect(duplicate).toBe(result)
    expect(writeRaw).toHaveBeenCalledOnce()
    finish(true)
    await expect(duplicate).resolves.toBe(true)
    expect(resolved).toHaveLength(1)
  })

  it('an old permission acknowledgement cannot clear a newer pending prompt from the record', async () => {
    await dispatched()
    state()._awaitUserDecision('req-2', request)
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.pendingPermission?.requestId).toBe('req-2'))
    finish(true)
    await expect(result).resolves.toBe(true)
    expect(session.getPendingPermissionRequests().map((pending) => pending.requestId)).toEqual(['req-2'])
    expect((await getSessionByClaudeId(SID))?.pendingPermission?.requestId).toBe('req-2')
  })

  it('a replaced pending object invalidates only the old attempt and does not lock a later retry', async () => {
    await dispatched()
    const pending = (session as unknown as { _pendingPermissionRequests: Map<string, unknown> })._pendingPermissionRequests
    pending.set('req-1', { request_id: 'req-1', request: { ...request, input: { command: 'new request' } } })
    finish(true)
    await expect(result).resolves.toBe(false)
    writeRaw.mockResolvedValueOnce(true)
    await expect(session.resolvePermissionRequest('req-1', true)).resolves.toBe(true)
    expect(writeRaw).toHaveBeenCalledTimes(2)
  })

  it('a confirmed answer stays resolved and suppresses a replayed request', async () => {
    await dispatched()
    finish(true)
    await expect(result).resolves.toBe(true)
    state().handleStreamLine(JSON.stringify({ type: 'control_request', request_id: 'req-1', request }))
    expect(session.hasPendingPermission).toBe(false)
    expect(state()._resolvedPermissionRequestIds.has('req-1')).toBe(true)
    expect(requests).toEqual([])
    expect(resolved).toHaveLength(1)
    expect(notices).toHaveLength(1)
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.pendingPermission).toBeUndefined())
  })
})
