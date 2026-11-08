/**
 * The Demo's stop on its remote hosts (src/commands/demo-remote-stop.ts): no new
 * lifted connection first, then for each connected lifted host its live sessions
 * stop through its daemon, it must show nothing alive and no command running, and
 * its daemon is retired (stopped, and its isolated root removed), all within one deadline. A host that
 * cannot be reached, or does not answer in time, is skipped; one that answers and
 * refuses keeps the Demo running. Every dependency is a fake: no daemon, no ssh.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { stopDemoRemoteHosts, type DemoRemoteConn, type DemoRemoteStopDeps } from '../../src/commands/demo-remote-stop.js'

interface FakeHost {
  sessions?: Array<{ sid: string; alive: boolean }>
  afterStop?: Array<{ sid: string; alive: boolean }>
  jobs?: Array<{ running: boolean }>
  /** No host_exec on that daemon (no host-exec-v1): it refuses exec.list. */
  noExec?: boolean
  /** exec.list answers with no job list. */
  execUnlisted?: boolean
  /** Every daemon command rejects (the link or the host is gone). */
  gone?: boolean
  /** Every daemon command waits forever. */
  hangs?: boolean
}

function fakeConn(host: string, f: FakeHost = {}) {
  let lists = 0
  const sent: string[] = []
  const conn = {
    host, connected: true,
    hasCapability: (cap: string) => !(f.noExec && cap === 'host-exec-v1'),
    send: vi.fn(async (cmd: string) => {
      sent.push(cmd)
      if (f.hangs) return new Promise<Record<string, unknown>>(() => {})
      if (f.gone) throw new Error('connection closed')
      if (cmd === 'list') return { sessions: lists++ === 0 ? (f.sessions ?? []) : (f.afterStop ?? []) }
      if (cmd === 'exec.list') {
        if (f.noExec) return { ok: false, error: 'exec.list unsupported: host-exec-core sidecar not loaded' }
        return f.execUnlisted ? { ok: true } : { jobs: f.jobs ?? [] }
      }
      throw new Error(`unexpected ${cmd}`)
    }),
    stopDemoDaemon: vi.fn(async (_ms: number) => {}),
  }
  return { conn: conn as typeof conn & DemoRemoteConn, sent }
}

function deps(conns: DemoRemoteConn[], over: Partial<DemoRemoteStopDeps> = {}) {
  const order: string[] = []
  const d: DemoRemoteStopDeps = {
    close: vi.fn(() => { order.push('close') }),
    connections: vi.fn(() => { order.push('connections'); return conns }),
    records: vi.fn(async () => []),
    stopSession: vi.fn(async () => 'stopped' as const),
    stopAcp: vi.fn(async () => 'stopped' as const),
    now: Date.now,
    ...over,
  }
  return { d, order }
}

describe('stopDemoRemoteHosts', () => {
  it('closes the lift before it looks at any connection, and does nothing with none', async () => {
    const { d, order } = deps([])
    await expect(stopDemoRemoteHosts(d)).resolves.toEqual({ stopped: [], skipped: [] })
    expect(order).toEqual(['close', 'connections'])
    expect(d.records).not.toHaveBeenCalled()
  })

  it('stops each live session through its own host, then that host\'s daemon, bounded by the deadline', async () => {
    const a = fakeConn('devbox', { sessions: [{ sid: 's1', alive: true }, { sid: 's2', alive: false }], afterStop: [{ sid: 's1', alive: false }] })
    const b = fakeConn('buildbox')
    const acpRow = { claudeSessionId: 'acp', host: 'devbox', acpRuntimeId: 'rt-1' }
    const { d } = deps([a.conn, b.conn], {
      records: vi.fn(async () => [acpRow, { claudeSessionId: 'x', host: 'other' }, { claudeSessionId: 'l', host: null }]),
    })
    const report = await stopDemoRemoteHosts(d, 20_000)
    expect(report.stopped.sort()).toEqual(['buildbox', 'devbox'])
    expect(report.skipped).toEqual([])
    expect(d.stopSession).toHaveBeenCalledTimes(1)
    expect(d.stopSession).toHaveBeenCalledWith({ claudeSessionId: 's1', host: 'devbox' }, a.conn)
    expect(d.stopAcp).toHaveBeenCalledTimes(1)
    expect(d.stopAcp).toHaveBeenCalledWith(acpRow, a.conn)
    expect(a.sent).toEqual(['list', 'list', 'exec.list'])
    for (const { conn } of [a, b]) {
      expect(conn.stopDemoDaemon).toHaveBeenCalledTimes(1)
      const ms = conn.stopDemoDaemon.mock.calls[0][0]
      expect(ms).toBeGreaterThan(0)
      expect(ms).toBeLessThanOrEqual(20_000)
    }
    // The daemon goes last on its host.
    expect(a.conn.stopDemoDaemon.mock.invocationCallOrder[0]).toBeGreaterThan(a.conn.send.mock.invocationCallOrder.at(-1)!)
  })

  it('a host that cannot be reached is skipped and logged; the others still stop', async () => {
    const gone = fakeConn('devbox', { gone: true })
    const ok = fakeConn('buildbox')
    const { d } = deps([gone.conn, ok.conn])
    const report = await stopDemoRemoteHosts(d)
    expect(report.stopped).toEqual(['buildbox'])
    expect(report.skipped).toEqual([{ host: 'devbox', reason: 'connection closed' }])
    expect(gone.conn.stopDemoDaemon).not.toHaveBeenCalled()
  })

  it('a host that does not answer is skipped at the deadline, never holding the stop', async () => {
    const slow = fakeConn('devbox', { hangs: true })
    const { d } = deps([slow.conn])
    const t0 = Date.now()
    const report = await stopDemoRemoteHosts(d, 80)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(report.skipped).toEqual([{ host: 'devbox', reason: 'no answer before the deadline' }])
    expect(slow.conn.stopDemoDaemon).not.toHaveBeenCalled()
  })

  it.each([
    ['a refused session stop', { sessions: [{ sid: 's1', alive: true }] }, { stopSession: vi.fn(async () => 'refused' as const) }, /session on devbox did not confirm/],
    ['a session still alive', { sessions: [{ sid: 's1', alive: true }], afterStop: [{ sid: 's1', alive: true }] }, {}, /live sessions on devbox/],
    ['a command still running', { jobs: [{ running: true }] }, {}, /commands running on devbox/],
  ] as const)('%s keeps the Demo running and never stops that daemon', async (_name, host, over, message) => {
    const h = fakeConn('devbox', host as FakeHost)
    const { d } = deps([h.conn], over as Partial<DemoRemoteStopDeps>)
    await expect(stopDemoRemoteHosts(d)).rejects.toThrow(message)
    expect(h.conn.stopDemoDaemon).not.toHaveBeenCalled()
  })
})

describe('the Demo stop runs it while the daemon links still stand', () => {
  it('demo-server.ts stops the remote hosts after fencing work and before stopServer', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../../src/commands/demo-server.ts'), 'utf8')
    const body = source.slice(source.indexOf('  const stop = (): Promise<void> => {'), source.indexOf('  const control = http.createServer'))
    const fence = body.indexOf('ws.closeAllClients(')
    const remote = body.indexOf('stopDemoRemoteHosts(')
    const server = body.indexOf('await stopServer(')
    const local = body.indexOf('await stopDemoProcesses(paths)')
    expect(fence).toBeGreaterThan(0)
    expect(remote).toBeGreaterThan(fence)
    expect(server).toBeGreaterThan(remote)
    expect(local).toBeGreaterThan(server)
  })

  it('stops a host whose daemon has no host_exec without asking it for commands, and keeps the Demo when one that has it lists none', async () => {
    const bare = fakeConn('bare', { noExec: true })
    await expect(stopDemoRemoteHosts(deps([bare.conn]).d)).resolves.toEqual({ stopped: ['bare'], skipped: [] })
    expect(bare.sent).toEqual(['list', 'list'])
    expect(bare.conn.stopDemoDaemon).toHaveBeenCalledTimes(1)
    const mute = fakeConn('mute', { execUnlisted: true })
    await expect(stopDemoRemoteHosts(deps([mute.conn]).d)).rejects.toThrow('Demo daemon on mute did not list its commands; data was kept')
    expect(mute.conn.stopDemoDaemon).not.toHaveBeenCalled()
  })
})
