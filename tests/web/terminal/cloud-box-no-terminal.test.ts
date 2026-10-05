/**
 * The cloud box has no SSH door (its sessions ride the companion's daemon
 * tunnel), so nothing terminal-shaped may try to ssh it: not a terminal open,
 * not the prewarm, not the orphan sweep. And a refusal says why in the cloud's
 * own words, never "check that `ssh __cloudbox__` works".
 *
 * child_process is replaced wholesale: every shell the terminal code would run
 * is recorded, nothing executes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const shellCalls: string[][] = []

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
    return { on: () => {}, kill: () => {} }
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

import { log } from '../../../src/logging/index.js'
import { prewarmRemoteHost, resolveSshTarget } from '../../../src/web/terminal/spawn.js'
import { probeTerminalMode } from '../../../src/web/terminal/dtach-check.js'
import { reapOrphanDtach } from '../../../src/web/terminal/dtach-lifecycle.js'
import type { SessionRecord } from '../../../src/core/types.js'

const touchedCloud = () => shellCalls.filter((c) => c.some((a) => a.includes('__cloudbox__') || a.includes('127.0.0.1:9')))

beforeEach(() => { shellCalls.length = 0 })

describe('no terminal on the cloud box', () => {
  it('the ssh target for a terminal is refused on Cloud, and still resolved for an SSH host', async () => {
    await expect(resolveSshTarget('__cloudbox__')).rejects.toThrow('A terminal is not available on Cloud: this Mac reaches it through the cloud companion, not SSH')
    await expect(resolveSshTarget('devbox')).resolves.toMatchObject({ hostname: 'devbox.example.test' })
  })

  it('terminal:open on Cloud says why in the cloud\'s words, with no ssh hint', async () => {
    const r = await probeTerminalMode({ claudeSessionId: 'sid-on-cloud', host: '__cloudbox__' } as SessionRecord)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('SSH_FAILED')
    expect(r.hint).toBe('Cloud runs this session through the cloud companion, which has no SSH, so there is no terminal there. Files and Changes still work.')
    expect(r.hint).not.toMatch(/ssh __cloudbox__/i)
    expect(r.detail).toMatch(/not available on Cloud/)
    expect(touchedCloud()).toEqual([])
  })

  it('the prewarm does nothing for Cloud', async () => {
    await prewarmRemoteHost('__cloudbox__')
    expect(shellCalls).toEqual([])
  })

  it('the orphan sweep skips Cloud: no ssh to it and no warning on every start', async () => {
    const warn = vi.spyOn(log.web, 'warn')
    try {
      // remoteHosts: on outside vitest; here every ssh is the mocked shell.
      await reapOrphanDtach({ remoteHosts: true })
      const listFailed = warn.mock.calls.filter(([msg]) => msg === 'reapOrphanDtach: list failed')
      expect(listFailed.filter(([, data]) => (data as { host?: string })?.host === '__cloudbox__')).toEqual([])
      expect(touchedCloud()).toEqual([])
      // The SSH host is still swept.
      expect(shellCalls.some((c) => c.some((a) => a.includes('devbox.example.test')))).toBe(true)
    } finally { warn.mockRestore() }
  })

  it('under vitest the default sweep stays on this machine (a test server never ssh-es its hosts)', async () => {
    await reapOrphanDtach()
    expect(shellCalls.some((c) => c.some((a) => a.includes('devbox.example.test')))).toBe(false)
  })
})
