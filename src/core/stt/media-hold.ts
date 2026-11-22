/**
 * Pause the music while the person dictates, and play it again when they stop.
 *
 * Every voice input on this machine (the mic button and the quick bar in a window, the Mac
 * app's dictation hotkey, the server's own dictation recorder) holds a MEDIA HOLD while its
 * microphone is open. The first hold pauses the Mac's Now Playing app (media-control.ts);
 * when the last hold ends, Walnut plays again exactly the app it paused, and only while it
 * is still paused: one that was not playing is never started, and one the person played
 * again meanwhile (or replaced by another) is left alone. `stt:media-hold` tells the
 * windows, so Walnut's own focus music (Rhythm) pauses and resumes in the page that plays it.
 *
 * A hold lives for HOLD_TTL_MS unless its owner renews it, so a window that crashed or a
 * hotkey app that quit never keeps the music off for long, and no hold outlives
 * HOLD_MAX_MS. What Walnut paused is kept in <WALNUT_HOME>/local/ (machine-local), so a
 * server that restarts mid-dictation still plays it again: the holds read back get one
 * TTL to be renewed, then the music comes back.
 *
 * On by default; `stt.pause_media: false` turns it off (Settings, Voice). Every call to
 * the player runs in one queue, so a pause still on its way never lands after the resume.
 */
import path from 'node:path'
import { mkdir, rm } from 'node:fs/promises'
import { WALNUT_HOME } from '../../constants.js'
import { readJsonFile, writeJsonFile } from '../../utils/fs.js'
import { log } from '../../logging/index.js'
import type { MediaController, PausedPlayer } from './media-control.js'

/** A hold not renewed for this long ends; owners renew every MEDIA_HOLD_RENEW_MS. */
export const HOLD_TTL_MS = 90_000
export const MEDIA_HOLD_RENEW_MS = 15_000
/** No dictation keeps the music off longer than this. */
export const HOLD_MAX_MS = 30 * 60_000
/** A pause read back after a longer outage is dropped: music starting hours later surprises. */
export const RESTORE_MAX_AGE_MS = 30 * 60_000
/** How often a renew may look whether the person played the paused app again. */
const TAKEOVER_CHECK_MS = 4_000
const MAX_HOLDS = 20
const HOLD_ID = /^[A-Za-z0-9_-]{6,80}$/

export interface MediaHoldView {
  /** The setting (stt.pause_media) is on. */
  enabled: boolean
  /** A hold is live: the music is off for voice input. */
  active: boolean
  /** The apps Walnut paused and will play again. */
  paused: string[]
  /** Why this hold did nothing to the system's music, when it did not. */
  note?: string
}

interface Hold { source: string; startedAt: number; expiresAt: number }

interface SavedState {
  version: 1
  savedAt: number
  paused: PausedPlayer[]
  holds: Array<{ id: string; source: string; startedAt: number }>
}

export interface MediaHoldDeps {
  /** The system's player, or null where Walnut may not touch it (off the Mac, an isolated server). */
  controller: () => MediaController | null
  enabled: () => Promise<boolean>
  /** Told when the music goes off for voice input (true) and when it may play again (false). */
  emit?: (active: boolean) => void
  /** Where what Walnut paused is kept across a restart; null keeps nothing. */
  file?: string | null
  now?: () => number
}

export function isMediaHoldId(id: unknown): id is string {
  return typeof id === 'string' && HOLD_ID.test(id)
}

export class MediaHold {
  private readonly holds = new Map<string, Hold>()
  /**
   * Every voice input that holds or renews, with when its hold would end, kept
   * even where the music is not touched (stt.pause_media off): `listening()`
   * tells the background voice work (Voice Accuracy) that a microphone is open.
   */
  private readonly heard = new Map<string, number>()
  /** Ids released lately: a renew that was on its way when its release landed starts nothing. */
  private readonly ended = new Map<string, number>()
  /** Call order, so a release that lands while a hold call still waits is seen by it. */
  private callSeq = 0
  private readonly endedSeq = new Map<string, number>()
  private paused: PausedPlayer[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private writes: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastTakeoverCheck = 0
  private published = false
  private readonly now: () => number

  constructor(private readonly deps: MediaHoldDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Start a hold, or renew it (the same id again). */
  async hold(id: string, source: string, ttlMs = HOLD_TTL_MS): Promise<MediaHoldView> {
    if (!isMediaHoldId(id)) throw new Error('A media hold id is 6 to 80 letters, digits, - or _.')
    const asked = this.callSeq++
    if (this.sweep()) await this.afterChange()
    const known = this.holds.get(id)
    const endedAt = this.ended.get(id)
    if (!known && endedAt !== undefined && this.now() - endedAt < HOLD_MAX_MS) return this.view(await this.deps.enabled())
    this.heard.set(id, this.now() + ttlMs)
    if (!known && !(await this.deps.enabled())) return this.view(false)
    // Its release landed while this call waited above: the hold is over before it began.
    if ((this.endedSeq.get(id) ?? -1) > asked) return this.view(true)
    const now = this.now()
    const startedAt = known?.startedAt ?? now
    if (!known && this.holds.size >= MAX_HOLDS) throw new Error('Too many voice inputs hold the music at once.')
    this.holds.set(id, { source: source.slice(0, 40), startedAt, expiresAt: Math.min(now + ttlMs, startedAt + HOLD_MAX_MS) })
    this.arm()
    this.publish()
    let note: string | undefined
    if (!known) note = await this.inOrder(() => this.pausePass())
    else if (now - this.lastTakeoverCheck >= TAKEOVER_CHECK_MS) {
      this.lastTakeoverCheck = now
      await this.inOrder(() => this.takeoverPass())
    }
    this.save()
    return this.view(true, note)
  }

  /** End a hold. The last one plays again what Walnut paused. Unknown ids are fine (a late end). */
  async release(id: string): Promise<MediaHoldView> {
    this.heard.delete(id)
    const had = this.holds.delete(id)
    this.markEnded(id)
    if (had) await this.afterChange()
    return this.view(await this.deps.enabled())
  }

  /** A voice input on this machine has its microphone open now (a hold live, whether or not it paused the music). */
  listening(): boolean {
    const now = this.now()
    for (const [id, until] of this.heard) if (until <= now) this.heard.delete(id)
    return this.heard.size > 0 || this.holds.size > 0
  }

  async status(): Promise<MediaHoldView> {
    if (this.sweep()) await this.afterChange()
    return this.view(await this.deps.enabled())
  }

  /** At boot: what an earlier run paused gets one TTL for its owners to renew, then plays again. */
  async restore(): Promise<void> {
    const file = this.deps.file
    if (!file) return
    const saved = await readJsonFile<Partial<SavedState> | null>(file, null)
    if (!saved || !Array.isArray(saved.paused) || saved.paused.length === 0) return
    const now = this.now()
    if (typeof saved.savedAt !== 'number' || now - saved.savedAt > RESTORE_MAX_AGE_MS) {
      log.stt.info('media hold: dropped a pause from an old run', { savedAt: saved.savedAt ?? null })
      await rm(file, { force: true }).catch(() => {})
      return
    }
    this.paused = saved.paused.filter((p) => p && typeof p.bundle === 'string' && typeof p.pid === 'number')
    const holds = Array.isArray(saved.holds) ? saved.holds.filter((h) => isMediaHoldId(h?.id)) : []
    for (const h of holds.slice(0, MAX_HOLDS)) {
      const startedAt = typeof h.startedAt === 'number' ? h.startedAt : now
      this.holds.set(h.id, { source: String(h.source ?? 'restored'), startedAt, expiresAt: Math.min(now + HOLD_TTL_MS, startedAt + HOLD_MAX_MS) })
    }
    log.stt.info('media hold: read back a pause from the last run', { paused: this.paused.map((p) => p.name), holds: this.holds.size })
    if (this.holds.size === 0) { await this.afterChange(); return }
    this.arm()
    this.publish()
  }

  /** Stop the timer (tests, shutdown). Nothing is resumed. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Resolves once every queued player call and file write has landed (tests). */
  async idle(): Promise<void> {
    await this.queue
    await this.writes
  }

  private view(enabled: boolean, note?: string): MediaHoldView {
    return { enabled, active: this.holds.size > 0, paused: this.paused.map((p) => p.name || p.bundle), ...(note ? { note } : {}) }
  }

  private inOrder<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async pausePass(): Promise<string | undefined> {
    const controller = this.deps.controller()
    if (!controller) return 'Walnut does not control the music on this machine.'
    if (this.holds.size === 0) return undefined
    const result = await controller.pauseNowPlaying()
    if (result.error) log.stt.warn('media hold: pause failed', { error: result.error })
    const player = result.paused
    if (!player) return result.error
    const known = this.paused.some((p) => p.bundle === player.bundle && p.pid === player.pid)
    if (!known) this.paused.push({ ...player, pausedAt: this.now() })
    log.stt.info('media hold: paused', { player: player.name || player.bundle })
    // The last hold may have ended while the pause was on its way.
    if (this.holds.size === 0) await this.resumePass()
    return undefined
  }

  /** A paused app that plays again is the person's: it is no longer Walnut's to resume. */
  private async takeoverPass(): Promise<void> {
    const controller = this.deps.controller()
    if (!controller || this.paused.length === 0) return
    const now = await controller.read()
    if (!now?.playing) return
    const before = this.paused.length
    this.paused = this.paused.filter((p) => !(p.bundle === now.bundle && p.pid === now.pid))
    if (this.paused.length !== before) log.stt.info('media hold: the person played it again; leaving it', { player: now.name || now.bundle })
  }

  private async resumePass(): Promise<void> {
    if (this.holds.size > 0 || this.paused.length === 0) return
    const controller = this.deps.controller()
    const list = this.paused
    this.paused = []
    if (!controller) return
    for (const player of list.reverse()) {
      const result = await controller.resume(player)
      log.stt.info(result.resumed ? 'media hold: played again' : 'media hold: left as it is', {
        player: player.name || player.bundle,
        ...(result.reason ? { reason: result.reason } : {}),
      })
    }
  }

  private async afterChange(): Promise<void> {
    this.arm()
    this.publish()
    if (this.holds.size === 0) await this.inOrder(() => this.resumePass())
    this.save()
  }

  private markEnded(id: string): void {
    this.ended.delete(id)
    this.ended.set(id, this.now())
    this.endedSeq.set(id, this.callSeq++)
    if (this.ended.size > 200) {
      const oldest = this.ended.keys().next().value as string
      this.ended.delete(oldest)
      this.endedSeq.delete(oldest)
    }
  }

  private sweep(): boolean {
    const now = this.now()
    let removed = false
    for (const [id, h] of this.holds) {
      if (h.expiresAt <= now) {
        this.holds.delete(id)
        // One that reached the cap stays ended: a window stuck renewing cannot start it again.
        if (h.startedAt + HOLD_MAX_MS <= now) this.markEnded(id)
        removed = true
        log.stt.info('media hold: a voice input stopped renewing; its hold ended', { source: h.source })
      }
    }
    return removed
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let next = Infinity
    for (const h of this.holds.values()) next = Math.min(next, h.expiresAt)
    if (next === Infinity) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.sweep()) void this.afterChange()
      else this.arm()
    }, Math.max(0, next - this.now()) + 50)
    this.timer.unref?.()
  }

  private publish(): void {
    const active = this.holds.size > 0
    if (active === this.published) return
    this.published = active
    try { this.deps.emit?.(active) } catch { /* a listener's failure is not the hold's */ }
  }

  private save(): void {
    const file = this.deps.file
    if (!file) return
    const state: SavedState = {
      version: 1,
      savedAt: this.now(),
      paused: this.paused,
      holds: [...this.holds].map(([id, h]) => ({ id, source: h.source, startedAt: h.startedAt })),
    }
    const empty = state.paused.length === 0
    this.writes = this.writes
      .then(() => (empty ? rm(file, { force: true }) : mkdir(path.dirname(file), { recursive: true }).then(() => writeJsonFile(file, state))))
      .catch((error: unknown) => log.stt.warn('media hold: could not save its state', { error: error instanceof Error ? error.message : String(error) }))
  }
}

export function mediaHoldFile(): string {
  return path.join(WALNUT_HOME, 'local', 'stt-media-hold.json')
}
