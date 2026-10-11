/**
 * The `code` the web client retries on, through the real routes.
 *
 * The Files tree and the viewer ask again on their own only when the answer says
 * `code: host_reconnecting` (web/src: SessionFileExplorer's batch listing,
 * FileContentView's payload); the sentence alone is not enough. The browser spec
 * (tests/e2e/browser/file-explorer-reconnect-retry.spec.ts) fakes these answers,
 * so this file pins the server half: each list-many item and the viewer's payload
 * carry the code while the host is not answering, and only then (gate links P1:
 * deleting either code left every other test green while the tree and the viewer
 * kept "Reconnecting to Cloud" after the host was back).
 *
 * Also the path picker's list-dirs `pending` answer after a failed connect: one
 * plain sentence, never the dial's own words (gate links P5).
 *
 * The pool is faked at the module boundary, as in host-read-bound-routes.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-reconnecting-code'))

type WouldWait = 'connected' | 'fails-fast' | 'dialing' | 'cold'
const pool = vi.hoisted(() => ({
  wouldWait: 'cold' as WouldWait,
  conn: null as null | { send: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> },
  alive: false,
  error: undefined as string | undefined,
  dialError: undefined as string | undefined,
}))
const never = <T>() => new Promise<T>(() => {})

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => {
    if (pool.dialError) throw new Error(pool.dialError)
    return pool.conn ?? never()
  },
  daemonConnectWouldWait: () => pool.wouldWait,
  probeDaemonLiveness: async () => pool.alive,
  getDaemonConnectState: (host: string) => ({
    host, connected: pool.wouldWait === 'connected', phase: pool.wouldWait === 'dialing' ? 'connect' : 'idle',
    phaseElapsedMs: 0, error: pool.error,
  }),
}))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({
    hosts: {
      devbox: { hostname: 'devbox.example.test', user: 'me', label: 'Big dev box' },
      __cloudbox__: { hostname: 'cloud.example.test' },
    },
  }),
}))
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async () => ({ host: '__cloudbox__', cwd: '/work' }),
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findByClaudeId: () => null },
}))
vi.mock('../../../src/core/hosts/host-connect-action.js', () => ({
  listDirsRoute: async () => ({ kind: 'dial' }),
}))

import { filesRouter } from '../../../src/web/routes/files.js'
import { fileContentRouter } from '../../../src/web/routes/file-content.js'
import { listSessionDirs } from '../../../src/core/sessions/session-extras.js'
import { HOST_READ_QUIET_MS, resetSharedHostReadsForTest } from '../../../src/core/hosts/remote-read-bound.js'

const ALIAS = '__cloudbox__'
/** The pool's own words for a companion tunnel that failed (gate links P5, the cloud matrix's fails-fast row). */
const RAW_DIAL = `Cloud companion tunnel failed: WebSocket connection failed: ECONNRESET (host=${ALIAS}, url=ws://127.0.0.1:64776/daemon-tunnel)`

let baseUrl = ''
let server: http.Server

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/files', filesRouter)
  app.use('/api/file-content', fileContentRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  pool.wouldWait = 'cold'
  pool.conn = null
  pool.alive = false
  pool.error = undefined
  pool.dialError = undefined
  resetSharedHostReadsForTest()
})

type Listing = { path: string; error?: string; code?: string; entries?: unknown[] }

async function listMany(host: string, paths: string[]): Promise<{ status: number; listings: Listing[] }> {
  const res = await fetch(`${baseUrl}/api/files/list-many`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ host, paths }),
  })
  const body = await res.json() as { listings: Listing[] }
  return { status: res.status, listings: [...body.listings].sort((a, b) => a.path.localeCompare(b.path)) }
}

async function viewerPayload(host: string, filePath: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/api/file-content?host=${encodeURIComponent(host)}&path=${encodeURIComponent(filePath)}`)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

/** A connected daemon: `fs.ls` lists `dirs`, any other path is ENOENT; reads answer `files`. */
const answering = (dirs: Record<string, string[]>, files: Record<string, string> = {}) => ({
  send: async (cmd: string, params: Record<string, unknown>) => {
    const p = params.path as string
    if (cmd === 'fs.ls') {
      return dirs[p] ? { ok: true, entries: dirs[p].map((name) => ({ name, type: 'file' })) } : { ok: false, error: `ENOENT: no such file or directory, scandir '${p}'` }
    }
    if (cmd === 'fs.stat') return files[p] === undefined ? { ok: true, exists: false } : { ok: true, exists: true, size: Buffer.byteLength(files[p]), mtimeMs: 1 }
    if (cmd === 'fs.read') return files[p] === undefined ? { ok: false, error: `EACCES: permission denied, open '${p}'` } : { ok: true, data: files[p] }
    return { ok: false, error: `unknown command: ${cmd}` }
  },
})

// files.ts imports the pool lazily (import() in onHost), once per listing, and
// list-many runs its listings on parallel workers. Under vi.mock two of those
// imports at once handed one worker the real module (it dialled a companion this
// file never paired; traced 2026-10-10), so a case that reaches the pool lists
// one path per request. A host still connecting answers before any import.
describe('list-many: every listing the host did not answer says so by code', () => {
  it('a host still connecting: each item is the sentence plus code host_reconnecting', async () => {
    pool.wouldWait = 'dialing'
    const { status, listings } = await listMany(ALIAS, ['/work', '/work/src'])
    expect(status).toBe(200)
    expect(listings).toEqual([
      { path: '/work', error: 'Reconnecting to Cloud', code: 'host_reconnecting' },
      { path: '/work/src', error: 'Reconnecting to Cloud', code: 'host_reconnecting' },
    ])
  })

  it('a host whose last dial failed: the plain sentence and the code, never the dial\'s words', async () => {
    pool.wouldWait = 'fails-fast'
    pool.error = RAW_DIAL
    pool.dialError = `Connection to ${ALIAS} failed 2s ago: ${RAW_DIAL}`
    const { listings } = await listMany(ALIAS, ['/work'])
    expect(listings).toEqual([{ path: '/work', error: "Can't reach Cloud right now.", code: 'host_reconnecting' }])
  })

  it('a connected link that went silent: the code too (an SSH host keeps its link: "is not answering")', async () => {
    pool.wouldWait = 'connected'
    pool.conn = { send: () => never<Record<string, unknown>>() }
    const { listings } = await listMany('devbox', ['/work'])
    expect(listings).toEqual([{ path: '/work', error: 'Big dev box is not answering', code: 'host_reconnecting' }])
  }, HOST_READ_QUIET_MS + 10_000)

  it('a folder the host answered with its own error has no code (the tree must not poll it); a folder it lists has none either', async () => {
    pool.wouldWait = 'connected'
    pool.conn = answering({ '/work': ['a.txt'] })
    const gone = (await listMany(ALIAS, ['/work/gone'])).listings
    expect(gone).toHaveLength(1)
    expect(gone[0].path).toBe('/work/gone')
    expect(gone[0].error).toMatch(/ENOENT/)
    expect(gone[0]).not.toHaveProperty('code')
    const listed = (await listMany(ALIAS, ['/work'])).listings
    expect(listed[0]).toMatchObject({ path: '/work', entries: [{ name: 'a.txt', type: 'file' }] })
    expect(listed[0]).not.toHaveProperty('code')
  })
})

describe('the viewer\'s payload: a host not answering says so by code', () => {
  it('a host still connecting: 200, no content, the sentence and code host_reconnecting', async () => {
    pool.wouldWait = 'dialing'
    const { status, body } = await viewerPayload(ALIAS, '/work/notes.md')
    expect(status).toBe(200)
    expect(body).toMatchObject({ content: null, error: 'Reconnecting to Cloud', code: 'host_reconnecting' })
  })

  it('a host whose last dial failed: the plain sentence and the code', async () => {
    pool.wouldWait = 'fails-fast'
    pool.error = RAW_DIAL
    pool.dialError = `Connection to ${ALIAS} failed 2s ago: ${RAW_DIAL}`
    const { body } = await viewerPayload(ALIAS, '/work/notes.md')
    expect(body).toMatchObject({ content: null, error: "Can't reach Cloud right now.", code: 'host_reconnecting' })
  })

  it('a read the host refused has no code (the viewer must not poll it)', async () => {
    pool.wouldWait = 'connected'
    // fs.stat says the file is there; the read is refused.
    const there = answering({}, { '/work/locked.md': 'x' })
    pool.conn = { send: async (cmd, params) => (cmd === 'fs.read' ? { ok: false, error: 'EACCES: permission denied' } : there.send(cmd, params)) }
    const { status, body } = await viewerPayload(ALIAS, '/work/locked.md')
    expect(status).toBe(200)
    expect(body.content).toBeNull()
    expect(body.error).toMatch(/EACCES/)
    expect(body).not.toHaveProperty('code')
  })

  it('a host that answers: the file, no code', async () => {
    pool.wouldWait = 'connected'
    pool.conn = answering({}, { '/work/notes.md': 'hello' })
    const { body } = await viewerPayload(ALIAS, '/work/notes.md')
    expect(body.content).toBe('hello')
    expect(body).not.toHaveProperty('code')
  })
})

describe('the path picker (list-dirs pending) after a failed connect', () => {
  it('one plain sentence in the host\'s name; kind and hint carry the cause, the dial\'s words stay in the log', async () => {
    pool.wouldWait = 'fails-fast'
    pool.error = RAW_DIAL
    pool.dialError = `Connection to ${ALIAS} failed 2s ago: ${RAW_DIAL}`
    const result = await listSessionDirs('~/', ALIAS, 1, { pending: true, waitMs: 2_000 })
    expect(result.dirs).toEqual([])
    expect(result.hostError?.message).toBe("Can't reach Cloud right now.")
    expect(typeof result.hostError?.kind).toBe('string')
    const said = JSON.stringify(result.hostError)
    for (const raw of ['ECONNRESET', 'ws://', '127.0.0.1', 'daemon-tunnel', ALIAS]) expect(said).not.toContain(raw)
  })
})
