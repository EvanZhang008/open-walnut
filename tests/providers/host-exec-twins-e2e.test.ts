/**
 * exec.run / exec.read / exec.kill (host-exec-v1, src/providers/host-exec-core.ts)
 * on BOTH daemon twins booted for real: the capability is advertised, a command
 * runs in the login shell with its exit code and output, argv runs with no shell
 * parsing, the log lands in the task's directory, a refusal comes back with its
 * code, a deadline stops the whole process group, a background job is read and
 * stopped (only by the task that started it), a process that left the group does
 * not hold the run open, and every run is in the audit file; host-exec-group-v1 ends a run's group
 * only when asked (`endGroup`); host-exec-wait-v1's
 * exec.read `until` waits for a line, tested in a matcher process each twin starts as its own
 * program (a runaway pattern kills that process, never the daemon's loop), and a wait_for that
 * could never hold is refused.
 *
 * MACHINE SAFETY: HOME, the daemon dir and the task root are temp paths; the
 * commands are /bin/sh builtins and sleep; the daemon is SIGKILLed after each twin.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'
import { onDaemonEarlyExit } from '../helpers/daemon-early-exit.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-exec-twins-')))
afterAll(() => { if (root.includes('walnut-host-exec-twins-')) fs.rmSync(root, { recursive: true, force: true }) })
const scriptPath = path.join(root, 'daemon.cjs')
fs.writeFileSync(scriptPath, getDaemonSource(), { mode: 0o755 })
const BUN: string | undefined = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds both sidecars next to it, as deployed.
if (BUN) {
  for (const name of ['task-dir-core', 'host-exec-core']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<{ name: string; command: () => [string, string[]] }> = [
  { name: `source twin (${SOURCE_TWIN.runtime})`, command: () => [SOURCE_TWIN.file, [scriptPath, '--start']] },
  ...(BUN ? [{ name: 'standalone twin (bun)', command: (): [string, string[]] => [BUN, [STANDALONE, '--start']] }] : []),
]

let proc: ChildProcess | null = null
let ws: WebSocket | null = null
let rpcId = 1
afterEach(async () => {
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
    // The exec guard's dir leads, so a stray ssh/scp is caught, never the real one.
    ...process.env, SHELL: '/bin/sh', PATH: guardedPath([], '/usr/bin:/bin'), HOME: home, WALNUT_HOME_OVERRIDE: home,
    WALNUT_DAEMON_DIR: path.join(dir, 'daemon'), WALNUT_STREAMS_DIR: path.join(dir, 'streams'),
    WALNUT_LEGACY_STREAMS_DIR: path.join(dir, 'no-legacy'), WALNUT_SPAWN_JOURNAL: path.join(dir, 'spawn-journal.jsonl'),
    WALNUT_TASK_DIR_ROOT: path.join(dir, 'state', 'tasks'),
  }
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[k]
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

describe.each(TWINS)('$name', (twin) => {
  it('runs a command for another host and keeps its log and audit', async () => {
    const dir = path.join(root, twin.name.replace(/\W+/g, '-'))
    const home = await boot(twin, dir)
    const hello = await rpc({ cmd: 'hello' })
    expect(hello.capabilities as string[]).toContain('host-exec-v1')

    const taskId = 'task-hx-1'
    const r = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-one', taskId, command: 'echo out; echo err >&2; exit 3', cwd: '~', caller: { task: taskId, host: 'devbox' } })
    expect(r).toMatchObject({ ok: true, jobId: 'hx-twin-one', running: false, exitCode: 3, timedOut: false, cwd: fs.realpathSync(home) })
    expect(String(r.output)).toContain('out\n')
    expect(String(r.output)).toContain('err\n')
    expect(r.logFile).toBe(path.join(dir, 'state', 'tasks', taskId, 'host-exec', 'hx-twin-one.log'))
    expect(fs.readFileSync(String(r.logFile), 'utf8')).toContain('out')

    // argv: one argument with spaces and quotes, never parsed by the shell.
    const a = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-argv', taskId, argv: ['printf', '%s|', "a b; echo pwned", "it's"] })
    expect(a).toMatchObject({ ok: true, exitCode: 0, output: "a b; echo pwned|it's|" })

    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-twin-gone', taskId, command: 'true', cwd: '/no/such/dir' }))
      .toMatchObject({ ok: false, code: 'cwd_missing', error: expect.stringMatching(/^exec\.run failed: /) })
    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-twin-both', taskId, command: 'true', argv: ['true'] }))
      .toMatchObject({ ok: false, code: 'bad_request' })

    // A deadline stops the whole group: the child sleep goes too.
    const t0 = Date.now()
    const slow = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-slow', taskId, command: 'sleep 30 & sleep 30; echo never', timeoutMs: 800 })
    expect(slow).toMatchObject({ ok: true, running: false, timedOut: true })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(String(slow.output)).not.toContain('never')

    // Background: read with a wait, then a second job stopped.
    const bg = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-bg', taskId, command: 'echo one; sleep 1; echo two', background: true })
    expect(bg).toMatchObject({ ok: true, running: true })
    const done = await rpc({ cmd: 'exec.read', jobId: 'hx-twin-bg', offset: 0, wait: 15_000 })
    expect(done).toMatchObject({ ok: true, running: false, exitCode: 0, output: 'one\ntwo\n', offset: 0 })
    const long = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-long', taskId, command: 'sleep 60', background: true })
    expect(long.running).toBe(true)
    expect(await rpc({ cmd: 'exec.kill', jobId: 'hx-twin-long' })).toMatchObject({ ok: true, jobId: 'hx-twin-long' })
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-twin-long', wait: 15_000 })).toMatchObject({ ok: true, running: false, killed: true })
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-nope-0000' })).toMatchObject({ ok: false, code: 'unknown_job' })
    // Only the task that started a job reads or stops it.
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-twin-bg', taskId: 'task-someone-else' })).toMatchObject({ ok: false, code: 'unknown_job' })
    expect(await rpc({ cmd: 'exec.kill', jobId: 'hx-twin-bg', taskId: 'task-someone-else' })).toMatchObject({ ok: false, code: 'unknown_job' })
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-twin-bg', taskId })).toMatchObject({ ok: true, running: false })

    // A process left in the shell's group holds the pipes: the shell's exit ends the job and stops it.
    const t2 = Date.now()
    const left = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-left', taskId, command: 'sleep 30 & echo started', timeoutMs: 60_000 })
    expect(left).toMatchObject({ ok: true, running: false, exitCode: 0, output: 'started\n' })
    expect(Date.now() - t2).toBeLessThan(6_000)
    // A process that left the group keeps the pipes open; the shell's exit still ends the job.
    if (spawnSync('perl', ['-e', '1']).status === 0) {
      const t1 = Date.now()
      const esc = await rpc({ cmd: 'exec.run', jobId: 'hx-twin-esc', taskId, command: "perl -MPOSIX -e 'POSIX::setsid(); exec q(sleep), 6' & echo started", timeoutMs: 30_000 })
      expect(esc).toMatchObject({ ok: true, running: false, exitCode: 0, output: 'started\n' })
      expect(Date.now() - t1).toBeLessThan(5_000)
    }

    const audit = fs.readFileSync(path.join(dir, 'daemon', 'host-exec', 'host-exec-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(audit.find((e) => e.jobId === 'hx-twin-one' && e.event === 'start')).toMatchObject({ task: taskId, host: 'devbox', command: 'echo out; echo err >&2; exit 3' })
    expect(audit.find((e) => e.jobId === 'hx-twin-one' && e.event === 'end')).toMatchObject({ exitCode: 3 })
  }, 90_000)

  it('host-exec-v2: the line in bash with WALNUT_TASK_DIR, a taken id refused, the jobs listed by task', async () => {
    const dir = path.join(root, `${twin.name.replace(/\W+/g, '-')}-v2`)
    await boot(twin, dir)
    expect((await rpc({ cmd: 'hello' })).capabilities as string[]).toContain('host-exec-v2')
    const taskId = 'task-hx-v2'
    const taskDir = path.join(dir, 'state', 'tasks', taskId)
    const r = await rpc({ cmd: 'exec.run', jobId: 'hx-v2-one', taskId, home: '/data/walnut-home', command: 'echo ===; [ -n "$BASH_VERSION" ] && echo bash; printf %s "$WALNUT_TASK_DIR"' })
    expect(r).toMatchObject({ ok: true, exitCode: 0, output: `===\nbash\n${taskDir}`, shell: 'bash', loginShell: 'sh', taskDir, taskId, blocked: null })
    expect(r.logFile).toBe(path.join(taskDir, 'host-exec', 'hx-v2-one.log'))
    expect(JSON.parse(fs.readFileSync(path.join(taskDir, '.walnut-task.json'), 'utf8'))).toMatchObject({ taskId, home: '/data/walnut-home' })
    // The caller chose the id: a second run under it is refused, whoever asks.
    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-v2-one', taskId, command: 'echo again' })).toMatchObject({ ok: false, code: 'job_exists' })
    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-v2-other', taskId: 'task-hx-other', command: 'true' })).toMatchObject({ ok: true, exitCode: 0 })
    const mine = await rpc({ cmd: 'exec.list', taskId })
    expect(mine.jobs).toMatchObject([{ jobId: 'hx-v2-one', taskId, running: false, exitCode: 0, command: expect.stringContaining('echo ===') }])
    expect(((await rpc({ cmd: 'exec.list' })).jobs as Array<{ jobId: string }>).map((j) => j.jobId).sort()).toEqual(['hx-v2-one', 'hx-v2-other'])
  }, 60_000)

  it('host-exec-wait-v1: exec.read until answers at the line, and refuses a bad pattern', async () => {
    const dir = path.join(root, `${twin.name.replace(/\W+/g, '-')}-wait`)
    await boot(twin, dir)
    expect((await rpc({ cmd: 'hello' })).capabilities as string[]).toContain('host-exec-wait-v1')
    const taskId = 'task-hx-wait'
    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-wait-one', taskId, command: 'sleep 0.5; echo "listening on :4000"; sleep 30', background: true })).toMatchObject({ ok: true, running: true })
    const t0 = Date.now()
    const hit = await rpc({ cmd: 'exec.read', jobId: 'hx-wait-one', taskId, wait: 15_000, until: { output: 'listening on :\\d+' } })
    expect(hit).toMatchObject({ ok: true, running: true, waitedFor: { matched: 'output', match: 'listening on :4000' } })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-wait-one', taskId, until: { output: '(a+)+$' } })).toMatchObject({ ok: false, code: 'bad_request' })
    // An alternation one group down repeats as badly (2026-11-04 review): refused by this twin's own check too.
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-wait-one', taskId, until: { output: '((a|a)b)*c' } })).toMatchObject({ ok: false, code: 'bad_request' })
    // A file under a task directory this host does not have for the run: refused before anything runs.
    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-wait-nodir', command: 'echo never', background: true, until: { file: '$WALNUT_TASK_DIR/ready' } })).toMatchObject({ ok: false, code: 'task_dir_unset' })
    expect(((await rpc({ cmd: 'exec.list' })).jobs as Array<{ jobId: string }>).map((j) => j.jobId)).not.toContain('hx-wait-nodir')
    expect(await rpc({ cmd: 'exec.kill', jobId: 'hx-wait-one', taskId })).toMatchObject({ ok: true })
  }, 60_000)

  it('host-exec-group-v1: exec.run endGroup stops what the shell left in its group; without it a redirected child runs on, as before', async () => {
    // Code review 6, item 2: the server asks on each run, so a daemon that updates under an older server keeps the older behaviour.
    const dir = path.join(root, `${twin.name.replace(/\W+/g, '-')}-group`)
    await boot(twin, dir)
    expect((await rpc({ cmd: 'hello' })).capabilities as string[]).toContain('host-exec-group-v1')
    const taskId = 'task-hx-group'
    const ended = await rpc({ cmd: 'exec.run', jobId: 'hx-group-end', taskId, command: 'sleep 65 > /dev/null 2>&1 & echo "child $!"', endGroup: true })
    expect(ended).toMatchObject({ ok: true, exitCode: 0, leftBehind: true })
    expect(String(ended.leftCommands)).toContain('sleep 65')
    const kept = await rpc({ cmd: 'exec.run', jobId: 'hx-group-keep', taskId, command: 'sleep 66 > /dev/null 2>&1 & echo "child $!"' })
    expect(kept).toMatchObject({ ok: true, exitCode: 0, leftBehind: false })
    const pid = Number(/child (\d+)/.exec(String(kept.output))?.[1])
    expect(pid).toBeGreaterThan(1)
    try {
      expect(() => process.kill(pid, 0)).not.toThrow()
    } finally {
      if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    }
  }, 60_000)

  it('host-exec-wait-v1: lines are tested in a matcher process of the daemon, which a runaway pattern loses while the daemon answers on', async () => {
    // 2026-11-04 review: patterns the static check passed held the daemon's loop 3 to 6 s a line.
    const dir = path.join(root, `${twin.name.replace(/\W+/g, '-')}-matcher`)
    await boot(twin, dir)
    const taskId = 'task-hx-matcher'
    expect(await rpc({ cmd: 'exec.run', jobId: 'hx-matcher-one', taskId, command: "printf '\\033[32mready\\033[0m on 4000\\n'; printf '%020000d\\n' 0; sleep 30", background: true })).toMatchObject({ ok: true, running: true })
    const hit = await rpc({ cmd: 'exec.read', jobId: 'hx-matcher-one', taskId, wait: 15_000, until: { output: 'READY on \\d+', flags: 'i' } })
    expect(hit).toMatchObject({ ok: true, waitedFor: { matched: 'output', match: 'ready on 4000' } })
    // The matcher is this daemon's child, run as this twin's own program.
    const children = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'args='], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout.split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((m): m is RegExpMatchArray => m !== null && Number(m[2]) === proc!.pid)
    const matcher = children.find((m) => /--wait-matcher|runWaitMatcher/.test(m[3]!))
    expect(matcher, children.map((m) => m[3]).join('\n')).toBeDefined()
    // Cubic on the 20 000-character line: stopped at its limit, and the daemon answered all the while.
    const t0 = Date.now()
    const slow = rpc({ cmd: 'exec.read', jobId: 'hx-matcher-one', taskId, wait: 15_000, scanFrom: hit.waitedFor && (hit.waitedFor as { scanned: number }).scanned, until: { output: '0.*0.*0.*x' } })
    await new Promise((r) => setTimeout(r, 100))
    const h0 = Date.now()
    expect(await rpc({ cmd: 'hello' })).toMatchObject({ ok: true })
    expect(Date.now() - h0).toBeLessThan(1_000)
    expect(await slow).toMatchObject({ ok: true, running: true, waitedFor: { matched: null, tooSlow: true } })
    expect(Date.now() - t0).toBeLessThan(10_000)
    // That process is gone; the next wait gets a new one.
    const matcherPid = Number(matcher![1])
    let gone = false
    for (let i = 0; i < 20 && !gone; i++) { try { process.kill(matcherPid, 0) } catch { gone = true }; if (!gone) await new Promise((r) => setTimeout(r, 100)) }
    expect(gone).toBe(true)
    expect(await rpc({ cmd: 'exec.read', jobId: 'hx-matcher-one', taskId, wait: 5_000, until: { output: '^ready' } })).toMatchObject({ waitedFor: { matched: 'output' } })
    expect(await rpc({ cmd: 'exec.kill', jobId: 'hx-matcher-one', taskId })).toMatchObject({ ok: true })
  }, 60_000)
})
