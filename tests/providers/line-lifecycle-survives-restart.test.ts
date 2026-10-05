/**
 * B2: that a CLI reports its command queue survives a server restart.
 *
 * Attach after a restart subscribes to new stream events only, so a session
 * object rebuilt for a live CLI has seen no `command_lifecycle` frame. It used
 * to treat that CLI as one that never reports, so a line written to it (or one
 * the daemon said still waited in it) left the queue on the write, and a crash
 * before the CLI started it lost the message without a word.
 *
 *   1. the first lifecycle frame of a process records its pid on the session
 *   2. attachToExisting reads it back while the record's pid is that process
 *   3. a record whose pid moved on (a fresh process) knows nothing yet
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js'

vi.mock('../../src/constants.js', () => createMockConstants())
// attachToExisting reads stream evidence through the daemon file reader; the
// mock keeps that host-local and stops the test from spawning a real daemon.
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus } from '../../src/core/event-bus.js'
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js'
import { createSessionRecord, updateSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import type { SessionRecord } from '../../src/core/types.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')
let daemon: MockDaemon

interface Internals {
  _transport: unknown
  _active: boolean
  _processStatus: string
  handleStreamLine(line: string, v?: number): void
  detach(): void
}

async function makeRecord(sid: string, pid: number, extra: Partial<SessionRecord> = {}): Promise<SessionRecord> {
  await createSessionRecord(sid, `task-${sid}`, 'proj', '/tmp', { pid, outputFile: '/tmp/nonexistent.jsonl', messageCount: 1 })
  return Object.keys(extra).length ? updateSessionRecord(sid, extra) : (await getSessionByClaudeId(sid))!
}

async function attach(record: SessionRecord): Promise<ClaudeCodeSession & Internals> {
  const session = await ClaudeCodeSession.attachToExisting(record, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`) as ClaudeCodeSession & Internals
  session._transport = {
    isRemote: false, hasPipe: true, processName: 'claude', pid: record.pid ?? null,
    outputFile: record.outputFile ?? null, host: null, fileSize: 0,
    imageCache: new Map(), lastEventAt: 0, tailOffset: 0,
    stopTail() {}, startTail() {}, detach() {},
  }
  session._active = true
  session._processStatus = 'running'
  return session
}

const frame = (uuid: string, state: string) => JSON.stringify({ type: 'command_lifecycle', command_uuid: uuid, state })

beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon.stop().catch(() => {}) })

beforeEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true })
})

afterEach(async () => {
  bus.clear()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

describe('a CLI that reports its queue is still known as one after a restart', () => {
  it('the first lifecycle frame records the pid that printed it', async () => {
    const sid = 'lc-persist'
    const session = await attach(await makeRecord(sid, 4242))
    expect(session.reportsLineLifecycle).toBe(false)
    session.handleStreamLine(frame('11111111-1111-4111-8111-111111111111', 'queued'), 100)
    expect(session.reportsLineLifecycle).toBe(true)
    await vi.waitFor(async () => {
      expect((await getSessionByClaudeId(sid))?.lineLifecyclePid).toBe(4242)
    }, { timeout: 2000, interval: 25 })
    session.detach()
  })

  it('a server that re-attaches to that same process knows it before any new frame', async () => {
    const session = await attach(await makeRecord('lc-same', 4242, { lineLifecyclePid: 4242 }))
    expect(session.reportsLineLifecycle).toBe(true)
    session.detach()
  })

  it('a fresh process (the pid moved on) has to say so itself', async () => {
    const session = await attach(await makeRecord('lc-new', 5151, { lineLifecyclePid: 4242 }))
    expect(session.reportsLineLifecycle).toBe(false)
    session.handleStreamLine(frame('22222222-2222-4222-8222-222222222222', 'started'), 200)
    expect(session.reportsLineLifecycle).toBe(true)
    await vi.waitFor(async () => {
      expect((await getSessionByClaudeId('lc-new'))?.lineLifecyclePid).toBe(5151)
    }, { timeout: 2000, interval: 25 })
    session.detach()
  })
})
