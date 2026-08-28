/**
 * E2E: a session whose process did not survive is resumed WITHOUT the user
 * touching anything (inc-1787439819342).
 *
 * What's real: the Express server boot, the startup session reconciler, the
 * auto-recover watcher, the event bus, session-tracker persistence, task-manager
 * phase lookup, and the send that triggers the resume.
 * What's mocked: constants.js (temp dir) only.
 *
 * The shape under test is the one that used to be a dead end: the process is
 * gone, the cause is infrastructure (here 'server_restart' — the Walnut server
 * outlived the CLI), the task is still IN_PROGRESS, and nobody is coming to press
 * Retry. Before this feature the session simply sat there; the incident's session
 * sat for 3.5 hours.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-auto-recover-e2e'))

import { WALNUT_HOME, SESSIONS_FILE, TASKS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'

const DEAD_SESSION = 'auto-recover-dead-001'
const DEAD_SESSION_DONE = 'auto-recover-done-002'
const TASK_LIVE = 'task-auto-recover-live'
const TASK_DONE = 'task-auto-recover-done'

let server: HttpServer
/** Every session:send / session:message-queued the server emitted during boot. */
const sends: Array<{ sessionId: string; source: string }> = []
const envBackup: Record<string, string | undefined> = {}

function setEnv(key: string, value: string): void {
  envBackup[key] = process.env[key]
  process.env[key] = value
}

function task(id: string, phase: string, sessionId: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    status: phase === 'IN_PROGRESS' ? 'in_progress' : 'in_progress',
    phase,
    priority: 'none',
    project: 'AutoRecover',
    session_ids: [sessionId],
    active_session_ids: [sessionId],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    description: '', summary: '', note: '', subtasks: [],
  }
}

/** A local session whose recorded pid is long gone. `process_status: 'running'`
 *  is the record's last event-driven truth — exactly what a host/server death
 *  leaves behind. */
function deadSession(sid: string, taskId: string): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    claudeSessionId: sid,
    taskId,
    project: 'AutoRecover',
    type: 'interactive',
    provider: 'cli',
    engine: 'claude',
    process_status: 'running',
    mode: 'bypass',
    // PID 2 is init-adjacent on macOS/Linux and never a live `claude` process;
    // the liveness check resolves it as dead without us having to kill anything.
    pid: 2,
    cwd: '/tmp',
    startedAt: now,
    lastActiveAt: now,
    messageCount: 3,
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(path.dirname(TASKS_FILE), { recursive: true })
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true })

  await fs.writeFile(TASKS_FILE, JSON.stringify({
    version: 1,
    tasks: [
      task(TASK_LIVE, 'IN_PROGRESS', DEAD_SESSION),
      // Work already handed back to the human — must NOT be resumed behind them.
      task(TASK_DONE, 'AGENT_COMPLETE', DEAD_SESSION_DONE),
    ],
  }))
  await fs.writeFile(SESSIONS_FILE, JSON.stringify({
    version: 2,
    sessions: [deadSession(DEAD_SESSION, TASK_LIVE), deadSession(DEAD_SESSION_DONE, TASK_DONE)],
  }))

  // Fire immediately instead of after the 20s settle delay, and disable the
  // per-host stagger so both candidates are decided in this test's lifetime.
  setEnv('WALNUT_AUTO_RECOVER_DELAY_MS', '0')
  setEnv('WALNUT_AUTO_RECOVER_STAGGER_MS', '0')

  bus.subscribe('auto-recover-e2e-probe', (event: BusEvent) => {
    const d = event.data as { sessionId?: string }
    if (d.sessionId) sends.push({ sessionId: d.sessionId, source: event.source ?? '' })
  }, { global: true, interest: ['session:send', 'session:message-queued'] })

  server = await startServer({ port: 0, dev: true })

  // Let the boot-time catch-up timers fire and the async fire() chain settle.
  await new Promise((r) => setTimeout(r, 2_000))
}, 120_000)

afterAll(async () => {
  bus.unsubscribe('auto-recover-e2e-probe')
  try { await stopServer() } catch { /* already down */ }
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
}, 60_000)

describe('auto-recover on server boot', () => {
  it('resumes the dead session whose task is still IN_PROGRESS, with no user action', () => {
    const mine = sends.filter((s) => s.source === 'auto-recover')
    expect(mine.map((s) => s.sessionId)).toContain(DEAD_SESSION)
  })

  it('does NOT resume the dead session whose work was already handed back', () => {
    const mine = sends.filter((s) => s.source === 'auto-recover')
    expect(mine.map((s) => s.sessionId)).not.toContain(DEAD_SESSION_DONE)
  })

  it('spends exactly one attempt from the persisted budget', async () => {
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const rec = await getSessionByClaudeId(DEAD_SESSION)
    expect(rec?.autoRecover?.attempts).toBe(1)
    expect(rec?.autoRecover?.cause).toBe('server_restart')
  })

  it('leaves the untouched session with no budget state at all', async () => {
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js')
    const rec = await getSessionByClaudeId(DEAD_SESSION_DONE)
    expect(rec?.autoRecover).toBeFalsy()
  })
})
