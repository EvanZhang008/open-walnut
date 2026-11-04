/**
 * This machine's own daemon service (src/providers/local-daemon-service.ts), run for real in
 * /bin/sh against the stand-ins for launchd and systemd (tests/helpers/service-stubs.ts):
 *   - the update runs detached with the tail after it, so a `walnut daemon update` killed
 *     between its bootout and its bootstrap, or a server killed with its whole process group
 *     mid-update, still ends with the LaunchAgent loaded and a daemon answering (2026-11-04
 *     review: it ran as the server's own child);
 *   - a config on disk whose service runs nothing is loaded (launchd) or started (a systemd
 *     unit waiting out a crash) before the server refuses; never while an update's runner
 *     works, and never with no install dir of the service's.
 *
 * MACHINE SAFETY: HOME, the configs and the runtime dir are under this file's temp dir, the
 * runner dirs are /tmp/open-walnut-update.* made here and removed, launchctl, systemctl and
 * uname are the stubs (PATH has nothing else first), the latest marker is a file of this
 * test's. The only processes are /bin/sh, the stubs' `sleep`s (stopped after each case) and
 * one `sh` this test starts in a process group of its own and kills.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_SERVICE_LABEL, daemonInstallRoot, renderDaemonLaunchAgent, renderDaemonSystemdUnit } from '../../src/providers/daemon-service-config.js'
import { LAUNCHED, launcherScript, runnerScript } from '../../src/providers/daemon-net-update-io.js'
import { reviveLocalService, updateLocalService } from '../../src/providers/local-daemon-service.js'
import { KeyedUpdateStore, updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { fakeUpdateRunner } from '../helpers/fake-update-runner.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-local-service-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const GOOD = '/opt/walnut/versions/good-new/open-walnut-daemon'
const TAIL = { waitSeconds: 5, goneSeconds: 2, staySeconds: 1 }

let work: string
let home: string
let marker: string
let stubs: ServiceStubs | null = null
const madeDirs: string[] = []
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  marker = path.join(work, 'latest')
  fs.mkdirSync(home)
})
afterEach(() => {
  stubs?.stop(); stubs = null
  for (const dir of madeDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const env = () => ({ HOME: home, ...stubs!.env })

/** Walnut's config for GOOD (a LaunchAgent or a user unit), with its private install dir. */
function install(platform: 'darwin' | 'linux'): string {
  const stateDir = daemonInstallRoot(platform, home)
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const config = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', `${DAEMON_SERVICE_LABEL}.plist`)
    : path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const c = { platform, home, executable: GOOD, args: ['--service'], runtimeDir: stubs!.runtime, stateDir, path: '/usr/bin:/bin' }
  fs.writeFileSync(config, platform === 'darwin' ? renderDaemonLaunchAgent(c) : renderDaemonSystemdUnit(c, 'user'), { mode: 0o600 })
  return config
}

/** A stand-in for `walnut daemon update`: the bootout of the old job, then `then`. */
function updateCli(then: string): string {
  const cli = path.join(work, 'walnut-cli')
  fs.writeFileSync(cli, ['#!/bin/sh', `launchctl bootout "gui/$(id -u)/${DAEMON_SERVICE_LABEL}"`, then, ''].join('\n'), { mode: 0o755 })
  return cli
}

const waitFor = async (ok: () => boolean, ms = 30_000) => {
  const until = Date.now() + ms
  while (!ok()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe('the local service update runs detached, with the tail after it', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })

  it('a `walnut daemon update` killed between its bootout and its bootstrap: the tail loads the agent again, and says so', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    // The CLI dies right after the bootout, the way a deploy's stop of the server took it.
    const cli = updateCli('kill -9 $$')
    const done = updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 60_000 })
    await expect(done).rejects.toThrow(/gave no answer Walnut could read \(rc=137 tries=1 tail=loaded\).*afterwards on the host: the service was not running after the update, so it was started again, and a daemon answers/)
    expect(stubs!.calls()).toEqual(expect.arrayContaining([`launchctl bootstrap gui/${process.getuid!()} ${config}`]))
    expect(stubs!.daemonUp()).toBe(true)
  }, 60_000)

  it('an update the CLI deferred (launchd starting no jobs, a dark wake) is "deferred": the running daemon was never stopped', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    const cli = path.join(work, 'walnut-cli')
    fs.writeFileSync(cli, ['#!/bin/sh', `echo '{"ok":false,"failure":{"code":"launchdNotSpawning","message":"update deferred: launchd is starting no jobs in this login session now"}}'`, 'exit 1', ''].join('\n'), { mode: 0o755 })
    expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 60_000 })).toBe('deferred')
    expect(stubs!.calls().filter((c) => !c.startsWith('launchctl print'))).toEqual([])
    expect(stubs!.daemonUp()).toBe(true)
  }, 60_000)

  // 2026-11-04 review: only an in-memory note guarded this, so a server restarted by a deploy
  // mid-update started a second runner beside the first.
  it('another update runner at work on this machine: busy, and nothing is started', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    const runner = fakeUpdateRunner('alive', marker)
    const dir = runner.dir
    try {
      const cli = updateCli(`echo started >> '${work}/cli-ran'; echo '{"ok":true}'`)
      expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000 })).toBe('busy')
      expect(fs.existsSync(path.join(work, 'cli-ran'))).toBe(false)
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe(dir)
      // That runner done: the next update goes ahead.
      fs.writeFileSync(path.join(dir, 'update.done'), 'rc=0 tries=1 tail=serving\n')
      expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000 })).toBe('applied')
      expect(fs.readFileSync(path.join(work, 'cli-ran'), 'utf8').trim()).toBe('started')
    } finally { runner.stop() }
  }, 60_000)

  // 2026-11-05 review 6: an update inside the last one's probation took its copies, the only way
  // back from a build that fails late.
  it('the last update\'s probation at work on this machine: busy, and nothing is started until it ends', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    // A probation's process (its script's name on its command line) and its pid in the install root.
    const script = path.join(work, 'daemon-probation.sh')
    fs.writeFileSync(script, 'sleep 120\n:\n', { mode: 0o700 })
    const probation = spawn('/bin/sh', [script], { stdio: 'ignore', detached: true })
    probation.unref()
    const copies = path.join(daemonInstallRoot('darwin', home), 'update-before')
    fs.mkdirSync(copies, { recursive: true })
    fs.writeFileSync(path.join(copies, 'probation.pid'), `${probation.pid}\n`)
    try {
      const cli = updateCli(`echo started >> '${work}/cli-ran'; echo '{"ok":true}'`)
      expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000 })).toBe('busy')
      expect(fs.existsSync(path.join(work, 'cli-ran'))).toBe(false)
      expect(stubs!.calls().filter((c) => !c.startsWith('launchctl print'))).toEqual([])
      // Its end: the next update goes ahead.
      process.kill(-probation.pid!, 'SIGKILL')
      await waitFor(() => { try { process.kill(probation.pid!, 0); return false } catch { return true } })
      expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000 })).toBe('applied')
      expect(fs.readFileSync(path.join(work, 'cli-ran'), 'utf8').trim()).toBe('started')
    } finally {
      if (probation.pid && probation.pid > 1) try { process.kill(-probation.pid, 'SIGKILL') } catch { /* gone */ }
    }
  }, 60_000)

  // 2026-11-04 review: a live pid was all it took, so a dead runner's pid reused by another
  // process held every later update on this machine for as long as that process lived.
  it('a live pid that is not that dir\'s runner (a reused pid) is no runner: the update goes ahead', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    const runner = fakeUpdateRunner('reused', marker)
    try {
      const cli = updateCli(`echo '{"ok":true}'`)
      expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000 })).toBe('applied')
    } finally { runner.stop() }
  }, 60_000)

  // 2026-11-04 review 4: this machine's update kept nothing, so a server restarted mid-update (a
  // deploy) had no hold and no cooldown: it stopped the healthy daemon once more for a build that
  // had just failed, and never read or removed the runner's dir.
  it('the record is kept from the launch: a server restarted mid-update reads it back first, holds a build that failed, and removes its dir', async () => {
    const file = path.join(work, 'unread.json')
    const holds = path.join(work, 'backoff.json')
    process.env.WALNUT_UPDATE_UNREAD_FILE = file
    process.env.WALNUT_BUILD_BACKOFF_FILE = holds
    try {
      const config = install('darwin')
      stubs!.setLoaded(true, config)
      stubs!.startDaemon(GOOD)
      const failed = JSON.stringify({ ok: false, failure: { code: 'notReady', stopped: true, message: 'the new daemon never answered as ready', rollback: 'the previous daemon was started again' } })
      // It goes on only once the test let it (a gate file, not a sleep that a loaded host outruns).
      const gate = path.join(work, 'go-launch-record')
      const cli = updateCli(`while [ ! -e '${gate}' ]; do sleep 0.1; done; launchctl bootstrap "gui/$(id -u)" '${config}'; echo '${failed}'; exit 1`)
      const record = { key: 'local:/tmp/open-walnut', expected: 'walnut-daemon-new0000' }
      let atLaunch = ''
      // This server's wait ends early (a deploy stops it): what was kept by its first poll.
      const first = updateLocalService(cli, 'user', {
        env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 300, record,
        sleep: async (ms) => { if (!atLaunch) { await updateStoresSettled(); atLaunch = fs.readFileSync(file, 'utf8') } await new Promise((r) => setTimeout(r, ms)) },
      })
      await expect(first).rejects.toThrow(/did not report back/)
      const kept = Object.values(JSON.parse(atLaunch))[0] as { directory: string; expected: string }
      expect(kept).toMatchObject({ expected: record.expected, directory: expect.stringMatching(/^\/tmp\/open-walnut-update\./) })
      madeDirs.push(kept.directory)
      // The next server, while that runner still works: busy, and nothing is started.
      const next = path.join(work, 'walnut-cli-next')
      fs.writeFileSync(next, ['#!/bin/sh', `echo started >> '${work}/next-ran'`, `echo '{"ok":true}'`, ''].join('\n'), { mode: 0o755 })
      const again = () => updateLocalService(next, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000, record })
      expect(await again()).toBe('busy')
      fs.writeFileSync(gate, '')
      await waitFor(() => fs.existsSync(path.join(kept.directory, 'update.done')))
      // Done: the build that failed after the stop is held, its dir removed, nothing started. The
      // hold is on disk while its dir is still there, and the record goes last: a server killed in
      // between keeps one of them, never neither (2026-11-04 review 5).
      const order: string[] = []
      const write = KeyedUpdateStore.prototype.write
      const spy = vi.spyOn(KeyedUpdateStore.prototype, 'write').mockImplementation(function (this: KeyedUpdateStore<{ at: number }>, key: string, entry: { at: number } | null) {
        const name = (this as unknown as { fileName: string }).fileName
        order.push(`${name}:${entry ? 'set' : 'clear'} dir=${fs.existsSync(kept.directory)}`)
        return write.call(this, key, entry)
      })
      try {
        await expect(again()).rejects.toMatchObject({ buildFailed: true, message: expect.stringContaining('never answered as ready') })
      } finally { spy.mockRestore() }
      expect(order).toEqual(['daemon-build-backoff.json:set dir=true', 'daemon-update-unread.json:clear dir=false'])
      expect(fs.existsSync(kept.directory)).toBe(false)
      expect(fs.existsSync(path.join(work, 'next-ran'))).toBe(false)
      await updateStoresSettled()
      expect(Object.values(JSON.parse(fs.readFileSync(holds, 'utf8')))).toEqual([expect.objectContaining({ expected: record.expected, reason: expect.stringContaining('never answered as ready') })])
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
      // Read once: the next try is an update like any other.
      expect(await again()).toBe('applied')
      await updateStoresSettled()
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
    } finally {
      delete process.env.WALNUT_UPDATE_UNREAD_FILE
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
    }
  }, 90_000)

  it('a build that failed in time: its hold is on disk while its dir is still there, and the record goes last', async () => {
    const file = path.join(work, 'unread-in-time.json')
    const holds = path.join(work, 'backoff-in-time.json')
    process.env.WALNUT_UPDATE_UNREAD_FILE = file
    process.env.WALNUT_BUILD_BACKOFF_FILE = holds
    const order: string[] = []
    let dir = ''
    const write = KeyedUpdateStore.prototype.write
    const spy = vi.spyOn(KeyedUpdateStore.prototype, 'write').mockImplementation(function (this: KeyedUpdateStore<{ at: number }>, key: string, entry: { at: number } | null) {
      const name = (this as unknown as { fileName: string }).fileName
      if (name === 'daemon-update-unread.json' && entry) dir = (entry as unknown as { directory: string }).directory
      order.push(`${name}:${entry ? 'set' : 'clear'} dir=${!!dir && fs.existsSync(dir)}`)
      return write.call(this, key, entry)
    })
    try {
      const config = install('darwin')
      stubs!.setLoaded(true, config)
      stubs!.startDaemon(GOOD)
      const failed = JSON.stringify({ ok: false, failure: { code: 'notReady', stopped: true, message: 'the new daemon never answered as ready', rollback: 'the previous daemon was started again' } })
      const cli = updateCli(`launchctl bootstrap "gui/$(id -u)" '${config}'; echo '${failed}'; exit 1`)
      const record = { key: 'local:/tmp/open-walnut', expected: 'walnut-daemon-new0000' }
      await expect(updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 60_000, record }))
        .rejects.toMatchObject({ buildFailed: true })
      expect(order).toEqual(['daemon-update-unread.json:set dir=true', 'daemon-build-backoff.json:set dir=true', 'daemon-update-unread.json:clear dir=false'])
      await updateStoresSettled()
      expect(Object.values(JSON.parse(fs.readFileSync(holds, 'utf8')))).toEqual([expect.objectContaining({ expected: record.expected })])
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({})
    } finally {
      spy.mockRestore()
      delete process.env.WALNUT_UPDATE_UNREAD_FILE
      delete process.env.WALNUT_BUILD_BACKOFF_FILE
    }
  }, 90_000)

  // 2026-11-04 review: the age held only where ps could not read the command line, so a runner
  // that hangs (its update.sh still running) blocked every update, revive and stand-in for good.
  it('a runner past the longest a runner may run (one that hangs) is no runner: the update goes ahead', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    const runner = fakeUpdateRunner('hung', marker)
    try {
      const cli = updateCli(`echo '{"ok":true}'`)
      expect(await updateLocalService(cli, 'user', { env: env(), latestMarker: marker, tail: TAIL, pollMs: 100, waitMs: 30_000 })).toBe('applied')
    } finally { runner.stop() }
    // Each shell that asks first waits one beat's grace for it (a runner a long sleep froze): about 40 s in all.
  }, 120_000)

  it('the update goes on when the server that started it is killed with its whole process group', async () => {
    const config = install('darwin')
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD)
    const dir = fs.mkdtempSync('/tmp/open-walnut-update.')
    madeDirs.push(dir)
    // Between the bootout and the bootstrap the server goes down; the CLI then finishes on its own.
    const cli = updateCli(`sleep 2; launchctl bootstrap "gui/$(id -u)" '${config}'; echo '{"ok":true}'`)
    fs.writeFileSync(path.join(dir, 'update.sh'), runnerScript({
      directory: dir, command: `${cli} walnut daemon update --yes --scope user`, executable: cli, tries: 1, settleSeconds: 0, latest: marker,
      tail: { scope: 'user', ...TAIL },
    }))
    // The "server": a process group of its own, which starts the update and then waits.
    const server = spawn('/bin/sh', ['-c', `${launcherScript(dir, marker)}\nsleep 60`], { detached: true, env: env(), stdio: ['ignore', 'pipe', 'ignore'] })
    let said = ''
    server.stdout!.on('data', (chunk: Buffer) => { said += chunk.toString() })
    await waitFor(() => said.includes(LAUNCHED), 15_000)
    process.kill(-server.pid!, 'SIGKILL')
    await waitFor(() => fs.existsSync(path.join(dir, 'update.done')))
    expect(fs.readFileSync(path.join(dir, 'update.done'), 'utf8').trim()).toBe('rc=0 tries=1 tail=serving')
    expect(fs.readFileSync(path.join(dir, 'update.out'), 'utf8')).toContain('{"ok":true}')
    expect(stubs!.daemonUp()).toBe(true)
  }, 60_000)
})

describe('a service config on disk with nothing running is started before the server refuses', () => {
  it('a LaunchAgent nobody loaded is bootstrapped, and a daemon answers', async () => {
    stubs = createServiceStubs(work, 'Darwin')
    const config = install('darwin')
    const tail = await reviveLocalService('user', { env: env(), latestMarker: marker, waitSeconds: 5 })
    expect(tail).toMatchObject({ outcome: 'loaded' })
    expect(stubs.calls()).toContain(`launchctl bootstrap gui/${process.getuid!()} ${config}`)
    expect(stubs.daemonUp()).toBe(true)
  }, 30_000)

  it('a user unit waiting out a crash is started, its start limit cleared first', async () => {
    stubs = createServiceStubs(work, 'Linux')
    const config = install('linux')
    stubs.setLoaded(true, config, true)
    const tail = await reviveLocalService('user', { env: env(), latestMarker: marker, waitSeconds: 5 })
    expect(tail).toMatchObject({ outcome: 'loaded' })
    expect(stubs.calls()).toEqual(expect.arrayContaining(['systemctl --user reset-failed open-walnut-daemon.service', 'systemctl --user start open-walnut-daemon.service']))
    expect(stubs.daemonUp()).toBe(true)
  }, 30_000)

  it('does nothing while an update runner is at work: its own tail decides', async () => {
    stubs = createServiceStubs(work, 'Darwin')
    install('darwin')
    const runner = fakeUpdateRunner('alive', marker)
    const dir = runner.dir
    try {
      expect(await reviveLocalService('user', { env: env(), latestMarker: marker, waitSeconds: 5 })).toBe('updating')
      expect(stubs.calls()).toEqual([])
      // Its record written: the runner is done, and the revive acts again.
      fs.writeFileSync(path.join(dir, 'update.done'), 'rc=0 tries=1 tail=down\n')
      expect(await reviveLocalService('user', { env: env(), latestMarker: marker, waitSeconds: 5 })).toMatchObject({ outcome: 'loaded' })
    } finally { runner.stop() }
  }, 30_000)

  // 2026-11-04 review: the revive loaded the job, and stood in for it, past the user's `launchctl disable`.
  it('leaves a LaunchAgent the user turned off alone, and says why', async () => {
    stubs = createServiceStubs(work, 'Darwin')
    install('darwin')
    stubs.setDisabled(true)
    expect(await reviveLocalService('user', { env: env(), latestMarker: marker, waitSeconds: 5 })).toEqual({
      outcome: 'stopped', words: 'the service is turned off in launchd (launchctl disable), so Walnut left it alone and started no daemon outside it',
    })
    expect(stubs.calls()).toEqual([`launchctl print-disabled gui/${process.getuid!()}`])
    expect(stubs.daemonUp()).toBe(false)
  })

  it('leaves a config alone when the service install dir is not there (it never makes one)', async () => {
    stubs = createServiceStubs(work, 'Darwin')
    install('darwin')
    // The revive is a sh script: the stub uname says Darwin, so the LaunchAgent's install dir is the one it reads.
    const ownRoot = daemonInstallRoot('darwin', home)
    fs.rmSync(ownRoot, { recursive: true, force: true })
    expect(await reviveLocalService('user', { env: env(), latestMarker: marker, waitSeconds: 5 })).toMatchObject({ outcome: 'down' })
    expect(stubs.calls()).toEqual([])
    expect(fs.existsSync(ownRoot)).toBe(false)
  })
})
