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
    // Messages already queued in the CLI are cancelled with the turn.
    expect(JSON.parse(transport.writeRaw.mock.calls[0][0]).request).toEqual({ subtype: 'interrupt', cancel_queued: true })
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

  it('an idle process is left alone', async () => {
    inner._processStatus = 'idle'
    await session.interrupt()
    expect(transport.writeRaw).not.toHaveBeenCalled()
    expect(transport.interrupt).not.toHaveBeenCalled()
  })

  it('a settled turn with work still running stops the process, since the interrupt cannot reach that work', async () => {
    inner._processStatus = 'running'
    inner._turnResultEmitted = true
    await session.interrupt()
    expect(transport.writeRaw).not.toHaveBeenCalled()
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
    expect(session.processStatus).toBe('stopped')
  })

  it('queued messages that survive the interrupt (a CLI without cancel_queued) stop the process', async () => {
    transport.writeRaw.mockImplementation(async (raw: string) => {
      const request = JSON.parse(raw)
      feed({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: ['queued-uuid'] } } })
      return true
    })
    const stopped = session.interrupt()
    abortResult()
    await stopped
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
  })

  it('stopProcess stops the process even when no turn is running', async () => {
    inner._processStatus = 'idle'
    await session.stopProcess()
    expect(transport.writeRaw).not.toHaveBeenCalled()
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
    expect(session.processStatus).toBe('stopped')
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

  it('background work torn down with the turn keeps the process and the interrupted outcome', async () => {
    feed({ type: 'system', subtype: 'task_started', session_id: 'interrupt-unit', task_id: 'background-unit', task_type: 'local_agent', description: 'Pending work' })
    const stopped = session.interrupt()
    abortResult()
    await vi.advanceTimersByTimeAsync(100)
    expect(inner._deferredOutcome).toMatchObject({ interrupted: true, isError: false })
    feed({ type: 'system', subtype: 'task_notification', session_id: 'interrupt-unit', task_id: 'background-unit', status: 'stopped' })
    feed({ type: 'system', subtype: 'session_state_changed', session_id: 'interrupt-unit', state: 'idle' })
    await vi.advanceTimersByTimeAsync(100)
    await stopped
    expect(transport.interrupt).not.toHaveBeenCalled()
    const result = events.find((e) => e.name === EventNames.SESSION_RESULT)
    expect(result?.data).toMatchObject({ interrupted: true, isError: false })
    expect(deriveSessionHookPoints({ name: EventNames.SESSION_RESULT, data: result!.data } as never, new Map(), vi.fn())).toEqual([])
  })

  it('background work that outlives the aborted turn stops the process', async () => {
    feed({ type: 'system', subtype: 'task_started', session_id: 'interrupt-unit', task_id: 'background-unit', task_type: 'local_agent', description: 'Pending work' })
    const stopped = session.interrupt()
    abortResult()
    await vi.advanceTimersByTimeAsync(2900)
    expect(transport.interrupt).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    await stopped
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
    expect(session.processStatus).toBe('stopped')
  })

  it('a detached command the aborted turn leaves running stops the process without the 3s wait', async () => {
    feed({ type: 'system', subtype: 'task_started', session_id: 'interrupt-unit', task_id: 'detached-unit', task_type: 'local_bash', description: 'Long build', is_backgrounded: true })
    const stopped = session.interrupt()
    abortResult()
    await vi.advanceTimersByTimeAsync(100)
    await stopped
    expect(transport.interrupt).toHaveBeenCalledTimes(1)
    expect(session.processStatus).toBe('stopped')
  })

  it('a stopped turn Walnut did not ask for (aborted terminal_reason) is not an error', async () => {
    feed({
      type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming',
      session_id: 'interrupt-unit', total_cost_usd: 0.001, errors: ['[ede_diagnostic] result_type=user'],
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(events.find((e) => e.name === EventNames.SESSION_RESULT)?.data).toMatchObject({ isError: false })
  })

  describe('lines queued behind the running turn', () => {
    let writes: Array<Record<string, unknown>>
    const queueLine = async (message: string, messageId: string, uuid?: string) => {
      expect(await session.writeMessage(message, {
        stopFence: null, markers: [{ message, messageId }], ...(uuid ? { uuid } : {}),
      })).toBe(true)
      return writes[writes.length - 1].uuid as string | undefined
    }
    // CLI 2.1.280 order on a Stop with cancel_queued (live probe 2026-09-25): the
    // dropped line's lifecycle frame, then the receipt that lists it.
    const ackWith = (cancelled: string[], lifecycle = true) => transport.writeRaw.mockImplementation(async (raw: string) => {
      const request = JSON.parse(raw)
      if (lifecycle) for (const uuid of cancelled) feed({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' })
      feed({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled } } })
      return true
    })
    const returned = () => events.filter((e) => e.name === EventNames.SESSION_QUEUED_CANCELLED).map((e) => e.data)

    beforeEach(() => {
      writes = []
      Object.assign(inner._transport as object, {
        writeMessage: vi.fn(async (_message: string, opts: Record<string, unknown>) => { writes.push(opts); return true }),
      })
    })

    it('a line the Stop cancels goes back to the composer, once', async () => {
      const uuid = await queueLine('use plan B', 'qm-1')
      // Walnut names the line itself: the CLI cancels uuid-less lines unlisted.
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
      ackWith([uuid!])
      const stopped = session.interrupt()
      abortResult()
      await stopped
      await vi.advanceTimersByTimeAsync(10)
      expect(returned()).toEqual([{ sessionId: 'interrupt-unit', messageIds: ['qm-1'], messages: ['use plan B'] }])
      expect(transport.interrupt).not.toHaveBeenCalled()
    })

    it('a receipt alone is enough, and the client uuid of a thread-anchored line is kept', async () => {
      const uuid = await queueLine('about that table', 'qm-2', 'a1b2c3d4-0000-4000-8000-000000000001')
      expect(uuid).toBe('a1b2c3d4-0000-4000-8000-000000000001')
      ackWith([uuid!], false)
      const stopped = session.interrupt()
      abortResult()
      await stopped
      await vi.advanceTimersByTimeAsync(10)
      expect(returned()).toEqual([{ sessionId: 'interrupt-unit', messageIds: ['qm-2'], messages: ['about that table'] }])
    })

    it('a line the model already took is not returned when its turn is stopped', async () => {
      const uuid = await queueLine('also check the logs', 'qm-3')
      // Folded into the running turn at a tool boundary (live probe: queued → started).
      feed({ type: 'command_lifecycle', command_uuid: uuid, state: 'started' })
      ackWith([])
      transport.writeRaw.mockImplementationOnce(async (raw: string) => {
        const request = JSON.parse(raw)
        feed({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: { still_queued: [], cancelled: [] } } })
        // The aborted turn's own commands end 'cancelled' too; that is not a drop.
        feed({ type: 'command_lifecycle', command_uuid: uuid, state: 'cancelled' })
        return true
      })
      const stopped = session.interrupt()
      abortResult()
      await stopped
      await vi.advanceTimersByTimeAsync(10)
      expect(returned()).toEqual([])
    })

    it('a Stop that falls back to the process stop returns every line still queued', async () => {
      feed({ type: 'command_lifecycle', command_uuid: 'running-prompt', state: 'started' })
      await queueLine('first follow-up', 'qm-4')
      await queueLine('second follow-up', 'qm-5')
      transport.writeRaw.mockResolvedValue(true) // no ACK: the process stop takes over
      const stopped = session.interrupt()
      await vi.advanceTimersByTimeAsync(5001)
      await stopped
      await vi.advanceTimersByTimeAsync(10)
      expect(transport.interrupt).toHaveBeenCalledTimes(1)
      expect(returned()).toEqual([{
        sessionId: 'interrupt-unit', messageIds: ['qm-4', 'qm-5'], messages: ['first follow-up', 'second follow-up'],
      }])
    })

    it('a receipt without still_queued (a CLI before interrupt_receipt_v1) stops the process', async () => {
      await queueLine('might run after the Stop', 'qm-8')
      transport.writeRaw.mockImplementation(async (raw: string) => {
        const request = JSON.parse(raw)
        feed({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {} } })
        return true
      })
      const stopped = session.interrupt()
      await stopped
      expect(transport.interrupt).toHaveBeenCalledTimes(1)
      expect(session.processStatus).toBe('stopped')
    })

    it('a CLI that never reports line fates gets nothing returned on a process stop', async () => {
      await queueLine('may already have run', 'qm-7')
      await session.stopProcess()
      await vi.advanceTimersByTimeAsync(10)
      expect(returned()).toEqual([])
    })

    it('a line written while idle starts a turn and is never tracked', async () => {
      inner._processStatus = 'idle'
      expect(await queueLine('new question', 'qm-6')).toBeUndefined()
      inner._processStatus = 'running'
      await session.stopProcess()
      await vi.advanceTimersByTimeAsync(10)
      expect(returned()).toEqual([])
    })
  })
})
