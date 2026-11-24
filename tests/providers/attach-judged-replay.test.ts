/**
 * An attach of a session this host judges itself reads what its CLI wrote while no runner read it
 * from the last turn end it judged (attach-evidence.ts judgedReplayFloor), through attachToExisting
 * against a mock daemon: the turn that ended in the gap is judged once, the turn judged before it is
 * a replay. A session the leader judges keeps today's future-only attach.
 *
 * 2026-11-23: after a restart of a host's service, a same-host send's turn ended before the host's
 * runner attached again; the future-only attach skipped it and nobody judged it.
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

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
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
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

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

async function attach(sid: string, pid: number, watermark: number): Promise<ClaudeCodeSession> {
  const { task } = await addTask({ title: `Judged replay ${sid}` })
  // The first turn was handled: the task waits on the person (the phase proxy would say "handled").
  await updateTaskRaw(task.id, { phase: 'NEED_ACTION' })
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

const lastAttach = (sid: string) => daemon.getAttachHistory().filter((a) => a.sid === sid).at(-1)?.fromOffset
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('attaching a session this host judges', () => {
  it('a turn that ended while no runner read it is replayed from the last judged turn end and judged once', async () => {
    own.hostKey = '__local__'
    const sid = 'jr-own-gap'
    const { watermark } = seed(sid, 6101, true)
    const results = resultsOf(sid)
    const session = await attach(sid, 6101, watermark)
    expect(lastAttach(sid), 'the attach reads from the judged position').toBe(watermark)
    await vi.waitFor(() => expect(results).toEqual(['echo: ROUND two']), { timeout: 5_000 })
    await settle(300)
    expect(results, 'the turn judged before the restart is a replay').toEqual(['echo: ROUND two'])
    expect((session as unknown as { _consumedOffset: number })._consumedOffset).toBeGreaterThan(watermark)
    session.detach()
  })

  it('no unjudged result past the watermark: the attach takes what comes next, as before', async () => {
    own.hostKey = '__local__'
    const sid = 'jr-own-quiet'
    const { watermark } = seed(sid, 6102, false)
    const results = resultsOf(sid)
    const session = await attach(sid, 6102, watermark)
    expect(lastAttach(sid)).toBe(Number.MAX_SAFE_INTEGER)
    await settle(300)
    expect(results).toEqual([])
    session.detach()
  })

  it('a session this server does not judge as its host keeps the future-only attach (the switch off: today\'s behaviour)', async () => {
    own.hostKey = ''
    const sid = 'jr-leader'
    const { watermark } = seed(sid, 6103, true)
    const results = resultsOf(sid)
    const session = await attach(sid, 6103, watermark)
    expect(lastAttach(sid)).toBe(Number.MAX_SAFE_INTEGER)
    await settle(300)
    expect(results).toEqual([])
    session.detach()
  })
})
