/**
 * The JSONL tailer of each session on this host (ensureWatcher): one poll timer per session reads
 * its stream file, folds each new line (task state, snapshot, the checks of daemon-line-checks.ts,
 * the hooks, the usage budget) and fans it out to every subscriber; and a subscriber's join
 * (addSubscriber), which replays what it missed first. The cron metadata replay of an adopted
 * session runs here too (cronMetadataReplay, this module's own chain).
 *
 * Created once per runtime by createDaemonRuntime (daemon-standalone.ts), at the place this code
 * had in its body; every start, attach, adopt and rename starts a tailer through ensureWatcher,
 * and a reap, replace or rename stops one (stopSessionWatcher). The code is the runtime's as it
 * was; deps carry the runtime's own names.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { shouldAutoRespond, buildControlResponse, durableCronDenyMessage, observedPermissionMode, type DaemonCore } from './daemon-core.js'
import { foldLine } from './daemon-fold.js'
import { createSessionTailer } from './session-tailer.js'
import { readCronMetadataStream, type createCronMetadataTracker } from './daemon-cron-metadata.js'
import type { CliOwner } from './cli-owner-core.js'
import type { createLiveSettings } from './live-settings-core.js'
import type { createUsageBudgetRuntime } from './usage-budget-runtime.js'
import type { createBudgetControl } from './usage-budget-control.js'
import type { readCronCliConfig } from './daemon-cron-runtime.js'
import type { createDaemonHooks } from './daemon-hooks.js'
import type { SessionData, SendOutcome, TaskState, WsData } from './daemon-session-types.js'
import type { DaemonLog } from './daemon-module-deps.js'

export interface DaemonSessionTailerDeps<W extends { data: WsData; readyState: number }> {
  SERVICE_MODE: boolean
  /** The most a tailer carries of one unfinished line, and reads in one tick. */
  TAILER_CARRY_MAX: number
  TAILER_TICK_READ_MAX: number
  sessions: Map<string, SessionData<W>>
  core: DaemonCore<SessionData<W>>
  cliOwner: CliOwner
  /** The offline host's answers (offline-journal-core.ts): a result line may close one. */
  offlineHost: { onResult: (sid: string, line: string, v: number, parse: () => unknown) => Promise<unknown> }
  liveSettings: Pick<ReturnType<typeof createLiveSettings>, 'noteResponse'>
  usageBudget: ReturnType<typeof createUsageBudgetRuntime>
  budgetControl: ReturnType<typeof createBudgetControl>
  cronMetadata: ReturnType<typeof createCronMetadataTracker>
  /** The CLI's cron config, once read. */
  cronMetadataConfig: () => Awaited<ReturnType<typeof readCronCliConfig>> | null
  /** The cron tracker's view of the session's process (and whether it was a fresh start). */
  cronProcess: (session: SessionData<W>) => Parameters<ReturnType<typeof createCronMetadataTracker>['configure']>[1] & { fresh: boolean }
  hookActions: ReturnType<typeof createDaemonHooks<W>>['hookActions']
  applyTaskEvent: (ts: TaskState, parsed: Record<string, unknown>, v: number, now: number) => boolean
  appendSpawnJournal: (sid: unknown, rec: Record<string, unknown>) => void
  namedSessionId: (args: string[]) => string | undefined
  streamEpochOf: (session: SessionData<W>) => string | null
  pushSnapshot: (sid: string, immediate: boolean) => void
  persistRegistry: () => void
  writeFifoRaw: (pipePath: string, raw: string) => boolean
  checkCronFires: (sid: string, session: SessionData<W>) => void
  checkDurableCronCreate: (sid: string, session: SessionData<W>, line: string, parseLine?: () => unknown) => void
  checkTurnRetry: (sid: string, session: SessionData<W>, line: string, v: number, parseLine?: () => unknown) => Promise<void>
  /** Turn snapshots (daemon-transcripts.ts, made further down, so asked on use). */
  turnSnapshots: { onTurnEnd: (sid: string, cwd: string, v: number) => unknown }
  /** What a subscriber is handed beside a line (the runtime's protocol helper). */
  parsedFor: (ws: W, parse: () => unknown) => Record<string, unknown> | undefined
  wsId: (ws: W) => number
  /** The runtime's timers. */
  setInterval: typeof globalThis.setInterval
  clearInterval: typeof globalThis.clearInterval
  logMsg: DaemonLog
  sendEvent: (ws: W, ev: string, data: Record<string, unknown>, local?: Record<string, unknown>) => void
}

export function createDaemonSessionTailer<W extends { data: WsData; readyState: number }>(deps: DaemonSessionTailerDeps<W>) {
  const { SERVICE_MODE, TAILER_CARRY_MAX, TAILER_TICK_READ_MAX, sessions, core, cliOwner, offlineHost, liveSettings, usageBudget, budgetControl, cronMetadata, cronMetadataConfig, cronProcess, hookActions, applyTaskEvent, appendSpawnJournal, namedSessionId, streamEpochOf, pushSnapshot, persistRegistry, writeFifoRaw, checkCronFires, checkDurableCronCreate, checkTurnRetry, turnSnapshots, parsedFor, wsId, setInterval, clearInterval, logMsg, sendEvent } = deps

  // ── File watching for JSONL streaming ──
  //
  // Lifecycle: session-bound (NOT ws-bound). One poll timer per session reads
  // the JSONL and fans new lines out to every currently-subscribed ws. ws
  // connect/disconnect does not affect the watcher. See the SessionData<W>
  // interface comment for the full rationale.

  let cronMetadataReplay: Promise<void> = Promise.resolve()

  // Idempotent: if the session already has a watcher, does nothing.
  /**
   * After a result: the last 4 KB of the CLI's stderr to every subscriber, so MCP failures and CLI
   * bails are visible without a shell on the host. Read asynchronously, off the tailer's clock.
   */
  async function pushStderrTail(sid: string, s: SessionData<W>, stderrPath: string): Promise<void> {
    let tail = ''
    try {
      const { size } = await fs.promises.stat(stderrPath)
      if (size <= 0) return
      const readLen = Math.min(size, 4096)
      const handle = await fs.promises.open(stderrPath, 'r')
      try {
        const ebuf = Buffer.alloc(readLen)
        const { bytesRead } = await handle.read(ebuf, 0, readLen, Math.max(0, size - readLen))
        tail = ebuf.subarray(0, bytesRead).toString('utf-8').trim()
      } finally { await handle.close() }
    } catch { return }
    if (!tail || sessions.get(sid) !== s) return
    // DUP-DEBUG: stderr_tail is once-per-result. Always log fan-out size + recipient wsIds to
    // confirm whether the daemon is sending to one ws or several.
    const recipientWsIds: number[] = []
    for (const ws of s.subscribers) {
      if (ws.readyState === 1) {
        recipientWsIds.push(wsId(ws))
        try { sendEvent(ws, 'stderr_tail', { sid, tail }) } catch {}
      }
    }
    logMsg('info', 'stderr_tail fan-out', { sid, subscriberCount: s.subscribers.size, recipientWsIds })
  }

  function ensureWatcher(sid: string) {
    const session = sessions.get(sid)
    if (!session) return
    if (session.watcher) return // already running
    if (session.state !== 'running') return
    if (!session.cronMetadataLoaded && (session.cronMetadataOrigin || Object.keys(session.foldState.cronIds).length > 0)) {
      session.cronMetadataLoaded = true
      session.cronMetadataLoading = true
      const process = cronProcess(session)
      cronMetadata.configure(sid, process, cronMetadataConfig())
      cronMetadata.replay(sid, process, true)
      cronMetadataReplay = cronMetadataReplay.then(async () => {
        if (sessions.get(sid) !== session) return
        let start = process.attributeByTime ? 0 : process.startOffset ?? 0
        cronMetadata.state(sid, process, Object.keys(session.foldState.cronIds).length > 0, process.fresh)
        // A by-time adopt reads the whole stream once (measured 4.1s for a 1GB
        // stream, 2.0M lines, on the host that owns the biggest one), so it gets a
        // budget that fits the file instead of the per-turn one a spawn needs.
        const signal = AbortSignal.timeout(process.attributeByTime ? 120_000 : 10_000)
        for (;;) {
          const end = session.watcher?.offset ?? session.offset
          // The watcher starts before this process's first byte (a rotated file's
          // carry line, a dead CLI's cut last line): nothing of it was read yet,
          // and the watcher observes its lines live once loading ends.
          if (end < start) break
          await readCronMetadataStream(session.jsonlPath, start, end, signal, (line, offset) => {
            if (sessions.get(sid) === session) cronMetadata.observe(sid, process, line, true, offset)
          }, {
            processBoundary: start === process.startOffset,
            expectedEpoch: streamEpochOf(session) ?? undefined,
            onGap: () => { if (sessions.get(sid) === session) cronMetadata.replay(sid, process, true, true) },
            pendingIds: () => cronMetadata.pendingIds(sid),
          })
          if (sessions.get(sid) !== session) return
          start = end
          if (start === (session.watcher?.offset ?? session.offset)) break
        }
        cronMetadata.replay(sid, cronProcess(session), false)
      }).catch((error) => {
        logMsg('warn', 'cron metadata replay failed', { sid, error: String(error) })
        if (sessions.get(sid) === session) cronMetadata.replay(sid, cronProcess(session), false, true)
      }).finally(() => { if (sessions.get(sid) === session) session.cronMetadataLoading = false })
    }

    const stderrPath = session.jsonlPath + '.err'
    // Tailer self-heal (incident 6c8428ac): a per-read error (EMFILE, ...) once froze the read
    // cursor while the CLI kept writing, and Walnut showed idle for a running session. Sustained
    // failure = a stalled tailer: logged (rate-limited), then rebuilt from the last complete line.
    let lastErrorLogTs = 0
    const STALL_ERRORS_BEFORE_HEAL = 50 // ~5s of 100ms ticks failing back-to-back
    const HEAL_COOLDOWN_MS = 60_000

    // The file is read off the main thread's clock, a read at a time (session-tailer.ts); this is
    // the per-line work, on the complete lines of each read.
    const tailer = createSessionTailer({
      path: session.jsonlPath,
      startOffset: session.offset || 0,
      maxReadBytes: TAILER_TICK_READ_MAX,
      carryMaxBytes: TAILER_CARRY_MAX,
      timers: { setInterval, clearInterval },
      active: () => { const s = sessions.get(sid); return !!s && s.state === 'running' && s.watcher?.pollTimer === tailer.timer },
      // Publish the last COMPLETE-line boundary (not the read cursor) so replay/attach never hand a
      // client a mid-line offset.
      onBoundary: (boundary) => { const s = sessions.get(sid); if (s?.watcher) s.watcher.offset = boundary },
      onLines: (batch, { overflowed: cronMetadataGap, carryBytes, cursor }) => {
      const s = sessions.get(sid)
      if (!s) return
      if (cronMetadataGap) logMsg('error', 'tailer carry overflow — dropping oversized partial line', {
        sid, carryBytes, cap: TAILER_CARRY_MAX, offset: cursor,
      })
      let sawResult = false
      // The cron tracker's view of this process, once per slice (cronProcess builds it anew each call).
      const cronProc = cronProcess(s)
      cronMetadata.configure(sid, cronProc, cronMetadataConfig())
      for (const { line, v, parse } of batch) {
        if (!line.trim()) continue

        // A rebuilt watcher can read a range again: dedupe on the line's true v.
        const modeLineFresh = v > s.foldState.v
        if (v > s.foldState.v) s.foldState = foldLine(s.foldState, line, v, parse)

        if (!s.cronMetadataLoading) cronMetadata.observe(sid, cronProc, line, false, undefined, parse)
        if (modeLineFresh && line.includes('"permissionMode"')) {
          try { const actual = observedPermissionMode(parse() as Parameters<typeof observedPermissionMode>[0]); if (actual) s.mode = actual } catch {}
        }

        // Evidence is observed before a result can schedule another billable turn.
        if (line.includes('"assistant"') || line.includes('"system"') || line.includes('"result"') || line.includes('"control_response"')) {
          try { const parsed = parse() as Parameters<typeof usageBudget.observe>[1]; usageBudget.observe(sid, parsed); budgetControl.noteResponse(sid, parsed as Parameters<typeof budgetControl.noteResponse>[1]) } catch {}
        }

        // ── Latency instrumentation: time from CLI spawn → first init line ──
        // Pure CLI cold-start (incl. MCP connect) as the daemon sees it, directly
        // comparable to running `claude` by hand. Logged once per session.
        if (!s.sawInit && line.includes('"type":"system"') && line.includes('"init"')) {
          try {
            const init = parse() as any
            if (init.type === 'system' && init.subtype === 'init') appendSpawnJournal(init.session_id, s.spawnInfo ?? { kind: 'new' })
            // A fork or an unnamed new session: its own id is known only now (cli-owner-core.ts).
            if (init.type === 'system' && init.subtype === 'init' && typeof init.session_id === 'string' && s.pid && !namedSessionId(s.args)) {
              void cliOwner.adopt(init.session_id, s.pid, s.startTime ?? null, s.spawnInfo?.home)
            }
            if (init.type === 'system' && init.subtype === 'init' && typeof init.claude_code_version === 'string') {
              s.cliVersion = init.claude_code_version
              if (SERVICE_MODE) persistRegistry()
            }
          } catch {}
          s.sawInit = true
          logMsg('info', 'first init line from CLI', {
            sid, spawnToInitMs: s.spawnTs ? Date.now() - s.spawnTs : null,
          })
        }

        // ── TTFT instrumentation (inc-1786665503510): send → first output ──
        // Anchored by handleSendCommand (ttftSendTs). Two one-shot lines per
        // turn: first stream_event of any kind (model started answering — the
        // Bedrock TTFB proxy), and first text_delta (user-visible prose began).
        // A huge sendToFirstTextMs with a normal sendToFirstLineMs = the model
        // spent the gap thinking/tooling (upstream behavior, not a walnut bug).
        // Substring gates keep the hot path parse-free; cleared at result.
        if (s.ttftSendTs && line.includes('"type":"stream_event"')) {
          if (!s.ttftSawFirstLine) {
            s.ttftSawFirstLine = true
            logMsg('info', 'ttft: first stream_event after send', {
              sid, sendToFirstLineMs: Date.now() - s.ttftSendTs,
            })
          }
          if (line.includes('"text_delta"')) {
            logMsg('info', 'ttft: first text_delta after send', {
              sid, sendToFirstTextMs: Date.now() - s.ttftSendTs,
            })
            s.ttftSendTs = null // one-shot: only the FIRST text of the turn
          }
        }

        // ── Scheduled-task fire detection (see checkCronFires) ──
        // A cron fire's ONLY stream evidence is a bare turn start: the CLI
        // re-emits init + session_state_changed{running} with no user line.
        // Check the on-disk scheduled_tasks.json on those lines (30s throttle
        // inside makes this cheap; substring gate keeps the hot path free).
        if (line.includes('"init"') || line.includes('"session_state_changed"')) {
          try { checkCronFires(sid, s) } catch {}
        }

        // ── Durable-cron invariant, corrective half (see checkDurableCronCreate) ──
        if (line.includes('CronCreate')) {
          try { checkDurableCronCreate(sid, s, line, parse) } catch {}
        }

        // ── Turn-error auto-retry (see checkTurnRetry) ──
        // Gate on the result-line substring only; the parse + is_error check
        // lives in the policy. Clean results come through too, because a
        // successful turn is what clears the failure streak.
        if (line.includes('"type":"result"')) {
          s.ttftSendTs = null // turn over — a stale TTFT anchor must not leak into replays
          void checkTurnRetry(sid, s, line, v, parse).catch(err => {
            logMsg('warn', 'turn-retry check threw', { sid, error: (err as Error).message })
          })
          // A reply request this host owns ends with this turn (offline-host-core.ts).
          void offlineHost.onResult(sid, line, v, parse).catch(() => {})
          // The working tree as this turn left it (turn-snapshot-core.ts): returns at once.
          try { turnSnapshots.onTurnEnd(sid, s.cwd, v) } catch { /* never the tailer's problem */ }
        }

        // ── L2: materialize daemon-authoritative task state ──
        // Cheap substring pre-filter (task_* events are `"type":"system"` lines carrying a
        // `task_` subtype) so we JSON.parse only the relevant ~1% of lines. The applied state
        // is served on `getState` so Walnut can reconcile a lost-terminal event without guessing.
        if (line.includes('"task_')) {
          try {
            const parsed = parse() as Record<string, unknown>
            if (applyTaskEvent(s.taskState, parsed, v, Date.now())) {
              logMsg('info', 'task transition', {
                sid, bgTaskId: parsed.task_id, status: s.taskState.tasks[parsed.task_id as string]?.status,
                derivedRunning: s.taskState.derivedRunning, v,
              })
            }
          } catch { /* malformed line — skip */ }
        }

        // ── Permission policy intercept ──
        if (line.includes('"control_request"') || line.includes('"control_response"')
          || line.includes('"control_cancel_request"')) {
          try {
            const parsed = parse() as Record<string, unknown>
            // The CLI's answer to a model or effort change this daemon wrote (leader.settings).
            if (parsed.type === 'control_response') liveSettings.noteResponse(sid, parsed)
            if (parsed.type === 'control_request' && parsed.request_id
              && (parsed.request as Record<string, unknown>)?.subtype === 'can_use_tool') {
              const req = parsed.request as Record<string, unknown>
              const toolName = req.tool_name as string | undefined
              // ── Hook point cron.create (see daemon-core.ts) ──
              // Evaluated BEFORE the auto-allow check: a bypass-mode session
              // would otherwise be waved through, and a durable job outlives
              // this session to fire inside a stranger sharing the directory.
              if (toolName === 'CronCreate') {
                const actions = hookActions('cron.create', { input: req.input, mode: s.mode, sid })
                if (actions.includes('log')) {
                  logMsg('info', 'hook log: cron.create', { sid, input: req.input, mode: s.mode })
                }
                if (actions.includes('deny')) {
                  const resp = buildControlResponse(
                    parsed.request_id as string, req, false, durableCronDenyMessage(),
                  )
                  if (writeFifoRaw(s.pipePath, resp)) {
                    s.pendingCtrl = null
                    try { persistRegistry() } catch {}
                    logMsg('warn', 'hook deny: durable CronCreate refused (session-scoped crons only)', {
                      sid, mode: s.mode,
                    })
                    continue
                  }
                  // Deliberate fall-through: a failed deny write proceeds to
                  // shouldAutoRespond (a bypass session then auto-allows the
                  // durable cron). Blocking the turn forever would be worse —
                  // cron.fire evict + session.reap strip still cover the row.
                  logMsg('error', 'hook deny: response could not be written to FIFO', { sid })
                }
              }
              if (shouldAutoRespond(s.mode, toolName)) {
                // The answer is Walnut's business only when it could not be given:
                // pending until the write lands (handleSendRawCommand clears it), and
                // the prompt reaches Walnut late only when the write was refused (a
                // paused budget, a dead pipe), so the human can still answer it.
                const reqId = parsed.request_id as string
                s.pendingCtrl = { reqId, toolName: toolName ?? 'unknown', request: req, receivedAt: Date.now() }
                try { persistRegistry() } catch {}
                const resp = buildControlResponse(reqId, req, true)
                void core.handleSendRawCommand(sid, resp).then((result: SendOutcome) => {
                  if (result.ok) {
                    logMsg('info', 'auto-allowed control_request', { sid, tool: toolName, mode: s.mode })
                    return
                  }
                  logMsg('warn', 'auto-allow not delivered; the prompt goes to Walnut', { sid, tool: toolName, mode: s.mode, result })
                  if (s.pendingCtrl?.reqId !== reqId) return
                  for (const ws of s.subscribers) {
                    if (ws.readyState === 1) { try { sendEvent(ws, 'jsonl', { sid, line, v }, parsedFor(ws, parse)) } catch {} }
                  }
                  pushSnapshot(sid, false)
                })
                continue
              }
              s.pendingCtrl = {
                reqId: parsed.request_id as string,
                toolName: toolName ?? 'unknown',
                request: req,
                receivedAt: Date.now(),
              }
              try { persistRegistry() } catch {}
            } else if (parsed.type === 'control_response' && s.pendingCtrl) {
              const resp = parsed.response as Record<string, unknown> | undefined
              if (resp?.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null
                try { persistRegistry() } catch {}
              }
            } else if (parsed.type === 'control_cancel_request' && s.pendingCtrl) {
              // CLI withdrew the request (turn aborted / restart). Without this
              // branch pendingCtrl stays set forever → snapshot waiting=true and
              // the UI shows a permanent Waiting badge (incident a172ce49).
              if (parsed.request_id === s.pendingCtrl.reqId) {
                s.pendingCtrl = null
                try { persistRegistry() } catch {}
                logMsg('info', 'control_cancel_request cleared pendingCtrl', { sid, requestId: parsed.request_id })
              }
            }
          } catch { /* parse failed, fall through to normal push */ }
        }

        // Fan out to all current subscribers, GC dead ones opportunistically.
        // DUP-DEBUG: only log fan-out when subscribers > 1 (the duplicate
        // smoking gun) AND only for tool_use lines (cheap to detect via
        // substring). High-frequency text deltas would spam the log.
        const fanCount = s.subscribers.size
        const isToolUseLine = fanCount > 1 && line.includes('"type":"tool_use"')
        const recipientWsIds: number[] = []
        for (const ws of s.subscribers) {
          if (ws.readyState === 1) {
            if (isToolUseLine) recipientWsIds.push(wsId(ws))
            // `v` MUST ride every live line (same as the replay path below):
            // without it the client falls back to relative
            // byte accounting, which drifts on skipped control lines → replay
            // windows + duplicate blocks on reattach.
            try { sendEvent(ws, 'jsonl', { sid, line, v }, parsedFor(ws, parse)) } catch {}
          } else {
            logMsg('info', 'GC dead subscriber from watcher fan-out', {
              sid, wsId: wsId(ws), readyState: ws.readyState,
            })
            s.subscribers.delete(ws)
          }
        }
        if (isToolUseLine) {
          logMsg('info', 'jsonl fan-out (tool_use, multi-subscriber)', {
            sid,
            subscriberCount: fanCount,
            recipientWsIds,
            lineSnippet: line.slice(0, 120),
          })
        }
        if (!sawResult && line.includes('"type":"result"')) sawResult = true
      }
      if (cronMetadataGap) cronMetadata.replay(sid, cronProcess(s), !!s.cronMetadataLoading, true)
      // ── C1: after each tailer batch, push the snapshot if it changed (this
      // also covers pendingCtrl set/clear — both happen inside this loop).
      pushSnapshot(sid, false)
      // After a result event, push stderr tail so MCP failures / CLI bails are
      // visible without SSH. Fan to all subscribers.
      if (sawResult) void pushStderrTail(sid, s, stderrPath)
      },
      onError: (err, consecutiveErrors) => {
        const s = sessions.get(sid)
        if (!s) return
        // NO-SILENT-FAILURES: log (rate-limited, this fires every 100ms while the error persists)
        // and self-heal after sustained failure.
        const now = Date.now()
        if (now - lastErrorLogTs > 10_000) {
          lastErrorLogTs = now
          logMsg('error', 'watcher poll tick failed', {
            sid, consecutiveErrors, offset: tailer.cursor,
            err: err instanceof Error ? `${(err as NodeJS.ErrnoException).code ?? ''} ${err.message}` : String(err),
          })
        }
        if (consecutiveErrors >= STALL_ERRORS_BEFORE_HEAL
          && now - (s.lastWatcherHealAt ?? 0) > HEAL_COOLDOWN_MS) {
          // Generation guard: only heal if this is still the session's tailer.
          if (!s.watcher || s.watcher.pollTimer !== tailer.timer) {
            logMsg('warn', 'stalled watcher is orphaned (session replaced) — clearing self', { sid })
            tailer.stop()
            return
          }
          s.lastWatcherHealAt = now
          logMsg('error', 'watcher stalled — forcing rebuild', { sid, offset: tailer.cursor, carryStartV: tailer.boundary, consecutiveErrors })
          // The last COMPLETE-line boundary (NOT the read cursor): the carry dies with this tailer,
          // so the rebuilt one re-reads the torn region (append-only file; client `v` dedup absorbs any overlap).
          s.offset = tailer.boundary
          stopSessionWatcher(sid)
          ensureWatcher(sid)
        }
      },
    })

    session.watcher = { pollTimer: tailer.timer, offset: tailer.boundary, tailer }
  }

  // Stop the session-bound watcher. Only called from reapSession (session died)
  // or daemon shutdown. NEVER called from ws.close.
  function stopSessionWatcher(sid: string) {
    const session = sessions.get(sid)
    if (!session || !session.watcher) return
    // Save offset back to session so a subsequent ensureWatcher() resumes from
    // here instead of re-streaming the entire jsonl file from byte 0. Matters
    // for cmdRename, where we intentionally tear down + re-create the watcher.
    session.offset = session.watcher.offset
    try { if (session.watcher.tailer) session.watcher.tailer.stop(); else clearInterval(session.watcher.pollTimer) } catch {}
    session.watcher = null
  }

  // Most bytes one catch-up replay reads. An offset of 0, or one taken from
  // another file, against a whale stream (1.79 GB seen live) would otherwise
  // allocate and split the whole gap on the daemon's one thread.
  const REPLAY_BACKFILL_MAX_BYTES = 8 * 1024 * 1024

  // Add ws to the session's subscribers and catch-up-push bytes
  // [fromOffset, currentOffset) to this one ws so reconnecting clients see no gap.
  // A gap over REPLAY_BACKFILL_MAX_BYTES replays only its newest lines, after a
  // replay_truncated system line saying how many bytes were skipped.
  function addSubscriber(ws: W, sid: string, fromOffset: number): boolean {
    const session = sessions.get(sid)
    if (!session) return false
    // DUP-DEBUG: capture the subscriber set BEFORE add so we can log who was
    // already attached. If `before` already contains this ws's wsId, we have a
    // double-add bug; if it contains other live wsIds for the same sid, every
    // subsequent push will fan out to all of them, doubling downstream events.
    const before = Array.from(session.subscribers).map((s) => ({
      wsId: wsId(s), readyState: s.readyState,
    }))
    session.subscribers.add(ws)
    ensureWatcher(sid)
    logMsg('info', 'addSubscriber: attached', {
      sid,
      wsId: wsId(ws),
      fromOffset,
      subscribersBefore: before,
      subscribersAfter: session.subscribers.size,
    })

    const currentOffset = session.watcher ? session.watcher.offset : 0
    const start = typeof fromOffset === 'number' && fromOffset >= 0 ? fromOffset : 0
    if (start < currentOffset) {
      const bytesToRead = currentOffset - start
      // Catch-up replay > 256KB is suspicious — it usually means the client
      // passed an offset from a DIFFERENT file (canonical vs stream mismatch),
      // and we're about to spam them with a huge replay that looks like "UI is
      // replaying the whole conversation". Log before doing it so we can trace.
      if (bytesToRead > 256 * 1024) {
        logMsg('warn', 'addSubscriber: large catch-up replay', {
          sid, fromOffset: start, currentOffset, bytesToRead,
        })
      } else {
        logMsg('info', 'addSubscriber: replay', {
          sid, fromOffset: start, currentOffset, bytesToRead,
        })
      }
      try {
        // Over the cap, read one byte before the window so the cut can land on a line start.
        const capped = bytesToRead > REPLAY_BACKFILL_MAX_BYTES
        const readFrom = capped ? currentOffset - REPLAY_BACKFILL_MAX_BYTES - 1 : start
        const fd = fs.openSync(session.jsonlPath, 'r')
        const buf = Buffer.alloc(currentOffset - readFrom)
        let got = 0
        try { got = fs.readSync(fd, buf, 0, buf.length, readFrom) } finally { fs.closeSync(fd) }
        let bytes = buf.subarray(0, got)
        // L1: stamp `v` (end-of-line byte offset) identically to the live watcher so the
        // client dedupes a replayed line against the same `v` it may already have seen live.
        let lineStartV = start
        if (capped) {
          const nl = bytes.indexOf(10)
          lineStartV = nl === -1 ? readFrom + got : readFrom + nl + 1
          bytes = bytes.subarray(nl === -1 ? got : nl + 1)
          const skippedBytes = lineStartV - start
          logMsg('warn', 'addSubscriber: catch-up capped', {
            sid, fromOffset: start, currentOffset, skippedBytes, cap: REPLAY_BACKFILL_MAX_BYTES,
          })
          // Same shape as appendSystemMarker's lines, but sent to this ws only and
          // never written to the file. Its v is where the replay resumes.
          const marker = JSON.stringify({
            type: 'system',
            subtype: 'replay_truncated',
            content: 'Catch-up replay skipped ' + skippedBytes + ' bytes of earlier output (limit '
              + REPLAY_BACKFILL_MAX_BYTES + ' bytes).',
            skipped_bytes: skippedBytes,
            from_offset: start,
            resume_offset: lineStartV,
            uuid: crypto.randomUUID(),
            session_id: sid,
            timestamp: new Date().toISOString(),
          })
          if (ws.readyState === 1) {
            try { sendEvent(ws, 'jsonl', { sid, line: marker, v: lineStartV }) } catch {}
          }
        }
        const text = bytes.toString('utf-8')
        for (const line of text.split('\n')) {
          const v = lineStartV + Buffer.byteLength(line, 'utf-8') + 1
          lineStartV = v
          if (!line.trim() || ws.readyState !== 1) continue
          // Skip transient permission-protocol lines on replay. control_request/
          // control_response are RPC handshake lines, not session history; replaying
          // them resurrects stale permission prompts in the UI. A genuinely-pending
          // request is recovered out-of-band via `pendingCtrl` (returned on attach),
          // NOT via replay — so dropping all control lines here loses nothing.
          // Prefix match: '"control_request"' misses control_request_progress
          // (heartbeats for in-flight side_question requests, inc-1786165723472)
          // and any future control_* variant — the whole family is plumbing.
          if (line.includes('"type":"control_')) continue
          try { sendEvent(ws, 'jsonl', { sid, line, v }) } catch {}
        }
      } catch {}
    } else {
      logMsg('info', 'addSubscriber: no replay (future-only)', {
        sid, fromOffset: start, currentOffset,
      })
    }
    return true
  }

  return { ensureWatcher, stopSessionWatcher, addSubscriber }
}

/** What createDaemonSessionTailer returns (the runtime names its type, so the session areas that call each other infer no cycle). */
export type DaemonSessionTailer<W extends { data: WsData; readyState: number }> = ReturnType<typeof createDaemonSessionTailer<W>>
