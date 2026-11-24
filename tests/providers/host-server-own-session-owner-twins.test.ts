/**
 * A session the host's own server started is its Walnut's, after any restart of the daemon and
 * after the server's spec is gone, on REAL daemon processes (2026-11-23 release
 * rehearsal: a host-judged session's next turn after a restart of the host's service never
 * reached the leader). And what that ownership does NOT open.
 *
 *   leader A (marina) ==trusted WS==>+-- daemon (standalone, on bun)
 *   follower of A     ==follower WS=>+    runs the server A configured, on data dir D
 *   A's companion     <==bridge WS===+
 *
 * The host's server starts its own sessions naming its data dir D as their home (origin.home is
 * its OPEN_WALNUT_HOME), so the spawn journal says D; its follower link says A's leader home.
 *
 *   own      A's follower reads the stream and status of a session started with home D, before and
 *            after a daemon restart (before the fix: "no such file" and not_found after a restart,
 *            and the host's runner swallowed the next turn's result)
 *   durable  the journal line names A beside D, so with the spec removed and the daemon restarted A
 *            still stops it as its own
 *   bridge   A's companion bridge never operates such a session directly (send, attach, history,
 *            status, resume, prompt answer): the host's server and its leader's channel do
 *   taken    a session the Mac started and the host took over by a resume spawn from D stays fenced
 *            from A's bridge after the daemon restarts (the journal keeps the Mac's first home)
 *   replica  a stop asked from D (the host's replica) of a session the Mac started and runs is
 *            refused: the replica stops only what its server spawned last here, by its resume record
 *            or, when that record is gone, by the journal's home
 *   control  a session of another home stays not_found to A's follower
 *   refused  a spec whose data dir is a Walnut's own home is refused at configure
 *   layouts  D as the leader writes it now (<root>/walnuts/<id>/data) and the shared <root>/data from
 *            before the split, which a Walnut keeps when its .walnut-id mark names it
 *
 * Hygiene: every dir is a temp dir; the daemons, the placeholder server, the fake companion and
 * the mock CLIs are ours and are stopped by pid in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME_A = '/fixture/marina-home'
const WALNUT_A = 'wmarinahost01'
const OWN = 'aaaaaaaa-1a1a-4a1a-8a1a-1a1a1a1a1a1a'
const OTHER = 'cccccccc-2c2c-4c2c-8c2c-2c2c2c2c2c2c'
const MACS = 'dddddddd-3d3d-4d3d-8d3d-3d3d3d3d3d3d'
const TAKEN = 'eeeeeeee-4e4e-4e4e-8e4e-4e4e4e4e4e4e'
const AGED = 'ffffffff-5f5f-4f5f-8f5f-5f5f5f5f5f5f'
const BUN: string | undefined = testBun()

/** A Claude CLI stand-in: init, a turn's end, idle, and gone with its stdin. */
const MOCK_CLI = `
const sid = process.argv[2]
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
process.stdin.on('end', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(fn: () => T, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
async function until<T>(fn: () => Promise<T>, ms: number, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(100)
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const read = (f: string) => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

let base = ''
const pids = new Set<number>()
const sockets: WebSocket[] = []
const servers: WebSocketServer[] = []

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
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

/** A fake companion: the daemon dials it; `link()` is its newest open link that said hello. */
async function companion(): Promise<{ url: string; link: (after?: number) => Promise<WebSocket>; count: () => number }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)
  await new Promise<void>((r) => wss.on('listening', () => r()))
  const hellos: WebSocket[] = []
  wss.on('connection', (ws) => {
    sockets.push(ws as unknown as WebSocket)
    ws.on('message', (d) => {
      try {
        const f = JSON.parse(String(d))
        if (f.ev === 'hello' && !hellos.includes(ws as unknown as WebSocket)) hellos.push(ws as unknown as WebSocket)
        if (f.ev === 'bridge-ping') ws.send(JSON.stringify({ cmd: 'ping', ackSeq: f.seq, id: cmdId++ }))
      } catch { /* not json */ }
    })
  })
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/bridge`,
    link: (after = 0) => waitFor(() => { const open = hellos.slice(after).filter((w) => w.readyState === WebSocket.OPEN); return open[open.length - 1] }, 15_000, 'the bridge hello'),
    count: () => hellos.length,
  }
}

async function spawnDaemon(dir: string): Promise<{ port: number; pid: number }> {
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true })
  for (const f of ['daemon.port', 'daemon.pid']) fs.rmSync(path.join(dir, f), { force: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_REPLICA_DIR: path.join(dir, 'host-replica'),
    WALNUT_HOME_OVERRIDE: path.join(dir, 'home'),
    // The sessions outlive the daemon, as a host's service restart leaves them.
    WALNUT_DAEMON_KEEP_SESSIONS: '1',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write('[daemon] ' + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, 'the daemon')
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  pids.add(pid)
  return { port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

async function restartDaemon(dir: string, d: { pid: number }, between?: () => void): Promise<{ port: number; pid: number }> {
  process.kill(d.pid, 'SIGTERM')
  await waitFor(() => !alive(d.pid), 20_000, 'the daemon to stop')
  between?.()
  return spawnDaemon(dir)
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hso-')))
})

afterAll(async () => {
  for (const ws of sockets) { try { ws.terminate() } catch { /* closed */ } }
  for (const s of servers) { try { s.close() } catch { /* closed */ } }
  for (const pid of pids) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  await sleep(300)
  for (const pid of pids) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

const LAYOUTS = ['split', 'legacy'] as const
for (const [n, layout] of LAYOUTS.entries()) {
  describe.skipIf(!BUN)(`${layout} layout: the host's own server's session stays its Walnut's`, () => {
    it('A reads it across a restart and stops it after its spec is gone; A\'s bridge and the replica stay fenced; another home stays not_found', async () => {
      const dir = path.join(base, `d${layout[0]}`)
      // The layouts a leader writes for its server: <host root>/walnuts/<walnut id>/data, or the
      // shared <host root>/data it kept from before the split (marked with its whole id).
      const root = path.join(base, `${layout}-host`)
      const data = layout === 'split' ? path.join(root, 'walnuts', WALNUT_A, 'data') : path.join(root, 'data')
      if (layout === 'legacy') { fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, '.walnut-id'), WALNUT_A) }
      const cwd = path.join(base, `${layout}-work`)
      fs.mkdirSync(cwd, { recursive: true })
      const mock = path.join(base, 'mock-cli.cjs')
      fs.writeFileSync(mock, MOCK_CLI)
      let d = await spawnDaemon(dir)

      const leader = await connect(d.port)
      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME_A, walnutId: WALNUT_A, backup: true })).ok).toBe(true)
      const cloud = await companion()
      expect((await cmd(leader, { cmd: 'bridge.configure', enabled: true, url: cloud.url, token: 'fixture-only', hostAlias: 'fixture-host', home: HOME_A })).ok).toBe(true)
      // The server A's daemon runs for it, on its own data dir D (OPEN_WALNUT_HOME), hands over its token.
      const tokenFile = path.join(base, `${layout}-token`)
      const spec = {
        v: 1, home: HOME_A, walnutId: WALNUT_A, command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
        cwd: base, env: { OPEN_WALNUT_HOME: data }, log: path.join(base, `${layout}-placeholder.log`), port: 41_107 + n,
        settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
      }
      // A data dir that is a Walnut's own home (here this host's production one) is refused: it would
      // hand that Walnut's sessions to A.
      const own = await cmd(leader, { cmd: 'server.configure', home: HOME_A, spec: { ...spec, env: { OPEN_WALNUT_HOME: path.join(dir, 'home', '.open-walnut') } } })
      expect(own, JSON.stringify(own)).toMatchObject({ ok: false })
      expect(String(own.error)).toMatch(/is a Walnut's own home/)
      expect((await cmd(leader, { cmd: 'server.configure', home: HOME_A, spec })).ok).toBe(true)
      const [token, placeholder] = (await waitFor(() => read(tokenFile), 20_000, 'the token')).split(' ')
      pids.add(Number(placeholder))

      // Started as the host's own server starts its sessions (origin.home is its data dir), the
      // control of another home, and one the Mac started itself (its home).
      const journal = path.join(dir, 'spawn-journal.jsonl')
      const startAs = async (sid: string, home: string) => {
        const started = await cmd(leader, { cmd: 'start', sid, cwd, message: 'init', args: [process.execPath, mock, sid], origin: { home, task: 'mwtask-0001' } })
        expect(started.ok, JSON.stringify(started)).toBe(true)
        await waitFor(() => read(path.join(dir, 'streams', `${sid}.jsonl`)).includes('"state":"idle"'), 30_000, `${sid} idle`)
        // Its id is journaled once the tailer reads its init line, which can lag the stream file.
        await waitFor(() => read(journal).includes(sid), 30_000, `${sid} in the spawn journal`)
        const st = await cmd(leader, { cmd: 'status', sid })
        if (typeof st.pid === 'number') pids.add(st.pid)
        return st
      }
      for (const [sid, home] of [[OWN, data], [OTHER, '/fixture/acme-data'], [MACS, HOME_A], [TAKEN, HOME_A], [AGED, data]] as const) await startAs(sid, home)
      // taken: the Mac's session, idle, is stopped and resumed by the host's server from D (a live one is never handed over).
      const first = await cmd(leader, { cmd: 'status', sid: TAKEN })
      expect(await cmd(leader, { cmd: 'stop', sid: TAKEN, reason: 'user', home: HOME_A }), 'the Mac stops its idle session').toMatchObject({ ok: true, stopped: true })
      await waitFor(() => typeof first.pid !== 'number' || !alive(first.pid), 20_000, 'the first CLI of the taken session to end')
      const resumed = await cmd(leader, { cmd: 'start', sid: TAKEN, cwd, message: 'resume', args: [process.execPath, mock, TAKEN], origin: { home: data, task: 'mwtask-0001' } })
      expect(resumed.ok, JSON.stringify(resumed)).toBe(true)
      const taken = await until(async () => { const st = await cmd(leader, { cmd: 'status', sid: TAKEN }); return st.alive && st.pid !== first.pid ? st : null }, 30_000, 'the host\'s resume of the taken session')
      if (typeof taken.pid === 'number') pids.add(taken.pid)
      const ownLine = JSON.parse(read(journal).split('\n').find((l) => l.includes(OWN))!)
      expect(ownLine, 'the journal keeps the home as it was asked, and names the Walnut it was for').toMatchObject({ home: data, walnut: HOME_A })
      expect(JSON.parse(read(journal).split('\n').find((l) => l.includes(OTHER))!).walnut).toBeUndefined()

      const reads = async (port: number) => {
        const follower = await connect(port)
        const hi = await cmd(follower, { cmd: 'follower.hello', walnutId: WALNUT_A, home: HOME_A, token })
        expect(hi.ok, JSON.stringify(hi)).toBe(true)
        const out: Record<string, { stat: Record<string, any>; status: Record<string, any> }> = {}
        for (const sid of [OWN, OTHER]) {
          out[sid] = {
            stat: await cmd(follower, { cmd: 'fs.stat', path: path.join(dir, 'streams', `${sid}.jsonl`) }),
            status: await cmd(follower, { cmd: 'status', sid }),
          }
        }
        follower.close()
        return out
      }
      const judge = (r: Awaited<ReturnType<typeof reads>>, when: string) => {
        expect(r[OWN]!.stat, `${when}: its own session's stream`).toMatchObject({ ok: true, exists: true })
        expect(r[OWN]!.stat.size, when).toBeGreaterThan(0)
        expect(r[OWN]!.status, `${when}: its own session's status`).toMatchObject({ ok: true, exists: true })
        expect(r[OTHER]!.stat, `${when}: another home's stream`).toMatchObject({ ok: true, exists: false })
        expect(r[OTHER]!.status, `${when}: another home's status`).toMatchObject({ ok: false, errorKind: 'not_found' })
      }
      judge(await reads(d.port), 'before the restart')

      // bridge: A's companion reaches A's own session, never the one the host's server started.
      const link = await cloud.link()
      expect(await cmd(link, { cmd: 'status', sid: MACS }), 'the bridge reaches a session of its Walnut').toMatchObject({ ok: true, exists: true })
      for (const frame of [
        { cmd: 'send', sid: OWN, message: 'from the companion', messageId: 'qm-companion-1' },
        { cmd: 'attach', sid: OWN },
        { cmd: 'read-history', sid: OWN },
        { cmd: 'status', sid: OWN },
        { cmd: 'bridgeResume', sid: OWN, message: 'from the companion', cwd },
        { cmd: 'session.permission', sid: OWN, requestId: 'r-1', allow: true },
      ]) expect(await cmd(link, frame), String(frame.cmd)).toMatchObject({ ok: false, errorKind: 'not_owner' })
      expect(await cmd(link, { cmd: 'status', sid: TAKEN }), 'the taken session, live').toMatchObject({ ok: false, errorKind: 'not_owner' })

      // replica: a stop asked from D of the session the Mac started and runs is refused, and it runs on.
      const refused = await cmd(leader, { cmd: 'stop', sid: MACS, reason: 'user', home: data })
      expect(refused, JSON.stringify(refused)).toMatchObject({ ok: true, stopped: false, reason: 'not_owned', detail: 'not_this_server' })
      expect(await cmd(leader, { cmd: 'status', sid: MACS })).toMatchObject({ ok: true, exists: true, alive: true })

      // The host's service restarts: a new daemon on the same dirs, the spec file read again at boot.
      leader.close()
      const hellosBefore = cloud.count()
      // The aged session's resume record is gone (pruned after its 30 days) while the daemon is down.
      d = await restartDaemon(dir, d, () => fs.rmSync(path.join(dir, 'resume-records', `${AGED}.json`), { force: true }))
      judge(await reads(d.port), 'after the restart')

      // taken, after the restart: the daemon adopted it with no spawn of its own; the bridge is still refused.
      const back = await connect(d.port)
      expect((await cmd(back, { cmd: 'leader.configure', home: HOME_A, walnutId: WALNUT_A, backup: true })).ok).toBe(true)
      expect((await cmd(back, { cmd: 'bridge.configure', enabled: true, url: cloud.url, token: 'fixture-only', hostAlias: 'fixture-host', home: HOME_A })).ok).toBe(true)
      const link2 = await cloud.link(hellosBefore)
      expect(await cmd(link2, { cmd: 'status', sid: MACS }), 'the bridge still reaches its Walnut\'s session').toMatchObject({ ok: true, exists: true })
      for (const frame of [
        { cmd: 'status', sid: TAKEN },
        { cmd: 'send', sid: TAKEN, message: 'from the companion', messageId: 'qm-companion-2' },
        { cmd: 'attach', sid: TAKEN },
        { cmd: 'session.permission', sid: TAKEN, requestId: 'r-2', allow: true },
      ]) expect(await cmd(link2, frame), `${frame.cmd} on the taken session after the restart`).toMatchObject({ ok: false, errorKind: 'not_owner' })
      // aged: with no resume record and no spawn of this daemon, the replica's stop reads the journal's home.
      const aged = await cmd(back, { cmd: 'stop', sid: AGED, reason: 'user', home: data })
      expect(aged, JSON.stringify(aged)).toMatchObject({ ok: true })
      expect(aged.detail, JSON.stringify(aged)).not.toBe('not_this_server')
      // MACS stays the Mac's: the replica is still refused.
      expect(await cmd(back, { cmd: 'stop', sid: MACS, reason: 'user', home: data })).toMatchObject({ stopped: false, reason: 'not_owned', detail: 'not_this_server' })
      back.close()

      // durable: the spec removed and the daemon restarted again, A still stops the session as its own.
      const again = await connect(d.port)
      expect((await cmd(again, { cmd: 'leader.configure', home: HOME_A, walnutId: WALNUT_A, backup: true })).ok).toBe(true)
      expect((await cmd(again, { cmd: 'server.configure', home: HOME_A, spec: null })).ok).toBe(true)
      again.close()
      d = await restartDaemon(dir, d)
      const last = await connect(d.port)
      expect((await cmd(last, { cmd: 'leader.configure', home: HOME_A, walnutId: WALNUT_A, backup: true })).ok).toBe(true)
      const other = await cmd(last, { cmd: 'stop', sid: OTHER, reason: 'user', home: HOME_A })
      expect(other, 'another home\'s session is not A\'s to stop').toMatchObject({ ok: true, stopped: false, reason: 'not_owned' })
      const stopped = await cmd(last, { cmd: 'stop', sid: OWN, reason: 'user', home: HOME_A })
      expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true })
      expect(stopped.reason, JSON.stringify(stopped)).not.toBe('not_owned')
    }, 240_000)
  })
}
