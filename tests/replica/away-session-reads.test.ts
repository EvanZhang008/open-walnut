/**
 * A host replica answering alone (the Mac away, no companion standing in)
 * answers the reads of a session that does not run on this host with
 * `503 needs_leader {why:'session_on_mac'}` (src/replica/away-session-reads.ts,
 * WP7): its transcript, files and changes are on the Mac. This host's sessions
 * are WP6's routes' whenever its daemon answers owner-scoped reads (passed
 * through untouched, every read); with an older daemon, their history comes
 * from the stream file. The session row itself, and every read while the
 * replica is not alone (the Mac answers, or the companion stands in), pass
 * through to the routes.
 *
 * A real express app with the middleware mounted as server.ts mounts it (under
 * /api); the routes behind it are stand-ins that say they ran.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import type net from 'node:net'
import { awaySessionReads, hostReadSession, SESSION_FILES_NEED_MAC, SESSION_ON_MAC, type AwaySessionReadsDeps } from '../../src/replica/away-session-reads.js'

const AS_OF = 1_760_000_000_000
const SESSIONS: Record<string, string | undefined> = {
  'mac-1': undefined, // the Mac's own (no host)
  'local-1': '__local__',
  'here-1': 'devbox',
  'other-1': 'otherbox',
}
const OFFLINE = { 'x-walnut-offline': String(AS_OF), 'x-walnut-offline-why': 'away' }
const state = { alone: true, hostKey: 'devbox' as string | null, selfHost: false }
/** Every stream file read the first app asked of the daemon. */
const daemonReads: string[] = []
let port = 0
let server: http.Server

beforeAll(async () => {
  const app = express()
  app.use('/api', awaySessionReads({
    alone: () => state.alone,
    offlineHeaders: () => OFFLINE,
    hostKey: () => state.hostKey,
    hostOf: async (sid) => (sid in SESSIONS ? SESSIONS[sid] : null),
    selfHost: (h) => state.selfHost && h === 'devbox',
    readHostHistory: async (sid) => { daemonReads.push(sid); return { ok: true, main: '' } },
  }))
  app.use('/api', (req, res) => { res.json({ ran: req.path }) })
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as net.AddressInfo).port
})
afterAll(async () => { await new Promise((r) => server.close(r)) })
beforeEach(() => { state.alone = true; state.hostKey = 'devbox'; state.selfHost = false; daemonReads.length = 0 })

function request(p: number, method: string, path: string): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: p, method, path, agent: false }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, headers: res.headers }))
    })
    req.on('error', reject)
    req.end()
  })
}
const call = (method: string, p: string) => request(port, method, p)

describe('which reads need the session\'s host', () => {
  it('the transcript, subagents, changes, plan, workflow, commands and the editor link; not the row or its controls', () => {
    for (const p of ['/sessions/s1/history', '/sessions/s1/subagent/a1/history', '/sessions/s1/changes', '/sessions/s1/changes/file',
      '/sessions/s1/changes/summary', '/sessions/s1/changes/triage', '/sessions/s1/plan', '/sessions/s1/workflow',
      '/sessions/s1/slash-commands', '/sessions/s1/vscode-uri', '/v1/sessions/s1/history', '/v1/sessions/s1/transcript']) {
      expect(hostReadSession('GET', p)).toBe('s1')
    }
    for (const p of ['/sessions/s1', '/sessions/s1/controls', '/sessions/s1/settings', '/sessions', '/v1/sessions/s1', '/sessions/s1/history/extra']) {
      expect(hostReadSession('GET', p)).toBeNull()
    }
    expect(hostReadSession('POST', '/sessions/s1/history')).toBeNull()
    expect(hostReadSession('GET', '/sessions/a%20b/history')).toBe('a b')
  })

  it('every spelling express routes to the same handler: any case, a trailing slash', () => {
    for (const p of ['/Sessions/s1/History', '/SESSIONS/s1/HISTORY/', '/sessions/s1/history/', '/sessions/s1/Changes/File',
      '/sessions/s1/changes/', '/V1/Sessions/s1/Transcript', '/v1/sessions/s1/history/', '/sessions/s1/subagent/a1/History/']) {
      expect(hostReadSession('GET', p), p).toBe('s1')
    }
  })
})

describe('answering alone', () => {
  it('a Mac session (no host, __local__) and another host\'s: 503 needs_leader session_on_mac, marked offline', async () => {
    for (const sid of ['mac-1', 'local-1', 'other-1']) {
      for (const p of [`/api/sessions/${sid}/history`, `/api/v1/sessions/${sid}/transcript`, `/api/sessions/${sid}/changes`]) {
        const r = await call('GET', p)
        expect(r.status).toBe(503)
        expect(r.json).toEqual({ error: { code: 'needs_leader', why: SESSION_ON_MAC, retryAfter: 5, message: 'This needs your Mac, which is not answering right now.' } })
        expect(r.headers['x-walnut-offline']).toBe(String(AS_OF))
        expect(r.headers['x-walnut-offline-why']).toBe('away')
        expect(r.headers['x-walnut-answered-via']).toBe('replica')
        expect(r.headers['retry-after']).toBe('5')
      }
    }
  })

  it('no spelling slips past to the route: a Mac session read in any case or with a trailing slash is refused', async () => {
    for (const p of ['/api/Sessions/mac-1/History', '/api/sessions/mac-1/history/', '/api/V1/sessions/mac-1/transcript/', '/api/sessions/mac-1/CHANGES/file']) {
      const r = await call('GET', p)
      expect(r.status, p).toBe(503)
      expect(r.json.error.why, p).toBe(SESSION_ON_MAC)
    }
  })

  it('this host\'s session with a daemon that answers owner-scoped reads: every read is WP6\'s route, untouched', async () => {
    state.selfHost = true
    for (const p of ['/sessions/here-1/history', '/sessions/here-1/subagent/a1/history', '/sessions/here-1/changes', '/sessions/here-1/changes/file',
      '/sessions/here-1/plan', '/sessions/here-1/workflow', '/sessions/here-1/slash-commands', '/sessions/here-1/vscode-uri',
      '/v1/sessions/here-1/history', '/v1/sessions/here-1/transcript', '/Sessions/here-1/History/']) {
      const r = await call('GET', `/api${p}`)
      expect(r.json, p).toEqual({ ran: p })
      expect(r.headers['x-walnut-offline'], p).toBeUndefined()
    }
    // The stream file is never read: WP6's routes read the CLI's own files.
    expect(daemonReads).toEqual([])
  })

  it('the same session with a daemon that lacks those reads: its history from the stream file, the rest needs the Mac', async () => {
    expect((await call('GET', '/api/sessions/here-1/history')).json).toMatchObject({ messages: [], windowed: true })
    expect(daemonReads).toEqual(['here-1'])
    const files = await call('GET', '/api/sessions/here-1/changes')
    expect(files.status).toBe(503)
    expect(files.json.error.why).toBe(SESSION_FILES_NEED_MAC)
  })

  it('with no host key told, a session with a host may be this host\'s and passes; the Mac\'s own still needs the Mac', async () => {
    state.hostKey = null
    expect((await call('GET', '/api/sessions/other-1/history')).json).toEqual({ ran: '/sessions/other-1/history' })
    expect((await call('GET', '/api/sessions/mac-1/history')).status).toBe(503)
  })

  it('an unknown session and the session row pass through to the routes', async () => {
    expect((await call('GET', '/api/sessions/nope/history')).json).toEqual({ ran: '/sessions/nope/history' })
    expect((await call('GET', '/api/sessions/mac-1')).json).toEqual({ ran: '/sessions/mac-1' })
  })
})

it('not alone (the Mac answers, or the companion stands in with live data): nothing is refused', async () => {
  state.alone = false
  expect((await call('GET', '/api/sessions/mac-1/history')).json).toEqual({ ran: '/sessions/mac-1/history' })
  expect((await call('GET', '/api/sessions/other-1/changes')).json).toEqual({ ran: '/sessions/other-1/changes' })
})

/**
 * This host's session, a daemon WITHOUT owner-scoped file reads: read from its
 * stream file (host-history.ts). A second app whose `readHostHistory` answers
 * as the daemon's `read-history` does (the newest `tailBytes` of
 * `<streams>/<sid>.jsonl`, whole lines, `{ok, main}`), from a real stream file
 * shaped as the daemon writes it: Walnut's user markers (one resent to a new
 * process), the CLI's assistant lines, its result line.
 */
describe('this host\'s session, an older daemon: read from its stream file', () => {
  const HERE = 'here-2'
  // Unicode test data, as \u escapes.
  const WORDS = 'Ship the build \u00e9t\u00e9 \u4f60\u597d'
  const line = (o: unknown) => JSON.stringify(o)
  const STREAM = [
    line({ type: 'system', subtype: 'init', session_id: HERE, cwd: '/w', model: 'm', tools: [] }),
    line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: WORDS }, walnutMessageId: 'qm-1', walnutPid: 11, timestamp: '2026-10-15T10:00:00.000Z' }),
    // The same line resent to a new process: one row, the last marker.
    line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: WORDS }, walnutMessageId: 'qm-1', walnutPid: 12, timestamp: '2026-10-15T10:00:01.000Z' }),
    line({ type: 'assistant', message: { id: 'msg_a1', role: 'assistant', model: 'm', content: [{ type: 'text', text: `echo: ${WORDS}` }] }, parent_tool_use_id: null, session_id: HERE, timestamp: '2026-10-15T10:00:02.000Z' }),
    line({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${WORDS}`, session_id: HERE }),
    line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'second turn' }, walnutMessageId: 'qm-2', timestamp: '2026-10-15T10:01:00.000Z' }),
    line({ type: 'assistant', message: { id: 'msg_a2', role: 'assistant', model: 'm', content: [{ type: 'text', text: 'echo: second turn' }] }, parent_tool_use_id: null, session_id: HERE, timestamp: '2026-10-15T10:01:01.000Z' }),
    '',
  ].join('\n')
  const asked: Array<{ sid: string; tailBytes: number }> = []
  const logs: Array<{ level: string; msg: string }> = []
  const daemon = { mode: 'ok' as 'ok' | 'not_found' | 'down', delayMs: 0, text: STREAM }
  let port2 = 0
  let server2: http.Server

  beforeAll(async () => {
    const app = express()
    const deps: AwaySessionReadsDeps = {
      alone: () => true,
      offlineHeaders: () => OFFLINE,
      hostKey: () => 'devbox',
      hostOf: async (sid) => (sid === HERE ? 'devbox' : sid === 'mac-1' ? undefined : null),
      // The daemon has no replica-reads-v1: the fallback path.
      selfHost: () => false,
      readHostHistory: async (sid, tailBytes) => {
        asked.push({ sid, tailBytes })
        if (daemon.delayMs) await new Promise((r) => setTimeout(r, daemon.delayMs))
        if (daemon.mode === 'down') throw new Error('read-history timed out')
        if (daemon.mode === 'not_found') return { ok: false, error: 'read-history: not a session of this Walnut on this host', errorKind: 'not_found' }
        const buf = Buffer.from(daemon.text, 'utf8')
        const start = Math.max(0, buf.length - tailBytes)
        let text = buf.subarray(start).toString('utf8')
        if (start > 0) text = text.slice(text.indexOf('\n') + 1)
        return { ok: true, main: text, subagents: {} }
      },
      log: (level, msg) => { logs.push({ level, msg }) },
    }
    app.use('/api', awaySessionReads(deps))
    app.use('/api', (req, res) => { res.json({ ran: req.path }) })
    server2 = http.createServer(app)
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', () => r()))
    port2 = (server2.address() as net.AddressInfo).port
  })
  afterAll(async () => { await new Promise((r) => server2.close(r)) })
  beforeEach(() => { daemon.mode = 'ok'; daemon.delayMs = 0; daemon.text = STREAM; asked.length = 0; logs.length = 0 })

  const get = (p: string) => request(port2, 'GET', p)

  it('the console\'s history: the person\'s words (one row per message id) and the replies, from the newest 1 MB, marked offline and windowed', async () => {
    const r = await get(`/api/sessions/${HERE}/history`)
    expect(r.status).toBe(200)
    expect(r.headers['x-walnut-offline']).toBe(String(AS_OF))
    expect(r.headers['x-walnut-answered-via']).toBe('replica')
    expect(asked).toEqual([{ sid: HERE, tailBytes: 1024 * 1024 }])
    const rows = (r.json.messages as Array<{ role: string; text: string }>).map((m) => `${m.role}: ${m.text}`)
    expect(rows).toEqual([`user: ${WORDS}`, `assistant: echo: ${WORDS}`, 'user: second turn', 'assistant: echo: second turn'])
    expect({ total: r.json.total, cursor: r.json.cursor, delta: r.json.delta, windowed: r.json.windowed }).toEqual({ total: 4, cursor: 4, delta: false, windowed: true })
  })

  it('tail and turns slice the newest rows; a `since` read is a full answer; a `before` page needs the Mac and says so', async () => {
    const tail = await get(`/api/sessions/${HERE}/history?tail=1`)
    expect((tail.json.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['echo: second turn'])
    expect([tail.json.total, tail.json.cursor]).toEqual([4, 4])
    const turns = await get(`/api/sessions/${HERE}/history?turns=1`)
    expect((turns.json.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['second turn', 'echo: second turn'])
    const since = await get(`/api/sessions/${HERE}/history?since=2`)
    expect([since.json.delta, since.json.messages.length]).toEqual([false, 4])
    const before = await get(`/api/sessions/${HERE}/history?before=2026-10-15T10:00:00.000Z&turns=20`)
    expect(before.status).toBe(200)
    expect(before.json).toEqual({ messages: [], reachedStart: false, unavailable: 'history_pages_need_mac' })
    expect(asked).toHaveLength(3)
  })

  it('the phone: the rich history and the slim transcript (its 512 KB tail) from the same file', async () => {
    const rich = await get(`/api/v1/sessions/${HERE}/history?tail=2`)
    expect(rich.status).toBe(200)
    expect((rich.json.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(['second turn', 'echo: second turn'])
    const slim = await get(`/api/v1/sessions/${HERE}/transcript`)
    expect(slim.status).toBe(200)
    expect(slim.headers['x-walnut-offline']).toBe(String(AS_OF))
    expect(JSON.stringify(slim.json)).toContain(WORDS)
    expect(asked.map((a) => a.tailBytes)).toEqual([1024 * 1024, 512 * 1024])
    const page = await get(`/api/v1/sessions/${HERE}/transcript?before=2026-10-15T10:00:00.000Z`)
    expect(page.status).toBe(503)
    expect(page.json.error).toMatchObject({ code: 'needs_leader', why: 'history_pages_need_mac' })
  })

  it('its other reads (files, changes, plan) need the Mac with such a daemon, with no daemon read', async () => {
    for (const p of [`/api/sessions/${HERE}/changes`, `/api/sessions/${HERE}/plan`, `/api/sessions/${HERE}/subagent/a1/history`, `/api/Sessions/${HERE}/Plan/`]) {
      const r = await get(p)
      expect(r.status, p).toBe(503)
      expect(r.json.error, p).toMatchObject({ code: 'needs_leader', why: SESSION_FILES_NEED_MAC })
    }
    expect(asked).toEqual([])
  })

  it('the daemon refuses the session (not this Walnut\'s): 404; the link is down: 503 daemon_unreachable; both logged as warnings', async () => {
    daemon.mode = 'not_found'
    const nf = await get(`/api/sessions/${HERE}/history`)
    expect(nf.status).toBe(404)
    expect(nf.json.error.code).toBe('not_found')
    daemon.mode = 'down'
    const down = await get(`/api/v1/sessions/${HERE}/transcript`)
    expect(down.status).toBe(503)
    expect(down.json.error).toMatchObject({ code: 'needs_leader', why: 'daemon_unreachable' })
    expect(logs.filter((l) => l.msg === 'replica: a host session read failed').map((l) => l.level)).toEqual(['warn', 'warn'])
  })

  it('a Mac session on the same app still needs the Mac, with no daemon read', async () => {
    const r = await get('/api/sessions/mac-1/history')
    expect(r.status).toBe(503)
    expect(r.json.error.why).toBe(SESSION_ON_MAC)
    expect(asked).toEqual([])
  })

  it('concurrent reads of one session share one daemon read and one parse; a whole window never holds the loop long', async () => {
    // A full 1 MB window of turns (tool calls, results, replies), as a busy session leaves it.
    const turns: string[] = []
    for (let n = 0; Buffer.byteLength(turns.join('\n')) < 1.2 * 1024 * 1024; n++) {
      const at = new Date(Date.UTC(2026, 9, 15, 10, 0, n)).toISOString()
      turns.push(
        line({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: `question ${n}` }, walnutMessageId: `qm-${n}`, timestamp: at }),
        line({ type: 'assistant', message: { id: `msg_${n}_t`, role: 'assistant', model: 'm', content: [{ type: 'tool_use', id: `tu_${n}`, name: 'Bash', input: { command: `make step${n}` } }] }, parent_tool_use_id: null, timestamp: at }),
        line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${n}`, content: 'log line\n'.repeat(60) }] }, parent_tool_use_id: null, timestamp: at }),
        line({ type: 'assistant', message: { id: `msg_${n}_a`, role: 'assistant', model: 'm', content: [{ type: 'text', text: `answer ${n}` }] }, parent_tool_use_id: null, timestamp: at }),
      )
    }
    daemon.text = turns.join('\n') + '\n'
    daemon.delayMs = 150
    let lagMax = 0
    let last = performance.now()
    const probe = setInterval(() => { const t = performance.now(); lagMax = Math.max(lagMax, t - last - 5); last = t }, 5)
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => get(`/api/sessions/${HERE}/history?tail=${i + 1}`)))
    clearInterval(probe)
    expect(asked).toHaveLength(1)
    for (const [i, a] of answers.entries()) {
      expect(a.status).toBe(200)
      expect(a.json.messages).toHaveLength(i + 1)
      expect(a.json.windowed).toBe(true)
    }
    // Every request saw the same window.
    expect(new Set(answers.map((a) => a.json.total)).size).toBe(1)
    expect(lagMax).toBeLessThan(100)
    // Settled: the next read asks the daemon again (nothing is cached past the read).
    await get(`/api/sessions/${HERE}/history`)
    expect(asked).toHaveLength(2)
  })
})
