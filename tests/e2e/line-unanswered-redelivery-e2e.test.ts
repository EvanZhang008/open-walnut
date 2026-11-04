/**
 * E2E: a message the CLI read and never answered is sent again once, never
 * silently counted as delivered (line-answer-v1).
 *
 * 2026-11-04, release rehearsal binary-restart: a line went into the CLI at
 * 00:35:31.8, the CLI said `started` and was killed 0.1 s later, and the resumed
 * session's daemon answered "ran" for it. The server took that as delivered, the
 * task went to IN_PROGRESS, and the message never got an answer.
 *
 * Real: the server (WebSocket API, queue, SessionRunner, ClaudeCodeSession),
 * the MockDaemon (in-process, the same line-fate-core verdict the daemon twins
 * run), and mock-claude.mjs as the CLI. The mock kills itself with SIGKILL right
 * after it prints `started` for a line whose text holds `die-after-start:N`
 * (the first N takes of that text), or after one assistant message for
 * `answer-then-die:N`; its stdout is the stream file, so what it printed is on
 * disk before the kill, as with the real daemon.
 *
 *   1. killed after started, no answer: the message is answered once, by a
 *      resumed process, and leaves the queue
 *   2. killed after it answered: not sent again (no double delivery)
 *   3. killed after started both times: parked "Not answered" with a Retry,
 *      never a third take
 *
 * MACHINE SAFETY: WALNUT_HOME is a temp dir (createMockConstants), the CLI is a
 * node script under the MockDaemon, ssh is a stub that refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'
import { vi } from 'vitest'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-line-unanswered'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let originalPath: string | undefined
let dieFile = ''

interface WsMsg { type: string; name?: string; data?: Record<string, unknown>; id?: string | number }

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function rpc(ws: WebSocket, method: string, payload: unknown): Promise<WsMsg> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15000)
    const handler = (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsMsg
        if (msg.id === id) { clearTimeout(timer); ws.removeListener('message', handler); resolve(msg) }
      } catch { /* skip */ }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

/** Every session:result this socket sees, in order. */
function collectResults(ws: WebSocket): Array<{ sessionId?: string; isError?: boolean; result?: string }> {
  const out: Array<{ sessionId?: string; isError?: boolean; result?: string }> = []
  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsMsg
      if (msg.type === 'event' && msg.name === 'session:result') out.push(msg.data as never)
    } catch { /* skip */ }
  })
  return out
}

async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** How many processes the mock killed on a line holding these words (the line may carry Walnut's notices ahead of them). */
function takesOf(words: string): number {
  try {
    const counts = JSON.parse(readFileSync(dieFile, 'utf8')) as Record<string, number>
    return Object.entries(counts).filter(([text]) => text.includes(words)).reduce((n, [, c]) => n + c, 0)
  } catch { return 0 }
}

async function startSession(ws: WebSocket, results: ReturnType<typeof collectResults>, first: string): Promise<string> {
  await rpc(ws, 'session:start', { taskId: '', message: first, host: 'mock-remote', cwd: '/tmp' })
  const r = await until('the first answer', () => results.find((x) => (x.result ?? '').includes(first)))
  expect(r.isError).toBe(false)
  return r.sessionId as string
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'version: 1', 'user:', '  name: TestUser', 'defaults:', '  priority: none',
    '  category: Inbox', 'hosts:', '  mock-remote:', '    hostname: localhost', '    user: testuser',
  ].join('\n') + '\n')
  const sshBin = path.join(WALNUT_HOME, 'bin')
  await fs.mkdir(sshBin, { recursive: true })
  await fs.writeFile(path.join(sshBin, 'ssh'),
    '#!/bin/sh\necho "ssh: connect to host localhost port 22: Connection refused" >&2\nexit 255\n', { mode: 0o755 })
  originalPath = process.env.PATH
  process.env.PATH = `${sshBin}${path.delimiter}${process.env.PATH}`
  dieFile = path.join(WALNUT_HOME, 'die-counts.json')
  process.env.MOCK_CLAUDE_DIE_COUNT_FILE = dieFile

  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  await new Promise((r) => setTimeout(r, 2000))
}, 60_000)

afterAll(async () => {
  delete process.env.MOCK_CLAUDE_DIE_COUNT_FILE
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  if (originalPath !== undefined) process.env.PATH = originalPath
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a line the CLI read and never answered (line-answer-v1)', () => {
  it('killed right after started: answered once by a resumed process, and the queue is empty', async () => {
    const ws = await connect()
    const results = collectResults(ws)
    try {
      const sessionId = await startSession(ws, results, 'warm up one')
      const words = 'die-after-start:1 alpha'
      await rpc(ws, 'session:send', { sessionId, message: words })
      const answered = await until('the answer to the killed line', () => results.find((x) => x.sessionId === sessionId && !x.isError && (x.result ?? '').includes(words)))
      expect(answered.isError).toBe(false)
      // One death (the count is of kills): the resumed process took it and answered.
      expect(takesOf(words)).toBe(1)
      await until('the queue to empty', async () => (await getQueue(sessionId)).length === 0 || undefined)
      // Answered once: no third take, no second answer.
      await new Promise((r) => setTimeout(r, 2000))
      expect(results.filter((x) => x.sessionId === sessionId && (x.result ?? '').includes(words))).toHaveLength(1)
    } finally { ws.close() }
  }, 90_000)

  it('killed after it answered: not sent again (no double delivery)', async () => {
    const ws = await connect()
    const results = collectResults(ws)
    try {
      const sessionId = await startSession(ws, results, 'warm up two')
      const words = 'answer-then-die:1 beta'
      await rpc(ws, 'session:send', { sessionId, message: words })
      // The process died after its answer: the line leaves the queue, and no process takes it again.
      await until('the queue to empty', async () => (await getQueue(sessionId)).length === 0 || undefined)
      await new Promise((r) => setTimeout(r, 4000))
      expect(takesOf(words)).toBe(1)
      expect(results.filter((x) => x.sessionId === sessionId && !x.isError && (x.result ?? '').includes(words))).toHaveLength(0)
      // The session still answers the next message.
      await rpc(ws, 'session:send', { sessionId, message: 'after beta' })
      await until('the next answer', () => results.find((x) => x.sessionId === sessionId && (x.result ?? '').includes('after beta')))
      expect(takesOf(words)).toBe(1)
    } finally { ws.close() }
  }, 90_000)

  it('killed after started twice: parked as not answered, never a third take', async () => {
    const ws = await connect()
    const results = collectResults(ws)
    try {
      const sessionId = await startSession(ws, results, 'warm up three')
      const words = 'die-after-start:5 gamma'
      await rpc(ws, 'session:send', { sessionId, message: words })
      const parked = await until('the line to be parked', async () =>
        (await getQueue(sessionId)).find((m) => m.status === 'parked' && m.message.includes(words)))
      expect(parked.parkedReason).toMatch(/^Not answered: /)
      await new Promise((r) => setTimeout(r, 4000))
      // The first take and the one resend, nothing more.
      expect(takesOf(words)).toBe(2)
    } finally { ws.close() }
  }, 90_000)
})
