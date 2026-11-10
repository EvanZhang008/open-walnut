/**
 * Commands a direct Codex session left running when its turn ended: Codex's background
 * terminals (an `exec_command` that answered with a session id and runs on). The model
 * ends its turn while a build or test run goes on, and nothing of Codex's wakes it when
 * that command ends; Walnut does (2026-11-10: a Codex task sat in Needs you three times
 * while its own build ran, each needing a person's nudge).
 *
 * What real Codex 0.167 does (smoke run): after `turn/completed` the command is listed by
 * `thread/backgroundTerminals/list`; when it exits, Codex sends that command's
 * `item/completed` (exit code, output) under the ended turn's id, and the list drops it.
 * A later turn can still read it. So:
 * - at a turn's end, before the turn settles, the list says what runs on (the worker
 *   journals it ahead of the turn's end, so the server never reads the task as done);
 * - an exit is read from that late `item/completed`, or, should it never come, from the
 *   list, polled while no turn runs;
 * - an exit while no turn runs is reported at once (the server wakes the session with it);
 *   one during a turn at that turn's end (a command gone from the list then ended too), unless
 *   that turn read the command after it ended (`item/commandExecution/terminalInteraction`), so
 *   the model saw how it ended; a read while it still ran proves nothing;
 * - a stop ends every background terminal (connection.ts cancel): none of them wakes anyone.
 */

import type { BackgroundTerminal, FinishedTerminal } from '../acp-worker/protocol.js'

export type { BackgroundTerminal, FinishedTerminal }
export interface BackgroundWorkState { running: BackgroundTerminal[]; finished: FinishedTerminal[] }

/** What of a command's output rides the report (its end, where a build says how it went). */
export const OUTPUT_TAIL_CHARS = 2_000
/** Exits that land together are reported together. */
const FLUSH_MS = 300

/** How often the list is read while commands run on and no turn runs (a test shortens it). */
export function backgroundPollMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.WALNUT_CODEX_BG_POLL_MS)
  return Number.isFinite(n) && n > 0 ? n : 30_000
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined

/** The terminals of a `thread/backgroundTerminals/list` answer. */
export function listedTerminals(resp: unknown): BackgroundTerminal[] {
  const data = isRecord(resp) && Array.isArray(resp.data) ? resp.data.filter(isRecord) : []
  const out: BackgroundTerminal[] = []
  for (const t of data) {
    const processId = idOf(t.processId)
    if (processId) out.push({ processId, command: typeof t.command === 'string' ? t.command : '' })
  }
  return out
}

export interface BackgroundWorkDeps {
  /** The thread's background terminals now; null when Codex cannot say (an older Codex, no answer). */
  list(): Promise<BackgroundTerminal[] | null>
  turnRunning(): boolean
  /** Called synchronously; each call is the whole state, and `finished` holds only what is new. */
  report(state: BackgroundWorkState): void
  pollMs: number
}

export class CodexBackgroundWork {
  private running = new Map<string, BackgroundTerminal>()
  private finished: FinishedTerminal[] = []
  /** Ended commands the running turn read after they ended: their end is no news to the model. */
  private readByTurn = new Set<string>()
  private reportedKey = '[]'
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private closed = false

  constructor(private readonly deps: BackgroundWorkDeps) {}

  get count(): number { return this.running.size }

  /**
   * A turn ended (call before it settles). `stopped`: a stop ends every background terminal,
   * so none runs on and none wakes anyone.
   */
  async turnEnded(opts: { stopped: boolean }): Promise<void> {
    if (this.closed) return
    const readByTurn = this.readByTurn
    this.readByTurn = new Set()
    if (opts.stopped) {
      this.dropAll()
      return
    }
    const listed = await this.deps.list()
    if (this.closed) return
    if (listed) {
      // One that left the list with no item/completed (the turn kept the poll off) ended too.
      this.collectGone(listed)
      this.running = new Map(listed.map((t) => [t.processId, t]))
    }
    this.finished = this.finished.filter((f) => !readByTurn.has(f.processId))
    this.emit()
  }

  /** A `commandExecution` item completed: an ended turn's included, which is how an exit is told. */
  noteItemCompleted(item: Record<string, unknown>): void {
    if (this.closed || item.type !== 'commandExecution') return
    const processId = idOf(item.processId)
    const known = processId ? this.running.get(processId) : undefined
    if (!processId || !known) return
    this.running.delete(processId)
    const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
    this.finished.push({
      processId,
      command: known.command,
      exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
      output: output.length > OUTPUT_TAIL_CHARS ? output.slice(-OUTPUT_TAIL_CHARS) : output,
    })
    this.flushSoon()
  }

  /** The running turn read (or wrote to) a background terminal: news to it only once that one has ended. */
  noteTerminalInteraction(params: Record<string, unknown>): void {
    const processId = idOf(params.processId)
    if (processId && this.deps.turnRunning() && this.finished.some((f) => f.processId === processId)) this.readByTurn.add(processId)
  }

  /** A stop ends them all (connection.ts cancel): from here none runs on, and no end of one is news. */
  dropAll(): void {
    if (this.closed) return
    this.running.clear()
    this.finished = []
    this.readByTurn.clear()
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.emit()
  }

  /** The app-server is gone, and every command it ran with it. */
  gone(): void {
    this.dropAll()
    this.close()
  }

  close(): void {
    this.closed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.pollTimer = null
    this.flushTimer = null
  }

  /** An exit while no turn runs is told now; one during a turn at that turn's end. */
  private flushSoon(): void {
    if (this.flushTimer || this.deps.turnRunning()) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (!this.closed && !this.deps.turnRunning()) this.emit()
    }, FLUSH_MS)
    this.flushTimer.unref?.()
  }

  /** Should Codex never send an exit's item, the list still drops the command. */
  private async pollOnce(): Promise<void> {
    if (this.closed || this.polling || this.deps.turnRunning() || this.running.size === 0) return
    this.polling = true
    try {
      const listed = await this.deps.list()
      if (!listed || this.closed || this.deps.turnRunning()) return
      this.collectGone(listed)
      if (this.finished.length) this.emit()
    } finally {
      this.polling = false
    }
  }

  /** Known commands no longer listed ended, how Codex never said. */
  private collectGone(listed: BackgroundTerminal[]): void {
    const still = new Set(listed.map((t) => t.processId))
    for (const [processId, t] of this.running) {
      if (still.has(processId)) continue
      this.running.delete(processId)
      this.finished.push({ ...t, exitCode: null, output: '' })
    }
  }

  private emit(): void {
    const finished = this.finished
    this.finished = []
    const key = JSON.stringify([...this.running.keys()])
    if (finished.length || key !== this.reportedKey) {
      this.reportedKey = key
      this.deps.report({ running: [...this.running.values()], finished })
    }
    if (this.running.size > 0 && !this.pollTimer && !this.closed) {
      this.pollTimer = setInterval(() => { void this.pollOnce() }, this.deps.pollMs)
      this.pollTimer.unref?.()
    } else if (this.running.size === 0 && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }
}
