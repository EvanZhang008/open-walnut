/**
 * Starting a Claude Code session on this host: the `start` command (its gate per session id, a
 * stop that supersedes it, the argument copies of start-arg-refs-v1) and the spawn itself
 * (startSessionProcess): the live-adopt of a CLI that still runs, the spawn gate, one CLI per
 * transcript, the fold of a resumed stream, the spawn files, the CLI's env, the session record,
 * the registry write-ahead and the first message.
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; every native start comes through startSessionProcess (the start command, turn
 * retries, host and bridge resumes, offline asks). The code is the runtime's as it was; deps carry
 * the runtime's own names.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type SessionMode, lockLiveFifo, type DaemonCore } from './daemon-core.js'
import { Subscribers, type TaskState, type SessionData, type SpawnInfo, type SessionGate, type SendOutcome, type DaemonCronRuntime } from './daemon-session-types.js'
import { initialFoldState, type FoldState } from './daemon-fold.js'
import type { StreamFoldResult, createStreamFold } from './stream-fold-core.js'
import { ensureTaskDir, restoreForStart, resumeSourceId } from './task-dir-core.js'
import { shellQuote } from './host-exec-core.js'
import { prepareSpawnFiles } from './session-spawn-files.js'
import { containListeners, type ChildProcessFns, type ChildProcessUse } from './daemon-child-spawn.js'
import { spawnBehindRegistry } from './daemon-spawn-barrier.js'
import type { createSpawnPool } from './spawn-pool.js'
import type { createRuntimeTimers } from './daemon-runtime-timers.js'
import type { createCliArgvFiles } from './cli-argv-files-core.js'
import type { CliOwner } from './cli-owner-core.js'
import type { HostResume } from './host-resume-core.js'
import type { createStreamCompact } from './stream-compact-core.js'
import type { createFoldCheckpoint } from './fold-checkpoint-core.js'
import type { createCronMetadataTracker } from './daemon-cron-metadata.js'
import type { readCronCliConfig } from './daemon-cron-runtime.js'
import type { createHostCallTokens } from './host-call-token-core.js'
import { claudeRetryEnv } from './engine-turn-watch.js'
import type { DaemonEnv, DaemonLog, DaemonReplies } from './daemon-module-deps.js'

export interface DaemonSessionStartDeps<W extends object> extends DaemonReplies<W> {
  daemonEnv: DaemonEnv
  SERVICE_MODE: boolean
  STREAMS_DIR: string
  /** Where the task directories are (task-dir-core.ts). */
  TASK_DIR_ROOT: string
  /** The agent gateway's socket (a session's `walnut` reaches its Walnut through it). */
  GATEWAY_SOCK_PATH: string
  /** The secrets the user shared (daemon-host-services.ts, made further down, so asked on use). */
  SECRETS_ROOT: () => string
  secretsSessionEnv: () => Record<string, string>
  /** The runtime dir a session keeps (service-set.ts). */
  SESSION_RUNTIME_DIR: string | undefined
  CLAUDE_PROJECTS_DIRS: string[]
  sessions: Map<string, SessionData<W>>
  core: DaemonCore<SessionData<W>>
  spawn: ChildProcessFns['spawn']
  execFile: ChildProcessFns['execFile']
  childUse: ChildProcessUse
  /** Inside another program, the CLIs start on the spawn pool's thread (spawn-pool.ts). */
  spawnPool: ReturnType<typeof createSpawnPool> | null
  runtimeTimers: Pick<ReturnType<typeof createRuntimeTimers>, 'contain'>
  clearInterval: typeof globalThis.clearInterval
  sessionStopVersions: Map<string, number>
  sessionStartGate: SessionGate
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  /** This boot's id, once known. */
  daemonBootId: () => string | undefined
  demoQuiesce: { readonly fenced: boolean }
  cliArgvFiles: ReturnType<typeof createCliArgvFiles>
  cliOwner: CliOwner
  hostResume: HostResume
  strictStartRefusal: (sid: string, cmd: Record<string, unknown>, home: string | undefined, resume: boolean) => Error | null
  waitForStoppedProcess: (pid: number) => Promise<boolean>
  requireBudgetAllowance: (sid: string) => Promise<void>
  budgetRefusal: (reason: 'budget_paused' | 'budget_checking') => Error & { code: string }
  cancelledStartPath: (sid: string) => string
  isJournalSid: (sid: unknown) => sid is string
  readStartTime: (pid: number) => string | null
  readStartTimeAsync: (pid: number) => Promise<string | null>
  killProcessGroup: (pid: number, signal: NodeJS.Signals) => unknown
  reapSession: (sid: string, code: number, reason: string, groupExited?: boolean) => void
  broadcastSessionState: DaemonCore<SessionData<W>>['broadcastSessionState']
  persistRegistryDurable: () => Promise<void>
  logStateTransition: (sid: string, from: string, to: string, reason: string, source: string, extra?: Record<string, unknown>) => void
  spawnInfoFor: (args: string[], cwd: string, resume: boolean, origin: unknown) => SpawnInfo
  appendSpawnJournal: (sid: unknown, rec: Record<string, unknown>) => void
  namedSessionId: (args: string[]) => string | undefined
  emptyTaskState: () => TaskState
  statSizeOrZero: (p: string) => number
  streamFold: ReturnType<typeof createStreamFold<FoldState, TaskState>>
  streamWriterGone: (sid: string) => boolean
  streamCompact: Pick<ReturnType<typeof createStreamCompact>, 'markPathFor'>
  foldCheckpoint: Pick<ReturnType<typeof createFoldCheckpoint>, 'pathFor' | 'nextPathFor' | 'discard'>
  cronMetadata: Pick<ReturnType<typeof createCronMetadataTracker>, 'configure' | 'state'>
  /** The CLI's cron config, once read. */
  cronMetadataConfig: () => Awaited<ReturnType<typeof readCronCliConfig>> | null
  cronProcess: (session: SessionData<W>) => Parameters<ReturnType<typeof createCronMetadataTracker>['configure']>[1]
  hostCallTokens: ReturnType<typeof createHostCallTokens>
  sessionWalnutApiUrl: (env: Record<string, unknown> | undefined) => string | undefined
  walnutThroughGateway: (env: Record<string, unknown> | undefined, home: unknown) => boolean
  settingsEnvOf: (args: string[]) => Record<string, unknown> | undefined
  buildSpawnPreamble: (o?: { nodeDir?: string; gatewayFirst?: boolean; shellSetupFile?: string }) => string
  sessionShell: () => string
  passwdReady: () => Promise<unknown>
  shellSetupOfStart: (cmd: Record<string, unknown>, sid: string) => string
  gateClaudeLaunch: (args: string[], shellSetupFile: string) => Promise<{ args: string[]; nodeDir?: string }>
  /** The page silencer (pw-silence-core.ts). */
  pwSilenceFile: () => Promise<string | null>
  pwSilenceOptions: (node: string | null | undefined, bun: string | null | undefined, file: string | null) => { NODE_OPTIONS: string | undefined; BUN_OPTIONS: string | undefined }
  /** Turn snapshots (daemon-transcripts.ts, made further down, so asked on use). */
  turnSnapshots: { onTurnStart: (sid: string, cwd: string) => unknown }
  /** The JSONL tailer and its subscribers (defined further down, so asked on use). */
  ensureWatcher: (sid: string) => void
  addSubscriber: (ws: W, sid: string, fromOffset: number) => boolean
  stopSessionWatcher: (sid: string) => void
  logMsg: DaemonLog
}

export function createDaemonSessionStart<W extends object>(deps: DaemonSessionStartDeps<W>) {
  const { daemonEnv, SERVICE_MODE, STREAMS_DIR, TASK_DIR_ROOT, GATEWAY_SOCK_PATH, SECRETS_ROOT, SESSION_RUNTIME_DIR, CLAUDE_PROJECTS_DIRS, sessions, core, spawn, execFile, childUse, spawnPool, runtimeTimers, clearInterval, sessionStopVersions, sessionStartGate, cronRuntime, daemonBootId, demoQuiesce, cliArgvFiles, cliOwner, hostResume, strictStartRefusal, waitForStoppedProcess, requireBudgetAllowance, budgetRefusal, cancelledStartPath, isJournalSid, readStartTime, readStartTimeAsync, killProcessGroup, reapSession, broadcastSessionState, persistRegistryDurable, logStateTransition, spawnInfoFor, appendSpawnJournal, namedSessionId, emptyTaskState, statSizeOrZero, streamFold, streamWriterGone, streamCompact, foldCheckpoint, cronMetadata, cronMetadataConfig, cronProcess, hostCallTokens, secretsSessionEnv, sessionWalnutApiUrl, walnutThroughGateway, settingsEnvOf, buildSpawnPreamble, sessionShell, passwdReady, shellSetupOfStart, gateClaudeLaunch, pwSilenceFile, pwSilenceOptions, turnSnapshots, ensureWatcher, addSubscriber, stopSessionWatcher, logMsg, sendOk, sendError } = deps

  async function cmdStart(ws: W, id: number, cmd: Record<string, unknown>) {
    const sid = cmd.sid as string
    if (!sid) return sendError(ws, id, 'start: missing sid')
    // A start's long arguments may come by hash (start-arg-refs-v1, cli-argv-files-core.ts): put
    // them back from this host's copies, and keep copies of what came in full.
    if (cmd.argRefs === true && Array.isArray(cmd.args)) {
      const refs = cliArgvFiles.resolveRefs(cmd.args.map(String))
      if (refs.missing.length) {
        logMsg('info', 'start: no copy of some arguments, asked for them in full', { sid, missing: refs.missing.length })
        return sendOk(ws, id, { ok: false, code: 'ARG_REFS_MISSING', missingRefs: refs.missing, error: 'start: this host has no copy of some of its arguments; send them in full' })
      }
      cmd = { ...cmd, args: refs.args }
      cliArgvFiles.rememberRefs(refs.args)
    }
    const stopVersion = sessionStopVersions.get(sid) ?? 0
    const current = () => (sessionStopVersions.get(sid) ?? 0) === stopVersion
      && (!cronRuntime() || (cronRuntime()!.deliveryAllowed(sid, cmd.stopFence) && (cmd.autoRetry !== true || !cronRuntime()!.get(sid))))
    const result = await sessionStartGate.run(sid, () => {
      if (!cmd.resume && fs.existsSync(cancelledStartPath(sid))) throw new Error('Initial start was cancelled; retry task_start on the same task')
      if (!current()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })
      return startSessionProcess(cmd, undefined, current)
    })
      .catch((error) => {
        if (error?.code === 'SESSION_STOP_SUPERSEDED') return null
        // A host that cannot run claude answers with the reason itself, not an
        // "internal daemon error".
        if (error?.code === 'BUDGET_PAUSED') return Object.assign(error as Error, { errorKind: 'budget_paused' })
        if (error?.code === 'BUDGET_CHECKING') return Object.assign(error as Error, { errorKind: 'budget_checking' })
        if (error?.code === 'CLAUDE_RUNTIME') return error as Error & { errorKind?: string }
        // Another CLI of this session runs on this host (cli-owner-core.ts).
        if (error?.code === 'SESSION_LIVE' || error?.code === 'SESSION_NOT_OURS') return error as Error & { errorKind?: string }
        throw error
      })
    if (!result) return sendOk(ws, id, { ok: false, reason: 'session_stopped', error: 'start: a stop request superseded this start' })
    if (result instanceof Error) return sendError(ws, id, result.message, { errorKind: result.errorKind, ...(result.errorKind === 'budget_paused' ? { reason: 'budget_paused', code: 'BUDGET_PAUSED' } : result.errorKind === 'budget_checking' ? { reason: 'budget_checking', code: 'BUDGET_CHECKING' } : result.errorKind === 'session_live' ? { reason: 'session_live', code: 'SESSION_LIVE' } : result.errorKind === 'session_other_walnut' ? { reason: 'session_other_walnut', code: 'SESSION_NOT_OURS' } : {}) })
    addSubscriber(ws, sid, result.offset)
    return sendOk(ws, id, result)
  }

  async function startSessionProcess(cmd: Record<string, unknown>, isCurrent?: () => boolean, canStart?: () => boolean) {
    // A template's hook texts (hook-files-v1) go back into its settings: the registry keeps the inline
    // form an older daemon re-spawns after a rollback (cli-argv-files-core.ts inlineArgs).
    if (Array.isArray(cmd.args)) cmd = { ...cmd, args: cliArgvFiles.inlineArgs(cmd.args.map(String)) }
    const { sid, args, cwd, message, resume, mode, uuid } = cmd as {
      sid: string; args: string[]; cwd: string; message?: string; resume?: boolean
      mode?: string
      /** Optional pre-assigned v4 uuid for the INITIAL message's user line. Absent
       *  on every older client ⇒ envelope unchanged. */
      uuid?: string
    }
    const initialUuid = typeof uuid === 'string' && uuid ? uuid : undefined
    // An empty message only resumes the process without injecting a user turn; the CLI may not send init until a schedule fires.
    if (!isJournalSid(sid) || !args || !cwd) throw new Error('start: missing required fields (sid, args, cwd)')
    await requireBudgetAllowance(sid)
    if (canStart && !canStart()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })
    if (isCurrent && !isCurrent()) throw new Error('start: supervision request was superseded')
    // Every native start comes here (commands, turn retries, host resumes, offline asks).
    if (demoQuiesce.fenced) throw new Error('start: Demo is stopping; no new session starts')

    // Validate cwd exists before spawning — prevents misleading ENOENT on /bin/bash
    // when the real issue is a non-existent working directory (e.g. local Mac path
    // sent to a remote Linux host).
    if (!fs.existsSync(cwd)) {
      throw new Error(`start: cwd does not exist on this host (${os.hostname()}): ${cwd}`)
    }

    // If a session with this sid already exists (e.g. adopted orphan still
    // running, or previous turn's process not yet reaped), clean it up BEFORE
    // overwriting sessions.set() below. Otherwise the old orphanPollTimer's
    // captured pid lingers and will misfire `pid-recycled` against our new pid
    // ~1s after spawn, killing every --resume-spawned process in a loop.
    const existing = sessions.get(sid)
    if (isCurrent && existing?.pid && existing.bootId === daemonBootId()) {
      try {
        process.kill(existing.pid, 0)
        if (existing.state !== 'running') throw new Error('start: an unadopted process may still own this session')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    if (existing) {
      // Live-adopt guard: a resume-with-message against a STILL-RUNNING CLI means
      // the caller lost track of the process (walnut restart race, stale hasPipe),
      // not that the process needs replacing. Killing it here aborts whatever the
      // CLI is doing mid-turn (observed: a 369K-token compaction). Deliver the
      // message to the live FIFO and adopt instead — exactly what cmdSend would
      // have done had the caller known the process was alive. An explicit restart
      // (reinitialize) sends message='' and still takes the respawn path below.
      if (resume && (message || cmd.deferMessage === true || isCurrent) && existing.state === 'running' && existing.pid) {
        let oldAlive = false
        try { process.kill(existing.pid, 0); oldAlive = true } catch (error) {
          if (isCurrent && (error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        if (oldAlive) {
          if (isCurrent && (!existing.startTime || existing.startTime !== await readStartTimeAsync(existing.pid))) {
            throw new Error('start: live process identity is unknown')
          }
          // Live-adopt: the start's initial message is delivered through the FIFO
          // instead of a respawn, so it must carry the same pre-assigned uuid.
          // A deferred delivery is not a restart: adopt first, and the ordered send writes the body afterwards.
          const sendResult: SendOutcome = message
            ? await core.handleSendCommand(sid, message, initialUuid)
            : { ok: true } as const
          if (sendResult.ok) {
            if (mode) existing.mode = mode as SessionMode
            // Hand out a COMPLETE-line boundary, never a raw stat().size: this
            // value becomes the client's cursor AND addSubscriber's replay start,
            // and a mid-line start fans a JSON fragment to the client (contract §4
            // boundary rule). The live watcher already publishes the boundary.
            const curSize = existing.watcher ? existing.watcher.offset : statSizeOrZero(existing.jsonlPath)
            logMsg('info', 'cmdStart: adopted live session — message delivered via FIFO, respawn skipped', {
              sid, pid: existing.pid, offset: curSize,
            })
            ensureWatcher(sid)
            return { pid: existing.pid, outputFile: existing.jsonlPath, offset: curSize, adopted: true }
          }
          if (sendResult.reason === 'budget_paused' || sendResult.reason === 'budget_checking') throw budgetRefusal(sendResult.reason)
          // Delivery failed. Only fall through to respawn if handleSendCommand
          // actually reaped the session (ENXIO / precheck-dead / partial-write).
          // A transient EAGAIN (pipe full, process alive) must NOT kill the CLI —
          // fail the start; the message stays queued and the caller retries.
          const afterSend = sessions.get(sid)
          if (afterSend && afterSend.state === 'running') {
            logMsg('warn', 'cmdStart: live-adopt delivery failed but process alive — refusing respawn', {
              sid, pid: existing.pid, reason: sendResult.reason ?? sendResult.error,
            })
            throw new Error(`start: session ${sid} is alive but FIFO delivery failed (${sendResult.reason ?? sendResult.error}); retry send`)
          }
          logMsg('warn', 'cmdStart: live-adopt delivery failed — falling back to respawn', {
            sid, reason: sendResult.reason ?? sendResult.error,
          })
        }
      }
    }

    // Spawn gate: name the exact reason a CLI cannot start (not installed, or the
    // npm build with no working node) instead of an exit 127 after the spawn.
    // It runs BEFORE the replaced session is torn down: a refusal must leave a
    // live CLI exactly as it was, never killed and replaced by nothing.
    const shellSetupFile = shellSetupOfStart(cmd, sid)
    // The login shell sessionShell() picks comes from passwd, read ahead at the runtime's start.
    await passwdReady()
    const launch = await gateClaudeLaunch(args, shellSetupFile)
    await requireBudgetAllowance(sid)
    if (canStart && !canStart()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })

    // One CLI per session id on this host, whichever daemon asks (cli-owner-core.ts):
    // a live CLI of this transcript that is not the one replaced below, or another
    // daemon's spawn in flight, refuses the start. Before the teardown, so a refusal
    // leaves everything as it was.
    const ownedSid = cliOwner.transcriptIdOf(args)
    const replacedPid = existing && existing.state === 'running' && existing.pid ? existing.pid : undefined
    const askingHome = (cmd.origin as { home?: unknown } | undefined)?.home
    const ownerHome = typeof askingHome === 'string' && askingHome ? askingHome : undefined
    // A resume by its args too, whatever the flag says (a fork is a new transcript).
    const resumesTranscript = !!resume || (args.includes('--resume') && !args.includes('--fork-session'))
    const notOurs = ownedSid ? strictStartRefusal(ownedSid, cmd, ownerHome, resumesTranscript) : null
    if (notOurs) throw notOurs
    // An archived transcript comes back plain before the CLI resumes it, or forks it: the source a
    // fork reads is its --resume id, not the new transcript it owns (transcript-archive.ts). A fresh
    // start under an id is checked the same way: history of that id archived here and not brought
    // back (remote storage refused) refuses the start, never a new conversation in its place.
    const archivedSource = resumeSourceId(args) ?? ownedSid
    if (archivedSource) await restoreForStart(CLAUDE_PROJECTS_DIRS, archivedSource)
    // A start that a stop or a newer supervision request overtook ends here.
    const superseded = () => (!!canStart && !canStart()) || (!!isCurrent && !isCurrent())
    const stopIfSuperseded = () => {
      if (canStart && !canStart()) throw Object.assign(new Error('start: stop request superseded this start'), { code: 'SESSION_STOP_SUPERSEDED' })
      if (isCurrent && !isCurrent()) throw new Error('start: supervision request was superseded')
    }
    // A resumed stream is folded once before the transcript is claimed: a big
    // file without a checkpoint folds for longer than a claim may sit
    // unconfirmed (cli-owner-core.ts CLAIM_TTL_MS), and the fold below then
    // reads only what this one's checkpoint left (stream-fold-core.ts).
    if (resume) {
      await streamFold.foldFile(path.join(STREAMS_DIR, sid + '.jsonl'), Date.now(), { aborted: superseded })
      stopIfSuperseded()
    }

    const ownerClaim = ownedSid ? await cliOwner.claim(ownedSid, { exceptPid: replacedPid, home: ownerHome }) : null
    let ownerCommitted = false
    try {

    if (existing) {
      logMsg('warn', 'cmdStart: replacing existing session', {
        sid,
        oldPid: existing.pid,
        oldState: existing.state,
        oldHasOrphanPoll: !!existing.orphanPollTimer,
        resume: !!resume,
      })
      if (existing.orphanPollTimer) {
        try { clearInterval(existing.orphanPollTimer) } catch {}
        existing.orphanPollTimer = null
      }
      // Stop the old session's watcher BEFORE sessions.set() replaces the entry.
      // The poll timer looks up sessions.get(sid) fresh each tick — once the new
      // session lands under the same sid (state='running'), the old timer passes
      // the state guard and tails the same jsonl at its own closure offset:
      // TWO watchers fanning every line twice (doubled blocks after respawn),
      // and the old timer leaks forever because nothing else clears it.
      stopSessionWatcher(sid)
      // If the old pid is still alive, kill its process group. This is the old
      // adopted orphan; we must not leave it running while we point `sessions`
      // at a different pid, or the orphan becomes permanently un-reapable.
      if (existing.state === 'running' && existing.pid) {
        let oldAlive = false
        try { process.kill(existing.pid, 0); oldAlive = true } catch {}
        if (oldAlive) {
          logMsg('warn', 'cmdStart: killing old-session process group before respawn', {
            sid, oldPid: existing.pid,
          })
          killProcessGroup(existing.pid, 'SIGTERM')
        }
      }
      // Mark dead so any late callbacks (subscribers, watchers) don't act on it.
      const stoppedPid = existing.state === 'running' ? existing.pid : null
      existing.state = 'dead'
      existing.exitReason = 'replaced-by-cmdstart'
      existing.exitedAt = Date.now()
      // The new CLI must not start on the transcript while the old one still writes it.
      if (stoppedPid && !await waitForStoppedProcess(stoppedPid)) {
        throw new Error(`start: the previous CLI of this session (pid ${stoppedPid}) has not exited; not starting a second one`)
      }
    }

    fs.mkdirSync(STREAMS_DIR, { recursive: true })
    // Journal the id now when the args name it; a new or forked session's id is
    // journaled from its init line (the tailer below).
    const spawnInfo = spawnInfoFor(args, cwd, !!resume, (cmd as Record<string, unknown>).origin)
    appendSpawnJournal(namedSessionId(args), spawnInfo)
    // The task's durable working directory: made here, on the host the session
    // runs on, and handed to the CLI as WALNUT_TASK_DIR. A supervision respawn
    // carries no origin, so the task comes from the resume record.
    const resumeRec = spawnInfo.task ? null : hostResume.recall(sid)
    const taskDir = ensureTaskDir(TASK_DIR_ROOT, spawnInfo.task ?? resumeRec?.task, spawnInfo.home ?? resumeRec?.home)

    const pipePath = path.join(STREAMS_DIR, sid + '.pipe')
    const jsonlPath = path.join(STREAMS_DIR, sid + '.jsonl')
    const stderrPath = jsonlPath + '.err'
    const pgidPath = path.join(STREAMS_DIR, sid + '.pgid')

    // Record offset before spawn (for resume — only stream new data).
    // C1: on resume the fold is rebuilt from the surviving jsonl, and the watcher
    // offset comes from THAT rebuild's complete-line boundary — never a raw
    // stat().size, which can sit mid-line if the previous CLI died mid-write
    // (contract §4 "Rebuild boundary rule").
    let offset = 0
    let resumeFold: StreamFoldResult<FoldState, TaskState> | null = null
    if (resume) {
      // Async, so every other session keeps its daemon while a big file folds
      // (from the checkpoint the fold before the claim left). A file over the
      // cap is then left for a fresh one (stream-fold-core.ts).
      resumeFold = await streamFold.foldFile(jsonlPath, Date.now(), { aborted: superseded })
      offset = resumeFold.boundary
      stopIfSuperseded()
      const rotation = streamWriterGone(sid) ? await streamFold.rotateReason(jsonlPath, ownedSid, CLAUDE_PROJECTS_DIRS, resumeFold.fold) : null
      stopIfSuperseded()
      if (rotation && streamFold.rotate(jsonlPath, [foldCheckpoint.pathFor(jsonlPath), foldCheckpoint.nextPathFor(jsonlPath), streamCompact.markPathFor(jsonlPath)], resumeFold ? resumeFold.fold : null)) {
        logMsg('info', 'stream rotated', { sid, bytes: rotation.size })
        // The dead process's turn and background tasks went with it.
        resumeFold = null
        offset = 0
      }
    }

    // The FIFO, the stream and the stderr log the CLI starts on (session-spawn-files.ts): made and
    // opened asynchronously, the stream O_APPEND (the daemon appends its marker lines too), a fresh
    // start's stream a new inode (a new streamEpoch: the 019a7fe5 class).
    const { pipeFd, outputFd, stderrFd, cronStartOffset, stderrStartOffset } = await prepareSpawnFiles({
      fs,
      execFile: (file, args, options, callback) => execFile(file, args, options, (error) => callback(error)),
      lockFifo: (p) => lockLiveFifo(fs, p),
      discardCheckpoint: (p) => foldCheckpoint.discard(p),
      warn: (msg, data) => logMsg('warn', msg, data),
    }, { sid, pipePath, jsonlPath, stderrPath, resume: !!resume, checkCurrent: stopIfSuperseded })
    const cronStartedAt = Date.now()

    // Spawn Claude through the user's shell, its rc file and the host's shell_setup, to activate
    // nvm/pyenv/volta and the sign-in variables they set, even on hosts where nvm binaries need a
    // newer GLIBC than the system provides.
    // The home this start is for, as it names it: its origin's, or the one its resume record kept
    // (the rule and the call entry each find its Walnut from it: daemon-standalone.ts followerHere).
    const startHome = spawnInfo.home ?? resumeRec?.home
    const preamble = buildSpawnPreamble({ nodeDir: launch.nodeDir, gatewayFirst: walnutThroughGateway(settingsEnvOf(launch.args), startHome), shellSetupFile })
    // Content arguments go to files: the shell's and the CLI's argv carry paths (cli-argv-files-core.ts).
    const escapedArgs = cliArgvFiles.toFiles(launch.args).map((a: string) => shellQuote(a)).join(' ')
    const shellCmd = `${preamble}; exec ${escapedArgs}`

    // Use the user's actual shell to spawn sessions. Hardcoding /bin/bash caused
    // .zshrc to be sourced from bash (via the preamble's `case "$SHELL"`), which
    // fails or partially executes — zsh-specific syntax errors are silently
    // swallowed by `2>/dev/null`, but PATH modifications before the error point
    // can clobber the inherited PATH, losing /usr/bin and other system dirs.
    // Using $SHELL ensures RC files are sourced by the correct shell interpreter.
    // Empirical verification: bash -c 'source .zshrc' on clouddev produces 0 /usr/bin
    // matches, while zsh -c 'source .zshrc' produces 2 matches, proving the bug.
    const userShell = sessionShell()
    // CLAUDE_CODE_MAX_RETRIES: harden against upstream Bedrock degradation windows.
    // Forensics found degradation windows of 10-103 min; the CLI's default 10 API
    // retries only cover a ~3min budget, so a turn dies with "Request timed out"
    // mid-outage. The persistent-retry env (CLAUDE_CODE_UNATTENDED_RETRY) is compiled
    // OUT of external CLI builds, so we raise the finite retry ceiling instead.
    // Retries past 10 back off ~35s each, so 60 covers roughly a 30-min outage.
    // Precedence: respect an explicit process-env override; else WALNUT_CLI_MAX_RETRIES;
    // else default '60'.
    const cliMaxRetries =
      daemonEnv.CLAUDE_CODE_MAX_RETRIES ?? daemonEnv.WALNUT_CLI_MAX_RETRIES ?? '60'
    const spawnOptions = {
      detached: true,
      stdio: [pipeFd, outputFd, stderrFd] as [number, number, number],
      cwd: cwd,
      // MCP_CONNECTION_NONBLOCKING=1 makes the CLI emit its `init` event immediately
      // instead of blocking up to 5s for MCP servers to connect (they keep connecting
      // in the background). This is the dominant time-to-init cost for Walnut sessions:
      // measured ~6.9s → ~2.9s with no loss of MCP functionality. The CLI only honors
      // this via env (no CLI flag); the daemon's spawn env is the single inject point.
      // CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1: opt into the authoritative
      // session_state_changed (running/idle/requires_action) stream events. idle is
      // the only reliable turn-over signal; a dynamic-workflow turn emits MANY result
      // events (one per background subagent finishing), so result is NOT a turn
      // boundary.
      //
      // We intentionally DO NOT set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: background
      // Bash tasks (run_in_background) are a useful capability and there's no reason to
      // amputate them. The original orphan-process worry doesn't hold: the CLI is
      // spawned detached (pid === PGID) and reapSession() kills the whole process group
      // (SIGTERM→SIGKILL), so any background shell is cleaned up with the CLI. Verified
      // by live capture that enabling it leaves the running→idle turn-completion signal
      // intact.
      // CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1: the CLI takes a file checkpoint
      // per user message ONLY when file history is enabled, and in non-interactive
      // (print) mode that is gated behind this env var alone — no CLI flag exists.
      // It is what makes Rewind's file half possible (rewind_files control_request,
      // see core/sessions/session-rewind.ts); without it every rewind answers "File
      // rewinding is not enabled." Backups are hardlinked and capped at 100
      // snapshots per session by the CLI, so the disk cost is bounded.
      // WALNUT_DISABLE_FILE_CHECKPOINTS=1 on the daemon opts a host out.
      env: {
        ...daemonEnv,
        // The secrets the user let this host's sessions have (secrets-core.ts), before
        // every Walnut variable so none of those can be replaced.
        ...secretsSessionEnv(),
        // The shell it starts in (sessionShell), so the CLI's Bash tool runs the same one.
        SHELL: userShell,
        MCP_CONNECTION_NONBLOCKING: '1',
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        // line-answer-v1: Walnut sends a line Claude Code took and never answered once more
        // itself; the CLI's own auto-resume of that turn (an empty value is off) would answer
        // it twice. Keep in sync with the other twin.
        CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '',
        CLAUDE_CODE_MAX_RETRIES: cliMaxRetries,
        // Its unattended retry mode (CLAUDE_CODE_RETRY_WATCHDOG, a user setting) otherwise retries
        // with no limit while the session reads Running: the same bound as every engine (engine-turn-watch.ts).
        // Like CLAUDE_CODE_MAX_RETRIES, a safety ceiling: the one kind of engine setting Walnut sets.
        ...claudeRetryEnv(daemonEnv),
        ...(daemonEnv.WALNUT_DISABLE_FILE_CHECKPOINTS === '1'
          ? {}
          : { CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: '1' }),
        // Agent gateway (peer sessions): the `walnut` CLI inside this session reads
        // these two to reach the on-host gateway socket. The sid may be a fresh
        // spawn's tmp id — gatewaySidAliases (cmdRename) resolves it to the
        // current sid on every request.
        WALNUT_AGENT_SOCKET: GATEWAY_SOCK_PATH,
        WALNUT_SESSION_ID: sid,
        // host-call-entry-v1: this host's own Walnut server's call entry socket and this run's token,
        // when its follower said a socket (hostCallTokens.envFor); unset otherwise, never inherited.
        WALNUT_CALL_SOCKET: undefined,
        WALNUT_CALL_TOKEN: undefined,
        ...hostCallTokens.envFor(startHome, sid),
        // Unset when the task has none, so a value this daemon inherited (it was
        // started from inside a session) never names another task's directory.
        WALNUT_TASK_DIR: taskDir ?? undefined,
        // Where the secrets the user shared with this host are, one file each.
        WALNUT_SECRETS_DIR: SECRETS_ROOT(),
        // The address its Walnut named in its settings, or none (never this daemon's own):
        // sessionWalnutApiUrl.
        OPEN_WALNUT_API_URL: sessionWalnutApiUrl(settingsEnvOf(launch.args)),
        // The page silencer, first in NODE_OPTIONS (pw-silence-core.ts).
        ...pwSilenceOptions(daemonEnv.NODE_OPTIONS, daemonEnv.BUN_OPTIONS, await pwSilenceFile()),
        // Never let OUR watchdog pid leak into the CLI's env. A CLI session that
        // runs `npm run dev:prod` would otherwise hand this stale pid to the
        // PRODUCTION daemon, whose watchdog would trip on the long-dead pid and
        // (with the isolated-dir reap) kill live prod sessions. Same env-carrier
        // chain as the VITEST_* leak.
        WALNUT_DAEMON_PARENT_PID: undefined,
        // Same for the keep-sessions switch (the cloud tunnel daemon's): it is this
        // daemon's own exit policy, and a CLI that starts a daemon of its own must
        // not hand it on.
        WALNUT_DAEMON_KEEP_SESSIONS: undefined,
        // And the service state dir: a daemon a CLI starts (a test, a sandbox) is isolated,
        // and with this var it could reach the service daemon's journals and state.
        WALNUT_DAEMON_STATE_DIR: undefined,
        // The server's images dir is this daemon's to know, not a daemon's that a CLI starts.
        WALNUT_DAEMON_IMAGES_DIR: undefined,
        // A test server's isolated daemon (remote-isolation.ts) is this daemon's own identity: a
        // daemon a CLI starts (a nested test server's) must not claim it. Keep in sync with the twin.
        WALNUT_DAEMON_ISOLATED_FOR: undefined,
        WALNUT_DAEMON_ORPHAN_EXIT_MS: undefined,
        WALNUT_INSTALL_HOME: undefined,
        // And the compiled file's runtime dir (src/binary/runtime-tree.ts): it names the
        // SERVING stage's runtime/, which a later deploy deletes. A walnut CLI the session runs
        // would unpack there or, after that deploy, mkdir it back inside a dead stage; without
        // it a compiled walnut uses its own default tree. A service set's own dir stays: it is
        // its install root's, which no deploy deletes, and without it every `walnut` of the
        // set's sessions unpacked into, and pruned, the default Walnut's data home.
        WALNUT_RUNTIME_DIR: SESSION_RUNTIME_DIR,
      },
    }
    let barrier: ReturnType<typeof spawnBehindRegistry> | null = null
    let proc: ReturnType<typeof spawn>
    try {
      // Last synchronous point before the CLI exists: a fence set during the awaits above wins.
      if (demoQuiesce.fenced) throw new Error('start: Demo is stopping; no new session starts')
      barrier = SERVICE_MODE ? spawnBehindRegistry(userShell, ['-c', shellCmd], spawnOptions, childUse) : null
      // Every launch is issued here, synchronously after the fence read. Inside another program the
      // pool's thread starts it (spawn-pool.ts posts the request at once) and its pid comes back after.
      const launched = barrier?.process
        ?? (spawnPool ? spawnPool.spawnDetached(userShell, ['-c', shellCmd], spawnOptions) : spawn(userShell, ['-c', shellCmd], spawnOptions))
      proc = launched instanceof Promise ? containListeners(await launched, runtimeTimers.contain) as unknown as ReturnType<typeof spawn> : launched
    } catch (error) {
      fs.closeSync(pipeFd); fs.closeSync(outputFd); fs.closeSync(stderrFd)
      throw error
    }
    try {
    // Detect spawn failure immediately — proc.pid is undefined when posix_spawn fails.
    // This catches cwd-doesn't-exist, shell-not-found, and other synchronous spawn errors
    // BEFORE we send ok:true back to the client.
    if (!proc.pid) {
      logMsg('error', 'spawn failed: no PID (likely bad cwd or missing shell)', { sid, cwd })
      // Clean up files we just created
      try { fs.closeSync(pipeFd) } catch {}
      try { fs.closeSync(outputFd) } catch {}
      try { fs.closeSync(stderrFd) } catch {}
      try { fs.unlinkSync(pipePath) } catch {}
      if (!resume) {
        try { fs.unlinkSync(jsonlPath) } catch {}
        try { fs.unlinkSync(stderrPath) } catch {}
      }
      // Drain the async error event to prevent unhandled rejection
      proc.on('error', () => {})
      throw new Error(`spawn failed: process could not start on ${os.hostname()} (cwd: ${cwd})`)
    }
    // line-answer-v1: where this process's output begins, so a line an earlier process
    // took is never answered by this one's output (line-fate-core.ts lineFateScan). Silent
    // (no words, no uuid, no session_id). Written before the CLI boots. walnutTurn: this process starts on the message below: the fold
    // counts the turn as open from here, not from the init the CLI prints once it booted
    // (daemon-fold.ts; 2026-11-05: a 25s boot read as an ended turn). Not for a
    // deferMessage start (its line may never be written; its send's marker anchors),
    // nor for a resume (the CLI may skip a line its transcript already has, by its uuid).
    const turnOnSpawn = typeof message === 'string' && message.length > 0 && !resumesTranscript
    try { fs.writeSync(outputFd, JSON.stringify({ type: 'system', subtype: 'walnut_process', walnutPid: proc.pid, ...(turnOnSpawn ? { walnutTurn: true } : {}) }) + '\n') } catch {}

    // Handle late spawn errors (shouldn't happen after pid is set, but defensive)
    proc.on('error', (err) => {
      logMsg('error', 'spawn error (post-start)', { sid, error: err.message })
    })

    // Write initial message to FIFO — only when one was provided. An empty message
    // means "spawn idle" (restart-to-reinitialize): the CLI still opens stdin and
    // emits its init event, but runs no turn. We keep the pipeFd open across the
    // O_RDWR lifetime like the send path, so the FIFO survives until the first real
    // message; closing it here (as the message path does after writing) is fine
    // because the CLI already holds its own read end.
    // Deliver only after registry ownership exists, through the guarded FIFO serializer.
    fs.closeSync(pipeFd)

    // Close fds in parent
    fs.closeSync(outputFd)
    fs.closeSync(stderrFd)

    // Save PID
    const pid = proc.pid
    proc.unref()
    try { fs.writeFileSync(pgidPath, String(pid)) } catch {}

    logStateTransition(sid, 'none', 'running', resume ? 'spawn-resume' : 'spawn-fresh', 'cmdStart', { pid })
    logMsg('info', 'session started', { sid, pid, resume: !!resume })

    // Track session
    const sessionData: SessionData<W> = {
      proc,
      pipePath,
      jsonlPath,
      pgidPath,
      pid,
      offset,
      // Fresh spawn → empty; resume → the fold of the existing jsonl (its tasks may still be live).
      taskState: resumeFold ? resumeFold.task : emptyTaskState(),
      // C1: fresh spawn (or a rotated file) starts an empty fold; resume folds the surviving jsonl.
      foldState: resumeFold ? resumeFold.fold : initialFoldState(0),
      foldCheckpointV: resumeFold ? resumeFold.checkpointV : undefined,
      watcher: null,
      subscribers: new Subscribers(),
      exitCode: null,
      state: 'running',
      exitReason: null,
      exitedAt: null,
      parented: true,
      startTime: readStartTime(pid),
      bootId: daemonBootId(),
      cwd,
      args,
      orphanPollTimer: null,
      mode: (mode as SessionMode) || 'default',
      pendingCtrl: null,
      cronMetadataLoaded: !resume,
      spawnTs: Date.now(),     // latency instrumentation: CLI spawn → first init line
      sawInit: false,
      spawnInfo,
    }

    ownerClaim?.commit(pid, sessionData.startTime)
    ownerCommitted = true

    proc.on('exit', runtimeTimers.contain('session exit handler', (code: number | null) => {
      // SIGCHLD is the fastest (near-0ms) death signal for parented sessions.
      // All cleanup funnels through reapSession so the exit path, missed-exit
      // fallback, and cmdSend-ENXIO path all produce the same side effects.
      //
      // Generation guard: if cmdStart REPLACED this sid (killing this process),
      // the map now holds the replacement session. reapSession(sid) re-resolves
      // by sid, so without this check the OLD process's death reaps the NEW
      // session ~100ms after its spawn (observed live: respawn under the same
      // sid died instantly with "proc-exit code 1").
      if (sessions.get(sid) !== sessionData) return
      reapSession(sid, code ?? 1, 'proc-exit')
    }))

    // What this process writes starts here (reapSession reads only that).
    sessionData.outputStartOffset = cronStartOffset
    sessionData.stderrStartOffset = stderrStartOffset
    sessionData.cronMetadataOrigin = { identity: cronProcess(sessionData).identity, offset: cronStartOffset, startedAt: cronStartedAt, fresh: !resume }
    sessions.set(sid, sessionData)
    // The command to start it again with, for a host resume (host-resume-core.ts).
    hostResume.remember(sid, { args, cwd, mode: sessionData.mode, home: spawnInfo.home, task: spawnInfo.task })
    // The tree before this session's first recorded turn, when it has none yet.
    try { turnSnapshots.onTurnStart(sid, cwd) } catch { /* never the spawn's problem */ }
    cronMetadata.configure(sid, cronProcess(sessionData), cronMetadataConfig())
    cronMetadata.state(sid, cronProcess(sessionData), false, !resume)
    // Write-ahead: flush registry before returning ok to caller so a crash-after-
    // spawn doesn't orphan the CLI without daemon knowledge. Awaited: the write
    // runs off the thread, the answer waits for it.
    try { await persistRegistryDurable() } catch (error) {
      if (SERVICE_MODE) throw error
    }

    await requireBudgetAllowance(sid)
    barrier?.release()
    broadcastSessionState(sid, 'running', { pid })
    ensureWatcher(sid)
    if (message) {
      // bootWait (send-boot-wait-v1): the client waits long enough for a CLI still booting.
      const sent: SendOutcome = await core.handleSendCommand(sid, message, initialUuid, undefined, { bootWait: cmd.bootWait === true })
      if (sent.reason === 'budget_paused' || sent.reason === 'budget_checking') throw budgetRefusal(sent.reason)
      if (!sent.ok) throw new Error(`start: initial message not delivered (${sent.reason ?? sent.error})`)
    }
    return { pid, outputFile: jsonlPath, offset }
    } catch (error) {
      barrier?.abort()
      throw error
    }
    } catch (error) {
      if (!ownerCommitted) await ownerClaim?.release()
      throw error
    }
  }

  return { cmdStart, startSessionProcess }
}
