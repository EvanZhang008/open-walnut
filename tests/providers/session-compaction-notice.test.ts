/**
 * The CLI's compaction lines, as they actually arrive, become ONE UI row.
 *
 * Reported 2026-09-18: five "Compacting context..." rows above one "Context
 * compacted 444K tokens". Those five were one compaction. Two independent causes,
 * both reproduced here with real line shapes taken from this machine's stream
 * files:
 *
 *   1. `{"type":"system","subtype":"status","status":"compacting"}` is a 30-SECOND
 *      TRANSPORT KEEP-ALIVE the CLI re-emits for the whole compaction
 *      (claude-code `services/compact/compact.ts` → `setInterval(… setSDKStatus
 *      ('compacting'), 30_000)`), and a real auto-compaction measurably runs
 *      147-539s.
 *   2. A daemon reattach replays the stream tail, and system lines have no dedup
 *      key of their own (only text/tool_use do), so every replayed line used to
 *      become another row.
 *
 * The boundary also has to be idempotent for a second reason: its handler fires a
 * `/context`-equivalent CLI query, which a replay would run again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/session-tracker.js')>(),
  updateSessionRecord: vi.fn(async () => {}),
}))
vi.mock('../../src/core/phase.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/phase.js')>(),
  applySessionPhase: vi.fn(async () => {}),
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { COMPACTED_MESSAGE, COMPACTING_MESSAGE } from '../../src/core/stream/compaction-notice.js'
import * as placeNotice from '../../src/core/sessions/place-notice.js'
import * as turnRecorder from '../../src/core/observability/recorder.js'
import * as sessionManager from '../../src/providers/session-manager.js'
import * as sessionTracker from '../../src/core/session-tracker.js'
import { setImmediate as nextImmediate } from 'node:timers/promises'

const transports: Array<{ writeRaw: ReturnType<typeof vi.fn> }> = []

const SID = 'sess-compaction'
const COMPACTION_ERROR = 'Error during compaction: API Error: 400 Input is too long.'
const COMMAND_UUID = '8b22aa8f-9389-415e-9f38-4f2996f4d009'
const MESSAGE_ID = '51a6ce02-8bfa-4a54-8a47-3565c254f639'

interface SessionInternals {
  claudeSessionId: string | null
  _transport: unknown
  _processStatus: string
  _interruptRequested: boolean
  _failedLocalCommandThisTurn: boolean
  _turnResultEmitted: boolean
  _consumedOffset: number
  persistSessionRecord(): Promise<void>
  emitStatusChanged(): void
  refreshAppliedSettings(): Promise<void>
  getContextUsage(): Promise<null>
  getModelCatalog(): Promise<null>
  seedCliContextWindow(): void
  startStallDiagTimer(): void
}

/** CLI 2.1.284: the stream message id is NOT the canonical local-command row uuid. */
function localCommandLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant', session_id: SID, uuid: COMMAND_UUID, parent_tool_use_id: null,
    message: {
      id: MESSAGE_ID, type: 'message', role: 'assistant', model: '<synthetic>',
      content: [{ type: 'text', text: COMPACTION_ERROR }],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
    local_command_outcome: { kind: 'failed' },
    local_command_run: { command: 'compact', args: '' },
    ...overrides,
  }
}

function commandResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'result', subtype: 'success', is_error: false, session_id: SID,
    result: '', num_turns: 0, duration_ms: 1500, duration_api_ms: 0, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...overrides,
  }
}

function runningSession(): ClaudeCodeSession {
  const session = new ClaudeCodeSession('task-command', 'proj', 'unused-cli')
  const inner = session as unknown as SessionInternals
  inner.claudeSessionId = SID
  inner._processStatus = 'running'
  const transport = {
    isRemote: true, hasPipe: true, imageCache: new Map(), fileSize: 0,
    writeRaw: vi.fn(() => { throw new Error('Unexpected CLI control query') }),
    processInbound: vi.fn((text: string) => text),
    writeMessage: vi.fn(async (_message: string, opts?: { onDispatch?: () => void }) => {
      opts?.onDispatch?.()
      return true
    }),
    renameForSession: vi.fn(), deletePipe: vi.fn(),
  }
  inner._transport = transport
  transports.push(transport)
  return session
}

function captureCommandEvents(): { notices: Record<string, unknown>[]; deltas: Record<string, unknown>[]; results: Record<string, unknown>[] } {
  const notices: Record<string, unknown>[] = []
  const deltas: Record<string, unknown>[] = []
  const results: Record<string, unknown>[] = []
  bus.subscribe('main-ai', (event) => {
    const data = event.data as Record<string, unknown>
    if (event.name === EventNames.SESSION_SYSTEM_EVENT) notices.push(data)
    if (event.name === EventNames.SESSION_TEXT_DELTA) deltas.push(data)
    if (event.name === EventNames.SESSION_RESULT) results.push(data)
  })
  return { notices, deltas, results }
}

function feed(session: ClaudeCodeSession, line: Record<string, unknown>): void {
  (session as unknown as { handleStreamLine(line: string): void })
    .handleStreamLine(JSON.stringify(line))
}

function init(session: ClaudeCodeSession): void {
  feed(session, {
    type: 'system', subtype: 'init', session_id: SID, cwd: '/tmp',
    model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default',
  })
}

/** Real shape from ~/.open-walnut/tmp/streams/*.jsonl. */
function compactingLine(uuid: string): Record<string, unknown> {
  return { type: 'system', subtype: 'status', status: 'compacting', session_id: SID, uuid }
}
function boundaryLine(uuid: string, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'system', subtype: 'compact_boundary', session_id: SID, uuid,
    compact_metadata: {
      trigger: 'auto', pre_tokens: 443847, post_tokens: 49108,
      cumulative_dropped_tokens: 17494300, duration_ms: 181769,
      ...extra,
    },
  }
}

interface Notice { variant: string; message: string; detail?: string; progress?: boolean }

function captureNotices(): Notice[] {
  const seen: Notice[] = []
  bus.subscribe('main-ai', (event) => {
    if (event.name !== EventNames.SESSION_SYSTEM_EVENT) return
    const p = event.data as Notice
    seen.push({ variant: p.variant, message: p.message, detail: p.detail, progress: p.progress })
  })
  return seen
}

beforeEach(async () => {
  vi.useFakeTimers()
  bus.clear()
  transports.length = 0
  vi.spyOn(placeNotice, 'notePlaceCompaction').mockResolvedValue()
  vi.spyOn(turnRecorder, 'recordTurn').mockImplementation(() => {})
  vi.spyOn(sessionTracker, 'updateSessionRecordConditionally').mockResolvedValue(null)
  vi.spyOn(sessionManager, 'createSessionManager').mockImplementation(() => { throw new Error('Unexpected session transport creation') })
  // No CLI control queries, transport startup, record writes, or real pid probes.
  const prototype = ClaudeCodeSession.prototype as unknown as SessionInternals
  vi.spyOn(prototype, 'persistSessionRecord').mockResolvedValue()
  vi.spyOn(prototype, 'emitStatusChanged').mockImplementation(() => {})
  vi.spyOn(prototype, 'refreshAppliedSettings').mockResolvedValue()
  vi.spyOn(prototype, 'getContextUsage').mockResolvedValue(null)
  vi.spyOn(prototype, 'getModelCatalog').mockResolvedValue(null)
  vi.spyOn(prototype, 'seedCliContextWindow').mockImplementation(() => {})
  vi.spyOn(prototype, 'startStallDiagTimer').mockImplementation(() => {})
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  try {
    await nextImmediate()
    await nextImmediate()
    expect(sessionManager.createSessionManager).not.toHaveBeenCalled()
    for (const transport of transports) expect(transport.writeRaw).not.toHaveBeenCalled()
  } finally {
    bus.clear()
    vi.clearAllTimers()
    vi.restoreAllMocks()
    vi.useRealTimers()
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
  }
})

describe('ClaudeCodeSession: failed local commands', () => {
  it('the real compact failure emits one canonical error row, never assistant text, and fails its raw-success result', () => {
    const session = runningSession()
    const { notices, deltas, results } = captureCommandEvents()
    const line = localCommandLine()
    feed(session, line)
    feed(session, line)
    feed(session, commandResult())
    // A reattach can replay the assistant line after its result too.
    feed(session, line)
    feed(session, commandResult())

    expect(notices).toEqual([{
      sessionId: SID, taskId: 'task-command', variant: 'error',
      message: COMPACTION_ERROR, progress: false, uuid: COMMAND_UUID,
    }])
    expect(COMMAND_UUID).not.toBe(MESSAGE_ID)
    expect(deltas).toEqual([])
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(true)
    expect(results[0].result).toBe(COMPACTION_ERROR)
    expect(session.processStatus).toBe('error')
    expect((session as unknown as SessionInternals)._failedLocalCommandThisTurn).toBe(false)
  })

  it('any failed native command uses its outcome rather than a command name or error phrase', () => {
    const session = runningSession()
    const { notices, results, deltas } = captureCommandEvents()
    feed(session, localCommandLine({ local_command_run: { command: 'inspect' },
      message: { id: MESSAGE_ID, role: 'assistant', content: [{ type: 'text', text: 'Workspace access denied.' }] } }))
    feed(session, commandResult())
    expect(results).toMatchObject([{ isError: true, result: 'Workspace access denied.' }])
    expect(notices).toMatchObject([{ variant: 'error', message: 'Workspace access denied.', uuid: COMMAND_UUID }])
    expect(notices[0].progress).toBeUndefined()
    expect(deltas).toEqual([])
    expect(session.processStatus).toBe('error')
  })

  it('a quiet process exit settles pending failure without claiming detached work continues', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    const inner = session as unknown as { handleQuietProcessExit(): void; reclaimUntakenLines(): void; _wakeupAt: number }
    vi.spyOn(inner, 'reclaimUntakenLines').mockImplementation(() => {})
    inner._wakeupAt = Date.now() + 60_000
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'detached', is_backgrounded: true, session_id: SID })
    feed(session, localCommandLine())
    inner.handleQuietProcessExit()
    expect(results).toMatchObject([{ isError: true, result: COMPACTION_ERROR }])
    expect(results[0].detachedBgActive).toBeUndefined()
    expect(results[0].wakeupPending).toBeUndefined()
    expect(session.processStatus).toBe('error')
    expect(session.processPid).toBeNull()
  })

  it('an expected quiet teardown cannot report the pending command failure again', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    const inner = session as unknown as { handleQuietProcessExit(): void; reclaimUntakenLines(): void; _expectedTeardown: boolean }
    vi.spyOn(inner, 'reclaimUntakenLines').mockImplementation(() => {})
    feed(session, localCommandLine())
    inner._expectedTeardown = true
    inner.handleQuietProcessExit()
    expect(results).toEqual([])
    expect(session.processStatus).toBe('stopped')
  })

  it('soft EDE cannot downgrade an explicit failed command', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    ;(session as unknown as { fullText: string }).fullText = 'Earlier response'
    feed(session, localCommandLine())
    feed(session, commandResult({ is_error: true, errors: ['[ede_diagnostic] local command result'] }))
    expect(results).toMatchObject([{ isError: true, result: COMPACTION_ERROR }])
    expect(session.processStatus).toBe('error')
  })

  it('a failed zero-cost command preserves a live transport after a billable turn', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, commandResult({ num_turns: 1, total_cost_usd: 1, usage: { input_tokens: 20, output_tokens: 5 } }))
    init(session)
    const transport = (session as unknown as { _transport: { deletePipe: ReturnType<typeof vi.fn> } })._transport
    feed(session, localCommandLine())
    feed(session, commandResult({ total_cost_usd: 1 }))
    expect(transport.deletePipe).not.toHaveBeenCalled()
    expect(results.map(row => row.isError)).toEqual([false, true])
  })

  it('a successful zero-turn command also preserves a live transport', () => {
    const session = runningSession()
    feed(session, commandResult({ num_turns: 1, total_cost_usd: 1, usage: { input_tokens: 20, output_tokens: 5 } }))
    init(session)
    const transport = (session as unknown as { _transport: { deletePipe: ReturnType<typeof vi.fn> } })._transport
    feed(session, localCommandLine({ local_command_outcome: { kind: 'completed' } }))
    feed(session, commandResult({ total_cost_usd: 1 }))
    expect(transport.deletePipe).not.toHaveBeenCalled()
  })

  it('an idle fallback retains a command failure when the result was lost', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, localCommandLine())
    ;(session as unknown as { _completeTurnOnIdle(): void })._completeTurnOnIdle()
    expect(results).toMatchObject([{ isError: true, result: COMPACTION_ERROR }])
    expect(session.processStatus).toBe('error')
  })

  it('an interrupted idle fallback settles normally after a command failure', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, localCommandLine())
    ;(session as unknown as SessionInternals)._interruptRequested = true
    ;(session as unknown as { _completeTurnOnIdle(): void })._completeTurnOnIdle()
    expect(results).toMatchObject([{ isError: false, interrupted: true }])
    expect(session.processStatus).toBe('idle')
  })

  it('a command failure overrides a withheld success before idle settles the turn', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    ;(session as unknown as { _deferredOutcome: unknown })._deferredOutcome = { isError: false, resultText: 'Earlier success', totalCost: 1 }
    feed(session, localCommandLine())
    ;(session as unknown as { _completeTurnOnIdle(): void })._completeTurnOnIdle()
    expect(results).toMatchObject([{ isError: true, result: COMPACTION_ERROR, totalCost: 1 }])
    expect(session.processStatus).toBe('error')
  })

  it('a missing command result settles when a level snapshot drains after idle', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'gating-task' }], session_id: SID })
    feed(session, localCommandLine())
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results).toHaveLength(0)
    feed(session, { type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: SID })
    expect(results).toMatchObject([{ isError: true, result: COMPACTION_ERROR }])
  })

  it('a detached notification leaves its settled user command failure visible', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'detached', is_backgrounded: true, session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'detached', status: 'completed', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: SID })
    feed(session, commandResult({ origin: { kind: 'task-notification' }, result: 'Background completed' }))
    expect(results).toMatchObject([{ isError: true }])
    expect(session.processStatus).toBe('error')
  })

  it('a notification init cannot emit a second successful result for a failed user turn', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'detached', is_backgrounded: true, session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'detached', status: 'completed', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: SID })
    init(session)
    feed(session, commandResult({ origin: { kind: 'task-notification' }, result: 'Background completed' }))
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(true)
    expect(session.processStatus).toBe('error')
  })

  it('a quiet exit after a settled detached failure retains error without another result', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    const inner = session as unknown as { handleQuietProcessExit(): void; reclaimUntakenLines(): void }
    vi.spyOn(inner, 'reclaimUntakenLines').mockImplementation(() => {})
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'detached', is_backgrounded: true, session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    expect(session.processStatus).toBe('running')
    inner.handleQuietProcessExit()
    expect(results).toHaveLength(1)
    expect(session.processStatus).toBe('error')
    expect(session.processPid).toBeNull()
  })

  it('a quiet exit after a result that already saw the CLI gone keeps the session stopped', () => {
    // A local CLI that exits right after its result: the result handler finds no
    // live process and says 'stopped'; the exit that lands next must not turn it
    // back to 'idle', or the next status write describes a dead CLI as live.
    const session = runningSession()
    const inner = session as unknown as { handleQuietProcessExit(): void; reclaimUntakenLines(): void; _transport: Record<string, unknown> }
    vi.spyOn(inner, 'reclaimUntakenLines').mockImplementation(() => {})
    Object.assign(inner._transport, { isRemote: false, hasPipe: false, stopTail: vi.fn() })
    feed(session, commandResult({ result: 'done', num_turns: 1 }))
    expect(session.processStatus).toBe('stopped')
    inner.handleQuietProcessExit()
    expect(session.processStatus).toBe('stopped')
    expect(session.processPid).toBeNull()
  })

  it('a notification turn with its own init hands the failed task back without a second result', async () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    // Spy on the instance: the session's dynamic import of phase.js need not resolve to this file's module mock.
    const handBack = vi.spyOn(session as unknown as { _handBackFollowupPhase(): void }, '_handBackFollowupPhase')
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'detached', is_backgrounded: true, session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'detached', status: 'completed', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: SID })
    init(session)
    feed(session, commandResult({ origin: { kind: 'task-notification' }, result: 'Background completed' }))
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(handBack).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(session.processStatus).toBe('error')
  })

  it('input during an automatic turn after a settled failure is judged on its own', async () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, localCommandLine())
    feed(session, commandResult())
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    init(session)
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'running', session_id: SID })
    expect(await session.writeMessage('and then?', { stopFence: null })).toBe(true)
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results.map(r => r.isError)).toEqual([true, false])
    expect(session.processStatus).toBe('idle')
  })

  it('input after a held failure result starts a turn the failure does not judge', async () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'gating-task', session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    expect(results).toHaveLength(0)
    expect(await session.writeMessage('ok, continue', { stopFence: null })).toBe(true)
    init(session)
    feed(session, commandResult({ result: 'Continued', num_turns: 1, total_cost_usd: 0.01 }))
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'gating-task', status: 'completed', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results).toMatchObject([{ isError: false }])
    expect(session.processStatus).toBe('idle')
  })

  it('a stop after a held failure result ends the remaining work but keeps the failure', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'gating-task', session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    ;(session as unknown as SessionInternals)._interruptRequested = true
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'gating-task', status: 'stopped', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results).toMatchObject([{ isError: true }])
    expect(results[0].interrupted).toBeUndefined()
    expect(session.processStatus).toBe('error')
  })

  it.each(['aborted_streaming', 'aborted_tools'])('a stopped result after a held failure result keeps the failure (%s)', reason => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'gating-task', session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult())
    feed(session, commandResult({ is_error: true, terminal_reason: reason }))
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'gating-task', status: 'stopped', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results).toMatchObject([{ isError: true }])
    expect(results[0].interrupted).toBeUndefined()
    expect(session.processStatus).toBe('error')
  })

  it('the init record write that lands after an instant command failure keeps the error', async () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    const emit = (ClaudeCodeSession.prototype as unknown as { emitStatusChanged: ReturnType<typeof vi.fn> }).emitStatusChanged
    init(session)
    feed(session, localCommandLine())
    feed(session, commandResult())
    expect(results).toMatchObject([{ isError: true }])
    emit.mockClear()
    // sessionReady resolves in the finally after the init's late status write.
    expect(await session.sessionReady).toBe(SID)
    expect(emit.mock.calls.filter(call => call[0] === 'IN_PROGRESS')).toHaveLength(0)
    expect(session.processStatus).toBe('error')
  })

  it('a team drain preserves its main command failure', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    const inner = session as unknown as { _teamActive: boolean; _areTeammatesStillActive(): boolean }
    inner._teamActive = true
    vi.spyOn(inner, '_areTeammatesStillActive').mockReturnValue(false)
    feed(session, localCommandLine())
    feed(session, commandResult())
    vi.runOnlyPendingTimers()
    expect(results).toHaveLength(2)
    expect(results.every(row => row.isError === true)).toBe(true)
    expect(session.processStatus).toBe('error')
  })

  it.each(['aborted_streaming', 'aborted_tools'])('a stopped result while a team holds the failure keeps it (%s)', reason => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    const inner = session as unknown as { _teamActive: boolean; _areTeammatesStillActive(): boolean }
    inner._teamActive = true
    vi.spyOn(inner, '_areTeammatesStillActive').mockReturnValue(false)
    feed(session, localCommandLine())
    feed(session, commandResult())
    init(session)
    feed(session, commandResult({ is_error: true, terminal_reason: reason }))
    vi.runOnlyPendingTimers()
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(row => row.isError === true && row.interrupted === undefined)).toBe(true)
    expect(session.processStatus).toBe('error')
  })

  it('a successful empty local command never repeats the previous answer', () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    ;(session as unknown as { fullText: string }).fullText = 'Previous answer'
    feed(session, commandResult({ result: '' }))
    expect(results).toMatchObject([{ result: '', isError: false }])
  })

  it.each(['aborted_streaming', 'aborted_tools'])('a withheld aborted result stays interrupted after gating drains (%s)', reason => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, { type: 'system', subtype: 'task_started', task_id: 'gating-task', session_id: SID })
    feed(session, localCommandLine())
    feed(session, commandResult({ terminal_reason: reason }))
    expect(results).toHaveLength(0)
    feed(session, { type: 'system', subtype: 'task_notification', task_id: 'gating-task', status: 'completed', session_id: SID })
    feed(session, { type: 'system', subtype: 'session_state_changed', state: 'idle', session_id: SID })
    expect(results).toMatchObject([{ isError: false, interrupted: true }])
  })

  it('a later normal turn stays successful even if an old failure is replayed into it', () => {
    const session = runningSession()
    const { notices, deltas, results } = captureCommandEvents()
    feed(session, localCommandLine())
    feed(session, commandResult())
    init(session)
    feed(session, localCommandLine())
    feed(session, {
      type: 'assistant', session_id: SID,
      message: { id: 'next-answer', role: 'assistant', model: 'mock-model', content: [{ type: 'text', text: 'Recovered normally.' }] },
    })
    feed(session, commandResult({ result: 'Recovered normally.', num_turns: 1, total_cost_usd: 0.001, usage: { input_tokens: 20, output_tokens: 5 } }))
    expect(notices).toHaveLength(1)
    expect(deltas.map((d) => d.delta)).toEqual(['Recovered normally.'])
    expect(results.map((r) => r.isError)).toEqual([true, false])
  })

  it('a successful local command retains normal assistant rendering and a successful result', () => {
    const session = runningSession()
    const { notices, deltas, results } = captureCommandEvents()
    feed(session, localCommandLine({ local_command_outcome: { kind: 'completed' } }))
    feed(session, commandResult())
    expect(notices).toEqual([])
    expect(deltas).toMatchObject([{ delta: COMPACTION_ERROR, msgId: MESSAGE_ID }])
    expect(results.map((r) => r.isError)).toEqual([false])
  })

  it('ordinary model prose mentioning a compaction error is not a command failure', () => {
    const session = runningSession()
    const { notices, deltas, results } = captureCommandEvents()
    feed(session, localCommandLine({ local_command_outcome: undefined, local_command_run: undefined }))
    feed(session, commandResult())
    expect(notices).toEqual([])
    expect(deltas).toMatchObject([{ delta: COMPACTION_ERROR, msgId: MESSAGE_ID }])
    expect(results.map((r) => r.isError)).toEqual([false])
  })

  it('a subagent command failure stays in its own lane and cannot fail the main turn', () => {
    const session = runningSession()
    const { notices, deltas, results } = captureCommandEvents()
    feed(session, localCommandLine({ parent_tool_use_id: 'subagent-task-tool' }))
    feed(session, commandResult())
    expect(notices).toEqual([])
    expect(deltas).toMatchObject([{ delta: COMPACTION_ERROR, msgId: MESSAGE_ID, parentToolUseId: 'subagent-task-tool' }])
    expect(results.map((r) => r.isError)).toEqual([false])
  })

  it.each(['aborted_streaming', 'aborted_tools', 'user-interrupt'])('a failed command cannot turn a stopped turn into an error (%s)', (reason) => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, localCommandLine())
    if (reason === 'user-interrupt') (session as unknown as SessionInternals)._interruptRequested = true
    feed(session, commandResult({ terminal_reason: reason }))
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(false)
    if (reason === 'user-interrupt') expect(results[0].interrupted).toBe(true)
  })

  it('another failed command with new ids reports its own failure', () => {
    const session = runningSession()
    const { notices, results } = captureCommandEvents()
    feed(session, localCommandLine())
    feed(session, commandResult())
    init(session)
    feed(session, localCommandLine({ uuid: 'another-command-row' }))
    feed(session, commandResult())
    expect(notices.map((n) => n.uuid)).toEqual([COMMAND_UUID, 'another-command-row'])
    expect(results.map((r) => r.isError)).toEqual([true, true])
  })

  it('mid-turn input and a running-state echo preserve an unconsumed failure', async () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, localCommandLine())
    expect(await session.writeMessage('Additional input', { stopFence: null })).toBe(true)
    feed(session, { type: 'system', subtype: 'session_state_changed', session_id: SID, state: 'running' })
    feed(session, commandResult())
    expect(results.map((r) => r.isError)).toEqual([true])
  })

  it('a genuine idle-to-running delivery resets an abandoned command failure', async () => {
    const session = runningSession()
    const { results } = captureCommandEvents()
    feed(session, localCommandLine())
    ;(session as unknown as SessionInternals)._processStatus = 'idle'
    expect(await session.writeMessage('Next input', { stopFence: null })).toBe(true)
    feed(session, commandResult())
    expect(results.map((r) => r.isError)).toEqual([false])
  })

  it('a positional replay of an unseen old command row does not fail the current turn', () => {
    const session = runningSession()
    const inner = session as unknown as SessionInternals
    inner._consumedOffset = 100
    const { notices, results } = captureCommandEvents()
    ;(session as unknown as { handleStreamLine(line: string, v: number): void })
      .handleStreamLine(JSON.stringify(localCommandLine()), 80)
    ;(session as unknown as { handleStreamLine(line: string, v: number): void })
      .handleStreamLine(JSON.stringify(commandResult()), 120)
    expect(notices).toHaveLength(1)
    expect(results.map((r) => r.isError)).toEqual([false])
  })
})

describe('ClaudeCodeSession: compaction emits one notice per compaction', () => {
  it('a 5-minute compaction (11 keep-alives) emits ONE placeholder, then the outcome', () => {
    const session = new ClaudeCodeSession('task-compact-1', 'proj')
    init(session)
    const notices = captureNotices()

    // 11 keep-alives ≈ a 330s compaction, inside the measured 147-539s range.
    for (let i = 0; i < 11; i++) feed(session, compactingLine(`ka-${i}`))
    expect(notices).toEqual([
      { variant: 'compact', message: COMPACTING_MESSAGE, detail: undefined, progress: true },
    ])

    feed(session, boundaryLine('b-1'))
    expect(notices).toHaveLength(2)
    expect(notices[1]).toEqual({
      variant: 'compact', message: COMPACTED_MESSAGE,
      detail: '444K → 49K tokens · auto', progress: undefined,
    })
  })

  it('the numbers are labelled as tokens at both ends, never a bare figure', () => {
    const session = new ClaudeCodeSession('task-compact-2', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, boundaryLine('b-2', { pre_tokens: 867067, post_tokens: 43107 }))
    // The reported row said only "444K tokens", which reads like a percentage.
    expect(notices[0].detail).toBe('867K → 43K tokens · auto')
  })

  it('a replayed tail (reattach) re-emits nothing — same uuids, no new rows', () => {
    const session = new ClaudeCodeSession('task-compact-3', 'proj')
    init(session)
    const notices = captureNotices()

    const tail = [compactingLine('ka-a'), compactingLine('ka-b'), boundaryLine('b-3')]
    for (const line of tail) feed(session, line)
    expect(notices).toHaveLength(2)

    // addSubscriber replays [fromOffset, end) of the stream file: the exact same
    // lines, in order, a second time.
    for (const line of tail) feed(session, line)
    expect(notices).toHaveLength(2)
  })

  it('a second real compaction announces itself again', () => {
    const session = new ClaudeCodeSession('task-compact-4', 'proj')
    init(session)
    const notices = captureNotices()

    feed(session, compactingLine('ka-1'))
    feed(session, boundaryLine('b-4a'))
    feed(session, compactingLine('ka-2'))
    feed(session, boundaryLine('b-4b', { pre_tokens: 612799, post_tokens: 47027 }))

    expect(notices.map((n) => `${n.message}|${n.detail ?? ''}`)).toEqual([
      `${COMPACTING_MESSAGE}|`,
      `${COMPACTED_MESSAGE}|444K → 49K tokens · auto`,
      `${COMPACTING_MESSAGE}|`,
      `${COMPACTED_MESSAGE}|613K → 47K tokens · auto`,
    ])
  })

  it('a compaction that never finished does not mute the next process', () => {
    // The CLI died mid-compaction, so no boundary ever closed the placeholder.
    // Without a reset the gate would stay shut for the rest of the session's
    // life and no later compaction would ever announce itself.
    const session = new ClaudeCodeSession('task-compact-5', 'proj')
    init(session)
    const notices = captureNotices()
    feed(session, compactingLine('ka-dead'))
    expect(notices).toHaveLength(1)

    // Stand in for the spawn-time reset: start() clears this gate in the same
    // block as `_emittedStreamKeys.clear()`. Spawning a real CLI here would buy
    // nothing the mock-CLI e2e doesn't already cover.
    ;(session as unknown as { _compactionNoticeOpen: boolean })._compactionNoticeOpen = false

    feed(session, compactingLine('ka-alive'))
    expect(notices).toHaveLength(2)
    expect(notices[1].message).toBe(COMPACTING_MESSAGE)
  })

  it('a line with no uuid still collapses (older CLI / ACP dialect)', () => {
    const session = new ClaudeCodeSession('task-compact-6', 'proj')
    init(session)
    const notices = captureNotices()
    for (let i = 0; i < 4; i++) {
      feed(session, { type: 'system', subtype: 'status', status: 'compacting', session_id: SID })
    }
    expect(notices).toHaveLength(1)
  })
})
