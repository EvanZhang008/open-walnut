/**
 * The detached update runner (src/providers/daemon-net-update-io.ts runnerScript), run for real in
 * /bin/sh. 2026-11-04 review 5:
 *   - a runner touched update.pid only at its start, so a Mac that slept through the 60 min a
 *     runner may take woke with every later update, revive and stand-in counting it as gone;
 *   - a `walnut daemon update` that hung kept its runner, and so the tail and every later update,
 *     waiting for as long as it lived;
 *   - a build whose probation failed on the host (daemon-update-probation.ts) was run again.
 *
 * MACHINE SAFETY: HOME and the update's dir are under this file's temp dir; uname and systemctl
 * are the stubs (tests/helpers/service-stubs.ts, PATH has nothing else first); the only processes
 * are /bin/sh and the `sleep`s of the commands here, killed after each case.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runnerScript } from '../../src/providers/daemon-net-update-io.js'
import { judgeServiceUpdate } from '../../src/providers/daemon-update-readback.js'
import { daemonInstallRoot } from '../../src/providers/daemon-service-config.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-runner-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
let home: string
let dir: string
let stubs: ServiceStubs
let runner: ChildProcess | null = null
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  dir = path.join(work, 'update')
  fs.mkdirSync(home)
  fs.mkdirSync(dir)
  stubs = createServiceStubs(work, 'Linux')
})
afterEach(() => {
  // The runner's own process group (it runs the command and its watch in it).
  if (runner?.pid) try { process.kill(-runner.pid, 'SIGKILL') } catch { /* gone */ }
  runner = null
  stubs.stop()
})

/** Start the runner as the launcher does (its go already given), in a process group of its own. */
function startRunner(script: string): void {
  fs.writeFileSync(path.join(dir, 'update.sh'), script, { mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'update.go'), '')
  runner = spawn('/bin/sh', [path.join(dir, 'update.sh')], { env: { HOME: home, ...stubs.env }, stdio: 'ignore', detached: true })
}
const done = () => path.join(dir, 'update.done')
const base = () => ({ directory: dir, executable: '/elsewhere/daemon', settleSeconds: 0, latest: path.join(work, 'latest') })

describe('the update runner', () => {
  it('touches update.pid while it runs (its heartbeat), so a sleep that froze it does not read as gone', async () => {
    startRunner(runnerScript({ ...base(), command: 'sleep 4', beatSeconds: 1 }))
    const pidFile = path.join(dir, 'update.pid')
    await vi.waitFor(() => expect(fs.existsSync(pidFile)).toBe(true), { timeout: 5_000 })
    // As old as a runner past its 60 minutes: the next beat makes it fresh again.
    const old = new Date(Date.now() - 2 * 3600_000)
    fs.utimesSync(pidFile, old, old)
    await vi.waitFor(() => expect(Date.now() - fs.statSync(pidFile).mtimeMs).toBeLessThan(60_000), { timeout: 5_000, interval: 200 })
    await vi.waitFor(() => expect(fs.existsSync(done())).toBe(true), { timeout: 15_000 })
  }, 30_000)

  it('ends a try that runs past its time, and still writes its done line', async () => {
    const started = Date.now()
    startRunner(runnerScript({ ...base(), command: 'sleep 60', cliMaxSeconds: 2 }))
    await vi.waitFor(() => expect(fs.existsSync(done())).toBe(true), { timeout: 20_000, interval: 200 })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(fs.readFileSync(done(), 'utf8')).not.toMatch(/^rc=0 /)
    expect(fs.readFileSync(path.join(dir, 'update.err'), 'utf8')).toContain('walnut-update: the try was ended after 2 s')
  }, 30_000)

  it('a try that ends by itself is left to end: its answer and its code stand', async () => {
    startRunner(runnerScript({ ...base(), command: `sh -c 'sleep 1; echo "{\\"ok\\": true}"'`, cliMaxSeconds: 30 }))
    await vi.waitFor(() => expect(fs.existsSync(done())).toBe(true), { timeout: 20_000, interval: 200 })
    expect(fs.readFileSync(done(), 'utf8')).toMatch(/^rc=0 tries=1 /)
    expect(fs.readFileSync(path.join(dir, 'update.out'), 'utf8')).toBe('{"ok": true}\n')
    expect(fs.existsSync(path.join(dir, 'update.ended'))).toBe(false)
  }, 30_000)
})

describe('a build whose probation failed on the host', () => {
  const failed = (build: string, ageSeconds: number) => {
    fs.mkdirSync(daemonInstallRoot('linux', home), { recursive: true })
    // A service is installed: its snapshot would be taken first thing.
    const unit = path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
    fs.mkdirSync(path.dirname(unit), { recursive: true })
    fs.writeFileSync(unit, '[Service]\nExecStart="/opt/walnut/versions/none/open-walnut-daemon" "--service"\n')
    stubs.setLoaded(true, unit)
    fs.writeFileSync(path.join(daemonInstallRoot('linux', home), 'update-probation.failed'), `${build}\n${Math.floor(Date.now() / 1000) - ageSeconds}\nno daemon answered 40 s into the new daemon's probation\n`)
  }
  const ran = () => path.join(work, 'ran')
  const run = () => startRunner(runnerScript({ ...base(), command: `touch '${ran()}'`, build: 'walnut-daemon-bad00001', tail: { scope: 'user', waitSeconds: 1, staySeconds: 0, probationSeconds: 0 } }))

  it('is refused before anything is touched, and the answer holds it the same day', async () => {
    failed('walnut-daemon-bad00001', 60)
    run()
    await vi.waitFor(() => expect(fs.existsSync(done())).toBe(true), { timeout: 20_000, interval: 200 })
    expect(fs.existsSync(ran())).toBe(false)
    expect(fs.existsSync(path.join(dir, 'before.state'))).toBe(false)
    expect(fs.readFileSync(done(), 'utf8')).toBe('rc=refused tries=0 tail=none\n')
    const output = fs.readFileSync(path.join(dir, 'update.out'), 'utf8')
    let thrown: unknown = null
    try { judgeServiceUpdate(output, null) } catch (error) { thrown = error }
    expect(thrown).toMatchObject({ buildFailed: true, stopped: false })
  }, 30_000)

  it.each([['another build', 'walnut-daemon-other0001', 60], ['the same build a day ago', 'walnut-daemon-bad00001', 25 * 3600]] as const)('%s is run as before', async (_what, build, age) => {
    failed(build, age)
    run()
    await vi.waitFor(() => expect(fs.existsSync(done())).toBe(true), { timeout: 20_000, interval: 200 })
    expect(fs.existsSync(ran())).toBe(true)
  }, 30_000)
})
