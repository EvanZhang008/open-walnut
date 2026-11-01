/**
 * Rhythm's one stateful object: it holds the focus run and today's log, and it is the
 * only thing that writes them.
 *
 * Every change runs through `serial`, one at a time, so a tick and an op can never
 * interleave their read-modify-write. The decisions are made by the pure module
 * (focus); this file only applies what it decides: notices, the quiet hold, shortcuts,
 * storage, and the `state` event.
 *
 * Rhythm watches nothing about the person: no keyboard time, no attention, no agent
 * turns. Only an op the person asked for starts a run (`actions.focusStart`); the
 * clock only ever moves a run toward off.
 */
import type { PluginNotifyInput, QuietState, WalnutServerApi } from '@open-walnut/plugin-api/server'
import { localDayKey, MINUTE_MS } from './clock'
import { normalizeConfig, type RhythmConfig } from './config'
import { applyDay, emptyDay, parseDay, type DayChange, type DayLog } from './day-log'
import {
  advanceFocus, desiredHold, focusOnBoot, IDLE_FOCUS, sameHold,
  type FocusDurations, type FocusEvent, type FocusState, type HoldSpec,
} from './focus'
import type { MacosBridge } from './macos-bridge'
import { DndController } from './macos-dnd'
import { SpotifyControl } from './spotify'
import { breakOverNotice, focusDoneNotice, KEY_BREAK_OVER, KEY_FOCUS_DONE, KEY_STAND_UP } from './notices'

const STATE_FILE = 'state.json'
/** A finished block or break announced this late is history, not a prompt. */
export const LATE_NOTIFY_MS = 10 * MINUTE_MS

interface StoredState {
  version: 1
  focus: FocusState
  /** The Do Not Disturb a block turned on, so a restart still knows which one is Rhythm's. */
  dnd?: unknown
}

export interface RuntimeDeps {
  walnut: WalnutServerApi
  macos: MacosBridge
  /** Absent: a control that never runs anything (tests, a host without macOS). */
  spotify?: SpotifyControl
  /** Builds the Do Not Disturb control over this runtime; absent: one that never runs anything. */
  dnd?: (runtime: RhythmRuntime) => DndController
  now?: () => number
}

export class RhythmRuntime {
  readonly walnut: WalnutServerApi
  readonly macos: MacosBridge
  readonly spotify: SpotifyControl
  readonly dnd: DndController
  readonly now: () => number
  config: RhythmConfig = normalizeConfig({})
  focus: FocusState = { ...IDLE_FOCUS }
  day: DayLog
  quietState: QuietState = { active: false, allowPermissions: true, holds: [] }
  /** A Spotify preview playing now (`active`), and the number that tells a stale timer from the current one. */
  readonly spotifyPreview: { token: number; active: boolean; timer?: ReturnType<typeof setTimeout> } = { token: 0, active: false }
  private hold: HoldSpec | null = null
  private raw: Record<string, unknown> = {}
  private dirty = false
  private dayDirty = false
  private chain: Promise<unknown> = Promise.resolve()
  private warned = new Set<string>()
  /** Rebuilt after every step; the ticker schedules the precise focus timeout from it. */
  onStepped: (now: number) => void = () => undefined
  /** Emits the public state; wired by the entry so this file stays free of the view shape. */
  onChanged: () => void = () => undefined

  constructor(deps: RuntimeDeps) {
    this.walnut = deps.walnut
    this.macos = deps.macos
    this.spotify = deps.spotify ?? new SpotifyControl({
      enabled: false, storage: deps.walnut.storage,
      run: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'not on a Mac' }),
    })
    this.now = deps.now ?? Date.now
    this.day = emptyDay(localDayKey(this.now()))
    this.dnd = deps.dnd ? deps.dnd(this) : new DndController({
      enabled: false, log: deps.walnut.log, run: async () => ({ ok: false, code: null, stdout: '', stderr: '', error: 'not on a Mac' }),
      readDetail: async () => ({ ok: false, reason: 'unreadable', message: 'not on a Mac' }),
      checkShortcuts: async () => this.macos.shortcuts, writeInput: async () => '', assumeOff: () => undefined,
      now: this.now, running: () => this.runningBlock(), onChange: () => this.dndChanged(),
    })
  }

  /** The focus block running now, for the Do Not Disturb control. */
  runningBlock(): { startedAt: number; endsAt: number } | null {
    return this.focus.phase === 'focus' && this.focus.endsAt > 0 ? { startedAt: this.focus.startedAt, endsAt: this.focus.endsAt } : null
  }

  /** The Do Not Disturb record moved (outside the queue): store it and tell the App. */
  dndChanged(): void {
    this.dirty = true
    void this.kick()
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    this.applyConfig(await this.walnut.config.get().catch(() => ({})))
    const now = this.now()
    const stored = await this.walnut.storage.readJson<Partial<StoredState>>(STATE_FILE, {})
    this.focus = focusOnBoot(stored.focus)
    this.dnd.load(stored.dnd)
    this.day = parseDay(await this.walnut.storage.readJson(this.dayFile(localDayKey(now)), null), localDayKey(now))
    // An older version kept a sitting streak and a stand-up reminder; neither exists now.
    if ('presence' in stored || 'reminder' in stored) {
      this.dirty = true
      // Its notices had buttons for ops that are gone (Start break, Snooze), and its
      // "Break over" after a stand-up break talked about a sitting count.
      await this.dismiss(KEY_STAND_UP)
      await this.dismiss(KEY_FOCUS_DONE)
      if (this.focus.phase === 'idle') await this.dismiss(KEY_BREAK_OVER)
    }
    // A hold left by an earlier activation is ours to reconcile, not to leave behind.
    const quiet = await this.readQuiet()
    const ours = quiet.holds.find((hold) => hold.source === `plugin:${this.walnut.pluginId}`)
    this.hold = ours ? { reason: ours.reason ?? '', ...(ours.until !== undefined ? { until: ours.until } : {}) } : null
  }

  applyConfig(raw: unknown): void {
    this.raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw as Record<string, unknown> } : {}
    this.config = normalizeConfig(this.raw)
  }

  /** The plugin's config as the host last handed it (keys Rhythm no longer reads included). */
  rawConfig(): Record<string, unknown> {
    return { ...this.raw }
  }

  durations(): FocusDurations {
    const c = this.config
    return { focusMinutes: c.focusMinutes, breakMinutes: c.breakMinutes, longBreakMinutes: c.longBreakMinutes, longBreakEvery: c.longBreakEvery }
  }

  /** Run `fn` after everything queued before it. A failure never poisons the queue. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Queue one step. Used by the tick, the precise timeout, quiet and config changes. */
  kick(): Promise<void> {
    return this.serial(() => this.step()).catch((error) => {
      this.walnut.log.error('Rhythm step failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }

  // ── the step ──────────────────────────────────────────────────────────────

  /** One pass: advance the run toward off, sync quiet, announce what ended. */
  async step(): Promise<void> {
    const now = this.now()
    this.rollDay(now)
    const advanced = advanceFocus(this.focus, now, this.durations())
    // Also without an event: an older version's waiting break becomes the running break.
    if (advanced.state !== this.focus) {
      this.focus = advanced.state
      this.dirty = true
    }
    // The block that turned macOS Do Not Disturb on is over (ended, stopped, or ended
    // while Walnut was down): Rhythm's own Do Not Disturb goes off, nothing else.
    const dndEnding = this.dnd.record?.status === 'on' && this.runningBlock()?.startedAt !== this.dnd.record.block
    this.dnd.reconcile()
    // Read it as off at once, so a hold the mirror kept for it does not outlive the block
    // by a poll and silence the block's own prompt below.
    if (dndEnding) this.macos.assumeDoNotDisturbOff(now)
    await this.macos.pollMirror(now, this.config.mirrorMacosFocus)
    // Release the block's quiet hold BEFORE announcing that the block ended: Walnut never
    // shows a reminder while quiet is on, so "Focus block done" would be silenced by our
    // own hold (it only lands in the feed).
    await this.syncHold()
    for (const event of advanced.events) await this.focusEvent(event, now)
    await this.readQuiet()
    await this.persist()
    this.onStepped(now)
    this.onChanged()
  }

  private async focusEvent(event: FocusEvent, now: number): Promise<void> {
    if (event.type === 'focus-completed') {
      const { block } = event
      // The block owned the Spotify it started; its break is quiet. Caught up long after
      // (the Mac slept), the music playing now is the person's own, not the block's.
      if (block.spotifyUri && event.lateMs < LATE_NOTIFY_MS) void this.spotify.pause()
      this.recordDay({ type: 'block', entry: { at: block.endedAt, minutes: block.minutes, ...(block.taskId ? { taskId: block.taskId } : {}), ...(block.title ? { title: block.title } : {}) } })
      if (block.taskId) {
        await this.walnut.tasks.appendLog(block.taskId, `Focus block: ${block.minutes} min`).catch((error: unknown) => {
          this.walnut.log.warn('Could not log the focus block on its task', { taskId: block.taskId, error: String(error) })
        })
      }
      this.recordDay({ type: 'focus-break' })
      // The break began on its own as part of the run; say so once, unless that was long ago.
      if (event.lateMs < LATE_NOTIFY_MS && event.breakEndsAt > now) {
        const minutes = Math.round((event.breakEndsAt - block.endedAt) / MINUTE_MS)
        await this.raise(focusDoneNotice(block, event.breakKind, minutes, event.breakEndsAt))
      }
    } else {
      await this.dismiss(KEY_FOCUS_DONE)
      // The one question after a break. Answered or not, Rhythm stays off.
      if (event.lateMs < LATE_NOTIFY_MS) await this.raise(breakOverNotice(this.focus))
    }
  }

  // ── effects ───────────────────────────────────────────────────────────────

  /** Dismiss-then-notify, so the feed never holds a stale copy of the same reminder. */
  async raise(notice: PluginNotifyInput): Promise<void> {
    await this.dismiss(notice.dedupKey)
    try { await this.walnut.notifications.notify(notice) }
    catch (error) { this.walnut.log.warn('Rhythm could not raise a reminder', { dedupKey: notice.dedupKey, error: String(error) }) }
  }

  async dismiss(dedupKey: string): Promise<void> {
    try { await this.walnut.notifications.dismiss(dedupKey) }
    catch (error) { this.warnOnce(`dismiss:${dedupKey}`, 'Rhythm could not dismiss a reminder', { dedupKey, error: String(error) }) }
  }

  /** Keep Walnut's one quiet hold for this plugin equal to what Rhythm wants right now. */
  async syncHold(): Promise<void> {
    const wanted = desiredHold({ focus: this.focus, focusQuietsWalnut: this.config.focusQuietsWalnut, macosFocusName: this.macos.activeFocusName() })
    if (sameHold(wanted, this.hold)) return
    const quiet = this.walnut.notifications.quiet
    try {
      if (wanted) await quiet.set(wanted.until !== undefined ? { reason: wanted.reason, until: wanted.until } : { reason: wanted.reason })
      else await quiet.clear()
      this.hold = wanted
    } catch (error) {
      this.warnOnce('quiet:set', 'Rhythm could not change quiet mode', { error: String(error) })
    }
  }

  async readQuiet(): Promise<QuietState> {
    try { this.quietState = await this.walnut.notifications.quiet.get() }
    catch (error) { this.warnOnce('quiet:get', 'Rhythm could not read quiet mode', { error: String(error) }) }
    return this.quietState
  }

  ownHold(): HoldSpec | null { return this.hold }

  recordDay(change: DayChange): void {
    const next = applyDay(this.day, change)
    if (next !== this.day) { this.day = next; this.dayDirty = true }
  }

  private rollDay(now: number): void {
    const date = localDayKey(now)
    if (date === this.day.date) return
    // The old day is flushed by persist() before the swap is visible to anything else.
    void this.persistDay(this.day)
    this.day = emptyDay(date)
    this.dayDirty = true
  }

  async persist(): Promise<void> {
    if (this.dirty) {
      this.dirty = false
      const dnd = this.dnd.toJSON()
      const state: StoredState = { version: 1, focus: this.focus, ...(dnd ? { dnd } : {}) }
      await this.walnut.storage.writeJson(STATE_FILE, state).catch((error: unknown) => {
        this.dirty = true
        this.warnOnce('persist:state', 'Rhythm could not save its state', { error: String(error) })
      })
    }
    if (this.dayDirty) {
      this.dayDirty = false
      await this.persistDay(this.day)
    }
  }

  markDirty(): void { this.dirty = true }

  private async persistDay(day: DayLog): Promise<void> {
    await this.walnut.storage.writeJson(this.dayFile(day.date), day).catch((error: unknown) => {
      this.dayDirty = true
      this.warnOnce('persist:day', 'Rhythm could not save the day log', { error: String(error) })
    })
  }

  dayFile(date: string): string { return `days/${date}.json` }

  warnOnce(key: string, message: string, data: Record<string, unknown> = {}): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.walnut.log.warn(message, data)
  }
}
