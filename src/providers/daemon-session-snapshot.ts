/**
 * A session's snapshot: the C18 synchronous pre-death fold drain (the CLI's last lines folded
 * and delivered before its exit event), the fold of a byte range of its stream, the stream
 * file's identity (its epoch), and the snapshot itself: assembled from the pure fold and the
 * daemon's own facts, pushed to the session's subscribers in a 50ms coalesce window (a death
 * snapshot at once).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; daemon-core's reap runs the drain, and the tailer, getState, the fold
 * checkpoint and the stop code read the epoch and push the snapshot through what it returns.
 * The code is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import { foldLine, assembleSnapshot, snapshotDiffers, type SessionSnapshot } from './daemon-fold.js'
import type { SessionData, TaskState } from './daemon-session-types.js'
import type { DaemonLog, DaemonSendEvent } from './daemon-module-deps.js'

export interface DaemonSessionSnapshotDeps<W extends { readyState: number }> {
  /** The read size of a fold over a stream (daemon-standalone.ts). */
  FOLD_REBUILD_CHUNK: number
  /** The window in which snapshot pushes coalesce. */
  SNAPSHOT_COALESCE_MS: number
  /** The longest partial line a fold carries before it drops it. */
  TAILER_CARRY_MAX: number
  sessions: Map<string, SessionData<W>>
  /** The L2 task-state step the tailer runs on a `task_` line. */
  applyTaskEvent: (ts: TaskState, parsed: Record<string, unknown>, v: number, now: number) => boolean
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  logMsg: DaemonLog
  sendEvent: DaemonSendEvent<W>
}

export function createDaemonSessionSnapshot<W extends { readyState: number }>(deps: DaemonSessionSnapshotDeps<W>) {
  const { FOLD_REBUILD_CHUNK, SNAPSHOT_COALESCE_MS, TAILER_CARRY_MAX, sessions, applyTaskEvent, setTimeout, clearTimeout, logMsg, sendEvent } = deps

  // ── C18: synchronous pre-death fold drain ──
  // The CLI writes its final `result` + companion `idle` lines microseconds before
  // exiting, and the tailer's 100ms poll does nothing once `state !== 'running'`
  // (reapSession flips that first). Without this drain the death snapshot — and
  // every later getState pull, which just re-assembles the same frozen fold —
  // reports turnActive=true for a turn that provably ended on disk.
  //
  // Reads from the last complete-line boundary the watcher published (its in-memory
  // carry died with it, so the torn region is simply re-read) to EOF, folds every
  // COMPLETE line, and re-publishes the boundary. Bounded by the same carry cap.
  // Before the exit event clears subscribers, re-send the complete lines the watcher has not delivered yet.
  function drainSessionFold(session: SessionData<W>, sid: string): void {
    const from = session.watcher ? session.watcher.offset : (session.offset || 0)
    let size = 0
    try { size = fs.statSync(session.jsonlPath).size } catch { return }
    if (size <= from) return
    const boundary = drainFoldRange(session, from, size, (line, v) => {
      // Task state reads the same lines the fold does (the tailer's L2 step), so a
      // checkpoint of both at foldState.v describes the same bytes.
      if (line.includes('"task_')) {
        try { applyTaskEvent(session.taskState, JSON.parse(line), v, Date.now()) } catch {}
      }
      for (const ws of session.subscribers) {
        if (ws.readyState === 1) {
          try { sendEvent(ws, 'jsonl', { sid, line, v }) } catch {}
        } else {
          session.subscribers.delete(ws)
        }
      }
    })
    session.offset = boundary
    if (session.watcher) session.watcher.offset = boundary
  }

  // Fold [from, to) into session.foldState, honoring the `v > foldState.v` guard
  // (bytes already folded out-of-band must not fold twice). Returns the new
  // complete-line boundary.
  // The fold may run ahead of delivery, so onLine is not bounded by foldState.v.
  function drainFoldRange(session: SessionData<W>, from: number, to: number, onLine?: (line: string, v: number) => void): number {
    let boundary = from
    let fd: number
    try { fd = fs.openSync(session.jsonlPath, 'r') } catch { return boundary }
    try {
      const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
      let filePos = from
      let carry: Buffer = Buffer.alloc(0)
      let discardThroughNextNewline = false
      while (filePos < to) {
        const want = Math.min(FOLD_REBUILD_CHUNK, to - filePos)
        const n = fs.readSync(fd, buf, 0, want, filePos)
        if (n <= 0) break
        filePos += n
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        let start = 0
        for (;;) {
          const nl = chunk.indexOf(10, start)
          if (nl === -1) break
          boundary += (nl - start) + 1
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else {
            const line = chunk.subarray(start, nl).toString('utf-8')
            if (line.trim()) {
              if (boundary > session.foldState.v) {
                session.foldState = foldLine(session.foldState, line, boundary)
              }
              if (onLine) { try { onLine(line, boundary) } catch {} }
            }
          }
          start = nl + 1
        }
        carry = Buffer.from(chunk.subarray(start))
        if (carry.length > TAILER_CARRY_MAX) {
          logMsg('error', 'fold drain carry overflow — dropping oversized partial line', {
            jsonlPath: session.jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
          })
          boundary = filePos
          carry = Buffer.alloc(0)
          discardThroughNextNewline = true
        }
      }
    } catch { /* partial drain is still monotone-safe */ } finally {
      try { fs.closeSync(fd) } catch {}
    }
    return boundary
  }

  // Stream-file identity: dev:ino:birthtimeMs. Changes exactly when the FILE is
  // recreated (reboot wiped /tmp, manual delete) — the event that resets v to 0
  // and invalidates every consumer-side watermark. Cached on the session; a
  // failed stat leaves null (walnut treats null as "epoch unknown, no reset").
  function streamEpochOf(session: SessionData<W>): string | null {
    if (session.streamEpoch) return session.streamEpoch
    try {
      const st = fs.statSync(session.jsonlPath)
      session.streamEpoch = `${st.dev}:${st.ino}:${Math.floor(st.birthtimeMs)}`
    } catch {
      session.streamEpoch = null
    }
    return session.streamEpoch
  }

  // Combine the pure fold with imperatively-tracked daemon facts. exitCode is
  // already normalized by reapSession (isTurnCompleteExit) by the time state
  // flips to 'dead'.
  function assembleSessionSnapshot(session: SessionData<W>): SessionSnapshot {
    const ctrl = session.pendingCtrl
    const snap = assembleSnapshot({
      rewrittenFrom: session.rewrittenFrom,
      foldState: session.foldState,
      pendingCtrl: ctrl
        ? { requestId: ctrl.reqId, toolName: ctrl.toolName, sinceTs: ctrl.receivedAt }
        : null,
      dead: session.state === 'dead',
      pid: session.pid,
      exitCode: session.exitCode,
      streamEpoch: streamEpochOf(session),
    })
    // Disk-side durable crons arm cronActive too (fold only sees CronCreate in
    // THIS stream file — blind after wipe/--resume/adoption). One-way OR: the
    // walnut health monitor treats snapshot cronActive as arm-only, so a stale
    // cache never *unarms* anything. Cache is filled by the idle scan (60s).
    if (!snap.cronActive && session.diskCronCache && session.diskCronCache.armed) snap.cronActive = true
    return snap
  }

  // snapshotDiffers (the change-compare that ignores a bare v advance) is
  // imported from daemon-fold.ts — it is pure + zero-dep, so it rides the same
  // injection path into the source template instead of being hand-mirrored there.

  function emitSnapshot(sid: string, session: SessionData<W>): void {
    const snapshot = assembleSessionSnapshot(session)
    const prev = session.lastPushedSnapshot
    if (prev && !snapshotDiffers(prev, snapshot)) return
    session.lastPushedSnapshot = snapshot
    for (const ws of session.subscribers) {
      if (ws.readyState === 1) {
        try { sendEvent(ws, 'snapshot', { sid, snapshot }) } catch {}
      }
    }
  }

  // Push entry point: coalesce within a 50ms window; death snapshots skip the
  // coalesce (immediate=true) so a dead session is never reported late.
  function pushSnapshot(sid: string, immediate: boolean): void {
    const session = sessions.get(sid)
    if (!session) return
    if (immediate) {
      if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null }
      emitSnapshot(sid, session)
      return
    }
    if (session.snapshotTimer) return // window already open — coalesce
    session.snapshotTimer = setTimeout(() => {
      session.snapshotTimer = null
      // Generation guard: cmdStart may have replaced the session under this sid.
      if (sessions.get(sid) !== session) return
      emitSnapshot(sid, session)
    }, SNAPSHOT_COALESCE_MS)
  }

  return { drainSessionFold, drainFoldRange, streamEpochOf, assembleSessionSnapshot, emitSnapshot, pushSnapshot }
}
