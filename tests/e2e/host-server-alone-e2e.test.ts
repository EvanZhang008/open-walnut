/**
 * A host server answering alone, end to end (docs/plan/walnut-servers-everywhere.md,
 * "Host server, leader away"): real daemon twins, the real host server, a mock
 * CLI session, a stand-in Mac (tests/helpers/host-alone-harness.ts). No companion.
 *
 *   - while the Mac answers, /_alone/ says so and answers nothing else;
 *   - the Mac gone: the page names nothing; a browser whose token the Mac's copy
 *     names lists this Walnut's sessions here (lane sessions left out), reads a
 *     conversation, writes to the running one and answers its prompt; a stopped
 *     session, an unknown one, a token the copy does not name, are refused;
 *   - the Mac back: it drains the person's message from the journal, and the
 *     page's API answers 409 again;
 *   - the Mac asleep with its socket open (no frame at all from it): alone after
 *     the quiet window, on the page and in the daemon alike;
 *   - the daemon itself: a follower's write while a server answers is refused,
 *     and read-history reads only a session file of the follower's own Walnut.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  startHostAloneHarness, waitFor, tokenHash, BUN, HOME, WALNUT, LIVE, STOPPED, ASIDE, TOKEN, DEVICE,
  type HostAloneHarness,
} from '../helpers/host-alone-harness.js'

function call(port: number, method: string, pathname: string, opts: { token?: string; body?: unknown; accept?: string } = {}): Promise<{ status: number; body: string; json: Record<string, any>; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? null : Buffer.from(JSON.stringify(opts.body))
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname, agent: false,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.accept ? { accept: opts.accept } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        let json: Record<string, any> = {}
        try { json = JSON.parse(body) } catch { /* html */ }
        resolve({ status: res.statusCode ?? 0, body, json, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(data ?? undefined)
  })
}

/** A raw follower socket, as the host server's own (its token from the daemon's spec). */
async function followerSocket(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise((r) => ws.once('open', r))
  let id = 1
  const pending = new Map<number, (m: Record<string, any>) => void>()
  ws.on('message', (d) => { const m = JSON.parse(String(d)); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } })
  const ask = (body: Record<string, unknown>) => new Promise<Record<string, any>>((resolve) => { const my = id++; pending.set(my, resolve); ws.send(JSON.stringify({ id: my, ...body })) })
  const hello = await ask({ cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token })
  return { ws, ask, hello }
}

const twins: Array<'source' | 'standalone'> = BUN ? ['source', 'standalone'] : ['source']

describe.each(twins)('a host server answering alone (%s twin)', (twin) => {
  let h: HostAloneHarness
  let port = 0
  const sessionsOf = async () => (await call(port, 'GET', '/_alone/sessions', { token: TOKEN })).json.sessions as Array<Record<string, any>>

  beforeAll(async () => {
    h = await startHostAloneHarness({ twin })
    port = h.publicPort
  }, 180_000)

  afterAll(async () => { await h?.stop() }, 60_000)

  it('the Mac sends its device list; while it answers, /_alone/ answers only its state', async () => {
    const pushed = await h.pushDevices([{ name: DEVICE, tokenHash: tokenHash(TOKEN) }])
    expect(pushed).toMatchObject({ status: 200, json: { ok: true, devices: 1 } })
    // A malformed list changes nothing.
    expect((await h.pushDevices([{ name: '', tokenHash: 'nope' }])).status).toBe(400)
    const state = await call(port, 'GET', '/_alone/state', { token: TOKEN })
    expect(state.json).toEqual({ route: 'leader', label: 'devbox', auth: 'ok' })
    const list = await call(port, 'GET', '/_alone/sessions', { token: TOKEN })
    expect(list.status).toBe(409)
    expect(list.json.error.code).toBe('leader_answers')
    // The page itself is the Mac's.
    expect((await call(port, 'GET', '/', { accept: 'text/html' })).body).toContain('The Mac console')
  })

  it('the Mac gone: the page names nothing, and only a known token gets the sessions', async () => {
    h.unlinkMac()
    await waitFor(() => h.route() === 'alone', 15_000, 'alone')
    const page = await call(port, 'GET', '/', { accept: 'text/html' })
    expect(page.status).toBe(200)
    expect(page.body).toContain('data-why="mac-away"')
    expect(page.body).toContain('Walnut on devbox')
    for (const name of ['Fix the build', 'Old report', LIVE.slice(0, 8)]) expect(page.body).not.toContain(name)
    expect(page.headers['content-security-policy']).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/)
    expect(page.headers['content-security-policy']).toContain("connect-src 'self'")

    expect((await call(port, 'GET', '/_alone/state')).json).toMatchObject({ route: 'alone', why: 'mac-away', auth: 'no_token' })
    expect((await call(port, 'GET', '/_alone/state', { token: 'wrong' })).json.auth).toBe('unknown_token')
    expect((await call(port, 'GET', '/_alone/sessions')).status).toBe(401)
    expect((await call(port, 'GET', '/_alone/sessions', { token: 'wrong' })).status).toBe(401)
    // The rest of the API still says the leader is away.
    expect((await call(port, 'GET', '/api/tasks')).json.error.code).toBe('leader_away')

    const list = await call(port, 'GET', '/_alone/sessions', { token: TOKEN })
    expect(list.status).toBe(200)
    expect(list.json.host).toBe('devbox')
    const byId = Object.fromEntries((list.json.sessions as Array<Record<string, any>>).map((s) => [s.sid, s]))
    expect(Object.keys(byId).sort()).toEqual([LIVE, STOPPED].sort())
    expect(byId[ASIDE]).toBeUndefined()
    expect(byId[LIVE]).toMatchObject({ title: 'Fix the build', taskTitle: 'Release: fix the build', taskPhase: 'IN_PROGRESS', state: 'idle' })
    expect(byId[LIVE].lastActiveAt).toMatch(/^\d{4}-/)
    expect(byId[STOPPED]).toMatchObject({ title: 'Old report', state: 'stopped' })
  })

  it('a message reaches the running session and shows in its conversation', async () => {
    const sent = await call(port, 'POST', `/_alone/sessions/${LIVE}/messages`, { token: TOKEN, body: { text: 'hello from the phone', messageId: 'qm-alone-test-1' } })
    expect(sent.status, sent.body).toBe(200)
    expect(sent.json).toEqual({ status: 'delivered', sessionId: LIVE, messageId: 'qm-alone-test-1' })
    await waitFor(() => h.inbox(LIVE).includes('hello from the phone'), 10_000, 'the CLI got it')
    const t = await waitFor(async () => {
      const r = await call(port, 'GET', `/_alone/sessions/${LIVE}/transcript`, { token: TOKEN })
      const texts = (r.json.messages ?? []).map((m: { text: string }) => m.text)
      return texts.includes('echo: hello from the phone') ? r : null
    }, 10_000, 'the reply in the transcript')
    const rows = t.json.messages as Array<{ role: string; text: string }>
    expect(rows.some((m) => m.role === 'user' && m.text === 'hello from the phone')).toBe(true)
  })

  it('refuses a stopped session, an unknown one, an empty message and a bad id', async () => {
    const stopped = await call(port, 'POST', `/_alone/sessions/${STOPPED}/messages`, { token: TOKEN, body: { text: 'are you there' } })
    expect(stopped.status).toBe(409)
    expect(stopped.json.error.code).toBe('not_running')
    const unknown = await call(port, 'POST', '/_alone/sessions/dddddddd-4444-4444-8444-444444444444/messages', { token: TOKEN, body: { text: 'hi' } })
    expect(unknown.status).toBe(404)
    expect((await call(port, 'POST', `/_alone/sessions/${LIVE}/messages`, { token: TOKEN, body: { text: '   ' } })).status).toBe(400)
    expect((await call(port, 'GET', '/_alone/sessions/..%2F..%2Fetc/transcript', { token: TOKEN })).status).toBe(400)
    expect((await call(port, 'GET', '/_alone/sessions/dddddddd-4444-4444-8444-444444444444/transcript', { token: TOKEN })).status).toBe(404)
  })

  it('a prompt shows in the list, and the answer reaches the CLI', async () => {
    expect((await call(port, 'POST', `/_alone/sessions/${LIVE}/messages`, { token: TOKEN, body: { text: 'ASK: list the docs' } })).status).toBe(200)
    const asking = await waitFor(async () => (await sessionsOf()).find((s) => s.sid === LIVE && s.prompt), 10_000, 'the prompt')
    expect(asking.prompt).toEqual({ requestId: 'perm-1', toolName: 'Bash', input: { command: 'ls docs/' }, reason: 'Bash is not allowed yet' })
    // A stale request id is refused and changes nothing.
    expect((await call(port, 'POST', `/_alone/sessions/${LIVE}/permission`, { token: TOKEN, body: { requestId: 'perm-9', allow: true } })).status).toBe(404)
    const answered = await call(port, 'POST', `/_alone/sessions/${LIVE}/permission`, { token: TOKEN, body: { requestId: 'perm-1', allow: true } })
    expect(answered.status, answered.body).toBe(200)
    expect(answered.json).toEqual({ status: 'resolved', requestId: 'perm-1', allow: true })
    await waitFor(() => h.responses(LIVE).length === 1, 10_000, 'the CLI got the answer')
    expect(h.responses(LIVE)[0].response).toMatchObject({ subtype: 'success', request_id: 'perm-1', response: { behavior: 'allow', updatedInput: { command: 'ls docs/' } } })
    expect((await sessionsOf()).find((s) => s.sid === LIVE)?.prompt).toBeUndefined()
    // A deny with a reason.
    await call(port, 'POST', `/_alone/sessions/${LIVE}/messages`, { token: TOKEN, body: { text: 'ASK: again' } })
    await waitFor(async () => (await sessionsOf()).find((s) => s.sid === LIVE && s.prompt?.requestId === 'perm-2'), 10_000, 'the second prompt')
    expect((await call(port, 'POST', `/_alone/sessions/${LIVE}/permission`, { token: TOKEN, body: { requestId: 'perm-2', allow: false, message: 'not now' } })).status).toBe(200)
    await waitFor(() => h.responses(LIVE).length === 2, 10_000, 'the deny')
    expect(h.responses(LIVE)[1].response.response).toEqual({ behavior: 'deny', message: 'not now' })
  })

  it('the Mac back: it drains the person\'s messages, and the page\'s API steps aside', async () => {
    await h.linkMac()
    await waitFor(() => h.route() === 'leader', 15_000, 'the leader route')
    const drained = await h.macCmd({ cmd: 'offline.drain', home: HOME })
    expect(drained.ok, JSON.stringify(drained)).toBe(true)
    const deliveries = (drained.records as Array<Record<string, any>>).filter((r) => r.kind === 'delivery' && r.toSessionId === LIVE)
    expect(deliveries.map((r) => r.messageId)).toContain('qm-alone-test-1')
    expect(deliveries.every((r) => r.fromSessionId === '')).toBe(true)
    expect(deliveries).toHaveLength(3)
    const list = await call(port, 'GET', '/_alone/sessions', { token: TOKEN })
    expect(list.status).toBe(409)
    expect((await call(port, 'GET', '/_alone/state', { token: TOKEN })).json.route).toBe('leader')
  })

  it('the Mac asleep with its socket open: after the quiet window the page is alone, and the daemon takes the write', async () => {
    h.silenceMac()
    await waitFor(() => h.route() === 'alone', 45_000, 'alone while the Mac sleeps')
    const sent = await call(port, 'POST', `/_alone/sessions/${LIVE}/messages`, { token: TOKEN, body: { text: 'while the Mac sleeps' } })
    expect(sent.status, sent.body).toBe(200)
    await waitFor(() => h.inbox(LIVE).includes('while the Mac sleeps'), 10_000, 'the CLI got it')
    h.wakeMac()
    await waitFor(() => h.route() === 'leader', 15_000, 'the Mac awake again')
    expect((await call(port, 'GET', '/_alone/sessions', { token: TOKEN })).status).toBe(409)
  }, 90_000)

  it('the daemon itself: a follower writes only while no server answers, and reads only its own session files', async () => {
    const token = h.followerToken()
    const f = await followerSocket(h.daemonPort(), token)
    try {
      expect(f.hello.ok, JSON.stringify(f.hello)).toBe(true)
      const send = await f.ask({ cmd: 'follower.send', sid: LIVE, text: 'sneaky' })
      expect(send).toMatchObject({ ok: false, errorKind: 'leader_answers' })
      const perm = await f.ask({ cmd: 'follower.permission', sid: LIVE, requestId: 'perm-1', allow: true })
      expect(perm).toMatchObject({ ok: false, errorKind: 'leader_answers' })
      expect(await f.ask({ cmd: 'read-history', sid: '../../etc/hosts', tailBytes: 100 })).toMatchObject({ ok: false })
      expect(await f.ask({ cmd: 'read-history', sid: 'eeeeeeee-5555-4555-8555-555555555555', tailBytes: 100 })).toMatchObject({ ok: false, errorKind: 'not_found' })
      const own = await f.ask({ cmd: 'read-history', sid: LIVE, tailBytes: 4096 })
      expect(own.ok).toBe(true)
      expect(String(own.main)).toContain('hello from the phone')
      // Still a follower: what only the leader sends is refused.
      expect(await f.ask({ cmd: 'send', sid: LIVE, message: 'x' })).toMatchObject({ ok: false, errorKind: 'follower_refused' })
    } finally {
      f.ws.close()
    }
    expect(h.inbox(LIVE)).not.toContain('sneaky')
  })
})
