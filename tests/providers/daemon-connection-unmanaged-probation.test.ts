/**
 * The probation of a new SSH daemon after an unmanaged update's stop (daemon-connection.ts
 * deployAndStart), for what the 2026-11-04 review 6 found:
 *   - a daemon found gone only long past its window (the link was down at its end) was the
 *     build's failure, though it may have died hours later;
 *   - a reboot of the host inside the window was the build's failure too;
 *   - the first failed try of the way back was not counted, so the host waited for a third.
 *
 * All SSH is stubbed at sshExec (tests/helpers/daemon-connection-update-stubs.ts); no process,
 * socket or tunnel is created. The one file written is each test's own temp file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'
import { updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { EXPECTED, OLD, TARGET, priv, state, probe, stub } from '../helpers/daemon-connection-update-stubs.js'

let conns: DaemonConnection[] = []
function make(): DaemonConnection {
  const c = new DaemonConnection('devbox', TARGET)
  conns.push(c)
  return c
}
let pendingDir: string | null = null
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  setPooledConnectionForTest('devbox', null)
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.WALNUT_UPDATE_PENDING_FILE
  if (pendingDir) fs.rmSync(pendingDir, { recursive: true, force: true })
  pendingDir = null
})

const STAY_MS = (DaemonConnection as unknown as { STAY_MS: number }).STAY_MS

/** A host whose old daemon was stopped for `recorded` (EXPECTED), the new one started `agoMs` ago (in boot `boot`), and none runs now. */
function startedThenGone(agoMs: number, boot?: number, recorded = EXPECTED) {
  pendingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-replace-'))
  process.env.WALNUT_UPDATE_PENDING_FILE = path.join(pendingDir, 'pending.json')
  const c = make()
  const seen = stub(c, { probe: probe(), version: OLD })
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(log.session, level).mockImplementation(() => {})
  state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now() - agoMs, stopped: true }
  state(c)._replacing = { expected: recorded, dir: state(c)._remoteDir, at: Date.now() - agoMs, started: { pid: 7001, at: Date.now() - agoMs, ...(boot ? { boot } : {}) } }
  vi.spyOn(priv(c), 'scheduleStayCheck').mockImplementation(() => {})
  const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
  const start = vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
  return { c, seen, fresh, start }
}

/** The host's boot time as `t_boot` prints it to the server (and the new daemon's pid). */
function bootIs(c: DaemonConnection, boot: number) {
  const ssh = vi.spyOn(priv(c), 'sshExec')
  const route = ssh.getMockImplementation()!
  ssh.mockImplementation(async (...args: unknown[]) => {
    const cmd = String(args[0])
    if (cmd.startsWith('cat ') && cmd.includes('daemon.pid')) return `7101\n\nwalnut-boot=${boot}\n`
    if (cmd.includes('walnut-boot=')) return `walnut-boot=${boot}\n`
    return route(...args)
  })
}

describe('the probation of a new SSH daemon', () => {
  it('found gone only long past its window: no verdict on the build; it starts again, watched anew, the way back kept', async () => {
    const { c, seen, fresh, start } = startedThenGone(STAY_MS + 3 * 3600_000)
    await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(false)
    expect(state(c)._realDirFail ?? null).toBeNull()
    // Watched over again from now (2026-11-04 review 7: the record was dropped, so a build that kept
    // dying was started unwatched on every connect, and the old one never again).
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.objectContaining({ at: expect.any(Number) }) })
    expect(Date.now() - state(c)._replacing.started.at).toBeLessThan(5_000)
    expect(state(c)._previous).toMatchObject({ stopped: true, runtime: 'node' })
    // It dies inside that window: now it is the build's failure, and the old one starts again.
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('node')
    expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, reason: expect.stringMatching(/stopped within \d+ s/) })
  })

  // 2026-11-05 review 6: a record made for B, then a deploy of C: C was started and judged as B, so
  // its failure held B and C stopped the old daemon again one cooldown later.
  it('a stop\'s record made for an older build: the build deployed now is watched and held under its own name', async () => {
    const { c, fresh } = startedThenGone(STAY_MS + 3 * 3600_000, undefined, 'walnut-daemon-recorded0')
    await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.any(Object) })
    await updateStoresSettled()
    expect(Object.values(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, 'utf8')))).toEqual([expect.objectContaining({ expected: EXPECTED })])
    // It dies inside its window: the build deployed is the one held, never the recorded one.
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, reason: expect.stringMatching(/stopped within \d+ s/) })
  })

  it('a stop\'s record made for an older build whose newer build does not start: the newer one is held, and the old one starts again', async () => {
    const { c, fresh, start } = startedThenGone(STAY_MS + 3 * 3600_000, undefined, 'walnut-daemon-recorded0')
    fresh.mockRejectedValueOnce(new Error('the new daemon did not answer'))
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('node')
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED })
  })

  it('gone inside its window is still the build\'s failure: the old one starts again', async () => {
    const { c, seen, fresh, start } = startedThenGone(5 * 60_000)
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('node')
    expect(fresh).not.toHaveBeenCalled()
    expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, reason: expect.stringMatching(/stopped within \d+ s/) })
  })

  it('the host rebooted inside its window: no failure; it starts again and its probation starts over, the way back kept', async () => {
    const boot = 1_800_000_000
    const { c, seen, fresh, start } = startedThenGone(5 * 60_000, boot)
    bootIs(c, boot + 4 * 3600)
    await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
    expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(false)
    expect(state(c)._realDirFail ?? null).toBeNull()
    // Watched anew from now, in the new boot, with the old one's files still the way back.
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: { pid: 7101, boot: boot + 4 * 3600 } })
    expect(Date.now() - state(c)._replacing.started.at).toBeLessThan(5_000)
    expect(state(c)._previous).toMatchObject({ stopped: true, runtime: 'node' })
    await updateStoresSettled()
    expect(Object.values(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, 'utf8')))).toEqual([expect.objectContaining({ started: expect.objectContaining({ boot: boot + 4 * 3600 }) })])
  })

  it('the same boot is no reboot: gone inside the window is the build\'s failure', async () => {
    const boot = 1_800_000_000
    const { c, start } = startedThenGone(5 * 60_000, boot)
    bootIs(c, boot)
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('node')
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED })
  })

  // The first try of the way back (from the new daemon's failure) failed too, and was not counted.
  it('the way back is tried twice in all, the first try counted, then the host gets the build there, watched', async () => {
    const { c, seen, fresh } = startedThenGone(5 * 60_000)
    const ssh = vi.spyOn(priv(c), 'sshExec')
    const route = ssh.getMockImplementation()!
    let restores = 0
    ssh.mockImplementation(async (...args: unknown[]) => {
      if (!String(args[0]).includes('walnut-previous-restored')) return route(...args)
      restores++
      seen.push('RESTORE')
      return ''
    })
    await expect(priv(c).deployAndStart()).rejects.toThrow()
    expect(state(c)._replacing).toMatchObject({ back: true, backTries: 1 })
    await updateStoresSettled()
    expect(Object.values(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE!, 'utf8')))).toEqual([expect.objectContaining({ back: true, backTries: 1 })])
    // The second try fails too: that was the last.
    await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    expect(restores).toBe(2)
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.any(Object) })
    expect(state(c)._replacing.back).toBeUndefined()
  })

  // 2026-11-04 review 7: the live scan's settle had no reboot check, so another pid there after a
  // reboot of the host was the build's failure.
  it('another daemon found alive there after a reboot of the host is watched, no failure of the build', async () => {
    const boot = 1_800_000_000
    const { c } = startedThenGone(5 * 60_000, boot)
    bootIs(c, boot + 4 * 3600)
    state(c)._connected = true
    await priv(c).settleStartedOnLive(8100)
    expect(state(c)._realDirFail ?? null).toBeNull()
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: { pid: 8100, boot: boot + 4 * 3600 } })
    expect(state(c)._previous).toMatchObject({ stopped: true })
  })

  it('another daemon found alive there in the same boot is still the build\'s failure', async () => {
    const boot = 1_800_000_000
    const { c } = startedThenGone(5 * 60_000, boot)
    bootIs(c, boot)
    state(c)._connected = true
    await priv(c).settleStartedOnLive(8100)
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, reason: expect.stringMatching(/another daemon \(pid 8100\) serves there/) })
    expect(state(c)._replacing).toBeNull()
  })
})
