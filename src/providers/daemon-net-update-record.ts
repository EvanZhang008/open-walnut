/**
 * The daemon update a server started on a host network machine, from the moment its
 * detached runner runs there (daemon-net-update-io.ts) until the server has read what it
 * left: the update's answer and the tail's record (daemon-update-tail.ts) in its staging dir.
 *
 * The old daemon exits during the update, so the link drops by design; when it does not
 * come back, the host's status says so in a sentence (core/hosts/host-status.ts), and when
 * it does (after the server's own wait gave up), this reads the record, logs the outcome
 * and removes the dir. 2026-11-04: a Mac went away during its own update and nothing on the
 * server said why; the poll that would have read the record had given up long before.
 * Kept on disk too from the launch until it was read (daemon-update-readback.ts unreadUpdates,
 * `net:<host>`): a server restarted meanwhile (a deploy) reads it back before its next attempt.
 * 2026-11-04 review 4: it lived in memory only, so the next server had no hold and no cooldown,
 * and stopped the healthy daemon once more for a build that had just failed.
 *
 * A record that says the build stopped the daemon and did not stay serving gives the build
 * the same day's hold as an answer in time (onBuildFailed; 2026-11-04 review: a late record
 * only fed the status, and the next try within the hour stopped the healthy daemon again).
 */
import { log } from '../logging/index.js'
import { netReadText, readNetUpdateRecord, type NetUpdateConn } from './daemon-net-update-io.js'
import { tailSteppedIn } from './daemon-update-tail.js'
import { judgeUpdateRecord, unreadUpdates, UPDATE_RUNNER_MAX_MS } from './daemon-update-readback.js'

/** Away this long during its update (the swap and the tail take a few minutes at worst): it has not come back yet. */
export const NET_UPDATE_LOST_AFTER_MS = 10 * 60_000
/** A runner with no done line this long after its launch died: its record never comes (daemon-update-readback.ts). */
export const NET_UPDATE_RUNNER_MAX_MS = UPDATE_RUNNER_MAX_MS
const STAGING = /^\/tmp\/open-walnut-update\.[a-zA-Z0-9]+$/

/** What a host's status says about its daemon update (DaemonConnectState.daemonUpdate). */
export interface DaemonUpdateView {
  /**
   * updating: the link dropped during it; lost: it has not come back yet (a Mac may just be
   * asleep, 2026-11-04 review); failed: it is back, and the update did not go through; down:
   * the update's own record, read over SSH, says no daemon runs on the host.
   */
  state: 'updating' | 'lost' | 'failed' | 'down'
  /** When the update started on the host (ms epoch). */
  at: number
  message?: string
}

interface Launched { at: number; directory: string; expected: string; from: string | null }

export class LaunchedNetUpdate {
  private launched: Launched | null = null
  private failure: { at: number; expected: string; message: string } | null = null
  private reading: Promise<void> | null = null
  /** When a status first saw the link down since the launch (the update's own swap drops it). */
  private downSince: number | null = null
  private loaded = false

  /**
   * `now` is the wall clock: the host's runner goes on while this Mac sleeps, so its minutes are
   * real ones. `onBuildFailed`: a record read back says the build itself did not stay serving.
   */
  constructor(
    private readonly host: string, private readonly now: () => number = Date.now,
    private readonly onBuildFailed?: (expected: string, reason: string) => void | Promise<void>,
  ) {}

  private get key(): string { return `net:${this.host}` }

  /** Once per process: an update a server before this one launched and did not live to read. */
  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    const kept = await unreadUpdates.read(this.key).catch(() => null)
    if (kept && !this.launched && STAGING.test(kept.directory)) this.launched = { at: kept.at, directory: kept.directory, expected: kept.expected, from: null }
  }

  started(directory: string, expected: string, from: string | null): void {
    this.launched = { at: this.now(), directory, expected, from }
    this.downSince = null
    this.loaded = true
    void unreadUpdates.write(this.key, { at: this.launched.at, directory, expected })
  }

  /** Its answer came back over the link: the record is read, the dir removed by the update itself. */
  answered(): void {
    if (this.launched) void unreadUpdates.write(this.key, null)
    this.launched = null
  }

  /** The last update failed with these words, or null when it went through. */
  outcome(expected: string, message: string | null): void {
    this.failure = message ? { at: this.launched?.at ?? this.now(), expected, message } : null
  }

  /** The record is still to be read: the server's wait ended before the host came back. */
  get unread(): boolean {
    return this.launched !== null
  }

  /**
   * `running`: the build the host's daemon answers with. A failure is not shown once the host
   * runs the build it was about (another way put it there). "Lost" counts from when a status
   * first saw the link down, not from the launch: busy retries may take minutes before the swap.
   * Called on every status frame, so it only compares fields it holds.
   */
  view(connected: boolean, running: string | null = null): DaemonUpdateView | null {
    if (this.launched) {
      // Back on the link: its record is read on the next check, which decides (readBack).
      if (connected) { this.downSince = null; return null }
      this.downSince ??= this.now()
      return { state: this.now() - this.downSince >= NET_UPDATE_LOST_AFTER_MS ? 'lost' : 'updating', at: this.launched.at }
    }
    const f = this.failure
    if (connected && f && running !== f.expected) return { state: 'failed', at: f.at, message: f.message }
    return null
  }

  /**
   * The host is back: read what the runner left, log it, remove the dir, and keep its
   * outcome as the last one (a failure stays on the host's status until a later update of
   * this build goes through). `running` is the build the host's daemon answers with now.
   */
  readBack(conn: NetUpdateConn, running: string | null, remove: (directory: string) => Promise<unknown>): Promise<void> {
    // A reconnect's read and the next check's may meet: one read, both wait for it.
    this.reading ??= this.read(conn, running, remove).finally(() => { this.reading = null })
    return this.reading
  }

  private async read(conn: NetUpdateConn, running: string | null, remove: (directory: string) => Promise<unknown>): Promise<void> {
    const l = this.launched
    if (!l) return
    // A read the link could not answer is no answer: the record is read on a later check.
    const read = netReadText(conn, { strict: true })
    let record: Awaited<ReturnType<typeof readNetUpdateRecord>>
    let script: string | null = null
    try {
      record = await readNetUpdateRecord(read, l.directory)
      if (!record) script = await read(`${l.directory}/update.sh`)
    } catch { return }
    if (!record) {
      // No update.done: still running (its script is there), or the dir is gone (a reboot clears /tmp), or it died.
      if (script !== null && this.now() - l.at < NET_UPDATE_RUNNER_MAX_MS) return
      this.answered()
      log.session.warn('DaemonConnection: host network daemon update left no record (the host may have restarted)', { host: this.host, expected: l.expected, from: l.from, running, startedAt: l.at, scriptLeft: script !== null })
      if (script !== null && STAGING.test(l.directory)) await remove(l.directory).catch(() => {})
      this.failure = running === l.expected ? null
        : { at: l.at, expected: l.expected, message: `the update left no record on the host (it may have restarted), and its daemon is still ${running ?? 'of an unknown build'}` }
      return
    }
    let ok = false
    try { ok = JSON.parse(record.out.slice(Math.max(0, record.out.indexOf('{')))).ok === true } catch { /* no answer */ }
    const tail = record.tail
    const superseded = record.done.includes('rc=superseded')
    const words = superseded ? 'a later update on the host took over before this one ran'
      : !ok ? `the update answered: ${record.out.trim().slice(-300) || record.done.trim()}` : ''
    const after = tailSteppedIn(tail) ? `afterwards on the host: ${tail!.words}` : ''
    const failed = superseded || !ok || tail?.outcome === 'restored' || tail?.outcome === 'standin' || tail?.outcome === 'down'
    // The same rule as an answer that came in time (judgeServiceUpdate): stopped and not serving, or restored or down after.
    const verdict = superseded ? null : judgeUpdateRecord(record)
    const fields = { host: this.host, expected: l.expected, from: l.from, running, startedAt: l.at, done: record.done.trim(), tail: tail?.outcome ?? null, tailWords: tail?.words ?? null }
    if (failed) log.session.error('DaemonConnection: host network daemon update did not go through (read back once the host returned)', { ...fields, answer: record.out.slice(-600) })
    else log.session.info('DaemonConnection: host network daemon update read back once the host returned', fields)
    this.failure = failed ? { at: l.at, expected: l.expected, message: [words, after].filter(Boolean).join('; ') || 'the update did not go through' } : null
    // The build's hold first, then the host's record (its dir), then this one: a server killed in
    // between keeps one of them, never neither (2026-11-04 review 5).
    if (verdict?.buildFailed) await Promise.resolve(this.onBuildFailed?.(l.expected, (this.failure?.message ?? verdict.message).slice(0, 300))).catch(() => {})
    if (STAGING.test(l.directory)) await remove(l.directory).catch(() => {})
    if (this.launched === l) this.answered()
  }
}
