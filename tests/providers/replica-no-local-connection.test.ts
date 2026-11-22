/**
 * A host replica, a host's one Walnut service included, never holds a '__local__' DaemonConnection
 * (a3b land 2 review H1): that is a full-trust client of the host's daemon with no follower origin,
 * so no owner scope, and its connect would configure the runtime with the replica's home as a
 * leader. The service holds the runtime in its own process, so before the guard every caller of
 * getLocalDaemonConnection (engine-model-probe, acp-session, feature-service, plugin jobs) would have
 * reached it. Its own host's reads go through the follower seat (self-host.ts).
 *
 * The guard sits where no new path can step around it: before any start or pool entry, and where
 * every socket of a connection opens. The ratchet below fails when a socket opens anywhere else.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetServerRoleForTesting, _resetServiceRuntimeForTesting, holdServiceRuntime } from '../../src/core/server-role.js'
import { isNeedsLeaderError } from '../../src/core/replication/needs-leader.js'
import { DaemonConnection, assertLocalDialAllowed, getDirectDaemonConnection } from '../../src/providers/daemon-connection.js'
import { dialLocalDaemon, getLocalDaemonConnection } from '../../src/providers/local-daemon-dial.js'
import { IN_PROCESS_DAEMON_URL } from '../../src/providers/in-process-daemon-socket.js'

const KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_HOST_SERVER'] as const
let saved: Record<string, string | undefined> = {}

const refused = (err: unknown): boolean => isNeedsLeaderError(err) && err.why === 'no_local_daemon_in_replica'

describe('a host replica gets no local daemon connection', () => {
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_SERVER: '1' })
    _resetServerRoleForTesting()
    // The host's one Walnut service: the runtime is in this process.
    holdServiceRuntime({ dir: '/nonexistent/service-runtime', home: '/nonexistent/home', env: {} })
  })
  afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    _resetServerRoleForTesting()
    _resetServiceRuntimeForTesting()
    vi.restoreAllMocks()
  })

  it('getLocalDaemonConnection and dialLocalDaemon refuse before starting or dialling anything', async () => {
    const { localDaemon } = await import('../../src/providers/local-daemon.js')
    const ensure = vi.spyOn(localDaemon, 'ensureRunning')
    const dial = vi.fn(async () => 'dialled')
    await expect(getLocalDaemonConnection()).rejects.toSatisfy(refused)
    await expect(dialLocalDaemon(dial)).rejects.toSatisfy(refused)
    expect(dial).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('the pooled direct dial and a private connection refuse, the in-process address too', async () => {
    await expect(getDirectDaemonConnection('__local__', IN_PROCESS_DAEMON_URL)).rejects.toSatisfy(refused)
    const own = new DaemonConnection('__local__', null)
    try {
      await expect(own.connectDirect(IN_PROCESS_DAEMON_URL)).rejects.toSatisfy(refused)
      await expect(own.connectDirect('ws://127.0.0.1:1')).rejects.toSatisfy(refused)
      expect(own.connected).toBe(false)
    } finally { own.disconnect() }
  })

  it('a leader is not refused, and another host key never is', () => {
    expect(() => assertLocalDialAllowed('devbox')).not.toThrow()
    for (const k of KEYS) delete process.env[k]
    _resetServerRoleForTesting()
    expect(() => assertLocalDialAllowed('__local__')).not.toThrow()
  })
})

describe('ratchet: every socket of a DaemonConnection opens behind the guard', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/providers/daemon-connection.ts'), 'utf-8')

  it('the guard runs first in connectWebSocket and getDirectDaemonConnection, and in dialLocalDaemon', () => {
    const cws = src.slice(src.indexOf('  private connectWebSocket('))
    expect(cws.slice(0, cws.indexOf('return new Promise('))).toMatch(/assertLocalDialAllowed\(this\.hostKey\)/)
    expect(src).toMatch(/export async function getDirectDaemonConnection\(hostKey: string, wsUrl: string\): Promise<DaemonConnection> \{\n {2}assertLocalDialAllowed\(hostKey\)/)
    const dialSrc = fs.readFileSync(path.join(__dirname, '../../src/providers/local-daemon-dial.ts'), 'utf-8')
    const body = dialSrc.slice(dialSrc.indexOf('export async function dialLocalDaemon'))
    expect(body.indexOf("assertLocalDialAllowed('__local__')")).toBeGreaterThan(-1)
    expect(body.indexOf("assertLocalDialAllowed('__local__')")).toBeLessThan(body.indexOf('.ensureRunning('))
  })

  it('a socket opens only in connectWebSocket, or in the bulk channel (never a local connection)', () => {
    const lines = src.split('\n')
    const sites: string[] = []
    let member = ''
    for (const line of lines) {
      const m = /^ {2}(?:private |public |protected )?(?:static )?(?:async )?([A-Za-z_]\w*)\s*\(/.exec(line)
      if (m) member = m[1]!
      if (/^(?:export )?(?:async )?function ([A-Za-z_]\w*)/.test(line)) member = /function ([A-Za-z_]\w*)/.exec(line)![1]!
      if (/new WebSocket\(|inProcessSocket\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line) && !/^function inProcessSocket/.test(line)) sites.push(member)
    }
    expect(sites.sort()).toEqual(['connectWebSocket', 'connectWebSocket', 'openBulkSocket'])
    // The bulk channel is never a local connection's.
    expect(src).toMatch(/return this\.hostKey !== '__local__' && this\.bulkOwnLink/)
  })
})
