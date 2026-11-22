/**
 * The cron backend keeps its crontab lines in the form of the boot script on disk: the plain
 * supervisor script has the single @reboot line, the launcher script the @reboot line and the
 * minute line. 2026-11-22: an update turned clouddev's plain script into the launcher (pair of
 * lines), failed, and its rollback put the plain script back but left the pair. From then on
 * every automatic update read the line as "stale" and refused with serviceInactive, every
 * 20 minutes, while the daemon itself served fine.
 *
 * Two guards: every failure of an update that wrote the crontab leaves the lines in the form of
 * the script the rollback restored, and a host already left in the other form is updated (and
 * its lines put right), never refused.
 */
import { describe, expect, it } from 'vitest'
import { createCronDaemonServiceManager, type CronServiceDeps } from '../../src/providers/daemon-service-cron.js'
import { DaemonServiceUpdateRefusedError } from '../../src/providers/daemon-service-manager.js'
import type { DaemonServiceConfig } from '../../src/providers/daemon-service-config.js'
import {
  cronLineState, crontabWithoutDaemonLine, daemonCronLine, daemonCronMinuteLine, renderDaemonBootScript,
} from '../../src/providers/daemon-service-boot-script.js'
import { launcherSeed, type LauncherControl, type LauncherResult } from '../../src/providers/service-launcher-control.js'
import { isLauncherScript, renderLauncherScript } from '../../src/providers/service-launcher-script.js'

const HOME = '/home/walnut'
const ROOT = `${HOME}/.local/share/open-walnut/daemon`
const OLD = `${ROOT}/versions/${'a'.repeat(64)}/daemon`
const NEW = `${ROOT}/versions/${'b'.repeat(64)}/daemon`
const BOOT = `${ROOT}/daemon-boot.sh`
const USER_TAB = '0 3 * * * /usr/bin/backup # mine\n'
const AFTER = '@reboot /usr/bin/other-tool # theirs\n'
const SINGLE = `${USER_TAB}${daemonCronLine(BOOT)}\n${AFTER}`
const PAIR = `${USER_TAB}${daemonCronLine(BOOT)}\n${daemonCronMinuteLine(BOOT)}\n${AFTER}`
/** Every line that is not ours, in order, byte for byte. */
const othersOf = (tab: string) => crontabWithoutDaemonLine(tab, BOOT)

const config = (executable: string): DaemonServiceConfig => ({
  platform: 'linux', home: HOME, executable, args: ['--service'], runtimeDir: '/tmp/open-walnut', stateDir: ROOT, path: '/usr/bin:/bin',
})
const plainScript = (exe = OLD) => renderDaemonBootScript(config(exe))
const launcherScript = (exe = OLD) => renderLauncherScript(config(exe), { backend: 'cron', self: BOOT })

/** Where an update can fail after it wrote the script and the crontab. */
type Failure = 'none' | 'prepareThrows' | 'prepareRefused' | 'notReady' | 'didNotStay' | 'launcherRolledBack'
const FAILURES: Failure[] = ['prepareThrows', 'prepareRefused', 'notReady', 'didNotStay', 'launcherRolledBack']

function harness(o: { script: string; crontab: string; launcher: boolean; failure?: Failure; tabWritesThatWork?: number }) {
  const files = new Map<string, string>([[BOOT, o.script]])
  let crontab = o.crontab
  let tabWrites = 0
  const events: string[] = []
  let daemonExe = OLD
  const failure = o.failure ?? 'none'
  const launcher: LauncherControl = {
    script: BOOT,
    render: (c, seed) => renderLauncherScript({ ...c, executable: seed }, { backend: 'cron', self: BOOT }),
    seed: async () => launcherSeed(files.get(BOOT) ?? ''),
    facts: async () => null,
    request: async () => 'id1',
    prepared: async () => {},
    withdraw: async () => {},
    wait: async (id): Promise<LauncherResult> => failure === 'launcherRolledBack'
      ? { id, outcome: 'rolledback', exe: NEW, reason: 'the new version was not ready within 90 s' }
      : { id, outcome: 'committed', exe: NEW, reason: '' },
    chmod: async () => {},
    refuses: async () => null,
    rollback: async (exe) => ({ id: 'b1', outcome: 'rolledback', exe, reason: '' }),
    reset: async () => {},
  }
  const deps: CronServiceDeps = {
    platform: 'linux', home: HOME, uid: 1000, user: 'walnut', path: '/usr/bin:/bin', stateDir: ROOT, runtimeDir: '/tmp/open-walnut',
    run: async (program, args, input) => {
      if (program === 'crontab' && args[0] === '-l') return { code: 0, stdout: crontab, stderr: '' }
      if (program === 'crontab' && args[0] === '-') {
        if (o.tabWritesThatWork !== undefined && ++tabWrites > o.tabWritesThatWork) return { code: 1, stdout: '', stderr: 'crontab: disk full' }
        crontab = input ?? ''
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: 'enabled cron.service\n', stderr: '' }
    },
    writeConfig: async (file, text) => { files.set(file, text) },
    removeConfig: async (file) => { files.delete(file) },
    readConfig: async (file) => files.get(file) ?? null,
    inspectConfig: async (file) => ({ present: files.has(file), owned: files.has(file) }),
    prepareExecutable: async () => ({ executable: NEW, args: ['--service'] }),
    // The previous daemon answers the rollback's restart; the new one answers only when it should.
    ready: async (_s, exe) => {
      if (exe === NEW && failure === 'notReady') return false
      daemonExe = exe === NEW ? NEW : OLD
      return true
    },
    stay: async () => (failure === 'didNotStay' ? 'the new daemon exited 3 s after it answered' : null),
    prepareUpdate: async () => {
      if (failure === 'prepareThrows') throw new Error('the link dropped while the daemon prepared')
      if (failure === 'prepareRefused') throw new DaemonServiceUpdateRefusedError('the daemon is busy')
    },
    proveBoot: async () => null,
    spawnDetached: async () => { events.push('spawn') },
    serviceDaemon: async () => ({ pid: 4242, executable: daemonExe }),
    supervisor: async () => 4241,
    signal: async (pid, sig) => { events.push(`signal ${pid} ${sig}`) },
    waitGone: async () => true,
    setStop: async () => {},
    ...(o.launcher ? { launcher } : {}),
  }
  const formOnDisk = () => cronLineState(crontab, BOOT, { everyMinute: isLauncherScript(files.get(BOOT) ?? '') })
  return { manager: createCronDaemonServiceManager(deps), files, crontab: () => crontab, formOnDisk, events }
}

/** Each way the script and the crontab change form in one update: the launcher experiment on or off. */
const SWITCHES = [
  { name: 'a plain script becoming the launcher', script: plainScript(), crontab: SINGLE, launcher: true },
  { name: 'the launcher becoming the plain script', script: launcherScript(), crontab: PAIR, launcher: false },
] as const

describe('a failed cron update leaves the crontab lines in the form of the script it put back', () => {
  for (const s of SWITCHES) {
    for (const failure of FAILURES) {
      // The launcher's own answer exists only on the launcher path.
      if (failure === 'launcherRolledBack' && !s.launcher) continue
      it(`${s.name}, failing at ${failure}`, async () => {
        const h = harness({ script: s.script, crontab: s.crontab, launcher: s.launcher, failure })
        const result = await h.manager.update()
        expect(result.ok).toBe(false)
        expect(h.files.get(BOOT)).toBe(s.script)
        expect(h.formOnDisk()).toBe('ours')
        // Lines that are not ours stay byte for byte.
        expect(othersOf(h.crontab())).toBe(`${USER_TAB}${AFTER}`)
        // And the next update is not refused for it.
        const again = await harness({ script: h.files.get(BOOT)!, crontab: h.crontab(), launcher: s.launcher }).manager.update()
        expect(again.ok).toBe(true)
      })
    }
  }
})

describe('a rollback whose crontab write fails', () => {
  it('still brings the previous daemon back, and says the lines were not put back', async () => {
    // The forward write works, the rollback's does not.
    const h = harness({ script: plainScript(), crontab: SINGLE, launcher: true, failure: 'notReady', tabWritesThatWork: 1 })
    const result = await h.manager.update()
    if (result.ok) throw new Error('the update should have failed')
    expect(h.files.get(BOOT)).toBe(plainScript())
    // The supervisor runs the restored script once the daemon it watches exits.
    expect(h.events).toContain('signal 4242 SIGTERM')
    expect(result.failure.rollback).toMatch(/previous daemon is responding; its crontab lines could not be put back: crontab - exited with 1/)
  })
})

describe('a host left with its lines in the other form is updated, and its lines put right', () => {
  const MISMATCHED = [
    { name: 'the plain script with the launcher\'s pair of lines (clouddev, 2026-11-22)', script: plainScript(), crontab: PAIR },
    { name: 'the launcher script with only the @reboot line', script: launcherScript(), crontab: SINGLE },
  ]
  for (const m of MISMATCHED) {
    for (const launcher of [true, false]) {
      it(`${m.name}, launcher experiment ${launcher ? 'on' : 'off'}`, async () => {
        const h = harness({ script: m.script, crontab: m.crontab, launcher })
        const result = await h.manager.update()
        expect(result.ok ? 'ok' : result.failure.code).toBe('ok')
        expect(isLauncherScript(h.files.get(BOOT)!)).toBe(launcher)
        expect(h.formOnDisk()).toBe('ours')
        expect(othersOf(h.crontab())).toBe(`${USER_TAB}${AFTER}`)
      })
    }
  }

  it('a crontab with no line of ours is still refused: the person took the boot start away', async () => {
    const h = harness({ script: plainScript(), crontab: USER_TAB, launcher: true })
    const result = await h.manager.update()
    expect(result.ok ? 'ok' : result.failure.code).toBe('serviceInactive')
    expect(h.crontab()).toBe(USER_TAB)
  })

  it('a copied or edited line is still refused as not ours', async () => {
    const tab = `${USER_TAB}@reboot sh ${BOOT} # open-walnut-daemon\n`
    const h = harness({ script: plainScript(), crontab: tab, launcher: true })
    const result = await h.manager.update()
    expect(result.ok ? 'ok' : result.failure.code).toBe('serviceInactive')
    expect(h.crontab()).toBe(tab)
  })
})
