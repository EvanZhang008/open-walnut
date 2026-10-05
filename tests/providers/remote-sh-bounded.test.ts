/**
 * runSshBounded: every ssh call answers by its deadline, even when a
 * ProxyCommand child outlives ssh and holds its stderr pipe.
 *
 * Reported 2026-09-28: a 5s status probe answered after 11 minutes, a
 * ControlMaster start took 15, one reconnect attempt ran 47. The proxy client
 * inherits ssh's stderr, and Node's 'close' (and execFile's timeout) waits for
 * EVERY holder of the pipe, so killing ssh settled nothing while the proxy hung.
 *
 * MACHINE SAFETY: real child processes, but only `/bin/sh`, `sleep` and `cat`
 * (and a fake `ssh` script in the shape of one whose ProxyCommand never answers;
 * no test runs the real ssh, tests/setup/exec-guard.ts). Each stray grandchild is
 * a short `sleep` that exits by itself.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runRemoteSh, runSshBounded, SSH_PIPE_GRACE_MS, RemoteCommandError } from '../../src/providers/remote-sh.js'
import { guardedPath } from '../setup/exec-guard.js'

const sh = (script: string, timeoutMs: number, input?: string) => runSshBounded(['-c', script], { bin: '/bin/sh', timeoutMs, input })

describe('runSshBounded', () => {
  it('a plain command settles on close with its output and code', async () => {
    const t0 = Date.now()
    const r = await sh('echo out; echo err >&2', 10_000)
    expect(r).toMatchObject({ stdout: 'out\n', stderr: 'err\n', code: 0, timedOut: false })
    expect(Date.now() - t0).toBeLessThan(SSH_PIPE_GRACE_MS)
  })

  it('a non-zero exit keeps its code and stderr', async () => {
    const r = await sh('echo "Permission denied (publickey)." >&2; exit 255', 10_000)
    expect(r.code).toBe(255)
    expect(r.stderr).toContain('Permission denied')
    expect(r.timedOut).toBe(false)
  })

  it('the deadline settles at once even while a grandchild still holds stderr', async () => {
    // The shape of a stuck ProxyCommand: a background child keeps stderr open
    // and the foreground never ends.
    const t0 = Date.now()
    const r = await sh('sleep 4 >/dev/null </dev/null & sleep 4', 300)
    const took = Date.now() - t0
    expect(r.timedOut).toBe(true)
    expect(r.code).toBeNull()
    expect(took).toBeGreaterThanOrEqual(290)
    expect(took).toBeLessThan(1_000)
  })

  it('a finished command answers within the pipe grace when a grandchild outlives it', async () => {
    // ssh done, its proxy still running: the answer is ssh's, not the proxy's lifetime.
    const t0 = Date.now()
    const r = await sh('echo done; sleep 4 >/dev/null </dev/null & exit 0', 10_000)
    const took = Date.now() - t0
    expect(r).toMatchObject({ stdout: 'done\n', code: 0, timedOut: false })
    expect(took).toBeLessThan(SSH_PIPE_GRACE_MS + 1_000)
  })

  it('carries a large stdin to a large stdout intact', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024) + '\nend\n'
    const r = await runSshBounded([], { bin: 'cat', input: big, timeoutMs: 20_000 })
    expect(r.code).toBe(0)
    expect(r.stdout.length).toBe(big.length)
    expect(r.stdout.endsWith('\nend\n')).toBe(true)
  })

  it('a binary that cannot start answers with spawnError, not a hang', async () => {
    const r = await runSshBounded(['-V'], { bin: '/nonexistent/walnut-ssh-test', timeoutMs: 5_000 })
    expect(r.spawnError).toBeInstanceOf(Error)
    expect(r.code).toBeNull()
  })
})

describe('runRemoteSh with an ssh whose ProxyCommand never answers', () => {
  it('rejects as timed out by its deadline, not when the proxy exits', async () => {
    // ssh hands its stderr to the proxy, which outlives it, and neither ends.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fake-ssh-'))
    fs.writeFileSync(path.join(dir, 'ssh'), '#!/bin/sh\nsleep 6 </dev/null >/dev/null &\nexec sleep 6\n', { mode: 0o755 })
    const saved = process.env.PATH
    process.env.PATH = guardedPath([dir])
    const t0 = Date.now()
    const err = await runRemoteSh([
      '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ProxyCommand=sleep 6', 'nobody@walnut-test.invalid',
    ], 'echo hi', 1_500).catch((e: unknown) => e).finally(() => {
      process.env.PATH = saved
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const took = Date.now() - t0
    expect(err).toBeInstanceOf(RemoteCommandError)
    expect((err as Error).message).toContain('timed out after 1500ms')
    // Before: settled only when `sleep 6` exited (and a real stuck proxy never does).
    expect(took).toBeLessThan(3_000)
  })
})
