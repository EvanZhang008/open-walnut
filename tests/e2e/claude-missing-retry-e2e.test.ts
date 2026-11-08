/**
 * E2E: a task started before Claude Code is installed keeps its first message,
 * and once Claude Code is installed, Retry runs that turn in the same session,
 * with the task still linked to it.
 *
 * Review round 2, should-fix 8: the start refusal parks the first line under the
 * launch bubble's id (claude-code-session.ts parkUnstartedFirstLine). Its
 * SESSION_ERROR used to carry no errorKind 'delivery_failed', so the runner's
 * turn-end handler wrote the record `error` and cleared the task's session slot,
 * as if a turn had ended in an error. Nothing ran: the message waits, and Retry
 * must find the session where it left it.
 *
 * Then (review round 2, D08 again): after the install nobody pressed Retry, and
 * nothing sent the message that "waits here"; a message typed then was refused,
 * because its delivery took --resume of a conversation that was never written
 * (the Demo's session gate refuses that). Now the parked line goes out by itself
 * once this computer's Claude Code reads ready (core/sessions/agent-wait-resend.ts),
 * the start that carries it is fresh under the same id (--session-id), and a line
 * typed after the install, before any readiness check, takes the parked one with it.
 *
 * Real: the server (WebSocket API, queue, SessionRunner, ClaudeCodeSession), the
 * MockDaemon (in-process), mock-claude.mjs as the CLI. "Claude Code missing" is
 * the daemon's spawn-gate refusal (errorKind claude_missing), then cleared, as an
 * install clears it.
 *
 * MACHINE SAFETY: WALNUT_HOME is a temp dir (createMockConstants), the CLI is a
 * node script under the MockDaemon, no ssh host is configured.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { WebSocket } from 'ws'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-claude-missing-retry'))

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { getQueue } from '../../src/core/session-message-queue.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { launchPromptId } from '../../src/core/sessions/launch-prompts.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { refreshLocalClaude, setLocalClaudeIo } from '../../src/core/hosts/local-readiness.js'
import type { HostPreflightResult } from '../../src/providers/host-runtime-core.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const NOT_INSTALLED = 'Claude Code is not installed on this host.'

let server: HttpServer
let port: number
let daemon: MockDaemon

interface WsMsg { type: string; name?: string; data?: Record<string, unknown>; id?: string | number; error?: string }

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

/** Every event of these names this socket sees, in order. */
function collect(ws: WebSocket, names: string[]): Array<{ name: string; data: Record<string, unknown> }> {
  const out: Array<{ name: string; data: Record<string, unknown> }> = []
  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString()) as WsMsg
      if (msg.type === 'event' && msg.name && names.includes(msg.name)) out.push({ name: msg.name, data: msg.data ?? {} })
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

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fs.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }))
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), [
    'version: 1', 'user:', '  name: TestUser', 'defaults:', '  priority: none', '  category: Inbox',
  ].join('\n') + '\n')
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

/** This computer's Claude Code as the readiness check reads it (the install's own re-check does the same). */
function machineReads(found: boolean): Promise<unknown> {
  const result: HostPreflightResult = {
    claude: found ? { found: true, path: '/opt/claude/bin/claude', version: '9.9.9', kind: 'native', auth: 'ok', versionOk: true } : { found: false },
    compiler: { found: true }, dtach: { found: true },
  }
  setLocalClaudeIo({ floor: async () => null, preflight: async () => ({ result, source: 'in-process' }) })
  return refreshLocalClaude()
}

/** The starts the daemon got for `sid`: the fresh one carries --session-id, never --resume. */
function startsOf(sid: string) {
  return daemon.getStartHistory().filter((s) => s.sid === sid)
}

afterAll(async () => {
  setLocalClaudeIo()
  daemon?.injectStartFault(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('Claude Code missing, then installed: Retry runs the first message', () => {
  it('parks the first line with the task still on its session, and Retry runs the turn there', async () => {
    const ws = await connect()
    const events = collect(ws, ['session:error', 'session:batch-failed', 'session:result'])
    try {
      const taskId = (await addTask({ title: 'First task before installing', project: 'Test' })).task.id
      daemon.injectStartFault(NOT_INSTALLED, { errorKind: 'claude_missing', reason: 'claude_missing' })
      const words = 'hello before installing Claude Code'
      await rpc(ws, 'session:start', { taskId, message: words, cwd: WALNUT_HOME })

      // The refusal: the first line waits under the launch id, parked with what to do.
      const failed = await until('the batch-failed for the first line', () => events.find((e) => e.name === 'session:batch-failed'))
      const sessionId = String(failed.data.sessionId)
      const rowId = launchPromptId(sessionId)
      expect(failed.data.messageIds).toEqual([rowId])
      const parked = await until('the parked first line', async () => (await getQueue(sessionId)).find((m) => m.id === rowId && m.status === 'parked'))
      expect(parked.message).toContain(words)
      expect(parked.parkedReason).toMatch(/Install Claude Code and this message goes out by itself/)
      expect(parked.waitsFor).toBe('claude_missing')
      // The record says no CLI ran: the next start of this id is fresh.
      expect((await until('the refused-start mark', async () => (await getSessionByClaudeId(sessionId))?.startRefused)).kind).toBe('claude_missing')

      // Nothing ran, so nothing is a turn's outcome: the task keeps its session.
      const err = await until('the start error', () => events.find((e) => e.name === 'session:error' && e.data.sessionId === sessionId))
      expect(err.data.errorKind).toBe('delivery_failed')
      await new Promise((r) => setTimeout(r, 1500))
      expect((await getTask(taskId)).session_id).toBe(sessionId)
      const before = await getSessionByClaudeId(sessionId)
      expect(before?.taskId).toBe(taskId)
      expect(before?.process_status).not.toBe('error')

      // Installed: Retry on the bubble (the web's retryFailed sends session:send with retryOf).
      daemon.injectStartFault(null)
      const retry = await rpc(ws, 'session:send', { sessionId, message: words, retryOf: rowId })
      expect(retry.error).toBeUndefined()
      const answer = await until('the answer to the first line', () => events.find((e) =>
        e.name === 'session:result' && e.data.sessionId === sessionId && String(e.data.result ?? '').includes(words)))
      expect(answer.data.isError).toBe(false)

      // The turn ran in the same session, the task linked to it, the line out of the queue.
      expect((await getTask(taskId)).session_id).toBe(sessionId)
      await until('the queue to empty', async () => (await getQueue(sessionId)).length === 0 || undefined)
      const after = await until('the record to settle', async () => {
        const r = await getSessionByClaudeId(sessionId)
        return r && r.process_status !== 'error' && r.process_status !== 'running' ? r : undefined
      })
      expect(after.taskId).toBe(taskId)
    } finally { ws.close() }
  }, 120_000)

  it('sends the parked first line by itself once Claude Code reads ready, as a fresh start, and answers the next message', async () => {
    const ws = await connect()
    const events = collect(ws, ['session:batch-failed', 'session:result', 'session:messages-delivered'])
    try {
      await machineReads(false)
      const taskId = (await addTask({ title: 'Install while it waits', project: 'Test' })).task.id
      daemon.injectStartFault(NOT_INSTALLED, { errorKind: 'claude_missing', reason: 'claude_missing' })
      const words = 'plan my week before Claude Code is here'
      await rpc(ws, 'session:start', { taskId, message: words, cwd: WALNUT_HOME })
      const failed = await until('the batch-failed for the first line', () => events.find((e) => e.name === 'session:batch-failed'))
      const sessionId = String(failed.data.sessionId)
      // The panel learns the row is parked and what it waits on (the Install in place).
      expect(failed.data).toMatchObject({ parked: true, waitsFor: 'claude_missing' })
      const rowId = launchPromptId(sessionId)
      await until('the parked first line', async () => (await getQueue(sessionId)).find((m) => m.id === rowId && m.status === 'parked'))

      // Installed and signed in: the check reads ready. Nobody presses Retry.
      daemon.injectStartFault(null)
      await machineReads(true)
      const answer = await until('the answer to the first line, with no Retry', () => events.find((e) =>
        e.name === 'session:result' && e.data.sessionId === sessionId && String(e.data.result ?? '').includes(words)))
      expect(answer.data.isError).toBe(false)
      // Once: one answer, one fresh start under the same id, never a --resume of a conversation never written.
      await new Promise((r) => setTimeout(r, 1500))
      expect(events.filter((e) => e.name === 'session:result' && e.data.sessionId === sessionId && String(e.data.result ?? '').includes(words))).toHaveLength(1)
      const starts = startsOf(sessionId)
      expect(starts.length).toBe(2)
      const second = starts[1]
      expect(second.resume).toBe(false)
      expect(second.args).not.toContain('--resume')
      expect(second.args[second.args.indexOf('--session-id') + 1]).toBe(sessionId)
      expect((await getTask(taskId)).session_id).toBe(sessionId)
      await until('the refused-start mark to clear', async () => !(await getSessionByClaudeId(sessionId))?.startRefused || undefined)

      // A message typed now is answered in the same session.
      const next = 'are you there now'
      const sent = await rpc(ws, 'session:send', { sessionId, message: next })
      expect(sent.error).toBeUndefined()
      const reply = await until('the answer to the next message', () => events.find((e) =>
        e.name === 'session:result' && e.data.sessionId === sessionId && String(e.data.result ?? '').includes(next)))
      expect(reply.data.isError).toBe(false)
      // Any later start of this id resumes the conversation that ran (the mark is gone), never a fresh one again.
      expect(startsOf(sessionId).slice(2).every((s) => !s.args.includes('--session-id'))).toBe(true)
    } finally { ws.close() }
  }, 120_000)

  it('a message typed after the install, before any readiness check, takes the parked first line with it', async () => {
    const ws = await connect()
    const events = collect(ws, ['session:batch-failed', 'session:result'])
    try {
      const taskId = (await addTask({ title: 'Type again after installing', project: 'Test' })).task.id
      daemon.injectStartFault(NOT_INSTALLED, { errorKind: 'claude_missing', reason: 'claude_missing' })
      const first = 'first words before the install'
      await rpc(ws, 'session:start', { taskId, message: first, cwd: WALNUT_HOME })
      const failed = await until('the batch-failed for the first line', () => events.find((e) => e.name === 'session:batch-failed'))
      const sessionId = String(failed.data.sessionId)
      await until('the parked first line', async () => (await getQueue(sessionId)).find((m) => m.id === launchPromptId(sessionId) && m.status === 'parked'))

      // Installed; no readiness answer has changed (this computer already read ready above).
      daemon.injectStartFault(null)
      const second = 'second words after the install'
      const sent = await rpc(ws, 'session:send', { sessionId, message: second })
      expect(sent.error).toBeUndefined()
      for (const words of [first, second]) {
        const got = await until(`the answer to "${words}"`, () => events.find((e) =>
          e.name === 'session:result' && e.data.sessionId === sessionId && String(e.data.result ?? '').includes(words)))
        expect(got.data.isError).toBe(false)
      }
      const fresh = startsOf(sessionId)[1]
      expect(fresh.resume).toBe(false)
      expect(fresh.args).not.toContain('--resume')
      expect(fresh.args).toContain('--session-id')
      await until('the queue to empty', async () => (await getQueue(sessionId)).length === 0 || undefined)
    } finally { ws.close() }
  }, 120_000)
})
