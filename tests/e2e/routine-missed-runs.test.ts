/**
 * A routine run that did not happen is seen (src/core/cron/run-log.ts, routines-core.ts,
 * routines/missed-runs.ts), through the real server's routes.
 *
 * 2026-11-08: the daily org reflection did not run (its start found no room on the Mac and the
 * error backoff moved it to the next day), and cron-state kept only the last run, so the cause
 * could not be read. Here: every run leaves a History row, the routine's reads carry its missed
 * runs, a catch-up run made for one covers it, Dismiss sets one aside, a slot that was not missed
 * cannot be "caught up", the creating session's task owns the routine, and the sweep tells.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-routine-missed-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { registerExecutor } from '../../src/core/routines/registry.js'
import { NO_RUN_REASON } from '../../src/core/cron/run-log.js'
import { noticeMissedRunsOnce } from '../../src/core/routines/missed-runs.js'
import { listNotifications } from '../../src/core/notifications/store.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR

let server: HttpServer
let port: number
let ran = 0

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost:${port}${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

/** The last three daily 08:00 UTC slots that are over an hour old, oldest first. */
function pastSlots(): number[] {
  const today = new Date()
  let s = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 8, 0, 0)
  while (s > Date.now() - HOUR) s -= DAY
  return [s - 2 * DAY, s - DAY, s]
}

const daily = (name: string, state?: Record<string, unknown>) => ({
  name, enabled: true, wakeMode: 'now', schedule: { kind: 'cron', expr: '0 8 * * *', tz: 'UTC' },
  executor: { type: 'e2e-runlog', config: { instructions: 'Reflect.' } },
  ...(state ? { state } : {}),
})

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  registerExecutor({
    type: 'e2e-runlog', label: 'run log', description: 'test double', configSchema: [],
    validate: () => ({ ok: true, config: { instructions: 'Reflect.' } }),
    async run() { ran += 1; return { status: 'ok', summary: 'Started (test)' } },
  })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('a routine’s run history and missed runs, through the routes', () => {
  it('Run now leaves a History row', async () => {
    const { json: made } = await call('POST', '/api/routines', daily('history'))
    const before = ran
    expect((await call('POST', `/api/routines/${made.job.id}/run`)).status).toBe(200)
    expect(ran).toBe(before + 1)
    const { json } = await call('GET', `/api/routines/${made.job.id}`)
    expect(json.job.state.runLog).toEqual([expect.objectContaining({ status: 'ok', manual: true, summary: 'Started (test)' })])
    expect(json.job.missed).toBeUndefined()
  })

  it('reads carry its missed runs; a catch-up covers one, Dismiss sets one aside, a slot not missed is refused', async () => {
    const [a, b, c] = pastSlots()
    // Its history began before the first slot: the first ran, the second failed, nothing ran for the third.
    const { json: made } = await call('POST', '/api/routines', daily('missed', {
      expectFromMs: a - HOUR, runLogSinceMs: a - HOUR,
      runLog: [
        { atMs: b + 5, slotMs: b, status: 'error', durationMs: 48_000, error: 'Not started: this Mac had no room for 1 minute' },
        { atMs: a + 5, slotMs: a, status: 'ok', durationMs: 1_000 },
      ],
    }))
    const id = made.job.id
    const { json: one } = await call('GET', `/api/routines/${id}`)
    expect(one.job.missed).toEqual([
      { slotMs: c, reason: NO_RUN_REASON },
      { slotMs: b, reason: 'Not started: this Mac had no room for 1 minute', failedAtMs: b + 5 },
    ])
    const { json: list } = await call('GET', '/api/routines?includeDisabled=true')
    expect(list.jobs.find((j: any) => j.id === id).missed).toHaveLength(2)

    // Not one of its missed runs.
    const wrong = await call('POST', `/api/routines/${id}/run`, { catchUpMs: a })
    expect(wrong.status).toBe(409)
    expect(wrong.json.error).toMatch(/no missed run/)

    const before = ran
    expect((await call('POST', `/api/v1/routines/${id}/run`, { catchUpMs: b })).status).toBe(200)
    expect(ran).toBe(before + 1)
    const { json: after } = await call('GET', `/api/routines/${id}`)
    expect(after.job.state.runLog[0]).toMatchObject({ catchUpMs: b, manual: true, status: 'ok' })
    expect(after.job.missed).toEqual([{ slotMs: c, reason: NO_RUN_REASON }])

    const dismissed = await call('POST', `/api/routines/${id}/missed/dismiss`, { slotMs: c })
    expect(dismissed.status).toBe(200)
    expect(dismissed.json.job.missed).toBeUndefined()
    expect((await call('GET', `/api/routines/${id}`)).json.job.missed).toBeUndefined()
    expect((await call('POST', `/api/v1/routines/${id}/missed/dismiss`, { slotMs: c })).status).toBe(409)
  })

  it('the session that made a routine owns it, and the sweep tells a missed run once', async () => {
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { addTask } = await import('../../src/core/task-manager.js')
    const { task } = await addTask({ title: 'Routine owner', project: 'Routines e2e' })
    const sid = crypto.randomUUID()
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME, { host: '__local__', initialProcessStatus: 'stopped' })
    const [, b] = pastSlots()
    const { json: owned } = await call('POST', '/api/routines', daily('owned', {
      expectFromMs: b - HOUR, runLogSinceMs: b - HOUR,
      runLog: [{ atMs: b + DAY + 5, slotMs: b + DAY, status: 'ok', durationMs: 1 }],
    }), { 'x-walnut-caller-sid': sid })
    expect(owned.job.ownerTaskId).toBe(task.id)
    // Nobody owns this one: its missed run goes on the user's notifications.
    const { json: orphan } = await call('POST', '/api/routines', daily('orphan', {
      expectFromMs: b - HOUR, runLogSinceMs: b - HOUR,
      runLog: [{ atMs: b + DAY + 5, slotMs: b + DAY, status: 'ok', durationMs: 1 }],
    }))
    expect(orphan.job.ownerTaskId).toBeUndefined()

    await noticeMissedRunsOnce()
    const bells = (await listNotifications()).feed.filter((n: any) => String(n.dedupKey ?? '').startsWith('routine-missed:'))
    expect(bells.map((n: any) => n.dedupKey)).toContain(`routine-missed:${orphan.job.id}:${b}`)
    const told = (await call('GET', `/api/routines/${owned.job.id}`)).json.job.state.missedToldMs
    expect(told).toEqual([b])
    // A second pass tells nothing new.
    const count = bells.length
    await noticeMissedRunsOnce()
    expect((await listNotifications()).feed.filter((n: any) => String(n.dedupKey ?? '').startsWith('routine-missed:'))).toHaveLength(count)
  })
})
