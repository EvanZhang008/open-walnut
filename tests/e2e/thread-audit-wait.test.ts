/**
 * A parked node woken by the thread check stays parked (experiment threads_audit; 2026-11-25
 * review: the check's source ended the wait for good, so a waiting VP lost its wait and its clock).
 * A task that keeps Threads parks itself on a clock, with no trigger; the check finds two cards on
 * one subject and its note starts a real turn of the mock CLI; at the turn end the task is WAITING
 * again with the same wait_until. Mocked: constants, the daemon (MockDaemon), the CLI, the judge.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-audit-wait'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'
import { getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { fileThreadMessage, writeThreadsFor } from '../../src/core/org/threads-store.js'
import { _resetOrgEnabledForTesting } from '../../src/core/org/org-enabled.js'
import { setAuditJudgeOverride } from '../../src/core/org/thread-audit.js'
import { executeOp } from '../../src/ops/index.js'
import type { OrgThread } from '../../src/core/org/threads-model.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
let server: Server
let daemon: MockDaemon
let root = ''
let taskId = ''
let sid = ''

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()
const setThread = (id: string, patch: Partial<OrgThread>) =>
  writeThreadsFor(taskId, (cur) => ({ file: { ...cur, threads: cur.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) }, out: undefined }))

/** The task's phase edges while `run` runs, until the last is WAITING or NEED_ACTION after an IN_PROGRESS. */
async function phasesDuring(run: () => Promise<void>): Promise<string[]> {
  const { bus, EventNames } = await import('../../src/core/event-bus.js')
  const seen: string[] = []
  let last = (await getTask(taskId)).phase as string
  const name = `thread-audit-wait-${randomUUID()}`
  bus.subscribe(name, (e) => {
    const t = (e.data as { task?: { id: string; phase: string } }).task
    if (t?.id === taskId && t.phase !== last) { seen.push(t.phase); last = t.phase }
  }, { global: true, interest: [EventNames.TASK_UPDATED] })
  try {
    await run()
    await vi.waitFor(() => {
      expect(seen).toContain('IN_PROGRESS')
      expect(['WAITING', 'NEED_ACTION']).toContain(seen[seen.length - 1])
    }, { timeout: 30_000, interval: 100 })
  } finally {
    bus.unsubscribe(name)
  }
  return seen
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetOrgEnabledForTesting(true)
  daemon = await createMockDaemon()
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  daemon.setCliCommand(MOCK_CLI)
  server = await startServer({ port: 0, dev: true })
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  taskId = (await addTask({ title: 'Orchard upkeep', project: 'Orchard' })).task.id
  await updateTaskRaw(taskId, { threads_on: true, phase: 'IN_PROGRESS' } as never, { emitEvent: true })
  sid = (await sessionRunner.startSession({ taskId, cwd: WALNUT_HOME, message: 'Ready', project: 'Orchard', preassignedSessionId: randomUUID() })).claudeSessionId
  await vi.waitFor(async () => expect((await getSessionByClaudeId(sid))?.process_status).toMatch(/idle|stopped/), { timeout: 20_000 })
  setAuditJudgeOverride(async () => '1 SAME: one irrigation timer, told twice')
}, 150_000)

afterAll(async () => {
  setAuditJudgeOverride(null)
  _resetOrgEnabledForTesting()
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon?.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
}, 60_000)

describe('a parked node woken by the thread check', () => {
  it('is WAITING again with its clock once the check\'s turn ends', async () => {
    const a = (await fileThreadMessage(taskId, { text: 'the pear orchard irrigation timer drifts at night', via: 'chat', at: ago(120) })).thread.id
    const b = (await fileThreadMessage(taskId, { text: 'irrigation timer drift in the pear orchard again', via: 'chat', at: ago(60) })).thread.id
    await setThread(a, { title: 'Pear orchard irrigation timer drifts at night', titled: true, state: 'answered', reply: 'The timer loses ten minutes a night; a new battery is ordered.' })
    await setThread(b, { title: 'Irrigation timer drift in the pear orchard', titled: true, state: 'working', reply: 'Looking at the timer log of the pear orchard pump.' })
    const wakeAt = new Date(Date.now() + 2 * 3_600_000).toISOString()
    // Parked by its own session, on a clock and no trigger (a waiting VP's usual park).
    const parked = await executeOp('task_update', { id: taskId, phase: 'WAITING', waiting_on: 'the battery delivery on Friday', wait_until: wakeAt }, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: sid })
    expect(parked.ok, JSON.stringify(parked)).toBe(true)
    expect(await getTask(taskId)).toMatchObject({ phase: 'WAITING', wait_until: wakeAt })
    expect((await fetch(`${root}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ experimental: { threads_audit: true } }) })).status).toBe(200)

    let delivery = ''
    const seen = await phasesDuring(async () => {
      const r = await fetch(`${root}/api/v1/thread-audit/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: taskId }) })
      delivery = ((await r.json()) as { delivery: string }).delivery
    })
    expect(delivery).toBe('woke')
    expect(seen).toEqual(['IN_PROGRESS', 'WAITING'])
    expect(await getTask(taskId)).toMatchObject({ phase: 'WAITING', wait_until: wakeAt })
  })
})
