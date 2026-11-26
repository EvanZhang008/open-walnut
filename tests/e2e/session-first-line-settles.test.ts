/**
 * A session kept busy from its very first line answers what is queued behind it.
 *
 * 2026-11-25 (threads-pop-up.spec test 8, a fresh session kept busy so the reply on its card
 * waits): the reply queued behind a new session's first long turn was never sent. Two gaps of the
 * mock pair, not of Walnut: the mock daemon passed the start's message as an argument, where the
 * real daemons write it down the FIFO as the first line, and the mock CLI took the first line it
 * read at startup without naming it (`command_lifecycle` queued, started), where Claude Code names
 * every line it takes. So a send that came right after the start ran as the first turn, the
 * start's message never ran, and that line's queue row stayed for good, holding the reply.
 *
 * The order the real daemon keeps (the start's line before any send) is pinned on the real
 * daemon in tests/providers/daemon-start-line-first-e2e.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-first-line-settles'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionsForTask } from '../../src/core/session-tracker.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

interface WsFrame {
  type: string
  name?: string
  data?: Record<string, unknown>
  id?: string
  ok?: boolean
  payload?: unknown
  error?: unknown
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 15000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame
      if (frame.type === 'res' && frame.id === id) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
  })
}

function delay(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

async function waitUntil(pred: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await delay(25)
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for ${label}`)
}

const savedDisableSearch = process.env.WALNUT_DISABLE_SEARCH
const savedQueueMidturn = process.env.MOCK_CLAUDE_QUEUE_MIDTURN
const TASKS = ['001', '002']

beforeAll(async () => {
  process.env.WALNUT_DISABLE_SEARCH = '1'
  // Sends in quick succession: a line that lands while a clean turn thinks is queued, as Claude Code queues it.
  process.env.MOCK_CLAUDE_QUEUE_MIDTURN = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: TASKS.map((n) => ({
      id: `first-line-${n}`, title: `First line settles ${n}`,
      status: 'todo', priority: 'none', category: 'Test', project: 'Walnut', session_ids: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      description: '', summary: '', note: '', subtasks: [], phase: 'TODO', source: 'ms-todo',
    })),
  }))
  server = await startServer({ port: 0, dev: true })
  port = (server.address() as { port: number }).port
  await delay(1000)
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  if (savedDisableSearch === undefined) delete process.env.WALNUT_DISABLE_SEARCH
  else process.env.WALNUT_DISABLE_SEARCH = savedDisableSearch
  if (savedQueueMidturn === undefined) delete process.env.MOCK_CLAUDE_QUEUE_MIDTURN
  else process.env.MOCK_CLAUDE_QUEUE_MIDTURN = savedQueueMidturn
}, 20000)

async function sessionOf(taskId: string): Promise<string> {
  let sid = ''
  await waitUntil(async () => {
    sid = (await getSessionsForTask(taskId))[0]?.claudeSessionId ?? ''
    return !!sid
  }, 15000, 'session record')
  return sid
}

/** What the session's queue still holds (GET /api/v1/sessions/:id/queue). */
async function queueRows(sid: string): Promise<unknown[]> {
  const res = await fetch(`http://localhost:${port}/api/v1/sessions/${sid}/queue`)
  return ((await res.json()) as { messages?: unknown[] }).messages ?? []
}

/** The texts the CLI answered, in order, from the session's stream file. */
function answered(sid: string): string[] {
  let text = ''
  try { text = fsSync.readFileSync(daemon.streamFilePath(sid), 'utf8') } catch { return [] }
  return text.split('\n').filter(Boolean).flatMap((l) => {
    try { const e = JSON.parse(l) as { type?: string; result?: unknown }; return e.type === 'result' && typeof e.result === 'string' ? [e.result] : [] } catch { return [] }
  })
}

// Each way a session's first line reaches its CLI: the start's own message, written down the
// FIFO by the daemon, and a send that comes right after the start, which the CLI reads at its
// first stdin read. A long turn on either keeps the session busy; the reply sent behind it must
// leave the queue and be answered once the long turn ends.
const CASES = [
  { n: '001', why: 'the start\'s own message is the long turn', start: 'snapshot-long-turn:3000', first: null },
  { n: '002', why: 'a send right after the start is the long turn', start: 'snapshot-clean-turn:Started 002', first: 'snapshot-long-turn:3000' },
] as const

describe('a session kept busy from its first line', () => {
  for (const c of CASES) {
    it(`answers the reply queued behind it, and its queue empties (${c.why})`, async () => {
      const ws = await connectWs()
      let sid = ''
      try {
        const taskId = `first-line-${c.n}`
        expect((await sendWsRpc(ws, 'session:start', { taskId, message: c.start, project: 'Walnut', mode: 'bypass', model: 'opus' })).ok).toBe(true)
        sid = await sessionOf(taskId)
        if (c.first) expect((await sendWsRpc(ws, 'session:send', { sessionId: sid, message: c.first })).ok).toBe(true)
        await waitUntil(() => cliTurnRunning(sid), 15000, 'long turn running')
        expect((await sendWsRpc(ws, 'session:send', { sessionId: sid, message: `snapshot-clean-turn:after the hold ${c.n}` })).ok).toBe(true)
        await waitUntil(() => answered(sid).includes(`after the hold ${c.n}`), 30000, 'the reply answered')
        await waitUntil(async () => (await queueRows(sid)).length === 0, 15000, 'the queue empty')
        // The start's own message ran first, whichever line came next.
        if (c.first) expect(answered(sid)[0]).toBe(`Started ${c.n}`)
      } catch (error) {
        // What the CLI printed, to read a failure by.
        let stream = ''
        try { stream = fsSync.readFileSync(daemon.streamFilePath(sid), 'utf8').split('\n').map((l) => l.slice(0, 240)).join('\n') } catch { /* none yet */ }
        throw new Error(`${(error as Error).message}\nstream of ${sid}:\n${stream}`)
      } finally {
        ws.close()
      }
    }, 60000)
  }
})

/** The CLI announced a long turn in its stream. */
function cliTurnRunning(sid: string): boolean {
  try { return fsSync.readFileSync(daemon.streamFilePath(sid), 'utf8').includes('"state":"running"') }
  catch { return false }
}
