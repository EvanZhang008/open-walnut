/**
 * Folding a session's whole stream file without holding the daemon's thread,
 * and starting a fresh file on a resume once the old one is too big.
 *
 * Why: a resume rebuilds the session's fold (the snapshot state) and its
 * background-task state from its stream file, from the newest valid fold
 * checkpoint or from byte 0. That ran synchronously, twice over the file, on
 * the daemon's one thread. On 2026-10-27 a resume of a 2.5 GB stream whose
 * checkpoint a format change had rejected held that thread for 214 s: every
 * local session, ping and snapshot waited. Now:
 *
 *   - `foldFile` reads the file once with async reads of CHUNK bytes, folds
 *     both states in the same pass (the steps of rebuildFoldStateFromJsonl and
 *     rebuildTaskStateFromJsonl), and gives the loop back after every chunk, so
 *     other commands run between chunks. It saves a checkpoint every
 *     PROGRESS_BYTES and at the end, so a fold that is cut short, and the next
 *     resume, start from there.
 *   - `rotateReason` says whether a resume should leave the old file once it
 *     is folded: at ROTATE_BYTES or more, and only when the session's Claude
 *     transcript exists (the conversation lives there; without it the stream
 *     file may be its only copy). The resume then starts a fresh file, the way
 *     a fresh spawn does: a new inode, so a new streamEpoch, which every
 *     consumer already reads as "offsets restarted" (the same path as a stream
 *     retention removed or a reboot wiped). So no stream file grows across
 *     resumes past the cap, and the next resume has a small file to read. A
 *     file whose fold holds an armed cron or a pending ScheduleWakeup is kept:
 *     the resumed CLI revives those from its transcript without a line in the
 *     new file, and the idle reapers read them from the fold.
 *
 * How each twin gets it: daemon-standalone.ts imports createStreamFold;
 * daemon-source.ts inlines `createStreamFold.toString()` through
 * `__CREATE_STREAM_FOLD__`. So the factory body references NOTHING at module
 * scope; every helper arrives through deps.
 */

export interface StreamFoldCheckpoint<F, T> {
  load(jsonlPath: string): { boundary: number; fold: F; task: T | null } | null
  write(jsonlPath: string, fold: F, task: T, expectedEpoch?: string | null): boolean
  restampTaskState(task: T, now: number): T
}

export interface StreamFoldDeps<F extends { v: number }, T> {
  fs: typeof import('node:fs')
  path: typeof import('node:path')
  foldLine: (state: F, line: string, v: number) => F
  initialFoldState: (v: number) => F
  emptyTaskState: () => T
  applyTaskEvent: (task: T, parsed: Record<string, unknown>, v: number, now: number) => unknown
  checkpoint: StreamFoldCheckpoint<F, T>
  /** Longest line the fold assembles (the tailer's carry cap). */
  maxLineBytes: number
  now: () => number
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>) => void
  /** Bytes per read; each read gives the loop back (tests may shrink it). */
  chunkBytes?: number
  /** Save a checkpoint after this many folded bytes. */
  progressBytes?: number
  /** A resume starts a fresh file at this size or more (0 turns it off). */
  rotateBytes?: number
}

export interface StreamFoldResult<F, T> {
  fold: F
  task: T
  /** End of the last complete line folded: where the watcher starts. */
  boundary: number
  /** Where the fold began (a checkpoint's boundary, or 0). */
  from: number
  /** Boundary of the newest checkpoint written for this file, 0 when none. */
  checkpointV: number
  /** The caller's `aborted` said stop: the fold ends early (its progress is saved). */
  aborted: boolean
  ms: number
}

export interface StreamFoldOptions {
  /** Checked after every read; true ends the fold there. */
  aborted?: () => boolean
}

/** The fold fields that outlive a process (daemon-fold.ts FoldState). */
interface SpanningFold {
  v: number
  cronIds?: Record<string, 1>
  wakeupAt?: number
}

export function createStreamFold<F extends SpanningFold, T>(deps: StreamFoldDeps<F, T>) {
  const fs = deps.fs
  const fsp = deps.fs.promises
  const CHUNK = deps.chunkBytes && deps.chunkBytes > 0 ? deps.chunkBytes : 256 * 1024
  const PROGRESS_BYTES = deps.progressBytes && deps.progressBytes > 0 ? deps.progressBytes : 256 * 1024 * 1024
  const ROTATE_BYTES = typeof deps.rotateBytes === 'number' && deps.rotateBytes >= 0 ? deps.rotateBytes : 256 * 1024 * 1024
  const TASK_MARKER = Buffer.from('"task_')
  const log = deps.log || function () {}

  /** Fold every complete line of the file into both states, from the best checkpoint. */
  async function foldFile(jsonlPath: string, now: number, opts?: StreamFoldOptions): Promise<StreamFoldResult<F, T>> {
    const t0 = deps.now()
    const aborted = (opts && opts.aborted) || function () { return false }
    const ck = deps.checkpoint.load(jsonlPath)
    // Both states resume from the checkpoint only together, so one pass serves both.
    const resume = ck && ck.task ? ck : null
    let fold = resume ? resume.fold : deps.initialFoldState(0)
    const task = resume && resume.task ? deps.checkpoint.restampTaskState(resume.task, now) : deps.emptyTaskState()
    const from = resume ? resume.boundary : 0
    let v = from
    let checkpointV = resume ? resume.boundary : 0
    let stopped = false
    let fh: import('node:fs/promises').FileHandle | null = null
    try {
      fh = await fsp.open(jsonlPath, 'r')
    } catch {
      return { fold: deps.initialFoldState(0), task: deps.emptyTaskState(), boundary: 0, from: 0, checkpointV: 0, aborted: false, ms: deps.now() - t0 }
    }
    const foldOne = (bytes: Buffer, lineEnd: number) => {
      const line = bytes.toString('utf-8')
      if (!line.trim()) return
      fold = deps.foldLine(fold, line, lineEnd)
      // Byte pre-filter first: almost no line is a task line.
      if (bytes.includes(TASK_MARKER) && line.includes('"task_')) {
        try { deps.applyTaskEvent(task, JSON.parse(line), lineEnd, now) } catch { /* not a task event */ }
      }
    }
    let epoch: string | null = null
    try {
      const st = await fh.stat()
      epoch = st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs)
      const buf = Buffer.alloc(CHUNK)
      let filePos = from
      // The line still being assembled, as copied pieces: a newline is looked
      // for only in new bytes, so a long line costs its length, not its square.
      let parts: Buffer[] = []
      let partsLen = 0
      let discardThroughNextNewline = false
      for (;;) {
        const { bytesRead: n } = await fh.read(buf, 0, CHUNK, filePos)
        if (n <= 0) break
        filePos += n
        const bytes = buf.subarray(0, n)
        let start = 0
        for (;;) {
          const nl = bytes.indexOf(10, start)
          if (nl === -1) break
          v += partsLen + (nl - start) + 1
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else if (partsLen) foldOne(Buffer.concat([...parts, bytes.subarray(start, nl)]), v)
          else foldOne(bytes.subarray(start, nl), v)
          parts = []
          partsLen = 0
          start = nl + 1
        }
        if (start < n) {
          // Copy the torn tail: `buf` is reused by the next read.
          parts.push(Buffer.from(bytes.subarray(start)))
          partsLen += n - start
          if (partsLen > deps.maxLineBytes) {
            log('error', 'fold carry overflow, dropping oversized partial line', {
              jsonlPath, carryBytes: partsLen, cap: deps.maxLineBytes, filePos,
            })
            v = filePos
            parts = []
            partsLen = 0
            discardThroughNextNewline = true
          }
        }
        if (fold.v - checkpointV >= PROGRESS_BYTES && deps.checkpoint.write(jsonlPath, fold, task, epoch)) checkpointV = fold.v
        if (aborted()) { stopped = true; break }
      }
      // A trailing unterminated fragment stays unfolded: the watcher re-reads it.
    } catch (err) {
      // A partial fold is still monotone-safe: serve what we have.
      log('warn', 'stream fold read failed', { jsonlPath, error: (err as Error).message, boundary: v })
    } finally {
      try { await fh.close() } catch { /* already closed */ }
    }
    // Every fold ends on a complete line, so even a cut one is a valid checkpoint.
    if (fold.v > checkpointV && deps.checkpoint.write(jsonlPath, fold, task, epoch)) checkpointV = fold.v
    const ms = deps.now() - t0
    if (v - from >= PROGRESS_BYTES / 4 || stopped) log('info', 'stream folded', { jsonlPath, from, boundary: v, bytes: v - from, ms, aborted: stopped })
    return { fold, task, boundary: v, from, checkpointV, aborted: stopped, ms }
  }

  /** True when `<projects>/<any project>/<transcriptId>.jsonl` exists. */
  async function transcriptExists(projectsDirs: readonly string[], transcriptId: string): Promise<boolean> {
    const name = transcriptId + '.jsonl'
    for (const dir of projectsDirs) {
      let slugs: string[]
      try { slugs = await fsp.readdir(dir) } catch { continue }
      for (const slug of slugs) {
        try {
          const st = await fsp.stat(deps.path.join(dir, slug, name))
          if (st.isFile() && st.size > 0) return true
        } catch { /* not in this project */ }
      }
    }
    return false
  }

  /**
   * Why a resume should start a fresh stream file after folding this one,
   * or null to keep it. Call only once no process can write the file.
   */
  async function rotateReason(
    jsonlPath: string, transcriptId: string | null, projectsDirs: readonly string[], fold: F,
  ): Promise<{ size: number } | null> {
    if (!ROTATE_BYTES || !transcriptId) return null
    let size: number
    try { size = (await fsp.stat(jsonlPath)).size } catch { return null }
    if (size < ROTATE_BYTES) return null
    // An armed cron or wakeup is known only from this file's lines (the resumed
    // CLI revives it silently from its transcript), and the reapers read it from
    // the fold: a fresh file would forget it. Such a file waits for a later resume.
    const crons = fold.cronIds ? Object.keys(fold.cronIds).length : 0
    if (crons > 0 || (typeof fold.wakeupAt === 'number' && fold.wakeupAt > deps.now())) {
      log('info', 'stream rotation skipped', { jsonlPath, size, reason: 'cron-armed', crons })
      return null
    }
    if (!await transcriptExists(projectsDirs, transcriptId)) {
      log('info', 'stream rotation skipped', { jsonlPath, size, reason: 'no-transcript' })
      return null
    }
    return { size }
  }

  /**
   * Leave the old file and start an empty one under the same name (a new
   * inode). `sidecars` are removed with it (checkpoints, compaction mark).
   */
  function rotate(jsonlPath: string, sidecars: readonly string[]): boolean {
    try { fs.unlinkSync(jsonlPath) } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log('warn', 'stream rotation failed', { jsonlPath, error: (err as Error).message })
        return false
      }
    }
    for (const f of sidecars) { try { fs.unlinkSync(f) } catch { /* none */ } }
    try { fs.writeFileSync(jsonlPath, '', { mode: 0o600 }) } catch { /* the spawn's open creates it */ }
    return true
  }

  return { foldFile, transcriptExists, rotateReason, rotate, rotateBytes: ROTATE_BYTES }
}
