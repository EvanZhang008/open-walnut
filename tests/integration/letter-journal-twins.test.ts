/**
 * A session's letter to the user while its Mac is away, on REAL daemon processes, both
 * twins (source twin on node, standalone on bun):
 *
 *   test as the Mac ==trusted WS==> daemon <== agent gateway (the session's human_inbox_send)
 *
 * A Mac that does not drain `letter` keeps today's answer: the op needs the server. A Mac
 * that drains it gets the letter saved on the host, listed in tools.list, handed over by
 * offline.drain with its body by offline.blob (byte for byte), and gone after the ack.
 *
 * Hygiene: every dir is a temp dir; every daemon is stopped by the pid it wrote into its
 * own temp dir, the mock CLI by the pids it logged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { buildSync } from 'esbuild'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { JOURNAL_V2_DRAINS } from '../../src/providers/offline-journal-core.js'
import { fetchOfflineBlob } from '../../src/core/offline-merge/blob.js'
import { LETTER_ID_RE } from '../../src/core/human-inbox/normalize.js'
import type { HostSlice } from '../../src/providers/offline-host-core.js'
import type { InboxLetterItem } from '../../src/core/human-inbox/types.js'

const ROOT = path.resolve(__dirname, '../..')
const HOME = '/fixture/marina-home'
const WALNUT = 'wmarinaletter1'
const A = 'aaaaaaaa-6666-4666-8666-666666666666'
const TASK_A = 'mtaskaaa-0006'
// Accents, CJK and an astral emoji: the body crosses the host byte for byte.
const BODY = '## Two layouts\n\nPick one: café 中文 🚀.\n'
const ITEMS: InboxLetterItem[] = Array.from({ length: 30 }, (_, n) => ({
  id: `twin-mail-${n}`, subject: `Marina update ${n}`, summary: 'Details: \u{e9} \u{4e2d}\u{6587} \u{1f680}.\nAn independent mail action.',
  source: { kind: 'mail', account: `twin-account-${n}`, message: `twin-message-${n}` },
  display: { sender: { name: 'Marina desk', address: 'desk@example.test' }, sentAt: '2026-10-14T09:30:00Z', accountLabel: `Mailbox ${n}` },
  actions: [
    { id: `twin-read-${n}`, kind: 'op', intent: 'mark_read' },
    { id: `twin-find-${n}`, kind: 'op', intent: 'find_task' },
    { id: `twin-create-${n}`, kind: 'op', intent: 'create_task' },
    { id: `twin-attach-${n}`, kind: 'op', intent: 'attach_task' },
    { id: `twin-ask-${n}`, kind: 'reply_ai', label: 'Ask about this mail', question: `Explain mail ${n}` },
  ],
}))
const LETTER = { subject: 'Pick a layout', type: 'action_required', markdown: BODY, actions: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }], items: ITEMS }
const OLD_DRAINS = JOURNAL_V2_DRAINS.filter((k) => k !== 'letter')
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))

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
    const binary = process.env.WALNUT_LETTER_TEST_BINARY
    proc = spawn(binary ?? BUN!, [...(binary ? [] : [path.join(ROOT, 'src/providers/daemon-standalone.ts')]), '--start'], { env, stdio: ['ignore', 'ignore', process.env.DEBUG_DAEMON ? 'pipe' : 'ignore'], cwd: ROOT })
  } else {
    const script = path.join(dir, 'daemon.cjs')
    const compiledModule = process.env.WALNUT_LETTER_TEST_SOURCE_MODULE
    const source = compiledModule
      ? (await import(compiledModule) as { getDaemonSource(): string }).getDaemonSource()
      : getDaemonSource()
    fs.writeFileSync(script, source, { mode: 0o755 })
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

function gateway(sock: string, op: 'tools.call' | 'tools.list', args: Record<string, unknown>): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock)
    let buf = ''
    const t = setTimeout(() => { s.destroy(); reject(new Error('gateway timeout')) }, 15_000)
    s.on('connect', () => s.write(JSON.stringify({ v: 1, op, sid: A, args }) + '\n'))
    s.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) { clearTimeout(t); s.destroy(); resolve(JSON.parse(buf.slice(0, nl))) }
    })
    s.on('error', (e) => { clearTimeout(t); reject(e) })
  })
}
const send = (d: Daemon, args: Record<string, unknown>) => gateway(d.sock, 'tools.call', { name: 'human_inbox_send', args })

function slice(): HostSlice {
  return {
    v: 1, home: HOME, hash: 'h1', asOf: Date.now(), host: 'devbox',
    sessions: [{ sid: A, taskId: TASK_A, title: 'Marina page' }],
    tasks: [{ id: TASK_A, title: 'Marina page', phase: 'IN_PROGRESS', project: 'Acme' }],
    requests: [],
  }
}

async function macConnects(d: Daemon, drains: string[]): Promise<WebSocket> {
  const ws = await connectWs(d.port)
  expect((await cmd(ws, { cmd: 'leader.configure', home: HOME, walnutId: WALNUT, backup: false, drains })).ok).toBe(true)
  expect((await cmd(ws, { cmd: 'host.slice', slice: slice() })).ok).toBe(true)
  return ws
}

async function startSession(d: Daemon, ws: WebSocket): Promise<void> {
  const mock = path.join(base, 'mock-cli.cjs')
  if (!fs.existsSync(mock)) fs.writeFileSync(mock, MOCK_CLI)
  const r = await cmd(ws, { cmd: 'start', sid: A, cwd: d.dir, message: 'init', args: [process.execPath, mock, A, path.join(base, 'mock-pids.txt')], origin: { home: HOME, task: TASK_A } })
  expect(r.ok, JSON.stringify(r)).toBe(true)
  await waitFor(() => { try { return fs.readFileSync(path.join(d.dir, 'streams', `${A}.jsonl`), 'utf8').includes('"state":"idle"') } catch { return false } }, 20_000, 'session A idle')
}

function daemonLog(d: Daemon): string {
  try {
    return fs.readdirSync(d.dir).filter((n) => /^daemon-.*\.log$/.test(n))
      .map((n) => fs.readFileSync(path.join(d.dir, n), 'utf8').split('\n').filter((l) => /letter|offline|gateway|error|warn/i.test(l)).slice(-40).join('\n')).join('\n')
  } catch { return '' }
}

beforeAll(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'wlj-')) })
afterAll(() => {
  let mocks: number[] = []
  try { mocks = fs.readFileSync(path.join(base, 'mock-pids.txt'), 'utf8').split('\n').map((l) => parseInt(l, 10)).filter((n) => n > 1) } catch { /* none */ }
  for (const pid of [...mocks, ...started]) { if (pid > 1 && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* best effort */ }
})

for (const twin of ['source', 'standalone'] as const) {
  describe.skipIf(twin === 'standalone' && !BUN)(`${twin} twin: a letter while the Mac is away`, () => {
    it('an older Mac: needs the server; a Mac that drains letters: saved, listed, drained with its body, acked', async () => {
      const d = await spawnDaemon(path.join(base, `${twin}-d`), twin)
      try { await run(d) } catch (err) { throw new Error(`${(err as Error).message}\n${twin} daemon log:\n${daemonLog(d)}`) }
    }, 120_000)
  })
}

async function run(d: Daemon): Promise<void> {
  // An older Mac (its drains leave letters out) leads, then goes away.
  let mac = await macConnects(d, OLD_DRAINS)
  await startSession(d, mac)
  mac.close()
  await sleep(300)
  const old = await send(d, LETTER)
  expect(old, JSON.stringify(old)).toMatchObject({ ok: false, error: { code: 'hub_unreachable', message: expect.stringMatching(/^"human_inbox_send" needs the Walnut server/) } })
  const oldList = await gateway(d.sock, 'tools.list', {})
  expect(oldList.ok, JSON.stringify(oldList)).toBe(true)
  expect((oldList.result.ops as Array<{ name: string }>).map((o) => o.name)).not.toContain('human_inbox_send')

  // A Mac that drains letters leads, then goes away.
  mac = await macConnects(d, JOURNAL_V2_DRAINS)
  mac.close()
  await sleep(300)
  const list = await gateway(d.sock, 'tools.list', {})
  expect((list.result.ops as Array<{ name: string }>).map((o) => o.name)).toContain('human_inbox_send')
  const r = await send(d, LETTER)
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true, result: { queued: true, offline: true, kind: 'letter' } })
  const letterId = r.result.letterId as string
  expect(letterId).toMatch(LETTER_ID_RE)
  // Refused with the store's words, nothing saved.
  const bad = await send(d, { subject: 'x', type: 'action_required', markdown: 'm' })
  expect(bad, JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: 'bad_request', message: expect.stringMatching(/^action_required needs at least one action/) } })

  // The Mac comes back and drains: the record, then its body by offline.blob.
  mac = await macConnects(d, JOURNAL_V2_DRAINS)
  const old2 = await cmd(mac, { cmd: 'offline.drain', home: HOME, kinds: OLD_DRAINS })
  expect(old2.ok, JSON.stringify(old2)).toBe(true)
  expect((old2.records as Array<{ kind: string }>).filter((x) => x.kind === 'letter')).toEqual([])
  const dr = await cmd(mac, { cmd: 'offline.drain', home: HOME, kinds: JOURNAL_V2_DRAINS })
  expect(dr.ok, JSON.stringify(dr)).toBe(true)
  const letters = (dr.records as Array<Record<string, any>>).filter((x) => x.kind === 'letter')
  expect(letters).toHaveLength(1)
  expect(letters[0]).toMatchObject({
    letterId, format: 'markdown', actor: { kind: 'session', sid: A },
    args: { subject: 'Pick a layout', type: 'action_required', actions: LETTER.actions },
  })
  expect(letters[0].args.items).toHaveLength(30)
  expect(letters[0].args.items).toEqual(ITEMS)
  expect(letters[0].args).not.toHaveProperty('markdown')
  const conn = { send: (c: string, p: Record<string, unknown> = {}) => cmd(mac, { cmd: c, ...p }) }
  expect((await fetchOfflineBlob(conn, letters[0].bodyBlob)).toString('utf8')).toBe(BODY)
  const ack = await cmd(mac, { cmd: 'offline.ack', home: HOME, seqs: letters.map((x) => x.seq), now: Date.now() })
  expect(ack, JSON.stringify(ack)).toMatchObject({ ok: true, remaining: 0 })
  // Freed at the ack.
  expect(await cmd(mac, { cmd: 'offline.blob', sha: letters[0].bodyBlob, offset: 0 })).toMatchObject({ ok: false })
  mac.close()
}
