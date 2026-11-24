/**
 * The daemon log's writer, one for both twins: lines are queued and appended by one async write
 * at a time, every line queued meanwhile going out in the next one.
 *
 * Why: logMsg did one appendFileSync per line on the daemon's thread. In a server that runs the
 * daemon runtime in its own process (in_process_daemon) that thread is the web server's, and a
 * session start logs a dozen lines (2026-11-21 stall investigation: an append among the
 * synchronous fs calls seen in D state on the server's thread).
 *
 *   - `append(line, urgent)`: queued; at most one write in flight, in order. An urgent line (an
 *     error) is written synchronously at once when no write is in flight, else right after the
 *     one in flight lands: never ahead of the lines before it.
 *   - `flushSync()`: the exit paths (a crash guard, the exit cleanup, a server's shutdown bail):
 *     the batch still in flight, then what is queued, written now, synchronously, so the last
 *     words of a dying process are on disk in order. The batch in flight may land a second time
 *     after it: a repeated line after an exit is better than a gap before it.
 *   - The queue is capped (maxQueuedBytes, in UTF-8 bytes): past it, lines are counted and
 *     dropped, and the count is written in their place once the writer catches up.
 *   - A wedged file pool never silences the log (the log is how that incident is diagnosed): an
 *     append in flight past deadlineMs (2 s) whose pool does not answer a probe either
 *     (file-pool-deadline.ts, the registry writer's rule) is written again synchronously with
 *     the queue behind it, in order, and every line after it is written synchronously until the
 *     stuck append ends (its batch may then land a second time). A pool that answers means a
 *     slow disk: the append is left to finish, never turned into a sync write on this thread.
 *
 * Imported by daemon-standalone.ts (createLogAppender). The factory body references NOTHING at module scope; every helper arrives through deps.
 */

export interface LogAppenderDeps {
  fs: typeof import('node:fs')
  file: string
  /** Default 4 MiB. */
  maxQueuedBytes?: number
  /** An append in flight longer than this probes the pool (and is made synchronously when it is wedged). Default 2000. */
  deadlineMs?: number
  /** The deadline rule (file-pool-deadline.ts armFilePoolDeadline), shared with the registry writer. */
  armDeadline: typeof import('./file-pool-deadline.js').armFilePoolDeadline
}

export interface LogAppender {
  append(line: string, urgent?: boolean): void
  flushSync(): void
  /** Resolves once everything queued before the call is written (tests). */
  drained(): Promise<void>
}

export function createLogAppender(deps: LogAppenderDeps): LogAppender {
  const fs = deps.fs
  const max = deps.maxQueuedBytes && deps.maxQueuedBytes > 0 ? deps.maxQueuedBytes : 4 * 1024 * 1024
  let queue: string[] = []
  let queuedBytes = 0
  let dropped = 0
  const deadlineMs = typeof deps.deadlineMs === 'number' && deps.deadlineMs > 0 ? deps.deadlineMs : 2000
  let inFlight: Promise<void> | null = null
  /** The append in flight went past its deadline with the pool wedged: lines are written here until it ends. */
  let stuck = false
  /** The text of the write in flight, until it lands (flushSync writes it again). */
  let inFlightText: string | null = null
  /** An urgent line is queued behind the write in flight: the rest goes synchronously after it. */
  let urgentQueued = false
  let scheduled = false
  let idle: Array<() => void> = []

  function take(): string {
    let text = queue.join('')
    if (dropped > 0) {
      text += JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'log lines dropped: the log could not keep up', dropped }) + '\n'
      dropped = 0
    }
    queue = []
    queuedBytes = 0
    return text
  }

  function writeQueuedSync(): void {
    urgentQueued = false
    if (queue.length === 0 && dropped === 0) return
    const text = take()
    try { fs.appendFileSync(deps.file, text) } catch { /* as append */ }
  }

  /** No async append is waited for: none in flight, or the one in flight is stuck. */
  function free(): boolean { return !inFlight || stuck }

  function pump(): void {
    if (!free()) return
    if (stuck || urgentQueued) writeQueuedSync()
    if (queue.length === 0 && dropped === 0) {
      const waiting = idle
      idle = []
      for (const resolve of waiting) resolve()
      return
    }
    const text = take()
    inFlightText = text
    let cancel: (() => void) | null = null
    const flight: Promise<void> = fs.promises.appendFile(deps.file, text).catch(() => { /* a log write that fails loses its lines, as before */ })
      .then(() => {
        if (cancel) cancel()
        if (inFlight === flight) { inFlightText = null; inFlight = null; stuck = false }
        pump()
      })
    inFlight = flight
    cancel = deps.armDeadline({
      fsp: fs.promises,
      deadlineMs,
      onWedged() {
        cancel = null
        if (inFlight !== flight) return
        stuck = true
        // The batch in flight, then the queue, now and in order; then a line saying why.
        const again = inFlightText || ''
        inFlightText = null
        const rest = queue.length > 0 || dropped > 0 ? take() : ''
        urgentQueued = false
        const why = JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'log: the file pool did not answer; writing synchronously', waitedMs: deadlineMs }) + '\n'
        try { fs.appendFileSync(deps.file, again + rest + why) } catch { /* as append */ }
        pump()
      },
    })
  }

  function append(line: string, urgent?: boolean): void {
    const size = Buffer.byteLength(line)
    if (queuedBytes + size > max) { dropped++; return }
    queue.push(line)
    queuedBytes += size
    if (urgent) {
      if (!free()) { urgentQueued = true; return }
      writeQueuedSync()
      return
    }
    if (!free() || scheduled) return
    // A microtask: the lines of this turn go out in one write.
    scheduled = true
    Promise.resolve().then(() => { scheduled = false; pump() })
  }

  function flushSync(): void {
    const before = inFlightText
    inFlightText = null
    urgentQueued = false
    const text = (before || '') + (queue.length > 0 || dropped > 0 ? take() : '')
    if (!text) return
    try { fs.appendFileSync(deps.file, text) } catch { /* as append */ }
  }

  function drained(): Promise<void> {
    if (free() && !scheduled && queue.length === 0) return Promise.resolve()
    return new Promise<void>((resolve) => { idle.push(resolve) })
  }

  return { append, flushSync, drained }
}
