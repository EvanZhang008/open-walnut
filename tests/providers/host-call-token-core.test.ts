/**
 * The host call entry's tokens (host-call-token-core.ts): one key per daemon dir, made once
 * (0600, never through a link, never seen half made by a second opener) and kept across daemon
 * restarts; a token per RUN of a caller sid (a nonce recorded beside the key), checked in constant
 * time against that sid's current run, so the next run of the sid ends the old token; the
 * follower's entry socket kept only as this daemon dir's private entry socket. Run as imported and
 * as the text the source twin inlines.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { HOST_CALL_SOCKET_DIR, HOST_CALL_SOCKET_MAX_BYTES, createHostCallTokens, hostCallSocketPath } from '../../src/providers/host-call-token-core.js'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { bunRuntime } from '../helpers/bun-runtime.js'

let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hct-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const uid = typeof process.getuid === 'function' ? process.getuid() : null
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const inlined = new Function(`"use strict"; return (${createHostCallTokens.toString()})`)() as typeof createHostCallTokens

const keyOf = () => Buffer.from(fs.readFileSync(path.join(dir, 'host-call.key'), 'utf8').trim(), 'hex')
const runsOf = () => JSON.parse(fs.readFileSync(path.join(dir, 'host-call-runs.json'), 'utf8')).runs as Record<string, [string, number]>

describe.each([['imported', createHostCallTokens], ['inlined', inlined]] as const)('host call tokens (%s)', (_label, make) => {
  const tokens = (over: Partial<Parameters<typeof createHostCallTokens>[0]> = {}) => make({ fs, path, crypto, dir, uid, ...over })

  it('makes one private key on first use; a restarted daemon in the same dir takes a live run\'s token', () => {
    const a = tokens()
    const t = a.issue('sid-1')
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(fs.statSync(path.join(dir, 'host-call.key')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'host-call-runs.json')).mode & 0o777).toBe(0o600)
    // A restarted daemon: the run is still current, its token still good.
    const b = tokens()
    expect(b.verify('sid-1', t)).toBe(true)
    // No temp file left behind.
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('a token of a previous run of the same sid is refused; the current one is good; a retired run takes none', () => {
    const a = tokens()
    const first = a.issue('sid-1')!
    const second = a.issue('sid-1')!
    expect(second).not.toBe(first)
    expect(a.verify('sid-1', first)).toBe(false)
    expect(a.verify('sid-1', second)).toBe(true)
    // Another daemon of this dir (a handover) sees the new run too.
    expect(tokens().verify('sid-1', first)).toBe(false)
    expect(tokens().verify('sid-1', second)).toBe(true)
    a.retire('sid-1')
    expect(a.verify('sid-1', second)).toBe(false)
    expect(runsOf()).not.toHaveProperty('sid-1')
  })

  it('a run started by another daemon of this dir after this one read the runs is seen at once', () => {
    const a = tokens()
    a.issue('sid-0')
    const t = tokens().issue('sid-2')!
    expect(a.verify('sid-2', t)).toBe(true)
  })

  it('a token is good for its own sid only, and anything that is not a token is refused', () => {
    const a = tokens()
    const t = a.issue('sid-1')!
    a.issue('sid-2')
    expect(a.verify('sid-2', t)).toBe(false)
    expect(a.verify('sid-1', t.toUpperCase())).toBe(false)
    expect(a.verify('sid-1', t.slice(1))).toBe(false)
    expect(a.verify('sid-1', '')).toBe(false)
    expect(a.verify('sid-1', undefined)).toBe(false)
    expect(a.verify(undefined, t)).toBe(false)
    expect(a.verify('', t)).toBe(false)
    expect(a.verify('never-ran', t)).toBe(false)
    expect(a.issue('')).toBeNull()
    // HMAC-SHA256 of the sid and its run's nonce under the key file's bytes.
    const [nonce] = runsOf()['sid-1']!
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(t).toBe(crypto.createHmac('sha256', keyOf()).update('sid-1\n' + nonce).digest('hex'))
  })

  it('keeps at most maxRuns runs (1024 by default), the oldest going first', () => {
    let at = 0
    const a = tokens({ now: () => ++at, maxRuns: 5 })
    const first = a.issue('old')!
    for (let i = 0; i < 5; i++) a.issue(`s${i}`)
    expect(Object.keys(runsOf()).sort()).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect(a.verify('old', first)).toBe(false)
    expect(createHostCallTokens.toString()).toMatch(/maxRuns \?\? 1024/)
  })

  it('a key file another user could read is never used nor replaced: no tokens, the socket stays the way', () => {
    fs.writeFileSync(path.join(dir, 'host-call.key'), 'ab'.repeat(32) + '\n', { mode: 0o644 })
    fs.chmodSync(path.join(dir, 'host-call.key'), 0o644)
    const logs: string[] = []
    const a = make({ fs, path, crypto, dir, uid, log: (_l, msg) => { logs.push(msg) } })
    expect(a.issue('sid-1')).toBeNull()
    expect(a.verify('sid-1', 'ab'.repeat(32))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'host-call.key'), 'utf8').trim()).toBe('ab'.repeat(32))
    expect(logs.some((m) => m.includes('no token key'))).toBe(true)
  })

  it('a runs file another user could read takes no token and is never replaced', () => {
    const t = tokens().issue('sid-1')!
    fs.chmodSync(path.join(dir, 'host-call-runs.json'), 0o644)
    const a = tokens()
    expect(a.verify('sid-1', t)).toBe(false)
    expect(a.issue('sid-2')).toBeNull()
    expect(fs.statSync(path.join(dir, 'host-call-runs.json')).mode & 0o777).toBe(0o644)
  })

  it('a key file that is a link is never followed', () => {
    const target = path.join(dir, 'elsewhere')
    fs.writeFileSync(target, 'cd'.repeat(32) + '\n', { mode: 0o600 })
    fs.symlinkSync(target, path.join(dir, 'host-call.key'))
    expect(tokens().issue('sid-1')).toBeNull()
  })

  it('a key file with no key in it gives no tokens', () => {
    fs.writeFileSync(path.join(dir, 'host-call.key'), 'not a key\n', { mode: 0o600 })
    expect(tokens().issue('sid-1')).toBeNull()
  })

  it('envFor: the socket the follower said and a token of a new run; no socket: none, and the old run ends', () => {
    let socket: string | undefined = '/d/host-call/0123456789abcdef.sock'
    const a = tokens({ socketFor: (home) => (home === '/h' ? socket : undefined) })
    const env = a.envFor('/h', 'sid-1')
    expect(env).toEqual({ WALNUT_CALL_SOCKET: '/d/host-call/0123456789abcdef.sock', WALNUT_CALL_TOKEN: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(a.verify('sid-1', env.WALNUT_CALL_TOKEN)).toBe(true)
    expect(a.envFor('/other', 'sid-2')).toEqual({})
    expect(a.envFor('/h', '')).toEqual({})
    socket = undefined
    expect(a.envFor('/h', 'sid-1')).toEqual({})
    expect(a.verify('sid-1', env.WALNUT_CALL_TOKEN)).toBe(false)
    // With no entry ever on, nothing is written at all.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'hct-'))
    try {
      expect(make({ fs, path, crypto, dir: fresh, uid }).envFor('/h', 'sid-1')).toEqual({})
      expect(fs.readdirSync(fresh)).toEqual([])
    } finally { fs.rmSync(fresh, { recursive: true, force: true }) }
  })
})

describe('the follower\'s entry socket, as the daemon keeps it', () => {
  async function listen(p: string): Promise<http.Server> {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
    const s = http.createServer()
    await new Promise<void>((resolve) => s.listen(p, () => resolve()))
    fs.chmodSync(p, 0o600)
    return s
  }

  it.each([['imported', createHostCallTokens], ['inlined', inlined]] as const)('%s: only this dir\'s entry path to a private socket of this uid', async (_l, make) => {
    const t = make({ fs, path, crypto, dir, uid })
    const good = hostCallSocketPath(path, crypto, dir, 'wmarina01')
    expect(path.dirname(good)).toBe(path.join(dir, HOST_CALL_SOCKET_DIR))
    expect(path.basename(good)).toMatch(/^[0-9a-f]{16}\.sock$/)
    // Not there yet: not kept.
    expect(t.socketOf(good)).toBeUndefined()
    const server = await listen(good)
    try {
      expect(t.socketOf(good)).toBe(good)
      // Traversal, relative, another dir, another name, a URL, too long: never.
      for (const bad of [
        `${dir}/${HOST_CALL_SOCKET_DIR}/../${HOST_CALL_SOCKET_DIR}/${path.basename(good)}`,
        `${dir}/${HOST_CALL_SOCKET_DIR}//${path.basename(good)}`,
        path.relative(process.cwd(), good),
        path.join(dir, path.basename(good)),
        path.join(dir, HOST_CALL_SOCKET_DIR, 'other.sock'),
        'http://127.0.0.1:4100/api/host/call',
        '/' + 'a'.repeat(HOST_CALL_SOCKET_MAX_BYTES) + '.sock',
        '', null, 42,
      ]) expect(t.socketOf(bad), String(bad)).toBeUndefined()
      // A socket others may open: never.
      fs.chmodSync(good, 0o666)
      expect(t.socketOf(good)).toBeUndefined()
    } finally {
      await new Promise((r) => server.close(() => r(null)))
    }
    // A regular file at that path: never.
    fs.writeFileSync(good, '', { mode: 0o600 })
    expect(t.socketOf(good)).toBeUndefined()
  })
})

describe('the key race: two daemons of one dir making the key at once', () => {
  it('every opener ends with the same whole key; none sees it empty and gives up', async () => {
    // Real processes, started together, each making the key and saying the token of one sid's run
    // it records: all keys equal (the file is whole the moment it exists).
    const coreUrl = new URL('../../src/providers/host-call-token-core.ts', import.meta.url).href
    const script = `
      import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path'
      const { createHostCallTokens } = await import(${JSON.stringify(coreUrl)})
      const t = createHostCallTokens({ fs, path, crypto, dir: process.argv[2], uid: process.getuid ? process.getuid() : null, log: (l, m, d) => { if (l === 'warn') console.error(m, JSON.stringify(d)) } })
      const go = Number(process.argv[3]); while (Date.now() < go) { /* start together */ }
      const tok = t.issue('sid-' + process.pid)
      console.log(JSON.stringify({ ok: tok !== null, key: fs.readFileSync(path.join(process.argv[2], 'host-call.key'), 'utf8').trim() }))
    `
    const file = path.join(dir, 'race.mjs')
    fs.writeFileSync(file, script)
    const go = Date.now() + 1_500
    const runs = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
      const c = spawn(bunRuntime(), [file, dir, String(go)], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''; let err = ''
      c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
      c.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err}`))))
    })))
    const said = runs.map((r) => JSON.parse(r) as { ok: boolean; key: string })
    expect(said.every((r) => r.ok), JSON.stringify(said)).toBe(true)
    expect(new Set(said.map((r) => r.key)).size).toBe(1)
    expect(said[0]!.key).toMatch(/^[0-9a-f]{64}$/)
  }, 60_000)

  it('the opener that loses the link() reads the winner\'s whole key, never a half-made one', () => {
    // The moment of the race, made exact: another opener's whole key appears just before this link().
    const winner = 'ef'.repeat(32)
    let raced = false
    const racingFs = { ...fs, linkSync: (from: fs.PathLike, to: fs.PathLike) => {
      if (!raced) {
        raced = true
        const theirs = path.join(dir, 'theirs.tmp')
        fs.writeFileSync(theirs, winner + '\n', { mode: 0o600 })
        fs.linkSync(theirs, to)
        fs.unlinkSync(theirs)
      }
      return fs.linkSync(from, to)
    } } as typeof fs
    const t = createHostCallTokens({ fs: racingFs, path, crypto, dir, uid })
    const tok = t.issue('sid-1')
    expect(raced).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'host-call.key'), 'utf8').trim()).toBe(winner)
    expect(tok).toBe(crypto.createHmac('sha256', Buffer.from(winner, 'hex')).update('sid-1\n' + runsOf()['sid-1']![0]).digest('hex'))
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('host call tokens in the source twin', () => {
  it('the generated daemon carries the inlined factory with no placeholder left', () => {
    const generated = getDaemonSource()
    expect(generated).not.toContain('__CREATE_HOST_CALL_TOKENS__')
    expect(generated).toContain(`var hostCallTokens = (${createHostCallTokens.toString()})(`)
    // The factory keeps its own copies of the module's socket constants.
    expect(createHostCallTokens.toString()).toMatch(new RegExp(`['"]${HOST_CALL_SOCKET_DIR}['"]`))
    expect(createHostCallTokens.toString()).toContain(String(HOST_CALL_SOCKET_MAX_BYTES))
  })
})
