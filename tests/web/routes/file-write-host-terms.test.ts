/**
 * The file routes' write paths, on a remote host: what they answer when the
 * host is not there, and in whose name.
 *
 * Gate review (2026-10-03): with the cloud companion's link down, Save answered
 * 502 "Could not save on the remote host: DaemonConnection not connected to
 * __cloudbox__" after 30 to 60s, and a new folder answered the same sentence;
 * the console showed both verbatim. The read paths named the host; the write
 * paths passed the daemon pool's error through. Now:
 *  - every answer of these routes passes one exit (hostTermsAtExit), so the
 *    alias never reaches a person, whichever route wrote the sentence;
 *  - a save's checks before the write are bounded like every read: a host still
 *    connecting or a link gone silent answers 503 in seconds, and nothing is
 *    written.
 *
 * The pool is faked at the module boundary (no ssh, no socket), as in
 * host-read-bound-routes.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-file-write-host-terms'))

type WouldWait = 'connected' | 'fails-fast' | 'dialing' | 'cold'
type FakeConn = { send: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> }
const pool = vi.hoisted(() => ({
  wouldWait: 'connected' as WouldWait,
  conn: null as null | FakeConn,
  probes: 0,
  alive: false,
}))
const never = <T>() => new Promise<T>(() => {})
const cfg = vi.hoisted(() => ({ devboxLabel: 'Big dev box', reads: 0 }))

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => pool.conn ?? never(),
  daemonConnectWouldWait: () => pool.wouldWait,
  probeDaemonLiveness: async () => { pool.probes++; return pool.alive },
  getDaemonConnectState: (host: string) => ({
    host, connected: pool.wouldWait === 'connected', phase: pool.wouldWait === 'dialing' ? 'connect' : 'idle', phaseElapsedMs: 0,
  }),
}))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => {
    cfg.reads++
    return {
      hosts: {
        devbox: { hostname: 'devbox.example.test', user: 'me', label: cfg.devboxLabel },
        __cloudbox__: { hostname: 'cloud.example.test' },
      },
    }
  },
}))

import { fileContentRouter } from '../../../src/web/routes/file-content.js'
import { fileOpsRouter } from '../../../src/web/routes/file-ops.js'
import { filesRouter } from '../../../src/web/routes/files.js'
import { filesV1Router } from '../../../src/web/routes/files-v1.js'
import { markLinkFailure, type LinkFailureKind } from '../../../src/providers/link-failure.js'
import { HOST_READ_QUIET_MS, HOST_LIVENESS_PROBE_MS, resetSharedHostReadsForTest } from '../../../src/core/hosts/remote-read-bound.js'
import { bodyInHostTerms, exitHostName, hostTermsAtExit, resetHostTermsForTest } from '../../../src/web/middleware/host-terms-at-exit.js'

const ALIAS = '__cloudbox__'
const NOT_CONNECTED = `DaemonConnection not connected to ${ALIAS}`

/**
 * A daemon holding `files`, recording each command; `fail(cmd)` makes a command
 * throw, with the message it returns, or with the error itself (a link failure
 * the pool tagged).
 */
function daemonWith(files: Record<string, string>, sent: string[], fail?: (cmd: string) => string | Error | undefined): FakeConn {
  return {
    send: async (cmd, params) => {
      sent.push(cmd)
      const failure = fail?.(cmd)
      if (failure) throw typeof failure === 'string' ? new Error(failure) : failure
      const p = params.path as string
      if (cmd === 'fs.stat') {
        if (p in files) return { ok: true, exists: true, size: Buffer.byteLength(files[p]), mtimeMs: 1 }
        // A directory the files live in exists.
        return Object.keys(files).some((f) => f.startsWith(p + '/')) ? { ok: true, exists: true, size: 0, mtimeMs: 1 } : { ok: true, exists: false }
      }
      if (cmd === 'fs.read') return p in files ? { ok: true, data: files[p] } : { ok: true, exists: false, data: null }
      if (cmd === 'fs.write') { files[p] = Buffer.from(params.data as string, 'base64').toString('utf-8'); return { ok: true } }
      if (cmd === 'fs.mkdir') return { ok: true }
      return { ok: false, error: `unknown command: ${cmd}` }
    },
  }
}

let baseUrl = ''
let server: http.Server

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/file-content', fileContentRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/files', fileOpsRouter)
  app.use('/api/v1', filesV1Router)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  pool.wouldWait = 'connected'
  pool.conn = null
  pool.probes = 0
  pool.alive = false
  cfg.devboxLabel = 'Big dev box'
  resetSharedHostReadsForTest()
  resetHostTermsForTest()
})

async function put(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const t0 = Date.now()
  const res = await fetch(`${baseUrl}/api/file-content`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown>, ms: Date.now() - t0 }
}

/** An error the pool raised for its link, tagged as the pool tags it (daemon-connection.ts). */
const linkFailure = (kind: LinkFailureKind, message = NOT_CONNECTED) => markLinkFailure(new Error(message), kind)

async function op(name: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/files/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('Save on a remote host, when the host is not there', () => {
  it('the write fails in transport: 502 in the host\'s name, the alias never in it', async () => {
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, sent, (cmd) => (cmd === 'fs.write' ? NOT_CONNECTED : undefined))
    const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'Could not save on Cloud: DaemonConnection not connected to Cloud' })
    // A labelled host: its label.
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, sent, (cmd) => (cmd === 'fs.write' ? 'DaemonConnection not connected to devbox' : undefined))
    const ssh = await put({ path: '/work/a.ts', host: 'devbox', content: 'new\n' })
    expect(ssh.status).toBe(502)
    expect(ssh.body).toEqual({ error: 'Could not save on Big dev box: DaemonConnection not connected to Big dev box' })
  })

  it('the checks before the write fail in transport: the same, and nothing is written', async () => {
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, sent, (cmd) => (cmd === 'fs.read' ? NOT_CONNECTED : undefined))
    const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(JSON.stringify(res.body)).not.toContain(ALIAS)
    expect(sent).not.toContain('fs.write')
  })

  it('a host still connecting: 503 at once, nothing written (it waited on the dial, then named the alias)', async () => {
    pool.wouldWait = 'dialing'
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, sent)
    const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ error: 'Nothing was saved. Reconnecting to Cloud', code: 'host_reconnecting' })
    expect(res.ms).toBeLessThan(2_000)
    expect(sent).not.toContain('fs.write')
  })

  it('a connected link gone silent: 503 at the quiet point plus one probe, nothing written (it was 30 to 60s)', async () => {
    const sent: string[] = []
    pool.conn = { send: async (cmd) => { sent.push(cmd); return never() } }
    const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toMatch(/^Nothing was saved\. /)
    expect(String(res.body.error)).not.toContain(ALIAS)
    expect(pool.probes).toBe(1)
    expect(res.ms).toBeLessThan(HOST_READ_QUIET_MS + HOST_LIVENESS_PROBE_MS + 3_000)
    expect(sent).not.toContain('fs.write')
  }, 20_000)

  it('a healthy save still saves', async () => {
    const sent: string[] = []
    const files = { '/work/a.ts': 'old\n' }
    pool.conn = daemonWith(files, sent)
    const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, size: 4 })
    expect(files['/work/a.ts']).toBe('new\n')
  })
})

describe('a new folder on a remote host, when the host is not there', () => {
  it('502 in the host\'s name (it said "Could not complete on the remote host: ... __cloudbox__")', async () => {
    const sent: string[] = []
    pool.conn = daemonWith({}, sent, (cmd) => (cmd === 'fs.mkdir' ? NOT_CONNECTED : undefined))
    const res = await op('mkdir', { path: '/home/acme/project/new-folder', host: ALIAS })
    expect(res.status).toBe(502)
    expect(res.body).toEqual({ error: 'Could not complete on Cloud: DaemonConnection not connected to Cloud', code: 'remote' })
  })

  it('the file-ops router names the host on its own, whatever is mounted before it', async () => {
    // In the server the files router sits first on /api/files and its exit
    // already covers these requests; this router must not depend on that order.
    const alone = express()
    alone.use(express.json())
    alone.use('/api/files', fileOpsRouter)
    const srv = http.createServer(alone)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    try {
      pool.conn = daemonWith({}, [], (cmd) => (cmd === 'fs.mkdir' ? NOT_CONNECTED : undefined))
      const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/files/mkdir`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/home/acme/project/new-folder', host: ALIAS }),
      })
      expect(res.status).toBe(502)
      expect(await res.json()).toEqual({ error: 'Could not complete on Cloud: DaemonConnection not connected to Cloud', code: 'remote' })
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })
})

describe('the exit: only sentences, only in the host\'s terms', () => {
  it('rewrites the sentence fields, at the top and in a list, and never anything else', () => {
    const body = {
      error: `Cannot reach ${ALIAS}`,
      content: `a file that mentions ${ALIAS} keeps it`,
      listings: [{ path: '/w', error: `ls failed on ${ALIAS}` }, { path: '/x', entries: [] }],
    }
    expect(bodyInHostTerms(body, ALIAS, 'Cloud')).toEqual({
      error: 'Cannot reach Cloud',
      content: `a file that mentions ${ALIAS} keeps it`,
      listings: [{ path: '/w', error: 'ls failed on Cloud' }, { path: '/x', entries: [] }],
    })
    // Nothing to change: the same object back.
    const plain = { ok: true }
    expect(bodyInHostTerms(plain, ALIAS, 'Cloud')).toBe(plain)
  })

  it('reads the name once per host for a while, not on every request (each read parses the config)', async () => {
    const reads0 = cfg.reads
    expect(await exitHostName('devbox')).toBe('Big dev box')
    cfg.devboxLabel = 'Renamed box'
    expect(await exitHostName('devbox')).toBe('Big dev box')
    expect(cfg.reads - reads0).toBe(1)
    // A rename shows once the kept name is 10s old.
    const realNow = Date.now.bind(Date)
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 10_001)
    try {
      expect(await exitHostName('devbox')).toBe('Renamed box')
    } finally {
      later.mockRestore()
    }
  })

  it('a file\'s content is served as it is, alias and all', async () => {
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/notes.md': `host: ${ALIAS}\n` }, sent)
    const res = await fetch(`${baseUrl}/api/file-content?path=${encodeURIComponent('/work/notes.md')}&host=${ALIAS}`)
    expect(res.status).toBe(200)
    expect((await res.json() as { content: string }).content).toBe(`host: ${ALIAS}\n`)
  })
})

describe('the exit covers every router it is mounted on, and plain text too', () => {
  it('the files router: a listing error from below says the host\'s name, at the top and in a batch', async () => {
    // fs.ls answers an error that names the alias (the pool's words, not a link failure).
    const refusal = `daemon on ${ALIAS} refused fs.ls`
    pool.conn = { send: async (cmd) => (cmd === 'fs.ls' ? { ok: false, error: refusal } : { ok: true }) }
    const one = await fetch(`${baseUrl}/api/files/list?path=${encodeURIComponent('/work')}&host=${ALIAS}`)
    expect(one.status).toBe(400)
    expect(await one.json()).toEqual({ error: 'Cannot list directory: daemon on Cloud refused fs.ls' })
    pool.conn = { send: async (cmd) => { if (cmd === 'fs.ls') throw new Error(refusal); return { ok: true } } }
    const many = await fetch(`${baseUrl}/api/files/list-many`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: ['/work'], host: ALIAS }),
    })
    expect(many.status).toBe(200)
    const body = await many.json() as { listings: Array<{ path: string; error?: string }> }
    expect(body.listings).toEqual([{ path: '/work', error: 'daemon on Cloud refused fs.ls' }])
  })

  it('a plain-text error says the host\'s name; plain-text bytes that succeed, and JSON content, are left alone', async () => {
    const app = express()
    app.use(hostTermsAtExit)
    app.get('/fail', (_req, res) => { res.status(502).type('text/plain').send(`ssh to ${ALIAS} was refused`) })
    app.get('/bytes', (_req, res) => { res.type('text/plain').send(`host: ${ALIAS}\n`) })
    app.get('/json', (_req, res) => { res.status(502).json({ error: `ssh to ${ALIAS} was refused`, content: `host: ${ALIAS}` }) })
    const srv = http.createServer(app)
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const at = (p: string) => fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}${p}?host=${ALIAS}`)
    try {
      const fail = await at('/fail')
      expect(fail.status).toBe(502)
      expect(await fail.text()).toBe('ssh to Cloud was refused')
      const bytes = await at('/bytes')
      expect(bytes.status).toBe(200)
      expect(await bytes.text()).toBe(`host: ${ALIAS}\n`)
      const json = await at('/json')
      expect(await json.json()).toEqual({ error: 'ssh to Cloud was refused', content: `host: ${ALIAS}` })
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })
})

describe('a link failure is told by its kind, never by its words', () => {
  it('Save: no link means nothing was saved (503, the client keeps the text and retries)', async () => {
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, sent, (cmd) => (cmd === 'fs.write' ? linkFailure('no-link') : undefined))
    const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: "Nothing was saved. Can't reach Cloud right now.", code: 'host_reconnecting' })
  })

  it('Save: a link lost, or a write never answered, may have landed: it says so, and how to recover', async () => {
    for (const kind of ['lost', 'no-answer'] as const) {
      pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, [], (cmd) => (cmd === 'fs.write' ? linkFailure(kind, 'connection closed') : undefined))
      const res = await put({ path: '/work/a.ts', host: ALIAS, content: 'new\n' })
      expect(res.status, kind).toBe(503)
      expect(res.body.code, kind).toBe('host_reconnecting')
      expect(String(res.body.error), kind).toBe(
        'Cloud stopped answering during the save, so it may not have landed. Your text is still in the editor: press Save again. If it did land, you are asked before anything is overwritten.',
      )
    }
  })

  it('Save on a dev box: an ssh dial refused at once is no link, never a raw "Command failed: ssh ..."', async () => {
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, [], (cmd) => (cmd === 'fs.write' ? linkFailure('no-link', 'Command failed: ssh 127.0.0.1 sh -s\nssh: refused') : undefined))
    const res = await put({ path: '/work/a.ts', host: 'devbox', content: 'new\n' })
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: "Nothing was saved. Can't reach Big dev box right now.", code: 'host_reconnecting' })
  })

  it('a new folder: each kind is a plain sentence about the change, never the pool\'s text', async () => {
    const said: Record<string, unknown> = {}
    for (const kind of ['no-link', 'lost', 'no-answer'] as const) {
      pool.conn = daemonWith({}, [], (cmd) => (cmd === 'fs.mkdir' ? linkFailure(kind) : undefined))
      const res = await op('mkdir', { path: '/home/acme/project/new-folder', host: ALIAS })
      expect(res.status, kind).toBe(502)
      expect(JSON.stringify(res.body), kind).not.toMatch(/DaemonConnection|__cloudbox__/)
      said[kind] = res.body.error
    }
    expect(said).toEqual({
      'no-link': 'Could not reach Cloud, so nothing was changed. Try again once it is back.',
      lost: 'Lost the link to Cloud before it answered, so this may or may not have happened. Refresh to check.',
      'no-answer': 'Cloud did not answer in time, so this may or may not have happened. Refresh to check.',
    })
  })

  it('/api/v1: a listing whose dial fails answers 503 reconnecting, and a save failure is never a 500', async () => {
    // The read began with nothing connected; the dial failed at once.
    pool.wouldWait = 'cold'
    pool.conn = { send: async () => { throw linkFailure('no-link', 'Command failed: ssh 127.0.0.1 sh -s\nssh: refused') } }
    const list = await fetch(`${baseUrl}/api/v1/files/list?path=${encodeURIComponent('/work')}&host=${ALIAS}`)
    expect(list.status).toBe(503)
    expect(await list.json()).toEqual({ error: { code: 'host_reconnecting', message: 'Reconnecting to Cloud' } })

    pool.wouldWait = 'connected'
    const save = (fail: string | Error) => {
      pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, [], (cmd) => (cmd === 'fs.write' ? fail : undefined))
      return fetch(`${baseUrl}/api/v1/file-content`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/work/a.ts', host: ALIAS, content: 'new\n' }),
      })
    }
    const lost = await save(linkFailure('lost', 'connection closed'))
    expect(lost.status).toBe(503)
    expect(((await lost.json()) as { error: { code: string } }).error.code).toBe('host_reconnecting')
    const refused = await save('EACCES: permission denied (EACCES)')
    expect(refused.status).toBe(502)
    expect(await refused.json()).toEqual({ error: { code: 'host_error', message: 'Could not save on Cloud: EACCES: permission denied (EACCES)' } })
  })
})

// Gate links (2026-10-07) found three of these edges answering a host that is not
// there with a 503 no test held: each could have become a 500 or a 502 unseen.
describe('a host still connecting: every remaining edge answers the designed 503', () => {
  it('/api/v1 Save: 503 host_reconnecting, marked handled, nothing written (never a 500)', async () => {
    pool.wouldWait = 'dialing'
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/a.ts': 'old\n' }, sent)
    const res = await fetch(`${baseUrl}/api/v1/file-content`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '/work/a.ts', host: ALIAS, content: 'new\n' }),
    })
    expect(res.status).toBe(503)
    expect(res.headers.get('x-walnut-handled-failure')).toBe('1')
    expect(await res.json()).toEqual({ error: { code: 'host_reconnecting', message: 'Nothing was saved. Reconnecting to Cloud' } })
    expect(sent).not.toContain('fs.write')
  })

  it('a raw read (the viewer\'s plain text): 503 text/plain in the host\'s name, marked handled (never a 502)', async () => {
    pool.wouldWait = 'dialing'
    for (const query of ['raw=1', 'raw=1&download=1']) {
      const res = await fetch(`${baseUrl}/api/file-content?path=${encodeURIComponent('/work/a.ts')}&host=${ALIAS}&${query}`)
      expect(res.status, query).toBe(503)
      expect(res.headers.get('x-walnut-handled-failure'), query).toBe('1')
      expect(res.headers.get('content-type'), query).toMatch(/^text\/plain/)
      expect(await res.text(), query).toBe('Reconnecting to Cloud')
    }
  })

  it('references: 503 host_reconnecting, marked handled (never a 502)', async () => {
    pool.wouldWait = 'dialing'
    const res = await fetch(`${baseUrl}/api/files/references?path=${encodeURIComponent('/work/a.ts')}&symbol=foo&host=${ALIAS}`)
    expect(res.status).toBe(503)
    expect(res.headers.get('x-walnut-handled-failure')).toBe('1')
    expect(await res.json()).toEqual({ error: 'Reconnecting to Cloud', code: 'host_reconnecting' })
  })
})
