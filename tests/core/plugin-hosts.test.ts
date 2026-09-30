/**
 * `walnut.hosts.run` (src/core/plugins/plugin-hosts.ts): the one way a plugin runs a short
 * script on a host. Remote runs go over ssh with key auth only; the arguments cross a login
 * shell, so every one must arrive as the literal string the plugin passed. Local runs are real
 * here (sh on this machine); remote ones check the ssh command line through an injected spawn.
 */
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    hosts: {
      devbox: { hostname: 'devbox.example.test', user: 'me', port: 2222 },
      plain: { hostname: 'plain.example.test' },
      sneaky: { hostname: '-oProxyCommand=touch /tmp/x' },
    },
  })),
}))

import { hostRunCommand, runOnPluginHost, shellQuote, type SpawnLike } from '../../src/core/plugins/plugin-hosts.js'

/** A spawn stand-in that records the command line and exits with `code` after `stdout`. */
function fakeSpawn(stdout: string, code = 0) {
  const calls: Array<{ command: string; argv: string[]; stdin: string }> = []
  const impl = ((command: string, argv: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => true
    let stdin = ''
    child.stdin.on('data', (chunk: Buffer) => { stdin += chunk.toString() })
    child.stdin.on('finish', () => {
      calls.push({ command, argv, stdin })
      child.stdout.end(stdout)
      setImmediate(() => child.emit('close', code))
    })
    return child
  }) as unknown as SpawnLike
  return { impl, calls }
}

describe('hosts.run command line', () => {
  it('runs sh -s over ssh with key auth only, and quotes every argument for the login shell', async () => {
    const { impl, calls } = fakeSpawn('{"ok":true}\n')
    const result = await runOnPluginHost('devbox', { script: 'echo "$1"', args: ["it's", 'a b', '$(echo injected)', 'caf\u00e9'] }, impl)
    expect(result).toEqual({ code: 0, stdout: '{"ok":true}\n', stderr: '', timedOut: false, truncated: false })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call!.command).toBe('ssh')
    expect(call!.stdin).toBe('echo "$1"')
    expect(call!.argv).toEqual([
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'StrictHostKeyChecking=accept-new', '-p', '2222', 'me@devbox.example.test',
      `sh -s -- 'it'\\''s' 'a b' '$(echo injected)' 'caf\u00e9'`,
    ])
  })

  it('leaves out user and port when the host has none', () => {
    const { argv } = hostRunCommand({ alias: 'plain', local: false, enabled: true, hostname: 'plain.example.test' }, [])
    expect(argv.slice(-2)).toEqual(['plain.example.test', 'sh -s --'])
    expect(argv).not.toContain('-p')
  })

  it('refuses a hostname that ssh would read as an option, before spawning anything', async () => {
    const { impl, calls } = fakeSpawn('')
    await expect(runOnPluginHost('sneaky', { script: 'true' }, impl)).rejects.toThrow(/no hostname ssh can use/)
    await expect(runOnPluginHost('missing', { script: 'true' }, impl)).rejects.toThrow(/no host named "missing"/)
    await expect(runOnPluginHost('devbox', { script: '  ' }, impl)).rejects.toThrow(/needs a script/)
    await expect(runOnPluginHost('devbox', { script: 'true', args: ['a\0b'] }, impl)).rejects.toThrow(/NUL/)
    expect(calls).toEqual([])
  })

  it('quotes the empty string and a lone quote', () => {
    expect(shellQuote('')).toBe(`''`)
    expect(shellQuote(`'`)).toBe(`''\\'''`)
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
