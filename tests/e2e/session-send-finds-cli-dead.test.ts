/**
 * A send that finds its CLI dead is answered once, by the process the resume starts.
 *
 * The CLI of a session that answered its turn dies before Walnut hears of it (the
 * daemon notices on the next write: precheck, ENXIO). The daemon reaps it while the
 * send is on its way and reports the death ahead of the refusal; the session runner
 * then resumes the session with the same line. Judged at once, that death found the
 * turn the send had just opened and ended it with a stand-in: a session:result made
 * of the previous turn's text (exit 0, what the daemon reports for a CLI whose stream
 * ends in a completed turn) or a session:error (a failure code), before the resumed
 * process answered (2026-11-07). Every client that reads session:result as "the turn
 * ended with this answer" (the web UI, the phone, a task waiting for a reply, the
 * turn-end hooks) took the stand-in.
 *
 * What's real: server, WebSocket, event bus, session runner, RemoteSessionManager.
 * What's mocked: the daemon (MockDaemon, whose injected ENXIO reaps the session and
 * broadcasts the death before its refusal, as daemon-core does) and the CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { waitForWsEvent } from '../helpers/ws-event-wait.js'

let server: HttpServer
let port: number
let daemon: MockDaemon | undefined

interface WsFrame {
  type: string
  id?: string
  name?: string
  data?: Record<string, unknown>
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
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10_000)
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

type TurnEnd = { name: string; sessionId: unknown; text: string }

/** Every turn end the server broadcasts, in order (filter by session once it is known). */
function turnEnds(ws: WebSocket): TurnEnd[] {
  const ends: TurnEnd[] = []
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as WsFrame
    if (frame.type !== 'event' || (frame.name !== 'session:result' && frame.name !== 'session:error')) return
    ends.push({ name: frame.name, sessionId: frame.data?.sessionId, text: String(frame.data?.result ?? frame.data?.error ?? '') })
  })
  return ends
}

const CASES = [
  { label: 'a CLI whose stream ends in its answer (exit 0)', exitCode: 0, taskId: 'dead-cli-clean' },
  { label: 'a CLI that crashed (exit -1)', exitCode: -1, taskId: 'dead-cli-crash' },
] as const

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(tasksDir, 'tasks.json'), JSON.stringify({
    version: 1,
    tasks: CASES.map((c) => ({
      id: c.taskId, title: `A send that finds its CLI dead (${c.exitCode})`, status: 'todo', priority: 'none',
      category: 'Work', project: 'Walnut', session_ids: [], active_session_ids: [],
      created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [],
    })),
  }))
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  daemon = undefined
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a send that finds its CLI dead', () => {
  for (const c of CASES) {
    it(`ends its turn once, with the resumed process's answer: ${c.label}`, async () => {
      const ws = await connectWs()
      const all = turnEnds(ws)

      // A CLI that stays alive after its answer, as the real one does.
      const first = waitForWsEvent(ws, 'session:result', { taskId: c.taskId, resultIncludes: 'first answer' })
      await sendWsRpc(ws, 'session:start', { taskId: c.taskId, message: 'snapshot-clean-turn:first answer', project: 'Walnut' })
      const sessionId = ((await first).data as { sessionId: string }).sessionId
      expect(sessionId).toBeTruthy()
      const ends = () => all.filter((e) => e.sessionId === sessionId)
      await vi.waitFor(() => {
        expect(sessionRunner.findSessionByClaudeId(sessionId)?.processStatus).toBe('idle')
      }, { timeout: 10_000, interval: 20 })
      const startedBefore = ends().length
      expect(ends().map((e) => e.name)).toEqual(['session:result'])
      expect(ends()[0].text).toContain('first answer')

      const dying = (daemon as unknown as { sessions: Map<string, { exited?: Promise<void> }> }).sessions.get(sessionId)
      // The follow-up's own line finds the CLI dead (sendOnly: a control write in
      // between, a settings read-back or a status question, goes through).
      daemon!.injectSendFault(sessionId, 'ENXIO', { exitCode: c.exitCode, sendOnly: true })
      const answered = waitForWsEvent(ws, 'session:result', { sessionId, resultIncludes: 'follow-up answer' })
      const res = await sendWsRpc(ws, 'session:send', { sessionId, message: 'snapshot-clean-turn:follow-up answer' })
      expect((res as unknown as { ok?: boolean }).ok).toBe(true)
      await answered
      // The killed process is gone and its exit timer has run; frames in flight land.
      await dying?.exited
      await new Promise((r) => setTimeout(r, 300))

      const followUp = ends().slice(startedBefore)
      expect(followUp).toHaveLength(1)
      expect(followUp[0].name).toBe('session:result')
      expect(followUp[0].text).toContain('follow-up answer')

      ws.close()
    })
  }
})
