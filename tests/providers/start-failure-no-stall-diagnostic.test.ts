/**
 * A start its host refused delivered nothing, so it never logs "STALL DIAGNOSTIC:
 * no JSONL event 30s after message delivery" (2026-11-14: one false stall after each
 * of 262 starts refused by a host whose link was down). The resume path arms the
 * stall timer right after transport.start(); the start's failure clears it. A start
 * whose outcome is unknown (a daemon command that timed out) keeps it: the daemon
 * may still run the buffered start, and the diagnostic is what says it did not. The
 * pool's cached dial failure reads as unknown by its words ("Connection to X failed
 * Ns ago"), but it is tagged `no-link` (link-failure.ts): no command left, so it
 * clears too (the incident's own error).
 *
 * MACHINE SAFETY: nothing is spawned. The transport is a stub whose start rejects,
 * the cwd check and the file reader are stubs, the liveness monitor is off, and the
 * data home is a temp dir (createMockConstants).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const rec = vi.hoisted(() => ({
  starts: 0,
  startError: null as Error | null,
  logs: [] as unknown[][],
}))

vi.mock('../../src/constants.js', () => createMockConstants('walnut-start-failure-no-stall'))
vi.mock('../../src/logging/index.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  // Any depth (log.session.warn) is the same recorder.
  const recorder: Record<string, unknown> = new Proxy(function recordLog() {}, {
    get: (_t, k) => (k === 'then' ? undefined : recorder),
    apply: (_t, _this, args: unknown[]) => { rec.logs.push(args) },
  }) as never
  return { ...real, log: recorder }
})
vi.mock('../../src/providers/session-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createSessionManager: () => ({
    isRemote: true, hasPipe: false, processName: 'claude', pid: null, outputFile: null, host: 'devbox', fileSize: 0,
    renameForSession: () => {},
    isAlive: async () => false,
    stop: async () => {}, stopTail: () => {}, detach: () => {},
    start: () => { rec.starts++; return Promise.reject(rec.startError) },
  }),
  registerSessionManager: () => {},
  unregisterSessionManager: () => {},
}))
vi.mock('../../src/providers/cwd-check.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkCwdExists: async () => ({ ok: true }),
}))
vi.mock('../../src/core/daemon-file-reader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  DaemonFileReader: class {
    async probeSessionPath() { return '/projects/-tmp/session.jsonl' }
    async readCostState() { return null }
  },
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { markLinkFailure } from '../../src/providers/link-failure.js'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1'
const STALL = 'STALL DIAGNOSTIC: no JSONL event 30s after message delivery'
// Starts refused by a host whose link is down: nothing reached the host.
const LINK_DOWN: Array<[string, () => Error]> = [
  // Link-down words (isHostLinkFailure) that are not an unknown outcome.
  ['link-down words', () => new Error('The session host bridge disconnected')],
  // The incident's error: the pool's cached failure, whose words alone read as an
  // unknown outcome, tagged no-link where the pool raises it (getDaemonConnection).
  ['the pool\'s cached failure, tagged no-link', () => markLinkFailure(new Error(
    'Connection to devbox failed 0s ago: Error: proxy client returned an error ... '
    + '[walnut-ssh-evidence: proxy-login (the SSH proxy says its own login is invalid or expired)]',
  ), 'no-link')],
]
// A daemon command whose answer never came: the start may still run.
const OUTCOME_UNKNOWN = 'daemon command timeout: start (30000ms)'

type Internals = { _stallDiagTimer: ReturnType<typeof setTimeout> | null; startLivenessMonitor(): void }

/** A cold --resume carrying a message; `settled` is the queue's settle callback. */
function resume(settled?: (ok: boolean, err?: Error) => void): ClaudeCodeSession & Internals {
  const s = new ClaudeCodeSession('', 'proj') as ClaudeCodeSession & Internals
  s.send('hello', '/tmp', SID, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, settled)
  return s
}

/** Waits for the start to be refused, then lets the 30s stall window pass. */
async function refusedStartThenWait(settled?: { calls: Array<[boolean, Error | undefined]> }): Promise<ClaudeCodeSession & Internals> {
  const s = resume(settled ? (ok, err) => { settled.calls.push([ok, err]) } : undefined)
  await vi.waitFor(() => expect(rec.logs.some((args) => args[0] === 'transport start failed')).toBe(true), { timeout: 10_000 })
  if (settled) expect(settled.calls.map(([ok]) => ok)).toEqual([false])
  await vi.advanceTimersByTimeAsync(31_000)
  return s
}

const stallLogs = () => rec.logs.filter((args) => args[0] === STALL)

beforeEach(() => {
  rec.starts = 0
  rec.startError = null
  rec.logs.length = 0
  // Real time still passes for the pre-spawn steps; the 30s window is advanced by hand.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.spyOn(ClaudeCodeSession.prototype as unknown as Internals, 'startLivenessMonitor').mockImplementation(() => {})
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a start that failed logs no stall diagnostic', () => {
  it.each(LINK_DOWN)('a queue resume (settle callback) refused by a host whose link is down: %s', async (_name, error) => {
    rec.startError = error()
    const s = await refusedStartThenWait({ calls: [] })
    expect(rec.starts).toBe(1)
    expect(s._stallDiagTimer).toBeNull()
    expect(stallLogs()).toEqual([])
  })

  it.each(LINK_DOWN)('a resume with no settle callback refused by a host whose link is down: %s', async (_name, error) => {
    rec.startError = error()
    const s = await refusedStartThenWait()
    expect(rec.starts).toBe(1)
    expect(s._stallDiagTimer).toBeNull()
    expect(stallLogs()).toEqual([])
  })

  it('control: a start whose outcome is unknown (untagged) keeps the diagnostic', async () => {
    rec.startError = new Error(OUTCOME_UNKNOWN)
    await refusedStartThenWait({ calls: [] })
    expect(rec.starts).toBe(1)
    expect(stallLogs()).toHaveLength(1)
    expect(stallLogs()[0]![1]).toMatchObject({ trigger: 'resume-spawn', sessionId: SID })
  })
})
