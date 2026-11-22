/**
 * The leader's switch of a host to its one Walnut service, through every real piece between the
 * leader's decision and the host's `--service` start, with only the transport played by the test:
 *
 *   DaemonConnection (the real decision: experiments, hello, launcher facts, the manager's word on
 *   the follower)  ->  updateRemoteDaemonService (the real update line, its words quoted for sh)
 *   ->  sh splits the line as the host's shell does  ->  `walnut daemon update`'s own parser
 *   (parseDaemonServiceArgs)  ->  nextServiceMode / writeServiceMode (the mode file)
 *   ->  decideServiceEntry (what the launcher's `<exe> --service` then runs).
 *
 * Then the way back (the experiments off: `--no-serve`, the mode file goes, the entry runs the
 * daemon), and a second Walnut's leader that can never flip it. The process side of a switch (one
 * process, the sessions adopted with their pids) is in one-service-host-e2e.test.ts and
 * in-process-daemon-e2e.test.ts.
 *
 * MACHINE SAFETY: one temp root; the only process run is /bin/sh splitting a line.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { lines, followerFact } = vi.hoisted(() => ({ lines: [] as string[], followerFact: vi.fn(() => ({ kind: 'replica' })) }))
// The real update function; only the host's runner is played: it records the line and answers ok.
vi.mock('../../src/providers/daemon-service-update.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/providers/daemon-service-update.js')>()
  return {
    ...real,
    updateRemoteDaemonService: (source: never, version: string, io: Record<string, unknown>, scope: never, opts: never) => real.updateRemoteDaemonService(source, version, {
      ...io,
      serviceUpdate: async (u: { command: string }) => { lines.push(u.command); return { output: '{"ok":true}', tail: null } },
    } as never, scope, opts),
  }
})
vi.mock('../../src/core/host-server/index.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), hostFollowerFact: followerFact }))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import { parseDaemonServiceArgs } from '../../src/providers/daemon-service-cli.js'
import { decideServiceEntry, nextServiceMode, readServiceMode, writeServiceMode } from '../../src/binary/service-entry.js'
import { resetInProcessDaemonWantedForTests } from '../../src/providers/in-process-daemon.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { EXPECTED, MANAGED, TARGET, priv, state, stub } from '../helpers/daemon-connection-update-stubs.js'

const roots: string[] = []
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }) })
let conns: DaemonConnection[] = []
let env0: Record<string, string | undefined>
beforeEach(() => {
  lines.length = 0
  followerFact.mockClear()
  env0 = { a: process.env.WALNUT_HOST_SERVICE_OFFER, b: process.env.WALNUT_SERVICE_LAUNCHER }
})
afterEach(() => {
  for (const c of conns) { state(c)._connected = false; c.disconnect() }
  conns = []
  for (const [k, v] of [['WALNUT_HOST_SERVICE_OFFER', env0.a], ['WALNUT_SERVICE_LAUNCHER', env0.b]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
  resetInProcessDaemonWantedForTests()
  vi.restoreAllMocks()
})

function experiments(on: boolean): void {
  process.env.WALNUT_HOST_SERVICE_OFFER = on ? '1' : '0'
  process.env.WALNUT_SERVICE_LAUNCHER = on ? '1' : '0'
  resetInProcessDaemonWantedForTests()
}

/** The host: an install root holding this Walnut's follower spec (what the daemon's supervisor keeps). */
function hostDirs(home: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'one-service-chain-'))
  roots.push(root)
  const stateDir = path.join(root, 'state'), runtimeDir = path.join(root, 'd'), launcher = path.join(stateDir, 'launcher')
  fs.mkdirSync(path.join(stateDir, 'host-server'), { recursive: true })
  fs.mkdirSync(launcher, { recursive: true })
  const spec = {
    v: 1, home, walnutId: 'w-test', command: '/srv/app/walnut', args: ['web', '--replica'], cwd: path.join(root, 'data'), log: path.join(root, 'server.log'), port: 41234, settings: {},
    env: { OPEN_WALNUT_HOME: path.join(root, 'data'), WALNUT_DAEMON_DIR: path.join(root, 'run'), WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: 'devbox', WALNUT_LEADER_HOME: home },
  }
  fs.writeFileSync(path.join(stateDir, 'host-server', 'server-0011223344556677.json'), JSON.stringify({ spec, token: crypto.randomBytes(32).toString('hex') }))
  const launcherEnv = { WALNUT_DAEMON_STATE_DIR: stateDir, WALNUT_DAEMON_DIR: runtimeDir, WALNUT_LAUNCHER_DIR: launcher }
  return { stateDir, launcherEnv }
}

/** What `walnut daemon update` does with the line: split by sh, read by its own parser, the mode written for the staged version. */
function hostRuns(line: string, stateDir: string, stagedExe: string): { note?: string } {
  const split = spawnSync('/bin/sh', ['-c', `set -- ${line}; shift 3; for a; do printf '%s\\0' "$a"; done`], { encoding: 'utf8' })
  expect(split.status).toBe(0)
  const argv = split.stdout.split('\0').slice(0, -1)
  const { action, options } = parseDaemonServiceArgs(argv)
  expect(action).toBe('update')
  const read = readServiceMode(stateDir)
  const next = nextServiceMode('mode' in read ? read.mode : null, options.serve, stagedExe)
  writeServiceMode(stateDir, next.mode)
  return next.note ? { note: next.note } : {}
}

/** A managed host on the current build, its daemon under the launcher, as the hello says. */
function leaderOf(serves: { serves: 'daemon' | 'walnut-serve'; serviceHome: string | null }): DaemonConnection {
  const c = new DaemonConnection('devbox', TARGET)
  conns.push(c)
  stub(c, { probe: MANAGED, version: EXPECTED })
  const ssh = priv(c).sshExec as unknown as ReturnType<typeof vi.fn>
  const answer = ssh.getMockImplementation()!
  // The walnut file already in the slot is this build: nothing is uploaded.
  ssh.mockImplementation(async (...args: unknown[]) => (String(args[0]).includes('__daemon --version') ? `${EXPECTED}\n` : answer(...args)))
  vi.spyOn(priv(c), 'serviceDaemonSource').mockResolvedValue({ binary: null, existing: '/slot/walnut' })
  vi.spyOn(priv(c), 'holdUpgradeForFoldPrewarm').mockResolvedValue(false)
  vi.spyOn(priv(c), 'handleConnectionLost').mockImplementation(() => { state(c)._connected = false })
  vi.spyOn(log.session, 'info').mockImplementation(() => {})
  vi.spyOn(log.session, 'warn').mockImplementation(() => {})
  state(c)._launcher = { current: '/v/b/daemon', good: '/v/a/daemon', phase: 'committed', since: 1 }
  state(c)._servesAs = serves
  state(c)._connected = true
  return c
}

describe('a leader switches a host to its one Walnut service, and back', () => {
  it('on: the update line carries --serve, the host writes the mode, and its --service start runs this Walnut\'s follower', async () => {
    experiments(true)
    const { stateDir, launcherEnv } = hostDirs(WALNUT_HOME)
    const c = leaderOf({ serves: 'daemon', serviceHome: null })
    await priv(c).recheckPostponedUpgrade()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(' --launcher --serve ')
    const staged = '/home/u/.local/share/open-walnut/daemon/versions/abc/daemon'
    expect(hostRuns(lines[0]!, stateDir, staged)).toEqual({})
    expect(readServiceMode(stateDir)).toEqual({ mode: { v: 1, home: WALNUT_HOME, exe: staged } })
    const d = decideServiceEntry(launcherEnv, staged)
    expect(d).toMatchObject({ kind: 'serve', home: WALNUT_HOME })
    // The version the launcher would put back runs as the daemon again: the file names this version only.
    expect(decideServiceEntry(launcherEnv, '/home/u/.local/share/open-walnut/daemon/versions/old/daemon').kind).toBe('daemon')
  })

  it('off: this Walnut\'s service goes back with --no-serve, the mode file goes, the start runs the daemon', async () => {
    const { stateDir, launcherEnv } = hostDirs(WALNUT_HOME)
    const staged = '/v/now/daemon'
    writeServiceMode(stateDir, { v: 1, home: WALNUT_HOME, exe: staged })
    experiments(false)
    const c = leaderOf({ serves: 'walnut-serve', serviceHome: WALNUT_HOME })
    await priv(c).recheckPostponedUpgrade()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(' --no-serve ')
    expect(lines[0]).not.toContain('--launcher')
    hostRuns(lines[0]!, stateDir, staged)
    expect(readServiceMode(stateDir)).toMatchObject({ missing: true })
    expect(decideServiceEntry(launcherEnv, staged)).toMatchObject({ kind: 'daemon', quiet: true })
  })

  it('off on a host that runs as the daemon: no update and no new word', async () => {
    experiments(false)
    const c = leaderOf({ serves: 'daemon', serviceHome: null })
    await priv(c).recheckPostponedUpgrade()
    expect(lines).toEqual([])
    expect(followerFact).not.toHaveBeenCalledWith('devbox')
  })

  // Review A3b S34-L3: this Walnut's data dir moved (FIRST -> WALNUT_HOME); the host keeps it under FIRST.
  describe('after a declared home move, the host\'s name for this Walnut', () => {
    const FIRST = `${WALNUT_HOME}-before-the-move`
    /** The leader.configure answer of a host where the move made WALNUT_HOME an alias of FIRST, through the connection's real leader link. */
    function heardHomeHere(c: DaemonConnection): void {
      const link = (priv(c).leaderLink as () => { noteHomeHere(h: string | null): void })()
      link.noteHomeHere(FIRST)
    }

    it('on: the line says --serve with the host\'s home, and the --service start finds the follower spec kept under it', async () => {
      experiments(true)
      const { stateDir, launcherEnv } = hostDirs(FIRST)
      const c = leaderOf({ serves: 'daemon', serviceHome: null })
      heardHomeHere(c)
      await priv(c).recheckPostponedUpgrade()
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(FIRST)
      const staged = '/v/moved/daemon'
      expect(hostRuns(lines[0]!, stateDir, staged)).toEqual({})
      expect(readServiceMode(stateDir)).toEqual({ mode: { v: 1, home: FIRST, exe: staged } })
      expect(decideServiceEntry(launcherEnv, staged)).toMatchObject({ kind: 'serve', home: FIRST })
    })

    it('the service it runs is this Walnut\'s: kept as it is with the experiments on, switched back with them off', async () => {
      const { stateDir, launcherEnv } = hostDirs(FIRST)
      const staged = '/v/now/daemon'
      writeServiceMode(stateDir, { v: 1, home: FIRST, exe: staged })
      experiments(true)
      const on = leaderOf({ serves: 'walnut-serve', serviceHome: FIRST })
      heardHomeHere(on)
      expect(on.servesAs).toEqual({ serves: 'walnut-serve', serviceHome: WALNUT_HOME })
      await priv(on).recheckPostponedUpgrade()
      expect(lines).toEqual([])
      experiments(false)
      const off = leaderOf({ serves: 'walnut-serve', serviceHome: FIRST })
      heardHomeHere(off)
      await priv(off).recheckPostponedUpgrade()
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain(" --no-serve ")
      expect(lines[0]).toContain(FIRST)
      expect(hostRuns(lines[0]!, stateDir, staged)).toEqual({})
      expect(readServiceMode(stateDir)).toMatchObject({ missing: true })
      expect(decideServiceEntry(launcherEnv, staged)).toMatchObject({ kind: 'daemon', quiet: true })
    })

    it('without the host\'s word (no move there) a service of FIRST stays another Walnut\'s', async () => {
      experiments(false)
      const c = leaderOf({ serves: 'walnut-serve', serviceHome: FIRST })
      expect(c.servesAs).toEqual({ serves: 'walnut-serve', serviceHome: FIRST })
      await priv(c).recheckPostponedUpgrade()
      expect(lines).toEqual([])
    })
  })

  it('a second Walnut\'s leader never flips the service of the first, even with words of its own', async () => {
    const { stateDir } = hostDirs(WALNUT_HOME)
    const staged = '/v/now/daemon'
    writeServiceMode(stateDir, { v: 1, home: '/home/first/.open-walnut', exe: staged })
    experiments(false)
    // The decision: another Walnut's service is left as it is (no line at all) ...
    const c = leaderOf({ serves: 'walnut-serve', serviceHome: '/home/first/.open-walnut' })
    await priv(c).recheckPostponedUpgrade()
    expect(lines).toEqual([])
    // ... and a line that asked anyway is refused by the host, the mode carried to the new version.
    const said = hostRuns(`/slot/walnut walnut daemon update --yes --scope user --executable /slot/walnut --no-serve ${WALNUT_HOME}`, stateDir, '/v/next/daemon')
    expect(said.note).toMatch(/^not_service_owner/)
    expect(readServiceMode(stateDir)).toEqual({ mode: { v: 1, home: '/home/first/.open-walnut', exe: '/v/next/daemon' } })
  })
})
