/**
 * The doctor's hosts half reads the same HostStatus the Settings pane shows,
 * including the connect-side runtime, daemon dir and warnings, and names the
 * daemon runtime from a service-mode hello. All read defensively: every one of
 * those HostStatus fields is optional.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-doctor-hosts'))

const state = vi.hoisted(() => ({ connect: {} as Record<string, unknown>, conn: null as null | Record<string, unknown> }))
vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ hosts: {
    devbox: { hostname: 'devbox.example.com', user: 'alice' },
    off: { hostname: 'off.example.com', enabled: false },
  } }),
}))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  getDaemonConnectState: (host: string) => ({
    host, connected: true, phase: 'connected', phaseElapsedMs: 0, connectElapsedMs: 0, ...state.connect,
  }),
  getConnectedDaemonConnection: (host: string) => (host === '__local__' ? state.conn : null),
}))

import { listHostDiagnostics, localDaemonPreflight, runtimeFromExecutable } from '../../../src/core/diagnostics/host-probes.js'

afterEach(() => { state.connect = {}; state.conn = null })

describe('listHostDiagnostics', () => {
  it('lists enabled hosts with their connection, and nothing for a disabled one', async () => {
    const hosts = await listHostDiagnostics()
    expect(hosts.map((h) => h.alias)).toEqual(['devbox'])
    expect(hosts[0]).toMatchObject({
      alias: 'devbox', hostname: 'devbox.example.com', user: 'alice', connected: true, phase: 'connected',
      runtime: null, daemonVersion: null, readiness: null, lastError: null, daemonDir: null, warnings: [],
    })
  })

  it('carries the runtime, daemon dir and warnings the connection reports', async () => {
    state.connect = {
      runtime: 'node',
      daemonDir: { path: '/home/alice/.cache/open-walnut', home: '/home/alice', fallback: true, reason: '/tmp is read-only', freeMb: 900 },
    }
    const [h] = await listHostDiagnostics()
    expect(h.runtime).toBe('node')
    // The home rides along for redaction: its last segment is the remote user name.
    expect(h.daemonDir).toEqual({ display: '~/.cache/open-walnut', fallback: true, freeMb: 900, home: '/home/alice' })
    // The wording belongs to the connect side (remote-daemon-dir.ts); the doctor carries it as-is.
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings?.[0]).toMatch(/~\/\.cache\/open-walnut.*read-only/)
  })

  it('treats an unknown runtime as not known', async () => {
    state.connect = { runtime: 'unknown' }
    const [h] = await listHostDiagnostics()
    expect(h.runtime).toBeNull()
  })
})

describe('runtimeFromExecutable', () => {
  it('names bun, node and a compiled binary, and nothing without a path', () => {
    expect(runtimeFromExecutable('/home/alice/.bun/bin/bun')).toBe('bun')
    expect(runtimeFromExecutable('/usr/bin/node')).toBe('node')
    expect(runtimeFromExecutable('/tmp/open-walnut/walnut-daemon-linux-x64')).toBe('binary')
    expect(runtimeFromExecutable(undefined)).toBeNull()
    expect(runtimeFromExecutable('  ')).toBeNull()
  })
})

describe('localDaemonPreflight', () => {
  // Review round 1, item 7: the local daemon answers for this machine when it is connected.
  const reply = {
    ok: true,
    claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native', auth: 'ok', versionOk: true, minVersion: '2.1.280' },
    compiler: { found: true, name: 'clang' },
    dtach: { found: true, path: '/opt/homebrew/bin/dtach' },
    platform: 'darwin', arch: 'arm64',
  }

  it('asks a connected local daemon with preflight-v1, passing the floor and the deadline', async () => {
    const send = vi.fn(async () => reply)
    state.conn = { hasCapability: (c: string) => c === 'preflight-v1', send }
    const pre = await localDaemonPreflight('2.1.280', 4_000)
    expect(send).toHaveBeenCalledWith('host.preflight', { minClaudeVersion: '2.1.280' }, 4_000)
    expect(pre?.claude).toMatchObject({ found: true, version: '2.1.280', auth: 'ok', versionOk: true })
    expect(pre?.compiler).toEqual({ found: true, name: 'clang' })
  })

  it('answers null with no local daemon, or one too old to preflight, so the caller runs it itself', async () => {
    expect(await localDaemonPreflight(undefined, 4_000)).toBeNull()
    const send = vi.fn(async () => reply)
    state.conn = { hasCapability: () => false, send }
    expect(await localDaemonPreflight(undefined, 4_000)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('throws on a refused or unreadable answer, which the collector turns into a warning and a fallback', async () => {
    state.conn = { hasCapability: () => true, send: async () => ({ ok: false, error: 'busy' }) }
    await expect(localDaemonPreflight(undefined, 4_000)).rejects.toThrow('busy')
    state.conn = { hasCapability: () => true, send: async () => ({ ok: true }) }
    await expect(localDaemonPreflight(undefined, 4_000)).rejects.toThrow(/unknown shape/)
  })
})
