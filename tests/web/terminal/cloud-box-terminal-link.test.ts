/**
 * The cloud box has no SSH door (its sessions ride the companion's daemon tunnel),
 * and it still gets a terminal: every terminal step goes over its daemon link
 * (a terminal stream for the pty, exec.script for dtach and the lifecycle), and
 * nothing terminal-shaped ever runs ssh to it: not the probe, not the prewarm, not
 * the orphan sweep. A daemon there without terminal streams is refused in the
 * daemon's own words, never "check that `ssh __cloudbox__` works".
 *
 * child_process is replaced wholesale: every shell the terminal code would run is
 * recorded, nothing executes. The link's script runner is a recorder too.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const shellCalls: string[][] = []
const linkRuns: Array<{ host: string; script: string }> = []
const link = vi.hoisted(() => ({ connected: true, noPty: false }))

vi.mock('node:child_process', () => {
  const execFile = (
    cmd: string,
    args: string[],
    opts: unknown,
    cb?: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    shellCalls.push([cmd, ...args])
    const done = typeof opts === 'function' ? opts as typeof cb : cb
    const script = args[args.length - 1] ?? ''
    done?.(null, script.includes('OWNER:') ? 'OWNER:\n' : 'DONE\n', '')
    return { on: () => {}, kill: () => {}, stdin: { on: () => {}, end: () => {} } }
  }
  return {
    execFile,
    spawn: (cmd: string, args: string[]) => { shellCalls.push([cmd, ...args]); throw new Error('spawn is not allowed in this test') },
    exec: (cmd: string) => { shellCalls.push([cmd]); throw new Error('exec is not allowed in this test') },
    execSync: () => { throw new Error('execSync is not allowed in this test') },
    execFileSync: () => { throw new Error('execFileSync is not allowed in this test') },
  }
})

const HOSTS = {
  __cloudbox__: { hostname: '127.0.0.1:9', label: 'Cloud', enabled: true, cloud_box: true },
  devbox: { hostname: 'devbox.example.test', label: 'Dev box', enabled: true },
}

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({ hosts: HOSTS })),
}))

vi.mock('../../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => [{ claudeSessionId: 'sid-on-cloud', host: '__cloudbox__' }]),
}))

vi.mock('../../../src/web/terminal/terminal-manager.js', () => ({
  terminalManager: { isViewing: () => false },
}))

vi.mock('../../../src/core/hosts/host-script.js', () => ({
  HOST_SCRIPT_CAPABILITY: 'host-script-v1',
  runScriptOnHost: vi.fn(async (host: string, input: { script: string }) => {
    linkRuns.push({ host, script: input.script })
    const stdout = input.script.includes('WALNUT_DTACH_BEGIN')
      ? 'WALNUT_DTACH_BEGIN\nOS:Linux\nDTACH_OK:walnut:/home/u/.local/bin/walnut-dtach\n'
      : input.script.includes('OWNER:') ? 'OWNER:\n' : 'DONE\n'
    return { code: 0, stdout, stderr: '', timedOut: false, truncated: false }
  }),
}))

vi.mock('../../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getDaemonConnectState: (host: string) => ({ host, connected: link.connected, phase: link.connected ? 'connected' : 'idle', phaseElapsedMs: 0, connectElapsedMs: 0, ...(link.noPty ? { noPtyStream: true } : {}) }),
  getConnectedDaemonConnection: (host: string) => (host === '__cloudbox__' && link.connected ? { hasCapability: (c: string) => c === 'host-script-v1' } : null),
}))

import { log } from '../../../src/logging/index.js'
import { prewarmRemoteHost, resolveTerminalRoute } from '../../../src/web/terminal/spawn.js'
import { probeTerminalMode } from '../../../src/web/terminal/dtach-check.js'
import { reapOrphanDtach } from '../../../src/web/terminal/dtach-lifecycle.js'
import { resetDtachCacheForTests } from '../../../src/web/terminal/dtach-provision.js'
import type { SessionRecord } from '../../../src/core/types.js'

const touchedCloud = () => shellCalls.filter((c) => c.some((a) => a.includes('__cloudbox__') || a.includes('127.0.0.1:9')))

beforeEach(() => {
  shellCalls.length = 0
  linkRuns.length = 0
  link.connected = true
  link.noPty = false
  resetDtachCacheForTests()
})

describe('a terminal on the cloud box rides its daemon link', () => {
  it('the route is the link for Cloud and ssh for an SSH host', async () => {
    await expect(resolveTerminalRoute('__cloudbox__')).resolves.toEqual({ via: 'link', link: 'cloud-tunnel' })
    await expect(resolveTerminalRoute('devbox')).resolves.toMatchObject({ via: 'ssh', target: { hostname: 'devbox.example.test' } })
  })

  it('terminal:open probes dtach over the link: a persistent terminal, and no ssh at all', async () => {
    const r = await probeTerminalMode({ claudeSessionId: 'sid-on-cloud', host: '__cloudbox__' } as SessionRecord)
    expect(r).toEqual({ ok: true, mode: { persistent: true } })
    expect(linkRuns.map((x) => x.host)).toEqual(['__cloudbox__'])
    expect(shellCalls).toEqual([])
  })

  it('a daemon there without terminal streams is refused in its own words, with no ssh hint', async () => {
    link.noPty = true
    const r = await probeTerminalMode({ claudeSessionId: 'sid-on-cloud', host: '__cloudbox__' } as SessionRecord)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('SSH_FAILED')
    expect(r.detail).toMatch(/The Walnut daemon on Cloud needs an update before it can open a terminal/)
    expect(r.hint).not.toMatch(/ssh/i)
    expect(linkRuns).toEqual([])
    expect(touchedCloud()).toEqual([])
  })

  it('a link that cannot run the probe names the connection, never ssh', async () => {
    const { runScriptOnHost } = await import('../../../src/core/hosts/host-script.js')
    vi.mocked(runScriptOnHost).mockRejectedValueOnce(new Error('Walnut cannot reach Cloud right now (dial timeout).'))
    const r = await probeTerminalMode({ claudeSessionId: 'sid-on-cloud', host: '__cloudbox__' } as SessionRecord)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.hint).toMatch(/through its connection/)
    expect(r.hint).not.toMatch(/ssh/i)
    expect(r.detail).toMatch(/cannot reach Cloud/)
  })

  it('the prewarm provisions dtach over the link, never ssh', async () => {
    await prewarmRemoteHost('__cloudbox__')
    expect(linkRuns.map((x) => x.host)).toEqual(['__cloudbox__'])
    expect(shellCalls).toEqual([])
  })

  it('the orphan sweep reaches Cloud over its link only while it is connected, and never by ssh', async () => {
    const warn = vi.spyOn(log.web, 'warn')
    try {
      await reapOrphanDtach({ remoteHosts: true })
      expect(linkRuns.some((x) => x.host === '__cloudbox__' && x.script.includes('OWNER:'))).toBe(true)
      expect(touchedCloud()).toEqual([])
      // The SSH host is still swept, by ssh.
      expect(shellCalls.some((c) => c.some((a) => a.includes('devbox.example.test')))).toBe(true)

      linkRuns.length = 0
      link.connected = false
      await reapOrphanDtach({ remoteHosts: true })
      expect(linkRuns).toEqual([])
      const listFailed = warn.mock.calls.filter(([msg]) => msg === 'reapOrphanDtach: list failed')
      expect(listFailed.filter(([, data]) => (data as { host?: string })?.host === '__cloudbox__')).toEqual([])
    } finally { warn.mockRestore() }
  })

  it('under vitest the default sweep stays on this machine (a test server never reaches its hosts)', async () => {
    await reapOrphanDtach()
    expect(shellCalls.some((c) => c.some((a) => a.includes('devbox.example.test')))).toBe(false)
    expect(linkRuns).toEqual([])
  })
})
