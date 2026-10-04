/**
 * The Homebrew install job behind the console's "Install with Homebrew" button
 * (src/core/tailscale-install.ts): one job at a time, its output kept as a
 * line ring, the end of a good run busting the Tailscale status cache and
 * opening the app once.
 *
 * Nothing is spawned or signalled for real: spawn is a fake child (an
 * EventEmitter with two streams), the brew lookup / installed check / `open`
 * are seams, and the process-group kill is a mock that only records its
 * arguments (a fake pid must never reach process.kill).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

vi.mock('../../src/core/process-group-kill.js', () => ({
  safeKillProcessGroup: vi.fn(() => true),
  isSafeGroupPid: (pid: unknown) => typeof pid === 'number' && pid > 1,
}))

import {
  LOG_VIEW_LINES, TAILSCALE_CASK, _setTailscaleInstallForTesting, installFailureMessage,
  openTailscaleApp, startTailscaleInstall, tailscaleInstallState,
  type InstallChild, type InstallSpawn,
} from '../../src/core/tailscale-install.js'
import { _setTailscaleProbeForTesting, tailscaleStatus } from '../../src/core/tailnet.js'
import { safeKillProcessGroup } from '../../src/core/process-group-kill.js'

class FakeChild extends EventEmitter implements InstallChild {
  pid = 424242
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => true)
  /** Print some output, then end both streams and exit. */
  async exit(code: number | null, signal: NodeJS.Signals | null = null): Promise<void> {
    this.stdout.end()
    this.stderr.end()
    await new Promise((r) => setImmediate(r))
    this.emit('close', code, signal)
    await new Promise((r) => setImmediate(r))
  }
}

const BREW = '/opt/homebrew/bin/brew'
let children: FakeChild[]
let spawn: Mock<InstallSpawn>
let openApp: Mock<() => Promise<void>>
let installed: boolean

function seams(over: Record<string, unknown> = {}) {
  _setTailscaleInstallForTesting({
    spawn,
    locateBrew: async () => BREW,
    isInstalled: async () => installed,
    openApp,
    platform: 'darwin',
    timeoutMs: 60_000,
    ...over,
  })
}

const tick = () => new Promise((r) => setImmediate(r))

beforeEach(() => {
  children = []
  installed = false
  spawn = vi.fn<InstallSpawn>(() => {
    const c = new FakeChild()
    children.push(c)
    return c
  })
  openApp = vi.fn(async () => {})
  vi.mocked(safeKillProcessGroup).mockClear()
  seams()
})

afterEach(() => {
  _setTailscaleInstallForTesting(null)
  _setTailscaleProbeForTesting(null)
})

describe('startTailscaleInstall', () => {
  it('runs exactly brew install --cask tailscale-app, non-interactive, in its own session; success -> done, the status cache is busted and the app opens once', async () => {
    // The status cache says "not installed" for the next 60s ...
    let cli: string | null = null
    _setTailscaleProbeForTesting({
      locate: async () => cli,
      exec: async () => ({ stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: {} }), stderr: '' }),
    })
    expect((await tailscaleStatus()).installed).toBe(false)
    cli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
    expect((await tailscaleStatus()).installed).toBe(false) // cached

    const started = await startTailscaleInstall()
    expect(started).toMatchObject({ ok: true, job: { state: 'running', log: [] } })
    expect(spawn).toHaveBeenCalledTimes(1)
    const [file, args, opts] = spawn.mock.calls[0]
    expect(file).toBe(BREW)
    expect(args).toEqual(['install', '--cask', TAILSCALE_CASK])
    expect(TAILSCALE_CASK).toBe('tailscale-app')
    expect([file, ...args].join(' ')).not.toMatch(/sudo/)
    expect(opts.env.HOMEBREW_NO_AUTO_UPDATE).toBe('1')
    expect(opts.env.NONINTERACTIVE).toBe('1')
    expect(opts.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(opts.detached).toBe(true)

    const child = children[0]
    child.stdout.write('==> Downloading https://pkgs.example.com/Tailscale-1.0-macos.pkg\n')
    child.stderr.write('\x1b[34m==>\x1b[0m Installing Cask tailscale-app\n')
    child.stdout.write('#####    20.0%\r#########  60.0%\r############ 100.0%\n')
    child.stdout.write('tailscale-app was successfully installed!')
    await tick()
    expect((await tailscaleInstallState()).job).toMatchObject({ state: 'running' })
    await child.exit(0)

    const { job, brew } = await tailscaleInstallState()
    expect(brew).toBe(true)
    expect(job?.state).toBe('done')
    expect(job?.error).toBeUndefined()
    expect(job?.log).toEqual([
      '==> Downloading https://pkgs.example.com/Tailscale-1.0-macos.pkg',
      '==> Installing Cask tailscale-app',
      '#####    20.0%',
      '#########  60.0%',
      '############ 100.0%',
      'tailscale-app was successfully installed!',
    ])
    expect(openApp).toHaveBeenCalledTimes(1)
    expect((await tailscaleStatus()).installed).toBe(true) // the cache was dropped
  })

  it('a non-zero exit fails with Homebrew\'s own error line and opens nothing', async () => {
    expect((await startTailscaleInstall()).ok).toBe(true)
    const child = children[0]
    child.stderr.write('==> Downloading something\nError: Download failed on Cask \'tailscale-app\' with message: timed out\n')
    await child.exit(1)
    const { job } = await tailscaleInstallState()
    expect(job).toMatchObject({ state: 'failed', error: "Homebrew could not install Tailscale. Error: Download failed on Cask 'tailscale-app' with message: timed out" })
    expect(openApp).not.toHaveBeenCalled()
    // A failed run can be retried.
    expect((await startTailscaleInstall()).ok).toBe(true)
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it('sudo with no terminal (the .pkg step) reads as a plain sentence pointing at the App Store', async () => {
    await startTailscaleInstall()
    const child = children[0]
    child.stderr.write('==> Running installer for tailscale-app with sudo; the password may be necessary.\n')
    child.stderr.write('sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\n')
    child.stderr.write('Error: Failure while executing; `/usr/bin/sudo -E -- /usr/sbin/installer -pkg /tmp/x.pkg -target /` exited with 1.\n')
    await child.exit(1)
    const { job } = await tailscaleInstallState()
    expect(job?.state).toBe('failed')
    expect(job?.error).toBe('Homebrew needs your Mac password to install Tailscale and cannot ask for it from here. Get Tailscale from the App Store instead, or run brew install --cask tailscale-app in Terminal.')
  })

  it('refuses a second start while one runs (409), including two clicks that race the checks', async () => {
    const [a, b] = await Promise.all([startTailscaleInstall(), startTailscaleInstall()])
    expect([a.ok, b.ok].sort()).toEqual([false, true])
    expect([a, b].find((r) => !r.ok)).toMatchObject({ status: 409, error: 'Tailscale is already being installed.' })
    expect(await startTailscaleInstall()).toMatchObject({ ok: false, status: 409 })
    expect(spawn).toHaveBeenCalledTimes(1)
    await children[0].exit(0)
    installed = true
    expect(await startTailscaleInstall()).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses without Homebrew, when Tailscale is already there, and off macOS (400); nothing is spawned', async () => {
    seams({ locateBrew: async () => null })
    expect(await startTailscaleInstall()).toEqual({ ok: false, status: 400, error: 'Homebrew is not installed on this Mac; get Tailscale from the App Store instead.' })
    expect(await tailscaleInstallState()).toEqual({ brew: false, macOS: true, job: null })

    seams()
    installed = true
    expect(await startTailscaleInstall()).toEqual({ ok: false, status: 400, error: 'Tailscale is already installed on this Mac.' })

    seams({ platform: 'linux' })
    expect(await startTailscaleInstall()).toEqual({ ok: false, status: 400, error: 'Installing with Homebrew works only on macOS.' })
    // Casks are macOS only, so Linux never offers the button even with a brew on PATH, and says it is not a Mac.
    expect(await tailscaleInstallState()).toEqual({ brew: false, macOS: false, job: null })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('keeps a ring of the last 200 lines and shows the last 40', async () => {
    await startTailscaleInstall()
    const child = children[0]
    child.stdout.write(Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    child.stdout.write('\n\n   \n') // blank lines are not kept
    child.stdout.write(`${'x'.repeat(900)}\n`)
    await child.exit(1)
    const { job } = await tailscaleInstallState()
    expect(job?.log).toHaveLength(LOG_VIEW_LINES)
    expect(job?.log.at(-1)).toBe(`${'x'.repeat(500)}...`)
    expect(job?.log[0]).toBe('line 212')
    // The ring itself is what the error message reads from: the 200 newest lines.
    expect(job?.error).toContain(`${'x'.repeat(500)}...`)
  })

  it('a run past the deadline ends the whole process group and fails with a sentence', async () => {
    seams({ timeoutMs: 30 })
    await startTailscaleInstall()
    await new Promise((r) => setTimeout(r, 60))
    expect(safeKillProcessGroup).toHaveBeenCalledWith(424242, 'SIGTERM')
    await children[0].exit(null, 'SIGTERM')
    expect((await tailscaleInstallState()).job).toMatchObject({
      state: 'failed', error: 'Homebrew did not finish within 15 minutes, so the install was stopped.',
    })
    expect(openApp).not.toHaveBeenCalled()
  })

  it('brew exits 0 but a child keeps the pipes open: done after the grace period, without waiting for close', async () => {
    seams({ exitGraceMs: 20 })
    await startTailscaleInstall()
    const child = children[0]
    child.stdout.write('tailscale-app was successfully installed!\n')
    await tick()
    child.emit('exit', 0, null) // no `close`: something still holds stdout
    expect((await tailscaleInstallState()).job?.state).toBe('running')
    await new Promise((r) => setTimeout(r, 40))
    expect((await tailscaleInstallState()).job).toMatchObject({ state: 'done', log: ['tailscale-app was successfully installed!'] })
    expect(openApp).toHaveBeenCalledTimes(1)
    // A late close changes nothing and opens nothing twice.
    child.emit('close', 0, null)
    expect(openApp).toHaveBeenCalledTimes(1)
  })

  it('an installer that outlives SIGKILL (root, under sudo) still ends the job, so Install works again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      seams({ timeoutMs: 1_000, exitGraceMs: 2_000 })
      await startTailscaleInstall()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(safeKillProcessGroup).toHaveBeenLastCalledWith(424242, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(safeKillProcessGroup).toHaveBeenLastCalledWith(424242, 'SIGKILL')
      expect((await tailscaleInstallState()).job?.state).toBe('running') // no exit, no close
      await vi.advanceTimersByTimeAsync(2_000)
      expect((await tailscaleInstallState()).job).toMatchObject({
        state: 'failed', error: 'Homebrew did not finish within 15 minutes, so the install was stopped.',
      })
    } finally {
      vi.useRealTimers()
    }
    expect((await startTailscaleInstall()).ok).toBe(true)
  })

  it('a spawn error (brew vanished) fails the job instead of hanging it', async () => {
    await startTailscaleInstall()
    children[0].emit('error', new Error('spawn /opt/homebrew/bin/brew ENOENT'))
    await children[0].exit(null)
    expect((await tailscaleInstallState()).job).toMatchObject({ state: 'failed', error: 'Could not start Homebrew: spawn /opt/homebrew/bin/brew ENOENT' })
  })
})

describe('installFailureMessage', () => {
  it('falls back to the last line and the exit code or signal', () => {
    expect(installFailureMessage(['==> Downloading', 'curl: (6) Could not resolve host'], 1, null))
      .toBe('Homebrew could not install Tailscale (it exited with code 1): curl: (6) Could not resolve host')
    expect(installFailureMessage([], null, 'SIGKILL')).toBe('Homebrew could not install Tailscale (it stopped by SIGKILL).')
  })
})

describe('openTailscaleApp', () => {
  it('opens the app on macOS, says why on Linux (501), and reports a failed open (500)', async () => {
    expect(await openTailscaleApp()).toEqual({ ok: true })
    expect(openApp).toHaveBeenCalledTimes(1)

    seams({ platform: 'linux' })
    expect(await openTailscaleApp()).toEqual({
      ok: false, status: 501, error: 'Opening Tailscale from here works only on macOS; on this machine run tailscale up in a terminal.',
    })

    seams({ openApp: async () => { throw new Error('Unable to find application named \'Tailscale\'') } })
    expect(await openTailscaleApp()).toEqual({ ok: false, status: 500, error: "Could not open Tailscale: Unable to find application named 'Tailscale'" })
  })
})
