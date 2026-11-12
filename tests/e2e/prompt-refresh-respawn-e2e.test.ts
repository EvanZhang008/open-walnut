/**
 * After a compaction, a session whose stored prompt is far behind moves onto its current prompt
 * through the real server (mock daemon + mock CLI): once its turn ended and it stayed quiet, the
 * CLI is respawned with no turn on the current prompt, keeping its conversation
 * (src/core/sessions/prompt-refresh-respawn.ts). 2026-11-11, the org review: the Walnut VP was
 * restated about 33 KB of instructions after each compaction for weeks.
 *
 * Pinned: the respawn spawns with --resume and the current prompt; the record stores it and the
 * decision; the task's phase does not move; the next message carries no instruction notice; a
 * session already on its current prompt is left alone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-refresh-respawn-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { sendMessageToSession } from '../../src/core/session-message-queue.js'
import { TASK_CONTEXT_JOIN } from '../../src/core/sessions/prompt-refresh.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

async function task(id: string): Promise<any> {
  const r = await req('GET', `/api/tasks/${id}`)
  return r.json.task ?? r.json
}

const starts = (sid: string) => daemon.getCommandHistoryFor('start').filter((c) => c.payload.sid === sid)
const promptOf = (c: { payload: Record<string, unknown> }) => {
  const args = (c.payload.args ?? []) as string[]
  const i = args.indexOf('--append-system-prompt')
  return i >= 0 ? args[i + 1] : undefined
}
const sentTexts = (sid: string) => daemon.getCommandHistoryFor('send')
  .filter((c) => c.payload.sid === sid)
  .map((c) => String(c.payload.text ?? c.payload.message ?? ''))

async function startSession(): Promise<{ sid: string; taskId: string; current: string }> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message: 'big-context-turn:60000:1h' })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const w = { sid: started.json.sessionId as string, taskId: started.json.taskId as string }
  await until('first hand-back', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
  const rec = await until('prompt stored', () => getSessionByClaudeId(w.sid), (r) => !!r?.appliedAppendSystemPrompt && !!r.promptCache?.expiresAt)
  return { ...w, current: rec!.appliedAppendSystemPrompt! }
}

/** The stored prompt as a session spawned weeks ago has it: the Walnut part cut to its first lines. */
function aged(current: string): string {
  const join = current.indexOf(TASK_CONTEXT_JOIN)
  const head = join >= 0 ? current.slice(0, join + TASK_CONTEXT_JOIN.length) : ''
  const walnut = join >= 0 ? current.slice(join + TASK_CONTEXT_JOIN.length) : current
  return head + walnut.split('\n').slice(0, 3).join('\n')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  process.env.WALNUT_PROMPT_REFRESH_QUIET_MS = '4000'
  process.env.MOCK_COMPACT_MS = '500'
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  delete process.env.WALNUT_PROMPT_REFRESH_QUIET_MS
  delete process.env.MOCK_COMPACT_MS
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a session whose stored prompt is far behind', () => {
  it('is respawned on its current prompt once quiet after its compaction, and is told nothing on its next message', async () => {
    const w = await startSession()
    const old = aged(w.current)
    expect(Buffer.byteLength(w.current) - Buffer.byteLength(old)).toBeGreaterThan(8_192)
    await updateSessionRecord(w.sid, { appliedAppendSystemPrompt: old })
    const startsBefore = starts(w.sid).length
    const before = await task(w.taskId)

    await sendMessageToSession(w.sid, '/compact', { source: 'ui', taskId: w.taskId })
    const rec = await until('respawned', () => getSessionByClaudeId(w.sid), (r) => r?.promptRefresh?.outcome === 'respawned' && starts(w.sid).length > startsBefore, 30_000)
    expect(rec!.promptRefresh).toMatchObject({ compactUuid: rec!.lastCompactUuid, rewriteTokens: 0 })
    // The current prompt as of the respawn (the task's title may have been refined meanwhile):
    // the whole Walnut part is back, not the aged head.
    expect(Buffer.byteLength(rec!.appliedAppendSystemPrompt!)).toBeGreaterThan(Buffer.byteLength(old) + 8_192)

    // The respawn resumed the conversation on the current prompt, and ran no turn.
    const respawn = starts(w.sid).at(-1)!
    expect((respawn.payload.args as string[])).toContain('--resume')
    expect(promptOf(respawn)).toBe(rec!.appliedAppendSystemPrompt)
    await until('idle again', () => getSessionByClaudeId(w.sid), (r) => r?.process_status === 'idle')
    expect((await task(w.taskId)).phase).toBe(before.phase)

    // The next message rides the new process with no restatement of the instructions.
    const sendsBefore = sentTexts(w.sid).length
    await sendMessageToSession(w.sid, 'big-context-turn:30000:1h', { source: 'ui', taskId: w.taskId })
    const texts = await until('next line sent', async () => sentTexts(w.sid), (t) => t.length > sendsBefore)
    expect(texts.at(-1)).not.toContain('Walnut changed your default instructions')
  }, 120_000)

  it('gives way when the host says the CLI is not quiet (a line its own same-host delivery wrote): the prompt stays, nothing is decided', async () => {
    const w = await startSession()
    await updateSessionRecord(w.sid, { appliedAppendSystemPrompt: aged(w.current) })
    const startsBefore = starts(w.sid).length
    daemon.notQuiet = true
    try {
      await sendMessageToSession(w.sid, '/compact', { source: 'ui', taskId: w.taskId })
      await until('compacted', () => getSessionByClaudeId(w.sid), (r) => !!r?.lastCompactUuid)
      // Past the quiet time and its own reads: the respawn was tried and gave way.
      await new Promise((r) => setTimeout(r, 9_000))
      const rec = await getSessionByClaudeId(w.sid)
      expect(rec!.promptRefresh).toBeUndefined()
      expect(rec!.appliedAppendSystemPrompt).toBe(aged(w.current))
      expect(starts(w.sid).length).toBe(startsBefore)
      expect(rec!.process_status).toBe('idle')
    } finally { daemon.notQuiet = false }
  }, 120_000)

  it('a session already on its current prompt is left alone after its compaction', async () => {
    const w = await startSession()
    const startsBefore = starts(w.sid).length
    await sendMessageToSession(w.sid, '/compact', { source: 'ui', taskId: w.taskId })
    const rec = await until('decided', () => getSessionByClaudeId(w.sid), (r) => !!r?.promptRefresh, 30_000)
    expect(rec!.promptRefresh!.outcome).toBe('current')
    expect(starts(w.sid).length).toBe(startsBefore)
  }, 120_000)
})
