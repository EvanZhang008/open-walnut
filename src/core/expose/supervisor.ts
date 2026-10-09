/**
 * Runs one tunnel provider and keeps it alive (docs/plan/walnut-servers-everywhere.md).
 *
 * The provider's command starts with the tunnel port filled in; its output is read
 * line by line for the public URL. The process is the server's own child: on a
 * clean stop it gets SIGTERM, then SIGKILL after 5 s, and it shares the server's
 * process group, so a managed server's group stop (launchd, the host's daemon)
 * ends it too.
 *
 * States (types.ts): `starting` → `connected` when a line matches the URL pattern
 * (and, for a provider with a ready pattern, once a ready line came too: some print
 * the address before the connection is up).
 * An exit, a URL that never came, or a URL that stopped answering is `retrying`
 * with growing waits (5 s to 5 min, back to 5 s after a minute connected). A line
 * matching a sign-in pattern is `needs-sign-in` (connected or not; the next URL or
 * ready line brings it back), a command that is not installed
 * is `missing`: both retry slowly, so renewing the sign-in or installing the tool
 * is all the person has to do. Every callback carries the run's generation, so a
 * late event from a replaced child changes nothing.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import os from 'node:os'
import type { ExposeProviderDefinition, ExposeState, ExposeStatus } from './types.js'

export const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
export const SIGN_IN_RETRY_MS = 60_000
export const MISSING_RETRY_MS = 300_000
/** A run connected this long has proven itself: the next failure starts the waits over. */
export const HEALTHY_MS = 60_000
/** A run that printed no URL in this long is stopped and started again. */
export const NO_URL_MS = 120_000
export const PROBE_EVERY_MS = 60_000
export const PROBE_TIMEOUT_MS = 10_000
export const PROBE_FAILURES = 3
export const KILL_AFTER_MS = 5_000

export interface ExposeChild {
  readonly pid?: number
  onLine(handler: (line: string) => void): void
  onExit(handler: (code: number | null, signal: string | null) => void): void
  onSpawnError(handler: (error: NodeJS.ErrnoException) => void): void
  kill(signal: NodeJS.Signals): void
}

export interface SupervisorDeps {
  spawn(command: string, args: string[], env: Record<string, string>): ExposeChild
  /** True when the URL answered at all (any HTTP status); false on a network error or timeout. */
  probe(url: string, timeoutMs: number): Promise<boolean>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(timer: unknown): void
  log: {
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
}

/** A definition ready to run: placeholders filled, patterns compiled. */
export interface ExposeRun {
  providerId: string
  title: string
  command: string
  args: string[]
  env: Record<string, string>
  urlPattern: RegExp
  readyPattern?: RegExp
  signInPatterns: RegExp[]
  signInHint?: string
  installHint?: string
  probe: boolean
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return `${os.homedir()}/${input.slice(2)}`
  return input
}

/**
 * Fill a definition in for one run. Throws a sentence when the definition or an
 * option value cannot be used (a pattern that does not compile, a value that does
 * not match its option's pattern), which the runtime shows as `unavailable`.
 */
export function resolveRun(def: ExposeProviderDefinition, port: number, values: Record<string, string> = {}): ExposeRun {
  const filled: Record<string, string> = { port: String(port) }
  for (const option of def.options ?? []) {
    const value = (values[option.key] ?? option.default ?? '').trim()
    if (option.pattern && !new RegExp(`^(?:${option.pattern})$`).test(value)) {
      throw new Error(`${option.label} "${value}" is not valid for ${def.title}.`)
    }
    filled[option.key] = value
  }
  const args = (def.args ?? []).map((arg) => arg.replace(/\{([a-z][a-z0-9_]*)\}/gi, (whole, key: string) => filled[key] ?? whole))
  let urlPattern: RegExp
  let readyPattern: RegExp | undefined
  let signInPatterns: RegExp[]
  try {
    urlPattern = new RegExp(def.urlPattern)
    readyPattern = def.readyPattern ? new RegExp(def.readyPattern, 'i') : undefined
    signInPatterns = (def.signInPatterns ?? []).map((p) => new RegExp(p, 'i'))
  } catch (error) {
    throw new Error(`${def.title} has a pattern that does not compile: ${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    providerId: def.id,
    title: def.title,
    command: expandHome(def.command.trim()),
    args,
    env: { ...(def.env ?? {}) },
    urlPattern,
    ...(readyPattern ? { readyPattern } : {}),
    signInPatterns,
    ...(def.signInHint ? { signInHint: def.signInHint } : {}),
    ...(def.installHint ? { installHint: def.installHint } : {}),
    probe: def.probe !== false,
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** The public URL in one line of output, without the punctuation a sentence puts after it. */
export function urlInLine(line: string, pattern: RegExp): string | null {
  const match = line.replace(ANSI, '').match(pattern)
  if (!match) return null
  return match[0].replace(/[.,;:!)\]'"]+$/, '')
}

export class ExposeSupervisor {
  private current: {
    run: ExposeRun
    port: number
    child: ExposeChild | null
    gen: number
  } | null = null
  private gen = 0
  private state: ExposeState = 'off'
  private since: number
  private url: string | undefined
  private lastError: string | undefined
  private hint: string | undefined
  private nextRetryAt: number | undefined
  private attempt = 0
  private connectedAt = 0
  private probeFailures = 0
  private timers = new Set<unknown>()
  private probeTimer: unknown = null
  private exited: Promise<void> | null = null
  private stopping = false
  /** Retry was pressed while the child still ran: start the next one at once, not after a wait. */
  private restartNow = false

  constructor(private readonly deps: SupervisorDeps, private readonly onStatus: (status: ExposeStatus) => void) {
    this.since = deps.now()
  }

  status(): Omit<ExposeStatus, 'enabled' | 'provider' | 'providerTitle'> {
    return {
      state: this.state,
      since: this.since,
      ...(this.url ? { url: this.url } : {}),
      ...(this.current ? { port: this.current.port } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.nextRetryAt ? { nextRetryAt: this.nextRetryAt } : {}),
    }
  }

  /** What is running now, if anything: the runtime compares before it replaces a run. */
  running(): { providerId: string; command: string; args: string[]; port: number } | null {
    if (!this.current) return null
    return { providerId: this.current.run.providerId, command: this.current.run.command, args: this.current.run.args, port: this.current.port }
  }

  /** Start `run`, replacing whatever runs now. */
  async start(run: ExposeRun, port: number): Promise<void> {
    await this.stop({ quiet: true })
    this.stopping = false
    this.restartNow = false
    this.attempt = 0
    this.url = undefined
    this.current = { run, port, child: null, gen: ++this.gen }
    this.spawnNow()
  }

  /** The person pressed Retry: start again now, whatever the wait (a running child is replaced). */
  retryNow(): void {
    if (!this.current || this.stopping) return
    this.attempt = 0
    if (this.current.child) {
      this.restartNow = true
      this.current.child.kill('SIGTERM')
      return
    }
    this.clearTimers()
    this.spawnNow()
  }

  async stop(opts: { quiet?: boolean } = {}): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const cur = this.current
    if (cur?.child) {
      const child = cur.child
      const exited = this.exited
      child.kill('SIGTERM')
      const force = this.deps.setTimer(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, KILL_AFTER_MS)
      let giveUp: unknown
      await Promise.race([
        exited ?? Promise.resolve(),
        new Promise<void>((resolve) => { giveUp = this.deps.setTimer(resolve, KILL_AFTER_MS + 1_000) }),
      ])
      this.deps.clearTimer(force)
      this.deps.clearTimer(giveUp)
    }
    this.current = null
    this.gen++
    this.url = undefined
    this.lastError = undefined
    this.hint = undefined
    this.nextRetryAt = undefined
    if (!opts.quiet || this.state !== 'off') this.setState('off')
  }

  private setTimer(fn: () => void, ms: number): unknown {
    const timer = this.deps.setTimer(() => { this.timers.delete(timer); fn() }, ms)
    this.timers.add(timer)
    return timer
  }

  private clearTimers(): void {
    for (const timer of this.timers) this.deps.clearTimer(timer)
    this.timers.clear()
    this.probeTimer = null
  }

  private setState(state: ExposeState): void {
    if (state !== this.state) this.since = this.deps.now()
    this.state = state
    this.onStatus({ enabled: true, provider: null, ...this.status() })
  }

  private spawnNow(): void {
    const cur = this.current
    if (!cur) return
    const gen = cur.gen
    const { run } = cur
    this.nextRetryAt = undefined
    this.probeFailures = 0
    let signInSeen = false
    /** The URL a provider with a ready line printed before it said it was ready. */
    let pendingUrl: string | undefined
    let readySeen = false
    let spawnFailed: NodeJS.ErrnoException | null = null
    let lastErrorLine: string | undefined
    let resolveExited: () => void = () => {}
    this.exited = new Promise<void>((resolve) => { resolveExited = resolve })
    const live = () => this.current?.gen === gen

    let child: ExposeChild
    try {
      child = this.deps.spawn(run.command, run.args, run.env)
    } catch (error) {
      resolveExited()
      this.onSpawnFailure(error as NodeJS.ErrnoException)
      return
    }
    cur.child = child
    this.setState('starting')
    this.deps.log.info('expose: provider started', { provider: run.providerId, pid: child.pid, port: cur.port })

    const noUrl = this.setTimer(() => {
      if (!live() || this.state === 'connected') return
      lastErrorLine = `${run.title} printed no address in ${Math.round(NO_URL_MS / 60_000)} minutes.`
      child.kill('SIGTERM')
    }, NO_URL_MS)

    child.onLine((raw) => {
      if (!live()) return
      const line = raw.replace(ANSI, '').trim()
      if (!line) return
      const printed = urlInLine(line, run.urlPattern)
      const readyLine = run.readyPattern?.test(line) ?? false
      if (printed) pendingUrl = printed
      if (readyLine) readySeen = true
      // Connected on the line that completes the pair (URL, and the ready line when there is one).
      const url = (printed || readyLine) && (!run.readyPattern || readySeen) ? pendingUrl : undefined
      if (!url && (printed || readyLine)) return
      if (url) {
        this.deps.clearTimer(noUrl)
        this.timers.delete(noUrl)
        const changed = url !== this.url || this.state !== 'connected'
        this.url = url
        this.lastError = undefined
        this.hint = undefined
        signInSeen = false
        if (changed) {
          this.connectedAt = this.deps.now()
          this.deps.log.info('expose: connected', { provider: run.providerId, url })
          this.setState('connected')
          if (run.probe) this.scheduleProbe(gen)
        }
        return
      }
      if (run.signInPatterns.some((p) => p.test(line))) {
        // Connected or not: the provider says it cannot go on until the person signs in.
        // Its next URL or ready line brings it back.
        signInSeen = true
        this.hint = run.signInHint ?? `${run.title} needs you to sign in again.`
        this.lastError = this.hint
        this.setState('needs-sign-in')
        return
      }
      if (/\b(error|fatal|failed)\b/i.test(line)) lastErrorLine = line.slice(0, 200)
    })

    child.onSpawnError((error) => {
      if (!live()) return
      spawnFailed = error
    })

    child.onExit((code, signal) => {
      resolveExited()
      if (!live()) return
      cur.child = null
      this.clearTimers()
      if (this.stopping) return
      if (this.restartNow) {
        this.restartNow = false
        this.spawnNow()
        return
      }
      if (spawnFailed) {
        this.onSpawnFailure(spawnFailed)
        return
      }
      const wasHealthy = this.state === 'connected' && this.deps.now() - this.connectedAt >= HEALTHY_MS
      if (wasHealthy) this.attempt = 0
      if (signInSeen) {
        this.lastError = this.hint
        this.scheduleRetry(SIGN_IN_RETRY_MS, 'needs-sign-in')
        return
      }
      this.lastError = lastErrorLine
        ?? (signal ? `${run.title} was stopped (${signal}).` : `${run.title} exited (code ${code ?? 'unknown'}).`)
      const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
      this.attempt++
      this.deps.log.warn('expose: provider exited', { provider: run.providerId, code, signal, error: this.lastError, retryInMs: wait })
      this.scheduleRetry(wait, 'retrying')
    })
  }

  private onSpawnFailure(error: NodeJS.ErrnoException): void {
    const cur = this.current
    if (!cur) return
    cur.child = null
    const { run } = cur
    if (error.code === 'ENOENT') {
      this.lastError = `${run.title} is not installed here (${run.command} not found).`
      this.hint = run.installHint
      this.scheduleRetry(MISSING_RETRY_MS, 'missing')
      return
    }
    this.lastError = `${run.title} could not start: ${error.code ?? error.message}.`
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!
    this.attempt++
    this.scheduleRetry(wait, 'retrying')
  }

  private scheduleRetry(ms: number, state: ExposeState): void {
    this.nextRetryAt = this.deps.now() + ms
    this.setState(state)
    this.setTimer(() => {
      if (this.stopping || !this.current || this.current.child) return
      this.spawnNow()
    }, ms)
  }

  private scheduleProbe(gen: number): void {
    // One chain of checks: a run that left and came back to connected must not start a second.
    if (this.probeTimer !== null) {
      this.deps.clearTimer(this.probeTimer)
      this.timers.delete(this.probeTimer)
    }
    this.probeTimer = this.setTimer(async () => {
      this.probeTimer = null
      const cur = this.current
      if (!cur || cur.gen !== gen || this.state !== 'connected' || !this.url || !cur.child) return
      const ok = await this.deps.probe(this.url, PROBE_TIMEOUT_MS).catch(() => false)
      if (!this.current || this.current.gen !== gen || !cur.child) return
      this.probeFailures = ok ? 0 : this.probeFailures + 1
      if (this.probeFailures >= PROBE_FAILURES) {
        this.deps.log.warn('expose: the address stopped answering, restarting the provider', { provider: cur.run.providerId, url: this.url })
        const child = cur.child
        // The exit handler schedules the next start; this run's error says why.
        this.probeFailures = 0
        child.kill('SIGTERM')
        return
      }
      this.scheduleProbe(gen)
    }, PROBE_EVERY_MS)
  }
}

/** The real child: stdout and stderr read as lines, its own environment, never the server's. */
export function nodeSpawn(command: string, args: string[], env: Record<string, string>): ExposeChild {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false
  child.once('exit', () => { exited = true })
  const lineHandlers: Array<(line: string) => void> = []
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    createInterface({ input: stream }).on('line', (line) => { for (const h of lineHandlers) h(line) })
  }
  return {
    get pid() { return child.pid },
    onLine(handler) { lineHandlers.push(handler) },
    onExit(handler) { child.on('exit', (code, signal) => handler(code, signal)) },
    onSpawnError(handler) {
      // A spawn failure emits 'error' and then 'close', never 'exit' (and sets exitCode to the
      // negative errno, so that is no test): report it as an exit too. A process that started
      // has a pid, and its own 'exit' comes.
      child.on('error', (error) => {
        handler(error as NodeJS.ErrnoException)
        if (child.pid === undefined && !exited) {
          exited = true
          child.emit('exit', null, null)
        }
      })
    },
    kill(signal) { try { child.kill(signal) } catch { /* already gone */ } },
  }
}

/** Any HTTP answer counts: a tunnel in front of a sign-in page answers 302 or 401. */
export async function httpProbe(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    return true
  } catch {
    return false
  }
}
