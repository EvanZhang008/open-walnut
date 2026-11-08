/**
 * What an isolated connection (a test server on a remote host, remote-isolation.ts)
 * sends to the host: every script of the connect path (dir probe, live daemon scan,
 * bun probe and install, the start) is captured and must name only the test
 * server's own dirs, and the hello of a daemon that is not the test server's own
 * is refused, never redeployed. The production side: a real server refuses a
 * test server's daemon.
 *
 * MACHINE SAFETY: no host is dialled. The dir probe runs for real under /bin/sh with
 * a temp HOME (its root is this file's own key, removed after); every other script
 * is only captured and answered with a canned reply.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const state = vi.hoisted(() => ({ ephemeral: true }))
vi.mock('../../src/constants.js', () => {
  const c = createMockConstants('walnut-iso-conn') as Record<string, unknown>
  return { ...c, get IS_EPHEMERAL() { return state.ephemeral } }
})

import { DaemonConnection, DaemonIdentityError } from '../../src/providers/daemon-connection.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { isolatedDaemonEnv, isolationKey } from '../../src/providers/remote-isolation.js'
import type { SshTarget } from '../../src/providers/session-io.js'
import { guardedPath } from '../setup/exec-guard.js'
import { writeBuildBackoff } from '../../src/providers/daemon-build-backoff.js'
import { pendingReplaces } from '../../src/providers/daemon-update-store.js'
import { unreadUpdates } from '../../src/providers/daemon-update-readback.js'

const target: SshTarget = { hostname: 'devbox.example.com', user: 'tester', use_daemon: true }
const priv = (c: DaemonConnection) => c as unknown as Record<string, unknown> & Record<string, (...a: unknown[]) => Promise<unknown>>
const PROD_PATH = /\/tmp\/open-walnut(?![-\w])|\.cache\/open-walnut(?![-\w])/
const saved = process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
const cleanup: string[] = []

beforeEach(() => { state.ephemeral = true; process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = '1' })
afterEach(() => {
  if (saved === undefined) delete process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
  else process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = saved
  for (const d of cleanup.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('an isolated connection writes only under its own root', () => {
  it('captures every connect-path script: own dirs only, installs under its own HOME', async () => {
    const key = isolationKey(WALNUT_HOME)
    const root = `/tmp/open-walnut-test-${key}`
    cleanup.push(root)
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-iso-conn-home-')))
    cleanup.push(home)
    const scripts: string[] = []
    const conn = new DaemonConnection('devbox', target)
    expect(conn.isolation).toMatchObject({ mode: 'isolated', key })
    vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (script: unknown) => {
      const s = String(script)
      scripts.push(s)
      // The dir probe runs for real, in a temp HOME; everything else gets a reply that ends its step.
      if (s.includes('walnut-dir-probe v1')) return execFileSync('/bin/sh', ['-s'], { input: s, encoding: 'utf-8', env: { PATH: guardedPath([], '/usr/bin:/bin'), HOME: home } })
      if (s.includes('walnut-live')) return 'walnut-live none\n'
      return ''
    })

    await priv(conn).resolveRemoteDir()
    expect(priv(conn)._remoteDir).toBe(`${root}/daemon`)
    expect(conn.isolatedRoot).toBe(root)

    await priv(conn).checkDaemonRunning().catch(() => null)
    await priv(conn).probeOrInstallBun().catch(() => null)
    priv(conn)._bunPath = `${root}/home/.bun/bin/bun`
    priv(conn)._deployedViaSource = true
    await priv(conn).startDaemon('bun').catch(() => null)

    expect(scripts.length).toBeGreaterThanOrEqual(4)
    for (const s of scripts) expect(s, s.slice(0, 400)).not.toMatch(PROD_PATH)
    // The bun probe may run a bun the user already has (`--version`, a read); only the installer writes, and never into ~/.bun.
    for (const s of scripts.filter((x) => !x.includes('bun_path='))) expect(s, s.slice(0, 400)).not.toMatch(/\$HOME\/\.bun|~\/\.bun/)

    const install = scripts.find((s) => s.includes('BUN_INSTALL='))
    expect(install).toBeDefined()
    expect(install).toContain(`HOME='${root}/home'`)
    expect(install).toContain(`BUN_INSTALL='${root}/home/.bun'`)

    const start = scripts.find((s) => s.includes('nohup'))
    expect(start).toBeDefined()
    for (const [k, v] of [
      ['WALNUT_DAEMON_DIR', `${root}/daemon`], ['WALNUT_STREAMS_DIR', `${root}/streams`], ['WALNUT_INSTALL_HOME', `${root}/home`],
      ['WALNUT_TASK_DIR_ROOT', `${root}/tasks`], ['WALNUT_DAEMON_ISOLATED_FOR', key],
    ]) expect([`${k}=${v}`, `${k}='${v}'`].some((w) => start!.includes(w)), k).toBe(true)
  })

  it('never takes the production daemon there: its hello is refused, never redeployed', async () => {
    const conn = new DaemonConnection('devbox', target)
    const iso = conn.isolation
    expect(iso.mode).toBe('isolated')
    vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, dir: '/tmp/open-walnut', capabilities: [] })
    const redeploy = vi.spyOn(priv(conn), 'forceRedeployAndReconnect').mockResolvedValue(undefined)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue('bun')
    await expect(priv(conn).verifyCapabilities()).rejects.toBeInstanceOf(DaemonIdentityError)
    expect(redeploy).not.toHaveBeenCalled()
    expect(deploy).not.toHaveBeenCalled()
  })

  it('takes its own daemon in its own dir', async () => {
    const conn = new DaemonConnection('devbox', target)
    const iso = conn.isolation
    if (iso.mode !== 'isolated') throw new Error('expected isolated')
    vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, dir: priv(conn)._remoteDir, isolatedFor: iso.key, capabilities: [] })
    // Missing capabilities answer false; the point is that identity let it through.
    await expect(priv(conn).verifyCapabilities()).resolves.toBe(false)
  })
})

describe('an isolated connection never acts on the real server\'s update records', () => {
  // A test server's data is a copy of the real one's, machine-local update records included: each
  // names the host's real daemon dir, which a restore, a read back or a removal would write in.
  const seed = async () => {
    const at = Date.now()
    await writeBuildBackoff('ssh:devbox', { expected: 'build-held', at, reason: 'it did not stay serving', previous: { runtime: 'bun', bunPath: '/usr/bin/bun' } })
    await pendingReplaces.write('ssh:devbox', { at, dir: '/tmp/open-walnut', expected: 'build-new', previous: { runtime: 'bun', bunPath: '/usr/bin/bun' } })
    await unreadUpdates.write('ssh:devbox', { at, directory: '/tmp/walnut-update.real', expected: 'build-new' })
  }
  const FILES = { WALNUT_BUILD_BACKOFF_FILE: 'backoff.json', WALNUT_UPDATE_PENDING_FILE: 'pending.json', WALNUT_UPDATE_UNREAD_FILE: 'unread.json' }
  const before: Record<string, string | undefined> = {}
  beforeEach(() => {
    // A test run keeps no store file unless one is named.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-iso-records-'))
    cleanup.push(dir)
    for (const [k, f] of Object.entries(FILES)) { before[k] = process.env[k]; process.env[k] = path.join(dir, f) }
  })
  afterEach(() => {
    for (const k of Object.keys(FILES)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k] }
  })

  it('reads none of them, so it restores, reads back and removes nothing outside its root', async () => {
    await seed()
    const conn = new DaemonConnection('devbox', target)
    expect(conn.isolation.mode).toBe('isolated')
    const ssh = vi.spyOn(priv(conn), 'sshExec').mockResolvedValue('')
    expect(await priv(conn).realDirFailure()).toBeNull()
    await priv(conn).loadPendingReplace()
    expect(priv(conn)._replacing ?? null).toBeNull()
    expect(priv(conn)._previous ?? null).toBeNull()
    expect(await priv(conn).readBackUnreadOnce()).toBeNull()
    expect(ssh).not.toHaveBeenCalled()
  })

  it('a real server reads them as always', async () => {
    state.ephemeral = false
    await seed()
    const conn = new DaemonConnection('devbox', target)
    expect(conn.isolation).toEqual({ mode: 'shared' })
    expect(await priv(conn).realDirFailure()).toMatchObject({ expected: 'build-held' })
    await priv(conn).loadPendingReplace()
    expect(priv(conn)._replacing).toMatchObject({ dir: '/tmp/open-walnut', expected: 'build-new' })
  })

  it('its trial of a staged build stays under its own root, in the runtime dir its daemon gets', async () => {
    const conn = new DaemonConnection('devbox', target)
    const iso = conn.isolation
    if (iso.mode !== 'isolated') throw new Error('expected isolated')
    const dir = String(priv(conn)._remoteDir)
    const root = path.posix.dirname(dir)
    priv(conn)._staged = { runtime: 'node', dir, at: Date.now(), bunPath: null }
    const scripts: string[] = []
    vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (script: unknown) => { scripts.push(String(script)); return '' })
    await priv(conn).trialStaged()
    expect(scripts.length).toBeGreaterThan(0)
    const runtimeDir = isolatedDaemonEnv(root, iso.key).WALNUT_RUNTIME_DIR
    for (const s of scripts) {
      expect(s).toContain(`trd='${runtimeDir}'`)
      expect(s).toContain(`mktemp -d '${root}'/walnut-proof.`)
      expect(s).toContain(`for o in '${root}'/walnut-proof.*`)
      expect(s).not.toMatch(PROD_PATH)
      expect(s).not.toContain('/tmp/walnut-proof')
    }
  })

  it('a real server\'s trial runs as always', async () => {
    state.ephemeral = false
    const conn = new DaemonConnection('devbox', target)
    priv(conn)._staged = { runtime: 'node', dir: '/tmp/open-walnut', at: Date.now(), bunPath: null }
    const scripts: string[] = []
    vi.spyOn(priv(conn), 'sshExec').mockImplementation(async (script: unknown) => { scripts.push(String(script)); return '' })
    await priv(conn).trialStaged()
    for (const s of scripts) {
      expect(s).toContain("mktemp -d '/tmp'/walnut-proof.")
      expect(s).toContain('trd="$HOME/.open-walnut/local/runtime"')
    }
  })
})

describe('a real server never talks to a test server\'s daemon', () => {
  it('refuses a hello that names a test server', async () => {
    state.ephemeral = false
    const conn = new DaemonConnection('devbox', target)
    expect(conn.isolation).toEqual({ mode: 'shared' })
    vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, dir: '/tmp/open-walnut-test-aaaaaaaaaaaaaaaa/daemon', isolatedFor: 'aaaaaaaaaaaaaaaa', capabilities: [] })
    await expect(priv(conn).verifyCapabilities()).rejects.toBeInstanceOf(DaemonIdentityError)
  })
  it('takes its host daemon as always', async () => {
    state.ephemeral = false
    const conn = new DaemonConnection('devbox', target)
    vi.spyOn(priv(conn), '_sendHandshake').mockResolvedValue({ ok: true, dir: '/tmp/open-walnut', capabilities: [] })
    await expect(priv(conn).verifyCapabilities()).resolves.toBe(false)
  })
})
