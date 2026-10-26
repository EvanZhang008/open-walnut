/**
 * cli-owner-v1 on the real daemon twins: one CLI per session id on a host,
 * whichever daemon asks (src/providers/cli-owner-core.ts).
 *
 * Two real daemons share one HOME (one ~/.claude, one spawn journal dir, so one
 * set of owner records) but have their own daemon and streams dirs, the way the
 * production daemon and an ephemeral test server's daemon do (2026-10-25: the
 * second one resumed a live session and two CLIs of it edited one tree). The
 * "CLI" is a node script named like claude that records every stdin line with
 * its pid and exits on its own (on a line "exit-now", or after 60 s).
 *
 * Pinned: a second daemon's resume of a live session is refused and spawns
 * nothing; two daemons starting one session at once start one CLI; messages go
 * in order to that one process; a CLI that exits on its own frees the session;
 * a restarted daemon adopts its CLI and keeps the record; a CLI no record names
 * (an older daemon's) still refuses; a daemon replacing its own CLI never has
 * two alive at once.
 *
 * MACHINE SAFETY: HOME, the daemon dirs and the streams dirs are temp paths; the
 * only processes signalled are the daemons and stand-in CLIs this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'

let scriptPath = ''
let cliPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const SOURCE: Twin = { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] }
const STANDALONE_TWIN: Twin | null = BUN ? { name: 'standalone twin (bun)', command: () => [BUN, [STANDALONE, '--start']] } : null
/** [first daemon, second daemon]: each twin against itself, and the two against each other. */
const PAIRS: Array<{ name: string; a: Twin; b: Twin }> = [
  { name: 'source + source', a: SOURCE, b: SOURCE },
  ...(STANDALONE_TWIN ? [
    { name: 'standalone + standalone', a: STANDALONE_TWIN, b: STANDALONE_TWIN },
    { name: 'standalone + source', a: STANDALONE_TWIN, b: SOURCE },
  ] : []),
]

const FAKE_CLI = `
const fs = require('fs')
const received = process.argv[2]
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
setTimeout(() => process.exit(0), 60000).unref()
let buf = ''
process.stdin.on('data', (chunk) => {
  buf += chunk.toString()
  let i
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.type !== 'user') continue
    const content = typeof msg.message.content === 'string' ? msg.message.content : JSON.stringify(msg.message.content)
    fs.appendFileSync(received, JSON.stringify({ pid: process.pid, content }) + '\\n')
    if (content === 'exit-now') process.exit(0)
  }
})
process.on('SIGTERM', () => process.exit(0))
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; ws: WebSocket; daemonDir: string; streams: string }
const daemons: Daemon[] = []
const spawnedPids = new Set<number>()
let rpcId = 1

const dirsFor = (name: string) => ({ daemonDir: path.join(root, name, 'daemon'), streams: path.join(root, name, 'streams') })
const received = (): Array<{ pid: number; content: string }> => {
  const f = path.join(root, 'received.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

async function boot(twin: Twin, name: string): Promise<Daemon> {
  const { daemonDir, streams } = dirsFor(name)
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    // Shared by both daemons, as the real HOME's journal is: the owner records live beside it.
    WALNUT_SPAWN_JOURNAL: path.join(root, 'home', '.open-walnut', 'local', 'spawn-journal.jsonl'),
  }
  const [cmd, args] = twin.command()
  const proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 60_000)
    proc.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  const d = { proc, ws, daemonDir, streams }
  daemons.push(d)
  return d
}

async function killDaemon(d: Daemon): Promise<void> {
  try { d.ws.close() } catch { /* closed */ }
  if (d.proc.exitCode === null) {
    d.proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000)
      d.proc.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  const i = daemons.indexOf(d)
  if (i >= 0) daemons.splice(i, 1)
}

function rpc(d: Daemon, cmd: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); d.ws.off('message', onMessage); resolve(msg) }
    }
    d.ws.on('message', onMessage)
    d.ws.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

/** Every live stand-in CLI that runs `sid`, from the real process table. */
function liveClis(sid: string): number[] {
  const out = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,args='], { encoding: 'utf8' }).stdout
  return out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .filter((m) => m[2].includes(cliPath) && (m[2].includes(`--resume ${sid}`) || m[2].includes(`--session-id ${sid}`))).map((m) => Number(m[1]))
}

/** Resume `sid` through daemon `d` the way the server does: the args name the session. */
function start(d: Daemon, sid: string, message = '', extra: Record<string, unknown> = {}, flag = '--resume') {
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(path.join(root, 'received.jsonl'))} "$@"`
  return rpc(d, { cmd: 'start', sid, cwd: root, message, resume: flag === '--resume', mode: 'default', args: ['/bin/sh', '-c', sh, 'sh', flag, sid], ...extra })
}

function track(reply: Record<string, unknown>): void {
  if (typeof reply.pid === 'number') spawnedPids.add(reply.pid)
}

const send = (d: Daemon, sid: string, message: string) => rpc(d, { cmd: 'send', sid, message })

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-owner-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  for (const d of [...daemons]) await killDaemon(d)
  for (const pid of spawnedPids) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  spawnedPids.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function newRoot(): void {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-cli-owner-')))
  fs.mkdirSync(path.join(root, 'home'), { recursive: true })
}

describe.each(PAIRS)('cli-owner-v1: $name', ({ a: twinA, b: twinB }) => {
  it('a second daemon never starts a live session again; messages reach the one process in order', async () => {
    newRoot()
    const a = await boot(twinA, 'a')
    const b = await boot(twinB, 'b')
    const sid = 'aaaaaaaa-0000-4000-8000-00000000000a'
    const first = await start(a, sid)
    track(first)
    expect(first).toMatchObject({ ok: true })
    expect(await waitFor(() => liveClis(sid).length === 1)).toBe(true)

    const second = await start(b, sid, 'from the other daemon')
    track(second)
    expect(second).toMatchObject({ ok: false, errorKind: 'session_live', reason: 'session_live' })
    expect(String(second.error)).toContain(`pid ${first.pid}`)
    await new Promise((r) => setTimeout(r, 500))
    expect(liveClis(sid)).toEqual([first.pid])
    // The refused daemon kept no FIFO or record of its own for it.
    expect(fs.existsSync(path.join(b.streams, sid + '.pipe'))).toBe(false)

    for (const m of ['one', 'two', 'three']) expect(await send(a, sid, m)).toMatchObject({ ok: true })
    expect(await waitFor(() => received().length === 3)).toBe(true)
    expect(received()).toEqual(['one', 'two', 'three'].map((content) => ({ pid: first.pid, content })))
  }, 180_000)

  it('two daemons starting one session at once start one CLI', async () => {
    newRoot()
    const a = await boot(twinA, 'a')
    const b = await boot(twinB, 'b')
    for (let round = 0; round < 3; round++) {
      const sid = `bbbbbbbb-0000-4000-8000-00000000000${round}`
      const replies = await Promise.all([start(a, sid), start(b, sid)])
      replies.forEach(track)
      expect(replies.filter((r) => r.ok === true)).toHaveLength(1)
      expect(replies.filter((r) => r.errorKind === 'session_live')).toHaveLength(1)
      await new Promise((r) => setTimeout(r, 300))
      expect(liveClis(sid)).toEqual([replies.find((r) => r.ok === true)!.pid])
    }
  }, 180_000)

  it('a CLI that exits on its own frees the session for the other daemon', async () => {
    newRoot()
    const a = await boot(twinA, 'a')
    const b = await boot(twinB, 'b')
    const sid = 'cccccccc-0000-4000-8000-00000000000c'
    const first = await start(a, sid)
    track(first)
    expect(await start(b, sid)).toMatchObject({ errorKind: 'session_live' })
    expect(await send(a, sid, 'exit-now')).toMatchObject({ ok: true })
    expect(await waitFor(() => liveClis(sid).length === 0)).toBe(true)
    const second = await start(b, sid)
    track(second)
    expect(second).toMatchObject({ ok: true })
    expect(second.pid).not.toBe(first.pid)
    expect(await waitFor(() => liveClis(sid).length === 1)).toBe(true)
    expect(liveClis(sid)).toEqual([second.pid])
  }, 180_000)

  it('a restarted daemon adopts its CLI and keeps the record; a CLI no record names still refuses', async () => {
    newRoot()
    let a = await boot(twinA, 'a')
    const b = await boot(twinB, 'b')
    const sid = 'dddddddd-0000-4000-8000-00000000000d'
    const first = await start(a, sid)
    track(first)
    await killDaemon(a) // the CLI survives its daemon
    expect(liveClis(sid)).toEqual([first.pid])
    a = await boot(twinA, 'a')
    // Adopted: a send reaches the same process.
    let sent: Record<string, unknown> = {}
    const until = Date.now() + 20_000
    do {
      sent = await send(a, sid, 'after restart')
      if (sent.reason !== 'not_found') break
      await new Promise((r) => setTimeout(r, 200))
    } while (Date.now() < until)
    expect(sent).toMatchObject({ ok: true })
    expect(await waitFor(() => received().some((r) => r.content === 'after restart'))).toBe(true)
    expect(received().find((r) => r.content === 'after restart')!.pid).toBe(first.pid)
    const recordDir = path.join(root, 'home', '.open-walnut', 'local', 'cli-owners')
    const recordFile = () => path.join(recordDir, fs.readdirSync(recordDir)[0], sid + '.json')
    expect(await waitFor(() => fs.existsSync(recordFile()))).toBe(true)
    expect(await start(b, sid)).toMatchObject({ errorKind: 'session_live' })

    // An older daemon's CLI has no record: the process table still refuses it.
    fs.unlinkSync(recordFile())
    const again = await start(b, sid)
    track(again)
    expect(again).toMatchObject({ errorKind: 'session_live' })
    expect(String(again.error)).toContain('no Walnut daemon recorded')
    expect(liveClis(sid)).toEqual([first.pid])
  }, 180_000)

  it("a test server's strict start never runs another Walnut's session, live or not", async () => {
    newRoot()
    const a = await boot(twinA, 'a')
    const b = await boot(twinB, 'b')
    const sid = 'ffffffff-0000-4000-8000-00000000000f'
    const prod = { origin: { home: '/walnut/prod' } }
    const test = { origin: { home: '/walnut/test' }, strict: true }
    const first = await start(a, sid, '', prod, '--session-id')
    track(first)
    expect(first).toMatchObject({ ok: true })
    expect(await send(a, sid, 'exit-now')).toMatchObject({ ok: true })
    expect(await waitFor(() => liveClis(sid).length === 0)).toBe(true)
    // Nothing runs it now, and still a test server may not resume it.
    const refused = await start(b, sid, 'copied clock', test)
    expect(refused).toMatchObject({ ok: false, errorKind: 'session_other_walnut', reason: 'session_other_walnut' })
    expect(String(refused.error)).toContain('/walnut/prod')
    expect(liveClis(sid)).toEqual([])
    // A session the test server starts itself it may run and resume.
    const own = 'ffffffff-0000-4000-8000-0000000000f2'
    const made = await start(b, own, '', test, '--session-id')
    track(made)
    expect(made).toMatchObject({ ok: true })
    expect(await send(b, own, 'exit-now')).toMatchObject({ ok: true })
    expect(await waitFor(() => liveClis(own).length === 0)).toBe(true)
    const resumed = await start(b, own, '', test)
    track(resumed)
    expect(resumed).toMatchObject({ ok: true })
    // The production daemon resumes its own session as before.
    const back = await start(a, sid, '', prod)
    track(back)
    expect(back).toMatchObject({ ok: true })
  }, 180_000)

  it('a daemon replacing its own CLI never has two alive at once', async () => {
    newRoot()
    const a = await boot(twinA, 'a')
    const sid = 'eeeeeeee-0000-4000-8000-00000000000e'
    const first = await start(a, sid)
    track(first)
    expect(await waitFor(() => liveClis(sid).length === 1)).toBe(true)
    let most = 0
    let sampling = true
    const sampler = (async () => {
      while (sampling) { most = Math.max(most, liveClis(sid).length); await new Promise((r) => setTimeout(r, 20)) }
    })()
    // An empty-message resume of a live session is the restart path (reinitialize).
    const second = await start(a, sid)
    track(second)
    expect(second).toMatchObject({ ok: true })
    expect(await waitFor(() => liveClis(sid).length === 1 && liveClis(sid)[0] === second.pid)).toBe(true)
    sampling = false
    await sampler
    expect(second.pid).not.toBe(first.pid)
    expect(most).toBe(1)
  }, 180_000)
})
