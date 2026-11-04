/**
 * The LaunchAgent update against a launchd that behaves like the real one where it hurts
 * (2026-11-04: a host network Mac's daemon update left no job loaded): `bootout` answers
 * at once while the job takes seconds to go (print still shows it meanwhile), a
 * `bootstrap` of a label on its way out fails with 5, and launchd runs whichever
 * executable the plist on disk named at the bootstrap. Time is virtual: every launchctl
 * call takes 20 ms of it, every pause of the manager its own length, and the end state is
 * read once the clock has moved on two minutes, when every exit has finished. The daemon of the new executable never answers in the
 * failure cases (its readiness wait timed out), the previous one does.
 *
 * Proven here: the forward path and the rollback both end with the job loaded, the
 * previous executable answering after a failure; and no darwin failure branch (update or
 * restart, every fault below) ends with `launchctl print` answering 113.
 *
 * MACHINE SAFETY: launchctl is a function here; nothing is run, written or signalled.
 */
import { describe, expect, it } from 'vitest'
import {
  createDaemonServiceManager,
  DaemonServiceHandoverPendingError,
  DaemonServiceUpdateRefusedError,
  type DaemonServiceDeps,
  type DaemonServiceResult,
} from '../../src/providers/daemon-service-manager.js'
import { readDaemonServiceExecutable } from '../../src/providers/daemon-service-config.js'

const LABEL = 'dev.openwalnut.session-daemon'
const HOME = '/Users/example'
const PLIST = `${HOME}/Library/LaunchAgents/${LABEL}.plist`
const TARGET = `gui/501/${LABEL}`
const PREVIOUS_EXE = '/opt/walnut/versions/previous/open-walnut-daemon'
const NEW_EXE = '/opt/walnut/versions/new/open-walnut-daemon'
const plistFor = (exe: string) =>
  `<plist><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array><string>${exe}</string><string>--service</string></array></dict></plist>\n`

interface Faults {
  /** How long the job takes to go after each bootout (ms). */
  exitMs?: number
  /** Bootstraps that answer 5 right after the job is gone (once per bootout). */
  bootstrapFailsAfterBootout?: number
  /** The new executable's daemon never answers (its readiness wait timed out). */
  newNeverReady?: boolean
  readyThrows?: boolean
  prepareUpdate?: 'pending' | 'refused'
  /** The rollback's write of the previous plist fails. */
  rollbackWriteFails?: boolean
}

function launchdLab(f: Faults = {}) {
  let clock = 0
  const disk = new Map<string, string>([[PLIST, plistFor(PREVIOUS_EXE)]])
  // goneAt: the moment a booted-out job is gone; null while it runs.
  let job: { exe: string; goneAt: number | null } | null = { exe: PREVIOUS_EXE, goneAt: null }
  let bootstrapFailures = 0
  let writes = 0
  const log: string[] = []
  const settle = () => { if (job && job.goneAt !== null && clock >= job.goneAt) job = null }
  const printJob = () => {
    settle()
    return job ? { code: 0, stdout: `state = ${job.goneAt === null ? 'running' : 'exiting'}\n\tpid = 4242\n\tpath = ${PLIST}\n`, stderr: '' }
      : { code: 113, stdout: '', stderr: 'Could not find service' }
  }
  const deps: DaemonServiceDeps = {
    platform: 'darwin', home: HOME, uid: 501, user: 'example', path: '/usr/bin:/bin',
    stateDir: `${HOME}/Library/Application Support/Open Walnut/Daemon`, runtimeDir: '/tmp/open-walnut',
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    async run(program, args) {
      const line = [program, ...args].join(' ')
      log.push(line)
      clock += 20
      if (line === `launchctl print ${TARGET}`) return printJob()
      if (line === 'launchctl print-disabled gui/501') return { code: 0, stdout: `disabled services = {\n\t"${LABEL}" => enabled\n}\n`, stderr: '' }
      if (line === `launchctl bootout ${TARGET}`) {
        settle()
        // The real one answered in 47 ms for a job that took 3 s to exit.
        if (job && job.goneAt === null) job.goneAt = clock + (f.exitMs ?? 3_000)
        bootstrapFailures = f.bootstrapFailsAfterBootout ?? 0
        return { code: 0, stdout: '', stderr: '' }
      }
      if (line === `launchctl bootstrap gui/501 ${PLIST}`) {
        settle()
        if (job) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' }
        if (bootstrapFailures > 0) { bootstrapFailures -= 1; return { code: 37, stdout: '', stderr: 'Bootstrap failed: 37: Operation already in progress' } }
        job = { exe: readDaemonServiceExecutable('darwin', disk.get(PLIST)!), goneAt: null }
        return { code: 0, stdout: '', stderr: '' }
      }
      throw new Error(`unexpected command ${line}`)
    },
    async writeConfig(target, text) {
      writes += 1
      if (f.rollbackWriteFails && writes === 2) throw new Error('No space left on device')
      disk.set(target, text)
    },
    async removeConfig(target) { disk.delete(target) },
    async readConfig(target) { return disk.get(target) ?? null },
    async inspectConfig(target) { return { present: disk.has(target), owned: true } },
    async prepareExecutable() { return { executable: NEW_EXE, args: ['--service'] } },
    async prepareUpdate() {
      // The old daemon prepares and exits 1; KeepAlive starts it again from the plist launchd
      // already holds, so the job keeps running the previous executable until the reload.
      if (f.prepareUpdate === 'pending') throw new DaemonServiceHandoverPendingError('the reply was lost')
      if (f.prepareUpdate === 'refused') throw new DaemonServiceUpdateRefusedError('has active operations; retry after they finish')
    },
    async ready(_status, expected) {
      settle()
      if (f.readyThrows && job?.exe === NEW_EXE) throw new Error('daemon socket closed')
      if (!job || job.goneAt !== null) return false
      if (f.newNeverReady && job.exe === NEW_EXE) return false
      return !expected || expected === job.exe
    },
  }
  return {
    manager: createDaemonServiceManager(deps),
    log,
    /** Is a job loaded once every exit under way has finished? */
    loaded: () => { clock += 120_000; settle(); return job !== null },
    running: () => { clock += 120_000; settle(); return job?.exe ?? null },
    plistExe: () => readDaemonServiceExecutable('darwin', disk.get(PLIST)!),
  }
}

function failureOf(result: DaemonServiceResult) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.status)}`)
  return result.failure
}

describe('a LaunchAgent update against a launchd that lets go slowly', () => {
  it('waits for the old job to go, asks again after a bootstrap that answers 5, and loads the new one', async () => {
    const lab = launchdLab({ exitMs: 3_000, bootstrapFailsAfterBootout: 1 })
    const result = await lab.manager.update()

    expect(result.ok).toBe(true)
    expect(lab.running()).toBe(NEW_EXE)
    // No bootstrap until print stopped showing the job (113): the last print before it.
    const firstBootstrap = lab.log.indexOf(`launchctl bootstrap gui/501 ${PLIST}`)
    const prints = lab.log.slice(lab.log.indexOf(`launchctl bootout ${TARGET}`) + 1, firstBootstrap)
    expect(prints.length).toBeGreaterThan(5)
    expect(prints.every((line) => line === `launchctl print ${TARGET}`)).toBe(true)
  })

  it('rolls a new daemon that never answers back to the previous executable, loaded and answering', async () => {
    const lab = launchdLab({ exitMs: 3_000, bootstrapFailsAfterBootout: 1, newNeverReady: true })
    const failure = failureOf(await lab.manager.update())

    expect(failure.code).toBe('notReady')
    expect(failure.rollback).toBe('put the previous config back and the previous executable is responding')
    expect(lab.loaded()).toBe(true)
    expect(lab.running()).toBe(PREVIOUS_EXE)
    expect(lab.plistExe()).toBe(PREVIOUS_EXE)
  })

  it('outwaits a forward bootout launchd will not finish within its wait, and the rollback brings the previous one back', async () => {
    // The job takes 40 s to go; the bootout waits 25 s.
    const lab = launchdLab({ exitMs: 40_000, newNeverReady: true })
    const failure = failureOf(await lab.manager.update())

    expect(failure.code).toBe('commandFailed')
    expect(failure.message).toMatch(/still loaded 25 s after launchctl bootout/)
    expect(lab.running()).toBe(PREVIOUS_EXE)
    expect(failure.rollback).toMatch(/previous executable is responding/)
  })
})

describe('no darwin failure branch ends with nothing loaded', () => {
  const faults: Array<[string, Faults]> = [
    ['the new daemon never answers', { newNeverReady: true }],
    ['the new daemon never answers, behind a slow bootout and a bootstrap that answers 5', { newNeverReady: true, exitMs: 3_000, bootstrapFailsAfterBootout: 1 }],
    ['bootstraps refused for several seconds after each bootout', { newNeverReady: true, exitMs: 1_000, bootstrapFailsAfterBootout: 8 }],
    ['the readiness check throws', { readyThrows: true, exitMs: 2_000 }],
    ['the old daemon refuses the update as busy', { prepareUpdate: 'refused' }],
    ['the old daemon\'s answer to the update is lost', { prepareUpdate: 'pending' }],
    ['the rollback cannot write the previous plist', { newNeverReady: true, exitMs: 2_000, rollbackWriteFails: true }],
    ['a bootout launchd takes longer than its wait to finish', { newNeverReady: true, exitMs: 40_000 }],
  ]

  it.each(faults)('update: %s', async (_name, f) => {
    const lab = launchdLab(f)
    const result = await lab.manager.update()

    expect(result.ok).toBe(false)
    expect(lab.loaded()).toBe(true)
    // A rollback that could put the previous plist back runs the previous executable.
    if (!f.rollbackWriteFails) expect(lab.running()).toBe(PREVIOUS_EXE)
  })

  it.each([
    ['a slow bootout and a bootstrap that answers 5', { exitMs: 3_000, bootstrapFailsAfterBootout: 1 }],
    ['a bootout launchd takes longer than its wait to finish', { exitMs: 40_000 }],
  ] as Array<[string, Faults]>)('restart: %s', async (_name, f) => {
    const lab = launchdLab(f)
    await lab.manager.restart()
    expect(lab.loaded()).toBe(true)
    expect(lab.running()).toBe(PREVIOUS_EXE)
  })
})
