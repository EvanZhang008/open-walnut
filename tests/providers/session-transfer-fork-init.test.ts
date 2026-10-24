/**
 * The CLI side of a Claude to Claude transfer: the fork resumes from the staged
 * FILE, and TRANSFER_FORK_INIT is announced once, only after the first init's
 * whole record chain (persist, or rename + queue move when the CLI ran under
 * another id, then the model write).
 *
 * MACHINE SAFETY: no process, socket or file. The transport is a recorder whose
 * start never resolves (nothing is spawned), the cwd check, stop fence and file
 * reader are stubs, the session store and queue writes the init makes are
 * recorders, logging is a no-op, and every absolute path the constants module
 * exports is moved under /nonexistent, so a write that slipped past these mocks
 * fails instead of landing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const rec = vi.hoisted(() => {
  const r = {
    order: [] as string[],
    managers: [] as unknown[][],
    starts: [] as Array<Record<string, unknown>>,
    failCreate: false,
    /** Every call to a store export this test did not expect; asserted empty after each test. */
    unexpected: [] as string[],
    /** A complete stub: each named export of the real module, failing loudly unless overridden. */
    stub(names: string[], overrides: Record<string, unknown>): Record<string, unknown> {
      const out: Record<string, unknown> = {}
      for (const n of names) out[n] = (..._a: unknown[]) => { r.unexpected.push(n); throw new Error(`unexpected store call: ${n}`) }
      return Object.assign(out, overrides)
    },
  }
  return r
})

vi.mock('../../src/constants.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(real)) out[k] = typeof v === 'string' && v.startsWith('/') ? '/nonexistent/walnut-xfer-test' + v : v
  return out
})
vi.mock('../../src/logging/index.js', () => {
  // Any depth (log.session.info, log.bus.debug) is the same callable no-op.
  const noop: Record<string, unknown> = new Proxy(function noopLog() {}, { get: (_t, k) => (k === 'then' ? undefined : noop), apply: () => undefined }) as never
  return { log: noop, createSubsystemLogger: () => noop, initLogging: () => {}, shouldLog: () => false, LOG_LEVEL_ORDER: [], redactSensitiveText: (s: string) => s }
})
vi.mock('../../src/providers/session-manager.js', () => ({
  createSessionManager: (...a: unknown[]) => {
    rec.managers.push(a)
    return {
      isRemote: false, hasPipe: false, processName: 'claude', pid: null, outputFile: null, host: null,
      renameForSession: (id: string) => { rec.order.push(`transport-rename:${id}`) },
      // The whole request the daemon would get; it never resolves, so nothing is spawned.
      start: (opts: Record<string, unknown>) => { rec.starts.push({ ...opts, args: [...(opts.args as string[])] }); return new Promise(() => {}) },
    }
  },
  registerSessionManager: () => {},
  unregisterSessionManager: () => {},
}))
vi.mock('../../src/providers/cwd-check.js', () => ({
  checkCwdExists: async () => ({ ok: true }),
  CwdMissingError: class CwdMissingError extends Error {},
}))
vi.mock('../../src/core/sessions/session-stop.js', () => ({ sessionStops: { fence: async () => null } }))
vi.mock('../../src/core/daemon-file-reader.js', () => ({
  DaemonFileReader: class { async readCostState() { return null } },
  DaemonNeedsUpgradeError: class DaemonNeedsUpgradeError extends Error {},
}))
// Complete pure stubs of the two stores the init chain writes (no real tracker or queue
// is loaded). Export lists copied from src/core/session-tracker.ts and
// src/core/session-message-queue.ts (with its re-exports) at base 87d914f71.
vi.mock('../../src/core/session-tracker.js', () => rec.stub([
  'toSessionStatusSnapshot', 'onSessionStoreWrite', 'isTriageSession', 'isTerminalSession', 'isListableSession',
  'isLaneSession', 'isEnvironmentSession', 'installAwaySessions', 'getSessionsForTaskSync',
  'getSessionByClaudeIdSync', 'getAcpIdentityReplacementTarget', '_withSessionWriteLockForTesting',
  '_setRetaskSliceMsForTesting', '_setRetaskClockForTesting', '_sessionStoreStatsForTesting',
  '_resetSessionTrackerForTesting', '_dropSessionStoreCacheForTesting', 'updateSessionRecordConditionally',
  'unlinkSessionsFromTasks', 'stageAcpSessionIdMigration', 'sessionRowsForReplica', 'scrubInheritedSessionPids',
  'rollbackAcpSessionIdMigration', 'resolveSessionByIdOrPrefix', 'relinkSessionsToTask', 'querySessions',
  'listSessionsForTasks', 'listSessionsForTaskHandback', 'listSessionsForHealthScan', 'listSessionsByLane',
  'listSessions', 'listRecentSessionRecords', 'listPendingSessionStops', 'listOrphanCandidates',
  'listNonTerminalSessions', 'listChatLaneSessions', 'listAllSessionIds', 'linkSessionToTask',
  'importSessionRecord', 'hostsWithSessionOverviews', 'hostSessionsWithOverview', 'healStalePendingPermissions',
  'getSessionSummaries', 'getSessionStatusSnapshots', 'getSessionsForTask', 'getSessionByLane',
  'getSessionByClaudeId', 'getRecentSessions', 'getAllAliveSessionsByHost', 'getActiveSessionsByHost',
  'deleteSessionRecords', 'completeTaskSessions', 'checkSessionLimit', 'batchUpdateSessionRecords',
  'acceptAcpPrompt',
], {
  TRIAGE_AGENTS: new Set(['turn-complete-triage', 'message-send-triage']),
  SESSION_ID_MIN_PREFIX: 8,
  renameSessionId: async (from: string, to: string) => { rec.order.push(`rename:${from}->${to}`); return true },
  createSessionRecord: async (id: string) => {
    if (rec.failCreate) throw new Error('disk full')
    rec.order.push(`create:${id}`)
  },
  updateSessionRecord: async (id: string, patch: Record<string, unknown>) => {
    if ('model' in patch) rec.order.push(`model:${id}`)
    return null
  },
  emitSessionStatusChanged: () => {},
}))
vi.mock('../../src/core/session-message-queue.js', () => rec.stub([
  'enqueueMessage', 'markNextProcessing', 'markProcessing', 'removeProcessed', 'revertToPending', 'parkMessages',
  'parkStalePending', 'loadQueue', 'getAllSessionsWithPending', 'getQueue', 'removeTaken', 'revertIfQueued',
  'parkIfQueued', 'withUndeliveredMessageGuard', 'withdrawRelayedMessage', 'sendMessageToSession', 'relayFateOf',
  'isMessageQueued', 'findQueuedMessage', 'editMessage', 'deleteMessage', 'settledLineUuid', 'unparkMessage',
  'rollbackSessionQueueMigration', 'resetCache',
], {
  MAX_PENDING_AGE_MS: 7 * 24 * 60 * 60_000,
  QueueNotStoredError: class QueueNotStoredError extends Error {},
  migrateSessionQueue: async (from: string, to: string) => { rec.order.push(`migrate:${from}->${to}`) },
}))

import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { DEFAULT_SESSION_MODE } from '../../src/core/types.js'

const XF = 'xf-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const PRE = '11111111-2222-4333-8444-555555555555'
const ACTUAL = '99999999-8888-4777-8666-555555555555'
const STAGED = `/home/dev/.open-walnut-transfers/${XF}/transcript/${PRE}.jsonl`

const init = (id: string) => JSON.stringify({ type: 'system', subtype: 'init', session_id: id, cwd: '/home/dev/repo', model: 'mock-model', tools: [], mcp_servers: [], permissionMode: 'default' })

type Internals = {
  handleStreamLine(line: string): void
  _expectedSessionId: string | null
  _transport: unknown
  _initEffortRead: boolean
  _modelCatalog: unknown
  sessionReady: Promise<string>
}

function sessionAwaitingInit(expected: string, attemptId?: string): ClaudeCodeSession & Internals {
  const s = new ClaudeCodeSession('task-new', 'Marina') as ClaudeCodeSession & Internals
  s.claudeSessionId = expected
  s._expectedSessionId = expected
  if (attemptId) s.transferAttemptId = attemptId
  s._transport = { isRemote: false, hasPipe: false, outputFile: null, renameForSession: (id: string) => { rec.order.push(`transport-rename:${id}`) } }
  // No deferred settings read-back or model-catalog fetch: nothing would answer them.
  s._initEffortRead = true
  s._modelCatalog = []
  return s
}

const forkInits: Array<Record<string, unknown>> = []
beforeEach(() => {
  bus.clear()
  rec.order.length = 0; rec.managers.length = 0; rec.starts.length = 0; rec.unexpected.length = 0; rec.failCreate = false
  forkInits.length = 0
  bus.subscribe('test-transfer', (e) => {
    if (e.name === EventNames.TRANSFER_FORK_INIT) { forkInits.push(e.data as Record<string, unknown>); rec.order.push('fork-init') }
  }, { global: true, interest: [EventNames.TRANSFER_FORK_INIT] })
})
afterEach(() => {
  bus.clear()
  expect(rec.unexpected).toEqual([])
})

/** The init chain awaits module imports, so give it real turns of the loop (bounded). */
const settle = () => new Promise((r) => setTimeout(r, 50))

describe('a transfer fork spawn', () => {
  it('resumes from the staged file with --fork-session and the pre-assigned --session-id', async () => {
    const s = new ClaudeCodeSession('task-new', 'Marina')
    s.send('continue', '/home/dev/repo', STAGED, undefined, undefined, undefined, undefined, undefined, true,
      undefined, undefined, undefined, undefined, undefined, { preassignedSessionId: PRE })
    await vi.waitFor(() => expect(rec.starts).toHaveLength(1), { timeout: 2000 })
    // The transport is made under the pre-assigned id, on this machine.
    expect(rec.managers).toHaveLength(1)
    expect(rec.managers[0].slice(0, 3)).toEqual([PRE, undefined, undefined])
    const [start] = rec.starts
    const { args, onOutput, onExit, ...request } = start as { args: string[]; onOutput: unknown; onExit: unknown }
    // Everything the daemon would be asked besides the argv and the two callbacks.
    expect(request).toEqual({ stopFence: null, cwd: '/home/dev/repo', message: 'continue', resume: false, fork: true, taskId: 'task-new', spillFile: undefined, mode: DEFAULT_SESSION_MODE })
    expect(typeof onOutput).toBe('function')
    expect(typeof onExit).toBe('function')
    const count = (flag: string) => args.filter((a) => a === flag).length
    expect(count('--resume')).toBe(1)
    expect(args[args.indexOf('--resume') + 1]).toBe(STAGED)
    expect(count('--fork-session')).toBe(1)
    expect(count('--session-id')).toBe(1)
    expect(args[args.indexOf('--session-id') + 1]).toBe(PRE)
    expect(args).not.toContain('--resume-session-at')
  })
})

describe('TRANSFER_FORK_INIT', () => {
  it('the CLI ran under another id: announced after the rename, the queue move and the model write, once', async () => {
    const s = sessionAwaitingInit(PRE, XF)
    s.handleStreamLine(init(ACTUAL))
    expect(await s.sessionReady).toBe(ACTUAL)
    await settle()
    expect(rec.order.filter((x) => !x.startsWith('transport-'))).toEqual([`rename:${PRE}->${ACTUAL}`, `migrate:${PRE}->${ACTUAL}`, `model:${ACTUAL}`, 'fork-init'])
    expect(forkInits).toEqual([{ attemptId: XF, preassignedId: PRE, actualId: ACTUAL, renamed: true }])
    // A later init (the next turn) is not the transfer's.
    s.handleStreamLine(init(ACTUAL))
    await settle()
    expect(forkInits).toHaveLength(1)
  })

  it('the CLI honoured the pre-assigned id: announced after the record and the model write', async () => {
    const s = sessionAwaitingInit(PRE, XF)
    s.handleStreamLine(init(PRE))
    await s.sessionReady
    await settle()
    expect(rec.order.filter((x) => !x.startsWith('transport-'))).toEqual([`create:${PRE}`, `model:${PRE}`, 'fork-init'])
    expect(forkInits).toEqual([{ attemptId: XF, preassignedId: PRE, actualId: PRE, renamed: false }])
  })

  it('the record could not be written: never announced (the transfer then times out and keeps its task)', async () => {
    rec.failCreate = true
    const s = sessionAwaitingInit(PRE, XF)
    s.handleStreamLine(init(PRE))
    expect(await s.sessionReady).toBe(PRE)
    await settle()
    expect(forkInits).toEqual([])
  })

  it('a session that is not a transfer never announces one', async () => {
    const s = sessionAwaitingInit(PRE)
    s.handleStreamLine(init(PRE))
    await s.sessionReady
    await settle()
    expect(forkInits).toEqual([])
  })
})

describe('the SDK session server path', () => {
  // A stub client only: nothing is connected, sent or started.
  const sdkRunner = () => {
    const r = new SessionRunner()
    r.setSdkClient({ connected: true } as never)
    return r as unknown as { assertStartRouting(d: Record<string, unknown>): Promise<void> }
  }

  it('refuses a transfer fork, in place (no resume file) or from a staged file: it cannot fork and never announces the init', async () => {
    await expect(sdkRunner().assertStartRouting({ forkedFromSessionId: PRE, transferAttemptId: XF })).rejects.toThrow(/session server/)
    await expect(sdkRunner().assertStartRouting({ forkedFromSessionId: PRE, resumeFile: STAGED, transferAttemptId: XF })).rejects.toThrow(/session server/)
    expect(rec.starts).toEqual([])
  })
})
