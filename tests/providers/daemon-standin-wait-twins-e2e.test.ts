/**
 * A --service daemon whose runtime dir a stand-in holds (daemon-update-standin.ts, its pid in
 * daemon.standin) waits for the handback instead of exiting, in BOTH real twins. 2026-11-04
 * review: it exited ("An existing daemon owns this runtime directory"), so launchd's KeepAlive
 * started the job again every 5 s, and a job that never stays up reads as inactive: every later
 * update was refused as serviceInactive while the stand-in served.
 *
 * MACHINE SAFETY: each daemon's dirs are under this file's temp dir, its PATH has the exec
 * guard first, and the test signals only the process groups of its own children.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { guardedPath } from '../setup/exec-guard.js'
import { testBun } from '../helpers/bun-runtime.js'
import { SOURCE_TWIN } from '../helpers/source-twin.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-standin-wait-')))
afterAll(() => { if (root.includes('walnut-standin-wait-')) fs.rmSync(root, { recursive: true, force: true }) })
const script = path.join(root, 'daemon.cjs')
fs.writeFileSync(script, getDaemonSource(), { mode: 0o755 })
const BUN = testBun()
const STANDALONE = path.resolve(__dirname, '../../src/providers/daemon-standalone.ts')
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
afterEach(() => {
  // Only this test's own child groups, and only while they still run.
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && typeof child.pid === 'number' && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* gone */ }
    }
  }
})

const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
  return ok()
}

describe.skipIf(!BUN)('a --service daemon behind a stand-in', () => {
  it.each(TWINS)('%s waits for the stand-in to go, then serves; behind any other daemon it exits', async (_name, twin) => {
    const t = fs.mkdtempSync(path.join(root, 'case-'))
    const dir = (name: string) => path.join(t, name)
    for (const name of ['h', 'tmp']) fs.mkdirSync(dir(name))
    const env: Record<string, string> = {
      HOME: dir('h'), PATH: guardedPath([], '/usr/bin:/bin'), TMPDIR: dir('tmp'), LANG: 'C',
      WALNUT_DAEMON_DIR: dir('d'), WALNUT_DAEMON_STATE_DIR: dir('s'), WALNUT_STREAMS_DIR: dir('st'), WALNUT_LEGACY_STREAMS_DIR: dir('ls'),
      WALNUT_SPAWN_JOURNAL: dir('sj.jsonl'), WALNUT_JOURNAL_DIR: dir('j'), WALNUT_TASK_DIR_ROOT: dir('t'),
      XDG_STATE_HOME: path.join(dir('h'), '.local', 'state'), XDG_CONFIG_HOME: path.join(dir('h'), '.config'),
      XDG_CACHE_HOME: path.join(dir('h'), '.cache'), XDG_DATA_HOME: path.join(dir('h'), '.local', 'share'),
    }
    const start = (mode = '--service') => {
      const { executable, args } = twin()
      const child = spawn(executable, args.map((a) => (a === '--service' ? mode : a)), { cwd: dir('h'), env, detached: true, stdio: 'ignore' })
      children.push(child)
      return child
    }
    const pidFile = () => Number(fs.existsSync(path.join(dir('d'), 'daemon.pid')) ? fs.readFileSync(path.join(dir('d'), 'daemon.pid'), 'utf8').trim() : 0)
    const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

    // The stand-in serves the dir.
    const standIn = start()
    expect(await until(() => pidFile() === standIn.pid && fs.existsSync(path.join(dir('d'), 'daemon.port')), 30_000)).toBe(true)
    fs.writeFileSync(path.join(dir('d'), 'daemon.standin'), `${standIn.pid}\n`)

    // launchd's job starts: it waits, it neither exits nor takes the dir.
    const job = start()
    await new Promise((r) => setTimeout(r, 4_000))
    expect(exited(job)).toBe(false)
    expect(pidFile()).toBe(standIn.pid)

    // The stand-in goes (its handback): the job's daemon takes the dir and serves.
    process.kill(-standIn.pid!, 'SIGTERM')
    expect(await until(() => pidFile() === job.pid && fs.existsSync(path.join(dir('d'), 'daemon.port')), 30_000)).toBe(true)
    expect(exited(job)).toBe(false)

    // Behind a daemon that is no stand-in, a --service daemon still exits as before.
    fs.rmSync(path.join(dir('d'), 'daemon.standin'), { force: true })
    const other = start()
    expect(await until(() => exited(other), 20_000)).toBe(true)
    expect(pidFile()).toBe(job.pid)

    // A daemon.standin a killed stand-in left, naming a pid a daemon that is no stand-in has now
    // (here an on-demand `--start` one): that is not a stand-in to wait for (2026-11-04 review).
    process.kill(-job.pid!, 'SIGTERM')
    expect(await until(() => exited(job), 20_000)).toBe(true)
    const onDemand = start('--start')
    expect(await until(() => pidFile() === onDemand.pid && fs.existsSync(path.join(dir('d'), 'daemon.port')), 30_000)).toBe(true)
    fs.writeFileSync(path.join(dir('d'), 'daemon.standin'), `${onDemand.pid}\n`)
    const late = start()
    expect(await until(() => exited(late), 20_000)).toBe(true)
    expect(pidFile()).toBe(onDemand.pid)
  }, 120_000)
})
