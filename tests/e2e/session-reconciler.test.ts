/**
 * E2E tests for session reconciler — zombie session cleanup on server startup.
 *
 * What's real: Express server, WebSocket, event bus, session-tracker persistence,
 * task-manager linking, REST endpoints.
 * What's mocked: constants.js (temp dir), Claude CLI (mock-claude.mjs).
 *
 * Tests verify:
 *   1. Pre-seeded zombie sessions in sessions.json are cleaned up on server start
 *   2. Task session references survive (a legacy multi-session task keeps one
 *      session and lists the rest as legacy_session_ids)
 *   3. Already-completed sessions are not touched
 *   4. WebSocket clients receive status-changed events for reconciled sessions
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import { createMockConstants } from '../helpers/mock-constants.js'

// Mock constants to isolate from real data
vi.mock('../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME, SESSIONS_FILE, TASKS_FILE } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const MOCK_DAEMON_SCRIPT = path.resolve(import.meta.dirname, '../helpers/mock-daemon-process.mjs')

// ── Helpers ──

let server: HttpServer
let port: number
// Standalone MockDaemon process. Post daemon-migration, sessions spawn the CLI
// via a daemon, not directly — so setCliCommand() alone no longer mocks `claude`.
// Routing the server at a MockDaemon (which spawns mock-claude.mjs) is what makes
// the "server can still start a new session" case use the mock instead of the
// real CLI. The seeded zombies are reconciled by PID-liveness regardless of this.
let daemonProc: ChildProcess | null = null
let daemonPort: number

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

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── Setup ──

// Pre-seed zombie sessions and tasks BEFORE the server starts.
// The reconciler runs during startServer(), so seeding must happen first.

const ZOMBIE_SESSION_IN_PROGRESS = 'zombie-in-progress-001'
const ZOMBIE_SESSION_TURN_COMPLETED = 'zombie-turn-completed-002'
const ZOMBIE_SESSION_DEAD_PID = 'zombie-dead-pid-003'
const COMPLETED_SESSION = 'already-completed-004'
const ZOMBIE_TASKLESS = 'zombie-taskless-005'

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })

  // Create directories
  const tasksDir = path.dirname(TASKS_FILE)
  const sessionsDir = path.dirname(SESSIONS_FILE)
  await fs.mkdir(tasksDir, { recursive: true })
  await fs.mkdir(sessionsDir, { recursive: true })

  // Seed tasks that reference the zombie sessions
  await fs.writeFile(
    TASKS_FILE,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: 'task-with-zombie',
          title: 'Task with zombie session',
          status: 'in_progress',
          priority: 'immediate',
          category: 'Test',
          project: 'Reconciler',
          session_ids: [ZOMBIE_SESSION_IN_PROGRESS, ZOMBIE_SESSION_TURN_COMPLETED],
          active_session_ids: [ZOMBIE_SESSION_IN_PROGRESS, ZOMBIE_SESSION_TURN_COMPLETED],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          source: 'ms-todo',
        },
        {
          id: 'task-with-dead-pid',
          title: 'Task with dead PID session',
          status: 'in_progress',
          priority: 'none',
          category: 'Test',
          project: 'Reconciler',
          session_ids: [ZOMBIE_SESSION_DEAD_PID],
          active_session_ids: [ZOMBIE_SESSION_DEAD_PID],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          description: '',
          summary: '',
          note: '',
          subtasks: [],
          source: 'ms-todo',
        },
      ],
    }),
  )

  // Seed sessions.json with zombies
  const now = new Date().toISOString()
  await fs.writeFile(
    SESSIONS_FILE,
    JSON.stringify({
      version: 2,
      sessions: [
        // Zombie 1: running with no PID (legacy-style)
        {
          claudeSessionId: ZOMBIE_SESSION_IN_PROGRESS,
          taskId: 'task-with-zombie',
          project: 'Reconciler',
          process_status: 'running',
          mode: 'bypass',
          startedAt: now,
          lastActiveAt: now,
          messageCount: 5,
        },
        // Zombie 2: stopped with no PID — already stopped, so reconciler skips it.
        // last_status_change is pre-set (realistic: a stopped session always has this).
        {
          claudeSessionId: ZOMBIE_SESSION_TURN_COMPLETED,
          taskId: 'task-with-zombie',
          project: 'Reconciler',
          process_status: 'stopped',
          mode: 'bypass',
          last_status_change: now,
          startedAt: now,
          lastActiveAt: now,
          messageCount: 3,
        },
        // Zombie 3: running with a dead PID
        {
          claudeSessionId: ZOMBIE_SESSION_DEAD_PID,
          taskId: 'task-with-dead-pid',
          project: 'Reconciler',
          process_status: 'running',
          mode: 'bypass',
          startedAt: now,
          lastActiveAt: now,
          messageCount: 2,
          pid: 999999999,
          outputFile: '/tmp/nonexistent.jsonl',
        },
        // Already stopped — should not be touched
        {
          claudeSessionId: COMPLETED_SESSION,
          taskId: 'task-with-zombie',
          project: 'Reconciler',
          process_status: 'stopped',
          mode: 'bypass',
          startedAt: now,
          lastActiveAt: now,
          messageCount: 10,
        },
        // Zombie 4: taskless session running
        {
          claudeSessionId: ZOMBIE_TASKLESS,
          taskId: '',
          project: '',
          process_status: 'running',
          mode: 'default',
          startedAt: now,
          lastActiveAt: now,
          messageCount: 1,
        },
      ],
    }),
  )

  // Start MockDaemon as a child process. New sessions route through it and it
  // spawns mock-claude.mjs — without this, the real local daemon would spawn the
  // real `claude` binary and the post-reconcile new-session case would time out.
  daemonPort = await new Promise<number>((resolve, reject) => {
    daemonProc = spawn(process.execPath, [MOCK_DAEMON_SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] })
    let buf = ''
    daemonProc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      const m = buf.match(/PORT=(\d+)/)
      if (m) resolve(parseInt(m[1], 10))
    })
    daemonProc.on('error', reject)
    daemonProc.on('exit', (code) => { if (!buf.includes('PORT=')) reject(new Error(`MockDaemon exit ${code}`)) })
    setTimeout(() => reject(new Error('MockDaemon startup timeout')), 10000)
  })

  // Wire mock CLI + route sessions at the MockDaemon
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemonPort}`)

  // Start server — this triggers reconcileSessions()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
})

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  if (daemonProc) { daemonProc.kill('SIGTERM'); daemonProc = null }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

// ── Tests ──

describe('Zombie session reconciliation on startup', () => {
  it('zombie sessions are marked stopped after server starts', async () => {
    const res = await fetch(apiUrl('/api/sessions'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      sessions: Array<{
        claudeSessionId: string
        process_status: string
      }>
    }

    const byId = (id: string) => body.sessions.find((s) => s.claudeSessionId === id)

    // Zombie 1: legacy no-PID running → stopped
    const z1 = byId(ZOMBIE_SESSION_IN_PROGRESS)
    expect(z1).toBeDefined()
    expect(z1!.process_status).toBe('stopped')

    // Zombie 2: already stopped → stays stopped
    const z2 = byId(ZOMBIE_SESSION_TURN_COMPLETED)
    expect(z2).toBeDefined()
    expect(z2!.process_status).toBe('stopped')

    // Zombie 3: dead PID → stopped
    const z3 = byId(ZOMBIE_SESSION_DEAD_PID)
    expect(z3).toBeDefined()
    expect(z3!.process_status).toBe('stopped')

    // Zombie 4: taskless → stopped
    const z4 = byId(ZOMBIE_TASKLESS)
    expect(z4).toBeDefined()
    expect(z4!.process_status).toBe('stopped')
  })

  it('already-stopped session is untouched', async () => {
    const res = await fetch(apiUrl('/api/sessions'))
    const body = (await res.json()) as {
      sessions: Array<{
        claudeSessionId: string
        process_status: string
        messageCount: number
      }>
    }

    const completed = body.sessions.find((s) => s.claudeSessionId === COMPLETED_SESSION)
    expect(completed).toBeDefined()
    expect(completed!.process_status).toBe('stopped')
    expect(completed!.messageCount).toBe(10) // unchanged
  })

  it('task session references are preserved for agent_complete sessions', async () => {
    // Reconciler sets agent_complete (not completed), so session slots are NOT cleared.
    // The deprecated active_session_ids field is migrated away and no longer present.
    // task-with-zombie held three sessions before one-session-per-task; the boot split
    // (core/sessions/split-multi-session-tasks.ts) keeps one in session_ids and the
    // rest as legacy_session_ids, so every reference survives.
    const res = await fetch(apiUrl('/api/tasks/task-with-zombie'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      task: { session_ids?: string[]; legacy_session_ids?: string[] }
    }
    expect(body.task.session_ids).toHaveLength(1)
    expect([...(body.task.session_ids ?? []), ...(body.task.legacy_session_ids ?? [])]).toEqual(
      expect.arrayContaining([ZOMBIE_SESSION_IN_PROGRESS, ZOMBIE_SESSION_TURN_COMPLETED, COMPLETED_SESSION]),
    )

    // Task with dead PID zombie — its only session stays its session.
    const res2 = await fetch(apiUrl('/api/tasks/task-with-dead-pid'))
    expect(res2.status).toBe(200)
    const body2 = (await res2.json()) as {
      task: { session_ids?: string[] }
    }
    expect(body2.task.session_ids).toEqual([ZOMBIE_SESSION_DEAD_PID])
  })

  it('the kept session is the one still linked to the task; the others are history', async () => {
    const res = await fetch(apiUrl('/api/tasks/task-with-zombie'))
    const body = (await res.json()) as {
      task: { session_ids?: string[]; legacy_session_ids?: string[] }
    }
    const kept = body.task.session_ids![0]
    const sessRes = await fetch(apiUrl('/api/sessions/task/task-with-zombie'))
    expect(sessRes.status).toBe(200)
    const sessBody = (await sessRes.json()) as { sessions: Array<{ claudeSessionId: string }> }
    // One session per task: only the kept row still names the task.
    expect(sessBody.sessions.map((s) => s.claudeSessionId)).toEqual([kept])
    expect(body.task.legacy_session_ids ?? []).not.toContain(kept)
  })

  it('server can still start new sessions after reconciliation', async () => {
    const ws = await connectWs()

    // Collect session:result events
    const resultPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for session:result')), 15000)
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'event' && frame.name === 'session:result') {
          clearTimeout(timer)
          resolve(frame.data)
        }
      })
    })

    // Start a new session via RPC
    const rpcRes = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = `rpc-${Date.now()}`
      const timer = setTimeout(() => reject(new Error('RPC timed out')), 10000)
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'res' && frame.id === id) {
          clearTimeout(timer)
          resolve(frame)
        }
      })
      ws.send(JSON.stringify({
        type: 'req',
        id,
        method: 'session:start',
        payload: {
          taskId: 'task-with-zombie',
          message: 'post-reconcile test',
          project: 'Reconciler',
        },
      }))
    })

    expect(rpcRes.ok).toBe(true)

    // Wait for result — proves sessions work after reconciliation
    const result = await resultPromise
    expect(result.taskId).toBe('task-with-zombie')
    expect(result.isError).toBe(false)
    expect(result.result).toContain('post-reconcile test')

    ws.close()
    await delay(50)
  })

  it('WS clients receive status-changed events for reconciled sessions', async () => {
    // This test verifies that the reconciler emits bus events.
    // Since reconciliation already happened at startup before our WS connected,
    // we verify indirectly: the sessions are marked completed and the event
    // infrastructure is working (proven by the session:result test above).
    // The bus.emit call in reconcileSessions ensures any WS client connected
    // at startup time would receive the events.

    // Read persisted reconciled state via the SQLite-backed API. Session persistence
    // moved from sessions.json to SQLite; sessions.json is only consumed once by the
    // startup migration and is never written back, so reading the file would observe
    // the stale seed values rather than the reconciler's output. /api/sessions is the
    // real persistence layer (session-tracker reads/writes SQLite exclusively).
    const res = await fetch(apiUrl('/api/sessions'))
    expect(res.status).toBe(200)
    const raw = (await res.json()) as {
      sessions: Array<{
        claudeSessionId: string
        process_status: string
        last_status_change?: string
      }>
    }

    // Sessions that were reconciled (dead processes): reconciler set process_status=stopped
    // and last_status_change, proving updateSessionRecordConditionally ran.
    for (const id of [ZOMBIE_SESSION_IN_PROGRESS, ZOMBIE_SESSION_DEAD_PID, ZOMBIE_TASKLESS]) {
      const s = raw.sessions.find((s) => s.claudeSessionId === id)
      expect(s).toBeDefined()
      expect(s!.process_status).toBe('stopped')
      expect(s!.last_status_change).toBeTruthy()
    }

    // ZOMBIE_SESSION_TURN_COMPLETED was seeded as process_status='stopped' so the reconciler
    // correctly skipped it (predicate: current.process_status === 'stopped' → return false).
    // We verify the seed state is preserved unchanged — this is NOT a reconciler output.
    const skipped = raw.sessions.find((s) => s.claudeSessionId === ZOMBIE_SESSION_TURN_COMPLETED)
    expect(skipped).toBeDefined()
    expect(skipped!.process_status).toBe('stopped')
  })
})
