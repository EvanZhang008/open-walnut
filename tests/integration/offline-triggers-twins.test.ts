/**
 * The trigger ops a host answers while its Walnut is away (offline-triggers-v1),
 * end to end on a REAL daemon (both twins), through the agent gateway socket a
 * session's `walnut` CLI speaks.
 *
 * The gap (clouddev transcripts, 2026-10-05 to 10-13): about 40 trigger_list,
 * trigger_test, trigger_delete and trigger_pause calls answered "needs the Walnut
 * server" while the Mac slept, though the checks run on that host. Now the host
 * lists and tests them itself, and a pause, resume or delete takes effect at once:
 * the trigger stops (or starts) checking, stays that way across a set the server
 * pushes before it has drained the journal and across a daemon restart, and the
 * server gets the records to replay.
 *
 * What's real: the daemon process (source twin under node with its trigger
 * sidecar bundled into its dir; standalone twin under bun), its gateway socket,
 * its journal and trigger files, a restart, /bin/sh checks, a mock CLI session.
 * What's faked: the Walnut server is a bare WS client. Every daemon is killed by
 * the pid it wrote into its own temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import type { GatewayResponse } from '../../src/providers/gateway-core.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const OTHER_HOME = '/fixture/test-server-home'
const SID = 'acacacac-1111-4111-8111-111111111111'
const TASK = 'mwatch00-7a7a'
const T_PR = 'mtrigpr0-0001'
const T_CI = 'mtrigci0-0002'
const T_THEIRS = 'mtrigth0-0003'

const bunPath = (() => {
  // The runner's own bun first, then the real home's (the test setup fakes HOME): testBun().
  const own = testBun()
  if (own) return own
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

const MOCK_CLI = `
const sid = process.argv[2]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
setInterval(() => {}, 1 << 30)
`

interface Daemon { proc: ChildProcess; dir: string; port: number; sock: string; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

/** A daemon on `dir` (a fresh one when absent; the same dir again is a restart). */
async function spawnDaemon(twin: 'source' | 'standalone', existing?: string): Promise<Daemon> {
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), `walnut-offtrig-${twin}-`))
  for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* fresh dir */ } }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '3000',
    WALNUT_TRIGGER_REPLAY_MS: '60000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    // The sidecar the deploy ships beside the script (scripts/build-daemon.sh).
    buildSync({
      entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent',
    })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(bunPath!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  return {
    proc, dir, sock,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

async function stopDaemon(d: Daemon): Promise<void> {
  const exited = new Promise<void>((r) => { if (d.proc.exitCode !== null) r(); else d.proc.once('exit', () => r()) })
  // Only the pid the isolated daemon wrote into its own temp dir.
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([exited, sleep(10_000)])
}

/** A stand-in Walnut server: commands with replies. */
class FakeServer {
  private nextId = 1
  private waiters = new Map<number, (m: Record<string, unknown>) => void>()
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      const w = typeof msg.id === 'number' ? this.waiters.get(msg.id) : undefined
      if (w) { this.waiters.delete(msg.id as number); w(msg) }
    })
  }
  static async connect(port: number): Promise<FakeServer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej) })
    return new FakeServer(ws)
  }
  cmd(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters.delete(id); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
      this.waiters.set(id, (m) => { clearTimeout(t); resolve(m) })
      this.ws.send(JSON.stringify({ id, ...body }))
    })
  }
  close(): Promise<void> {
    return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close() })
  }
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply.data && typeof reply.data === 'object' ? reply.data : reply) as Record<string, unknown>
}

function gateway(sock: string, name: string, args: Record<string, unknown> = {}): Promise<GatewayResponse> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 15_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: SID, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function ok(r: GatewayResponse): Record<string, any> {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`)
  return r.result as Record<string, any>
}

const twins: Array<'source' | 'standalone'> = bunPath ? ['source', 'standalone'] : ['source']

describe.each(twins)('trigger ops on the real %s daemon while its Walnut is away', (twin) => {
  let d: Daemon
  let check: string

  const def = (id: string, home = HOME) => ({
    id, name: `Watch ${id}`, everyMs: 3_600_000,
    check: { run: `sh ${check}`, timeoutSeconds: 10 },
    deliver: { home, taskId: TASK, prompt: 'Look at it.' },
  })
  const slice = (): HostSlice => ({
    v: 1, home: HOME, hash: 'h1', asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: SID, taskId: TASK, title: 'Watcher' }],
    tasks: [{ id: TASK, title: 'Watch the PR', phase: 'WAITING', project: 'Ops' }],
    requests: [],
  })

  /** Which of the ids the daemon runs now: `triggers.run` answers "unknown" for a disarmed one. */
  async function armedNow(ids: string[]): Promise<string[]> {
    const server = await FakeServer.connect(d.port)
    const out: string[] = []
    for (const id of ids) if ((await server.cmd({ cmd: 'triggers.run', triggerId: id })).ok === true) out.push(id)
    await server.close()
    return out
  }

  /** The Mac pushes its set again (its connect does this while the journal drains). */
  async function pushSet(ids: string[]): Promise<void> {
    const server = await FakeServer.connect(d.port)
    const r = await server.cmd({ cmd: 'triggers.configure', config: { version: 1, triggers: ids.map((id) => def(id, id === T_THEIRS ? OTHER_HOME : HOME)) } })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    await server.close()
  }

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    check = path.join(d.dir, 'check.sh')
    // Says where it ran: the session's folder when the call names none.
    fs.writeFileSync(check, 'printf \'{"fire":true,"items":[{"id":"c1"}],"input":"%s"}\\n\' "$(pwd)"\n')
    const mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    const server = await FakeServer.connect(d.port)
    expect((await server.cmd({ cmd: 'hello' })).capabilities as string[]).toContain('offline-triggers-v1')
    const started = await server.cmd({
      cmd: 'start', sid: SID, cwd: d.dir, message: 'init', args: [process.execPath, mock, SID], origin: { home: HOME, task: TASK },
    })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await waitFor(() => {
      try { return fs.readFileSync(path.join(d.dir, 'streams', `${SID}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false }
    }, 20_000, 'the session idle')
    expect((await server.cmd({ cmd: 'host.slice', slice: slice() })).ok).toBe(true)
    await server.close()
    await pushSet([T_PR, T_CI, T_THEIRS])
    await sleep(300)
  }, 90_000)

  afterAll(async () => { if (d) await stopDaemon(d) })

  it('lists the triggers it checks for this Walnut, and only those', async () => {
    const r = ok(await gateway(d.sock, 'trigger_list'))
    expect(r.offline).toBe(true)
    expect(r.triggers.map((t: { id: string }) => t.id).sort()).toEqual([T_CI, T_PR])
    expect(r.triggers.find((t: { id: string }) => t.id === T_PR)).toMatchObject({ state: 'armed', every: '1h', host: 'devbox', run: `sh ${check}`, task: TASK })
  })

  it('tests a check here, in the session\'s folder, against a trigger\'s seen set', async () => {
    const r = ok(await gateway(d.sock, 'trigger_test', { run: `sh ${check}`, id: T_PR }))
    expect(r.result).toMatchObject({ ok: true, exitCode: 0, wouldFire: true, newItemCount: 1, parsed: { fire: true } })
    expect(fs.realpathSync(String(r.result.parsed.input))).toBe(fs.realpathSync(d.dir))
    expect(r.outcome).toContain('WOULD fire now')
    const bad = ok(await gateway(d.sock, 'trigger_test', { run: 'echo not json' }))
    expect(bad.result.parsed).toBeNull()
    expect(bad.outcome).toContain('did not produce a usable answer')
  })

  it('a pause stops the check at once, and a set pushed before the drain does not undo it', async () => {
    expect(await armedNow([T_PR, T_CI])).toEqual([T_PR, T_CI])
    expect(ok(await gateway(d.sock, 'trigger_pause', { id: T_PR }))).toMatchObject({ state: 'paused', changed: true })
    expect(await armedNow([T_PR, T_CI])).toEqual([T_CI])
    // The returning Mac's connect pushes its set (still with T_PR) while the journal drains.
    await pushSet([T_PR, T_CI, T_THEIRS])
    expect(await armedNow([T_PR, T_CI])).toEqual([T_CI])
    expect(ok(await gateway(d.sock, 'trigger_list')).triggers.find((t: { id: string }) => t.id === T_PR)).toMatchObject({ state: 'paused', changedHere: 'paused' })
  }, 30_000)

  it('the pause holds across a daemon restart, and a resume here arms it again', async () => {
    await stopDaemon(d)
    d = await spawnDaemon(twin, d.dir)
    await sleep(300)
    expect(await armedNow([T_PR, T_CI])).toEqual([T_CI])
    expect(ok(await gateway(d.sock, 'trigger_resume', { id: T_PR }))).toMatchObject({ state: 'armed', changed: true })
    expect(await armedNow([T_PR, T_CI])).toEqual([T_PR, T_CI])
  }, 60_000)

  it('a delete stops it, refuses another Walnut\'s trigger, and the server gets every change to replay', async () => {
    expect(ok(await gateway(d.sock, 'trigger_delete', { id: T_CI }))).toMatchObject({ state: 'deleted', changed: true })
    expect(await armedNow([T_PR, T_CI])).toEqual([T_PR])
    const theirs = await gateway(d.sock, 'trigger_pause', { id: T_THEIRS })
    expect(!theirs.ok && theirs.error.code).toBe('hub_unreachable')
    expect(await armedNow([T_THEIRS])).toEqual([T_THEIRS])

    const server = await FakeServer.connect(d.port)
    const drained = data(await server.cmd({ cmd: 'offline.drain', home: HOME }))
    const records = drained.records as Array<Record<string, any>>
    expect(records.map((r) => [r.op, r.args.id])).toEqual([['trigger_pause', T_PR], ['trigger_resume', T_PR], ['trigger_delete', T_CI]])
    expect(records[0]).toMatchObject({ kind: 'op', callerSid: SID, trigger: { id: T_PR, check: { run: `sh ${check}` } } })
    expect((await server.cmd({ cmd: 'offline.ack', home: HOME, upTo: Math.max(...records.map((r) => r.seq as number)) })).ok).toBe(true)
    await server.close()
    // Taken: the server's last set alone decides again (a change it refused is
    // undone here; it still carried T_CI).
    expect(await armedNow([T_PR, T_CI])).toEqual([T_PR, T_CI])
    // The server applied them: its next set has no T_CI, and T_PR runs as it says.
    await pushSet([T_PR, T_THEIRS])
    expect(await armedNow([T_PR, T_CI, T_THEIRS])).toEqual([T_PR, T_THEIRS])
  }, 30_000)
})
