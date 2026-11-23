/**
 * A session the host's own server started is its Walnut's, after any restart of the daemon,
 * on REAL daemon processes, both twins (2026-11-23 release rehearsal: a host-judged session's
 * next turn after a restart of the host's service never reached the leader).
 *
 *   leader A (marina) ==trusted WS==>+-- daemon (source twin on node, standalone on bun)
 *   follower of A     ==follower WS=>+    runs the server A configured, on data dir D
 *
 * The host's server starts its own sessions naming its data dir D as their home (origin.home is
 * its OPEN_WALNUT_HOME), so the spawn journal says D; its follower link says A's leader home.
 * Before the fix the daemon took D for another Walnut: after a restart, the follower's read of
 * its own session's stream file answered "no such file", its status not_found, and the host's
 * runner fell back to a guess that swallowed the next turn's result. Now a data dir of a server
 * this daemon runs (its spec, read again at boot) names that server's Walnut. A session whose
 * home is no such dir stays another Walnut's (the control).
 *
 * Hygiene: every dir is a temp dir; the daemons, the placeholder server and the mock CLIs are
 * ours and are stopped by pid in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME_A = '/fixture/marina-home'
const WALNUT_A = 'wmarinahost01'
const OWN = 'aaaaaaaa-1a1a-4a1a-8a1a-1a1a1a1a1a1a'
const OTHER = 'cccccccc-2c2c-4c2c-8c2c-2c2c2c2c2c2c'
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

let base = ''
const pids = new Set<number>()
const sockets: WebSocket[] = []

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

async function spawnDaemon(dir: string, twin: 'source' | 'standalone'): Promise<{ port: number; pid: number }> {
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
  const args = twin === 'source' ? [path.join(dir, 'daemon.cjs'), '--start'] : [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start']
  if (twin === 'source') fs.writeFileSync(args[0]!, getDaemonSource(), { mode: 0o755 })
  const proc = spawn(twin === 'source' ? SOURCE_TWIN.file : BUN!, args, { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  pids.add(pid)
  return { port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hso-')))
})

afterAll(async () => {
  for (const ws of sockets) { try { ws.close() } catch { /* closed */ } }
  for (const pid of pids) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  await sleep(300)
  for (const pid of pids) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: the host's own server's session stays its Walnut's across a restart`, () => {
    it('the follower of A reads the stream and status of a session started with its data dir as home, before and after a daemon restart; another home stays not_found', async () => {
      const dir = path.join(base, twin.slice(0, 2))
      const data = path.join(base, `${twin}-walnuts`, WALNUT_A, 'data')
      const cwd = path.join(base, `${twin}-work`)
      fs.mkdirSync(cwd, { recursive: true })
      const mock = path.join(base, 'mock-cli.cjs')
      fs.writeFileSync(mock, MOCK_CLI)
      let d = await spawnDaemon(dir, twin)

      const leader = await connect(d.port)
      expect((await cmd(leader, { cmd: 'leader.configure', home: HOME_A, walnutId: WALNUT_A, backup: true })).ok).toBe(true)
      // The server A's daemon runs for it, on its own data dir D (OPEN_WALNUT_HOME), hands over its token.
      const tokenFile = path.join(base, `${twin}-token`)
      const spec = {
        v: 1, home: HOME_A, walnutId: WALNUT_A, command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
        cwd: base, env: { OPEN_WALNUT_HOME: data }, log: path.join(base, `${twin}-placeholder.log`), port: 41_100 + (twin === 'source' ? 7 : 8),
        settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
      }
      expect((await cmd(leader, { cmd: 'server.configure', home: HOME_A, spec })).ok).toBe(true)
      const [token, placeholder] = (await waitFor(() => { try { return fs.readFileSync(tokenFile, 'utf8') } catch { return '' } }, 20_000, 'the token')).split(' ')
      pids.add(Number(placeholder))

      // Started as the host's own server starts its sessions (origin.home is its data dir), and the control.
      for (const [sid, home] of [[OWN, data], [OTHER, '/fixture/acme-data']] as const) {
        const started = await cmd(leader, { cmd: 'start', sid, cwd, message: 'init', args: [process.execPath, mock, sid], origin: { home, task: 'mwtask-0001' } })
        expect(started.ok, JSON.stringify(started)).toBe(true)
        await waitFor(() => { try { return fs.readFileSync(path.join(dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
        const st = await cmd(leader, { cmd: 'status', sid })
        if (typeof st.pid === 'number') pids.add(st.pid)
      }
      const journal = fs.readFileSync(path.join(dir, 'spawn-journal.jsonl'), 'utf8')
      expect(journal, 'the journal keeps the home as it was asked').toContain(JSON.stringify(data))

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

      // The host's service restarts: a new daemon on the same dirs, the spec file read again at boot.
      leader.close()
      process.kill(d.pid, 'SIGTERM')
      await waitFor(() => !alive(d.pid), 20_000, 'the daemon to stop')
      d = await spawnDaemon(dir, twin)
      judge(await reads(d.port), 'after the restart')
    }, 180_000)
  })
}
