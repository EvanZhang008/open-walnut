/**
 * A simulated reboot, on both daemon twins booted for real: a session's task
 * directory, with an unmerged commit and evidence in it, survives the daemon
 * dying and its whole runtime dir (the /tmp of this test) being wiped; the
 * next session for the same task gets the same directory and carries on.
 *
 * Also pinned here, because only a real spawn shows them: the CLI's env holds
 * WALNUT_TASK_DIR exactly when the start names a task (an inherited value is
 * scrubbed), hello reports the root, and taskdir.remove keeps the directory
 * while its commit exists nowhere else, then removes it once pushed.
 *
 * MACHINE SAFETY: HOME is a temp dir (so ~/.local/state is inside it), the
 * daemon dir is a temp path, PATH is pinned to system dirs and SHELL=/bin/sh;
 * the only sessions are /bin/sh scripts that write one file and sleep, in their
 * own process groups, SIGKILLed by group in afterEach. git runs only on repos
 * made here, with a temp HOME and no hooks.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'

let scriptPath = ''
let root = ''
const BUN = [process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, 'bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun']
  .find((p): p is string => !!p && fs.existsSync(p))
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
const CORE = path.resolve(__dirname, '../../src/providers/task-dir-core.ts')
type Twin = { name: string; command: () => [string, string[]] }
// The source twin needs its sidecar, which only bun builds (as scripts/build-daemon.sh does).
const TWINS: Twin[] = BUN ? [
  { name: 'source twin (node)', command: () => [process.execPath, [scriptPath, '--start']] },
  { name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] },
] : []
let proc: ChildProcess | null = null
let ws: WebSocket | null = null
const started: number[] = []

const paths = () => {
  const home = path.join(root, 'home')
  return {
    home,
    // Everything a reboot wipes: the daemon dir and its streams sibling.
    volatile: path.join(root, 'volatile-tmp'),
    daemonDir: path.join(root, 'volatile-tmp', 'open-walnut'),
    taskRoot: path.join(home, '.local', 'state', 'open-walnut', 'tasks'),
  }
}

async function boot(twin: Twin, extraEnv: Record<string, string> = {}): Promise<void> {
  const p = paths()
  fs.mkdirSync(p.home, { recursive: true })
  fs.mkdirSync(p.daemonDir, { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: p.home,
    SHELL: '/bin/sh',
    PATH: '/usr/bin:/bin',
    WALNUT_DAEMON_DIR: p.daemonDir,
    WALNUT_LEGACY_STREAMS_DIR: path.join(root, 'no-legacy-streams'),
    // The test's "remote" lives in the OS temp dir; trust it like a real one.
    WALNUT_TASK_DIR_VOLATILE: '/nonexistent-volatile',
    ...extraEnv,
  }
  // The default root is what is under test, so no override and no XDG dir.
  for (const k of ['NVM_DIR', 'FNM_DIR', 'VOLTA_HOME', 'ASDF_DATA_DIR', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'WALNUT_STREAMS_DIR', 'WALNUT_DAEMON_PARENT_PID', 'WALNUT_TASK_DIR_ROOT']) delete env[k]
  if (!('WALNUT_TASK_DIR' in extraEnv)) delete env.WALNUT_TASK_DIR
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

let nextId = 1
function rpc(frame: Record<string, unknown>, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc ${String(frame.cmd)} timeout`)), timeoutMs)
    const onMessage = (data: Buffer) => {
      let msg: Record<string, unknown>
      try { msg = JSON.parse(data.toString()) } catch { return }
      if (msg.id === id) { clearTimeout(timer); ws!.off('message', onMessage); resolve(msg) }
    }
    ws!.on('message', onMessage)
    ws!.send(JSON.stringify({ id, ...frame }))
  })
}

/** A "CLI" that records the WALNUT_TASK_DIR it was given, then idles like a live CLI. */
async function startSession(sid: string, origin: Record<string, unknown> | undefined, seen: string): Promise<void> {
  const script = `printf '%s' "\${WALNUT_TASK_DIR-unset}" > '${seen}'; exec /bin/sleep 60`
  const reply = await rpc({ cmd: 'start', sid, args: ['/bin/sh', '-c', script], cwd: root, message: 'init\n', ...(origin ? { origin } : {}) })
  expect(reply.ok, JSON.stringify(reply)).toBe(true)
  const pid = Number((reply as { pid?: unknown }).pid ?? (reply as { result?: { pid?: unknown } }).result?.pid)
  expect(pid).toBeGreaterThan(1)
  started.push(pid)
}

async function waitFile(file: string, ms = 15_000): Promise<string> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fs.existsSync(file)) { const t = fs.readFileSync(file, 'utf8'); if (t) return t }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no file ' + file)
}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** The reboot: the daemon and every session die at once, then the volatile dir is gone. */
async function reboot(): Promise<void> {
  try { ws?.close() } catch { /* closed */ }
  ws = null
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise<void>((resolve) => proc!.once('exit', () => resolve()))
    proc.kill('SIGKILL')
    await exited
  }
  proc = null
  for (const pid of started.splice(0)) if (pid > 1 && groupAlive(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
  fs.rmSync(paths().volatile, { recursive: true, force: true })
}

const gitHome = () => path.join(root, 'git-home')
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', '-c', 'core.hooksPath=/dev/null', ...args], {
  cwd, encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: gitHome(), GIT_CONFIG_NOSYSTEM: '1' },
})

beforeAll(() => {
  if (!BUN) return
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-dir-reboot-src-'))
  scriptPath = path.join(dir, 'daemon.cjs')
  fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
  const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(dir, 'task-dir-core.cjs'), CORE], { encoding: 'utf8' })
  if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
})

afterEach(async () => {
  await reboot().catch(() => {})
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = ''
})

describe.each(TWINS)('task directory across a reboot: $name', (twin) => {
  it('keeps the unmerged commit and the evidence, and the next session continues in the same directory', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-dir-reboot-')))
    fs.mkdirSync(gitHome())
    const p = paths()
    const taskId = '7f35f6b1-0000-4000-8000-000000000001'
    const taskDir = path.join(p.taskRoot, taskId)

    await boot(twin)
    const hello = await rpc({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('task-dir-v1')
    expect(hello.taskDirRoot).toBe(p.taskRoot)

    await startSession('reboot-a', { home: '/data/home', task: taskId }, path.join(root, 'seen-1'))
    expect(await waitFile(path.join(root, 'seen-1'))).toBe(taskDir)
    expect(fs.statSync(taskDir).mode & 0o777).toBe(0o700)

    // The session's work: a clone with a commit that exists nowhere else, plus evidence.
    const remote = path.join(root, 'remote.git')
    fs.mkdirSync(remote)
    git(remote, 'init', '--bare', '-q')
    git(taskDir, 'clone', '-q', remote, 'app')
    const app = path.join(taskDir, 'app')
    fs.writeFileSync(path.join(app, 'fix.ts'), 'export const fixed = true\n')
    git(app, 'add', '.')
    git(app, 'commit', '-qm', 'the only copy of this fix')
    fs.mkdirSync(path.join(taskDir, 'evidence'))
    fs.writeFileSync(path.join(taskDir, 'evidence', 'report.md'), '# all green\n')
    const head = git(app, 'rev-parse', 'HEAD').trim()

    await reboot()
    expect(fs.existsSync(p.daemonDir)).toBe(false)

    await boot(twin)
    // Same task, a resumed session: same directory, everything still there.
    await startSession('reboot-b', { home: '/data/home', task: taskId }, path.join(root, 'seen-2'))
    expect(await waitFile(path.join(root, 'seen-2'))).toBe(taskDir)
    expect(git(app, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(git(app, 'log', '-1', '--format=%s').trim()).toBe('the only copy of this fix')
    expect(fs.readFileSync(path.join(taskDir, 'evidence', 'report.md'), 'utf8')).toBe('# all green\n')
    // And the work goes on from where it stopped.
    fs.writeFileSync(path.join(app, 'more.ts'), 'export const more = 1\n')
    git(app, 'add', '.')
    git(app, 'commit', '-qm', 'continued after the reboot')

    const listed = await rpc({ cmd: 'taskdir.list' })
    expect((listed.dirs as Array<{ taskId: string; home?: string }>).map((d) => [d.taskId, d.home])).toEqual([[taskId, '/data/home']])

    // The cleanup keeps it while the commits exist only here, and removes it once they are pushed.
    const kept = await rpc({ cmd: 'taskdir.remove', taskIds: [taskId] })
    expect(kept.removed).toEqual([])
    expect(JSON.stringify(kept.kept)).toMatch(/commits not on any remote|a live session works in it/)
    await reboot()
    await boot(twin)
    expect(((await rpc({ cmd: 'taskdir.remove', taskIds: [taskId] })).kept as Array<{ reasons: string[] }>)[0].reasons)
      .toEqual(['app: commits not on any remote'])
    git(app, 'push', '-q', 'origin', 'HEAD:main')
    git(app, 'fetch', '-q', 'origin')
    const gone = await rpc({ cmd: 'taskdir.remove', taskIds: [taskId] })
    expect(gone.removed).toEqual([taskId])
    expect(fs.existsSync(taskDir)).toBe(false)
  }, 120_000)

  it('a start without a task gets no directory, even when the daemon inherited one', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-task-dir-reboot-')))
    await boot(twin, { WALNUT_TASK_DIR: '/somewhere/another-task' })
    await startSession('no-task', undefined, path.join(root, 'seen'))
    expect(await waitFile(path.join(root, 'seen'))).toBe('unset')
    // taskdir.ensure makes one on demand (a session spawned before its daemon had them).
    const made = await rpc({ cmd: 'taskdir.ensure', taskId: 'late-task', home: '/data/home' })
    expect(made.path).toBe(path.join(paths().taskRoot, 'late-task'))
    expect(fs.existsSync(made.path as string)).toBe(true)
    expect((await rpc({ cmd: 'taskdir.ensure', taskId: '../escape' })).ok).toBe(false)
  }, 60_000)
})
