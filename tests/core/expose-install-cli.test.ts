/**
 * A tunnel provider's install command (src/core/expose/install-cli.ts), run for
 * real: under sh -c, from the home dir, in its own process group, so a timeout or
 * a stopping server ends everything it started (a `curl | sh` forks), and the
 * answer comes only once that is gone. The processes signalled here are the
 * test's own (the shells it starts and their children).
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { installFailure, shellInstall } from '../../src/core/expose/install-cli.js'

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin' }
const dirs: string[] = []
const started: number[] = []

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-install-cli-'))
  dirs.push(dir)
  return dir
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function pidIn(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
    if (raw) { const pid = Number(raw); started.push(pid); return pid }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('no pid written')
}

afterEach(() => {
  for (const pid of started.splice(0)) { try { if (pid > 1) process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('shellInstall', () => {
  it('runs the command under sh -c and keeps what it printed', async () => {
    const ok = await shellInstall('echo one; echo two >&2', env, 10_000)
    expect(ok.ok).toBe(true)
    expect(ok.output).toContain('one')
    expect(ok.output).toContain('two')
    expect(await shellInstall('echo nope; exit 3', env, 10_000)).toEqual({ ok: false, output: 'nope\n' })
    expect(await shellInstall('exit 4', env, 10_000)).toEqual({ ok: false, output: 'exited with code 4' })
  })

  it('gets only the environment it is given', async () => {
    const out = await shellInstall('echo "[$FAKE_SECRET][$FAKE_GIVEN]"', { ...env, FAKE_GIVEN: 'yes' }, 10_000)
    expect(out.output.trim()).toBe('[][yes]')
  })

  it('runs from the home dir it is given (never the server\'s own dir), else the temp dir', async () => {
    const home = tmp()
    const out = await shellInstall('pwd -P', { ...env, HOME: home }, 10_000)
    expect(out.output.trim()).toBe(fs.realpathSync(home))
    const none = await shellInstall('pwd -P', { ...env, HOME: path.join(home, 'no-such-dir') }, 10_000)
    expect([fs.realpathSync(os.homedir()), fs.realpathSync(os.tmpdir())]).toContain(none.output.trim())
    expect(none.output.trim()).not.toBe(fs.realpathSync(process.cwd()))
  })

  it('a timeout stops its whole group, what it forked too, and answers only once that is gone', async () => {
    const dir = tmp()
    const pidFile = path.join(dir, 'child.pid')
    const t0 = Date.now()
    const out = await shellInstall(`sleep 60 & echo $! > ${pidFile}; wait`, env, 400)
    const child = await pidIn(pidFile)
    expect(out.ok).toBe(false)
    expect(out.output).toMatch(/stopped after 1 second$/)
    expect(alive(child)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(9_000)
  })

  it('an abort (the server stopping) ends the group the same way', async () => {
    const dir = tmp()
    const pidFile = path.join(dir, 'child.pid')
    const abort = new AbortController()
    const running = shellInstall(`sleep 60 & echo $! > ${pidFile}; wait`, env, 60_000, abort.signal)
    const child = await pidIn(pidFile)
    expect(alive(child)).toBe(true)
    abort.abort()
    const out = await running
    expect(out).toMatchObject({ ok: false })
    expect(out.output).toMatch(/the server is stopping/)
    expect(alive(child)).toBe(false)
    // Already aborted: it stops at once.
    const late = await shellInstall('sleep 30', env, 60_000, abort.signal)
    expect(late.ok).toBe(false)
  })

  it('a successful install that left a child holding its output answers anyway, and that child is left alone', async () => {
    const dir = tmp()
    const pidFile = path.join(dir, 'child.pid')
    const t0 = Date.now()
    const out = await shellInstall(`sleep 30 & echo $! > ${pidFile}; echo installed`, env, 60_000)
    const child = await pidIn(pidFile)
    expect(out).toMatchObject({ ok: true })
    expect(out.output).toContain('installed')
    expect(Date.now() - t0).toBeLessThan(9_000)
    // Only a stop ends what it started; a finished install may have started a helper on purpose.
    expect(alive(child)).toBe(true)
  })
})

describe('installFailure', () => {
  it('is one sentence from the last line it printed', () => {
    expect(installFailure('Acme Tunnel', 'step one\n\x1b[31merror: no access\x1b[0m\n')).toBe('Installing Acme Tunnel failed: error: no access.')
    expect(installFailure('Acme Tunnel', 'Done!\n')).toBe('Installing Acme Tunnel failed: Done!')
    expect(installFailure('Acme Tunnel', '  \n')).toBe('Installing Acme Tunnel failed.')
  })
})
