/**
 * Install Tailscale on this Mac with Homebrew, for the console's guided setup
 * card (Settings, Phones & Cloud). ONE job at a time, its state kept in memory
 * and read through GET /api/devices/tailscale.
 *
 * What it runs, and nothing else: `brew install --cask tailscale-app` (the cask
 * `tailscale` is the deprecated name), argv only, never a shell, never sudo.
 * The cask is a .pkg, so Homebrew itself calls sudo for the installer. The child
 * gets its own session (`detached`), so it has no controlling terminal: on a Mac
 * with Touch ID for sudo the system asks with its own dialog, and anywhere else
 * sudo fails at once instead of waiting forever on the terminal the server was
 * started from. That failure becomes a plain sentence for the console.
 *
 * Also here: `open -a Tailscale`, so the app's sign-in window appears.
 * Everything is async (tests/core/event-loop-blocking-ratchet.test.ts).
 */

import path from 'node:path'
import { access, constants as fsConstants } from 'node:fs/promises'
import { execFile, spawn as realSpawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { gitChildEnv } from '../lib/git-env.js'
import { safeKillProcessGroup } from './process-group-kill.js'
import { forgetTailscaleStatus, tailscaleDetail } from './tailnet.js'
import { log } from '../logging/index.js'

export const TAILSCALE_CASK = 'tailscale-app'
const INSTALL_TIMEOUT_MS = 15 * 60_000
const LOG_RING_LINES = 200
/** Lines the GET returns; the ring keeps more for the server log. */
export const LOG_VIEW_LINES = 40
const MAX_LINE_CHARS = 500
const BREW_FALLBACK_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']
const OPEN_TIMEOUT_MS = 10_000

export type InstallJobState = 'running' | 'done' | 'failed'

/** The job as GET /api/devices/tailscale shows it. */
export interface InstallJobView {
  state: InstallJobState
  startedAt: string
  log: string[]
  error?: string
}

/** What `spawn` must give back: the slice of ChildProcess this module uses. */
export interface InstallChild {
  pid?: number
  stdout: Readable | null
  stderr: Readable | null
  once(event: 'error', cb: (err: Error) => void): unknown
  once(event: 'close' | 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type InstallSpawn = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => InstallChild

interface Seams {
  spawn: InstallSpawn
  locateBrew: () => Promise<string | null>
  isInstalled: () => Promise<boolean>
  openApp: () => Promise<void>
  platform: NodeJS.Platform
  timeoutMs: number
  /** After brew exits, how long its pipes may stay open (a child still holding them) before the job ends anyway. */
  exitGraceMs: number
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `which brew` over PATH, then the two standard prefixes. A stat, nothing is run. */
async function realLocateBrew(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'brew')
    if (await isExecutable(candidate)) return candidate
  }
  for (const candidate of BREW_FALLBACK_PATHS) {
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

const realOpenApp = (): Promise<void> => new Promise((resolve, reject) => {
  execFile('open', ['-a', 'Tailscale'], { timeout: OPEN_TIMEOUT_MS, encoding: 'utf8' }, (err, _stdout, stderr) => {
    if (err) {
      const why = String(stderr ?? '').trim().split('\n')[0] || err.message
      reject(new Error(why))
      return
    }
    resolve()
  })
})

const defaultSeams = (): Seams => ({
  spawn: (file, args, opts) => realSpawn(file, args, opts),
  locateBrew: realLocateBrew,
  isInstalled: async () => (await tailscaleDetail({ refresh: true })).installed,
  openApp: realOpenApp,
  platform: process.platform,
  timeoutMs: INSTALL_TIMEOUT_MS,
  exitGraceMs: 3_000,
})

let seams: Seams = defaultSeams()

interface Job {
  state: InstallJobState
  startedAt: string
  lines: string[]
  error?: string
}

let job: Job | null = null
/** True between a start's first check and its spawn, so two clicks never start two jobs. */
let starting = false

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

function pushLine(target: Job, raw: string): void {
  const line = raw.replace(ANSI, '').trimEnd()
  if (!line.trim()) return
  target.lines.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}...` : line)
  if (target.lines.length > LOG_RING_LINES) target.lines.splice(0, target.lines.length - LOG_RING_LINES)
}

/** Split a stream into lines (Homebrew's progress bars redraw with `\r`). */
function collectLines(target: Job, stream: Readable | null): void {
  if (!stream) return
  let partial = ''
  stream.setEncoding?.('utf8')
  stream.on('data', (chunk: string | Buffer) => {
    const parts = (partial + String(chunk)).split(/\r\n|\r|\n/)
    partial = parts.pop() ?? ''
    for (const p of parts) pushLine(target, p)
  })
  stream.on('end', () => {
    if (partial) pushLine(target, partial)
    partial = ''
  })
}

/** The sentence the console shows for a failed run, from what Homebrew printed. */
export function installFailureMessage(lines: readonly string[], code: number | null, signal: NodeJS.Signals | null): string {
  const text = lines.join('\n')
  if (/a terminal is required|no tty present|askpass|incorrect password|sudo: /i.test(text)) {
    return 'Homebrew needs your Mac password to install Tailscale and cannot ask for it from here. Get Tailscale from the App Store instead, or run brew install --cask tailscale-app in Terminal.'
  }
  const lastError = [...lines].reverse().find((l) => /^Error:/.test(l.trim()))
  if (lastError) return `Homebrew could not install Tailscale. ${lastError.trim()}`
  const last = [...lines].reverse().find((l) => l.trim())
  const how = signal ? `stopped by ${signal}` : `exited with code ${code ?? 'unknown'}`
  return `Homebrew could not install Tailscale (it ${how})${last ? `: ${last.trim()}` : '.'}`
}

function viewOf(j: Job): InstallJobView {
  return {
    state: j.state,
    startedAt: j.startedAt,
    log: j.lines.slice(-LOG_VIEW_LINES),
    ...(j.error ? { error: j.error } : {}),
  }
}

/** What GET /api/devices/tailscale reports under `install`. Never throws. */
export async function tailscaleInstallState(): Promise<{ brew: boolean; macOS: boolean; job: InstallJobView | null }> {
  const macOS = seams.platform === 'darwin'
  let brew = false
  if (macOS) {
    try { brew = (await seams.locateBrew()) !== null } catch { brew = false }
  }
  return { brew, macOS, job: job ? viewOf(job) : null }
}

export type StartInstallResult =
  | { ok: true; job: InstallJobView }
  | { ok: false; status: 400 | 409; error: string }

/**
 * Start `brew install --cask tailscale-app`. Refuses while a job runs (409),
 * off macOS, without Homebrew, or when Tailscale is already installed (400).
 * Resolves once the child is spawned; the job runs on in the background.
 */
export async function startTailscaleInstall(): Promise<StartInstallResult> {
  if (starting || job?.state === 'running') {
    return { ok: false, status: 409, error: 'Tailscale is already being installed.' }
  }
  starting = true
  try {
    if (seams.platform !== 'darwin') {
      return { ok: false, status: 400, error: 'Installing with Homebrew works only on macOS.' }
    }
    const brew = await seams.locateBrew()
    if (!brew) {
      return { ok: false, status: 400, error: 'Homebrew is not installed on this Mac; get Tailscale from the App Store instead.' }
    }
    if (await seams.isInstalled()) {
      return { ok: false, status: 400, error: 'Tailscale is already installed on this Mac.' }
    }
    return { ok: true, job: viewOf(run(brew)) }
  } finally {
    starting = false
  }
}

function run(brew: string): Job {
  const current: Job = { state: 'running', startedAt: new Date().toISOString(), lines: [] }
  job = current
  const args = ['install', '--cask', TAILSCALE_CASK]
  log.web.info('tailscale install: starting', { brew, args: args.join(' ') })

  let child: InstallChild
  try {
    child = seams.spawn(brew, args, {
      // No auto-update (minutes of git work and a second thing changing the Mac), no prompts.
      env: gitChildEnv({ HOMEBREW_NO_AUTO_UPDATE: '1', NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (err) {
    current.state = 'failed'
    current.error = `Could not start Homebrew: ${err instanceof Error ? err.message : String(err)}`
    log.web.warn('tailscale install: spawn failed', { error: current.error })
    return current
  }

  collectLines(current, child.stdout)
  collectLines(current, child.stderr)

  const TIMEOUT_MESSAGE = 'Homebrew did not finish within 15 minutes, so the install was stopped.'
  let settled = false
  let timedOut = false
  // Every timer that can end the job; finish() clears them all.
  const timers: NodeJS.Timeout[] = []
  const later = (ms: number, fn: () => void): void => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    timers.push(t)
  }
  const killGroup = (signal: NodeJS.Signals): void => {
    // Homebrew runs curl and the installer under it: end the whole group it leads.
    if (!safeKillProcessGroup(child.pid, signal)) {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  later(seams.timeoutMs, () => {
    timedOut = true
    killGroup('SIGTERM')
    later(5_000, () => {
      killGroup('SIGKILL')
      // The installer runs as root under sudo, out of this user's reach, and may
      // still hold the pipes: the job ends here whatever it does.
      later(seams.exitGraceMs, () => finish('failed', TIMEOUT_MESSAGE))
    })
  })

  const finish = (state: 'done' | 'failed', error?: string): void => {
    if (settled) return
    settled = true
    for (const t of timers) clearTimeout(t)
    current.state = state
    if (error) current.error = error
    log.web.info('tailscale install: finished', { state, ...(error ? { error } : {}), lines: current.lines.length })
    if (state !== 'done') return
    // The CLI exists now: the next status read must not serve "not installed" from the cache.
    forgetTailscaleStatus()
    seams.openApp().catch((err: unknown) => {
      log.web.warn('tailscale install: open -a Tailscale failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }

  const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (timedOut) finish('failed', TIMEOUT_MESSAGE)
    else if (code === 0) finish('done')
    else finish('failed', installFailureMessage(current.lines, code, signal))
  }
  child.once('error', (err) => finish('failed', `Could not start Homebrew: ${err.message}`))
  // `close` waits for every process holding the pipes; brew's own exit code is
  // final, so a child that keeps them open only gets a grace period for output.
  child.once('exit', (code, signal) => later(seams.exitGraceMs, () => settle(code, signal)))
  child.once('close', settle)
  return current
}

export type OpenAppResult = { ok: true } | { ok: false; status: 500 | 501; error: string }

/** `open -a Tailscale` (macOS only), so the app shows its sign-in window. */
export async function openTailscaleApp(): Promise<OpenAppResult> {
  if (seams.platform !== 'darwin') {
    return { ok: false, status: 501, error: 'Opening Tailscale from here works only on macOS; on this machine run tailscale up in a terminal.' }
  }
  try {
    await seams.openApp()
    return { ok: true }
  } catch (err) {
    return { ok: false, status: 500, error: `Could not open Tailscale: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/**
 * Test seam: replace any of spawn / brew lookup / installed check / open /
 * platform / timeout. `null` restores the real ones. Always forgets the job.
 */
export function _setTailscaleInstallForTesting(impl: Partial<Seams> | null): void {
  seams = { ...defaultSeams(), ...(impl ?? {}) }
  job = null
  starting = false
}
