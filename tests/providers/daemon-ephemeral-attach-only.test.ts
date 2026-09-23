/**
 * Unit tests for ephemeral attach-only isolation (DaemonConnection).
 *
 * An ephemeral server (argv --_ephemeral-child) runs over a snapshot of production
 * data. It MAY attach to an already-running remote daemon to debug live sessions,
 * but must NEVER deploy/start/stop/redeploy it — two servers owning the singleton
 * remote daemon caused a redeploy/restart crash loop.
 *
 * The single discriminator gating all destructive paths is the private getter
 * `isReadOnlyRemote` (IS_EPHEMERAL && hostKey !== '__local__'). These tests pin its
 * behavior: remote hosts are read-only under ephemeral; __local__ is exempt; and a
 * non-ephemeral server is never read-only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

// Force the process to look like an ephemeral child for this file.
vi.mock('../../src/constants.js', () => createMockConstants('walnut-eph-test', { IS_EPHEMERAL: true }))

import { DaemonConnection } from '../../src/providers/daemon-connection.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const testSshTarget: SshTarget = {
  hostname: 'clouddev.example.com',
  user: 'testuser',
  use_daemon: true,
}

// Bracket access to read the private getter without exposing it publicly.
function readOnlyRemote(conn: DaemonConnection): boolean {
  return (conn as unknown as { isReadOnlyRemote: boolean }).isReadOnlyRemote
}

describe('ephemeral attach-only: isReadOnlyRemote discriminator', () => {
  it('remote host under ephemeral → read-only (destructive ops gated)', () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    expect(readOnlyRemote(conn)).toBe(true)
  })

  it('__local__ under ephemeral → NOT read-only (local daemon sharing is safe)', () => {
    const conn = new DaemonConnection('__local__', null)
    expect(readOnlyRemote(conn)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════
//  The discriminator above is necessary but not sufficient: a green
//  getter doesn't prove the destructive call sites actually honor it.
//  These tests drive the real control flow to each guard and assert the
//  destructive method (deploy / start / forceRedeploy / sshExec --stop)
//  is NEVER invoked. If the fix were reverted (guards removed), each of
//  these would fall through and call the spied destructive method → fail.
// ═══════════════════════════════════════════════════════════════════

describe('ephemeral attach-only: prevents destructive daemon ops', () => {
  // Cast helper: reach private methods/getters for spying + invocation.
  const priv = (conn: DaemonConnection) => conn as unknown as Record<string, (...args: unknown[]) => unknown>
  // Attaching to a remote host at all is opt-in for ephemeral servers now (see
  // 'ephemeral remote hosts' below); these tests pin what an OPTED-IN one may do.
  const savedOptIn = process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
  beforeEach(() => { process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = '1' })
  afterEach(() => {
    if (savedOptIn === undefined) delete process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
    else process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = savedOptIn
  })

  it('Test 1 — connect(), no daemon running → throws attach-only, never deploys/starts', async () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'checkDaemonRunning').mockResolvedValue(null)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(12345)

    await expect(conn.connect()).rejects.toThrow(/attach-only/)
    expect(deploy).toHaveBeenCalledTimes(0)
    expect(start).toHaveBeenCalledTimes(0)
  })

  it('Test 2 — connect() handshake fail → throws attach-only, never forceRedeploy', async () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    // Non-null port → skip the deploy branch and reach the handshake guard.
    vi.spyOn(priv(conn), 'checkDaemonRunning').mockResolvedValue(9999)
    vi.spyOn(priv(conn), 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv(conn), 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'verifyCapabilities').mockResolvedValue(false)
    const redeploy = vi.spyOn(priv(conn), 'forceRedeployAndReconnect').mockResolvedValue(undefined)

    await expect(conn.connect()).rejects.toThrow(/attach-only/)
    expect(redeploy).toHaveBeenCalledTimes(0)

    conn.disconnect()
  })

  it('Test 3 — shouldUpgradeDaemon → false, never sshExec', async () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    const ssh = vi.spyOn(priv(conn), 'sshExec').mockResolvedValue('')

    await expect(priv(conn).shouldUpgradeDaemon('/tmp/open-walnut/daemon-linux-x64')).resolves.toBe(false)
    expect(ssh).toHaveBeenCalledTimes(0)
  })

  it('Test 4 — forceRedeployAndReconnect backstop throws directly, never deploy/start', async () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockImplementation(vi.fn())
    const start = vi.spyOn(priv(conn), 'startDaemon').mockImplementation(vi.fn())

    await expect(priv(conn).forceRedeployAndReconnect()).rejects.toThrow(/attach-only/)
    expect(deploy).toHaveBeenCalledTimes(0)
    expect(start).toHaveBeenCalledTimes(0)
  })

  it('Test 5a — reconnect() with daemon absent → throws, never deploys/starts', async () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    // Drive past reconnect()'s early returns: not destroyed (fresh instance),
    // host !== '__local__' with sshTarget → takes the SSH branch.
    vi.spyOn(priv(conn), 'stopControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'checkDaemonRunning').mockResolvedValue(null)
    const deploy = vi.spyOn(priv(conn), 'deployDaemon').mockResolvedValue(undefined)
    const start = vi.spyOn(priv(conn), 'startDaemon').mockResolvedValue(12345)

    await expect(priv(conn).reconnect()).rejects.toThrow(/attach-only|not redeploying/)
    expect(deploy).toHaveBeenCalledTimes(0)
    expect(start).toHaveBeenCalledTimes(0)
  })

  it('Test 5b — reconnect() handshake fail → throws, never forceRedeploy', async () => {
    const conn = new DaemonConnection('clouddev', testSshTarget)
    vi.spyOn(priv(conn), 'stopControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    // Non-null port → skip deploy branch, reach the reconnect handshake guard.
    vi.spyOn(priv(conn), 'checkDaemonRunning').mockResolvedValue(9999)
    vi.spyOn(priv(conn), 'createTunnel').mockResolvedValue(5555)
    vi.spyOn(priv(conn), 'connectWebSocket').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'verifyCapabilities').mockResolvedValue(false)
    const redeploy = vi.spyOn(priv(conn), 'forceRedeployAndReconnect').mockResolvedValue(undefined)

    await expect(priv(conn).reconnect()).rejects.toThrow(/attach-only|not redeploying/)
    expect(redeploy).toHaveBeenCalledTimes(0)

    conn.disconnect()
  })
})

// ═══════════════════════════════════════════════════════════════════
//  2026-09-23: a remote daemon hands relayed work (phone requests, the
//  `walnut` calls of its sessions) to whichever server it sees first, so a
//  test server attached there could answer the real Walnut's traffic and its
//  own test sessions' calls could land on the real Walnut. Default: stay off.
// ═══════════════════════════════════════════════════════════════════

describe('ephemeral remote hosts: off unless WALNUT_EPHEMERAL_REMOTE_HOSTS=1', () => {
  const priv = (conn: DaemonConnection) => conn as unknown as Record<string, (...args: unknown[]) => unknown>
  const saved = process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
  afterEach(() => {
    if (saved === undefined) delete process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
    else process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = saved
  })

  it('refuses before any SSH, with a message the connect hint recognises', async () => {
    delete process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
    const conn = new DaemonConnection('clouddev', testSshTarget)
    const ssh = vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    const probe = vi.spyOn(priv(conn), 'checkDaemonRunning').mockResolvedValue(9999)

    await expect(conn.connect()).rejects.toThrow(/ephemeral server: remote host 'clouddev' is off for test servers/)
    expect(ssh).toHaveBeenCalledTimes(0)
    expect(probe).toHaveBeenCalledTimes(0)
    const { classifyHostConnectError } = await import('../../src/core/sessions/host-connect-hint.js')
    expect(classifyHostConnectError(`ephemeral server: remote host 'clouddev' is off for test servers`, 'clouddev').kind).toBe('ephemeral')
  })

  it('the opt-in reaches the attach path (contrast: the gate is what stopped it)', async () => {
    process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = '1'
    const conn = new DaemonConnection('clouddev', testSshTarget)
    const ssh = vi.spyOn(priv(conn), 'ensureControlMaster').mockResolvedValue(undefined)
    vi.spyOn(priv(conn), 'checkDaemonRunning').mockResolvedValue(null)

    await expect(conn.connect()).rejects.toThrow(/attach-only/)
    expect(ssh).toHaveBeenCalledTimes(1)
  })

  it('never pushes the cloud bridge config, not even to its own local daemon', async () => {
    const conn = new DaemonConnection('__local__', null)
    const send = vi.spyOn(conn, 'send').mockResolvedValue({ ok: true } as never)
    priv(conn).pushBridgeConfig()
    // Deterministic: an ungated push claims its in-flight slot synchronously,
    // before any of the async work a timed wait would have to outlast.
    expect(priv(conn).bridgePushInFlight).toBeFalsy()
    await new Promise((r) => setTimeout(r, 20))
    expect(send.mock.calls.filter((c) => c[0] === 'bridge.configure')).toHaveLength(0)
  })
})
