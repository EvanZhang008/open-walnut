/**
 * A start its host refused delivered nothing, so it never logs "STALL DIAGNOSTIC:
 * no JSONL event 30s after message delivery" (2026-11-14: one false stall after each
 * of 262 starts refused by a host whose link was down). Only a confirmed start
 * stamps delivery and arms its stall diagnostic. An unknown start keeps a separate
 * diagnostic, never a delivery timestamp: the daemon may still run the buffered
 * start. A cached dial failure tagged no-link cannot have sent anything.
 *
 * MACHINE SAFETY: nothing is spawned. The transport is a stub whose start rejects,
 * the cwd check and the file reader are stubs, the liveness monitor is off, and the
 * data home is a temp dir (createMockConstants).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createMockConstants } from '../helpers/mock-constants.js'

const rec = vi.hoisted(() => ({
  starts: 0,
  startError: null as Error | null,
  logs: [] as unknown[][],
  confirmStart: false,
  beforeAck: null as (() => void) | null,
  output: null as ((event: { line: string; v: number }) => void) | null,
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
    start: (opts: { onOutput: (event: { line: string; v: number }) => void }) => {
      rec.starts++
      rec.output = opts.onOutput
      rec.beforeAck?.()
      return rec.confirmStart ? Promise.resolve({ pid: 4242, outputFile: '/tmp/start-confirmed.jsonl', fileSize: 0 }) : Promise.reject(rec.startError)
    },
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
import { SessionHeldElsewhereError, ClaudeRuntimeMissingError } from '../../src/providers/delivery-failure.js'
import { CwdMissingError } from '../../src/providers/cwd-check.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000000f1'
const STALL = 'STALL DIAGNOSTIC: no JSONL event 30s after message delivery'
const UNKNOWN_STALL = 'STALL DIAGNOSTIC: no JSONL event 30s after unconfirmed start'
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
  ['expired certificate', () => markLinkFailure(new Error('Certificate expired'), 'no-link')],
  ['missing folder', () => new CwdMissingError('Working directory does not exist')],
  ['missing runtime', () => new ClaudeRuntimeMissingError('Runtime executable missing', 'claude_missing')],
  ['held session', () => new SessionHeldElsewhereError('devbox', 'session_live', 4242)],
  ['new refusal kind', () => new Error('New host refusal')],
]
// A daemon command whose answer never came: the start may still run.
const OUTCOME_UNKNOWN = 'daemon command timeout: start (30000ms)'

type Internals = {
  _stallDiagTimer: ReturnType<typeof setTimeout> | null
  _lastClaudeOutputTs: number
  _lastMessageDeliveryTs: number
  startLivenessMonitor(): void
}

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
  rec.confirmStart = false
  rec.beforeAck = null
  rec.output = null
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
  it('every new delivery diagnostic call stays after transport confirmation', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../src/providers/claude-code-session.ts', import.meta.url)), 'utf8')
    const body = source.slice(source.indexOf('    const spawnPromise = startSpawn()'), source.indexOf('  static forResume('))
    const success = body.indexOf('spawnPromise.then((result) => {')
    const failure = body.indexOf('}).catch((err) => {', success)
    const confirmed = [...body.matchAll(/this\.startStallDiagTimer\([^\n]+/g)].filter(match => !match[0].includes(', false'))
    expect(confirmed).toHaveLength(1)
    expect(confirmed[0].index).toBeGreaterThan(success)
    expect(confirmed[0].index).toBeLessThan(failure)
  })
  it('confirms delivery only after the start acknowledgement', async () => {
    rec.confirmStart = true
    const outcomes: boolean[] = []
    const s = resume(ok => outcomes.push(ok))
    expect(s.lastMessageDeliveryAt).toBe(0)
    await vi.waitFor(() => expect(outcomes).toEqual([true]), { timeout: 10_000 })
    expect(s.lastMessageDeliveryAt).toBeGreaterThan(0)
    expect(s._stallDiagTimer).not.toBeNull()
    s.detach()
  })

  it('does not invent silence when output beats the start acknowledgement', async () => {
    rec.confirmStart = true
    const outcomes: boolean[] = []
    const s = resume(ok => outcomes.push(ok))
    rec.beforeAck = () => { rec.output!({ line: JSON.stringify({ type: 'assistant', message: { id: 'early-answer', role: 'assistant', content: [{ type: 'text', text: 'Early answer' }] } }), v: 100 }) }
    await vi.waitFor(() => expect(outcomes).toEqual([true]), { timeout: 10_000 })
    expect(s.lastMessageDeliveryAt).toBeGreaterThan(0)
    expect(s._lastClaudeOutputTs).toBeGreaterThanOrEqual(s.lastMessageDeliveryAt)
    expect(s._stallDiagTimer).toBeNull()
    s.detach()
  })

  it('clears an old process delivery clock before every cold start attempt', async () => {
    rec.startError = new Error('New host refusal')
    const s = new ClaudeCodeSession('', 'proj') as ClaudeCodeSession & Internals
    s._lastMessageDeliveryTs = Date.now() - 600_000
    s.send('hello', '/tmp', SID, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, () => {})
    expect(s.lastMessageDeliveryAt).toBe(0)
    await vi.waitFor(() => expect(rec.logs.some(args => args[0] === 'transport start failed')).toBe(true), { timeout: 10_000 })
    expect(s.lastMessageDeliveryAt).toBe(0)
    s.detach()
  })
  it.each(LINK_DOWN)('a queue resume (settle callback) refused by a host whose link is down: %s', async (_name, error) => {
    rec.startError = error()
    // The queue's settle callback (settleResumeFailure) owns the record here.
    const s = await refusedStartThenWait({ calls: [] })
    expect(rec.starts).toBe(1)
    expect(s._stallDiagTimer).toBeNull()
    expect(s.lastMessageDeliveryAt).toBe(0)
    expect(stallLogs()).toEqual([])
  })

  it.each(LINK_DOWN)('a resume with no settle callback refused by a host whose link is down: %s', async (_name, error) => {
    rec.startError = error()
    const s = await refusedStartThenWait()
    expect(rec.starts).toBe(1)
    expect(s._stallDiagTimer).toBeNull()
    expect(s.lastMessageDeliveryAt).toBe(0)
    expect(s.processStatus).toBe('stopped')
    expect(stallLogs()).toEqual([])
  })

  it.each(['lost', 'no-answer'] as const)('a %s start stays unknown even without matching error words', async (kind) => {
    await createSessionRecord(SID, '', 'proj', '/tmp', { initialProcessStatus: 'stopped' })
    rec.startError = markLinkFailure(new Error('connection closed'), kind)
    const s = await refusedStartThenWait()
    expect(s.lastMessageDeliveryAt).toBe(0)
    expect(s.processStatus).toBe('error')
    expect(await getSessionByClaudeId(SID)).toMatchObject({ process_status: 'error', status_reason: 'spawn_outcome_unknown', errorKind: 'infra' })
  })

  it('control: a start whose outcome is unknown (untagged) keeps the diagnostic', async () => {
    rec.startError = new Error(OUTCOME_UNKNOWN)
    const s = await refusedStartThenWait({ calls: [] })
    expect(rec.starts).toBe(1)
    expect(s.lastMessageDeliveryAt).toBe(0)
    expect(stallLogs()).toEqual([])
    const unknown = rec.logs.filter(args => args[0] === UNKNOWN_STALL)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]![1]).toMatchObject({ trigger: 'resume-spawn', sessionId: SID, delivered: false })
  })
})
