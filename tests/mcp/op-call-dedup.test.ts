/**
 * An op call's id (src/lib/op-call-id.ts) through the real executor, the op-call registry
 * and the op-id middleware with its ledger, against a stub API.
 *
 * 2026-11-04: task_send answered `hub_timeout` while its message was delivered, so the
 * caller could only send it again (two copies) or believe it lost. A call id makes a
 * resend run once, in this process (op-calls.ts) and across a restart (each write's
 * op id, kept in the applied-ops ledger), and lets op_result read what the call did.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-op-call-dedup'))

import express from 'express'
import { WALNUT_HOME } from '../../src/constants.js'
import { executeOp } from '../../src/ops/index.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { opIdMiddleware } from '../../src/web/middleware/op-id.js'
import { _setLedgerFileForTesting } from '../../src/core/offline-merge/ledger.js'
import { _heldBytesForTesting, _resetOpCallsForTesting, runOnce } from '../../src/ops/op-calls.js'
import { defineOp } from '../../src/ops/registry.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { z } from 'zod'
import { opCallsV1Router } from '../../src/web/routes/op-calls-v1.js'
import {
  CALL_ID_RE, callIdFor, lostCallDetail, lostCallLines, newCallId, takeCallIdArg, writeOpId,
} from '../../src/lib/op-call-id.js'

let server: http.Server
let apiBase: string
/** Every request the stub API saw: route, op id header, body. */
let seen: Array<{ route: string; opId?: string; body: unknown }>
/** When set, the next POST /messages is held this long before it answers. */
let holdMs = 0
/** When set, the next POST /messages drops its connection after it applied (a lost answer). */
let dropNext = false
let sent = 0
let notes: string[] = []
/** The stub note for note_edit, and how often its PUT applied. */
let noteText = ''
let notePuts = 0
/** Per row: how the next PATCH /api/v1/probe-rows/:id answers. */
let rowAnswers: Record<string, number[]> = {}
let rowPatches: string[] = []
let secretUses = 0
/** When set, the next request to this path drops its answer after it applied. */
let dropPath = ''
/** When set, the next POST /messages sends its headers and then breaks its body. */
let cutBody = false

// Test ops: a bulk handler that catches each row's failure, and a write answering a secret.
defineOp({
  name: 'test_probe_bulk',
  title: 'probe', description: 'probe',
  input: { ids: z.array(z.string()) },
  handler: async (args, call) => {
    const rows = []
    for (const id of args.ids as string[]) {
      try { await call('PATCH', `/probe-rows/${id}`, {}); rows.push({ id, ok: true }) } catch (err) { rows.push({ id, ok: false, error: String(err) }) }
    }
    return { changed: rows.filter((r) => r.ok).length, failed: rows.filter((r) => !r.ok).length, rows }
  },
  tags: { readonly: false, remote: 'allow' },
})
defineOp({
  name: 'test_probe_secret',
  title: 'probe', description: 'probe',
  input: { item: z.string() },
  bind: { method: 'POST', path: '/probe-secret' },
  tags: { readonly: false, remote: 'allow' },
})

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _setLedgerFileForTesting(path.join(WALNUT_HOME, 'applied-ops.sqlite'))
  _resetOpCallsForTesting()
  seen = []
  holdMs = 0
  dropNext = false
  sent = 0
  notes = []
  noteText = 'alpha beta'
  notePuts = 0
  rowAnswers = {}
  rowPatches = []
  secretUses = 0
  dropPath = ''
  cutBody = false
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    seen.push({ route: `${req.method} ${req.path}`, opId: req.headers['x-walnut-op-id'] as string | undefined, body: req.body })
    next()
  })
  // Applied and answered here (the middleware records it), but the answer never reaches the
  // caller: what a timeout or a dropped link does to it. Mounted before the middleware, so its
  // capture of the answer sits on top of this end and still sees it.
  app.use((req, res, next) => {
    if (dropNext && req.method === 'POST' && req.path === '/api/v1/messages') {
      dropNext = false
      res.end = (() => { req.socket.destroy(); return res }) as typeof res.end
    }
    // The headers go out, then the connection breaks before the body. (A reset before any
    // header is sent again by fetch itself for a PUT, which the ledger answers.)
    if ((cutBody && req.method === 'POST' && req.path === '/api/v1/messages') || (dropPath && req.path === dropPath && req.method !== 'GET')) {
      cutBody = false
      dropPath = ''
      res.end = (() => {
        res.writeHead(202, { 'content-type': 'application/json', 'content-length': '500' })
        res.write('{"delivery":"qu')
        setTimeout(() => req.socket.destroy(), 20)
        return res
      }) as typeof res.end
    }
    next()
  })
  app.use('/api', opIdMiddleware())
  app.post('/api/v1/messages', async (req, res) => {
    sent += 1
    const n = sent
    if (holdMs) { const ms = holdMs; holdMs = 0; await new Promise((r) => setTimeout(r, ms)) }
    res.status(202).json({ delivery: 'queued', messageId: `qm-${n}`, requestId: `rq-${String(n).padStart(6, 'a')}`, targetTaskId: req.body.to })
  })
  app.get('/api/tasks/:id', (req, res) => { res.json({ task: { id: req.params.id, title: 'T', phase: 'TODO' } }) })
  app.post('/api/tasks/:id/notes', (req, res) => {
    notes.push(String(req.body.content))
    res.json({ task: { id: req.params.id, title: 'T', note: notes.join('\n') } })
  })
  app.get('/api/v1/notes/content/:p', (req, res) => { res.json({ path: req.params.p, content: noteText, contentHash: `h${noteText.length}` }) })
  app.put('/api/v1/notes/content/:p', (req, res) => {
    notePuts += 1
    noteText = String(req.body.content)
    res.json({ path: req.params.p, contentHash: `h${noteText.length}` })
  })
  app.patch('/api/v1/probe-rows/:id', (req, res) => {
    rowPatches.push(req.params.id)
    const status = rowAnswers[req.params.id]?.shift() ?? 200
    res.status(status).json(status < 400 ? { id: req.params.id } : { error: { code: 'busy', message: 'try again' } })
  })
  app.post('/api/v1/probe-secret', (_req, res) => { secretUses += 1; res.json({ item: 'x', password: `p-${secretUses}` }) })
  app.use('/api/v1', opCallsV1Router)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  apiBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  _setLedgerFileForTesting(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

const run = (name: string, args: Record<string, unknown>, callId?: string) =>
  executeOp(name, args, { apiBase, origin: LOCAL_ORIGIN, ...(callId ? { callId } : {}) })

describe('call ids (src/lib/op-call-id.ts)', () => {
  it('mints ids the server accepts, takes a caller-given one out of the arguments, refuses a bad one', () => {
    const id = newCallId()
    expect(id).toMatch(CALL_ID_RE)
    const args: Record<string, unknown> = { to: 't', _call_id: id }
    expect(takeCallIdArg(args)).toEqual({ callId: id })
    expect(args).toEqual({ to: 't' })
    expect(callIdFor({ _call_id: 'nope' }).bad).toMatch(/_call_id must be/)
    expect(callIdFor({}).callId).toMatch(CALL_ID_RE)
  })

  it('derives one op id per write, keyed by route and order, within the middleware limit of 80', () => {
    const id = `oc-${'x'.repeat(48)}`
    const a = writeOpId(id, 'POST', '/messages?x=1', 0)
    expect(a.length).toBeLessThanOrEqual(80)
    expect(writeOpId(id, 'POST', '/messages', 999).length).toBeLessThanOrEqual(80)
    // Two ids that differ only at the end never share a write's op id.
    expect(writeOpId(`oc-${'x'.repeat(47)}y`, 'POST', '/messages', 0)).not.toBe(a)
    expect(CALL_ID_RE.test(`oc-${'x'.repeat(49)}`)).toBe(false)
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,80}$/)
    expect(writeOpId(id, 'POST', '/messages', 0)).toBe(a)
    expect(writeOpId(id, 'POST', '/messages', 1)).not.toBe(a)
    expect(writeOpId(id, 'PUT', '/messages', 0)).not.toBe(a)
  })

  it('a lost answer names the call, how to read it and how to run it again safely, on stderr and stdout', () => {
    const lines = lostCallLines('task_send', { to: 'abc', text: 'hi' }, 'oc-12345678')
    expect(lines.join('\n')).toContain(`walnut tools call op_result '{"call_id":"oc-12345678"}'`)
    expect(lines.join('\n')).toContain(`"_call_id":"oc-12345678"`)
    expect(lostCallDetail('task_send', 'oc-12345678')).toMatchObject({ call_id: 'oc-12345678', state: 'unknown' })
  })
})

describe('a write call runs at most once per call id', () => {
  it('task_send twice under one id: one message, the same answer, and op_result reads it', async () => {
    const callId = newCallId()
    const first = await run('task_send', { to: 'task-a', text: 'hello', expect_reply: false }, callId)
    expect(first.ok).toBe(true)
    const again = await run('task_send', { to: 'task-a', text: 'hello', expect_reply: false }, callId)
    expect(again).toEqual(first)
    expect(sent).toBe(1)
    expect(seen.filter((s) => s.route === 'POST /api/v1/messages').map((s) => s.opId)).toEqual([writeOpId(callId, 'POST', '/messages', 0)])
    const read = await run('op_result', { call_id: callId })
    expect(read.ok).toBe(true)
    expect(read.ok && read.result).toMatchObject({ call_id: callId, state: 'done', op: 'task_send', ok: true, repeats: 1 })
    expect(read.ok && (read.result as { result: { messageId: string } }).result.messageId).toBe('qm-1')
  })

  it('a copy arriving while the first still runs waits for it and runs nothing', async () => {
    const callId = newCallId()
    holdMs = 300
    const [a, b] = await Promise.all([
      run('task_send', { to: 'task-a', text: 'x', expect_reply: false }, callId),
      run('task_send', { to: 'task-a', text: 'x', expect_reply: false }, callId),
    ])
    expect(a).toEqual(b)
    expect(sent).toBe(1)
  })

  it('after a restart (no call in memory) the ledger still answers the first write instead of applying it again', async () => {
    const callId = newCallId()
    const first = await run('task_send', { to: 'task-a', text: 'once', expect_reply: false }, callId)
    _resetOpCallsForTesting()
    const read = await run('op_result', { call_id: callId })
    expect(read.ok && read.result).toMatchObject({ state: 'applied', writes: [{ route: 'POST /api/v1/messages', status: 202, outcome: 'applied' }] })
    const again = await run('task_send', { to: 'task-a', text: 'once', expect_reply: false }, callId)
    expect(sent).toBe(1)
    expect(again.ok && (again.result as { messageId: string }).messageId).toBe(first.ok && (first.result as { messageId: string }).messageId)
  })

  it('an answer lost on the way (the connection dropped after the write applied): a re-run applies nothing twice', async () => {
    const callId = newCallId()
    dropNext = true
    const lost = await run('task_send', { to: 'task-a', text: 'maybe', expect_reply: false }, callId)
    expect(lost.ok).toBe(false)
    expect(!lost.ok && (lost.lost || lost.unreachable)).toBe(true)
    const read = await run('op_result', { call_id: callId })
    expect(read.ok && read.result).toMatchObject({ state: 'lost', op: 'task_send', writes: [{ route: 'POST /api/v1/messages', status: 202 }] })
    // The re-run's write meets the same op id: the ledger answers the first answer.
    const again = await run('task_send', { to: 'task-a', text: 'maybe', expect_reply: false }, callId)
    expect(again.ok).toBe(true)
    expect(again.ok && (again.result as { messageId: string }).messageId).toBe('qm-1')
    expect(sent).toBe(1)
    const ids = seen.filter((s) => s.route === 'POST /api/v1/messages').map((s) => s.opId)
    expect(new Set(ids)).toEqual(new Set([writeOpId(callId, 'POST', '/messages', 0)]))
  })

  it('a caller re-running a lost call passes "_call_id" in the arguments; the op never sees it', async () => {
    const callId = newCallId()
    await run('task_send', { to: 'task-a', text: 'via arg', expect_reply: false, _call_id: callId })
    await run('task_send', { to: 'task-a', text: 'via arg', expect_reply: false, _call_id: callId })
    expect(sent).toBe(1)
    const body = seen.find((s) => s.route === 'POST /api/v1/messages')!.body as Record<string, unknown>
    expect(body).not.toHaveProperty('_call_id')
    const bad = await run('task_send', { to: 'task-a', text: 'x', _call_id: 'oc-!' })
    expect(bad.ok).toBe(false)
    expect(sent).toBe(1)
  })

  it('the same id for another call is refused and runs nothing', async () => {
    const callId = newCallId()
    await run('task_send', { to: 'task-a', text: 'one', expect_reply: false }, callId)
    const other = await run('task_send', { to: 'task-a', text: 'two', expect_reply: false }, callId)
    expect(other.ok).toBe(false)
    expect(!other.ok && other.message).toMatch(/already used for this op with other arguments/)
    expect(sent).toBe(1)
  })

  it('a handler op (task_note_write) carries the op id on its write too', async () => {
    const callId = newCallId()
    await run('task_note_write', { id: 'task-a', content: 'entry', mode: 'append' }, callId)
    _resetOpCallsForTesting()
    await run('task_note_write', { id: 'task-a', content: 'entry', mode: 'append' }, callId)
    expect(notes).toEqual(['entry'])
    expect(seen.find((s) => s.route === 'POST /api/tasks/task-a/notes')?.opId).toBe(writeOpId(callId, 'POST', '/api/tasks/task-a/notes', 0))
  })

  it('a read runs every time and carries no op id; a call with no id is as before', async () => {
    const callId = newCallId()
    await run('task_get', { id: 'task-a' }, callId)
    await run('task_get', { id: 'task-a' }, callId)
    const reads = seen.filter((s) => s.route === 'GET /api/tasks/task-a')
    expect(reads).toHaveLength(2)
    expect(reads.every((r) => r.opId === undefined)).toBe(true)
    await run('task_send', { to: 'task-a', text: 'plain', expect_reply: false })
    await run('task_send', { to: 'task-a', text: 'plain', expect_reply: false })
    expect(sent).toBe(2)
  })

  it('op_result of an id this server never saw says unknown: nothing was written', async () => {
    const read = await run('op_result', { call_id: newCallId() })
    expect(read.ok && read.result).toMatchObject({ state: 'unknown', writes: [] })
    expect(read.ok && (read.result as { outcome: string }).outcome).toMatch(/no record of the call/)
  })
})

describe('runOnce (src/ops/op-calls.ts)', () => {
  it('a run that threw settles as a failure and is kept for a copy', async () => {
    let runs = 0
    const boom = () => { runs += 1; return Promise.reject(new Error('boom')) }
    const a = await runOnce('oc-aaaaaaaa1', 'x', {}, undefined, boom)
    const b = await runOnce('oc-aaaaaaaa1', 'x', {}, undefined, boom)
    expect(a).toEqual({ ok: false, message: 'boom' })
    expect(b).toEqual(a)
    expect(runs).toBe(1)
  })

  it('a lost outcome is not replayed: the next copy runs again', async () => {
    let runs = 0
    const lost = () => { runs += 1; return Promise.resolve({ ok: false as const, message: 'timed out', lost: true as const }) }
    await runOnce('oc-aaaaaaaa2', 'x', {}, undefined, lost)
    await runOnce('oc-aaaaaaaa2', 'x', {}, undefined, lost)
    expect(runs).toBe(2)
  })
})

describe('what the review of the first version found', () => {
  const runAs = (sid: string, name: string, args: Record<string, unknown>, callId: string) =>
    executeOp(name, args, { apiBase, origin: LOCAL_ORIGIN, callId, callerSid: sid })

  it('an answer holding a secret is never kept: a copy goes through the route again, and op_result does not show it', async () => {
    const callId = newCallId()
    const first = await runAs('sid-a', 'test_probe_secret', { item: 'x' }, callId)
    expect(first.ok && (first.result as { password: string }).password).toBe('p-1')
    const read = await executeOp('op_result', { call_id: callId }, { apiBase, origin: LOCAL_ORIGIN, callerSid: 'sid-a' })
    expect(JSON.stringify(read)).not.toContain('p-1')
    expect(read.ok && read.result).toMatchObject({ state: 'done', not_kept: expect.stringMatching(/secret/) })
    // The copy is not handed the kept answer: it goes to the route again (here the ledger,
    // which keeps no secret either, answers its status; a vault route the ledger skips runs again).
    const again = await runAs('sid-a', 'test_probe_secret', { item: 'x' }, callId)
    expect(JSON.stringify(again)).not.toContain('p-1')
  })

  it('a copy from another session under the same id is refused, and its op_result withholds the answer', async () => {
    const callId = newCallId()
    await runAs('sid-a', 'task_send', { to: 'task-a', text: 'mine', expect_reply: false }, callId)
    const other = await runAs('sid-b', 'task_send', { to: 'task-a', text: 'mine', expect_reply: false }, callId)
    expect(other.ok).toBe(false)
    expect(!other.ok && other.message).toMatch(/another session/)
    expect(sent).toBe(1)
    const read = await executeOp('op_result', { call_id: callId }, { apiBase, origin: LOCAL_ORIGIN, callerSid: 'sid-b' })
    expect(read.ok && read.result).toMatchObject({ state: 'done', answer_withheld: expect.any(String) })
    expect(read.ok && (read.result as Record<string, unknown>).result).toBeUndefined()
  })

  it('headers that came with a body cut short are a lost answer, never a kept success', async () => {
    const callId = newCallId()
    cutBody = true
    const lost = await run('task_send', { to: 'task-a', text: 'cut', expect_reply: false }, callId)
    expect(lost.ok).toBe(false)
    expect(!lost.ok && lost.lost).toBe(true)
    const again = await run('task_send', { to: 'task-a', text: 'cut', expect_reply: false }, callId)
    expect(again.ok && (again.result as { messageId: string }).messageId).toBe('qm-1')
    expect(sent).toBe(1)
  })

  it('a handler that caught a row refused for now answers ok, and a copy runs the row again (the done row is not repeated)', async () => {
    const callId = newCallId()
    rowAnswers = { r2: [503] }
    const first = await run('test_probe_bulk', { ids: ['r1', 'r2'] }, callId)
    expect(first.ok && first.result).toMatchObject({ changed: 1, failed: 1 })
    const again = await run('test_probe_bulk', { ids: ['r1', 'r2'] }, callId)
    expect(again.ok && again.result).toMatchObject({ changed: 2, failed: 0 })
    // r1 applied once (the ledger answered the copy); r2 ran twice, its 503 changed nothing.
    expect(rowPatches.filter((r) => r === 'r1')).toHaveLength(1)
    expect(rowPatches.filter((r) => r === 'r2')).toHaveLength(2)
  })

  it('a re-run whose handler stops before its write says the first try already applied it (note_edit)', async () => {
    const callId = newCallId()
    dropPath = '/api/v1/notes/content/a.md'
    const lost = await run('note_edit', { path: 'a.md', old_str: 'alpha', new_str: 'omega' }, callId)
    expect(lost.ok).toBe(false)
    expect(noteText).toBe('omega beta')
    const again = await run('note_edit', { path: 'a.md', old_str: 'alpha', new_str: 'omega' }, callId)
    expect(again.ok).toBe(false)
    expect(!again.ok && again.message).toMatch(/already applied PUT \/api\/v1\/notes\/content\/a\.md \(200\)/)
    expect(!again.ok && again.message).toMatch(/Do not run it again/)
    expect(notePuts).toBe(1)
  })

  it('a too-large answer is not held (in the record or a settled promise), and a copy runs again', async () => {
    let runs = 0
    const big = () => { runs += 1; return Promise.resolve({ ok: true as const, result: 'x'.repeat(300 * 1024) }) }
    await runOnce('oc-bigbigbig1', 'x', {}, undefined, big)
    expect(_heldBytesForTesting()).toBe(0)
    await runOnce('oc-bigbigbig1', 'x', {}, undefined, big)
    expect(runs).toBe(2)
  })

  it('through the gateway, the server\'s own lost write reaches the caller as hub_timeout, so its client names the call', async () => {
    const saved = process.env.OPEN_WALNUT_API_URL
    process.env.OPEN_WALNUT_API_URL = apiBase
    try {
      dropNext = true
      const r = await handleGatewayCapability('tools.call', 'sid-gw', { name: 'task_send', args: { to: 'task-a', text: 'gw', expect_reply: false }, callId: newCallId() }, '__local__', { throttle: new PeerThrottle(), cloudMode: false })
      expect(r).toMatchObject({ ok: false, error: { code: 'hub_timeout' } })
    } finally {
      if (saved === undefined) delete process.env.OPEN_WALNUT_API_URL; else process.env.OPEN_WALNUT_API_URL = saved
    }
  })
})
