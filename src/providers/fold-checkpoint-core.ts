/**
 * Fold checkpoints: where a session's stream fold stood, so a daemon restart
 * resumes the fold instead of replaying the whole stream file.
 *
 * Why: every daemon start adopts each live CLI by folding its stream JSONL from
 * byte 0, twice (the snapshot fold and the background-task state), before the
 * daemon listens. On 2026-09-28 a 1.76 GB stream took 99s and the whole boot
 * 2.5 minutes; every local session was unreachable for that long and the
 * server, seeing no port file after 10s, kept starting daemons that could only
 * lose the instance lock. A deploy that changes daemon code restarts it, so
 * this happened on most deploy days.
 *
 * A checkpoint is `<stream>.jsonl.fold`:
 *   { v, epoch, boundary, tail, fold, task }
 * `boundary` is the fold's own `v` (the end of the last complete line folded),
 * `epoch` is the stream file's identity (dev:ino:birthtime, the daemon's
 * streamEpoch), and `tail` hashes the bytes just before `boundary`. A load
 * accepts it only while the file is the same incarnation, still reaches the
 * boundary, and holds the same bytes there, so resuming is exactly the full
 * fold: the fold is a pure reducer over an append-only file. Anything else
 * (another file, a rewrite, a torn or foreign checkpoint) reads as "no
 * checkpoint" and the caller folds from byte 0 as before.
 *
 * Written best effort, atomically (temp file + rename), for streams of at
 * least MIN_BYTES: at graceful shutdown, when a session dies, and periodically
 * while it grows. Never throws.
 *
 * How each twin gets it: daemon-standalone.ts imports createFoldCheckpoint;
 * daemon-source.ts inlines `createFoldCheckpoint.toString()` through
 * `__CREATE_FOLD_CHECKPOINT__`. So the factory body references NOTHING at
 * module scope.
 */

/**
 * Checkpoint format, which also names the fold LOGIC that produced it. A
 * checkpoint holds the state the old foldLine/applyTaskEvent computed for its
 * prefix, so when that logic changes, old checkpoints must stop loading: bump
 * this (and FORMAT inside the factory, which cannot read module scope). A
 * ratchet in tests/providers/fold-checkpoint-core.test.ts pins the logic's text
 * to this number and fails until you decide.
 */
export const FOLD_CHECKPOINT_FORMAT = 1

export interface FoldCheckpointTaskState {
  tasks: Record<string, { t: number }>
  updatedAt: number
  recentTransitions: Array<{ t: number }>
}

export interface FoldCheckpointDeps {
  fs: typeof import('node:fs')
  createHash: typeof import('node:crypto').createHash
  pid: number
  log?: (level: 'info' | 'warn', msg: string, meta: Record<string, unknown>) => void
  /** Streams smaller than this fold fast enough; skip the write. */
  minBytes?: number
}

export function createFoldCheckpoint(deps: FoldCheckpointDeps) {
  const fs = deps.fs
  const FORMAT = 1
  const TAIL_BYTES = 4096
  const MIN_BYTES = typeof deps.minBytes === 'number' ? deps.minBytes : 8 * 1024 * 1024
  const log = deps.log || function () {}

  const pathFor = (jsonlPath: string): string => jsonlPath + '.fold'
  const epochOf = (st: { dev: number; ino: number; birthtimeMs: number }): string =>
    st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs)

  function tailHash(fd: number, boundary: number): string {
    const len = Math.min(TAIL_BYTES, boundary)
    const buf = Buffer.alloc(len)
    let got = 0
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, boundary - len + got)
      if (n <= 0) break
      got += n
    }
    return deps.createHash('sha1').update(buf.subarray(0, got)).digest('hex') + ':' + got
  }

  /** Persist where this fold stands. Returns true when a checkpoint was written. */
  function write(jsonlPath: string, fold: { v: number }, task: unknown, expectedEpoch?: string | null): boolean {
    const boundary = fold && typeof fold.v === 'number' ? fold.v : 0
    if (!(boundary >= MIN_BYTES)) return false
    let fd: number
    // No stream file (retention removed a cold one): nothing to describe.
    try { fd = fs.openSync(jsonlPath, 'r') } catch { return false }
    const target = pathFor(jsonlPath)
    const tmp = target + '.tmp-' + deps.pid
    try {
      const st = fs.fstatSync(fd)
      const epoch = epochOf(st)
      // The fold must describe THIS file: a recreated stream restarts offsets at 0.
      if (expectedEpoch && expectedEpoch !== epoch) return false
      if (st.size < boundary) return false
      const payload = JSON.stringify({ v: FORMAT, epoch, boundary, tail: tailHash(fd, boundary), fold, task })
      fs.writeFileSync(tmp, payload, { mode: 0o600 })
      fs.renameSync(tmp, target)
      return true
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* never written */ }
      log('warn', 'fold checkpoint write failed', { jsonlPath, error: (err as Error).message })
      return false
    } finally {
      try { fs.closeSync(fd) } catch { /* already closed */ }
    }
  }

  /** The checkpoint for this stream file when it still describes it, else null. */
  function load<F extends { v: number }, T>(jsonlPath: string): { boundary: number; fold: F; task: T | null } | null {
    let raw: string
    try { raw = fs.readFileSync(pathFor(jsonlPath), 'utf-8') } catch { return null }
    let fd: number | null = null
    try {
      const ck = JSON.parse(raw) as {
        v?: unknown; epoch?: unknown; boundary?: unknown; tail?: unknown; fold?: { v?: unknown }; task?: unknown
      }
      if (!ck || ck.v !== FORMAT || typeof ck.epoch !== 'string' || typeof ck.tail !== 'string') return null
      const boundary = ck.boundary
      if (typeof boundary !== 'number' || !Number.isSafeInteger(boundary) || boundary <= 0) return null
      if (!ck.fold || typeof ck.fold !== 'object' || ck.fold.v !== boundary) return null
      fd = fs.openSync(jsonlPath, 'r')
      const st = fs.fstatSync(fd)
      if (epochOf(st) !== ck.epoch || st.size < boundary) return null
      if (tailHash(fd, boundary) !== ck.tail) {
        log('warn', 'fold checkpoint does not match its stream file; folding from the start', { jsonlPath, boundary })
        return null
      }
      return { boundary, fold: ck.fold as F, task: ck.task && typeof ck.task === 'object' ? ck.task as T : null }
    } catch {
      return null
    } finally {
      if (fd !== null) { try { fs.closeSync(fd) } catch { /* already closed */ } }
    }
  }

  /**
   * A checkpoint's task state as a rebuild at `now` would produce it: a rebuild
   * stamps every task and transition with the rebuild time, so a resumed one
   * must too.
   */
  function restampTaskState<T extends FoldCheckpointTaskState>(task: T, now: number): T {
    for (const id of Object.keys(task.tasks || {})) task.tasks[id].t = now
    for (const tr of task.recentTransitions || []) tr.t = now
    task.updatedAt = Object.keys(task.tasks || {}).length > 0 ? now : 0
    return task
  }

  function discard(jsonlPath: string): void {
    try { fs.unlinkSync(pathFor(jsonlPath)) } catch { /* none */ }
  }

  return { write, load, restampTaskState, discard, pathFor, minBytes: MIN_BYTES }
}
