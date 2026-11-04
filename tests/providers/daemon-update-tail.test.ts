/**
 * The tail of a daemon update (src/providers/daemon-update-tail.ts), run for real in /bin/sh
 * against stand-ins for launchd and systemd (tests/helpers/service-stubs.ts) and a fake boot
 * script for cron: a service left unloaded is loaded again; a new daemon that never answers
 * gets the previous config put back, with its ownership record, and the previous one answers;
 * the record says what it took; and with no service config nothing is touched. The tail and its
 * snapshot hold the service install lock; a later runner stands it down only while it works.
 * The dark wake (launchd starting no jobs) is daemon-update-standin.test.ts.
 *
 * MACHINE SAFETY: HOME, the configs, the runtime dir and the record dir are under this file's
 * temp dir; launchctl, systemctl and uname are the stubs (PATH has nothing else first); the
 * only processes are /bin/sh and the stubs' `sleep`s, stopped after each case.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { daemonInstallRoot, readDaemonServiceDir, renderDaemonLaunchAgent, renderDaemonSystemdUnit } from '../../src/providers/daemon-service-config.js'
import { renderDaemonBootScript } from '../../src/providers/daemon-service-boot-script.js'
import { dirLines, parseUpdateTail, updateSnapshotScript, updateTailScript, type UpdateTailOptions } from '../../src/providers/daemon-update-tail.js'
import { createServiceStubs, type ServiceStubs } from '../helpers/service-stubs.js'
import { fakeUpdateRunner } from '../helpers/fake-update-runner.js'
import { guardedPath } from '../setup/exec-guard.js'

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-update-tail-')))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let work: string
let home: string
let record: string
let stubs: ServiceStubs | null = null
beforeEach(() => {
  work = fs.mkdtempSync(path.join(root, 'case-'))
  home = path.join(work, 'home')
  record = path.join(work, 'record')
  fs.mkdirSync(home)
  fs.mkdirSync(record)
})
// Most cases here run /bin/sh synchronously for seconds: the event loop is let run between them,
// or vitest's own worker calls wait past their 60 s timeout ("Timeout calling onTaskUpdate").
afterEach(async () => { stubs?.stop(); stubs = null; await new Promise((r) => setTimeout(r, 0)) })

const GOOD_PREVIOUS = '/opt/walnut/versions/good-previous/open-walnut-daemon'
const GOOD_NEW = '/opt/walnut/versions/good-new/open-walnut-daemon'
const BAD_NEW = '/opt/walnut/versions/bad-new/open-walnut-daemon'
const FAST: Omit<UpdateTailOptions, 'scope'> = { waitSeconds: 2, goneSeconds: 2, staySeconds: 1, probationSeconds: 0, probeSeconds: 2 }

function sh(script: string): string {
  const out = spawnSync('/bin/sh', ['-c', script], { env: { HOME: home, ...stubs!.env }, encoding: 'utf8', timeout: 60_000 })
  if (out.status !== 0) throw new Error(`sh exited ${out.status}: ${out.stderr}`)
  return out.stdout
}

/** A LaunchAgent (or a user unit) for `exe`, and the ownership record that names it as Walnut's. */
function install(platform: 'darwin' | 'linux', exe: string): { config: string; owners: string } {
  const stateDir = daemonInstallRoot(platform, home)
  fs.mkdirSync(stateDir, { recursive: true })
  const config = platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', 'dev.openwalnut.session-daemon.plist')
    : path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service')
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const c = { platform, home, executable: exe, args: ['--service'], runtimeDir: stubs!.runtime, stateDir, path: '/usr/bin:/bin' }
  fs.writeFileSync(config, platform === 'darwin' ? renderDaemonLaunchAgent(c) : renderDaemonSystemdUnit(c, 'user'), { mode: 0o600 })
  const owners = path.join(stateDir, 'service-configs.json')
  fs.writeFileSync(owners, `{"${config}":"${exe.includes('previous') ? 'a'.repeat(64) : 'b'.repeat(64)}"}\n`, { mode: 0o600 })
  return { config, owners }
}

describe('the tail of a LaunchAgent update', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Darwin') })

  it('says serving and does nothing when the new daemon answers', () => {
    const { config } = install('darwin', GOOD_NEW)
    stubs!.setLoaded(true, config)
    stubs!.startDaemon(GOOD_NEW)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))).toEqual({ outcome: 'serving', words: 'a daemon answers' })
    expect(stubs!.calls()).toEqual([])
  })

  it('loads a job the update left unloaded, and says so', () => {
    sh(updateSnapshotScript(record, { scope: 'user' }))
    const { config } = install('darwin', GOOD_NEW)
    stubs!.setLoaded(false)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))

    expect(tail).toEqual({ outcome: 'loaded', words: 'the service was not running after the update, so it was started again, and a daemon answers' })
    expect(stubs!.calls()).toContain(`launchctl bootstrap gui/${process.getuid!()} ${config}`)
    expect(stubs!.daemonUp()).toBe(true)
    // The record is in the update's dir for the server to read.
    expect(fs.readFileSync(path.join(record, 'update.tail'), 'utf8')).toMatch(/^outcome=loaded\n/)
  })

  it('puts the previous plist and its ownership record back when the new daemon never answers, and the previous one answers', () => {
    const before = install('darwin', GOOD_PREVIOUS)
    const previousPlist = fs.readFileSync(before.config, 'utf8')
    const previousOwners = fs.readFileSync(before.owners, 'utf8')
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    expect(fs.readFileSync(path.join(record, 'before.state'), 'utf8')).toBe('running\n')
    // The update wrote the new plist and its record, and launchd runs the new executable, which never answers.
    install('darwin', BAD_NEW)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))

    expect(tail).toEqual({ outcome: 'restored', words: 'no daemon answered within 2 s, so the previous service config was put back, and its daemon answers' })
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previousPlist)
    expect(fs.readFileSync(before.owners, 'utf8')).toBe(previousOwners)
    expect((fs.statSync(before.config).mode & 0o777).toString(8)).toBe('600')
    const calls = stubs!.calls()
    expect(calls.indexOf(`launchctl bootout gui/${process.getuid!()}/dev.openwalnut.session-daemon`)).toBeLessThan(calls.lastIndexOf(`launchctl bootstrap gui/${process.getuid!()} ${before.config}`))
    expect(stubs!.daemonUp()).toBe(true)
  })

  // 2026-11-04 review: the first answer counted, so a build that listened and then exited was
  // left as the service, and the previous one was never put back.
  it('puts the previous plist back when the new daemon answers and then does not stay', () => {
    const before = install('darwin', GOOD_PREVIOUS)
    const previousPlist = fs.readFileSync(before.config, 'utf8')
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    const FLAKY = '/opt/walnut/versions/good-flaky/open-walnut-daemon'
    install('darwin', FLAKY)
    // launchd runs the new executable: it answers, and exits a second later.
    stubs!.startDaemon(FLAKY)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST, staySeconds: 3 })))
    expect(tail).toEqual({ outcome: 'restored', words: 'the new daemon answered and then did not stay serving for 3 s, so the previous service config was put back, and its daemon answers' })
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previousPlist)
    expect(stubs!.daemonUp()).toBe(true)
  })

  it('says down when neither the new nor the previous daemon answers', () => {
    const before = install('darwin', '/opt/walnut/versions/bad-previous/open-walnut-daemon')
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    install('darwin', BAD_NEW)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.outcome).toBe('down')
  })

  it('touches nothing when no service config is installed', () => {
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.outcome).toBe('no-service')
    expect(stubs!.calls()).toEqual([])
  })

  it('kickstarts a job that is loaded with nothing running (KeepAlive restarts only a failed exit)', () => {
    const { config } = install('darwin', GOOD_NEW)
    stubs!.setLoaded(true, config, true)
    const tail = parseUpdateTail(sh(updateTailScript(record, { scope: 'user', waitSeconds: 20, goneSeconds: 2 })))
    expect(tail?.outcome).toBe('loaded')
    expect(stubs!.calls()).toContain(`launchctl kickstart gui/${process.getuid!()}/dev.openwalnut.session-daemon`)
    expect(stubs!.calls().some((c) => c.startsWith('launchctl bootstrap'))).toBe(false)
    expect(stubs!.daemonUp()).toBe(true)
  }, 60_000)

  it('leaves a service the user had stopped as it was', () => {
    const before = install('darwin', GOOD_PREVIOUS)
    stubs!.setLoaded(false)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    expect(fs.readFileSync(path.join(record, 'before.state'), 'utf8')).toBe('stopped\n')
    install('darwin', BAD_NEW)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.outcome).toBe('stopped')
    expect(stubs!.calls().filter((c) => !c.startsWith('launchctl print'))).toEqual([])
    expect(fs.readFileSync(before.config, 'utf8')).toContain('bad-new')
  })


  it('stops checking, and puts nothing back, once a later update took over the host', () => {
    const before = install('darwin', GOOD_PREVIOUS)
    stubs!.setLoaded(true, before.config)
    const latest = path.join(work, 'latest')
    const script = (s: string) => s.replace(`d='${record}'`, `d='${record}'\nL='${latest}'`)
    sh(script(updateSnapshotScript(record, { scope: 'user' })))
    install('darwin', BAD_NEW)
    // Another launch named its own dir the latest while this one waits for a daemon, and its runner is at work.
    const later = fakeUpdateRunner('alive', latest)
    try {
      expect(parseUpdateTail(sh(script(updateTailScript(record, { scope: 'user', ...FAST }))))?.outcome).toBe('superseded')
      expect(fs.readFileSync(before.config, 'utf8')).toContain('bad-new')
      expect(stubs!.calls().filter((c) => !c.startsWith('launchctl print'))).toEqual([])
    } finally { later.stop() }
  })

  // 2026-11-04 review: any other dir in the marker stood the tail down, so a later runner that
  // never ran, or died, left the host with nobody to put the service back. A live pid alone is
  // not enough either: a dead runner's pid reused by another process ('reused') is no runner.
  it.each(['dead', 'done', 'reused'] as const)('a later runner that is %s does not stand the tail down: it still puts the previous config back', (runner) => {
    const before = install('darwin', GOOD_PREVIOUS)
    stubs!.setLoaded(true, before.config)
    const latest = path.join(work, 'latest')
    const script = (s: string) => s.replace(`d='${record}'`, `d='${record}'\nL='${latest}'`)
    sh(script(updateSnapshotScript(record, { scope: 'user' })))
    install('darwin', BAD_NEW)
    const later = fakeUpdateRunner(runner, latest)
    try {
      expect(parseUpdateTail(sh(script(updateTailScript(record, { scope: 'user', ...FAST }))))?.outcome).toBe('restored')
      expect(fs.readFileSync(before.config, 'utf8')).toContain('good-previous')
    } finally { later.stop() }
  })
})

describe('the service install lock around the snapshot and the tail', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })
  const lockOf = () => path.join(daemonInstallRoot('linux', home), 'service-configs.json.lock')

  // 2026-11-04 review: a second runner took its snapshot unlocked, after the first had written the
  // new config, and its put-back then undid the first one's finished rollback.
  it('waits while a live `walnut daemon` holds it, and leaves that holder\'s lock alone', () => {
    install('linux', GOOD_NEW)
    fs.mkdirSync(lockOf())
    fs.writeFileSync(path.join(lockOf(), 'pid'), String(process.pid))
    const started = Date.now()
    sh(updateSnapshotScript(record, { scope: 'user', lockWaitSeconds: 2 }))
    // It waited the whole wait for the holder, then went on (a holder that hangs must not stop the tail for good).
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900)
    expect(fs.readFileSync(path.join(lockOf(), 'pid'), 'utf8')).toBe(String(process.pid))
    expect(fs.readdirSync(lockOf())).toEqual(['pid'])
  })

  it('takes over a lock whose holder died, and releases it after', () => {
    install('linux', GOOD_NEW)
    fs.mkdirSync(lockOf())
    fs.writeFileSync(path.join(lockOf(), 'pid'), String(2 ** 22 + 77))
    const started = Date.now()
    sh(updateSnapshotScript(record, { scope: 'user', lockWaitSeconds: 20 }))
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(fs.existsSync(lockOf())).toBe(false)
    expect(fs.readdirSync(path.dirname(lockOf())).filter((n) => n.includes('.lock-pid.') || n.includes('.lock-claim'))).toEqual([])
  })

  // 2026-11-04 review: two shells that both read the dead holder's pid each wrote their own and
  // checked it 0.2 s later; writes more than 0.2 s apart (a shell slowed by load) both held it.
  it('two shells that both find the holder dead never both hold the lock', async () => {
    install('linux', GOOD_NEW)
    fs.mkdirSync(lockOf())
    fs.writeFileSync(path.join(lockOf(), 'pid'), String(2 ** 22 + 78))
    // The first shell is slowed between its read and its write: each of its mv calls waits 1 s.
    const slow = path.join(work, 'slow-bin')
    fs.mkdirSync(slow)
    fs.writeFileSync(path.join(slow, 'mv'), '#!/bin/sh\nsleep 1\nexec /bin/mv "$@"\n', { mode: 0o755 })
    const { lockLines, servicePreamble } = await import('../../src/providers/daemon-update-shell.js')
    // Each holds it 2 s, then says whether the lock still names it.
    const script = [...servicePreamble('user'), ...lockLines(10), 't_lock', '[ -n "$tk_l" ] || { echo unlocked; exit 0; }', 'sleep 2',
      'if [ "$(cat "$to.lock/pid" 2>/dev/null)" = "$$" ]; then echo kept; else echo stolen; fi', 't_unlock'].join('\n')
    const run = (env: NodeJS.ProcessEnv) => new Promise<string>((resolve) => {
      execFile('/bin/sh', ['-c', script], { env, timeout: 40_000 }, (_e, out) => resolve(String(out).trim()))
    })
    const first = run({ HOME: home, ...stubs!.env, PATH: guardedPath([slow, stubs!.bin], '/usr/bin:/bin') })
    await new Promise((r) => setTimeout(r, 300))
    const second = run({ HOME: home, ...stubs!.env })
    expect(await Promise.all([first, second])).toEqual(['kept', 'kept'])
    expect(fs.existsSync(lockOf())).toBe(false)
  }, 60_000)

  it('a Node `walnut daemon` transaction waits for the tail that holds it', async () => {
    const { withFileLock } = await import('../../src/utils/file-lock.js')
    install('linux', GOOD_NEW)
    const owners = path.join(daemonInstallRoot('linux', home), 'service-configs.json')
    // The tail's own lock lines, held for 3 s.
    const { lockLines, servicePreamble } = await import('../../src/providers/daemon-update-shell.js')
    const held = execFile('/bin/sh', ['-c', [...servicePreamble('user'), ...lockLines(5), 't_lock', 'sleep 3', 't_unlock'].join('\n')], { env: { HOME: home, ...stubs!.env } })
    try {
      await vi.waitFor(() => expect(fs.existsSync(path.join(lockOf(), 'pid'))).toBe(true), { timeout: 5_000 })
      await expect(withFileLock(owners, async () => 'got it', { timeoutMs: 1_000 })).rejects.toThrow(/lock/i)
      await expect(withFileLock(owners, async () => 'got it', { timeoutMs: 10_000 })).resolves.toBe('got it')
    } finally { held.kill() }
  }, 30_000)
})

describe('the tail of a systemd user unit update', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })

  it('starts a unit the update left stopped', () => {
    install('linux', GOOD_NEW)
    stubs!.setLoaded(false)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.outcome).toBe('loaded')
    expect(stubs!.calls()).toEqual(expect.arrayContaining(['systemctl --user reset-failed open-walnut-daemon.service', 'systemctl --user start open-walnut-daemon.service']))
    expect(stubs!.daemonUp()).toBe(true)
  })

  it('starts a unit that waits out a crash (activating, SubState auto-restart): it is not running', () => {
    // 2026-11-04 review: `activating` read as running, so a crash-looping unit was never started and its start limit ended it.
    // The stub answers as systemd 219 does (no --value), where the old `show --value` read empty, and so running.
    const { config } = install('linux', GOOD_NEW)
    stubs!.setLoaded(true, config, true)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.outcome).toBe('loaded')
    expect(stubs!.calls()).toEqual(expect.arrayContaining([
      'systemctl --user show -p SubState open-walnut-daemon.service', 'systemctl --user start open-walnut-daemon.service',
    ]))
    expect(stubs!.daemonUp()).toBe(true)
  })

  // 2026-11-04 review: these ends said "there was no earlier service config to go back to", which was untrue.
  it('a config that is still the one from before the update says so when nothing answers', () => {
    install('linux', BAD_NEW)
    stubs!.setLoaded(true, path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service'))
    sh(updateSnapshotScript(record, { scope: 'user' }))
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))).toEqual({
      outcome: 'down', words: 'no daemon answered within 2 s, and the service config was already the one from before the update, so there was nothing to put back',
    })
  })

  it('a previous config that could not be put back says so', () => {
    const before = install('linux', GOOD_PREVIOUS)
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    install('linux', BAD_NEW)
    // The copy cannot be written over the config (here: the snapshot is not a file).
    fs.rmSync(path.join(record, 'before.cfg'))
    fs.mkdirSync(path.join(record, 'before.cfg'))
    fs.writeFileSync(path.join(record, 'before.cfg', 'x'), 'x')
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))).toEqual({
      outcome: 'down', words: 'no daemon answered within 2 s, and the previous service config could not be put back',
    })
  })

  // 2026-11-04 review: a config that was there and could not be copied (a full disk) read as "there was no earlier service config".
  it('a config the snapshot could not copy says so, not that there was none', () => {
    const before = install('linux', GOOD_PREVIOUS)
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    fs.rmSync(path.join(record, 'before.cfg'))
    install('linux', BAD_NEW)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))).toEqual({
      outcome: 'down', words: 'no daemon answered within 2 s, and the service config from before the update could not be copied before it, so there was nothing to put back',
    })
  })

  it('no snapshot at all still says there was none', () => {
    install('linux', BAD_NEW)
    stubs!.setLoaded(true, path.join(home, '.config', 'systemd', 'user', 'open-walnut-daemon.service'))
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.words).toBe('no daemon answered within 2 s, and there was no earlier service config to go back to')
  })

  it('puts the previous unit back and restarts it when the new daemon never answers', () => {
    const before = install('linux', GOOD_PREVIOUS)
    const previous = fs.readFileSync(before.config, 'utf8')
    stubs!.setLoaded(true, before.config)
    sh(updateSnapshotScript(record, { scope: 'user' }))
    install('linux', BAD_NEW)
    expect(parseUpdateTail(sh(updateTailScript(record, { scope: 'user', ...FAST })))?.outcome).toBe('restored')
    expect(fs.readFileSync(before.config, 'utf8')).toBe(previous)
    expect(stubs!.calls()).toEqual(expect.arrayContaining(['systemctl --user daemon-reload', 'systemctl --user restart open-walnut-daemon.service']))
    expect(stubs!.daemonUp()).toBe(true)
  })
})

describe('the tail of a cron-supervised update', () => {
  beforeEach(() => { stubs = createServiceStubs(work, 'Linux') })

  it('starts the boot script again when its supervisor is gone, and the daemon answers', () => {
    const stateDir = daemonInstallRoot('linux', home)
    fs.mkdirSync(stateDir, { recursive: true })
    // A stand-in for the supervisor: it records its pid, starts the daemon of its EXEC, and stays.
    fs.writeFileSync(path.join(stateDir, 'daemon-boot.sh'), [
      '#!/bin/sh',
      `export WALNUT_DAEMON_DIR='${stubs!.runtime}'`,
      `echo $$ > '${stateDir}/daemon-boot.pid'`,
      `echo $$ >> '${stubs!.state}/pids'`,
      `'${stubs!.state}/start-daemon' '${GOOD_NEW}'`,
      `env > '${stubs!.state}/supervisor-env'`,
      'exec sleep 300',
      '',
    ].join('\n'), { mode: 0o700 })
    // The runner runs in the daemon's env, which the boot script gave its failure counters.
    const tail = parseUpdateTail(sh(`export WALNUT_BOOT_FAILS=4 WALNUT_BOOT_FIRST=1\n${updateTailScript(record, { scope: 'cron', ...FAST })}`))
    expect(tail?.outcome).toBe('loaded')
    expect(stubs!.daemonUp()).toBe(true)
    // cron's own environment, as the manager starts it: none of the runner's counters.
    const env = fs.readFileSync(path.join(stubs!.state, 'supervisor-env'), 'utf8')
    expect(env).not.toContain('WALNUT_BOOT_FAILS')
    expect(env).toContain('PATH=/usr/bin:/bin')
  })
})

// 2026-11-05 review 6: t_dir read the daemon dir as the config writes it (XML entities, systemd's
// backslashes and %%, sh quoting), so with a HOME of such characters the tail found no daemon in a
// dir that does not exist, put the previous config back over a new daemon that served, and held
// the good build a day.
describe('the daemon dir the config pins, as the scripts read it', () => {
  // Every character one of the three escapes: ' & " < > (launchd), ' (cron), " \\ % (systemd), and $ and spaces.
  const pinned = `/Users/h o'm$e/a&b<c>"d\\e%f/.cache/open-walnut`
  const base = { home: '/Users/h o\'m$e', executable: '/opt/walnut/versions/good-new/open-walnut-daemon', args: ['--service'], runtimeDir: pinned, stateDir: '/Users/h o\'m$e/state', path: '/usr/bin:/bin' }
  const configs = {
    launchd: () => renderDaemonLaunchAgent({ platform: 'darwin', ...base }),
    systemd: () => renderDaemonSystemdUnit({ platform: 'linux', ...base }, 'user'),
    cron: () => renderDaemonBootScript({ platform: 'linux', ...base }),
  }
  for (const [tk, render] of Object.entries(configs)) {
    for (const shell of [['/bin/sh'], ['bash', '--posix']]) {
      it(`${tk}, in ${shell.join(' ')}: the dir itself, as the server reads it`, () => {
        const text = render()
        // The server's own reader agrees (the one the scripts must match).
        expect(readDaemonServiceDir(tk === 'launchd' ? 'darwin' : 'linux', text)).toBe(pinned)
        const tc = path.join(work, 'config')
        fs.writeFileSync(tc, text)
        const out = spawnSync(shell[0], [...shell.slice(1), '-c', [`tk=${tk}; tc='${tc}'`, ...dirLines(), 'tr=$(t_dir | head -n 1); printf "%s" "$tr"'].join('\n')], { encoding: 'utf8', env: { PATH: guardedPath([], '/usr/bin:/bin') } })
        expect(out.stderr).toBe('')
        expect(out.stdout).toBe(pinned)
      })
    }
  }
})
