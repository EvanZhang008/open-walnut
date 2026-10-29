/**
 * A parked task woken by its wait_until clock: the conversation the user reads
 * holds the wake note and the session's answer, and none of the context the model
 * received around them (2026-10-29: a woken worker's view showed its whole
 * MEMORY.md, CLAUDE.md and old hint text as rows, from the `api-request-blob`
 * lines Claude Code 2.1.284+ writes into its transcript).
 *
 * Real server, real wait_until sweep, real delivery through the mock daemon; the
 * mock CLI files each turn in the session's transcript with those blob lines
 * (MOCK_CLAUDE_REQUEST_BLOBS), and the test reads history through the routes the
 * web app and the phone read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-wait-wake-view-e2e'))

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getOp } from '../../src/ops/index.js'
import { sweepWaitUntil } from '../../src/core/task-wait-until.js'
import { encodeProjectPath, invalidateSessionHistoryCaches } from '../../src/core/session-history.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const ENV_KEYS = ['WALNUT_HOME_OVERRIDE', 'MOCK_CLAUDE_PERSIST_DIR', 'MOCK_CLAUDE_PERSIST_SESSIONS', 'MOCK_CLAUDE_REQUEST_BLOBS'] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

/** Text that is context the model received, never something the user should read as the conversation. */
const INJECTED = [
  '<system-reminder', 'Instruction files were re-read', 'MOCK_MEMORY_LESSON', 'MEMORY.md',
  'Walnut (rich-output)', 'Walnut (reply-language)', 'Rich output mode', 'You are an interactive agent.',
]

let server: HttpServer
let port: number
let daemon: MockDaemon
let cwd = ''
let sid = ''
let taskId = ''

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function task(id: string): Promise<any> {
  const r = await req('GET', `/api/tasks/${id}`)
  return r.json.task ?? r.json
}

async function until<T>(what: string, probe: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await probe()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    v = await probe()
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v)?.slice(0, 400)}`)
  return v
}

function opCall(callerSid: string) {
  return async (method: string, p: string, body?: unknown) => {
    const r = await req(method, `/api/v1${p}`, body, { 'x-walnut-caller-sid': callerSid })
    if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`)
    return r.json
  }
}

function transcriptFile(): string {
  return path.join(CLAUDE_HOME, 'projects', encodeProjectPath(cwd), `${sid}.jsonl`)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  // The local daemon resolves ~/.claude to the mocked CLAUDE_HOME.
  process.env.WALNUT_HOME_OVERRIDE = path.dirname(CLAUDE_HOME)
  cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wait-wake-view-')))
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0

  const started = await req('POST', '/api/sessions/quick-start', { cwd, message: 'ship it once CR 1234 is approved' })
  expect(started.status).toBe(200)
  sid = started.json.sessionId
  taskId = started.json.taskId
  await until('first hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')

  // From here every turn of this session is filed in its transcript the way
  // Claude Code 2.1.284+ files it, request blobs included.
  const first = new Date().toISOString()
  await fs.mkdir(path.dirname(transcriptFile()), { recursive: true })
  await fs.writeFile(transcriptFile(), [
    { type: 'user', uuid: 'seed-u', parentUuid: null, sessionId: sid, cwd, timestamp: first, isSidechain: false, message: { role: 'user', content: 'ship it once CR 1234 is approved' } },
    { type: 'assistant', uuid: 'seed-a', parentUuid: 'seed-u', sessionId: sid, cwd, timestamp: first, isSidechain: false, message: { id: 'msg_seed', role: 'assistant', content: [{ type: 'text', text: 'Waiting on the review.' }] } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  process.env.MOCK_CLAUDE_PERSIST_DIR = path.join(CLAUDE_HOME, 'projects')
  process.env.MOCK_CLAUDE_PERSIST_SESSIONS = sid
  process.env.MOCK_CLAUDE_REQUEST_BLOBS = '1'
}, 120_000)

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
})

describe('a task woken by its wait_until clock', () => {
  it('shows the wake note and the answer, and none of the injected context', async () => {
    await getOp('task_update')!.handler!({ id: taskId, phase: 'WAITING', wait_until: new Date(Date.now() + 3_600_000).toISOString() }, opCall(sid))
    expect((await task(taskId)).phase).toBe('WAITING')

    const linesBefore = (await fs.readFile(transcriptFile(), 'utf8')).trim().split('\n').length
    const sweptAt = Date.now()
    expect(await sweepWaitUntil(sweptAt + 2 * 3_600_000)).toContain(taskId)
    await until('the wake turn filed', async () => (await fs.readFile(transcriptFile(), 'utf8')).trim().split('\n').length,
      (n) => n >= linesBefore + 5)
    await until('the hand-back', () => task(taskId), (t) => t.phase === 'NEED_ACTION')

    // Fixture fidelity: the transcript really holds the blobs, with the injected context in them.
    const raw = await fs.readFile(transcriptFile(), 'utf8')
    expect(raw).toContain('"type":"api-request-blob"')
    expect(raw).toContain('MOCK_MEMORY_LESSON')
    expect(raw).toContain('The wait on this task ran until')

    await invalidateSessionHistoryCaches(sid)
    for (const route of [`/api/sessions/${sid}/history`, `/api/v1/sessions/${sid}/history`]) {
      const r = await req('GET', route)
      expect(r.status, route).toBe(200)
      const rows: Array<{ role: string; text?: string; timestamp?: string }> = r.json.messages
      const wake = rows.filter((m) => m.role === 'user' && (m.text ?? '').includes('The wait on this task ran until'))
      expect(wake, route).toHaveLength(1)
      expect(rows.filter((m) => m.role === 'assistant').length, route).toBeGreaterThanOrEqual(2)
      for (const m of rows) {
        for (const bad of INJECTED) expect(m.text ?? '', `${route} ${m.role} row holds "${bad}"`).not.toContain(bad)
        // No row is stamped "now" for want of a time of its own.
        if (m.timestamp) expect(Date.parse(m.timestamp), route).toBeLessThan(Date.now() + 1)
      }
      // Exactly the conversation: seed question, seed answer, wake, its answer.
      expect(rows.map((m) => m.role), route).toEqual(['user', 'assistant', 'user', 'assistant'])
    }
  }, 90_000)
})
