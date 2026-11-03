/**
 * Live update: a running server installs a newer release by itself and restarts
 * into it once nobody is using it (2026-11-03, the user: Walnut updates itself
 * without being asked). One per server process.
 *
 * After every update check (update-check.ts, every 6 h) with a newer release,
 * `updates.auto` on, an install this process can replace (live-update-deps.ts:
 * the compiled file's layout, or an npm install of the compiled file, writable)
 * and the release not held back (held-versions.ts), the install runs in the
 * background with the startup update's own machinery (the file's swap, or npm
 * detached); the server keeps serving the version it runs. Once it is in, the
 * restarted server's first start is watched as after any install
 * (update-unverified.json), so one that fails to start is gone back from.
 *
 * Then the idle gate (idle-gate.ts) is asked every minute; when it is ready the
 * state goes to `restarting` (pushed to every window), and after a short wait
 * the restart handler web.ts registered runs. No handler (tests, an embedded
 * server, dev) means no restart: the state stays `installed`, and the Restart
 * the page offers answers `no_restart`.
 *
 *   off ─(auto on, can install)→ idle ─(newer release)→ downloading ─→ installed
 *   installed ─(handler, gate not ready)→ waiting ─(gate ready)→ restarting
 *   downloading ─(error)→ failed ─(next check, or the person's retry)→ downloading
 *
 * A person may install (also with auto off or a held version) and restart at
 * once from the page or the API; both skip the gate.
 */

import { autoUpdateEnabled, LAUNCHER_UPDATES_ENV } from './startup-update.js'
import type { UpdateStatus } from './update-check.js'
import { idleMsFrom, judgeIdle, lastUserActivity, MAX_TURN_WAIT_MS, type IdleVerdict } from './idle-gate.js'

export type LiveState = 'off' | 'idle' | 'downloading' | 'installed' | 'waiting' | 'restarting' | 'failed'

export interface LiveStatus {
  state: LiveState
  version: string | null
  error: string | null
  canInstall: boolean
  held: string | null
  updatesAuto: boolean
  idle: IdleVerdict
}

export interface LiveUpdateDeps {
  now: () => number
  /** The shared checker's last answer. */
  status: () => UpdateStatus
  configAuto: () => Promise<boolean | undefined>
  env: Record<string, string | undefined>
  /** Can this process replace its own install while it serves (kind, writable, compiled)? */
  canSelfInstall: (status: UpdateStatus) => boolean
  /** Why `latest` is held back here, or null. */
  held: (status: UpdateStatus) => string | null
  /** An install another start began still runs: why not to start one, or null. */
  busy: () => Promise<string | null>
  /** Install `version`; throws with a one-line reason. Resolves to the version it replaced, when known. */
  install: (status: UpdateStatus, version: string, asked: boolean) => Promise<{ from: string | null }>
  markUnverified: (pending: { version: string; from: string } | null) => void
  noteInstalled: (version: string) => void
  /** A version the startup update installed after its budget ran out (its supervisor's or this process's), or null. */
  installedLater: (status: UpdateStatus) => Promise<string | null> | string | null
  turnsRunning: () => Promise<number>
  /** Something a window shows changed: push the status. */
  onChange: () => void
  log: (level: 'info' | 'warn', msg: string, meta?: Record<string, unknown>) => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  restartDelayMs?: number
  gateEveryMs?: number
  maxTurnWaitMs?: number
}

export type LiveAnswer = { ok: true } | { ok: false; code: 'cannot_install' | 'no_update' | 'no_restart'; fix?: string | null }

type RestartHandler = () => Promise<void> | void
let restartHandler: RestartHandler | null = null

/** web.ts: how this process restarts (exit 75 to its supervisor, or become one). Null: never. */
export function setRestartHandler(fn: RestartHandler | null): void {
  restartHandler = fn
  // An install that went in before the handler was there starts waiting on the gate now.
  current?.handlerChanged()
}
export function hasRestartHandler(): boolean { return restartHandler !== null }

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class LiveUpdater {
  private state: LiveState = 'off'
  private version: string | null = null
  private error: string | null = null
  private installedAtMs: number | null = null
  private auto = true
  private lastTurns = 0
  private lastReady: boolean | null = null
  private restartAsap = false
  private gateTimer: unknown = null
  private stopped = false
  private readonly startedAtMs: number
  private readonly launcher: boolean
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: LiveUpdateDeps) {
    this.startedAtMs = deps.now()
    this.launcher = deps.env[LAUNCHER_UPDATES_ENV] === '1'
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h })
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout))
  }

  /** Read the config once and settle the first state; the Mac app's page needs the gate from the start. */
  async start(): Promise<void> {
    await this.onChecked(this.deps.status())
    this.armGate()
  }

  stop(): void {
    this.stopped = true
    if (this.gateTimer) { this.clearTimer(this.gateTimer); this.gateTimer = null }
  }

  /** The restart handler came or went: canInstall changed, and an installed version may now wait on the gate. */
  handlerChanged(): void {
    this.changed()
    this.armGate()
  }

  private changed(): void {
    if (!this.stopped) this.deps.onChange()
  }

  private busyState(): boolean {
    return this.state === 'downloading' || this.state === 'installed' || this.state === 'waiting' || this.state === 'restarting'
  }

  /** After every check: settle off/idle, pick up a version installed at startup, start an automatic install. */
  async onChecked(status: UpdateStatus): Promise<void> {
    if (this.stopped) return
    this.auto = autoUpdateEnabled(await this.deps.configAuto().catch(() => undefined), this.deps.env)
    const can = this.deps.canSelfInstall(status)
    const later = await Promise.resolve(this.deps.installedLater(status)).catch(() => null)
    if (this.stopped) return
    if (!this.busyState() && later && later !== status.current) {
      this.enterInstalled(later)
    } else if (!this.busyState()) {
      // A failure keeps its error until this check tries again; nothing to try is idle (or off).
      const wanted = this.auto && can && status.available && !!status.latest && !this.deps.held(status)
      const busy = wanted ? await this.deps.busy().catch(() => null) : null
      if (this.busyState()) {
        // Another check started the install while this one waited on the config or the record.
      } else if (wanted && !busy) {
        void this.install(status, status.latest!, false)
      } else {
        if (busy) this.deps.log('info', 'live update: an install already runs', { busy })
        const keepFailure = this.state === 'failed' && !!busy
        this.state = !this.auto || !can ? 'off' : keepFailure ? 'failed' : 'idle'
        if (!keepFailure) this.error = null
      }
    }
    this.changed()
    this.armGate()
  }

  private enterInstalled(version: string): void {
    this.state = 'installed'
    this.version = version
    this.error = null
    this.installedAtMs = this.deps.now()
  }

  private async install(status: UpdateStatus, version: string, asked: boolean): Promise<void> {
    this.state = 'downloading'
    this.version = version
    this.error = null
    this.changed()
    let recorded = false
    try {
      // Never a second npm into one prefix, whoever asks (an earlier start's install may still run).
      const busy = await this.deps.busy().catch(() => null)
      if (busy) throw new Error(busy)
      this.deps.log('info', `live update: installing Open Walnut ${version} while ${status.current} serves`, { asked })
      // Recorded before it starts: npm runs detached and may finish after this server
      // stopped, and the start that then runs it must still be watched.
      this.deps.markUnverified({ version, from: status.current })
      recorded = true
      const done = await this.deps.install(status, version, asked)
      this.deps.markUnverified({ version, from: done.from ?? status.current })
      this.deps.noteInstalled(version)
      if (this.stopped) return
      this.enterInstalled(version)
      this.deps.log('info', `live update: Open Walnut ${version} is installed`, { from: done.from ?? status.current })
      this.changed()
      if (asked || this.restartAsap) { this.restartAsap = false; this.restartNow('asked') } else void this.tick().finally(() => this.armGate())
    } catch (e) {
      if (recorded) this.deps.markUnverified(null)
      if (this.stopped) return
      this.state = 'failed'
      this.error = messageOf(e)
      this.restartAsap = false
      this.deps.log('warn', `live update: Open Walnut ${version} did not install`, { error: this.error })
      this.changed()
    }
  }

  /** The gate is asked while an installed version waits, and always for the Mac app (its page restarts the shell). */
  private needsGate(): boolean {
    return !this.stopped && (this.launcher || ((this.state === 'installed' || this.state === 'waiting') && restartHandler !== null))
  }

  private armGate(): void {
    if (this.gateTimer || !this.needsGate()) return
    this.gateTimer = this.setTimer(() => { this.gateTimer = null; void this.tick().finally(() => this.armGate()) }, this.deps.gateEveryMs ?? 60_000)
  }

  private verdict(turns: number): IdleVerdict {
    const waiting = this.state === 'installed' || this.state === 'waiting' || this.state === 'restarting'
    return judgeIdle({
      now: this.deps.now(), lastActivity: lastUserActivity(), sinceMs: this.startedAtMs, turnsRunning: turns,
      waitingSinceMs: waiting ? this.installedAtMs : null,
      idleMs: idleMsFrom(this.deps.env), maxTurnWaitMs: this.deps.maxTurnWaitMs ?? MAX_TURN_WAIT_MS,
    })
  }

  /** One look at the gate: restart when it is ready, else say the install waits. */
  async tick(): Promise<void> {
    if (this.stopped) return
    this.lastTurns = await this.deps.turnsRunning().catch(() => this.lastTurns)
    // Turned off since the install: only the person's Restart restarts it now.
    this.auto = autoUpdateEnabled(await this.deps.configAuto().catch(() => undefined), this.deps.env)
    if (this.stopped) return
    const v = this.verdict(this.lastTurns)
    let moved = false
    if (this.launcher && v.ready !== this.lastReady) moved = true
    this.lastReady = v.ready
    if ((this.state === 'installed' || this.state === 'waiting') && restartHandler) {
      if (v.ready && this.auto) { this.restartNow('idle'); return }
      if (this.state === 'installed') { this.state = 'waiting'; moved = true }
    }
    if (moved) this.changed()
  }

  /** The person's Update: install `latest` now and restart as soon as it is in. */
  installNow(caller: string | null = null): LiveAnswer {
    const status = this.deps.status()
    if (this.state === 'installed' || this.state === 'waiting') return this.restartNow('asked', caller)
    if (this.state === 'restarting') return { ok: true }
    if (!this.deps.canSelfInstall(status) || !restartHandler) {
      return { ok: false, code: 'cannot_install', fix: status.install.updateCommand }
    }
    if (this.state === 'downloading') { this.restartAsap = true; return { ok: true } }
    if (!status.available || !status.latest) return { ok: false, code: 'no_update' }
    this.deps.log('info', 'live update: install asked', { caller, version: status.latest })
    void this.install(status, status.latest, true)
    return { ok: true }
  }

  /** Restart into the installed version now (the person's Restart, or the gate). */
  restartNow(reason: 'asked' | 'idle', caller: string | null = null): LiveAnswer {
    if (this.state === 'restarting') return { ok: true }
    if ((this.state !== 'installed' && this.state !== 'waiting') || !this.version) return { ok: false, code: 'no_update' }
    const handler = restartHandler
    if (!handler) return { ok: false, code: 'no_restart' }
    this.state = 'restarting'
    this.changed()
    this.deps.log('info', `Walnut is restarting into ${this.version} (was ${this.deps.status().current})`, { reason, caller })
    this.setTimer(() => {
      void Promise.resolve().then(handler).catch((e) => {
        this.state = 'installed'
        this.error = `the restart failed: ${messageOf(e)}`
        this.deps.log('warn', 'live update: the restart failed', { error: this.error })
        this.changed()
        this.armGate()
      })
    }, this.deps.restartDelayMs ?? 2_000)
    return { ok: true }
  }

  /** What GET /api/system/update says. `freshWithinMs`: count the running turns now, waiting at most that long. */
  async snapshot(freshWithinMs?: number): Promise<LiveStatus> {
    const status = this.deps.status()
    if (freshWithinMs) {
      let timer: unknown = null
      const late = new Promise<number>((resolve) => { timer = this.setTimer(() => resolve(this.lastTurns), freshWithinMs) })
      this.lastTurns = await Promise.race([this.deps.turnsRunning().catch(() => this.lastTurns), late])
      this.clearTimer(timer)
    }
    const held = status.available && status.latest ? this.deps.held(status) : null
    const can = this.deps.canSelfInstall(status)
    const auto = autoUpdateEnabled(await this.deps.configAuto().catch(() => undefined), this.deps.env)
    // Off or idle as things stand now (the config, the install), not as at the last check.
    const state: LiveState = this.busyState() || this.state === 'failed' ? this.state : auto && can ? 'idle' : 'off'
    return {
      state,
      version: this.version,
      error: this.error,
      canInstall: can && restartHandler !== null,
      held,
      updatesAuto: auto,
      idle: this.verdict(this.lastTurns),
    }
  }
}

// ── The process's one updater ──

let current: LiveUpdater | null = null
let testDeps: Partial<LiveUpdateDeps> | null = null

/** Tests: stub parts of the next startLiveUpdate's deps (installers, the clock, the gate's cadence). */
export function setLiveUpdateDepsForTest(deps: Partial<LiveUpdateDeps> | null): void { testDeps = deps }

/** The server, after listen (with the update checker). Replaces one already running. */
export async function startLiveUpdate(onChange: () => void): Promise<LiveUpdater> {
  stopLiveUpdate()
  const { realLiveUpdateDeps } = await import('./live-update-deps.js')
  const { onSharedChecked } = await import('./update-check.js')
  const updater = new LiveUpdater({ ...realLiveUpdateDeps(onChange), ...(testDeps ?? {}) })
  current = updater
  const off = onSharedChecked((status) => { void updater.onChecked(status) })
  const stop = updater.stop.bind(updater)
  updater.stop = () => { off(); stop() }
  await updater.start()
  return updater
}

export function stopLiveUpdate(): void {
  current?.stop()
  current = null
}

export function getLiveUpdater(): LiveUpdater | null { return current }

/** The `live` block when no updater runs (an embedded server, a replica): off, nothing waits. */
export function offLiveStatus(updatesAuto: boolean): LiveStatus {
  return {
    state: 'off', version: null, error: null, canInstall: false, held: null, updatesAuto,
    idle: { ready: false, userIdleMs: null, turnsRunning: 0, waitingSince: null },
  }
}
