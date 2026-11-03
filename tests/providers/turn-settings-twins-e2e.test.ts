/**
 * turns.configure per Walnut (walnut-scope-core.ts) on BOTH daemon twins booted
 * for real: two Walnuts push different turn snapshot settings to one daemon, each
 * lands in its own file, and a session's turn follows its own Walnut's settings
 * (one off, one on); a push with no home (an older server) is the legacy file,
 * marked, and a session with no Walnut follows it.
 *
 * MACHINE SAFETY: HOME, the daemon dir and every repository are temp paths; the
 * "CLI" is /bin/sh; every process is killed after.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-turn-settings-twins-')))
afterAll(() => { if (root.includes('walnut-turn-settings-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
const keyOf = (h: string) => crypto.createHash('sha1').update(h).digest('hex').slice(0, 16)

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
const started: number[] = []
afterEach(async () => {
  for (const pid of started.splice(0)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((r) => { const t = setTimeout(r, 10_000); proc!.once('exit', () => { clearTimeout(t); r() }) })
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
})

async function boot(twin: (typeof TWINS)[number], dir: string): Promise<string> {
  const home = path.join(dir, 'home')
  fs.mkdirSync(home, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'WALNUT_TURN_SNAPSHOTS']) delete env[k]
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    onDaemonEarlyExit(proc!, { daemonDir: env.WALNUT_DAEMON_DIR }, (err) => { clearTimeout(timer); reject(err) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
  return home
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  const sock = ws!
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); sock.off('message', onMessage); resolve(msg) }
    }
    sock.on('message', onMessage)
    sock.send(JSON.stringify({ id, ...cmd }))
  })
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } as NodeJS.ProcessEnv,
  }).trim()
}

function makeRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

const turnRefs = (repo: string, sid: string) => git(repo, 'for-each-ref', '--format=%(refname)', `refs/walnut/turns/${sid}/`).split('\n').filter(Boolean)

async function startTurn(sid: string, repo: string, home?: string): Promise<void> {
  // One turn: a result line on stdout, then the "CLI" waits.
  const script = `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"${sid}"}'; exec /bin/sleep 60`
  const reply = await rpc({ cmd: 'start', sid, args: ['/bin/sh', '-c', script], cwd: repo, message: 'go\n', ...(home ? { origin: { home } } : {}) })
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
  if (pid > 1) started.push(pid)
}

async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) { if (check()) return; await new Promise((r) => setTimeout(r, 100)) }
  throw new Error('condition not met in time')
}

describe.each(TWINS)('$name', (twin) => {
  it("keeps each Walnut's turn snapshot settings apart and applies them by the session's Walnut", async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    await boot(twin, dir)
    const daemonDir = path.join(dir, 'daemon')
    const A = path.join(dir, 'walnut-a')
    const B = path.join(dir, 'walnut-b')
    expect(await rpc({ cmd: 'turns.configure', home: A, enabled: false, keep: 5 })).toMatchObject({ ok: true, enabled: false, keep: 5 })
    expect(await rpc({ cmd: 'turns.configure', home: B, enabled: true, keep: 2 })).toMatchObject({ ok: true, enabled: true, keep: 2 })
    const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'))
    expect(read(path.join(daemonDir, 'walnuts', keyOf(A), 'turn-snapshots.json'))).toEqual({ home: A, enabled: false, keep: 5 })
    expect(read(path.join(daemonDir, 'walnuts', keyOf(B), 'turn-snapshots.json'))).toEqual({ home: B, enabled: true, keep: 2 })
    expect(fs.existsSync(path.join(daemonDir, 'turn-snapshots.json'))).toBe(false)

    // A's session takes no snapshot; B's does.
    const repoA = makeRepo(path.join(dir, 'repos', 'a'))
    const repoB = makeRepo(path.join(dir, 'repos', 'b'))
    fs.writeFileSync(path.join(repoA, 'a.txt'), 'changed\n')
    fs.writeFileSync(path.join(repoB, 'a.txt'), 'changed\n')
    await startTurn('scope-walnut-a-1', repoA, A)
    await startTurn('scope-walnut-b-1', repoB, B)
    await until(() => turnRefs(repoB, 'scope-walnut-b-1').length > 0)
    // Give A's turn the same time it took B's to snapshot, then some.
    await new Promise((r) => setTimeout(r, 1500))
    expect(turnRefs(repoA, 'scope-walnut-a-1')).toEqual([])
    const listedA = await rpc({ cmd: 'turns.list', sid: 'scope-walnut-a-1', cwd: repoA })
    expect(listedA).toMatchObject({ ok: true, enabled: false })

    // An unnamed push (an older server) is the legacy file, marked; a session with no Walnut follows it.
    expect(await rpc({ cmd: 'turns.configure', enabled: false, keep: 9 })).toMatchObject({ ok: true, enabled: false, keep: 9 })
    expect(read(path.join(daemonDir, 'turn-snapshots.json'))).toEqual({ scoped: 1, enabled: false, keep: 9 })
    const repo0 = makeRepo(path.join(dir, 'repos', 'unnamed'))
    fs.writeFileSync(path.join(repo0, 'a.txt'), 'changed\n')
    await startTurn('scope-unnamed-1', repo0)
    await new Promise((r) => setTimeout(r, 1500))
    expect(turnRefs(repo0, 'scope-unnamed-1')).toEqual([])
    // B's settings stayed B's through both other pushes.
    expect(read(path.join(daemonDir, 'walnuts', keyOf(B), 'turn-snapshots.json'))).toEqual({ home: B, enabled: true, keep: 2 })
  }, 90_000)
})
