/**
 * trigger-caller-v1 on the real daemon twins (trigger-check-core.ts checkCallers): a trigger
 * check's `walnut` calls reach the server as `external` plus the trigger the daemon ran it for.
 *
 *   test (server WS) ◄═gateway-request{callerSid: external, payload.triggerCaller}═ daemon
 *                                                                                    │ runs
 *                                                                                    ▼ check ─► gateway socket
 *
 * Before (2026-11-14) a check's calls carried nothing, so host_exec_read and the rest refused them
 * as "not a session" and the trigger never fired. Covered, on both twins:
 * - the hello says trigger-caller-v1;
 * - a test the server names (checkCaller) and an armed trigger's run each relay their own
 *   triggerCaller, with the run's token in WALNUT_CHECK_TOKEN and this daemon's socket in
 *   WALNUT_CHECK_SOCKET (never WALNUT_SESSION_ID);
 * - a triggerCaller the caller wrote itself is dropped, from a check or from anyone else;
 * - op_card_record from a check is answered by the daemon and never relayed;
 * - a token whose run is over vouches for nothing (a child the check left behind);
 * - a test the server names no caller for runs as before (no token, `external`).
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths under /tmp (a unix socket
 * path is at most 104 bytes on macOS); the only processes signalled are the daemons this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'
import { testBun } from '../helpers/bun-runtime.js'
import { TRIGGER_CALLER_CAPABILITY } from '../../src/providers/gateway-core.js'
import { TRIGGER_CALLER_CAPABILITY as CORE_CAPABILITY } from '../../src/providers/trigger-check-core.js'

const ROOT = path.resolve(__dirname, '../..')
const BUN: string | undefined = testBun()
const STANDALONE = path.join(ROOT, 'src/providers/daemon-standalone.ts')
let srcDir = ''
let checkPath = ''
let root = ''
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [path.join(srcDir, 'daemon.cjs'), '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

// The check: three gateway calls as a script's `walnut tools call` would make them, then its verdict.
// Its env says who it is; it writes that to a file so the test can call with the token later.
const CHECK = `
const net = require('net'), fs = require('fs')
const sock = process.env.WALNUT_CHECK_SOCKET || process.argv[2]
const sid = process.env.WALNUT_CHECK_TOKEN || 'external'
fs.writeFileSync(process.argv[3], JSON.stringify({ sid, sock: process.env.WALNUT_CHECK_SOCKET || null, session: process.env.WALNUT_SESSION_ID || null, agentSocket: process.env.WALNUT_AGENT_SOCKET || null }))
const lines = [
  { v: 1, op: 'tools.call', sid, args: { name: 'host_exec_read', args: { host: 'h', job_id: 'hx-1234' }, triggerCaller: { kind: 'armed', id: 'forged' } } },
  { v: 1, op: 'tools.call', sid, args: { name: 'op_card_record', args: { op: 'x' } } },
  { v: 1, op: 'tools.call', sid: 'external', args: { name: 'task_list', args: {}, triggerCaller: { kind: 'armed', id: 'forged' } } },
]
let left = lines.length
const done = () => { if (--left === 0) { console.log(JSON.stringify({ fire: false })); process.exit(0) } }
for (const l of lines) {
  const s = net.connect(sock)
  s.on('connect', () => s.write(JSON.stringify(l) + '\\n'))
  s.on('data', () => { s.destroy(); done() })
  s.on('error', done)
}
setTimeout(() => { console.log(JSON.stringify({ fire: false })); process.exit(0) }, 15000)
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
  root = fs.realpathSync(fs.mkdtempSync('/tmp/wtc-'))
  const daemonDir = path.join(root, 'd')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_SESSION_ID: undefined,
    WALNUT_AGENT_SOCKET: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_TRIGGER_STATE_DIR: path.join(root, 'ts'),
    WALNUT_STREAMS_DIR: path.join(root, 's'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy'),
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', 'spawn-journal.jsonl'),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(b.toString()))
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
    let m: Record<string, any>
    try { m = JSON.parse(data.toString()) } catch { return }
    if (m.ev !== 'gateway-request') return
    requests.push(m)
    // Answer at once, as a server would, so the check finishes.
    ws.send(JSON.stringify({ id: rpcId++, cmd: 'gateway-result', relayId: m.relayId, result: { ok: true } }))
  })
  const hello = await rpc({ ws }, { cmd: 'hello', run: 'trigger-caller-test' })
  expect(await waitFor(() => fs.existsSync(path.join(daemonDir, 'agent-gateway.sock')), 30_000)).toBe(true)
  daemon = { proc, ws, daemonDir, requests, hello }
  return daemon
}

function checkRun(d: Daemon, out: string): { run: string; timeoutSeconds: number } {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  return { run: `${q(process.execPath)} ${q(checkPath)} ${q(path.join(d.daemonDir, 'agent-gateway.sock'))} ${q(out)}`, timeoutSeconds: 30 }
}

const byName = (d: Daemon, name: string, from = 0) => d.requests.slice(from).filter((r) => r.payload?.name === name)

beforeAll(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-trigger-caller-src-'))
  fs.writeFileSync(path.join(srcDir, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
  // The sidecar the deploy ships beside the script (scripts/build-daemon.sh).
  buildSync({
    entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: path.join(srcDir, 'trigger-check-core.cjs'), logLevel: 'silent',
  })
  checkPath = path.join(srcDir, 'check.cjs')
  fs.writeFileSync(checkPath, CHECK)
})

afterEach(async () => {
  if (daemon) {
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

it('the server and the daemon name the capability the same', () => {
  expect(CORE_CAPABILITY).toBe(TRIGGER_CALLER_CAPABILITY)
})

for (const twin of TWINS) {
  describe(`trigger-caller-v1, ${twin.name}`, () => {
    it('a check\'s calls carry the trigger they ran for, and nothing a caller wrote', async () => {
      const d = await boot(twin)
      expect(d.hello.capabilities as string[]).toContain(TRIGGER_CALLER_CAPABILITY)

      // 1. A test the server named a caller for.
      const testOut = path.join(root, 'test-env.json')
      const tested = await rpc(d, { cmd: 'triggers.test', check: checkRun(d, testOut), checkCaller: 'tt-abcdefgh12345678' })
      expect(tested.ok, JSON.stringify(tested)).toBe(true)
      expect((tested.result as Record<string, unknown>).ok, JSON.stringify(tested.result)).toBe(true)
      const testEnv = JSON.parse(fs.readFileSync(testOut, 'utf8')) as { sid: string; sock: string; session: string | null; agentSocket: string | null }
      expect(testEnv.sid).toMatch(/^trigger-check:[0-9a-f]+$/)
      expect(testEnv.sock).toBe(path.join(d.daemonDir, 'agent-gateway.sock'))
      // Names nothing else reads: a session id would change how the CLI, git hooks and guards treat every call.
      expect(testEnv.session).toBeNull()
      expect(testEnv.agentSocket).toBeNull()
      expect(await waitFor(() => byName(d, 'host_exec_read').length === 1 && byName(d, 'task_list').length === 1)).toBe(true)
      const read = byName(d, 'host_exec_read')[0]!
      expect(read.callerSid).toBe('external')
      expect(read.payload.triggerCaller).toEqual({ kind: 'test', id: 'tt-abcdefgh12345678' })
      expect(read.payload.args).toEqual({ host: 'h', job_id: 'hx-1234' })
      // Someone else writing triggerCaller themselves: dropped.
      expect(byName(d, 'task_list')[0]!.payload.triggerCaller).toBeUndefined()
      // A chat card for a session a check is not: answered here, never relayed.
      expect(byName(d, 'op_card_record')).toHaveLength(0)

      // 2. Over: the same token vouches for nothing now.
      const after = d.requests.length
      await new Promise<void>((resolve) => {
        const s = net.connect(testEnv.sock)
        s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: testEnv.sid, args: { name: 'host_exec_list', args: {} } }) + '\n'))
        s.on('data', () => { s.destroy(); resolve() })
        s.on('error', () => resolve())
      })
      expect(await waitFor(() => byName(d, 'host_exec_list', after).length === 1)).toBe(true)
      const late = byName(d, 'host_exec_list', after)[0]!
      expect(late.callerSid).toBe('external')
      expect(late.payload.triggerCaller).toBeUndefined()

      // 3. A test the server named no caller for: as before, no token at all.
      const plainOut = path.join(root, 'plain-env.json')
      const from = d.requests.length
      expect((await rpc(d, { cmd: 'triggers.test', check: checkRun(d, plainOut) })).ok).toBe(true)
      expect(JSON.parse(fs.readFileSync(plainOut, 'utf8'))).toEqual({ sid: 'external', sock: null, session: null, agentSocket: null })
      expect(await waitFor(() => byName(d, 'host_exec_read', from).length === 1)).toBe(true)
      expect(byName(d, 'host_exec_read', from)[0]!.payload.triggerCaller).toBeUndefined()
      // With no token it is anyone's call, relayed as it always was.
      expect(byName(d, 'op_card_record', from)).toHaveLength(1)

      // 4. An armed trigger's run: its own id.
      const armedOut = path.join(root, 'armed-env.json')
      const armedFrom = d.requests.length
      const configured = await rpc(d, {
        cmd: 'triggers.configure',
        config: { version: 1, triggers: [{ id: 'trg-watch-1', name: 'Watch', everyMs: 3_600_000, check: checkRun(d, armedOut) }] },
      })
      expect(configured.ok, JSON.stringify(configured)).toBe(true)
      // Run it now, whatever the clock says (a run already started by the arm is fine too).
      await rpc(d, { cmd: 'triggers.run', triggerId: 'trg-watch-1' }).catch(() => undefined)
      expect(await waitFor(() => byName(d, 'host_exec_read', armedFrom).length >= 1, 30_000)).toBe(true)
      const armed = byName(d, 'host_exec_read', armedFrom)[0]!
      expect(armed.callerSid).toBe('external')
      expect(armed.payload.triggerCaller).toEqual({ kind: 'armed', id: 'trg-watch-1' })
      expect(JSON.parse(fs.readFileSync(armedOut, 'utf8')).sid).toMatch(/^trigger-check:/)
      expect(byName(d, 'op_card_record', armedFrom)).toHaveLength(0)
    }, 120_000)
  })
}
