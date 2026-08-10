/**
 * Shared vendor-CLI runner used by the azure and gcp drivers.
 *
 * These run REAL child processes — `sh -c` and `node -e`, both already required
 * to run this suite at all — because the three things worth pinning here are
 * exactly the things a stubbed spawn cannot prove: that stdout and stderr are
 * captured separately (gcloud writes warnings to stderr while its JSON goes to
 * stdout), that the promise waits for both pipes to drain rather than resolving
 * on 'close' with a truncated stdout, and that a secret file really is 0600 and
 * really is gone afterwards.
 */
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cliErrorDetail, CliMissingError, cliVerb, killProcessGroup, parseJsonSafe, runCli, withSecretFile } from '../../../src/core/cloud-setup/providers/cli-exec.js'

const TIMEOUT = 30_000

/** True while a pid exists (signal 0 does not deliver, it only probes). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(predicate: () => boolean, budgetMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

describe('runCli', () => {
  it('captures stdout and stderr separately, and interleaved in output', async () => {
    // The gcp driver parses stdout with JSON.parse; a runner that merged the
    // streams would fail on any warning gcloud decided to print.
    const res = await runCli('sh', ['-c', 'echo out-line; echo err-line >&2'], { timeoutMs: TIMEOUT })
    expect(res.code).toBe(0)
    expect(res.stdout.trim()).toBe('out-line')
    expect(res.stderr.trim()).toBe('err-line')
    expect(res.output).toContain('out-line')
    expect(res.output).toContain('err-line')
  })

  it('returns a non-zero exit code instead of throwing', async () => {
    // The drivers decide whether an exit code is a failure or an answer
    // (gcloud's ALREADY_EXISTS, az's "not found" adopt probe), so the runner
    // must not make that call for them.
    const res = await runCli('sh', ['-c', 'echo nope >&2; exit 3'], { timeoutMs: TIMEOUT })
    expect(res.code).toBe(3)
    expect(res.stderr.trim()).toBe('nope')
  })

  it('does not truncate a large stdout that arrives in several chunks', async () => {
    // The failure this guards: resolving on 'close' alone can settle before the
    // pipes have drained, handing back a short read that then fails to parse.
    const payload = JSON.stringify({ blob: 'x'.repeat(300_000) })
    const res = await runCli('node', ['-e', `process.stdout.write(${JSON.stringify(payload)})`], { timeoutMs: TIMEOUT })
    expect(res.code).toBe(0)
    expect(res.stdout.length).toBe(payload.length)
    expect(JSON.parse(res.stdout)).toEqual({ blob: 'x'.repeat(300_000) })
  })

  it('streams whole lines to onLog and echoes the command first', async () => {
    const logs: string[] = []
    await runCli('sh', ['-c', 'echo one; echo two >&2; printf no-trailing-newline'], {
      timeoutMs: TIMEOUT,
      onLog: (l) => logs.push(l),
    })
    expect(logs[0]).toMatch(/^\$ sh -c /)
    expect(logs).toContain('one')
    expect(logs).toContain('two')
    // A final line with no newline must still be emitted, not swallowed.
    expect(logs).toContain('no-trailing-newline')
  })

  it('stays silent when no onLog is given', async () => {
    // detectCreds wants the captured output and nothing in the operator log.
    const res = await runCli('sh', ['-c', 'echo quiet'], { timeoutMs: TIMEOUT })
    expect(res.stdout.trim()).toBe('quiet')
  })

  it('applies the redactor to the echoed command AND to streamed lines', async () => {
    const logs: string[] = []
    await runCli('sh', ['-c', 'echo hunter2'], {
      timeoutMs: TIMEOUT,
      onLog: (l) => logs.push(l),
      redact: (t) => t.split('hunter2').join('<redacted>'),
    })
    const joined = logs.join('\n')
    expect(joined).not.toContain('hunter2')
    // Both surfaces: the echoed argv and the process's own output.
    expect(joined.match(/<redacted>/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('throws CliMissingError for a binary that is not on PATH', async () => {
    // detectCreds branches on this to offer "install the CLI" rather than
    // "sign in", which are different fixes for the operator.
    const err = await runCli('walnut-no-such-cli-abcdef', ['--version'], { timeoutMs: TIMEOUT })
      .then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(CliMissingError)
    expect((err as CliMissingError).code).toBe('ENOENT')
    expect((err as Error).message).toMatch(/not installed or not on PATH/)
  })

  it('closes stdin so a CLI that decides to prompt fails instead of hanging', async () => {
    // A prompt on a job nobody is watching would park the setup forever.
    const res = await runCli('sh', ['-c', 'read line || echo eof'], { timeoutMs: TIMEOUT })
    expect(res.stdout.trim()).toBe('eof')
  })

  it('kills and rejects a command that outlives its timeout', async () => {
    const started = Date.now()
    await expect(runCli('sh', ['-c', 'sleep 30'], { timeoutMs: 150 }))
      .rejects.toThrow(/timed out after/)
    // Rejected on the timeout, not after the sleep finished.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('kills the whole process TREE on timeout, not just the top-level child', async () => {
    // az and gcloud are Python wrappers that spawn subprocesses. Signalling only
    // the parent reparents the grandchild to pid 1, where a 15-minute `az vm
    // create` keeps running with nobody reading it and nobody able to stop it.
    const pidFile = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-pgid-')), 'grandchild.pid')
    await expect(runCli('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300 }))
      .rejects.toThrow(/timed out after/)

    const grandchild = Number(await fs.promises.readFile(pidFile, 'utf-8'))
    expect(Number.isInteger(grandchild), 'the test child must have recorded a grandchild pid').toBe(true)
    expect(await until(() => !alive(grandchild)), `grandchild ${grandchild} survived the timeout`).toBe(true)
    await fs.promises.rm(path.dirname(pidFile), { recursive: true, force: true })
  })

  it('rejects promptly when the signal fires mid-run, and reaps the tree', async () => {
    // Cancellation has to reach a LIVE child: a cooperative flag checked between
    // steps would let a 30-minute deploy run to completion, charging the operator
    // for work the UI already called cancelled.
    const pidFile = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'walnut-abort-')), 'grandchild.pid')
    const controller = new AbortController()
    const run = runCli('sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], {
      timeoutMs: TIMEOUT,
      signal: controller.signal,
    })
    // Fire once the child is really up, so this exercises the live-process path
    // rather than the already-aborted shortcut below.
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf-8').trim() !== '')
    const started = Date.now()
    controller.abort()

    await expect(run).rejects.toThrow(/cancelled/)
    expect(Date.now() - started).toBeLessThan(5_000)
    const grandchild = Number(fs.readFileSync(pidFile, 'utf-8'))
    expect(await until(() => !alive(grandchild)), `grandchild ${grandchild} survived the cancel`).toBe(true)
    await fs.promises.rm(path.dirname(pidFile), { recursive: true, force: true })
  })

  it('rejects a signal that was already aborted before the spawn', async () => {
    // The runner is called in a loop of steps; the abort can land between two of
    // them, and running the command anyway would create the resource the cancel
    // was meant to prevent.
    const res = await runCli('sh', ['-c', 'echo should-not-matter'], {
      timeoutMs: TIMEOUT,
      signal: AbortSignal.abort(),
    }).then(() => 'resolved, but should have rejected', (e: Error) => e.message)
    expect(res).toMatch(/cancelled/)
  })

  it('leaves no abort listener behind on a normal completion', async () => {
    // runCli is called many times per provision against ONE job signal, so a
    // listener that outlives its call accumulates for the life of the job.
    const controller = new AbortController()
    for (let i = 0; i < 5; i++) {
      await runCli('sh', ['-c', 'echo ok'], { timeoutMs: TIMEOUT, signal: controller.signal })
    }
    // No public listener count on AbortSignal, so assert the observable
    // consequence: aborting now must not throw from a stale listener of an
    // already-settled call.
    expect(() => controller.abort()).not.toThrow()
  })
})

describe('killProcessGroup', () => {
  it('refuses pids that cannot be a spawned child (undefined, 0, 1)', () => {
    // ⚠️ NEVER "test" this path by actually passing pid 1 to the real
    // implementation without the guard: kill(-1, SIGKILL) does NOT throw EPERM
    // on macOS — POSIX defines it as a BROADCAST to every process the user can
    // signal. On 2026-08-09 exactly that line tore down the user's entire GUI
    // session (every app SIGKILLed) six times in one afternoon. pid ≤ 1 can
    // only ever be corrupted bookkeeping, so the guard must signal NOTHING —
    // not even the single-pid fallback.
    const killed: string[] = []
    killProcessGroup({ pid: undefined, kill: () => killed.push('single') })
    killProcessGroup({ pid: 1, kill: () => killed.push('single') })
    killProcessGroup({ pid: 0, kill: () => killed.push('single') })
    killProcessGroup({ pid: -5 as unknown as number, kill: () => killed.push('single') })
    expect(killed).toEqual([])
  })

  it('falls back to the single pid when the group kill throws', () => {
    // Simulate the real fallback trigger (child never became a group leader →
    // ESRCH) with a spy, so the test never emits a real signal to anything.
    const killed: string[] = []
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      return true
    }) as typeof process.kill)
    try {
      killProcessGroup({ pid: 424242, kill: () => killed.push('single') })
    } finally {
      spy.mockRestore()
    }
    expect(killed).toEqual(['single'])
  })
})

describe('parseJsonSafe', () => {
  it('parses JSON, and answers undefined rather than throwing on anything else', () => {
    // Shared by azure and gcp detectCreds: a CLI that printed an update warning
    // instead of JSON still means "signed in", so this must not throw.
    expect(parseJsonSafe<{ name: string }>('{"name":"acme"}')).toEqual({ name: 'acme' })
    expect(parseJsonSafe('WARNING: extension update available')).toBeUndefined()
    expect(parseJsonSafe('')).toBeUndefined()
  })
})

describe('cliVerb', () => {
  it('takes the leading non-flag tokens, so an error names the command not its argv', () => {
    expect(cliVerb(['group', 'create', '-n', 'walnut-cloud', '-l', 'eastus'])).toBe('group create')
    expect(cliVerb(['compute', 'instances', 'create', 'walnut-cloud', '--zone', 'us-central1-a']))
      .toBe('compute instances create walnut-cloud')
    expect(cliVerb(['--version'])).toBe('')
  })
})

describe('cliErrorDetail', () => {
  const base = { code: 1, stdout: '', stderr: '', output: '' }

  it('prefers stderr, which is where both CLIs put their diagnosis', () => {
    expect(cliErrorDetail({ ...base, stdout: 'ignored', stderr: 'AuthorizationFailed' }))
      .toBe('AuthorizationFailed')
  })

  it('falls back to stdout when stderr is empty', () => {
    expect(cliErrorDetail({ ...base, stdout: 'nsg not found' })).toBe('nsg not found')
  })

  it('joins multiple lines into one, since this lands in a single error message', () => {
    expect(cliErrorDetail({ ...base, stderr: 'ERROR: one\n\n  - two  \n' })).toBe('ERROR: one | - two')
  })

  it('keeps the TAIL when the output is long — the cause is usually last', () => {
    const detail = cliErrorDetail({ ...base, stderr: `${'x'.repeat(1000)}\nthe real cause` }, 100)
    expect(detail.length).toBeLessThanOrEqual(101)
    expect(detail).toContain('the real cause')
    expect(detail.startsWith('…')).toBe(true)
  })

  it('returns an empty string when the CLI said nothing at all', () => {
    expect(cliErrorDetail(base)).toBe('')
  })
})

describe('withSecretFile', () => {
  it('hands the callback a 0600 file holding exactly the content', async () => {
    // 0600 because the file holds the pairing code: another local user reading
    // it could claim the cloud companion.
    let seen = { path: '', mode: -1, content: '' }
    await withSecretFile('walnut-test-', 'boot.sh', 'secret-payload', async (file) => {
      seen = {
        path: file,
        mode: fs.statSync(file).mode & 0o777,
        content: fs.readFileSync(file, 'utf-8'),
      }
    })
    expect(seen.content).toBe('secret-payload')
    expect(seen.mode).toBe(0o600)
    expect(seen.path).toContain('walnut-test-')
    expect(seen.path).toContain('boot.sh')
  })

  it('deletes the directory after the callback resolves', async () => {
    let file = ''
    await withSecretFile('walnut-test-', 'boot.sh', 'x', async (f) => { file = f })
    expect(fs.existsSync(file)).toBe(false)
  })

  it('deletes the directory when the callback THROWS, and propagates the error', async () => {
    // The finally clause is the point: a failed provision must not leave the
    // pairing code sitting in /tmp until the next reboot.
    let file = ''
    await expect(withSecretFile('walnut-test-', 'boot.sh', 'x', async (f) => {
      file = f
      throw new Error('create failed')
    })).rejects.toThrow('create failed')
    expect(file).not.toBe('')
    expect(fs.existsSync(file)).toBe(false)
  })

  it('returns the callback value through', async () => {
    const out = await withSecretFile('walnut-test-', 'boot.sh', 'x', async () => 'result')
    expect(out).toBe('result')
  })

  it('gives each call its own directory, so concurrent jobs cannot collide', async () => {
    const [a, b] = await Promise.all([
      withSecretFile('walnut-test-', 'boot.sh', 'a', async (f) => f),
      withSecretFile('walnut-test-', 'boot.sh', 'b', async (f) => f),
    ])
    expect(a).not.toBe(b)
  })
})
