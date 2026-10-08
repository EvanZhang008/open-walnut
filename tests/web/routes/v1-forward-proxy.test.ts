/**
 * The companion's half of the forward (src/web/v1-forward/proxy.ts), with a
 * real Express app: the middleware in front of a stand-in for the companion's
 * own routes, and a stand-in for the bridge call to the Mac.
 *
 * The decision table it pins:
 *   - the Mac answers (bridge, fresh heartbeat, not led, allowed): forwarded,
 *     the Mac's status, headers and body as they came;
 *   - a route the companion keeps, the Mac silent or unheard, the companion
 *     leading, the user not allowing it, the forward turned off: answered here,
 *     the Mac never asked;
 *   - the Mac refused before running it, or the call never left: answered here;
 *   - an old Mac: answered here, and not asked again for a while;
 *   - sent and unanswered: a read is answered here and the Mac is not asked again
 *     until it is heard; a write is a 504 that says it may have been applied;
 *   - a reply too large to carry: a read is answered here; a write says it was applied.
 */
import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createV1Forward, macAnswers, type CallOutcome, type PrimarySnapshot } from '../../../src/web/v1-forward/proxy.js'

const NOW = 1_800_000_000_000

function fresh(over: Partial<PrimarySnapshot> = {}): PrimarySnapshot {
  return { bridge: true, heard: true, lastSeenAt: NOW - 5_000, leading: 0, backupAllowed: true, takeoverMs: 60_000, ...over }
}

const reply = (status: number, value: unknown, headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' }): CallOutcome => {
  const buf = Buffer.from(JSON.stringify(value))
  return { ok: true, result: { status, headers, size: buf.byteLength, data: buf.toString('base64') } }
}

function harness(opts: { primary?: () => PrimarySnapshot | null; call?: (p: Record<string, unknown>, t: number) => Promise<CallOutcome>; enabled?: boolean; ownToken?: string } = {}) {
  let now = NOW
  const calls: Array<{ params: Record<string, unknown>; timeoutMs: number }> = []
  const fwd = createV1Forward({
    now: () => now,
    enabled: () => opts.enabled !== false,
    ownCall: (req) => opts.ownToken !== undefined && req.headers.authorization === `Bearer ${opts.ownToken}`,
    // By default the Mac was heard moments ago, whatever the clock says.
    primary: async () => (opts.primary ? opts.primary() : fresh({ lastSeenAt: now - 5_000 })),
    call: async (params, timeoutMs) => {
      calls.push({ params, timeoutMs })
      return opts.call ? opts.call(params, timeoutMs) : reply(200, { from: 'mac' })
    },
  })
  const app = express()
  app.use(express.json())
  app.use('/api/v1', fwd.middleware)
  // The companion's own routes.
  app.all('/api/v1/*rest', (req, res) => { res.status(200).json({ from: 'companion', path: req.path }) })
  return { app, fwd, calls, advance: (ms: number) => { now += ms } }
}

describe('macAnswers', () => {
  it.each([
    ['no snapshot', null, 'no-leader'],
    ['no bridge', fresh({ bridge: false }), 'no-bridge'],
    ['never heard', fresh({ heard: false }), 'primary-unheard'],
    ['silent for three beats', fresh({ lastSeenAt: NOW - 46_000 }), 'primary-silent'],
    ['silent past a short takeover window', fresh({ lastSeenAt: NOW - 7_000, takeoverMs: 6_000 }), 'primary-silent'],
    ['the companion leads a host', fresh({ leading: 1 }), 'companion-leads'],
    ['the user does not allow it', fresh({ backupAllowed: false }), 'not-allowed'],
    ['no heartbeat said', fresh({ backupAllowed: null }), 'not-allowed'],
  ])('%s: %s', (_what, snapshot, why) => {
    expect(macAnswers(snapshot as PrimarySnapshot | null, NOW, 0, 0)).toBe(why)
  })

  it('a suspect Mac is asked again once it is heard after the failure', () => {
    expect(macAnswers(fresh({ lastSeenAt: NOW - 3_000 }), NOW, NOW - 2_000, 0)).toBe('primary-suspect')
    expect(macAnswers(fresh({ lastSeenAt: NOW - 1_000 }), NOW, NOW - 2_000, 0)).toBeNull()
  })

  it('away, for a route with a copy: no bridge, silent, suspect, or the companion leads; not when unknown', async () => {
    const away = async (snapshot: PrimarySnapshot | null, setup?: (h: ReturnType<typeof harness>) => Promise<void>) => {
      const h = harness({ primary: () => snapshot, call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'timed out', notSent: false } }) })
      if (setup) await setup(h)
      return h.fwd.primaryAway()
    }
    expect(await away(fresh({ bridge: false }))).toBe(true)
    expect(await away(fresh({ lastSeenAt: NOW - 120_000 }))).toBe(true)
    expect(await away(fresh({ leading: 1 }))).toBe(true)
    // A read went out and came back unanswered: away until the Mac is heard again.
    expect(await away(fresh({ lastSeenAt: NOW - 1_000 }), async (h) => { await request(h.app).get('/api/v1/usage/overview') })).toBe(true)
    // Unknown is not away: the route asks the Mac as it did.
    expect(await away(null)).toBe(false)
    expect(await away(fresh({ heard: false }))).toBe(false)
    // Up, whatever the forward itself may do.
    expect(await away(fresh())).toBe(false)
    expect(await away(fresh({ backupAllowed: false }))).toBe(false)
  })

  it('an old Mac rests until its time is up', () => {
    expect(macAnswers(fresh(), NOW, 0, NOW + 1)).toBe('primary-too-old')
    expect(macAnswers(fresh(), NOW, 0, NOW)).toBeNull()
  })
})

describe('the forward middleware', () => {
  it('forwards a call the companion does not keep, and sends the Mac\'s answer back as it came', async () => {
    const h = harness({ call: async () => reply(201, { ok: true, renamed: 'Acme2' }, { 'content-type': 'application/json', etag: '"e1"', 'x-walnut-api': '1' }) })
    const res = await request(h.app).patch('/api/v1/projects/Acme?x=1').set('Authorization', 'Bearer phone').send({ name: 'Acme2' })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ ok: true, renamed: 'Acme2' })
    expect(res.headers.etag).toBe('"e1"')
    expect(res.headers['x-walnut-api']).toBe('1')
    expect(res.headers['x-walnut-answered-by']).toBe('primary')
    expect(h.calls).toHaveLength(1)
    const p = h.calls[0].params
    expect(p).toMatchObject({ method: 'PATCH', url: '/api/v1/projects/Acme?x=1' })
    expect(JSON.parse(Buffer.from(String(p.data), 'base64').toString('utf8'))).toEqual({ name: 'Acme2' })
    expect(p.size).toBe(Buffer.byteLength(JSON.stringify({ name: 'Acme2' })))
    // No credential crosses.
    expect(JSON.stringify(p.headers)).not.toMatch(/phone|authorization/i)
    // A write waits longer than a read, and the Mac gives up first.
    expect(h.calls[0].timeoutMs).toBe(25_000)
    expect(p.timeoutMs).toBe(23_000)
    expect(h.fwd.status().forwarded).toBe(1)
  })

  it('a read waits less', async () => {
    const h = harness()
    await request(h.app).get('/api/v1/usage/overview')
    expect(h.calls[0].timeoutMs).toBe(8_000)
    expect(h.calls[0].params.data).toBeUndefined()
  })

  it('passes a 304 and a 204 through without a body', async () => {
    const h = harness({ call: async (p) => ({ ok: true, result: { status: String(p.url).endsWith('/usage/a') ? 304 : 204, headers: {}, size: 0, data: '' } }) })
    expect((await request(h.app).get('/api/v1/usage/a')).status).toBe(304)
    expect((await request(h.app).delete('/api/v1/routines/r1')).status).toBe(204)
  })

  it.each([
    ['a kept route', 'get', '/api/v1/tasks'],
    ['a stream', 'get', '/api/v1/events'],
    ['a send', 'post', '/api/v1/sessions/abc/messages'],
  ])('%s is answered here and the Mac never asked', async (_what, verb, path) => {
    const h = harness()
    const res = await (request(h.app) as unknown as Record<string, (p: string) => request.Test>)[verb](path)
    expect(res.body.from).toBe('companion')
    expect(res.headers['x-walnut-answered-by']).toBe('companion')
    expect(h.calls).toHaveLength(0)
  })

  it.each([
    ['the Mac is silent', () => fresh({ lastSeenAt: NOW - 60_000 }), 'primary-silent'],
    ['the companion leads', () => fresh({ leading: 2 }), 'companion-leads'],
    ['the user does not allow it', () => fresh({ backupAllowed: false }), 'not-allowed'],
    ['no bridge', () => fresh({ bridge: false }), 'no-bridge'],
  ])('%s: answered here', async (_what, primary, why) => {
    const h = harness({ primary })
    const res = await request(h.app).get('/api/v1/usage/overview')
    expect(res.body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
    expect(h.fwd.status().answeredHere[why]).toBe(1)
  })

  it('turned off: answered here', async () => {
    const h = harness({ enabled: false })
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
  })

  it('this server\'s own op call keeps its own path; a phone\'s goes to the Mac', async () => {
    const h = harness({ ownToken: 'self-token' })
    const own = await request(h.app).post('/api/v1/actions/invoke').set('Authorization', 'Bearer self-token').send({ tool: 'task_list' })
    expect(own.body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
    expect(h.fwd.status().answeredHere['own-call']).toBe(1)
    const phone = await request(h.app).post('/api/v1/actions/invoke').set('Authorization', 'Bearer phone').send({ tool: 'task_list' })
    expect(phone.body.from).toBe('mac')
  })

  it('a body that is not JSON stays here', async () => {
    const h = harness()
    const res = await request(h.app).post('/api/v1/memory/global').set('Content-Type', 'text/plain').send('hello')
    expect(res.body.from).toBe('companion')
    expect(h.calls).toHaveLength(0)
  })

  it('a refusal and a call that never left are answered here, writes included', async () => {
    const refused = harness({ call: async () => ({ ok: false, failure: { kind: 'error', status: 400, code: 'forward_refused', message: 'kept' } }) })
    expect((await request(refused.app).put('/api/v1/memory/global').send({ content: 'x' })).body.from).toBe('companion')
    const notSent = harness({ call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'no bridge', notSent: true } }) })
    expect((await request(notSent.app).put('/api/v1/memory/global').send({ content: 'x' })).body.from).toBe('companion')
    // Neither makes the Mac suspect: the next call is forwarded again.
    expect(notSent.fwd.status().suspectAt).toBeNull()
  })

  it('an old Mac is answered here and rests for ten minutes', async () => {
    const h = harness({ call: async () => ({ ok: false, failure: { kind: 'needs_upgrade', message: 'old' } }) })
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect(h.calls).toHaveLength(1)
    h.advance(10 * 60_000 + 1)
    await request(h.app).get('/api/v1/usage/overview')
    expect(h.calls).toHaveLength(2)
  })

  it('a read that went out unanswered is answered here, and the Mac is not asked again until it is heard', async () => {
    let lastSeenAt = NOW - 1_000
    const h = harness({
      primary: () => fresh({ lastSeenAt }),
      call: async () => ({ ok: false, failure: { kind: 'bridge_offline', message: 'timed out', notSent: false } }),
    })
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect((await request(h.app).get('/api/v1/usage/overview')).body.from).toBe('companion')
    expect(h.calls).toHaveLength(1)
    expect(h.fwd.status().answeredHere['primary-suspect']).toBe(1)
    // A heartbeat after the failure: asked again.
    h.advance(2_000)
    lastSeenAt = NOW + 1_000
    await request(h.app).get('/api/v1/usage/overview')
    expect(h.calls).toHaveLength(2)
  })

  it('a write that went out unanswered is a 504 that says it may have been applied, never run here', async () => {
    const h = harness({ call: async () => ({ ok: false, failure: { kind: 'error', status: 504, code: 'forward_failed', message: 'timed out' } }) })
    const res = await request(h.app).patch('/api/v1/projects/Acme').send({ name: 'B' })
    expect(res.status).toBe(504)
    expect(res.body.error.code).toBe('primary_timeout')
    expect(res.body.error.message).toMatch(/may have applied/)
    expect(res.body.from).toBeUndefined()
    expect(h.fwd.status().unanswered).toBe(1)
  })

  it('a reply too large to carry: a read is answered here, a write says it was applied', async () => {
    const h = harness({ call: async () => ({ ok: true, result: { status: 200, headers: {}, size: 300_000, tooLarge: true } }) })
    expect((await request(h.app).get('/api/v1/usage/recent')).body.from).toBe('companion')
    const w = await request(h.app).post('/api/v1/routines').send({ name: 'r' })
    expect(w.status).toBe(200)
    expect(w.body.from).toBeUndefined()
    expect(w.body.note).toMatch(/Applied on the Mac/)
    expect(w.headers['x-walnut-answered-by']).toBe('primary')
  })

  it('at most 16 reads are in flight; the next one is answered here', async () => {
    const releases: Array<() => void> = []
    const h = harness({ call: () => new Promise((resolve) => { releases.push(() => resolve(reply(200, { from: 'mac' }))) }) })
    const pending = Array.from({ length: 16 }, () => request(h.app).get('/api/v1/usage/overview').then((r) => r))
    while (releases.length < 16) await new Promise((r) => setTimeout(r, 5))
    const extra = await request(h.app).get('/api/v1/usage/overview')
    expect(extra.body.from).toBe('companion')
    for (const release of releases) release()
    const done = await Promise.all(pending)
    expect(done.every((r) => r.body.from === 'mac')).toBe(true)
    expect(h.fwd.status().answeredHere.busy).toBe(1)
  })
})
