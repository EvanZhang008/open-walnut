/**
 * Rhythm's one stateful object: it holds the streak, the reminder, the focus cycle and
 * today's log, and it is the only thing that writes them.
 *
 * Every change runs through `serial`, one at a time, so a tick, an attention batch, a
 * hook and an op can never interleave their read-modify-write. The decisions are made
 * by the pure modules (presence, scheduler, focus); this file only applies what they
 * decide: notices, the quiet hold, shortcuts, storage, and the `state` event.
 */
import type { PluginNotifyInput, QuietState, WalnutServerApi } from '@open-walnut/plugin-api/server'
import { localDayKey, parseQuietHours, inQuietWindow, MINUTE_MS, type QuietWindow } from './clock'
import { normalizeConfig, type RhythmConfig } from './config'
import { applyDay, emptyDay, parseDay, type DayChange, type DayLog } from './day-log'
import {
  advanceFocus, desiredHold, focusOnBoot, IDLE_FOCUS, ownsBreak, sameHold, skipBreak,
  type FocusDurations, type FocusEvent, type FocusState, type HoldSpec,
} from './focus'
import type { MacosBridge } from './macos-bridge'
import { breakOverNotice, focusDoneNotice, KEY_BREAK_OVER, KEY_FOCUS_DONE, KEY_STAND_UP, standBreakOverNotice, standUpNotice } from './notices'
import {
  EMPTY_PRESENCE, expireIfAway, foldAttention, presenceOnBoot, restartStreak, sittingMs,
  type AttentionSpan, type PresenceState, type StreakEnded,
} from './presence'
import { EMPTY_REMINDER, evaluateReminder, pushBackReminder, reminderOnBoot, type Evaluation, type ReminderState } from './scheduler'

const STATE_FILE = 'state.json'
/** A finished block or break announced this late is history, not a prompt. */
export const LATE_NOTIFY_MS = 10 * MINUTE_MS
/** A turn with no end event after this long was interrupted; stop waiting on it. */
const MAX_TURN_MS = 60 * MINUTE_MS

interface StoredState {
  version: 1
  presence: PresenceState
  reminder: ReminderState
  focus: FocusState
}

export interface RuntimeDeps {
  walnut: WalnutServerApi
  macos: MacosBridge
  now?: () => number
}

export class RhythmRuntime {
  readonly walnut: WalnutServerApi
  readonly macos: MacosBridge
  readonly now: () => number
  config: RhythmConfig = normalizeConfig({})
  quietWindow: QuietWindow | null = null
  quietHoursValid = true
  presence: PresenceState = { ...EMPTY_PRESENCE }
  reminder: ReminderState = { ...EMPTY_REMINDER }
  focus: FocusState = { ...IDLE_FOCUS }
  day: DayLog
  quietState: QuietState = { active: false, allowPermissions: true, holds: [] }
  readonly signals = { walnut: 0, mac: 0 }
  private hold: HoldSpec | null = null
  private turns = new Map<string, number>()
  private lastTurnEndedAt = 0
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
    this.now = deps.now ?? Date.now
    this.day = emptyDay(localDayKey(this.now()))
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    this.applyConfig(await this.walnut.config.get().catch(() => ({})))
    const now = this.now()
    const stored = await this.walnut.storage.readJson<Partial<StoredState>>(STATE_FILE, {})
    this.presence = presenceOnBoot(stored.presence, now, this.awayMs)
    this.reminder = reminderOnBoot(stored.reminder)
    this.focus = focusOnBoot(stored.focus)
    this.day = parseDay(await this.walnut.storage.readJson(this.dayFile(this.day.date), null), this.day.date)
    // The streak that reminder belonged to ended while Walnut was down: withdraw it.
    if (this.reminder.outstanding && this.reminder.streakKey !== this.presence.streakStartedAt) {
      this.reminder = { ...this.reminder, outstanding: false }
      this.dirty = true
      await this.dismiss(KEY_STAND_UP)
    }
    // A hold left by an earlier activation is ours to reconcile, not to leave behind.
    const quiet = await this.readQuiet()
    const ours = quiet.holds.find((hold) => hold.source === `plugin:${this.walnut.pluginId}`)
    this.hold = ours ? { reason: ours.reason ?? '', ...(ours.until !== undefined ? { until: ours.until } : {}) } : null
  }

  applyConfig(raw: unknown): void {
    this.config = normalizeConfig(raw)
    const parsed = parseQuietHours(this.config.quietHours)
    this.quietWindow = parsed.kind === 'window' ? parsed.window : null
    this.quietHoursValid = parsed.kind !== 'invalid'
    if (parsed.kind === 'invalid') this.warnOnce(`quiet-hours:${parsed.input}`, 'quiet_hours is not HH:MM-HH:MM; quiet hours are off', { value: parsed.input })
  }

  get awayMs(): number { return this.config.awayResetMinutes * MINUTE_MS }

  durations(): FocusDurations {
    const c = this.config
    return { focusMinutes: c.focusMinutes, breakMinutes: c.breakMinutes, longBreakMinutes: c.longBreakMinutes, longBreakEvery: c.longBreakEvery, standBreakMinutes: c.standBreakMinutes }
  }

  /** Run `fn` after everything queued before it. A failure never poisons the queue. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** Queue one step. Used by the tick, the precise timeout and a turn's natural pause. */
  kick(): Promise<void> {
    return this.serial(() => this.step()).catch((error) => {
      this.walnut.log.error('Rhythm step failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }

  // ── signals ───────────────────────────────────────────────────────────────

  attention(spans: AttentionSpan[], signal: 'walnut' | 'mac'): Promise<void> {
    if (spans.length === 0) return Promise.resolve()
    this.signals[signal] = this.now()
    return this.serial(async () => {
      const folded = foldAttention(this.presence, spans, this.awayMs)
      this.presence = folded.state
      this.dirty = true
      await this.streaksEnded(folded.ended)
      await this.step()
    })
  }

  /** onTurnStart / onTurnComplete / onTurnError, told apart by the payload's fields. */
  turn(context: unknown): void {
    const value = context && typeof context === 'object' ? context as Record<string, unknown> : {}
    const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
    if (!sessionId) return
    const ended = typeof value.error === 'string' || 'result' in value
    if (!ended) { this.turns.set(sessionId, this.now()); return }
    this.turns.delete(sessionId)
    this.lastTurnEndedAt = this.now()
    // The natural pause a deferred reminder was waiting for: decide now, not at the next tick.
    if (this.reminder.deferStartedAt !== null) void this.kick()
  }

  turnsInFlight(now: number): number {
    for (const [sessionId, startedAt] of this.turns) if (now - startedAt > MAX_TURN_MS) this.turns.delete(sessionId)
    return this.turns.size
  }

  // ── the step ──────────────────────────────────────────────────────────────

  /** One pass: expire the streak, advance the block, sync quiet, decide the reminder. */
  async step(): Promise<void> {
    const now = this.now()
    this.rollDay(now)
    const expired = expireIfAway(this.presence, now, this.awayMs)
    if (expired.ended.length > 0) {
      this.presence = expired.state
      this.dirty = true
      await this.streaksEnded(expired.ended)
    }
    const advanced = advanceFocus(this.focus, now, this.durations())
    if (advanced.events.length > 0) {
      this.focus = advanced.state
      this.dirty = true
    }
    // A block that drove macOS Do Not Disturb turns it off here, and the mirror is told
    // to read it as off at once: otherwise the hold it kept alive would outlive the
    // block by a poll and silence the block's own prompt below.
    if (this.config.macosFocusShortcuts && advanced.events.some((event) => event.type === 'focus-completed')) {
      this.macos.setDoNotDisturb(false, this.now)
      this.macos.assumeDoNotDisturbOff(now)
    }
    await this.macos.pollMirror(now, this.config.mirrorMacosFocus)
    // Release the block's quiet hold BEFORE announcing that the block ended: Walnut never
    // shows a reminder while quiet is on, so "Focus block done" would be silenced by our
    // own hold (it only lands in the feed).
    await this.syncHold()
    for (const event of advanced.events) await this.focusEvent(event, now)
    await this.readQuiet()
    const evaluation = this.evaluate(now)
    if (JSON.stringify(evaluation.state) !== JSON.stringify(this.reminder)) {
      this.reminder = evaluation.state
      this.dirty = true
    }
    if (evaluation.fire) await this.fireStandUp(evaluation.view.sittingMs)
    this.recordDay({ type: 'streak', ms: sittingMs(this.presence, now, this.awayMs) })
    await this.persist()
    this.onStepped(now)
    this.onChanged()
  }

  /** The scheduler's answer for `now`, WITHOUT committing it (status reads use this too). */
  evaluate(now: number): Evaluation {
    return evaluateReminder(this.reminder, {
      now,
      presence: this.presence,
      intervalMs: this.config.reminderEveryMinutes * MINUTE_MS,
      awayMs: this.awayMs,
      deferCapMs: this.config.deferForNaturalPauseMinutes * MINUTE_MS,
      focusActive: ownsBreak(this.focus),
      inQuietHours: inQuietWindow(this.quietWindow, now),
      quietActive: this.quietState.active,
      turnsInFlight: this.turnsInFlight(now),
      lastTurnEndedAt: this.lastTurnEndedAt,
    })
  }

  inQuietHours(now: number): boolean { return inQuietWindow(this.quietWindow, now) }

  /** Walking away answers whatever was waiting: an unanswered reminder, a finished block. */
  async streaksEnded(ended: StreakEnded[]): Promise<void> {
    if (ended.length === 0) return
    for (const one of ended) this.recordDay({ type: 'streak', ms: one.streakMs })
    if (this.reminder.outstanding) {
      this.reminder = { ...this.reminder, outstanding: false }
      this.recordDay({ type: 'moved-without-click' })
      await this.dismiss(KEY_STAND_UP)
    }
    if (this.focus.phase === 'break_due') {
      this.focus = skipBreak(this.focus, this.now())
      this.recordDay({ type: 'focus-break' })
      await this.dismiss(KEY_FOCUS_DONE)
    }
  }

  private async focusEvent(event: FocusEvent, now: number): Promise<void> {
    if (event.type === 'focus-completed') {
      const { block } = event
      this.recordDay({ type: 'block', entry: { at: block.endedAt, minutes: block.minutes, ...(block.taskId ? { taskId: block.taskId } : {}), ...(block.title ? { title: block.title } : {}) } })
      if (block.taskId) {
        await this.walnut.tasks.appendLog(block.taskId, `Focus block: ${block.minutes} min`).catch((error: unknown) => {
          this.walnut.log.warn('Could not log the focus block on its task', { taskId: block.taskId, error: String(error) })
        })
      }
      // The block's own prompt tells them to stand; the stand-up reminder starts over.
      this.reminder = pushBackReminder(this.reminder, now, this.config.reminderEveryMinutes * MINUTE_MS)
      if (event.lateMs < LATE_NOTIFY_MS) {
        const minutes = event.breakKind === 'long' ? this.config.longBreakMinutes : this.config.breakMinutes
        await this.raise(focusDoneNotice(block, event.breakKind, minutes))
      }
    } else if (event.type === 'break-ended') {
      // Nobody sat through the break: the sitting count starts when it ends, not when it began.
      this.presence = restartStreak(this.presence, now - event.lateMs)
      await this.dismiss(KEY_FOCUS_DONE)
      if (event.lateMs < LATE_NOTIFY_MS) {
        await this.raise(event.breakKind === 'stand' ? standBreakOverNotice() : breakOverNotice(this.focus))
      }
    } else {
      await this.dismiss(KEY_FOCUS_DONE)
    }
  }

  private async fireStandUp(sitting: number): Promise<void> {
    this.recordDay({ type: 'reminder-fired' })
    await this.raise(standUpNotice(sitting, this.config.snoozeMinutes, this.config.standBreakMinutes))
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
      const state: StoredState = { version: 1, presence: this.presence, reminder: this.reminder, focus: this.focus }
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
