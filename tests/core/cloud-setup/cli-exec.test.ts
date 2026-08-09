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
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { cliErrorDetail, CliMissingError, cliVerb, runCli, withSecretFile } from '../../../src/core/cloud-setup/providers/cli-exec.js'

const TIMEOUT = 30_000

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

  it('kills and rejects a command that outlives its timeout', async () => {
    const started = Date.now()
    await expect(runCli('sh', ['-c', 'sleep 30'], { timeoutMs: 150 }))
      .rejects.toThrow(/timed out after/)
    // Rejected on the timeout, not after the sleep finished.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('closes stdin so a CLI that decides to prompt fails instead of hanging', async () => {
    // A prompt on a job nobody is watching would park the setup forever.
    const res = await runCli('sh', ['-c', 'read line || echo eof'], { timeoutMs: TIMEOUT })
    expect(res.stdout.trim()).toBe('eof')
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
