/**
 * Stopping a session this host runs: the stop command (owner-home-v1's proof of who may stop it,
 * the orphan stop's first-hand proofs, the idle stop's supervision re-check) and the process stop
 * itself (stopSessionProcess): the process identity proved before every signal, the intent
 * stamped before the first one, SIGINT then SIGTERM, the registry written before the answer.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; its dispatcher answers `stop` through cmdStop, and the budget pause, the
 * follower code and the cleanup stop through what it returns. The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import { argvNamesSession, clearTurnRetryStreak } from './daemon-core.js'
import type { createCliArgvFiles } from './cli-argv-files-core.js'
import type { SessionData, SessionGate, DaemonCronRuntime } from './daemon-session-types.js'
import type { DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonSessionStopDeps<W extends object> extends DaemonReplies<W> {
  SERVICE_MODE: boolean
  /** The idle scanner's limits (defined further down, so asked on use). */
  SESSION_IDLE_WARNING_MS: () => number
  SESSION_IDLE_KILL_MS: () => number
  sessions: Map<string, SessionData<W>>
  cliArgvFiles: Pick<ReturnType<typeof createCliArgvFiles>, 'namesIn'>
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  /** This boot's id, once known. */
  daemonBootId: () => string | undefined
  sessionStartGate: SessionGate
  sessionStopVersions: Map<string, number>
  journaledHome: (sid: string) => string | undefined
  journaledIds: () => Set<string>
  walnutOfHome: (home: string) => string
  servedStopRefusal: (sid: string, home: string) => { reason: string; detail?: string } | null
  isProcessGroupAlive: (pgid: number) => boolean
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => unknown
  readStartTime: (pid: number) => string | null
  /** A live process's command line, or null when it cannot be read. */
  commandLineOf: (pid: number) => string | null
  reapSession: (sid: string, code: number, reason: string, groupExited?: boolean) => void
  persistRegistry: () => void
  persistRegistryDurable: () => Promise<void>
  /** The keep-alive verdict and the scheduler's own log (defined further down, so asked on use). */
  deriveSessionProtection: (session: SessionData<W>, sid: string, now: number) => { source: string | null }
  hasRecentSchedulerFiring: (sid: string, withinMs: number) => boolean
  /** The turn-error auto-retry (defined further down, so asked on use). */
  cancelTurnRetry: (sid: string, reason: string) => void
  wsId: (ws: W) => number
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  logMsg: DaemonLog
}

export function createDaemonSessionStop<W extends object>(deps: DaemonSessionStopDeps<W>) {
  const { SERVICE_MODE, SESSION_IDLE_WARNING_MS, SESSION_IDLE_KILL_MS, sessions, cliArgvFiles, cronRuntime, daemonBootId, sessionStartGate, sessionStopVersions, journaledHome, journaledIds, walnutOfHome, servedStopRefusal, isProcessGroupAlive, killProcessGroup, readStartTime, commandLineOf, reapSession, persistRegistry, persistRegistryDurable, deriveSessionProtection, hasRecentSchedulerFiring, cancelTurnRetry, wsId, setTimeout, logMsg, sendOk, sendError } = deps

  // ── Stop session ──
  // A refused stop request must not cancel a start that is already queued.
  async function cmdStop(ws: W, id: number, cmd: Record<string, unknown>) {
    const { sid } = cmd as { sid: string }
    if (!sid) return sendError(ws, id, 'stop: missing sid')
    if (cmd.stopRequestId !== undefined && (typeof cmd.stopRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cmd.stopRequestId))) {
      return sendError(ws, id, 'stop: invalid stopRequestId')
    }
    if (cmd.reason !== undefined && !['user', 'maintenance', 'idle', 'orphan'].includes(cmd.reason as string)) {
      return sendError(ws, id, 'stop: invalid reason')
    }
    // owner-home-v1: a stop the server decided on names the asking Walnut, and a
    // session the spawn journal records for another Walnut is refused
    // (stopOwnerRefusal). Checked before anything changes, so a refused stop
    // disables no supervision and fences no start. 'orphan' has its own, stricter
    // proof below.
    if (cmd.reason !== 'orphan') {
      const ownerRefusal = stopOwnerRefusal(sid, cmd)
      if (ownerRefusal) {
        logMsg('info', 'cmdStop: stop refused for a session another Walnut started', { sid, reason: cmd.reason, initiator: cmd.initiator, ...ownerRefusal as { reason?: string; detail?: string } })
        return sendOk(ws, id, { stopped: false, ...ownerRefusal })
      }
    }
    // 'orphan' (orphan-stop-v1): a server found a record saying this session was
    // deliberately ended while its pid still answers. A server never signals a
    // pid it read from its database: the pid proves nothing about which daemon
    // spawned the process (2026-09-26, an ephemeral test server holding a copy of
    // the production database SIGTERM'd the user's live CLIs). It asks the owner,
    // and the owner decides with first-hand evidence (orphanStopRefusal).
    // Supervision is never touched: a supervised session is refused.
    if (cmd.reason === 'orphan') {
      return sessionStartGate.run(sid, async () => {
        const refusal = orphanStopRefusal(sid, cmd.expectPid, cmd.home)
        if (refusal) {
          logMsg('info', 'cmdStop: orphan stop refused', { sid, expectPid: cmd.expectPid, ...refusal })
          return sendOk(ws, id, { stopped: false, ...refusal })
        }
        logMsg('warn', 'cmdStop: ending an orphaned session this daemon owns', { sid, pid: cmd.expectPid })
        sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
        return stopSessionProcess(ws, id, sid)
      })
    }
    // Supervision may be re-enabled while queued, so an idle reap must re-check inside the gate.
    if (cmd.reason === 'idle') {
      return sessionStartGate.run(sid, async () => {
        const supervised = cronRuntime()?.get(sid)
        if (supervised?.enabled && supervised.state !== 'inactive') {
          return sendOk(ws, id, { stopped: false, reason: 'cron_supervised' })
        }
        sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
        return stopSessionProcess(ws, id, sid)
      })
    }
    // Invalidate any in-flight recovery first, then wait on persistence and the process gate; do not wait for the recovery to finish before recording the stop.
    sessionStopVersions.set(sid, (sessionStopVersions.get(sid) ?? 0) + 1)
    if (cronRuntime() && cmd.reason !== 'maintenance') await cronRuntime()!.disable(sid, cmd.stopRequestId as string | undefined)
    return sessionStartGate.run(sid, () => stopSessionProcess(ws, id, sid))
  }

  /**
   * owner-home-v1: why this daemon will NOT carry out a stop the server decided
   * on (reason user, maintenance or idle), or null when it may.
   *
   * A pid or a sid in a server's database proves nothing about which Walnut
   * started the session: an ephemeral test server over a copy of the production
   * data holds the user's session ids, and a remote host's daemon is shared by
   * every Walnut that reaches it. So a stop names the asking Walnut (`home`, its
   * data dir) and the spawn journal's first line for the sid decides:
   *  - it names a Walnut: only that one may stop the session, for any reason;
   *  - it names none (first spawned before the journal recorded homes, or not
   *    journaled at all): `strict` (an ephemeral server, which never started such
   *    a session) is refused; otherwise a session with a journal line keeps
   *    today's behaviour, and an unjournaled one may only be stopped by a person
   *    (`initiator: 'human'`), never by a reaper or sweep.
   * A session one Walnut started stays that Walnut's even after another one
   * resumes it: the second is refused here (fail closed), and this daemon's own
   * idle reaper still ends the process.
   * A request with no `home` comes from a server older than owner-home-v1 and
   * keeps today's behaviour. stopSessionProcess still checks the registry and the
   * process start time before any signal.
   */
  function stopOwnerRefusal(sid: string, cmd: Record<string, unknown>): { reason: string; detail?: string } | null {
    const home = cmd.home
    if (home === undefined) return null
    if (typeof home !== 'string' || !home) return { reason: 'bad_request', detail: 'home must name the asking Walnut' }
    const served = servedStopRefusal(sid, home)
    if (served) return served
    const owner = journaledHome(sid)
    if (owner) return owner === walnutOfHome(home) ? null : { reason: 'not_owned', detail: 'other_walnut' }
    const journaled = journaledIds().has(sid)
    const detail = journaled ? 'no_journaled_walnut' : 'not_journaled'
    if (cmd.strict === true) return { reason: 'not_owned', detail }
    if (journaled) return null
    const human = cmd.initiator === 'human' || (cmd.initiator === undefined && cmd.reason === 'user')
    return human ? null : { reason: 'not_owned', detail }
  }

  /**
   * Why this daemon will NOT end `sid` as an orphan, or null when it may.
   *
   * Ownership first, all first-hand: the sid is in THIS daemon's registry with
   * exactly the pid the server named, the .pgid file in this daemon's own streams
   * dir names the same group (written at spawn by this daemon, or by the earlier
   * daemon on the same dir it adopted the session from), and the host's spawn
   * journal records the sid as started for the asking Walnut (`home`, its data
   * dir). A remote host's daemon is shared by every Walnut that reaches it, so
   * "this daemon spawned it" alone would let a server end another server's
   * session. A process that fails any of these belongs to someone else:
   * 'not_owned'. Then liveness, with the same keep-alive rules the idle scanner
   * uses: recent output, a turn in flight, a cron, a team, a running background
   * task or a pending turn retry all refuse. stopSessionProcess then re-checks
   * the process identity (start time) before its first signal.
   *
   * Race window: cmdStop runs this and stopSessionProcess under the same per-sid
   * gate a start takes, and from here to the first SIGINT everything is
   * synchronous, so no other daemon command (a send included) can land between
   * the check and the signal. Only the CLI itself could start work in between
   * (a cron firing inside it), a window of microseconds.
   */
  function orphanStopRefusal(sid: string, expectPid: unknown, home: unknown): { reason: string; detail?: string } | null {
    if (typeof expectPid !== 'number' || !Number.isSafeInteger(expectPid) || expectPid <= 1) {
      return { reason: 'bad_request', detail: 'expectPid must be an integer above 1' }
    }
    if (typeof home !== 'string' || !home) return { reason: 'bad_request', detail: 'home must name the asking Walnut' }
    const session = sessions.get(sid)
    if (!session) return { reason: 'not_owned', detail: 'not_in_registry' }
    const served = servedStopRefusal(sid, home)
    if (served) return served
    if (session.pid !== expectPid) return { reason: 'not_owned', detail: 'pid_mismatch' }
    if (SERVICE_MODE && session.bootId && session.bootId !== daemonBootId()) return { reason: 'not_owned', detail: 'previous_boot' }
    if (session.state !== 'running' || session.exitCode !== null) return { reason: 'not_running' }
    let pgid = NaN
    try { pgid = parseInt(fs.readFileSync(session.pgidPath, 'utf-8').trim(), 10) } catch { /* no pgid file: not provable */ }
    if (pgid !== expectPid) return { reason: 'not_owned', detail: 'pgid_mismatch' }
    if (!journaledIds().has(sid)) return { reason: 'not_owned', detail: 'not_journaled' }
    const owner = journaledHome(sid)
    if (owner !== walnutOfHome(home)) return { reason: 'not_owned', detail: owner ? 'other_walnut' : 'no_journaled_walnut' }
    const now = Date.now()
    let mtimeMs: number
    try { mtimeMs = fs.statSync(session.jsonlPath).mtimeMs } catch { return { reason: 'protected', detail: 'no-stream-file' } }
    if (now - mtimeMs < SESSION_IDLE_WARNING_MS()) return { reason: 'recent_output' }
    if (session.foldState && session.foldState.turnActive) return { reason: 'protected', detail: 'turn-active' }
    const prot = deriveSessionProtection(session, sid, now)
    if (prot.source) return { reason: 'protected', detail: prot.source }
    if (hasRecentSchedulerFiring(sid, SESSION_IDLE_KILL_MS())) return { reason: 'protected', detail: 'cron-debug-log' }
    return null
  }

  /**
   * A session whose spawn could not read its process's start time (a `ps` that
   * timed out under load) gets one now, when the live process's own command line
   * names this session (argvNamesSession). Without it the record stayed empty for
   * good, adopted that way again by every restart, and every stop of the process
   * was refused: 2026-10-28, one CLI, a refusal every 30 s for over a day. The
   * stop's own check then compares a second reading against this one.
   */
  function recordMissingStartTime(sid: string, session: SessionData<W>): boolean {
    const pid = session.pid
    if (session.startTime || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return false
    if (SERVICE_MODE && session.bootId !== daemonBootId()) return false
    const startTime = readStartTime(pid)
    const argv = startTime ? commandLineOf(pid) : null
    if (!startTime || !argv || !argvNamesSession(argv, sid, session.args)) {
      logMsg('warn', 'process identity: no start time recorded, and the process does not prove it runs this session', {
        sid, pid, startTimeRead: !!startTime, commandLineRead: argv !== null && argv !== '',
      })
      return false
    }
    session.startTime = startTime
    persistRegistry()
    logMsg('info', 'process identity: recorded the missing start time (its command line names the session)', { sid, pid, startTime })
    return true
  }

  /**
   * True only when it is proven that the recorded process is not the one living under its pid:
   * the daemon already saw it die, a start time was recorded, the pid now has another readable start
   * time, and its command line (readable, not empty) names neither the session nor its argv files.
   * Anything unread is not proof.
   */
  function pidNowRunsAnotherProgram(sid: string, session: SessionData<W>, recordedStartTime: string | null | undefined): boolean {
    const pid = session.pid
    // Only a record whose death this daemon already saw: a live-looking record is never declared gone.
    if (session.state !== 'dead') return false
    if (!recordedStartTime || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return false
    if (sessions.get(sid) !== session || (SERVICE_MODE && session.bootId !== daemonBootId())) return false
    const now = readStartTime(pid)
    if (!now || now === recordedStartTime) return false
    const argv = commandLineOf(pid)
    if (argv === null || argv === '') return false
    // Loose on purpose: a live CLI runs its argv as files (cli-argv-files-core.ts), so any mention
    // of the session or of one of its argv files means it may still be ours.
    if (argv.includes(sid)) return false
    const files = Array.isArray(session.args) ? cliArgvFiles.namesIn(session.args.map(String)) : []
    return !files.some((name: string) => argv.includes(name))
  }

  /** The pid's own process is gone (ESRCH) while its process group still has members. */
  function leaderGoneWithGroup(pid: number): boolean {
    try { process.kill(pid, 0); return false } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' && isProcessGroupAlive(pid)
    }
  }

  function stopSessionProcess(ws: W, id: number, sid: string) {
    const session = sessions.get(sid)
    if (!session || !session.pid) {
      const saved = cronRuntime()?.get(sid)?.process
      if (saved && saved.bootId === daemonBootId()) {
        try {
          process.kill(saved.pid, 0)
          return sendError(ws, id, 'stop: saved process is still alive but not adopted; stop confirmation is pending')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return sendError(ws, id, 'stop: saved process liveness is unknown')
        }
      }
      logMsg('info', 'cmdStop: session not in registry (nothing to kill)', {
        sid, hasSession: !!session, hasPid: !!session?.pid,
      })
      return sendOk(ws, id, { stopped: true, noop: true, reason: 'not_in_registry' })
    }

    const pid = session.pid
    if (!Number.isSafeInteger(pid) || pid <= 1) return sendError(ws, id, 'stop: invalid process identity')
    if (SERVICE_MODE && session.bootId && session.bootId !== daemonBootId()) {
      return sendOk(ws, id, { stopped: true, noop: true, reason: 'previous_boot' })
    }
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return sendError(ws, id, 'stop: process liveness is unknown; refusing to signal')
      if (isProcessGroupAlive(pid)) return sendError(ws, id, 'stop: process group still exists without its original leader; stop confirmation is pending')
      reapSession(sid, 0, 'stop-confirmed', true)
      return persistRegistryDurable().then(
        () => sendOk(ws, id, { stopped: true, noop: true, reason: 'already_exited' }),
        (failure) => sendError(ws, id, `stop: registry persistence failed: ${String(failure)}`),
      )
    }
    if (!session.startTime) recordMissingStartTime(sid, session)
    const originalStartTime = session.startTime
    const sameProcess = () => sessions.get(sid) === session && pid > 1
      && (!SERVICE_MODE || session.bootId === daemonBootId())
      && !!originalStartTime && readStartTime(pid) === originalStartTime
    if (!sameProcess() && pidNowRunsAnotherProgram(sid, session, originalStartTime)) {
      // The recorded CLI is gone and its pid belongs to another program now (2026-11-05: a CLI
      // stopped at 06:03 kept its record, the pid was reused, and a send to the session failed with
      // "process identity is unknown" until the new program ended). Nothing is signalled.
      logMsg('info', 'cmdStop: the recorded process is gone; its pid runs another program now (not signalled)', {
        sid, pid, recordedStartTime: originalStartTime ?? null, state: session.state,
      })
      return persistRegistryDurable().then(
        () => sendOk(ws, id, { stopped: true, noop: true, reason: 'pid_reused' }),
        (failure) => sendError(ws, id, `stop: registry persistence failed: ${String(failure)}`),
      )
    }
    if (!sameProcess()) {
      logMsg('warn', 'cmdStop: process identity is unknown; refusing to signal', {
        sid, pid, wsId: wsId(ws), recordedStartTime: originalStartTime ?? null,
      })
      return sendError(ws, id, 'stop: process identity is unknown; refusing to signal')
    }
    logMsg('info', 'cmdStop: stopping session (process group kill)', { sid, pid })

    // Nobody sends `stop` by accident, so record the intent BEFORE the first
    // signal: the death lands asynchronously (orphan poll → ESRCH → code -1) and
    // by then nothing remembers this was asked for. Without the stamp reapSession
    // falls back to the JSONL tail, which says "not a clean turn end" for any
    // session whose last line isn't a type:result, and the projection paints a red
    // Error. This path is how the SERVER's idle reaper kills (mgr.kill() → stop
    // RPC), not the daemon's own scan, so it needs its own stamp: a LOCAL session
    // auto-stopped after 2h idle surfaced as "Session ended unexpectedly and no
    // cause was recorded" (2026-09-03).
    session.intentionalStopAt = Date.now()

    // An explicit stop is a human decision — it must never be undone by a pending
    // auto-retry respawning the CLI a few minutes later. Cancel the timer AND
    // clear the streak so an in-flight `result` line can't re-arm one either.
    cancelTurnRetry(sid, 'session-stopped')
    if (session.turnRetry) clearTurnRetryStreak(session.turnRetry)

    return new Promise<void>((resolve) => {
      const reply = (error?: string) => {
        if (error) sendError(ws, id, error)
        else sendOk(ws, id, { stopped: true })
        resolve()
      }
      try { killProcessGroup(pid, 'SIGINT') } catch (error) {
        reply(`stop: ${(error as Error).message}`)
        return
      }
      let checks = 0
      const checkExit = () => {
        // The CLI itself may have exited on the SIGINT (and been reaped) while its children are still
        // leaving its group (2026-11-12: a Demo reset's stop answered "identity changed" 200 ms after the
        // CLI ended). With the leader gone and the group alive, no process can hold this pid (a group's
        // id is not reused while it has members), so the members are the CLI's own: keep waiting, with
        // the SIGTERM below. Only a live process whose identity changed is refused.
        // Identity is read BEFORE the group: on macOS readStartTime is a `ps` call, and the last member
        // leaving during it made a group read before it say alive and the one inside leaderGoneWithGroup
        // say empty, so a finished stop answered "identity changed" (2026-11-13, a flaky twins e2e).
        const ours = sameProcess() || leaderGoneWithGroup(pid)
        if (!isProcessGroupAlive(pid)) {
          if (sessions.get(sid) === session) {
            reapSession(sid, 0, 'stop-confirmed', true)
            persistRegistryDurable().then(() => reply(), (error) => reply(`stop: registry persistence failed: ${String(error)}`))
            return
          }
          return reply()
        }
        if (!ours) return reply('stop: process identity changed; no further signals sent')
        checks++
        if (checks === 25) {
          try { killProcessGroup(pid, 'SIGTERM') } catch (error) { return reply(`stop: ${String(error)}`) }
        }
        if (checks >= 35) return reply('stop: process did not exit after SIGTERM; automatic recovery remains disabled')
        setTimeout(checkExit, 200)
      }
      setTimeout(checkExit, 200)
    })
  }

  return { cmdStop, stopOwnerRefusal, stopSessionProcess }
}
