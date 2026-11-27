/**
 * A session's stream file on disk: the compaction of a stopped session's stream (its finished
 * turns' token deltas dropped once nothing wrote it for a while, the fold, task state and a
 * checkpoint re-seated on the new file), and the async stream fold with its rotation on resume
 * (a big file is folded without holding the thread, a huge one whose transcript exists starts
 * fresh), with the CLI's transcript dirs a rotation checks.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; Main runs the compaction sweep, and attach, resume and the transcript reads use
 * the async fold and the transcript dirs through what it returns. The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { foldLine, initialFoldState, type FoldState } from './daemon-fold.js'
import { createStreamCompact } from './stream-compact-core.js'
import { eachInBatches } from './daemon-core.js'
import { createStreamFold } from './stream-fold-core.js'
import type { CliOwner } from './cli-owner-core.js'
import type { DaemonSessionGate } from './daemon-cron-controller.js'
import type { createFoldCheckpoint } from './fold-checkpoint-core.js'
import type { SessionData, TaskState } from './daemon-session-types.js'
import type { DaemonEnv, DaemonLog } from './daemon-module-deps.js'

export interface DaemonStreamCompactionDeps<W extends object> {
  daemonEnv: DaemonEnv
  HOME_DIR: string
  STREAMS_DIR: string
  /** The longest line a fold carries (daemon-session-fold.ts). */
  TAILER_CARRY_MAX: number
  TASK_LINE_MARKER: Buffer
  sessions: Map<string, SessionData<W>>
  /** A spawn of a sid waits for the swap of its stream file. */
  sessionStartGate: DaemonSessionGate
  foldCheckpoint: ReturnType<typeof createFoldCheckpoint>
  emptyTaskState: () => TaskState
  applyTaskEvent: (ts: TaskState, parsed: Record<string, unknown>, v: number, now: number) => boolean
  isProcessGroupAlive: (pgid: number) => boolean
  /** One CLI per session id (made further down, so asked on use). */
  cliOwner: Pick<CliOwner, 'holderOf'>
  /** The session snapshot (daemon-session-snapshot.ts; made further down). */
  streamEpochOf: (session: SessionData<W>) => string | null
  pushSnapshot: (sid: string, immediate: boolean) => void
  logMsg: DaemonLog
}

export function createDaemonStreamCompaction<W extends object>(deps: DaemonStreamCompactionDeps<W>) {
  const { daemonEnv, HOME_DIR, STREAMS_DIR, TAILER_CARRY_MAX, TASK_LINE_MARKER, sessions, sessionStartGate, foldCheckpoint, emptyTaskState, applyTaskEvent, isProcessGroupAlive, cliOwner, streamEpochOf, pushSnapshot, logMsg } = deps

  // ── Stream compaction (stream-compact-core.ts) ──
  // A stopped session's stream file loses the token deltas of its finished turns
  // (about 60% of its bytes), once nothing has written it for IDLE_MS. The copy is
  // folded as it is written, so the swap re-seats the fold, the task state and a
  // fresh checkpoint for the new file at once, and a later resume reads from the
  // checkpoint instead of folding the file again. One file at a time, smallest
  // first. Env overrides are TEST-ONLY.
  const STREAM_COMPACT_IDLE_MS = parseInt(daemonEnv.WALNUT_STREAM_COMPACT_IDLE_MS || '', 10) || 30 * 60_000
  const STREAM_COMPACT_SWEEP_MS = parseInt(daemonEnv.WALNUT_STREAM_COMPACT_SWEEP_MS || '', 10) || 10 * 60_000
  const streamCompact = createStreamCompact({
    fs, now: Date.now, pid: process.pid, maxLineBytes: TAILER_CARRY_MAX,
    minBytes: parseInt(daemonEnv.WALNUT_STREAM_COMPACT_MIN_BYTES || '', 10) || undefined,
    chunkBytes: parseInt(daemonEnv.WALNUT_STREAM_COMPACT_CHUNK || '', 10) || undefined,
    log: (level, msg, meta) => logMsg(level, msg, meta),
  })
  let streamCompactRunning = false

  // ── Async stream fold + rotation on resume (stream-fold-core.ts) ──
  // A resume or a discovering attach folds the stream file without holding the
  // thread (2026-10-27: a 2.5 GB fold froze this daemon for 214 s), and a resume
  // of a file of STREAM_ROTATE_BYTES or more whose Claude transcript exists starts
  // a fresh file instead of reading it. The env override is TEST-ONLY.
  const streamRotateEnv = parseInt(daemonEnv.WALNUT_STREAM_ROTATE_BYTES || '', 10)
  const streamFold = createStreamFold<FoldState, TaskState>({
    fs, path, foldLine, initialFoldState, emptyTaskState, applyTaskEvent,
    checkpoint: foldCheckpoint, maxLineBytes: TAILER_CARRY_MAX, now: Date.now,
    log: (level, msg, meta) => logMsg(level, msg, meta),
    rotateBytes: Number.isFinite(streamRotateEnv) ? streamRotateEnv : undefined,
  })
  /** The CLI's config dir, as every CLI this daemon spawns inherits it (host-local transcript readers). */
  const CLAUDE_CONFIG_HOME = daemonEnv.CLAUDE_CONFIG_DIR || path.join(HOME_DIR, '.claude')
  /** Where the CLI keeps transcripts; a rotation needs the session's to exist. */
  const CLAUDE_PROJECTS_DIRS = Array.from(new Set([
    path.join(CLAUDE_CONFIG_HOME, 'projects'),
    path.join(HOME_DIR, '.claude', 'projects'),
  ]))
  const pidAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

  /** No process can write this stream file: the session is dead here and its group is gone. */
  function streamWriterGone(sid: string): boolean {
    const s = sessions.get(sid)
    if (s && (s.state !== 'dead' || (s.pid && isProcessGroupAlive(s.pid)))) return false
    try {
      const pid = parseInt(fs.readFileSync(path.join(STREAMS_DIR, sid + '.pgid'), 'utf-8').trim(), 10)
      if (Number.isInteger(pid) && pid > 1 && isProcessGroupAlive(pid)) return false
    } catch {}
    return true
  }

  async function compactIdleStreams(): Promise<void> {
    if (streamCompactRunning) return
    streamCompactRunning = true
    try {
      // The streams dir holds every session of the last 90 days: listed and stat'ed async, in
      // bounded batches that give the loop turns (daemon-core.ts eachInBatches), since this runtime
      // can share the web server's loop.
      let names: string[] = []
      try { names = await fs.promises.readdir(STREAMS_DIR) } catch { return }
      const now = Date.now()
      // Temp files a dead daemon left, and marks whose stream file is gone.
      streamCompact.sweepStale(STREAMS_DIR, pidAlive, names)
      const due: Array<{ sid: string; jsonlPath: string; size: number }> = []
      await eachInBatches(names.filter((f) => streamCompact.isStreamFile(f)), async (f) => {
        const sid = f.slice(0, -'.jsonl'.length)
        const jsonlPath = path.join(STREAMS_DIR, f)
        const st = await fs.promises.stat(jsonlPath)
        if (now - st.mtimeMs < STREAM_COMPACT_IDLE_MS) return
        if (!streamCompact.due(jsonlPath, st) || !streamWriterGone(sid)) return
        due.push({ sid, jsonlPath, size: st.size })
      })
      due.sort((a, b) => a.size - b.size)
      for (const c of due) await compactOneStream(c.sid, c.jsonlPath)
    } catch (err) {
      logMsg('warn', 'stream compaction sweep failed', { error: (err as Error).message })
    } finally {
      streamCompactRunning = false
    }
  }

  async function compactOneStream(sid: string, jsonlPath: string): Promise<void> {
    // A CLI this daemon does not know (no registry entry, no .pgid) may still
    // hold the file: the owner record and the process table say so.
    if (await cliOwner.holderOf(sid)) {
      logMsg('info', 'stream compaction skipped', { sid, reason: 'live-elsewhere' })
      return
    }
    const t0 = Date.now()
    let fold = initialFoldState(0)
    const task = emptyTaskState()
    const prepared = await streamCompact.compact(jsonlPath, {
      aborted: () => !streamWriterGone(sid),
      minDropBytes: streamCompact.minBytes / 4,
      // The same steps as rebuildFoldStateFromJsonl and rebuildTaskStateFromJsonl.
      onKeptLine: (buf, v) => {
        const line = buf.toString('utf-8')
        if (line.trim()) fold = foldLine(fold, line, v)
        if (buf.includes(TASK_LINE_MARKER) && line.includes('"task_')) {
          try { applyTaskEvent(task, JSON.parse(line), v, t0) } catch {}
        }
      },
    })
    if ('skipped' in prepared) {
      if (prepared.skipped === 'aborted' || prepared.skipped === 'line-too-long') logMsg('info', 'stream compaction skipped', { sid, reason: prepared.skipped })
      return
    }
    // The swap runs in the start gate: a spawn of this sid waits for it, and a
    // spawn that won the race leaves a changed file or a live session behind.
    await sessionStartGate.run(sid, async () => {
      if (!streamWriterGone(sid) || !streamCompact.commit(jsonlPath, prepared)) {
        streamCompact.discard(jsonlPath)
        logMsg('info', 'stream compaction skipped', { sid, reason: 'changed' })
        return
      }
      // A new inode: every offset restarted, so re-seat what the daemon holds.
      foldCheckpoint.discard(jsonlPath)
      const s = sessions.get(sid)
      if (s && s.jsonlPath === jsonlPath) {
        s.foldState = fold
        s.taskState = task
        s.rewrittenFrom = streamCompact.rewrittenFrom(jsonlPath, fs.statSync(jsonlPath))
        s.streamEpoch = null
        s.offset = fold.v
        if (s.watcher) s.watcher.offset = fold.v
        s.lastPushedSnapshot = null
        s.foldCheckpointV = foldCheckpoint.write(jsonlPath, fold, task, streamEpochOf(s)) ? fold.v : 0
        pushSnapshot(sid, true)
      } else {
        foldCheckpoint.write(jsonlPath, fold, task, null)
      }
      logMsg('info', 'stream compacted', {
        sid, before: prepared.size, after: prepared.after, droppedBytes: prepared.droppedBytes,
        droppedLines: prepared.droppedLines, ms: Date.now() - t0,
      })
    })
  }

  return { STREAM_COMPACT_IDLE_MS, STREAM_COMPACT_SWEEP_MS, streamCompact, streamFold, CLAUDE_CONFIG_HOME, CLAUDE_PROJECTS_DIRS, pidAlive, streamWriterGone, compactIdleStreams }
}
