/**
 * The macOS half of Rhythm, as I/O glue around the pure parsers: the Focus mirror
 * poll, the Shortcuts status, and turning Do Not Disturb on and off.
 *
 * Nothing here runs on another platform or on a cloud replica. The mirror reads two
 * named files every 30s; a refused read backs off to every 10 minutes and is logged
 * once. Shortcut runs go through their own chain, so "on" and "off" can never cross,
 * and they run OUTSIDE the runtime's state queue: a 10 second `shortcuts run` must not
 * hold up a status read.
 */
import type { PluginLogger } from '@open-walnut/plugin-api/server'
import type { Runner } from './exec'
import type { MacosFocusRead } from './macos-focus'
import {
  SHORTCUT_OFF,
  SHORTCUT_ON,
  ensureShortcuts,
  installShortcuts,
  runShortcut,
  type InstallStep,
  type ShortcutsStatus,
} from './macos-shortcuts'

export type MirrorPhase = 'off' | 'inactive' | 'active' | 'unavailable'

export interface MirrorView {
  phase: MirrorPhase
  focusName?: string
  error?: string
  /** The read was refused by macOS privacy (Full Disk Access), not broken. */
  needsAccess?: boolean
  /** The program macOS has to allow: the one running the Walnut server. */
  processPath?: string
  checkedAt: number
}

/** Opens System Settings at Privacy & Security, Full Disk Access. */
export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

export interface ShortcutsView extends ShortcutsStatus {
  checkedAt: number
  lastRun?: { name: string; ok: boolean; at: number; error?: string }
  lastInstall?: { at: number; steps: InstallStep[] }
  /** True while Rhythm re-lists Shortcuts every few seconds after opening the Add dialogs. */
  watching?: boolean
}

const MIRROR_POLL_MS = 25_000
const MIRROR_BACKOFF_MS = 10 * 60_000
const SHORTCUTS_TTL_MS = 10 * 60_000
/**
 * After the Add Shortcut dialogs open, the person clicks Add in another app; nothing
 * tells Rhythm. So it re-lists every few seconds for a while and the App flips to
 * "installed" on its own, instead of asking for a Check again click.
 */
export const INSTALL_WATCH_MS = 3 * 60_000
export const INSTALL_POLL_MS = 3_000
/**
 * After Rhythm itself asked macOS to turn Do Not Disturb off, the mirror reads it as
 * off for this long even if the file still says on. `shortcuts run` takes seconds and
 * the next poll is up to 25s away; without this the block's own "stand up" prompt
 * would be silenced by a hold that only Rhythm was keeping alive.
 */
export const ASSUME_OFF_MS = 90_000

export interface MacosBridgeDeps {
  enabled: boolean
  log: PluginLogger
  run: Runner
  readFocus: () => Promise<MacosFocusRead>
  shortcutsDir: string
  onChange: () => void
  /** The install watch's sleep: the plugin passes one on `walnut.timers` so it stops on
   *  disposal; tests inject one that does not wait. */
  wait?: (ms: number) => Promise<void>
}

/** A sleep that never keeps the process alive on its own. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  ;(timer as { unref?: () => void }).unref?.()
})

export class MacosBridge {
  mirror: MirrorView = { phase: 'off', checkedAt: 0 }
  shortcuts: ShortcutsView = { checked: false, installed: null, missing: [], checkedAt: 0 }
  private shortcutChain: Promise<unknown> = Promise.resolve()
  private warned = new Set<string>()
  private assumeOffUntil = 0
  private watchGeneration = 0
  private watch: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly deps: MacosBridgeDeps) {}

  get available(): boolean { return this.deps.enabled }

  /** The macOS Focus name while one is on and mirroring is wanted, else null. */
  activeFocusName(): string | null {
    return this.mirror.phase === 'active' ? this.mirror.focusName ?? 'Focus' : null
  }

  /** `force` skips the poll interval and the refusal backoff (the App's Check again). */
  async pollMirror(now: number, wanted: boolean, force = false): Promise<void> {
    if (!this.deps.enabled || !wanted) {
      if (this.mirror.phase !== 'off') this.mirror = { phase: 'off', checkedAt: now }
      return
    }
    const wait = this.mirror.phase === 'unavailable' ? MIRROR_BACKOFF_MS : MIRROR_POLL_MS
    if (!force && this.mirror.phase !== 'off' && now - this.mirror.checkedAt < wait) return
    const read = await this.deps.readFocus().catch((error: unknown): MacosFocusRead => ({
      ok: false, reason: 'unreadable', message: error instanceof Error ? error.message : String(error),
    }))
    if (!read.ok) {
      this.warnOnce(`mirror:${read.reason}`, 'macOS Focus mirror cannot read the Focus state', { reason: read.reason, message: read.message })
      this.mirror = {
        phase: 'unavailable',
        error: read.message,
        ...(read.reason === 'permission' ? { needsAccess: true, processPath: process.execPath } : {}),
        checkedAt: now,
      }
      return
    }
    const active = read.focus.active && now >= this.assumeOffUntil
    this.mirror = active
      ? { phase: 'active', focusName: read.focus.name ?? 'Focus', checkedAt: now }
      : { phase: 'inactive', checkedAt: now }
  }

  /** Rhythm just told macOS to turn Do Not Disturb off: read it as off right away. */
  assumeDoNotDisturbOff(now: number): void {
    if (!this.deps.enabled) return
    this.assumeOffUntil = now + ASSUME_OFF_MS
    if (this.mirror.phase === 'active') this.mirror = { phase: 'inactive', checkedAt: now }
  }

  /** Open Full Disk Access in System Settings, for a person who clicked the App's button. */
  async openPrivacySettings(): Promise<void> {
    if (!this.deps.enabled) throw new Error('Privacy settings open on the Mac that hosts your primary Walnut.')
    const result = await this.deps.run('open', [FULL_DISK_ACCESS_URL], { timeoutMs: 10_000 })
    if (!result.ok) throw new Error(`System Settings did not open: ${result.error ?? 'unknown error'}`)
  }

  /** Read-only `shortcuts list`, cached for ten minutes unless `force`. */
  async checkShortcuts(now: number, force = false): Promise<ShortcutsView> {
    if (!this.deps.enabled) return this.shortcuts
    if (!force && this.shortcuts.checked && now - this.shortcuts.checkedAt < SHORTCUTS_TTL_MS) return this.shortcuts
    const status = await ensureShortcuts(this.deps.run)
    if (status.error) this.warnOnce('shortcuts:list', 'Could not list Shortcuts', { error: status.error })
    this.shortcuts = { ...this.shortcuts, ...status, checkedAt: now }
    if (!status.error) delete this.shortcuts.error
    return this.shortcuts
  }

  /** Turn Do Not Disturb on or off. Queued, never awaited by the caller, never throws. */
  setDoNotDisturb(on: boolean, now: () => number): void {
    if (!this.deps.enabled) return
    const name = on ? SHORTCUT_ON : SHORTCUT_OFF
    this.shortcutChain = this.shortcutChain.then(async () => {
      const result = await runShortcut(this.deps.run, name)
      if (!result.ok) this.warnOnce(`shortcuts:run:${name}`, 'A Rhythm shortcut failed to run', { name, error: result.error })
      this.shortcuts = {
        ...this.shortcuts,
        lastRun: { name, ok: result.ok, at: now(), ...(result.error ? { error: result.error } : {}) },
      }
      this.deps.onChange()
    }).catch(() => undefined)
  }

  /** Build, sign and open the missing shortcuts. Throws only for a plain-words refusal. */
  async install(now: () => number): Promise<{ steps: InstallStep[]; alreadyInstalled: boolean }> {
    if (!this.deps.enabled) throw new Error('Shortcuts install runs on the Mac that hosts your primary Walnut.')
    const status = await this.checkShortcuts(now(), true)
    if (status.installed === null) throw new Error(`Could not list your Shortcuts: ${status.error ?? 'unknown error'}`)
    if (status.missing.length === 0) return { steps: [], alreadyInstalled: true }
    const steps = await installShortcuts(this.deps.run, this.deps.shortcutsDir, status.missing)
    for (const step of steps) {
      if (!step.ok) this.warnOnce(`shortcuts:install:${step.step}`, 'A Rhythm shortcut could not be prepared', { name: step.name, step: step.step, error: step.error })
    }
    this.shortcuts = { ...this.shortcuts, lastInstall: { at: now(), steps } }
    this.deps.onChange()
    if (steps.some((step) => step.ok) && !this.disposed) this.watch = this.watchInstall(now)
    return { steps, alreadyInstalled: false }
  }

  /** Resolves when no install watch is running (tests wait on it). */
  settled(): Promise<void> { return this.watch }

  /** The plugin is going away: a running install watch stops before its next list and
   *  announces nothing more, so a disabled or reloaded Rhythm never speaks for the new one. */
  dispose(): void {
    this.disposed = true
    this.watchGeneration++
    this.shortcuts = { ...this.shortcuts, watching: false }
  }

  /**
   * Re-list Shortcuts every INSTALL_POLL_MS until both exist or INSTALL_WATCH_MS pass.
   * A second install restarts the watch; a stale loop notices and stops. Every change
   * of what is missing is announced, so the App shows each Add as it happens.
   */
  private async watchInstall(now: () => number): Promise<void> {
    const generation = ++this.watchGeneration
    const until = now() + INSTALL_WATCH_MS
    const wait = this.deps.wait ?? sleep
    this.shortcuts = { ...this.shortcuts, watching: true }
    this.deps.onChange()
    try {
      while (now() < until) {
        await wait(INSTALL_POLL_MS)
        if (generation !== this.watchGeneration) return
        const before = this.shortcuts.missing.join('|')
        const status = await this.checkShortcuts(now(), true)
        if (generation !== this.watchGeneration) return
        if (status.missing.join('|') !== before) this.deps.onChange()
        if (status.installed !== null && status.missing.length === 0) return
      }
    } finally {
      if (generation === this.watchGeneration) {
        this.shortcuts = { ...this.shortcuts, watching: false }
        this.deps.onChange()
      }
    }
  }

  private warnOnce(key: string, message: string, data: Record<string, unknown>): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.log.warn(message, data)
  }
}
