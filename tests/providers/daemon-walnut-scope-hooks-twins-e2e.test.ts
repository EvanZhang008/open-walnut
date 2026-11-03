/**
 * One daemon, two Walnuts: hooks and the commands that name a Walnut, on the real twins.
 *
 * 2026-11-03: a host shared by two people's Walnuts held ONE hook rule set; whichever server
 * pushed last decided what every session on the host was denied, the other Walnut's included.
 * Pinned here: each Walnut's push keeps its own rules, which apply only to its own sessions
 * (the home its start named); a push with no home (an older server) is the unnamed copy that
 * still applies to every session whose Walnut pushed none; a hooks.json an older daemon left
 * (no `scoped` mark) applies until the first named push drops it; and a command naming another
 * Walnut than the one its socket speaks for is refused.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the streams dir are temp paths, PATH is built with
 * guardedPath; the only processes signalled are the daemons and stand-in CLIs this file started.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

let scriptPath = ''
let cliPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

const HOME_A = '/walnuts/alice/.open-walnut'
const HOME_B = '/walnuts/bob/.open-walnut'
const keyOf = (home: string) => crypto.createHash('sha1').update(home).digest('hex').slice(0, 16)
const DENY_DURABLE = {
  version: 1, hash: 'deny-durable',
  hooks: [{ id: 'session-only-cron', enabled: true, rules: [{ on: 'cron.create', when: { 'input.durable': true }, action: 'deny' }] }],
}
const NO_HOOKS = { version: 1, hash: 'none', hooks: [] }

// Asks for a durable CronCreate at once, then writes every stdin line it reads to its file.
const FAKE_CLI = `
const fs = require('fs')
const out = process.argv[2]
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fake' }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'r-cron', request: { subtype: 'can_use_tool', tool_name: 'CronCreate', input: { cron: '* * * * *', prompt: 'x', durable: true } } }) + '\\n')
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\\n')) >= 0) { fs.appendFileSync(out, buf.slice(0, i) + '\\n'); buf = buf.slice(i + 1) }
})
process.on('SIGTERM', () => process.exit(0))
setTimeout(() => process.exit(0), 60000).unref()
setInterval(() => {}, 1000)
`

interface Daemon { proc: ChildProcess; port: number; dir: string }
const daemons: Daemon[] = []
const sockets: WebSocket[] = []
const spawnedPids = new Set<number>()
let rpcId = 1

async function boot(twin: Twin): Promise<Daemon> {
  const daemonDir = path.join(root, 'daemon')
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: guardedPath([], '/usr/bin:/bin'),
    HOME: path.join(root, 'home'),
    CLAUDE_CONFIG_DIR: undefined,
    OPEN_WALNUT_API_URL: undefined,
    WALNUT_ENFORCE_SESSION_CRON: undefined,
    WALNUT_ALLOW_DURABLE_CRON: undefined,
    WALNUT_DAEMON_DIR: daemonDir,
    WALNUT_STREAMS_DIR: path.join(root, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
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
    onDaemonEarlyExit(proc, { daemonDir }, (err) => { clearTimeout(timer); reject(err) })
  })
  const d: Daemon = { proc, port, dir: daemonDir }
  daemons.push(d)
  return d
}

async function client(d: Daemon): Promise<WebSocket> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${d.port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  sockets.push(ws)
  return ws
}

function rpc(ws: WebSocket, cmd: Record<string, unknown>, timeoutMs = 40_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg) }
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, ...cmd }))
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

const stdinOf = (out: string): string => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '')
const denied = (out: string) => /"control_response"[\s\S]*"behavior":"deny"/.test(stdinOf(out))

async function startSession(ws: WebSocket, n: number, home: string | null): Promise<string> {
  const sid = `aaaaaaaa-0000-4000-8000-00000000000${n}`
  const out = path.join(root, `stdin-${n}.jsonl`)
  const sh = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} ${JSON.stringify(out)} "$@"`
  const args = ['/bin/sh', '-c', sh, 'sh', '--output-format', 'stream-json', '--input-format', 'stream-json', '--session-id', sid]
  const reply = await rpc(ws, { cmd: 'start', sid, cwd: root, message: '', mode: 'default', args, ...(home ? { origin: { home } } : {}) })
  expect(reply).toMatchObject({ ok: true })
  spawnedPids.add(reply.pid as number)
  return out
}

/** A session that runs under no deny rule gets no answer to its CronCreate (it waits for a person). */
async function settle(): Promise<void> { await new Promise((r) => setTimeout(r, 2500)) }

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-scope-hooks-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  cliPath = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(cliPath, FAKE_CLI)
})

afterEach(async () => {
  for (const ws of sockets.splice(0)) { try { ws.close() } catch { /* closed */ } }
  for (const d of daemons.splice(0)) {
    if (d.proc.exitCode === null) {
      d.proc.kill('SIGKILL')
      await new Promise<void>((resolve) => { const t = setTimeout(resolve, 3000); d.proc.once('exit', () => { clearTimeout(t); resolve() }) })
    }
  }
  for (const pid of spawnedPids) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } } }
  spawnedPids.clear()
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

function freshRoot(): void {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-scope-hooks-')))
  fs.mkdirSync(path.join(root, 'home'), { recursive: true })
}

describe.each(TWINS)('one daemon, two Walnuts: hooks ($name)', (twin) => {
  it('each Walnut\'s rules apply to its own sessions only, and survive a restart in their own file', async () => {
    freshRoot()
    const d = await boot(twin)
    const a = await client(d)
    const b = await client(d)
    expect(await rpc(a, { cmd: 'hooks.configure', home: HOME_A, config: DENY_DURABLE })).toMatchObject({ ok: true, changed: true })
    expect(await rpc(b, { cmd: 'hooks.configure', home: HOME_B, config: NO_HOOKS })).toMatchObject({ ok: true, changed: true })
    // B's push replaced nothing of A's: A's session is denied, B's is not.
    const outA = await startSession(a, 1, HOME_A)
    const outB = await startSession(b, 2, HOME_B)
    expect(await waitFor(() => denied(outA))).toBe(true)
    await settle()
    expect(stdinOf(outB)).not.toMatch(/control_response/)
    // Each copy is its own file, with its home; the legacy file is not written.
    const fileA = path.join(d.dir, 'walnuts', keyOf(HOME_A), 'hooks.json')
    expect(JSON.parse(fs.readFileSync(fileA, 'utf8'))).toMatchObject({ hash: 'deny-durable', home: HOME_A, scoped: 1 })
    expect(JSON.parse(fs.readFileSync(path.join(d.dir, 'walnuts', keyOf(HOME_B), 'hooks.json'), 'utf8'))).toMatchObject({ hash: 'none', home: HOME_B })
    expect(fs.existsSync(path.join(d.dir, 'hooks.json'))).toBe(false)

    // A restarted daemon reads both back before anyone pushes.
    d.proc.kill('SIGKILL')
    await new Promise<void>((resolve) => d.proc.once('exit', () => resolve()))
    for (const pid of spawnedPids) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
    spawnedPids.clear()
    const d2 = await boot(twin)
    const c = await client(d2)
    const outA2 = await startSession(c, 3, HOME_A)
    const outB2 = await startSession(c, 4, HOME_B)
    expect(await waitFor(() => denied(outA2))).toBe(true)
    await settle()
    expect(stdinOf(outB2)).not.toMatch(/control_response/)
  }, 180_000)

  it('a push with no home is the unnamed copy: it covers every session whose Walnut pushed none, as before', async () => {
    freshRoot()
    const d = await boot(twin)
    const old = await client(d)
    expect(await rpc(old, { cmd: 'hooks.configure', config: DENY_DURABLE })).toMatchObject({ ok: true })
    expect(JSON.parse(fs.readFileSync(path.join(d.dir, 'hooks.json'), 'utf8'))).toMatchObject({ hash: 'deny-durable', scoped: 1 })
    const b = await client(d)
    expect(await rpc(b, { cmd: 'hooks.configure', home: HOME_B, config: NO_HOOKS })).toMatchObject({ ok: true })
    // A session of an older server (no home) and one of a Walnut that pushed none: the unnamed rules.
    const outOld = await startSession(old, 5, null)
    const outA = await startSession(old, 6, HOME_A)
    // B pushed its own (none): the unnamed copy is not B's.
    const outB = await startSession(b, 7, HOME_B)
    expect(await waitFor(() => denied(outOld))).toBe(true)
    expect(await waitFor(() => denied(outA))).toBe(true)
    await settle()
    expect(stdinOf(outB)).not.toMatch(/control_response/)
    // A marked unnamed copy is an older server's own: a named push leaves it.
    expect(fs.existsSync(path.join(d.dir, 'hooks.json'))).toBe(true)
  }, 180_000)

  it('the one hooks.json an older daemon left covers everyone until the first named push drops it', async () => {
    freshRoot()
    fs.mkdirSync(path.join(root, 'daemon'), { recursive: true })
    fs.writeFileSync(path.join(root, 'daemon', 'hooks.json'), JSON.stringify(DENY_DURABLE))
    const d = await boot(twin)
    const b = await client(d)
    const outB = await startSession(b, 8, HOME_B)
    expect(await waitFor(() => denied(outB))).toBe(true)
    expect(await rpc(b, { cmd: 'hooks.configure', home: HOME_B, config: NO_HOOKS })).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(d.dir, 'hooks.json'))).toBe(false)
    // Walnut A has not pushed yet: with the inherited copy gone, nothing denies its session.
    const outA = await startSession(b, 9, HOME_A)
    await settle()
    expect(stdinOf(outA)).not.toMatch(/control_response/)
  }, 180_000)
})

describe.each(TWINS)('one daemon, two Walnuts: a command naming another Walnut ($name)', (twin) => {
  it('is refused on a socket bound to another one; an unbound socket may name any', async () => {
    freshRoot()
    const d = await boot(twin)
    const a = await client(d)
    expect(await rpc(a, { cmd: 'leader.configure', home: HOME_A, walnutId: 'walnuta' })).toMatchObject({ ok: true })
    const foreign = [
      { cmd: 'hooks.configure', home: HOME_B, config: NO_HOOKS },
      { cmd: 'offline.drain', home: HOME_B },
      { cmd: 'offline.ack', home: HOME_B, upTo: 0 },
      { cmd: 'replica.status', home: HOME_B },
      { cmd: 'server.status', home: HOME_B },
      { cmd: 'leader.claim', home: HOME_B },
      { cmd: 'leader.configure', home: HOME_B, walnutId: 'walnutb' },
      { cmd: 'host.slice', home: HOME_B, hash: 'x' },
      { cmd: 'taskdir.ensure', home: HOME_B, taskId: 'task-1' },
    ]
    for (const c of foreign) {
      const r = await rpc(a, c)
      expect(r, c.cmd).toMatchObject({ ok: false, errorKind: 'not_owner' })
      expect(String(r.error), c.cmd).toMatch(/speaks for another Walnut/)
    }
    // Its own Walnut's commands still work.
    expect(await rpc(a, { cmd: 'offline.drain', home: HOME_A })).toMatchObject({ ok: true })
    expect(await rpc(a, { cmd: 'replica.status', home: HOME_A })).toMatchObject({ ok: true })
    // An unbound socket (the bulk channel, an older server before it binds) is not judged.
    const bulk = await client(d)
    expect(await rpc(bulk, { cmd: 'replica.status', home: HOME_B })).toMatchObject({ ok: true })
    expect(await rpc(bulk, { cmd: 'offline.drain', home: HOME_B })).toMatchObject({ ok: true })
  }, 120_000)
})
