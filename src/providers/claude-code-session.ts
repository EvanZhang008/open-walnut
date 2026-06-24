/**
 * Claude Code Session — event-bus-driven, crash-resilient proxy to `claude -p`.
 *
 * ARCHITECTURE NOTE:
 * This is the ONLY provider that spawns Claude Code CLI processes.
 * The main agent (open-walnut's "brain") uses Bedrock SDK directly via agent/model.ts.
 * This file manages delegated coding sessions — long-running claude -p workers
 * that execute tasks in the background, returning results via the event bus.
 *
 * DETACHED MODE:
 * Sessions are spawned detached with stdout redirected to a JSONL file.
 * The server tails that file for real-time streaming. On server restart,
 * it reconnects to sessions that are still alive (PID check + file tail).
 *
 * ClaudeCodeSession: spawns `claude -p --output-format stream-json --verbose`
 * with stdout→file, tails the output file, and emits incremental bus events:
 *   - session:text-delta for text content blocks
 *   - session:tool-use for tool call blocks
 *   - session:tool-result for tool result blocks
 * When process exits (detected via PID liveness check), emits session:result.
 *
 * SessionRunner: subscribes to session:start / session:send on the bus,
 * manages active ClaudeCodeSession instances, reconnects on startup.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { bus, EventNames, eventData } from '../core/event-bus.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { isLocalJsonlFresh } from '../utils/session-liveness.js'
import { SESSION_STREAMS_DIR, CLAUDE_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { markProcessing, removeProcessed, revertToPending, loadQueue, getAllSessionsWithPending } from '../core/session-message-queue.js'
import type { QueuedMessage } from '../core/session-message-queue.js'
// Image transfer for remote sessions: RemoteSessionManager.prepareOutbound() uploads
// local images via daemon and rewrites paths inside start() and writeMessage().
import type { SshTarget } from './session-io.js'
import { createSessionManager, registerSessionManager, unregisterSessionManager } from './session-manager.js'
import type { SessionManager } from './session-manager.js'
import { checkCwdExists } from './cwd-check.js'
import { recoverStateFromJsonl, extractImageFilePathFromInput } from '../core/session-history.js'
import type { SessionRecord, SessionMode, ProcessStatus, TaskPhase } from '../core/types.js'
import { SESSION_MODEL_CLI_MAP, DEFAULT_CLI_MODEL } from '../core/types.js'
import { classifyStreamEvent, classifyDelta } from './claude-stream-event-map.js'
import { accumulateWorkflowProgress, sortedPhases, sortedAgents } from '../core/workflow-progress.js'
import type { WorkflowPhaseInfo, WorkflowAgentInfo } from '../core/event-types.js'
import { recordTurn } from '../core/observability/recorder.js'
import type { SessionServerClient } from './session-server-client.js'
import { sanitizeInitModel, CONTEXT_WINDOW_DEFAULT } from '../agent/providers/defaults.js'

// ── JSONL types from `claude -p --output-format stream-json --verbose` ──

/**
 * System init event — first line of JSONL output, contains session_id and metadata.
 *
 * EMPIRICAL FINDING (from real CLI tests):
 * The `permissionMode` field is present in EVERY `system` event with subtype `init`.
 * Values observed: "plan", "bypassPermissions", "acceptEdits", "default".
 * This is the ground truth for what mode the CLI is actually running in.
 */
interface StreamInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd?: string
  model?: string
  tools?: string[]
  permissionMode?: string
}

/**
 * System status event — emitted by CLI when permission mode changes mid-session.
 *
 * EMPIRICAL FINDING (from real CLI tests):
 * When Claude calls EnterPlanMode, the CLI emits a `system` event with subtype `status`
 * containing the NEW `permissionMode`. This is how we detect mid-session mode changes.
 *
 * Test evidence (test-bypass-enterplan.jsonl):
 *   Line 0: SYSTEM subtype=init permissionMode=bypassPermissions  ← startup
 *   Line 2: TOOL_USE → EnterPlanMode
 *   Line 3: SYSTEM subtype=status permissionMode=plan             ← mode changed!
 *
 * NOTE: ExitPlanMode does NOT emit a system status event in `-p` mode.
 * It returns is_error=true because CLI needs interactive user approval.
 * See the ExitPlanMode handler in handleStreamLine() for that case.
 */
interface StreamStatusEvent {
  type: 'system'
  subtype: 'status'
  permissionMode?: string
  session_id?: string
}

/** Content block within an assistant message */
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | unknown[]
}

/** Assistant or user message event */
interface StreamMessageEvent {
  type: 'assistant' | 'user'
  /** Non-null when this event belongs to a subagent Task */
  parent_tool_use_id?: string | null
  message: {
    id?: string
    role: 'assistant' | 'user'
    model?: string
    content: ContentBlock[]
    stop_reason?: string | null
    usage?: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  session_id: string
}

/** Final result event — last line */
interface StreamResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  result: string
  session_id: string
  duration_ms?: number
  total_cost_usd?: number
  num_turns?: number
  usage?: { input_tokens: number; output_tokens: number }
}

/** control_request for --permission-prompt-tool stdio protocol */
interface StreamControlRequestEvent {
  type: 'control_request'
  request_id: string
  request: Record<string, unknown>
}

/** control_response: CLI's reply to a Walnut-initiated control_request (e.g.
 *  side_question). Inbound counterpart of the permission flow's outbound response. */
interface StreamControlResponseEvent {
  type: 'control_response'
  response?: Record<string, unknown>
}

/** stream_event: partial SSE events from --include-partial-messages */
interface StreamPartialEvent {
  type: 'stream_event'
  event?: {
    type?: string
    message?: { id?: string }
    index?: number
    content_block?: { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
    delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
  }
  session_id?: string
}

type StreamEvent = StreamInitEvent | StreamStatusEvent | StreamMessageEvent | StreamResultEvent | StreamControlRequestEvent | StreamControlResponseEvent | StreamPartialEvent

/**
 * Map CLI permissionMode string to our internal SessionMode.
 *
 * CLI values (from JSONL system events):
 *   "bypassPermissions" → 'bypass'
 *   "acceptEdits"       → 'accept'
 *   "plan"              → 'plan'
 *   "default"           → 'default'
 */
function mapPermissionMode(cliMode: string): SessionMode | null {
  switch (cliMode) {
    case 'bypassPermissions': return 'bypass'
    case 'acceptEdits': return 'accept'
    case 'plan': return 'plan'
    case 'default': return 'default'
    default: return null
  }
}

// ── Helpers for PID-death handler ──

/**
 * Check if a JSONL output file contains a 'result' event line.
 * Returns { hasResult: true } for successful results, { hasResult: false }
 * otherwise. If the result has is_error:true (e.g. --resume "No conversation
 * found"), returns { hasResult: false, errorMessage } so the caller can
 * surface the error to the user instead of silently swallowing it.
 */
function outputFileCheckResult(filePath: string, fromOffset = 0): { hasResult: boolean; errorMessage?: string } {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const stat = fs.fstatSync(fd)
      // Only scan data written after fromOffset (current turn).
      // On resume, the file contains previous turns' events — including old
      // result events that would cause a false positive if we scanned them.
      const scanStart = Math.max(fromOffset, 0)
      if (stat.size <= scanStart) return { hasResult: false }  // No new data written this turn
      const bytesToRead = stat.size - scanStart
      const buf = Buffer.alloc(bytesToRead)
      fs.readSync(fd, buf, 0, bytesToRead, scanStart)
      const data = buf.toString('utf-8')
      for (const line of data.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === 'result') {
            if (event.is_error) {
              // --resume failure or other CLI error — extract message
              const errors: string[] = Array.isArray(event.errors) ? event.errors : []
              return { hasResult: false, errorMessage: errors[0] || 'Claude Code returned an error result' }
            }
            return { hasResult: true }
          }
        } catch { continue }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return { hasResult: false }
}

/**
 * Determine if SSH stderr content is benign (not a real error).
 * SSH sessions always produce stderr from the EXIT trap (`cat JSONL.err >&2`)
 * which copies Claude CLI's diagnostic output. We don't want to treat normal
 * SSH disconnect messages or Claude CLI startup noise as session errors.
 */
function isBenignSshStderr(stderr: string): boolean {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length > 0 && lines.every(line => {
    // SSH connection close messages
    if (/^Connection to .+ closed\.?$/i.test(line)) return true
    // Normal process termination (SIGTERM=15, SIGHUP=1) — but NOT SIGKILL=9 (OOM)
    if (/^Killed:\s*\d+$/i.test(line) || /killed by signal (1|15)\b/i.test(line)) return true
    // SSH mux messages
    if (/^(Shared connection to .+ closed|ControlSocket .+)$/i.test(line)) return true
    return false
  })
}

// Re-export types and helpers from session-io for backwards compatibility
export type { SshTarget } from './session-io.js'
export { shellQuote } from './session-io.js'

// Exported for testing
export { outputFileCheckResult }

// ── ClaudeCodeSession ──

const MAX_FULL_TEXT = 100 * 1024 // 100KB cap on accumulated text
const LIVENESS_INTERVAL_MS = 3000

// DUP-DEBUG: per-process counter so each ClaudeCodeSession has a stable id
// in logs. If logs show two ccsId values for the same claudeSessionId
// processing the same JSONL line, multiple session instances are alive
// (= leaked instance pointing at the same sid).
let __ccsIdCounter = 0

export class ClaudeCodeSession {
  private readonly _ccsId: number = ++__ccsIdCounter
  /** DUP-DEBUG: count of jsonl lines this instance has ingested. */
  private _streamLinesSeen = 0
  /** DUP-DEBUG: count of duplicate dedup hits (tool_use replay protection). */
  private _toolUseDedupHits = 0
  private pid: number | null = null
  private fullText = ''
  /** Dedup set for streaming text/tool events — prevents replay duplicates.
   *  Key format: `{message.id}:tool_use:{block.id}` or length-based text keys.
   *  Cleared on send()/writeMessage(). */
  private _emittedStreamKeys = new Set<string>()
  /** Tracks last emitted text per (messageId, textBlockIndex) for progressive delta
   *  extraction. Claude Code writes multiple JSONL lines per message with accumulated
   *  text; we must emit only the NEW suffix, not the full snapshot. */
  private _lastEmittedText = new Map<string, string>()
  /** Anthropic message.id of the current stream_event sequence. stream_event
   *  path stores its accumulator under `${msgId}:${sseIndex}`; the `assistant`
   *  branch dedups by prefix-matching any key with the same msgId prefix, so
   *  index alignment between the two paths is no longer required. */
  private _currentStreamMsgId: string | null = null
  /** Scopes we've already warned about this turn (top_level / stream_event / delta
   *  keyed by "scope:type"), so a burst of unknown events doesn't spam the UI. */
  private _warnedUnknownTypes = new Set<string>()
  private claudeSessionId: string | null = null
  private _cwd: string | null = null
  private _active = false
  private _exitCode: number | null = null
  /** Stderr from the remote daemon (populated on exit for remote sessions) */
  private _exitStderr: string | undefined
  /** Session-lifetime flag: survives across turns, checked by handleProcessDeath and
   *  server-restart recovery to suppress spurious events from dead/old processes.
   *  Set true on kill/interrupt/respawn; set false when a new turn begins. */
  private resultEmitted = false
  /** Per-turn flag: reset on writeMessage()/send(), prevents duplicate JSONL result
   *  events within a single turn (e.g., tailer emits result, then PID-death handler fires). */
  private _turnResultEmitted = false
  /** Byte offset in the output file where the current turn started (for resume). */
  private _turnStartOffset = 0
  /** Cumulative cost from the last result event — used to detect stale/replayed results. */
  private _lastResultCost: number | undefined
  /** stop_reason of the most recent assistant message_delta — the truncated-success
   *  invariant compares this against result.subtype (success + null = truncation). */
  private _lastStopReason: string | null | undefined
  /** Delivery latency + path of the most recent delivered batch, surfaced into the
   *  per-turn wide event (forensic observability). Stamped by logDeliveryLatency. */
  private _lastDeliveryMs: number | undefined
  private _lastDeliveryPath: string | undefined
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private _outputFile: string | null = null
  private cliCommand: string
  /** Direct WebSocket URL for daemon (test-only, bypasses SSH). Set by SessionRunner. */
  _testDaemonUrl: string | undefined
  /** Host key from config.hosts — null means local execution */
  private _host: string | null = null

  // Status tracking
  private _processStatus: ProcessStatus = 'stopped'
  private _mode: SessionMode = 'default'
  private _activity: string | undefined
  /** Model ID from JSONL assistant messages (e.g. "claude-opus-4-6"). */
  private _model: string | undefined
  /** Full model string from system init (e.g. "global.anthropic.claude-opus-4-6-v1[1m]"). */
  private _initModel: string | undefined
  /** CLI model string passed to --model (e.g. "opus[1m]"). Preserved for resume. */
  private _cliModel: string | undefined
  /** The session ID we expect after a --resume. If Claude returns a different ID,
   *  we rename the existing record instead of creating a phantom new one. */
  private _expectedSessionId: string | null = null

  /** Auto-generated title set by SessionRunner before first send */
  pendingTitle?: string
  /** Auto-generated description set by SessionRunner before first send */
  pendingDescription?: string
  /** Source plan session ID (set when this session was created from a plan) */
  fromPlanSessionId?: string
  /** Source session ID when this session was forked from another session */
  forkedFromSessionId?: string

  /** Plan file path captured from Write tool_use targeting ~/.claude/plans/ */
  planFile: string | null = null
  /** True when ExitPlanMode tool_use is detected in the JSONL stream */
  planCompleted = false
  /** True when TeamCreate tool_use detected; cleared on TeamDelete, process exit,
   *  or team-idle timeout. While active, intermediate `result` events suppress
   *  idle/AGENT_COMPLETE/triage because the lead is polling for teammate results. */
  private _teamActive = false
  /** The team name from the most recent TeamCreate — used to check teammate liveness. */
  private _teamName: string | undefined
  /** Public getter for health monitor — skip idle timeout while team is active. */
  get teamActive(): boolean { return this._teamActive }
  /** Timer that periodically checks if teammates are still active.
   *  Only clears _teamActive when ALL teammates have been idle for the full timeout. */
  private _teamIdleTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly TEAM_IDLE_TIMEOUT_MS = 120_000 // 2 min

  // ── Background task / dynamic-workflow tracking ──
  // A dynamic-workflow turn (or any background subagent) fans out N tasks that
  // outlive the agent's text turn. The CLI emits a `result` as soon as the main
  // turn produces output ("Workflow launched in background"), but background tasks
  // keep running — so `result` must NOT drive turn-completion while bg work is live.
  //
  // AUTHORITY for "is bg work in flight" is our own `_bgTasksInFlight` counter
  // (task_started − task_notification), NOT the CLI's idle. POC-verified (see
  // [[claude_code_session_state_semantics]]): the CLI emits session_state_changed
  // {idle} ~20×/run — between every sub-agent/phase — NOT once at the end. So idle is
  // only the turn-over *trigger*: the turn is done when we see idle AND the counter is
  // 0. `_sessionStateSeen` flips true the first time we observe a session_state event;
  // when false (old CLI) we complete via `result` + the counter + the daemon-PULL
  // liveness invariant instead.
  /** True once we've observed any session_state_changed event → idle is the turn-over trigger. */
  private _sessionStateSeen = false
  /** Most recent CLI session state, when emitted. */
  private _cliSessionState: 'running' | 'idle' | 'requires_action' | undefined
  /** Count of background tasks started but not yet terminated (task_started − task_notification).
   *  Source of truth for "is background work in flight" when session_state events are absent. */
  private _bgTasksInFlight = 0
  /** task_id → live description, for the workflow/background-task progress UI. */
  private _bgTasks = new Map<string, { description?: string; subagentType?: string; status: string; tokens?: number; lastTool?: string; summary?: string; workflowName?: string }>()
  /** Wall-clock of the most recent task_* event — feeds the "JSONL still moving ⇒ running" invariant. */
  private _lastBgActivityTs = 0
  /** Workflow name from the most recent task_started with task_type==='local_workflow'. */
  private _workflowName: string | undefined
  /** The workflow script Claude generated (task_started.prompt) + its description —
   *  lets the UI show WHAT workflow was created. */
  private _workflowScript: string | undefined
  private _workflowDescription: string | undefined
  /** Dynamic-workflow phases, keyed by phase index (from workflow_progress[]). */
  private _workflowPhases = new Map<number, WorkflowPhaseInfo>()
  /** Per-subagent breakdown, keyed by agentId. The CLI emits only the currently-active
   *  agents per task_progress snapshot, so we accumulate here (latest-wins merge) to
   *  reconstruct the full set across phases. Parse logic lives in the shared
   *  workflow-progress module so reload-from-disk reconstruction stays in sync. */
  private _workflowAgents = new Map<string, WorkflowAgentInfo>()

  /** True when any background subagent / dynamic-workflow task is still running.
   *  Single choke point: every "is this turn's result intermediate?" decision consults
   *  THIS, so adding a future bg mechanism only touches one place.
   *
   *  AUTHORITY = our own `_bgTasksInFlight` counter (task_started − task_notification),
   *  NOT the CLI's `idle`. POC-verified (see [[claude_code_session_state_semantics]]):
   *  the CLI emits `session_state_changed{idle}` ~20×/run — once between every
   *  sub-agent / phase — because its idle-wait loop excludes `in_process_teammate`
   *  tasks (fork `print.ts:2390-2459`). So `idle` means "foreground thread quiet right
   *  now", NOT "all background work done". An earlier version short-circuited this to
   *  `false` on idle; that's exactly what completed turns mid-workflow (→ false
   *  await_human). The counter reliably drains and idle re-fires once it hits 0, so
   *  trusting the counter never hangs. `_cliSessionState` is kept for status DISPLAY
   *  and as the turn-over *trigger* (see the idle handler), never as an override here. */
  hasActiveBackgroundWork(): boolean {
    return this._bgTasksInFlight > 0
  }

  /** Snapshot of background tasks for the UI (Workflow progress panel). */
  get backgroundTasks(): Array<{ taskId: string; description?: string; subagentType?: string; status: string; tokens?: number; lastTool?: string; summary?: string; workflowName?: string }> {
    return [...this._bgTasks.entries()].map(([taskId, t]) => ({ taskId, ...t }))
  }
  get workflowName(): string | undefined { return this._workflowName }
  /** Per-subagent breakdown for the workflow progress panel, ordered by index. */
  get workflowAgents(): WorkflowAgentInfo[] {
    return sortedAgents(this._workflowAgents)
  }

  /** Parse a task_progress.workflow_progress[] array into _workflowPhases + _workflowAgents.
   *  Delegates to the shared accumulator so reload-from-disk reconstruction (which
   *  reads the same array from the on-disk manifest) parses identically. */
  private _ingestWorkflowProgress(wp: unknown[]): void {
    accumulateWorkflowProgress(wp, this._workflowPhases, this._workflowAgents)
  }

  /** Clear all dynamic-workflow state. Called when a fresh workflow opens (a new
   *  task_started with task_type==='local_workflow') so a previous run's
   *  agents/phases/script/name don't leak across turns.
   *
   *  Safe to call from the task_started handler: a dynamic workflow opens with
   *  exactly ONE top-level local_workflow task_started — the N subagents ride
   *  inside task_progress.workflow_progress[] and do NOT each fire their own
   *  task_started — so this reset fires once per run, not once per subagent. */
  private _resetWorkflowState(): void {
    this._workflowPhases.clear()
    this._workflowAgents.clear()
    this._workflowScript = undefined
    this._workflowDescription = undefined
    this._workflowName = undefined
  }

  /** Broadcast the current background-task set so the UI can render workflow progress. */
  private _emitBackgroundTasksUpdate(sessionId: string): void {
    bus.emit(EventNames.SESSION_BACKGROUND_TASKS, {
      sessionId,
      taskId: this.taskId,
      workflowName: this._workflowName,
      inFlight: this._bgTasksInFlight,
      tasks: this.backgroundTasks,
      phases: sortedPhases(this._workflowPhases),
      agents: this.workflowAgents,
      scriptSource: this._workflowScript,
      workflowDescription: this._workflowDescription,
    }, ['main-ai', 'web-ui'], { source: 'session-runner' })
  }

  /**
   * Check if any teammate subagent JSONL files have been written to recently.
   * Subagent files live at ~/.claude/projects/{encoded}/{sessionId}/subagents/*.jsonl.
   * If any file's mtime is within the timeout window, teammates are still active.
   */
  private _areTeammatesStillActive(): boolean {
    if (!this.claudeSessionId || !this.cwd) return false
    try {
      const encoded = this.cwd.replaceAll('/', '-')
      const subagentDir = path.join(CLAUDE_HOME, 'projects', encoded, this.claudeSessionId, 'subagents')
      if (!fs.existsSync(subagentDir)) return false

      const now = Date.now()
      const cutoff = now - ClaudeCodeSession.TEAM_IDLE_TIMEOUT_MS
      const files = fs.readdirSync(subagentDir).filter(f => f.endsWith('.jsonl'))
      for (const file of files) {
        const stat = fs.statSync(path.join(subagentDir, file))
        if (stat.mtimeMs > cutoff) return true
      }
    } catch {
      // If we can't check (e.g. remote session), fall through to clear _teamActive
    }
    return false
  }

  /**
   * Schedule (or reschedule) the team-idle check. When the timer fires:
   *   - If subagent files are still being written → reschedule (teammates alive)
   *   - If no recent writes → clear _teamActive and transition to idle
   */
  private _scheduleTeamIdleCheck(resultText?: string, totalCost?: number, durationMs?: number): void {
    if (this._teamIdleTimer) clearTimeout(this._teamIdleTimer)
    this._teamIdleTimer = setTimeout(() => {
      if (!this._teamActive) return

      // Check if teammates are still writing to their JSONL files
      if (this._areTeammatesStillActive()) {
        log.session.debug('team-idle timer: teammates still active, rescheduling', {
          sessionId: this.claudeSessionId, taskId: this.taskId,
        })
        // Ensure status shows 'running' while team is active
        if (this._processStatus !== 'running') {
          this._processStatus = 'running'
          this._activity = 'Team subagents working'
          this.emitStatusChanged('IN_PROGRESS')
        }
        this._scheduleTeamIdleCheck(resultText, totalCost, durationMs)
        return
      }

      log.session.info('team-idle timeout — no active teammates, clearing _teamActive', {
        sessionId: this.claudeSessionId, taskId: this.taskId,
      })
      this._teamActive = false
      this._teamIdleTimer = null
      this._processStatus = 'idle'
      this._activity = undefined
      this.emitStatusChanged('AGENT_COMPLETE')
      bus.emit(EventNames.SESSION_RESULT, {
        sessionId: this.claudeSessionId,
        taskId: this.taskId,
        result: resultText ?? '(team-idle timeout)',
        totalCost,
        duration: durationMs,
        isError: false,
      }, ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, ClaudeCodeSession.TEAM_IDLE_TIMEOUT_MS)
  }
  /** Plan content captured from the most recent Write to ~/.claude/plans/ */
  private _lastPlanWriteContent: string | null = null
  /** True when we've already auto-replied to AskUserQuestion this turn. Reset on new turn. */
  private _askUserIntercepted = false
  /** Pending permission requests awaiting user decision (non-bypass modes). */
  private _pendingPermissionRequests = new Map<string, {
    request_id: string
    request: { subtype: string; tool_name?: string; input?: Record<string, unknown>; tool_use_id?: string; decision_reason?: string }
  }>()
  /** Periodic re-emit timers for pending permission requests (no auto-resolve). */
  private _permissionReEmitTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** request_ids we've already responded to. Guards against the daemon replaying
   *  historical control_request lines on reconnect — those are stale (already
   *  auto-allowed remotely) and must not resurrect a UI permission prompt.
   *  INTENTIONALLY NEVER CLEARED: surviving across reconnect/replay is the whole
   *  point. Do NOT add a .clear() on turn boundary or process death — that would
   *  reintroduce the zombie-prompt bug (replayed control_request lines outlive the
   *  turn that produced them). It looks like a leaking Set but bounded growth is
   *  accepted; see git history for the zombie permission-card incident. */
  private _resolvedPermissionRequestIds = new Set<string>()
  /** Pending Walnut-initiated control_requests (e.g. side_question / "btw") awaiting
   *  a matching control_response from the CLI. Keyed by request_id.
   *
   *  ── Claude Code stream-json control protocol (Walnut→CLI direction) ──
   *  This is the SYMMETRIC counterpart of the permission flow: there, the CLI sends
   *  Walnut a `control_request` and Walnut replies with a `control_response`
   *  (respondToControlRequest). Here, WALNUT sends the CLI a `control_request` and
   *  the CLI replies with a `control_response` that we must route back to the caller.
   *  The fork's print mode (`claude -p`, exactly what Walnut spawns) handles these
   *  natively — see fork src/cli/print.ts (subtype dispatch ~line 2831+:
   *  side_question 3815, set_model 2933, get_context_usage 2961,
   *  generate_session_title 3783) and the Zod schemas in
   *  src/entrypoints/sdk/coreSchemas.ts. The full subtype catalog + payloads live in
   *  memory note claude_code_stream_json_control_protocol.md.
   *  Transport: writeRaw(json) → daemon sendRaw → CLI FIFO stdin — the SAME pipe the
   *  permission control_response already uses (no new daemon plumbing, no new flag). */
  private _pendingSideQuestions = new Map<string, {
    resolve: (answer: string) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  /** Timestamp when spawn() was called — used to measure time-to-init for diagnostics. */
  private _spawnTs = 0
  /** Wall-clock ts of the HTTP request that triggered this start (latency instrumentation only). */
  private _requestTs = 0
  /** Ts when transport.start() resolved (daemon spawned the CLI). For init-latency breakdown. */
  private _transportReadyTs = 0
  /** Timestamp of the last message delivery (FIFO write or --resume spawn). */
  private _lastMessageDeliveryTs = 0
  /** Timestamp of the last JSONL event received from the output file. */
  private _lastJsonlEventTs = 0
  /** Timestamp of the last JSONL event produced by Claude Code (excludes walnut-injected user events).
   *  Used by health monitor to detect hung API calls: message delivered but no Claude output. */
  private _lastClaudeOutputTs = 0
  /** Output file size at the time of last message delivery — used to detect stalled output. */
  private _fileSizeAtDelivery = 0
  /** Timer for diagnosing "Running but no response" — fires if no JSONL event arrives after message delivery. */
  private _stallDiagTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-session cache for remote→local image path rewriting (avoids re-downloading). */
  private _remoteImageCache = new Map<string, string>()
  /** Cache tool_use input file paths for image tools — used to resolve tool_result image content blocks to file paths. */
  private _toolInputFilePaths = new Map<string, string>()
  /** Session manager for all session I/O (local + remote). Null before first send(). */
  private _transport: SessionManager | null = null

  /** Resolves with the Claude session ID once the system init event arrives. */
  readonly sessionReady: Promise<string>
  private _resolveSessionReady!: (id: string) => void
  private _rejectSessionReady!: (err: Error) => void

  constructor(
    readonly taskId: string,
    readonly project: string,
    cliCommand?: string,
  ) {
    this.cliCommand = cliCommand ?? 'claude'
    this.sessionReady = new Promise<string>((resolve, reject) => {
      this._resolveSessionReady = resolve
      this._rejectSessionReady = reject
    })
    // Prevent unhandled rejection if nobody awaits sessionReady (e.g., taskless sessions)
    this.sessionReady.catch(() => {})
  }

  get active(): boolean {
    return this._active
  }

  get sessionId(): string | null {
    return this.claudeSessionId
  }

  get outputFile(): string | null {
    return this._outputFile
  }

  get processPid(): number | null {
    return this.pid
  }

  get processStatus(): ProcessStatus {
    return this._processStatus
  }

  /**
   * Mark this session's process as dead externally (e.g. pre-flight check
   * discovered the PID is gone before a FIFO write).
   * Clears the pipe so the next processNext() falls through to --resume.
   */
  markProcessDead(): void {
    this._transport?.deletePipe()
    this._active = false
    this._processStatus = 'stopped'
    this._pendingPermissionRequests.clear()
    this._clearAllPermissionReEmitTimers()
  }

  get mode(): SessionMode {
    return this._mode
  }

  get activity(): string | undefined {
    return this._activity
  }

  get host(): string | null {
    return this._host
  }

  /** Timestamp of last JSONL event produced by Claude Code (excludes walnut-injected).
   *  0 means no Claude output received yet (e.g. right after resume spawn). */
  get lastClaudeOutputAt(): number { return this._lastClaudeOutputTs }

  /** Timestamp of last message delivered to Claude via FIFO or --resume. */
  get lastMessageDeliveryAt(): number { return this._lastMessageDeliveryTs }

  get cwd(): string | null {
    return this._cwd
  }

  /** Session manager for all session I/O. Null before first send(). */
  get transport(): SessionManager | null {
    return this._transport
  }

  /** Whether this session has an active write pipe (FIFO). */
  get hasPipe(): boolean {
    return this._transport?.hasPipe ?? false
  }

  /**
   * Send a message to Claude Code via detached spawn.
   * stdout is redirected to a JSONL file; a tailer reads it for streaming.
   *
   * When `host` and `sshTarget` are provided, the claude process is spawned on
   * a remote machine via SSH. The JSONL stdout is piped back through the SSH
   * connection to the local output file, so JsonlTailer works identically.
   */
  send(
    message: string,
    cwd?: string,
    resumeSessionId?: string,
    mode?: string,
    model?: string,
    appendSystemPrompt?: string,
    host?: string,
    sshTarget?: SshTarget,
    forkSession?: boolean,
    permissionPrompt?: boolean,
    spillFile?: { localPath: string },
    streamPartialMessages?: boolean,
    // Invoked once the daemon settles the spawn: ok=true when the CLI process
    // actually started (pid returned), ok=false (with err) when spawn/SSH/daemon
    // deploy failed. CRITICAL: spawn is fire-and-forget (startSpawn runs async and
    // send() returns immediately), so callers MUST NOT treat send() returning as
    // "delivered". Removing the message from the queue / reporting delivery must
    // happen in THIS callback, never right after send() returns. See processNext.
    onSpawnSettled?: (ok: boolean, err?: Error) => void,
  ): void {
    const args = ['-p', '--output-format', 'stream-json', '--verbose']

    // Token-level streaming: emit Anthropic SSE stream_event records so assistant
    // text streams into the UI character-by-character. Default on; falsy config
    // (explicit false) disables for fallback to per-message delivery.
    if (streamPartialMessages !== false) {
      args.push('--include-partial-messages')
    }

    // Claude Code trace/debug log. On by default — writes to
    // ~/.claude/debug/<claude-session-id>.txt on whichever host the CLI is
    // running on (local or remote daemon), with a `latest` symlink. Disable
    // with WALNUT_CLAUDE_DEBUG=0. See CLAUDE.md § Debugging.
    if (process.env.WALNUT_CLAUDE_DEBUG !== '0') {
      args.push('--debug')
    }

    // Store mode and set initial activity.
    // Default (no mode, or explicit 'bypass'): bypassPermissions — users shouldn't
    // be prompted to approve every edit. Plan mode must be explicitly requested.
    if (mode === 'plan') {
      this._mode = 'plan'
      this._activity = 'planning'
      args.push('--permission-mode', 'plan')
    } else if (mode === 'accept') {
      this._mode = 'accept'
      args.push('--permission-mode', 'acceptEdits')
    } else {
      this._mode = 'bypass'
      this._activity = 'implementing'
      args.push('--permission-mode', 'bypassPermissions')
    }
    // Map picker short IDs → CLI model aliases via the SESSION_MODELS registry
    // (single source of truth in core/types.ts). The CLI understands the [1m]
    // suffix for the 1M context window. An unknown id falls through to passthrough
    // (CLI resolves it per provider), and no model at all → DEFAULT_CLI_MODEL.
    const cliModel = SESSION_MODEL_CLI_MAP[model ?? ''] ?? (model || DEFAULT_CLI_MODEL)
    this._cliModel = cliModel
    args.push('--model', cliModel)
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId)
      if (forkSession) {
        // Fork creates a NEW session ID — don't claim the source ID as ours
        args.push('--fork-session')
        this.claudeSessionId = null
        this._expectedSessionId = null
      } else {
        this.claudeSessionId = resumeSessionId
        this._expectedSessionId = resumeSessionId  // track expected ID to detect resume failure
      }
    } else {
      this.claudeSessionId = null
      this._expectedSessionId = null
    }

    if (appendSystemPrompt) {
      args.push('--append-system-prompt', appendSystemPrompt)
    }

    // Both local and SSH sessions use stream-json stdin via SessionIO
    args.push('--input-format', 'stream-json')

    // Permission prompt tool: intercepts sensitive-file and AskUserQuestion permission checks.
    // For remote sessions, control_response is routed through the daemon's `sendRaw`
    // command (see RemoteSessionManager.writeRaw → daemon-core.handleSendRawCommand).
    // Controlled by config.session.permission_prompt (default: true).
    if (permissionPrompt !== false) {
      args.push('--permission-prompt-tool', 'stdio')
    }

    // Store host key for liveness checks and record persistence
    this._host = host ?? null

    // Kill any existing process before spawning a new one.
    // This prevents multiple processes competing for the same Claude session
    // (e.g., after server restart, startup recovery re-processes queued messages
    // while the old process from the previous server instance is still alive).
    if (this.pid !== null) {
      log.session.info('killing old process before respawn', { taskId: this.taskId, oldPid: this.pid })
      try { process.kill(this.pid, 'SIGTERM') } catch { /* already dead */ }
    }
    this.resultEmitted = true  // Suppress spurious events from old process
    // Stop monitoring (tailer + liveness) BEFORE replacing transport
    this.stopMonitoring()
    if (this._transport) {
      // Detach first to unsubscribe event listeners from the shared DaemonConnection,
      // preventing duplicate agent_complete / result emissions from the old transport.
      this._transport.detach()
      this._transport.deletePipe()
      if (this.claudeSessionId) unregisterSessionManager(this.claudeSessionId)
      this._transport = null
    }

    this._active = true
    this._processStatus = 'running'
    this._exitCode = null
    this._exitStderr = undefined
    this.resultEmitted = false
    this._turnResultEmitted = false
    this._lastResultCost = undefined  // Fresh session — no previous cost to compare
    this._askUserIntercepted = false
    this.fullText = ''
    this._emittedStreamKeys.clear()
    this._lastEmittedText.clear()
    this._currentStreamMsgId = null
    this._warnedUnknownTypes.clear()
    this._cwd = cwd ?? null

    const isResume = !!resumeSessionId && !forkSession
    const tmpId = isResume ? resumeSessionId : crypto.randomBytes(8).toString('hex')

    this._spawnTs = Date.now()
    const transport = createSessionManager(tmpId, host ?? undefined, sshTarget, undefined, this.cliCommand, this._testDaemonUrl)
    this._transport = transport

    const resolvedCwd = cwd ?? process.cwd()

    // Layer 3 — CWD existence pre-flight. Cheap safety net so we don't spawn
    // `claude` into a nonexistent directory and report "session created and running"
    // when the spawn will definitely fail (ENOENT). Soft-fails on remote errors
    // to avoid blocking on flaky connectivity.
    const startSpawn = async (): Promise<{ pid: number | null; outputFile: string; fileSize: number }> => {
      const cwdCheck = await checkCwdExists(resolvedCwd, host, sshTarget)
      if (!cwdCheck.ok) {
        const errMsg = cwdCheck.error ?? 'Working directory not available'
        log.session.warn('cwd pre-flight failed — aborting spawn', {
          taskId: this.taskId, host: host ?? 'local', cwd: resolvedCwd, error: errMsg,
        })
        throw new Error(errMsg)
      }
      return transport.start({
      args,
      cwd: resolvedCwd,
      message,
      resume: isResume,
      fork: forkSession,
      spillFile,
      mode: this._mode as 'bypass' | 'plan' | 'accept' | 'default',
      onOutput: (event) => this.handleStreamLine(event.line),
      onExit: (code, stderr) => {
        this._exitCode = code
        this._exitStderr = stderr
        if (code !== 0) {
          log.session.warn('session process exited with non-zero code', {
            taskId: this.taskId, exitCode: code, host, isRemote: !!sshTarget,
            stderr: stderr?.slice(0, 200),
          })
        }
        // Process died before init (no claudeSessionId) — emit error so callers
        // waiting for this session (e.g. plan execute endpoint) can detect the failure.
        if (!this.claudeSessionId && !this.resultEmitted) {
          this.resultEmitted = true
          this._active = false
          this._processStatus = 'error'
          this._activity = undefined
          this.clearStallDiagTimer()
          const parts = [`Process exited with code ${code} before initialization`]
          if (host) parts.push(`[${host}]`)
          if (stderr) parts.push(stderr.slice(0, 500))
          const errMsg = parts.join(' — ')
          log.session.error('session process died before init', {
            taskId: this.taskId, exitCode: code, host, fromPlanSessionId: this.fromPlanSessionId,
            stderr: stderr?.slice(0, 500),
          })
          this.emitStatusChanged('AGENT_COMPLETE', errMsg)
          bus.emit(EventNames.SESSION_ERROR, {
            sessionId: this.claudeSessionId ?? undefined,
            taskId: this.taskId,
            error: errMsg,
            fromPlanSessionId: this.fromPlanSessionId,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        }
        // Post-init death: claudeSessionId IS set, so the block above is skipped.
        // Without this, the error is silently swallowed and the session drifts to 'idle'.
        // Applies to all daemon-backed sessions (both remote and local via __local__ daemon).
        else if (code !== 0 && !this.resultEmitted) {
          this.handleRemoteProcessExit(code, stderr)
        }
      },
      })
    }

    startSpawn().then((result) => {
      this.pid = result.pid
      this._outputFile = result.outputFile
      this._turnStartOffset = result.fileSize

      // Register in the global session manager registry (for liveness checks, health monitor)
      if (this.claudeSessionId) {
        registerSessionManager(this.claudeSessionId, transport)
      }

      // Mark when the daemon confirmed the CLI was spawned — lets the init handler
      // isolate "CLI cold-start until first init line" from Walnut-side overhead.
      this._transportReadyTs = Date.now()

      log.session.info('session spawned via transport', {
        // DUP-DEBUG: ccsId tags every CCS instance creation. Pair with the
        // matching `session detached` to confirm clean lifecycle, or with
        // a second `session spawned` for the same sid to spot leaked instances.
        ccsId: this._ccsId,
        taskId: this.taskId,
        project: this.project,
        host,
        pid: result.pid,
        outputFile: result.outputFile,
        resume: isResume,
        fork: !!forkSession,
        isRemote: !!sshTarget,
        spawnMs: Date.now() - this._spawnTs,
      })

      // Persist outputFile + PID for resume recovery
      if (isResume && resumeSessionId) {
        import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
          updateSessionRecord(resumeSessionId, {
            outputFile: this._outputFile ?? undefined,
            pid: this.pid ?? undefined,
            process_status: 'running',
          }).catch(() => {}),
        ).catch(() => {})
      }

      // Spawn confirmed by the daemon (pid returned). Only now is it safe to
      // consider the message delivered — see onSpawnSettled doc on send().
      try { onSpawnSettled?.(true) } catch { /* callback must never break spawn */ }
    }).catch((err) => {
      log.session.error('transport start failed', {
        taskId: this.taskId, host: host ?? 'local', cwd, isRemote: !!sshTarget,
        error: err instanceof Error ? err.message : String(err),
      })
      this._rejectSessionReady(err)
      // Tell the caller the spawn failed BEFORE the SESSION_ERROR emit, so it can
      // restore the message to the queue (revertToPending) instead of leaving it
      // deleted. This is the path remote daemon-deploy failures (SSH/publickey)
      // take — historically the message was already removeProcessed'd by the time
      // we got here, silently losing it.
      const e = err instanceof Error ? err : new Error(String(err))
      try { onSpawnSettled?.(false, e) } catch { /* callback must never break error handling */ }
      if (!this.resultEmitted) {
        // Always stop bookkeeping so this dead spawn emits no spurious events.
        this.resultEmitted = true
        this._active = false
        // When a settle callback owns this spawn (queue-managed --resume), the
        // callback's settleResumeFailure already drove the lifecycle: reverted the
        // batch to 'pending' (session stays valid, message not lost) and emitted
        // SESSION_ERROR errorKind:'delivery_failed'. We MUST NOT also flip to
        // 'stopped' + emit AGENT_COMPLETE here: that status-changed (process_status
        // 'stopped' → ['*']) hits server.ts's markDone+clear fallback and wipes the
        // previous turn's blocks the user is viewing — the exact thing the
        // delivery_failed buffer-protection (server.ts) is meant to prevent. The
        // disk record's process_status is left as-is by the failure path (it was
        // not 'running' before this resume attempt anyway for a dead remote), so
        // settleResumeFailure has nothing to re-assert.
        if (!onSpawnSettled) {
          this._processStatus = 'stopped'
          this._activity = undefined
          this.emitStatusChanged('AGENT_COMPLETE')
          // No errorKind here: without a settle callback this is a NEW-session
          // start whose message is not in the disk queue (not 'delivery_failed').
          // (The second SESSION_ERROR was what fed the session-runner's own handler
          // and re-triggered processNext — the infinite redeliver loop of 2026-06-10,
          // 104 cycles/min against a dead SSH host.)
          bus.emit(EventNames.SESSION_ERROR, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            error: err instanceof Error ? err.message : String(err),
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        }
      }
    })

    this._outputFile = transport.outputFile
    this.emitStatusChanged('IN_PROGRESS')
    this.startLivenessMonitor()
    this.startStallDiagTimer('resume-spawn')
  }

  /**
   * Attach to an existing running process (for reconnection after restart).
   * Does NOT spawn — just tails the output file and monitors PID.
   */
  static async attachToExisting(
    record: SessionRecord,
    cliCommand?: string,
    testDaemonUrl?: string,
  ): Promise<ClaudeCodeSession> {
    const session = new ClaudeCodeSession(record.taskId, record.project, cliCommand)
    session._testDaemonUrl = testDaemonUrl
    session.claudeSessionId = record.claudeSessionId
    session.pid = record.pid ?? null
    session._outputFile = record.outputFile ?? null
    session._cwd = record.cwd ?? null
    session._active = true
    session._processStatus = record.process_status ?? 'running'
    session._mode = record.mode ?? 'default'
    session._activity = record.activity
    session.planFile = record.planFile ?? null
    session.planCompleted = record.planCompleted ?? false
    session._host = record.host ?? null
    // Restore model from session record so context % works after server restart.
    // _initModel is in-memory only (set from init events); old init events aren't
    // re-processed since the JSONL tailer starts from current offset.
    if (record.model) {
      // De-duplicate [1m][1m] from old resume bug before processing
      const cleanModel = record.model.replace(/(\[1m\])+$/, '[1m]')
      session._initModel = cleanModel
      const shortModel = cleanModel.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || cleanModel
      session._model = shortModel
    }
    if (record.cliModel) {
      session._cliModel = record.cliModel
    }

    // ── resultEmitted recovery after server restart ──
    // `resultEmitted` is ephemeral — it lives only on the ClaudeCodeSession instance
    // in memory and is lost when the server restarts. New instances always start
    // with resultEmitted=false (the field default). Without recovery, the PID-death
    // liveness handler would emit a *synthetic* session:result for every session
    // that was already fully processed (git pull, usage tracking, task phase update,
    // triage dispatch) before the restart — flooding the user with stale notifications.
    //
    // We use the linked task's phase as the durable proxy for "server already
    // handled this result":
    //   - The main-ai handler in server.ts advances task.phase to AGENT_COMPLETE
    //     only AFTER completing all result bookkeeping
    //   - tasks.json is written to disk and persists across restarts
    //   - If task.phase is past IN_PROGRESS, the server already processed the real result
    //
    // Race window: theoretically the server could crash between setting task.phase
    // and flushing tasks.json to disk. In practice this window is sub-millisecond.
    // Worst case: one extra triage notification — acceptable.
    let taskPhaseIsTerminal = false
    if (record.taskId) {
      try {
        const { getTask } = await import('../core/task-manager.js')
        const task = await getTask(record.taskId)
        if (task && task.phase !== 'TODO' && task.phase !== 'IN_PROGRESS') {
          taskPhaseIsTerminal = true
        }
      } catch { /* task not found — assume non-terminal */ }
    }
    session.resultEmitted = taskPhaseIsTerminal
      || record.process_status === 'error'

    // Create the session manager for attach (all sessions go through daemon now).
    //
    // CRITICAL: Pass record.outputFile so the manager uses the correct path from
    // when the session was created. Without this, SESSION_STREAMS_DIR may point to a
    // different directory after server restart (e.g. if WALNUT_HOME changed).
    if (record.claudeSessionId) {
      let sshTarget: SshTarget | undefined
      if (record.host) {
        try {
          const { getConfig } = await import('../core/config-manager.js')
          const config = await getConfig()
          const hostDef = config.hosts?.[record.host]
          if (hostDef) {
            const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
            if (hostname) {
              sshTarget = {
                hostname,
                user: hostDef.user,
                port: hostDef.port,
                shell_setup: hostDef.shell_setup,
              }
            }
          }
        } catch {
          log.session.warn('failed to resolve host config for attach', {
            sessionId: record.claudeSessionId,
            host: record.host,
          })
        }
      }

      const transport = createSessionManager(
        record.claudeSessionId,
        record.host ?? undefined,
        sshTarget,
        record.outputFile ?? undefined,
        cliCommand,
        testDaemonUrl,
      )
      session._transport = transport

      // Register in the global session manager registry
      registerSessionManager(record.claudeSessionId, transport)

      // Set PID on the transport before attach (needed for liveness checks)
      if (record.pid && 'setPid' in transport) {
        (transport as { setPid(pid: number): void }).setPid(record.pid)
      }
    }

    // Recover state from CloudCode canonical JSONL (source of truth).
    // The session record in sessions.json may be stale if the server crashed
    // before an async updateSessionRecord() completed. The CloudCode JSONL
    // is maintained by Claude CLI itself and always has the ground truth.
    let jsonlByteLength = 0
    try {
      const recovered = await recoverStateFromJsonl(record.claudeSessionId, record.cwd, record.host)
      if (recovered) {
        if (recovered.mode) session._mode = recovered.mode as SessionMode
        if (recovered.model) {
          // De-duplicate [1m][1m] from old resume bug
          const cleanModel = recovered.model.replace(/(\[1m\])+$/, '[1m]')
          session._initModel = cleanModel
          const shortModel = cleanModel.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || cleanModel
          session._model = shortModel
        }
        if (recovered.planFile) session.planFile = recovered.planFile
        if (recovered.planCompleted != null) session.planCompleted = recovered.planCompleted
        if (recovered.activity) session._activity = recovered.activity
        if (recovered.jsonlByteLength) jsonlByteLength = recovered.jsonlByteLength
        if (recovered.teamActive != null) session._teamActive = recovered.teamActive
        // ── Recover background-task / workflow state ──
        // Without this, a server restart mid-workflow loses the in-flight count and the
        // next replayed/real `result` would be mistaken for turn-over (the bug we fixed).
        if (recovered.bgTasksInFlight != null) session._bgTasksInFlight = recovered.bgTasksInFlight
        if (recovered.cliSessionState != null) {
          session._sessionStateSeen = true
          session._cliSessionState = recovered.cliSessionState
        }
        // Counter is the SOLE authority for "work in flight" — NOT _cliSessionState.
        // A workflow persists idle ~20×/run, so a mid-workflow restart often recovers
        // with cliSessionState='idle' while tasks are genuinely live; gating on
        // `!== 'idle'` here would drop us out of running status (the same idle-override
        // bug fixed in hasActiveBackgroundWork / the idle handler). Trust the counter.
        if (session._bgTasksInFlight > 0) {
          session._processStatus = 'running'
          session._activity = 'Background tasks running'
          session._lastBgActivityTs = Date.now()
          log.session.info('recovery: background work in flight — keeping running status', {
            sessionId: session.claudeSessionId, taskId: session.taskId,
            bgTasksInFlight: session._bgTasksInFlight,
          })
        }
        // Arm team-idle safety timer when recovering into team mode.
        // Without this, if no new JSONL events arrive after restart (process alive
        // but team poll loop idle), _teamActive stays true forever and triage never fires.
        // The live flow arms this timer inside the result handler (line ~2000); on
        // recovery we must do it explicitly since result events before the crash are
        // not replayed (tailer starts from fromOffset).
        if (session._teamActive) {
          // If teammates are still active, show 'running' (not 'idle')
          if (session._areTeammatesStillActive()) {
            session._processStatus = 'running'
            session._activity = 'Team subagents working'
            log.session.info('recovery: team still active — keeping running status', {
              sessionId: session.claudeSessionId, taskId: session.taskId,
            })
            // Persist to session record so API/frontend show 'running'
            if (session.claudeSessionId) {
              import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                updateSessionRecord(session.claudeSessionId!, {
                  process_status: 'running',
                  activity: 'Team subagents working',
                }),
              ).catch(() => {})
            }
          }
          session._scheduleTeamIdleCheck('(team-idle timeout after server restart)')
        }
        // Belt-and-suspenders: if the JSONL has a result event (hasResult),
        // reinforce resultEmitted even if tasks.json was momentarily stale.
        if (recovered.workStatus === 'agent_complete' || recovered.workStatus === 'await_human_action') {
          session.resultEmitted = true
        }
        log.session.info('recovered state from canonical JSONL', {
          sessionId: record.claudeSessionId,
          recovered,
        })
        // Patch the in-memory record directly so other code paths that read it
        // (reconciler, API responses) see the corrected values immediately.
        // The next updateSessionRecord() call from any code path will persist these.
        if (recovered.mode) record.mode = recovered.mode as SessionRecord['mode']
        if (recovered.model) record.model = recovered.model
        if (recovered.planFile) record.planFile = recovered.planFile
        if (recovered.planCompleted != null) record.planCompleted = recovered.planCompleted

        // Layer 1 (canonical JSONL): recover orphaned control_request.
        // Note: control_request events are typically NOT in the canonical JSONL —
        // they only appear in the STDOUT stream. This check exists as a belt-and-suspenders.
        if (recovered.pendingControlRequest) {
          const { request_id, request } = recovered.pendingControlRequest
          session._pendingPermissionRequests.set(request_id, { request_id, request })
          log.session.info(`recovered orphaned control_request from canonical JSONL`, {
            sessionId: record.claudeSessionId,
            requestId: request_id,
            toolName: request.tool_name,
            mode: session._mode,
          })
        }
      }
    } catch (err) {
      log.session.warn('state recovery from canonical JSONL failed, using session record', {
        sessionId: record.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // ── Permission recovery: 2 layers + daemon attach, first one wins ──
    // Layer 1 (canonical JSONL) — already checked above
    // Layer 2 (session record on disk) — most reliable, persisted atomically
    // Layer 3 (daemon attach response) — daemon returns pendingCtrl directly
    //
    // Must populate _pendingPermissionRequests BEFORE transport.attach() since
    // attach starts delivering live events that may reference these requests.

    // Layer 2: Recover from session record (sessions.json)
    if (session._pendingPermissionRequests.size === 0 && record.pendingPermission) {
      const pp = record.pendingPermission
      session._pendingPermissionRequests.set(pp.requestId, {
        request_id: pp.requestId,
        request: {
          subtype: pp.subtype ?? 'can_use_tool',
          tool_name: pp.toolName,
          input: pp.input,
          decision_reason: pp.reason,
        },
      })
      log.session.info('recovered orphaned control_request from session record (Layer 2)', {
        sessionId: record.claudeSessionId,
        requestId: pp.requestId,
        toolName: pp.toolName,
        mode: session._mode,
        receivedAt: pp.receivedAt,
      })
    }

    // Layer 3 (stream JSONL tail scan) — REMOVED.
    // All sessions now go through daemon, which provides pendingCtrl directly in the
    // attach response. The old Layer 3 only ran for local sessions (!remote://) anyway.

    // Start periodic re-emit timer for ALL recovered permissions (Layer 4 visibility net).
    // Re-emits every 60s so the UI picks it up. No auto-approve/deny — waits for human decision.
    if (session._pendingPermissionRequests.size > 0) {
      for (const pending of session._pendingPermissionRequests.values()) {
        session._startPermissionReEmitTimer(pending.request_id, pending.request)
      }
    }

    log.session.info('attaching to existing session', {
      // DUP-DEBUG: pair with `session detached` (same ccsId) for lifecycle audit
      ccsId: session._ccsId,
      taskId: record.taskId,
      sessionId: record.claudeSessionId,
      pid: record.pid,
      outputFile: record.outputFile,
      hasFifo: session._transport?.hasPipe ?? false,
    })

    // Attach the transport: recovers FIFO (local) or reconnects WebSocket (daemon),
    // then starts tailing from AFTER the data we already recovered.
    //
    // fromOffset semantics: the daemon stream file is /tmp/open-walnut-streams/<sid>.jsonl,
    // which is DIFFERENT from the canonical claude-projects JSONL. The daemon's
    // addSubscriber() replays bytes [fromOffset, currentOffset) of its stream file.
    //
    // For LOCAL sessions: transport.fileSize reflects the local FIFO capture, which
    // is the same file the daemon streams — so fileSize is a valid offset.
    //
    // For REMOTE sessions on a fresh attachToExisting: transport.fileSize is 0 (this
    // RemoteSessionManager instance hasn't received any live events yet). We used to
    // fall back to `jsonlByteLength` from canonical-JSONL recovery here, but that's
    // the byte length of the CLI's canonical JSONL in ~/.claude/projects/ — a totally
    // different file, usually much smaller than the daemon stream (because it doesn't
    // include every tool_use/tool_result delta). Passing the canonical size as
    // `fromOffset` made the daemon replay [canonical_size, stream_size) of its stream,
    // i.e. potentially megabytes of historical tool_use/tool_result events that the
    // session already processed. UI symptom: pressing Enter seemed to "replay the
    // whole conversation" because handleStreamLine consumed every old event.
    //
    // Fix: treat "I just rehydrated — don't replay anything" as the signal. Sending
    // Number.MAX_SAFE_INTEGER makes daemon's `start < currentOffset` check fail, so
    // it subscribes to future events only. History was already loaded via the
    // session-history API separately — we don't need the daemon to re-emit it.
    if (session._transport && record.claudeSessionId) {
      const isRemote = !!session._transport.isRemote
      // Local sessions have the SAME two-file mismatch as remote: daemon offsets
      // are byte positions in the STREAM file (/tmp/open-walnut-streams/<sid>.jsonl),
      // while jsonlByteLength measures the canonical ~/.claude/projects JSONL — a
      // different, much smaller file. Falling back to it after a walnut restart
      // (fileSize=0) made the daemon replay [canonical_size, stream_size) — the
      // exact "whole conversation replays" bug, just on the local path. Only a
      // live in-process fileSize (>0, accumulated from stream events) is a valid
      // stream offset; otherwise subscribe future-only like remote.
      const fromOffset = session._transport.fileSize > 0 && !isRemote
        ? session._transport.fileSize
        : Number.MAX_SAFE_INTEGER  // fresh-attach: subscribe future-only
      log.session.info('attachToExisting: attach fromOffset chosen', {
        sessionId: record.claudeSessionId,
        isRemote,
        transportFileSize: session._transport.fileSize,
        canonicalJsonlByteLength: jsonlByteLength,
        fromOffset: fromOffset === Number.MAX_SAFE_INTEGER ? 'MAX_SAFE_INTEGER (skip replay)' : fromOffset,
      })
      try {
        const attachResult = await session._transport.attach({
          sessionId: record.claudeSessionId,
          fromOffset,
          mode: session._mode as 'bypass' | 'plan' | 'accept' | 'default',
          onOutput: (event) => session.handleStreamLine(event.line),
          onExit: (code, stderr) => {
            session._exitCode = code
            session._exitStderr = stderr
            // Post-init death — surface error instead of silent swallow.
            // Applies to all daemon-backed sessions (both remote and local via __local__ daemon).
            if (code !== 0 && !session.resultEmitted) {
              session.handleRemoteProcessExit(code, stderr)
            }
          },
        })
        // Recover pending permission from daemon attach response.
        // The daemon tracks control_request state and returns it on attach.
        // Single slot: the `claude -p` protocol has at most one outstanding
        // can_use_tool at a time, so pendingCtrl carries at most one request.
        if (attachResult?.pendingCtrl && session._pendingPermissionRequests.size === 0) {
          const pc = attachResult.pendingCtrl
          session._pendingPermissionRequests.set(pc.reqId, {
            request_id: pc.reqId,
            request: pc.request as { subtype: string; tool_name?: string; input?: Record<string, unknown>; decision_reason?: string },
          })
          session._startPermissionReEmitTimer(pc.reqId, pc.request as { subtype: string; tool_name?: string; input?: Record<string, unknown> })
          log.session.info('recovered pendingCtrl from daemon attach response', {
            sessionId: record.claudeSessionId,
            requestId: pc.reqId,
            toolName: pc.toolName,
          })
        }
      } catch (err) {
        log.session.warn('transport attach failed, session may not stream', {
          sessionId: record.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    session.startLivenessMonitor()

    // Re-emit pending permission requests to the UI after transport is ready.
    // Re-emit must happen AFTER transport.attach() returns because the WebSocket
    // subscription isn't live until then — emitting earlier would be lost.
    // If the server restarted while Claude Code was waiting for control_response,
    // the UI needs to show the permission dialog again so the user can approve/deny.
    if (session._pendingPermissionRequests.size > 0 && record.claudeSessionId) {
      // Check config for bypass auto-approve setting
      let autoApproveBypassed = true
      if (session._mode === 'bypass') {
        try {
          const { getConfig } = await import('../core/config-manager.js')
          const cfg = await getConfig()
          autoApproveBypassed = cfg.session?.auto_approve_bypass !== false
        } catch { /* default true */ }
      }

      // Snapshot before iterating: resolvePermissionRequest() deletes from the map
      const pendingSnapshot = [...session._pendingPermissionRequests.values()]
      for (const pending of pendingSnapshot) {
        if (session._mode === 'bypass' && autoApproveBypassed) {
          // Bypass mode + auto-approve ON: approve immediately to unblock Claude Code.
          log.session.info('auto-approving recovered control_request (bypass mode)', {
            sessionId: record.claudeSessionId,
            requestId: pending.request_id,
            toolName: pending.request.tool_name,
          })
          session.resolvePermissionRequest(pending.request_id, true)
        } else {
          log.session.info('re-emitting recovered control_request to UI', {
            sessionId: record.claudeSessionId,
            requestId: pending.request_id,
            toolName: pending.request.tool_name,
          })
          bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
            sessionId: record.claudeSessionId,
            taskId: record.taskId,
            requestId: pending.request_id,
            toolName: pending.request.tool_name,
            input: pending.request.input,
            reason: pending.request.decision_reason,
          }, ['*'], { source: 'session-runner', urgency: 'urgent' })
        }
      }
    }

    return session
  }

  /**
   * Detach from the session without killing the process.
   * Stops tailing and liveness monitoring. The process continues running.
   */
  detach(): void {
    log.session.info('session detached', {
      // DUP-DEBUG: pair with the matching `session spawned` / `attaching to
      // existing session` (same ccsId). If a sid has two spawns/attaches but
      // only one detach, we have a leaked CCS instance still ingesting JSONL.
      ccsId: this._ccsId,
      sessionId: this.claudeSessionId,
      taskId: this.taskId, pid: this.pid, hasPipe: this._transport?.hasPipe,
      streamLinesSeen: this._streamLinesSeen,
      toolUseDedupHits: this._toolUseDedupHits,
    })
    this.stopMonitoring()
    this._transport?.detach()
    this._active = false
  }

  /**
   * Kill the running process.
   * Marks resultEmitted so no spurious events are emitted.
   */
  kill(): void {
    log.session.info('session killed', { taskId: this.taskId, pid: this.pid })
    this.resultEmitted = true
    this.stopMonitoring()
    this._transport?.kill()
    this._active = false
    this._pendingPermissionRequests.clear()
    this._clearAllPermissionReEmitTimers()
  }

  /**
   * Write a follow-up message via the named FIFO (stream-json stdin).
   * Returns true if the message was written successfully.
   * Returns false if the FIFO is gone — caller should fall back to --resume spawn.
   *
   * Named pipes survive server restarts: the FIFO file persists on disk,
   * and any server instance can open it for writing.
   */
  async writeMessage(message: string): Promise<boolean> {
    if (!this._transport) return false
    const ok = await this._transport.writeMessage(message)
    if (!ok) return false
    this._processStatus = 'running'  // Back to running from idle
    this._activity = undefined
    this.resultEmitted = false
    this._turnResultEmitted = false  // New turn starting — allow result emission
    this._turnStartOffset = this._transport?.fileSize ?? 0  // Track where this turn's data begins
    this._askUserIntercepted = false
    this._toolInputFilePaths.clear()  // Fresh turn — clear stale cached tool input paths
    this._emittedStreamKeys.clear()   // Fresh turn — allow new events through dedup
    this._lastEmittedText.clear()     // Fresh turn — reset progressive delta tracking
    this._currentStreamMsgId = null   // Fresh turn — stream_event message tracking
    this._warnedUnknownTypes.clear()  // Fresh turn — reset unknown-event warn set
    this.emitStatusChanged('IN_PROGRESS')
    // Persist running state to session tracker so API consumers (frontend tree, etc.)
    // see the updated status immediately — not just WebSocket subscribers.
    //
    // Carry pid + host with the 'running' write. Without them this created the
    // orphan dead-pool: a 'running' record with pid==null && host==null is
    // un-verifiable (isSessionProcessAlive returns false), so the health monitor
    // flagged it dead and rewrote it every tick (the write-amp stall). With pid
    // set, a local session is verifiable; with host set, a remote session routes
    // to the daemon liveness check. This is the upstream fix that stops the pool
    // from refilling after the batch drain cleans it.
    if (this.claudeSessionId) {
      import('../core/session-tracker.js').then(({ updateSessionRecord }) => {
        updateSessionRecord(this.claudeSessionId!, {
          process_status: 'running',
          activity: undefined,
          last_status_change: new Date().toISOString(),
          ...(this.pid != null ? { pid: this.pid } : {}),
          ...(this._host ? { host: this._host } : {}),
          // Persist outputFile on every FIFO write, not just the resume path.
          // A freshly-spawned local session sets _outputFile in memory (the
          // remote://__local__/<sid> sentinel) but historically only the resume
          // path wrote it to the DB, so a session that never resumed kept an empty
          // output_file column forever. That empty column is what history/stream
          // readers key off, and it was the latent footgun behind the false-zombie
          // kill (the reconciler used to treat "no outputFile" as "dead"). Writing
          // it on every turn keeps the column populated regardless of resume.
          ...(this._outputFile ? { outputFile: this._outputFile } : {}),
        }).catch(() => {})
      }).catch(() => {})
    }
    log.session.info('message sent to session via FIFO', { taskId: this.taskId, sessionId: this.claudeSessionId, messageLength: message.length })
    this.startStallDiagTimer('fifo-write')
    return true
  }

  /**
   * Append a synthetic user-text event to the local output file.
   * Claude Code's stdout stream does NOT echo user text messages — only tool_results
   * and assistant responses appear in the JSONL. This means the local streams file
   * never sees user messages, and the frontend relies entirely on optimistic copies
   * that can fail to dedup.
   *
   * Writes ONLY to the streams file (_outputFile), never to canonical JSONL.
   * The walnutMessageId enables deterministic dedup against optimistic copies.
   *
   * NOTE: Remote sessions have _outputFile=null (RemoteSessionManager.outputFile
   * returns null), so this is effectively a no-op for remote sessions.
   * RemoteSessionManager overrides this method as an explicit no-op.
   */
  writeSyntheticUserEvent(message: string, walnutMessageId: string): void {
    if (this._transport) {
      this._transport.writeSyntheticUserEvent(message, walnutMessageId)
      return
    }
    // Fallback for pre-transport sessions (e.g. during init before send())
    const outputFile = this._outputFile
    if (!outputFile) return
    const event = JSON.stringify({
      type: 'user',
      subtype: 'walnut-injected',
      message: { role: 'user', content: message },
      walnutMessageId,
      timestamp: new Date().toISOString(),
    })
    const line = event + '\n'
    // Write to streams capture file only (_outputFile).
    // ⛔ NEVER write to canonical JSONL (~/.claude/projects/<cwd>/<sessionId>.jsonl).
    // Canonical is owned by Claude Code; writing entries without uuid/parentUuid
    // breaks the conversation tree and causes --resume to lose all history.
    // The streams file is sufficient: tailer reads it for real-time display,
    // and walnutMessageId enables frontend dedup.
    fsp.appendFile(outputFile, line).catch((err) => {
      log.session.debug('writeSyntheticUserEvent failed on streams file (non-fatal)', {
        sessionId: this.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /**
   * Gracefully stop the running process before respawning.
   * Uses SIGINT (Claude Code saves session state on Ctrl+C) + wait, with SIGTERM fallback.
   * This ensures session data is flushed to disk so --resume can find it.
   *
   * Unlike interrupt(), this does NOT clean up FIFO or modify session state —
   * it ONLY stops the process. The caller (processNext) will spawn a new process immediately after.
   *
   * THIS IS CRITICAL: Without graceful stop, send() would SIGTERM the old process,
   * which doesn't give Claude Code time to flush session state. Then --resume fails,
   * creates a new session with a different ID, and activeProcessing gets permanently stuck.
   */
  async gracefulStop(): Promise<void> {
    if (!this._transport) return
    log.session.info('gracefulStop: using transport', { taskId: this.taskId })
    await this._transport.stop()
    log.session.info('gracefulStop: complete', { taskId: this.taskId })
  }

  /**
   * Interrupt the running session: close stdin pipe, gracefully stop the process,
   * and wait for it to exit so session state is flushed to disk.
   *
   * Two-phase shutdown:
   *   1. SIGINT (like Ctrl+C) — Claude Code handles this gracefully and saves session state
   *   2. SIGTERM (fallback) — if SIGINT doesn't kill within 5s
   *
   * Waits for the process to actually exit before returning, so --resume
   * can find the saved session. Without this wait, the new --resume process
   * races against the dying process's disk flush and fails with
   * "No conversation found with session ID".
   */
  async interrupt(): Promise<void> {
    log.session.info('session interrupted', { taskId: this.taskId, pid: this.pid })
    this.resultEmitted = true
    this.stopMonitoring()
    if (this._transport) {
      await this._transport.interrupt()
    }
    this._active = false
    this._processStatus = 'stopped'
    this._activity = undefined
    this._pendingPermissionRequests.clear()
    this._clearAllPermissionReEmitTimers()
    this._rejectAllSideQuestions('session stopped')
  }

  /** Reject + clear any in-flight side questions (e.g. on session teardown) so the
   *  drawer's promise settles instead of hanging until its own timeout. */
  private _rejectAllSideQuestions(reason: string): void {
    for (const pending of this._pendingSideQuestions.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this._pendingSideQuestions.clear()
  }

  // ── Private ──

  private startLivenessMonitor(): void {
    // Skip liveness polling for remote daemon sessions — the daemon already monitors
    // process liveness on the remote host and reports exit events via WebSocket.
    // Polling isAlive() over SSH is redundant and fragile: a momentary tunnel glitch
    // or rename race causes false negatives → premature handleProcessDeath().
    if (this._transport?.isRemote) return

    this.livenessTimer = setInterval(async () => {
      if (this.pid === null || this.resultEmitted) {
        this.stopLivenessMonitor()
        return
      }

      if (!this._transport) return

      if (!await this._transport.isAlive()) {
        log.session.info('session process exited (transport check)', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          pid: this.pid,
          isRemote: this._transport.isRemote,
        })
        this.handleProcessDeath()
      }
    }, LIVENESS_INTERVAL_MS)
  }

  /**
   * Handle process death detected by liveness monitor.
   */
  private handleProcessDeath(): void {
    // Process is dead — clean up via transport
    this._transport?.deletePipe()
    this._transport?.flushTail()
    this._transport?.stopTail()

    this._active = false
    this._processStatus = 'stopped'
    this.stopLivenessMonitor()

    // Reject sessionReady with detailed diagnostics.
    // For local sessions, read stderr from the .err file on disk.
    // For remote sessions, the local path doesn't exist — use _exitStderr from daemon exit event.
    let initStderr = ''
    if (this._outputFile) {
      try {
        initStderr = fs.readFileSync(this._outputFile + '.err', 'utf-8').slice(0, 2048).trim()
      } catch { /* no stderr file (expected for remote sessions) */ }
    }
    if (!initStderr && this._exitStderr) {
      initStderr = this._exitStderr.slice(0, 2048)
    }
    const parts = ['process died before session init']
    if (this._host) parts.push(`[SSH → ${this._host}]`)
    if (this._exitCode !== null) parts.push(`[exit code: ${this._exitCode}]`)
    if (this.pid) parts.push(`[pid: ${this.pid}]`)
    if (initStderr) parts.push(`stderr: ${initStderr}`)
    else parts.push('(no stderr captured)')
    const errMsg = parts.join(' ')
    log.session.error('session init failed — process died before init event', {
      taskId: this.taskId,
      pid: this.pid,
      exitCode: this._exitCode,
      host: this._host,
      stderr: initStderr || undefined,
      outputFile: this._outputFile,
      timeSinceSpawnMs: this._spawnTs ? Date.now() - this._spawnTs : undefined,
    })
    this._rejectSessionReady(new Error(errMsg))

    // If no result was emitted by the tailer, determine fallback behavior.
    if (!this.resultEmitted && !this._turnResultEmitted) {
      const { hasResult: hasResultInFile, errorMessage: resultErrorMessage } = this._outputFile
        ? outputFileCheckResult(this._outputFile, this._turnStartOffset)
        : { hasResult: false, errorMessage: undefined }

      this.resultEmitted = true
      this._turnResultEmitted = true

      if (hasResultInFile) {
        this._activity = undefined
        this.emitStatusChanged('AGENT_COMPLETE')
        if (this.claudeSessionId) {
          this.persistSessionRecord(this.claudeSessionId, this._cwd ?? undefined).catch((err) => {
            log.session.warn('persistSessionRecord failed (PID died, result found)', { sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err) })
          })
        }
        log.session.info('session PID died — result found in output file (tailer race)', {
          taskId: this.taskId,
          sessionId: this.claudeSessionId,
          host: this._host,
        })
        bus.emit(EventNames.SESSION_RESULT, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          result: this.fullText,
          isError: false,
        }, ['main-ai', 'session-runner'], { source: 'session-runner' })
      } else if (resultErrorMessage) {
        // Result event exists but is_error:true — e.g. --resume "No conversation found".
        // Surface the error instead of silently treating it as success.
        const conversationLost = resultErrorMessage.includes('No conversation found')
        this._activity = undefined
        this.emitStatusChanged('AGENT_COMPLETE', resultErrorMessage.slice(0, 500))
        log.session.error('session PID died — error result in output file', {
          taskId: this.taskId,
          sessionId: this.claudeSessionId,
          host: this._host,
          errorMessage: resultErrorMessage,
          ...(conversationLost ? { conversationLost: true } : {}),
        })
        // Auto-archive on conversation loss (same rationale as result-handler path).
        if (conversationLost && this.claudeSessionId) {
          const sid = this.claudeSessionId
          const hint = `Remote JSONL missing (cwd=${this._cwd ?? 'unknown'}, host=${this._host ?? 'local'})`
          import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
            updateSessionRecord(sid, {
              archived: true,
              archive_reason: 'remote_conversation_lost',
              errorMessage: hint,
            }),
          ).catch((err) => {
            log.session.warn('failed to auto-archive lost conversation (PID-death path)', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
          })
        }
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          error: resultErrorMessage,
          ...(conversationLost ? { errorKind: 'conversation_lost' as const } : {}),
        }, ['main-ai', 'session-runner'], { source: 'session-runner' })
      } else {
        let stderr = ''
        if (this._outputFile) {
          try {
            stderr = fs.readFileSync(this._outputFile + '.err', 'utf-8').slice(0, 10240).trim()
          } catch { /* No stderr file (expected for remote sessions) */ }
        }
        // For remote sessions, local .err file doesn't exist — use daemon-provided stderr
        if (!stderr && this._exitStderr) {
          stderr = this._exitStderr.slice(0, 10240)
        }

        const isRealError = stderr && !isBenignSshStderr(stderr)

        if (isRealError) {
          this._activity = undefined
          this.emitStatusChanged('AGENT_COMPLETE', stderr.slice(0, 500))
          bus.emit(EventNames.SESSION_ERROR, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            error: stderr,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        } else {
          this._activity = undefined
          this.emitStatusChanged('AGENT_COMPLETE')
          if (this.claudeSessionId) {
            this.persistSessionRecord(this.claudeSessionId, this._cwd ?? undefined).catch((err) => {
              log.session.warn('persistSessionRecord failed (PID died, no result)', { sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err) })
            })
          }
          log.session.warn('session PID died but no result event', {
            taskId: this.taskId,
            host: this._host,
            stderr: stderr ? stderr.slice(0, 200) : undefined,
          })
          bus.emit(EventNames.SESSION_RESULT, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            result: this.fullText,
            isError: false,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        }
      }
    }
  }

  private stopLivenessMonitor(): void {
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  private stopMonitoring(): void {
    this.stopLivenessMonitor()
    this._transport?.stopTail()
    this.clearStallDiagTimer()
  }

  /**
   * Handle non-zero exit from a remote daemon session that already has a claudeSessionId.
   * This is the remote-session equivalent of handleProcessDeath() — the liveness
   * monitor never fires for remote sessions, so daemon exit events are the only signal.
   *
   * Without this, post-init remote exits silently set the session to 'idle' and the
   * user never sees what went wrong (exit code, stderr, command not found, etc.).
   */
  private handleRemoteProcessExit(code: number, stderr?: string): void {
    const parts: string[] = []
    if (code === 127) {
      parts.push('Claude CLI not found on remote host')
    } else {
      parts.push(`Remote session exited with code ${code}`)
    }
    if (this._host) parts.push(`[${this._host}]`)
    if (stderr) parts.push(stderr.slice(0, 500))
    const errMsg = parts.join(' — ')

    log.session.error('remote session process exited with error', {
      taskId: this.taskId,
      sessionId: this.claudeSessionId,
      exitCode: code,
      host: this._host,
      stderr: stderr?.slice(0, 200),
    })

    this._active = false
    this._processStatus = 'error'
    this._activity = undefined
    this.pid = null

    // Persist error state to session record
    if (this.claudeSessionId) {
      const sid = this.claudeSessionId
      import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
        updateSessionRecord(sid, {
          process_status: 'error',
          errorMessage: errMsg,
          status_reason: 'daemon_reported_exit',
          status_changed_by: 'system',
          pid: undefined,
        } as Record<string, unknown>),
      ).catch((err) => {
        log.session.warn('failed to persist remote exit error', { sessionId: sid, error: String(err) })
      })
    }

    // Emit status change with errorMessage so frontend shows the error banner
    this.emitStatusChanged('AGENT_COMPLETE', errMsg)

    if (!this.resultEmitted) {
      this.resultEmitted = true
      bus.emit(EventNames.SESSION_ERROR, {
        sessionId: this.claudeSessionId ?? undefined,
        taskId: this.taskId,
        error: errMsg,
      }, ['main-ai', 'session-runner'], { source: 'session-runner' })
    }
  }

  /**
   * Start a diagnostic timer after message delivery (FIFO write or --resume spawn).
   * If no JSONL event arrives within 30s, log comprehensive state for debugging
   * "Running but no response" issues. Does NOT kill anything — purely diagnostic.
   *
   * Motivation: users report sessions stuck at "Running" with no output. Root causes
   * vary widely — FIFO write silently failing, Claude process hung on tool execution,
   * tailer not attached, output file on wrong path. Without diagnostics at the moment
   * of stall, we can't distinguish these cases from logs alone. The 30s threshold
   * balances early detection vs false positives (some tool calls legitimately take 20s+).
   */
  private startStallDiagTimer(trigger: 'fifo-write' | 'resume-spawn'): void {
    this.clearStallDiagTimer()
    this._lastMessageDeliveryTs = Date.now()
    this._fileSizeAtDelivery = this._transport?.fileSize ?? 0

    this._stallDiagTimer = setTimeout(async () => {
      this._stallDiagTimer = null
      const now = Date.now()
      const currentFileSize = this._transport?.fileSize ?? 0
      const fileSizeGrew = currentFileSize > this._fileSizeAtDelivery
      const pidAlive = this._transport
        ? await this._transport.isAlive()
        : (this.pid !== null && await isProcessAliveAsync(this.pid, 'claude'))
      const msSinceDelivery = now - this._lastMessageDeliveryTs
      const msSinceLastEvent = this._lastJsonlEventTs ? now - this._lastJsonlEventTs : -1
      const hasTailer = !!this._transport

      log.session.warn('STALL DIAGNOSTIC: no JSONL event 30s after message delivery', {
        trigger,
        sessionId: this.claudeSessionId,
        taskId: this.taskId,
        pid: this.pid,
        pidAlive,
        host: this._host,
        processStatus: this._processStatus,
        hasPipe: this._transport?.hasPipe ?? false,
        hasTailer,
        fileSizeAtDelivery: this._fileSizeAtDelivery,
        currentFileSize,
        fileSizeGrew,
        msSinceDelivery,
        msSinceLastEvent,
        outputFile: this._outputFile,
        usingTransport: !!this._transport,
      })

      // Self-heal: the process is alive but we haven't seen JSONL bytes, so the
      // daemon's session.subscribers set is probably missing our ws (e.g. a
      // reconnect path that didn't call reattachWatcher). Try reattaching once —
      // the daemon will re-add this ws and catch-up push bytes from fromOffset.
      // Cheap and idempotent: _seenUuids dedup prevents any double-rendering.
      // Applies to BOTH local and remote sessions: both go through the daemon /
      // RemoteSessionManager, and a local-daemon WS flap drops the subscriber
      // exactly the same way. Gating this on isRemote left local sessions with
      // no self-heal path — they stayed frozen until a manual refresh.
      if (pidAlive && !fileSizeGrew && this._transport) {
        type Reattachable = { reattachWatcher?: () => Promise<boolean> }
        const reattachable = this._transport as unknown as Reattachable
        if (reattachable.reattachWatcher) {
          try {
            const ok = await reattachable.reattachWatcher()
            log.session.info('STALL self-heal: reattachWatcher attempted', {
              sessionId: this.claudeSessionId, ok,
            })
          } catch (err) {
            log.session.warn('STALL self-heal: reattachWatcher threw', {
              sessionId: this.claudeSessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }
    }, 30_000)
  }

  /** Clear the stall diagnostic timer. Called when any JSONL event arrives or session stops. */
  private clearStallDiagTimer(): void {
    if (this._stallDiagTimer) {
      clearTimeout(this._stallDiagTimer)
      this._stallDiagTimer = null
    }
  }

  /**
   * Rewrite remote image paths in text to local paths for remote sessions.
   * No-op for local sessions. Uses transport.processInbound() for remote.
   */
  private rewriteRemoteImages(text: string): string {
    if (!this._transport?.isRemote) return text
    const sessionId = this.claudeSessionId ?? 'unknown'
    return this._transport.processInbound(text, sessionId, this._cwd ?? undefined)
  }

  /**
   * Catch-all for JSONL event types we don't know how to parse. Emits a single
   * SESSION_UNKNOWN_EVENT per (scope, type) per turn so the UI always surfaces
   * surprise events (future CLI additions like recap/away-summary/etc.) instead
   * of silently dropping them. Dedup map is cleared on each new turn.
   */
  private emitUnknownEventOnce(
    scope: 'top_level' | 'stream_event' | 'delta',
    eventType: string,
    line: string,
  ): void {
    const warnKey = `${scope}:${eventType}`
    if (this._warnedUnknownTypes.has(warnKey)) return
    this._warnedUnknownTypes.add(warnKey)
    const snippet = line.slice(0, 500)
    log.session.info('JSONL unknown event — surfacing to UI', {
      sessionId: this.claudeSessionId, taskId: this.taskId,
      scope, eventType,
      linePreview: snippet,
    })
    bus.emit(EventNames.SESSION_UNKNOWN_EVENT, {
      sessionId: this.claudeSessionId,
      taskId: this.taskId,
      scope,
      eventType,
      snippet,
    }, ['main-ai'], { source: 'session-runner' })
  }

  /**
   * Handle a single JSONL line from the stream-json output.
   * Parses the JSON, extracts the event type, and emits bus events.
   */
  /** Track whether we've received any JSONL line yet (for first-line timing). */
  private _firstLineSeen = false

  private handleStreamLine(line: string): void {
    // Clear stall diagnostic timer — we're receiving output, session is responsive
    this._lastJsonlEventTs = Date.now()
    this._streamLinesSeen++
    this.clearStallDiagTimer()
    // Reset team-idle timer on any new JSONL event — the team is still active.
    if (this._teamIdleTimer) {
      clearTimeout(this._teamIdleTimer)
      this._teamIdleTimer = null
    }

    if (!this._firstLineSeen) {
      this._firstLineSeen = true
      log.session.info('first JSONL line received from output', {
        taskId: this.taskId,
        isRemote: !!this._host,
        host: this._host,
        timeSinceSpawnMs: this._spawnTs ? Date.now() - this._spawnTs : undefined,
        linePreview: line.slice(0, 120),
      })
    }

    let event: StreamEvent
    try {
      event = JSON.parse(line) as StreamEvent
    } catch {
      log.session.warn('malformed JSONL line skipped', { sessionId: this.claudeSessionId, taskId: this.taskId, linePreview: line.slice(0, 80) })
      return
    }

    // Track Claude Code output separately from walnut-injected user events.
    // walnut-injected events are written by Walnut to the JSONL file — they refresh
    // _lastJsonlEventTs (file mtime) but should NOT reset the "Claude is responsive" timer.
    const isWalnutInjected = event.type === 'user' && (event as unknown as Record<string, unknown>).subtype === 'walnut-injected'
    if (!isWalnutInjected) {
      this._lastClaudeOutputTs = Date.now()
    }

    try {
      switch (event.type) {
      case 'system': {
        const sys = event as unknown as Record<string, unknown>

        // ── Init handling ──
        // compact_boundary also carries session_id — guard with subtype check
        if (sys.session_id && (sys.subtype === 'init' || !this.claudeSessionId)) {
          // A new init means Claude Code started a new API turn. Reset the dedup
          // guard so the subsequent result event can emit normally. This handles
          // auto-continuation (compaction, multi-turn agent loops) where Claude Code
          // starts a new turn without any user message (no writeMessage() call).
          if (this._turnResultEmitted) {
            log.session.info('new init after result — resetting turnResultEmitted', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
            })
            this._turnResultEmitted = false
          }
          if (this.resultEmitted) {
            // Optimistic remote-exit (~line 2286) set this true, but the daemon is
            // still feeding fresh turns — reset so the next result event isn't
            // suppressed by the "replayed result" guard (~line 2145). Without this,
            // subsequent SESSION_RESULT events get dropped, markDone never fires,
            // and the UI's "Streaming" badge stays stuck.
            log.session.warn('new init while resultEmitted=true — reverting optimistic remote-exit', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
            })
            this.resultEmitted = false
          }
          const newId = sys.session_id as string
          const expectedId = this._expectedSessionId
          const oldSessionId = this.claudeSessionId
          this.claudeSessionId = newId
          this._expectedSessionId = null
          // ── time-to-init latency breakdown (instrumentation) ──
          // Splits the previously-opaque timeToInitMs into hops so we can see whether
          // Walnut's overhead vs bare CLI lives in route, spawn, or the CLI cold-start.
          const now = Date.now()
          const initElapsedMs = this._spawnTs ? now - this._spawnTs : undefined
          // route→handleStart (HTTP recv → send() called): captured via _requestTs.
          // _spawnTs is set at the top of send(), so requestTs→spawn covers route + send setup.
          const requestToSpawnMs = this._requestTs ? this._spawnTs - this._requestTs : undefined
          // _spawnTs → transport.start() resolved: daemon accepted start, spawned CLI.
          const spawnToTransportMs = this._transportReadyTs && this._spawnTs
            ? this._transportReadyTs - this._spawnTs : undefined
          // transport ready → first init line back in Walnut: CLI cold-start + MCP wait
          // + 100ms daemon poll + WS hop. This is the segment that should ≈ bare-CLI time.
          const transportToInitMs = this._transportReadyTs ? now - this._transportReadyTs : undefined
          const requestToInitMs = this._requestTs ? now - this._requestTs : undefined
          log.session.info('session ID from init', {
            sessionId: newId,
            taskId: this.taskId,
            timeToInitMs: initElapsedMs,
            requestToInitMs,
            requestToSpawnMs,
            spawnToTransportMs,
            transportToInitMs,
            isRemote: !!this._host,
            host: this._host,
          })

          // Rename output file + FIFO to use the real session ID
          if (this._transport) {
            // Update registry: unregister old tmpId → register with real session ID
            if (oldSessionId && oldSessionId !== newId) {
              unregisterSessionManager(oldSessionId)
            }
            this._transport.renameForSession(newId)
            this._outputFile = this._transport.outputFile
            registerSessionManager(newId, this._transport)
          }

          // Capture model from init event — sanitize ANSI codes and validate.
          // sanitizeInitModel strips real ANSI escapes (\x1b[...) while preserving
          // the legitimate [1m] context window marker, then rejects malformed results.
          const rawModel = typeof sys.model === 'string' && sys.model
            ? sanitizeInitModel(sys.model)
            : undefined
          if (rawModel) {
            this._initModel = rawModel
            // Extract short model ID for display (e.g. "claude-opus-4-6" or "claude-opus-4-6[1m]")
            const shortModel = rawModel.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || rawModel
            this._model = shortModel
          } else if (typeof sys.model === 'string' && sys.model) {
            // sanitizeInitModel rejected the string — log so we can diagnose.
            log.session.warn('init model failed validation, using raw', {
              rawModel: sys.model, sessionId: newId,
            })
            // Fall back to raw string with only ESC-prefix ANSI stripped
            // eslint-disable-next-line no-control-regex
            const fallback = sys.model.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            this._initModel = fallback
            const shortModel = fallback.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || fallback
            this._model = shortModel
          }

          // Persist session record BEFORE resolving sessionReady — callers must not
          // receive the session ID until sessions.json is written.  Without this,
          // concurrent starts could return an ID that has no matching record.
          // handleStreamLine is sync, so we wrap in an async IIFE.
          const initModel = rawModel
          ;(async () => {
            try {
              if (expectedId && expectedId !== newId) {
                // Resume failed — Claude created a new session. Rename the original record's
                // ID to the new ID so history/UI stays connected.
                log.session.warn('resume produced different session ID, renaming record', {
                  expectedSessionId: expectedId, actualSessionId: newId, taskId: this.taskId,
                })
                const { renameSessionId } = await import('../core/session-tracker.js')
                const renamed = await renameSessionId(expectedId, newId, {
                  outputFile: this._outputFile ?? undefined,
                  pid: this.pid ?? undefined,
                })
                if (!renamed) {
                  // Original record not found — fall back to creating a fresh record
                  await this.persistSessionRecord(newId, this._cwd ?? undefined)
                }
              } else {
                await this.persistSessionRecord(newId, this._cwd ?? undefined)
              }
              // Write model after persist — record is guaranteed to exist now
              if (initModel) {
                const { updateSessionRecord } = await import('../core/session-tracker.js')
                await updateSessionRecord(newId, { model: initModel })
              }
            } catch (err) {
              // Persist failed — log loudly but still resolve so the session isn't stuck.
              // The session process IS running, just not registered.
              log.session.error('CRITICAL: session record persist failed — session will be unregistered', {
                sessionId: newId, taskId: this.taskId,
                error: err instanceof Error ? err.message : String(err),
              })
            } finally {
              // Always resolve — the process is already alive regardless of persist outcome
              this._resolveSessionReady(newId)
            }
          })()

          // Re-emit status now that claudeSessionId is set (first emit at spawn had null ID)
          this.emitStatusChanged('IN_PROGRESS')
        }

        // Parse permissionMode from system events.
        // Only apply mode changes from 'status' events (EnterPlanMode mid-session).
        // Skip 'init' events — the init event just reports the CLI's spawn-time mode,
        // which can differ from the user's intent (e.g. user toggled mode via UI while
        // the CLI was spawned with a different mode). The session record is authoritative
        // for display mode; the init event would overwrite it incorrectly.
        // ExitPlanMode does NOT emit system event → handled by tool_use detection above.
        const permMode = sys.permissionMode
        if (typeof permMode === 'string' && sys.subtype === 'status') {
          const mapped = mapPermissionMode(permMode)
          if (mapped && mapped !== this._mode) {
            const oldMode = this._mode
            this._mode = mapped
            if (this.claudeSessionId) {
              import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                updateSessionRecord(this.claudeSessionId!, { mode: mapped }).catch(() => {}),
              )
            }
            // Propagate mode change to daemon so it can auto-respond with new policy.
            // All sessions (local + remote) now go through daemon.
            this._transport?.setMode?.(mapped)
            this.emitStatusChanged('IN_PROGRESS')
            log.session.info('mode updated from JSONL system event', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
              oldMode, newMode: mapped,
              subtype: sys.subtype,
            })
          }
        }

        // ── System event notifications for UI ──
        // Guard: claudeSessionId is null before the init event arrives.
        if (this.claudeSessionId) {
          const sid = this.claudeSessionId
          if (sys.subtype === 'status' && sys.status === 'compacting') {
            this._activity = 'compacting context'
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'compact' as const, message: 'Compacting context...',
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (sys.subtype === 'compact_boundary') {
            const meta = sys.compact_metadata as { trigger?: string; pre_tokens?: number } | undefined
            const pre = meta?.pre_tokens
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'compact' as const, message: 'Context compacted',
              detail: pre ? `${Math.round(pre / 1000)}K tokens` : undefined,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (sys.subtype === 'error_during_execution') {
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'error' as const, message: String(sys.error || 'Execution error'),
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (sys.subtype === 'success') {
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'info' as const, message: 'Operation succeeded',
            }, ['main-ai'], { source: 'session-runner' })
          } else if (sys.subtype === 'api_retry') {
            // Upstream API error — Claude Code is retrying with backoff.
            // Surface so the user can tell "Anthropic throttle" from "Walnut stuck".
            // CLI emits one api_retry per attempt; we mirror 1:1 (not urgent — routine throttles
            // clear in <1s, only interesting in aggregate if retries keep piling up).
            const attempt = sys.attempt as number | undefined
            const max = sys.max_retries as number | undefined
            const delayMs = sys.retry_delay_ms as number | undefined
            const errStatus = sys.error_status as string | number | null | undefined
            const errName = sys.error as string | undefined
            const hasRealErrName = typeof errName === 'string' && errName.length > 0 && errName !== 'unknown'
            const errLabel = errStatus ? `HTTP ${errStatus}` : (hasRealErrName ? errName : 'upstream error')
            const delayLabel = typeof delayMs === 'number' ? `${Math.round(delayMs)}ms` : '?'
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'info' as const,
              message: `Upstream retry ${attempt ?? '?'}/${max ?? '?'} — ${errLabel}, backoff ${delayLabel}`,
              // Only attach errName as detail when it's additional info beyond errLabel
              // (i.e. we already showed an HTTP status — errName adds the category).
              detail: errStatus && hasRealErrName ? errName : undefined,
            }, ['main-ai'], { source: 'session-runner' })
          } else if (sys.subtype === 'thinking_tokens') {
            // Drop silently. The CLI emits a `thinking_tokens` system event
            // between every pair of `thinking_delta`s as a running token-count
            // estimate (100s–1000s per turn). It carries no user value, and
            // rendering each as a UI system block shreds the live thinking view:
            // each system block lands after the current thinking block, so the
            // NEXT thinking-delta sees "last block is not thinking" and starts a
            // brand-new thinking fragment. Verified on prod session 0b303a59 —
            // one turn produced 194 thinking fragments, 0 clean appends, with
            // 181 system blocks landing directly on a thinking block. Swallowing
            // the event here lets thinking-delta keep appending to one block.
          } else if (sys.subtype === 'session_state_changed') {
            // ── CLI session state (turn-over TRIGGER, gated on the bg-work counter) ──
            // Gated by CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS (daemon sets it).
            //
            // ⚠️ `idle` does NOT mean "turn over". POC-verified (see
            // [[claude_code_session_state_semantics]]): a dynamic-workflow run emits
            // `idle` ~20× — once between every sub-agent / phase — because the CLI's
            // idle-wait loop excludes `in_process_teammate` tasks (fork
            // `print.ts:2390-2459`). idle == "foreground thread quiet right now". In one
            // real incident 18/20 idles fired while 1–5 workflow tasks were still
            // running; treating the first as turn-over completed the turn mid-workflow
            // (→ false await_human). So idle completes the turn ONLY when our own
            // in-flight counter has actually drained (`!hasActiveBackgroundWork()`).
            // The counter is authoritative; idle is just the signal that, IF nothing is
            // in flight, the turn is over. 'running' keeps us active; 'requires_action'
            // = paused on a permission/AskUserQuestion prompt (NOT done).
            this._sessionStateSeen = true
            const newState = sys.state as 'running' | 'idle' | 'requires_action' | undefined
            this._cliSessionState = newState
            log.session.info('session_state_changed', {
              sessionId: sid, taskId: this.taskId, state: newState,
              bgTasksInFlight: this._bgTasksInFlight,
            })
            if (newState === 'running') {
              if (this._processStatus !== 'running') {
                this._processStatus = 'running'
                this.emitStatusChanged('IN_PROGRESS')
              }
            } else if (newState === 'idle') {
              if (this.hasActiveBackgroundWork()) {
                // Mid-workflow idle: background tasks still in flight. NOT turn-over —
                // do NOT complete and do NOT touch the counter (it's the authority; a
                // task_notification will decrement it). Stay running; the real
                // end-of-workflow idle (after the counter drains to 0) completes below.
                log.session.info('idle while background work in flight — staying running, awaiting drain', {
                  sessionId: sid, taskId: this.taskId, bgTasksInFlight: this._bgTasksInFlight,
                })
                if (this._processStatus !== 'running') {
                  this._processStatus = 'running'
                  this._activity = this._workflowName ? `Workflow: ${this._workflowName}` : 'Background tasks running'
                  this.emitStatusChanged('IN_PROGRESS')
                }
              } else if (!this.resultEmitted && this._turnResultEmitted) {
                // result already processed this turn (normal single-turn path) — nothing to do.
              } else if (!this.resultEmitted) {
                // Authoritative turn-over: idle AND no background work in flight. If a
                // result was withheld because bg work was live, emit completion now.
                // Set _turnResultEmitted so the NEXT idle (the CLI keeps emitting them
                // after the turn ends) falls into the "nothing to do" branch above and
                // does NOT re-fire SESSION_RESULT. Mirrors the result handler (~3053).
                this._activity = undefined
                this._processStatus = 'idle'
                this._turnResultEmitted = true
                this.emitStatusChanged('AGENT_COMPLETE')
                bus.emit(EventNames.SESSION_RESULT, {
                  sessionId: sid, taskId: this.taskId,
                  result: this.fullText, isError: false,
                }, ['main-ai', 'session-runner'], { source: 'session-runner' })
              } else {
                // Already completed by result handler — just confirm idle status.
                if (this._processStatus === 'running') {
                  this._processStatus = 'idle'
                  this._activity = undefined
                }
              }
            }
            // requires_action: leave status as-is; the permission flow drives AWAIT.
          } else if (sys.subtype === 'task_started') {
            // ── Background task / dynamic-workflow lifecycle (opening bookend) ──
            const taskId = sys.task_id as string | undefined
            if (taskId) {
              if (!this._bgTasks.has(taskId)) this._bgTasksInFlight++
              const workflowName = sys.workflow_name as string | undefined
              // A dynamic workflow opens with task_type='local_workflow' and carries the
              // generated script in `prompt`. Capture it (and reset any prior run's agents)
              // so the UI can show WHAT workflow was created + a fresh per-subagent view.
              if (sys.task_type === 'local_workflow') {
                this._resetWorkflowState()
                if (typeof sys.prompt === 'string') this._workflowScript = sys.prompt
                if (typeof sys.description === 'string') this._workflowDescription = sys.description
              }
              if (workflowName) this._workflowName = workflowName
              this._bgTasks.set(taskId, {
                description: sys.description as string | undefined,
                subagentType: sys.subagent_type as string | undefined,
                status: 'running',
                workflowName,
              })
              this._lastBgActivityTs = Date.now()
              if (this._processStatus !== 'running') {
                this._processStatus = 'running'
                this._activity = workflowName ? `Workflow: ${workflowName}` : 'Background task running'
              }
              this._emitBackgroundTasksUpdate(sid)
            }
          } else if (sys.subtype === 'task_progress') {
            // Heartbeat — refresh activity timestamp (feeds the liveness invariant) + UI.
            const taskId = sys.task_id as string | undefined
            this._lastBgActivityTs = Date.now()
            // Dynamic-workflow per-subagent breakdown rides on task_progress in the
            // `workflow_progress` array — accumulate it (the CLI sends only the currently
            // active agents per snapshot). This is the data behind the rich progress panel.
            const wp = sys.workflow_progress as unknown[] | undefined
            const ingestedWorkflow = Array.isArray(wp) && wp.length > 0
            if (ingestedWorkflow) this._ingestWorkflowProgress(wp as unknown[])
            if (taskId) {
              const prev = this._bgTasks.get(taskId) ?? { status: 'running' }
              const usage = sys.usage as { total_tokens?: number } | undefined
              this._bgTasks.set(taskId, {
                ...prev,
                description: (sys.description as string | undefined) ?? prev.description,
                subagentType: (sys.subagent_type as string | undefined) ?? prev.subagentType,
                status: 'running',
                tokens: usage?.total_tokens ?? prev.tokens,
                lastTool: (sys.last_tool_name as string | undefined) ?? prev.lastTool,
                summary: (sys.summary as string | undefined) ?? prev.summary,
              })
            }
            // Emit if EITHER bookkeeping ran — a workflow_progress snapshot without a
            // task_id must still push the accumulated agents to the panel.
            if (taskId || ingestedWorkflow) this._emitBackgroundTasksUpdate(sid)
          } else if (sys.subtype === 'task_updated') {
            // Status patch — merge into local task map.
            const taskId = sys.task_id as string | undefined
            const patch = sys.patch as Record<string, unknown> | undefined
            this._lastBgActivityTs = Date.now()
            if (taskId && patch) {
              const prev = this._bgTasks.get(taskId) ?? { status: 'running' }
              this._bgTasks.set(taskId, {
                ...prev,
                status: (patch.status as string | undefined) ?? prev.status,
                description: (patch.description as string | undefined) ?? prev.description,
              })
              this._emitBackgroundTasksUpdate(sid)
            }
          } else if (sys.subtype === 'task_notification') {
            // Terminal bookend — task reached completed|failed|stopped.
            const taskId = sys.task_id as string | undefined
            const status = (sys.status as string | undefined) ?? 'completed'
            this._lastBgActivityTs = Date.now()
            if (taskId) {
              const prev = this._bgTasks.get(taskId)
              if (prev && prev.status === 'running') {
                this._bgTasksInFlight = Math.max(0, this._bgTasksInFlight - 1)
              }
              this._bgTasks.set(taskId, { ...(prev ?? {}), status })
              log.session.info('background task terminal', {
                sessionId: sid, taskId: this.taskId, bgTaskId: taskId, status,
                remainingInFlight: this._bgTasksInFlight,
              })
              this._emitBackgroundTasksUpdate(sid)
            }
          } else if (sys.subtype && sys.subtype !== 'init' && sys.subtype !== 'status') {
            // ── Observability: structured status cards from the stream-json protocol ──
            // post_turn_summary (per-turn status card: status_category / needs_action /
            // title) and task_summary (mid-turn progress line) are emitted only by the
            // CLI's bridge / remote-control / Kairos layer (fork src/server/
            // directConnectManager.ts), which requires a claude.ai OAuth subscription —
            // explicitly EXCLUDING Bedrock/Vertex (fork src/bridge/bridgeEnabled.ts).
            // A vanilla `claude -p` (what Walnut spawns) never enters that path, so these
            // currently never arrive. Verified absent via live probe on binary 2.1.170 in
            // Walnut's exact multi-turn stream-json mode. We log explicitly here so that
            // IF a future CLI version emits them on the plain print stream, we can confirm
            // it directly in Walnut logs (grep "stream-json summary subtype"). The
            // catch-all below already forwards the full payload to the UI as a system
            // block — no extra wiring needed the day they start arriving.
            if (sys.subtype === 'post_turn_summary' || sys.subtype === 'task_summary' || sys.subtype === 'session_state_changed') {
              log.session.info('stream-json summary subtype received', {
                sessionId: sid, taskId: this.taskId, subtype: sys.subtype,
                statusCategory: sys.status_category, needsAction: sys.needs_action,
                title: sys.title,
              })
            }
            // Catch-all: unknown future subtypes — forward full payload so we
            // don't lose diagnostic info to a bare subtype name.
            const payloadForDisplay = Object.fromEntries(
              Object.entries(sys).filter(([k]) => k !== 'session_id' && k !== 'uuid' && k !== 'type' && k !== 'subtype')
            )
            const detail = Object.keys(payloadForDisplay).length > 0
              ? JSON.stringify(payloadForDisplay).slice(0, 500)
              : undefined
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: 'info' as const, message: String(sys.subtype),
              detail,
            }, ['main-ai'], { source: 'session-runner' })
          }
        }

        break
      }

      case 'assistant': {
        const msg = event as StreamMessageEvent
        if (!Array.isArray(msg.message?.content)) break
        const msgId = msg.message?.id ?? ''
        const parentToolUseId = msg.parent_tool_use_id ?? undefined
        // Dedup strategy: the `assistant` JSONL content array does NOT include
        // thinking blocks, but the SSE stream at `inner.index` DOES. So an
        // index-based key drifts — we've had real cases where SSE wrote
        // `msgId:1` for text while assistant-loop wrote `msgId:0` and the
        // whole text was emitted twice (extended-thinking models).
        //
        // Instead: find *any* previously-streamed text for this msgId that
        // matches as a prefix, and use that as previousText. Works regardless
        // of whether thinking preceded text.
        let textBlocksSeen = 0
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text) {
            // Find the prefix-matching stream accumulator for this message.
            // Falls back to the trackingKey we ourselves wrote last time
            // the assistant branch ran (for non-stream_event mode).
            let previousText = ''
            let matchKey = ''
            for (const [key, val] of this._lastEmittedText) {
              if (!key.startsWith(`${msgId}:`)) continue
              // Longest matching prefix wins — handles multiple text blocks
              // per message by taking the one that best covers block.text.
              if (val.length > previousText.length && block.text.startsWith(val)) {
                previousText = val
                matchKey = key
              }
            }
            // Fallback for non-stream_event sessions: per-text-block-index key.
            const fallbackKey = `${msgId}:assistant-text:${textBlocksSeen}`
            textBlocksSeen++
            const trackingKey = matchKey || fallbackKey
            if (!matchKey) {
              previousText = this._lastEmittedText.get(fallbackKey) ?? ''
            }

            if (block.text === previousText) {
              continue // Exact duplicate — skip entirely
            }

            let deltaText: string
            if (previousText && block.text.startsWith(previousText)) {
              // Progressive growth — emit only the new suffix
              deltaText = block.text.slice(previousText.length)
            } else {
              // New text or complete rewrite — emit full text
              deltaText = block.text
            }

            this._lastEmittedText.set(trackingKey, block.text)

            // Secondary dedup guard (length-based) for exact replay scenarios
            const dedupKey = `${msgId}:text:${trackingKey}:${block.text.length}`
            if (this._emittedStreamKeys.has(dedupKey)) continue
            this._emittedStreamKeys.add(dedupKey)

            // Rewrite remote image paths to local paths (no-op for local sessions)
            const rewrittenDelta = this.rewriteRemoteImages(deltaText)
            if (this.fullText.length < MAX_FULL_TEXT) {
              this.fullText += rewrittenDelta
            }
            log.session.debug('JSONL event: text-delta', { sessionId: this.claudeSessionId, taskId: this.taskId })
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: rewrittenDelta,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (block.type === 'tool_use') {
            // Dedup: skip tool_use blocks already emitted (daemon replay protection)
            if (block.id) {
              const toolDedupKey = `${msgId}:tool_use:${block.id}`
              if (this._emittedStreamKeys.has(toolDedupKey)) {
                // DUP-DEBUG: dedup hit means we saw the same (msgId, tool_use_id)
                // twice — daemon replay or duplicate stream. If logs show
                // dedupHits accumulating but the UI STILL shows duplicates,
                // the duplication must be downstream of this guard (e.g. a
                // different msgId wrapping the same tool_use_id).
                this._toolUseDedupHits++
                log.session.info('tool_use dedup hit (replay protected)', {
                  ccsId: this._ccsId,
                  sessionId: this.claudeSessionId,
                  taskId: this.taskId,
                  toolUseId: block.id,
                  toolName: block.name,
                  msgId,
                  totalDedupHits: this._toolUseDedupHits,
                  totalLinesSeen: this._streamLinesSeen,
                })
                continue
              }
              this._emittedStreamKeys.add(toolDedupKey)
            }
            this._activity = `Using ${block.name}`

            // Cache image file paths from tool inputs (e.g. Read tool's file_path).
            // When the tool_result comes back with base64 image content blocks,
            // we use the cached path instead of the base64 data.
            if (block.id && block.input) {
              const imgPath = extractImageFilePathFromInput(block.input as Record<string, unknown>)
              if (imgPath) this._toolInputFilePaths.set(block.id, imgPath)
            }

            // Team mode detection — TeamCreate/TeamDelete tool_use.
            // While team is active, intermediate `result` events suppress idle/AGENT_COMPLETE/triage
            // because the lead session is polling for in-process teammate results (print.ts poll loop).
            if (block.name === 'TeamCreate') {
              this._teamActive = true
              this._teamName = (block.input as Record<string, unknown>)?.name as string | undefined
              log.session.info('team created — entering team mode', {
                sessionId: this.claudeSessionId, taskId: this.taskId,
                teamName: this._teamName,
              })
            }
            if (block.name === 'TeamDelete') {
              this._teamActive = false
              if (this._teamIdleTimer) { clearTimeout(this._teamIdleTimer); this._teamIdleTimer = null }
              log.session.info('team deleted — exiting team mode', {
                sessionId: this.claudeSessionId, taskId: this.taskId,
              })
            }

            // Capture plan file path and content (Claude writes plan to ~/.claude/plans/{slug}.md)
            if (block.name === 'Write' && typeof block.input?.file_path === 'string') {
              if (block.input.file_path.includes('.claude/plans/')) {
                this.planFile = block.input.file_path
                if (typeof block.input.content === 'string') {
                  this._lastPlanWriteContent = block.input.content
                }
              }
            }

            /**
             * ExitPlanMode detection — plan phase is complete.
             *
             * ┌─────────────────────────────────────────────────────────────────┐
             * │ SESSION MODE TRANSITION — HOW IT WORKS END-TO-END              │
             * │                                                                │
             * │ PROBLEM (empirically verified via 4 real CLI tests):           │
             * │ In `-p` (non-interactive) mode, ExitPlanMode returns           │
             * │ is_error=true because the CLI needs an interactive user to     │
             * │ approve the plan. The CLI does NOT switch permissions and      │
             * │ does NOT emit a system status event.                           │
             * │                                                                │
             * │ Therefore Walnut keeps the mode unchanged here. The session      │
             * │ stays 'plan' until the user explicitly clicks Execute, which   │
             * │ sends mode:'bypass' via the /execute-continue route.           │
             * │                                                                │
             * │ FLOW (plan session):                                           │
             * │  1. send(--permission-mode plan) → _mode = 'plan'             │
             * │  2. Claude plans, calls ExitPlanMode                           │
             * │  3. CLI returns is_error=true (can't exit without user)        │
             * │  4. THIS HANDLER: planCompleted=true, _mode stays 'plan'      │
             * │  5. emitStatusChanged() → WS → UI shows Execute button        │
             * │  6. updateSessionRecord(planCompleted, planFile) → sessions    │
             * │  7. Turn ends, process stops                                   │
             * │  8. Human clicks Execute → POST /execute-continue              │
             * │  9. Route explicitly sends mode:'bypass' to processNext()      │
             * │     → --permission-mode bypassPermissions                      │
             * │ 10. CLI starts in bypass → Claude can Write/Edit/Bash          │
             * │                                                                │
             * │ FLOW (bypass session, voluntary planning):                     │
             * │  1. send(--permission-mode bypass) → _mode = 'bypass'         │
             * │  2. Claude voluntarily plans, calls ExitPlanMode               │
             * │  3. THIS HANDLER: _mode unchanged (still 'bypass')            │
             * │  4. No spurious "Plan" badge, resume stays bypass              │
             * │                                                                │
             * │ Test evidence:                                                 │
             * │  - test-plan-exit-then-bash.jsonl: ExitPlanMode is_error=true, │
             * │    no system status event, Claude stays in plan mode           │
             * │  - test-bypass-enterplan.jsonl: EnterPlanMode DOES emit        │
             * │    system status event (asymmetric behavior)                   │
             * │  - Session 7035c120: bypass session called ExitPlanMode,       │
             * │    old code overwrote mode to 'plan' (wrong!)                  │
             * └─────────────────────────────────────────────────────────────────┘
             */
            if (block.name === 'ExitPlanMode') {
              this.planCompleted = true
              this._activity = 'plan complete'
              // Keep _mode unchanged — a plan session stays 'plan', a bypass session stays 'bypass'.
              // Execute routes pass mode:'bypass' explicitly, so record.mode is not used for that.

              // Persist planCompleted + planFile immediately so the flag survives crashes/restarts.
              if (this.claudeSessionId) {
                import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                  updateSessionRecord(this.claudeSessionId!, { planCompleted: true, planFile: this.planFile ?? undefined })
                    .catch(() => {}),
                )
              }

              // Promote to plan slot: if this session occupies the exec slot (not already
              // on the plan slot), move it to plan_session_id so the UI recognizes it as
              // a plan session regardless of original mode (bypass, default, etc.).
              if (this.claudeSessionId && this.taskId) {
                import('../core/task-manager.js').then(async ({ getTask, linkSessionSlot, clearSessionSlot }) => {
                  const sid = this.claudeSessionId!
                  const tid = this.taskId!
                  try {
                    const task = await getTask(tid)
                    // Only promote if session is on exec slot (or no slot), and plan slot is free
                    if (task.plan_session_id === sid) return // already on plan slot
                    if (task.plan_session_id && task.plan_session_id !== sid) return // another session owns plan slot
                    if (task.exec_session_id === sid) {
                      await clearSessionSlot(tid, sid, 'exec')
                    }
                    await linkSessionSlot(tid, sid, 'plan')
                  } catch { /* task not found or lock contention — ignore */ }
                }).catch(() => {})
              }

              // Notify frontend so it can show the Execute button once the session stops
              this.emitStatusChanged('IN_PROGRESS')
            }

            // ── AskUserQuestion auto-intercept ──
            // In -p (non-interactive) mode, AskUserQuestion never reaches the user.
            // Claude often calls it repeatedly (7+ times), wasting tokens.
            // Auto-inject a corrective message once per turn so Claude stops trying.
            if (block.name === 'AskUserQuestion' && !this._askUserIntercepted && this._transport?.hasPipe) {
              this._askUserIntercepted = true
              const correction = 'You are running in non-interactive (-p) mode. '
                + 'The user cannot see AskUserQuestion — it will always fail here. '
                + 'Instead, print your questions or assumptions directly in your text output, and wait for user response.'
              Promise.resolve(this._transport?.writeMessage(correction)).then((injected) => {
                log.session.info('auto-intercepted AskUserQuestion in -p mode', {
                  sessionId: this.claudeSessionId,
                  taskId: this.taskId,
                  injected: injected ?? false,
                })
              }).catch(() => {})
            }

            // For ExitPlanMode, resolve plan content: prefer captured Write content, fall back to input.plan
            const exitPlanContent = block.name === 'ExitPlanMode'
              ? (this._lastPlanWriteContent
                ?? (typeof block.input?.plan === 'string' && block.input.plan ? block.input.plan : null))
              : null

            log.session.debug('JSONL event: tool-use', {
              // DUP-DEBUG: ccsId tags each emit with its session instance.
              // Two emits with same toolUseId but different ccsId → two
              // ClaudeCodeSession instances alive for same sid.
              ccsId: this._ccsId,
              sessionId: this.claudeSessionId, taskId: this.taskId,
              toolName: block.name, toolUseId: block.id, msgId,
              parentToolUseId,
            })
            bus.emit(EventNames.SESSION_TOOL_USE, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              toolName: block.name,
              toolUseId: block.id,
              input: block.input,
              ...(exitPlanContent ? { planContent: exitPlanContent } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
            }, ['main-ai'], { source: 'session-runner' })
          }
        }

        // ── Emit context window usage from assistant message ──
        // Skip subagent messages — Agent/Task tool calls produce assistant messages
        // with their own independent (smaller) context windows.  Without this guard,
        // the UI bounces between parent (248K) and subagent (50K) context percentages.
        // parent_tool_use_id is null for parent conversation, set for subagents.
        if (parentToolUseId) break
        // Context % = totalInput / contextWindowSize * 100
        //   totalInput = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        //   These three fields are mutually exclusive (no overlap):
        //     - input_tokens: tokens NOT read from or written to cache
        //     - cache_creation_input_tokens: tokens written to cache this request
        //     - cache_read_input_tokens: tokens read from cache
        //   Their sum = total prompt size = context window usage.
        //   NOT capped at 100 — values >100% indicate wrong contextWindowSize detection.
        if (this.claudeSessionId && msg.message) {
          const usage = msg.message.usage
          if (usage) {
            const totalInput = usage.input_tokens
              + (usage.cache_creation_input_tokens ?? 0)
              + (usage.cache_read_input_tokens ?? 0)
            // Detect context window size:
            //   1) init model string contains [1m] → 1M
            //   2) totalInput > 200K → must be 1M (defense-in-depth: processNext
            //      now preserves record.model on resume, but this catches any
            //      other code path that might lose the [1m] suffix)
            //   3) default → 200K
            const is1M = (this._initModel?.includes('[1m]') ?? false)
              || totalInput > CONTEXT_WINDOW_DEFAULT
            const contextWindowSize = is1M ? 1_000_000 : 200_000
            const contextPercent = Math.round(totalInput / contextWindowSize * 100)
            // Use assistant message model only as fallback when init event didn't
            // provide one. Init model is the source of truth — it reflects the
            // configured --model flag. Claude Code routes Agent subagent calls to
            // cheaper models (Haiku), and those appear as assistant messages with a
            // different model string. Legit model switches (via /model command)
            // trigger a --resume which fires a new init event, updating _model there.
            const msgModel = msg.message.model
            if (typeof msgModel === 'string' && msgModel && !this._model) {
              this._model = msgModel
            }
            bus.emit(EventNames.SESSION_USAGE_UPDATE, {
              sessionId: this.claudeSessionId,
              model: this._model,
              contextPercent,
              inputTokens: totalInput,
            }, ['main-ai'], { source: 'session-runner' })
          }
        }
        break
      }

      case 'user': {
        const msg = event as StreamMessageEvent
        // Skip synthetic walnut-injected user events (content is a plain string).
        // Only process Claude Code's canonical user events (content is an array
        // of tool_result blocks). Synthetic events exist in the streams file for
        // history reads — emitting them here would duplicate the optimistic copy.
        if (!Array.isArray(msg.message?.content)) break
        const userParentToolUseId = msg.parent_tool_use_id ?? undefined
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            let resultContent: string
            // If the tool_result has image content blocks, use the cached file path
            // from the tool_use input instead of the base64 data. This keeps the
            // streaming pipeline lightweight — paths are short and the frontend's
            // findImagePaths() detects them and renders via /api/local-image.
            const hasImageBlocks = Array.isArray(block.content) && block.content.some((c: Record<string, unknown>) => c.type === 'image')
            const cachedPath = block.tool_use_id ? this._toolInputFilePaths.get(block.tool_use_id) : undefined
            if (hasImageBlocks && cachedPath) {
              // Use the file path from the tool input — avoids piping 130K+ base64 through the bus
              resultContent = cachedPath
              this._toolInputFilePaths.delete(block.tool_use_id as string)
            } else if (hasImageBlocks) {
              // Image blocks but no cached path (e.g. screenshot tool without file_path input).
              // Don't serialize the base64 blob — just note it's an image.
              resultContent = '[image]'
            } else {
              const rawResult = typeof block.content === 'string'
                ? block.content
                : (block.content != null ? JSON.stringify(block.content) : '')
              resultContent = rawResult
            }
            // Rewrite remote image paths in tool results (no-op for local sessions)
            resultContent = this.rewriteRemoteImages(resultContent)
            log.session.debug('JSONL event: tool-result', {
              // DUP-DEBUG: same ccsId scheme as tool-use — see emit above.
              ccsId: this._ccsId,
              sessionId: this.claudeSessionId, taskId: this.taskId,
              toolUseId: block.tool_use_id,
            })
            bus.emit(EventNames.SESSION_TOOL_RESULT, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              toolUseId: block.tool_use_id,
              result: resultContent.slice(0, 2000),
              ...(userParentToolUseId ? { parentToolUseId: userParentToolUseId } : {}),
            }, ['main-ai'], { source: 'session-runner' })
          }
        }
        break
      }

      case 'result': {
        const result = event as StreamResultEvent

        // Guard against duplicate/replayed result events (daemon resume can replay
        // old JSONL lines). The init-reset above handles auto-continuation turns;
        // this guard catches pure replays where no new init was emitted.
        if (this._turnResultEmitted) {
          log.session.debug('ignoring duplicate result event (no init since last result)', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
          })
          break
        }

        // Guard against replayed results for sessions already marked as complete.
        // After server restart, attachToExisting() sets resultEmitted=true for sessions
        // whose task is past IN_PROGRESS. But the daemon may replay the entire JSONL
        // history — each replayed init resets _turnResultEmitted, letting old results
        // through. Without this guard, N replayed turns = N SESSION_RESULT events = N
        // triage dispatches = wasted tokens. resultEmitted is only reset to false by
        // writeMessage() when a new user message is sent, so this guard only blocks
        // replays, never legitimate new results.
        if (this.resultEmitted) {
          log.session.debug('suppressing replayed result (session already complete)', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
          })
          this._turnResultEmitted = true
          break
        }

        // ── Background-work intermediate result (dynamic workflows) ──
        // A dynamic-workflow turn emits MANY `result` events: the main turn's own
        // result (often "Workflow launched in background...") PLUS one per background
        // subagent completion that the CLI feeds back into a fresh ask(). NONE of these
        // mean "session is done". The turn is over only at a session_state_changed{idle}
        // that arrives AFTER our `_bgTasksInFlight` counter has drained to 0 — NOT at the
        // first idle (POC-verified: idle fires ~20×/run, between every sub-agent; see
        // [[claude_code_session_state_semantics]] and the session_state_changed handler).
        //
        // Two filters:
        //  (a) origin.kind === 'task-notification' → a result produced by the CLI
        //      processing a completion notification. Never a real turn-over. Skip
        //      completion entirely (don't even update _lastResultCost — it's noise).
        //  (b) our in-flight counter shows live background tasks → withhold
        //      AGENT_COMPLETE; stay running. The idle-after-drain event completes it.
        const resultOrigin = (event as Record<string, unknown>).origin as { kind?: string } | undefined
        const isTaskNotificationResult = resultOrigin?.kind === 'task-notification'
        if (isTaskNotificationResult) {
          log.session.info('result is task-notification origin — bookkeeping only, no turn-over', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
          })
          // Capture final text/cost for display but do NOT complete the turn or set
          // _turnResultEmitted (a real result or idle still has to arrive).
          if (typeof result.result === 'string' && result.result) this.fullText = result.result
          break
        }
        if (this.hasActiveBackgroundWork()) {
          log.session.info('result while background work in flight — staying running, awaiting idle', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            bgTasksInFlight: this._bgTasksInFlight, cliState: this._cliSessionState,
          })
          if (typeof result.result === 'string' && result.result) this.fullText = result.result
          if (result.total_cost_usd !== undefined) this._lastResultCost = result.total_cost_usd
          this._processStatus = 'running'
          this._activity = this._workflowName ? `Workflow: ${this._workflowName}` : 'Background tasks running'
          this.emitStatusChanged('IN_PROGRESS')
          break
        }

        // Detect stale/replayed result events for daemon sessions (all sessions now).
        // If the cumulative cost is identical to the previous turn's cost, the CLI
        // didn't make an API call — the daemon replayed old JSONL events (e.g., after
        // a FIFO write to a stuck process that echoed the old result without processing).
        // Skip this check for the first result (no previous cost) and for error results.
        if (this._transport
          && this._lastResultCost !== undefined
          && result.total_cost_usd !== undefined
          && result.total_cost_usd === this._lastResultCost
          && !result.is_error) {
          // Dump the full raw record so we can diagnose *why* the CLI made zero API calls.
          // Fields to look at next time: subtype, stop_reason, num_turns, duration_api_ms,
          // usage, mcp_servers. A `num_turns: 0` with `duration_api_ms: 0` means the CLI
          // never entered the agent loop — typical of MCP init hang or pre-flight bailout.
          log.session.warn('stale result detected (cost unchanged) — forcing --resume on next message', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            cost: result.total_cost_usd, prevCost: this._lastResultCost,
            rawResult: event,
          })
          // Mark pipe as dead so processNext falls through to --resume spawn
          // instead of writing to a potentially broken FIFO.
          if (this._transport) {
            (this._transport as import('./remote-session-manager.js').RemoteSessionManager).deletePipe()
          }
        }

        // Track cost for stale detection on next turn
        if (result.total_cost_usd !== undefined) {
          this._lastResultCost = result.total_cost_usd
        }

        // On error, keep the original session ID so events reach the frontend
        // (Claude CLI assigns a new throwaway ID even when --resume fails)
        if (result.session_id && !result.is_error) {
          this.claudeSessionId = result.session_id
        }

        // Extract error messages from the result (e.g. "No conversation found with session ID: ...")
        let resultText = result.result ?? this.fullText
        const resultErrors = Array.isArray((result as Record<string, unknown>).errors)
          ? ((result as Record<string, unknown>).errors as string[])
          : undefined

        // Detect Claude Code "soft" is_error — the turn actually produced real output
        // (fullText non-empty) and the only error marker is [ede_diagnostic], which fires
        // when stop_reason=tool_use + last message.type=user in print-mode stream-json.
        // This is NOT a real API failure — downgrade to a normal result so the task goes
        // to AGENT_COMPLETE instead of AWAIT_HUMAN_ACTION.
        const isSoftEdeError = result.is_error
          && !!this.fullText
          && this.fullText.trim().length > 0
          && resultErrors !== undefined
          && resultErrors.every(e => e.startsWith('[ede_diagnostic]'))
        const effectiveIsError = result.is_error && !isSoftEdeError

        let conversationLost = false
        if (result.is_error && resultErrors?.length && !isSoftEdeError) {
          let errorMsg = resultErrors.join('; ')
          // Add cwd hint — Claude CLI uses cwd to resolve session storage path,
          // so a renamed/moved project directory causes "No conversation found"
          if (errorMsg.includes('No conversation found')) {
            conversationLost = true
            errorMsg += ` (cwd: ${this._cwd ?? 'unknown'} — the project directory may have changed since this session was created)`
          }
          resultText = errorMsg
        }

        // Auto-archive on "No conversation found": the remote/local JSONL was wiped
        // (typical on clouddev cleanup), so --resume will keep failing. Archive the
        // stale record to free the task's single-slot and let the next session_send
        // pre-flight detect the loss and start a fresh session.
        if (conversationLost && this.claudeSessionId) {
          const sid = this.claudeSessionId
          const hint = `Remote JSONL missing (cwd=${this._cwd ?? 'unknown'}, host=${this._host ?? 'local'})`
          log.session.warn('conversation lost — auto-archiving session', {
            sessionId: sid, taskId: this.taskId, host: this._host, cwd: this._cwd,
          })
          import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
            updateSessionRecord(sid, {
              archived: true,
              archive_reason: 'remote_conversation_lost',
              errorMessage: hint,
            }),
          ).catch((err) => {
            log.session.warn('failed to auto-archive lost conversation', { sessionId: sid, error: err instanceof Error ? err.message : String(err) })
          })
        }

        log.session.info('session result received', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          cost: result.total_cost_usd,
          isError: result.is_error,
          effectiveIsError,
          ...(isSoftEdeError ? { softEdeDowngrade: true } : {}),
          hasFifo: this._transport?.hasPipe ?? false,
          ...(resultErrors?.length ? { errors: resultErrors } : {}),
        })

        if (this.claudeSessionId) {
          this.persistSessionRecord(this.claudeSessionId, this._cwd ?? undefined).catch((err) => {
            log.session.warn('persistSessionRecord failed (result handler)', { sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err) })
          })
        }

        // Process liveness check for deciding FIFO-alive vs exited.
        // Local: process.kill(pid, 0) — quick and reliable.
        // Remote: local PID check is meaningless (PID is on the remote host).
        //   For remote sessions, trust _hasPipe — it's cleared when the daemon
        //   sends an 'exit' event or when the FIFO write fails (ENXIO/EAGAIN).
        let processStillAlive = false
        if (this._transport?.isRemote) {
          // Remote: process.kill can't reach remote PID. Trust hasPipe instead.
          processStillAlive = this._transport.hasPipe
        } else if (this.pid !== null) {
          try { process.kill(this.pid, 0); processStillAlive = true } catch { /* dead */ }
        }
        if (this._transport?.hasPipe && processStillAlive) {
          // stream-json FIFO mode: process is still alive between turns.
          // Works for both local and remote sessions now that remote uses hasPipe
          // for the liveness signal instead of local PID checks.
          if (this._teamActive) {
            // Team subagents still working — lead is in poll loop (print.ts while(true))
            // waiting for teammate inbox messages. Keep 'running' so health monitor
            // doesn't mistake the poll sleep for an idle session.
            this._processStatus = 'running'
            this._activity = 'Team subagents working'
          } else {
            this._processStatus = 'idle'  // Turn done, process alive, waiting for next writeMessage()
            this._activity = undefined
          }
          this.resultEmitted = false  // Ready for next turn
        } else if (this._transport?.isRemote && !effectiveIsError) {
          // Remote daemon session: process exited (hasPipe was cleared by daemon exit
          // event or FIFO write failure), but daemon connection is still alive.
          // Show 'idle' so user can send follow-up messages (triggers --resume).
          // BUT: if onExit already set 'error' (non-zero exit code), don't overwrite —
          // the error state + errorMessage must reach the frontend.
          this.resultEmitted = true
          this._active = false
          if (this._processStatus !== 'error') {
            this._processStatus = 'idle'
          }
          this._activity = undefined
          // Clear PID — the remote process exited. Prevents stale local PID checks.
          this.pid = null
          if (this.claudeSessionId) {
            const sid = this.claudeSessionId
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(sid, { pid: undefined }),
            ).catch(() => {})
          }
          // Broadcast status-change so server's belt-and-suspenders (web/server.ts
          // on session:status-changed with process_status in {stopped,error,idle})
          // calls sessionStreamBuffer.markDone(sid). Without this, a subsequent
          // daemon replay wave that gets suppressed by the resultEmitted guard at
          // line ~2145 never drives the stream buffer to isStreaming=false, and
          // the UI's "Streaming" badge stays stuck until the next writeMessage.
          this.emitStatusChanged('AGENT_COMPLETE')
        } else {
          // Process is exiting (SSH, interrupted, or natural exit)
          this.resultEmitted = true
          this._active = false
          this._processStatus = 'stopped'
          this._activity = undefined
          this._teamActive = false  // Safety: clear team flag on process exit
          if (this._teamIdleTimer) { clearTimeout(this._teamIdleTimer); this._teamIdleTimer = null }
          this.stopMonitoring()
          this._pendingPermissionRequests.clear()
          this._clearAllPermissionReEmitTimers()

          // Clear PID + pendingPermission from record to prevent stale state on future reuse
          if (this.claudeSessionId) {
            const sid = this.claudeSessionId
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(sid, { pid: undefined, pendingPermission: undefined }),
            ).catch((err) => {
              log.session.warn('failed to clear PID/pendingPermission on process exit', { sessionId: sid, error: String(err) })
            })
          }
        }

        this._turnResultEmitted = true

        // ── Forensic observability: emit the per-turn wide event + run invariants. ──
        // Single call covers both team + non-team branches (teamActive distinguishes).
        // Fire-and-forget, never throws — must not affect turn completion. This is the
        // hook that catches "silent success" (e.g. success + stopReason=null = truncation).
        recordTurn({
          sessionId: this.claudeSessionId ?? this.sessionId ?? '',
          taskId: this.taskId ?? undefined,
          host: this._host,
          model: this._model,
          hasPipe: this._transport?.hasPipe ?? false,
          pid: this.pid ?? null,
          isError: effectiveIsError ?? false,
          subtype: (result as { subtype?: string }).subtype,
          numTurns: result.num_turns,
          stopReason: this._lastStopReason,
          durationMs: result.duration_ms,
          resultLen: resultText?.length ?? 0,
          deliveryMs: this._lastDeliveryMs,
          deliveryPath: this._lastDeliveryPath,
          teamActive: this._teamActive,
          backgroundActive: this.hasActiveBackgroundWork(),
        })

        if (this._teamActive) {
          // Team subagents still working — this is an intermediate result from
          // the lead session (e.g. "Team is up. 5 reviewers working...").
          // Suppress AGENT_COMPLETE phase and triage; keep task at IN_PROGRESS.
          log.session.info('team active — intermediate result, staying IN_PROGRESS', {
            sessionId: this.claudeSessionId, taskId: this.taskId, resultLength: resultText?.length ?? 0,
          })
          this.emitStatusChanged('IN_PROGRESS')
          bus.emit(EventNames.SESSION_RESULT, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            result: resultText,
            totalCost: result.total_cost_usd,
            duration: result.duration_ms,
            isError: effectiveIsError ?? false,
            teamActive: true,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })

          // Schedule team-idle check: periodically checks if subagent JSONL files
          // are still being written. Only clears _teamActive when all teammates
          // have been idle for the full timeout period.
          this._scheduleTeamIdleCheck(resultText, result.total_cost_usd, result.duration_ms)
        } else {
          this.emitStatusChanged('AGENT_COMPLETE')
          log.session.info('session result emitted', { sessionId: this.claudeSessionId, taskId: this.taskId, resultLength: resultText?.length ?? 0 })
          bus.emit(EventNames.SESSION_RESULT, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            result: resultText,
            totalCost: result.total_cost_usd,
            duration: result.duration_ms,
            isError: effectiveIsError ?? false,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
        }

        break
      }

      // ── Permission prompt tool protocol ──
      // When --permission-prompt-tool stdio is active, Claude Code sends
      // control_request events for tool permission checks (sensitive file writes,
      // AskUserQuestion, etc.). We respond via the FIFO with control_response.
      //
      // Wire format (from Claude Code source — controlSchemas.ts):
      //   Request:  { type: 'control_request', request_id, request: { subtype: 'can_use_tool', ... } }
      //   Response: { type: 'control_response', response: { subtype: 'success', request_id, response: <PermissionResult> } }
      //   PermissionResult = { behavior: 'allow', updatedInput } | { behavior: 'deny', message }
      case 'control_request': {
        const ctrl = event as unknown as {
          type: 'control_request'
          request_id: string
          request: {
            subtype: string
            tool_name?: string
            input?: Record<string, unknown>
            tool_use_id?: string
            decision_reason?: string
            permission_suggestions?: unknown[]
          }
        }
        const { request_id, request } = ctrl
        log.session.info('control_request received', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          requestId: request_id,
          subtype: request.subtype,
          toolName: request.tool_name,
          mode: this._mode,
        })

        // Dedup: ignore a request_id we've already responded to. The daemon
        // replays historical JSONL on reconnect; a replayed control_request is
        // stale (already auto-allowed remotely) and must not resurrect a prompt.
        // DEFENSE-IN-DEPTH: the daemon's addSubscriber() already skips control
        // lines during replay, so in the common case this guard never fires. It
        // is retained as a backstop for (1) version skew — a remote daemon running
        // an OLDER binary that predates the skip — and (2) any race where a control
        // line slips through. Both layers are intentional; do NOT delete this as
        // "redundant" with the daemon-side skip.
        if (this._resolvedPermissionRequestIds.has(request_id)) {
          log.session.info('control_request ignored — already resolved (stale replay)', {
            sessionId: this.claudeSessionId, taskId: this.taskId, requestId: request_id, toolName: request.tool_name,
          })
          break
        }

        if (request.subtype === 'can_use_tool') {
          // NOTE: For daemon sessions (all sessions now), bypass/plan auto-approval is
          // handled by the daemon itself — it `continue`s past auto-decided requests so
          // walnut never sees them. The code below is retained as a safety fallback but
          // is effectively dead code for daemon-backed sessions.
          if (this._mode === 'bypass') {
            // Bypass mode: check auto_approve_bypass config (default: true).
            // Config read is async — use .then() since handleStreamLine is sync.
            // Add sentinel BEFORE async gap so hasPendingPermission is true during config read.
            this._pendingPermissionRequests.set(request_id, { request_id, request })
            import('../core/config-manager.js').then(({ getConfig }) => getConfig()).then(cfg => {
              if (!this._active) return  // Session killed during async gap — discard
              const autoApprove = cfg.session?.auto_approve_bypass !== false
              if (autoApprove) {
                this._pendingPermissionRequests.delete(request_id)
                this.respondToControlRequest(request_id, request, true)
              } else {
                // auto_approve_bypass OFF: treat bypass like other modes — show to user.
                // Sentinel already in _pendingPermissionRequests; start re-emit timer.
                this._startPermissionReEmitTimer(request_id, request)
                if (this.claudeSessionId) {
                  import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                    updateSessionRecord(this.claudeSessionId!, {
                      pendingPermission: { requestId: request_id, toolName: request.tool_name, input: request.input, reason: request.decision_reason, subtype: request.subtype, receivedAt: new Date().toISOString() },
                    }),
                  ).catch(() => {})
                  bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
                    sessionId: this.claudeSessionId,
                    taskId: this.taskId,
                    requestId: request_id,
                    toolName: request.tool_name,
                    input: request.input,
                    reason: request.decision_reason,
                  }, ['*'], { source: 'session-runner', urgency: 'urgent' })
                }
              }
            }).catch(() => {
              if (!this._active) return  // Session killed during async gap — discard
              // Config read failed — default to auto-approve in bypass
              this._pendingPermissionRequests.delete(request_id)
              this.respondToControlRequest(request_id, request, true)
            })
          } else {
            // Non-bypass modes: emit to UI for user decision.
            // Store the pending request so the API route can resolve it later.
            this._pendingPermissionRequests.set(request_id, { request_id, request })
            log.session.info('control_request pending — waiting for user decision', {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              requestId: request_id,
              toolName: request.tool_name,
              mode: this._mode,
            })

            // Layer 2: Persist to session record on disk — survives server crashes.
            // Best-effort: don't block the event handler on disk I/O.
            if (this.claudeSessionId) {
              import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
                updateSessionRecord(this.claudeSessionId!, {
                  pendingPermission: {
                    requestId: request_id,
                    toolName: request.tool_name,
                    input: request.input,
                    reason: request.decision_reason,
                    subtype: request.subtype,
                    receivedAt: new Date().toISOString(),
                  },
                }),
              ).catch(err => log.session.warn('failed to persist pendingPermission', {
                sessionId: this.claudeSessionId, error: err instanceof Error ? err.message : String(err),
              }))

              // Layer 4: Periodic re-emit of permission request every 60s.
              // If the UI missed the initial event, the re-emit ensures visibility.
              // No auto-approve or auto-deny — the session waits indefinitely for human decision.
              this._startPermissionReEmitTimer(request_id, request)

              bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
                sessionId: this.claudeSessionId,
                taskId: this.taskId,
                requestId: request_id,
                toolName: request.tool_name,
                input: request.input,
                reason: request.decision_reason,
              }, ['*'], { source: 'session-runner', urgency: 'urgent' })
            }
          }
        } else {
          // Send deny for unknown subtypes to prevent Claude Code from blocking forever
          log.session.warn('unknown control_request subtype — auto-denying to prevent deadlock', {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            subtype: request.subtype,
            requestId: request_id,
          })
          this.respondToControlRequest(request_id, request, false, `Unknown control_request subtype: ${request.subtype}`)
        }
        break
      }

      // ── control_response: CLI's reply to a Walnut-initiated control_request ──
      // The INBOUND direction of the stream-json control protocol (see
      // _pendingSideQuestions above). The CLI emits this after handling one of OUR
      // outbound control_requests (e.g. side_question). The permission flow does NOT
      // use this branch — there Walnut is the responder, not the requester. We resolve
      // the pending promise by request_id and DO NOT push anything into the transcript
      // (that's what keeps a /btw answer out of the main conversation).
      case 'control_response': {
        const cr = event as unknown as {
          type: 'control_response'
          response?: {
            subtype?: 'success' | 'error'
            request_id?: string
            // side_question nests the answer three levels: response.response.response
            response?: { response?: string; synthetic?: boolean }
            error?: string
          }
        }
        const requestId = cr.response?.request_id
        if (!requestId) break
        const pending = this._pendingSideQuestions.get(requestId)
        if (!pending) break // not ours (or a stale replay we already resolved)
        this._pendingSideQuestions.delete(requestId)
        clearTimeout(pending.timer)
        if (cr.response?.subtype === 'error') {
          pending.reject(new Error(cr.response.error || 'side question failed'))
        } else {
          const answer = cr.response?.response?.response ?? ''
          log.session.info('side_question control_response resolved', {
            sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
            answerLen: answer.length,
          })
          pending.resolve(answer)
        }
        break
      }

      case 'stream_event': {
        // Anthropic SSE partial events (--include-partial-messages). Enables
        // token-level UI streaming. See claude-stream-event-map.ts for the
        // parse/drop/unknown contract.
        const se = event as unknown as {
          event?: {
            type?: string
            message?: { id?: string }
            index?: number
            content_block?: { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
            delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
          }
        }
        const inner = se.event
        const innerType = inner?.type ?? ''
        if (!innerType) break
        const fate = classifyStreamEvent(innerType)
        if (fate === 'drop') break
        if (fate === 'unknown') {
          this.emitUnknownEventOnce('stream_event', innerType, line)
          break
        }

        // ── message_start: capture msg id for dedup tracking ──
        if (innerType === 'message_start') {
          this._currentStreamMsgId = inner?.message?.id ?? null
          break
        }

        // ── message_delta: already handled for usage/stop_reason upstream ──
        // Capture stop_reason for the forensic per-turn wide event + the
        // truncated-success invariant (success + stopReason=null = truncation).
        if (innerType === 'message_delta') {
          const sr = (inner?.delta as { stop_reason?: string | null } | undefined)?.stop_reason
          if (sr !== undefined) this._lastStopReason = sr
          break
        }

        // ── content_block_delta: real content streams here ──
        if (innerType === 'content_block_delta') {
          const delta = inner?.delta
          const deltaType = delta?.type ?? ''
          const deltaFate = classifyDelta(deltaType)
          if (deltaFate === 'drop') break
          if (deltaFate === 'unknown') {
            this.emitUnknownEventOnce('delta', deltaType, line)
            break
          }

          const msgId = this._currentStreamMsgId ?? ''
          const sseIndex = inner?.index ?? 0

          if (deltaType === 'text_delta') {
            const text = delta?.text ?? ''
            if (!text) break
            // Stream path stores per-(msgId, SSE-index) accumulators. The
            // `assistant` branch doesn't know our SSE index (Claude Code strips
            // thinking blocks from the persisted content array), so it
            // prefix-matches any `${msgId}:*` key — which works regardless of
            // how indexes line up between the two paths.
            const trackingKey = `${msgId}:${sseIndex}`
            const previousText = this._lastEmittedText.get(trackingKey) ?? ''
            this._lastEmittedText.set(trackingKey, previousText + text)

            const rewritten = this.rewriteRemoteImages(text)
            if (this.fullText.length < MAX_FULL_TEXT) {
              this.fullText += rewritten
            }
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: rewritten,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (deltaType === 'thinking_delta') {
            const text = delta?.thinking ?? ''
            if (!text) break
            bus.emit(EventNames.SESSION_THINKING_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: text,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (deltaType === 'citations_delta') {
            // Surface citation as a text_delta with the reference mark so it
            // appears in the normal text flow. More elaborate UI can come later.
            const citation = JSON.stringify(delta)
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: ` ※${citation} `,
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          }
          break
        }

        break
      }

      default: {
        const unknownType = (event as { type?: string }).type ?? 'null'
        this.emitUnknownEventOnce('top_level', unknownType, line)
        break
      }
      }
    } catch (err) {
      log.session.warn('error processing stream event', {
        taskId: this.taskId,
        type: (event as { type: string }).type,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private emitStatusChanged(phase: TaskPhase, errorMessage?: string): void {
    bus.emit(EventNames.SESSION_STATUS_CHANGED, {
      sessionId: this.claudeSessionId,
      taskId: this.taskId,
      process_status: this._processStatus,
      phase,
      mode: this._mode,
      activity: this._activity,
      ...(this.planCompleted ? { planCompleted: true } : {}),
      ...(this.fromPlanSessionId ? { fromPlanSessionId: this.fromPlanSessionId } : {}),
      ...(this.forkedFromSessionId ? { forkedFromSessionId: this.forkedFromSessionId } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    }, ['*'], { source: 'session-runner', urgency: 'urgent' })
  }

  // ── Permission prompt tool helpers ──

  /**
   * Send a control_response to Claude Code via the FIFO.
   * @param allow — true to allow, false to deny
   * @returns true if the response was written (or at least attempted), false if no transport
   */
  private respondToControlRequest(
    requestId: string,
    request: { tool_name?: string; input?: Record<string, unknown> },
    allow: boolean,
    denyMessage?: string,
  ): boolean {
    const result = allow
      ? { behavior: 'allow' as const, updatedInput: request.input }
      : { behavior: 'deny' as const, message: denyMessage ?? 'User denied permission' }
    // SDKControlResponseSchema wraps ControlResponseSchema: outer `response` is transport,
    // inner `response` is the permission result. Format mismatch = Claude Code hangs silently.
    const response = JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: result,
      },
    })
    log.session.info(`control_request ${allow ? 'approved' : 'denied'}`, {
      sessionId: this.claudeSessionId,
      taskId: this.taskId,
      requestId,
      toolName: request.tool_name,
      mode: this._mode,
    })
    if (!this._transport) {
      // Transport gone: the response was NOT delivered. resolvePermissionRequest()
      // sees written===false and re-queues this request for recovery on reconnect.
      // CRITICAL: do NOT add requestId to _resolvedPermissionRequestIds here —
      // the request is still genuinely pending. Poisoning it would make the dedup
      // guard in handleStreamLine() silently drop the replayed control_request,
      // permanently stranding the session (CLI blocked forever).
      log.session.warn('control_response dropped — no transport (session detached). Permission stays pending for recovery.', {
        sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
      })
      return false
    }
    // Response is being delivered (sync handoff to writeRaw succeeded). Mark resolved
    // so a daemon replay of this same request_id on reconnect is ignored.
    this._resolvedPermissionRequestIds.add(requestId)
    Promise.resolve(this._transport.writeRaw(response)).then((ok) => {
      if (!ok) {
        log.session.warn('control_response write failed (broken pipe) — session may hang until idle timeout kills it', {
          sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
        })
      }
    }).catch((err) => {
      log.session.warn('control_response write error — session may hang until idle timeout kills it', {
        sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    // Notify UI
    if (this.claudeSessionId) {
      bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
        sessionId: this.claudeSessionId,
        taskId: this.taskId,
        variant: 'info' as const,
        message: `Permission ${allow ? 'granted' : 'denied'}: ${request.tool_name}`,
      }, ['main-ai'], { source: 'session-runner' })
    }
    return true
  }

  /**
   * Ask a "side question" (the native Claude Code `/btw`) inside THIS live coding
   * session, without polluting the main conversation.
   *
   * ── How it works (Claude Code stream-json control protocol, OUTBOUND) ──
   * Writes a `{type:'control_request', request_id, request:{subtype:'side_question',
   * question}}` envelope to the CLI's FIFO stdin via writeRaw (→ daemon sendRaw →
   * FIFO) — the SAME transport the permission control_response uses. The fork's
   * print mode handles it natively: it runs a forked agent that reuses THIS session's
   * own last-turn prompt-cache prefix (byte-identical → cache hit), denies all tools,
   * caps at 1 turn, and returns the answer ONLY in the matching `control_response`
   * (subtype:success, response.response.response = answer string). The answer is
   * never appended to the session transcript. Fire-and-forget on the CLI side: the
   * main turn is NOT interrupted. See fork src/cli/print.ts:3815 (side_question
   * dispatch) → src/utils/sideQuestion.ts (runSideQuestion). Full protocol catalog:
   * memory note claude_code_stream_json_control_protocol.md.
   *
   * Live-verified against shipped binary 2.1.170 in Walnut's exact multi-turn
   * stream-json mode (Bedrock, Opus 4.8): round-trips and recalls cross-turn context.
   */
  async askSideQuestion(question: string, timeoutMs = 60_000): Promise<string> {
    if (!this._transport) throw new Error('session not started')
    const requestId = `sq-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    const envelope = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'side_question', question },
    })
    log.session.info('side_question dispatching', {
      sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
      questionLen: question.length,
    })
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingSideQuestions.delete(requestId)
        reject(new Error('side question timed out'))
      }, timeoutMs)
      this._pendingSideQuestions.set(requestId, { resolve, reject, timer })
      Promise.resolve(this._transport!.writeRaw(envelope)).then((ok) => {
        if (!ok) {
          const pending = this._pendingSideQuestions.get(requestId)
          if (pending) {
            this._pendingSideQuestions.delete(requestId)
            clearTimeout(pending.timer)
            reject(new Error('failed to write side question to session'))
          }
        }
      }).catch((err) => {
        const pending = this._pendingSideQuestions.get(requestId)
        if (pending) {
          this._pendingSideQuestions.delete(requestId)
          clearTimeout(pending.timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  /**
   * Resolve a pending permission request from the UI.
   * Called by the API route when the user clicks allow/deny.
   */
  resolvePermissionRequest(requestId: string, allow: boolean, denyMessage?: string): boolean {
    const pending = this._pendingPermissionRequests.get(requestId)
    if (!pending) return false
    this._pendingPermissionRequests.delete(requestId)
    this._clearPermissionReEmitTimer(requestId)
    const written = this.respondToControlRequest(requestId, pending.request, allow, denyMessage)

    if (!written) {
      // Transport gone — re-add so recovery / re-attach can retry the response.
      // Don't emit resolved to UI; the permission stays visually pending.
      this._pendingPermissionRequests.set(requestId, pending)
      this._startPermissionReEmitTimer(requestId, pending.request)
      log.session.warn('resolvePermissionRequest: transport unavailable, re-queued for recovery', {
        sessionId: this.claudeSessionId, requestId,
      })
      return false
    }

    // Notify UI so stream buffer + frontend blocks update their status
    if (this.claudeSessionId) {
      bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
        sessionId: this.claudeSessionId,
        taskId: this.taskId,
        requestId,
        toolName: pending.request.tool_name,
        allowed: allow,
      }, ['*'], { source: 'session-runner' })
    }

    // Clear persisted pendingPermission from session record (best-effort)
    if (this.claudeSessionId) {
      import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
        updateSessionRecord(this.claudeSessionId!, { pendingPermission: undefined }),
      ).catch(() => {})
    }
    return true
  }

  /** True when Claude Code is blocked waiting for a permission decision. */
  get hasPendingPermission(): boolean {
    return this._pendingPermissionRequests.size > 0
  }

  /** Get all pending permission requests (for API/UI). */
  getPendingPermissionRequests(): Array<{
    requestId: string
    toolName?: string
    input?: Record<string, unknown>
    reason?: string
  }> {
    return [...this._pendingPermissionRequests.values()].map(p => ({
      requestId: p.request_id,
      toolName: p.request.tool_name,
      input: p.request.input,
      reason: p.request.decision_reason,
    }))
  }

  /**
   * Layer 4: Periodic re-emit of pending permission requests.
   * If the UI missed the initial prompt (WebSocket disconnect, page reload, etc.),
   * keep re-emitting every 60s so the user eventually sees it.
   * No auto-approve or auto-deny — human decision is required.
   */
  private _startPermissionReEmitTimer(requestId: string, request: { subtype: string; tool_name?: string; input?: Record<string, unknown>; decision_reason?: string }): void {
    this._clearPermissionReEmitTimer(requestId)
    const REEMIT_INTERVAL_MS = 60_000 // re-emit every 60s
    const timer = setInterval(() => {
      if (!this._pendingPermissionRequests.has(requestId)) {
        this._clearPermissionReEmitTimer(requestId)
        return
      }
      if (this.claudeSessionId) {
        log.session.info('re-emitting stale permission request (periodic)', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          requestId,
          toolName: request.tool_name,
        })
        bus.emit(EventNames.SESSION_PERMISSION_REQUEST, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          requestId,
          toolName: request.tool_name,
          input: request.input,
          reason: request.decision_reason,
        }, ['*'], { source: 'session-runner', urgency: 'urgent' })
      }
    }, REEMIT_INTERVAL_MS)
    timer.unref()
    this._permissionReEmitTimers.set(requestId, timer)
  }

  private _clearPermissionReEmitTimer(requestId: string): void {
    const timer = this._permissionReEmitTimers.get(requestId)
    if (timer) {
      clearInterval(timer)
      this._permissionReEmitTimers.delete(requestId)
    }
  }

  /** Clear ALL permission re-emit timers (called on session cleanup). */
  private _clearAllPermissionReEmitTimers(): void {
    for (const timer of this._permissionReEmitTimers.values()) clearInterval(timer)
    this._permissionReEmitTimers.clear()
  }

  private async persistSessionRecord(claudeSessionId: string, cwd?: string): Promise<void> {
    const { createSessionRecord } = await import('../core/session-tracker.js')
    await createSessionRecord(claudeSessionId, this.taskId, this.project, cwd, {
      pid: this.pid ?? undefined,
      outputFile: this._outputFile ?? undefined,
      title: this.pendingTitle,
      description: this.pendingDescription,
      mode: this._mode,
      planFile: this.planFile ?? undefined,
      planCompleted: this.planCompleted ? true : undefined,
      host: this._host ?? undefined,
      fromPlanSessionId: this.fromPlanSessionId,
      forkedFromSessionId: this.forkedFromSessionId,
      cliModel: this._cliModel,
    })
  }
}

// ── SessionRunner ──

export class SessionRunner {
  private sessions = new Map<string, ClaudeCodeSession>()
  private cliCommand: string
  private activeProcessing = new Set<string>()
  private batchCounts = new Map<string, number>()
  /** Safety timers that auto-clear stuck activeProcessing entries */
  private activeProcessingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** SDK session server client (set via setSdkClient when session_server.enabled) */
  private sdkClient: SessionServerClient | null = null
  /** Track SDK session IDs mapped to their task IDs for event routing */
  private sdkSessionMap = new Map<string, string>()

  constructor(cliCommand?: string) {
    this.cliCommand = cliCommand ?? 'claude'
  }

  /**
   * Override the CLI command used to spawn sessions.
   * Useful for E2E tests that wire in a mock CLI script.
   */
  setCliCommand(cmd: string): void {
    this.cliCommand = cmd
  }

  /** Direct WebSocket URL for daemon transport (test-only, bypasses SSH). */
  private _testDaemonUrl: string | undefined

  /**
   * Set a direct WebSocket URL for RemoteSessionManager, bypassing SSH.
   * Used by E2E tests with MockDaemon.
   */
  setTestDaemonUrl(url: string | undefined): void {
    this._testDaemonUrl = url
  }

  /**
   * Clear activeProcessing + batchCounts + safety timer for a session.
   * Centralizes cleanup to prevent dangling timers or stale entries.
   */
  private clearActiveProcessing(sessionId: string): void {
    this.activeProcessing.delete(sessionId)
    this.batchCounts.delete(sessionId)
    const timer = this.activeProcessingTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.activeProcessingTimers.delete(sessionId)
    }
  }

  /**
   * Add a session to activeProcessing with a safety timeout.
   * The timeout auto-clears the entry after 60s to prevent permanent stuck state
   * (e.g., if SESSION_RESULT arrives with a mismatched session ID).
   */
  private setActiveProcessing(sessionId: string, batchCount: number): void {
    this.activeProcessing.add(sessionId)
    this.batchCounts.set(sessionId, batchCount)

    // Cancel any existing safety timer for this sessionId
    const existingTimer = this.activeProcessingTimers.get(sessionId)
    if (existingTimer) clearTimeout(existingTimer)

    // Set safety timeout — prevents permanent stuck state
    const timer = setTimeout(() => {
      if (this.activeProcessing.has(sessionId)) {
        log.session.warn('activeProcessing safety timeout (60s): force-clearing stuck entry', { sessionId })
        this.activeProcessing.delete(sessionId)
        this.batchCounts.delete(sessionId)
        this.activeProcessingTimers.delete(sessionId)
        // Try to process next messages if any accumulated while stuck
        this.processNext(sessionId).catch(() => {})
      }
    }, 60_000)
    timer.unref()
    this.activeProcessingTimers.set(sessionId, timer)
  }

  /**
   * Set the SDK session server client for SDK-based sessions.
   * When set, new sessions will use the SDK path instead of CLI.
   */
  setSdkClient(client: SessionServerClient): void {
    this.sdkClient = client
  }

  /**
   * Subscribe to the event bus and handle session lifecycle events.
   * Optionally reconnect to sessions that survived a server restart.
   */
  init(reconnectable?: SessionRecord[]): void {
    // Reconnect to surviving sessions + startup recovery (async)
    const startupRecovery = async () => {
      // Phase 1: reconnect to surviving sessions
      if (reconnectable?.length) {
        for (const record of reconnectable) {
          try {
            const session = await ClaudeCodeSession.attachToExisting(record, this.cliCommand, this._testDaemonUrl)
            const mapKey = record.taskId || `reconnected-${record.claudeSessionId}`
            this.sessions.set(mapKey, session)
            log.session.info('reconnected to surviving session', {
              sessionId: record.claudeSessionId,
              taskId: record.taskId,
              pid: record.pid,
            })
          } catch (err) {
            log.session.warn('failed to reconnect to session', {
              sessionId: record.claudeSessionId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      // Phase 2: load queue from disk, re-process pending messages.
      // Race condition: the REST API starts accepting /send requests before SessionRunner
      // initialization completes. Messages received during this window get persisted to
      // the queue file, but the corresponding SESSION_SEND bus events fire before any
      // subscriber exists — so they're lost. Previously we skipped reconnected (alive)
      // sessions here, assuming their process would handle it. But that's wrong: the
      // queued message never reaches the FIFO because processNext() was never called.
      // Fix: process ALL pending queues including alive sessions. processNext() detects
      // alive sessions and uses the FIFO write path (not --resume spawn), so this is safe.
      await loadQueue()
      const pendingSessions = await getAllSessionsWithPending()
      for (const sessionId of pendingSessions) {
        log.session.info('recovering pending queue messages on startup', { sessionId })
        this.processNext(sessionId).catch((err) => {
          log.session.error('startup queue recovery failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
        })
      }
    }

    startupRecovery().catch((err) => {
      log.session.error('startup recovery failed', { error: err instanceof Error ? err.message : String(err) })
    })

    // Event-driven redelivery: when a host's daemon (re)connects, drain any
    // queue messages stranded in 'pending' by a delivery failure on that host.
    // This replaces spin-retrying after SESSION_ERROR (the 2026-06-10 infinite
    // loop) — messages wait quietly in the disk queue until the host is back,
    // the user hits Retry, or the user sends another message.
    import('./daemon-connection.js').then(({ setOnDaemonHostConnected }) => {
      setOnDaemonHostConnected((hostKey) => {
        this.redeliverPendingForHost(hostKey).catch((err) => {
          log.session.warn('reconnect redelivery failed', { hostKey, error: err instanceof Error ? err.message : String(err) })
        })
      })
    }).catch(() => {})

    bus.subscribe('session-runner', async (event) => {
      switch (event.name) {
        case EventNames.SESSION_START: {
          const startData = eventData<'session:start'>(event)
          log.session.info('session start requested', { taskId: startData.taskId, host: startData.host, cwd: startData.cwd, mode: startData.mode })
          if (this.sdkClient?.connected) {
            log.session.info('session routing', { taskId: startData.taskId, type: 'sdk' })
            await this.handleStartSdk(startData)
          } else {
            log.session.info('session routing', { taskId: startData.taskId, type: 'cli' })
            await this.handleStart(startData)
          }
        }
          break

        case EventNames.SESSION_SEND: {
          const sendData = eventData<'session:send'>(event)
          log.session.info('session send requested', { sessionId: sendData.sessionId, messageLength: sendData.message.length })
          // Route to SDK if this session is tracked as an SDK session
          if (this.sdkSessionMap.has(sendData.sessionId)) {
            await this.handleSendSdk(sendData.sessionId, sendData.message, sendData.mode as SessionMode | undefined, sendData.interrupt)
          } else {
            await this.handleSend(sendData)
          }
        }
          break

        case EventNames.SESSION_RESULT:
        case EventNames.SESSION_ERROR: {
          const { sessionId } = eventData<'session:result'>(event)
          if (!sessionId) break

          // delivery_failed = the batch never reached the CLI (SSH/daemon down).
          // It is NOT a turn outcome. The emitter (settleResumeFailure / processNext
          // catch) already reverted the batch to 'pending' and notified the UI via
          // SESSION_BATCH_FAILED. Running the turn-completion logic below would:
          //   - emit SESSION_BATCH_COMPLETED → frontend deletes the user's optimistic
          //     messages (the "my message got lost" bug), and
          //   - call processNext → re-deliver → fail → SESSION_ERROR → here again
          //     (the infinite 2-req/s retry loop).
          // Redelivery is event-driven instead: user Retry / next send / daemon reconnect.
          if (event.name === EventNames.SESSION_ERROR
            && (eventData<'session:error'>(event)).errorKind === 'delivery_failed') {
            log.session.info('SESSION_ERROR delivery_failed — skipping turn-completion handling', { sessionId })
            break
          }

          // Persist process_status to sessions.json.
          // Trust the in-memory processStatus that handleStreamEvent() already computed
          // (idle for FIFO-alive and remote --resume, stopped for dead processes).
          // Don't re-derive — that caused a bug where remote --resume sessions
          // (active=false but processStatus='idle') were incorrectly written as 'stopped'.
          {
            const isError = event.name === EventNames.SESSION_ERROR
              || (eventData<'session:result'>(event) as { isError?: boolean }).isError === true
            const errorMessage = isError
              ? ((eventData<'session:error'>(event) as { error?: string }).error ?? 'Unknown error').slice(0, 1000)
              : undefined
            const cliSession = this.findSessionByClaudeId(sessionId)
            const status = isError ? 'error' : (cliSession?.processStatus ?? 'stopped')

            import('../core/session-tracker.js').then(({ updateSessionRecord, getSessionByClaudeId }) => {
              updateSessionRecord(sessionId, {
                process_status: status,
                errorMessage: isError ? errorMessage : undefined,
                activity: undefined,
                last_status_change: new Date().toISOString(),
                status_reason: isError ? 'api_error' : (status === 'idle' ? 'turn_completed' : 'normal_completion'),
                status_changed_by: 'session-runner',
              }).then(() => {
                // Clear task session slot only when truly stopped/error
                if (status === 'stopped' || status === 'error') {
                  getSessionByClaudeId(sessionId).then(rec => {
                    if (rec?.taskId) {
                      import('../core/task-manager.js').then(({ clearSessionSlot }) => {
                        clearSessionSlot(rec.taskId!, sessionId).catch(() => {})
                      }).catch(() => {})
                    }
                  }).catch(() => {})
                }
              }).catch(() => {})
            }).catch(() => {})
          }

          // Clear activeProcessing — try direct match first, fall back to taskId match.
          // Session ID can change when --resume fails and Claude creates a new session.
          let resolvedSessionId = sessionId
          if (!this.activeProcessing.has(sessionId)) {
            const taskId = eventData<'session:result'>(event).taskId
            if (taskId) {
              for (const activeId of this.activeProcessing) {
                // The session object's sessionId was already updated to the new ID,
                // so we can't match via findSessionByClaudeId(activeId).
                // Instead, check if any session in our Map has this taskId and its
                // old sessionId is the one stuck in activeProcessing.
                for (const [mapKey, session] of this.sessions) {
                  if ((mapKey === taskId || session.taskId === taskId) && activeId !== sessionId) {
                    resolvedSessionId = activeId
                    log.session.warn('SESSION_RESULT: sessionId mismatch — matched via taskId', {
                      expectedSessionId: activeId,
                      actualSessionId: sessionId,
                      taskId,
                    })
                    break
                  }
                }
                if (resolvedSessionId !== sessionId) break
              }
            }
          }

          // sessionId mismatch fixup: if the SESSION_RESULT carried a new sessionId
          // (e.g. Claude Code --resume failed → new claudeSessionId), the frontend
          // is still subscribed to the OLD sessionId and would filter out this event
          // (sid !== sessionId). Emit a supplementary copy under resolvedSessionId
          // directly to the web-ui subscriber so the frontend's useSessionStream
          // clears isStreaming. Destination ['web-ui'] avoids re-entering this
          // handler (session-runner won't receive it → no infinite loop) and bypasses
          // the main-ai re-emit enrichment path (the frontend's result handler only
          // needs sessionId).
          if (resolvedSessionId !== sessionId) {
            const rawData = eventData<'session:result'>(event)
            // `reemit: true` marks this as a re-emit so global subscribers (event-bus.ts:228)
            // skip it — they already processed the original under `sessionId`. Only the web-ui
            // subscriber (destination-targeted) should forward this to the browser.
            bus.emit(
              EventNames.SESSION_RESULT,
              { ...rawData, sessionId: resolvedSessionId },
              ['web-ui'],
              { source: 'sid-mismatch-fixup', reemit: true },
            )
            log.session.info('SESSION_RESULT: emitted fixup under resolvedSessionId', {
              resolvedSessionId, rawSessionId: sessionId,
            })
          }

          const batchCount = this.batchCounts.get(resolvedSessionId) ?? 1
          this.clearActiveProcessing(resolvedSessionId)

          // NO un-scoped removeProcessed here. Every delivery point already removes
          // its own batch eagerly (FIFO write / mid-turn inject / settleResumeSuccess),
          // so by turn-end there is nothing legitimately left in 'processing'. The only
          // thing an un-scoped sweep could hit is a CONCURRENT in-flight batch (e.g. a
          // --resume spawn settling seconds later) — deleting it silently lost the
          // user's message. Worst case of not sweeping: a stuck 'processing' message
          // survives until restart and gets redelivered (duplicate > loss).

          // Tell frontend how many optimistic messages to clear
          bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
            sessionId,
            count: batchCount,
          }, ['main-ai'], { source: 'session-runner' })

          // Process next batch if any new messages arrived during processing
          this.processNext(sessionId).catch((err) => {
            log.session.error('processNext failed after result/error', { sessionId, error: err instanceof Error ? err.message : String(err) })
          })
          break
        }
      }
    })
  }

  /**
   * Detach from all sessions (they survive) and unsubscribe.
   * Use this for graceful server shutdown — sessions continue running.
   */
  destroy(): void {
    for (const [, session] of this.sessions) {
      session.detach()
    }
    this.sessions.clear()
    this.activeProcessing.clear()
    this.batchCounts.clear()
    for (const timer of this.activeProcessingTimers.values()) clearTimeout(timer)
    this.activeProcessingTimers.clear()
    this.sdkSessionMap.clear()
    if (this.sdkClient) {
      this.sdkClient.destroy()
      this.sdkClient = null
    }
    // Disconnect all daemon connections (SSH tunnels) on server shutdown
    import('./daemon-connection.js').then(({ disconnectAllDaemons }) => {
      disconnectAllDaemons()
    }).catch(() => {})
    bus.unsubscribe('session-runner')
  }

  /**
   * Kill all sessions and unsubscribe.
   * Use this for explicit "stop everything" (e.g., tests, user request).
   */
  destroyAndKill(): void {
    for (const [, session] of this.sessions) {
      session.kill()
    }
    // Stop SDK sessions via session server
    if (this.sdkClient?.connected) {
      for (const [sessionId] of this.sdkSessionMap) {
        this.sdkClient.stopSession({ sessionId }).catch(() => {})
      }
    }
    this.sessions.clear()
    this.activeProcessing.clear()
    this.batchCounts.clear()
    for (const timer of this.activeProcessingTimers.values()) clearTimeout(timer)
    this.activeProcessingTimers.clear()
    this.sdkSessionMap.clear()
    if (this.sdkClient) {
      this.sdkClient.destroy()
      this.sdkClient = null
    }
    bus.unsubscribe('session-runner')
  }

  /**
   * Get a session by task ID.
   */
  getByTaskId(taskId: string): ClaudeCodeSession | undefined {
    return this.sessions.get(taskId)
  }

  /**
   * Find a live session by its Claude session ID (iterates all sessions).
   */
  findByClaudeId(claudeSessionId: string): ClaudeCodeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.sessionId === claudeSessionId) return session
    }
    return undefined
  }

  /**
   * Resolve a live session, attaching to its still-running CLI process ON DEMAND
   * if it isn't in the in-memory `this.sessions` map.
   *
   * Why this exists: `findByClaudeId` only iterates the in-memory map, which on a
   * fresh process holds just the sessions the startup reconciler flagged as
   * reconnectable. Many genuinely-alive sessions are NOT in that map, so a feature
   * keyed off `findByClaudeId` (e.g. the `/btw` side-question control_request) would
   * wrongly report "Live session not found" for a session the user can chat with
   * normally. Normal send doesn't hit this because `processNext` rehydrates via
   * `attachToExisting` (see ~line 4873). This helper extracts that same rehydration
   * so control-protocol callers (side_question, set_model, get_context_usage, …)
   * get the SAME attach-on-demand semantics as a normal turn.
   */
  async getOrAttachLiveSession(claudeSessionId: string): Promise<ClaudeCodeSession | undefined> {
    const inMap = this.findByClaudeId(claudeSessionId)
    if (inMap) return inMap

    try {
      const { getSessionByClaudeId } = await import('../core/session-tracker.js')
      const record = await getSessionByClaudeId(claudeSessionId)
      if (!record || !(await this.isSessionStillAlive(record))) return undefined

      log.session.info('getOrAttachLiveSession: rehydrating via attachToExisting', {
        sessionId: claudeSessionId, host: record.host, pid: record.pid, taskId: record.taskId,
      })
      const attached = await ClaudeCodeSession.attachToExisting(record, this.cliCommand, this._testDaemonUrl)

      // Race guard mirrors processNext: a concurrent path may have populated the
      // map while attachToExisting awaited — if so, discard ours so we don't
      // overwrite the live transport's registry entry / orphan its tailer.
      const collided = this.findByClaudeId(claudeSessionId)
      if (collided) {
        attached.detach()
        return collided
      }
      const mapKey = record.taskId || `reconnected-${claudeSessionId}`
      this.sessions.set(mapKey, attached)
      return attached
    } catch (err) {
      log.session.warn('getOrAttachLiveSession: attach attempt failed', {
        sessionId: claudeSessionId, error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    }
  }

  /**
   * Kill orphaned claude processes from stopped/terminal sessions.
   * Scans sessions.json for sessions with PIDs where process_status is 'stopped'
   * or in terminal state, but the OS process is still alive.
   * This prevents accumulation of zombie claude processes over time.
   */
  private async killOrphanedSessionProcesses(): Promise<void> {
    try {
      const { listSessions, isTerminalSession } = await import('../core/session-tracker.js')
      const sessions = await listSessions()

      let killed = 0
      for (const s of sessions) {
        if (s.pid == null) continue
        if (s.provider === 'embedded' || s.provider === 'sdk') continue

        // Kill processes for sessions that are stopped/error or in terminal state
        const shouldBeDeadByStatus = s.process_status === 'stopped' || s.process_status === 'error'
        if (!shouldBeDeadByStatus && !isTerminalSession(s)) continue

        const processName = s.host ? 'ssh' : 'claude'
        if (!await isProcessAliveAsync(s.pid, processName)) continue

        // GROUND-TRUTH RECHECK before a destructive kill — veto on POSITIVE proof of life.
        // This sweeper fires on every session start and trusts process_status==='stopped'
        // (plus a live, binary-verified pid) as the kill signal — with NO grace period.
        // That is exactly how the false-zombie incident killed a healthy CLI: the
        // server-restart reconciler mis-marked a live local session 'stopped', and on the
        // next session start this loop SIGTERM'd the real (still-streaming) process.
        // The DB status flag is not authoritative; the JSONL mtime is (it's the same signal
        // the daemon's reapSession uses). Only a fresh JSONL (process wrote output within the
        // window) is positive proof the CLI is alive and working → veto the kill.
        //
        // We veto ONLY on `=== true`, NOT on 'unknown'. 'unknown' means "remote session" or
        // "local file already cleaned/archived" — neither is evidence of life, and treating
        // them as a veto would (a) leak remote orphans forever and (b) leak local PID-recycled
        // orphans. The existing isProcessAliveAsync(pid,'claude') binary check above already
        // guards PID reuse (a recycled non-claude pid returns false), so letting 'unknown'
        // fall through to the kill restores exactly the prior, correct cleanup behavior while
        // still blocking the one case that caused the incident.
        const ORPHAN_FRESH_WINDOW_MS = 2 * 60 * 1000
        if (isLocalJsonlFresh(s, ORPHAN_FRESH_WINDOW_MS) === true) {
          log.session.warn('skipping orphan kill — JSONL recently written (process alive despite stopped flag)', {
            sessionId: s.claudeSessionId, pid: s.pid, process_status: s.process_status,
          })
          continue
        }

        // Process is alive but session is done — kill it
        log.session.warn('killing orphaned session process', {
          sessionId: s.claudeSessionId,
          taskId: s.taskId,
          pid: s.pid,
          process_status: s.process_status,
        })

        try { process.kill(s.pid, 'SIGTERM') } catch { /* already dead */ }
        killed++
      }

      if (killed > 0) {
        log.session.info('killed orphaned session processes', { count: killed })
      }
    } catch (err) {
      log.session.warn('killOrphanedSessionProcesses failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * Find an in-memory CLI session by its Claude session ID.
   */
  private findSessionByClaudeId(claudeSessionId: string): ClaudeCodeSession | undefined {
    for (const [, session] of this.sessions) {
      if (session.sessionId === claudeSessionId) return session
    }
    return undefined
  }

  /** Public lookup for health monitor — returns hung-detection timestamps for a session. */
  getSessionTimestamps(claudeSessionId: string): { lastClaudeOutputAt: number; lastMessageDeliveryAt: number } | undefined {
    const session = this.findSessionByClaudeId(claudeSessionId)
    if (!session) return undefined
    return { lastClaudeOutputAt: session.lastClaudeOutputAt, lastMessageDeliveryAt: session.lastMessageDeliveryAt }
  }

  /** Check if a session is in team mode (teammates still active). Used by health monitor. */
  isTeamActive(claudeSessionId: string): boolean {
    const session = this.findSessionByClaudeId(claudeSessionId)
    return session?.teamActive ?? false
  }

  /** Check if a session has background workflow/subagent tasks still running.
   *  Used by health monitor to skip the idle-timeout kill — a dynamic workflow can run
   *  for many minutes with no main-turn output, but the session is NOT idle. */
  isBackgroundWorkActive(claudeSessionId: string): boolean {
    const session = this.findSessionByClaudeId(claudeSessionId)
    return session?.hasActiveBackgroundWork() ?? false
  }

  /** Check if a session has a pending permission request. Used by health monitor to skip idle timeout. */
  hasPendingPermission(claudeSessionId: string): boolean {
    const session = this.findSessionByClaudeId(claudeSessionId)
    return session?.hasPendingPermission ?? false
  }

  /**
   * Public entry point for starting a session.
   * Returns the Claude session ID once the process emits its init event.
   * The tool can await this to include the session ID in its response.
   *
   * Routes to SDK session server when sdkClient is set, otherwise falls back to CLI.
   */
  async startSession(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
    forkedFromSessionId?: string
  }): Promise<{ claudeSessionId: string; title: string }> {
    // Route to SDK session server when available and connected
    if (this.sdkClient?.connected) {
      return this.handleStartSdk(data)
    }

    const startTs = Date.now()
    const { sessionReady, title } = await this.handleStart(data)
    const handleStartMs = Date.now() - startTs
    if (handleStartMs > 2000) {
      log.session.warn('handleStart took unexpectedly long', {
        taskId: data.taskId,
        host: data.host,
        handleStartMs,
      })
    }

    // Session init timeout. Local new sessions take 1-2s from the console.
    // Remote adds SSH/wssh/shell overhead (~5-10s). 90s for remote gives margin
    // while timing logs (first JSONL line, timeToInitMs) collect data to find
    // the real bottleneck — remote new sessions shouldn't take >10s but sometimes
    // exceed 30s for unknown reasons (wssh relay? devdesk load?).
    const isRemote = !!data.host
    const initTimeoutMs = isRemote ? 90_000 : 30_000

    let timer: ReturnType<typeof setTimeout>
    const claudeSessionId = await Promise.race([
      sessionReady,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          log.session.error(`session init timeout — ${initTimeoutMs / 1000}s exceeded`, {
            taskId: data.taskId,
            host: data.host,
            isRemote,
            totalElapsedMs: Date.now() - startTs,
            handleStartMs,
          })
          reject(new Error(`session init timed out after ${initTimeoutMs / 1000}s`))
        }, initTimeoutMs)
      }),
    ]).finally(() => clearTimeout(timer!))

    log.session.info('session ready', {
      claudeSessionId,
      host: data.host,
      totalStartMs: Date.now() - startTs,
      handleStartMs,
    })
    return { claudeSessionId, title }
  }

  private async handleStart(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
    forkedFromSessionId?: string
    largePromptFile?: { localPath: string; originalLength: number }
    requestTs?: number
  }): Promise<{ sessionReady: Promise<string>; title: string }> {
    const { taskId, project, mode, model } = data
    let cwd = data.cwd
    let { message } = data
    // Latency instrumentation: time from HTTP request received → handleStart entry
    // (covers task create/update, event bus dispatch). See § time-to-init breakdown.
    const routeToHandleStartMs = data.requestTs ? Date.now() - data.requestTs : undefined
    log.session.info('starting session', {
      taskId: taskId || '(taskless)', project, host: data.host,
      routeToHandleStartMs,
    })
    if (data.largePromptFile) {
      log.session.info('session start with spilled prompt', {
        taskId, host: data.host,
        spillFile: data.largePromptFile.localPath,
        originalLength: data.largePromptFile.originalLength,
      })
    }

    // Resolve cwd if not provided — defense-in-depth for RPC/bus paths that
    // bypass the agent tool's resolveSessionContext().
    if (!cwd && taskId) {
      try {
        const { getTask, getProjectMetadata } = await import('../core/task-manager.js')
        const task = await getTask(taskId)
        if (task) {
          // Walk parent chain for task.cwd
          let current: typeof task | undefined = task
          const seen = new Set<string>()
          while (current && !cwd) {
            if (current.cwd) { cwd = current.cwd; break }
            if (!current.parent_task_id || seen.has(current.parent_task_id)) break
            seen.add(current.id)
            current = await getTask(current.parent_task_id).catch(() => undefined)
          }
          // Project metadata default_cwd
          if (!cwd) {
            const metadata = await getProjectMetadata(task.category, task.project)
            if (metadata?.default_cwd) cwd = metadata.default_cwd as string
          }
          // Last resort: project memory directory (LOCAL sessions only).
          // For remote sessions, a local path won't exist on the remote host —
          // fail with a clear error instead of sending a bogus cwd.
          if (!cwd) {
            if (data.host) {
              throw new Error(
                `No working directory found for remote session on host "${data.host}" ` +
                `(task: "${task.id}", category: "${task.category}", project: "${task.project}"). ` +
                `Set a cwd on the task, or set default_cwd in project "${task.project}" metadata ` +
                `(e.g. /workplace/... on the remote host).`
              )
            }
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js')
            const path = await import('node:path')
            const nodeFs = await import('node:fs')
            const projectDir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase())
            nodeFs.mkdirSync(projectDir, { recursive: true })
            cwd = projectDir
          }
        }
      } catch (err) {
        log.session.warn('handleStart: cwd resolution failed', { taskId, error: err instanceof Error ? err.message : String(err) })
        // For remote sessions, cwd is critical — rethrow so the caller sees the error
        if (data.host && !cwd) throw err
      }
    }

    // Prune completed taskless sessions to prevent unbounded Map growth
    for (const [key, s] of this.sessions) {
      if (key.startsWith('taskless-') && !s.active) {
        this.sessions.delete(key)
      }
    }

    // Kill orphaned processes from stopped/terminal sessions to prevent accumulation.
    // Over time, claude processes can leak (e.g. idle timeout GC'd, server restart
    // orphaned the in-process timer). This ensures we don't exhaust OS resources.
    await this.killOrphanedSessionProcesses()

    const mapKey = taskId || `taskless-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (taskId) {
      const existing = this.sessions.get(taskId)
      if (existing?.active) {
        log.session.warn('overwriting active session Map entry — old process stays alive', {
          taskId, existingPid: existing.processPid,
        })
      }
    }
    const session = new ClaudeCodeSession(taskId, project ?? '', this.cliCommand)
    session._testDaemonUrl = this._testDaemonUrl
    if (data.fromPlanSessionId) session.fromPlanSessionId = data.fromPlanSessionId
    if (data.forkedFromSessionId) session.forkedFromSessionId = data.forkedFromSessionId
    this.sessions.set(mapKey, session)

    // Auto-generate title + description
    let taskTitle: string | undefined
    let taskCategory: string | undefined
    if (taskId) {
      try {
        const { updateTask, getTask } = await import('../core/task-manager.js')
        await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
        const task = await getTask(taskId)
        taskTitle = task?.title
        taskCategory = task?.category
      } catch (err) {
        log.session.warn('failed to update task phase on session start', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Use agent-provided title if available, otherwise auto-generate
    if (data.title) {
      session.pendingTitle = data.title
    } else {
      const defaultPromptPrefix = 'Working on task:'
      const isCustomPrompt = !message.startsWith(defaultPromptPrefix)

      if (taskTitle && isCustomPrompt) {
        session.pendingTitle = `${taskTitle} — ${message.slice(0, 80)}`
      } else if (taskTitle) {
        session.pendingTitle = taskTitle
      } else {
        session.pendingTitle = message.slice(0, 120)
      }
    }
    session.pendingDescription = message.slice(0, 500)

    let appendSystemPrompt: string | undefined
    const isFork = !!data.forkedFromSessionId

    // If caller provided an appendSystemPrompt (e.g. custom context), use it.
    // Skip for forks — Claude Code's --fork-session handles conversation context natively.
    // Note: plan content is no longer injected here — it's passed as a file path in the message.
    if (data.appendSystemPrompt && !isFork) {
      appendSystemPrompt = data.appendSystemPrompt
      log.session.info('using caller-provided system prompt', { taskId, promptLength: data.appendSystemPrompt.length })
    }

    // Build session context from task info (task details, project memory, etc.)
    if (taskId) {
      try {
        const { buildSessionContext } = await import('../agent/session-context.js')
        const ctx = await buildSessionContext(taskId, cwd, data.host)
        if (ctx.systemPrompt) {
          // Combine: caller-provided prompt takes priority, task context appended after
          appendSystemPrompt = appendSystemPrompt
            ? `${appendSystemPrompt}\n\n---\n\n## Task Context\n\n${ctx.systemPrompt}`
            : ctx.systemPrompt
          log.session.info('session context built', { taskId, promptLength: ctx.systemPrompt.length })
        }
      } catch (err) {
        log.session.warn('failed to build session context', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Resolve SSH host config and session_model default from config
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()

    // Resolve model: explicit caller value > config default > hardcoded 'opus' fallback in send()
    const resolvedModel = model ?? config.agent?.session_model

    // Resolve SSH host config if specified
    let sshTarget: SshTarget | undefined
    if (data.host) {
      const hostDef = config.hosts?.[data.host]
      if (!hostDef) {
        throw new Error(`Unknown host "${data.host}" — configure it in config.yaml under hosts.${data.host}`)
      }
      // Support both 'hostname' and legacy 'ssh' field names
      const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
      if (!hostname) {
        throw new Error(`Host "${data.host}" is missing 'hostname' field in config.yaml`)
      }
      sshTarget = {
        hostname,
        user: hostDef.user,
        port: hostDef.port,
        shell_setup: hostDef.shell_setup,
      }
    }

    // Local images are uploaded to the remote host by RemoteSessionManager.prepareOutbound()
    // called inside start() and writeMessage(). No manual SCP transfer needed.

    const sessionTitle = session.pendingTitle ?? message.slice(0, 120)
    // For forks: pass source session ID as resumeSessionId with forkSession=true.
    // Claude Code's --resume + --fork-session creates a new session with full context.
    const resumeId = isFork ? data.forkedFromSessionId : undefined
    const spillFile = data.largePromptFile ? { localPath: data.largePromptFile.localPath } : undefined
    // Carry the HTTP request ts onto the session instance so the init handler can
    // compute the full route→init latency breakdown (instrumentation only).
    session._requestTs = data.requestTs ?? 0
    session.send(message, cwd, resumeId, mode, resolvedModel, appendSystemPrompt, data.host, sshTarget, isFork, config.session?.permission_prompt, spillFile, config.session?.stream_partial_messages)

    // Record directory usage for the frequent-dirs persistent store (fire-and-forget)
    if (cwd) {
      import('../core/frequent-dirs.js').then(({ recordDirectory }) => {
        recordDirectory(cwd, data.host ?? null, taskCategory).catch(() => {})
      }).catch(() => {})
    }

    bus.emit(EventNames.SESSION_STARTED, {
      taskId,
      project: project ?? '',
      host: data.host,
    }, ['main-ai'], { source: 'session-runner' })

    // Link session to task once the Claude session ID is known.
    // Runs after SESSION_STARTED so the UI updates immediately.
    if (taskId) {
      session.sessionReady.then(async (claudeSessionId) => {
        try {
          // Archived guard: do NOT write task session slots for archived sessions.
          // handleStart is also the resume entry point; if the user sends a message to
          // an archived session (archive is a soft flag), the session spawns and reaches
          // sessionReady — without this guard we'd re-link the archived sessionId into
          // task.session_id / plan_session_id / exec_session_id, poisoning the task slots
          // so every UI entry point opens the archived session instead of the live one.
          // Safe to query the record here: persistSessionRecord is awaited inside the
          // handleStreamLine init handler (~line 1720) BEFORE sessionReady is resolved,
          // so by the time this .then() runs the record is guaranteed to exist.
          const { getSessionByClaudeId } = await import('../core/session-tracker.js')
          const { addSessionToHistory, linkSessionSlot, linkSession } = await import('../core/task-manager.js')
          const record = await getSessionByClaudeId(claudeSessionId)
          if (record?.archived) {
            await addSessionToHistory(taskId, claudeSessionId).catch((err) => {
              log.session.debug('failed to add archived session to history', {
                taskId, sessionId: claudeSessionId,
                error: err instanceof Error ? err.message : String(err),
              })
            })
            log.session.warn('skipping task slot link for archived session', {
              taskId, sessionId: claudeSessionId, archiveReason: record.archive_reason,
            })
            return
          }

          const slot: 'plan' | 'exec' = mode === 'plan' ? 'plan' : 'exec'
          await linkSessionSlot(taskId, claudeSessionId, slot)
          // Use the task from linkSession (has session_id set) so the browser's
          // React state always receives session_id correctly populated.
          const { task } = await linkSession(taskId, claudeSessionId)
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
        } catch (err) {
          log.session.warn('failed to link session to task', { taskId, error: err instanceof Error ? err.message : String(err) })
        }
      }).catch((err) => {
        // Session failed to initialize (SSH failure, timeout, etc.)
        // Notify web-ui so the pending session panel can show an error.
        const errorMsg = err instanceof Error ? err.message : String(err)
        log.session.warn('session init failed — notifying web-ui', { taskId, error: errorMsg, host: data.host })
        bus.emit(EventNames.SESSION_ERROR, {
          sessionId: null,
          taskId,
          error: errorMsg,
        }, ['web-ui'], { source: 'session-init-failure' })
      })
    }

    return { sessionReady: session.sessionReady, title: sessionTitle }
  }

  /**
   * Start a session via the SDK session server.
   * Creates a session record in session-tracker and delegates to the session server client.
   */
  private async handleStartSdk(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
  }): Promise<{ claudeSessionId: string; title: string }> {
    if (!this.sdkClient) throw new Error('SDK client not configured')

    const { taskId, message, project, mode } = data
    let cwd = data.cwd
    log.session.info('starting SDK session', { taskId: taskId || '(taskless)', project, host: data.host })

    // Resolve cwd if not provided (same chain as handleStart)
    if (!cwd && taskId) {
      try {
        const { getTask: getTaskFn, getProjectMetadata } = await import('../core/task-manager.js')
        const task = await getTaskFn(taskId)
        if (task) {
          let current: typeof task | undefined = task
          const seen = new Set<string>()
          while (current && !cwd) {
            if (current.cwd) { cwd = current.cwd; break }
            if (!current.parent_task_id || seen.has(current.parent_task_id)) break
            seen.add(current.id)
            current = await getTaskFn(current.parent_task_id).catch(() => undefined)
          }
          if (!cwd) {
            const metadata = await getProjectMetadata(task.category, task.project)
            if (metadata?.default_cwd) cwd = metadata.default_cwd as string
          }
          if (!cwd) {
            if (data.host) {
              throw new Error(
                `No working directory found for remote session on host "${data.host}" ` +
                `(task: "${task.id}", category: "${task.category}", project: "${task.project}"). ` +
                `Set a cwd on the task, or set default_cwd in project "${task.project}" metadata.`
              )
            }
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js')
            const path = await import('node:path')
            const nodeFs = await import('node:fs')
            const projectDir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase())
            nodeFs.mkdirSync(projectDir, { recursive: true })
            cwd = projectDir
          }
        }
      } catch (err) {
        log.session.warn('handleStartSdk: cwd resolution failed', { taskId, error: err instanceof Error ? err.message : String(err) })
        if (data.host && !cwd) throw err
      }
    }

    // Auto-generate title (same logic as CLI path)
    let taskTitle: string | undefined
    let sdkTaskCategory: string | undefined
    if (taskId) {
      try {
        const { updateTask, getTask } = await import('../core/task-manager.js')
        await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
        const task = await getTask(taskId)
        taskTitle = task?.title
        sdkTaskCategory = task?.category
      } catch (err) {
        log.session.warn('failed to update task phase on SDK session start', {
          taskId, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    let sessionTitle: string
    if (data.title) {
      sessionTitle = data.title
    } else {
      const defaultPromptPrefix = 'Working on task:'
      const isCustomPrompt = !message.startsWith(defaultPromptPrefix)
      if (taskTitle && isCustomPrompt) {
        sessionTitle = `${taskTitle} — ${message.slice(0, 80)}`
      } else if (taskTitle) {
        sessionTitle = taskTitle
      } else {
        sessionTitle = message.slice(0, 120)
      }
    }

    // Build system prompt
    let systemPrompt: string | undefined
    if (data.appendSystemPrompt) {
      systemPrompt = data.appendSystemPrompt
    }
    if (taskId) {
      try {
        const { buildSessionContext } = await import('../agent/session-context.js')
        const ctx = await buildSessionContext(taskId, cwd, data.host)
        if (ctx.systemPrompt) {
          systemPrompt = systemPrompt
            ? `${systemPrompt}\n\n---\n\n## Task Context\n\n${ctx.systemPrompt}`
            : ctx.systemPrompt
        }
      } catch (err) {
        log.session.warn('failed to build SDK session context', {
          taskId, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Map session server mode to SDK permission mode.
    // Default (no mode): 'bypass' — matches CLI spawn semantics.
    const sdkMode = mode === 'plan' ? 'plan'
      : mode === 'accept' ? 'accept'
        : 'bypass'

    // Start via session server client
    const result = await this.sdkClient.startSession({
      message,
      cwd,
      mode: sdkMode,
      systemPrompt,
    })

    const claudeSessionId = result.sessionId

    // Track the SDK session
    this.sdkSessionMap.set(claudeSessionId, taskId)

    // Create session record
    const { createSessionRecord } = await import('../core/session-tracker.js')
    await createSessionRecord(claudeSessionId, taskId, project ?? '', cwd, {
      mode: (mode as SessionMode) ?? 'bypass',
      title: sessionTitle,
      description: message.slice(0, 500),
      host: data.host,
      provider: 'sdk',
      fromPlanSessionId: data.fromPlanSessionId,
    })

    // Link to task
    if (taskId) {
      try {
        const { linkSessionSlot, linkSession } = await import('../core/task-manager.js')
        const slot: 'plan' | 'exec' = mode === 'plan' ? 'plan' : 'exec'
        await linkSessionSlot(taskId, claudeSessionId, slot)
        // Use the task from linkSession (has session_id set) so the browser's
        // React state always receives session_id correctly populated.
        const { task } = await linkSession(taskId, claudeSessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
      } catch (err) {
        log.session.warn('failed to link SDK session to task', {
          taskId, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Record directory usage for frequent-dirs store (fire-and-forget)
    if (cwd) {
      import('../core/frequent-dirs.js').then(({ recordDirectory }) => {
        recordDirectory(cwd, data.host ?? null, sdkTaskCategory).catch(() => {})
      }).catch(() => {})
    }

    bus.emit(EventNames.SESSION_STARTED, {
      taskId,
      project: project ?? '',
      host: data.host,
      provider: 'sdk',
    }, ['main-ai'], { source: 'session-runner' })

    return { claudeSessionId, title: sessionTitle }
  }

  /**
   * Check whether a session's underlying process is still live.
   * Used by processNext to decide between rehydrating an existing process vs
   * spawning a fresh `claude --resume` (which would kill the running turn).
   *
   * Intentionally NOT reusing `isSessionProcessAlive` in `src/utils/session-liveness.ts`:
   *   - That util routes remote sessions through `isDaemonConnected(host)`, which only
   *     tells us the SSH tunnel is up — not whether this specific sessionId is still
   *     tracked by the daemon. It also applies a 5-min grace period desirable for the
   *     health-monitor hot path but wrong here: we need authoritative "process alive"
   *     at send time so we don't silently fall through to `--resume` and kill a turn.
   *   - It also consults the SessionManager registry first; this helper is called
   *     precisely when `this.sessions` is empty (no registered manager available).
   *
   * Strict `probe?.alive === true` guards against contract drift where `alive` might
   * become truthy-non-boolean; daemon today returns `{ok:true,alive:true}` on live and
   * `{ok:false}` otherwise (see `src/providers/daemon-connection.ts:probeDaemonSession`).
   */
  private async isSessionStillAlive(record: SessionRecord): Promise<boolean> {
    if (record.host) {
      try {
        const { probeDaemonSession } = await import('./daemon-connection.js')
        const probe = await probeDaemonSession(record.host, record.claudeSessionId)
        return probe?.alive === true
      } catch (err) {
        log.session.debug('isSessionStillAlive: remote probe threw', {
          host: record.host, sessionId: record.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    }
    if (record.pid == null) return false
    try {
      process.kill(record.pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Send a follow-up message to an SDK session.
   */
  private async handleSendSdk(sessionId: string, message: string, mode?: SessionMode, interrupt?: boolean): Promise<void> {
    if (!this.sdkClient) throw new Error('SDK client not configured')

    // Unconditional phase transition: session input → IN_PROGRESS
    try {
      const { getSessionByClaudeId } = await import('../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (record?.taskId) {
        // Cancel stale triage runs for this task — user has resumed, triage analysis is outdated
        try {
          const { subagentRunner } = await import('./subagent-runner.js')
          const cancelled = subagentRunner.cancelRunsForTask(record.taskId, 'turn-complete-triage')
          if (cancelled > 0) log.session.info('handleSendSdk: cancelled stale triage', { taskId: record.taskId, cancelled })
        } catch { /* non-fatal */ }

        const { applySessionPhase } = await import('../core/phase.js')
        await applySessionPhase(record.taskId, 'session:input', 'session.ts:handleSendSdk', { sessionId })
        // Touch last_session_update on resume for "Recent" sidebar sort
        const { touchLastSessionUpdate } = await import('../core/task-manager.js')
        touchLastSessionUpdate(record.taskId).catch(err =>
          log.session.warn('touchLastSessionUpdate failed', { taskId: record.taskId, error: String(err) }))
      }
    } catch (err) {
      log.session.warn('handleSendSdk: phase update failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    }

    if (interrupt) {
      await this.sdkClient.interrupt({ sessionId })
    }

    if (mode) {
      await this.sdkClient.setMode({ sessionId, mode })
    }

    await this.sdkClient.sendMessage({ sessionId, message })

    // Update session record — always reset on send (user is actively resuming)
    try {
      const { updateSessionRecord } = await import('../core/session-tracker.js')
      await updateSessionRecord(sessionId, {
        activity: 'Processing follow-up...',
        lastActiveAt: new Date().toISOString(),
      })
    } catch (err) {
      log.session.warn('handleSendSdk: status reset failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async handleSend(data: {
    sessionId: string
    message: string
    mode?: string
    model?: string
    interrupt?: boolean
  }): Promise<void> {
    const { sessionId, mode, model, interrupt } = data

    if (interrupt) {
      // Interrupt: gracefully stop the running session (SIGINT + wait for exit),
      // then process next (which spawns --resume with saved session state)
      for (const [, session] of this.sessions) {
        if (session.sessionId === sessionId) {
          await session.interrupt()
          break
        }
      }

      // Clean up batch tracking for the interrupted turn.
      // No removeProcessed sweep: delivered batches were already removed eagerly
      // at their delivery point; anything still 'processing' is an in-flight
      // batch that must survive (sweeping it = silent message loss).
      if (this.activeProcessing.has(sessionId)) {
        const oldBatchCount = this.batchCounts.get(sessionId) ?? 1
        this.clearActiveProcessing(sessionId)

        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId,
          count: oldBatchCount,
        }, ['main-ai'], { source: 'session-runner' })
      }
    }

    // pendingModel/pendingMode is saved at the RPC layer (session-chat.ts) BEFORE
    // enqueueMessage, preventing a race with concurrent processNext() calls.

    // If model switch requested on an active session, interrupt to force --resume with new model
    if (model && this.activeProcessing.has(sessionId) && !interrupt) {
      log.session.info('handleSend: forcing interrupt for model switch', { sessionId, model })
      for (const [, session] of this.sessions) {
        if (session.sessionId === sessionId) {
          await session.interrupt()
          break
        }
      }
      // Clean up batch tracking for the interrupted turn (no removeProcessed
      // sweep — same in-flight-batch protection as the interrupt path above).
      if (this.activeProcessing.has(sessionId)) {
        const oldBatchCount = this.batchCounts.get(sessionId) ?? 1
        this.clearActiveProcessing(sessionId)
        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId,
          count: oldBatchCount,
        }, ['main-ai'], { source: 'session-runner' })
      }
    }

    // Message delivery is top priority — trigger it NOW, before any task/phase
    // bookkeeping. Those writes go through the global task write-lock, which
    // serializes behind every other session's task updates; awaiting them here
    // would delay delivery by seconds when other sessions are busy.
    // Message is already enqueued by session:send RPC (or session_send agent tool).
    // Visibility: record WHY we pick a path — activeProcessing decides processNext
    // (drain queue, can spawn/resume) vs injectMidTurn (live FIFO write). The
    // target session's hasPipe/pid/active are the inputs injectMidTurn gates on,
    // so logging them here lets `walnut-logs.sh trace` explain any queued stall
    // without guessing.
    const dbgTarget = this.findSessionByClaudeId(sessionId)
    log.session.info('handleSend: routing send', {
      sessionId,
      interrupt: !!interrupt,
      activeProcessing: this.activeProcessing.has(sessionId),
      hasPipe: dbgTarget?.hasPipe ?? false,
      pid: dbgTarget?.processPid ?? null,
      host: dbgTarget?.host ?? null,
      path: this.activeProcessing.has(sessionId) ? 'injectMidTurn' : 'processNext',
    })
    if (!this.activeProcessing.has(sessionId)) {
      log.session.info('handleSend: triggering processNext', { sessionId, interrupt: !!interrupt })
      this.processNext(sessionId, mode).catch((err) => {
        log.session.error('processNext failed after send', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })
    } else {
      // Session is mid-turn. Try to inject via stdin pipe (like typing in Claude CLI while it's working).
      // With --input-format stream-json, Claude reads stdin between API rounds (tool calls),
      // so the message is injected immediately rather than waiting for the turn to finish.
      this.injectMidTurn(sessionId).catch((err) => {
        log.session.error('injectMidTurn failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })
    }

    // Unconditional phase transition + session cleanup. Best-effort and fire-and-forget
    // so the global task write-lock never blocks message delivery above.
    // applySessionPhase is an idempotent state machine (reads current phase, no-ops if
    // no transition needed), so running it after delivery is safe.
    void this.syncPhaseAfterSend(sessionId)
  }

  /** Fire-and-forget phase/status bookkeeping after a send. Never blocks delivery. */
  private async syncPhaseAfterSend(sessionId: string): Promise<void> {
    try {
      const { getSessionByClaudeId, updateSessionRecord } = await import('../core/session-tracker.js')
      const record = await getSessionByClaudeId(sessionId)
      if (!record) return

      // Phase sync: session input → IN_PROGRESS
      if (record.taskId) {
        // Cancel stale triage runs for this task — user has resumed, triage analysis is outdated
        try {
          const { subagentRunner } = await import('./subagent-runner.js')
          const cancelled = subagentRunner.cancelRunsForTask(record.taskId, 'turn-complete-triage')
          if (cancelled > 0) log.session.info('handleSend: cancelled stale triage', { taskId: record.taskId, cancelled })
        } catch { /* non-fatal */ }

        const { applySessionPhase } = await import('../core/phase.js')
        await applySessionPhase(record.taskId, 'session:input', 'session.ts:handleSend', { sessionId })
        // Touch last_session_update on resume for "Recent" sidebar sort
        const { touchLastSessionUpdate } = await import('../core/task-manager.js')
        touchLastSessionUpdate(record.taskId).catch(err =>
          log.session.warn('touchLastSessionUpdate failed', { taskId: record.taskId, error: String(err) }))
      }
      // Clear stale error message and update activity on resume
      if (record.process_status === 'error' || record.errorMessage) {
        await updateSessionRecord(sessionId, {
          activity: 'Processing follow-up...',
          errorMessage: undefined,  // Clear stale error on resume
        })
        // Emit status change so frontend clears the error banner immediately
        bus.emit(EventNames.SESSION_STATUS_CHANGED, {
          sessionId,
          taskId: record.taskId,
          process_status: record.process_status,
          phase: 'IN_PROGRESS',
          activity: 'Processing follow-up...',
        }, ['*'], { source: 'session-runner' })
      }
    } catch (err) {
      log.session.warn('handleSend: phase/status reset failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * Inject a message mid-turn via stream-json stdin pipe.
   * Claude reads stdin between API rounds, so the message appears between tool calls.
   * If stdin write fails, the message stays queued for processNext after the turn completes.
   */
  private async injectMidTurn(sessionId: string): Promise<void> {
    // Find the session with this Claude session ID
    let targetSession: ClaudeCodeSession | undefined
    for (const [, session] of this.sessions) {
      if (session.sessionId === sessionId) {
        targetSession = session
        break
      }
    }

    // Do NOT gate on the local `hasPipe` flag here. `hasPipe` is a locally-cached
    // guess at remote liveness, and for remote (daemon) sessions it goes stale: the
    // CLI is alive and its FIFO is readable, yet `hasPipe=false` (pid=None) because
    // walnut never learned the remote state. Gating on it strands the message —
    // injectMidTurn used to silently `return` and wait for some later event to call
    // processNext, producing the 30–50s QUEUED stall users saw mid-turn.
    //
    // The authoritative liveness check lives in the daemon: `writeMessage` →
    // `cmdSend` does an atomic O_WRONLY|O_NONBLOCK FIFO probe (ENXIO if no reader),
    // exactly like processNext's stdin path. So: if the session object is missing,
    // OR we can't write the FIFO, delegate to processNext — it owns rehydrate /
    // attach / --resume and will deliver via the source of truth instead of guessing.
    // (Root-cause fix, mirrors the 2026-04-22 removal of the _hasPipe cache; see
    // memory: don't cache remote state locally.)
    if (!targetSession) {
      log.session.info('injectMidTurn: no live session object — delegating to processNext', {
        sessionId,
      })
      return this.processNext(sessionId)
    }

    // If Claude is blocked on a permission prompt, auto-deny it so the user's
    // message can be processed. Without this, messages are silently lost.
    if (targetSession.hasPendingPermission) {
      const pendingPerms = targetSession.getPendingPermissionRequests()
      log.session.info('injectMidTurn: auto-denying pending permissions to unblock for user message', {
        sessionId,
        permissions: pendingPerms.map(p => p.toolName),
      })
      for (const p of pendingPerms) {
        targetSession.resolvePermissionRequest(p.requestId, false, 'User sent a new message — permission auto-denied')
      }
      await new Promise(r => setTimeout(r, 200))
    }

    // Atomically move pending messages to processing state
    const newMsgs = await markProcessing(sessionId)
    if (newMsgs.length === 0) return

    const combined = newMsgs.map((m) => m.message).join('\n\n')

    if (await targetSession.writeMessage(combined)) {
      // Injection succeeded — increment batch count so SESSION_BATCH_COMPLETED
      // includes these messages when the turn eventually completes
      this.batchCounts.set(sessionId, (this.batchCounts.get(sessionId) ?? 0) + newMsgs.length)
      log.session.info('handleSend: message injected mid-turn via stdin', { sessionId, count: newMsgs.length })
      this.logDeliveryLatency(sessionId, 'mid-turn', newMsgs)

      // Write synthetic user events so history has user messages for dedup.
      // Without this, mid-turn injected messages are missing from JSONL history,
      // causing optimistic message dedup to fail (user message appears twice).
      for (const msg of newMsgs) {
        if (msg.id) targetSession.writeSyntheticUserEvent(msg.message, msg.id)
      }

      // Eagerly remove from disk queue — message written to FIFO, no re-delivery on crash.
      // Scoped to THIS batch's ids so a concurrent in-flight batch is never swept.
      removeProcessed(sessionId, newMsgs.map((m) => m.id)).catch((err) => {
        log.session.warn('eager removeProcessed failed after mid-turn injection', { sessionId, error: err instanceof Error ? err.message : String(err) })
      })

      // Tell frontend these messages have been delivered to the CLI
      bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
        sessionId,
        count: newMsgs.length,
      }, ['main-ai'], { source: 'session-runner' })
    } else {
      // stdin write failed — the daemon's FIFO probe says the CLI isn't reading
      // (turn-between gap, process died, etc.). Revert to pending, then delegate to
      // processNext NOW rather than stranding the message until some later event.
      // processNext owns the authoritative recovery path (rehydrate / attach /
      // --resume), so the message is delivered promptly instead of waiting out the
      // whole turn (the old behavior logged a warn and left it queued = 30–50s stall).
      // NOTE: deliberately does NOT emit SESSION_ERROR errorKind:'delivery_failed'
      // here. This is a delegation/retry, not a surrender: processNext owns the
      // authoritative recovery path and is the one that emits the terminal
      // delivery_failed (via settleResumeFailure) if the --resume also fails.
      // Emitting here too would double-report the same failure.
      await revertToPending(newMsgs)
      log.session.info('injectMidTurn: stdin write failed — delegating to processNext', { sessionId, count: newMsgs.length })
      return this.processNext(sessionId)
    }
  }

  /**
   * Log enqueue→delivered latency for a delivered batch. The messageId
   * (`qm-<ts>-<rand>`) is the cross-layer request id — grep it to trace a
   * single message from RPC through delivery. deliveryMs = now - enqueuedAt
   * of the oldest message in the batch (worst-case wait the user felt).
   */
  private logDeliveryLatency(sessionId: string, path: 'stdin' | 'mid-turn' | 'resume', msgs: QueuedMessage[]): void {
    const now = Date.now()
    let maxMs = 0
    let oldestId: string | undefined
    for (const m of msgs) {
      const enq = Date.parse(m.enqueuedAt)
      if (!Number.isNaN(enq)) {
        const ms = now - enq
        if (ms >= maxMs) { maxMs = ms; oldestId = m.id }
      }
    }
    log.session.info('message delivered', {
      sessionId,
      path,
      count: msgs.length,
      deliveryMs: maxMs,
      messageId: oldestId,
    })
    // Stash for the next per-turn wide event (forensic observability).
    this._lastDeliveryMs = maxMs
    this._lastDeliveryPath = path
  }

  /**
   * Settle a --resume spawn that the daemon CONFIRMED started (pid returned).
   * Only now is it safe to drop the batch from the persistent queue and tell the
   * UI it was delivered. Writes synthetic user events first so Phase-1 history has
   * the user messages for optimistic-dedup. Called from send()'s onSpawnSettled(true).
   */
  private settleResumeSuccess(sessionId: string, session: ClaudeCodeSession, msgs: QueuedMessage[]): void {
    for (const m of msgs) {
      if (m.id) session.writeSyntheticUserEvent(m.message, m.id)
    }
    removeProcessed(sessionId, msgs.map((m) => m.id)).catch((err) => {
      log.session.warn('eager removeProcessed failed after --resume spawn', { sessionId, error: err instanceof Error ? err.message : String(err) })
    })
    bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
      sessionId,
      count: msgs.length,
    }, ['main-ai'], { source: 'session-runner' })
    this.logDeliveryLatency(sessionId, 'resume', msgs)
  }

  /**
   * Settle a --resume spawn that FAILED (SSH/daemon-deploy/publickey error, EMFILE…).
   * The message was never delivered, so it MUST survive: revert the batch from
   * 'processing' back to 'pending' (recoverable on restart / user Retry) and tell the
   * UI to mark the optimistic rows 'failed' (keep text + Retry) via batch-failed —
   * NOT batch-completed (which deletes them). Called from send()'s onSpawnSettled(false).
   */
  private settleResumeFailure(sessionId: string, msgs: QueuedMessage[], err: Error): void {
    this.clearActiveProcessing(sessionId)
    log.session.warn('resume spawn failed — reverting batch to pending', { sessionId, error: err.message })
    revertToPending(msgs).catch(() => {})
    bus.emit(EventNames.SESSION_BATCH_FAILED, {
      sessionId,
      messageIds: msgs.map((m) => m.id),
      error: err.message,
    }, ['main-ai'], { source: 'session-runner' })
    // errorKind 'delivery_failed' = connectivity status, NOT a turn outcome.
    // Consumers (server.ts chat persist, hook dispatcher, push notify, and the
    // session-runner's own handler) all short-circuit on it: no batch-completed,
    // no processNext re-trigger, no phase flip, deduped notification. The
    // missing kind is what turned an SSH outage into the 2-req/s infinite
    // retry loop + 150 red boxes on 2026-06-10.
    bus.emit(EventNames.SESSION_ERROR, {
      sessionId,
      error: err.message,
      errorKind: 'delivery_failed' as const,
    }, ['main-ai'], { source: 'session-runner' })
  }

  /**
   * Redeliver pending queue messages for sessions on a host that just
   * (re)connected. Called from the daemon pool's host-connected callback.
   * Local sessions (host=null → '__local__') are included when the local
   * daemon reconnects.
   */
  private async redeliverPendingForHost(hostKey: string): Promise<void> {
    const pendingSessions = await getAllSessionsWithPending()
    if (pendingSessions.length === 0) return

    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    for (const sessionId of pendingSessions) {
      // Skip sessions mid-delivery — their batch is already in flight.
      if (this.activeProcessing.has(sessionId)) continue
      try {
        const record = await getSessionByClaudeId(sessionId)
        if (!record) continue
        // Don't resurrect an archived session on reconnect — it's been retired
        // (plan executed / user closed); resuming it would spawn a CLI for a
        // session no UI entry point points at. Leave its messages pending.
        if (record.archived) continue
        const recordHost = record.host ?? '__local__'
        if (recordHost !== hostKey) continue
        log.session.info('daemon reconnected — redelivering pending messages', { sessionId, hostKey })
        await this.processNext(sessionId)
      } catch (err) {
        log.session.warn('reconnect redelivery failed for session', {
          sessionId, hostKey, error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  /**
   * Drain all pending messages for a session, combine them, and send as one claude --resume call.
   * @param mode - Optional permission mode override for the resumed session.
   */
  private async processNext(sessionId: string, mode?: string): Promise<void> {
    const msgs = await markProcessing(sessionId)
    if (msgs.length === 0) return

    this.setActiveProcessing(sessionId, msgs.length)

    let combined = msgs.map((m) => m.message).join('\n\n')

    try {
      // Find the session that has this Claude session ID
      let targetSession: ClaudeCodeSession | undefined

      for (const [, session] of this.sessions) {
        if (session.sessionId === sessionId) {
          targetSession = session
          break
        }
      }

      // Check for pending model/mode switch — requires --resume (can't change via FIFO)
      let resolvedModel: string | undefined
      let resolvedMode: string | undefined
      let hasPendingSwitch = false
      try {
        const { getSessionByClaudeId: getSession, updateSessionRecord: updateRecord } = await import('../core/session-tracker.js')
        const record = await getSession(sessionId)
        if (record?.pendingModel || record?.pendingMode) {
          resolvedModel = record.pendingModel
          resolvedMode = record.pendingMode ?? mode
          hasPendingSwitch = true
          // Clear pending fields
          await updateRecord(sessionId, { pendingModel: undefined, pendingMode: undefined })
          log.session.info('processNext: consuming pending model/mode switch', { sessionId, model: resolvedModel, mode: resolvedMode })
        }
        // Fall back to stored CLI model for --resume so the [1m] context window
        // marker is preserved.  record.cliModel stores the original --model arg
        // (e.g. "opus[1m]").  record.model stores the *reported* model from init
        // events (e.g. "global.anthropic.claude-opus-4-6-v1") which never includes
        // [1m] — using it for resume would silently downgrade to 200K context.
        // Skip malformed model strings (e.g. orphan "]" from old ANSI stripping bug).
        const storedCliModel = record?.cliModel
        const storedModel = record?.model
        if (!resolvedModel && storedCliModel) {
          resolvedModel = storedCliModel
        } else if (!resolvedModel && storedModel
          && (!storedModel.endsWith(']') || storedModel.endsWith('[1m]'))) {
          if (storedModel.endsWith('[1m]')) {
            // Already has context marker — use as-is
            resolvedModel = storedModel
          } else {
            // Backward compat: sessions created before cliModel was persisted
            // only have the reported model (e.g. "global.anthropic.claude-opus-4-6-v1")
            // which never includes [1m].  Infer CLI alias + [1m] from model family
            // so resume preserves 1M context (the default for new sessions).
            const lower = storedModel.toLowerCase()
            if (lower.includes('sonnet')) resolvedModel = 'sonnet[1m]'
            else if (lower.includes('haiku')) resolvedModel = 'haiku'  // haiku has no 1M variant
            else if (lower.includes('fable')) resolvedModel = 'fable[1m]'  // fable defaults to 1M like opus
            else resolvedModel = undefined  // → send() defaults to 'opus[1m]'
          }
        }
      } catch (err) {
        log.session.warn('processNext: failed to read pending model/mode', { sessionId, error: err instanceof Error ? err.message : String(err) })
      }

      // Rehydrate: if this.sessions lost the entry (e.g. reconciler didn't flag the
      // record as reconnectable on startup, so init() never populated the map), try
      // to attach to the existing process before falling through to --resume spawn.
      // Without this, sending a message to a healthy remote session would kill the
      // running turn and emit the SDK's "[Request interrupted by user]" marker in
      // the JSONL stream (that string is emitted by @anthropic-ai/claude-agent-sdk
      // — not a Walnut string, don't grep locally — when its abortController is
      // aborted with a non-"interrupt" reason, i.e. exactly what a --resume respawn
      // does to the in-flight turn).
      //
      // Skip when a pending model/mode switch is in flight — that path must go
      // through --resume (the CLI args change), so rehydrating would be wasted work.
      if (!targetSession && !hasPendingSwitch) {
        try {
          const { getSessionByClaudeId } = await import('../core/session-tracker.js')
          const record = await getSessionByClaudeId(sessionId)
          if (record && await this.isSessionStillAlive(record)) {
            log.session.info('processNext: rehydrating session via attachToExisting', {
              sessionId, host: record.host, pid: record.pid, taskId: record.taskId,
            })
            const attached = await ClaudeCodeSession.attachToExisting(record, this.cliCommand, this._testDaemonUrl)
            // Race guard: a concurrent path (startup init() phase 1, or a concurrent
            // session:start for the same taskId) may have populated this.sessions
            // while attachToExisting was awaiting. If so, discard ours — registering
            // a second transport would overwrite the first's entry in the session
            // manager registry (src/providers/session-manager.ts:296) and orphan its
            // event listeners / tailer.
            let collided: ClaudeCodeSession | undefined
            for (const [, s] of this.sessions) {
              if (s.sessionId === sessionId) { collided = s; break }
            }
            if (collided) {
              log.session.info('processNext: rehydrate lost race — discarding attached, using existing', { sessionId })
              attached.detach()
              targetSession = collided
            } else {
              // mapKey mirrors the convention used by startup init() (~line 2860):
              // taskId when available, else `reconnected-<claudeSessionId>` so taskless
              // sessions don't collide under an undefined key.
              const mapKey = record.taskId || `reconnected-${sessionId}`
              this.sessions.set(mapKey, attached)
              targetSession = attached
            }
          }
        } catch (err) {
          log.session.warn('processNext: rehydrate attempt failed, will fall back to --resume', {
            sessionId, error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // If pending model/mode switch, force --resume path (skip FIFO)
      if (hasPendingSwitch && targetSession) {
        log.session.info('processNext: forcing --resume for model/mode switch', { sessionId, model: resolvedModel, mode: resolvedMode })
        await targetSession.gracefulStop()
      }

      // Build walnutMessageIds from the batch — one synthetic event per queued message.
      // Each optimistic copy in the frontend has a unique queueId; we need a matching
      // walnutMessageId in the JSONL for each one so Layer 1 dedup can remove them all.
      const walnutMessageIds = msgs.map(m => m.id).filter(Boolean)

      // Try stdin write first (stream-json mode — reuses running process)
      if (targetSession && !hasPendingSwitch) {
        // If Claude Code is blocked on a permission prompt (control_request), auto-deny
        // the pending permissions so Claude unblocks and can process the user's new message.
        // Previously this reverted messages to pending and re-emitted the permission UI,
        // but users often don't see (or ignore) the prompt — causing the session to get
        // permanently stuck with messages bouncing in the queue.
        if (targetSession.hasPendingPermission) {
          const pendingPerms = targetSession.getPendingPermissionRequests()
          log.session.info('processNext: auto-denying pending permissions to unblock session for user message', {
            sessionId,
            permissions: pendingPerms.map(p => p.toolName),
          })
          for (const p of pendingPerms) {
            targetSession.resolvePermissionRequest(p.requestId, false, 'User sent a new message — permission auto-denied')
          }
          // Small delay for Claude Code to process the denial before we write the new message
          await new Promise(r => setTimeout(r, 200))
        }

        // All sessions now go through daemon. The daemon's `cmdSend` does atomic
        // FIFO liveness detection (O_WRONLY|O_NONBLOCK → ENXIO if nobody is reading).
        // No local PID pre-flight check needed.
        if (await targetSession.writeMessage(combined)) {
          log.session.info('processNext: message sent via stdin (no new process)', { sessionId })
          this.logDeliveryLatency(sessionId, 'stdin', msgs)

          // Write synthetic user events to streams file so Phase 1 has user messages.
          // One event per queued message so each optimistic copy can dedup by ID.
          for (const wmId of walnutMessageIds) {
            const msgText = msgs.find(m => m.id === wmId)!.message
            targetSession.writeSyntheticUserEvent(msgText, wmId)
          }

          // ── Eagerly remove from disk queue ──
          // Once the message is written to the FIFO, Claude has it. Remove from the
          // persistent queue immediately so a server crash/restart won't re-deliver it.
          // This prevents the infinite loop where: session kills server → restart →
          // loadQueue() resets processing→pending → re-delivers same message → loop.
          // Scoped to THIS batch's ids so a concurrent in-flight batch is never swept.
          removeProcessed(sessionId, msgs.map((m) => m.id)).catch((err) => {
            log.session.warn('eager removeProcessed failed after FIFO write', { sessionId, error: err instanceof Error ? err.message : String(err) })
          })

          // Tell frontend these messages have been delivered to the CLI
          bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
            sessionId,
            count: msgs.length,
          }, ['main-ai'], { source: 'session-runner' })

          // FIFO stall detection removed — the 120s timer was killing legitimate
          // long-running operations (compaction on large contexts, slow API calls).
          // The 30-min health monitor idle timeout is the proper safety net.

          return
        }
        log.session.info('processNext: writeMessage failed, falling back to --resume spawn', {
          sessionId,
          hasPipe: targetSession.hasPipe,
          processActive: targetSession.active,
          pid: targetSession.processPid,
          host: targetSession.host,
        })

        // Gracefully stop old process before respawning (SIGINT → wait → SIGTERM).
        // This ensures Claude Code flushes session state to disk so --resume can find it.
        // Without this, send() would SIGTERM the old process immediately, which can cause
        // --resume to fail and create a new session with a different ID.
        await targetSession.gracefulStop()
      }

      if (!targetSession) {
        // Session not in memory — create a new one to resume
        const { getSessionByClaudeId } = await import('../core/session-tracker.js')
        const record = await getSessionByClaudeId(sessionId)
        if (record) {
          const session = new ClaudeCodeSession(record.taskId, record.project, this.cliCommand)
          session._testDaemonUrl = this._testDaemonUrl
          this.sessions.set(record.taskId, session)

          // Read config for SSH target resolution and permission_prompt setting
          const { getConfig } = await import('../core/config-manager.js')
          const resumeConfig = await getConfig()

          // Resolve SSH target if session has a stored host
          let sshTarget: SshTarget | undefined
          if (record.host) {
            try {
              const hostDef = resumeConfig.hosts?.[record.host]
              if (hostDef) {
                const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
                if (hostname) {
                  sshTarget = {
                    hostname,
                    user: hostDef.user,
                    port: hostDef.port,
                    shell_setup: hostDef.shell_setup,
                  }
                }
              }
            } catch {
              log.session.warn('failed to resolve host config for resume', { sessionId, host: record.host })
            }
          }

          // Fall back to record.mode when no explicit mode provided — prevents
          // mode silently reverting to 'default' on --resume (send() treats undefined as default).
          const resumeMode = resolvedMode ?? mode ?? record.mode
          log.session.info('resuming session via CLI', { sessionId, taskId: record.taskId, messageLength: combined.length, model: resolvedModel, mode: resumeMode })
          // Settle the queue from send()'s spawn callback — NOT synchronously after
          // send() returns. send() is fire-and-forget; the SSH/daemon deploy that can
          // fail (publickey denied) happens asynchronously. Removing the message before
          // that confirmation is what silently lost messages. See onSpawnSettled doc.
          session.send(combined, record.cwd ?? undefined, sessionId, resumeMode, resolvedModel, undefined, record.host ?? undefined, sshTarget, undefined, resumeConfig.session?.permission_prompt, undefined, resumeConfig.session?.stream_partial_messages,
            (ok, err) => {
              if (ok) this.settleResumeSuccess(sessionId, session, msgs)
              else this.settleResumeFailure(sessionId, msgs, err ?? new Error('resume spawn failed'))
            })

          bus.emit(EventNames.SESSION_STARTED, {
            taskId: record.taskId,
            project: record.project,
            host: record.host,
            resumed: true,
          }, ['main-ai'], { source: 'session-runner' })
          return
        }

        // No record found — throw so the catch block handles cleanup
        throw new Error(`No active session found for session ID: ${sessionId}`)
      }

      // Resolve SSH target if the session was on a remote host, so --resume
      // spawns on the correct machine (not locally).
      const { getConfig } = await import('../core/config-manager.js')
      const resumeConfig2 = await getConfig()
      let resumeSshTarget: SshTarget | undefined
      const resumeHost = targetSession.host
      if (resumeHost) {
        try {
          const hostDef = resumeConfig2.hosts?.[resumeHost]
          if (hostDef) {
            const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
            if (hostname) {
              resumeSshTarget = { hostname, user: hostDef.user, port: hostDef.port, shell_setup: hostDef.shell_setup }
            }
          }
        } catch {
          log.session.warn('failed to resolve host config for resume (existing target)', { sessionId, host: resumeHost })
        }
      }

      // Resume the session with the combined message (with optional mode/model override).
      // Fall back to targetSession._mode to prevent mode silently reverting to 'default'.
      const existingResumeMode = resolvedMode ?? mode ?? targetSession.mode
      log.session.info('resuming session via CLI (existing target)', { sessionId, taskId: targetSession.taskId, messageLength: combined.length, host: resumeHost, model: resolvedModel, mode: existingResumeMode })
      // Settle the queue from send()'s spawn callback, not synchronously — the remote
      // SSH/daemon deploy can fail AFTER send() returns. See onSpawnSettled doc on send().
      const settleTarget = targetSession
      targetSession.send(combined, targetSession.cwd ?? undefined, sessionId, existingResumeMode, resolvedModel, undefined, resumeHost ?? undefined, resumeSshTarget, undefined, resumeConfig2.session?.permission_prompt, undefined, resumeConfig2.session?.stream_partial_messages,
        (ok, err) => {
          if (ok) this.settleResumeSuccess(sessionId, settleTarget, msgs)
          else this.settleResumeFailure(sessionId, msgs, err ?? new Error('resume spawn failed'))
        })
    } catch (err) {
      // Clean up activeProcessing + batchCounts on any error (send() EMFILE, lookup failure, etc.)
      this.clearActiveProcessing(sessionId)

      const errorMsg = err instanceof Error ? err.message : String(err)
      log.session.warn('processNext failed', { sessionId, error: errorMsg })

      // Delivery failed (SSH/daemon down, spawn EMFILE, etc.). Revert the batch to
      // 'pending' instead of removing it — the messages were never delivered to the
      // CLI, so they must survive (server restart re-picks pending; user can Retry).
      // Then tell the UI to mark these specific messages 'failed' (keep text + Retry)
      // via batch-failed — NOT batch-completed, which would delete the optimistic rows.
      await revertToPending(msgs).catch(() => {})

      bus.emit(EventNames.SESSION_BATCH_FAILED, {
        sessionId,
        messageIds: msgs.map((m) => m.id),
        error: errorMsg,
      }, ['main-ai'], { source: 'session-runner' })

      // delivery_failed: batch is back in 'pending' — see settleResumeFailure.
      bus.emit(EventNames.SESSION_ERROR, {
        sessionId,
        error: errorMsg,
        errorKind: 'delivery_failed' as const,
      }, ['main-ai'], { source: 'session-runner' })
    }
  }
}

// ── Singleton ──

export const sessionRunner = new SessionRunner()

// ── Stream file cleanup ──

/**
 * Clean up old JSONL stream files from completed sessions.
 * Deletes files older than 1 hour, but preserves files belonging to
 * non-terminal sessions (they may be needed for reconnection or UI display).
 *
 * @param preserveSessionIds — Set of Claude session IDs whose files should NOT be deleted.
 *   Pass non-terminal session IDs from sessions.json to prevent deleting files that
 *   are still referenced and could cause ENOENT errors during reconnection.
 */
export async function cleanupStreamFiles(preserveSessionIds?: Set<string>): Promise<number> {
  let cleaned = 0
  try {
    const files = await fsp.readdir(SESSION_STREAMS_DIR)
    const now = Date.now()
    const ONE_HOUR = 60 * 60 * 1000

    for (const file of files) {
      // Check if this file belongs to a preserved session
      if (preserveSessionIds) {
        // Extract session ID from filename: {sessionId}.jsonl, {sessionId}.jsonl.err, {sessionId}.pipe
        const baseName = file.replace(/\.(jsonl\.err|jsonl|pipe)$/, '')
        if (preserveSessionIds.has(baseName)) continue
      }

      const filePath = path.join(SESSION_STREAMS_DIR, file)
      try {
        const stat = await fsp.stat(filePath)
        if (now - stat.mtimeMs > ONE_HOUR) {
          await fsp.unlink(filePath)
          cleaned++
        }
      } catch {
        // File may have been deleted by another process
      }
    }

    if (cleaned > 0) {
      log.session.info('cleaned up old stream files', { cleaned, preserved: preserveSessionIds?.size ?? 0 })
    }
  } catch {
    // Directory may not exist yet — not an error
  }
  return cleaned
}
