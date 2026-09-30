/**
 * A duplicate server removes its own launchd job, and ONLY its own.
 *
 * 2026-09-25: the deploy's KeepAlive job lost the instance lock to a server the
 * Mac app had restarted, and launchd relaunched the duplicate about every 11s for
 * seven hours. The fix removes the job from inside the losing server. The danger
 * it must never become: the production server's environment (WALNUT_LAUNCHD_LABEL
 * and the XPC_SERVICE_NAME launchd exports) is inherited by every session shell
 * under it, so a hand-started server there that hit the lock would otherwise
 * remove the PRODUCTION job. Every decision below is pinned with a stubbed
 * `launchctl`; nothing here runs the real one.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  claimedLaunchdLabel, parseLaunchdJobPid, removeOwnLaunchdJob, type LaunchctlExec,
} from '../../src/core/launchd-self-remove.js'

const LABEL = 'com.example.walnut-prod'
const JOB_ENV = { WALNUT_LAUNCHD_LABEL: LABEL, XPC_SERVICE_NAME: LABEL }
const listOutput = (pid?: number): string =>
  `{\n\t"LimitLoadToSessionType" = "Aqua";\n\t"Label" = "${LABEL}";\n${pid ? `\t"PID" = ${pid};\n` : ''}\t"LastExitStatus" = 256;\n};\n`

function stubExec(listPid: number | 'unlisted', removeFails = false): { exec: LaunchctlExec; calls: string[][] } {
  const calls: string[][] = []
  const exec: LaunchctlExec = vi.fn(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list') {
      if (listPid === 'unlisted') throw new Error('Could not find service')
      return listOutput(listPid)
    }
    if (args[0] === 'remove') {
      if (removeFails) throw new Error('remove refused')
      return ''
    }
    throw new Error(`unexpected launchctl ${args.join(' ')}`)
  })
  return { exec, calls }
}

describe('claimedLaunchdLabel (environment prefilter)', () => {
  it('claims the label only on macOS, with both variables agreeing', () => {
    expect(claimedLaunchdLabel(JOB_ENV, 'darwin')).toBe(LABEL)
    expect(claimedLaunchdLabel(JOB_ENV, 'linux')).toBeNull()
    expect(claimedLaunchdLabel({ WALNUT_LAUNCHD_LABEL: LABEL }, 'darwin')).toBeNull()
    expect(claimedLaunchdLabel({ ...JOB_ENV, XPC_SERVICE_NAME: 'application.com.example.Terminal.1' }, 'darwin')).toBeNull()
    expect(claimedLaunchdLabel({ XPC_SERVICE_NAME: LABEL }, 'darwin')).toBeNull()
  })

  it('refuses a label that is not a plain launchd identifier', () => {
    const odd = 'x; launchctl remove other'
    expect(claimedLaunchdLabel({ WALNUT_LAUNCHD_LABEL: odd, XPC_SERVICE_NAME: odd }, 'darwin')).toBeNull()
  })
})

describe('parseLaunchdJobPid', () => {
  it('reads the PID a running job reports, and null for a job without a process', () => {
    expect(parseLaunchdJobPid(listOutput(54740))).toBe(54740)
    expect(parseLaunchdJobPid(listOutput())).toBeNull()
    expect(parseLaunchdJobPid('')).toBeNull()
  })
})

describe('removeOwnLaunchdJob', () => {
  it('removes the job when launchd confirms this pid IS the job', async () => {
    const { exec, calls } = stubExec(4242)
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec }))
      .resolves.toBe('removed')
    expect(calls).toEqual([['list', LABEL], ['remove', LABEL]])
  })

  it('puts its log line on disk BEFORE the remove (launchd SIGTERMs it before remove returns)', async () => {
    // Seen on a real job: the line only reached the job's stdout, because the
    // file logger writes every 2s and the process was gone first.
    const order: string[] = []
    const { exec } = stubExec(4242)
    const tracked: LaunchctlExec = async (args) => { order.push(`launchctl ${args[0]}`); return exec(args) }
    const flushLog = vi.fn(async () => { order.push('flush') })
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec: tracked, flushLog }))
      .resolves.toBe('removed')
    expect(order).toEqual(['launchctl list', 'flush', 'launchctl remove'])
  })

  it('a flush that fails never stops the remove', async () => {
    const { exec, calls } = stubExec(4242)
    const flushLog = vi.fn(async () => { throw new Error('disk full') })
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec, flushLog }))
      .resolves.toBe('removed')
    expect(calls).toEqual([['list', LABEL], ['remove', LABEL]])
  })

  it('never removes the job when another process holds it (a session shell inherited the env)', async () => {
    const { exec, calls } = stubExec(54740)
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec }))
      .resolves.toBe('not-the-job-process')
    expect(calls).toEqual([['list', LABEL]])
  })

  it('never removes a job that has no process, since this process is then not it', async () => {
    const { exec, calls } = stubExec(0)
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec }))
      .resolves.toBe('not-the-job-process')
    expect(calls).toEqual([['list', LABEL]])
  })

  it('does nothing when the label is not registered', async () => {
    const { exec, calls } = stubExec('unlisted')
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec }))
      .resolves.toBe('job-not-listed')
    expect(calls).toEqual([['list', LABEL]])
  })

  it('never calls launchctl outside a claimed job (Linux, nohup, a hand-run server)', async () => {
    const { exec, calls } = stubExec(4242)
    await expect(removeOwnLaunchdJob('x', { env: JOB_ENV, platform: 'linux', pid: 4242, exec })).resolves.toBe('not-a-launchd-job')
    await expect(removeOwnLaunchdJob('x', { env: {}, platform: 'darwin', pid: 4242, exec })).resolves.toBe('not-a-launchd-job')
    expect(calls).toEqual([])
  })

  it('reports a failed remove without throwing', async () => {
    const { exec } = stubExec(4242, true)
    await expect(removeOwnLaunchdJob('duplicate', { env: JOB_ENV, platform: 'darwin', pid: 4242, exec }))
      .resolves.toBe('remove-failed')
  })
})

describe('startServer ordering (static ratchet)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'src', 'web', 'server.ts'), 'utf-8')
  const start = src.indexOf('export async function startServer(')
  const body = src.slice(start)

  it('takes the instance lock before any subsystem starts', () => {
    const lock = body.indexOf('acquireInstanceLock(port)')
    expect(lock).toBeGreaterThan(-1)
    for (const later of [
      'await initDirectories()',
      'installLogErrorNotifications(broadcastEvent)',
      'startEventLoopMonitor()',
      'recoverOrphanedUserMessage(',
      'await localDaemon.ensureRunning()',
      'const app = express()',
    ]) {
      const at = body.indexOf(later)
      expect(at, later).toBeGreaterThan(-1)
      expect(lock, `lock before ${later}`).toBeLessThan(at)
    }
  })

  it('a lost lock removes the own launchd job, then still fails the start', () => {
    const lock = body.indexOf('acquireInstanceLock(port)')
    const branch = body.slice(lock, body.indexOf('releaseInstanceLockSync = releaseInstanceLock', lock))
    expect(branch).toMatch(/err instanceof InstanceLockError/)
    expect(branch).toMatch(/await removeOwnLaunchdJob\(err\.message\)/)
    expect(branch).toMatch(/throw err/)
  })
})
