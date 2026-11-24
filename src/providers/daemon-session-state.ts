/**
 * Reading a session's state and files on this host: getState (the daemon-authoritative task state
 * and snapshot, and its cold rebuild from the stream file of a session no longer in memory), cron
 * supervision, the rename of a session's files to its real id, read-history, and the lookup of
 * delivery markers (marker-find-v1).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; its dispatcher answers these commands through what it returns. The code is the
 * runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { TaskState, SessionData, WsData, DaemonCronRuntime } from './daemon-session-types.js'
import { findDeliveryMarkers, validMarkerIds } from './marker-find-core.js'
import { foldLine, initialFoldState, assembleSnapshot, type FoldState, type SessionSnapshot } from './daemon-fold.js'
import type { createFoldCheckpoint } from './fold-checkpoint-core.js'
import type { createStreamCompact } from './stream-compact-core.js'
import type { createCronMetadataTracker } from './daemon-cron-metadata.js'
import type { DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonSessionStateDeps<W extends { data: WsData }> extends DaemonReplies<W> {
  STREAMS_DIR: string
  /** The disk rebuild's chunk, and the most a tailer carries of one unfinished line. */
  FOLD_REBUILD_CHUNK: number
  TAILER_CARRY_MAX: number
  sessions: Map<string, SessionData<W>>
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  foldCheckpoint: ReturnType<typeof createFoldCheckpoint>
  streamCompact: Pick<ReturnType<typeof createStreamCompact>, 'rewrittenFrom'>
  /** A follower reads only its own Walnut's sessions (follower-reads-core.ts). */
  followerReads: { ownerOf: (sid: string) => string | undefined }
  /** A renamed session's old id, for the agent gateway's callers. */
  gatewaySidAliases: Map<string, string>
  cronMetadata: Pick<ReturnType<typeof createCronMetadataTracker>, 'rename'>
  cronProcess: (session: SessionData<W>) => Parameters<ReturnType<typeof createCronMetadataTracker>['rename']>[2]
  applyTaskEvent: (ts: TaskState, parsed: Record<string, unknown>, v: number, now: number) => boolean
  emptyTaskState: () => TaskState
  assembleSessionSnapshot: (session: SessionData<W>) => SessionSnapshot
  pushSnapshot: (sid: string, immediate: boolean) => void
  persistRegistry: () => void
  /** The keep-alive verdict and the JSONL tailer (defined further down, so asked on use). */
  deriveSessionProtection: (session: SessionData<W>, sid: string, now: number) => unknown
  ensureWatcher: (sid: string) => void
  stopSessionWatcher: (sid: string) => void
  /** The runtime's timers. */
  setImmediate: typeof globalThis.setImmediate
  clearTimeout: typeof globalThis.clearTimeout
  logMsg: DaemonLog
}

export function createDaemonSessionState<W extends { data: WsData }>(deps: DaemonSessionStateDeps<W>) {
  const { STREAMS_DIR, FOLD_REBUILD_CHUNK, TAILER_CARRY_MAX, sessions, cronRuntime, foldCheckpoint, streamCompact, followerReads, gatewaySidAliases, cronMetadata, cronProcess, applyTaskEvent, emptyTaskState, assembleSessionSnapshot, pushSnapshot, persistRegistry, deriveSessionProtection, ensureWatcher, stopSessionWatcher, setImmediate, clearTimeout, logMsg, sendOk, sendError } = deps

  // ── L2: getState — daemon-authoritative background-task state (the PULL source of truth) ──
  // Returns the materialized task state plus process liveness. Walnut PULLs this to reconcile a
  // lost-terminal event: if the daemon (which persisted every event) says a task is terminal that
  // Walnut still has 'running', Walnut adopts the daemon's truth and completes the withheld turn —
  // no liveness guessing. If the session is unknown but its jsonl exists, rebuild from disk so a
  // post-restart PULL still returns truth.
  function cronSupervisionStatus(sid: string) {
    const record = cronRuntime()?.get(sid)
    if (!record) return null
    return {
      enabled: record.enabled, state: record.state, reason: record.reason,
      generation: record.generation, retryAt: record.retryAt, updatedAt: record.updatedAt,
    }
  }

  async function cmdCronSupervision(ws: W, id: number, cmd: Record<string, unknown>) {
    if (!cronRuntime()) return sendError(ws, id, 'cron supervision requires a managed daemon service')
    const sid = cmd.sid
    if (typeof sid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) return sendError(ws, id, 'cron.supervision: invalid sid')
    if (cmd.enabled !== undefined) {
      if (typeof cmd.enabled !== 'boolean') return sendError(ws, id, 'cron.supervision: enabled must be boolean')
      if (!cronRuntime()!.deliveryAllowed(sid, cmd.stopFence)) return sendError(ws, id, 'cron.supervision: request superseded by a stop')
      if (cmd.enabled) await cronRuntime()!.enable(sid, cmd.stopFence)
      else await cronRuntime()!.disable(sid)
    }
    return sendOk(ws, id, { cronSupervision: cronSupervisionStatus(sid) })
  }

  // ── Cold getState: a sid with no session in memory ──
  // The server pulls a stopped session's state every 5 minutes for a day, and
  // most dead streams have no fold checkpoint. So this disk rebuild folds both
  // states in one pass, hands the event loop back every COLD_STATE_SLICE_MS (the
  // external session scan's pattern), reads at most the newest
  // COLD_STATE_SCAN_MAX_BYTES, and is remembered until the stream file or its
  // checkpoint changes. The adopt/attach/resume rebuilds are separate: they seed
  // a live watcher and must stay exact.
  const COLD_STATE_SCAN_MAX_BYTES = 32 * 1024 * 1024
  const COLD_STATE_SLICE_MS = 8
  const COLD_STATE_MEMO_MAX = 64
  interface ColdState { state: FoldState; task: TaskState }
  const coldStateMemo = new Map<string, { key: string; result: Promise<ColdState> }>()

  function coldStateKey(jsonlPath: string, st: fs.Stats): string {
    let ck = 'none'
    try {
      const c = fs.statSync(foldCheckpoint.pathFor(jsonlPath))
      ck = c.size + ':' + c.mtimeMs
    } catch {}
    return st.ino + ':' + st.size + ':' + st.mtimeMs + ':' + ck
  }

  /** The rebuild of one stream file, shared by every caller until the file changes. */
  function coldState(jsonlPath: string, st: fs.Stats): Promise<ColdState> {
    const key = coldStateKey(jsonlPath, st)
    const hit = coldStateMemo.get(jsonlPath)
    coldStateMemo.delete(jsonlPath)
    const entry = hit && hit.key === key ? hit : { key, result: scanColdState(jsonlPath, st.size) }
    coldStateMemo.set(jsonlPath, entry)
    if (coldStateMemo.size > COLD_STATE_MEMO_MAX) coldStateMemo.delete(coldStateMemo.keys().next().value as string)
    return entry.result
  }

  async function scanColdState(jsonlPath: string, size: number): Promise<ColdState> {
    const startedAt = Date.now()
    const ck = foldCheckpoint.load<FoldState, TaskState>(jsonlPath)
    let from = ck && ck.task ? ck.boundary : 0
    const capped = size - from > COLD_STATE_SCAN_MAX_BYTES
    if (capped) from = size - COLD_STATE_SCAN_MAX_BYTES
    const resume = ck && ck.task && !capped ? ck : null
    let state = resume ? resume.fold : initialFoldState(0)
    const ts = resume && resume.task ? foldCheckpoint.restampTaskState(resume.task, startedAt) : emptyTaskState()
    // After a cap cut, start one byte early and drop through the first newline:
    // a cut that lands exactly on a line start keeps that line.
    let filePos = capped ? from - 1 : from
    let v = filePos
    let discardThroughNextNewline = capped
    let sliceStart = Date.now()
    let fd: number
    try { fd = fs.openSync(jsonlPath, 'r') } catch { return { state, task: ts } }
    try {
      const buf = Buffer.alloc(FOLD_REBUILD_CHUNK)
      let carry: Buffer = Buffer.alloc(0)
      while (filePos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(FOLD_REBUILD_CHUNK, size - filePos), filePos)
        if (n <= 0) break
        filePos += n
        const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        let start = 0
        for (;;) {
          const nl = chunk.indexOf(10, start)
          if (nl === -1) break
          v += (nl - start) + 1
          if (discardThroughNextNewline) discardThroughNextNewline = false
          else {
            const line = chunk.subarray(start, nl).toString('utf-8')
            if (line.trim()) {
              state = foldLine(state, line, v)
              if (line.includes('"task_')) {
                try { applyTaskEvent(ts, JSON.parse(line), v, startedAt) } catch {}
              }
            }
          }
          start = nl + 1
          if (Date.now() - sliceStart >= COLD_STATE_SLICE_MS) {
            await new Promise<void>((resolve) => setImmediate(resolve))
            sliceStart = Date.now()
          }
        }
        carry = Buffer.from(chunk.subarray(start))
        if (carry.length > TAILER_CARRY_MAX) {
          logMsg('error', 'cold rebuild carry overflow, dropping oversized partial line', {
            jsonlPath, carryBytes: carry.length, cap: TAILER_CARRY_MAX, filePos,
          })
          v = filePos
          carry = Buffer.alloc(0)
          discardThroughNextNewline = true
        }
      }
    } catch { /* a partial fold is still safe to serve */ } finally {
      try { fs.closeSync(fd) } catch {}
    }
    logMsg(capped ? 'warn' : 'info', 'getState: cold rebuild', {
      jsonlPath, size, from, capped, cap: COLD_STATE_SCAN_MAX_BYTES,
      fromCheckpoint: !!resume, ms: Date.now() - startedAt,
    })
    return { state, task: ts }
  }

  async function getStateFromDisk(ws: W, id: number, cmd: Record<string, unknown>, sid: string, cronSupervision: ReturnType<typeof cronSupervisionStatus>): Promise<void> {
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    let st: fs.Stats
    try { st = fs.statSync(jsonlPath) } catch { return sendOk(ws, id, { exists: false, cronSupervision }) }
    const coldFold = await coldState(jsonlPath, st)
    // The scan yields, so the session may have come alive meanwhile.
    if (sessions.has(sid)) return cmdGetState(ws, id, cmd)
    // The memo is shared: answer with a copy stamped now, as a rebuild would be.
    const taskState = foldCheckpoint.restampTaskState(JSON.parse(JSON.stringify(coldFold.task)) as TaskState, Date.now())
    // C1: disk-rebuild snapshot. No live process backs this sid (it would be in
    // the map), so it is dead, with no pendingCtrl and unknown pid/exitCode. The
    // epoch is stamped from the on-disk file so a pull against a dead session
    // still lets walnut detect a recreated file (incident 019a7fe5: this IS the
    // reconcile path).
    const snapshot = assembleSnapshot({
      foldState: coldFold.state,
      pendingCtrl: null,
      dead: true,
      pid: null,
      exitCode: null,
      streamEpoch: st.dev + ':' + st.ino + ':' + Math.floor(st.birthtimeMs),
      rewrittenFrom: streamCompact.rewrittenFrom(jsonlPath, st),
    })
    return sendOk(ws, id, { exists: true, alive: false, state: 'dead', taskState, snapshot, cronSupervision })
  }

  function cmdGetState(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid } = cmd as { sid: string }
    if (!sid) return sendError(ws, id, 'getState: missing sid')

    const cronSupervision = cronSupervisionStatus(sid)
    const session = sessions.get(sid)
    if (session) {
      return sendOk(ws, id, {
        exists: true,
        alive: session.state === 'running',
        state: session.state,
        taskState: session.taskState,
        cronSupervision,
        // The reaper's OWN keep-alive verdict, with its source — so what a
        // debugger sees here is exactly what the kill path will use.
        protection: deriveSessionProtection(session, sid, Date.now()),
        // C1: assembled on demand — the PULL half of snapshot flow.
        snapshot: assembleSessionSnapshot(session),
        // Whether the CLI is between turns as this daemon sees it, a line its own same-host delivery
        // wrote included (ttftSendTs: set at each write, cleared at that turn's first text or end).
        // The server's prompt respawn asks it right before its stop (sessions/prompt-refresh-respawn.ts).
        quiet: {
          turnActive: session.foldState?.turnActive === true,
          lineAwaitingAnswer: session.ttftSendTs != null,
          promptOpen: !!session.pendingCtrl,
        },
      })
    }
    if (cmd.memoryOnly === true) return sendOk(ws, id, { snapshotAvailable: false, cronSupervision })
    // Unknown in memory — rebuild from the durable jsonl if it exists (post-restart PULL).
    return getStateFromDisk(ws, id, cmd, sid, cronSupervision)
  }

  // ── Rename session files ──
  function cmdRename(ws: W, id: number, cmd: Record<string, unknown>) {
    const { oldSid, newSid } = cmd as { oldSid: string; newSid: string }
    if (!oldSid || !newSid) return sendError(ws, id, 'rename: missing oldSid or newSid')
    if (oldSid === newSid) return sendOk(ws, id, { renamed: true })

    const session = sessions.get(oldSid)
    if (!session) return sendError(ws, id, 'rename: session not found: ' + oldSid)

    // Derive from the session's ACTUAL file location, not STREAMS_DIR: a live
    // session spawned before the /tmp→HOME move still has its family in the
    // legacy dir (startup migration skips live pgids), and renaming against the
    // new dir would silently fail per-ext and then point jsonlPath at a
    // nonexistent file — the session would go deaf.
    const liveDir = path.dirname(session.jsonlPath)
    const oldBase = path.join(liveDir, oldSid)
    const newBase = path.join(liveDir, newSid)

    // C14: flush a pending coalesced snapshot BEFORE the re-key. pushSnapshot's
    // 50ms timer carries a generation guard (`sessions.get(sid) !== session`) that
    // is keyed on the OLD sid — after the delete/set below it can never match, so
    // the queued state change would be silently dropped and walnut would only
    // learn about it on the next 30s pull. Flush at the old sid (that is the sid
    // walnut's subscribers know right now) and clear the timer.
    if (session.snapshotTimer) {
      try { pushSnapshot(oldSid, true) } catch {}
      if (session.snapshotTimer) { clearTimeout(session.snapshotTimer); session.snapshotTimer = null }
    }

    try {
      for (const ext of ['.jsonl', '.jsonl.err', '.jsonl.fold', '.jsonl.fold.next', '.jsonl.lines', '.jsonl.compact', '.pipe', '.pgid', '.log']) {
        try { fs.renameSync(oldBase + ext, newBase + ext) } catch {}
      }
      session.jsonlPath = newBase + '.jsonl'
      session.pipePath = newBase + '.pipe'
      session.pgidPath = newBase + '.pgid'

      // The session-bound watcher's pollTimer closure captured the OLD sid and
      // looks up sessions.get(oldSid) each tick. After the re-key below, that
      // lookup returns undefined and the watcher silently stops fanning out
      // jsonl lines — users see the session "go deaf" mid-turn (UI stuck on
      // "Walnut is working…" until the whole session ends). Fix: stop the old
      // watcher before re-keying, then re-create it against the new sid so its
      // closure captures the right key. Subscribers stay put — they only hold
      // ws refs, not sid — so no re-attach is needed from the client side.
      stopSessionWatcher(oldSid)

      sessions.delete(oldSid)
      sessions.set(newSid, session)
      session.cronMetadataLoaded = cronMetadata.rename(oldSid, newSid, cronProcess(session))
      session.cronMetadataLoading = false
      persistRegistry()
      // Agent gateway: the CLI's WALNUT_SESSION_ID env still carries the OLD sid
      // (env is frozen at spawn). Record the alias so resolveCallerSid can chase
      // the chain to the current sid.
      gatewaySidAliases.set(oldSid, newSid)

      ensureWatcher(newSid)

      sendOk(ws, id, { renamed: true })
      logMsg('info', 'session renamed', { oldSid, newSid })
    } catch (err: unknown) {
      sendError(ws, id, 'rename failed: ' + (err as Error).message)
    }
  }

  // ── Read history ──
  // Most bytes one read-history reply carries, main and subagents together: the
  // same ceiling as the server's DaemonFileReader. A reply is one frame.
  const READ_HISTORY_MAX_BYTES = 32 * 1024 * 1024

  /** The newest `maxBytes` of a file; past a cut the partial first line is dropped. */
  function readTailWindow(filePath: string, maxBytes: number): { text: string; bytes: number; size: number; cut: boolean } {
    const st = fs.statSync(filePath)
    const start = Math.max(0, st.size - maxBytes)
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      const got = fs.readSync(fd, buf, 0, buf.length, start)
      let from = 0
      if (start > 0) {
        const nl = buf.subarray(0, got).indexOf(10)
        from = nl === -1 ? got : nl + 1
      }
      const kept = buf.subarray(from, got)
      return { text: kept.toString('utf-8'), bytes: kept.length, size: st.size, cut: start > 0 }
    } finally { fs.closeSync(fd) }
  }

  function cmdReadHistory(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, tailBytes } = cmd as { sid: string; tailBytes?: number }
    // A session id names a file in the streams dir and nothing else: the bridge
    // and a follower reach this command, and neither may read any other file.
    if (typeof sid !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sid) || sid.includes('..')) return sendError(ws, id, 'read-history: missing or invalid sid')
    // A follower reads its own Walnut's sessions only.
    if (ws.data?.origin === 'follower' && followerReads.ownerOf(sid) !== ws.data.followerHome) return sendError(ws, id, 'read-history: not a session of this Walnut on this host', { errorKind: 'not_found' })

    try {
      // Read main JSONL. tailBytes > 0 = tail-only read (mobile transcript):
      // whale sessions (10MB+) must not ride the bridge as one frame when the
      // caller only renders the last ~200 rows. Without tailBytes the reply is
      // still capped at READ_HISTORY_MAX_BYTES, served as the newest window and
      // flagged `truncated` with the file's `size`.
      let mainContent = ''
      let mainBytes = 0
      let mainSize = 0
      let truncated = false
      const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
      const wantTail = typeof tailBytes === 'number' && tailBytes > 0
      const windowBytes = wantTail ? Math.min(tailBytes as number, READ_HISTORY_MAX_BYTES) : READ_HISTORY_MAX_BYTES
      try {
        const main = readTailWindow(jsonlPath, windowBytes)
        mainContent = main.text
        mainBytes = main.bytes
        mainSize = main.size
        if (main.cut && (!wantTail || (tailBytes as number) > windowBytes)) truncated = true
      } catch {}

      // Read subagents (skipped on tail reads — transcripts are main-lane only)
      // from what the main file left of the cap.
      const subagents: Record<string, string> = {}
      if (!wantTail) {
        let budget = READ_HISTORY_MAX_BYTES - mainBytes
        const subagentDir = path.dirname(jsonlPath) + '/' + sid + '/subagents'
        try {
          const files = fs.readdirSync(subagentDir)
          for (const f of files) {
            if (f.endsWith('.jsonl')) {
              if (budget <= 0) { truncated = true; continue }
              try {
                const sub = readTailWindow(path.join(subagentDir, f), budget)
                subagents[f] = sub.text
                budget -= sub.bytes
                if (sub.cut) truncated = true
              } catch {}
            }
          }
        } catch {}
      }

      if (truncated) {
        logMsg('warn', 'read-history: reply capped', { sid, size: mainSize, cap: READ_HISTORY_MAX_BYTES })
        return sendOk(ws, id, { main: mainContent, subagents, truncated: true, size: mainSize })
      }
      sendOk(ws, id, { main: mainContent, subagents })
    } catch (err: unknown) {
      sendError(ws, id, 'read-history failed: ' + (err as Error).message)
    }
  }

  // ── Delivery-marker lookup (marker-find-v1) ──
  // Which of a session's phone messages reached its CLI: each delivery writes a
  // marker carrying the message id into the session's stream. The search runs
  // here, newest bytes first, so only the ids found cross the bridge
  // (marker-find-core.ts). `ordered`: this daemon writes a send's markers inside
  // the delivery (send-markers-v1).
  async function cmdMarkersFind(ws: W, id: number, cmd: Record<string, unknown>) {
    const sid = cmd.sid
    if (typeof sid !== 'string' || !sid || sid.includes('/') || sid.includes('\\') || sid.includes('..')) {
      return sendError(ws, id, 'markers.find: missing or invalid sid')
    }
    const ids = validMarkerIds(cmd.ids)
    if (typeof ids === 'string') return sendError(ws, id, ids)
    const file = sessions.get(sid)?.jsonlPath || path.join(STREAMS_DIR, sid + '.jsonl')
    try {
      const result = await findDeliveryMarkers(file, ids)
      sendOk(ws, id, { ...result, ordered: true })
    } catch (err) {
      sendError(ws, id, 'markers.find failed: ' + (err as Error).message)
    }
  }

  return { cmdCronSupervision, cmdGetState, cmdRename, cmdReadHistory, cmdMarkersFind }
}
