/**
 * One kind of link (docs/plan/walnut-servers-everywhere.md), on REAL daemon
 * processes, both twins: the leader keeps a host server running through the
 * daemon (`server.configure`); that server, a follower, reads who leads, is
 * refused everything only the leader may write, and the two reach each other
 * only by streams the daemon passes between their links.
 *
 *   test (the leader) ══trusted WS══► daemon (source twin on node, standalone on bun)
 *                                        │ spawns with a token, keeps running, adopts
 *                                        ▼
 *                                   fake host server ══follower WS══► the same daemon
 *
 * What's real: the daemon processes, their supervision (spawn, process group,
 * backoff restart, pid + start time adoption across a daemon restart, SIGTERM on
 * removal), the follower role, its token and its refusals, the stream relay.
 * The host server is a small script that speaks to the daemon the way the real
 * one does.
 *
 * Hygiene: every dir is a temp dir; daemons and fake servers are ours and are
 * stopped by pid at the end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { StreamLane } from '../../src/providers/stream-lane.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/walnut-home'
const WALNUT = 'wprimaryhost01'
/** The takeover window: a primary unheard this long is away. */
const T = 3_000

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const WS_PATH = createRequire(import.meta.url).resolve('ws')

/** A host server as its daemon sees it: a follower that reads and tries what it may not. */
const FAKE_SERVER = `
const WebSocket = require(${JSON.stringify(WS_PATH)})
const fs = require('fs')
const path = require('path')
const out = process.env.FAKE_OUT
const log = (o) => fs.appendFileSync(out, JSON.stringify(Object.assign({ t: Date.now(), pid: process.pid }, o)) + '\\n')
log({ ev: 'start', daemonDir: process.env.WALNUT_HOST_DAEMON_DIR, label: process.env.FAKE_LABEL, token: process.env.WALNUT_FOLLOWER_TOKEN })
process.on('SIGTERM', () => { log({ ev: 'sigterm' }); process.exit(0) })
if (process.env.FAKE_EXIT_FIRST === '1' && !fs.existsSync(out + '.exited')) {
  fs.writeFileSync(out + '.exited', '1')
  log({ ev: 'exit-first' })
  process.exit(3)
}
const port = Number(fs.readFileSync(path.join(process.env.WALNUT_HOST_DAEMON_DIR, 'daemon.port'), 'utf8'))
const ws = new WebSocket('ws://127.0.0.1:' + port)
let id = 0
const pending = new Map()
const call = (cmd, p) => new Promise((resolve) => { const my = ++id; pending.set(my, resolve); ws.send(JSON.stringify(Object.assign({ id: my, cmd }, p || {}))) })
const b64 = (t) => Buffer.from(t).toString('base64')
const text = (d) => Buffer.from(d, 'base64').toString()
ws.on('message', (d) => {
  let m; try { m = JSON.parse(String(d)) } catch { return }
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (!m.ev) return
  // Streams: ours to the leader (o…), and the leader's to us (r…).
  if (m.ev === 'stream-accept' && m.sid === 'o1') ws.send(JSON.stringify({ cmd: 'stream.data', sid: 'o1', d: b64('hello leader') }))
  else if (m.ev === 'stream-data' && m.sid === 'o1') { log({ ev: 'echo', text: text(m.d) }); ws.send(JSON.stringify({ cmd: 'stream.ack', sid: 'o1', n: 1 })); ws.send(JSON.stringify({ cmd: 'stream.end', sid: 'o1' })) }
  else if (m.ev === 'stream-open') { log({ ev: 'incoming', from: m.from, home: m.home, purpose: m.purpose }); ws.send(JSON.stringify({ cmd: 'stream.accept', sid: m.sid })) }
  else if (m.ev === 'stream-data') log({ ev: 'from-leader', text: text(m.d) })
  else if (m.ev === 'stream-close') log({ ev: 'stream-close', sid: m.sid, error: m.error })
  else log({ ev: 'event', name: m.ev })
})
ws.on('error', () => {})
ws.on('close', () => log({ ev: 'closed' }))
ws.on('open', async () => {
  log({ ev: 'before-hello', r: await call('hooks.configure', { rules: [] }) })
  log({ ev: 'no-token', r: await call('follower.hello', { walnutId: process.env.FAKE_WALNUT, home: process.env.FAKE_HOME }) })
  log({ ev: 'hello', r: await call('follower.hello', { walnutId: process.env.FAKE_WALNUT, home: process.env.FAKE_HOME, token: process.env.WALNUT_FOLLOWER_TOKEN }) })
  log({ ev: 'hooks', r: await call('hooks.configure', { rules: [] }) })
  log({ ev: 'leader', r: await call('leader.configure', { home: process.env.FAKE_HOME, walnutId: process.env.FAKE_WALNUT, backup: true }) })
  log({ ev: 'server', r: await call('server.configure', { home: process.env.FAKE_HOME, spec: null }) })
  log({ ev: 'list', r: await call('list', {}) })
  log({ ev: 'own', r: await call('server.status', {}) })
  // A stream to the leader, and one to itself (a follower opens to the primary or the companion only).
  const openStreams = () => {
    ws.send(JSON.stringify({ cmd: 'stream.open', sid: 'o1', to: 'primary', purpose: 'web' }))
    ws.send(JSON.stringify({ cmd: 'stream.open', sid: 'o2', to: 'follower' }))
    ws.send(JSON.stringify({ cmd: 'stream.open', sid: 'o3', to: 'companion' }))
  }
  // FAKE_OPEN_AFTER: not before that file exists (the leader's lane is up by then).
  const after = process.env.FAKE_OPEN_AFTER
  if (!after) openStreams()
  else { const t = setInterval(() => { if (fs.existsSync(after)) { clearInterval(t); openStreams() } }, 100) }
  ws.send(JSON.stringify({ cmd: 'follower.report', report: { route: { kind: 'leader' }, pid: process.pid } }))
  // Chatty on purpose: none of this may count as the primary heard.
  setInterval(async () => { log({ ev: 'status', r: await call('follower.status', {}) }) }, 250)
})
setInterval(() => {}, 1 << 30)
`

interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

let base = ''
const started: number[] = []

async function spawnDaemon(dir: string, twin: 'source' | 'standalone'): Promise<Daemon> {
  fs.mkdirSync(dir, { recursive: true })
  for (const f of ['daemon.port', 'daemon.pid']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* none */ } }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_LEADER_TAKEOVER_MS: String(T),
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  let proc: ChildProcess
  if (twin === 'source') {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  } else {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

async function stopDaemon(d: Daemon): Promise<void> {
  try { process.kill(d.pid, 'SIGTERM') } catch { /* gone */ }
  await waitFor(() => !alive(d.pid), 20_000, 'daemon exit')
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const t = setTimeout(() => reject(new Error('ws connect timeout')), 5000)
    ws.once('open', () => { clearTimeout(t); resolve(ws) })
    ws.once('error', (e) => { clearTimeout(t); reject(e) })
  })
}

let cmdId = 1
function cmd(ws: WebSocket, body: Record<string, unknown>): Promise<Record<string, any>> {
  const id = cmdId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 15_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

function events(file: string): Array<Record<string, any>> {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-'))
})

afterAll(() => {
  for (const file of fs.existsSync(base) ? fs.readdirSync(base).filter((n) => n.endsWith('.jsonl')) : []) {
    for (const e of events(path.join(base, file))) {
      if (typeof e.pid === 'number' && e.pid > 1 && alive(e.pid)) { try { process.kill(e.pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }
  for (const pid of started) { if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: the leader keeps a follower server running`, () => {
    it('supervises, refuses the follower the leader\'s writes, adopts across a daemon restart, stops on removal', async () => {
      const dir = path.join(base, twin.slice(0, 2))
      const out = path.join(base, `${twin}.jsonl`)
      const fake = path.join(base, `${twin}-fake.cjs`)
      fs.writeFileSync(fake, FAKE_SERVER)
      let d = await spawnDaemon(dir, twin)
      const leader = await connectWs(d.port)

      // The leader's end of the streams: it accepts what the follower opens and echoes it.
      const leaderSaw: Array<Record<string, any>> = []
      leader.on('message', (data) => {
        let m: Record<string, any>
        try { m = JSON.parse(String(data)) } catch { return }
        if (!m.ev?.startsWith('stream-')) return
        leaderSaw.push(m)
        if (m.ev === 'stream-open') leader.send(JSON.stringify({ cmd: 'stream.accept', sid: m.sid }))
        if (m.ev === 'stream-data') leader.send(JSON.stringify({ cmd: 'stream.data', sid: m.sid, d: Buffer.from('echo:' + Buffer.from(m.d, 'base64').toString()).toString('base64') }))
      })

      // No leader yet: a follower of an unknown Walnut is told so, and nobody else may configure.
      const stranger = await connectWs(d.port)
      expect((await cmd(stranger, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME })).errorKind).toBe('unknown_walnut')
      const spec = {
        v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [fake], cwd: base,
        env: { FAKE_OUT: out, FAKE_WALNUT: WALNUT, FAKE_HOME: HOME, FAKE_EXIT_FIRST: '1', FAKE_LABEL: 'devbox' },
        log: path.join(base, `${twin}-server.log`), port: 41_234, settings: { expose: { enabled: false } },
      }
      expect((await cmd(stranger, { cmd: 'server.configure', home: HOME, spec })).error).toMatch(/send leader\.configure for this Walnut first/)

      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
      // A live Mac is heard all the time (it pings every beat); this one, every half second.
      const beat = setInterval(() => { try { leader.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 500)
      expect((await cmd(leader, { cmd: 'server.configure', home: HOME, spec: { ...spec, walnutId: 'wsomeoneelse' } })).error).toMatch(/another Walnut/)
      expect((await cmd(leader, { cmd: 'server.configure', home: HOME, spec: { ...spec, command: 'node' } })).error).toMatch(/absolute path/)
      const first = await cmd(leader, { cmd: 'server.configure', home: HOME, spec })
      expect(first.ok).toBe(true)
      expect(['starting', 'running']).toContain(first.status.state)

      // The first run exits 3; the daemon starts it again after 5 s.
      await waitFor(() => events(out).some((e) => e.ev === 'exit-first'), 15_000, 'first exit')
      await waitFor(() => events(out).some((e) => e.ev === 'own'), 30_000, 'the restarted server to follow')
      const ev = events(out)
      const starts = ev.filter((e) => e.ev === 'start')
      expect(starts).toHaveLength(2)
      expect(starts[1]!.t - ev.find((e) => e.ev === 'exit-first')!.t).toBeGreaterThanOrEqual(4_000)
      // The daemon hands it its own dir, the spec's env and a token of its own.
      expect(starts[1]!.daemonDir).toBe(dir)
      expect(starts[1]!.label).toBe('devbox')
      expect(starts[1]!.token).toMatch(/^[0-9a-f]{64}$/)
      const serverPid = starts[1]!.pid as number

      // Before follower.hello it is an ordinary local client; after it, a follower.
      expect(ev.find((e) => e.ev === 'before-hello')!.r.errorKind).not.toBe('follower_refused')
      // Only with the token the daemon started it with: a stray process cannot take its place.
      expect(ev.find((e) => e.ev === 'no-token')!.r).toMatchObject({ ok: false, errorKind: 'not_started_here' })
      expect((await cmd(stranger, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token: 'f'.repeat(64) })).errorKind).toBe('not_started_here')
      // Nor may a socket that is not the leader's open a stream to the follower.
      const strangerSaw: Array<Record<string, any>> = []
      stranger.on('message', (data) => { try { strangerSaw.push(JSON.parse(String(data))) } catch { /* not json */ } })
      stranger.send(JSON.stringify({ cmd: 'stream.open', sid: 'o9', to: 'follower' }))
      await waitFor(() => strangerSaw.some((m) => m.ev === 'stream-close'), 5_000, 'the stranger refused')
      expect(strangerSaw.find((m) => m.ev === 'stream-close')).toMatchObject({ sid: 'o9', error: 'this link opens no such stream' })
      stranger.close()
      const hello = ev.find((e) => e.ev === 'hello')!.r
      expect(hello.ok).toBe(true)
      expect(hello).toMatchObject({ walnutId: WALNUT, home: HOME, holder: 'primary', primaryConnected: true, settings: { expose: { enabled: false } } })
      for (const name of ['hooks', 'leader', 'server']) {
        expect(ev.find((e) => e.ev === name)!.r).toMatchObject({ ok: false, errorKind: 'follower_refused' })
      }
      expect(ev.find((e) => e.ev === 'list')!.r.ok).toBe(true)
      expect(ev.find((e) => e.ev === 'own')!.r.status).toMatchObject({ state: 'running', pid: serverPid, restarts: 1 })

      // Its stream reaches the leader and the answer comes back; the other two have nobody there.
      await waitFor(() => events(out).some((e) => e.ev === 'echo'), 10_000, 'the echo through the daemon')
      expect(events(out).find((e) => e.ev === 'echo')!.text).toBe('echo:hello leader')
      expect(leaderSaw.find((m) => m.ev === 'stream-open')).toMatchObject({ from: 'follower', home: HOME, purpose: 'web' })
      await waitFor(() => leaderSaw.some((m) => m.ev === 'stream-end'), 5_000, 'the follower FIN')
      const closes = events(out).filter((e) => e.ev === 'stream-close')
      expect(closes.find((e) => e.sid === 'o2')!.error).toBe('a follower opens streams to the primary or the companion')
      expect(closes.find((e) => e.sid === 'o3')!.error).toBe('the cloud companion is not linked to this host')
      // The leader reads its report through the daemon.
      const reported = await cmd(leader, { cmd: 'server.status', home: HOME })
      expect(reported.status).toMatchObject({ report: { route: { kind: 'leader' }, pid: serverPid } })

      // The leader's stream to its follower.
      const leaderSid = 'o1'
      leader.send(JSON.stringify({ cmd: 'stream.open', sid: leaderSid, to: 'follower', purpose: 'replica' }))
      await waitFor(() => leaderSaw.some((m) => m.ev === 'stream-accept' && m.sid === leaderSid), 5_000, 'the follower to accept')
      expect(events(out).find((e) => e.ev === 'incoming')).toMatchObject({ from: 'primary', home: HOME, purpose: 'replica' })
      leader.send(JSON.stringify({ cmd: 'stream.data', sid: leaderSid, d: Buffer.from('a copy').toString('base64') }))
      await waitFor(() => events(out).some((e) => e.ev === 'from-leader'), 5_000, 'the copy to arrive')
      expect(events(out).find((e) => e.ev === 'from-leader')!.text).toBe('a copy')

      // New settings reach the follower without a restart.
      const moved = await cmd(leader, { cmd: 'server.configure', home: HOME, spec: { ...spec, settings: { expose: { enabled: true } } } })
      expect(moved.status).toMatchObject({ state: 'running', pid: serverPid })
      await waitFor(() => events(out).some((e) => e.ev === 'status' && e.r.settings?.expose?.enabled === true), 5_000, 'the new settings')

      // The leader goes quiet (its socket closes); the chatty follower does not count as the primary heard,
      // and the stream the leader held ends at the follower.
      clearInterval(beat)
      leader.close()
      await waitFor(() => events(out).some((e) => e.ev === 'stream-close' && e.error === 'the other server is no longer linked to this host'), 5_000, 'the stream to end with the link')
      await sleep(T + 1_000)
      const last = events(out).filter((e) => e.ev === 'status').pop()!.r
      expect(last.primaryConnected).toBe(false)
      expect(last.primaryHeardAgoMs).toBeGreaterThanOrEqual(T)

      // A daemon restart (an upgrade) adopts the running server instead of starting another.
      await stopDaemon(d)
      expect(alive(serverPid)).toBe(true)
      d = await spawnDaemon(dir, twin)
      const leader2 = await connectWs(d.port)
      const adopted = await cmd(leader2, { cmd: 'server.status', home: HOME })
      expect(adopted.status).toMatchObject({ state: 'running', pid: serverPid })
      await sleep(1_500)
      expect(events(out).filter((e) => e.ev === 'start')).toHaveLength(2)

      // Removing the spec ends the server.
      expect((await cmd(leader2, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
      const removed = await cmd(leader2, { cmd: 'server.configure', home: HOME, spec: null })
      expect(removed.status.state).toBe('off')
      await waitFor(() => !alive(serverPid), 15_000, 'the server to stop')
      expect(events(out).some((e) => e.ev === 'sigterm' && e.pid === serverPid)).toBe(true)
      expect(fs.readdirSync(path.join(dir, 'host-server')).filter((n) => n.startsWith('server-'))).toEqual([])
      leader2.close()
      await stopDaemon(d)
    }, 120_000)

    it('the leader\'s lane carries its streams both ways, nothing else, and is never the primary', async () => {
      const dir = path.join(base, `${twin.slice(0, 2)}-lane`)
      const out = path.join(base, `${twin}-lane.jsonl`)
      const go = `${out}.go`
      const fake = path.join(base, `${twin}-lane-fake.cjs`)
      fs.writeFileSync(fake, FAKE_SERVER)
      const d = await spawnDaemon(dir, twin)
      const leader = await connectWs(d.port)
      const leaderSaw: Array<Record<string, any>> = []
      leader.on('message', (data) => { try { const m = JSON.parse(String(data)); if (m.ev) leaderSaw.push(m) } catch { /* not json */ } })

      // Before the leader describes its Walnut, nobody may take a lane for it.
      const early = await connectWs(d.port)
      expect((await cmd(early, { cmd: 'stream.lane', home: HOME, walnutId: WALNUT })).errorKind).toBe('unknown_walnut')
      early.close()

      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
      const beat = setInterval(() => { try { leader.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 500)
      const spec = {
        v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [fake], cwd: base,
        env: { FAKE_OUT: out, FAKE_WALNUT: WALNUT, FAKE_HOME: HOME, FAKE_OPEN_AFTER: go },
        log: path.join(base, `${twin}-lane-server.log`), port: 41_235, settings: { expose: { enabled: false } },
      }
      expect((await cmd(leader, { cmd: 'server.configure', home: HOME, spec })).ok).toBe(true)
      await waitFor(() => events(out).some((e) => e.ev === 'own'), 30_000, 'the server to follow')

      // The socket that speaks for the Walnut cannot become a lane; another Walnut's id is refused.
      expect((await cmd(leader, { cmd: 'stream.lane', home: HOME, walnutId: WALNUT })).error).toMatch(/already speaks for a leader/)
      const wrong = await connectWs(d.port)
      expect((await cmd(wrong, { cmd: 'stream.lane', home: HOME, walnutId: 'wsomeoneelse' })).errorKind).toBe('unknown_walnut')
      // A lane sends streams only.
      expect((await cmd(wrong, { cmd: 'stream.lane', home: HOME, walnutId: WALNUT })).ok).toBe(true)
      for (const c of ['list', 'leader.configure', 'server.configure', 'host.slice']) {
        expect((await cmd(wrong, { cmd: c, home: HOME })).errorKind).toBe('lane_refused')
      }
      wrong.close()

      // The Mac's lane: its streams to the follower, the follower's to the Mac.
      const incoming: Array<{ from: string; purpose?: string }> = []
      const lane = new StreamLane({
        hostKey: 'devbox', home: HOME, walnutId: async () => WALNUT,
        daemonInstanceId: () => null,
        forward: async () => ({ port: d.port, onExit: () => {}, stop: () => {} }),
        accept: (info) => {
          incoming.push({ from: info.from, purpose: info.purpose })
          return (stream) => {
            stream.on('error', () => { /* ends with the lane */ })
            stream.on('data', (b: Buffer) => stream.write(`echo:${b.toString()}`))
          }
        },
        beatMs: 500,
      })
      lane.start()
      await waitFor(() => lane.ready, 10_000, 'the lane')
      const toFollower = await lane.open('follower', 'replica')
      const toFollowerError = new Promise<Error>((resolve) => toFollower.on('error', resolve))
      toFollower.write('a copy over the lane')
      await waitFor(() => events(out).some((e) => e.ev === 'from-leader'), 5_000, 'the copy to arrive')
      expect(events(out).find((e) => e.ev === 'from-leader')!.text).toBe('a copy over the lane')
      expect(events(out).find((e) => e.ev === 'incoming')).toMatchObject({ from: 'primary', home: HOME, purpose: 'replica' })

      fs.writeFileSync(go, '1')
      await waitFor(() => events(out).some((e) => e.ev === 'echo'), 10_000, 'the follower\'s stream over the lane')
      expect(events(out).find((e) => e.ev === 'echo')!.text).toBe('echo:hello leader')
      expect(incoming).toEqual([{ from: 'follower', purpose: 'web' }])
      // None of it rode the session link.
      expect(leaderSaw.filter((m) => String(m.ev).startsWith('stream-'))).toEqual([])

      // The session link goes quiet: the lane, still answering, is not the primary heard.
      clearInterval(beat)
      leader.close()
      await sleep(T + 1_000)
      const last = events(out).filter((e) => e.ev === 'status').pop()!.r
      expect(last.primaryConnected).toBe(false)

      // The lane ends: its stream ends at the follower.
      lane.stop()
      await waitFor(() => events(out).some((e) => e.ev === 'stream-close' && e.error === 'the other server is no longer linked to this host'), 5_000, 'the stream to end with the lane')
      expect(lane.ready).toBe(false)
      expect((await toFollowerError).message).toBe('the lane was closed')

      const leader2 = await connectWs(d.port)
      expect((await cmd(leader2, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
      await cmd(leader2, { cmd: 'server.configure', home: HOME, spec: null })
      leader2.close()
      await stopDaemon(d)
    }, 120_000)
  })
}
