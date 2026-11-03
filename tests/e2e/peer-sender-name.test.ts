/**
 * A message between tasks names its sender by the TASK title, never the session's
 * (src/core/peers/sender-name.ts). 2026-11-03: one task's messages arrived from
 * "Fork of Fork of Fork of Fork of Fork of Session: <service> — <url>", its session's
 * old title, while its task had a plain name.
 *
 * Through the real server (mock daemon + mock CLI): a peer note (`POST /api/v1/messages`
 * with `to`), and a reply (`in_reply_to`), each from a session whose record still wears a
 * stacked fork title. The envelope the daemon is asked to write prints the task title.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-peer-sender-name-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { createSessionRequest } from '../../src/core/session-requests.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const STACKED = 'Fork of Fork of Fork of Fork of Fork of Session: Widget Service — https://example.invalid/t/42'

let server: HttpServer
let port: number
let daemon: MockDaemon

async function req(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const asSession = (sid: string) => ({ 'x-walnut-caller-sid': sid })

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

async function task(id: string): Promise<any> {
  const r = await req('GET', `/api/tasks/${id}`)
  return r.json.task ?? r.json
}

async function sessionStatus(sid: string): Promise<string> {
  const r = await req('GET', `/api/sessions/${sid}`)
  return r.json?.session?.process_status ?? r.json?.process_status ?? ''
}

interface Worker { sid: string; taskId: string }

/** A started task, renamed, whose session record keeps a stacked fork title. */
async function startWorker(message: string, taskTitle: string): Promise<Worker> {
  const started = await req('POST', '/api/sessions/quick-start', { cwd: '/tmp', message })
  expect(started.status, JSON.stringify(started.json)).toBe(200)
  const w = { sid: started.json.sessionId, taskId: started.json.taskId }
  await until('first hand-back', () => task(w.taskId), (t) => t.phase === 'NEED_ACTION')
  await until('session idle', () => sessionStatus(w.sid), (s) => s !== 'running')
  const renamed = await req('PATCH', `/api/tasks/${w.taskId}`, { title: taskTitle })
  expect(renamed.status, JSON.stringify(renamed.json)).toBeLessThan(300)
  await updateSessionRecord(w.sid, { title: STACKED })
  return w
}

const sentTexts = () => [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
  .map((c) => String(c.payload.text ?? c.payload.message ?? ''))

/** The `from` attribute of the envelope that carries `words`. */
function fromOf(words: string): string | undefined {
  const text = sentTexts().find((s) => s.includes(words))
  return text?.match(/<walnut-message [^>]*\bfrom="([^"]*)"/)?.[1]
}

let asker: Worker
let lead: Worker

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  asker = await startWorker('lead the widget release', 'Widget release lead')
  lead = await startWorker('check the widget build', 'Widget build check')
}, 120_000)

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the sender of a message between tasks', () => {
  it('a peer note names its sender by the task title, not the stacked session title', async () => {
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', {
      to: lead.taskId, text: 'please check build 7', expect_reply: false,
    }, asSession(asker.sid))
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    const from = await until('peer note written', async () => fromOf('please check build 7'), (f) => !!f)
    expect(from).toBe(`Widget release lead [${asker.sid.slice(0, 8)}]`)
    expect(from).not.toContain('Fork of')
  }, 60_000)

  it('the printed name alone, with no [8hex], reaches that task', async () => {
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', {
      to: 'Widget build check', text: 'by name only', expect_reply: false,
    }, asSession(asker.sid))
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    await until('note written', async () => fromOf('by name only'), (f) => !!f)
    const sent = [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
      .find((c) => String(c.payload.text ?? c.payload.message ?? '').includes('by name only'))
    expect(sent?.payload.sessionId ?? sent?.payload.sid).toBe(lead.sid)
  }, 60_000)

  it('a reply names its sender by the task title too', async () => {
    await until('asker idle', () => sessionStatus(asker.sid), (s) => s !== 'running', 30_000)
    const rq = await createSessionRequest({
      fromSessionId: asker.sid, fromTaskId: asker.taskId, toSessionId: lead.sid, toTaskId: lead.taskId,
      text: 'is build 7 green?',
    })
    daemon.clearCommandHistory()
    const r = await req('POST', '/api/v1/messages', { in_reply_to: rq.id, text: 'build 7 is green' }, asSession(lead.sid))
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300)
    const from = await until('reply written', async () => fromOf('build 7 is green'), (f) => !!f)
    expect(from).toBe(`Widget build check [${lead.sid.slice(0, 8)}]`)
  }, 60_000)
})
