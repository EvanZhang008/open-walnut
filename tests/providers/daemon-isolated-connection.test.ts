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
import { isolationKey } from '../../src/providers/remote-isolation.js'
import type { SshTarget } from '../../src/providers/session-io.js'

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
      if (s.includes('walnut-dir-probe v1')) return execFileSync('/bin/sh', ['-s'], { input: s, encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: home } })
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
