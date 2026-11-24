/**
 * Starting a stopped session again on this host, with the command it last ran: for a trigger
 * fire no server claimed (trigger-host-resume-v1), and for the bridge's resume, which builds the
 * argv itself so the public bridge never names a command (bridgeResume).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; the dispatcher answers bridgeResume through cmdBridgeResume, the offline host
 * calls resumeForTrigger, and the turn-error auto-retry resumes through cmdBridgeResume. The code
 * is the runtime's as it was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import { type SessionMode, MODE_CLI, type DaemonCore } from './daemon-core.js'
import { buildClaudeArgv } from './claude-session-argv.js'
import type { createHostResume } from './host-resume-core.js'
import type { SessionData, WsData, SessionGate, DaemonCronRuntime } from './daemon-session-types.js'
import type { DaemonCommand, DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonSessionResumeDeps<W extends { data: WsData }> extends Pick<DaemonReplies<W>, 'sendError'> {
  daemonEnv: DaemonEnv
  STREAMS_DIR: string
  sessions: Map<string, SessionData<W>>
  core: DaemonCore<SessionData<W>>
  hostResume: Pick<ReturnType<typeof createHostResume>, 'resumeArgs'>
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  sessionStartGate: SessionGate
  sessionStopVersions: Map<string, number>
  isJournalSid: (sid: unknown) => sid is string
  /** The session's stream is here, or the spawn journal names it. */
  livedHere: (sid: string) => boolean
  journaledHome: (sid: string) => string | undefined
  walnutOfHome: (home: string) => string
  spawnRecordOf: (sid: string) => { args: string[]; cwd: string; mode: string; home?: string } | null
  /** The uuid of a fire's line (the offline host's). */
  fireLineUuid: (messageId: string) => string
  startSessionProcess: (cmd: Record<string, unknown>, isCurrent?: () => boolean, canStart?: () => boolean) => Promise<unknown>
  cmdStart: DaemonCommand<W>
  cmdSend: DaemonCommand<W>
  /** The bridge link may operate that session (its Walnut's, not a host server's). */
  bridgeHearsSession: (client: W, sid: string) => boolean
  logMsg: DaemonLog
}

export function createDaemonSessionResume<W extends { data: WsData }>(deps: DaemonSessionResumeDeps<W>) {
  const { daemonEnv, STREAMS_DIR, sessions, core, hostResume, cronRuntime, sessionStartGate, sessionStopVersions, isJournalSid, livedHere, journaledHome, walnutOfHome, spawnRecordOf, fireLineUuid, startSessionProcess, cmdStart, cmdSend, bridgeHearsSession, logMsg, sendError } = deps

  // ── Host resume for a trigger fire (trigger-host-resume-v1) ──
  // A fire no server claimed whose task's session is stopped on this host: start
  // that session again with the fire as its first message, with the command it
  // last ran (resumeArgs). Proof first: the spawn journal names this Walnut as the
  // one that started it, and its transcript is here. At most two start at once,
  // one per session every 10 minutes (a CLI that dies at once is not started again
  // every minute), none while 20 sessions here are mid-turn.
  const HOST_RESUME_MAX_STARTING = 2
  const HOST_RESUME_COOLDOWN_MS = 10 * 60_000
  const HOST_RESUME_MAX_BUSY = 20
  let hostResumesStarting = 0
  const hostResumedAt = new Map<string, number>()

  async function resumeForTrigger(home: string, sid: string, text: string, messageId: string, taskId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!isJournalSid(sid)) return { ok: false, reason: 'not a session id' }
    // The journal's first line decides when it names a Walnut. A line backfilled
    // from the older ledger names none (every session started before 2026-09-26),
    // and then the Walnut that asked for its latest spawn decides (below).
    // livedHere first: it reads the journal again on a miss, so the owner below is the file's as it is now.
    if (!livedHere(sid)) return { ok: false, reason: 'no transcript of that session on this host' }
    const journaled = journaledHome(sid)
    if (journaled !== undefined && journaled !== walnutOfHome(home)) return { ok: false, reason: 'that session was started on this host for another Walnut' }
    // trigger-resume-once: a try of a fire that already reached the session (a daemon killed
    // after the write, before the ack mark) starts nothing: the stream and its write records
    // are on disk, so they say so across a restart (core.lineReachedBefore).
    const uuid = fireLineUuid(messageId)
    const went = await core.lineReachedBefore(path.join(STREAMS_DIR, sid + '.jsonl'), uuid, [messageId])
    if (went) {
      logMsg('info', 'trigger: the fire already reached that session; it is not resumed again', { sid, taskId, messageId, ...went })
      return { ok: true }
    }
    const now = Date.now()
    for (const [k, at] of hostResumedAt) if (now - at >= HOST_RESUME_COOLDOWN_MS) hostResumedAt.delete(k)
    if (hostResumedAt.has(sid)) return { ok: false, reason: 'this host resumed that session moments ago' }
    if (hostResumesStarting >= HOST_RESUME_MAX_STARTING) return { ok: false, reason: 'other sessions are starting on this host' }
    let busy = 0
    for (const s of sessions.values()) if (s.state === 'running' && s.foldState?.turnActive) busy++
    if (busy >= HOST_RESUME_MAX_BUSY) return { ok: false, reason: 'this host is busy' }
    const spawn = spawnRecordOf(sid)
    if (!spawn) return { ok: false, reason: 'no spawn record of that session on this host' }
    if (journaled === undefined && walnutOfHome(spawn.home ?? '') !== walnutOfHome(home)) return { ok: false, reason: 'this host has no record of starting that session for this Walnut' }
    if (!fs.existsSync(spawn.cwd)) return { ok: false, reason: 'its folder is gone from this host' }
    const args = hostResume.resumeArgs(spawn.args, sid, spawn.mode)
    hostResumedAt.set(sid, now)
    hostResumesStarting++
    const stopVersion = sessionStopVersions.get(sid) ?? 0
    const current = () => (sessionStopVersions.get(sid) ?? 0) === stopVersion
      && (!cronRuntime() || cronRuntime()!.deliveryAllowed(sid, undefined))
    try {
      await sessionStartGate.run(sid, async () => {
        if (!current()) throw new Error('a stop request superseded this start')
        // Started with no line, then the fire as one delivery, as the server's own resume
        // sends a marked message (deferMessage): its write record goes on disk before the
        // line's first byte and after its newline, and its turn-start marker (the CLI never
        // echoes stdin, so without one the fire never shows in the chat) sits before that
        // newline. So no crash point leaves a line the CLI can run with no record of it.
        await startSessionProcess({ cmd: 'start', sid, args, cwd: spawn.cwd, message: '', deferMessage: true, resume: true, mode: spawn.mode, origin: { home, task: taskId } }, undefined, current)
        const sent = await core.handleSendCommand(sid, text, uuid, [{ message: text, messageId }], { fromHost: true, bootWait: true })
        if (!('ok' in sent) || !sent.ok) {
          throw new Error('the fire did not go into the resumed session (' + String('reason' in sent ? sent.reason : (sent as { error?: string }).error) + ')')
        }
      })
      logMsg('info', 'trigger: resumed a stopped session on this host', { sid, taskId, messageId, mode: spawn.mode })
      return { ok: true }
    } catch (err) {
      logMsg('warn', 'trigger: host resume failed', { sid, taskId, messageId, error: (err as Error).message })
      return { ok: false, reason: (err as Error).message }
    } finally {
      hostResumesStarting--
    }
  }

  // ── Bridge-safe resume: respawn a dead session with --resume <sid> ──
  // Unlike `start` (which takes arbitrary argv from the caller — unsafe over
  // the public bridge), `bridgeResume` only accepts {sid, message, cwd?, model?}
  // and builds the argv itself: the session's last spawn command (spawnRecordOf,
  // turned into a resume of this sid by resumeArgs) or, when there is none, a
  // fixed default `claude --resume` command. Gated on the session's jsonl
  // existing in STREAMS_DIR, which proves the session genuinely lived on this
  // host, so a compromised cloud box still can't run arbitrary commands, only
  // wake conversations that were here.
  function cmdBridgeResume(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid, message, cwd: cwdHint, model } = cmd as {
      sid: string; message: string; cwd?: string; model?: string
    }
    if (!sid || !message) {
      return sendError(ws, id, 'bridgeResume: missing sid or message')
    }

    const session = sessions.get(sid)

    if (session && session.state === 'running' && cmd.autoRetry !== true) {
      // Already alive — just send the message directly.
      return cmdSend(ws, id, { cmd: 'send', sid, message, stopFence: cmd.stopFence })
    }

    // Proof of residence: its stream file, or the spawn journal once retention dropped the file.
    if (!livedHere(sid)) {
      return sendError(ws, id, 'bridgeResume: session not found: ' + sid)
    }
    // livedHere may have read the journal again: the session's Walnut is judged on what it read.
    if (ws.data?.origin === 'bridge' && !bridgeHearsSession(ws, sid)) {
      return sendError(ws, id, 'bridgeResume: a session of another Walnut', { errorKind: 'not_owner' })
    }

    const spawn = spawnRecordOf(sid)
    // cwd: the spawn record → caller's projection hint. --resume only finds the
    // conversation when the cwd matches the original, so a wrong hint just
    // yields a "No conversation found" turn error, not a security problem.
    // The folder it last ran in, unless that is gone and the server names another
    // (Walnut moved the session out of a deleted folder).
    const cwd = spawn && (fs.existsSync(spawn.cwd) || !cwdHint) ? spawn.cwd : cwdHint
    if (!cwd) {
      return sendError(ws, id, 'bridgeResume: no cwd known for session (record lost, no hint)')
    }

    const mode = spawn ? spawn.mode : (session?.mode ?? 'default')
    const args: string[] = spawn
      ? hostResume.resumeArgs(spawn.args, sid, mode)
      // The spawn record is lost: the same frame every session starts with (claude-session-argv.ts),
      // with no settings of its own (they were in the lost record).
      : buildClaudeArgv({
        command: 'claude',
        env: daemonEnv,
        session: ['--permission-mode', MODE_CLI[mode as SessionMode] || 'default', ...(model ? ['--model', model] : []), '--resume', sid],
        settings: {},
      })

    logMsg('info', 'bridgeResume: respawning dead session', {
      sid, cwd, recordLost: !spawn,
    })
    // cmdStart is async (FIFO write continuation) — return the promise so the
    // dispatcher's rejection handler owns any throw.
    return cmdStart(ws, id, {
      cmd: 'start',
      sid,
      args,
      cwd,
      message,
      resume: true,
      mode,
      stopFence: cmd.stopFence,
      autoRetry: cmd.autoRetry === true,
    })
  }

  return { resumeForTrigger, cmdBridgeResume }
}
