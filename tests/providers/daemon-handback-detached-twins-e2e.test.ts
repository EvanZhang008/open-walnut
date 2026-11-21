/**
 * `walnut daemon handback` with a detached host_exec run in flight, on BOTH real twins.
 *
 * The stand-in an update's tail started outside launchd hands back to the LaunchAgent's job
 * (daemon-service-handback.ts): it is asked to prepare an update (`service.update`, carrying the
 * CLI's ADOPTED_WORK_CAPABILITIES as `adopts`), it exits, the job is kickstarted, and that job's
 * daemon adopts what runs detached. A detached run (exec.run `detach: true`, detached-run.ts) must
 * come out of that followed by the job's daemon to its real end: never ended as a rollback, never
 * left running with no daemon following it, never started a second time.
 *
 * The real handback module and the real `service.update` request run here; only launchd is faked:
 * `kickstart` starts the next `--service` daemon on the same runtime and state dirs, as launchd's
 * job would, and the platform is 'darwin' so the module runs on Linux too.
 *
 * MACHINE SAFETY: every dir is under this file's temp dir, each daemon's PATH has the exec guard
 * first, the run is an sh loop that ends by itself after 2 minutes at most, and the only signals go
 * to the process groups of this file's own children (pid > 1).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { WebSocket } from 'ws'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { handBackStandIn } from '../../src/providers/daemon-service-handback.js'
import { daemonReady, requestDaemonServiceUpdate } from '../../src/providers/daemon-service-cli.js'
import { ADOPTS_FILE, ROLLBACK_NOTE } from '../../src/providers/detached-registry.js'
import { STANDIN_PID_NAME } from '../../src/providers/daemon-update-standin.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-handback-detached-')))
afterAll(() => { if (root.includes('walnut-handback-detached-')) fs.rmSync(root, { recursive: true, force: true }) })
const script = path.join(root, 'daemon.cjs')
fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
const BUN = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
// The source twin finds its sidecars next to it, as deployed: a --service daemon needs the cron
// runtime and the instance lock, a detached run the host_exec core.
if (BUN) {
  for (const name of ['task-dir-core', 'host-exec-core', 'daemon-cron-runtime', 'daemon-instance-lock']) {
    const built = spawnSync(BUN, ['build', '--target=node', '--format=cjs', '--outfile', path.join(root, `${name}.cjs`),
      path.resolve(__dirname, `../../src/providers/${name}.ts`)], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error('sidecar build failed: ' + built.stderr)
  }
}
const TWINS: Array<[string, () => { executable: string; args: string[] }]> = BUN ? [
  [`source twin (${SOURCE_TWIN.runtime})`, () => ({ executable: SOURCE_TWIN.file, args: [script, '--service'] })],
  ['standalone twin (bun)', () => ({ executable: BUN, args: [STANDALONE, '--service'] })],
] : []

const children: ChildProcess[] = []
const groups = new Set<number>()
const sockets: WebSocket[] = []
afterEach(() => {
  for (const s of sockets.splice(0)) { try { s.terminate() } catch { /* closed */ } }
  // Only this test's own child groups (the daemons and the run), and only while they still run.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && typeof child.pid === 'number' && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
  }
  for (const g of [...groups]) { groups.delete(g); if (g > 1) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } } }
})

async function until<T>(f: () => T | Promise<T>, ok: (v: T) => boolean, ms = 60_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await f()
    if (ok(v) || Date.now() > end) return v
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** A client of the daemon on `port`: rpc(cmd) answers its reply. */
async function connect(port: number) {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}`)
    s.once('open', () => resolve(s))
    s.once('error', reject)
  })
  sockets.push(ws)
  let n = 0
  return (cmd: Record<string, unknown>, ms = 30_000): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const id = ++n
    const timer = setTimeout(() => reject(new Error('rpc timeout: ' + String(cmd.cmd))), ms)
    const receive = (raw: Buffer) => {
      let m: Record<string, unknown>
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (m.id === id) { clearTimeout(timer); ws.off('message', receive); resolve(m) }
    }
    ws.on('message', receive)
    ws.once('close', () => { clearTimeout(timer); reject(new Error('socket closed: ' + String(cmd.cmd))) })
    ws.send(JSON.stringify({ id, ...cmd }))
  })
}

/** Whether a process still runs (a zombie waiting for its reaper does not). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0) } catch { return false }
  try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return true }
}

describe.skipIf(!BUN)('handback with a detached host_exec run in flight', () => {
  it.each(TWINS)('%s: the job\'s daemon follows the run to its end, which ran once', async (_name, twin) => {
    const t = fs.mkdtempSync(path.join(root, 'case-'))
    const dir = (name: string) => path.join(t, name)
    for (const name of ['h', 'tmp']) fs.mkdirSync(dir(name))
    const runtimeDir = dir('d')
    const stateDir = dir('s')
    const env: Record<string, string> = {
      HOME: dir('h'), PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C', SHELL: '/bin/sh',
      WALNUT_DAEMON_DIR: runtimeDir, WALNUT_DAEMON_STATE_DIR: stateDir, WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'),
      WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'), WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'),
      XDG_STATE_HOME: path.join(dir('h'), '.local', 'state'), XDG_CONFIG_HOME: path.join(dir('h'), '.config'),
      XDG_CACHE_HOME: path.join(dir('h'), '.cache'), XDG_DATA_HOME: path.join(dir('h'), '.local', 'share'),
    }
    const start = () => {
      const { executable, args } = twin()
      const child = spawn(executable, args, { cwd: dir('h'), env, detached: true, stdio: 'ignore' })
      children.push(child)
      return child
    }
    const read = (name: string) => (fs.existsSync(path.join(runtimeDir, name)) ? fs.readFileSync(path.join(runtimeDir, name), 'utf8').trim() : '')
    const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null
    const serving = (child: ChildProcess) => Number(read('daemon.pid')) === child.pid && !!read('daemon.port') && !!read('daemon.instance')

    // The stand-in serves the dir (daemon-update-standin.ts names it in daemon.standin).
    const standIn = start()
    expect(await until(() => serving(standIn), (v) => v)).toBe(true)
    fs.writeFileSync(path.join(runtimeDir, STANDIN_PID_NAME), `${standIn.pid}\n`)
    const standInInstance = read('daemon.instance')

    // A detached run on it: it counts its lines until the test lets it end, and marks each start.
    const go = dir('go')
    const starts = dir('starts')
    const jobId = 'hx-handback-detached-01'
    const taskId = 'handback-detached-task'
    const command = `echo start >> '${starts}'; i=0; while [ ! -e '${go}' ] && [ $i -lt 600 ]; do i=$((i+1)); echo line-$i; sleep 0.2; done; echo done; exit 7`
    const askStandIn = await connect(Number(read('daemon.port')))
    const started = await askStandIn({ cmd: 'exec.run', jobId, taskId, command, cwd: '~', background: true, endGroup: true, detach: true, caller: { task: taskId, host: 'devbox' } })
    expect(started).toMatchObject({ ok: true, running: true, detached: true })
    const audit = () => (fs.existsSync(path.join(stateDir, 'host-exec', 'host-exec-audit.jsonl'))
      ? fs.readFileSync(path.join(stateDir, 'host-exec', 'host-exec-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : []).filter((l) => l.jobId === jobId)
    const spawned = await until(() => audit().find((l) => l.event === 'spawned'), (v) => !!v, 10_000)
    const wrapper = Number(spawned?.pid)
    expect(wrapper).toBeGreaterThan(1)
    groups.add(wrapper)
    await until(() => askStandIn({ cmd: 'exec.read', jobId, taskId }), (r) => String(r.output ?? '').includes('line-3\n'), 20_000)

    // The handback, with launchd faked: kickstart starts the job's daemon on the same dirs.
    let job: ChildProcess | undefined
    let standInGoneAtKickstart = false
    const notes: string[] = []
    const result = await handBackStandIn({
      platform: 'darwin', runtimeDir,
      ours: async () => true,
      spawns: async () => 'ok',
      prepareUpdate: () => requestDaemonServiceUpdate(runtimeDir, stateDir, { note: (text) => notes.push(text) }),
      job: async () => ({ runs: 1 }),
      kickstart: async () => {
        standInGoneAtKickstart = !alive(standIn.pid!)
        // A launcher removes `adopts` before it starts any version; the job's daemon writes it again.
        fs.rmSync(path.join(stateDir, 'detached', ADOPTS_FILE), { force: true })
        job = start()
      },
      ready: (previous) => daemonReady(runtimeDir, undefined, 60_000, previous),
      alive,
    })
    expect(result, JSON.stringify({ result, notes })).toEqual({ ok: true, message: "the stand-in handed over, and launchd's job serves" })

    // The stand-in exited before the job started; the job's daemon serves the dir.
    expect(standInGoneAtKickstart).toBe(true)
    expect(await until(() => exited(standIn), (v) => v, 10_000)).toBe(true)
    expect(job).toBeDefined()
    expect(exited(job!)).toBe(false)
    expect(Number(read('daemon.pid'))).toBe(job!.pid)
    expect(read('daemon.instance')).not.toBe(standInInstance)
    expect(fs.existsSync(path.join(runtimeDir, STANDIN_PID_NAME))).toBe(false)
    // The job's daemon said which kinds it adopts, host_exec runs among them.
    const adopts = await until(() => fs.existsSync(path.join(stateDir, 'detached', ADOPTS_FILE)), (v) => v, 20_000)
    expect(adopts).toBe(true)
    expect(fs.readFileSync(path.join(stateDir, 'detached', ADOPTS_FILE), 'utf8').split('\n')).toContain('host-exec')

    // The run went on through the swap, and the job's daemon follows it: running, never ended.
    expect(alive(wrapper)).toBe(true)
    const askJob = await connect(Number(read('daemon.port')))
    const during = await askJob({ cmd: 'exec.read', jobId, taskId })
    expect(during).toMatchObject({ ok: true, running: true })
    expect(during.daemonEnded).toBeUndefined()

    // Let it end: the job's daemon reads its real exit code and its whole output.
    fs.writeFileSync(go, '')
    const end = await until(() => askJob({ cmd: 'exec.read', jobId, taskId, wait: 5_000 }), (r) => r.running === false, 30_000)
    expect(end).toMatchObject({ ok: true, running: false, exitCode: 7 })
    expect(end.daemonEnded).toBeUndefined()
    const output = String(end.output)
    expect(output).not.toContain(ROLLBACK_NOTE)
    const lines = output.trim().split('\n')
    expect(lines.at(-1)).toBe('done')
    const counted = lines.slice(0, -1)
    expect(counted.length).toBeGreaterThan(3)
    expect(counted).toEqual(Array.from({ length: counted.length }, (_, i) => `line-${i + 1}`))

    // Ran once: one start of the command, one spawn, one end line (written by the job's daemon).
    expect(fs.readFileSync(starts, 'utf8')).toBe('start\n')
    const lines2 = await until(() => audit(), (a) => a.some((l) => l.event === 'end'), 10_000)
    expect(lines2.filter((l) => l.event === 'start')).toHaveLength(1)
    expect(lines2.filter((l) => l.event === 'spawned')).toHaveLength(1)
    const ends = lines2.filter((l) => l.event === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ exitCode: 7 })
    expect(lines2.filter((l) => l.event === 'ended-by-update')).toEqual([])
    // The job's daemon adopted it (and no other daemon did).
    expect(lines2.filter((l) => l.event === 'adopted').map((l) => l.daemonPid)).toEqual([job!.pid])
    expect(await until(() => alive(wrapper), (v) => !v, 10_000)).toBe(false)
  }, 240_000)
})
