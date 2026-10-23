/**
 * Notes written while the Mac is away, on REAL daemon processes, both twins
 * (docs/plan/walnut-replica-servers-impl.md section 6, WP11, `note-journal-v1`):
 *
 *   test as the Mac ==trusted WS==> daemon (source twin on node, standalone on bun)
 *   test as the replica ==follower WS (follower.op note_put)==^   ^ agent gateway (a session's note_edit)
 *
 * A phone save and a session's note_edit of one note serialize: the stale one is a 409
 * with the text the host shows; a later save of the same writer coalesces; 120 saves in
 * a minute are never throttled. The Mac comes back and drains: the records in order,
 * their bodies by `offline.blob`, merged into the Mac's own edit by the real drain code;
 * the copy holds the note until a manifest made after the ack, then takes the Mac's text.
 *
 * Hygiene: every dir is a temp dir; every daemon is stopped by the pid it wrote into its
 * own temp dir, the fake server and the mock CLI by the pids they logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { fetchOfflineBlob } from '../../src/core/offline-merge/blob.js'
import { applyNoteRecord, type NoteRecordLike } from '../../src/core/offline-merge/notes.js'
import { mergeVersions } from '../../src/lib/three-way-merge.js'
import { withNoteId } from '../../src/core/parse-frontmatter.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'
import { testBun } from '../helpers/bun-runtime.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinanote01'
const A = 'aaaaaaaa-5555-4555-8555-555555555555'
const TASK_A = 'mtaskaaa-0005'
const PHONE = { kind: 'device', deviceId: 'dev-acme-phone', name: 'Acme phone' }
const KEY = 'Projects/Plan.md'
const BODY = '---\nid: n_plan01\n---\n# Plan\n\nShip on Friday.\nThe rollback is ready.\nNotes end here.\n'
const BUN: string | undefined = testBun()
const sha12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

const FAKE_SERVER = `
const fs = require('fs')
fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ pid: process.pid, token: process.env.WALNUT_FOLLOWER_TOKEN }) + '\\n')
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1 << 30)
`

const MOCK_CLI = `
const fs = require('fs')
const sid = process.argv[2]
fs.appendFileSync(process.argv[3], process.pid + '\\n')
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: sid })
out({ type: 'result', subtype: 'success', is_error: false, result: 'ready', session_id: sid })
out({ type: 'system', subtype: 'session_state_changed', state: 'idle' })
process.stdin.on('data', () => {})
setInterval(() => {}, 1 << 30)
`

type Twin = 'source' | 'standalone'
interface Daemon { proc: ChildProcess; dir: string; port: number; pid: number; sock: string; twin: Twin }

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
const fakePids: number[] = []

async function spawnDaemon(dir: string, twin: Twin): Promise<Daemon> {
  fs.mkdirSync(dir, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WALNUT_DAEMON_DIR: dir,
    WALNUT_JOURNAL_DIR: path.join(dir, 'journal'),
    WALNUT_REPLICA_DIR: path.join(dir, 'replica'),
    WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_GATEWAY_TIMEOUT_MS: '3000',
  }
  delete env.VITEST; delete env.VITEST_MODE; delete env.VITEST_WORKER_ID; delete env.VITEST_POOL_ID
  delete env.WALNUT_DAEMON_STATE_DIR
  let proc: ChildProcess
  if (twin === 'standalone') {
    proc = spawn(BUN!, [path.join(ROOT, 'src/providers/daemon-standalone.ts'), '--start'], { env, stdio: ['ignore', 'ignore', process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'], cwd: ROOT })
  } else {
    const script = path.join(dir, 'daemon.cjs')
    fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
    buildSync({ entryPoints: [path.join(ROOT, 'src/providers/trigger-check-sidecar.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'trigger-check-core.cjs'), logLevel: 'silent' })
    proc = spawn(process.execPath, [script, '--start'], { env, stdio: ['ignore', 'ignore', process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'] })
  }
  if (process.env.DEBUG_DAEMON) proc.stderr?.on('data', (b) => process.stderr.write(`[${twin}] ` + b.toString()))
  const sock = path.join(dir, 'agent-gateway.sock')
  await waitFor(() => fs.existsSync(path.join(dir, 'daemon.port')) && fs.existsSync(sock) && fs.existsSync(path.join(dir, 'daemon.pid')), 60_000, `${twin} daemon`)
  const pid = parseInt(fs.readFileSync(path.join(dir, 'daemon.pid'), 'utf8').trim(), 10)
  started.push(pid)
  return { proc, dir, sock, twin, pid, port: parseInt(fs.readFileSync(path.join(dir, 'daemon.port'), 'utf8').trim(), 10) }
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
    const t = setTimeout(() => { ws.off('message', on); reject(new Error(`cmd ${body.cmd} timed out`)) }, 20_000)
    const on = (data: WebSocket.Data) => {
      try { const m = JSON.parse(data.toString()); if (m.id === id) { clearTimeout(t); ws.off('message', on); resolve(m) } } catch { /* not json */ }
    }
    ws.on('message', on)
    ws.send(JSON.stringify({ id, ...body }))
  })
}

function gateway(sock: string, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 15_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op: 'tools.call', sid: A, args: { name, args } }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}

function slice(): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: A, taskId: TASK_A, title: 'Plan work' }],
    tasks: [{ id: TASK_A, title: 'Plan work', phase: 'IN_PROGRESS', project: 'Acme' }],
    requests: [],
  }
}

/** The Mac connects: its Walnut with every v2 drain (notes included), the slice, and the notes copy. */
async function macConnects(d: Daemon, macBody: string | null): Promise<WebSocket> {
  const ws = await connectWs(d.port)
  expect((await cmd(ws, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false, drains: JOURNAL_V2_DRAINS })).ok).toBe(true)
  expect((await cmd(ws, { cmd: 'host.slice', slice: slice() })).ok).toBe(true)
  if (macBody !== null) {
    const entries = [{ k: KEY, h: sha12(macBody), n: Buffer.byteLength(macBody), m: { title: 'Plan', id: 'n_plan01' } }]
    const s = await cmd(ws, { cmd: 'replica.sync', home: HOME, kind: 'notes', entries, asOf: Date.now() })
    expect(s.ok, JSON.stringify(s)).toBe(true)
    if (s.need.length) expect((await cmd(ws, { cmd: 'replica.put', home: HOME, kind: 'notes', files: [{ k: KEY, body: macBody }] })).ok).toBe(true)
  }
  return ws
}

async function startSession(d: Daemon, ws: WebSocket): Promise<void> {
  const mock = path.join(base, 'mock-cli.cjs')
  if (!fs.existsSync(mock)) fs.writeFileSync(mock, MOCK_CLI)
  const r = await cmd(ws, { cmd: 'start', sid: A, cwd: d.dir, message: 'init', args: [process.execPath, mock, A, path.join(base, 'mock-pids.txt')], origin: { home: HOME, task: TASK_A } })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  await waitFor(() => { try { return fs.readFileSync(path.join(d.dir, 'streams', `${A}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 20_000, 'session A idle')
}

async function followerSocket(d: Daemon, mac: WebSocket): Promise<WebSocket> {
  const out = path.join(base, `${d.twin}-fake.jsonl`)
  const fake = path.join(base, 'fake-server.cjs')
  fs.writeFileSync(fake, FAKE_SERVER)
  const spec = { v: 1, home: HOME, walnutId: WALNUT, command: process.execPath, args: [fake], cwd: base, env: { FAKE_OUT: out }, log: path.join(base, `server-${d.twin}.log`), port: 41_236, settings: { expose: { enabled: false } } }
  expect((await cmd(mac, { cmd: 'server.configure', home: HOME, spec })).ok).toBe(true)
  await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').trim().length > 0, 30_000, 'the host server token')
  const ws = await connectWs(d.port)
  for (let attempt = 0; attempt < 40; attempt++) {
    const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    for (const l of lines) if (typeof l.pid === 'number' && fakePids.indexOf(l.pid) === -1) fakePids.push(l.pid)
    const hello = await cmd(ws, { cmd: 'follower.hello', walnutId: WALNUT, home: HOME, token: lines[lines.length - 1].token })
    if (hello.ok) return ws
    await sleep(250)
  }
  throw new Error('follower.hello refused')
}

const save = (f: WebSocket, args: Record<string, unknown>, opId: string) => cmd(f, { cmd: 'follower.op', op: 'note_put', args: { path: KEY, ...args }, actor: PHONE, opId })

/** The daemon's own log lines of a failed run (its dir is removed after the test). */
function daemonLog(d: Daemon): string {
  try {
    return fs.readdirSync(d.dir).filter((n) => /^daemon-.*\.log$/.test(n))
      .map((n) => fs.readFileSync(path.join(d.dir, n), 'utf8').split('\n').filter((l) => /follower|note|offline|error|warn/i.test(l)).slice(-40).join('\n')).join('\n')
  } catch { return '' }
}

beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'wnj-')) })
afterAll(() => {
  let mocks: number[] = []
  try { mocks = fs.readFileSync(path.join(base, 'mock-pids.txt'), 'utf8').split('\n').map((l) => parseInt(l, 10)).filter((n) => n > 1) } catch { /* none */ }
  for (const pid of [...mocks, ...fakePids, ...started]) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

const entry = (body: string) => [{ k: KEY, h: sha12(body), n: Buffer.byteLength(body), m: { title: 'Plan', id: 'n_plan01' } }]

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: notes while the Mac is away`, () => {
    it('a phone save and a session note_edit serialize with 409; saves coalesce; 120 saves are never throttled; the drain merges; the copy catches up after the ack', async () => {
      const d = await spawnDaemon(path.join(base, `${twin}-d`), twin)
      try { await run(d) } catch (err) { throw new Error(`${(err as Error).message}\n${twin} daemon log:\n${daemonLog(d)}`) }
    }, 180_000)
  })
}

async function run(d: Daemon): Promise<void> {
  const twin = d.twin
  let mac = await macConnects(d, BODY)
  await startSession(d, mac)
  const follower = await followerSocket(d, mac)
  // The Mac goes away (its socket closes).
  mac.close()
  await sleep(300)
  // The phone saves twice: the second folds into the first.
  const p1 = BODY.replace('Ship on Friday.', 'Ship on Thursday.')
  const r1 = await save(follower, { content: p1, expectedHash: sha12(BODY) }, `op-${twin}-p1`)
  expect(r1, JSON.stringify(r1)).toMatchObject({ ok: true, queued: true, kind: 'note', mode: 'put', contentHash: sha12(p1), noteId: 'n_plan01' })
  const p2 = p1 + 'A line from the phone.\n'
  const r2 = await save(follower, { content: p2, expectedHash: sha12(p1) }, `op-${twin}-p2`)
  expect(r2, JSON.stringify(r2)).toMatchObject({ ok: true, coalesced: true, contentHash: sha12(p2) })
  // A lost answer retried with its op id: answered, nothing written.
  expect(await save(follower, { content: p2, expectedHash: sha12(p1) }, `op-${twin}-p2`)).toMatchObject({ ok: true, duplicate: true, contentHash: sha12(p2), noteId: 'n_plan01' })
  // The session edits what it read before the phone saved: 409, nothing written.
  const stale = await gateway(d.sock, 'note_edit', { path: 'Projects/Plan', old_str: 'The rollback is ready.', new_str: 'The rollback is tested.', expectedHash: sha12(BODY) })
  expect(stale, JSON.stringify(stale)).toMatchObject({ ok: false, error: { code: 'conflict' } })
  // Read again: the phone's text; the edit on it is a record of its own.
  const read = await gateway(d.sock, 'note_read', { path: 'Projects/Plan' })
  expect(read, JSON.stringify(read)).toMatchObject({ ok: true, result: { content: p2, contentHash: sha12(p2) } })
  const edit = await gateway(d.sock, 'note_edit', { path: 'Projects/Plan', old_str: 'The rollback is ready.', new_str: 'The rollback is tested.', expectedHash: read.result.contentHash })
  expect(edit, JSON.stringify(edit)).toMatchObject({ ok: true, result: { queued: true, kind: 'note' } })
  expect(edit.result.coalesced).toBeUndefined()
  const s1 = p2.replace('The rollback is ready.', 'The rollback is tested.')
  // The phone, still on p2: 409 with the text this host shows, for its editor to merge.
  const late = await save(follower, { content: p2 + 'x\n', expectedHash: sha12(p2) }, `op-${twin}-late`)
  expect(late).toMatchObject({ ok: false, errorKind: 'conflict', detail: { serverHash: sha12(s1), serverContent: s1 } })
  // An editor's autosave: 120 saves inside a minute, none throttled; after the first they fold.
  let text = s1
  const t0 = Date.now()
  for (let i = 0; i < 120; i++) {
    const next = `${text}autosave ${i}\n`
    const r = await save(follower, { content: next, expectedHash: sha12(text) }, `op-${twin}-auto-${i}`)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (i > 0) expect(r.coalesced, `save ${i}`).toBe(true)
    text = next
  }
  expect(Date.now() - t0).toBeLessThan(60_000)
  expect((await cmd(follower, { cmd: 'follower.status' })).journal).toMatchObject({ records: 3 })

  // The Mac comes back with its own edit of the last line; its manifest finds the note held.
  const macNow = BODY.replace('Notes end here.', 'Notes end here, says the Mac.')
  mac = await macConnects(d, null)
  expect(await cmd(mac, { cmd: 'replica.sync', home: HOME, kind: 'notes', entries: entry(macNow), asOf: Date.now() })).toMatchObject({ ok: true, need: [], held: 1 })
  const dr = await cmd(mac, { cmd: 'offline.drain', home: HOME, kinds: JOURNAL_V2_DRAINS })
  expect(dr.ok, JSON.stringify(dr)).toBe(true)
  const notes = (dr.records as NoteRecordLike[]).filter((r) => (r as { kind?: string }).kind === 'note')
  expect(notes.map((r) => [(r.actor as { kind: string }).kind, r.mode])).toEqual([['device', 'put'], ['session', 'put'], ['device', 'put']])
  expect(notes[0]).toMatchObject({ path: KEY, noteId: 'n_plan01', baseHash: sha12(BODY), oursHash: sha12(p2), opId: `op-${twin}-p1` })
  expect(notes[1]).toMatchObject({ baseHash: sha12(p2), oursHash: sha12(s1) })
  expect(notes[2]).toMatchObject({ baseHash: sha12(s1), oursHash: sha12(text) })
  // The real drain code over this daemon's blobs, into a vault holding the Mac's edit.
  const vault = path.join(base, `${twin}-vault`)
  fs.mkdirSync(path.join(vault, 'Projects'), { recursive: true })
  fs.writeFileSync(path.join(vault, KEY), macNow)
  const conn = { send: (c: string, p: Record<string, unknown> = {}) => cmd(mac, { cmd: c, ...p }) }
  const letters: unknown[] = []
  for (const r of notes) {
    await applyNoteRecord({
      root: vault, cacheDir: path.join(base, `${twin}-cache`), hostLabel: 'devbox', hostKey: 'devbox',
      fetchBlob: (sha) => fetchOfflineBlob(conn, sha), merge: async (b, v, o) => mergeVersions(b, v, o),
      pathOfId: () => undefined, lock: (_a, fn) => fn(), written: () => undefined, remove: async () => undefined,
      ensureId: (c, cur) => withNoteId(c, cur).content,
    }, { conflicts: (e) => { letters.push(...e) } }, r, r.at)
  }
  const merged = fs.readFileSync(path.join(vault, KEY), 'utf8')
  expect(merged).toBe(text.replace('Notes end here.', 'Notes end here, says the Mac.'))
  expect(letters).toEqual([])
  expect(fs.readdirSync(path.join(vault, 'Projects'))).toEqual(['Plan.md'])
  // The ack: the copy holds the key until a manifest made after it, then takes the Mac's text.
  const ackAt = Date.now()
  expect((await cmd(mac, { cmd: 'offline.ack', home: HOME, seqs: (dr.records as Array<{ seq: number }>).map((r) => r.seq) })).ok).toBe(true)
  expect(await cmd(mac, { cmd: 'replica.sync', home: HOME, kind: 'notes', entries: entry(merged), asOf: ackAt - 5_000 })).toMatchObject({ ok: true, need: [], held: 1 })
  expect(await cmd(mac, { cmd: 'replica.sync', home: HOME, kind: 'notes', entries: entry(merged), asOf: Date.now() + 1_000 })).toMatchObject({ ok: true, need: [KEY], held: 0 })
  expect((await cmd(mac, { cmd: 'replica.put', home: HOME, kind: 'notes', files: [{ k: KEY, body: merged }] })).ok).toBe(true)
  mac.close()
  await sleep(300)
  const after = await gateway(d.sock, 'note_read', { path: 'Projects/Plan' })
  expect(after, JSON.stringify(after)).toMatchObject({ ok: true, result: { content: merged, contentHash: sha12(merged), offline: true } })

  // A folder the Mac keeps off this host is refused in any letter case (the Mac's vault is
  // case-insensitive), and a path with a control character never reaches the journal.
  mac = await macConnects(d, null)
  expect((await cmd(mac, { cmd: 'replica.sync', home: HOME, kind: 'notes', entries: entry(merged), asOf: Date.now() + 2_000, opts: { keepExclude: ['Private'] } })).ok).toBe(true)
  mac.close()
  await sleep(300)
  for (const p of ['Private/new', 'private/new', 'PRIVATE/x/y']) {
    const r = await cmd(follower, { cmd: 'follower.op', op: 'note_put', args: { path: p, content: 'x\n' }, actor: PHONE, opId: `op-${twin}-kx-${p.length}-${p[1]}` })
    expect(r, `${p}: ${JSON.stringify(r)}`).toMatchObject({ ok: false, errorKind: 'needs_leader', detail: { why: 'not_kept_here' } })
  }
  const nul = await cmd(follower, { cmd: 'follower.op', op: 'note_put', args: { path: 'Projects/a\u0000b', content: 'x\n' }, actor: PHONE, opId: `op-${twin}-nul` })
  expect(nul, JSON.stringify(nul)).toMatchObject({ ok: false, errorKind: 'bad_request' })
  // An `id:` line typed into a save never sends it elsewhere: the record keeps the copy's id,
  // also for a later save over the pending one.
  const forged = merged.replace('id: n_plan01', 'id: n_diary01')
  const f1 = await save(follower, { content: forged, expectedHash: sha12(merged) }, `op-${twin}-forged-1`)
  expect(f1, JSON.stringify(f1)).toMatchObject({ ok: true, noteId: 'n_plan01' })
  const f2 = await save(follower, { content: forged + 'More.\n', expectedHash: sha12(forged) }, `op-${twin}-forged-2`)
  expect(f2, JSON.stringify(f2)).toMatchObject({ ok: true, noteId: 'n_plan01' })
  follower.close()
}
