/**
 * The self-host shim of a host replica (src/replica/self-host.ts, WP6): the
 * Mac's name for this host resolves to the follower link, and only there.
 * The real DaemonFileReader and getDaemonConnection run over a fake link that
 * answers as the daemon does; the same path over real daemon processes is
 * tests/integration/replica-local-routes-twins.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { clearSelfHost, hostEntryOf, installSelfHost, isLocalHere, isSelfHost, selfHostConnection, sessionIdOfPath, type SelfHostLink } from '../../src/replica/self-host.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-self-host'))

function fakeLink(files: Record<string, string>, caps: string[] | null = ['replica-reads-v1', 'fs-mutate-v1']): SelfHostLink & { asked: Array<Record<string, unknown>>; up: boolean } {
  const asked: Array<Record<string, unknown>> = []
  const link = {
    asked,
    up: true,
    state: (): 'up' | 'down' => (link.up ? 'up' : 'down'),
    capabilities: () => caps,
    async request(cmd, params = {}) {
      asked.push({ cmd, ...params })
      const p = String(params.path ?? '')
      if (!(p in files)) return { ok: false, error: `${cmd}: ENOENT: not found for this Walnut on this host`, errorKind: 'not_found' }
      if (cmd === 'fs.stat') return { ok: true, exists: true, size: Buffer.byteLength(files[p]!), mtimeMs: 1 }
      if (cmd === 'fs.read') return params.encoding === 'utf-8' ? { ok: true, data: files[p] } : { ok: true, data: Buffer.from(files[p]!).toString('base64'), encoding: 'base64' }
      return { ok: false, error: 'unknown' }
    },
  }
  return link
}

afterEach(() => clearSelfHost())

describe('which host is this host', () => {
  it('only the aliases it was given, only with replica-reads-v1, never __local__, and nothing before install', () => {
    expect(isSelfHost('devbox')).toBe(false)
    installSelfHost({ aliases: ['devbox', '__local__', ' '], link: fakeLink({}) })
    expect(isSelfHost('devbox')).toBe(true)
    expect(isSelfHost('__local__')).toBe(false)
    expect(isSelfHost('other-box')).toBe(false)
    expect(isSelfHost(undefined)).toBe(false)
    installSelfHost({ aliases: ['devbox'], link: fakeLink({}, ['fs-mutate-v1']) })
    expect(isSelfHost('devbox')).toBe(false)
    installSelfHost({ aliases: ['devbox'], link: fakeLink({}, null) })
    expect(selfHostConnection('devbox')).toBeNull()
  })

  it('a link that dropped (capabilities still known) answers nothing here until it is up again: the Mac answers', async () => {
    const link = fakeLink({})
    installSelfHost({ aliases: ['devbox'], link })
    const lookup = async () => ({ host: 'devbox' })
    link.up = false
    // Its reads still go to the link (it reports not connected), never to an SSH dial.
    expect(isSelfHost('devbox')).toBe(true)
    expect(selfHostConnection('devbox')?.connected).toBe(false)
    expect(await isLocalHere('/api/sessions/s1/history', 'session', lookup)).toBe(false)
    expect(await isLocalHere('/api/file-content?host=devbox&path=/x', 'host', lookup)).toBe(false)
    link.up = true
    expect(await isLocalHere('/api/file-content?host=devbox&path=/x', 'host', lookup)).toBe(true)
    // A row that needs a capability this daemon lacks (the changes view without changes-v1): the Mac's.
    expect(await isLocalHere('/api/sessions/s1/changes', 'session', lookup, 'changes-v1')).toBe(false)
    installSelfHost({ aliases: ['devbox'], link: fakeLink({}, ['replica-reads-v1', 'changes-v1']) })
    expect(await isLocalHere('/api/sessions/s1/changes', 'session', lookup, 'changes-v1')).toBe(true)
  })

  it('a route\'s hosts-config lookup: this host stands in on a replica (no hosts config there), any other host as configured', () => {
    const hosts = { other: { hostname: 'other.example', user: 'u', port: 22 } }
    expect(hostEntryOf(hosts, 'devbox')).toBeUndefined()
    installSelfHost({ aliases: ['devbox'], link: fakeLink({}) })
    expect(hostEntryOf(undefined, 'devbox')).toEqual({ hostname: 'devbox' })
    expect(hostEntryOf(hosts, 'other')).toEqual(hosts.other)
    expect(hostEntryOf(hosts, 'nowhere')).toBeUndefined()
  })

  it('a session path or a host query decides; an unknown session is not here', async () => {
    installSelfHost({ aliases: ['devbox'], link: fakeLink({}) })
    const lookup = async (sid: string) => (sid === 's-here' ? { host: 'devbox' } : sid === 's-mac' ? { host: null } : null)
    expect(sessionIdOfPath('/api/sessions/s-here/history?tail=5')).toBe('s-here')
    expect(sessionIdOfPath('/api/v1/sessions/s%2Dhere/transcript')).toBe('s-here')
    expect(sessionIdOfPath('/api/tasks/t1')).toBeNull()
    expect(await isLocalHere('/api/sessions/s-here/history', 'session', lookup)).toBe(true)
    expect(await isLocalHere('/api/sessions/s-mac/history', 'session', lookup)).toBe(false)
    expect(await isLocalHere('/api/sessions/nobody/history', 'session', lookup)).toBe(false)
    expect(await isLocalHere('/api/file-content?host=devbox&path=/x', 'host', lookup)).toBe(true)
    expect(await isLocalHere('/api/file-content?host=other&path=/x', 'host', lookup)).toBe(false)
    // No host is the Mac's own file, whatever session it names: never this replica's disk.
    expect(await isLocalHere('/api/files/list?sessionId=s-here&path=/x', 'host', lookup)).toBe(false)
    expect(await isLocalHere('/api/file-content?sessionId=s-here&path=/home/u/.ssh/id_ed25519', 'host', lookup)).toBe(false)
    expect(await isLocalHere('/api/files/list?path=/x', 'host', lookup)).toBe(false)
    clearSelfHost()
    expect(await isLocalHere('/api/sessions/s-here/history', 'session', lookup)).toBe(false)
  })
})

describe('reads of this host go through the follower link', () => {
  it('getDaemonConnection and DaemonFileReader take the link, no SSH target and no hosts config', async () => {
    const link = fakeLink({ '/work/marina/a.txt': 'marina file\n' })
    installSelfHost({ aliases: ['devbox'], link })
    const { getDaemonConnection } = await import('../../src/providers/daemon-connection.js')
    const conn = await getDaemonConnection('devbox', { hostname: 'ignored' })
    expect(conn.connected).toBe(true)
    expect(conn.hasCapability('replica-reads-v1')).toBe(true)
    const { DaemonFileReader } = await import('../../src/core/daemon-file-reader.js')
    const reader = new DaemonFileReader('devbox')
    expect(await reader.readFile('/work/marina/a.txt')).toBe('marina file\n')
    expect(await reader.readFile('/work/acme/secret.txt')).toBeNull()
    expect(link.asked.map((a) => a.cmd)).toContain('fs.read')
    // Any other host still takes the ordinary path (here: refused for want of a config entry).
    await expect(new DaemonFileReader('other-box').readFile('/x')).rejects.toThrow(/Unknown host/)
  })
})
