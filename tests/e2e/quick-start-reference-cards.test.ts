/**
 * A launch message carrying an entity reference (the composer's `@[title]`
 * token, a `<task-ref/>` tag on the wire) reaches the CLI with the same
 * reference card block `session:send` appends to a later message, and the names
 * derived from that launch read the task's words rather than the markup.
 *
 * Real pipeline below the HTTP edge: POST /api/sessions/quick-start →
 * quickStartSession → SESSION_START → the runner → MockDaemon (which records the
 * exact `start` command, message included) → the mock CLI.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-qs-reference-cards'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { REFERENCE_CARDS_CLOSE, REFERENCE_CARDS_OPEN } from '../../src/core/sessions/reference-cards.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')

let server: HttpServer
let port: number
let daemon: MockDaemon
let cwd: string

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

async function post<T>(p: string, body: Record<string, unknown>): Promise<{ status: number; json: T }> {
  const res = await fetch(apiUrl(p), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as T }
}

async function waitFor<T>(read: () => T | undefined, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = read()
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out waiting')
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-qs-refs-'))
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  await fs.rm(cwd, { recursive: true, force: true }).catch(() => {})
})

describe('quick-start with a reference in the launch message', () => {
  it('appends the reference card to the CLI message, keeps the words first, and names nothing after the markup', async () => {
    const created = await post<{ task?: { id: string }; id?: string }>('/api/tasks', {
      title: 'Login button stays grey', source: 'local', project: 'Walnut', description: 'Pressing it does nothing on Safari.',
    })
    expect(created.status).toBe(201)
    const referenced = created.json.task?.id ?? created.json.id!
    const message = `please read <task-ref id="${referenced}" label="Login button stays grey"/> first`

    const res = await post<{ taskId?: string; sessionId?: string; error?: string }>('/api/sessions/quick-start', { cwd, message })
    expect(res.status, res.json.error).toBe(200)
    const sid = res.json.sessionId!
    expect(sid).toBeTruthy()

    const start = await waitFor(() => daemon.getCommandHistoryFor('start').find((c) => c.payload.sid === sid))
    const wire = start.payload.message as string
    // The human's words lead; the card follows on its own lines and names the task.
    expect(wire.startsWith(message)).toBe(true)
    const cardStart = wire.indexOf(REFERENCE_CARDS_OPEN)
    expect(cardStart).toBeGreaterThan(message.length)
    const card = wire.slice(cardStart, wire.indexOf(REFERENCE_CARDS_CLOSE))
    expect(card).toContain(`task ${referenced}`)
    expect(card).toContain('Login button stays grey')
    expect(card).toContain('use task_get / task_send for more')

    // The session is named after the words, with the reference read as its label.
    const record = await waitFor(() => {
      const r = sessionRunner.findSessionByClaudeId(sid) as { pendingTitle?: string } | undefined
      return r?.pendingTitle ? r : undefined
    }).catch(() => undefined)
    const stored = await getSessionByClaudeId(sid)
    for (const title of [record?.pendingTitle, stored?.title]) {
      if (!title) continue
      expect(title).not.toContain('<task-ref')
      expect(title).not.toContain(REFERENCE_CARDS_OPEN)
    }
    const task = await (await fetch(apiUrl(`/api/tasks/${res.json.taskId}`))).json() as { task: { title: string; description?: string } }
    expect(task.task.title).not.toContain('<task-ref')
    expect(task.task.description ?? '').not.toContain(REFERENCE_CARDS_OPEN)
  })

  it('leaves a slash command alone: a card inside its argument string would change the command', async () => {
    const message = '/walnut-trigger watch <task-ref id="no-such-task" label="Ghost"/>'
    const res = await post<{ sessionId?: string; error?: string }>('/api/sessions/quick-start', { cwd, message })
    expect(res.status, res.json.error).toBe(200)
    const start = await waitFor(() => daemon.getCommandHistoryFor('start').find((c) => c.payload.sid === res.json.sessionId))
    expect(start.payload.message).toBe(message)
  })

  it('a reference that resolves to nothing adds no card', async () => {
    const message = 'look at <task-ref id="no-such-task" label="Ghost"/> please'
    const res = await post<{ sessionId?: string; error?: string }>('/api/sessions/quick-start', { cwd, message })
    expect(res.status, res.json.error).toBe(200)
    const start = await waitFor(() => daemon.getCommandHistoryFor('start').find((c) => c.payload.sid === res.json.sessionId))
    expect(start.payload.message).toBe(message)
  })
})
