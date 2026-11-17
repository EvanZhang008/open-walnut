/**
 * A trigger check's own `walnut tools call` on the Mac goes to the API over HTTP, so the daemon
 * running the check never sees a 507 it got. The CLI tells it (tools-daemon-fallback.ts
 * reportCheckOutcome): one line on WALNUT_CHECK_SOCKET with the fault's kind, read from the answer's
 * status and code (2026-11-16: a full Mac disk failed nine checks at once).
 *
 * Covered: the real executor against an API that answers like the disk guard, then the report on a
 * fake daemon socket; no report for the script's own errors, outside a check, or inside a session.
 *
 * MACHINE SAFETY: the socket and the HTTP server are this test's own, on a temp path and port 0.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { reportCheckOutcome } from '../../src/commands/tools-daemon-fallback.js'
import { executeOp } from '../../src/ops/index.js'
import { CHECK_FAULT_OP } from '../../src/providers/trigger-check-core.js'
import { LOCAL_ORIGIN } from '../../src/lib/caller-origin.js'
import { spawn } from 'node:child_process'
import { testBun } from '../helpers/bun-runtime.js'

let dir = ''
const closers: Array<() => void> = []

afterEach(() => {
  for (const c of closers.splice(0)) c()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** A daemon's gateway socket that records every line and answers ok. */
async function fakeDaemon(): Promise<{ socket: string; lines: Array<Record<string, any>> }> {
  dir = fs.mkdtempSync('/tmp/wcf-')
  const socket = path.join(dir, 'g.sock')
  const lines: Array<Record<string, any>> = []
  const server = net.createServer((c) => {
    let buf = ''
    c.on('data', (d) => {
      buf += d
      if (!buf.includes('\n')) return
      lines.push(JSON.parse(buf.split('\n')[0]!))
      c.end(JSON.stringify({ ok: true, result: {} }) + '\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  closers.push(() => server.close())
  return { socket, lines }
}

/** An API that answers every request with this status and body. */
async function api(status: number, body: unknown): Promise<string> {
  const server = http.createServer((_req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api/v1`
}

// Every tools.call carries its own call id (src/lib/op-call-id.ts), so a resend runs it once.
const CALL_ID = expect.stringMatching(/^oc-[0-9a-f]{32}$/)

const checkEnv = (socket: string): NodeJS.ProcessEnv => ({ WALNUT_CHECK_TOKEN: 'trigger-check:abc', WALNUT_CHECK_SOCKET: socket })

describe('a check\'s HTTP call the machine failed', () => {
  it('a 507 from the disk guard reaches the check\'s daemon as disk_full', async () => {
    const d = await fakeDaemon()
    const base = await api(507, { error: 'Data disk is critically full (99% used)', code: 'disk_full', usedPct: 99 })
    const r = await executeOp('task_update', { id: 'task-1', title: 'x' }, { apiBase: base, origin: LOCAL_ORIGIN })
    expect(r).toMatchObject({ ok: false, status: 507, code: 'disk_full' })
    await reportCheckOutcome(r, checkEnv(d.socket))
    expect(d.lines).toEqual([{ v: 1, op: 'tools.call', sid: 'trigger-check:abc', args: { name: CHECK_FAULT_OP, args: { kind: 'disk_full' }, callId: CALL_ID } }])
  })

  it('no server at all is server_away', async () => {
    const d = await fakeDaemon()
    const r = await executeOp('task_get', { id: 'task-1' }, { apiBase: 'http://127.0.0.1:9/api/v1', origin: LOCAL_ORIGIN })
    expect(r.ok).toBe(false)
    await reportCheckOutcome(r, checkEnv(d.socket))
    expect(d.lines.map((l) => l.args.args.kind)).toEqual(['server_away'])
  })

  it('a real answer clears; the script\'s own refusals, and calls outside a check, report nothing', async () => {
    const d = await fakeDaemon()
    const ok = await api(200, { task: { id: 'task-1' } })
    const answered = await executeOp('task_get', { id: 'task-1' }, { apiBase: ok, origin: LOCAL_ORIGIN })
    expect(answered.ok).toBe(true)
    await reportCheckOutcome(answered, checkEnv(d.socket))
    expect(d.lines.map((l) => l.args)).toEqual([{ name: CHECK_FAULT_OP, args: { kind: null }, callId: CALL_ID }])
    const base = await api(404, { error: { code: 'not_found', message: 'no such task' } })
    const r = await executeOp('task_get', { id: 'nope' }, { apiBase: base, origin: LOCAL_ORIGIN })
    expect(r).toMatchObject({ ok: false, status: 404 })
    await reportCheckOutcome(r, checkEnv(d.socket))
    const disk = { ok: false, status: 507, code: 'disk_full' }
    await reportCheckOutcome(disk, {})
    await reportCheckOutcome(disk, { ...checkEnv(d.socket), WALNUT_SESSION_ID: 'a-session' })
    expect(d.lines).toHaveLength(1)
  })

  it('the real `walnut tools call` in a check tells its daemon of the 507 it got', async () => {
    const bun = testBun()
    if (!bun) return
    const d = await fakeDaemon()
    const base = await api(507, { error: 'Data disk is critically full (99% used)', code: 'disk_full' })
    const home = path.join(dir, 'home')
    const env = {
      PATH: process.env.PATH, HOME: home, OPEN_WALNUT_HOME: path.join(home, '.open-walnut'),
      OPEN_WALNUT_API_URL: base.replace(/\/api\/v1$/, ''), ...checkEnv(d.socket),
    }
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(bun, [path.resolve(__dirname, '../../src/cli.ts'), 'tools', 'call', 'task_update', '{"id":"t-1","title":"x"}'], { env, stdio: 'ignore' })
      p.on('close', resolve)
    })
    expect(code).not.toBe(0)
    expect(d.lines.map((l) => l.args)).toEqual([{ name: CHECK_FAULT_OP, args: { kind: 'disk_full' }, callId: CALL_ID }])
  }, 60_000)

  it('a daemon that is gone costs nothing but the attempt', async () => {
    const started = Date.now()
    await reportCheckOutcome({ ok: false, status: 507 }, checkEnv('/tmp/no-such-walnut-socket'))
    expect(Date.now() - started).toBeLessThan(2_500)
  })
})
