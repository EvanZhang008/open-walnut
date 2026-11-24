/**
 * Who a call on a host daemon's gateway socket comes from (caller-identity, 2026-11-21): the sid a
 * line names is believed only when the process on the socket may speak for it.
 *
 *   test (server WS) ◄═gateway-request{callerSid}═ daemon ◄═gateway socket═ asker
 *                                                     │ spawns
 *                                                     ▼ stand-in CLI A (default) ─► child ─► grandchild
 *                                                     ▼ stand-in CLI B (bypass)
 *
 * The session daemon (daemon-standalone.ts, under bun) reads the process on its socket: a process
 * inside session A (A's CLI's child or grandchild, also after A's CLI was started again under a new
 * pid) is A; the same process naming B, or a process outside every session naming A, is the
 * anonymous `external`; the process that started the daemon (it commands the daemon anyway) is
 * believed.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths under /tmp (a unix socket
 * path is at most 104 bytes on macOS); the only processes signalled are the daemons and stand-in
 * CLIs this file started (by the daemon's own stop).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { guardedPath } from '../setup/exec-guard.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let cliPath = ''
let clientPath = ''
let root = ''

// A gateway client: `client <socket> <line> <depth> [quit]`. At depth > 1 it starts itself one level
// down (a session's bash starting a script), so the asker is a deeper descendant. `quit`: it exits
// right after writing its line, before any answer (a caller that leaves at once).
const CLIENT = `
const { spawn } = require('child_process')
const [sock, line, depth, quit] = process.argv.slice(2)
if (Number(depth) > 1) {
  const c = spawn(process.execPath, [__filename, sock, line, String(Number(depth) - 1), quit || ''], { stdio: 'ignore' })
  c.on('exit', () => process.exit(0))
} else {
  const s = require('net').connect(sock)
  s.on('connect', () => { s.write(line + '\\n'); if (quit === 'quit') process.exit(0) })
  s.on('data', () => { s.destroy(); process.exit(0) })
  s.on('error', () => process.exit(0))
  setTimeout(() => process.exit(0), 20000)
}
`

// The stand-in CLI: on the message "call <base64 json {sock, line, depth, quit}>", its child runs the client.
const FAKE_CLI = `
const { spawn } = require('child_process')
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const content = typeof msg.message.content === 'string' ? msg.message.content : ''
    const m = /^call (\\S+)$/.exec(content)
    if (!m) continue
    const c = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
    spawn(process.execPath, [c.client, c.sock, c.line, String(c.depth), c.quit ? 'quit' : ''], { stdio: 'ignore' })
  }
})
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; ws: WebSocket; daemonDir: string; sock: string; requests: Array<Record<string, any>>; sids: string[] }
let daemon: Daemon | null = null
let rpcId = 1

function rpc(d: { ws: WebSocket }, cmd: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, any>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, any>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

async function boot(): Promise<Daemon> {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wci-'))
  const daemonDir = path.join(root, 'd')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 's'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl'),
  }
  const proc = spawn(BUN!, [STANDALONE, '--start'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const requests: Array<Record<string, any>> = []
  ws.on('message', (data: Buffer) => {
    try {
      const m = JSON.parse(data.toString())
      if (m.ev !== 'gateway-request') return
      requests.push(m)
      // Answered at once, as the server does: the asker then ends.
      ws.send(JSON.stringify({ id: rpcId++, cmd: 'gateway-result', relayId: m.relayId, result: { ok: true } }))
    } catch { /* not a frame */ }
  })
  await rpc({ ws }, { cmd: 'hello', run: 'caller-identity-test' })
  const sock = path.join(daemonDir, 'agent-gateway.sock')
  expect(await waitFor(() => fs.existsSync(sock), 30_000)).toBe(true)
  daemon = { proc, ws, daemonDir, sock, requests, sids: [] }
  return daemon
}

async function startCli(d: Daemon, sid: string, mode: string): Promise<void> {
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"`
  const started = await rpc(d, { cmd: 'start', sid, cwd: root, message: '', resume: true, mode, args: ['/bin/sh', '-c', sh, 'sh', '--resume', sid] })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  if (!d.sids.includes(sid)) d.sids.push(sid)
}

function line(sid: string, tag: string): string {
  return JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: 'task_list', args: { tag } } })
}

/** Session `inside`'s CLI has a descendant (`depth` levels down) send a line naming `claims`. */
async function callFromSession(d: Daemon, inside: string, claims: string, tag: string, depth = 1, quit = false): Promise<void> {
  const c = { client: clientPath, sock: d.sock, line: line(claims, tag), depth, quit }
  const sent = await rpc(d, { cmd: 'send', sid: inside, message: `call ${Buffer.from(JSON.stringify(c)).toString('base64')}` })
  expect(sent.ok, JSON.stringify(sent)).toBe(true)
}

/** A line from this test process: the process that started the daemon. */
function callFromStarter(d: Daemon, claims: string, tag: string): void {
  const s = net.connect(d.sock)
  s.on('connect', () => s.write(line(claims, tag) + '\n'))
  s.on('data', () => s.destroy())
  s.on('error', () => { /* the test reads the relay frame */ })
  setTimeout(() => s.destroy(), 15_000).unref()
}

/** A line from a process this test starts: outside every session, and not the daemon's starter. */
function callFromStranger(d: Daemon, claims: string, tag: string): void {
  spawn(process.execPath, [clientPath, d.sock, line(claims, tag), '1', ''], { stdio: 'ignore' })
}

async function frame(d: Daemon, tag: string, ms = 20_000): Promise<Record<string, any> | undefined> {
  const find = () => d.requests.find((r) => r.payload?.args?.tag === tag)
  await waitFor(() => !!find(), ms)
  return find()
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-caller-identity-src-'))
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
  clientPath = path.join(dir, 'client.cjs')
  fs.writeFileSync(clientPath, CLIENT)
})

afterEach(async () => {
  if (daemon) {
    for (const sid of daemon.sids) await rpc(daemon, { cmd: 'stop', sid }, 10_000).catch(() => undefined)
    try { daemon.ws.close() } catch { /* closed */ }
    if (daemon.proc.exitCode === null) {
      daemon.proc.kill('SIGKILL')
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); daemon!.proc.once('exit', () => { clearTimeout(t); resolve() }) })
    }
  }
  daemon = null
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.skipIf(!BUN)('gateway caller identity, standalone daemon (bun)', () => {
  it('believes a sid only from inside its session or from the daemon\'s starter; any other asker is external', async () => {
    const d = await boot()
    const A = crypto.randomUUID()
    const B = crypto.randomUUID()
    await startCli(d, A, 'default')
    await startCli(d, B, 'bypass')

    // A's own CLI's child and grandchild: A.
    await callFromSession(d, A, A, 'own-child')
    await callFromSession(d, A, A, 'own-grandchild', 2)
    // A's child naming its bypass sibling B: the forged sid.
    await callFromSession(d, A, B, 'forged')
    // The daemon's starter naming B, and a stranger naming A.
    callFromStarter(d, B, 'starter')
    callFromStranger(d, A, 'stranger')

    const own = await frame(d, 'own-child')
    const deep = await frame(d, 'own-grandchild')
    const forged = await frame(d, 'forged')
    const starter = await frame(d, 'starter')
    const stranger = await frame(d, 'stranger')
    expect(own?.callerSid).toBe(A)
    expect(deep?.callerSid).toBe(A)
    expect(forged?.callerSid).toBe('external')
    expect(stranger?.callerSid).toBe('external')
    expect(starter?.callerSid).toBe(B)
    for (const f of [own, deep, forged, starter, stranger]) expect(f?.payload.callerUnproven).toBeUndefined()

    // A's CLI started again (a resume: a new process): its new child is A.
    await startCli(d, A, 'default')
    await callFromSession(d, A, A, 'after-restart')
    expect((await frame(d, 'after-restart'))?.callerSid).toBe(A)

    // A forger that leaves the moment it wrote its line is never A's sibling either.
    await callFromSession(d, A, B, 'forged-quit', 1, true)
    const quit = await frame(d, 'forged-quit', 5_000)
    expect(quit === undefined || quit.callerSid === 'external').toBe(true)
    // One warning per forged sid, not one per call.
    await callFromSession(d, A, B, 'forged-again')
    expect((await frame(d, 'forged-again'))?.callerSid).toBe('external')
    const log = fs.readdirSync(d.daemonDir).filter((n) => /^daemon-.*\.log$/.test(n))
      .map((n) => fs.readFileSync(path.join(d.daemonDir, n), 'utf8')).join('\n')
    expect(log.split('\n').filter((l) => l.includes('names a session it does not run inside') && l.includes(B)).length).toBe(1)
  }, 120_000)
})
