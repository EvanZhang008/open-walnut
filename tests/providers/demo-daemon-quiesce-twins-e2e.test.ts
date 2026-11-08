/**
 * demo.quiesce on both real daemon twins, booted as a Demo's own daemon (WALNUT_DEMO_ROOT,
 * its generation, HOME and the daemon dir under that root), with stand-in programs only:
 * a native CLI that stays on its stdin, the one-shot fake (exits at stdin EOF) and an ACP
 * worker that exits on shutdown. Pinned: the reply comes after work accepted before it and
 * names the ACP runtime; a warm one-shot child has exited by stdin EOF before the reply;
 * new starts, input and writes are refused while list, reads and stops still work; a daemon
 * that is no Demo's refuses it and keeps starting work.
 *
 * MACHINE SAFETY: HOME, the Demo root, daemon and streams dirs are temp paths; PATH is the
 * exec guard's; the only signals are SIGTERM to the daemons this file started (their own
 * stop path) and the daemon's own stop of its own sessions, trigger checks and plugin jobs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { hostWalnutMcpServer, withWalnutMcpMount } from '../../src/core/sessions/walnut-mcp-mount.js'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { demoTerminalDir, ensureDemoTerminalDir, removeDemoTerminalDir } from '../../src/lib/demo-terminal-dir.js'
import { guardedPath } from '../setup/exec-guard.js'
import { bunRuntime } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const ONESHOT_FAKE = path.resolve(__dirname, '../helpers/oneshot-fake-claude.cjs')
const BUN = bunRuntime()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const ACP_DAEMON = path.resolve(__dirname, '../../src/providers/acp-daemon.ts')
const HOST_EXEC = path.resolve(__dirname, '../../src/providers/host-exec-core.ts')
const TRIGGER_SIDECAR = path.resolve(__dirname, '../../src/providers/trigger-check-sidecar.ts')

// Fixture trigger check: records its pid, then ends on a private release file or after 30 s; no network.
const CHECK_HELPER = `
const fs = require('fs')
const path = require('path')
const [dir, tag] = process.argv.slice(2)
fs.writeFileSync(path.join(dir, tag + '.started'), String(process.pid))
const done = () => { process.stdout.write('{"fire":false}\\n'); process.exit(0) }
setInterval(() => { if (fs.existsSync(path.join(dir, 'release'))) done() }, 50)
setTimeout(done, 30000)
`
// Fixture plugin job: records its pid, ends on the run's abort (the daemon's own stop) or after 30 s.
const JOB_BUNDLE = `
import fs from 'node:fs'
export const jobs = {
  worker: async (walnut, signal) => {
    const out = walnut.config.out
    fs.appendFileSync(out, JSON.stringify({ ev: 'start', pid: process.pid }) + '\\n')
    await new Promise((resolve) => {
      const backstop = setTimeout(resolve, 30000)
      signal.addEventListener('abort', () => { clearTimeout(backstop); resolve() })
    })
    fs.appendFileSync(out, JSON.stringify({ ev: 'end', pid: process.pid, aborted: signal.aborted }) + '\\n')
  },
}
`

// Stand-in native CLI: prints init, records nothing, lives on its stdin, ends on SIGTERM/SIGINT or after 60 s.
const NATIVE_CLI = `
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
setTimeout(() => process.exit(0), 60000).unref()
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
`
// Stand-in ACP worker: answers the start, exits on shutdown or stdin EOF.
const ACP_WORKER = `
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const journal = process.argv[process.argv.indexOf('--journal') + 1]
fs.mkdirSync(path.dirname(journal), { recursive: true })
if (!fs.existsSync(journal)) fs.writeFileSync(journal, '')
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const r = JSON.parse(line)
  if (r.op === 'newSession') return reply(r.id, { sessionId: 'quiesce-provider-session' })
  if (r.op === 'getState') return reply(r.id, { providerSessionId: 'quiesce-provider-session', turnActive: false, controlActive: false, pendingPermissions: [], capabilities: {} })
  reply(r.id, {})
  if (r.op === 'shutdown') setTimeout(() => process.exit(0), 20)
})
rl.on('close', () => process.exit(0))
setTimeout(() => process.exit(0), 60000).unref()
`

let lib = ''
let scriptDir = ''
beforeAll(() => {
  lib = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wq-lib-')))
  fs.writeFileSync(path.join(lib, 'native-cli.cjs'), NATIVE_CLI)
  fs.writeFileSync(path.join(lib, 'acp-worker.mjs'), ACP_WORKER)
  fs.writeFileSync(path.join(lib, 'check-helper.cjs'), CHECK_HELPER)
  // The source twin runs from a dir holding daemon.cjs and its ACP sidecar, built from this checkout.
  scriptDir = path.join(lib, 'source')
  fs.mkdirSync(scriptDir)
  fs.writeFileSync(path.join(scriptDir, 'daemon.cjs'), getDaemonSource(), { mode: 0o755 })
  // Its ACP and host-exec sidecars, as scripts/build-daemon.sh builds them.
  // trigger-check-core.cjs from trigger-check-sidecar.ts, the entry scripts/build-daemon.sh uses; the plugin job harness is inlined in daemon.cjs.
  for (const [out, entry] of [['acp-daemon-core.cjs', ACP_DAEMON], ['host-exec-core.cjs', HOST_EXEC], ['trigger-check-core.cjs', TRIGGER_SIDECAR]]) {
    const built = spawnSync(bunRuntime(), ['build', '--target=node', '--format=cjs', '--outfile', path.join(scriptDir, out), entry], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('could not build the ' + out + ' sidecar: ' + built.stderr)
  }
})
// A fixture or daemon still running may be using a script in lib: then lib stays.
let keepLib = false
afterAll(() => { if (!keepLib && lib.includes('wq-lib-')) fs.rmSync(lib, { recursive: true, force: true }) })

type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [path.join(scriptDir, 'daemon.cjs'), '--start']] },
  // No bun is a failure here, never a skip.
  { name: 'standalone twin (bun)', command: () => [BUN, [STANDALONE, '--start']] },
]

interface Daemon { proc: ChildProcess; ws: WebSocket; root: string; data: string }
// Registered right after the spawn, so a boot that fails at the port or the socket is still stopped.
const daemons: Array<Omit<Daemon, 'ws'> & { ws: WebSocket | null; terminals?: string }> = []
// Roots whose processes outlived their wait: never removed while something may run from them.
const keepRoots = new Set<string>()
let rpcId = 1
let arrival = 0
// Fixture processes a test started: a dir is never removed while one of them still runs.
const fixtures: Array<{ root: string; pid: () => number | null; release?: string }> = []

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    if (f.release) fs.writeFileSync(f.release, '')
    const pid = f.pid()
    if (pid !== null && !(await waitFor(() => !isAlive(pid), 5_000))) { keepRoots.add(f.root); keepLib = true }
  }
  for (const d of daemons.splice(0)) {
    try { d.ws?.close() } catch { /* closed */ }
    if (d.proc.exitCode === null && d.proc.signalCode === null) {
      // The daemon's own stop: an isolated dir reaps its sessions on the way out.
      const exited = new Promise<void>((r) => { const t = setTimeout(r, 30_000); d.proc.once('exit', () => { clearTimeout(t); r() }) })
      d.proc.kill('SIGTERM')
      await exited
    }
    const exitedOwnStop = d.proc.exitCode !== null || d.proc.signalCode !== null
    if (!exitedOwnStop) { keepRoots.add(d.root); keepLib = true }
    if (!keepRoots.has(d.root)) fs.rmSync(path.dirname(d.root), { recursive: true, force: true })
    // The claimed short terminal dir goes only once its daemon really exited.
    if (d.terminals && exitedOwnStop && !keepRoots.has(d.root)) await removeDemoTerminalDir(d.terminals, d.data)
    expect(exitedOwnStop, 'daemon exited on its own stop').toBe(true)
  }
})

/** `demo`: the daemon dir is the Demo root's `d`; otherwise a plain isolated daemon with the same HOME. */
async function boot(twin: Twin, demo: boolean): Promise<Daemon> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wq-')))
  const root = path.join(base, 'open-walnut-demo')
  const home = path.join(root, 'homes', 'g1')
  const daemonDir = demo ? path.join(root, 'd', 'g1') : path.join(base, 'plain-d')
  fs.mkdirSync(home, { recursive: true })
  // A Demo daemon's gateway listens in the claimed short terminal dir, which the Demo server makes before it starts the daemon.
  const terminals = demo ? demoTerminalDir(root, 'g1') : undefined
  if (terminals) ensureDemoTerminalDir(terminals, path.join(root, 'data', 'g1'))
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    CLAUDE_CONFIG_DIR: undefined, WALNUT_DAEMON_KEEP_SESSIONS: undefined, WALNUT_DAEMON_STATE_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir, WALNUT_STREAMS_DIR: daemonDir + '-streams',
    WALNUT_LEGACY_STREAMS_DIR: path.join(base, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(base, 'spawn-journal.jsonl'),
    WALNUT_DAEMON_PARENT_PID: String(process.pid),
    WALNUT_DEMO_ROOT: root, WALNUT_DEMO_GENERATION: 'g1',
  }
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry: Omit<Daemon, 'ws'> & { ws: WebSocket | null; terminals?: string } = { proc, ws: null, root, data: path.join(root, 'data', 'g1'), terminals }
  daemons.push(entry)
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  entry.ws = ws
  return entry as Daemon
}

type Reply = Record<string, unknown> & { arrived: number }
function rpc(d: Daemon, cmd: Record<string, unknown>, timeoutMs = 45_000): Promise<Reply> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id !== id) return
      clearTimeout(timer)
      d.ws.off('message', onMessage)
      resolve({ ...msg, arrived: ++arrival })
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

function nativeStart(d: Daemon, sid: string, cli = 'native-cli.cjs', lead: string[] = []) {
  const sh = `exec ${[process.execPath, path.join(lib, cli), ...lead].map((a) => JSON.stringify(a)).join(' ')} "$@"`
  return rpc(d, { cmd: 'start', sid, cwd: lib, message: '', resume: false, mode: 'default', args: ['/bin/sh', '-c', sh, 'sh', '--session-id', sid] })
}

function acpStart(d: Daemon, sid: string) {
  const worker = path.join(lib, 'acp-worker.mjs')
  return rpc(d, { cmd: 'acpStart', sid, cwd: lib, workerCmd: [process.execPath, worker], adapterCmd: [process.execPath, worker], env: {} })
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Pids whose command line holds `marker`, from the real process table. */
function pidsWith(marker: string): number[] {
  const out = spawnSync('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m && m[2].includes(marker)).map((m) => Number(m[1]))
}

async function waitFor(check: () => boolean, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

const listed = async (d: Daemon) => ((await rpc(d, { cmd: 'list' })).sessions as Array<{ sid: string; alive: boolean }>)

describe.each(TWINS)('demo.quiesce on the $name', (twin) => {
  it('the short Demo socket serves the default MCP mount or the capability-gated CLI fallback', async () => {
    const d = await boot(twin, true)
    const socket = path.join(demoTerminalDir(d.root, 'g1'), 'agent-gateway.sock')
    const shim = path.join(path.dirname(socket), 'bin', 'walnut')
    expect(await waitFor(() => fs.existsSync(socket) && fs.existsSync(shim))).toBe(true)
    const seen: Array<{ capability: string; callerSid: string; payload: Record<string, unknown> }> = []
    const onGateway = (data: Buffer) => {
      const event = JSON.parse(data.toString())
      if (event.ev !== 'gateway-request') return
      seen.push(event)
      const result = event.capability === 'tools.list' ? { ops: [{
        name: 'echo_demo', description: 'Echo fixture input', readonly: true,
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }] } : { echoed: event.payload.args }
      d.ws.send(JSON.stringify({ id: rpcId++, cmd: 'gateway-result', relayId: event.relayId, result }))
    }
    d.ws.on('message', onGateway)
    const mount = hostWalnutMcpServer()
    const env = {
      HOME: path.join(d.root, 'homes', 'g1'), PATH: guardedPath([path.dirname(BUN)], '/usr/bin:/bin'),
      WALNUT_AGENT_SOCKET: socket, WALNUT_SESSION_ID: 'external', WALNUT_DAEMON_DIR: path.join(d.root, 'd', 'g1'),
    }
    const transport = new StdioClientTransport({
      command: mount.command, args: mount.args, env, stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (data) => { stderr += data.toString() })
    const client = new Client({ name: 'demo-mount-test', version: '1' })
    try {
      const hello = await rpc(d, { cmd: 'hello', run: 'demo-mount-fixture', readOps: ['echo_demo'] })
      expect(hello).toMatchObject({ ok: true })
      const supportsMcp = (hello.capabilities as string[]).includes('walnut-mcp-v1')
      expect(supportsMcp).toBe(twin.name === 'standalone twin (bun)')
      const profile = withWalnutMcpMount({ setting: undefined, profile: undefined, hostServesMcp: supportsMcp, local: true, hubMount: () => { throw new Error('Default mounts never use the legacy hub') } })
      if (!supportsMcp) {
        expect(profile).toBeUndefined()
        const child = spawn(shim, ['tools', 'list', '--json'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        child.stdout.on('data', (data) => { stdout += data.toString() })
        child.stderr.on('data', (data) => { stderr += data.toString() })
        try {
          const code = await new Promise<number | null>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Demo fallback CLI did not exit')), 15_000)
            child.once('error', (error) => { clearTimeout(timer); reject(error) })
            child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
          })
          expect(code, stderr).toBe(0)
          const reply = JSON.parse(stdout)
          expect(reply.ok).toBe(true)
          expect(reply.result.ops.map((op: { name: string }) => op.name)).toEqual(['echo_demo'])
          expect(seen.map((event) => event.capability)).toEqual(['tools.list'])
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            const exited = new Promise<void>((resolve) => { const timer = setTimeout(resolve, 10_000); child.once('exit', () => { clearTimeout(timer); resolve() }) })
            child.kill('SIGTERM')
            await exited
          }
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
        }
        return
      }
      expect(profile?.mcpServers?.walnut).toEqual(mount)
      await client.connect(transport)
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['echo_demo'])
      const input = 'Quoted "text", $5, `literal`, and $(never-executed)'
      const reply = await client.callTool({ name: 'echo_demo', arguments: { text: input } })
      expect(reply.isError).not.toBe(true)
      expect(JSON.parse((reply.content as Array<{ text: string }>)[0].text)).toEqual({ echoed: { text: input } })
      expect(seen.map((event) => event.capability)).toEqual(['tools.list', 'tools.call'])
      expect(seen.map((event) => event.callerSid)).toEqual(['external', 'external'])
      expect(fs.existsSync(path.join(d.root, 'd', 'g1', 'bin', 'walnut'))).toBe(false)
    } catch (error) {
      throw new Error(`${String(error)}; MCP stderr: ${stderr}`)
    } finally {
      await client.close()
      d.ws.off('message', onGateway)
    }
  }, 90_000)

  it('waits for accepted work, ends the warm pool by stdin, names the ACP runtime, then takes only reads and stops', async () => {
    const d = await boot(twin, true)
    const live = 'aaaaaaaa-0000-4000-8000-0000000000a1'
    const late = 'aaaaaaaa-0000-4000-8000-0000000000a2'
    const first = await nativeStart(d, live)
    expect(first).toMatchObject({ ok: true })
    const nativePid = first.pid as number
    expect(await acpStart(d, 'rt-quiesce-1')).toMatchObject({ ok: true })
    const marker = 'quiesce-warm-' + twin.name.replace(/\W+/g, '-')
    const spec = { command: process.execPath, args: [ONESHOT_FAKE, '-p', '--input-format', 'stream-json', '--model', marker], cwd: lib, env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: path.join(d.root, 'homes', 'g1') }, warmKey: 'k1' }
    expect(await rpc(d, { cmd: 'oneshot.prewarm', ...spec })).toMatchObject({ ok: true, warm: 'spawned' })
    expect(await waitFor(() => pidsWith(marker).length === 1)).toBe(true)
    const warmPid = pidsWith(marker)[0]!

    // A start accepted just before the fence, then the fence on the same socket.
    const lateStart = nativeStart(d, late)
    const quiet = await rpc(d, { cmd: 'demo.quiesce', home: d.data })
    const lateReply = await lateStart
    expect(quiet).toMatchObject({ ok: true, quiet: true })
    expect(quiet.acpRuntimes).toEqual([expect.objectContaining({ sid: 'rt-quiesce-1', state: 'running' })])
    expect(lateReply.arrived).toBeLessThan(quiet.arrived)
    // The warm child ended by its stdin before the reply; no signal reached it.
    expect(isAlive(warmPid)).toBe(false)
    const sessions = await listed(d)
    if (lateReply.ok === true) expect(sessions.find((s) => s.sid === late)?.alive).toBe(true)
    else {
      expect(String(lateReply.error)).toMatch(/Demo is stopping/)
      expect(sessions.find((s) => s.sid === late)?.alive ?? false).toBe(false)
    }

    // Closed: every start, input, one-shot, command and write.
    for (const cmd of [
      { cmd: 'start', sid: 'aaaaaaaa-0000-4000-8000-0000000000a3', args: [], cwd: lib },
      { cmd: 'acpStart', sid: 'rt-quiesce-2', cwd: lib },
      { cmd: 'agent.start', engine: 'codex', sid: 'rt-quiesce-3', cwd: lib },
      { cmd: 'send', sid: live, message: 'hello' },
      { cmd: 'oneshot.prewarm', ...spec, warmKey: 'k2' },
      { cmd: 'oneshot.run', ...spec, runId: 'r1' },
      // No `id` field here: the frame's own id is the RPC id.
      { cmd: 'exec.run', line: 'true', cwd: lib },
      { cmd: 'fs.write', path: path.join(lib, 'x.txt'), content: 'x' },
      { cmd: 'triggers.configure', triggers: [] },
    ]) {
      expect(await rpc(d, cmd), cmd.cmd).toMatchObject({ ok: false, errorKind: 'demo_stopping' })
    }
    expect(pidsWith(marker)).toEqual([])

    // Open: reads and stops; a retried quiesce answers again.
    expect(await rpc(d, { cmd: 'exec.list' })).toMatchObject({ ok: true })
    expect(await rpc(d, { cmd: 'acpState', sid: 'rt-quiesce-1' })).toMatchObject({ ok: true })
    expect(await rpc(d, { cmd: 'stop', sid: live, reason: 'user' })).toMatchObject({ ok: true })
    expect(await waitFor(() => !isAlive(nativePid))).toBe(true)
    if (lateReply.ok === true) {
      expect(await rpc(d, { cmd: 'stop', sid: late, reason: 'user' })).toMatchObject({ ok: true })
      expect(await waitFor(() => !isAlive(lateReply.pid as number))).toBe(true)
    }
    expect(await rpc(d, { cmd: 'acpStop', sid: 'rt-quiesce-1' })).toMatchObject({ ok: true, stopped: true })
    expect(await rpc(d, { cmd: 'acpState', sid: 'rt-quiesce-1' })).toMatchObject({ ok: false, errorKind: 'no_worker' })
    expect((await listed(d)).filter((s) => s.alive)).toEqual([])
    expect(await rpc(d, { cmd: 'demo.quiesce', home: d.data })).toMatchObject({ ok: true, quiet: true, acpRuntimes: [] })
  }, 180_000)

  it('a daemon that is no Demo\'s own refuses it, a wrong home is refused, and starts go on', async () => {
    const plain = await boot(twin, false)
    expect(await rpc(plain, { cmd: 'demo.quiesce', home: plain.data })).toMatchObject({ ok: false, errorKind: 'demo_quiesce_refused' })
    const demo = await boot(twin, true)
    expect(await rpc(demo, { cmd: 'demo.quiesce', home: path.join(demo.root, 'data', 'other') })).toMatchObject({ ok: false, errorKind: 'demo_quiesce_refused' })
    for (const d of [plain, demo]) {
      const sid = d === plain ? 'bbbbbbbb-0000-4000-8000-0000000000b1' : 'bbbbbbbb-0000-4000-8000-0000000000b2'
      const started = await nativeStart(d, sid)
      expect(started).toMatchObject({ ok: true })
      expect(await rpc(d, { cmd: 'stop', sid, reason: 'user' })).toMatchObject({ ok: true })
      expect(await waitFor(() => !isAlive(started.pid as number))).toBe(true)
    }
  }, 180_000)

  it('a running trigger check is ended by the quiesce, quiet comes after its real exit, and no check starts after the fence', async () => {
    const d = await boot(twin, true)
    const dir = path.join(path.dirname(d.root), 'fixture')
    fs.mkdirSync(dir)
    const release = path.join(dir, 'release')
    const startedFile = (tag: string) => path.join(dir, tag + '.started')
    const pidOf = (tag: string) => (fs.existsSync(startedFile(tag)) ? Number(fs.readFileSync(startedFile(tag), 'utf8')) || null : null)
    fixtures.push({ root: d.root, pid: () => pidOf('before'), release })
    const run = (tag: string) => `exec ${[process.execPath, path.join(lib, 'check-helper.cjs'), dir, tag].map((a) => JSON.stringify(a)).join(' ')}`
    try {
      const began = Date.now()
      const test = rpc(d, { cmd: 'triggers.test', check: { run: run('before'), timeoutSeconds: 120 } })
      expect(await waitFor(() => pidOf('before') !== null)).toBe(true)
      const checkPid = pidOf('before')!
      expect(isAlive(checkPid)).toBe(true)

      const quiet = await rpc(d, { cmd: 'demo.quiesce', home: d.data })
      const tested = await test
      expect(quiet).toMatchObject({ ok: true, quiet: true })
      // The check really exited before quiet, by the stop and not by its release or its 30 s backstop.
      expect(isAlive(checkPid)).toBe(false)
      expect(tested.arrived).toBeLessThan(quiet.arrived)
      expect(fs.existsSync(release)).toBe(false)
      expect(Date.now() - began).toBeLessThan(25_000)

      expect(await rpc(d, { cmd: 'triggers.test', check: { run: run('after'), timeoutSeconds: 5 } })).toMatchObject({ ok: false, errorKind: 'demo_stopping' })
      await new Promise((r) => setTimeout(r, 1_000))
      expect(fs.existsSync(startedFile('after'))).toBe(false)
    } finally {
      fs.writeFileSync(release, '')
      const pid = pidOf('before')
      const gone = pid === null || await waitFor(() => !isAlive(pid), 35_000)
      if (!gone) { keepRoots.add(d.root); keepLib = true }
      expect(gone, 'the fixture check exited').toBe(true)
    }
  }, 180_000)

  it('a running plugin job is retired by the quiesce through the daemon\'s own stop, and a new configure is refused', async () => {
    const d = await boot(twin, true)
    const out = path.join(path.dirname(d.root), 'job.jsonl')
    const jobEvents = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { ev: string; pid: number; aborted?: boolean }) : [])
    const jobPid = () => jobEvents().find((e) => e.ev === 'start')?.pid ?? null
    fixtures.push({ root: d.root, pid: jobPid })
    // The bundle where a leader puts it: <daemon dir>/plugin-jobs/bundles/<sha256>.mjs.
    const sha256 = crypto.createHash('sha256').update(JOB_BUNDLE).digest('hex')
    const file = path.join(d.root, 'd', 'g1', 'plugin-jobs', 'bundles', `${sha256}.mjs`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JOB_BUNDLE)
    const walnutId = 'wdemojobs01'
    const spec = { v: 1, home: d.data, walnutId, jobs: [{ plugin: 'demo-jobs', version: '1.0.0', job: 'worker', kind: 'long-running', bundle: { sha256, file }, config: { out }, host: '__local__' }] }
    try {
      expect(await rpc(d, { cmd: 'leader.configure', home: d.data, walnutId, backup: false })).toMatchObject({ ok: true })
      expect(await rpc(d, { cmd: 'jobs.configure', home: d.data, spec })).toMatchObject({ ok: true })
      expect(await waitFor(() => jobPid() !== null, 30_000)).toBe(true)
      const pid = jobPid()!
      expect(isAlive(pid)).toBe(true)

      // Quiet only once the retired run exited: runs, draining and timers all 0.
      expect(await rpc(d, { cmd: 'demo.quiesce', home: d.data })).toMatchObject({ ok: true, quiet: true })
      expect(isAlive(pid)).toBe(false)
      expect(jobEvents().filter((e) => e.ev === 'end')).toEqual([expect.objectContaining({ pid, aborted: true })])

      expect(await rpc(d, { cmd: 'jobs.configure', home: d.data, spec: { ...spec, jobs: [{ ...spec.jobs[0]!, config: { out, n: 2 } }] } })).toMatchObject({ ok: false, errorKind: 'demo_stopping' })
      await new Promise((r) => setTimeout(r, 6_000))
      expect(jobEvents().filter((e) => e.ev === 'start')).toHaveLength(1)
    } finally {
      const pid = jobPid()
      const gone = pid === null || await waitFor(() => !isAlive(pid), 35_000)
      if (!gone) { keepRoots.add(d.root); keepLib = true }
      expect(gone, 'the fixture job exited').toBe(true)
    }
  }, 180_000)
})
