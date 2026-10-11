/**
 * Each route that reads through a remote host's daemon answers within the
 * host-read deadline (core/hosts/remote-read-bound.ts), and every sentence it
 * answers with names the host by its label, never the internal alias.
 *
 * Pinned per route, with the pool faked at the module boundary (no ssh, no
 * socket): while the host is connecting the answer is immediate; on a connected
 * link that stopped answering (a companion that holds the tunnel open and
 * forwards nothing) the answer comes at the quiet point plus one probe, not at
 * the daemon's 30s command timeout. Routes:
 *  - the slash palette's remote scan (it waited on the dial with no bound),
 *    and a session palette's recovery of the CLI's names from the stream;
 *  - the phone's /api/v1/media daemon fetch (the same);
 *  - files/list (a 15s timer whose sentence named the alias, then a 500);
 *  - list-dirs (the fixture route's 15s sentence, and the dial route's cap);
 *  - quick-start's ensureCwd (its 15s sentence named the alias);
 *  - file content: its "Cannot reach" sentence, the bytes it asks a host for
 *    (only the 512KB the viewer shows) and one read for many requests.
 */
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-read-bound-routes'))

type WouldWait = 'connected' | 'fails-fast' | 'dialing' | 'cold'
const pool = vi.hoisted(() => ({
  wouldWait: 'cold' as WouldWait,
  /** What getDaemonConnection hands out: null = the dial never settles. */
  conn: null as null | { send: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> },
  dials: 0,
  probes: 0,
  /** The liveness probe's verdict. */
  alive: false,
  /** The pool's cached failure (getDaemonConnectState().error). */
  error: undefined as string | undefined,
  /** fails-fast: the dial rejects at once with this. */
  dialError: undefined as string | undefined,
  /** The dial's rejection is tagged as this link failure (as the pool tags its own). */
  dialLink: undefined as undefined | 'no-link',
  /** The dial settles (with `conn`) after this long. */
  dialDelayMs: 0,
}))
const never = <T>() => new Promise<T>(() => {})

vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnection: async () => {
    pool.dials++
    if (pool.dialDelayMs) {
      await new Promise((r) => setTimeout(r, pool.dialDelayMs))
      // A dial that lands leaves the pool connected, as the real one does.
      if (pool.conn && !pool.dialError) pool.wouldWait = 'connected'
    }
    if (pool.dialError) {
      const err = new Error(pool.dialError)
      if (pool.dialLink) (await import('../../../src/providers/link-failure.js')).markLinkFailure(err, pool.dialLink)
      throw err
    }
    return pool.conn ?? never()
  },
  daemonConnectWouldWait: () => pool.wouldWait,
  probeDaemonLiveness: async () => {
    pool.probes++
    return pool.alive
  },
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
// No live process: the session palette recovers the CLI's command names from the stream.
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findByClaudeId: () => null },
}))
// list-dirs asks which route a host lists through; a test picks it.
const listRoute = vi.hoisted(() => ({ value: { kind: 'dial' } as Record<string, unknown> }))
vi.mock('../../../src/core/hosts/host-connect-action.js', () => ({
  listDirsRoute: async () => listRoute.value,
}))

import { buildSessionSlashCommandItems, buildSlashCommandItems } from '../../../src/web/routes/slash-commands.js'
import { mediaV1Router } from '../../../src/web/routes/media-v1.js'
import { filesRouter } from '../../../src/web/routes/files.js'
import { listSessionDirs } from '../../../src/core/sessions/session-extras.js'
import { ensureCwd } from '../../../src/core/sessions/ensure-cwd.js'
import { HOST_READ_DIAL_CAP_MS, HOST_READ_QUIET_MS, resetSharedHostReadsForTest } from '../../../src/core/hosts/remote-read-bound.js'
import { readFileContentPayload } from '../../../src/web/routes/file-content.js'

const ALIAS = '__cloudbox__'
const silentConn = { send: () => never<Record<string, unknown>>() }

let baseUrl = ''
let server: http.Server

beforeAll(async () => {
  const app = express()
  app.use('/api/v1', mediaV1Router)
  app.use('/api/files', filesRouter)
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
  pool.dials = 0
  pool.probes = 0
  pool.alive = false
  pool.error = undefined
  pool.dialError = undefined
  pool.dialLink = undefined
  pool.dialDelayMs = 0
  listRoute.value = { kind: 'dial' }
  resetSharedHostReadsForTest()
})

afterEach(() => {
  vi.useRealTimers()
})

/** `work`, or a loud failure after `ms` (a route that waits on the dial never settles here). */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<{ value: T; ms: number }> {
  const t0 = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms}ms`)), ms) })
  try {
    const value = await Promise.race([work, late])
    return { value, ms: Date.now() - t0 }
  } finally {
    clearTimeout(timer)
  }
}

/** Settle `work` under fake timers, advancing the clock a second at a time. */
async function settleOnFakeClock<T>(work: Promise<T>, maxSecs = 30): Promise<T> {
  let done = false
  const tracked = work.finally(() => { done = true })
  for (let i = 0; i < maxSecs && !done; i++) await vi.advanceTimersByTimeAsync(1_000)
  return tracked
}

describe('slash palette: the remote scan is bounded', () => {
  it('a host still connecting answers degraded at once (the scan waited on the dial)', async () => {
    pool.wouldWait = 'dialing'
    const { value, ms } = await within(buildSlashCommandItems({ host: ALIAS, cwd: '/work', fresh: true }), 2_000, 'slash scan')
    expect(value.degraded).toBe(true)
    expect(value.items.length).toBeGreaterThan(0) // Walnut + built-in commands still offered
    expect(ms).toBeLessThan(1_000)
    expect(pool.dials).toBe(0)
  })

  it('a connected link that went silent answers degraded at the quiet point plus one probe', async () => {
    pool.wouldWait = 'connected'
    pool.conn = silentConn
    const { value, ms } = await within(buildSlashCommandItems({ host: ALIAS, cwd: '/work', fresh: true }), HOST_READ_QUIET_MS + 3_000, 'slash scan')
    expect(value.degraded).toBe(true)
    expect(pool.probes).toBe(1)
    expect(ms).toBeGreaterThanOrEqual(HOST_READ_QUIET_MS - 100)
  })
})

describe('a session\'s slash palette: the stream recovery is bounded too', () => {
  it('a host still connecting answers degraded at once (the stream stats waited on the dial: 25s)', async () => {
    pool.wouldWait = 'dialing'
    const { value, ms } = await within(buildSessionSlashCommandItems({ sessionId: 'sid-remote-1', fresh: true }), 2_000, 'session slash')
    expect(value.degraded).toBe(true)
    expect(ms).toBeLessThan(1_000)
    expect(pool.dials).toBe(0)
  })

  it('a connected link that went silent answers degraded after one probe, not after the 30s command timeout', async () => {
    pool.wouldWait = 'connected'
    pool.conn = silentConn
    const { value, ms } = await within(buildSessionSlashCommandItems({ sessionId: 'sid-remote-2', fresh: true }), HOST_READ_QUIET_MS * 2 + 3_000, 'session slash')
    expect(value.degraded).toBe(true)
    // The stream recovery asked the host and it did not answer: the discovery
    // after it degrades at once, not after a second quiet window and probe
    // (9s on a silent SSH link where one ask takes 6s).
    expect(pool.probes).toBe(1)
    expect(ms).toBeLessThan(HOST_READ_QUIET_MS + 1_500)
  })

  it('a refresh (fresh) on a host that just did not answer degrades at once even with a scan cached: it does not ask the silent link again', async () => {
    // A scan of this host and folder is cached from when it answered.
    pool.wouldWait = 'connected'
    pool.alive = true
    pool.conn = { send: async () => ({ ok: true, entries: [], files: [], skills: [] }) }
    const warm = await buildSlashCommandItems({ host: ALIAS, cwd: '/work', fresh: true })
    expect(warm.degraded).toBeUndefined()
    // Then the link goes silent, and the palette is refreshed.
    pool.alive = false
    pool.conn = silentConn
    pool.probes = 0
    const { value, ms } = await within(buildSessionSlashCommandItems({ sessionId: 'sid-remote-3', fresh: true }), HOST_READ_QUIET_MS * 3 + 3_000, 'session slash')
    expect(value.degraded).toBe(true)
    // One ask (the stream recovery), not a second one for the forced re-scan.
    expect(pool.probes).toBe(1)
    expect(ms).toBeLessThan(HOST_READ_QUIET_MS + 1_500)
  }, 20_000)
})

describe('/api/v1/media: the daemon fetch is bounded', () => {
  const url = () => `${baseUrl}/api/v1/media?path=${encodeURIComponent('/remote-only/shot.png')}&session=sid-remote-1`

  it('a host still connecting answers 404 at once, without dialling', async () => {
    pool.wouldWait = 'dialing'
    const { value: res, ms } = await within(fetch(url()), 2_000, 'v1 media')
    expect(res.status).toBe(404)
    expect(ms).toBeLessThan(1_000)
    expect(pool.dials).toBe(0)
  })

  it('a connected link that went silent answers at the quiet point plus one probe, not after two 30s command timeouts', async () => {
    pool.wouldWait = 'connected'
    pool.conn = silentConn
    const { value: res } = await within(fetch(url()), HOST_READ_QUIET_MS + 3_000, 'v1 media')
    expect(res.status).toBe(404)
    expect(pool.probes).toBe(1)
  })
})

describe('files/list: degraded in the host\'s name', () => {
  const url = (host: string) => `${baseUrl}/api/files/list?host=${encodeURIComponent(host)}&path=${encodeURIComponent('/work')}`

  it('a host still connecting: 503 host_reconnecting at once, marked handled, the label not the alias', async () => {
    pool.wouldWait = 'dialing'
    const { value: res, ms } = await within(fetch(url(ALIAS)), 2_000, 'files/list')
    expect(res.status).toBe(503)
    expect(res.headers.get('x-walnut-handled-failure')).toBe('1')
    const body = await res.json() as { error: string; code: string }
    expect(body).toEqual({ error: 'Reconnecting to Cloud', code: 'host_reconnecting' })
    expect(ms).toBeLessThan(1_000)
  })

  it('a dial this request started waits at most the cap, then the same sentence (it was a 15s timer naming the alias)', async () => {
    const { value: res, ms } = await within(fetch(url(ALIAS)), HOST_READ_DIAL_CAP_MS + 3_000, 'files/list')
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('Reconnecting to Cloud')
    expect(body.error).not.toContain(ALIAS)
    expect(ms).toBeGreaterThanOrEqual(HOST_READ_DIAL_CAP_MS - 100)
  })

  it('a connected link that went silent: 503 at the quiet point plus one probe (it was 30s, then a 500)', async () => {
    pool.wouldWait = 'connected'
    pool.conn = silentConn
    const { value: res } = await within(fetch(url('devbox')), HOST_READ_QUIET_MS + 3_000, 'files/list')
    expect(res.status).toBe(503)
    // An SSH host's link is kept, so the sentence says what is true: it does not answer.
    expect(((await res.json()) as { error: string }).error).toBe('Big dev box is not answering')
    expect(pool.probes).toBe(1)
  })

  it('a known connect failure: one plain sentence at once, never the pool\'s words (errno, URL, dial line)', async () => {
    pool.wouldWait = 'fails-fast'
    pool.error = `Cloud companion tunnel failed: WebSocket connection failed: ECONNRESET (host=${ALIAS}, url=ws://127.0.0.1:53389/daemon-tunnel)`
    // fails-fast: the dial answers at once with the cached failure, in the pool's words.
    pool.dialError = `Connection to ${ALIAS} failed 2s ago: ${pool.error}`
    const { value: res, ms } = await within(fetch(url(ALIAS)), 2_000, 'files/list')
    expect(res.status).toBe(503)
    const body = await res.json() as { error: string; code?: string }
    expect(body).toEqual({ error: "Can't reach Cloud right now.", code: 'host_reconnecting' })
    expect(ms).toBeLessThan(1_000)
  })
})

describe('files/resolve-path: one wait on a silent host, then the naive path', () => {
  it('a host resolver that went silent is not asked again through the legacy walk (it was 6s, then 5s more)', async () => {
    pool.wouldWait = 'connected'
    pool.conn = { ...silentConn, hasCapability: (c: string) => c === 'path-resolve-v1' } as unknown as typeof pool.conn
    const url = `${baseUrl}/api/files/resolve-path?rel=${encodeURIComponent('src/a.ts:42')}&cwd=${encodeURIComponent('/work')}&host=devbox`
    const { value: res, ms } = await within(fetch(url), HOST_READ_QUIET_MS * 2, 'resolve-path')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/work/src/a.ts', resolved: false, degraded: true, line: 42 })
    expect(pool.probes).toBe(1)
    expect(ms).toBeLessThan(HOST_READ_QUIET_MS + 2_000)
  })
})

describe('list-dirs: every timeout sentence names the label', () => {
  it('the dial route without pending: 503 host_reconnecting at the dial cap, in the label', async () => {
    const err = await within(listSessionDirs('~/', ALIAS, 1).then(() => null, (e: Error & { statusCode?: number }) => e), HOST_READ_DIAL_CAP_MS + 3_000, 'list-dirs')
    expect(err.value?.statusCode).toBe(503)
    expect(err.value?.message).toBe('Reconnecting to Cloud')
  })

  it('the fixture route without pending: the 15s timeout reads in the label (it named the alias)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    listRoute.value = {
      kind: 'fixture',
      connect: () => never(),
      state: (host: string) => ({ host, connected: false, phase: 'connect', phaseElapsedMs: 0 }),
    }
    const err = await settleOnFakeClock(listSessionDirs('~/fixture/', ALIAS, 1).then(() => null, (e: Error & { statusCode?: number }) => e))
    expect(err?.statusCode).toBe(400)
    expect(err?.message).toBe('Remote connection to Cloud timed out')
  })
})

describe('quick-start ensureCwd: every sentence names the label', () => {
  it('a dial that never answers: reconnecting (503 host_reconnecting), in the label, never "the connection timed out"', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const err = await settleOnFakeClock(ensureCwd('/work/new', ALIAS).then(() => null, (e: Error & { statusCode?: number; body?: unknown }) => e))
    expect(err?.message).toBe('Reconnecting to Cloud, so the folder was not created. Try again in a moment.')
    expect(err?.statusCode).toBe(503)
    expect(err?.body).toEqual({ code: 'host_reconnecting', host: ALIAS })
  })

  it('a dial already under way is waited for (a user action): the folder is made once it connects', async () => {
    pool.wouldWait = 'dialing'
    pool.dialDelayMs = 300
    const sent: string[] = []
    pool.conn = { send: async (cmd, params) => { sent.push(`${cmd} ${String(params.path)}`); return { ok: true } } }
    const { value: err } = await within(ensureCwd('/work/new', ALIAS).then(() => null, (e: Error) => e), 5_000, 'ensureCwd')
    expect(err).toBeNull()
    expect(sent).toEqual(['fs.mkdir /work/new'])
  })

  it('a dial that fails: reconnecting, one plain sentence; the dial\'s own words (errno, URL) only in the log', async () => {
    pool.dialError = 'Cloud companion tunnel failed: WebSocket connection failed: ECONNRESET (host=__cloudbox__, url=ws://127.0.0.1:9/daemon-tunnel)'
    pool.dialLink = 'no-link'
    const err = await ensureCwd('/work/new', ALIAS).then(() => null, (e: Error & { statusCode?: number; body?: unknown }) => e)
    expect(err?.statusCode).toBe(503)
    expect(err?.message).toBe('Reconnecting to Cloud, so the folder was not created. Try again in a moment.')
    expect(err?.body).toEqual({ code: 'host_reconnecting', host: ALIAS })
  })

  it('a dial failure that is not the link stays the folder\'s 400, in the label', async () => {
    pool.dialError = `Unknown host ${ALIAS} in config`
    const err = await ensureCwd('/work/new', ALIAS).then(() => null, (e: Error & { statusCode?: number }) => e)
    expect(err?.statusCode).toBe(400)
    expect(err?.message).toBe('Cannot create directory on Cloud: Unknown host Cloud in config')
  })

  it('a mkdir failure that names the alias is put in the host\'s terms', async () => {
    pool.wouldWait = 'connected'
    pool.conn = { send: async () => ({ ok: false, error: `fs.mkdir failed on ${ALIAS}: EACCES` }) }
    const err = await ensureCwd('/work/new', ALIAS).then(() => null, (e: Error) => e)
    expect(err?.message).toBe('Cannot create directory on Cloud: fs.mkdir failed on Cloud: EACCES')
  })

  it('a connected link that went silent fails the mkdir at the quiet point plus one probe, in the label', async () => {
    pool.wouldWait = 'connected'
    pool.conn = silentConn
    const { value: err } = await within(ensureCwd('/work/new', 'devbox').then(() => null, (e: Error & { statusCode?: number }) => e), HOST_READ_QUIET_MS + 3_000, 'ensureCwd')
    // The mkdir was asked: it may have happened, and asking again is safe.
    expect(err?.message).toBe('Big dev box stopped answering while creating the folder, so it may or may not exist. Try again: creating it twice is safe.')
    expect(err?.statusCode).toBe(503)
    expect(pool.probes).toBe(1)
  })
})

describe('file content on a remote host', () => {
  /** A connected host whose daemon answers from `files` (path → text), recording each command. */
  const daemonWith = (files: Record<string, string>, sent: string[], opts: { readDelayMs?: number; readError?: string } = {}) => ({
    send: async (cmd: string, params: Record<string, unknown>) => {
      sent.push(cmd)
      const text = files[params.path as string]
      if (cmd === 'fs.stat') return text === undefined ? { ok: true, exists: false } : { ok: true, exists: true, size: Buffer.byteLength(text), mtimeMs: 1 }
      if (opts.readDelayMs) await new Promise((r) => setTimeout(r, opts.readDelayMs))
      if (opts.readError) return { ok: false, error: opts.readError }
      if (cmd === 'fs.read') return { ok: true, data: text }
      if (cmd === 'fs.readRange') {
        const buf = Buffer.from(text, 'utf-8').subarray(params.start as number, (params.start as number) + (params.length as number))
        return { ok: true, data: buf.toString('base64'), bytesRead: buf.length, fileSize: Buffer.byteLength(text), eof: (params.start as number) + buf.length >= Buffer.byteLength(text) }
      }
      return { ok: false, error: `unknown command: ${cmd}` }
    },
  })

  it('a read the host failed says "Cannot reach" with the host\'s label, the alias put in its terms', async () => {
    pool.wouldWait = 'connected'
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/notes.md': 'hello' }, sent, { readError: `EACCES: permission denied on ${ALIAS}` })
    const payload = await readFileContentPayload('/work/notes.md', ALIAS)
    expect(payload.content).toBeNull()
    expect(payload.error).toBe('Cannot reach Cloud: fs.read transport failure: EACCES: permission denied on Cloud')
    pool.conn = daemonWith({ '/work/notes.md': 'hello' }, sent, { readError: 'EACCES: permission denied on devbox' })
    const ssh = await readFileContentPayload('/work/notes.md', 'devbox')
    expect(ssh.error).toBe('Cannot reach Big dev box: fs.read transport failure: EACCES: permission denied on Big dev box')
  })

  it('a file over 512KB: only the 512KB the viewer shows crosses the link, in one range read', async () => {
    pool.wouldWait = 'connected'
    const sent: string[] = []
    const big = 'x'.repeat(3 * 1024 * 1024)
    pool.conn = daemonWith({ '/work/big.log': big }, sent)
    const payload = await readFileContentPayload('/work/big.log', ALIAS)
    expect(payload.error).toBeUndefined()
    expect(payload.content?.length).toBe(512 * 1024)
    expect(payload).toMatchObject({ truncated: true, size: big.length, binary: false })
    expect(payload.contentHash).toBeUndefined()
    expect(sent).toEqual(['fs.stat', 'fs.readRange'])
  })

  it('a file just over 512KB is read whole as text: the base64 range would be the bigger transfer', async () => {
    pool.wouldWait = 'connected'
    const sent: string[] = []
    const over = 'z'.repeat(600 * 1024)
    pool.conn = daemonWith({ '/work/over.log': over }, sent)
    const payload = await readFileContentPayload('/work/over.log', ALIAS)
    expect(payload).toMatchObject({ truncated: true, size: over.length })
    expect(payload.content?.length).toBe(512 * 1024)
    expect(sent.filter((c) => c === 'fs.readRange')).toHaveLength(0)
    expect(sent.filter((c) => c === 'fs.read')).toHaveLength(1)
  })

  it('a small file is read whole, with the hash a save is checked against', async () => {
    pool.wouldWait = 'connected'
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/a.ts': 'export const a = 1\n' }, sent)
    const payload = await readFileContentPayload('/work/a.ts', ALIAS)
    expect(payload).toMatchObject({ content: 'export const a = 1\n', truncated: false })
    expect(typeof payload.contentHash).toBe('string')
    expect(sent.filter((c) => c === 'fs.read')).toHaveLength(1)
  })

  it('many requests for one file at once: one read reaches the host', async () => {
    pool.wouldWait = 'connected'
    const sent: string[] = []
    pool.conn = daemonWith({ '/work/big.log': 'y'.repeat(2 * 1024 * 1024) }, sent, { readDelayMs: 100 })
    const all = await Promise.all([1, 2, 3, 4].map(() => readFileContentPayload('/work/big.log', ALIAS)))
    expect(all.every((p) => p.content?.length === 512 * 1024)).toBe(true)
    expect(sent.filter((c) => c === 'fs.readRange')).toHaveLength(1)
  })
})
