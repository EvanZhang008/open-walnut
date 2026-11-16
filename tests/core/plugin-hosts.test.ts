/**
 * `walnut.hosts.run` (src/core/plugins/plugin-hosts.ts): the one way a plugin runs a short
 * script on a host. Local runs are real here (sh on this machine); a remote run goes through
 * the host's link and daemon (tests/core/hosts/host-script.test.ts), never ssh.
 */
import { describe, it, expect, vi } from 'vitest'
import { spawn } from 'node:child_process'

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    hosts: {
      devbox: { hostname: 'devbox.example.test', user: 'me', port: 2222 },
    },
  })),
}))

import { runOnPluginHost, type SpawnLike } from '../../src/core/plugins/plugin-hosts.js'

/** A spawn stand-in that records every call: the checks below must refuse before any. */
function recordingSpawn() {
  const calls: string[] = []
  const impl = ((command: string) => { calls.push(command); throw new Error('spawned') }) as unknown as SpawnLike
  return { impl, calls }
}

describe('hosts.run arguments', () => {
  it('refuses a bad call before running anything', async () => {
    const { impl, calls } = recordingSpawn()
    await expect(runOnPluginHost('missing', { script: 'true' }, impl)).rejects.toThrow(/no host named "missing"/)
    await expect(runOnPluginHost('devbox', { script: '  ' }, impl)).rejects.toThrow(/needs a script/)
    await expect(runOnPluginHost('devbox', { script: 'true', args: ['a\0b'] }, impl)).rejects.toThrow(/NUL/)
    expect(calls).toEqual([])
  })
})

describe('hosts.run on this machine', () => {
  it('passes arguments through untouched and reports the exit code and stderr', async () => {
    const args = ["it's", 'a b', '$(echo no)', '*', 'caf\u00e9', '']
    const result = await runOnPluginHost('__local__', { script: 'for a in "$@"; do printf "[%s]" "$a"; done; echo oops >&2; exit 7', args })
    expect(result).toEqual({ code: 7, stdout: "[it's][a b][$(echo no)][*][caf\u00e9][]", stderr: 'oops\n', timedOut: false, truncated: false })
  })

  it('ends a run that outlives its timeout, and one that prints past its cap', async () => {
    const slow = await runOnPluginHost('__local__', { script: 'echo started; sleep 3; echo never', timeoutMs: 1000 })
    expect(slow).toMatchObject({ code: null, timedOut: true, truncated: false, stdout: 'started\n' })

    const loud = await runOnPluginHost('__local__', { script: 'while :; do echo 0123456789; done', maxOutputBytes: 25 })
    expect(loud).toMatchObject({ code: null, timedOut: false, truncated: true })
    expect(loud.stdout).toHaveLength(25)
  }, 15_000)

  it('reports a command that cannot start as a failed run, not a throw', async () => {
    const failing = ((_command: string, argv: string[], options: object) =>
      spawn('/nonexistent/walnut-test-binary', argv, options)) as unknown as SpawnLike
    const result = await runOnPluginHost('__local__', { script: 'true' }, failing)
    expect(result.code).toBeNull()
    expect(result.stderr).toMatch(/ENOENT/)
  })
})
