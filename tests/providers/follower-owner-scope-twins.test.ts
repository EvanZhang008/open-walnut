/**
 * Owner scope on a follower socket (docs/plan/walnut-replica-servers-impl.md WP6,
 * scenario R18 "another Walnut on the host"), on REAL daemon processes, both twins.
 *
 *   leader A (marina) ==trusted WS==>+
 *   leader B (acme)   ==trusted WS==>+-- daemon (source twin on node, standalone on bun)
 *   follower of A     ==follower WS=>+    runs one mock session for each Walnut
 *
 * Two Walnuts share one host. The follower of A (the replica server A's daemon
 * started) reads A's sessions, files and copy, and gets `not_found` for every
 * session, file and copy entry of B: attach, status, list rows, markers,
 * history, changes, fs/git reads outside A's session cwds, and replica reads.
 * The leaders' own answers are unchanged (status keeps its argv, list keeps
 * every row). Before WP6 the daemon answered B's status, list row, attach and
 * markers to A's follower: this file was red on that daemon (notes of WP6).
 *
 * Hygiene: every dir is a temp dir; the daemon, the placeholder server and the
 * mock CLIs are ours and are stopped by pid in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const HOME_A = '/fixture/marina-home'
const HOME_B = '/fixture/acme-home'
const WALNUT_A = 'wmarinahost01'
const WALNUT_B = 'wacmehost0001'
const SA = 'aaaaaaaa-0a0a-4a0a-8a0a-0a0a0a0a0a0a'
const SB = 'bbbbbbbb-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
/** A note path and body with non-ASCII text (\u escapes: the repo keeps sources ASCII). */
const UNI_KEY = 'Journal/\u00e9t\u00e9 \u6e2c\u8a66.md'
const UNI_BODY = '# \u00c9t\u00e9\n\nCaf\u00e9 \u2603 \u{1F330}\r\nline two\n'

const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))

/** A Claude CLI stand-in: init, idle, and gone with its stdin. */
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
const sha12 = (body: string) => crypto.createHash('sha256').update(body).digest('hex').slice(0, 12)

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

async function spawnDaemon(dir: string, twin: 'source' | 'standalone', extraEnv: Record<string, string> = {}): Promise<{ port: number; pid: number }> {
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_REPLICA_DIR: path.join(dir, 'host-replica'),
    // The daemon's `~` is a temp dir too: its follower scope looks at ~/.claude and the Walnut dirs there.
    WALNUT_HOME_OVERRIDE: path.join(dir, 'home'),
    ...extraEnv,
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  const args = twin === 'source' ? [path.join(dir, 'daemon.cjs'), '--start'] : [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start']
  if (twin === 'source') fs.writeFileSync(args[0]!, getDaemonSource(), { mode: 0o755 })
  const proc = spawn(twin === 'source' ? process.execPath : BUN!, args, { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: ROOT })
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const portFile = path.join(dir, 'daemon.port')
  await waitFor(() => fs.existsSync(portFile) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  pids.add(pid)
  return { port: parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10), pid }
}

/** A Walnut that leads this host: its link, its slice, its notes copy and its pictures, and one session in `cwd`. */
async function linkLeader(port: number, o: { home: string; walnut: string; sid: string; cwd: string; notes: Record<string, string>; pictures?: Record<string, Buffer>; mock: string }): Promise<WebSocket> {
  const ws = await connect(port)
  const beat = setInterval(() => { try { ws.send(JSON.stringify({ id: 0, cmd: 'ping' })) } catch { /* closed */ } }, 500)
  ws.on('close', () => clearInterval(beat))
  expect((await cmd(ws, { cmd: 'leader.configure', home: o.home, walnutId: o.walnut, backup: true })).ok).toBe(true)
  const slice = { v: 1, home: o.home, hash: 'h-' + o.walnut, asOf: Date.now(), host: 'devbox', sessions: [{ sid: o.sid, title: 'Session of ' + o.walnut }], tasks: [], requests: [] }
  expect((await cmd(ws, { cmd: 'host.slice', slice })).ok).toBe(true)
  const entries = Object.entries(o.notes).map(([k, body]) => ({ k, h: sha12(body), n: Buffer.byteLength(body), m: { title: path.posix.basename(k, '.md'), updatedAt: '2026-10-01T00:00:00.000Z' } }))
  const synced = await cmd(ws, { cmd: 'replica.sync', home: o.home, kind: 'notes', entries, asOf: Date.now() })
  expect(synced.need).toHaveLength(entries.length)
  const put = await cmd(ws, { cmd: 'replica.put', home: o.home, kind: 'notes', files: Object.entries(o.notes).map(([k, body]) => ({ k, body })) })
  expect(put).toMatchObject({ ok: true, stored: entries.length, rejected: 0 })
  // Its copy of the notes' pictures (attachment-copy-v1), in 2 MB chunks as the Mac sends them.
  const pictures = Object.entries(o.pictures ?? {})
  if (pictures.length > 0) {
    const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
    const want = await cmd(ws, { cmd: 'attachments.sync', home: o.home, entries: pictures.map(([k, b]) => ({ k, h: sha256(b), n: b.length })), asOf: Date.now() })
    expect(want.need, JSON.stringify(want)).toHaveLength(pictures.length)
    for (const [k, b] of pictures) {
      for (let off = 0; ; off += 2 * 1024 * 1024) {
        const r = await cmd(ws, { cmd: 'attachments.put', home: o.home, k, h: sha256(b), offset: off, data: b.subarray(off, off + 2 * 1024 * 1024).toString('base64') })
        expect(r.ok, JSON.stringify(r)).toBe(true)
        if (r.stored === true) break
      }
    }
  }
  const started = await cmd(ws, { cmd: 'start', sid: o.sid, cwd: o.cwd, message: 'init', args: [process.execPath, o.mock, o.sid], origin: { home: o.home } })
  expect(started.ok, JSON.stringify(started)).toBe(true)
  return ws
}

beforeAll(() => {
  // Real: git reports real paths, and macOS's tmpdir is behind a link.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fos-')))
})

afterAll(async () => {
  for (const ws of sockets) { try { ws.close() } catch { /* closed */ } }
  for (const pid of pids) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } } }
  await sleep(300)
  for (const pid of pids) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

const notFound = (r: Record<string, any>) => r.ok === false && r.errorKind === 'not_found'

/** The follower of A: the server A's daemon runs for it hands over its token (a placeholder program here). */
async function followerOfA(port: number, leaderA: WebSocket, tag: string, serverPort: number): Promise<WebSocket> {
  const tokenFile = path.join(base, `${tag}-token`)
  const spec = {
    v: 1, home: HOME_A, walnutId: WALNUT_A, command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
    cwd: base, env: {}, log: path.join(base, `${tag}-placeholder.log`), port: serverPort,
    settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
  }
  expect((await cmd(leaderA, { cmd: 'server.configure', home: HOME_A, spec })).ok).toBe(true)
  const [token, placeholder] = (await waitFor(() => { try { return fs.readFileSync(tokenFile, 'utf8') } catch { return '' } }, 20_000, 'the token')).split(' ')
  pids.add(Number(placeholder))
  const follower = await connect(port)
  const hi = await cmd(follower, { cmd: 'follower.hello', walnutId: WALNUT_A, home: HOME_A, token })
  expect(hi.ok, JSON.stringify(hi)).toBe(true)
  return follower
}

/** git in a test repo, with no GIT_* of the caller (a hook's GIT_DIR outranks cwd). */
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))
  return execFileSync('git', ['-c', 'user.name=marina', '-c', 'user.email=marina@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' })
}

function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p) } }
  try { walk(dir) } catch { /* none */ }
  return out
}

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a follower reads its own Walnut only`, () => {
    it('answers A\'s follower for A and not_found for every session, file and copy entry of B; the leaders see what they saw', async () => {
      const dir = path.join(base, twin.slice(0, 2))
      const cwdA = path.join(base, `${twin}-marina`)
      const cwdB = path.join(base, `${twin}-acme`)
      for (const d of [cwdA, cwdB]) fs.mkdirSync(path.join(d, 'src'), { recursive: true })
      fs.writeFileSync(path.join(cwdA, 'src', 'own.txt'), 'marina file\n')
      fs.writeFileSync(path.join(cwdB, 'src', 'secret.txt'), 'acme secret\n')
      // A link inside A's tree that points into B's: following it is still B's.
      fs.symlinkSync(cwdB, path.join(cwdA, 'escape'))
      const mock = path.join(base, 'mock-cli.cjs')
      fs.writeFileSync(mock, MOCK_CLI)
      const d = await spawnDaemon(dir, twin)

      // A's picture is over one 2 MB chunk: it crosses the daemon link as two frames of base64.
      const scanA = crypto.randomBytes(2 * 1024 * 1024 + 99)
      const leaderA = await linkLeader(d.port, { home: HOME_A, walnut: WALNUT_A, sid: SA, cwd: cwdA, mock, notes: { 'Alpha.md': '# Alpha\n\nsee [[Beta]]\n', [UNI_KEY]: UNI_BODY }, pictures: { 'Alpha/_attachment/scan.png': scanA } })
      const leaderB = await linkLeader(d.port, { home: HOME_B, walnut: WALNUT_B, sid: SB, cwd: cwdB, mock, notes: { 'Secret.md': '# Secret of acme\n' }, pictures: { 'Secret/_attachment/plan.png': Buffer.from('acme plan') } })
      for (const sid of [SA, SB]) {
        await waitFor(() => { try { return fs.readFileSync(path.join(dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
        const st = await cmd(leaderA, { cmd: 'status', sid })
        if (typeof st.pid === 'number') pids.add(st.pid)
      }

      // The server A's daemon runs for it hands over its token; this test speaks as that follower.
      const tokenFile = path.join(base, `${twin}-token`)
      const spec = {
        v: 1, home: HOME_A, walnutId: WALNUT_A, command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(tokenFile)}, process.env.WALNUT_FOLLOWER_TOKEN + ' ' + process.pid); setInterval(() => {}, 1 << 30)`],
        cwd: base, env: {}, log: path.join(base, `${twin}-placeholder.log`), port: 41_000 + (twin === 'source' ? 7 : 8),
        settings: { expose: { enabled: false, definition: null, options: {} }, exposeRetry: 0 },
      }
      expect((await cmd(leaderA, { cmd: 'server.configure', home: HOME_A, spec })).ok).toBe(true)
      const [token, placeholder] = (await waitFor(() => { try { return fs.readFileSync(tokenFile, 'utf8') } catch { return '' } }, 20_000, 'the token')).split(' ')
      pids.add(Number(placeholder))
      const follower = await connect(d.port)
      const heard: Array<Record<string, any>> = []
      follower.on('message', (data) => { try { const m = JSON.parse(String(data)); if (m.ev) heard.push(m) } catch { /* not json */ } })
      const hello = await cmd(follower, { cmd: 'hello' })
      const hi = await cmd(follower, { cmd: 'follower.hello', walnutId: WALNUT_A, home: HOME_A, token })
      expect(hi.ok, JSON.stringify(hi)).toBe(true)

      // The hole WP6 closes: B's session, read through A's follower.
      expect(await cmd(follower, { cmd: 'status', sid: SB })).toMatchObject({ ok: false, errorKind: 'not_found' })
      const rows = (await cmd(follower, { cmd: 'list' })).sessions as Array<{ sid: string }>
      expect(rows.map((r) => r.sid)).toContain(SA)
      expect(rows.map((r) => r.sid)).not.toContain(SB)
      for (const c of [
        { cmd: 'attach', sid: SB },
        { cmd: 'markers.find', sid: SB, ids: ['m-1'] },
        { cmd: 'read-history', sid: SB },
        { cmd: 'changes.compute', sid: SB },
        { cmd: 'changes.file', sid: SB, path: path.join(cwdB, 'src', 'secret.txt') },
      ]) expect(notFound(await cmd(follower, c)), JSON.stringify(c)).toBe(true)
      // Its own session: status without the argv a leader may ask for, attach, markers, history.
      const own = await cmd(follower, { cmd: 'status', sid: SA, includeArgs: true })
      expect(own).toMatchObject({ ok: true, exists: true })
      expect(own.args).toBeUndefined()
      expect((await cmd(follower, { cmd: 'attach', sid: SA, fromOffset: 0 })).ok).toBe(true)
      expect((await cmd(follower, { cmd: 'markers.find', sid: SA, ids: ['m-1'] })).ok).toBe(true)
      expect((await cmd(follower, { cmd: 'read-history', sid: SA })).ok).toBe(true)

      // Files: inside A's session cwds only (a `..` or a link out of it is B's).
      const secret = path.join(cwdB, 'src', 'secret.txt')
      for (const c of [
        { cmd: 'fs.read', path: secret },
        { cmd: 'fs.read', path: path.join(cwdA, '..', path.basename(cwdB), 'src', 'secret.txt') },
        { cmd: 'fs.read', path: path.join(cwdA, 'escape', 'src', 'secret.txt') },
        { cmd: 'fs.readRange', path: secret, start: 0, length: 10 },
        { cmd: 'fs.ls', path: cwdB },
        { cmd: 'fs.ls', path: '/' },
        { cmd: 'fs.read', path: '~/walnut-fixture-not-there.txt' },
        { cmd: 'fs.resolvePath', ref: 'src/secret.txt', cwd: cwdB },
        { cmd: 'fs.grep', file: secret, symbol: 'acme' },
        { cmd: 'git.fileLog', cwd: cwdB, path: secret },
        { cmd: 'git.fileShow', cwd: cwdA, path: secret, sha: 'a'.repeat(40) },
      ]) expect(notFound(await cmd(follower, c)), JSON.stringify(c)).toBe(true)
      // A stat out of scope is the daemon's answer for a missing file; a diff, its answer for no repository.
      expect(await cmd(follower, { cmd: 'fs.stat', path: secret })).toMatchObject({ ok: true, exists: false })
      expect(await cmd(follower, { cmd: 'git.diff', cwd: cwdB, base: 'uncommitted' })).toEqual(expect.objectContaining({ ok: true, repoRoot: null, files: [] }))
      const read = await cmd(follower, { cmd: 'fs.read', path: path.join(cwdA, 'src', 'own.txt') })
      expect(read.ok, JSON.stringify(read)).toBe(true)
      expect(read.encoding === 'base64' ? Buffer.from(read.data, 'base64').toString() : read.data).toBe('marina file\n')
      expect((await cmd(follower, { cmd: 'fs.ls', path: path.join(cwdA, 'src') })).ok).toBe(true)
      expect((await cmd(follower, { cmd: 'fs.stat', path: path.join(cwdA, 'src', 'own.txt') })).ok).toBe(true)
      expect((await cmd(follower, { cmd: 'git.diff', cwd: cwdA, base: 'uncommitted' })).errorKind).not.toBe('not_found')
      // Writes stay the leader's.
      for (const c of ['fs.write', 'fs.mkdir', 'git.commitStart', 'start', 'send']) {
        expect((await cmd(follower, { cmd: c, path: path.join(cwdA, 'x'), sid: SA })).errorKind).toBe('follower_refused')
      }

      // The host copy: A's notes, whatever home the follower names.
      const list = await cmd(follower, { cmd: 'replica.list', kind: 'notes', home: HOME_B })
      expect(list.ok, JSON.stringify(list)).toBe(true)
      expect((list.entries as Array<{ k: string }>).map((e) => e.k).sort()).toEqual(['Alpha.md', UNI_KEY].sort())
      expect(list.manifestHash).toMatch(/^[0-9a-f]{12,}$/)
      expect(notFound(await cmd(follower, { cmd: 'replica.read', kind: 'notes', key: 'Secret.md' }))).toBe(true)
      expect(notFound(await cmd(follower, { cmd: 'replica.read', kind: 'notes', key: 'Secret.md', home: HOME_B }))).toBe(true)
      const uni = await cmd(follower, { cmd: 'replica.read', kind: 'notes', key: UNI_KEY })
      expect(uni).toMatchObject({ ok: true, k: UNI_KEY, body: UNI_BODY, h: sha12(UNI_BODY) })
      const many = await cmd(follower, { cmd: 'replica.readMany', kind: 'notes', keys: ['Alpha.md', 'Secret.md', UNI_KEY] })
      expect((many.files as Array<{ k: string }>).map((f) => f.k).sort()).toEqual(['Alpha.md', UNI_KEY].sort())
      expect(many.missing).toEqual(['Secret.md'])
      expect((await cmd(follower, { cmd: 'replica.list', kind: 'secrets' })).ok).toBe(false)

      // The copy of the pictures: A's, whatever home the follower names; B's is not_found.
      const pics = await cmd(follower, { cmd: 'attachments.list', home: HOME_B })
      expect(pics, JSON.stringify(pics)).toMatchObject({ ok: true, keys: ['Alpha/_attachment/scan.png'], next: null })
      expect(pics.asOf).toMatch(/^20\d\d-/)
      const slices: Buffer[] = []
      for (let off = 0; off < scanA.length;) {
        const r = await cmd(follower, { cmd: 'attachments.read', key: 'Alpha/_attachment/scan.png', offset: off })
        expect(r.ok, JSON.stringify(r).slice(0, 300)).toBe(true)
        const data = Buffer.from(String(r.data), 'base64')
        expect(data.length).toBeLessThanOrEqual(2 * 1024 * 1024)
        slices.push(data)
        off += data.length
      }
      expect(Buffer.concat(slices).equals(scanA)).toBe(true)
      expect(notFound(await cmd(follower, { cmd: 'attachments.read', key: 'Secret/_attachment/plan.png', offset: 0, home: HOME_B }))).toBe(true)
      // Only a leader fills or removes it.
      for (const c of ['attachments.sync', 'attachments.put', 'attachments.drop', 'attachments.status']) {
        expect((await cmd(follower, { cmd: c, home: HOME_A, entries: [] })).errorKind).toBe('follower_refused')
      }
      expect(await cmd(leaderB, { cmd: 'attachments.status', home: HOME_B })).toMatchObject({ ok: true, entries: 1, pending: 0 })
      expect(hello.capabilities).toContain('attachment-copy-v1')

      // The leaders: unchanged answers (status keeps the argv a fork asks for, list keeps every row).
      const leaderStatus = await cmd(leaderB, { cmd: 'status', sid: SB, includeArgs: true })
      expect(leaderStatus).toMatchObject({ ok: true, exists: true })
      expect(Array.isArray(leaderStatus.args)).toBe(true)
      const all = ((await cmd(leaderA, { cmd: 'list' })).sessions as Array<{ sid: string }>).map((r) => r.sid)
      expect(all).toEqual(expect.arrayContaining([SA, SB]))
      expect((await cmd(leaderA, { cmd: 'fs.read', path: secret })).ok).toBe(true)
      // replica.* reads are the follower's: a leader names its home with replica.status, as before.
      expect((await cmd(leaderA, { cmd: 'replica.status', home: HOME_A })).kinds.notes.entries).toBe(2)
      expect(hello.capabilities).toContain('replica-reads-v1')

      for (const sid of [SA, SB]) await cmd(sid === SA ? leaderA : leaderB, { cmd: 'stop', sid, reason: 'user', home: sid === SA ? HOME_A : HOME_B })
      // Session broadcasts: the follower hears its own Walnut's session end, never the other's.
      await waitFor(() => heard.some((e) => e.ev === 'session_state' && e.sid === SA), 15_000, 'A\'s session_state')
      await sleep(500)
      expect(heard.filter((e) => e.sid === SB)).toEqual([])
      await cmd(leaderA, { cmd: 'server.configure', home: HOME_A, spec: null })
    }, 180_000)

    it('a session of A in the home dir, B deeper in the same repository: B\'s files, transcript, the CLI history and the daemon\'s copies stay B\'s', async () => {
      // The daemon's `~` is a temp home, and its own dir lives inside it (as ~/.cache would).
      const fakeHome = path.join(base, `${twin}-home2`)
      const dir = path.join(fakeHome, '.cache', 'wd')
      const repo = path.join(fakeHome, 'code', 'repo')
      const cwdB = path.join(repo, 'acme')
      const projects = path.join(fakeHome, '.claude', 'projects', '-code-repo')
      for (const d of [cwdB, projects]) fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(repo, 'marina.txt'), 'marina v1 shared_symbol\n')
      fs.writeFileSync(path.join(cwdB, 'secret.txt'), 'acme v1 shared_symbol\n')
      git(repo, 'init', '-q')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'one')
      const sha = git(repo, 'rev-parse', 'HEAD').trim()
      fs.writeFileSync(path.join(repo, 'marina.txt'), 'marina v2 shared_symbol\n')
      fs.writeFileSync(path.join(cwdB, 'secret.txt'), 'acme v2 shared_symbol\n')
      fs.writeFileSync(path.join(projects, `${SA}.jsonl`), '{"type":"user","marina":1}\n')
      fs.writeFileSync(path.join(projects, `${SB}.jsonl`), '{"type":"user","acme":1}\n')
      fs.writeFileSync(path.join(fakeHome, '.claude', 'history.jsonl'), '{"display":"acme prompt"}\n')
      const mock = path.join(base, 'mock-cli.cjs')
      fs.writeFileSync(mock, MOCK_CLI)
      const d = await spawnDaemon(dir, twin, { WALNUT_HOME_OVERRIDE: fakeHome })
      const leaderA = await linkLeader(d.port, { home: HOME_A, walnut: WALNUT_A, sid: SA, cwd: fakeHome, mock, notes: { 'Alpha.md': '# Alpha\n' } })
      const leaderB = await linkLeader(d.port, { home: HOME_B, walnut: WALNUT_B, sid: SB, cwd: cwdB, mock, notes: { 'Secret.md': '# Secret of acme\n' } })
      for (const sid of [SA, SB]) {
        await waitFor(() => { try { return fs.readFileSync(path.join(dir, 'streams', `${sid}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 30_000, `${sid} idle`)
        const st = await cmd(leaderA, { cmd: 'status', sid })
        if (typeof st.pid === 'number') pids.add(st.pid)
      }
      const follower = await followerOfA(d.port, leaderA, `${twin}-2`, 41_100 + (twin === 'source' ? 7 : 8))
      const text = (r: Record<string, any>) => (r.encoding === 'base64' ? Buffer.from(r.data, 'base64').toString() : r.data)

      // Under A's home-dir cwd, ordinary files are A's; A's own transcript too.
      expect(text(await cmd(follower, { cmd: 'fs.read', path: path.join(repo, 'marina.txt') }))).toBe('marina v2 shared_symbol\n')
      expect((await cmd(follower, { cmd: 'fs.read', path: path.join(projects, `${SA}.jsonl`) })).ok).toBe(true)
      // B's transcript, the CLI's prompt history, and every file of the daemon's own dir (B's notes copy among them) are not.
      const daemonFiles = filesUnder(dir).filter((f) => !f.endsWith('.pipe'))
      expect(daemonFiles.some((f) => f.includes('host-replica'))).toBe(true)
      for (const f of [path.join(projects, `${SB}.jsonl`), path.join(fakeHome, '.claude', 'history.jsonl'), path.join(cwdB, 'secret.txt'), ...daemonFiles.filter((f) => !f.endsWith(`${SA}.jsonl`) && !f.endsWith(`${SA}.meta.json`))]) {
        expect(notFound(await cmd(follower, { cmd: 'fs.read', path: f })), f).toBe(true)
      }
      // A's own transcript is found with no cwd (fs.find), B's never.
      const found = await cmd(follower, { cmd: 'fs.find', path: '~/.claude/projects', name: `${SA}.jsonl`, maxDepth: 3 })
      expect(found.files).toEqual([path.join(projects, `${SA}.jsonl`)])
      expect(notFound(await cmd(follower, { cmd: 'fs.find', path: '~/.claude/projects', name: `${SB}.jsonl` }))).toBe(true)

      // The whole repository's answers lose B's files and matches; the leader's keep them.
      const diff = await cmd(follower, { cmd: 'git.diff', cwd: repo, base: 'uncommitted' })
      expect(diff.ok, JSON.stringify(diff).slice(0, 300)).toBe(true)
      expect((diff.files as Array<{ relPath: string }>).map((f) => f.relPath)).toEqual(['marina.txt'])
      expect(JSON.stringify(diff)).not.toContain('acme v')
      const grep = await cmd(follower, { cmd: 'fs.grep', file: path.join(repo, 'marina.txt'), symbol: 'shared_symbol' })
      expect((grep.matches as Array<{ file: string }>).map((m) => m.file)).toEqual([path.join(repo, 'marina.txt')])
      const leaderDiff = await cmd(leaderA, { cmd: 'git.diff', cwd: repo, base: 'uncommitted' })
      expect((leaderDiff.files as Array<{ relPath: string }>).map((f) => f.relPath).sort()).toEqual(['acme/secret.txt', 'marina.txt'])

      // git file history: a relative path is refused (the handler would resolve it
      // against the daemon's own cwd); the absolute path of A's file answers.
      for (const c of [
        { cmd: 'git.fileShow', cwd: repo, path: 'acme/secret.txt', sha },
        { cmd: 'git.fileShow', cwd: repo, path: 'marina.txt', sha },
        { cmd: 'git.fileLog', cwd: repo, path: 'acme/secret.txt' },
        { cmd: 'git.fileShow', cwd: repo, path: path.join(cwdB, 'secret.txt'), sha },
      ]) expect(notFound(await cmd(follower, c)), JSON.stringify(c)).toBe(true)
      expect(await cmd(follower, { cmd: 'git.fileShow', cwd: repo, path: path.join(repo, 'marina.txt'), sha })).toMatchObject({ ok: true, content: 'marina v1 shared_symbol\n' })

      for (const sid of [SA, SB]) await cmd(sid === SA ? leaderA : leaderB, { cmd: 'stop', sid, reason: 'user', home: sid === SA ? HOME_A : HOME_B })
      await cmd(leaderA, { cmd: 'server.configure', home: HOME_A, spec: null })
    }, 180_000)
  })
}
