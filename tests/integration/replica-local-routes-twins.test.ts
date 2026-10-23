/**
 * Local routes of a host replica (docs/plan/walnut-replica-servers-impl.md WP6),
 * on REAL daemon processes, both twins, with the real startServer booted in this
 * process as the host's replica:
 *
 *   stand-in Mac ==trusted WS==> daemon (source twin on node, standalone on bun)
 *     (counts every stream the     ^ follower WS (owner scoped, replica-reads-v1)
 *      follower opens to it)       |
 *                               startServer as `web --replica` (this process)
 *                                 public port <== the test, as a browser with a device token
 *
 * While the Mac answers: a host session's history is read on the host through
 * the follower link and opens NO stream to the Mac (a route that is the Mac's
 * opens one, so the counter is live); the history equals the leader's parse of
 * the same transcript; a file read outside the Walnut's session cwds is
 * not_found. While the Mac is away (its socket paused past LEADER_QUIET_MS):
 * the terminal answers needs_leader, and the notes tree of a generated
 * 13 MB, 3,000-note vault comes from the daemon's copy in under 1 s warm.
 *
 * Hygiene: every dir is a temp dir (the daemon's `~` included, through
 * WALNUT_HOME_OVERRIDE); the daemon and the placeholder server are ours and are
 * stopped by pid in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocket } from '#ws'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-local'))

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME = '/fixture/marina-home'
const WALNUT = 'a1b2c3d4e5f60718293a4b5c6d7e8f91'
const HOST_KEY = 'devbox'
const SID = 'cccccccc-1111-4111-8111-111111111111'
const OTHER_SID = 'dddddddd-2222-4222-8222-222222222222'
const TOKEN = 'marina-browser-token-' + 'z'.repeat(32)
const QUIET_MS = 1500
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sha256 = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const sha12 = (t: string) => sha256(t).slice(0, 12)
async function waitFor<T>(fn: () => T | Promise<T>, ms: number, label: string): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + label)
    await sleep(50)
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

/** Transcript lines (parentUuid chain) stamped as the CLI writes them, from second `from` on. */
function lines(cwd: string, rows: Array<Record<string, unknown>>, from = 0): string {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString()
  return rows.map((r, i) => JSON.stringify({ ...r, sessionId: SID, cwd, timestamp: at(from + i), version: '2.1.0' })).join('\n') + '\n'
}

/** A Claude Code transcript: a chain of user and assistant lines, and Writes of a file in the cwd's repository and of one outside the cwd. */
function transcript(cwd: string, edited: string): string {
  return lines(cwd, [
    { type: 'user', uuid: 'u-1', parentUuid: null, message: { role: 'user', content: 'Fix the build on the release branch' } },
    { type: 'assistant', uuid: 'a-1', parentUuid: 'u-1', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the failing step.' }] } },
    { type: 'user', uuid: 'u-2', parentUuid: 'a-1', message: { role: 'user', content: 'Caf\u00e9 \u2603 \u{1F330}: keep going' } },
    { type: 'assistant', uuid: 'a-2', parentUuid: 'u-2', message: { role: 'assistant', content: [{ type: 'text', text: 'Done: the build is green.' }] } },
    { type: 'assistant', uuid: 'a-3', parentUuid: 'a-2', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu-1', name: 'Write', input: { file_path: edited, content: 'edited by marina\n' } },
      { type: 'tool_use', id: 'tu-2', name: 'Write', input: { file_path: path.join(cwd, 'tracked.txt'), content: 'tracked v2 marina_symbol\n' } },
    ] } },
    { type: 'user', uuid: 'u-3', parentUuid: 'a-3', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-1', content: 'File created successfully' },
      { type: 'tool_result', tool_use_id: 'tu-2', content: 'File written successfully' },
    ] } },
  ])
}

/** A generated vault: `count` notes of about `bytes` in total, in folders of 100, each linking the next. */
function vault(count: number, bytes: number): Record<string, string> {
  const out: Record<string, string> = {}
  const filler = 'The release notes for the marina project, with the steps that ran and the ones that did not. '
  const per = Math.floor(bytes / count)
  for (let i = 0; i < count; i++) {
    const name = `Note ${String(i).padStart(4, '0')}`
    const head = `# ${name}\n\nSee [[Note ${String((i + 1) % count).padStart(4, '0')}]] #marina\n\n`
    out[`Area ${String(Math.floor(i / 100)).padStart(2, '0')}/${name}.md`] = head + filler.repeat(Math.max(1, Math.ceil((per - head.length) / filler.length))).slice(0, Math.max(0, per - head.length))
  }
  return out
}

interface Mac {
  ws: WebSocket
  beat: ReturnType<typeof setInterval>
  opened: number
  seen: string[]
  cmd(body: Record<string, unknown>): Promise<Record<string, any>>
  silence(): void
  door: http.Server
}

/** The stand-in Mac: the daemon's primary, its door for what the replica forwards, and a stream counter. */
async function linkMac(daemonPort: number): Promise<Mac> {
  const { createStreamEndpoint, spliceStream } = await import('../../src/lib/link-stream.js')
  const seen: string[] = []
  const door = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: 'mac', url: req.url }))
  })
  const doorPort = await new Promise<number>((r) => door.listen(0, '127.0.0.1', () => r((door.address() as net.AddressInfo).port)))
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}`)
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
  const pending = new Map<number, (m: Record<string, any>) => void>()
  const mac = { ws, opened: 0, seen, door } as unknown as Mac
  const streams = createStreamEndpoint({
    send: (frame) => ws.send(JSON.stringify(frame)),
    accept: (info) => {
      if (info.from !== 'follower') return null
      mac.opened++
      return (s) => spliceStream(s, net.connect(doorPort, '127.0.0.1'))
    },
  })
  ws.on('message', (data) => {
    let m: Record<string, any>
    try { m = JSON.parse(String(data)) } catch { return }
    if (streams.handle(m)) return
    const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
    if (p) { pending.delete(m.id); p(m) }
  })
  ws.on('close', () => streams.closeAll('closed'))
  let id = 1
  mac.cmd = (body) => new Promise((resolve, reject) => {
    const my = id++
    const t = setTimeout(() => { pending.delete(my); reject(new Error(`cmd ${body.cmd} timed out`)) }, 30_000)
    pending.set(my, (r) => { clearTimeout(t); resolve(r) })
    ws.send(JSON.stringify({ id: my, ...body }))
  })
  mac.beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 300)
  mac.silence = () => {
    clearInterval(mac.beat)
    ;(ws as unknown as { _socket: { pause(): void } })._socket.pause()
  }
  return mac
}

/** The Mac pushes its notes copy the way core/host-replica.ts does (manifest, then the bodies it lacks). */
async function pushNotes(mac: Mac, notes: Record<string, string>): Promise<void> {
  const entries = Object.entries(notes).map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body), m: { title: path.posix.basename(k, '.md'), updatedAt: '2026-10-01T00:00:00.000Z' } }))
  const synced = await mac.cmd({ cmd: 'replica.sync', home: HOME, kind: 'notes', entries, asOf: Date.now() })
  expect(synced.ok, JSON.stringify(synced).slice(0, 300)).toBe(true)
  let batch: Array<{ k: string; body: string }> = []
  let size = 0
  const flush = async () => {
    if (batch.length === 0) return
    const r = await mac.cmd({ cmd: 'replica.put', home: HOME, kind: 'notes', files: batch })
    expect(r.rejected).toBe(0)
    batch = []
    size = 0
  }
  for (const k of synced.need as string[]) {
    batch.push({ k, body: notes[k]! })
    size += notes[k]!.length
    if (size > 1024 * 1024) await flush()
  }
  await flush()
}

const pids = new Set<number>()
const ENV_KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER', 'WALNUT_WALNUT_ID', 'WALNUT_FOLLOWER_TOKEN', 'WALNUT_HOST_DAEMON_DIR',
  'OPEN_WALNUT_HOME', 'WALNUT_LEADER_HOME', 'WALNUT_HOST_KEY', 'WALNUT_HOST_LABEL', 'WALNUT_LEADER_QUIET_MS'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))

async function spawnDaemon(dir: string, twin: 'source' | 'standalone', fakeHome: string): Promise<{ port: number; pid: number }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir, WALNUT_STREAMS_DIR: path.join(dir, 'streams'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_REPLICA_DIR: path.join(dir, 'host-replica'), WALNUT_HOME_OVERRIDE: fakeHome, WALNUT_LEADER_QUIET_MS: String(QUIET_MS),
  }
  for (const k of ['VITEST', 'VITEST_MODE', 'VITEST_WORKER_ID', 'VITEST_POOL_ID', 'WALNUT_FOLLOWER_TOKEN', 'WALNUT_HOST_DAEMON_DIR', 'WALNUT_ROLE', 'WALNUT_HOST_SERVER']) delete env[k]
  const args = twin === 'source' ? [path.join(dir, 'daemon.cjs'), '--start'] : [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start']
  if (twin === 'source') fs.writeFileSync(args[0]!, (await import('../../src/providers/daemon-source.js')).getDaemonSource(), { mode: 0o755 })
  const proc = spawn(twin === 'source' ? process.execPath : BUN!, args, { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  pids.add(pid)
  return { port: parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10), pid }
}

async function get(port: number, p: string): Promise<{ status: number; headers: Headers; text: string; json: any; ms: number }> {
  const t0 = performance.now()
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${TOKEN}`, connection: 'close' } })
  const text = await r.text()
  const ms = performance.now() - t0
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, headers: r.headers, text, json, ms }
}

/** The devices copy, through the leader door (what the Mac's device round sends on a primary stream). */
async function pushDevices(door: { accept(sock: net.Socket): void }): Promise<void> {
  const server = net.createServer((sock) => door.accept(sock))
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port)))
  const devices = [{ id: 'd0011223344556677', name: 'marina-browser', tokenHash: sha256(TOKEN) }]
  const { deviceListHash } = await import('../../src/core/replication/device-replica.js')
  const r = await fetch(`http://127.0.0.1:${port}/bridge/replica`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ op: 'put', kind: 'devices', devices, hash: deviceListHash(devices) }),
  })
  expect(r.status, await r.text()).toBe(200)
  await new Promise<void>((r2) => server.close(() => r2()))
}

let base = ''
let walnutHome = ''
let cwdA = ''
let cwdB = ''
let editedFile = ''
const NOTES = vault(3000, 13 * 1024 * 1024)

beforeAll(async () => {
  // Real: git reports real paths, and macOS's tmpdir is behind a link.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wrl-')))
  walnutHome = (await import('../../src/constants.js')).WALNUT_HOME
  if (!process.env.WALNUT_DAEMON_DIR || process.env.WALNUT_DAEMON_DIR === '/tmp/open-walnut') throw new Error('REFUSING: the worker has no isolated WALNUT_DAEMON_DIR')
  // Two Walnuts' working dirs on this host: marina's (this replica's Walnut) and acme's.
  cwdA = path.join(base, 'marina')
  cwdB = path.join(base, 'acme')
  for (const d of [path.join(cwdA, 'src'), cwdB, path.join(base, 'elsewhere')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(cwdA, 'src', 'own.txt'), 'marina file\n')
  fs.writeFileSync(path.join(cwdB, 'secret.txt'), 'acme secret\n')
  // marina's cwd is a git repository with an uncommitted change (the git-base changes view), and the
  // session also wrote a file in another repository outside its cwd (its change list names it).
  fs.writeFileSync(path.join(cwdA, 'tracked.txt'), 'tracked v1\n')
  const elsewhere = path.join(base, 'elsewhere')
  fs.writeFileSync(path.join(elsewhere, 'README.md'), 'elsewhere\n')
  const genv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=marina', '-c', 'user.email=marina@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, env: genv })
  for (const repo of [cwdA, elsewhere]) {
    git(repo, 'init', '-q')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'one')
  }
  fs.writeFileSync(path.join(cwdA, 'tracked.txt'), 'tracked v2 marina_symbol\n')
  editedFile = path.join(elsewhere, 'edited.txt')
  fs.writeFileSync(editedFile, 'edited by marina\n')
  // The replica's session row for the marina session (what the sessions copy, WP4, brings): it runs on this host.
  const tracker = await import('../../src/core/session-tracker.js')
  await tracker.createSessionRecord(SID, 'mreplica-0001', 'Marina', cwdA, { host: HOST_KEY, title: 'Fix the build' })
}, 30_000)

afterAll(async () => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k] }
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
  for (const pid of pids) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  await sleep(300)
  for (const pid of pids) if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
}, 60_000)

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a host replica reads its own host's sessions, files and notes`, () => {
    let mac: Mac
    let port = 0
    let stop: (() => Promise<void>) | null = null

    beforeAll(async () => {
      const dir = path.join(base, twin.slice(0, 2))
      const fakeHome = path.join(base, `${twin}-home`)
      fs.mkdirSync(dir, { recursive: true })
      // The CLI's transcript of the marina session, where the CLI keeps it on this host.
      const { encodeProjectPath } = await import('../../src/core/session-file-reader.js')
      const projectDir = path.join(fakeHome, '.claude', 'projects', encodeProjectPath(cwdA))
      fs.mkdirSync(projectDir, { recursive: true })
      fs.writeFileSync(path.join(projectDir, `${SID}.jsonl`), transcript(cwdA, editedFile))
      // Who started what here: the marina session and one of another Walnut (the spawn journal).
      fs.writeFileSync(path.join(dir, 'spawn-journal.jsonl'), [
        JSON.stringify({ v: 1, sid: SID, at: '2026-10-01T10:00:00.000Z', kind: 'new', cwd: cwdA, home: HOME }),
        JSON.stringify({ v: 1, sid: OTHER_SID, at: '2026-10-01T10:00:00.000Z', kind: 'new', cwd: cwdB, home: '/fixture/acme-home' }),
      ].join('\n') + '\n')
      const d = await spawnDaemon(dir, twin, fakeHome)
      mac = await linkMac(d.port)
      expect((await mac.cmd({ cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: true })).ok).toBe(true)
      const slice = { v: 1, home: HOME, hash: 'h-local', asOf: Date.now(), host: HOST_KEY, sessions: [{ sid: SID, title: 'Fix the build' }], tasks: [], requests: [] }
      expect((await mac.cmd({ cmd: 'host.slice', slice })).ok).toBe(true)
      await pushNotes(mac, NOTES)
      const tokenFile = path.join(base, `${twin}-token`)
      const spec = {
        v: 1, home: HOME, walnutId: WALNUT, command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
        cwd: base, env: {}, log: path.join(base, `${twin}-placeholder.log`), port: 42_000 + (twin === 'source' ? 1 : 2),
        settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
      }
      expect((await mac.cmd({ cmd: 'server.configure', home: HOME, spec })).ok).toBe(true)
      const [token, placeholder] = (await waitFor(() => { try { return fs.readFileSync(tokenFile, 'utf8') } catch { return '' } }, 20_000, 'the token')).split(' ')
      pids.add(Number(placeholder))

      // This process becomes the host's replica (`web --replica`), following that daemon.
      Object.assign(process.env, {
        WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1', WALNUT_WALNUT_ID: WALNUT,
        WALNUT_FOLLOWER_TOKEN: token, WALNUT_HOST_DAEMON_DIR: dir, OPEN_WALNUT_HOME: walnutHome,
        WALNUT_LEADER_HOME: HOME, WALNUT_HOST_KEY: HOST_KEY, WALNUT_HOST_LABEL: HOST_KEY, WALNUT_LEADER_QUIET_MS: String(QUIET_MS),
      })
      ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
      // The env scrub reads the follower secrets once per process: this boot follows this twin's daemon.
      ;(await import('../../src/host-server/env.js'))._resetFollowerSecretsForTesting()
      const server = await import('../../src/web/server.js')
      const listening = await server.startServer({ port: 0, dev: true })
      stop = server.stopServer
      port = (listening.address() as net.AddressInfo).port
      await pushDevices(server.getHostReplicaLeaderDoor()!)
      const front = server.getHostReplicaFront()!
      await waitFor(() => front.route().kind === 'leader' && front.link.capabilities()?.includes('replica-reads-v1'), 30_000, 'the replica to follow a Mac that answers')
    }, 180_000)

    afterAll(async () => {
      try { await stop?.() } catch { /* already down */ }
      clearInterval(mac?.beat)
      try { mac?.ws.close() } catch { /* closed */ }
      await new Promise<void>((r) => (mac?.door ? mac.door.close(() => r()) : r()))
    }, 60_000)

    it('while the Mac answers: a host session\'s history is read here (no stream to the Mac) and equals the leader\'s parse', async () => {
      const { parseSessionMessages } = await import('../../src/core/session-history.js')
      const { encodeProjectPath } = await import('../../src/core/session-file-reader.js')
      const fakeHome = path.join(base, `${twin}-home`)
      const text = fs.readFileSync(path.join(fakeHome, '.claude', 'projects', encodeProjectPath(cwdA), `${SID}.jsonl`), 'utf8')
      const leaderView = parseSessionMessages(text).map((m) => ({ role: m.role, text: m.text }))
      expect(leaderView.length).toBeGreaterThanOrEqual(4)
      const opened = mac.opened
      const seen = mac.seen.length
      const h = await get(port, `/api/sessions/${SID}/history`)
      expect(h.status, h.text.slice(0, 300)).toBe(200)
      expect((h.json.messages as Array<{ role: string; text: string }>).map((m) => ({ role: m.role, text: m.text }))).toEqual(leaderView)
      expect(h.text).toContain('Caf\u00e9 \u2603 \u{1F330}')
      expect(mac.opened).toBe(opened)
      expect(mac.seen.length).toBe(seen)
      // A route that is the Mac's still goes there: the counter counts.
      const tasks = await get(port, '/api/tasks')
      expect(tasks.json).toMatchObject({ from: 'mac' })
      expect(mac.opened).toBe(opened + 1)
    })

    it('while the Mac answers: a file of this host is read here, inside the Walnut\'s session cwds only', async () => {
      const opened = mac.opened
      const own = await get(port, `/api/file-content?host=${HOST_KEY}&path=${encodeURIComponent(path.join(cwdA, 'src', 'own.txt'))}`)
      expect(own.status, own.text.slice(0, 300)).toBe(200)
      expect(own.text).toContain('marina file')
      // Another Walnut's file, and one outside every session here: what a missing file answers.
      const other = await get(port, `/api/file-content?host=${HOST_KEY}&path=${encodeURIComponent(path.join(cwdB, 'secret.txt'))}`)
      expect(other.text).not.toContain('acme secret')
      expect(other.status === 404 || other.json?.content === null, other.text.slice(0, 200)).toBe(true)
      const outside = await get(port, `/api/file-content?host=${HOST_KEY}&path=${encodeURIComponent('/etc/hosts')}`)
      expect(outside.status === 404 || outside.json?.content === null, outside.text.slice(0, 200)).toBe(true)
      expect(mac.opened).toBe(opened)
      // Another host's file is the Mac's.
      const elsewhere = await get(port, `/api/file-content?host=other-box&path=${encodeURIComponent('/x')}`)
      expect(elsewhere.json).toMatchObject({ from: 'mac' })
    })

    it('while the Mac answers: a file route with no host is the Mac\'s, whatever its sessionId names (never this disk)', async () => {
      const own = path.join(cwdA, 'src', 'own.txt')
      for (const p of [
        `/api/file-content?path=${encodeURIComponent(own)}&sessionId=${SID}`,
        `/api/files/list?path=${encodeURIComponent('/')}&sessionId=${SID}`,
        `/api/files/resolve-path?rel=src/own.txt&cwd=${encodeURIComponent(cwdA)}&sessionId=${SID}`,
        `/api/files/references?path=${encodeURIComponent(own)}&symbol=marina&sessionId=${SID}`,
        // The phone's twins of the same reads.
        `/api/v1/file-content?path=${encodeURIComponent(own)}&sessionId=${SID}`,
        `/api/v1/files/list?path=${encodeURIComponent('/')}&sessionId=${SID}`,
        `/api/v1/files/resolve-path?rel=src/own.txt&cwd=${encodeURIComponent(cwdA)}&sessionId=${SID}`,
      ]) {
        const opened = mac.opened
        const r = await get(port, p)
        expect(r.json, p).toMatchObject({ from: 'mac' })
        expect(mac.opened, p).toBe(opened + 1)
      }
    })

    it('while the Mac answers: the Files tree, path resolve, references and the git-base changes of this host answer here', async () => {
      const opened = mac.opened
      const list = await get(port, `/api/files/list?host=${HOST_KEY}&path=${encodeURIComponent(path.join(cwdA, 'src'))}`)
      expect(list.status, list.text.slice(0, 300)).toBe(200)
      expect(list.text).toContain('own.txt')
      const resolved = await get(port, `/api/files/resolve-path?host=${HOST_KEY}&rel=src/own.txt&cwd=${encodeURIComponent(cwdA)}&sessionId=${SID}`)
      expect(resolved.status, resolved.text.slice(0, 300)).toBe(200)
      expect(resolved.json).toMatchObject({ path: path.join(cwdA, 'src', 'own.txt'), resolved: true })
      const refs = await get(port, `/api/files/references?host=${HOST_KEY}&path=${encodeURIComponent(path.join(cwdA, 'tracked.txt'))}&symbol=marina_symbol`)
      expect(refs.status, refs.text.slice(0, 300)).toBe(200)
      expect((refs.json.matches as Array<{ file: string }>).map((m) => m.file)).toEqual([path.join(cwdA, 'tracked.txt')])
      // The repository the session wrote in, against its last commit (git.diff through the follower link).
      expect(mac.opened).toBe(opened)
      const changeReads = [`/api/sessions/${SID}/changes?base=uncommitted`, `/api/sessions/${SID}/changes`, `/api/sessions/${SID}/changes/file?path=${encodeURIComponent(editedFile)}`]
      const server = await import('../../src/web/server.js')
      if (!server.getHostReplicaFront()!.link.capabilities()?.includes('changes-v1')) {
        // A daemon without the host-local changes pipeline (a source deploy with no sidecar):
        // the changes view is the Mac's, as before WP6 (the reader path would miss edited.txt).
        for (const p of changeReads) expect((await get(port, p)).json, p).toMatchObject({ from: 'mac' })
        return
      }
      const diff = await get(port, changeReads[0]!)
      expect(diff.status, diff.text.slice(0, 300)).toBe(200)
      expect(diff.text).toContain('tracked.txt')
      expect(diff.text).toContain('tracked v2 marina_symbol')
      // A file the session wrote outside its cwd is that session's change, read by the daemon's pipeline.
      const changes = await get(port, changeReads[1]!)
      expect(changes.status, changes.text.slice(0, 300)).toBe(200)
      expect(changes.text).toContain('edited.txt')
      const one = await get(port, changeReads[2]!)
      expect(one.status, one.text.slice(0, 300)).toBe(200)
      expect(one.text).toContain('edited by marina')
      expect(mac.opened).toBe(opened)
    })

    it('while the Mac answers: a local history read plus the turn the Mac streams renders the timeline the Mac\'s own parse gives', async () => {
      const { parseSessionMessages } = await import('../../src/core/session-history.js')
      const { encodeProjectPath } = await import('../../src/core/session-file-reader.js')
      const { planDeltaMerge } = await import('../../web/src/hooks/history-merge.js')
      const file = path.join(base, `${twin}-home`, '.claude', 'projects', encodeProjectPath(cwdA), `${SID}.jsonl`)
      const opened = mac.opened
      // The console's first read: the full history, here.
      const full = await get(port, `/api/sessions/${SID}/history`)
      expect(full.status).toBe(200)
      const held = full.json.messages
      const cursor = full.json.cursor ?? full.json.total ?? held.length
      // A turn streams through the Mac (its WS carries the blocks); the CLI writes it to the transcript here.
      fs.appendFileSync(file, lines(cwdA, [
        { type: 'user', uuid: 'u-4', parentUuid: 'u-3', message: { role: 'user', content: 'Now tag the release \u00e9t\u00e9' } },
        { type: 'assistant', uuid: 'a-4', parentUuid: 'u-4', message: { role: 'assistant', content: [{ type: 'text', text: 'Tagged v2.4.0.' }] } },
      ], 20))
      // At the turn's end the console asks for what is new since its cursor, again here, and folds it in.
      const delta = await get(port, `/api/sessions/${SID}/history?since=${cursor}`)
      expect(delta.status, delta.text.slice(0, 300)).toBe(200)
      const plan = planDeltaMerge(held, delta.json, cursor)
      expect(plan.kind, JSON.stringify(plan).slice(0, 300)).toBe('merged')
      const shown = (plan as { messages: Array<{ role: string; text: string; msgId?: string }> }).messages
      // The Mac's history of the same session is its parse of the same transcript.
      const macView = parseSessionMessages(fs.readFileSync(file, 'utf8'))
      const key = (m: { role: string; text: string }) => ({ role: m.role, text: m.text })
      expect(shown.map(key)).toEqual(macView.map(key))
      // Folded by identity: no row twice.
      const ids = shown.map((m) => m.msgId).filter(Boolean)
      expect(new Set(ids).size).toBe(ids.length)
      expect(shown.map((m) => m.text)).toContain('Tagged v2.4.0.')
      expect(mac.opened).toBe(opened)
    })

    it('while the Mac is away: the terminal needs the Mac, and the notes come from the daemon\'s copy (3,000 notes, 13 MB: tree under 1 s warm)', async () => {
      const server = await import('../../src/web/server.js')
      const front = server.getHostReplicaFront()!
      // This host's session, read while the Mac answers (WP6's routes, through the daemon) ...
      const changesHere = front.link.capabilities()?.includes('changes-v1') === true
      const sessionReads = [`/api/sessions/${SID}/history`, `/api/v1/sessions/${SID}/history`, `/api/v1/sessions/${SID}/transcript`,
        ...(changesHere ? [`/api/sessions/${SID}/changes?base=uncommitted`, `/api/sessions/${SID}/changes`, `/api/sessions/${SID}/changes/file?path=${encodeURIComponent(editedFile)}`] : [])]
      const awake = new Map<string, string>()
      for (const p of sessionReads) {
        const r = await get(port, p)
        expect(r.status, `${p}: ${r.text.slice(0, 200)}`).toBe(200)
        expect(r.json, p).not.toMatchObject({ from: 'mac' })
        awake.set(p, r.text)
      }
      mac.silence()
      await waitFor(() => front.route().kind === 'alone', 20_000, 'the replica to call the Mac away')
      expect(front.rpcGate('terminal:open')).toBe('needs_leader: terminal_needs_mac')
      // ... answers the same while the Mac is away: the same routes, the same JSON, never the stream-file fallback.
      for (const [p, text] of awake) {
        const r = await get(port, p)
        expect(r.status, `${p}: ${r.text.slice(0, 200)}`).toBe(200)
        // The transcript's export stamp is the time of the answer.
        const same = (t: string) => { const j = JSON.parse(t); delete j.exportedAt; return j }
        expect(same(r.text), p).toEqual(same(text))
      }
      const history = JSON.parse(awake.get(`/api/sessions/${SID}/history`)!)
      expect(history.windowed).toBeUndefined()
      expect((history.messages as Array<{ text: string }>).map((m) => m.text)).toContain('Tagged v2.4.0.')
      // A file with no host (the Mac's) or of another host needs the Mac; never this disk.
      const own = path.join(cwdA, 'src', 'own.txt')
      for (const p of [`/api/file-content?path=${encodeURIComponent(own)}&sessionId=${SID}`, `/api/files/list?path=${encodeURIComponent(cwdA)}`, `/api/file-content?host=other-box&path=${encodeURIComponent(own)}`,
        `/api/v1/file-content?path=${encodeURIComponent(own)}`, `/api/v1/files/list?path=${encodeURIComponent(cwdA)}`, `/api/v1/file-raw/local${own.split('/').map(encodeURIComponent).join('/')}`]) {
        const r = await get(port, p)
        expect(r.status, p).toBe(503)
        expect(r.text, p).toContain('needs_leader')
        expect(r.text, p).not.toContain('marina file')
      }
      // This host's file is still read here, through the daemon.
      const here = await get(port, `/api/file-content?host=${HOST_KEY}&path=${encodeURIComponent(own)}`)
      expect(here.status, here.text.slice(0, 200)).toBe(200)
      expect(here.text).toContain('marina file')
      const hereV1 = await get(port, `/api/v1/file-content?host=${HOST_KEY}&path=${encodeURIComponent(own)}`)
      expect(hereV1.status, hereV1.text.slice(0, 200)).toBe(200)
      expect(hereV1.text).toContain('marina file')
      const cold = await get(port, '/api/notes-v2')
      expect(cold.status, cold.text.slice(0, 300)).toBe(200)
      expect(cold.headers.get('x-walnut-offline')).toBeTruthy()
      const countNotes = (nodes: Array<{ type: string; children?: unknown[] }>): number =>
        nodes.reduce((n, x) => n + (x.type === 'folder' ? countNotes(x.children as never) : 1), 0)
      expect(countNotes(cold.json.tree)).toBe(3000)
      const warm: number[] = []
      for (let i = 0; i < 5; i++) {
        await sleep(i === 2 ? 2_100 : 0) // one run after the manifest window: a list call, the same hash
        const r = await get(port, '/api/notes-v2')
        expect(r.text).toBe(cold.text)
        warm.push(r.ms)
      }
      const bytes = Object.values(NOTES).reduce((n, b) => n + Buffer.byteLength(b), 0)
      console.log(JSON.stringify({ probe: 'replica notes tree', twin, notes: 3000, bytes, coldMs: Math.round(cold.ms), warmMs: warm.map((m) => Math.round(m)), treeBytes: cold.text.length }))
      expect(bytes).toBeGreaterThan(13 * 1000 * 1000)
      expect(Math.max(...warm)).toBeLessThan(1000)
      // A body, byte for byte, and the v1 shape of the same read.
      const key = 'Area 07/Note 0712.md'
      const body = await get(port, `/api/notes-v2/content/${encodeURIComponent(key.replace(/\.md$/, ''))}`)
      expect(body.json).toMatchObject({ content: NOTES[key], contentHash: sha12(NOTES[key]!) })
      const v1 = await get(port, `/api/v1/notes/content/${encodeURIComponent(key.replace(/\.md$/, ''))}`)
      expect(v1.json).toMatchObject({ content: NOTES[key], contentHash: sha12(NOTES[key]!) })
      // The first index read builds it from the whole copy (4 MB answers), never holding the loop long.
      let lagMax = 0
      let last = performance.now()
      const probe = setInterval(() => { const t = performance.now(); lagMax = Math.max(lagMax, t - last - 10); last = t }, 10)
      const back = await get(port, `/api/notes-v2/backlinks/${encodeURIComponent('Area 07/Note 0712')}`)
      clearInterval(probe)
      expect((back.json.backlinks as Array<{ path: string }>).map((b) => b.path)).toEqual(['Area 07/Note 0711.md'])
      const warmBack = await get(port, `/api/notes-v2/backlinks/${encodeURIComponent('Area 07/Note 0712')}`)
      console.log(JSON.stringify({ probe: 'replica notes index', twin, coldBacklinksMs: Math.round(back.ms), warmBacklinksMs: Math.round(warmBack.ms), loopLagMaxMs: Math.round(lagMax) }))
      expect(lagMax).toBeLessThan(300)
      // Warm: one pass over the parsed links, names looked up in a per-manifest map.
      expect(warmBack.ms).toBeLessThan(250)
      const tags = await get(port, '/api/notes-v2/tags')
      expect(tags.json.tags).toEqual([{ tag: 'marina', count: 3000 }])
      // A write is still the Mac's.
      const put = await fetch(`http://127.0.0.1:${port}/api/notes-v2/content/x`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x' }) })
      expect(put.status).toBe(503)
    }, 120_000)
  })
}
