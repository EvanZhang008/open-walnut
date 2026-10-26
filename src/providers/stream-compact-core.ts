/**
 * Stream compaction: a stopped session's stream file loses the token deltas of
 * its finished turns.
 *
 * The CLI writes its stdout straight into `<streams>/<sid>.jsonl` (the file is
 * its stdout fd), and the file grows across every spawn of the session. With
 * `--include-partial-messages`, about half of it is `stream_event` lines (one per
 * token delta) and another tenth `system/thinking_tokens` counters. Both matter
 * only while the turn streams: the tailer delivers them live, the fold skips
 * them, and the conversation itself lives in the Claude transcript. On
 * 2026-10-26 the Mac's streams dir held 12.5 GB written in under a week, about
 * 4x the transcripts (one session 3.3 GB), on a disk with 16 GiB free.
 *
 * What a compaction does, for a file whose CLI is gone:
 *   - drops those two line kinds, but only before the end of the last complete
 *     `result` line (everything after it, an unfinished turn included, keeps
 *     every byte), and only a line that parses whole (the fragment a killed
 *     CLI left, glued to the next spawn's first line, is kept);
 *   - counts what would go first, read-only, and stops there when it is too
 *     little or the disk could not hold the copy;
 *   - copies every other line byte for byte, in order, to a temp file beside it
 *     (same mtime as the original), and reports each kept line with its end
 *     offset in the NEW file (the tailer's `v`), so the caller can fold it;
 *   - `commit` swaps the copy in with a rename (a new inode, so a new
 *     streamEpoch, which tells every consumer that offsets restarted) only when
 *     the original has not changed since it was read.
 * A line too long to hold, a read or write error, or the caller's abort leaves
 * the original untouched.
 *
 * `<file>.compact` is the mark: the inode and size the last look left (a
 * compaction's output, or a file judged not worth it), so the file is looked at
 * again only once it has grown enough, and for an output the epoch of the file
 * it replaced (`rewrittenFrom`). A snapshot carries that while the file is still
 * exactly the output, so the server knows the new epoch holds the same turns,
 * not a new incarnation that ran one.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createStreamCompact;
 * daemon-source.ts inlines `createStreamCompact.toString()` through
 * `__CREATE_STREAM_COMPACT__`. So the factory body references NOTHING at module
 * scope; every side effect arrives through deps.
 */

export interface StreamCompactDeps {
  fs: typeof import('node:fs')
  now: () => number
  /** This daemon's pid: names its temp files, so two daemons never share one. */
  pid: number
  log?: (level: 'info' | 'warn', msg: string, meta: Record<string, unknown>) => void
  /** Longest line the copy will hold (the tailer's carry cap). */
  maxLineBytes: number
  /** Read size per step (tests shrink it). */
  chunkBytes?: number
  /** Files smaller than this are never compacted. */
  minBytes?: number
  /** Free space that must remain beyond the copy (default 2 GiB). */
  reserveBytes?: number
}

export interface StreamCompactPrepared {
  tmpPath: string
  /** The original, as read: commit refuses when any of these moved. */
  size: number
  mtimeMs: number
  ino: number
  /** Size of the compacted copy. */
  after: number
  droppedBytes: number
  droppedLines: number
}

export interface StreamCompactOptions {
  /** Each kept, complete line with its end offset in the new file. */
  onKeptLine?: (line: Buffer, v: number) => void
  /** Checked between reads; true stops and discards the copy. */
  aborted?: () => boolean
  /** Skip when fewer bytes than this would go. */
  minDropBytes?: number
}

export function createStreamCompact(deps: StreamCompactDeps) {
  const fs = deps.fs
  const fsp = deps.fs.promises
  const CHUNK = deps.chunkBytes && deps.chunkBytes > 0 ? deps.chunkBytes : 1024 * 1024
  const MIN_BYTES = typeof deps.minBytes === 'number' ? deps.minBytes : 32 * 1024 * 1024
  const RESERVE = typeof deps.reserveBytes === 'number' ? deps.reserveBytes : 2 * 1024 * 1024 * 1024
  const MAX_LINE = deps.maxLineBytes
  const log = deps.log || function () {}
  const DROP = [
    Buffer.from('{"type":"stream_event",'),
    Buffer.from('{"type":"system","subtype":"thinking_tokens",'),
  ]
  // The fold's own result test is this substring (the CLI writes the key after
  // others: `{"duration_api_ms":…,"type":"result",…}`); a parse confirms it is
  // the line's own type.
  const RESULT_KEY = Buffer.from('"type":"result"')
  const TMP_INFIX = '.compact-tmp-'

  const tmpPathFor = (jsonlPath: string): string => jsonlPath + TMP_INFIX + deps.pid
  const markPathFor = (jsonlPath: string): string => jsonlPath + '.compact'
  // The daemon's streamEpoch (streamEpochOf): dev:ino:birthtimeMs.
  const epochOf = (st: { dev: number; ino: number; birthtimeMs: number }): string =>
    st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs)

  /** A session's stream file (not an ACP journal, which has no turns to drop). */
  function isStreamFile(name: string): boolean {
    return name.endsWith('.jsonl') && !name.endsWith('.acp.jsonl')
  }

  function startsWithAt(buf: Buffer, at: number, end: number, prefix: Buffer): boolean {
    if (end - at < prefix.length) return false
    for (let i = 0; i < prefix.length; i++) if (buf[at + i] !== prefix[i]) return false
    return true
  }

  function droppable(buf: Buffer, at: number, end: number): boolean {
    for (const p of DROP) if (startsWithAt(buf, at, end, p)) return true
    return false
  }

  function readMark(jsonlPath: string): { ino?: unknown; size?: unknown; from?: unknown; skipped?: unknown } | null {
    try { return JSON.parse(fs.readFileSync(markPathFor(jsonlPath), 'utf-8')) } catch { return null }
  }

  function writeMark(jsonlPath: string, mark: Record<string, unknown>): void {
    try {
      fs.writeFileSync(markPathFor(jsonlPath), JSON.stringify(Object.assign({ v: 1, at: deps.now() }, mark)), { mode: 0o600 })
    } catch { /* the mark only saves a later look and names the old epoch */ }
  }

  /** Bytes free on the file system holding `file`, or null when unknown. */
  function freeBytes(file: string): number | null {
    const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync
    if (typeof statfs !== 'function') return null
    try { const s = statfs(file); return s.bavail * s.bsize } catch { return null }
  }

  /** Is this file worth a look now? (size floor + growth since the last look) */
  function due(jsonlPath: string, st: { size: number; ino: number }): boolean {
    if (st.size < MIN_BYTES) return false
    const mark = readMark(jsonlPath)
    if (!mark || mark.ino !== st.ino || typeof mark.size !== 'number') return true
    const grown = st.size - mark.size
    return grown >= Math.max(MIN_BYTES, mark.size / 4)
  }

  /** The epoch this file replaced, while it is still exactly a compaction's output; else null. */
  function rewrittenFrom(jsonlPath: string, st: { ino: number; size: number }): string | null {
    const mark = readMark(jsonlPath)
    return mark && mark.ino === st.ino && mark.size === st.size && typeof mark.from === 'string' ? mark.from : null
  }

  /**
   * One pass over [0, size): every complete line, with whether it may be dropped.
   * Returns false when a line is longer than the cap or the caller aborted.
   */
  async function eachLine(
    src: import('node:fs/promises').FileHandle,
    size: number,
    keepFrom: number,
    aborted: () => boolean,
    onLine: (chunk: Buffer, start: number, end: number, drop: boolean, offset: number) => void | Promise<void>,
  ): Promise<{ ok: true; tail: Buffer } | { ok: false; reason: string }> {
    const buf = Buffer.alloc(CHUNK)
    let carry: Buffer = Buffer.alloc(0)
    let filePos = 0
    let lineStart = 0 // offset in the file of carry[0]
    while (filePos < size) {
      if (aborted()) return { ok: false, reason: 'aborted' }
      const { bytesRead: n } = await src.read(buf, 0, Math.min(CHUNK, size - filePos), filePos)
      if (n <= 0) break
      filePos += n
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
      let start = 0
      for (;;) {
        const nl = chunk.indexOf(10, start)
        if (nl === -1) break
        const end = nl + 1
        const drop = lineStart + end <= keepFrom && droppable(chunk, start, nl)
        await onLine(chunk, start, end, drop, lineStart + start)
        start = end
      }
      lineStart += start
      carry = Buffer.from(chunk.subarray(start))
      if (carry.length > MAX_LINE) return { ok: false, reason: 'line-too-long' }
    }
    return { ok: true, tail: carry }
  }

  async function compact(jsonlPath: string, opts?: StreamCompactOptions): Promise<StreamCompactPrepared | { skipped: string }> {
    const onKept = opts && opts.onKeptLine
    const aborted = (opts && opts.aborted) || function () { return false }
    const minDrop = Math.max(1, opts && typeof opts.minDropBytes === 'number' ? opts.minDropBytes : 0)
    const tmpPath = tmpPathFor(jsonlPath)
    let src: import('node:fs/promises').FileHandle | null = null
    let out: import('node:fs/promises').FileHandle | null = null
    let keep = false
    let opened = false
    try {
      src = await fsp.open(jsonlPath, 'r')
      const st = await src.stat()
      const size = st.size
      // A file judged not worth it is not read again until it grows (see due).
      const notWorth = (reason: string) => { writeMark(jsonlPath, { ino: st.ino, size, skipped: reason }); return { skipped: reason } }
      const free = freeBytes(jsonlPath)
      if (free !== null && free < size + RESERVE) return { skipped: 'low-disk' }
      // Read-only first: where the last finished turn ends (the end of its
      // result line), and what would go before it. A file with little to drop
      // is never copied.
      let keepFrom = 0
      let droppedBytes = 0
      let droppedLines = 0
      let seen = 0
      let seenLines = 0
      const counted = await eachLine(src, size, size, aborted, (chunk, start, end, drop, offset) => {
        if (drop) { seen += end - start; seenLines++; return }
        const line = chunk.subarray(start, end)
        if (line.indexOf(RESULT_KEY) === -1) return
        let parsed: { type?: unknown } | null = null
        try { parsed = JSON.parse(line.toString('utf-8')) } catch { return }
        if (!parsed || parsed.type !== 'result') return
        keepFrom = offset + (end - start)
        droppedBytes = seen
        droppedLines = seenLines
      })
      if (!counted.ok) return counted.reason === 'line-too-long' ? notWorth(counted.reason) : { skipped: counted.reason }
      if (keepFrom === 0) return notWorth('no-finished-turn')
      if (droppedBytes < minDrop) return notWorth('little-to-drop')

      // 'wx': a temp file that exists belongs to an unfinished copy; never share it.
      out = await fsp.open(tmpPath, 'wx', 0o600)
      opened = true
      let newV = 0
      const pending: Buffer[] = []
      let pendingBytes = 0
      const flush = async (): Promise<void> => {
        if (pendingBytes === 0) return
        const joined = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes)
        pending.length = 0
        pendingBytes = 0
        let off = 0
        while (off < joined.length) {
          const { bytesWritten } = await out!.write(joined, off, joined.length - off)
          off += bytesWritten
        }
      }
      // The count pass judged by prefix; the copy drops only a line that parses
      // whole, and reports what it actually dropped.
      droppedBytes = 0
      droppedLines = 0
      const copied = await eachLine(src, size, keepFrom, aborted, async (chunk, start, end, drop) => {
        if (drop) {
          try {
            JSON.parse(chunk.toString('utf-8', start, end - 1))
            droppedBytes += end - start
            droppedLines++
            return
          } catch { /* a glued or torn line: keep every byte */ }
        }
        // Copy: `chunk` may alias the reused read buffer.
        const line = Buffer.from(chunk.subarray(start, end))
        pending.push(line)
        pendingBytes += line.length
        newV += line.length
        if (onKept) onKept(line.subarray(0, line.length - 1), newV)
        if (pendingBytes >= CHUNK) await flush()
      })
      if (!copied.ok) return { skipped: copied.reason }
      // A trailing unterminated fragment (a CLI killed mid-write) stays as is.
      if (copied.tail.length) { pending.push(copied.tail); pendingBytes += copied.tail.length }
      await flush()
      await out.sync()
      const after = (await out.stat()).size
      // Keep the original's times: retention judges a stream file by its mtime.
      fs.utimesSync(tmpPath, st.atime, st.mtime)
      keep = true
      return { tmpPath, size, mtimeMs: st.mtimeMs, ino: st.ino, after, droppedBytes, droppedLines }
    } catch (err) {
      log('warn', 'stream compaction failed; the original is untouched', { jsonlPath, error: (err as Error).message })
      return { skipped: 'error' }
    } finally {
      if (out) { try { await out.close() } catch { /* already closed */ } }
      if (src) { try { await src.close() } catch { /* already closed */ } }
      if (opened && !keep) { try { fs.unlinkSync(tmpPath) } catch { /* gone */ } }
    }
  }

  /**
   * Swap the copy in, synchronously, when the original is exactly what was read.
   * Returns false (and removes the copy) otherwise. Run it where no spawn of the
   * session can interleave (the daemon's per-session start gate).
   */
  function commit(jsonlPath: string, prepared: StreamCompactPrepared): boolean {
    try {
      const st = fs.statSync(jsonlPath)
      if (st.size !== prepared.size || st.mtimeMs !== prepared.mtimeMs || st.ino !== prepared.ino) {
        discard(jsonlPath)
        return false
      }
      // The mark first, keyed to the copy's inode (a rename keeps it), so a crash
      // between the two never leaves an output that does not name its origin.
      const tmp = fs.statSync(prepared.tmpPath)
      writeMark(jsonlPath, { ino: tmp.ino, size: tmp.size, from: epochOf(st) })
      fs.renameSync(prepared.tmpPath, jsonlPath)
      return true
    } catch (err) {
      log('warn', 'stream compaction commit failed; the original is untouched', { jsonlPath, error: (err as Error).message })
      discard(jsonlPath)
      return false
    }
  }

  function discard(jsonlPath: string): void {
    try { fs.unlinkSync(tmpPathFor(jsonlPath)) } catch { /* none */ }
  }

  /** Remove temp files no live daemon is writing, and marks whose stream file is gone. */
  function sweepStale(dir: string, isAlive: (pid: number) => boolean): void {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { return }
    const present = new Set(names)
    for (const f of names) {
      const at = f.lastIndexOf(TMP_INFIX)
      if (at !== -1 && f.slice(0, at).endsWith('.jsonl')) {
        const pid = parseInt(f.slice(at + TMP_INFIX.length), 10)
        if (!(Number.isInteger(pid) && pid > 1 && pid !== deps.pid && isAlive(pid))) {
          if (pid === deps.pid && compacting.has(f.slice(0, at))) continue
          try { fs.unlinkSync(dir + '/' + f) } catch { /* gone */ }
        }
      } else if (f.endsWith('.jsonl.compact') && !present.has(f.slice(0, -'.compact'.length))) {
        try { fs.unlinkSync(dir + '/' + f) } catch { /* gone */ }
      }
    }
  }

  // Files this daemon is copying right now (sweepStale must leave their temp files).
  const compacting = new Set<string>()
  async function compactTracked(jsonlPath: string, opts?: StreamCompactOptions): Promise<StreamCompactPrepared | { skipped: string }> {
    const name = jsonlPath.slice(jsonlPath.lastIndexOf('/') + 1)
    compacting.add(name)
    try { return await compact(jsonlPath, opts) } finally { compacting.delete(name) }
  }

  return {
    compact: compactTracked, commit, discard, due, rewrittenFrom, sweepStale, isStreamFile,
    tmpPathFor, markPathFor, minBytes: MIN_BYTES,
  }
}
