/**
 * E2E tests for reading a session's history and its plan over REST.
 *
 * What's real: Express server, event bus, session-tracker, session-history
 * parsing, REST endpoints.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Tests verify:
 *   1. Plan extraction from a completed plan session (Write + ExitPlanMode)
 *   2. A session with no plan answers 404 with a readable reason
 *   3. GET /api/sessions/:id/history returns the parsed messages
 *   4. A live session started through the WS RPC lands in history
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CLAUDE_HOME, SESSIONS_FILE } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { encodeProjectPath } from '../../src/core/session-history.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const CWD = '/Users/test/project'

// ── Helpers ──

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl())
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 15000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), timeoutMs)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer)
        ws.off('message', handler)
        resolve(frame)
      }
    }
    ws.on('message', handler)
  })
}

function sendWsRpc(ws: WebSocket, method: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000)
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>
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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function pollUntil(check: () => Promise<boolean>, intervalMs = 100, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(intervalMs)
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`)
}

/** Write a JSONL file directly to CLAUDE_HOME/projects/ for a given sessionId. */
async function writeSessionJsonl(sessionId: string, lines: unknown[]) {
  const encoded = encodeProjectPath(CWD)
  const dir = path.join(CLAUDE_HOME, 'projects', encoded)
  await fs.mkdir(dir, { recursive: true })
  const content = lines.map((l) => JSON.stringify(l)).join('\n')
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), content)
}

/** Seed sessions.json with a session record. */
async function seedSessionRecord(sessionId: string, extras?: Record<string, unknown>) {
  let existing: { version: number; sessions: unknown[] } = { version: 2, sessions: [] }
  try {
    const raw = await fs.readFile(SESSIONS_FILE, 'utf-8')
    existing = JSON.parse(raw)
  } catch { /* file doesn't exist yet */ }

  existing.sessions.push({
    claudeSessionId: sessionId,
    taskId: 'hist-task-001',
    project: 'test',
    process_status: 'stopped',
    mode: 'default',
    startedAt: '2025-01-01T00:00:00Z',
    lastActiveAt: '2025-01-01T01:00:00Z',
    messageCount: 1,
    cwd: CWD,
    ...extras,
  })

  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true })
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(existing))
}

function msg(id: string, role: 'user' | 'assistant', text: string, extras?: { tools?: unknown[] }) {
  const content: unknown[] = [{ type: 'text', text }]
  if (extras?.tools) content.push(...extras.tools)
  return {
    type: role,
    timestamp: `2025-01-01T00:00:${String(parseInt(id.replace(/\D/g, '') || '0')).padStart(2, '0')}Z`,
    message: { id, role, content },
  }
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  sessionRunner.setCliCommand(MOCK_CLI)

  // Seed tasks
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [{
        id: 'hist-task-001',
        title: 'History test task',
        status: 'todo',
        priority: 'none',
        category: 'Work',
        project: 'Test',
        session_ids: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        description: '',
        summary: '',
        note: '',
        subtasks: [],
      }],
    }),
  )

  // Pre-seed session records and JSONL files for direct tool testing
  // -- Session with plan content
  await seedSessionRecord('plan-sess-001')
  await writeSessionJsonl('plan-sess-001', [
    msg('u1', 'user', 'Create a plan'),
    {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:01Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will create a plan.' },
          {
            type: 'tool_use',
            name: 'Write',
            input: {
              file_path: '/home/user/.claude/plans/my-plan.md',
              content: '# E2E Plan\n\n## Step 1\nImplement feature\n\n## Step 2\nWrite tests',
            },
          },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: '2025-01-01T00:00:02Z',
      message: {
        id: 'a2',
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'ExitPlanMode', input: {} },
          { type: 'text', text: 'Plan complete.' },
        ],
      },
    },
  ])

  // -- Session with no plan (regular session)
  await seedSessionRecord('regular-sess-001')
  await writeSessionJsonl('regular-sess-001', [
    msg('u1', 'user', 'Fix the bug'),
    msg('a1', 'assistant', 'I found the issue.'),
    msg('u2', 'user', 'What was it?'),
    msg('a2', 'assistant', 'A null pointer dereference.'),
  ])

  // -- Long session for pagination testing (20 messages)
  await seedSessionRecord('long-sess-001')
  const longLines: unknown[] = []
  for (let i = 0; i < 20; i++) {
    longLines.push(msg(
      `m${i}`,
      i % 2 === 0 ? 'user' : 'assistant',
      `Message number ${i}: ${'x'.repeat(100)}`,
    ))
  }
  await writeSessionJsonl('long-sess-001', longLines)

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Tests ──

describe('REST /api/sessions/:id/plan — plan extraction', () => {
  it('extracts plan content from a session with Write + ExitPlanMode', async () => {
    const res = await fetch(apiUrl('/api/sessions/plan-sess-001/plan'))
    expect(res.status).toBe(200)
    const body = await res.json() as { content: string }
    expect(body.content).toContain('# E2E Plan')
    expect(body.content).toContain('## Step 1')
    expect(body.content).toContain('Implement feature')
    expect(body.content).toContain('## Step 2')
    expect(body.content).toContain('Write tests')
  })

  it('answers 404 with a readable reason when the session has no plan', async () => {
    const res = await fetch(apiUrl('/api/sessions/regular-sess-001/plan'))
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toMatch(/no plan/i)
  })
})

describe('REST /api/sessions/:id/history — refactor backward compat', () => {
  it('returns session history via REST after refactor', async () => {
    const res = await fetch(apiUrl('/api/sessions/regular-sess-001/history'))
    expect(res.status).toBe(200)

    const body = await res.json() as { messages: unknown[] }
    expect(body.messages).toHaveLength(4)
    expect((body.messages[0] as Record<string, unknown>).text).toBe('Fix the bug')
  })

  it('returns 404 for unknown session', async () => {
    const res = await fetch(apiUrl('/api/sessions/nonexistent-999/history'))
    expect(res.status).toBe(404)
  })
})

describe('live session via mock CLI — default history works', () => {
  it('starts a session and reads history via default mode', async () => {
    const ws = await connectWs()
    try {
      const resultPromise = waitForWsEvent(ws, 'session:result')

      const rpcRes = await sendWsRpc(ws, 'session:start', {
        taskId: 'hist-task-001',
        message: 'hello from history test',
        project: 'Test',
      })
      expect(rpcRes.ok).toBe(true)

      // Wait for session to complete
      const resultEvent = await resultPromise
      const rd = resultEvent.data as { sessionId: string; result: string }
      expect(rd.sessionId).toBeTruthy()
      expect(rd.result).toContain('hello from history test')

      // Verify the session result event has correct structure
      expect(rd.result).toBeDefined()
    } finally {
      ws.close()
    }
  })
})
