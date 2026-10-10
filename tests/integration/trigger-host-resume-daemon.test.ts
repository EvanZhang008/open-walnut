/**
 * A trigger fire wakes a STOPPED session on its own host while no Walnut server
 * is connected (trigger-host-resume-v1), end to end on a REAL daemon (both twins).
 *
 * The incident (2026-10-09): the Mac slept overnight, the idle reaper had stopped
 * the target session after its two quiet hours, and the host retried "no live
 * session of the target task on this host" every minute for six hours (606 such
 * retries in its logs against 13 deliveries). Now the daemon starts that session
 * again with the command it last ran, the fire as its first message, journals a
 * `resume` record for the returning server, and replays the fire with
 * `host.resumed`.
 *
 * What's real: the daemon process (source twin under node with its trigger
 * sidecar bundled into its dir; standalone twin under bun), the spawn journal,
 * the resume records, a restart of the daemon, /bin/sh checks, a mock CLI that
 * logs its argv and every user message it reads. What's faked: the Walnut server
 * is a bare WS client. Every daemon is killed by the pid it wrote into its own
 * temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const OTHER_HOME = '/fixture/test-server-home'
const SID = 'abcdabcd-6666-4666-8666-666666666666'
const FOREIGN = 'dcbadcba-7777-4777-8777-777777777777'
const TASK = 'mwatch00-1c2d'
const TRIGGER = 'mtrig000-r3sm'
const GRACE_MS = 1_500

const bunPath = (() => {
  // BUN_INSTALL first: the test setup swaps HOME for a fake one and points this at the real bun.
  for (const p of [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) if (p && fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

/** The mock CLI: logs its argv once per spawn, and every user message it reads. */
const MOCK_CLI = `
const fs = require('fs')
const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : '' }
const sid = opt('--mock-sid'), inbox = opt('--mock-inbox')
fs.appendFileSync(opt('--mock-argv'), JSON.stringify(argv) + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    fs.appendFileSync(inbox, JSON.stringify({ sid, content: msg.message && msg.message.content }) + '\\n')
  }
})
setInterval(() => {}, 1 << 30)
`

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

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
  const dir = existing ?? fs.mkdtempSync(path.join(os.tmpdir(), `walnut-trigresume-${twin}-`))
  for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* fresh dir */ } }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TRIGGER_HOST_GRACE_MS: String(GRACE_MS),
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
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 30_000, `${twin} daemon`)
  return {
    proc, dir,
    port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10),
    pid: parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10),
  }
}

async function stopDaemon(d: Daemon): Promise<void> {
  const exited = new Promise<void>((r) => { if (d.proc.exitCode !== null) r(); else d.proc.once('exit', () => r()) })
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
  await Promise.race([exited, sleep(10_000)])
}

/** A stand-in Walnut server: commands with replies, and every event it was sent. */
class FakeServer {
  events: Array<Record<string, unknown>> = []
  private nextId = 1
  private waiters = new Map<number, (m: Record<string, unknown>) => void>()
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>
      if (typeof msg.ev === 'string') { this.events.push(msg); return }
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
  fires(seq?: number): Array<Record<string, unknown>> {
    return this.events.filter((e) => e.ev === 'trigger.fired' && e.id === TRIGGER && (seq === undefined || e.seq === seq))
  }
  close(): Promise<void> {
    return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close() })
  }
}

function data(reply: Record<string, unknown>): Record<string, unknown> {
  return (reply.data && typeof reply.data === 'object' ? reply.data : reply) as Record<string, unknown>
}

const PROMPT = 'New review comments are in this fire. Read each one. \u00e9\u4e2d'

describe.each(bunPath ? ['source', 'standalone'] as const : ['source'] as const)('trigger host resume on the real %s daemon', (twin) => {
  let d: Daemon
  let itemsFile: string
  let inbox: string
  let argvLog: string
  let wrapper: string

  function setItems(ids: string[]): void {
    fs.writeFileSync(itemsFile, JSON.stringify({ fire: true, items: ids.map((id) => ({ id, text: `comment ${id}` })) }) + '\n')
  }
  const spawns = (sid = SID): string[][] => {
    try {
      return fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
        .filter((a) => a[a.indexOf('--mock-sid') + 1] === sid)
    } catch { return [] }
  }
  const triggerMessages = (): string[] => {
    try {
      return fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content))
        .filter((c) => c.includes('<walnut-message kind="trigger"'))
    } catch { return [] }
  }
  const pending = () => (JSON.parse(fs.readFileSync(path.join(d.dir, 'trigger-state', `${TRIGGER}.json`), 'utf8')) as { pendingFires: Array<Record<string, unknown>> }).pendingFires
  const slice = (sessions: HostSlice['sessions'] = [{ sid: SID, taskId: TASK, title: 'Review loop' }]): HostSlice => ({
    v: 1, home: HOME, hash: `h-${sessions.map((s) => s.sid).join(',')}`, asOf: Date.now(), host: 'devbox',
    sessions,
    tasks: [{ id: TASK, title: 'Watch the review', phase: 'WAITING', project: 'Ops' }],
    requests: [],
  })

  async function configure(server: FakeServer): Promise<void> {
    const r = await server.cmd({
      cmd: 'triggers.configure',
      config: {
        version: 1,
        triggers: [{
          id: TRIGGER, name: 'Review watch', everyMs: 3_600_000,
          check: { run: `cat ${itemsFile}`, timeoutSeconds: 10 },
          deliver: { home: HOME, taskId: TASK, prompt: PROMPT },
        }],
      },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }

  /** The way a server first starts a session: a fresh spawn naming its id. */
  async function startFresh(server: FakeServer, sid: string, home: string): Promise<void> {
    const r = await server.cmd({
      cmd: 'start', sid, cwd: d.dir, message: 'init', mode: 'default', origin: { home, task: TASK },
      args: [wrapper, '-p', '--model', 'opus', '--permission-mode', 'default', '--dangerously-skip-permissions',
        '--session-id', sid, '--mock-sid', sid, '--mock-inbox', inbox, '--mock-argv', argvLog],
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    await waitFor(() => spawns(sid).length > 0, 20_000, `${sid} spawned`)
  }

  async function stopSession(server: FakeServer, sid: string, home: string): Promise<void> {
    const r = await server.cmd({ cmd: 'stop', sid, reason: 'user', home })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    for (let i = 0; i < 100; i++) {
      const st = data(await server.cmd({ cmd: 'status', sid }))
      if (st.alive === false || st.exists === false) return
      await sleep(100)
    }
    throw new Error(`${sid} did not stop`)
  }

  /** Run the check now and leave: the Mac falls asleep with the fire unclaimed. */
  async function fireAndLeave(ids: string[]): Promise<void> {
    setItems(ids)
    const server = await FakeServer.connect(d.port)
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await server.close()
  }

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    itemsFile = path.join(d.dir, 'items.json')
    inbox = path.join(d.dir, 'inbox.jsonl')
    argvLog = path.join(d.dir, 'argv.jsonl')
    setItems([])
    const mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    // Stands where `claude` stands in a real command: the first word, then flags.
    wrapper = path.join(d.dir, 'claude-mock')
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${mock}" "$@"\n`, { mode: 0o755 })
    const server = await FakeServer.connect(d.port)
    expect((await server.cmd({ cmd: 'hello' })).capabilities as string[]).toContain('trigger-host-resume-v1')
    await startFresh(server, SID, HOME)
    expect((await server.cmd({ cmd: 'host.slice', slice: slice() })).ok).toBe(true)
    await configure(server)
    // The user switched it to plan mode, then it stopped (the idle reaper's stop is the same stop).
    expect((await server.cmd({ cmd: 'setMode', sid: SID, mode: 'plan' })).ok).toBe(true)
    await stopSession(server, SID, HOME)
    await server.close()
  }, 120_000)

  afterAll(async () => { if (d) await stopDaemon(d) })

  it('with no server connected, a fire starts the stopped session again with its own command and hands it the fire', async () => {
    await fireAndLeave(['c1'])
    await waitFor(() => spawns().length === 2, 25_000, 'the host resume')
    const resumed = spawns()[1]
    // A resume the CLI accepts: --resume, no --session-id beside it.
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(SID)
    expect(resumed).not.toContain('--session-id')
    // The mode it has now, not the one it was started in; the bypass capability only.
    expect(resumed[resumed.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(resumed).toContain('--allow-dangerously-skip-permissions')
    expect(resumed).not.toContain('--dangerously-skip-permissions')
    // The rest of its command is its own.
    expect(resumed[resumed.indexOf('--model') + 1]).toBe('opus')
    await waitFor(() => triggerMessages().some((m) => m.includes('"c1"')), 15_000, 'the fire in the session')
    const msg = triggerMessages().find((m) => m.includes('"c1"'))!
    expect(msg).toContain('from="Trigger: Review watch"')
    expect(msg).toContain(PROMPT)
    await waitFor(() => pending().some((f) => f.seq === 1 && !!f.host), 5_000, 'the host delivery recorded')
    expect(pending().find((f) => f.seq === 1)!.host).toMatchObject({ sessionId: SID, seqs: [1], resumed: true })
    // The command it was resumed with is kept for the next time.
    const rec = JSON.parse(fs.readFileSync(path.join(d.dir, 'resume-records', `${SID}.json`), 'utf8'))
    expect(rec).toMatchObject({ v: 1, sid: SID, mode: 'plan', home: HOME, task: TASK })
    expect(fs.statSync(path.join(d.dir, 'resume-records', `${SID}.json`)).mode & 0o777).toBe(0o600)
  }, 60_000)

  it('the returning server finds the resume in the journal, the fire with host.resumed, and the CLI running', async () => {
    const server = await FakeServer.connect(d.port)
    const drained = data(await server.cmd({ cmd: 'offline.drain', home: HOME }))
    const records = drained.records as Array<Record<string, unknown>>
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'resume', sid: SID, taskId: TASK })]))
    const upTo = Math.max(...records.map((r) => r.seq as number))
    expect((await server.cmd({ cmd: 'offline.ack', home: HOME, upTo })).ok).toBe(true)
    expect(data(await server.cmd({ cmd: 'status', sid: SID })).alive).toBe(true)
    await server.cmd({ cmd: 'host.slice', slice: slice() })
    await configure(server) // the reconnect path replays every pending fire
    await waitFor(() => server.fires(1).length > 0, 10_000, 'the replay')
    expect(server.fires(1)[0]).toMatchObject({ seq: 1, host: { sessionId: SID, resumed: true } })
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: TRIGGER, seq: 1 })).acked).toBe(true)
    // Exactly one delivery of c1 ever reached the session.
    expect(triggerMessages().filter((m) => m.includes('"c1"'))).toHaveLength(1)
    await stopSession(server, SID, HOME)
    await server.close()
  }, 60_000)

  it('a session that stopped again moments after a host resume is not started again every minute', async () => {
    await fireAndLeave(['c1', 'c2'])
    await sleep(GRACE_MS + 7_000)
    expect(spawns()).toHaveLength(2)
    const fire = pending().find((f) => f.seq === 2)!
    expect(fire.host).toBeUndefined()
    expect(fire.hostTriedAt).toEqual(expect.any(Number))
  }, 60_000)

  it('after a daemon restart, the resume record still carries the session\'s command', async () => {
    await stopDaemon(d)
    d = await spawnDaemon(twin, d.dir)
    const server = await FakeServer.connect(d.port)
    // The new generation has no record of the session in memory: only its file.
    expect(data(await server.cmd({ cmd: 'status', sid: SID })).exists).toBe(false)
    await server.cmd({ cmd: 'host.slice', slice: slice() })
    await configure(server)
    await server.close()
    // c2's fire waits out its minute since the last try; a new one goes after the grace.
    await fireAndLeave(['c1', 'c2', 'c3'])
    await waitFor(() => spawns().length === 3, 30_000, 'the resume after the restart')
    const resumed = spawns()[2]
    expect(resumed[resumed.indexOf('--resume') + 1]).toBe(SID)
    expect(resumed).not.toContain('--session-id')
    expect(resumed[resumed.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(resumed[resumed.indexOf('--model') + 1]).toBe('opus')
    await waitFor(() => triggerMessages().some((m) => m.includes('"c3"')), 15_000, 'c3 in the session')
    await waitFor(() => pending().some((f) => f.seq === 3 && !!f.host), 5_000, 'c3 recorded')
    expect(pending().find((f) => f.seq === 3)!.host).toMatchObject({ sessionId: SID, resumed: true })
  }, 90_000)

  it('a session another Walnut started on this host is never resumed for this Walnut\'s fire', async () => {
    const server = await FakeServer.connect(d.port)
    await stopSession(server, SID, HOME)
    await startFresh(server, FOREIGN, OTHER_HOME)
    await stopSession(server, FOREIGN, OTHER_HOME)
    // A copy that names the foreign session as this Walnut's (a stale or forged slice).
    await server.cmd({ cmd: 'host.slice', slice: slice([{ sid: FOREIGN, taskId: TASK, title: 'Not ours' }]) })
    await configure(server)
    await server.close()
    await fireAndLeave(['c1', 'c2', 'c3', 'c4'])
    await sleep(GRACE_MS + 7_000)
    expect(spawns(FOREIGN)).toHaveLength(1)
    expect(spawns()).toHaveLength(3)
    expect(pending().find((f) => f.seq === 4)?.host).toBeUndefined()
  }, 60_000)
})
