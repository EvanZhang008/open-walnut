/**
 * The tailer of one session's output file (its append-only jsonl): every 100 ms it reads what
 * the CLI appended since the last read and hands the COMPLETE lines over, each with its `v`
 * (the byte offset at the end of the line). Used by the daemon runtime (ensureWatcher in
 * daemon-standalone.ts), which does all the per-line work.
 *
 * Never on the main thread's clock: every file call is asynchronous, and one read is in flight at
 * a time (a tick that finds the previous read still going does nothing), so a slow disk slows the
 * tailing of that one session and nothing else. A read takes at most `maxReadBytes`; a backlog is
 * read over the following ticks. The lines of one read are handed over in slices, each under the
 * loop's shared budget (loop-budget.ts): once this turn's few milliseconds are spent, the next slice
 * waits for a later turn. Inside a server's process ten busy sessions never hold every request for
 * the whole of their batches.
 *
 * Torn-tail carry (contract §4 "Feed", adjudicated 2026-08-05): a read can land MID-LINE (the CLI
 * appends a >64KB whale tool_result while we read). Such a fragment is never handed over: it
 * waits in the carry (BYTES: a UTF-8 char split across reads is decoded once) until its newline
 * arrives. `boundary` is the absolute offset of the carry's first byte, the last COMPLETE-line
 * boundary (boundary + carry length === read cursor at all times): it is what the owner publishes
 * (replay, attach, the registry), never a mid-line offset, with one exception below. The carry is
 * a part list, not one Buffer (C26): with no newline in the new bytes nothing completes, so they
 * are only appended; the newline search starts past the carry (it holds none by invariant).
 *
 * Carry overflow, the one exception: a line over `carryMaxBytes` is dropped (`overflowed` on that
 * batch) and the tailer realigns on its newline. From the drop until that newline arrives the
 * carry is empty and `boundary` IS the cursor, inside the dropped line (each read without a
 * newline moves both). The newline's read puts `boundary` back on a line end. A reader that starts
 * at such a mid-line offset (a replay, a rebuilt tailer) gets the rest of the dropped line as its
 * first line, which is no JSON: its parse() throws, as for any line that is no JSON.
 *
 * A file call that never settles (a hung network file system) fails after `readTimeoutMs`
 * through `onError`, like any failed read, and the next tick reads again from the same cursor.
 *
 * Each line comes with `parse()`: the line's JSON, parsed at the first call and kept (a line that
 * is no JSON throws the same error each call). Every consumer of a line asks it, so a line is
 * parsed at most once, and a line nothing needs as an object is not parsed at all.
 */
import fsp from 'node:fs/promises'
import { sharedLoopBudget, type LoopBudget } from './loop-budget.js'

export interface TailedLine {
  line: string
  /** Byte offset at the END of this line in the file: monotonic, the same live and on replay. */
  v: number
  /** The line's JSON, parsed once (throws, the same each call, for a line that is no JSON). */
  parse(): unknown
}

export interface TailerFs {
  stat(path: string): Promise<{ size: number }>
  /** Reads `length` bytes at `position` into a new buffer; resolves the bytes actually read. */
  read(path: string, position: number, length: number): Promise<Buffer>
}

export const asyncTailerFs: TailerFs = {
  stat: (file) => fsp.stat(file),
  async read(file, position, length) {
    const handle = await fsp.open(file, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buf, 0, length, position)
      return bytesRead === length ? buf : buf.subarray(0, bytesRead)
    } finally { await handle.close() }
  },
}

/** A line's JSON on first ask, kept for the next. */
export function parseOnce(line: string): () => unknown {
  let done = false
  let value: unknown
  let error: unknown
  return () => {
    if (!done) {
      done = true
      try { value = JSON.parse(line) } catch (err) { error = err }
    }
    if (error !== undefined) throw error
    return value
  }
}

/** The carry and the line split, without any I/O: bytes in, complete lines out. */
export function createLineAssembler(startOffset: number, carryMaxBytes: number) {
  let carryParts: Buffer[] = []
  let carryLen = 0
  let boundary = startOffset
  let cursor = startOffset
  // Set after a carry-overflow drop: the rest of the oversized line is still coming.
  let discardThroughNextNewline = false
  return {
    get boundary() { return boundary },
    get cursor() { return cursor },
    get carryBytes() { return carryLen },
    /** The bytes read at the cursor: the lines they complete, and whether a line was dropped as oversized. */
    push(buf: Buffer): { lines: Array<{ line: string; v: number }>; overflowed: boolean; carryBytes: number } {
      cursor += buf.length
      const lines: Array<{ line: string; v: number }> = []
      if (buf.indexOf(10) === -1) {
        // Still inside an over-cap line: these bytes can never complete a line; drop them.
        if (discardThroughNextNewline) boundary = cursor
        else { carryParts.push(buf); carryLen += buf.length }
      } else {
        // A newline arrived. Concat once; the carry holds no newline, so the search starts past it.
        const chunk = carryLen ? Buffer.concat([...carryParts, buf], carryLen + buf.length) : buf
        let searchFrom = carryLen
        let lineEnd = boundary
        let cut = 0
        for (;;) {
          const nl = chunk.indexOf(10, searchFrom)
          if (nl === -1) break
          lineEnd += (nl - cut) + 1
          // A discarded whale ends at this newline: `v` is realigned, the NEXT line goes on.
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else lines.push({ line: chunk.subarray(cut, nl).toString('utf-8'), v: lineEnd })
          cut = nl + 1
          searchFrom = cut
        }
        // Copy the torn tail: `chunk` may alias `buf`.
        const tail = Buffer.from(chunk.subarray(cut))
        carryParts = tail.length ? [tail] : []
        carryLen = tail.length
        boundary = lineEnd
      }
      const overflowed = carryLen > carryMaxBytes
      const carryBytes = carryLen
      if (overflowed) {
        // A line larger than the cap can't be assembled: drop it, realign on the next newline;
        // `boundary` stays absolute so every later line keeps its true `v`.
        boundary = cursor
        carryParts = []
        carryLen = 0
        discardThroughNextNewline = true
      }
      return { lines, overflowed, carryBytes }
    },
  }
}

export interface SessionTailerOptions {
  path: string
  startOffset: number
  intervalMs?: number
  maxReadBytes: number
  carryMaxBytes: number
  fs?: TailerFs
  timers: { setInterval: typeof globalThis.setInterval; clearInterval: typeof globalThis.clearInterval }
  /** Still tailing this session (it runs, and this is still its tailer)? A tick does nothing otherwise. */
  active(): boolean
  /**
   * Complete lines of one read, in order, a slice at a time. The boundary up to the slice's start is
   * already published when it runs. `last`: the read's final slice, the one `overflowed` is told on.
   */
  onLines(lines: TailedLine[], info: { overflowed: boolean; carryBytes: number; cursor: number; last: boolean }): void
  /** The last complete-line boundary handed over moved. */
  onBoundary(boundary: number): void
  /** Lines per slice (default 32). */
  sliceLines?: number
  /** The loop's budget the slices are handed over under (default: the process's shared one). */
  budget?: LoopBudget
  /** A read failed (ENOENT excepted: the CLI has not written its first line yet), or timed out. */
  onError(err: unknown, consecutive: number): void
  /** How long one stat or read may take before it counts as failed (default TAILER_READ_TIMEOUT_MS). */
  readTimeoutMs?: number
}

export const TAILER_READ_TIMEOUT_MS = 30_000

/**
 * `call`, or an ETIMEDOUT error once `ms` passed without it settling. The call itself cannot be
 * cancelled: a late result is dropped (the next tick reads that range again).
 */
function withDeadline<T>(call: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`session tailer: ${what} did not settle within ${ms}ms`), { code: 'ETIMEDOUT' })), ms)
    timer.unref?.()
  })
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer))
}

export interface SessionTailer {
  readonly boundary: number
  readonly cursor: number
  readonly timer: ReturnType<typeof globalThis.setInterval>
  /** One read now (tests); the clock does the same. */
  tick(): Promise<void>
  stop(): void
}

export function createSessionTailer(opts: SessionTailerOptions): SessionTailer {
  const io = opts.fs ?? asyncTailerFs
  const lines = createLineAssembler(opts.startOffset, opts.carryMaxBytes)
  let reading: Promise<void> | null = null
  let stopped = false
  let consecutiveErrors = 0
  const readTimeoutMs = opts.readTimeoutMs ?? TAILER_READ_TIMEOUT_MS

  const readOnce = async (): Promise<void> => {
    if (stopped || !opts.active()) return
    try {
      const { size } = await withDeadline(io.stat(opts.path), readTimeoutMs, 'stat')
      if (stopped || size <= lines.cursor) { consecutiveErrors = 0; return }
      const buf = await withDeadline(io.read(opts.path, lines.cursor, Math.min(size - lines.cursor, opts.maxReadBytes)), readTimeoutMs, 'read')
      if (stopped || !opts.active()) return
      consecutiveErrors = 0
      if (!buf.length) return
      const out = lines.push(buf)
      const batch: TailedLine[] = out.lines.map(({ line, v }) => ({ line, v, parse: parseOnce(line) }))
      const sliceLen = Math.max(1, opts.sliceLines ?? 32)
      const budget = opts.budget ?? sharedLoopBudget
      for (let at = 0; at < batch.length || at === 0; at += sliceLen) {
        if (budget.over()) {
          await budget.yieldTurn()
          if (stopped || !opts.active()) return
        }
        const slice = batch.slice(at, at + sliceLen)
        const last = at + sliceLen >= batch.length
        // Published as far as it is handed over: a stop between slices leaves the rest to be read
        // again from there (the drain, a rebuilt tailer), never skipped.
        opts.onBoundary(last ? lines.boundary : slice[slice.length - 1]!.v)
        opts.onLines(slice, { overflowed: last && out.overflowed, carryBytes: out.carryBytes, cursor: lines.cursor, last })
        if (last) break
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') { consecutiveErrors = 0; return }
      consecutiveErrors++
      opts.onError(err, consecutiveErrors)
    }
  }
  const tick = (): Promise<void> => {
    // One read in flight: a slow one makes the next ticks wait, never pile up.
    if (reading) return reading
    reading = readOnce().finally(() => { reading = null })
    return reading
  }
  const timer = opts.timers.setInterval(() => { void tick() }, opts.intervalMs ?? 100)
  return {
    get boundary() { return lines.boundary },
    get cursor() { return lines.cursor },
    timer,
    tick,
    stop() { stopped = true; opts.timers.clearInterval(timer) },
  }
}
