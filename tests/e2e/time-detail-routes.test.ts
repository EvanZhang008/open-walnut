/**
 * Richer time tracking through a REAL server:
 *   - the browser's heartbeats carry a session view, the open file and plugin
 *     items: the synced day file keeps only the view word, the names go to the
 *     Mac-local detail file;
 *   - the report groups views, files and items, and counts calls;
 *   - the timeline has a calls source, checks meetings against the calls, takes the
 *     user's answer for one meeting, and leaves out the meetings they ignore;
 *   - the two new ops run through the real executor.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import http, { type Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-time-detail-routes'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { executeOp } from '../../src/ops/executor.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { registerTimelineSource, clearTimelineSources } from '../../src/core/time-tracking/timeline/registry.js'

let server: HttpServer
let port: number

const key = (d: Date): string => [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
const now = new Date()
// Yesterday: inside the 7-day sample window, and a whole day.
const DAY = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
const D = key(DAY)
const at = (h: number, m = 0): Date => new Date(DAY.getFullYear(), DAY.getMonth(), DAY.getDate(), h, m)

const url = (p: string): string => `http://127.0.0.1:${port}${p}`
async function getJson(p: string): Promise<{ status: number; body: any }> {
  const r = await fetch(url(p))
  return { status: r.status, body: await r.json() }
}
async function post(p: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null }
}
const op = (name: string, args: Record<string, unknown>) =>
  executeOp(name, args, { apiBase: `http://127.0.0.1:${port}`, origin: LOCAL_ORIGIN })

async function waitForFile(file: string, test: (text: string) => boolean): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (test(text)) return text
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${file}`)
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  const calls = path.join(WALNUT_HOME, 'time-tracking', 'outside', 'calls')
  await fs.mkdir(calls, { recursive: true })
  await fs.writeFile(path.join(calls, `${D}.jsonl`), [
    { t: 'cov', start: at(0).toISOString(), end: at(23, 59).toISOString(), src: 'log' },
    { t: 'call', app: 'zoom.us', start: at(11, 0).toISOString(), end: at(11, 50).toISOString(), src: 'log' },
    { t: 'call', app: 'zoom.us', start: at(16, 0).toISOString(), end: at(16, 20).toISOString(), src: 'log' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
  // A meeting source standing in for the calendar plugin (none is installed here).
  registerTimelineSource('testcal', {
    id: 'meetings', label: 'Test meetings', lane: 'activity', priority: 50,
    segments: async () => ({
      segments: [
        { start: at(11, 0).getTime(), end: at(12, 0).getTime(), kind: 'meeting', label: 'Design review', confidence: 'planned', detail: { eventId: 'EV-design' } },
        { start: at(14, 0).getTime(), end: at(14, 30).getTime(), kind: 'meeting', label: 'Team sync', confidence: 'planned', detail: { eventId: 'EV-sync' } },
        { start: at(15, 0).getTime(), end: at(15, 30).getTime(), kind: 'meeting', label: 'Team lunch', confidence: 'planned', detail: { eventId: 'EV-lunch' } },
      ],
    }),
  })
}, 60_000)

afterAll(async () => {
  clearTimelineSources('testcal')
  await stopServer()
})

describe('heartbeats with detail', () => {
  it('the synced day file keeps the view word only; the file and the item go to the local detail file', async () => {
    const r = await post('/api/time/heartbeats', { samples: [
      { ts: at(10, 0).toISOString(), durationMs: 30_000, kind: 'session', sessionId: 'sess-detail-1', view: 'files', file: '/repo/src/app.ts' },
      { ts: at(10, 1).toISOString(), durationMs: 20_000, kind: 'session', sessionId: 'sess-detail-1', view: 'chat' },
      { ts: at(10, 2).toISOString(), durationMs: 40_000, kind: 'app', app: 'chatapp', item: 'C0123', label: '#general', mode: 'reply' },
      { ts: at(10, 3).toISOString(), durationMs: 10_000, kind: 'session', sessionId: 'sess-detail-1', view: 'not-a-view', app: 'ignored-on-session' },
    ] })
    expect(r.status).toBe(204)
    const day = await waitForFile(path.join(WALNUT_HOME, 'time-tracking', `${D}.jsonl`), (t) => t.split('\n').filter(Boolean).length >= 4)
    const lines = day.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => [l.kind, l.view ?? null, l.app ?? null, l.mode ?? null])).toEqual([
      ['session', 'files', null, null], ['session', 'chat', null, null], ['app', null, 'chatapp', 'reply'], ['session', null, null, null],
    ])
    expect(day).not.toContain('app.ts')
    expect(day).not.toContain('#general')
    const detail = await waitForFile(path.join(WALNUT_HOME, 'time-tracking', 'outside', 'detail', `${D}.jsonl`), (t) => t.split('\n').filter(Boolean).length >= 2)
    expect(detail.trim().split('\n').map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ t: 'lease', kind: 'session', view: 'files', file: '/repo/src/app.ts', durationMs: 30_000 }),
      expect.objectContaining({ t: 'lease', kind: 'app', app: 'chatapp', item: 'C0123', label: '#general', mode: 'reply' }),
    ])
  })

  it('the report groups views, files and items, and counts the calls', async () => {
    const { status, body } = await getJson(`/api/time/report?from=${D}&to=${D}&group_by=view,file,item`)
    expect(status).toBe(200)
    expect(body.kinds).toEqual(['session', 'triage', 'chat', 'app'])
    expect(body.groups.view.rows.map((v: any) => v.view)).toEqual(expect.arrayContaining(['files', 'chat', 'app:chatapp', 'unknown']))
    expect(body.groups.file.rows).toEqual([expect.objectContaining({ file: '/repo/src/app.ts' })])
    expect(body.groups.item.rows).toEqual([expect.objectContaining({ app: 'chatapp', item: 'C0123', label: '#general' })])
    expect(body.totals.wholeDay.callMin).toBe(70)
    expect(body.days[0]).toMatchObject({ callMin: 70 })
    expect(body.notes.join(' ')).toMatch(/callMin/)
  })
})

describe('Walnut opened under another name', () => {
  /** A POST that names its Host, as a paired browser on a LAN or tailnet name sends it. */
  async function postAs(host: string, p: string, body: unknown): Promise<number> {
    const { createDevice } = await import('../../src/core/device-auth.js')
    const { token } = await createDevice('laptop-browser')
    const data = JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Host: `${host}:${port}`, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(data)
    })
  }

  it('a heartbeat teaches the server the page\'s hostname, so that browser tab stops reading as another app', async () => {
    // The sampler saw Chrome on mac-mini.lan from 08:00 to 08:10.
    const outsideFile = path.join(WALNUT_HOME, 'time-tracking', 'outside', `${D}.jsonl`)
    await fs.mkdir(path.dirname(outsideFile), { recursive: true })
    await fs.appendFile(outsideFile, Array.from({ length: 120 }, (_, i) => JSON.stringify({
      date: D, ts: new Date(at(8, 0).getTime() + i * 5_000).toISOString(), durationMs: 5_000, app: 'Google Chrome', bundleId: 'com.google.Chrome', host: 'mac-mini.lan',
    })).join('\n') + '\n')
    // A lease from a loopback page: the server has not seen that name yet, so it is cut.
    expect((await post('/api/time/heartbeats', { samples: [{ ts: at(8, 0).toISOString(), durationMs: 120_000, kind: 'chat' }] })).status).toBe(204)
    const before = await getJson(`/api/time/report?from=${D}&to=${D}&kinds=chat`)
    expect(before.body.totals.wholeDay).toMatchObject({ walnutMin: 0, overlapMin: 2 })
    // The page on mac-mini.lan sends a heartbeat: from now on that site is Walnut.
    expect(await postAs('mac-mini.lan', '/api/time/heartbeats', { samples: [{ ts: at(8, 5).toISOString(), durationMs: 60_000, kind: 'chat' }] })).toBe(204)
    await waitForFile(path.join(WALNUT_HOME, 'time-tracking', 'outside', 'walnut-hosts.json'), (t) => t.includes('mac-mini.lan'))
    const after = await getJson(`/api/time/report?from=${D}&to=${D}&kinds=chat`)
    expect(after.body.totals.wholeDay).toMatchObject({ walnutMin: 3, overlapMin: 0 })
  })
})

describe('meetings in the timeline', () => {
  it('checks each meeting against the calls and lists the ones to ask about', async () => {
    const { status, body } = await getJson(`/api/time/timeline?date=${D}`)
    expect(status).toBe(200)
    expect(body.sources.find((s: any) => s.id === 'calls')).toMatchObject({ available: true, priority: 85 })
    const day = body.days[0]
    const plan = Object.fromEntries(day.plan.map((p: any) => [p.title, p]))
    expect(plan['Design review']).toMatchObject({ attendance: 'attended', attendanceBasis: 'call', callMin: 50, eventId: 'EV-design' })
    expect(plan['Team sync']).toMatchObject({ attendance: 'needs_confirmation', meetingMin: 0 })
    expect(day.summary).toMatchObject({ callMin: 70, adHocCallMin: 20 })
    expect(day.summary.needsConfirmation.map((m: any) => m.eventId)).toEqual(['EV-sync', 'EV-lunch'])
    expect(day.blocks.some((b: any) => b.kind === 'call' && b.label === 'Zoom call')).toBe(true)
  })

  it('takes the user\'s answer through the op, and leaves an ignored meeting out', async () => {
    const answered = await op('time_meeting_attendance_set', { event_id: 'EV-sync', attended: true })
    expect(answered.ok).toBe(true)
    const ignored = await op('time_meetings_ignore_set', { patterns: ['lunch'] })
    expect(ignored.ok && (ignored.result as any).ignore).toEqual(['lunch'])
    const tl = await op('time_timeline', { date: D })
    expect(tl.ok).toBe(true)
    const day = (tl.ok ? tl.result as any : undefined).days[0]
    expect(day.plan.map((p: any) => p.title)).toEqual(['Design review', 'Team sync'])
    expect(day.plan[1]).toMatchObject({ attendance: 'attended', attendanceBasis: 'user', meetingMin: 30 })
    expect(day.summary.ignoredMeetings).toBe(1)
    expect(day.summary.needsConfirmation).toBeUndefined()
    // Clearing both brings the question back.
    await op('time_meeting_attendance_set', { event_id: 'EV-sync', attended: null })
    await op('time_meetings_ignore_set', { patterns: [] })
    const again = await getJson(`/api/time/timeline?date=${D}`)
    expect(again.body.days[0].summary.needsConfirmation).toHaveLength(2)
  })

  it('refuses a malformed answer with a sentence', async () => {
    expect((await post('/api/time/meetings/attendance', { event_id: 'EV-sync', attended: 'yes' })).status).toBe(400)
    expect((await post('/api/time/meetings/attendance', { attended: true })).status).toBe(400)
    expect((await post('/api/time/meetings/ignore', { patterns: 'lunch' })).status).toBe(400)
  })
})
