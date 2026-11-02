/**
 * A task's triggers pause when it completes, and a reopen resumes exactly those
 * (src/core/routines/trigger-completion-pause.ts), through the real server.
 *
 * 2026-11-02, the user: the trigger of a completed task kept polling; its check
 * script was deleted, it failed five times, and Walnut wrote him a letter. A task
 * that is done watches nothing, and only what Walnut paused comes back on a reopen:
 * a pause the user made stays, and so does a resume the user made by hand.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-trigger-completion-pause-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { sessionRunner } from '../../src/providers/claude-code-session.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'
import { setTriggerDaemonLookupForTest, type TriggerDaemon } from '../../src/core/routines/trigger-daemon.js'
import {
  completionPausesOf, startTriggerCompletionPause, stopTriggerCompletionPause, sweepTriggerCompletionPauses,
} from '../../src/core/routines/trigger-completion-pause.js'

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs')
const MIN = 60_000

let server: HttpServer
let port: number
let daemon: MockDaemon

const fakeDaemon: TriggerDaemon = {
  host: '__local__',
  hasCapability: (cap) => cap === 'triggers-v1',
  triggersPushed: true,
  async send() { return { ok: true } },
}

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

const job = async (id: string) => (await req('GET', `/api/routines/${id}`)).json.job
const enabled = async (id: string): Promise<boolean> => (await job(id)).enabled === true

async function waitFor<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let v = await read()
  while (!ok(v) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}

const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms))

async function newTask(title: string): Promise<string> {
  const r = await req('POST', '/api/tasks', { title, project: 'Trigger completion e2e' })
  expect(r.status).toBe(201)
  return r.json.id ?? r.json.task?.id
}

async function newTrigger(name: string, taskId: string): Promise<string> {
  const r = await req('POST', '/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 5 * MIN },
    check: { run: `bash ~/.open-walnut/triggers/${name.replace(/\W+/g, '-')}/check.sh` },
    executor: { type: 'session', config: { target: taskId, prompt: 'Check it.' } },
  })
  expect(r.status).toBe(201)
  return r.json.job.id
}

/** A plain timed routine into the task's session: the user's own routine, not a trigger. */
async function newTimedRoutine(name: string, taskId: string): Promise<string> {
  const r = await req('POST', '/api/routines', {
    name,
    schedule: { kind: 'every', everyMs: 24 * 60 * MIN },
    executor: { type: 'session', config: { target: taskId, prompt: 'Write the daily digest.' } },
  })
  expect(r.status).toBe(201)
  return r.json.job.id
}

async function complete(taskId: string) {
  expect((await req('POST', `/api/tasks/${taskId}/complete`, {})).status).toBeLessThan(300)
}

async function reopen(taskId: string) {
  expect((await req('PATCH', `/api/tasks/${taskId}`, { phase: 'IN_PROGRESS' })).status).toBe(200)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  daemon = await createMockDaemon()
  sessionRunner.setCliCommand(MOCK_CLI)
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`)
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
  setTriggerDaemonLookupForTest(() => fakeDaemon)
}, 60_000)

afterAll(async () => {
  setTriggerDaemonLookupForTest(null)
  sessionRunner.setTestDaemonUrl(undefined)
  await stopServer()
  await daemon.stop()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('a task completing pauses its triggers', () => {
  it('pauses only its armed triggers; a reopen resumes exactly those, and the user\'s own pause stays', async () => {
    const taskId = await newTask('release watch')
    const otherId = await newTask('another open task')
    const armed = await newTrigger('release armed', taskId)
    const second = await newTrigger('release second', taskId)
    const userPaused = await newTrigger('release user paused', taskId)
    expect((await req('PATCH', `/api/routines/${userPaused}`, { enabled: false })).status).toBe(200)
    const userPausedAt = (await job(userPaused)).state.pausedAtMs
    const timed = await newTimedRoutine('release digest', taskId)
    const elsewhere = await newTrigger('another task watch', otherId)

    await complete(taskId)
    expect(await waitFor(() => enabled(armed), (on) => !on)).toBe(false)
    expect(await waitFor(() => enabled(second), (on) => !on)).toBe(false)
    // It reads as an ordinary pause on the card.
    expect(typeof (await job(armed)).state.pausedAtMs).toBe('number')
    // A plain timed routine stays as its maker set it, and another task's trigger is not touched.
    expect(await enabled(timed)).toBe(true)
    expect(await enabled(elsewhere)).toBe(true)
    expect((await completionPausesOf(taskId)).map((t) => t.id).sort()).toEqual([armed, second].sort())

    await reopen(taskId)
    expect(await waitFor(() => enabled(armed), (on) => on)).toBe(true)
    expect(await waitFor(() => enabled(second), (on) => on)).toBe(true)
    // Paused by the user before the completion: not Walnut's to resume.
    expect(await enabled(userPaused)).toBe(false)
    expect((await job(userPaused)).state.pausedAtMs).toBe(userPausedAt)
    expect(await completionPausesOf(taskId)).toEqual([])

    // A second round goes the same way.
    await complete(taskId)
    expect(await waitFor(() => enabled(armed), (on) => !on)).toBe(false)
    await reopen(taskId)
    expect(await waitFor(() => enabled(armed), (on) => on)).toBe(true)
    expect(await enabled(userPaused)).toBe(false)
  })

  it('a trigger resumed by hand on the completed task stays resumed; paused again by hand, a reopen leaves it paused', async () => {
    const taskId = await newTask('hand watch')
    const kept = await newTrigger('hand kept', taskId)
    const repaused = await newTrigger('hand repaused', taskId)
    await complete(taskId)
    expect(await waitFor(() => enabled(kept), (on) => !on)).toBe(false)
    expect(await waitFor(() => enabled(repaused), (on) => !on)).toBe(false)

    expect((await req('PATCH', `/api/routines/${kept}`, { enabled: true })).status).toBe(200)
    expect((await req('PATCH', `/api/routines/${repaused}`, { enabled: true })).status).toBe(200)
    expect((await req('PATCH', `/api/routines/${repaused}`, { enabled: false })).status).toBe(200)
    // Neither the live path nor a boot pass pauses a hand-resumed trigger again.
    await sweepTriggerCompletionPauses()
    await settle()
    expect(await enabled(kept)).toBe(true)

    await reopen(taskId)
    await settle()
    expect(await enabled(kept)).toBe(true)
    // The person's pause after the completion is theirs: it stays.
    expect(await enabled(repaused)).toBe(false)
  })

  it('a completion by transfer leaves the triggers on: the fire follows the work to the new task', async () => {
    const taskId = await newTask('moved watch')
    const newHome = await newTask('moved watch, new home')
    const id = await newTrigger('moved watch trigger', taskId)
    const { updateTaskRaw } = await import('../../src/core/task-manager.js')
    await updateTaskRaw(taskId, { transferred_to: newHome }, { source: 'transfer' })
    await complete(taskId)
    await settle()
    expect(await enabled(id)).toBe(true)
    expect(await completionPausesOf(taskId)).toEqual([])
  })

  it('the boot pass covers a completion and a reopen the server did not see', async () => {
    const taskId = await newTask('offline watch')
    const id = await newTrigger('offline watch trigger', taskId)
    await stopTriggerCompletionPause()
    try {
      await complete(taskId)
      await settle()
      expect(await enabled(id)).toBe(true)
      expect((await sweepTriggerCompletionPauses()).paused).toEqual([id])
      expect(await enabled(id)).toBe(false)
      // A second pass has nothing left to do.
      expect(await sweepTriggerCompletionPauses()).toEqual({ paused: [], resumed: [] })

      await reopen(taskId)
      await settle()
      expect(await enabled(id)).toBe(false)
      expect((await sweepTriggerCompletionPauses()).resumed).toEqual([id])
      expect(await enabled(id)).toBe(true)
    } finally {
      await startTriggerCompletionPause()
    }
  })

  it('a trigger made on a task after it completed is left alone by the boot pass', async () => {
    const taskId = await newTask('late watch')
    await complete(taskId)
    await settle()
    const id = await newTrigger('late watch trigger', taskId)
    await sweepTriggerCompletionPauses()
    expect(await enabled(id)).toBe(true)
  })
  it('a reopen while its team is stopped hands the triggers to the stop: a team resume turns them on', async () => {
    const { updateTaskRaw, getTask } = await import('../../src/core/task-manager.js')
    const rootId = await newTask('stopped team root')
    const taskId = await newTask('stopped team member')
    await updateTaskRaw(taskId, { parent_task_id: rootId }, { source: 'test' })
    const id = await newTrigger('stopped team watch', taskId)
    await complete(taskId)
    expect(await waitFor(() => enabled(id), (on) => !on)).toBe(false)
    await updateTaskRaw(rootId, { team_stop: { at: new Date().toISOString(), by: 'human', when: 'now', members: [{ id: rootId, title: 'stopped team root' }] } }, { source: 'test' })
    await reopen(taskId)
    const stop = await waitFor(async () => (await getTask(rootId)).team_stop, (t) => !!t?.members.some((m) => m.id === taskId))
    expect(stop?.members.find((m) => m.id === taskId)?.triggers).toEqual([id])
    // Still paused while the team is stopped.
    expect(await enabled(id)).toBe(false)
  })
})
