/**
 * The Demo's remote hosts (src/providers/demo-remote-host.ts): on a Demo server
 * (IS_DEMO, which is always an ephemeral one too) a host reached over ssh gets the
 * isolated daemon any test server gets there (src/providers/remote-isolation.ts),
 * in the default roots named by the Demo's data dir, with no
 * WALNUT_EPHEMERAL_REMOTE_HOSTS.
 *
 * Invariants pinned here:
 *   - the decision: an ssh host is the Demo's; `__local__`, the companion's box and
 *     a host network machine are not; a non-Demo server has none;
 *   - a Demo DaemonConnection is isolated, not read only, and starts in its own root;
 *   - once the Demo's stop began, a new connection is off, one already made keeps
 *     its daemon so the stop can retire it;
 *   - every gate that said "Off on this test server" treats a Demo host as on;
 *   - what stays off in the Demo: boot start setup, a host server, plugin jobs on a
 *     remote host;
 *   - the Demo's stop retires its daemon (stop and root removal) after the link
 *     left the pool, and refuses any host whose daemon is not the Demo's.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-demo-remote-test', { IS_EPHEMERAL: true, IS_DEMO: true }))

import {
  DaemonConnection, demoLiftedConnections, peekDaemonConnection, setPooledConnectionForTest,
} from '../../src/providers/daemon-connection.js'
import {
  _reopenDemoRemoteHostsForTesting, closeDemoRemoteHosts, demoIsolationInput, isDemoLiftedHost,
} from '../../src/providers/demo-remote-host.js'
import { isolationKey } from '../../src/providers/remote-isolation.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { hostStatusFrame, remoteHostsOff } from '../../src/core/hosts/host-connect-action.js'
import { getHostServerManager } from '../../src/core/host-server/index.js'
import { pluginJobsConnected } from '../../src/core/plugin-jobs/index.js'
import type { SshTarget } from '../../src/providers/session-io.js'

const TARGET: SshTarget = { hostname: 'devbox.example.test', user: 'marina', use_daemon: true }
const KEYS = ['WALNUT_EPHEMERAL_REMOTE_HOSTS', 'WALNUT_EPHEMERAL_REPLICA_HOST'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
  _reopenDemoRemoteHostsForTesting()
})
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _reopenDemoRemoteHostsForTesting()
  vi.restoreAllMocks()
})

type Priv = Record<string, unknown> & Record<string, (...args: unknown[]) => unknown>
const priv = (c: DaemonConnection) => c as unknown as Priv
const readOnly = (c: DaemonConnection) => priv(c).isReadOnlyRemote as boolean

describe('the decision', () => {
  it('an ssh host is the Demo\'s, on a Demo server only', () => {
    expect(isDemoLiftedHost('devbox', { transport: 'ssh' }, true)).toBe(true)
    expect(isDemoLiftedHost('devbox', undefined, true)).toBe(true)
    expect(isDemoLiftedHost('devbox', undefined, false)).toBe(false)
  })

  it('never the local daemon, the companion\'s box or a host network machine', () => {
    expect(isDemoLiftedHost('__local__', undefined, true)).toBe(false)
    expect(isDemoLiftedHost('__cloudbox__', undefined, true)).toBe(false)
    expect(isDemoLiftedHost('', undefined, true)).toBe(false)
    expect(isDemoLiftedHost('cloud', { cloud_box: true }, true)).toBe(false)
    expect(isDemoLiftedHost('lab', { transport: 'net' }, true)).toBe(false)
  })

  it('the isolation input says a Demo, and whether its stop began; nothing for another server', () => {
    expect(demoIsolationInput(false)).toBeUndefined()
    expect(demoIsolationInput(true)).toEqual({ closed: false })
    closeDemoRemoteHosts()
    expect(demoIsolationInput(true)).toEqual({ closed: true })
    expect(demoIsolationInput(false)).toBeUndefined()
  })
})

describe('DaemonConnection on a Demo server', () => {
  it('an ssh host is isolated without the remote-host opt-in, in the default root named by the Demo\'s data dir', () => {
    const conn = new DaemonConnection('devbox', TARGET)
    const key = isolationKey(WALNUT_HOME)
    expect(conn.isolation).toEqual({ mode: 'isolated', key, roots: [`/tmp/open-walnut-test-${key}`, `$HOME/.cache/open-walnut-test/${key}`], replica: false })
    expect(readOnly(conn)).toBe(false)
    expect(priv(conn).ephemeralRemoteRefused).toBe(false)
    expect(conn.demoLifted).toBe(true)
    // Until the probe chose, the dir is the root's, never /tmp/open-walnut.
    expect(priv(conn)._remoteDir).toBe(`/tmp/open-walnut-test-${key}/daemon`)
  })

  it('a host network machine stays read only and off', () => {
    const conn = new DaemonConnection('lab', { ...TARGET, via: 'net' } as SshTarget)
    expect(readOnly(conn)).toBe(true)
    expect(conn.demoLifted).toBe(false)
  })

  it('boot start setup stays off on a Demo host', () => {
    const conn = new DaemonConnection('devbox', TARGET)
    expect(priv(conn)._bootStart).toBeNull()
  })

  it('once the stop began a new connection is off; one already made keeps its daemon to retire', () => {
    const before = new DaemonConnection('devbox', TARGET)
    expect(before.demoLifted).toBe(true)
    closeDemoRemoteHosts()
    const after = new DaemonConnection('devbox', TARGET)
    expect(after.isolation).toEqual({ mode: 'off', reason: 'demo-stopped' })
    expect(after.demoLifted).toBe(false)
    expect(priv(after).ephemeralRemoteRefused).toBe(true)
    expect(before.demoLifted).toBe(true)
  })
})

describe('stopDemoDaemon', () => {
  function connected(host = 'devbox'): DaemonConnection {
    const conn = new DaemonConnection(host, TARGET)
    priv(conn)._connected = true
    return conn
  }

  it('drops the link from the pool first, then retires the isolated daemon', async () => {
    const conn = connected()
    setPooledConnectionForTest('devbox', conn)
    const order: string[] = []
    const retire = vi.spyOn(conn, 'retireIsolatedDaemon').mockImplementation(async (ms?: number) => {
      order.push(`retire:${peekDaemonConnection('devbox') ? 'held' : 'gone'}:${ms}`)
      return 'retired'
    })
    await conn.stopDemoDaemon(7_000)
    expect(retire).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['retire:gone:7000'])
  })

  it('a retire that did not confirm is an error naming its outcome', async () => {
    for (const outcome of ['failed', 'skipped', 'stopped'] as const) {
      const conn = connected()
      vi.spyOn(conn, 'retireIsolatedDaemon').mockResolvedValue(outcome)
      await expect(conn.stopDemoDaemon(5_000)).rejects.toThrow(new RegExp(`did not confirm its stop \\(${outcome}\\)`))
    }
  })

  it('refuses a host whose daemon is not the Demo\'s, retiring nothing', async () => {
    const box = new DaemonConnection('__cloudbox__', TARGET)
    const retire = vi.spyOn(box, 'retireIsolatedDaemon')
    await expect(box.stopDemoDaemon(5_000)).rejects.toThrow(/not a Demo host/)
    closeDemoRemoteHosts()
    const late = connected('devbox')
    const retire2 = vi.spyOn(late, 'retireIsolatedDaemon')
    await expect(late.stopDemoDaemon(5_000)).rejects.toThrow(/not a Demo host/)
    expect(retire).not.toHaveBeenCalled()
    expect(retire2).not.toHaveBeenCalled()
  })

  it('demoLiftedConnections lists only connected Demo links', () => {
    const lifted = connected('devbox')
    const idle = new DaemonConnection('buildbox', TARGET)
    const box = new DaemonConnection('__cloudbox__', TARGET)
    priv(box)._connected = true
    setPooledConnectionForTest('devbox', lifted)
    setPooledConnectionForTest('buildbox', idle)
    setPooledConnectionForTest('__cloudbox__', box)
    try {
      expect(demoLiftedConnections()).toEqual([lifted])
    } finally {
      for (const k of ['devbox', 'buildbox', '__cloudbox__']) setPooledConnectionForTest(k, null)
    }
  })
})

describe('the other gates on a Demo server', () => {
  it('a Demo host is on in the live frame and for Connect; the server-wide answer stays off', () => {
    expect(remoteHostsOff('devbox', { transport: 'ssh' })).toBe(false)
    expect(remoteHostsOff('lab', { transport: 'net' })).toBe(true)
    expect(remoteHostsOff()).toBe(true)
    expect(hostStatusFrame('devbox', { hostname: 'devbox.example.test' }).phase).not.toBe('off')
    expect(hostStatusFrame('lab', { hostname: 'lab', transport: 'net' } as never).phase).toBe('off')
  })

  it('a host is off again once the Demo stops', () => {
    closeDemoRemoteHosts()
    expect(remoteHostsOff('devbox', { transport: 'ssh' })).toBe(true)
  })

  it('no host server: the manager is absent and its writes are refused', async () => {
    expect(getHostServerManager()).toBeNull()
    const express = (await import('express')).default
    const { hostServersRouter } = await import('../../src/web/routes/host-servers.js')
    const app = express()
    app.use(express.json())
    app.use('/api/host-servers', hostServersRouter)
    const server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      for (const [method, path] of [['PUT', '/devbox'], ['POST', '/devbox/retry'], ['POST', '/devbox/expose/retry']]) {
        const res = await fetch(`http://127.0.0.1:${port}/api/host-servers${path}`, {
          method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }),
        })
        expect(res.status).toBe(409)
        expect(await res.json()).toMatchObject({ code: 'demo_host_server_off' })
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('no plugin jobs are sent to a remote host', async () => {
    const send = vi.fn()
    await pluginJobsConnected({ hostKey: 'devbox', connected: true, hasCapability: () => true, send, uploadFile: vi.fn() })
    expect(send).not.toHaveBeenCalled()
  })
})
