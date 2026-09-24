import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-turn-interrupt'))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { deriveSessionHookPoints } from '../../src/core/session-hooks/derive/session.js'

interface Internals {
  _transport: unknown
  _active: boolean
  _processStatus: string
  _turnResultEmitted: boolean
  claudeSessionId: string
  _deferredOutcome?: { isError: boolean; interrupted?: boolean }
  _clearAllPermissionReEmitTimers(): void
  _completeTurnOnIdle(): void
  handleStreamLine(line: string): void
  persistSessionRecord(): Promise<void>
  refreshAppliedSettings(): Promise<void>
}

describe('stream-json turn interruption', () => {
  let session: ClaudeCodeSession
  let inner: Internals
  let transport: { hasPipe: boolean; writeRaw: ReturnType<typeof vi.fn>; interrupt: ReturnType<typeof vi.fn> }
  let events: Array<{ name: string; data: Record<string, unknown> }>
  const feed = (event: unknown) => inner.handleStreamLine(JSON.stringify(event))
  const abortResult = () => feed({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    session_id: 'interrupt-unit', total_cost_usd: 0.001,
    errors: ['[ede_diagnostic] result_type=user'],
    usage: { input_tokens: 10, output_tokens: 0 },
  })

  beforeEach(() => {
    vi.useFakeTimers()
    bus.clear()
    session = new ClaudeCodeSession('interrupt-unit-task', 'test', 'unused-cli')
    inner = session as unknown as Internals
    inner.claudeSessionId = 'interrupt-unit'
    inner._active = true
    inner._processStatus = 'running'
    vi.spyOn(inner, 'persistSessionRecord').mockResolvedValue()
    vi.spyOn(inner, 'refreshAppliedSettings').mockResolvedValue()
    transport = {
      hasPipe: true,
      writeRaw: vi.fn(async (raw: string) => {
        const request = JSON.parse(raw)
        feed({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [] } } })
        return true
      }),
      interrupt: vi.fn(async () => { transport.hasPipe = false }),
    }
    inner._transport = { ...transport, isRemote: true, imageCache: new Map(), fileSize: 0, stopTail: vi.fn() }
    events = []
    bus.subscribe('interrupt-unit-observer', (event) => {
      events.push({ name: event.name, data: event.data as Record<string, unknown> })
    }, { global: true })
  })

  afterEach(() => {
    inner._clearAllPermissionReEmitTimers()
    bus.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('concurrent callers share one control request and wait for the result', async () => {
    const first = session.interrupt()
    expect(session.interrupt()).toBe(first)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.writeRaw).toHaveBeenCalledTimes(1)
    expect(transport.interrupt).not.toHaveBeenCalled()
    abortResult()
    await first
    await vi.advanceTimersByTimeAsync(100)
    expect(events.find((e) => e.name === EventNames.SESSION_RESULT)?.data).toMatchObject({ interrupted: true, isError: false })
    expect(session.processStatus).toBe('idle')
  })

  it('an acknowledged interrupt without a result gracefully stops the process', async () => {
    const stopped = session.interrupt()
    await vi.advanceTimersByTimeAsync(2999)
    expect(transport.interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await stopped
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
    expect(session.processStatus).toBe('stopped')
  })

  it('a missing acknowledgement falls back without sending another interrupt', async () => {
    transport.writeRaw.mockResolvedValue(true)
    const stopped = session.interrupt()
    await vi.advanceTimersByTimeAsync(5001)
    await stopped
    expect(transport.writeRaw).toHaveBeenCalledTimes(1)
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
  })

  it('a result received before a lost ACK preserves the process', async () => {
    transport.writeRaw.mockResolvedValue(true)
    const stopped = session.interrupt()
    abortResult()
    await vi.advanceTimersByTimeAsync(5001)
    await stopped
    expect(transport.interrupt).not.toHaveBeenCalled()
  })

  it('an authoritative idle without a result settles the interrupt without killing the process', async () => {
    const stopped = session.interrupt()
    feed({ type: 'system', subtype: 'session_state_changed', session_id: 'interrupt-unit', state: 'idle' })
    await stopped
    await vi.advanceTimersByTimeAsync(100)
    expect(transport.interrupt).not.toHaveBeenCalled()
    expect(events.find((e) => e.name === EventNames.SESSION_RESULT)?.data.interrupted).toBe(true)
  })

  it('idle and completed background turns do not interrupt a healthy process', async () => {
    inner._processStatus = 'idle'
    await session.interrupt()
    inner._processStatus = 'running'
    inner._turnResultEmitted = true
    await session.interrupt()
    expect(transport.writeRaw).not.toHaveBeenCalled()
    expect(transport.interrupt).not.toHaveBeenCalled()
  })

  it('permission cancellation settles the card and prevents replay from reopening it', async () => {
    const permission = {
      type: 'control_request', request_id: 'permission-interrupt',
      request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan: 'Test plan' } },
    }
    feed(permission)
    expect(session.hasPendingPermission).toBe(true)
    const stopped = session.interrupt()
    abortResult()
    await stopped
    await vi.advanceTimersByTimeAsync(100)
    expect(session.hasPendingPermission).toBe(false)
    expect(events.find((e) => e.name === EventNames.SESSION_PERMISSION_RESOLVED)?.data).toMatchObject({ requestId: 'permission-interrupt', cancelled: true })
    feed(permission)
    expect(session.hasPendingPermission).toBe(false)
  })

  it('background draining retains the interrupted outcome and skips completion hooks', async () => {
    feed({ type: 'system', subtype: 'task_started', session_id: 'interrupt-unit', task_id: 'background-unit', task_type: 'local_agent', description: 'Pending work' })
    const stopped = session.interrupt()
    abortResult()
    await stopped
    expect(inner._deferredOutcome).toMatchObject({ interrupted: true, isError: false })
    feed({ type: 'system', subtype: 'task_notification', session_id: 'interrupt-unit', task_id: 'background-unit', status: 'completed' })
    feed({ type: 'system', subtype: 'session_state_changed', session_id: 'interrupt-unit', state: 'idle' })
    await vi.advanceTimersByTimeAsync(100)
    const result = events.find((e) => e.name === EventNames.SESSION_RESULT)
    expect(result?.data).toMatchObject({ interrupted: true, isError: false })
    expect(deriveSessionHookPoints({ name: EventNames.SESSION_RESULT, data: result!.data } as never, new Map(), vi.fn())).toEqual([])
  })
})
