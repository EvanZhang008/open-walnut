/**
 * The SSH way back after an unmanaged update's stop holds until the old daemon runs again
 * (2026-11-04 review 4): a restore or a start of the old one that fails leaves the stop's
 * record marked (`back`), so the next connect, and a restarted server, go back again and never
 * deploy the build that just failed; the mark goes once that build is no longer held. With the
 * build held and no daemon, the old one's files come back from the kept copy (which survives a
 * reboot) before its start, and the held build, started when that fails, is watched. A stop's
 * record past its age is not read.
 *
 * All SSH is stubbed at sshExec (tests/helpers/daemon-connection-update-stubs.ts); no
 * process, socket or tunnel is created. The one file written is each test's own temp file.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonConnection, setPooledConnectionForTest } from '../../src/providers/daemon-connection.js'
import { log } from '../../src/logging/index.js'
import { updateStoresSettled } from '../../src/providers/daemon-update-store.js'
import { EXPECTED, OLD, TARGET, priv, state, probe, stub, type Routes } from '../helpers/daemon-connection-update-stubs.js'

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

describe('the SSH way back holds until the old daemon runs again', () => {
  /** An unmanaged SSH host running OLD, connected (as in daemon-connection-unmanaged-rollback.test.ts). */
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
  /** The pending file of this test (a server restart reads it), and a cleanup. */
  function pendingFile(): { file: string; done(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-pending-replace-'))
    process.env.WALNUT_UPDATE_PENDING_FILE = path.join(dir, 'pending.json')
    return { file: process.env.WALNUT_UPDATE_PENDING_FILE, done: () => { delete process.env.WALNUT_UPDATE_PENDING_FILE; fs.rmSync(dir, { recursive: true, force: true }) } }
  }
  /** Answers the restore with `restores` in turn (the last repeats): '' fails, the marker puts the files back. */
  function restoreAnswers(c: DaemonConnection, seen: string[], restores: string[]) {
    const ssh = vi.spyOn(priv(c), 'sshExec')
    const route = ssh.getMockImplementation()!
    let n = 0
    ssh.mockImplementation(async (...args: unknown[]) => {
      if (!String(args[0]).includes('walnut-previous-restored')) return route(...args)
      seen.push('RESTORE')
      return restores[Math.min(n++, restores.length - 1)]
    })
  }

  // 2026-11-04 review 4: the stop's record was dropped before the restore and the start, so one
  // that failed once (an SSH timeout in the 120 s restore, a slow start) left the next connect no
  // way back: it deployed the held build again, which listened and died on every reconnect.
  it.each([
    ['the restore', { restores: ['', 'walnut-previous-restored'], starts: 1 }],
    ['the old one\'s start', { restores: ['walnut-previous-restored'], starts: 2 }],
  ])('%s failing once keeps the way back: the next connect, and a restarted server, go back again, never deploy the held build', async (_what, o) => {
    const pending = pendingFile()
    try {
      const c = make()
      const seen = stub(c, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'error').mockImplementation(() => {})
      restoreAnswers(c, seen, o.restores)
      state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
      state(c)._replacing = { expected: EXPECTED, dir: state(c)._remoteDir, at: Date.now() }
      const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockRejectedValue(new Error('Daemon failed to start: no port file'))
      const start = vi.spyOn(priv(c), 'startDaemon')
      if (o.starts === 2) start.mockRejectedValueOnce(new Error('Daemon failed to start: ssh timed out'))
      start.mockResolvedValue(32300)
      await expect(priv(c).deployAndStart()).rejects.toThrow()
      expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, back: true })
      await updateStoresSettled()
      expect(Object.values(JSON.parse(fs.readFileSync(pending.file, 'utf8')))).toEqual([expect.objectContaining({ expected: EXPECTED, back: true, previous: { runtime: 'node', bunPath: null } })])
      // A server restarted now reads the mark: back to the old one, no deploy.
      const restarted = make()
      const again = stub(restarted, { probe: probe(), version: OLD })
      const restartedFresh = vi.spyOn(priv(restarted), 'deployAndStartNew').mockResolvedValue(32400)
      vi.spyOn(priv(restarted), 'startDaemon').mockResolvedValue(32301)
      await expect(priv(restarted).deployAndStart()).resolves.toBe(32301)
      expect(restartedFresh).not.toHaveBeenCalled()
      expect(again.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(true)
      // The same connection's next connect too (its record in memory).
      await expect(priv(c).deployAndStart()).resolves.toBe(32300)
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenLastCalledWith('node')
      expect(state(c)._replacing).toBeNull()
      expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, reason: 'Daemon failed to start: no port file', previous: { runtime: 'node', bunPath: null } })
      await updateStoresSettled()
      expect(JSON.parse(fs.readFileSync(pending.file, 'utf8'))).toEqual({})
    } finally { pending.done() }
  })

  it('the mark goes once that build is no longer held: a newer build is deployed when the old one cannot come back', async () => {
    const pending = pendingFile()
    try {
      const c = make()
      const seen = stub(c, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'error').mockImplementation(() => {})
      restoreAnswers(c, seen, [''])
      state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
      state(c)._replacing = { expected: EXPECTED, dir: state(c)._remoteDir, at: Date.now(), back: true }
      state(c)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not start' }
      vi.spyOn(priv(c), 'getExpectedDaemonVersion').mockReturnValue('walnut-daemon-newer0000')
      const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(state(c)._replacing).toBeNull()
    } finally { pending.done() }
  })

  // 2026-11-04 review 5: while the build was held, a way back that kept failing was all the host
  // got, so it had no daemon for up to the build's whole day off.
  it.each([
    ['fails twice', ['', ''], 2],
    ['finds no copy to put back', ['walnut-previous-none'], 1],
  ] as const)('a way back that %s hands the host to the build there, watched', async (_what, restores, tries) => {
    const pending = pendingFile()
    try {
      const c = make()
      const seen = stub(c, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'error').mockImplementation(() => {})
      vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      restoreAnswers(c, seen, [...restores])
      state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
      state(c)._replacing = { expected: EXPECTED, dir: state(c)._remoteDir, at: Date.now(), back: true }
      state(c)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not start' }
      const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
      vi.spyOn(priv(c), 'scheduleStayCheck').mockImplementation(() => {})
      for (let n = 1; n < tries; n++) {
        await expect(priv(c).deployAndStart()).rejects.toThrow()
        // Counted on disk, so a restarted server counts on.
        await updateStoresSettled()
        expect(Object.values(JSON.parse(fs.readFileSync(pending.file, 'utf8')))).toEqual([expect.objectContaining({ back: true, backTries: n })])
      }
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
      expect(fresh).toHaveBeenCalledTimes(1)
      // Started, and its stay watched like any start of the held build.
      expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.any(Object) })
      expect(state(c)._replacing.back).toBeUndefined()
    } finally { pending.done() }
  })

  // 2026-11-04 review 4: <dir>/previous lived in /tmp, so after a reboot the held-back start found
  // no files and the connect deployed the held build; and that start was not watched.
  it('with the build held and no daemon, the old one\'s files are put back from the kept copy before its start; the held build, started when that fails, is watched', async () => {
    const pending = pendingFile()
    try {
      const c = make()
      const seen = stub(c, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      state(c)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not start', previous: { runtime: 'binary', bunPath: null } }
      const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
      const start = vi.spyOn(priv(c), 'startDaemon').mockImplementation(async () => { seen.push('START'); return 32300 })
      await expect(priv(c).deployAndStart()).resolves.toBe(32300)
      const restoreAt = seen.findIndex((cmd) => cmd.includes('walnut-previous-restored'))
      expect(restoreAt).toBeGreaterThanOrEqual(0)
      expect(restoreAt).toBeLessThan(seen.indexOf('START'))
      // A kept copy of the held build itself is never put back.
      expect(seen[restoreAt]).toContain(`= '${EXPECTED}' ] && { echo walnut-previous-none; exit 0; }`)
      expect(fresh).not.toHaveBeenCalled()
      // The old one does not start either: the held build is started, and its stay watched.
      start.mockRejectedValueOnce(new Error('Daemon failed to start: no such file'))
      vi.spyOn(priv(c), 'scheduleStayCheck').mockImplementation(() => {})
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
      expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.objectContaining({ at: expect.any(Number) }) })
      expect(state(c)._previous).toBeNull()
    } finally { pending.done() }
  })

  // 2026-11-04 review 5: a watched start of the held build that died rewrote the hold without how
  // the one before ran, so every connect after deployed the held build again and never that one.
  it('a start of the held build that died keeps how the one before ran: the next connect starts that one, never the held build again', async () => {
    const pending = pendingFile()
    try {
      const c = make()
      stub(c, { probe: probe(), version: OLD })
      vi.spyOn(log.session, 'warn').mockImplementation(() => {})
      vi.spyOn(log.session, 'error').mockImplementation(() => {})
      state(c)._realDirFail = { expected: EXPECTED, at: Date.now() - 60_000, reason: 'it did not start', previous: { runtime: 'binary', bunPath: null } }
      const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
      const start = vi.spyOn(priv(c), 'startDaemon').mockRejectedValueOnce(new Error('Daemon failed to start: ssh timed out')).mockResolvedValue(32300)
      vi.spyOn(priv(c), 'scheduleStayCheck').mockImplementation(() => {})
      // The old one did not start once: the held build is started, watched.
      await expect(priv(c).deployAndStart()).resolves.toBe(32400)
      expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.any(Object) })
      // It was gone within its window: the next connect, no daemon there, starts the old one.
      await expect(priv(c).deployAndStart()).resolves.toBe(32300)
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(start).toHaveBeenLastCalledWith('binary')
      expect(state(c)._realDirFail).toMatchObject({ expected: EXPECTED, previous: { runtime: 'binary', bunPath: null } })
      expect(state(c)._replacing).toBeNull()
      expect(state(c)._updateFailure).toMatchObject({ expected: EXPECTED, message: expect.stringContaining('so the one that ran before was started again') })
    } finally { pending.done() }
  })

  it('with nothing put back and the held build\'s files on disk, those are never started as the one before: the held build is deployed, watched', async () => {
    const c = make()
    const seen = stub(c, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    const ssh = vi.spyOn(priv(c), 'sshExec')
    const route = ssh.getMockImplementation()!
    ssh.mockImplementation(async (...args: unknown[]) => {
      const cmd = String(args[0])
      if (cmd.includes('walnut-previous-restored')) { seen.push('RESTORE'); return '' }
      if (cmd.includes('walnut-files-carry-build')) { seen.push('CARRIES'); return 'walnut-files-carry-build\n' }
      return route(...args)
    })
    state(c)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not start', previous: { runtime: 'binary', bunPath: null } }
    const start = vi.spyOn(priv(c), 'startDaemon').mockResolvedValue(32300)
    const fresh = vi.spyOn(priv(c), 'deployAndStartNew').mockResolvedValue(32400)
    vi.spyOn(priv(c), 'scheduleStayCheck').mockImplementation(() => {})
    await expect(priv(c).deployAndStart()).resolves.toBe(32400)
    expect(seen).toEqual(expect.arrayContaining(['RESTORE', 'CARRIES']))
    expect(start).not.toHaveBeenCalled()
    expect(fresh).toHaveBeenCalledTimes(1)
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: expect.any(Object) })
  })

  // 2026-11-04 review 5: a daemon found running while the record said "go back" was taken for the
  // old one, also when it was the held build that came up late, and its runtime kept as the way back.
  it('marked to go back, a daemon that is the held build after all is watched; the old one come back settles the mark', async () => {
    const c = make()
    stub(c, { probe: probe(), version: EXPECTED })
    vi.spyOn(log.session, 'warn').mockImplementation(() => {})
    vi.spyOn(priv(c), 'scheduleStayCheck').mockImplementation(() => {})
    state(c)._previous = { dir: state(c)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
    state(c)._replacing = { expected: EXPECTED, dir: state(c)._remoteDir, at: Date.now(), back: true }
    state(c)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not come to serve' }
    await priv(c).settleStartedOnLive(4242)
    expect(state(c)._replacing).toMatchObject({ expected: EXPECTED, started: { pid: 4242 } })
    expect(state(c)._replacing.back).toBeUndefined()
    expect(state(c)._realDirFail.previous).toBeUndefined()

    const old = make()
    stub(old, { probe: probe(), version: OLD })
    vi.spyOn(log.session, 'info').mockImplementation(() => {})
    state(old)._previous = { dir: state(old)._remoteDir, runtime: 'node', bunPath: null, at: Date.now(), stopped: true }
    state(old)._replacing = { expected: EXPECTED, dir: state(old)._remoteDir, at: Date.now(), back: true }
    state(old)._realDirFail = { expected: EXPECTED, at: Date.now(), reason: 'it did not come to serve' }
    await priv(old).settleStartedOnLive(4343)
    expect(state(old)._replacing).toBeNull()
    expect(state(old)._realDirFail).toMatchObject({ expected: EXPECTED, previous: { runtime: 'node', bunPath: null } })
  })

  // 2026-11-04 review 4: a stop's record had no age at all, so one a host that never came back
  // left (or one under an old host name) stayed for good.
  it('a stop\'s record past its age is not read: the host is started as a new one', async () => {
    const pending = pendingFile()
    try {
      const first = make()
      unmanagedOnOld(first)
      await priv(first).recheckPostponedUpgrade()
      await updateStoresSettled()
      const late = Date.now() + 8 * 24 * 3600_000
      vi.spyOn(Date, 'now').mockImplementation(() => late)
      const second = make()
      const seen = stub(second, { probe: probe(), version: OLD })
      vi.spyOn(priv(second), 'deployAndStartNew').mockResolvedValue(32400)
      await expect(priv(second).deployAndStart()).resolves.toBe(32400)
      expect(state(second)._replacing).toBeNull()
      expect(seen.some((cmd) => cmd.includes('walnut-previous-restored'))).toBe(false)
    } finally { pending.done() }
  })
})
