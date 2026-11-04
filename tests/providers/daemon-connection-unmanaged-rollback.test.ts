/**
 * The unmanaged (no OS service) update of an SSH host never leaves it without a daemon
 * (2026-11-04 reviews): the running daemon's files are kept first, stamped with the build
 * that runs; the staged build has a trial run; the old daemon is stopped only with its way
 * back (a kept copy, or the word that there is nothing to keep); a new build that does not
 * start after the stop is followed by the old one again, and that build waits a day. The
 * stop and its kept copy are on disk too, for a server restarted in between.
 *
 * All SSH is stubbed at sshExec (tests/helpers/daemon-connection-update-stubs.ts); no
 * process, socket or tunnel is created. The one file written is this file's temp file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'
import { updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { EXPECTED, OLD, TARGET, priv, state, probe, stub, destructive, type Routes } from '../helpers/daemon-connection-update-stubs.js'

let conns: DaemonConnection[] = []
function make(): DaemonConnection {
  const c = new DaemonConnection('devbox', TARGET)
  conns.push(c)
  return c
}
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  setPooledConnectionForTest('devbox', null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the unmanaged update never leaves the host without a daemon', () => {
  // 2026-11-04 review: the old daemon was stopped for the staged build with no check that it could start.
  it('a staged build that fails its trial run never stops the old daemon; its files go back, and the host says why', async () => {
    const c = make()
    const seen = stub(c, { probe: probe(), version: OLD, trial: 'walnut-trial-failed it exited with 1 before it listened: SyntaxError: Unexpected token' })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { priv(c).setConnected(false) })
    state(c)._runtime = 'node'
    state(c)._connected = true
    state(c)._daemonVersion = OLD
    await priv(c).recheckPostponedUpgrade()
    const keepAt = seen.findIndex((cmd) => cmd.includes('walnut-previous-kept'))
    const trialAt = seen.findIndex((cmd) => cmd.includes('walnut-trial-ok'))
    expect(keepAt).toBeGreaterThanOrEqual(0)
    expect(keepAt).toBeLessThan(seen.indexOf('DEPLOY'))
    expect(trialAt).toBeGreaterThan(seen.indexOf('DEPLOY'))
    expect(seen.findIndex((cmd) => cmd.includes('walnut-previous-restored'))).toBeGreaterThan(trialAt)
    expect(seen.filter((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toEqual([])
    expect(lost).not.toHaveBeenCalled()
    expect(state(c).upgradeRecheckTimer).not.toBeNull()
    expect(c.daemonUpdateView).toMatchObject({ state: 'failed', message: expect.stringContaining('did not start in a trial run on the host, so the running one keeps serving: it exited with 1') })
    // Gone once the host runs that build.
    state(c)._daemonVersion = EXPECTED
    expect(c.daemonUpdateView).toBeNull()
  })

  // 2026-11-04 review 5: a build that replaced another counted as up after 30 s, and a newer one
  // could replace it inside its probation, keeping it over the copy of the one before it.
  it('a newer build waits while the build that runs is on its probation: no keep, no deploy, asked again after it', async () => {
    const c = make()
    const seen = stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
    state(c)._runtime = 'node'
    state(c)._connected = true
    state(c)._daemonVersion = OLD
    // OLD replaced the build before it two minutes ago, and its probation runs.
    state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now() - 120_000, stopped: true }
    state(c)._replacing = { expected: OLD, dir: state(c)._remoteDir, at: Date.now() - 120_000, started: { pid: 4242, at: Date.now() - 120_000 } }
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    await priv(c).recheckPostponedUpgrade()
    expect(seen.some((cmd) => cmd.includes('walnut-previous-kept'))).toBe(false)
    expect(seen).not.toContain('DEPLOY')
    expect(postpone).toHaveBeenCalledWith(expect.stringContaining('probation'), EXPECTED, OLD, { delayMs: expect.any(Number) })
    const delay = (postpone.mock.calls.at(-1)![3] as { delayMs: number }).delayMs
    expect(delay).toBeGreaterThan(10 * 60_000)
    expect(state(c)._replacing).toMatchObject({ expected: OLD })
  })

  it('a new build that passed its trial and does not start after the stop is followed by the old one again', async () => {
    const c = make()
    const seen = stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    state(c)._previous = { dir: state(c)._remoteDir, runtime: 'binary', bunPath: null, at: Date.now(), stopped: true }
    vi.spyOn(priv(c), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
    const start = vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('binary')
    expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
    state(c)._connected = true
    state(c)._daemonVersion = OLD
    expect(c.daemonUpdateView).toMatchObject({ state: 'failed', message: expect.stringContaining('so the old one was started again: Daemon failed to start') })
    // The build's day off says how the old one runs (a daemon that dies within it starts as it is).
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, previous: { runtime: 'binary', bunPath: null } })
    // The kept copy is for that one update only: with no hold, a later failed start is the connect's own, as before.
    state(c)._realDirFail = null
    await expect(priv(c).deployAndStart()).rejects.toThrow('Daemon failed to start')
    expect(start).toHaveBeenCalledTimes(1)
  })

  // 2026-11-04 review (this machine's twin: its gate held only a live replacement): once the old
  // daemon started again died within its build's day off, the next connect deployed the held
  // build, which had just failed there, and the host was left with no daemon.
  it('no daemon runs while the build has its day off: the old one starts from its files as they are, not the held build', async () => {
    const c = make()
    stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    state(c)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not start', previous: { runtime: 'binary', bunPath: null } }
    const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
    const start = vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('binary')
    expect(fresh).not.toHaveBeenCalled()
    expect(state(c)._runtime).toBe('binary')
    // The old one does not start (its files are gone): the build is deployed as before.
    start.mockRejectedValueOnce(new Error('Daemon failed to start: no such file'))
    await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    expect(fresh).toHaveBeenCalledTimes(1)
    // That start of the held build is watched (daemon-connection-unmanaged-wayback.test.ts); here it stayed.
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.any(Object) })
    state(c)._replacing = null
    // A newer build, a day gone, or a hold that does not say how the old one ran: deployed as before.
    start.mockClear()
    for (const held of [
      { expected: 'walnut-daemon-older000', at: Date.now(), reason: 'x', previous: { runtime: 'binary', bunPath: null } },
      { expected: EXPECTED, at: Date.now() - 25 * 60 * 60_000, reason: 'x', previous: { runtime: 'binary', bunPath: null } },
      { expected: EXPECTED, at: Date.now(), reason: 'x' },
    ]) {
      state(c)._realDirFail = held
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    }
    expect(start).not.toHaveBeenCalled()
  })

  // 2026-11-04 review: with no copy of the old daemon kept, a failed start after the stop was
  // recorded nowhere: no reason on the host's status, and the build was tried again at once.
  it('a new build that does not start after the stop, with no copy of the old one kept, says so and waits a day', async () => {
    const c = make()
    stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    state(c)._previous = null
    state(c)._replacing = { expected: EXPECTED, dir: state(c)._remoteDir, at: Date.now() }
    vi.spyOn(priv(c), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
    await expect(priv(c).deployAndStart()).rejects.toThrow('Daemon failed to start')
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED })
    state(c)._connected = false
    expect(c.daemonUpdateView).toMatchObject({ state: 'down', message: expect.stringContaining('no copy of the old one was kept to start again: Daemon failed to start') })
    // Once only: a later failed start is the connect's own.
    state(c)._realDirFail = null
    await expect(priv(c).deployAndStart()).rejects.toThrow('Daemon failed to start')
    expect(state(c)._realDirFail).toBeNull()
  })

  /** A connected host on the old build whose update goes through the unmanaged path. */
  function unmanagedOnOld(c: DaemonConnection, routes: Partial<Routes> = {}) {
    const seen = stub(c, { probe: probe(), version: OLD, ...routes })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
    const lost = vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { priv(c).setConnected(false) })
    state(c)._runtime = 'node'
    state(c)._connected = true
    state(c)._daemonVersion = OLD
    return { seen, lost }
  }
  const restoredAfter = (seen: string[], marker: string) => {
    const at = seen.findIndex((cmd) => cmd.includes(marker))
    return at >= 0 && seen.findIndex((cmd, i) => i > at && cmd.includes('walnut-previous-restored')) > at
  }

  // 2026-11-04 review: previous/ was copied from whatever the disk held, so after an attempt that
  // stopped short it could hold the new build, the one a rollback then "restored".
  it('keeps the files only as the build that runs: the keep names that build and the program that carries it', async () => {
    const c = make()
    const { seen } = unmanagedOnOld(c)
    await priv(c).recheckPostponedUpgrade()
    const keep = seen.find((cmd) => cmd.includes('walnut-previous-kept'))!
    expect(keep).toContain(`v='${OLD}'`)
    expect(keep).toContain('for f in "$d/daemon.cjs"; do [ -f "$f" ] && grep -qF "$v" "$f"')
    expect(keep).toContain('walnut-previous-not-running')
  })

  // 2026-11-04 review: the stop did not depend on a copy having been kept: an SSH error or the
  // keep's 120 s timeout read as nothing to keep, and the update still staged, trialled and stopped.
  it.each([
    ['the keep fails or times out (no answer)', { keep: '' }, 'node'],
    ['the runtime is not known', {}, 'unknown'],
  ] as const)('no copy kept because %s: nothing is staged or stopped, and it is asked again later', async (_what, routes, runtime) => {
    const c = make()
    const { seen, lost } = unmanagedOnOld(c, routes)
    state(c)._runtime = runtime
    const postpone = vi.spyOn(priv(c), 'postponeUpgrade')
    await priv(c).recheckPostponedUpgrade()
    expect(destructive(seen)).toEqual([])
    expect(seen.filter((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toEqual([])
    expect(lost).not.toHaveBeenCalled()
    expect(postpone.mock.calls.at(-1)![0]).toMatch(/could not be kept to go back to, so it keeps serving/)
  })

  it('files that no longer carry the running build have nothing to keep: the update goes on as before', async () => {
    const c = make()
    const { seen } = unmanagedOnOld(c, { keep: 'walnut-previous-not-running' })
    await priv(c).recheckPostponedUpgrade()
    expect(seen).toContain('DEPLOY')
    expect(seen.some((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toBe(true)
  })

  // 2026-11-04 review: the kept copy's 10 min ran from the keep, so an upload and a trial of
  // that long left it expired at the stop, and a failed start had nothing to go back to.
  it('the kept copy is the way back after the stop, however long the upload and the trial took', async () => {
    const c = make()
    const { seen } = unmanagedOnOld(c)
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.spyOn(priv(c), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); clock += 11 * 60_000; return 'node' })
    await priv(c).recheckPostponedUpgrade()
    expect(seen.some((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toBe(true)
    clock += 60_000
    vi.spyOn(priv(c), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
    const start = vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    expect(start).toHaveBeenCalledWith('node')
    expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
  })

  // 2026-11-04 review: the stop and its kept copy lived in this server's memory only, so a server
  // restarted before the new daemon started (a deploy, a crash) had no way back when it failed.
  it('a server restarted between the stop and the start still starts the kept old daemon (kept on disk, with no clock)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-replace-'))
    process.env.WALNUT_UPDATE_PENDING_FILE = path.join(dir, 'pending.json')
    try {
      const first = make()
      const { seen } = unmanagedOnOld(first)
      await priv(first).recheckPostponedUpgrade()
      expect(seen.some((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toBe(true)
      // The server restarts: a new connection object knows nothing in memory.
      const second = make()
      const again = stub(second, { probe: probe(), version: OLD })
      vi.spyOn(priv(second), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
      const start = vi.spyOn(priv(second), 'startDaemon').mockResolvedValue(32300)
      await expect(priv(second).deployAndStart()).resolves.toBe(32300)
      expect(start).toHaveBeenCalledWith('node')
      expect(again.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
      expect(state(second)._realDirFail).toMatchObject({ expected: EXPECTED })
      // Used once: the record is gone from the disk too.
      await updateStoresSettled()
      expect(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE, 'utf8'))).toEqual({})

      // A day after the stop (a host that was away, a server that was down), the way back is still
      // there: no clock ends it (2026-11-04 review: it ran out 10 min after the stop).
      state(second)._realDirFail = null
      const third = make()
      unmanagedOnOld(third)
      await priv(third).recheckPostponedUpgrade()
      await updateStoresSettled()
      const late = Date.now() + 25 * 60 * 60_000
      vi.spyOn(Date, 'now').mockImplementation(() => late)
      const fourth = make()
      const fourthSeen = stub(fourth, { probe: probe(), version: OLD })
      vi.spyOn(priv(fourth), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
      const back = vi.spyOn(priv(fourth), 'startDaemon').mockResolvedValue(32300)
      await expect(priv(fourth).deployAndStart()).resolves.toBe(32300)
      expect(back).toHaveBeenCalledWith('node')
      expect(fourthSeen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
    } finally {
      delete process.env.WALNUT_UPDATE_PENDING_FILE
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // 2026-11-04 review: the record was cleared before the new daemon started, so a server that
  // stopped in the middle of that start (a deploy, a crash) left the next one no way back.
  it('the stop\'s record outlives a start the server did not finish', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-replace-'))
    process.env.WALNUT_UPDATE_PENDING_FILE = path.join(dir, 'pending.json')
    try {
      const first = make()
      unmanagedOnOld(first)
      await priv(first).recheckPostponedUpgrade()
      // The server goes away in the middle of the new daemon's deploy and start.
      vi.spyOn(priv(first), 'deployAndStartNew').mockImplementation(() => new Promise(() => {}))
      void priv(first).deployAndStart()
      await new Promise((r) => setTimeout(r, 20))
      await updateStoresSettled()
      const second = make()
      const again = stub(second, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'error').mockImplementation(() => {})
      vi.spyOn(priv(second), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
      const start = vi.spyOn(priv(second), 'startDaemon').mockResolvedValue(32300)
      await expect(priv(second).deployAndStart()).resolves.toBe(32300)
      expect(start).toHaveBeenCalledWith('node')
      expect(again.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
    } finally {
      delete process.env.WALNUT_UPDATE_PENDING_FILE
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // 2026-11-04 review: one answer counted as success, so a build that listened and then died
  // left the host to the reconnect, which deployed the same build again; the old one never came back.
  it('a new daemon that answers and is gone before it stayed serving is followed by the old one, and the build waits a day', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-replace-'))
    process.env.WALNUT_UPDATE_PENDING_FILE = path.join(dir, 'pending.json')
    const stay = (DaemonConnection as unknown as { STAY_MS: number }).STAY_MS
    ;(DaemonConnection as unknown as { STAY_MS: number }).STAY_MS = 30
    try {
      const c = make()
      const { seen } = unmanagedOnOld(c)
      await priv(c).recheckPostponedUpgrade()
      const ssh = vi.spyOn(priv(c), 'sshExec')
      const route = ssh.getMockImplementation()!
      // The stay check finds no daemon in the dir: it listened, answered, and exited.
      ssh.mockImplementation(async (...args: unknown[]) => {
        const cmd = String(args[0])
        if (cmd.includes('walnut-live=')) { seen.push('PROVE'); return 'walnut-live=none' }
        if (cmd.startsWith('cat ') && cmd.includes('daemon.pid')) return '7001\n'
        return route(...args)
      })
      const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
      // The connect goes on to the new daemon's link.
      state(c)._connected = true
      // Answered: started, not yet up; the record says so on disk too.
      await updateStoresSettled()
      expect(Object.values(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE, 'utf8')))).toEqual([expect.objectContaining({ expected: EXPECTED, started: expect.objectContaining({ pid: 7001 }) })])
      // Gone within its window: the stay check finds no daemon, and the reconnect starts the old one.
      await vi.waitFor(() => expect(seen).toContain('PROVE'))
      expect(state(c)._replacing).toMatchObject({ started: { pid: 7001 } })
      const start = vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
      await expect(priv(c).deployAndStart()).resolves.toBe(32300)
      expect(start).toHaveBeenCalledWith('node')
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
      expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, reason: expect.stringMatching(/stopped within \d+ s after it started on the real dir/) })
      await updateStoresSettled()
      expect(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE, 'utf8'))).toEqual({})
    } finally {
      ;(DaemonConnection as unknown as { STAY_MS: number }).STAY_MS = stay
      delete process.env.WALNUT_UPDATE_PENDING_FILE
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a new daemon that stayed serving past its window settles the record; a restarted server proves one it finds alive', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-replace-'))
    process.env.WALNUT_UPDATE_PENDING_FILE = path.join(dir, 'pending.json')
    const stay = (DaemonConnection as unknown as { STAY_MS: number }).STAY_MS
    ;(DaemonConnection as unknown as { STAY_MS: number }).STAY_MS = 30
    try {
      const c = make()
      const { seen } = unmanagedOnOld(c)
      await priv(c).recheckPostponedUpgrade()
      const ssh = vi.spyOn(priv(c), 'sshExec')
      const route = ssh.getMockImplementation()!
      ssh.mockImplementation(async (...args: unknown[]) => {
        const cmd = String(args[0])
        if (cmd.includes('walnut-live=')) { seen.push('PROVE'); return 'walnut-live=7001' }
        if (cmd.startsWith('cat ') && cmd.includes('daemon.pid')) return '7001\n'
        return route(...args)
      })
      vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
      state(c)._connected = true
      await vi.waitFor(() => expect(state(c)._replacing).toBeNull())
      expect(state(c)._previous).toBeNull()
      await updateStoresSettled()
      expect(JSON.parse(fs.readFileSync(process.env.WALNUT_UPDATE_PENDING_FILE, 'utf8'))).toEqual({})
      expect(state(c)._realDirFail ?? null).toBeNull()

      // A server restarted after the stop finds a daemon alive in the dir (the old server started it):
      // its window starts now, and it settles once that passed.
      const before = make()
      unmanagedOnOld(before)
      await priv(before).recheckPostponedUpgrade()
      await updateStoresSettled()
      const after = make()
      const afterSeen = stub(after, { probe: probe(), version: EXPECTED })
      state(after)._connected = true
      await priv(after).settleStartedOnLive(8100)
      expect(state(after)._replacing).toMatchObject({ started: { pid: 8100 } })
      const ssh2 = vi.spyOn(priv(after), 'sshExec')
      const route2 = ssh2.getMockImplementation()!
      ssh2.mockImplementation(async (...args: unknown[]) => String(args[0]).includes('walnut-live=') ? (afterSeen.push('PROVE'), 'walnut-live=8100') : route2(...args))
      await vi.waitFor(() => expect(state(after)._replacing).toBeNull())
      expect(afterSeen).toContain('PROVE')
    } finally {
      ;(DaemonConnection as unknown as { STAY_MS: number }).STAY_MS = stay
      delete process.env.WALNUT_UPDATE_PENDING_FILE
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an upload that fails puts the kept files back, so the disk holds the build that serves', async () => {
    const c = make()
    const { seen, lost } = unmanagedOnOld(c)
    vi.spyOn(priv(c), 'deployDaemon').mockImplementation(async () => { seen.push('DEPLOY'); throw new Error('chunk 3 of 9 failed: Connection reset') })
    await priv(c).recheckPostponedUpgrade()
    expect(restoredAfter(seen, 'DEPLOY')).toBe(true)
    expect(state(c)._previous).toBeNull()
    expect(seen.filter((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toEqual([])
    expect(lost).not.toHaveBeenCalled()
  })

  it('work that started during the upload holds the stop, and the kept files go back too', async () => {
    const c = make()
    const { seen, lost } = unmanagedOnOld(c)
    vi.spyOn(priv(c), 'acpTurnsOpen').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await priv(c).recheckPostponedUpgrade()
    expect(restoredAfter(seen, 'DEPLOY')).toBe(true)
    expect(state(c)._previous).toBeNull()
    expect(seen.filter((cmd) => cmd.includes('walnut-daemon-stop-confirmed'))).toEqual([])
    expect(lost).not.toHaveBeenCalled()
  })

  // 2026-11-04 review: a build that passed its trial and did not start on the real dir was
  // tried again after every 10-minute cooldown, each time stopping the healthy old daemon.
  it('a build that did not start on the real dir is not tried again, past the cooldown, until a newer build comes', async () => {
    const c = make()
    const { seen } = unmanagedOnOld(c)
    state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
    vi.spyOn(priv(c), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
    vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
    await expect(priv(c).deployAndStart()).resolves.toBe(32300)
    seen.length = 0
    // The circuit breaker's cooldown is over: only the build's own backoff holds it now.
    state(c)._lastUpgradeAttempt = null
    state(c)._connected = true
    await priv(c).recheckPostponedUpgrade()
    expect(destructive(seen)).toEqual([])
    expect(seen.some((cmd) => cmd.includes('walnut-previous-kept'))).toBe(false)
    // A newer build is tried on its own merits.
    vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-newer0000')
    await priv(c).recheckPostponedUpgrade()
    expect(seen).toContain('DEPLOY')
  })

  it.each([
    ['the kept files cannot be put back', { restore: '' }, /and the old one's files could not be put back: Daemon failed to start/],
    ['the old one does not start again either', { restore: 'walnut-previous-restored' }, /and the old one did not start again either: Daemon failed to start: no port file; then old start failed/],
  ])('a failed start after the stop is recorded when %s', async (_what, o, message) => {
    const c = make()
    const seen = stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'error').mockImplementation(() => {})
    const ssh = vi.spyOn(priv(c), 'sshExec')
    const route = ssh.getMockImplementation()!
    ssh.mockImplementation(async (...args: unknown[]) => {
      if (!String(args[0]).includes('walnut-previous-restored')) return route(...args)
      seen.push('RESTORE')
      return o.restore
    })
    state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
    vi.spyOn(priv(c), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
    vi.spyOn(priv(c), 'startDaemon').mockRejectedValue(new Error('old start failed'))
    await expect(priv(c).deployAndStart()).rejects.toThrow()
    expect(state(c)._updateFailure).toMatchObject({ expected: EXPECTED, message: expect.stringMatching(message) })
    expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED })
    expect(seen).toContain('RESTORE')
  })
})
