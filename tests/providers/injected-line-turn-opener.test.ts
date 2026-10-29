/**
 * What the runner tells the phase machine about a turn its host's daemon opened
 * with a line of its own (src/providers/claude-code-session.ts _noteInjectedLine,
 * rules in src/core/task-wait-resume.ts). The server hears of a same-host
 * delivery only as the daemon's walnut-injected marker in the stream, so the
 * marker's envelopes say whose turn it is:
 *   - two lines delivered between turns run as one turn, and the stronger one
 *     (what the wait waited for, a person's words) decides it;
 *   - a line that ends the wait inside the turn, read before the turn's wait was
 *     noted, still keeps that wait from coming back;
 *   - an opener belongs to its turn only: a later turn the CLI starts itself (a
 *     ScheduleWakeup) is the CLI's, and a line delivered to a process that died
 *     opens nothing later.
 * The phase machine is stubbed to record the turn-start edges; the wait rules are real.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-injected-line-opener'))

const edges: Array<{ trigger: string; opts: Record<string, unknown> }> = []
vi.mock('../../src/core/phase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/phase.js')>()),
  applySessionPhase: vi.fn(async (_taskId: string, trigger: string, _source: string, opts: Record<string, unknown> = {}) => {
    edges.push({ trigger, opts })
    return { changed: false }
  }),
}))

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js'
import { interruptedWaits, noteInterruptedWait, resetInterruptedWaitsForTest } from '../../src/core/task-wait-resume.js'

const SID = 'injected-line-opener-sid'
const TASK = 'task-opener-1'
const kit = createEnvelopeKit()
const lead = { title: 'Lead', shortId: '0b253ffe', sessionId: '0b253ffe-1d5f-445d-aada-a7b5b5fb5a14', taskId: 'lead-1', host: 'local' }
const PEER = kit.buildPeerWrapper('Hold your build.', lead, { title: 'Hold the build' })
const REPLY = kit.buildReplyDeliveryText({ id: 'rq-abc123', preview: 'is the build fine?' } as never, lead, 'yes, all green')

type Fed = { handleStreamLine(line: string): void; handleProcessDeath(): void }

/** A session between turns: its last turn's result is in, the process waits on its FIFO. */
function idleSession(): ClaudeCodeSession {
  const session = new ClaudeCodeSession(TASK, 'test-project')
  const s = session as unknown as Record<string, unknown>
  s._transport = {
    isRemote: false, hasPipe: true, processName: 'claude', pid: null, outputFile: null, host: null,
    fileSize: 0, imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    deletePipe() {}, flushTail() {}, stopTail() {},
  }
  s._active = true
  s.claudeSessionId = SID
  s._processStatus = 'idle'
  s._turnResultEmitted = true
  return session
}

const feed = (session: ClaudeCodeSession, ...lines: object[]) => {
  for (const line of lines) (session as unknown as Fed).handleStreamLine(JSON.stringify(line))
}
/** The daemon's marker for a line it delivered; `ordered` = written inside the delivery (current daemons). */
const marker = (content: string, ordered = false) => ({
  type: 'user', subtype: 'walnut-injected', message: { role: 'user', content },
  walnutMessageId: `qm-host-${Math.random().toString(16).slice(2, 14)}`,
  ...(ordered ? { walnutDelivery: 'ordered' } : {}), timestamp: new Date().toISOString(),
})
const running = { type: 'system', subtype: 'session_state_changed', session_id: SID, state: 'running' }
let cost = 0.001
const result = () => ({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 40, num_turns: 1, result: 'Noted.',
  session_id: SID, total_cost_usd: (cost += 0.001), usage: { input_tokens: 10, output_tokens: 5 },
})
const turnStarts = () => edges.filter((e) => e.trigger === 'session:turn-start')
/** The runner reaches the phase machine through a dynamic import: wait for the next turn-start edge. */
async function nextTurnStart(seen = 0): Promise<{ trigger: string; opts: Record<string, unknown> }> {
  return vi.waitFor(() => {
    const all = turnStarts()
    if (all.length <= seen) throw new Error('no turn-start edge yet')
    return all[all.length - 1]
  })
}

beforeEach(() => {
  edges.length = 0
  resetInterruptedWaitsForTest()
})

describe('lines delivered between turns run as one turn: the stronger decides', () => {
  it('a reply, then a peer\'s note: the turn is the reply\'s (the wait ends)', async () => {
    const session = idleSession()
    feed(session, marker(REPLY), marker(PEER), running)
    expect((await nextTurnStart()).opts.lineSource).toBe('ends')
  })

  it('a person\'s words, then a peer\'s note: the person\'s', async () => {
    const session = idleSession()
    feed(session, marker('how is the build going?'), marker(PEER), running)
    expect((await nextTurnStart()).opts.lineSource).toBeNull()
  })

  it('a peer\'s note, then a reply: the reply\'s; a peer\'s note alone: the note\'s', async () => {
    const a = idleSession()
    feed(a, marker(PEER), marker(REPLY), running)
    expect((await nextTurnStart()).opts.lineSource).toBe('ends')
    const b = idleSession()
    feed(b, marker(PEER), running)
    expect((await nextTurnStart(1)).opts.lineSource).toBe('peer')
  })
})

describe('a line that ends the wait inside the turn, read before the wait is noted', () => {
  it('keeps the turn\'s wait from being remembered; another turn\'s wait is', async () => {
    const session = idleSession()
    // The ordered marker opens the turn at once; the reply lands inside it.
    feed(session, marker(PEER, true))
    const edge = await nextTurnStart()
    expect(edge.opts.lineSource).toBe('peer')
    feed(session, marker(REPLY, true))
    const leftAt = new Date().toISOString()
    noteInterruptedWait(TASK, { waitUntil: null, leftAt, sessionId: SID, cause: 'message', source: 'stream:peer', byLine: true }, edge.opts.waitTurn as number)
    expect(interruptedWaits().has(TASK)).toBe(false)
    // The mark is spent and named that turn only.
    noteInterruptedWait(TASK, { waitUntil: null, leftAt, sessionId: SID, cause: 'message', source: 'stream:peer', byLine: true }, edge.opts.waitTurn as number)
    expect(interruptedWaits().has(TASK)).toBe(true)
  })

  it('a person\'s words inside a turn a peer\'s note opened leave the mark too; another peer\'s note does not', async () => {
    const session = idleSession()
    feed(session, marker(PEER, true))
    const turn = (await nextTurnStart()).opts.waitTurn as number
    feed(session, marker(PEER, true))
    noteInterruptedWait(TASK, { waitUntil: null, leftAt: 'a', sessionId: SID, cause: 'message', source: 'stream:peer', byLine: true }, turn)
    expect(interruptedWaits().has(TASK)).toBe(true)
    resetInterruptedWaitsForTest()
    feed(session, marker('one more thing from me'))
    noteInterruptedWait(TASK, { waitUntil: null, leftAt: 'b', sessionId: SID, cause: 'message', source: 'stream:peer', byLine: true }, turn)
    expect(interruptedWaits().has(TASK)).toBe(false)
  })
})

describe('an opener belongs to its own turn', () => {
  it('after the note\'s turn ends, a turn the CLI starts itself (a wakeup) carries no line', async () => {
    const session = idleSession()
    feed(session, marker(PEER, true), running)
    await nextTurnStart()
    await new Promise((r) => setTimeout(r, 50))
    const seen = turnStarts().length
    expect(turnStarts().every((e) => e.opts.lineSource === 'peer')).toBe(true)
    feed(session, result())
    feed(session, running)
    const wake = await nextTurnStart(seen)
    expect(wake.opts).not.toHaveProperty('lineSource')
  })

  it('a line delivered to a process that died opens no later turn', async () => {
    const session = idleSession()
    feed(session, marker(PEER))
    ;(session as unknown as Fed).handleProcessDeath()
    // The same object sees a later turn begin (the process came back without a spawn of ours).
    const s = session as unknown as Record<string, unknown>
    s._processStatus = 'idle'
    s._turnResultEmitted = true
    feed(session, running)
    const later = await nextTurnStart()
    expect(later.opts).not.toHaveProperty('lineSource')
  })
})
