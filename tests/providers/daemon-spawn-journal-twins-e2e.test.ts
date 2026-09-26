/**
 * The spawn journal, written by both daemon twins booted for real: every CLI a
 * daemon starts gets one line in ~/.open-walnut/local/spawn-journal.jsonl, under
 * the CLI's own session id (from the args when they name it, else from the init
 * line), with the asking Walnut's data dir and task. At startup the older
 * records (per-id marker files, streams captures) are folded in and the marker
 * dir is removed. The external-session scan reads this file, so these lines are
 * what keeps Walnut's own sessions (from any instance on the host) out of the
 * import.
 *
 * MACHINE SAFETY: HOME, the daemon dir, the streams dir and the legacy streams
 * dir are all temp paths, WALNUT_SPAWN_JOURNAL is unset so the default path
 * under the temp HOME is what gets tested, the "CLI" is /bin/sh printing one
 * init line, and the daemon is SIGKILLed after each test.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { readSpawnJournal } from '../../src/providers/external-session-scan-core.js'

let scriptPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
type Twin = { name: string; command: () => [string, string[]] }
const TWINS: Twin[] = [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1

interface Dirs { home: string; streams: string; journal: string; legacy: string }

function makeDirs(): Dirs {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-journal-')))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  return {
    home,
    streams: path.join(root, 'streams'),
    journal: path.join(home, '.open-walnut', 'local', 'spawn-journal.jsonl'),
    legacy: path.join(home, '.open-walnut', 'tmp', 'spawned-sessions'),
  }
}

async function boot(twin: Twin, dirs: Dirs, extraEnv: Record<string, string> = {}): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    HOME: dirs.home,
    WALNUT_DAEMON_DIR: path.join(root, 'daemon'),
    WALNUT_STREAMS_DIR: dirs.streams,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
  }
  delete env.WALNUT_SPAWN_JOURNAL
  Object.assign(env, extraEnv)
  const [cmd, args] = twin.command()
  proc = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('daemon spawn timeout')), 30_000)
    proc!.stdout?.on('data', (chunk) => {
      const m = chunk.toString().trim().match(/^\d+$/m)
      if (m) { clearTimeout(timer); resolve(parseInt(m[0], 10)) }
    })
    proc!.on('error', (err) => { clearTimeout(timer); reject(err) })
    proc!.on('exit', (code) => { clearTimeout(timer); reject(new Error('daemon exited early: ' + code)) })
  })
  ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.on('open', () => resolve(s))
    s.on('error', reject)
  })
}

function rpc(cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const id = rpcId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...cmd }))
  })
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return check()
}

/** A stand-in CLI: prints the init line a real `claude -p` would, then idles. */
function fakeCli(sessionId: string): string {
  return `printf '%s\\n' '{"type":"system","subtype":"init","session_id":"${sessionId}"}'; sleep 20`
}

function start(sid: string, sessionId: string, extraArgs: string[], opts: { resume?: boolean; origin?: unknown } = {}) {
  return rpc({
    cmd: 'start', sid, cwd: root, message: '', mode: 'default',
    args: ['/bin/sh', '-c', fakeCli(sessionId), 'sh', ...extraArgs],
    ...(opts.resume ? { resume: true } : {}),
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
  })
}

const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-spawn-journal-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
})

afterEach(async () => {
  try { ws?.close() } catch { /* already closed */ }
  ws = null
  if (proc && proc.exitCode === null) {
    proc.kill('SIGKILL')
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 2000)
      proc!.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
  proc = null
  // The stand-in CLIs are `sleep`s in their own process groups; they exit on their own.
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('spawn journal: $name', (twin) => {
  it('journals new, forked and resumed sessions under the CLI\'s own id, once each', async () => {
    const dirs = makeDirs()
    await boot(twin, dirs)
    const origin = { home: '/tmp/walnut-ephemeral-x', task: 'task-1' }

    // New: the tmp id never reaches the journal, the init line's id does.
    await start('tmp-new', 'real-new', [], { origin })
    // Fork: the parent is named by --resume, the fork's own id comes from init.
    await start('tmp-fork', 'real-fork', ['--resume', 'parent-1', '--fork-session'], { origin })
    // Resume: the args name the id, so it is journaled at start; init repeats it.
    await start('res-1', 'res-1', ['--resume', 'res-1'], { resume: true })
    // Garbage origin is dropped, not recorded.
    await start('tmp-odd', 'real-odd', [], { origin: { home: 42, task: 'x'.repeat(500) } })

    const ids = () => new Set(lines(dirs.journal).map((l) => l.sid))
    expect(await waitFor(() => fs.existsSync(dirs.journal) && ['real-new', 'real-fork', 'res-1', 'real-odd'].every((id) => ids().has(id)))).toBe(true)

    const all = lines(dirs.journal)
    expect(all.map((l) => l.sid).sort()).toEqual(['real-fork', 'real-new', 'real-odd', 'res-1'])
    const byId = readSpawnJournal(dirs.journal)
    expect(byId.get('real-new')).toMatchObject({ kind: 'new', home: origin.home, task: 'task-1' })
    expect(byId.get('real-fork')).toMatchObject({ kind: 'fork', parent: 'parent-1', home: origin.home })
    expect(byId.get('res-1')).toMatchObject({ kind: 'resume' })
    expect(byId.get('real-odd')).toEqual(expect.objectContaining({ kind: 'new' }))
    expect(byId.get('real-odd')!.home).toBeUndefined()
    expect(byId.get('real-odd')!.task).toBeUndefined()
    for (const line of all) {
      expect(line.v).toBe(1)
      expect(Number.isNaN(Date.parse(line.at))).toBe(false)
      expect(line.cwd).toBe(root)
    }
    expect((fs.statSync(dirs.journal).mode & 0o777).toString(8)).toBe('600')
  }, 60_000)

  it('folds the marker files and streams captures in at startup, then removes the marker dir', async () => {
    const dirs = makeDirs()
    fs.mkdirSync(dirs.legacy, { recursive: true })
    for (const id of ['old-1', 'old-2', 'known-1']) fs.writeFileSync(path.join(dirs.legacy, id), '')
    fs.mkdirSync(dirs.streams, { recursive: true })
    fs.writeFileSync(path.join(dirs.streams, 'str-9.jsonl'), '')
    fs.writeFileSync(path.join(dirs.streams, 'str-9.jsonl.err'), '')
    // An existing journal: one real line, then a torn tail from a writer that died.
    fs.mkdirSync(path.dirname(dirs.journal), { recursive: true })
    fs.writeFileSync(dirs.journal, JSON.stringify({ v: 1, sid: 'known-1', kind: 'new', home: '/h' }) + '\n{"v":1,"sid":"torn","ki')

    await boot(twin, dirs)

    const byId = readSpawnJournal(dirs.journal)
    expect([...byId.keys()].sort()).toEqual(['known-1', 'old-1', 'old-2', 'str-9'])
    expect(byId.get('known-1')).toEqual({ kind: 'new', home: '/h' })
    expect(byId.get('old-1')).toMatchObject({ kind: 'backfill' })
    expect(byId.get('str-9')).toMatchObject({ kind: 'backfill' })
    // known-1 was not written twice, and the torn line did not swallow a record.
    const text = fs.readFileSync(dirs.journal, 'utf8')
    expect(text.match(/"known-1"/g)).toHaveLength(1)
    expect(fs.existsSync(dirs.legacy)).toBe(false)
  }, 60_000)

  it('a relocated journal leaves the real marker dir alone', async () => {
    // A test daemon runs under the real HOME with WALNUT_SPAWN_JOURNAL pointed at
    // a temp file. Folding the real markers into that file and deleting them
    // lost the real record once (2026-09-26); the markers belong to the default.
    const dirs = makeDirs()
    fs.mkdirSync(dirs.legacy, { recursive: true })
    fs.writeFileSync(path.join(dirs.legacy, 'real-marker'), '')
    const relocated = path.join(root, 'elsewhere', 'spawn-journal.jsonl')

    await boot(twin, dirs, { WALNUT_SPAWN_JOURNAL: relocated })
    await start('tmp-x', 'reloc-1', [])

    expect(await waitFor(() => fs.existsSync(relocated) && readSpawnJournal(relocated).has('reloc-1'))).toBe(true)
    expect(readSpawnJournal(relocated).has('real-marker')).toBe(false)
    expect(fs.existsSync(path.join(dirs.legacy, 'real-marker'))).toBe(true)
    expect(fs.existsSync(dirs.journal)).toBe(false)
  }, 60_000)
})
