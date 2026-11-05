/**
 * The server's relay for a session's servers (src/core/session-servers.ts): which
 * daemon it asks, which ids name the session, what stays out of reach, and how the
 * daemon's answers become HTTP statuses.
 */
import { describe, it, expect } from 'vitest'
import {
  listSessionServers,
  serverUrl,
  sessionProcessIds,
  stopSessionServer,
  SessionServerStopError,
} from '../../src/core/session-servers.js'
import type { SessionRecord } from '../../src/core/types.js'

const session = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({ claudeSessionId: 'sess-1', taskId: 't1', project: 'p', process_status: 'running', mode: 'default', ...over } as SessionRecord)

function fakeConn(reply: (cmd: string, params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>, caps = ['ports-v1']) {
  const sent: Array<{ cmd: string; params: Record<string, unknown> }> = []
  return {
    sent,
    conn: {
      hasCapability: (c: string) => caps.includes(c),
      send: async (cmd: string, params: Record<string, unknown> = {}) => { sent.push({ cmd, params }); return { ok: true, ...(await reply(cmd, params)) } as { ok: boolean } },
    },
  }
}

const raw = (over: Record<string, unknown>) => ({
  sid: 'sess-1', port: 5173, addresses: ['127.0.0.1'], loopbackOnly: true, pid: 300, pgid: 300,
  name: 'node', command: 'node vite', ageSec: 5, via: 'env', kind: 'http', stopScope: 'group', ...over,
})

describe('listSessionServers', () => {
  it('asks the session host\'s daemon and keeps only this session\'s servers', async () => {
    const { conn, sent } = fakeConn(() => ({ servers: [raw({}), raw({ sid: 'other', port: 8000 }), raw({ sid: 'rt-1', port: 9000 })] }))
    const hosts: string[] = []
    const res = await listSessionServers(session({ host: 'devbox' }), { connection: async (h) => { hosts.push(h); return conn } })
    expect(hosts).toEqual(['devbox'])
    expect(res.state).toBe('ok')
    expect(res.servers.map((s) => s.port)).toEqual([5173])
    expect(res.servers[0]!.url).toBe('http://localhost:5173/')
    expect(res.servers[0]!.title).toBeUndefined()
    // A remote host has no Walnut server pid to guard.
    expect(sent[0]).toEqual({ cmd: 'ports.list', params: { sids: ['sess-1'], guardPids: [] } })
  })

  it('passes a page title through, capped, and drops one that is not a string', async () => {
    const { conn } = fakeConn(() => ({ servers: [raw({ title: 'Acme storefront' }), raw({ port: 8000, title: 'y'.repeat(300) }), raw({ port: 8001, title: 7 })] }))
    const res = await listSessionServers(session(), { connection: async () => conn })
    expect(res.servers.map((s) => s.title?.length ?? null)).toEqual([15, 80, null])
  })

  it('on this machine it guards the server\'s own pid, and an ACP session matches its runtime id', async () => {
    const { conn, sent } = fakeConn(() => ({ servers: [raw({ sid: 'rt-1', port: 9000 }), raw({ sid: 'thread-1', port: 9001, via: 'terminal' })] }))
    const res = await listSessionServers(session({ claudeSessionId: 'thread-1', acpRuntimeId: 'rt-1' }), { connection: async () => conn, serverPid: 4321 })
    expect(res.servers.map((s) => s.port)).toEqual([9000, 9001])
    expect(sent[0]!.params).toEqual({ sids: ['rt-1', 'thread-1'], guardPids: [4321] })
  })

  it('says offline, unsupported or error instead of throwing', async () => {
    expect((await listSessionServers(session(), { connection: async () => null })).state).toBe('offline')
    const old = fakeConn(() => ({}), [])
    expect((await listSessionServers(session(), { connection: async () => old.conn })).state).toBe('unsupported')
    expect(old.sent).toEqual([])
    const broken = { hasCapability: () => true, send: async () => { throw new Error('socket closed') } }
    const res = await listSessionServers(session(), { connection: async () => broken })
    expect(res).toMatchObject({ state: 'error', error: 'socket closed', servers: [] })
  })

  it('a host that cannot read its sockets is an error, never "nothing listens"', async () => {
    const { conn } = fakeConn(() => ({ servers: [], source: 'none' }))
    const res = await listSessionServers(session(), { connection: async () => conn })
    expect(res.state).toBe('error')
    expect(res.servers).toEqual([])
  })
})

describe('stopSessionServer', () => {
  it('sends the session\'s ids, the pid and port, and the guard', async () => {
    const { conn, sent } = fakeConn(() => ({ stopped: true, scope: 'group', signal: 'SIGTERM', confirmed: true }))
    const res = await stopSessionServer(session({ claudeSessionId: 'thread-1', acpRuntimeId: 'rt-1' }), { pid: 300, port: 5173 }, { connection: async () => conn, serverPid: 4321 })
    expect(res).toEqual({ stopped: true, scope: 'group', signal: 'SIGTERM', confirmed: true })
    expect(sent[0]).toEqual({ cmd: 'ports.stop', params: { sids: ['rt-1', 'thread-1'], pid: 300, port: 5173, guardPids: [4321] } })
  })

  it('maps the daemon\'s refusals to statuses', async () => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ stopped: false, code: 'not_found', reason: 'gone' }, 404, 'not_found'],
      [{ stopped: false, code: 'not_stoppable', reason: 'agent group' }, 409, 'not_stoppable'],
      [{ stopped: false, code: 'signal_failed', reason: 'EPERM' }, 502, 'signal_failed'],
    ]
    for (const [reply, status, code] of cases) {
      const { conn } = fakeConn(() => reply)
      const err = await stopSessionServer(session(), { pid: 300, port: 5173 }, { connection: async () => conn }).catch((e) => e)
      expect(err).toBeInstanceOf(SessionServerStopError)
      expect([err.status, err.code]).toEqual([status, code])
    }
  })

  it('refuses a bad request before it reaches any daemon', async () => {
    let asked = false
    const connection = async () => { asked = true; return null }
    for (const req of [{ pid: 1, port: 80 }, { pid: 0, port: 80 }, { pid: -5, port: 80 }, { pid: 'x', port: 80 }, { pid: 300, port: 0 }, { pid: 300, port: 70000 }, {}]) {
      const err = await stopSessionServer(session(), req as { pid: unknown; port: unknown }, { connection }).catch((e) => e)
      expect(err.status).toBe(400)
    }
    expect(asked).toBe(false)
  })

  it('a test server\'s refusal for a session it did not start is 403', async () => {
    const conn = { hasCapability: () => true, send: async () => { throw Object.assign(new Error('inherited_session: ...'), { code: 'inherited_session' }) } }
    const err = await stopSessionServer(session(), { pid: 300, port: 5173 }, { connection: async () => conn }).catch((e) => e)
    expect([err.status, err.code]).toEqual([403, 'inherited_session'])
  })
})

describe('urls and ids', () => {
  it('opens loopback and wildcard listeners at localhost, a specific address as itself', () => {
    expect(serverUrl({ port: 80, addresses: ['0.0.0.0'], kind: 'http' })).toBe('http://localhost:80/')
    expect(serverUrl({ port: 443, addresses: ['::'], kind: 'https' })).toBe('https://localhost:443/')
    expect(serverUrl({ port: 8080, addresses: ['10.0.0.5'], kind: 'http' })).toBe('http://10.0.0.5:8080/')
    expect(serverUrl({ port: 8080, addresses: ['fe80::1'], kind: 'unknown' })).toBe('http://[fe80::1]:8080/')
  })

  it('names a native session by its id, an ACP one by runtime id first', () => {
    expect(sessionProcessIds({ claudeSessionId: 'a' })).toEqual(['a'])
    expect(sessionProcessIds({ claudeSessionId: 'thread', acpRuntimeId: 'rt' })).toEqual(['rt', 'thread'])
  })
})
