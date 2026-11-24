/**
 * The commands on a session this host runs: attach (and the discovery of a session another daemon
 * left), the fate of a line, send, sendRaw, the turn-start marker, setMode and status. The FIFO
 * logic itself is daemon-core's (handleSendCommand and friends); these map it onto the replies.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; its dispatcher answers these commands through what it returns, and the
 * follower code changes a session's mode through applyModePolicy. The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { shouldAutoRespond, buildControlResponse, type SessionMode, type UserMarkerInput, lockLiveFifo, type DaemonCore } from './daemon-core.js'
import { Subscribers, type SessionData, type TaskState, type SessionGate, type SendOutcome, type DaemonCronRuntime } from './daemon-session-types.js'
import type { createStreamFold } from './stream-fold-core.js'
import type { FoldState } from './daemon-fold.js'
import type { CliOwner } from './cli-owner-core.js'
import type { HostResume } from './host-resume-core.js'
import type { DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonSessionCommandsDeps<W extends object> extends DaemonReplies<W> {
  STREAMS_DIR: string
  sessions: Map<string, SessionData<W>>
  core: DaemonCore<SessionData<W>>
  streamFold: Pick<ReturnType<typeof createStreamFold<FoldState, TaskState>>, 'foldFile'>
  sessionStartGate: SessionGate
  sessionStopVersions: Map<string, number>
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  cliOwner: Pick<CliOwner, 'adopt'>
  hostResume: Pick<HostResume, 'pinMode' | 'remember'>
  readStartTimeAsync: (pid: number) => Promise<string | null>
  reapSession: (sid: string, code: number, reason: string, groupExited?: boolean) => void
  startOrphanPoll: (sid: string) => void
  persistRegistry: () => void
  /** The turn-error auto-retry and the JSONL tailer (defined further down, so asked on use). */
  cancelTurnRetry: (sid: string, reason: string) => void
  addSubscriber: (ws: W, sid: string, fromOffset: number) => boolean
  logMsg: DaemonLog
}

export function createDaemonSessionCommands<W extends object>(deps: DaemonSessionCommandsDeps<W>) {
  const { STREAMS_DIR, sessions, core, streamFold, sessionStartGate, sessionStopVersions, cronRuntime, cliOwner, hostResume, readStartTimeAsync, reapSession, startOrphanPoll, persistRegistry, cancelTurnRetry, addSubscriber, logMsg, sendOk, sendError } = deps

  // ── Attach to existing session ──
  // An attach for a sid this daemon does not hold: build its session from the
  // stream file another daemon left.
  async function discoverSessionFromFiles(sid: string, mode: string | undefined): Promise<SessionData<W>> {
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')
    const pipePath = path.join(STREAMS_DIR, sid + '.pipe')

    const discovered = await streamFold.foldFile(jsonlPath, Date.now())
    let pid: number | null = null
    let alive = false
    try {
      pid = parseInt(fs.readFileSync(pgidPath, 'utf-8').trim(), 10)
      process.kill(pid, 0) // check alive
      alive = true
    } catch { pid = null; alive = false }

    // A FIFO an earlier daemon made may still be readable (LIVE_FIFO_MODE).
    if (alive) lockLiveFifo(fs, pipePath)
    const session: SessionData<W> = {
      proc: null,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      // Watcher starts at the fold rebuild's COMPLETE-line boundary — same rule
      // as adopt. Catch-up for [fromOffset, end) is addSubscriber's job (it reads
      // the file directly). Using the client's fromOffset here is wrong both
      // ways: 0 re-fans the whole file; MAX_SAFE_INTEGER (future-only
      // sentinel) freezes the watcher forever (stat.size <= offset). And a raw
      // stat().size would sit mid-line whenever the CLI is writing during
      // attach — the rebuild consumed the fragment's first half, so the
      // completed line would never be folded whole (contract §4 boundary rule).
      offset: discovered.boundary,
      taskState: discovered.task,
      foldState: discovered.fold,
      foldCheckpointV: discovered.checkpointV,
      watcher: null,
      subscribers: new Subscribers(),
      exitCode: alive ? null : 0,
      state: alive ? 'running' : 'dead',
      exitReason: alive ? null : 'attach-discovered-dead',
      exitedAt: alive ? null : Date.now(),
      parented: false,  // discovered, not spawned
      startTime: pid && alive ? await readStartTimeAsync(pid) : null,
      cwd: '',
      args: [],
      orphanPollTimer: null,
      mode: (mode as SessionMode) || 'default',
      pendingCtrl: null,
    }
    sessions.set(sid, session)
    if (alive && pid) {
      // Discovered an orphan — start the 1s tight poll so we detect death
      // within a second (Phase D, layer 3.2).
      startOrphanPoll(sid)
      void cliOwner.adopt(sid, pid, session.startTime ?? null)
    }
    return session
  }

  async function cmdAttach(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, fromOffset, mode } = cmd as { sid: string; fromOffset?: number; mode?: string }
    if (!sid) return sendError(ws, id, 'attach: missing sid')

    let session = sessions.get(sid)

    if (!session) {
      // Try to discover from files
      if (!fs.existsSync(path.join(STREAMS_DIR, sid + '.jsonl'))) {
        return sendError(ws, id, 'attach: session not found: ' + sid)
      }
      // The fold is async (a big file must not hold the thread), so it runs in
      // the start gate: a start or send of this sid waits for it, and a second
      // attach finds the session the first one made.
      session = await sessionStartGate.run(sid, async () => sessions.get(sid) ?? await discoverSessionFromFiles(sid, mode))
    }
    // Update mode if provided (walnut re-sends mode on reconnect)
    if (mode && session.state === 'running') {
      session.mode = mode as SessionMode
    }

    const offset = fromOffset || 0
    // Hot-path fresh check to avoid lying to a client whose prior daemon state
    // is stale (race with reaper/SIGCHLD).
    let alive = session.state === 'running' && session.pid !== null
    if (alive && session.pid) {
      try { process.kill(session.pid, 0) } catch {
        reapSession(sid, -1, 'attach-kill-check')
        alive = false
      }
    }

    // Subscribe this ws to the session-bound watcher. Does NOT create a new
    // watcher if one exists. Catches up from fromOffset to the watcher's
    // current offset so reconnecting clients see no gap.
    if (alive) addSubscriber(ws, sid, offset)

    sendOk(ws, id, {
      pid: session.pid,
      alive,
      state: session.state,
      exitCode: session.exitCode,
      outputFile: session.jsonlPath,
      currentOffset: session.watcher ? session.watcher.offset : 0,
      pendingCtrl: session.pendingCtrl,
    })
  }

  // Read-only recovery query. Not reachable from bridge, follower or lane sockets.
  async function cmdLineFate(ws: W, id: number, cmd: Record<string, unknown>) {
    sendOk(ws, id, await core.handleLineFateQuery(cmd.sid, cmd.uuid, cmd.messageIds) as unknown as Record<string, unknown>)
  }

  // ── Send message ──
  // Logic lives in daemon-core.handleSendCommand (strict-ack). This wrapper
  // only maps the SendResult envelope onto the WS reply format.
  async function cmdSend(ws: W, id: number, cmd: Record<string, unknown>) {
    const sid = cmd.sid as string
    if (!sid) return sendError(ws, id, 'send: missing sid')
    const stopVersion = sessionStopVersions.get(sid) ?? 0
    return sessionStartGate.run(sid, () => {
      if ((sessionStopVersions.get(sid) ?? 0) !== stopVersion || (cronRuntime() && !cronRuntime()!.deliveryAllowed(sid, cmd.stopFence))) {
        return sendOk(ws, id, { ok: false, reason: 'session_stopped' })
      }
      return sendSessionMessage(ws, id, cmd)
    })
  }

  async function sendSessionMessage(ws: W, id: number, cmd: Record<string, unknown>) {
    // `uuid` (optional): the pre-assigned v4 uuid the client wants the CLI to
    // persist this user line under. Older clients never send it and the envelope is
    // then unchanged.
    const { sid, message, uuid } = cmd as { sid: string; message: string; uuid?: string }
    // markers (send-markers-v1): the daemon writes them between the body and the newline; core validates them.
    const markers = (cmd as { markers?: UserMarkerInput[] }).markers
    cancelTurnRetry(sid, 'superseded-by-send')
    // dedupe (send-dedupe-v1): a resend after an unanswered send; core writes it only if this CLI lacks it.
    // lostPid (send-lost-line-v1): the server proved this CLI read past the line; core writes it again.
    // bootWait (send-boot-wait-v1): the first line after a start; a CLI still booting gets until its boot deadline.
    const result = await core.handleSendCommand(sid, message, typeof uuid === 'string' ? uuid : undefined, markers, { dedupe: cmd.dedupe === true, lostPid: typeof cmd.lostPid === 'number' ? cmd.lostPid : null, bootWait: cmd.bootWait === true, answers: cmd.answers === true })
    // `written`: how much of the line went in before the write failed (daemon-core.ts SendResult).
    if ('error' in result) return sendError(ws, id, result.error, result.written ? { written: result.written } : undefined)
    sendOk(ws, id, result as unknown as Record<string, unknown>)
  }

  // ── Send raw (permission-prompt-tool control_response passthrough) ──
  // Same strict-ack protocol as cmdSend; the FIFO receives `raw` verbatim.
  async function cmdSendRaw(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, raw } = cmd as { sid: string; raw: string }
    const result = await core.handleSendRawCommand(sid, raw)
    if ('error' in result) return sendError(ws, id, result.error)
    sendOk(ws, id, result as unknown as Record<string, unknown>)
  }

  // ── Append turn-start user marker to the stream file ──
  // Logic lives in daemon-core.handleAppendUserMarker.
  function cmdAppendUserMarker(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, message, messageId } = cmd as { sid: string; message: string; messageId: string }
    const result = core.handleAppendUserMarker(sid, message, messageId)
    if ('error' in result) return sendError(ws, id, result.error)
    sendOk(ws, id, result as unknown as Record<string, unknown>)
  }

  // ── Set session mode ──
  function cmdSetMode(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, mode } = cmd as { sid: string; mode: string }
    if (!sid || !mode) return sendError(ws, id, 'setMode: missing sid or mode')
    const session = sessions.get(sid)
    if (!session) return sendError(ws, id, 'setMode: session not found: ' + sid)
    const oldMode = session.mode
    applyModePolicy(session, sid, mode as SessionMode)
    sendOk(ws, id, { oldMode, newMode: mode })
  }

  /** The session's auto-answer policy follows its mode; a prompt the new mode allows is answered now. */
  function applyModePolicy(session: SessionData<W>, sid: string, mode: SessionMode): void {
    session.mode = mode
    // A chosen mode survives a resume (host-resume-core.ts pinMode).
    if (session.args.length > 0) session.args = hostResume.pinMode(session.args, mode)
    if (session.args.length > 0 && session.cwd) {
      hostResume.remember(sid, { args: session.args, cwd: session.cwd, mode, home: session.spawnInfo?.home, task: session.spawnInfo?.task })
    }
    if (session.pendingCtrl && shouldAutoRespond(session.mode, session.pendingCtrl.toolName)) {
      const resp = buildControlResponse(session.pendingCtrl.reqId, session.pendingCtrl.request, true)
      const toolName = session.pendingCtrl.toolName
      void core.handleSendRawCommand(sid, resp).then((result: SendOutcome) => {
        logMsg(result.ok ? 'info' : 'warn', 'setMode: pending control_response delivery', { sid, tool: toolName, mode, result })
      })
    }
    try { persistRegistry() } catch {}
  }

  // ── Status ──
  function cmdStatus(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, includeArgs } = cmd as { sid: string; includeArgs?: boolean }
    if (!sid) return sendError(ws, id, 'status: missing sid')

    const session = sessions.get(sid)
    if (!session) return sendOk(ws, id, { exists: false })

    // If daemon already reaped it, trust that — don't go back to kill(pid,0).
    let alive = session.state === 'running'
    if (alive && session.pid) {
      // Hot-path verification: daemon may not have seen SIGCHLD yet for a
      // just-died parented session. A fresh kill(pid,0) closes that window.
      try { process.kill(session.pid, 0) } catch {
        reapSession(sid, -1, 'status-kill-check')
        alive = false
      }
    }

    let mtime: string | null = null, size = 0
    try {
      const stat = fs.statSync(session.jsonlPath)
      mtime = stat.mtime.toISOString()
      size = stat.size
    } catch {}

    sendOk(ws, id, {
      exists: true,
      alive,
      pid: session.pid,
      mtime,
      size,
      // send-markers-v1: a send's markers are written inside its delivery, so a
      // caller may hand them over with the send (direct-host-send.ts).
      sendMarkers: true,
      state: session.state,
      exitCode: session.exitCode,
      exitReason: session.exitReason,
      pendingCtrl: session.pendingCtrl,
      // Opt-in: the argv the live process was launched with (a fork copies it to
      // reproduce the parent's prompt-cache prefix). Off by default because the
      // health monitor polls status for every session and the argv carries the
      // multi-KB --append-system-prompt.
      ...(includeArgs && session.args && session.args.length > 0 ? { args: session.args } : {}),
    })
  }

  return { cmdAttach, cmdLineFate, cmdSend, sendSessionMessage, cmdSendRaw, cmdAppendUserMarker, cmdSetMode, applyModePolicy, cmdStatus }
}
