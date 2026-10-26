/**
 * tests/helpers/live-connect-guard.cjs in a short-lived node child: a connect to a denied loopback
 * port is refused before it is made (net.connect with a port, with options, http, fetch) and
 * logged; an allowed port, another host and a unix socket pass. The child dials only listeners it
 * opened itself on 127.0.0.1.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LIVE_CONNECT_GUARD, liveEnv } from '../helpers/live-isolation.js'

const made: string[] = []
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

const CHILD = String.raw`
const net = require('node:net'), http = require('node:http')
const listen = () => new Promise((r) => { const s = net.createServer((c) => { c.on('error', () => {}); c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok') }); s.listen(0, '127.0.0.1', () => r(s)) })
const dial = (fn) => new Promise((r) => { const s = fn(); s.once('connect', () => { s.destroy(); r('connected') }); s.once('error', (e) => r(e.code + ' ' + e.message)) })
;(async () => {
  const denied = await listen(), allowed = await listen()
  const dp = denied.address().port, ap = allowed.address().port
  // The guard reads its ports at load; this child picks them after, so it loads the guard now.
  process.env.WALNUT_TEST_DENY_PORTS = String(dp)
  require(process.env.GUARD)
  const out = {}
  out.port = await dial(() => net.connect(dp, '127.0.0.1'))
  out.options = await dial(() => net.connect({ port: dp, host: 'localhost' }))
  out.allowed = await dial(() => net.connect({ port: ap, host: '127.0.0.1' }))
  out.http = await new Promise((r) => http.get('http://127.0.0.1:' + dp + '/x', () => r('answered')).on('error', (e) => r(e.code)))
  // undici wraps the socket error in a TypeError's cause; bun's guarded fetch rejects with it directly.
  out.fetch = await fetch('http://127.0.0.1:' + dp + '/x').then(() => 'answered', (e) => String((e.cause && e.cause.code) || e.code))
  out.fetchAllowed = await fetch('http://127.0.0.1:' + ap + '/x').then((res) => res.status, (e) => String(e))
  out.unix = await dial(() => net.connect(require('node:path').join(process.env.DIR, 'none.sock')))
  denied.close(); allowed.close()
  console.log(JSON.stringify({ dp, out }))
})()
`

describe('the live connect guard', () => {
  it('refuses and logs a denied loopback port, passes everything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-guard-'))
    made.push(dir)
    const log = path.join(dir, 'guard.log')
    const r = spawnSync(process.execPath, ['-e', CHILD], {
      env: { PATH: process.env.PATH, GUARD: LIVE_CONNECT_GUARD, WALNUT_TEST_CONNECT_GUARD_LOG: log, DIR: dir },
      encoding: 'utf8', timeout: 20_000,
    })
    expect(r.status, r.stderr).toBe(0)
    const { dp, out } = JSON.parse(r.stdout.trim().split('\n').at(-1)!)
    expect(out.port).toMatch(/^ECONNREFUSED live test guard: refused a connect to 127\.0\.0\.1:/)
    expect(out.options).toMatch(/^ECONNREFUSED live test guard: refused a connect to localhost:/)
    expect(out.http).toBe('ECONNREFUSED')
    expect(out.fetch).toBe('ECONNREFUSED')
    expect(out.allowed).toBe('connected')
    expect(out.fetchAllowed).toBe(200)
    expect(out.unix).toMatch(/^ENOENT/)
    // Not trimmed: under `node -e` a line ends with the tab before an empty argv.
    const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBe(4)
    for (const l of lines) expect(l).toContain(`:${dp}\t`)
  })

  it('is loaded by a child started with the live environment, bun included (BUN_OPTIONS)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-guard-env-'))
    made.push(dir)
    const env = liveEnv({ home: path.join(dir, 'home'), tmp: path.join(dir, 'tmp'), bins: [], guardLog: path.join(dir, 'guard.log') }, {})
    const r = spawnSync(process.execPath, ['-e', 'console.log(require("node:net").Socket.prototype.connect.name)'], { cwd: dir, env, encoding: 'utf8', timeout: 20_000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('guardedConnect')
  })

  it('stops a process that got the guard without its ports', () => {
    const r = spawnSync(process.execPath, ['--require', LIVE_CONNECT_GUARD, '-e', 'console.log("ran")'], {
      env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20_000,
    })
    expect(r.status).not.toBe(0)
    expect(r.stdout).not.toContain('ran')
    expect(r.stderr).toContain('WALNUT_TEST_DENY_PORTS is not set')
  })
})
