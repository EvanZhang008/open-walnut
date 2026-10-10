/**
 * The time report and the day timeline through a REAL server, over seeded day files:
 * GET /api/time/report (both views, the task join, groups, argument refusals),
 * GET/POST /api/time/work-hours, and GET /api/time/timeline. Also the ops that bind
 * them (time_report, time_work_hours_set, time_timeline, task_note_write) run
 * through the real op executor against this server.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-time-report-routes'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'

let server: HttpServer
let port: number
let taskA = ''
let taskB = ''

const key = (d: Date): string => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
const now = new Date()
// The latest Monday strictly before today, and the Sunday before it: one workday, one weekend day.
const back = ((now.getDay() + 6) % 7) || 7
const MON_DATE = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
const MON = key(MON_DATE)
const SUN = key(new Date(MON_DATE.getFullYear(), MON_DATE.getMonth(), MON_DATE.getDate() - 1))
const at = (base: Date, h: number, m = 0): string => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).toISOString()
const SUN_DATE = new Date(MON_DATE.getFullYear(), MON_DATE.getMonth(), MON_DATE.getDate() - 1)

const url = (p: string): string => `http://127.0.0.1:${port}${p}`
async function getJson(p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url(p))
  return { status: r.status, body: await r.json() }
}
async function postJson(p: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const op = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN })

function leases(base: Date, date: string, h: number, m: number, n: number, taskId: string): string[] {
  return Array.from({ length: n }, (_, i) => JSON.stringify({ date, ts: at(base, h, m + i), durationMs: 60_000, kind: 'session', taskId }))
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port

  for (const [title, project] of [['Marina rollout checklist', 'Marina'], ['Ops ticket', 'Ops']] as const) {
    const r = await postJson('/api/tasks', { title, project, priority: 'none', pinned: false })
    expect(r.status).toBe(201)
    if (!taskA) taskA = r.body.task.id
    else taskB = r.body.task.id
  }
  const dir = path.join(WALNUT_HOME, 'time-tracking')
  await fs.mkdir(path.join(dir, 'outside'), { recursive: true })
  await fs.writeFile(path.join(dir, `${MON}.jsonl`), [
    ...leases(MON_DATE, MON, 10, 0, 60, taskA),
    ...leases(MON_DATE, MON, 19, 0, 30, taskA),
    ...leases(MON_DATE, MON, 14, 0, 20, taskB),
    JSON.stringify({ date: MON, ts: at(MON_DATE, 15), durationMs: 120 * 60_000, kind: 'agent', taskId: taskB }),
  ].join('\n') + '\n')
  await fs.writeFile(path.join(dir, `${SUN}.jsonl`), JSON.stringify({ date: SUN, ts: at(SUN_DATE, 11), durationMs: 15 * 60_000, kind: 'chat' }) + '\n')
  await fs.writeFile(path.join(dir, 'outside', `${MON}.jsonl`), [
    { date: MON, ts: at(MON_DATE, 9), durationMs: 40 * 60_000, app: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' },
    { date: MON, ts: at(MON_DATE, 11), durationMs: 15 * 60_000, app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'docs.example.com' },
    { date: MON, ts: at(MON_DATE, 12), durationMs: 30 * 60_000, app: 'Walnut', bundleId: 'com.local.walnut-desktop' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n')
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('GET /api/time/report', () => {
  it('answers both views in one call, with titles and projects joined', async () => {
    const { status, body } = await getJson(`/api/time/report?from=${SUN}&to=${MON}&group_by=day,task,project,app`)
    expect(status).toBe(200)
    expect(body).toMatchObject({ from: SUN, to: MON, dayCount: 2, workHours: { label: '09:00-18:00 Mon-Fri', source: 'default' } })
    expect(body.totals.wholeDay).toMatchObject({ walnutMin: 125, outsideMin: 55, attentionMin: 180, walnutForegroundMin: 30, agentMin: 120 })
    expect(body.totals.workHours).toMatchObject({ walnutMin: 80, outsideMin: 55, attentionMin: 135 })
    expect(body.days.map((d: any) => [d.date, d.workday, d.walnutMin, d.workMin])).toEqual([[SUN, false, 15, 0], [MON, true, 110, 80]])
    const a = body.groups.task.rows.find((r: any) => r.taskId === taskA)
    expect(a).toMatchObject({ title: 'Marina rollout checklist', project: 'Marina', min: 90, workMin: 60, offMin: 30, phase: 'TODO' })
    expect(body.groups.project.rows.map((p: any) => p.project)).toEqual(['Marina', 'Ops', '(no task)'])
    expect(body.groups.app.rows.map((r: any) => r.app)).toEqual(['Slack', 'Google Chrome'])
    expect(body.notes.length).toBeGreaterThan(2)
  })

  it('refuses a bad range or argument with a sentence', async () => {
    const cases: Array<[string, RegExp]> = [
      [`from=${MON}&to=${SUN}`, /from must not be after to/],
      [`from=${MON}&last_days=3`, /not both/],
      ['last_days=40', /from 1 to 31/],
      ['from=2026-02-31', /real YYYY-MM-DD/],
      ['kinds=sleep', /unknown kind/],
      ['group_by=weekday', /unknown group/],
      ['work_start=25:00', /HH:MM/],
      ['include_outside=maybe', /true or false/],
      [`from=${key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 120))}&to=${key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 100))}`, /keeps 90 days/],
      [`from=${key(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2))}`, /future/],
    ]
    for (const [qs, message] of cases) {
      const { status, body } = await getJson(`/api/time/report?${qs}`)
      expect(status, qs).toBe(400)
      expect(body.message, qs).toMatch(message)
    }
  })

  it('takes a request override of the work hours and says so', async () => {
    const { body } = await getJson(`/api/time/report?from=${MON}&to=${MON}&work_start=13:00&work_end=20:00`)
    expect(body.workHours).toMatchObject({ start: '13:00', end: '20:00', source: 'args' })
    expect(body.totals.workHours.walnutMin).toBe(50)
  })
})

describe('work hours setting', () => {
  it('reads the default, saves a change, applies it to the next report, and resets', async () => {
    expect((await getJson('/api/time/work-hours')).body).toMatchObject({ start: '09:00', end: '18:00', source: 'default' })
    expect((await postJson('/api/time/work-hours', {})).status).toBe(400)
    expect((await postJson('/api/time/work-hours', { end: '08:00' })).body.message).toMatch(/after start/)
    const saved = await postJson('/api/time/work-hours', { start: '08:00', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sun'] })
    expect(saved).toMatchObject({ status: 200, body: { start: '08:00', end: '18:00', source: 'config' } })
    const r = await getJson(`/api/time/report?from=${SUN}&to=${SUN}`)
    expect(r.body.workHours).toMatchObject({ source: 'config', start: '08:00' })
    expect(r.body.days[0]).toMatchObject({ workday: true, workMin: 15 })
    expect((await postJson('/api/time/work-hours', { reset: true })).body).toMatchObject({ start: '09:00', source: 'default' })
  })
})

describe('GET /api/time/timeline', () => {
  it('draws the day from every source, says which sources had nothing, and checks the range', async () => {
    const { status, body } = await getJson(`/api/time/timeline?date=${MON}`)
    expect(status).toBe(200)
    const sources = Object.fromEntries(body.sources.map((s: any) => [s.id, s]))
    expect(sources.walnut).toMatchObject({ available: true, priority: 100 })
    expect(sources['mac-apps']).toBeDefined()
    for (const id of ['sleep', 'workouts', 'calendar', 'places']) expect(sources[id], id).toBeDefined()
    const day = body.days[0]
    // 10:00-11:00 in Walnut, then Chrome until 11:15 with no gap: one screen block.
    const screen = day.blocks.find((b: any) => b.kind === 'screen' && b.start.includes('T10:00'))
    expect(screen).toMatchObject({ min: 75, trackedMin: 75, source: 'walnut+mac-apps' })
    expect(screen.top[0]).toMatchObject({ label: 'Marina rollout checklist', min: 60, taskId: taskA })
    // Walnut's own window is never an app minute: 12:00-12:30 is a hole, not screen time.
    expect(day.blocks.some((b: any) => b.kind === 'screen' && b.start.includes('T12:0'))).toBe(false)
    expect(day.summary.workHours.walnutMin).toBe(80)
    expect((await getJson(`/api/time/timeline?from=${key(new Date(MON_DATE.getFullYear(), MON_DATE.getMonth(), MON_DATE.getDate() - 10))}&to=${MON}`)).status).toBe(400)
    expect((await getJson(`/api/time/timeline?date=${MON}&from=${SUN}`)).status).toBe(400)
  })
})

describe('the ops over these routes', () => {
  it('time_report answers through the executor', async () => {
    const out = await op('time_report', { from: SUN, to: MON, kinds: 'session' })
    expect(out.ok).toBe(true)
    const result = out.ok ? out.result as any : undefined
    expect(result.totals.wholeDay.walnutMin).toBe(110)
    expect(result.kinds).toEqual(['session'])
  })

  it('time_work_hours_set saves, time_timeline reads', async () => {
    const set = await op('time_work_hours_set', { start: '09:30' })
    expect(set.ok && (set.result as any).start).toBe('09:30')
    await op('time_work_hours_set', { reset: true })
    const tl = await op('time_timeline', { date: MON })
    expect(tl.ok).toBe(true)
  })

  it('task_note_write replaces and appends the task note', async () => {
    const replaced = await op('task_note_write', { id: taskA, content: '## Plan\n- one' })
    expect(replaced.ok).toBe(true)
    const appended = await op('task_note_write', { id: taskA, content: 'second entry', mode: 'append' })
    expect(appended.ok).toBe(true)
    const task = (await getJson(`/api/tasks/${taskA}`)).body.task
    expect(task.note).toContain('## Plan')
    expect(task.note).toContain('second entry')
  })
})
