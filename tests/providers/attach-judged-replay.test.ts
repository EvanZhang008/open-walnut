/**
 * An attach of a session this host judges itself reads what its CLI wrote while no runner read it
 * from the last turn end it judged (attach-evidence.ts judgedReplayFloor), through attachToExisting
 * against a mock daemon: the turn that ended in the gap is judged once, the turn judged before it is
 * a replay. A session the leader judges keeps today's future-only attach.
 *
 * 2026-11-23: after a restart of a host's service, a same-host send's turn ended before the host's
 * runner attached again; the future-only attach skipped it and nobody judged it.
 *
 * Every case runs once per phase of the host's copy of the task: what the replay says must not hang
 * on it (review of 3279a329e4: at IN_PROGRESS a replay from a result's end made up an empty turn end
 * on that result's companion idle, and the real one was not said).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const own = vi.hoisted(() => ({ hostKey: '' }))

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/core/daemon-file-reader.js', async () => (await import('../helpers/mock-local-daemon-reader.js')).mockLocalDaemonReader())
vi.mock('../../src/core/sessions/session-row-owner.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/sessions/session-row-owner.js')>()),
  thisHostKey: () => own.hostKey,
}))

import { ClaudeCodeSession, SessionRunner } from '../../src/providers/claude-code-session.js'
import { lineBeingRead, setSaidLines, setToldLines } from '../../src/core/session-channel/host-judged-lines.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import type { SessionRecord } from '../../src/core/types.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
const streams = fs.mkdtempSync(path.join(os.tmpdir(), 'judged-replay-'))
let daemon: MockDaemon
const savedStreamsDir = process.env.WALNUT_STREAMS_DIR

beforeAll(async () => {
  process.env.WALNUT_STREAMS_DIR = streams
  daemon = await createMockDaemon({ streamsDir: streams })
})
afterAll(async () => {
  await daemon.stop().catch(() => {})
  if (savedStreamsDir === undefined) delete process.env.WALNUT_STREAMS_DIR
  else process.env.WALNUT_STREAMS_DIR = savedStreamsDir
  await fsp.rm(streams, { recursive: true, force: true })
})
beforeEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})
afterEach(async () => {
  bus.clear()
  own.hostKey = ''
  setToldLines(null)
  setSaidLines(null)
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

const toolUse = (id: string) => JSON.stringify({ type: 'assistant', message: { id: `msg-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const result = (sid: string, text: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 10, num_turns: 1, result: text, session_id: sid })
const idle = () => JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' })

/** A stream with two turns: the first judged (the watermark is its result's end), the second written while no runner read it. */
function seed(sid: string, pid: number, secondTurn: boolean): { watermark: number } {
  const first = [user('ROUND one'), result(sid, 'echo: ROUND one')].map((l) => l + '\n').join('')
  const watermark = Buffer.byteLength(first)
  const rest = [idle(), ...(secondTurn ? [user('ROUND two'), result(sid, 'echo: ROUND two'), idle()] : [])].map((l) => l + '\n').join('')
  fs.writeFileSync(path.join(streams, `${sid}.jsonl`), first + rest)
  daemon.seedSession(sid, { pid, alive: true })
  return { watermark }
}

const PHASES = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] as const
type Phase = typeof PHASES[number]

async function attach(sid: string, pid: number, watermark: number, phase: Phase): Promise<ClaudeCodeSession> {
  const { task } = await addTask({ title: `Judged replay ${sid}` })
  // The host's copy of the task, whatever it says (a copy behind the leader's, a task that stays in progress).
  await updateTaskRaw(task.id, { phase })
  await createSessionRecord(sid, task.id, 'proj', '/tmp', { pid, outputFile: `remote://__local__/${sid}`, messageCount: 1 })
  const record = { ...(await getSessionByClaudeId(sid))!, judge: 'host', host: '__local__', consumedOffset: watermark } as SessionRecord
  return ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`)
}

function resultsOf(sid: string): string[] {
  const out: string[] = []
  bus.subscribe(`judged-replay-${sid}`, (e) => {
    const d = e.data as { sessionId?: string; result?: unknown }
    if (e.name === EventNames.SESSION_RESULT && d.sessionId === sid) out.push(String(d.result))
  }, { global: true })
  return out
}

function eventsOf(sid: string, name: string): number[] {
  const out: number[] = []
  bus.subscribe(`judged-replay-${name}-${sid}`, (e) => {
    if (e.name === name && (e.data as { sessionId?: string }).sessionId === sid) out.push(1)
  }, { global: true })
  return out
}

/** A stream whose second turn was running at the restart: its tool call was told, its end came while no runner read. */
function seedMidTurn(sid: string, pid: number): { watermark: number; told: number; end: number } {
  const lines = [user('ROUND one'), result(sid, 'echo: ROUND one'), idle(), user('ROUND two'), toolUse('toolu_told'), result(sid, 'echo: ROUND two'), idle()]
  const ends: number[] = []
  let at = 0
  for (const l of lines) { at += Buffer.byteLength(l) + 1; ends.push(at) }
  fs.writeFileSync(path.join(streams, `${sid}.jsonl`), lines.map((l) => l + '\n').join(''))
  daemon.seedSession(sid, { pid, alive: true })
  return { watermark: ends[1]!, told: ends[4]!, end: ends[5]! }
}

/** A turn whose own result (an error) was withheld while its agent ran: the told line stayed below that result (claude-code-session.ts readOffset). */
function seedHeld(sid: string, pid: number): { watermark: number; told: number } {
  const started = JSON.stringify({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'agent-a', task_type: 'local_agent', description: 'agent-a' })
  const failed = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, num_turns: 1, result: 'held: rate limit', session_id: sid, total_cost_usd: 0.02 })
  const done = JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'agent-a', status: 'completed' })
  const lines = [user('ROUND one'), result(sid, 'echo: ROUND one'), idle(), user('ROUND held'), started, failed, done, idle()]
  const ends: number[] = []
  let at = 0
  for (const l of lines) { at += Buffer.byteLength(l) + 1; ends.push(at) }
  fs.writeFileSync(path.join(streams, `${sid}.jsonl`), lines.map((l) => l + '\n').join(''))
  daemon.seedSession(sid, { pid, alive: true })
  return { watermark: ends[1]!, told: ends[4]! }
}

const lastAttach = (sid: string) => daemon.getAttachHistory().filter((a) => a.sid === sid).at(-1)?.fromOffset
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.each(PHASES)('attaching a session this host judges (its task copy at %s)', (phase) => {
  const id = (s: string) => `${s}-${phase.toLowerCase()}`
  it('a turn running at the restart is read on from the line the leader was told: its end is said once, its told part not again', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-mid-turn')
    const { watermark, told } = seedMidTurn(sid, 6111)
    setToldLines((s) => (s === sid ? { v: told } : undefined))
    const results = resultsOf(sid)
    const tools = eventsOf(sid, EventNames.SESSION_TOOL_USE)
    const session = await attach(sid, 6111, watermark, phase)
    expect(lastAttach(sid)).toBe(told)
    await vi.waitFor(() => expect(results).toEqual(['echo: ROUND two']), { timeout: 5_000 })
    await settle(300)
    expect(results).toEqual(['echo: ROUND two'])
    expect(tools, 'the tool call the leader already heard').toEqual([])
    session.detach()

    // The control: with no told line (a log from before it) the same stream is read from the judged turn end, tool call included.
    const sid2 = id('jr-mid-turn-untold')
    const m2 = seedMidTurn(sid2, 6115)
    const tools2 = eventsOf(sid2, EventNames.SESSION_TOOL_USE)
    const again = await attach(sid2, 6115, m2.watermark, phase)
    expect(lastAttach(sid2)).toBe(m2.watermark)
    await vi.waitFor(() => expect(tools2.length).toBe(1), { timeout: 5_000 })
    again.detach()
  })

  it('a result withheld for an agent at the restart is read again from below it: the turn ends once, with its own outcome', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-held')
    const { watermark, told } = seedHeld(sid, 6116)
    setToldLines((s) => (s === sid ? { v: told } : undefined))
    const outcomes: Array<{ result: string; isError: unknown }> = []
    bus.subscribe(`judged-replay-held-${sid}`, (e) => {
      const d = e.data as { sessionId?: string; result?: unknown; isError?: unknown }
      if (e.name === EventNames.SESSION_RESULT && d.sessionId === sid) outcomes.push({ result: String(d.result), isError: d.isError })
    }, { global: true })
    const session = await attach(sid, 6116, watermark, phase)
    expect(lastAttach(sid)).toBe(told)
    await vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(0), { timeout: 5_000 })
    await settle(300)
    expect(outcomes).toEqual([{ result: 'held: rate limit', isError: true }])
    session.detach()
  })

  it('the result\'s fact was told but the record\'s watermark was not written (a crash between): the turn is not said twice', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-crash-window')
    const { watermark, end } = seedMidTurn(sid, 6112)
    setToldLines((s) => (s === sid ? { v: end, end: true } : undefined))
    const results = resultsOf(sid)
    const session = await attach(sid, 6112, watermark, phase)
    expect(lastAttach(sid)).toBe(end)
    await settle(500)
    expect(results).toEqual([])
    session.detach()
  })

  it('the record\'s watermark was written but the result\'s fact was not: the turn is read again and said once', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-reverse-window')
    const { watermark, end } = seedMidTurn(sid, 6113)
    setToldLines((s) => (s === sid ? { v: watermark, end: true } : undefined))
    const results = resultsOf(sid)
    const session = await attach(sid, 6113, end, phase)
    expect(lastAttach(sid)).toBe(watermark)
    await vi.waitFor(() => expect(results).toEqual(['echo: ROUND two']), { timeout: 5_000 })
    session.detach()
  })

  it('a CLI the daemon resumed itself while the service was down (its row stopped, a stale pid) is attached with the runtime\'s pid, and its turn judged', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-resumed')
    const { watermark } = seedMidTurn(sid, 6114)
    const { task } = await addTask({ title: 'Resumed by the daemon' })
    await updateTaskRaw(task.id, { phase })
    await createSessionRecord(sid, task.id, 'proj', '/tmp', { pid: 1, outputFile: `remote://__local__/${sid}`, messageCount: 1 })
    await updateSessionRecord(sid, { judge: 'host', host: '__local__', process_status: 'stopped', consumedOffset: watermark } as Partial<SessionRecord>)
    expect(await getSessionByClaudeId(sid)).toMatchObject({ judge: 'host', host: '__local__', process_status: 'stopped' })
    const results = resultsOf(sid)
    const runner = new SessionRunner(MOCK_CLI)
    runner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
    const session = await runner.attachOwnLive(sid, 6114)
    expect(session, 'attached').toBeTruthy()
    expect(lastAttach(sid)).toBe(watermark)
    await vi.waitFor(() => expect(results).toEqual(['echo: ROUND two']), { timeout: 5_000 })
    session!.detach()
  })

  it('a turn that ended while no runner read it is replayed from the last judged turn end and judged once', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-own-gap')
    const { watermark } = seed(sid, 6101, true)
    const results = resultsOf(sid)
    const session = await attach(sid, 6101, watermark, phase)
    expect(lastAttach(sid), 'the attach reads from the judged position').toBe(watermark)
    await vi.waitFor(() => expect(results).toEqual(['echo: ROUND two']), { timeout: 5_000 })
    await settle(300)
    expect(results, 'the turn judged before the restart is a replay').toEqual(['echo: ROUND two'])
    expect((session as unknown as { _consumedOffset: number })._consumedOffset).toBeGreaterThan(watermark)
    session.detach()
  })

  it('no unjudged result past the watermark: the attach takes what comes next, as before', async () => {
    own.hostKey = '__local__'
    const sid = id('jr-own-quiet')
    const { watermark } = seed(sid, 6102, false)
    const results = resultsOf(sid)
    const session = await attach(sid, 6102, watermark, phase)
    expect(lastAttach(sid)).toBe(Number.MAX_SAFE_INTEGER)
    await settle(300)
    expect(results).toEqual([])
    session.detach()
  })

  it('a session this server does not judge as its host keeps the future-only attach (the switch off: today\'s behaviour)', async () => {
    own.hostKey = ''
    const sid = id('jr-leader')
    const { watermark } = seed(sid, 6103, true)
    const results = resultsOf(sid)
    const session = await attach(sid, 6103, watermark, phase)
    expect(lastAttach(sid)).toBe(Number.MAX_SAFE_INTEGER)
    await settle(300)
    expect(results).toEqual([])
    session.detach()
  })
})

/**
 * 2026-11-25: a result withheld for background work held the told line at its start while the turn's
 * tool calls went on; after a daemon update the attach read them all again from there and the leader
 * heard 119 tool calls twice. The attach takes the furthest line a fact was read from (saidLine): each
 * line below it is handled as said (host-judged-lines.ts readingLine), so the host emitter keeps none
 * of their detail, while the withheld result is still judged once, and a line past it is new.
 */
describe('an attach that reads again tool calls the leader already heard', () => {
  it('handles them as said, still ends the held turn once, and a line past the said line as new', async () => {
    own.hostKey = '__local__'
    const sid = 'jr-held-said'
    const started = JSON.stringify({ type: 'system', subtype: 'task_started', session_id: sid, task_id: 'agent-a', task_type: 'local_agent', description: 'agent-a' })
    const failed = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 10, num_turns: 1, result: 'held: rate limit', session_id: sid, total_cost_usd: 0.02 })
    const done = JSON.stringify({ type: 'system', subtype: 'task_notification', session_id: sid, task_id: 'agent-a', status: 'completed' })
    const lines = [user('ROUND one'), result(sid, 'echo: ROUND one'), idle(), user('ROUND held'), started, failed, toolUse('toolu_a'), toolUse('toolu_b'), toolUse('toolu_new'), done, idle()]
    const ends: number[] = []
    let at = 0
    for (const l of lines) { at += Buffer.byteLength(l) + 1; ends.push(at) }
    const file = path.join(streams, `${sid}.jsonl`)
    fs.writeFileSync(file, lines.map((l) => l + '\n').join(''))
    daemon.seedSession(sid, { pid: 6120, alive: true })
    const st = fs.statSync(file)
    const epoch = `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`
    // Told: held at the agent's start. Said: the line of toolu_b, the last fact the leader heard.
    setToldLines((s) => (s === sid ? { epoch, v: ends[4]! } : undefined))
    setSaidLines((s) => (s === sid ? { epoch, v: ends[7]! } : undefined))
    const seen: Array<[string, boolean | undefined]> = []
    const outcomes: string[] = []
    bus.subscribe(`judged-replay-said-${sid}`, (e) => {
      const d = e.data as { sessionId?: string; toolUseId?: string; result?: unknown }
      if (d.sessionId !== sid) return
      if (e.name === EventNames.SESSION_TOOL_USE) seen.push([String(d.toolUseId), lineBeingRead(sid)?.said])
      if (e.name === EventNames.SESSION_RESULT) outcomes.push(String(d.result))
    }, { global: true })
    const session = await attach(sid, 6120, ends[1]!, 'IN_PROGRESS')
    expect(lastAttach(sid)).toBe(ends[4])
    await vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(0), { timeout: 5_000 })
    await settle(300)
    // toolu_a's line is below the said line: said. toolu_b's is the said line itself (its facts go
    // again: never one lost). toolu_new's is past it: new.
    expect(seen).toEqual([['toolu_a', true], ['toolu_b', false], ['toolu_new', false]])
    expect(outcomes).toEqual(['held: rate limit'])
    session.detach()
  })
})
