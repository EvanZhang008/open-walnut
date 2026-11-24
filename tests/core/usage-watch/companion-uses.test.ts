/**
 * The cloud companion's real use, counted on the Mac (src/core/usage-watch/companion-uses.ts).
 *
 * 2026-11-24: GET /api/v1/sessions/:id/transcript, how the phone reads a chat, had no row in a
 * week: the companion answers it itself, and real use ran only on the Mac.
 *
 * Pinned:
 *   - the box: its recorder hands the minute's rows to the outbox, not to a file; a batch whose answer
 *     was lost is sent again under the same id; an older Mac (needs-upgrade) keeps the rows; a
 *     refusal drops the batch; the rows wait at most 48 hours;
 *   - the Mac, through the real relay dispatcher: rows add to the hours under the route's name; a
 *     resend of a batch adds nothing; a row that is not one the recorder writes (content in its name,
 *     an hour outside the week, a count that is no count, an unknown key) is refused alone;
 *   - through the real request logger on the box: a request its own route answered is counted, one
 *     the forward answered (no route on the box) is not, as the Mac counts it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-uses'))

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; failure: Record<string, unknown> }
const mac = { reply: null as null | ((params: any) => Reply), calls: [] as Array<{ action: string; params: any }> }
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async (action: string, _sid: string, params: any) => {
    mac.calls.push({ action, params: JSON.parse(JSON.stringify(params)) })
    return mac.reply ? mac.reply(params) : { ok: true, result: {} }
  },
}))

import { _resetCompanionUsesForTesting, _resetAppliedBatchesForTesting, companionUsesWaiting, flushCompanionUses, noteCompanionRows, type UseRow } from '../../../src/core/usage-watch/companion-uses.js'
import { _resetUsageRecorderForTesting, flushUsage, recordHttp } from '../../../src/core/usage-watch/record.js'
import { closeUsageWatchStore, readHours, setUsageWatchFile } from '../../../src/core/usage-watch/store.js'
import { emptyAgg } from '../../../src/core/usage-watch/agg.js'
import { handleSessionControlRelay } from '../../../src/core/sessions/session-controls.js'
import { requestLogger } from '../../../src/web/middleware/request-logger.js'

const H = 3_600_000
const NOW = Date.now()
const HOUR = Math.floor(NOW / H) * H
const TRANSCRIPT = 'GET /api/v1/sessions/:id/transcript'
const row = (name: string, calls: number, hour = HOUR): UseRow => ({ hour, kind: 'http', name, agg: { ...emptyAgg(), calls, msSum: calls * 40, msMax: 40, msHist: { '16': calls } } })
let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-uses-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetCompanionUsesForTesting()
  _resetAppliedBatchesForTesting()
  mac.reply = null
  mac.calls = []
})

afterEach(() => {
  _resetUsageRecorderForTesting(false)
  closeUsageWatchStore()
  setUsageWatchFile(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the box', () => {
  it('hands the recorder\'s rows to the outbox instead of a file, and sends them', async () => {
    _resetUsageRecorderForTesting(true, 0, (rows) => noteCompanionRows(rows, NOW))
    for (let i = 0; i < 3; i++) recordHttp({ method: 'GET', template: '/api/v1/sessions/:id/transcript', status: 200, ms: 40, waits: false, now: NOW })
    flushUsage(NOW)
    expect(readHours(0)).toEqual([])
    expect(companionUsesWaiting()).toEqual({ waiting: 1, inflight: 0 })
    expect(await flushCompanionUses('test', NOW)).toBe(1)
    expect(mac.calls.map((c) => c.action)).toEqual(['server.usage.rows'])
    expect(mac.calls[0]!.params.rows).toMatchObject([{ hour: HOUR, kind: 'http', name: TRANSCRIPT, agg: { calls: 3 } }])
    expect(companionUsesWaiting()).toEqual({ waiting: 0, inflight: 0 })
  })

  it('sends a batch whose answer was lost again under its id; an older Mac keeps the rows; a refusal drops them', async () => {
    noteCompanionRows([row(TRANSCRIPT, 2)], NOW)
    mac.reply = () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'timed out', notSent: false } })
    expect(await flushCompanionUses('test', NOW)).toBe(0)
    // A later count of the same hour waits beside the batch, never inside it.
    noteCompanionRows([row(TRANSCRIPT, 5)], NOW)
    mac.reply = () => ({ ok: false, failure: { kind: 'needs_upgrade', message: 'The primary box predates this mobile action' } })
    expect(await flushCompanionUses('test', NOW)).toBe(0)
    mac.reply = null
    expect(await flushCompanionUses('test', NOW)).toBe(1)
    expect(await flushCompanionUses('test', NOW)).toBe(1)
    const ids = mac.calls.map((c) => c.params.batch)
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).toBe(ids[2])
    expect(ids[3]).not.toBe(ids[2])
    expect(mac.calls.map((c) => c.params.rows[0].agg.calls)).toEqual([2, 2, 2, 5])
    noteCompanionRows([row(TRANSCRIPT, 1)], NOW)
    mac.reply = () => ({ ok: false, failure: { kind: 'error', status: 400, code: 'bad_request', message: 'rows refused' } })
    expect(await flushCompanionUses('test', NOW)).toBe(0)
    expect(companionUsesWaiting()).toEqual({ waiting: 0, inflight: 0 })
  })

  it('keeps rows at most 48 hours, and only requests', async () => {
    noteCompanionRows([row(TRANSCRIPT, 1, HOUR - 49 * H), row('GET /api/v1/tasks', 1), { ...row('task_get', 1), kind: 'op' }], NOW)
    expect(companionUsesWaiting().waiting).toBe(1)
  })
})

describe('the Mac', () => {
  const send = async (params: Record<string, unknown>) => {
    const r = await handleSessionControlRelay('server.usage.rows', '__server__', params)
    return r
  }

  it('adds the rows under the route\'s name, once per batch', async () => {
    const r = await send({ batch: 'cu-1', rows: [row(TRANSCRIPT, 4), row('GET /api/v1/tasks', 2)] })
    expect(r).toMatchObject({ ok: true, result: { added: 2, refused: 0 } })
    expect((await send({ batch: 'cu-1', rows: [row(TRANSCRIPT, 4)] }))).toMatchObject({ ok: true, result: { duplicate: true } })
    await send({ batch: 'cu-2', rows: [row(TRANSCRIPT, 1)] })
    const t = readHours(0, { kind: 'http', name: TRANSCRIPT })
    expect(t).toHaveLength(1)
    expect(t[0]!.agg).toMatchObject({ calls: 5, msHist: { '16': 5 } })
  })

  it('refuses a row that is not one the recorder writes, alone', async () => {
    const bad: unknown[] = [
      row('GET /api/v1/notes/My diary.md', 1),
      row('GET /etc/passwd', 1),
      row(TRANSCRIPT, 1, HOUR - 9 * 24 * H),
      row(TRANSCRIPT, 1, HOUR + 30_000),
      { ...row(TRANSCRIPT, 1), agg: { ...emptyAgg(), calls: -1 } },
      { ...row(TRANSCRIPT, 1), agg: { ...emptyAgg(), calls: 1, codes: { 'Secret text here': 1 } } },
      { ...row(TRANSCRIPT, 1), kind: 'op' },
    ]
    const r = await send({ batch: 'cu-3', rows: [...bad, row('GET /api/v1/tasks/:id', 1)] })
    expect(r).toMatchObject({ ok: true, result: { added: 1, refused: bad.length } })
    expect(readHours(0).map((x) => x.name)).toEqual(['GET /api/v1/tasks/:id'])
    expect(await send({ batch: 'cu-4', rows: Array.from({ length: 501 }, () => row(TRANSCRIPT, 1)) })).toMatchObject({ ok: false, errorKind: 'bad_request' })
    expect(await send({ rows: [] })).toMatchObject({ ok: false, errorKind: 'bad_request' })
  })
})

describe('through the real request logger on the box', () => {
  it('counts what its own route answered, never what the forward answered', async () => {
    const seen: UseRow[] = []
    _resetUsageRecorderForTesting(true, 0, (rows) => seen.push(...rows))
    const app = express()
    app.use('/api', requestLogger)
    const v1 = express.Router()
    // The forward (web/v1-forward/proxy.ts) answers before any route: the Mac counts it.
    v1.use((req, res, next) => { if (req.path === '/tasks') { res.json({ forwarded: true }); return } next() })
    v1.get('/sessions/:id/transcript', (_req, res) => { res.json({ messages: [] }) })
    app.use('/api/v1', v1)
    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)) })
    try {
      const port = (server.address() as { port: number }).port
      await fetch(`http://127.0.0.1:${port}/api/v1/sessions/5f1c2a77-0b2e-4d43-9c55-2f6ad3e0c1ab/transcript?rich=1`).then((r) => r.arrayBuffer())
      await fetch(`http://127.0.0.1:${port}/api/v1/tasks`).then((r) => r.arrayBuffer())
      await vi.waitFor(() => { flushUsage(); expect(seen.map((r) => r.name)).toContain(TRANSCRIPT) })
    } finally { await new Promise((r) => server.close(r)) }
    expect(seen.map((r) => r.name)).toEqual([TRANSCRIPT])
  })
})
