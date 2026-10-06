/**
 * Trigger fires reach a session on the same host while the Walnut server is away
 * (trigger-claim-v1), end to end on a REAL daemon (both twins).
 *
 * The incident (2026-10-05): the Mac slept, the host kept running a one-minute
 * chat check, and five fires waited up to 42 minutes for the server while the
 * target session sat idle on that same host. Now the daemon arbitrates: a fire no
 * server claimed within the grace is written into the target task's live
 * session by the daemon itself, and replayed with `host` set so the server only
 * records it. A server that claims keeps delivering alone.
 *
 * What's real: the daemon process (source twin under node with its trigger
 * sidecar bundled into its dir; standalone twin under bun), /bin/sh checks, the
 * state files, a mock CLI reading its FIFO. What's faked: the Walnut server is a
 * bare WS client. Every daemon is killed by the pid it wrote into its own temp dir.
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
import type { HostDelivery } from '../../src/providers/trigger-check-core.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/walnut-home'
const OTHER_HOME = '/fixture/test-server-home'
const SID = 'eeeeeeee-5555-4555-8555-555555555555'
const TASK = 'mslack00-0b27'
const TRIGGER = 'mtrig000-c9bb'
const GRACE_MS = 1_500

const bunPath = (() => {
  for (const p of [path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']) if (fs.existsSync(p)) return p
  try { return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || null } catch { return null }
})()

/** The mock CLI: every user message it reads lands in its inbox file. */
const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
const inbox = process.argv[3]
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
    fs.appendFileSync(inbox, JSON.stringify({ content: msg.message && msg.message.content }) + '\\n')
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

async function spawnDaemon(twin: 'source' | 'standalone'): Promise<Daemon> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `walnut-trighost-${twin}-`))
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

function stopDaemon(d: Daemon): void {
  if (d.pid > 1) { try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ } }
  try { d.proc.kill('SIGTERM') } catch { /* gone */ }
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

function slice(home = HOME): HostSlice {
  return {
    v: 1, home, hash: `h-${home}`, asOf: Date.now(), host: 'devbox',
    sessions: home === HOME ? [{ sid: SID, taskId: TASK, title: 'Chat loop' }] : [],
    tasks: home === HOME ? [{ id: TASK, title: 'Monitor chat', phase: 'IN_PROGRESS', project: 'Ops' }] : [],
    requests: [],
  }
}

const PROMPT = 'New chat messages are in this fire. Handle each one. é中'

describe.each(bunPath ? ['source', 'standalone'] as const : ['source'] as const)('trigger host delivery on the real %s daemon', (twin) => {
  let d: Daemon
  let itemsFile: string
  let inbox: string

  /** The check prints whatever items the test last wrote; each new id is one fire. */
  function setItems(ids: string[]): void {
    fs.writeFileSync(itemsFile, JSON.stringify({ fire: true, items: ids.map((id) => ({ id, text: `msg ${id}` })) }) + '\n')
  }
  const delivered = (): string[] => {
    try { return fs.readFileSync(inbox, 'utf8').trim().split('\n').filter(Boolean).map((l) => String(JSON.parse(l).content)) } catch { return [] }
  }
  const triggerMessages = () => delivered().filter((c) => c.includes('<walnut-message kind="trigger"'))
  const statePath = () => path.join(d.dir, 'trigger-state', `${TRIGGER}.json`)
  const pending = () => (JSON.parse(fs.readFileSync(statePath(), 'utf8')) as { pendingFires: Array<Record<string, unknown>> }).pendingFires

  async function configure(server: FakeServer, withDeliver = true): Promise<void> {
    const r = await server.cmd({
      cmd: 'triggers.configure',
      config: {
        version: 1,
        triggers: [{
          id: TRIGGER, name: 'Chat monitor', everyMs: 3_600_000,
          check: { run: `cat ${itemsFile}`, timeoutSeconds: 10 },
          ...(withDeliver ? { deliver: { home: HOME, taskId: TASK, prompt: PROMPT } } : {}),
        }],
      },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
  }

  beforeAll(async () => {
    d = await spawnDaemon(twin)
    itemsFile = path.join(d.dir, 'items.json')
    inbox = path.join(d.dir, 'inbox.jsonl')
    setItems([])
    const mock = path.join(d.dir, 'mock-cli.cjs')
    fs.writeFileSync(mock, MOCK_CLI)
    const server = await FakeServer.connect(d.port)
    const hello = await server.cmd({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('trigger-claim-v1')
    const started = await server.cmd({
      cmd: 'start', sid: SID, cwd: d.dir, message: 'init',
      args: [process.execPath, mock, SID, inbox], origin: { home: HOME, task: TASK },
    })
    expect(started.ok, JSON.stringify(started)).toBe(true)
    await waitFor(() => {
      try { return fs.readFileSync(path.join(d.dir, 'streams', `${SID}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false }
    }, 20_000, 'session idle')
    expect((await server.cmd({ cmd: 'host.slice', slice: slice() })).ok).toBe(true)
    await configure(server)
    await server.close()
  }, 90_000)

  afterAll(() => { if (d) stopDaemon(d) })

  it('with no server connected, delivers the fire into the live session within the grace', async () => {
    setItems(['m1'])
    const server = await FakeServer.connect(d.port)
    // Run now, then leave: the Mac falls asleep with the fire unclaimed.
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await server.close()
    await waitFor(() => triggerMessages().some((m) => m.includes('"m1"')), 20_000, 'the fire in the session')
    const msg = triggerMessages().find((m) => m.includes('"m1"'))!
    expect(msg).toContain('from="Trigger: Chat monitor"')
    expect(msg).toContain(PROMPT)
    await waitFor(() => pending().some((f) => f.seq === 1 && !!f.host), 5_000, 'the host delivery recorded')
    const fire = pending().find((f) => f.seq === 1)!
    expect(fire.host).toMatchObject({ sessionId: SID, seqs: [1] })
    expect(String((fire.host as HostDelivery).messageId)).toMatch(/^qm-trigger-/)
  })

  it('the returning server gets the fire with its host delivery, and a claim says so too', async () => {
    const server = await FakeServer.connect(d.port)
    await server.cmd({ cmd: 'host.slice', slice: slice() })
    await configure(server) // the reconnect path replays every pending fire
    await waitFor(() => server.fires(1).length > 0, 10_000, 'the replay')
    expect(server.fires(1)[0]).toMatchObject({ seq: 1, host: { sessionId: SID, seqs: [1] } })
    const epoch = String(server.fires(1)[0].epoch)
    const claim = data(await server.cmd({ cmd: 'triggers.claim', triggerId: TRIGGER, epoch, seqs: [1] }))
    expect(claim).toMatchObject({ claimed: [], busy: [], host: [{ seq: 1, host: { sessionId: SID } }] })
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: TRIGGER, seq: 1 })).acked).toBe(true)
    expect(pending()).toEqual([])
    // Exactly one delivery of m1 ever reached the session.
    expect(triggerMessages().filter((m) => m.includes('"m1"'))).toHaveLength(1)
    await server.close()
  })

  it('a server that claims at arrival delivers alone: the host stays out', async () => {
    const server = await FakeServer.connect(d.port)
    await server.cmd({ cmd: 'host.slice', slice: slice() })
    setItems(['m1', 'm2'])
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => server.fires(2).length > 0, 15_000, 'fire 2')
    const epoch = String(server.fires(2)[0].epoch)
    const claim = data(await server.cmd({ cmd: 'triggers.claim', triggerId: TRIGGER, epoch, seqs: [2] }))
    expect(claim).toMatchObject({ claimed: [2], host: [], busy: [] })
    expect(pending().find((f) => f.seq === 2)?.claimedAt).toEqual(expect.any(Number))
    // Well past the grace and a tick: nothing reached the session from the host.
    await sleep(GRACE_MS + 6_000)
    expect(triggerMessages().some((m) => m.includes('"m2"'))).toBe(false)
    expect(pending().find((f) => f.seq === 2)?.host).toBeUndefined()
    // Only the claiming server delivers; it acks when done.
    expect(data(await server.cmd({ cmd: 'triggers.ack', triggerId: TRIGGER, seq: 2 })).acked).toBe(true)
    await server.close()
  })

  it('a connected socket that never claims (the Mac asleep behind it) does not hold the fire back', async () => {
    const zombie = await FakeServer.connect(d.port)
    await zombie.cmd({ cmd: 'host.slice', slice: slice() })
    setItems(['m1', 'm2', 'm3'])
    expect((await zombie.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => triggerMessages().some((m) => m.includes('"m3"')), 20_000, 'the host delivery of m3')
    // The socket hears about it right away, with the delivery, so a slow server only records it.
    await waitFor(() => zombie.fires(3).some((e) => !!e.host), 10_000, 'the replay with host')
    await zombie.cmd({ cmd: 'triggers.ack', triggerId: TRIGGER, seq: 3 })
    await zombie.close()
  })

  it('another Walnut\'s socket cannot claim this Walnut\'s fire', async () => {
    const other = await FakeServer.connect(d.port)
    await other.cmd({ cmd: 'host.slice', slice: slice(OTHER_HOME) })
    setItems(['m1', 'm2', 'm3', 'm4'])
    expect((await other.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => other.fires(4).length > 0, 15_000, 'fire 4')
    const claim = data(await other.cmd({ cmd: 'triggers.claim', triggerId: TRIGGER, seqs: [4] }))
    expect(claim.foreign).toBe(true)
    // So the host still delivers it to the owner's session.
    await waitFor(() => triggerMessages().some((m) => m.includes('"m4"')), 20_000, 'the host delivery of m4')
    await other.cmd({ cmd: 'triggers.ack', triggerId: TRIGGER, seq: 4 })
    await other.close()
  })

  it('a def without deliver (an older server pushed it) is never delivered by the host', async () => {
    const server = await FakeServer.connect(d.port)
    await configure(server, false)
    setItems(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect((await server.cmd({ cmd: 'triggers.run', triggerId: TRIGGER })).ok).toBe(true)
    await waitFor(() => server.fires(5).length > 0, 15_000, 'fire 5')
    await server.close()
    await sleep(GRACE_MS + 6_000)
    expect(triggerMessages().some((m) => m.includes('"m5"'))).toBe(false)
    const fire = pending().find((f) => f.seq === 5)!
    expect(fire.arbitrated).toBeUndefined()
    expect(fire.host).toBeUndefined()
    // Re-armed WITH deliver later, that old fire still stays the server's.
    const back = await FakeServer.connect(d.port)
    await configure(back)
    await back.close()
    await sleep(GRACE_MS + 6_000)
    expect(triggerMessages().some((m) => m.includes('"m5"'))).toBe(false)
  })
})
