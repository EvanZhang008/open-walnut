/**
 * The real-use monitor on a temp file: what it keeps (names, never content), the recorder's
 * hours, a watch's verdict, where an alarm goes and how notes are batched and retried, and the
 * completion check for a task that shipped.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { setUsageWatchFile, readHours, readEvents, closeUsageWatchStore, markAlive } from '../../../src/core/usage-watch/store.js'
import { addObserveTap } from '../../../src/core/observability/metrics.js'
import { usageReport } from '../../../src/core/usage-watch/report.js'
import { _resetUsageRecorderForTesting, STALL_KIND, flushUsage, recordConfirmedCut, recordHttp, recordOpCall, recordPageError } from '../../../src/core/usage-watch/record.js'
import { PAGE_REQUEST_HOWS, TemplateMatcher, agentCutChars, failureClass, pageErrorKind, pageKindIsPagesOwn, pageRequestOf, registeredTemplate, walnutOpOfToolCall, type PageRequestHow } from '../../../src/core/usage-watch/normalize.js'
import { judgeWatch, newWatch, putWatch, listWatches, armedWatchesFor, targetCovers } from '../../../src/core/usage-watch/watches.js'
import { BATCH_GAP_MS, _sendsForTesting, noteText, routeUsageAlarm, sendDueNotes, type RouteDeps } from '../../../src/core/usage-watch/route.js'
import { recordShip, shipFailed, shipOfCommand } from '../../../src/core/usage-watch/ships.js'
import { admitShipWatch, noteClosedUnwatched } from '../../../src/core/usage-watch/gate.js'
import { runUsageWatchAction, probeFiller } from '../../../src/core/usage-watch/actions.js'
import { answerSize } from '../../../src/lib/tool-answer-size.js'

const T0 = Date.parse('2026-11-21T10:00:00Z')
const H = 3_600_000
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-watch-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('what is kept', () => {
  it('reads Claude Code\'s own cut notes, MCP and Bash', () => {
    expect(agentCutChars('Error: result (27,446 characters across 178 lines) exceeds maximum allowed tokens. Output has been saved to /x')).toBe(27_446)
    expect(agentCutChars('<persisted-output>\nOutput too large (11.8KB). Full output saved to: /tmp/x.txt')).toBe(12_083)
    expect(agentCutChars('{"ok":true}')).toBeNull()
    // An answer that quotes another session's note is not a cut (a task_history read).
    expect(agentCutChars('{"messages":[{"text":"Error: result (27,446 characters across 178 lines) exceeds maximum allowed tokens."}]}')).toBeNull()
    expect(agentCutChars('<error>MCP tool "x" response (40000 tokens) exceeds maximum allowed tokens (25000).</error>')).toBe(0)
  })

  it('names a tool call\'s op from MCP or the CLI', () => {
    expect(walnutOpOfToolCall('mcp__walnut__thread_update', {})).toBe('thread_update')
    expect(walnutOpOfToolCall('Bash', { command: "walnut tools call task_get '{\"id\":\"x\"}' | head" })).toBe('task_get')
    expect(walnutOpOfToolCall('Bash', { command: 'ls' })).toBeNull()
    expect(walnutOpOfToolCall('Bash', { command: 'grep -n "walnut tools call task_get" notes.md' })).toBeNull()
    expect(walnutOpOfToolCall('Bash', { command: 'WALNUT_AGENT_SOCKET=/s /x/bin/walnut tools call usage_watch \'{}\'' })).toBe('usage_watch')
    expect(walnutOpOfToolCall('mcp__other__x', {})).toBeNull()
  })

  it('keeps only the route template Express matched', () => {
    expect(registeredTemplate('/api/v1', '/tasks/:id')).toBe('/api/v1/tasks/:id')
    expect(registeredTemplate('/api', undefined)).toBe('unmatched')
    // A regex route or anything with odd characters is never kept as a name.
    expect(registeredTemplate('/api', '/notes/(.*)')).toBe('unmatched')
    // A mount path is the URL's own: an id there becomes :id; a plain word or `notes-v2` stays.
    expect(registeredTemplate('/api/plugins/acme-sync/items/rq-b83e9eb1dd8d', '/')).toBe('/api/plugins/acme-sync/items/:id')
    expect(registeredTemplate('/api/notes-v2', '/search')).toBe('/api/notes-v2/search')
  })

  it('names a request by what Express holds when it finishes, through real routers', async () => {
    const app = express()
    const seen: string[] = []
    app.use((req, res, next) => { res.on('finish', () => seen.push(registeredTemplate(req.baseUrl, req.route?.path))); next() })
    const v1 = express.Router()
    v1.get('/tasks/:id', (_req, res) => { res.json({}) })
    app.use('/api/v1', v1)
    const plugin = express.Router({ mergeParams: true })
    const inner = express.Router({ mergeParams: true })
    inner.get('/', (_req, res) => { res.json({}) })
    plugin.use('/items/:itemId', inner)
    app.use('/api/plugins/:pluginId', plugin)
    const server = await new Promise<import('node:http').Server>((r) => { const s = app.listen(0, () => r(s)) })
    try {
      const port = (server.address() as { port: number }).port
      for (const u of ['/api/v1/tasks/c17c6e79-7681-5286-a134-23cacdb988eb', '/api/plugins/acme-sync/items/mwr1najx-c816', '/api/nothing']) await fetch(`http://127.0.0.1:${port}${u}`)
      // `finish` can come just after the client has its answer: wait for the three, not a clock.
      await vi.waitFor(() => expect(seen).toHaveLength(3))
    } finally { await new Promise((r) => server.close(r)) }
    expect(seen).toEqual(['/api/v1/tasks/:id', '/api/plugins/acme-sync/items/:id', 'unmatched'])
  })

  it('a page error keeps its request template or its type and bundle, never its message', () => {
    const t = new TemplateMatcher()
    t.add('GET', '/api/sessions/:id')
    t.add('GET', '/api/sessions/search')
    expect(pageErrorKind('[api] GET /api/sessions/abc-123?x=1 FAILED after 15000ms (timeout 15000ms)', '', t))
      .toEqual({ kind: 'GET /api/sessions/:id timed out in the page', route: 'GET /api/sessions/:id', request: true, how: 'timed out' })
    expect(pageErrorKind('[api] GET /api/sessions/search FAILED after 20ms', '', t)?.kind).toBe('GET /api/sessions/search failed in the page')
    // A path no answered template matches is never kept as itself (it may hold a file name).
    expect(pageErrorKind('[api] GET /api/notes/My%20private%20file.md FAILED after 5ms', '', t)?.kind).toBe('GET unknown request failed in the page')
    // Held in the page's queue while the page was in the background: no problem at all.
    expect(pageErrorKind('[api] GET /api/sessions/search rejected after 15000ms in the connection queue (page suspended)', '', t)).toBeNull()
    expect(pageErrorKind('[api] GET /api/sessions/search rejected after 20000ms in the connection queue (page hidden)', '', t)).toBeNull()
    // Out on the network while the window was hidden: its answer came late (2026-11-24, /org).
    expect(pageErrorKind('[api] GET /api/sessions/search FAILED after 15411ms (timeout 15000ms, page hidden)', '', t)).toBeNull()
    expect(pageErrorKind('[api] GET /api/sessions/search rejected after 15000ms in the connection queue (pool saturated)', '', t)?.kind).toBe('GET /api/sessions/search rejected in the page')
    const thrown = pageErrorKind('[uncaught] Uncaught TypeError: cannot read secret-word of undefined', 'https://h/assets/ThreadCard-AbC123xy.js:1:2', t)
    expect(thrown).toEqual({ kind: 'TypeError in the ThreadCard chunk', request: false })
    expect(JSON.stringify(thrown)).not.toContain('secret')
    expect(pageErrorKind('[app] something the app logged', '', t)).toBeNull()
    // The browser's own errors have no stack to place them: each has a name, never "Other in the unknown chunk"
    // (2026-11-23: the Mac app's WebKit line, args as browser-logger.ts sends them).
    expect(pageErrorKind('[uncaught] ResizeObserver loop completed with undelivered notifications.', 'http://localhost:3456/?s1=a&s2=b:0:0, undefined', t))
      .toEqual({ kind: 'ResizeObserver loop in the page', request: false })
    expect(pageErrorKind('[uncaught] ResizeObserver loop limit exceeded', '', t)?.kind).toBe('ResizeObserver loop in the page')
    expect(pageErrorKind('[uncaught] Script error.', ':0:0', t)?.kind).toBe('Script error from another origin')
    // A thrown message that only starts like one is still the page's own error.
    expect(pageErrorKind('[uncaught] ResizeObserver loop completed with undelivered notifications. TypeError: x', '', t)?.kind).toBe('TypeError in the unknown chunk')
    // A network error never reached the server; anything else the browser threw is the page's own.
    for (const err of ['TypeError: Failed to fetch', 'TypeError: Load failed', 'TypeError: NetworkError when attempting to fetch resource.']) {
      expect(pageErrorKind('[api] GET /api/sessions/search FAILED after 3ms', err, t)?.how, err).toBe('failed')
    }
    expect(pageErrorKind('[api] GET /api/sessions/search FAILED after 0ms', "TypeError: Failed to execute 'fetch' on 'Window': Invalid value", t))
      .toEqual({ kind: 'GET /api/sessions/search refused by the browser', route: 'GET /api/sessions/search', request: true, how: 'refused' })
  })

  it('the minute flush settles timeouts once their minute has passed: alone never rung, three kinds together once as a stall', () => {
    const seen: string[] = []
    const off = addObserveTap((name, _v, labels) => { if (name === 'usage.page.errors') seen.push(labels?.kind ?? '') })
    const timedOut = (route: string) => ({ kind: `${route} timed out in the page`, route, request: true, how: 'timed out' as const })
    try {
      recordPageError(timedOut('GET /api/x'), T0)
      flushUsage(T0 + 61_000)
      expect(seen).toEqual([])
      for (const r of ['GET /api/a', 'GET /api/b', 'GET /api/c']) recordPageError(timedOut(r), T0 + 200_000)
      flushUsage(T0 + 230_000)
      expect(seen).toEqual([])
      flushUsage(T0 + 261_000)
      expect(seen).toEqual([STALL_KIND])
      flushUsage(T0 + 400_000)
      expect(seen).toHaveLength(1)
    } finally { off() }
  })

  it('classes a failed call by what the op answered', () => {
    expect(failureClass({ invalidArgs: true }).cls).toBe('bad_args')
    expect(failureClass({ status: 409, code: 'target_complete' })).toEqual({ cls: 'refused', code: 'target_complete' })
    expect(failureClass({ status: 500 }).cls).toBe('error')
    expect(failureClass({ status: 503, code: 'host_reconnecting' }).cls).toBe('unreachable')
    expect(failureClass({ lost: true }).cls).toBe('timeout')
    expect(failureClass({ status: 409, code: 'Free text with spaces' }).code).toBe('http_409')
  })

  it('measures an answer the way its client prints it', () => {
    const big = { text: 'a'.repeat(26_000) }
    expect(answerSize(big, 'mcp').overLimit).toBe(true)
    expect(answerSize({ text: 'a'.repeat(9_000) }, 'cli').overLimit).toBe(false)
    expect(answerSize({ text: 'a'.repeat(11_000) }, 'cli').overLimit).toBe(true)
    // Past the MCP server's own cap it is saved to a file and never cut by the harness.
    expect(answerSize({ text: 'a'.repeat(70_000) }, 'mcp')).toEqual({ size: 70_011, overLimit: false, spilled: true })
    // An older client names none: over every client's limit reads over budget.
    expect(answerSize(big, 'unknown').overLimit).toBe(true)
    expect(answerSize({ text: 'a'.repeat(20_000) }, 'unknown').overLimit).toBe(false)
  })

  it('the probe is filler with no content and a length the drill names', () => {
    const p = probeFiller(1_000)
    expect(p).toHaveLength(1_000)
    expect(/^[\u2800-\u28ff]+$/.test(p)).toBe(true)
  })
})

describe('the recorder', () => {
  it('folds calls into hours and keeps problem events without content', () => {
    recordOpCall({ op: 'task_get', client: 'mcp', cls: 'ok', size: 30_000, overLimit: true, ms: 40, now: T0 })
    recordOpCall({ op: 'task_get', client: 'mcp', cls: 'ok', size: 2_000, overLimit: false, ms: 10, now: T0 + 1_000 })
    recordOpCall({ op: 'task_get', client: 'cli', cls: 'error', code: 'http_500', size: 80, overLimit: false, ms: 900, now: T0 + 2_000 })
    recordConfirmedCut('task_get', 30_000, 'mcp', T0 + 3_000)
    recordHttp({ method: 'GET', template: '/api/v1/tasks/:id', status: 200, ms: 6_000, waits: false, now: T0 })
    recordHttp({ method: 'GET', template: '/api/v1/events', status: 200, ms: 600_000, waits: true, now: T0 })
    recordPageError({ kind: 'TypeError in the X chunk', request: false }, T0)
    flushUsage(T0 + 60_000)
    const rows = readHours(T0 - H)
    const op = rows.find((r) => r.kind === 'op' && r.name === 'task_get')!.agg
    expect(op).toMatchObject({ calls: 3, errors: 1, overLimit: 1, cut: 1, charsMax: 30_000 })
    expect(op.codes).toEqual({ http_500: 1 })
    const slow = rows.find((r) => r.kind === 'http' && r.name === 'GET /api/v1/tasks/:id')!.agg
    expect(slow.slow).toBe(1)
    // A long poll's time is no latency.
    expect(rows.find((r) => r.name === 'GET /api/v1/events')!.agg.slow).toBe(0)
    const ev = readEvents({ since: 0, limit: 50 })
    expect(ev.map((e) => e.problem).sort()).toEqual(['cut', 'error', 'error', 'over_limit', 'slow'])
    expect(Object.keys(ev[0]!)).not.toContain('sid')
  })

  it('a whole answer (a program\'s read, a call no session made, `_full`) is a call but in no size number and never over a limit', async () => {
    const { recordGatewayCall } = await import('../../../src/core/usage-watch/gateway-record.js')
    const big = { ok: true, result: { text: 'a'.repeat(300_000) } }
    recordGatewayCall('task_history', 'cli', big, 5, true)
    recordGatewayCall('task_history', 'mcp', big, 5, true)
    recordGatewayCall('task_history', 'program', big, 5)
    recordGatewayCall('task_history', 'cli', { ok: true, result: { text: 'a'.repeat(4_000) } }, 5)
    // A failure of such a call still counts as one, with its small size.
    recordGatewayCall('task_history', 'cli', { ok: false, message: 'Invalid arguments for task_history: x', invalidArgs: true }, 5, true)
    flushUsage(T0 + 60_000)
    const op = readHours(0).filter((r) => r.kind === 'op' && r.name === 'task_history').map((r) => r.agg)
    const sum = (k: 'calls' | 'overLimit' | 'badArgs') => op.reduce((n, a) => n + a[k], 0)
    expect(sum('calls')).toBe(5)
    expect(sum('overLimit')).toBe(0)
    expect(sum('badArgs')).toBe(1)
    expect(Math.max(...op.map((a) => a.charsMax))).toBeLessThan(10_000)
    expect(readEvents({ since: 0, limit: 50 }).filter((e) => e.name === 'task_history' && e.problem === 'over_limit')).toEqual([])
    // The same answer held to an agent's surface still counts.
    recordGatewayCall('task_history', 'cli', big, 5)
    flushUsage(T0 + 120_000)
    expect(readHours(0).filter((r) => r.kind === 'op' && r.name === 'task_history').reduce((n, r) => n + r.agg.overLimit, 0)).toBe(1)
  })

  it("a 503 saying its host is not reachable now is unreachable, never the route's server error; any other 503 still is", () => {
    // 2026-11-23: deploys cut a host's link and the history route's "Reconnecting" 503s rang as
    // its server errors; an op call's 503 was already unreachable (failureClass).
    expect(failureClass({ status: 503 }).cls).toBe('unreachable')
    const T = '/api/sessions/:sessionId/history'
    recordHttp({ method: 'GET', template: T, status: 503, ms: 20, waits: false, hostUnreachable: true, now: T0 })
    recordHttp({ method: 'GET', template: T, status: 503, ms: 20, waits: false, now: T0 + 1 })
    recordHttp({ method: 'GET', template: T, status: 500, ms: 20, waits: false, now: T0 + 2 })
    flushUsage(T0 + 60_000)
    const agg = readHours(T0 - H).find((r) => r.kind === 'http' && r.name === `GET ${T}`)!.agg
    expect(agg).toMatchObject({ calls: 3, unreachable: 1, serverErrors: 2, errors: 2 })
    expect(agg.codes).toEqual({ http_503: 2, http_500: 1 })
    const problems = readEvents({ since: 0, limit: 50 }).filter((e) => e.kind === 'http').map((e) => `${e.problem}:${e.code}`).sort()
    expect(problems).toEqual(['server_error:http_500', 'server_error:http_503', 'unreachable:http_503'])
  })

  it('through the real request logger: a host_reconnecting 503 is unreachable, a store-busy 503 a server error', async () => {
    const { requestLogger } = await import('../../../src/web/middleware/request-logger.js')
    const { HOST_RECONNECTING } = await import('../../../src/core/hosts/remote-read-bound.js')
    const app = express()
    app.use(requestLogger)
    const r = express.Router()
    r.get('/:sessionId/history', (_req, res) => { res.status(503).json({ error: 'Reconnecting to box', code: HOST_RECONNECTING }) })
    r.get('/:sessionId/draft', (_req, res) => { res.status(503).json({ error: 'store busy' }) })
    app.use('/api/sessions', r)
    const v1 = express.Router()
    v1.get('/files/:id', (_req, res) => { res.status(503).send({ error: { code: HOST_RECONNECTING, message: 'x' } }) })
    app.use('/api/v1', v1)
    const server = await new Promise<import('node:http').Server>((ok) => { const s = app.listen(0, () => ok(s)) })
    try {
      const port = (server.address() as { port: number }).port
      for (const u of ['/api/sessions/s1/history', '/api/sessions/s1/draft', '/api/v1/files/f1']) await fetch(`http://127.0.0.1:${port}${u}`)
      await new Promise((ok) => setTimeout(ok, 50))
    } finally { await new Promise((ok) => server.close(ok)) }
    flushUsage(Date.now() + 60_000)
    const agg = (name: string) => readHours(0).find((row) => row.kind === 'http' && row.name === name)?.agg
    expect(agg('GET /api/sessions/:sessionId/history')).toMatchObject({ unreachable: 1, serverErrors: 0 })
    expect(agg('GET /api/sessions/:sessionId/draft')).toMatchObject({ unreachable: 0, serverErrors: 1 })
    // res.send(object) goes through res.json: seen too.
    expect(agg('GET /api/v1/files/:id')).toMatchObject({ unreachable: 1, serverErrors: 0 })
  })

  it('the request logger knows a host-unreachable 503 from its body, whichever route sent it', async () => {
    const { watchHostUnreachableAnswer, isHostUnreachableAnswer } = await import('../../../src/web/middleware/host-unreachable-answer.js')
    const answer = (status: number, body: unknown) => {
      const res = { statusCode: 200, json(b: unknown) { void b; return res } } as unknown as import('express').Response
      watchHostUnreachableAnswer(res)
      ;(res as { statusCode: number }).statusCode = status
      res.json(body)
      return isHostUnreachableAnswer(res)
    }
    expect(answer(503, { error: 'Reconnecting to box', code: 'host_reconnecting' })).toBe(true)
    expect(answer(503, { error: { code: 'host_reconnecting', message: 'x' } })).toBe(true)
    expect(answer(503, { error: 'store busy' })).toBe(false)
    expect(answer(200, { code: 'host_reconnecting' })).toBe(false)
    // Every code that says a machine is away, in both body shapes (tests/web/host-away-503-ratchet.test.ts).
    const { HOST_AWAY_CODES } = await import('../../../src/web/middleware/host-unreachable-answer.js')
    for (const code of HOST_AWAY_CODES) {
      expect(answer(503, { error: 'away', code }), code).toBe(true)
      expect(answer(503, { error: { code, message: 'away' } }), code).toBe(true)
    }
    expect(answer(503, { error: 'x', code: 'budget_unavailable' })).toBe(false)
  })

  it('records nothing until started (a replica, a CLI process)', () => {
    _resetUsageRecorderForTesting(false)
    recordOpCall({ op: 'task_get', client: 'mcp', cls: 'ok', size: 1, overLimit: false, ms: 1, now: T0 })
    flushUsage(T0 + 60_000)
    expect(readHours(0)).toEqual([])
  })
})

describe('the report', () => {
  it('a server started late in an hour has recorded all of its time, not the hour\'s few minutes', () => {
    const start = T0 + 56 * 60_000
    for (let m = 0; m < 5; m++) markAlive(start + m * 60_000)
    expect(usageReport('7d', { now: start + 5 * 60_000 }).recorded).toBe(1)
    // Down for the next two hours, back for 30 minutes: about a fifth recorded since it began.
    for (let m = 0; m < 30; m++) markAlive(T0 + 3 * H + m * 60_000)
    const r = usageReport('7d', { now: T0 + 3 * H + 30 * 60_000 }).recorded
    expect(r).toBeGreaterThan(0.2)
    expect(r).toBeLessThan(0.3)
  })
})

describe('a watch', () => {
  function seed(calls: number, size: number, at = T0 + H) {
    for (let i = 0; i < calls; i++) recordOpCall({ op: 'thread_update', client: 'mcp', cls: 'ok', size, overLimit: size > 25_000, ms: 5, now: at + i })
    flushUsage(at + 60_000)
  }

  it('passes with enough use and every check met', () => {
    seed(25, 5_000)
    const w = newWatch({ taskId: 't1', targets: ['op:thread_update'], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })
    // The server was up the whole time.
    for (let m = 0; m < 5 * 60; m++) flushUsage(T0 + m * 60_000)
    expect(judgeWatch(w, T0 + 5 * H).state).toBe('passed')
  })

  it('is not failed for an answer from the hour it was armed in, before it was armed', () => {
    // 2026-11-24: a watch armed at 02:57 on a fix was failed for an 88,422-character answer of 02:10.
    seed(1, 88_000, T0 + 10 * 60_000)
    seed(25, 5_000, T0 + 2 * H)
    const w = newWatch({ taskId: 't1', targets: ['op:thread_update'], checks: {}, who: 'this task', checkAt: T0 + 6 * H, createdAt: T0 + 57 * 60_000 })
    for (let m = 0; m < 6 * 60; m++) flushUsage(T0 + m * 60_000)
    expect(judgeWatch(w, T0 + 6 * H).state).toBe('passed')
    // The same answer inside the window still fails it.
    seed(1, 88_000, T0 + 3 * H)
    expect(judgeWatch(w, T0 + 6 * H).state).toBe('failed')
    // A window too short to hold a whole hour still counts the hour it starts in.
    const short = newWatch({ taskId: 't1', targets: ['op:thread_update'], checks: { min_uses: 1 }, who: 'this task', checkAt: T0 + 3 * H + 50 * 60_000, createdAt: T0 + 3 * H + 5 * 60_000 })
    expect(judgeWatch(short, T0 + 3 * H + 50 * 60_000).state).toBe('failed')
  })

  it('fails on a 22,000-character answer against a 20,000 check, though nothing was cut', () => {
    seed(25, 22_000)
    const w = newWatch({ taskId: 't1', targets: ['op:thread_update'], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })
    const v = judgeWatch(w, T0 + 5 * H)
    expect(v.state).toBe('failed')
    expect(v.summary).toContain('largest answer 22,000 over 20,000')
  })

  it('too little use is checked again once, then says so', () => {
    seed(3, 1_000)
    const w = newWatch({ taskId: 't1', targets: ['op:thread_update'], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })
    expect(judgeWatch(w, T0 + 5 * H).state).toBe('extended')
    expect(judgeWatch({ ...w, extended: true }, T0 + 5 * H).state).toBe('too_little_use')
  })

  // 2026-11-24: two deploy restarts made 253 failed requests on the session page, and a watch on
  // page:session read every one as the page's error. Each way a request can go wrong is named here:
  // a new one fails to compile until it says whether it is the page's own failure.
  // A timed-out one waited on its route or its server: supervision timeouts fell in the minutes its
  // server read slowly, and four servers timeouts on a server being replaced for a deploy (11-23 17:54).
  const PAGES_OWN: Record<PageRequestHow, boolean> = { failed: false, rejected: false, 'timed out': false, refused: true }
  const LINES: Record<PageRequestHow, [string, string]> = {
    failed: ['[api] GET /api/sessions/abc/supervision FAILED after 5ms', 'TypeError: Load failed'],
    rejected: ['[api] GET /api/sessions/abc/supervision rejected after 15000ms in the connection queue (pool saturated)', ''],
    'timed out': ['[api] GET /api/sessions/abc/supervision FAILED after 8000ms (timeout 8000ms)', 'TimeoutError: The operation timed out.'],
    refused: ['[api] GET /api/sessions/abc/supervision FAILED after 0ms', "TypeError: Failed to execute 'fetch' on 'Window': Invalid value"],
  }

  it('a page watch fails only on the page\'s own errors, never on requests that never reached the server or were never sent', () => {
    const t = new TemplateMatcher()
    t.add('GET', '/api/sessions/:sessionId/supervision')
    for (const how of Object.keys(PAGES_OWN) as PageRequestHow[]) {
      const k = pageErrorKind(LINES[how][0], LINES[how][1], t)!
      expect(k.how, how).toBe(how)
      expect(pageKindIsPagesOwn(k.kind), how).toBe(PAGES_OWN[how])
    }
    expect(pageKindIsPagesOwn('TypeError in the SessionChat chunk')).toBe(true)
    const kindOf = (how: PageRequestHow) => pageErrorKind(LINES[how][0], LINES[how][1], t)!
    const watch = newWatch({ taskId: 't1', targets: ['page:session'], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 })
    for (let i = 0; i < 30; i++) recordPageError(kindOf(i % 2 ? 'failed' : 'rejected'), T0 + H + i)
    flushUsage(T0 + H + 60_000)
    for (let m = 0; m < 5 * 60; m++) flushUsage(T0 + m * 60_000)
    const away = judgeWatch(watch, T0 + 5 * H)
    expect(away.state).toBe('passed')
    expect(away.summary).toContain('30 requests that went wrong on the way')
    recordPageError(kindOf('timed out'), T0 + 2 * H)
    flushUsage(T0 + 2 * H + 60_000)
    expect(judgeWatch(watch, T0 + 5 * H).state).toBe('passed')
    recordPageError(kindOf('refused'), T0 + 2 * H)
    recordPageError({ kind: 'TypeError in the session-chat chunk', request: false }, T0 + 2 * H)
    flushUsage(T0 + 2 * H + 60_000)
    const own = judgeWatch(watch, T0 + 5 * H)
    expect(own.state).toBe('failed')
    expect(own.summary).toContain('2 page errors')
    expect(own.summary).toContain('31 requests that went wrong on the way')
  })

  // 2026-11-24: page timeouts failed the page watches of tasks that changed only how controls look,
  // then rang the watch of a route that answered in time (a notes list answered in 24 ms that the
  // page waited 15 s for). A request that went wrong on its way is neither the page's nor its route's;
  // a route that held its page until the page gave up is its own slow read, recorded by its server.
  it('a request that went wrong on its way rings no watch, page or route; a route that held its page reads slow', () => {
    const t = new TemplateMatcher()
    t.add('GET', '/api/sessions/:sessionId/supervision')
    const slowKind = pageErrorKind(LINES['timed out'][0], LINES['timed out'][1], t)!
    expect(pageRequestOf(slowKind.kind)).toEqual({ route: 'GET /api/sessions/:sessionId/supervision', how: 'timed out' })
    expect(pageRequestOf('TypeError in the session-chat chunk')).toBeNull()
    expect(pageRequestOf('GET unknown request timed out in the page')).toEqual({ route: 'GET unknown request', how: 'timed out' })
    const ROUTE = 'route:GET /api/sessions/:sessionId/supervision'
    putWatch(newWatch({ taskId: 't-page', targets: ['page:session'], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 }))
    putWatch(newWatch({ taskId: 't-route', targets: [ROUTE], checks: {}, who: 'this task', checkAt: T0 + 5 * H, createdAt: T0 }))
    // Every way on the way, enumerated from the source: a new one is checked here as it lands.
    for (const how of PAGE_REQUEST_HOWS) {
      const kind = `GET /api/sessions/:sessionId/supervision ${how} in the page`
      expect(pageRequestOf(kind)?.how, how).toBe(how)
      for (const target of ['page:session', 'page:supervision', ROUTE, 'route:/api/sessions/:sessionId/supervision']) expect(targetCovers(target, 'page', kind), `${how} ${target}`).toBe(false)
      expect(armedWatchesFor('page', kind, T0 + H), how).toEqual([])
    }
    expect(targetCovers(ROUTE, 'http', 'GET /api/sessions/:sessionId/supervision')).toBe(true)
    const refused = pageErrorKind(LINES.refused[0], LINES.refused[1], t)!
    expect(targetCovers('page:session', 'page', refused.kind)).toBe(true)
    expect(armedWatchesFor('page', 'TypeError in the session-chat chunk', T0 + H).map((w) => w.taskId)).toEqual(['t-page'])
    const seen: string[] = []
    const off = addObserveTap((name, _v, labels) => { if (name.startsWith('usage.page') || name === 'usage.http.slow') seen.push(`${name} ${labels?.kind ?? labels?.route ?? ''}`) })
    try {
      // Each way alone, five times an hour apart from the rest: never rung.
      for (const how of PAGE_REQUEST_HOWS) {
        for (let n = 0; n < 5; n++) recordPageError({ kind: `GET /api/x ${how} in the page`, route: 'GET /api/x', request: true, how }, T0 + H + n * 120_000)
      }
      flushUsage(T0 + 2 * H)
      expect(seen).toEqual([])
      // The route answered in 40 ms and the page still gave up: still nobody's.
      recordHttp({ method: 'GET', template: '/api/sessions/:sessionId/supervision', status: 200, ms: 40, waits: false, now: T0 + 3 * H })
      recordPageError(slowKind, T0 + 3 * H + 15_000)
      flushUsage(T0 + 3 * H + 120_000)
      expect(seen).toEqual([])
      // The page gave up after 15 s and its fetch was aborted: the server's hang-up is a slow read of
      // the route, timed as long as the page waited. A short hang-up (a closed tab) and a stream's end are not.
      recordHttp({ method: 'GET', template: '/api/sessions/:sessionId/supervision', status: 200, ms: 15_003, waits: false, hungUp: true, now: T0 + 4 * H })
      recordHttp({ method: 'GET', template: '/api/sessions/:sessionId/supervision', status: 200, ms: 900, waits: false, hungUp: true, now: T0 + 4 * H })
      recordHttp({ method: 'GET', template: '/api/v1/events', status: 200, ms: 600_000, waits: true, hungUp: true, now: T0 + 4 * H })
      recordPageError(slowKind, T0 + 4 * H + 1)
      flushUsage(T0 + 4 * H + 120_000)
      expect(seen).toEqual(['usage.http.slow GET /api/sessions/:sessionId/supervision'])
      const agg = readHours(0).find((r) => r.kind === 'http' && r.name === 'GET /api/sessions/:sessionId/supervision' && r.hour === T0 + 4 * H)!.agg
      expect(agg).toMatchObject({ calls: 2, slow: 1, msMax: 15_003 })
    } finally { off() }
    expect(judgeWatch(listWatches({}).find((w) => w.taskId === 't-page')!, T0 + 5 * H).state).not.toBe('failed')
  })

  it('reads Unknown when the server was not recording', () => {
    seed(25, 1_000)
    const w = newWatch({ taskId: 't1', targets: ['op:thread_update'], checks: {}, who: 'this task', checkAt: T0 + 48 * H, createdAt: T0 })
    expect(judgeWatch(w, T0 + 48 * H).state).toBe('unknown')
  })
})

function fakeDeps(over: Partial<RouteDeps> & { tasks?: Record<string, { title: string; project?: string; complete?: boolean }>; lead?: string | null; fail?: { n: number } } = {}) {
  const sent: Array<{ taskId: string; text: string; rowId: string }> = []
  const clock = { now: T0 }
  const tasks = over.tasks ?? {}
  const deps: RouteDeps = {
    enabled: async () => true,
    taskInfo: async (id) => (tasks[id] ? { id, title: tasks[id]!.title, ...(tasks[id]!.project ? { project: tasks[id]!.project } : {}), complete: !!tasks[id]!.complete } : null),
    leadOf: async () => (over.lead === null ? null : { id: over.lead ?? 'vp', title: 'Walnut VP' }),
    deliver: async (taskId, text, rowId) => {
      if (over.fail && over.fail.n > 0) { over.fail.n--; return { ok: false, detail: 'no session' } }
      sent.push({ taskId, text, rowId }); return { ok: true, detail: 'told' }
    },
    now: () => clock.now,
    ...over,
  }
  return { deps, sent, clock }
}

const cutAlarm = (since = T0) => ({ alarmId: 'usage.cut{op=thread_update}', since, title: 'A tool\'s answers get cut', kind: 'op' as const, name: 'thread_update', line: '1 confirmed cuts in the last 1 h.' })

describe('where an alarm goes', () => {
  it('to the open task whose armed watch names the target, the latest ship first', async () => {
    putWatch(newWatch({ taskId: 'old', targets: ['op:thread_update'], checks: {}, who: 'this task', shipAt: T0 - 5 * H, checkAt: T0 + 20 * H, createdAt: T0 - 5 * H }))
    putWatch(newWatch({ taskId: 'new', targets: ['op:thread_update'], checks: {}, who: 'this task', shipAt: T0 - H, checkAt: T0 + 20 * H, createdAt: T0 - H }))
    expect(armedWatchesFor('op', 'thread_update', T0).map((w) => w.taskId)).toEqual(['new', 'old'])
    const { deps, sent } = fakeDeps({ tasks: { new: { title: 'Threads: card summary' }, old: { title: 'Old' }, vp: { title: 'Walnut VP' } } })
    const r = await routeUsageAlarm(cutAlarm(), deps)
    expect(r).toMatchObject({ handled: true, delivered: true, taskId: 'new' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('your watch names op:thread_update')
  })

  it('a complete owner is never reopened: its lead hears it, named', async () => {
    putWatch(newWatch({ taskId: 'done', targets: ['op:thread_update'], checks: {}, who: 'this task', shipAt: T0 - H, checkAt: T0 + 20 * H, createdAt: T0 - H }))
    const { deps, sent } = fakeDeps({ tasks: { done: { title: 'Threads: card summary', complete: true }, vp: { title: 'Walnut VP' } } })
    const r = await routeUsageAlarm(cutAlarm(), deps)
    expect(r).toMatchObject({ handled: true, taskId: 'vp' })
    expect(sent[0]!.text).toContain('"Threads: card summary" (done) shipped op:thread_update')
    expect(sent[0]!.text).toContain('task_send force:true')
  })

  it('no watch: the Walnut project lead; no lead: the fix-task way', async () => {
    const a = fakeDeps({ tasks: { vp: { title: 'Walnut VP' } } })
    expect(await routeUsageAlarm(cutAlarm(), a.deps)).toMatchObject({ handled: true, taskId: 'vp' })
    expect(a.sent[0]!.text).toContain('No armed watch names op:thread_update')
    const b = fakeDeps({ lead: null })
    expect(await routeUsageAlarm({ ...cutAlarm(), alarmId: 'usage.cut{op=x}' }, b.deps)).toEqual({ handled: false, fallback: true, detail: 'no watch and no project lead to tell' })
  })

  it('off: recorded, nobody told', async () => {
    const { deps, sent } = fakeDeps({ enabled: async () => false })
    expect(await routeUsageAlarm(cutAlarm(), deps)).toMatchObject({ handled: false, fallback: false })
    expect(sent).toHaveLength(0)
  })

  it('the day\'s first note goes at once; later alarms wait 4 hours and go together; the same episode never twice', async () => {
    const { deps, sent, clock } = fakeDeps({ tasks: { vp: { title: 'Walnut VP' } } })
    await routeUsageAlarm(cutAlarm(), deps)
    await routeUsageAlarm(cutAlarm(), deps)
    expect(sent).toHaveLength(1)
    clock.now = T0 + 10 * 60_000
    const second = await routeUsageAlarm({ ...cutAlarm(clock.now), alarmId: 'usage.slow{route=GET /api/x}', kind: 'http', name: 'GET /api/x', title: 'Reads are slow' }, deps)
    expect(second).toMatchObject({ handled: true, delivered: false })
    expect(second.detail).toContain('queued for "Walnut VP"')
    await routeUsageAlarm({ ...cutAlarm(clock.now), alarmId: 'usage.errors{op=y}', name: 'y', title: 'A tool keeps failing' }, deps)
    await sendDueNotes(deps)
    expect(sent).toHaveLength(1)
    clock.now = T0 + BATCH_GAP_MS
    await sendDueNotes(deps)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.text).toContain('Real use: 2 alarms rang.')
    // A restart reads the rows again and sends nothing twice.
    closeUsageWatchStore()
    await sendDueNotes(deps)
    expect(sent).toHaveLength(2)
    expect(new Set(sent.map((s) => s.rowId)).size).toBe(2)
  })

  it('a failed send is tried again every 10 minutes, at most 6 times', async () => {
    const fail = { n: 10 }
    const { deps, clock } = fakeDeps({ tasks: { vp: { title: 'Walnut VP' } }, fail })
    const r = await routeUsageAlarm(cutAlarm(), deps)
    expect(r).toMatchObject({ handled: true, delivered: false })
    for (let i = 0; i < 8; i++) { clock.now += 10 * 60_000; await sendDueNotes(deps) }
    const [row] = _sendsForTesting()
    expect(row).toMatchObject({ state: 'failed', tries: 6 })
  })

  it('a send in flight is not sent twice, and an alarm meanwhile goes in a later note, never lost', async () => {
    const { deps, sent, clock } = fakeDeps({ tasks: { vp: { title: 'Walnut VP' } } })
    // The delivery waits: the minute tick and the Health route reach the same row meanwhile.
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const inDeliver = new Promise<void>((r) => { entered = r })
    const slow = { ...deps, deliver: async (...a: Parameters<typeof deps.deliver>) => { entered(); await gate; return deps.deliver(...a) } }
    const first = routeUsageAlarm(cutAlarm(), slow)
    await inDeliver
    await sendDueNotes(slow)
    const during = await routeUsageAlarm({ ...cutAlarm(clock.now), alarmId: 'usage.errors{op=y}', name: 'y', title: 'A tool keeps failing' }, slow)
    expect(during).toMatchObject({ handled: true, delivered: false })
    release()
    await first
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toContain('Real use: an alarm rang.')
    clock.now = T0 + BATCH_GAP_MS
    await sendDueNotes(deps)
    expect(sent).toHaveLength(2)
    expect(sent[1]!.text).toContain('A tool keeps failing: y.')
  })

  it('the note says what rang and what to do, with no content', () => {
    const text = noteText([{ key: 'k', title: 'A tool\'s answers get cut', name: 'thread_update', target: 'op:thread_update', line: '1 confirmed cuts in the last 1 h.', at: T0 }])
    expect(text).toContain('A tool\'s answers get cut: thread_update.')
    expect(text).toContain('at most one note every 4 hours')
  })
})

describe('ships and the completion check', () => {
  it('knows a ship command, and a failed one', () => {
    expect(shipOfCommand('cd x && ~/walnut-dev/bin/walnut-dev land')).toBe('walnut-dev land')
    expect(shipOfCommand('git push origin main')).toBe('a push to main')
    expect(shipOfCommand('git push origin wt/feature')).toBeNull()
    expect(shipOfCommand('npm publish --dry-run')).toBeNull()
    expect(shipOfCommand('walnut-cloud result 123')).toBeNull()
    // Only what a command runs counts, never a word it reads or writes (review, 2026-11-21).
    expect(shipOfCommand('grep -n "walnut-dev land" CLAUDE.local.md')).toBeNull()
    expect(shipOfCommand('git commit -m "Run deploy-committed.sh; then walnut-dev land"')).toBeNull()
    expect(shipOfCommand('echo walnut-dev land')).toBeNull()
    expect(shipOfCommand("python3 - <<'EOF'\nwalnut-dev land\nEOF")).toBeNull()
    expect(shipOfCommand('# walnut-dev land later\nls')).toBeNull()
    expect(shipOfCommand('bun run check && walnut-cloud land t1 --from x --queue')).toBe('walnut-cloud land')
    expect(shipOfCommand('timeout 7200 ~/walnut-dev/bin/walnut-dev land > out.txt 2>&1')).toBe('walnut-dev land')
    expect(shipOfCommand("bash -c 'cd /x && bash scripts/deploy-committed.sh'")).toBe('deploy-committed')
    // A ship a shell keyword opens (2026-11-24: these read as no ship before).
    expect(shipOfCommand('if walnut-dev land; then echo ok; fi')).toBe('walnut-dev land')
    expect(shipOfCommand('while ! walnut-cloud land t1 --queue; do sleep 60; done')).toBe('walnut-cloud land')
    expect(shipOfCommand('echo do walnut-dev land')).toBeNull()
    expect(shipOfCommand('git -C /repo push origin HEAD:main')).toBe('a push to main')
    expect(shipOfCommand('FOO=1 bun run dev:prod')).toBe('dev:prod')
    // A here-string or a quoted `<<` starts no heredoc: the land after it still counts.
    expect(shipOfCommand('cat <<< "$x"\nwalnut-dev land')).toBe('walnut-dev land')
    expect(shipOfCommand('git commit -m "a <<EOF"\nwalnut-dev land')).toBe('walnut-dev land')
    expect(shipOfCommand("cat <<'A' && cat <<B\nwalnut-dev land\nA\nwalnut-dev land\nB\nls")).toBeNull()
    expect(shipOfCommand('echo `walnut-dev land`')).toBe('walnut-dev land')
    expect(shipOfCommand('timeout -k 5 7200 walnut-dev land')).toBe('walnut-dev land')
    expect(shipOfCommand("ssh -p 22 mac 'walnut-cloud land t1 --queue'")).toBe('walnut-cloud land')
    expect(shipOfCommand("ssh mac 'walnut-cloud result 12'")).toBeNull()
    expect(shipFailed('Exit code 1\nrefused')).toBe(true)
    expect(shipFailed('Command running in background with ID: b1')).toBe(false)
    expect(shipFailed(' ! [rejected]        main -> main (fetch first)')).toBe(true)
    expect(shipFailed('landed abc123, deployed and pushed')).toBe(false)
  })

  const gate = (enabled = true, trigger = false) => ({ enabled: async () => enabled, triggerWatches: async () => trigger })

  it('a task that shipped completes only with a watch, an exemption, or a trigger aimed elsewhere', async () => {
    const now = Date.now()
    expect(await admitShipWatch({ id: 't1' }, gate())).toBeNull()
    recordShip({ taskId: 't1', key: 'tu1', at: now - 60_000, how: 'walnut-dev land', state: 'started' })
    const refused = await admitShipWatch({ id: 't1' }, gate())
    expect(refused?.code).toBe('no_real_use_watch')
    expect(refused?.message).toContain('usage_watch {"action":"set"')
    expect(await admitShipWatch({ id: 't1' }, gate(false))).toBeNull()
    const ctx = { callerTask: 't1', taskInfo: async (id: string) => ({ id, title: id, complete: false }) }
    // A trigger that is not aimed at another open task does not pass.
    await runUsageWatchAction({ action: 'set', trigger: 'job-1' }, ctx)
    expect(await admitShipWatch({ id: 't1' }, gate(true, false))).not.toBeNull()
    expect(await admitShipWatch({ id: 't1' }, gate(true, true))).toBeNull()
    await runUsageWatchAction({ action: 'set', targets: ['op:thread_update'], check_after: '24h' }, ctx)
    expect(await admitShipWatch({ id: 't1' }, gate(true, false))).toBeNull()
  })

  it('an exemption needs a kind and a reason; a failed watch holds the task', async () => {
    const now = Date.now()
    recordShip({ taskId: 't2', key: 'tu2', at: now - 60_000, how: 'npm publish', state: 'done' })
    const ctx = { callerTask: 't2', taskInfo: async (id: string) => ({ id, title: id, complete: false }) }
    await expect(runUsageWatchAction({ action: 'exempt', kind: 'copy', reason: 'short' }, ctx)).rejects.toThrow('20 to 500')
    await runUsageWatchAction({ action: 'exempt', kind: 'copy', reason: 'Only two button labels changed, no behaviour.' }, ctx)
    expect(await admitShipWatch({ id: 't2' }, gate())).toBeNull()
    // A ship watched outside Walnut (another repo's pipeline alarm) is an exemption of its own kind.
    recordShip({ taskId: 't5', key: 'tu5', at: now - 60_000, how: 'git push main', state: 'done' })
    const ctx5 = { ...ctx, callerTask: 't5' }
    await expect(runUsageWatchAction({ action: 'exempt', kind: 'elsewhere', reason: 'The pipeline alarm watches it daily.' }, ctx5)).rejects.toThrow('watched_elsewhere')
    await runUsageWatchAction({ action: 'exempt', kind: 'watched_elsewhere', reason: 'The service pipeline alarm on 5xx watches it; its owner reads it daily.' }, ctx5)
    expect(await admitShipWatch({ id: 't5' }, gate())).toBeNull()
    recordShip({ taskId: 't3', key: 'tu3', at: now - 60_000, how: 'walnut-dev land', state: 'done' })
    putWatch({ ...newWatch({ taskId: 't3', targets: ['op:x'], checks: {}, who: 'this task', checkAt: now + 2 * H, createdAt: now }), state: 'failed', result: [{ target: 'op:x', uses: 30, ok: false, notes: ['largest answer 30,000 over 20,000'] }] })
    expect((await admitShipWatch({ id: 't3' }, gate()))?.message).toContain('failed: op:x: largest answer 30,000 over 20,000')
  })

  it('a shipped task closed by someone else with no watch is recorded once as a gap, which lets nothing through', async () => {
    const now = Date.now()
    expect(noteClosedUnwatched('t6', now)).toBeNull()
    recordShip({ taskId: 't6', key: 'tu6', at: now - 60_000, how: 'walnut-dev land', state: 'done' })
    expect(noteClosedUnwatched('t6', now)?.state).toBe('unwatched')
    expect(noteClosedUnwatched('t6', now + 1_000)).toBeNull()
    expect(listWatches({ taskId: 't6' }).map((w) => w.state)).toEqual(['unwatched'])
    // Reopened, its own session's close is still asked for a watch.
    expect(await admitShipWatch({ id: 't6' }, gate())).not.toBeNull()
    // An exempted ship has no gap to record.
    recordShip({ taskId: 't7', key: 'tu7', at: now - 60_000, how: 'npm publish', state: 'done' })
    putWatch(newWatch({ taskId: 't7', targets: [], checks: {}, who: 'this task', checkAt: now, createdAt: now, state: 'exempt', exempt: { kind: 'docs', reason: 'Only the README changed, nothing runs.' } }))
    expect(noteClosedUnwatched('t7', now)).toBeNull()
  })

  it('refuses a target it cannot watch and a who that is not an open task', async () => {
    const ctx = { callerTask: 't4', taskInfo: async (id: string) => (id === 'gone' ? null : { id, title: id, complete: id === 'closed' }) }
    await expect(runUsageWatchAction({ action: 'set', targets: ['thread_update'] }, ctx)).rejects.toThrow('is not a target')
    await expect(runUsageWatchAction({ action: 'set', targets: ['op:x'], who: 'closed' }, ctx)).rejects.toThrow('is complete')
    await expect(runUsageWatchAction({ action: 'set', targets: ['op:x'], check_after: '20m' }, ctx)).rejects.toThrow('1h to 14d')
    expect(listWatches({ taskId: 't4' })).toEqual([])
  })
})

describe('every task\'s own close after a ship meets the check (class test)', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const src = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8')

  it('the check sits in the one gate every session close goes through, after its early passes', () => {
    const gate = src('src/core/sessions/owed-to-user.ts')
    const body = gate.slice(gate.indexOf('export async function admitSessionClose'))
    const at = body.indexOf('admitShipWatch(')
    expect(at).toBeGreaterThan(0)
    // Before what the user is owed (a refusal there would hide the missing watch) and only for a session caller.
    expect(at).toBeLessThan(body.indexOf('await owedToUser('))
    expect(at).toBeGreaterThan(body.indexOf('if (!closer || !callerSid)'))
    // In its own session's close (a lead closing its subtask decides that itself; tests/e2e/ship-watch-close.test.ts).
    expect(at).toBeGreaterThan(body.indexOf('if (closer.taskId === task.id && !opts.replayed) {'))
    expect(body.indexOf('if (closer.taskId === task.id && !opts.replayed) {')).toBeGreaterThan(0)
  })

  it('every kind of task is either checked or passes for a named reason', () => {
    // The org roles a task can hold (src/core/types.ts OrgRole): Main and a lead never do work
    // themselves (CLAUDE.md "Main and every VP never do the work themselves"), so they pass early.
    const roles = /export type OrgRole = ([^;]+);/.exec(src('src/core/types.ts'))![1]!.match(/'([a-z_-]+)'/g)!.map((r) => r.slice(1, -1))
    const PASSES: Record<string, string> = { main: 'never ships work itself', lead: 'never ships work itself' }
    const gate = src('src/core/sessions/owed-to-user.ts')
    const early = /task\.org_role === '(\w+)'/g
    const passing = new Set([...gate.slice(gate.indexOf('export async function admitSessionClose')).matchAll(early)].map((m) => m[1]!))
    for (const role of roles) {
      if (PASSES[role]) expect(passing.has(role), `${role} passes early`).toBe(true)
      else expect(passing.has(role), `a task with org role "${role}" that ships must meet the real-use check: classify it here`).toBe(false)
    }
    // A new early pass in the gate (another kind of task let through) must be named here too.
    for (const p of passing) expect(PASSES[p], `admitSessionClose lets "${p}" through: name why it needs no real-use watch`).toBeTruthy()
  })
})

describe('the session hook', () => {
  it('counts a Walnut tool answer Claude Code cut, matched by the call id', async () => {
    const { realUseHook, _resetRealUseHookForTesting } = await import('../../../src/core/usage-watch/session-hook.js')
    _resetRealUseHookForTesting()
    const use = (toolName: string, toolUseId: string, input: Record<string, unknown>) =>
      realUseHook.handler!({ taskId: 'tk', sessionId: 's1', toolName, toolUseId, input } as never)
    const result = (toolUseId: string, text: string) => realUseHook.handler!({ taskId: 'tk', sessionId: 's1', toolUseId, result: text } as never)
    await use('mcp__walnut__thread_update', 'u1', {})
    await use('mcp__walnut__task_get', 'u2', {})
    await result('u2', '{"ok":true}')
    await result('u1', 'Error: result (27,446 characters across 178 lines) exceeds maximum allowed tokens. Output has been saved to /x.txt')
    // An answer of some other tool that was cut is not a Walnut tool's.
    await use('mcp__other__read', 'u3', {})
    await result('u3', 'Error: result (90,000 characters across 9 lines) exceeds maximum allowed tokens.')
    flushUsage(Date.now() + 60_000)
    const rows = readHours(0, { kind: 'op' })
    expect(rows.map((r) => [r.name, r.agg.cut])).toEqual([['thread_update', 1]])
    expect(readEvents({ since: 0 })[0]).toMatchObject({ problem: 'cut', chars: 27_446, code: 'cut_mcp' })
  })

  it('notes a ship when the session runs one, and drops it when the result shows it failed', async () => {
    const { realUseHook, _resetRealUseHookForTesting } = await import('../../../src/core/usage-watch/session-hook.js')
    const { lastShipOf } = await import('../../../src/core/usage-watch/ships.js')
    _resetRealUseHookForTesting()
    await realUseHook.handler!({ taskId: 'tk', sessionId: 's1', toolName: 'Bash', toolUseId: 'b1', input: { command: 'git push origin main' } } as never)
    expect(lastShipOf('tk')?.how).toBe('a push to main')
    await realUseHook.handler!({ taskId: 'tk', sessionId: 's1', toolUseId: 'b1', result: 'Exit code 1\n ! [rejected] main -> main (fetch first)' } as never)
    expect(lastShipOf('tk')).toBeNull()
    await realUseHook.handler!({ taskId: 'tk', sessionId: 's1', toolName: 'Bash', toolUseId: 'b2', input: { command: '~/walnut-dev/bin/walnut-dev land' } } as never)
    await realUseHook.handler!({ taskId: 'tk', sessionId: 's1', toolUseId: 'b2', result: 'Command running in background with ID: x1' } as never)
    expect(lastShipOf('tk')?.how).toBe('walnut-dev land')
  })
})
