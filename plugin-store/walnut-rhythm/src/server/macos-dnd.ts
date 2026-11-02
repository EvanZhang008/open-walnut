/**
 * A focus block turns macOS Do Not Disturb on for its length, and only Do Not Disturb
 * Rhythm turned on is ever turned off.
 *
 *   Start ──▶ a Focus already on?  yes ──▶ left-alone (the person's own Focus stays)
 *               │ no
 *               ▼
 *   run "Walnut Do Not Disturb Until Block Ends" with the block's end ──▶ read macOS again
 *               │ a new Do Not Disturb is live                 │ none
 *               ▼                                              ▼
 *              on (its assertion id kept)                    failed (said plainly)
 *
 *   The block ends or stops, on any path ──▶ our assertion still live? ──▶ "Walnut Focus Off"
 *
 * Ownership is the assertion id macOS gave the Do Not Disturb Rhythm started: a Focus
 * the person turns on, or a Do Not Disturb they turn off and on again, has another id
 * and is never touched. macOS holds the end time itself, so the Mac goes back to normal
 * on time even when Walnut is not running then; when Walnut is, it also ends ours at
 * the very moment a block stops early. Rhythm refuses to turn anything on when it
 * cannot see whether a Focus is already on (macOS keeps that behind Full Disk Access),
 * because it could replace the person's own.
 *
 * The record is persisted with the run (`toJSON`/`load`), so a restart mid-block still
 * knows which Do Not Disturb is Rhythm's. Every macOS step runs on one chain, so an on
 * and an off never cross, and outside the runtime's state queue: `shortcuts run` takes
 * seconds. The runtime decides WHEN (`reconcile`); this file only does it.
 */
import type { PluginLogger } from '@open-walnut/plugin-api/server'
import type { FocusDetailRead, LiveAssertion } from './macos-focus'
import type { ShortcutsView } from './macos-bridge'
import { NO_END } from './dnd-words'
import { SHORTCUT_OFF, SHORTCUT_ON, runShortcut } from './macos-shortcuts'
import type { Runner } from './exec'

export const DND_MODE_ID = 'com.apple.donotdisturb.mode.default'

export type DndStatus = 'turning-on' | 'on' | 'left-alone' | 'failed' | 'turning-off' | 'off'

export interface DndRecord {
  /** The block this belongs to (its `startedAt`). */
  block: number
  /** The block's end: when macOS ends it by itself. */
  until: number
  status: DndStatus
  /** The macOS assertion Rhythm started. Only this one is ever turned off. */
  assertionId?: string
  /** When the shortcut ran; a restart while turning on finds the assertion by it. */
  ranAt?: number
  /** left-alone: the person's own Focus, by name. */
  focusName?: string
  /** failed: why, in words the person reads; on: why macOS kept its first end time. */
  error?: string
  /** The shortcut set no end time (or another one): macOS will not end it by itself. */
  noEnd?: boolean
  /** The "on" shortcut that ran, by name: a noEnd found on an older one says nothing of today's. */
  shortcut?: string
  /** failed while turning off: Rhythm's Do Not Disturb may still be on, and Rhythm tries again. */
  stillOn?: boolean
  /** How many times turning off failed for this record. */
  offTries?: number
  /** The block end a move to failed for, so it is not retried every step. */
  moveTried?: number
  at: number
}

export interface DndDeps {
  enabled: boolean
  log: PluginLogger
  run: Runner
  readDetail: () => Promise<FocusDetailRead>
  /** Which of the shortcuts exist (cached by the bridge). */
  checkShortcuts: (now: number) => Promise<ShortcutsView>
  /** Write the shortcut's input (the end time) and answer its path. */
  writeInput: (text: string) => Promise<string>
  /** Tell the mirror that Rhythm just turned Do Not Disturb off. */
  assumeOff: (now: number) => void
  now: () => number
  /** The focus block running now, if any. */
  running: () => { startedAt: number; endsAt: number } | null
  onChange: () => void
  wait?: (ms: number) => Promise<void>
}

/** Read macOS this many times, this far apart, for the change a shortcut just made. */
export const VERIFY_TRIES = 6
export const VERIFY_GAP_MS = 500
/** An assertion that started this long before the shortcut ran is not the shortcut's. */
const START_SLACK_MS = 5_000
/** Turning off is tried this many times, this far apart, before Rhythm only says so. */
export const OFF_TRIES = 3
const OFF_RETRY_MS = 20_000
/** A block end this much later than macOS's end time moves it (Extend). */
const MOVE_SLACK_MS = 30_000
/** macOS's end time this close to the one asked for is the one asked for. */
const END_SLACK_MS = 60_000
/** Too close to the block's end to be worth turning on. */
const MIN_LEFT_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms)
  ;(timer as { unref?: () => void }).unref?.()
})

/**
 * The shortcut's input: the block's end as local wall-clock time, "2026-11-01 12:58:00",
 * which Shortcuts' Get Dates from Input reads in every locale. PURE.
 */
export function untilInput(until: number): string {
  const d = new Date(until)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** The Do Not Disturb a shortcut run at `ranAt` started, if macOS shows one. PURE. */
export function findStarted(live: LiveAssertion[], ranAt: number): LiveAssertion | undefined {
  return live.filter((one) => one.modeId === DND_MODE_ID && one.startedAt >= ranAt - START_SLACK_MS).pop()
}

/** Words for a read macOS refused, when it decides whether anything may be turned on. */
const CANNOT_SEE = 'Rhythm cannot see whether a Focus is already on, because macOS keeps that private. Give Walnut Full Disk Access (Rhythm, macOS), then turn Do Not Disturb on again.'

export class DndController {
  record: DndRecord | null = null
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: DndDeps) {}

  get available(): boolean { return this.deps.enabled }

  /** A stored record, as the last run left it. Anything malformed is dropped. */
  load(raw: unknown): void {
    if (!raw || typeof raw !== 'object') { this.record = null; return }
    const r = raw as Partial<DndRecord>
    const statuses: DndStatus[] = ['turning-on', 'on', 'left-alone', 'failed', 'turning-off', 'off']
    if (typeof r.block !== 'number' || typeof r.until !== 'number' || !statuses.includes(r.status as DndStatus)) { this.record = null; return }
    this.record = {
      block: r.block, until: r.until, status: r.status as DndStatus, at: typeof r.at === 'number' ? r.at : 0,
      ...(typeof r.assertionId === 'string' && r.assertionId ? { assertionId: r.assertionId } : {}),
      ...(typeof r.ranAt === 'number' ? { ranAt: r.ranAt } : {}),
      ...(typeof r.focusName === 'string' ? { focusName: r.focusName } : {}),
      ...(typeof r.error === 'string' ? { error: r.error } : {}),
      ...(typeof r.moveTried === 'number' ? { moveTried: r.moveTried } : {}),
      ...(r.noEnd === true ? { noEnd: true } : {}),
      ...(typeof r.shortcut === 'string' ? { shortcut: r.shortcut } : {}),
      ...(r.stillOn === true ? { stillOn: true } : {}),
      ...(typeof r.offTries === 'number' ? { offTries: r.offTries } : {}),
    }
  }

  toJSON(): DndRecord | null { return this.record }

  /** Resolves when every queued macOS step has run (tests and the op answers wait on it). */
  settled(): Promise<void> { return this.chain.then(() => undefined, () => undefined) }

  /** Turn Do Not Disturb on until `block.endsAt`. Queued; never throws. */
  turnOn(block: { startedAt: number; endsAt: number }): Promise<void> {
    if (!this.deps.enabled) return Promise.resolve()
    return this.enqueue(() => this.doOn(block))
  }

  /**
   * Turn Rhythm's Do Not Disturb off (if it is still Rhythm's). Queued; never throws.
   * `forBlock`: only that block's, so an off queued for an ended block never ends the
   * Do Not Disturb a newer block turned on in the meantime.
   */
  turnOff(forBlock?: number): Promise<void> {
    if (!this.deps.enabled) return Promise.resolve()
    return this.enqueue(() => this.doOff(forBlock))
  }

  /**
   * Bring macOS in line with the run, after a step: the block that owns our Do Not
   * Disturb is over (ended, stopped, or ended while Walnut was down) means off; a
   * restart in the middle of turning on or off finishes that.
   */
  reconcile(): void {
    const r = this.record
    // A step already queued or running calls this again when it ends.
    if (!r || !this.deps.enabled || this.busy) return
    const running = this.deps.running()
    const current = running !== null && running.startedAt === r.block
    // Off: the block is over, a restart interrupted an off, or an off failed and is tried again.
    if ((r.status === 'on' && !current) || r.status === 'turning-off' || (this.retryOff(r) && !current)) void this.turnOff(r.block)
    else if (r.status === 'turning-on') void this.enqueue(() => this.resumeOn())
    // The block was extended: macOS's end time moves with it (a copy with no end time is turned off at the end instead).
    else if (r.status === 'on' && current && !r.noEnd && running.endsAt - r.until > MOVE_SLACK_MS && r.moveTried !== running.endsAt) void this.enqueue(() => this.doMove())
  }

  private retryOff(r: DndRecord): boolean {
    return r.status === 'failed' && r.stillOn === true && (r.offTries ?? 0) < OFF_TRIES && this.deps.now() - r.at >= OFF_RETRY_MS
  }

  /** What macOS shows live now: an assertion past its end that macOS has not cleared yet is over. */
  private liveNow(live: LiveAssertion[]): LiveAssertion[] {
    const now = this.deps.now()
    return live.filter((one) => one.endsAt === undefined || one.endsAt > now)
  }

  private busy = false

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => {
      this.busy = true
      try { await fn() } finally { this.busy = false }
      // The run may have moved while macOS was busy (a Stop while turning on).
      this.reconcile()
    })
    this.chain = run.catch((error: unknown) => {
      this.deps.log.warn('Rhythm could not change Do Not Disturb', { error: error instanceof Error ? error.message : String(error) })
    })
    return this.chain.then(() => undefined)
  }

  private set(next: DndRecord | null): void {
    this.record = next
    this.deps.onChange()
  }

  private fail(block: { startedAt: number; endsAt: number }, error: string): void {
    this.deps.log.warn('Do Not Disturb did not turn on', { error })
    this.set({ block: block.startedAt, until: block.endsAt, status: 'failed', error, at: this.deps.now() })
  }

  private async doOn(asked: { startedAt: number; endsAt: number }): Promise<void> {
    let r = this.record
    if (r && r.block === asked.startedAt && r.status === 'on') return
    // The last block's Do Not Disturb is still Rhythm's (a Stop then Focus now while macOS
    // was busy): end it first, or the new block would take it for the person's own.
    if (r && r.block !== asked.startedAt && (r.status === 'on' || r.status === 'turning-off' || (r.status === 'failed' && r.stillOn))) {
      await this.doOff()
      r = this.record
      if (r?.stillOn) return this.fail(asked, `Rhythm's Do Not Disturb from the last block is still on. ${r.error ?? ''}`.trim())
    }
    const now = this.deps.now()
    const running = this.deps.running()
    // Stopped or ended before its turn came; extended since it was asked for: its end now.
    if (running?.startedAt !== asked.startedAt || running.endsAt - now < MIN_LEFT_MS) return
    const block = running
    this.set({ block: block.startedAt, until: block.endsAt, status: 'turning-on', at: now })
    const read = await this.deps.readDetail().catch((error: unknown): FocusDetailRead => ({ ok: false, reason: 'unreadable', message: String(error) }))
    if (!read.ok) return this.fail(block, read.reason === 'permission' ? CANNOT_SEE : `Rhythm could not read the Mac's Focus state: ${read.message}`)
    if (this.liveNow(read.live).length > 0) {
      // The person's own Focus (or a Do Not Disturb they turned on) stays exactly as it is.
      this.set({ block: block.startedAt, until: block.endsAt, status: 'left-alone', focusName: read.focus.name ?? 'A Focus', at: this.deps.now() })
      return
    }
    const shortcuts = await this.deps.checkShortcuts(this.deps.now())
    if (shortcuts.installed === null) return this.fail(block, `Rhythm could not list your Shortcuts: ${shortcuts.error ?? 'unknown error'}`)
    if (!shortcuts.installed.on || !shortcuts.installed.off) {
      return this.fail(block, 'The Do Not Disturb shortcuts are not added yet. Open Rhythm and click Add shortcuts (one time).')
    }
    // Extended while macOS was read: the end as it is now (a later Extend moves it, doMove).
    const until = this.deps.running()?.startedAt === block.startedAt ? this.deps.running()!.endsAt : block.endsAt
    let input: string
    try { input = await this.deps.writeInput(untilInput(until)) } catch (error) {
      return this.fail(block, `Rhythm could not prepare the shortcut: ${String((error as Error).message ?? error)}`)
    }
    const ranAt = this.deps.now()
    this.set({ ...this.record!, until, ranAt })
    const ran = await runShortcut(this.deps.run, SHORTCUT_ON, input)
    if (!ran.ok) return this.fail(block, `The shortcut did not run: ${ran.error ?? 'unknown error'}`)
    const ours = await this.waitFor((live) => findStarted(live, ranAt) ?? null)
    if (!ours) return this.fail(block, 'The shortcut ran, but macOS did not turn Do Not Disturb on.')
    this.deps.log.info('Do Not Disturb is on for the focus block', { until, macosEndsAt: ours.endsAt ?? null })
    // A shortcut of the same name that sets no end time (an older or edited copy): it still
    // goes off at the block's end while Walnut runs, but not if Walnut is down then.
    const noEnd = ours.endsAt === undefined || Math.abs(ours.endsAt - until) > END_SLACK_MS
    this.set({
      block: block.startedAt, until, status: 'on', assertionId: ours.id, ranAt, at: this.deps.now(), shortcut: SHORTCUT_ON,
      ...(noEnd ? { noEnd: true, error: NO_END } : {}),
    })
  }

  /**
   * The block runs longer now (Extend): run the shortcut again with the new end. macOS
   * either replaces Rhythm's Do Not Disturb or moves its end; both count as Rhythm's.
   */
  private async doMove(): Promise<void> {
    const r = this.record
    const running = this.deps.running()
    if (!r || r.status !== 'on' || !running || running.startedAt !== r.block || running.endsAt - r.until <= MOVE_SLACK_MS || r.moveTried === running.endsAt) return
    const until = running.endsAt
    const was = new Date(r.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const stuck = (why: string) => {
      this.deps.log.warn('Do Not Disturb kept its old end time', { why })
      // Still Rhythm's: it ends at the old time by itself, or at the block's end.
      this.set({ ...r, moveTried: until, error: `Do Not Disturb still ends at ${was}, the block's first end: ${why}`, at: this.deps.now() })
    }
    let input: string
    try { input = await this.deps.writeInput(untilInput(until)) } catch (error) {
      return stuck(String((error as Error).message ?? error))
    }
    const ranAt = this.deps.now()
    const ran = await runShortcut(this.deps.run, SHORTCUT_ON, input)
    if (!ran.ok) return stuck(`the shortcut did not run (${ran.error ?? 'unknown error'}).`)
    const moved = await this.waitFor((live) => live.filter((one) => one.modeId === DND_MODE_ID
      && (one.id === r.assertionId || one.startedAt >= ranAt - START_SLACK_MS)
      && one.endsAt !== undefined && Math.abs(one.endsAt - until) <= END_SLACK_MS).pop() ?? null)
    if (!moved) return stuck('macOS did not take the new end time.')
    const { error: _old, moveTried: _tried, ...rest } = r
    this.set({ ...rest, until, assertionId: moved.id, ranAt, at: this.deps.now() })
  }

  /** Walnut stopped while the shortcut was running: find what it did. */
  private async resumeOn(): Promise<void> {
    const r = this.record
    if (!r || r.status !== 'turning-on') return
    const read = await this.deps.readDetail().catch(() => null)
    const ours = read?.ok && r.ranAt !== undefined ? findStarted(this.liveNow(read.live), r.ranAt) : undefined
    if (ours) this.set({ ...r, status: 'on', assertionId: ours.id, at: this.deps.now() })
    else this.set({ ...r, status: 'failed', error: 'Walnut restarted while turning Do Not Disturb on, and macOS shows none of Rhythm\'s.', at: this.deps.now() })
  }

  private async doOff(forBlock?: number): Promise<void> {
    const r = this.record
    if (!r || (forBlock !== undefined && r.block !== forBlock)) return
    const ours = r.status === 'on' || r.status === 'turning-off' || (r.status === 'failed' && r.stillOn === true)
    if (!ours) {
      // Nothing of Rhythm's is on. A failure to turn on stays said; anything else is off now.
      if (r.status !== 'off' && r.status !== 'failed') this.set({ ...r, status: 'off', at: this.deps.now() })
      return
    }
    this.set({ ...r, status: 'turning-off', at: this.deps.now() })
    const read = await this.deps.readDetail().catch(() => null)
    const gone = (live: LiveAssertion[]) => !this.liveNow(live).some((one) => one.id === r.assertionId)
    // Ours is gone already (macOS ended it on time, or the person turned it off): nothing to do.
    if (read?.ok && gone(read.live)) return this.offDone(r)
    // Ours is live, or macOS no longer lets Rhythm look: it turned this one on, so it ends it.
    const ran = await runShortcut(this.deps.run, SHORTCUT_OFF)
    // Only an off that ran tells the mirror to read macOS as off; a failed one leaves it reading the truth.
    if (ran.ok) this.deps.assumeOff(this.deps.now())
    const until = new Date(r.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const after = r.noEnd ? 'Turn it off in Control Center.' : `macOS ends it at ${until} by itself.`
    if (!ran.ok) {
      this.deps.log.warn('Do Not Disturb did not turn off', { error: ran.error })
      return this.offFailed(r, `Do Not Disturb may still be on: the shortcut did not run (${ran.error ?? 'unknown error'}). ${after}`)
    }
    const off = read?.ok ? await this.waitFor((live) => (gone(live) ? true : null)) : true
    if (!off) return this.offFailed(r, `The shortcut ran, but Do Not Disturb is still on. ${after}`)
    this.offDone(r)
  }

  private offDone(r: DndRecord): void {
    const { stillOn: _s, offTries: _t, error: _e, ...rest } = r
    this.set({ ...rest, status: 'off', at: this.deps.now() })
  }

  private offFailed(r: DndRecord, error: string): void {
    this.set({ ...r, status: 'failed', stillOn: true, offTries: (r.offTries ?? 0) + 1, error, at: this.deps.now() })
  }

  /** Re-read macOS until `pick` finds what it wants, a few times. */
  private async waitFor<T>(pick: (live: LiveAssertion[]) => T | null): Promise<T | null> {
    const wait = this.deps.wait ?? sleep
    for (let i = 0; i < VERIFY_TRIES; i++) {
      if (i > 0) await wait(VERIFY_GAP_MS)
      const read = await this.deps.readDetail().catch(() => null)
      if (read?.ok) {
        const found = pick(read.live)
        if (found !== null) return found
      }
    }
    return null
  }
}
