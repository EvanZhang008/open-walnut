/**
 * What the JSONL tailer checks on a session's lines: a durable CronCreate (the cron.created hook's
 * correction), a turn that ended in error (the turn-error auto-retry: the policy is daemon-core's
 * decideTurnRetry), and a CLI cron that fired (its marker, and the provenance warning when another
 * session created it).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place the turn
 * retry had in its body; the tailer (daemon-session-tailer.ts) calls the checks, and every real
 * send, stop and death cancels a pending retry (cancelTurnRetry). The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { detectCronFires, durableCronCorrectionMessage, cronFireMarkerText, stripCronTaskById, parseTurnErrorLine, resolveTurnRetryConfig, decideTurnRetry, applyTurnRetry, clearTurnRetryStreak, newTurnRetryState, turnRetryMessage, turnRetryMarkerText, turnRetryGiveUpText, type BudgetGate, type DaemonCore } from './daemon-core.js'
import type { createDaemonCommandDrain } from './daemon-command-drain.js'
import type { createDaemonHooks } from './daemon-hooks.js'
import type { SessionData, DaemonCronRuntime, SendOutcome } from './daemon-session-types.js'
import type { DaemonCommand, DaemonEnv, DaemonLog } from './daemon-module-deps.js'

export interface DaemonLineChecksDeps<W extends object> {
  /** The runtime's env: the turn retry's settings are read from it once. */
  daemonEnv: DaemonEnv
  sessions: Map<string, SessionData<W>>
  core: DaemonCore<SessionData<W>>
  /** The command drain: a retry rides it, and a stopping daemon starts none. */
  daemonCommands: ReturnType<typeof createDaemonCommandDrain>
  /** Bumped by every cancel, so a retry check in flight knows it was overtaken. */
  retryCheckVersions: Map<string, number>
  /** The runtime's cron runtime, once Main made it. */
  cronRuntime: () => DaemonCronRuntime | null
  /** The hooks each Walnut pushed (daemon-hooks.ts). */
  hookActions: ReturnType<typeof createDaemonHooks<W>>['hookActions']
  budgetAllowance: (sid: string) => Promise<BudgetGate>
  /** A retry of a dead CLI is a bridge-safe resume (daemon-session-resume.ts). */
  cmdBridgeResume: DaemonCommand<W>
  persistRegistry: () => void
  /** The runtime's timers. */
  setTimeout: typeof globalThis.setTimeout
  clearTimeout: typeof globalThis.clearTimeout
  logMsg: DaemonLog
}

export function createDaemonLineChecks<W extends object>(deps: DaemonLineChecksDeps<W>) {
  const { daemonEnv, sessions, core, daemonCommands, retryCheckVersions, cronRuntime, hookActions, budgetAllowance, cmdBridgeResume, persistRegistry, setTimeout, clearTimeout, logMsg } = deps

  // ── Scheduled-task (CLI cron) fire detection ──
  // A cron fire in headless mode delivers its prompt STRAIGHT to the model —
  // nothing appears in the stream-json stdout except a bare turn start
  // (session_state_changed{running} + init), so neither the Mac nor the UI can
  // see it happened. The daemon is the only component with the cwd + the files,
  // so it checks {cwd}/.claude/scheduled_tasks.json on turn-start lines
  // (30s-throttled) and, when a recently-fired task was created by a DIFFERENT
  // session (directory-scoped lock adoption — upstream #50300/#66509):
  //   1. appends a scheduled_task_fire system marker to the stream file
  //      (history + live UI render it), and
  //   2. injects a provenance warning into the FIFO so the MODEL knows the
  //      prompt is an adopted cron, not the human.
  // Same-session fires get only the marker (normal /loop operation).
  const CRON_CHECK_THROTTLE_MS = 30_000

  // Hook point cron.created: a bypassPermissions session never emits a
  // can_use_tool control_request, so the cron.create deny can't fire — the job
  // is already on disk by the time the tool_use echoes in the stream. The only
  // available action is `inject` (fixed corrective text — the model is asked to
  // CronDelete + recreate non-durable; it may decline, which is why the hook
  // set pairs this with cron.fire evict). Once per tool_use id so a re-read of
  // the same line can't nag in a loop; `durableCronNudged` is in-memory only (a
  // respawn re-nudges, which is correct — the durable task is still on disk).
  function checkDurableCronCreate(sid: string, session: SessionData<W>, line: string, parseLine?: () => unknown) {
    let parsed: Record<string, unknown>
    try { parsed = (parseLine ? parseLine() : JSON.parse(line)) as Record<string, unknown> } catch { return }
    if (parsed.type !== 'assistant') return
    const content = (parsed.message as { content?: unknown })?.content
    if (!Array.isArray(content)) return
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use') continue
      if ((block.name as string | undefined) !== 'CronCreate') continue
      const actions = hookActions('cron.created', { input: block.input, mode: session.mode, sid })
      if (actions.includes('log')) {
        logMsg('info', 'hook log: cron.created', { sid, input: block.input, mode: session.mode })
      }
      if (!actions.includes('inject')) continue
      const key = String(block.id ?? 'unknown')
      if (!session.durableCronNudged) session.durableCronNudged = {}
      if (session.durableCronNudged[key]) continue
      session.durableCronNudged[key] = Date.now()
      // Task id isn't in the tool_use (the CLI mints it) — the model knows it
      // from its own tool_result, so the message asks it to delete "that task id".
      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: durableCronCorrectionMessage(undefined) },
      })
      void core.handleSendRawCommand(sid, payload).then((result: SendOutcome) => {
        logMsg(result.ok ? 'warn' : 'error', 'hook inject: durable CronCreate correction delivery', { sid, toolUseId: key, mode: session.mode, result })
      })
    }
  }

  // ── Turn-error auto-retry (policy in daemon-core: decideTurnRetry) ──
  //
  // Read ONCE at boot: the Mac sets these in the daemon spawn env from user
  // config, so a config change takes effect on the next daemon restart (same
  // contract as WALNUT_ENFORCE_SESSION_CRON — see DAEMON_RESTART_NOTE).
  const TURN_RETRY_CFG = resolveTurnRetryConfig(daemonEnv)

  /**
   * A turn ended with is_error. Decide whether to resume it, and if so schedule
   * the resume after a backoff.
   *
   * Called from the tailer on every `result` line. Two jobs:
   *   - a CLEAN result clears the failure streak (so the 12h budget bounds ONE
   *     outage, not the session's lifetime), and
   *   - an ERROR result runs the policy and either schedules a resume or writes a
   *     "gave up" marker for the human.
   *
   * The retry is delivered as a normal FIFO user message when the CLI is still
   * alive, and as a --resume respawn when it died — reusing the exact paths a
   * human "continue" would take, so no delivery invariant is special-cased.
   */
  async function checkTurnRetry(sid: string, session: SessionData<W>, line: string, v: number, parseLine?: () => unknown) {
    if (daemonCommands.stopping || !TURN_RETRY_CFG.enabled || cronRuntime()?.get(sid) || session.budgetGracefulStop) return
    const checkVersion = (retryCheckVersions.get(sid) ?? 0) + 1
    retryCheckVersions.set(sid, checkVersion)
    if (await budgetAllowance(sid) !== 'ok' || retryCheckVersions.get(sid) !== checkVersion || sessions.get(sid) !== session || session.state !== 'running' || session.intentionalStopAt != null) return
    const { isTurnError, text } = parseTurnErrorLine(line, parseLine)

    if (!isTurnError) {
      // Clean turn-over → the streak is over. Only persist when something changed.
      if (line.includes('"type":"result"') && session.turnRetry) {
        cancelTurnRetry(sid, 'turn-succeeded')
        if (clearTurnRetryStreak(session.turnRetry)) {
          logMsg('info', 'turn-retry streak cleared by a successful turn', { sid })
          persistRegistry()
        }
      }
      return
    }

    if (!session.turnRetry) session.turnRetry = newTurnRetryState()
    const now = Date.now()
    const decision = decideTurnRetry({ errorText: text, state: session.turnRetry, cfg: TURN_RETRY_CFG, nowMs: now, v })

    if (!decision.retry) {
      if (decision.reason === 'duplicate-line') return
      logMsg('warn', 'turn-retry declined', {
        sid, reason: decision.reason, errorText: text,
        attempts: session.turnRetry.attempts,
      })
      // Only tell the human when we actually STOPPED a retry cycle we had begun,
      // or when the error was retryable-looking but out of budget. A plain
      // terminal error on a session that never retried needs no extra row: the
      // CLI's own error is already in the timeline.
      if (decision.reason !== 'terminal' || session.turnRetry.attempts > 0) {
        appendSystemMarker(sid, session, 'turn_retry_stopped', turnRetryGiveUpText(decision.reason, text))
      }
      return
    }

    applyTurnRetry(session.turnRetry, now, v)
    persistRegistry()
    logMsg('warn', 'turn-retry scheduled', {
      sid, attempt: decision.attempt, delayMs: decision.delayMs,
      elapsedMs: decision.elapsedMs, budgetMs: TURN_RETRY_CFG.budgetMs, errorText: text,
    })
    appendSystemMarker(sid, session, 'turn_retry', turnRetryMarkerText({
      attempt: decision.attempt, delayMs: decision.delayMs, errorText: text,
      budgetMs: TURN_RETRY_CFG.budgetMs, elapsedMs: decision.elapsedMs,
    }))

    // Replace any pending timer — the newest failure owns the schedule.
    if (session.turnRetryTimer) { clearTimeout(session.turnRetryTimer); session.turnRetryTimer = null }
    const attempt = decision.attempt
    session.turnRetryTimer = setTimeout(() => {
      session.turnRetryTimer = null
      void fireTurnRetry(sid, attempt, text).catch((err) => {
        logMsg('error', 'turn-retry fire threw', { sid, error: (err as Error).message })
      })
    }, decision.delayMs)
  }

  /**
   * Deliver the retry.
   *
   * Re-resolves the session from the map rather than closing over it: across a
   * 10-minute backoff the entry can be reaped and REPLACED (a new CLI for the
   * same sid), and nudging a stale object would write to a dead FIFO.
   */
  async function fireTurnRetry(sid: string, attempt: number, errorText: string | null) {
    if (cronRuntime()?.get(sid)) return
    const session = sessions.get(sid)
    if (!session) {
      logMsg('info', 'turn-retry aborted — session gone', { sid, attempt })
      return
    }
    if (daemonCommands.stopping) return
    if (daemonCommands.closed) {
      if (session.turnRetryTimer) clearTimeout(session.turnRetryTimer)
      session.turnRetryTimer = setTimeout(() => {
        session.turnRetryTimer = null
        if (sessions.get(sid) !== session) return
        void fireTurnRetry(sid, attempt, errorText).catch((err) => {
          logMsg('error', 'turn-retry fire threw', { sid, error: (err as Error).message })
        })
      }, 1000)
      return
    }
    const message = turnRetryMessage(attempt, errorText)
    await daemonCommands.run(() => cmdBridgeResume(RETRY_WS_SINK, 0, { cmd: 'bridgeResume', sid, message, autoRetry: true }))
  }

  /**
   * A retry is daemon-initiated, so there is no client socket to answer. The
   * command handlers all take a ws to reply on, so give them a sink that drops
   * the reply but still records failures — a silent drop would hide a broken
   * resume for 12 hours.
   */
  const RETRY_WS_SINK = {
    readyState: 1,
    send: (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as { error?: string }
        if (parsed?.error) logMsg('error', 'turn-retry resume returned an error', { error: parsed.error })
      } catch { /* non-JSON reply — nothing to report */ }
      return 1
    },
    close: () => {},
  } as unknown as W

  /** Append a `type:"system"` marker to the stream file so the session timeline
   *  shows what the daemon did. Same pattern as the cron-fire marker: stream file
   *  only, never the canonical JSONL. */
  function appendSystemMarker(sid: string, session: SessionData<W>, subtype: string, content: string) {
    try {
      const marker = JSON.stringify({
        type: 'system', subtype, content,
        uuid: crypto.randomUUID(), session_id: sid,
        timestamp: new Date().toISOString(),
      }) + '\n'
      fs.appendFileSync(session.jsonlPath, marker)
    } catch (err) {
      logMsg('warn', 'system marker append failed', { sid, subtype, error: (err as Error).message })
    }
  }

  /** Cancel a pending retry. Called when a REAL send arrives (the human took over
   *  — never inject behind them) and from the death funnel. */
  function cancelTurnRetry(sid: string, reason: string) {
    retryCheckVersions.set(sid, (retryCheckVersions.get(sid) ?? 0) + 1)
    const session = sessions.get(sid)
    if (!session?.turnRetryTimer) return
    clearTimeout(session.turnRetryTimer)
    session.turnRetryTimer = null
    logMsg('info', 'turn-retry canceled', { sid, reason })
  }

  function checkCronFires(sid: string, session: SessionData<W>) {
    const now = Date.now()
    if (session.lastCronCheckTs && now - session.lastCronCheckTs < CRON_CHECK_THROTTLE_MS) return
    session.lastCronCheckTs = now
    if (!session.cwd) return
    const base = path.join(session.cwd, '.claude')
    let tasksJson: string | null = null
    let lockJson: string | null = null
    try { tasksJson = fs.readFileSync(path.join(base, 'scheduled_tasks.json'), 'utf-8') } catch { return }
    try { lockJson = fs.readFileSync(path.join(base, 'scheduled_tasks.lock'), 'utf-8') } catch {}
    if (!session.cronWarned) session.cronWarned = {}
    const fires = detectCronFires({ sid, tasksJson, lockJson, nowMs: now, warned: session.cronWarned })
    for (const fire of fires) {
      logMsg(fire.foreign ? 'warn' : 'info', 'scheduled-task fire detected', {
        sid, taskId: fire.taskId, foreign: fire.foreign,
        createdBySessionId: fire.createdBySessionId, lastFiredAt: fire.lastFiredAt,
      })
      // 1. Hook point cron.fire — evaluated BEFORE the marker so the marker can
      // report what actually happened. The interesting action is `evict` on a
      // FOREIGN fire: an orphaned durable cron just hijacked this session, and
      // nobody in this process will ever CronDelete it — removing the row is
      // the only thing that ends the loop. Deliberately NO model-visible
      // message here: the injected warning this replaced cost a turn + context
      // every hour and could not stop anything (a model verifiably ignored one,
      // 2026-08-11). The stream marker below tells the HUMAN.
      let evicted = false
      {
        const actions = hookActions('cron.fire', {
          foreign: fire.foreign, taskId: fire.taskId,
          createdBySessionId: fire.createdBySessionId ?? null, sid,
        })
        if (actions.includes('log')) {
          logMsg('info', 'hook log: cron.fire', { sid, taskId: fire.taskId, foreign: fire.foreign })
        }
        if (actions.includes('evict')) {
          try {
            const tasksPath = path.join(base, 'scheduled_tasks.json')
            const strip = stripCronTaskById(tasksJson, fire.taskId)
            if (strip.changed && strip.text != null) {
              const tmp = tasksPath + '.walnut-' + String(process.pid) + '.tmp'
              fs.writeFileSync(tmp, strip.text, { mode: 0o600 })
              fs.renameSync(tmp, tasksPath)
              evicted = true
              logMsg('warn', 'hook evict: removed orphaned foreign cron', {
                sid, taskId: fire.taskId, createdBySessionId: fire.createdBySessionId, tasksPath,
              })
            }
          } catch (err) {
            logMsg('warn', 'hook evict failed', { sid, taskId: fire.taskId, error: (err as Error).message })
          }
        }
      }
      // 2. Stream-file marker — same append pattern as handleAppendUserMarker
      // (never the canonical JSONL). The tailer folds it (unknown system subtype
      // = v-only, safe) and fans it out; session-history renders
      // scheduled_task_fire as a system info row.
      try {
        const marker = JSON.stringify({
          type: 'system',
          subtype: 'scheduled_task_fire',
          content: cronFireMarkerText(fire, { evicted }),
          cron_task_id: fire.taskId,
          cron_created_by: fire.createdBySessionId ?? null,
          cron_foreign: fire.foreign,
          uuid: crypto.randomUUID(),
          session_id: sid,
          timestamp: new Date(now).toISOString(),
        }) + '\n'
        fs.appendFileSync(session.jsonlPath, marker)
      } catch (err) {
        logMsg('warn', 'scheduled-task fire: marker append failed', { sid, error: (err as Error).message })
      }
    }
  }

  return { TURN_RETRY_CFG, checkDurableCronCreate, checkTurnRetry, cancelTurnRetry, checkCronFires }
}

/** What createDaemonLineChecks returns (the runtime names its type, so the session areas that call each other infer no cycle). */
export type DaemonLineChecks<W extends object> = ReturnType<typeof createDaemonLineChecks<W>>
