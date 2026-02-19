/**
 * E2E test: Mid-stream user message position in session history.
 *
 * Reproduces the bug: when a user sends messages mid-stream (via FIFO injection),
 * Claude Code's JSONL stores them as `type: "queue-operation"` entries — NOT as
 * `role: "user"` messages. The `parseSessionMessages` function must include these
 * entries as user messages at their correct chronological positions.
 *
 * Without the fix:
 *   - API returns history WITHOUT the user's mid-stream messages
 *   - UI falls back to optimistic state → committed messages render at the BOTTOM
 *   - User sees: [assistant output] [assistant output] [user "hi"] [user "stop"]
 *     instead of: [assistant output] [user "hi"] [assistant output] [user "stop"] [assistant response]
 *
 * What's real: Express server, session-history JSONL parsing, REST endpoint.
 * What's mocked: constants.js (temp dir).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, CLAUDE_HOME, SESSIONS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { encodeProjectPath } from '../../src/core/session-history.js'

const CWD = '/Users/test/mid-stream-project'

// ── Helpers ──

let server: HttpServer
let port: number

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`
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
    taskId: 'midstream-task-001',
    project: 'MidStreamTest',
    process_status: 'stopped',
    work_status: 'completed',
    mode: 'bypass',
    startedAt: '2026-02-20T00:40:00.000Z',
    lastActiveAt: '2026-02-20T00:42:00.000Z',
    messageCount: 5,
    cwd: CWD,
    ...extras,
  })

  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true })
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(existing))
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // Seed tasks
  const tasksDir = path.join(WALNUT_HOME, 'tasks')
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.writeFile(
    path.join(tasksDir, 'tasks.json'),
    JSON.stringify({
      version: 1,
      tasks: [{
        id: 'midstream-task-001',
        title: 'Mid-stream test task',
        status: 'todo',
        priority: 'none',
        category: 'Test',
        project: 'MidStreamTest',
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

  // ── Seed the key JSONL file that reproduces the exact real-world scenario ──
  //
  // This JSONL mimics what Claude Code actually writes when a user sends messages
  // mid-stream via Walnut's send-to-session feature (FIFO injection).
  //
  // The chronological sequence:
  //   1. User sends initial request → assistant starts working
  //   2. Assistant reads a file (tool use)
  //   3. User sends "hi" mid-stream → FIFO-injected → queue-operation in JSONL
  //   4. Assistant continues reading another file
  //   5. User sends "stop" mid-stream → FIFO-injected → queue-operation in JSONL
  //   6. queue-operation remove (cleanup) — should be ignored
  //   7. Assistant sends final response acknowledging the messages
  //
  // The bug: parseSessionMessages ignores queue-operation entries, so the API returns:
  //   [user "Read 3 files", assistant "File 1...", assistant "File 2...", assistant "Stopping."]
  // instead of the correct:
  //   [user "Read 3 files", assistant "File 1...", user "hi", assistant "File 2...", user "stop", assistant "Stopping."]
  await seedSessionRecord('mid-pos-001')
  await writeSessionJsonl('mid-pos-001', [
    // 1. User's initial request
    {
      type: 'user',
      timestamp: '2026-02-20T00:40:00.000Z',
      message: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'Read 3 files with 5s sleep' }],
      },
    },
    // 2. Assistant starts working — reads file 1
    {
      type: 'assistant',
      timestamp: '2026-02-20T00:40:05.000Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file: 'f1.ts' } },
          { type: 'text', text: 'File 1 read.' },
        ],
      },
    },
    // 3. User's mid-stream FIFO message → stored as queue-operation
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'hi',
      timestamp: '2026-02-20T00:40:09.000Z',
    },
    // 4. Assistant continues — reads file 2
    {
      type: 'assistant',
      timestamp: '2026-02-20T00:40:15.000Z',
      message: {
        id: 'a2',
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file: 'f2.ts' } },
          { type: 'text', text: 'File 2 read.' },
        ],
      },
    },
    // 5. User's second mid-stream FIFO message → queue-operation
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'stop',
      timestamp: '2026-02-20T00:40:20.000Z',
    },
    // 6. queue-operation remove (cleanup) — should NOT appear as a message
    {
      type: 'queue-operation',
      operation: 'remove',
      timestamp: '2026-02-20T00:40:21.000Z',
    },
    // 7. Assistant's final response
    {
      type: 'assistant',
      timestamp: '2026-02-20T00:40:30.000Z',
      message: {
        id: 'a3',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Stopping. Got your messages.' },
        ],
      },
    },
  ])

  // ── Seed a second session: single mid-stream message between assistant segments ──
  await seedSessionRecord('mid-pos-002')
  await writeSessionJsonl('mid-pos-002', [
    {
      type: 'user',
      timestamp: '2026-02-20T01:00:00.000Z',
      message: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'Start' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-02-20T01:00:05.000Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Working...' }],
      },
    },
    // User says "check tests" mid-stream
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'check tests',
      timestamp: '2026-02-20T01:00:10.000Z',
    },
    {
      type: 'assistant',
      timestamp: '2026-02-20T01:00:15.000Z',
      message: {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
      },
    },
  ])

  // ── Seed a third session: Pattern A — message sent between turns (enqueue + dequeue + user STRING) ──
  // This verifies Fix 1: a Pattern A enqueue must NOT produce a duplicate user message.
  // The enqueue is followed by dequeue → the user STRING is the canonical record.
  // Expected: exactly 2 messages (user "hello" + assistant "Hi there"), NOT 3.
  await seedSessionRecord('mid-pos-003')
  await writeSessionJsonl('mid-pos-003', [
    // 1. User sends "hello" between turns → enqueue + dequeue
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'hello',
      timestamp: '2026-02-20T02:00:00.000Z',
    },
    {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: '2026-02-20T02:00:01.000Z',
    },
    // 2. Claude CLI writes the canonical user STRING (Pattern A)
    {
      type: 'user',
      timestamp: '2026-02-20T02:00:02.000Z',
      message: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
    },
    // 3. Assistant responds
    {
      type: 'assistant',
      timestamp: '2026-02-20T02:00:05.000Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there' }],
      },
    },
  ])

  // ── Seed a fourth session: mixed Pattern A + Pattern B in same session ──
  // Ensures the two-pass scan correctly handles both patterns together.
  // Pattern A: enqueue "normal" → dequeue → user "normal" STRING
  // Pattern B: enqueue "midstream" (no dequeue, just remove)
  // Expected: 4 messages total (user "normal", assistant "working", user "midstream", assistant "done")
  await seedSessionRecord('mid-pos-004')
  await writeSessionJsonl('mid-pos-004', [
    // Pattern A: message sent between turns
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'normal',
      timestamp: '2026-02-20T03:00:00.000Z',
    },
    {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: '2026-02-20T03:00:01.000Z',
    },
    {
      type: 'user',
      timestamp: '2026-02-20T03:00:02.000Z',
      message: {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: 'normal' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-02-20T03:00:05.000Z',
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'working' }],
      },
    },
    // Pattern B: mid-stream injection (enqueue + remove, no user STRING)
    {
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'midstream',
      timestamp: '2026-02-20T03:00:08.000Z',
    },
    {
      type: 'queue-operation',
      operation: 'remove',
      timestamp: '2026-02-20T03:00:09.000Z',
    },
    {
      type: 'assistant',
      timestamp: '2026-02-20T03:00:15.000Z',
      message: {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
      },
    },
  ])

  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Tests ──

describe('Mid-stream message position in API history', () => {
  it('queue-operation enqueue entries appear as user messages at correct chronological positions', async () => {
    // Call the REAL API endpoint — no mocks, goes through the full path:
    // REST route → readSessionHistory → findSessionJsonlPath → parseSessionMessages
    const res = await fetch(apiUrl('/api/sessions/mid-pos-001/history'))
    expect(res.status).toBe(200)

    const body = await res.json() as { messages: Array<{ role: string; text: string }> }
    const msgs = body.messages

    // ── THE CRITICAL ASSERTION ──
    // Expected message order (chronological, matching JSONL):
    //   0: user "Read 3 files with 5s sleep"
    //   1: assistant "File 1 read."
    //   2: user "hi"               ← from queue-operation enqueue
    //   3: assistant "File 2 read."
    //   4: user "stop"             ← from queue-operation enqueue
    //   5: assistant "Stopping. Got your messages."
    //
    // BUG (without fix): only 4 messages — queue-operations invisible:
    //   0: user "Read 3 files..."
    //   1: assistant "File 1 read."
    //   2: assistant "File 2 read."
    //   3: assistant "Stopping..."

    // First: verify the total count includes the FIFO-injected messages
    expect(msgs).toHaveLength(6)

    // Second: verify exact order
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'Read 3 files with 5s sleep' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'File 1 read.' })
    expect(msgs[2]).toMatchObject({ role: 'user', text: 'hi' })
    expect(msgs[3]).toMatchObject({ role: 'assistant', text: 'File 2 read.' })
    expect(msgs[4]).toMatchObject({ role: 'user', text: 'stop' })
    expect(msgs[5]).toMatchObject({ role: 'assistant', text: 'Stopping. Got your messages.' })

    // Third: verify "hi" comes BEFORE "File 2 read." and "stop" comes BEFORE "Stopping."
    // (redundant with the order check above, but makes the intent crystal clear)
    const hiIndex = msgs.findIndex(m => m.text === 'hi')
    const file2Index = msgs.findIndex(m => m.text === 'File 2 read.')
    const stopIndex = msgs.findIndex(m => m.text === 'stop')
    const finalIndex = msgs.findIndex(m => m.text === 'Stopping. Got your messages.')

    expect(hiIndex).toBeLessThan(file2Index)
    expect(stopIndex).toBeLessThan(finalIndex)
    expect(hiIndex).toBeGreaterThan(0) // not at position 0
    expect(stopIndex).toBeGreaterThan(hiIndex) // stop comes after hi
  })

  it('queue-operation remove entries are NOT included as messages', async () => {
    const res = await fetch(apiUrl('/api/sessions/mid-pos-001/history'))
    const body = await res.json() as { messages: Array<{ role: string; text: string }> }

    // No message should have empty text or "remove" content
    for (const msg of body.messages) {
      expect(msg.text).toBeTruthy()
      expect(msg.role).toMatch(/^(user|assistant)$/)
    }

    // Exactly 6 messages — the remove entry must not create a message
    expect(body.messages).toHaveLength(6)
  })

  it('single mid-stream message appears between correct assistant segments', async () => {
    const res = await fetch(apiUrl('/api/sessions/mid-pos-002/history'))
    expect(res.status).toBe(200)

    const body = await res.json() as { messages: Array<{ role: string; text: string }> }
    const msgs = body.messages

    // Expected: Start → Working... → check tests → Done.
    expect(msgs).toHaveLength(4)
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'Start' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'Working...' })
    expect(msgs[2]).toMatchObject({ role: 'user', text: 'check tests' })
    expect(msgs[3]).toMatchObject({ role: 'assistant', text: 'Done.' })
  })

  it('Pattern A: enqueue + dequeue + user STRING produces exactly 1 user message (no duplicate)', async () => {
    // This tests Fix 1 for Pattern A.
    // A message sent between turns produces: enqueue → dequeue → user STRING.
    // The enqueue must be skipped (it's in the skip set); only the user STRING is parsed.
    // Without the fix: both enqueue and user STRING are parsed → 3 messages (user appears twice).
    const res = await fetch(apiUrl('/api/sessions/mid-pos-003/history'))
    expect(res.status).toBe(200)

    const body = await res.json() as { messages: Array<{ role: string; text: string }> }
    const msgs = body.messages

    // Must be exactly 2 messages — the enqueue must NOT add a duplicate
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'hello' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'Hi there' })
  })

  it('mixed Pattern A + Pattern B in same session: correct count and order', async () => {
    // Pattern A produces 1 user message via user STRING (enqueue skipped).
    // Pattern B produces 1 user message via enqueue (no user STRING).
    // Expected: 4 messages total — user "normal", assistant "working", user "midstream", assistant "done"
    const res = await fetch(apiUrl('/api/sessions/mid-pos-004/history'))
    expect(res.status).toBe(200)

    const body = await res.json() as { messages: Array<{ role: string; text: string }> }
    const msgs = body.messages

    expect(msgs).toHaveLength(4)
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'normal' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'working' })
    expect(msgs[2]).toMatchObject({ role: 'user', text: 'midstream' })
    expect(msgs[3]).toMatchObject({ role: 'assistant', text: 'done' })
  })
})
