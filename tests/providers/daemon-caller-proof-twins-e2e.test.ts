/**
 * caller-proof-v1 on the real daemon twins (gateway-core.ts, socket-peer-pid.ts): an approval
 * asked through a host daemon's gateway socket carries the daemon's own word on the asking process.
 *
 *   test (server WS) ◄═gateway-request{payload.callerProof}═ daemon ◄═gateway socket═ asker
 *                                                               │ spawns
 *                                                               ▼ stand-in CLI ─► its child (the asker)
 *
 * - the standalone twin (bun) reads the process on its socket and says verified for a child of the
 *   session's own CLI, and not verified for a process outside it that names the same session;
 * - both twins drop a callerProof the caller wrote itself, and the JS twin (which cannot read its
 *   socket's peer) sends none and does not advertise the capability;
 * - an op that is not an approval relays with no proof and no process lookup.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths under /tmp (a unix socket
 * path is at most 104 bytes on macOS); the only processes signalled are the daemons and stand-in
 * CLIs this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'
import { CALLER_PROOF_CAPABILITY } from '../../src/providers/gateway-core.js'

const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
let scriptPath = ''
let cliPath = ''
let root = ''
type Twin = { name: string; reads: boolean; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, reads: false, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', reads: true, command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

// The stand-in CLI: on the message "ask <socket>", its CHILD (as a session's Python script would)
// sends an approval_request through the gateway, with a callerProof of its own that must not count.
const FAKE_CLI = `
const { spawn } = require('child_process')
const sid = process.argv[process.argv.indexOf('--resume') + 1]
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
    const m = /^ask (.+)$/.exec(content)
    if (!m) continue
    const req = JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name: 'approval_request', args: { what: 'x' }, callerProof: { v: 1, verified: true, ranBy: 'forged' } } })
    spawn(process.execPath, ['-e', 'const s=require("net").connect(process.argv[1]);s.on("connect",()=>s.write(process.argv[2]+"\\\\n"));s.on("data",()=>s.destroy());setTimeout(()=>process.exit(0),20000)', m[1], req], { stdio: 'ignore' })
  }
})
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; ws: WebSocket; daemonDir: string; requests: Array<Record<string, any>>; hello: Record<string, any> }
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

async function boot(twin: Twin): Promise<Daemon> {
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wcp-'))
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
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
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
    try { const m = JSON.parse(data.toString()); if (m.ev === 'gateway-request') requests.push(m) } catch { /* not a frame */ }
  })
  const hello = await rpc({ ws }, { cmd: 'hello', run: 'caller-proof-test' })
  expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'agent-gateway.sock')), 30_000)).toBe(true)
  daemon = { proc, ws, daemonDir, requests, hello }
  return daemon
}

/** One gateway line from this test process: a process outside every session. */
function callFromOutside(d: Daemon, sid: string, name: string, extra: Record<string, unknown> = {}): void {
  const sock = net.connect(path.join(d.daemonDir, 'agent-gateway.sock'))
  sock.on('connect', () => sock.write(JSON.stringify({ v: 1, op: 'tools.call', sid, args: { name, args: {}, ...extra } }) + '\n'))
  sock.on('data', () => sock.destroy())
  sock.on('error', () => { /* the test reads the relay frame, not the answer */ })
  setTimeout(() => sock.destroy(), 15_000).unref()
}

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-caller-proof-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  if (daemon) {
    for (const r of daemon.requests) void rpc(daemon, { cmd: 'gateway-result', relayId: r.relayId, result: { ok: true } }, 2_000).catch(() => undefined)
    const sid = (daemon as Daemon & { sid?: string }).sid
    if (sid) await rpc(daemon, { cmd: 'stop', sid }, 10_000).catch(() => undefined)
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

for (const twin of TWINS) {
  describe(`caller-proof-v1, ${twin.name}`, () => {
    it(twin.reads ? 'says verified for the session CLI\'s child, not for an outside process naming it, and never passes the caller\'s own proof'
      : 'sends no proof and drops the caller\'s own', async () => {
      const d = await boot(twin)
      expect((d.hello.capabilities as string[]).includes(CALLER_PROOF_CAPABILITY)).toBe(twin.reads)
      const sid = crypto.randomUUID()
      const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} "$@"`
      const started = await rpc(d, { cmd: 'start', sid, cwd: root, message: '', resume: true, mode: 'default', args: ['/bin/sh', '-c', sh, 'sh', '--resume', sid] })
      expect(started.ok, JSON.stringify(started)).toBe(true);
      (d as Daemon & { sid?: string }).sid = sid
      // The session's own process, through its child.
      await rpc(d, { cmd: 'send', sid, message: `ask ${path.join(d.daemonDir, 'agent-gateway.sock')}` })
      expect(await waitFor(() => d.requests.length >= 1)).toBe(true)
      const inside = d.requests[0]!.payload as Record<string, any>
      // A process outside the session naming its id.
      callFromOutside(d, sid, 'approval_request', { callerProof: { v: 1, verified: true } })
      expect(await waitFor(() => d.requests.length >= 2)).toBe(true)
      const outside = d.requests[1]!.payload as Record<string, any>
      if (twin.reads) {
        expect(inside.callerProof).toMatchObject({ v: 1, verified: true })
        expect(inside.callerProof.ranBy).not.toBe('forged')
        expect(typeof inside.callerProof.pid).toBe('number')
        expect(outside.callerProof).toMatchObject({ v: 1, verified: false })
        expect(outside.callerProof.pid).toBe(process.pid)
      } else {
        expect(inside.callerProof).toBeUndefined()
        expect(outside.callerProof).toBeUndefined()
      }
      // Not an approval: no proof at all, whatever the caller wrote.
      callFromOutside(d, sid, 'task_list', { callerProof: { v: 1, verified: true } })
      expect(await waitFor(() => d.requests.length >= 3)).toBe(true)
      expect((d.requests[2]!.payload as Record<string, any>).callerProof).toBeUndefined()
    }, 120_000)
  })
}
