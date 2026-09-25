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
  checkedAt: number
}

export interface ShortcutsView extends ShortcutsStatus {
  checkedAt: number
  lastRun?: { name: string; ok: boolean; at: number; error?: string }
  lastInstall?: { at: number; steps: InstallStep[] }
}

const MIRROR_POLL_MS = 25_000
const MIRROR_BACKOFF_MS = 10 * 60_000
const SHORTCUTS_TTL_MS = 10 * 60_000
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
}

export class MacosBridge {
  mirror: MirrorView = { phase: 'off', checkedAt: 0 }
  shortcuts: ShortcutsView = { checked: false, installed: null, missing: [], checkedAt: 0 }
  private shortcutChain: Promise<unknown> = Promise.resolve()
  private warned = new Set<string>()
  private assumeOffUntil = 0

  constructor(private readonly deps: MacosBridgeDeps) {}

  get available(): boolean { return this.deps.enabled }

  /** The macOS Focus name while one is on and mirroring is wanted, else null. */
  activeFocusName(): string | null {
    return this.mirror.phase === 'active' ? this.mirror.focusName ?? 'Focus' : null
  }

  async pollMirror(now: number, wanted: boolean): Promise<void> {
    if (!this.deps.enabled || !wanted) {
      if (this.mirror.phase !== 'off') this.mirror = { phase: 'off', checkedAt: now }
      return
    }
    const wait = this.mirror.phase === 'unavailable' ? MIRROR_BACKOFF_MS : MIRROR_POLL_MS
    if (this.mirror.phase !== 'off' && now - this.mirror.checkedAt < wait) return
    const read = await this.deps.readFocus().catch((error: unknown): MacosFocusRead => ({
      ok: false, reason: 'unreadable', message: error instanceof Error ? error.message : String(error),
    }))
    if (!read.ok) {
      this.warnOnce(`mirror:${read.reason}`, 'macOS Focus mirror cannot read the Focus state', { reason: read.reason, message: read.message })
      this.mirror = { phase: 'unavailable', error: read.message, checkedAt: now }
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
    return { steps, alreadyInstalled: false }
  }

  private warnOnce(key: string, message: string, data: Record<string, unknown>): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.deps.log.warn(message, data)
  }
}
