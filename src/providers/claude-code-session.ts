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
import { CostWatermark } from '../core/usage/cost-watermark.js'
import { isProcessAliveAsync } from '../utils/process.js'
import { isLocalJsonlFresh } from '../utils/session-liveness.js'
import { SESSION_STREAMS_DIR, CLAUDE_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import {
  enqueueMessage,
  markNextProcessing,
  markProcessing,
  migrateSessionQueue,
  removeProcessed,
  revertToPending,
  loadQueue,
  getAllSessionsWithPending,
} from '../core/session-message-queue.js'
import type { QueuedMessage } from '../core/session-message-queue.js'
import { registerEchoClaims, revokeEchoClaims } from '../core/echo-claims.js'
import { matchesRetryExhaustion } from '../core/session-auto-continue.js'
// Image transfer for remote sessions: RemoteSessionManager.prepareOutbound() uploads
// local images via daemon and rewrites paths inside start() and writeMessage().
import type { SshTarget } from './session-io.js'
import { createSessionManager, registerSessionManager, unregisterSessionManager } from './session-manager.js'
import type { SessionManager } from './session-manager.js'
import type { DaemonTaskState } from './daemon-connection.js'
import { checkCwdExists } from './cwd-check.js'
import { AcpSession, emitAcpIdentityBoundary, sessionMcpServerToAcp } from './acp-session.js'
import { extractImageFilePathFromInput } from '../core/session-history.js'
import type { SessionRecord, SessionMode, ProcessStatus, TaskPhase, SessionModelCatalogEntry, SessionEffort } from '../core/types.js'
import {
  SESSION_MODEL_CLI_MAP, modelSupportsEffort, VALID_SESSION_EFFORT_IDS,
  SESSION_MODE_CLI_MAP, VALID_SESSION_MODE_IDS, sessionModeFromCli,
} from '../core/types.js'
import { classifyStreamEvent, classifyDelta } from './claude-stream-event-map.js'
import { accumulateWorkflowProgress, sortedPhases, sortedAgents } from '../core/workflow-progress.js'
import type { WorkflowPhaseInfo, WorkflowAgentInfo } from '../core/event-types.js'
import { recordTurn } from '../core/observability/recorder.js'
import type { SessionServerClient } from './session-server-client.js'
import { sanitizeInitModel, CONTEXT_WINDOW_DEFAULT } from '../agent/providers/defaults.js'
import {
  openTurn,
  settleTurn,
  abortTurn,
  abortAllTurns,
  getOpenTurnPromise,
} from './turn-ledger.js'

export async function buildAcpLaneConfig(lane: string): Promise<{
  lane: string
  disableProjectInstructions: true
  walnutMcpServer: import('./acp-worker/protocol.js').AcpMcpServer
}> {
  const { walnutMcpProfile } = await import('../core/sessions/profiles.js')
  const server = walnutMcpProfile().mcpServers?.walnut
  if (!server) throw new Error('Walnut MCP profile is unavailable for the Main Agent lane')
  return {
    lane,
    disableProjectInstructions: true,
    walnutMcpServer: sessionMcpServerToAcp('walnut', server),
  }
}

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
  /**
   * Per-server mount health, one entry per server the CLI accepted from
   * `--mcp-config`. A server refused by machine policy is ABSENT from this list
   * entirely (the CLI only warns on stderr), so "we mounted N, init reports
   * fewer" is the one reliable signal that a mount was rejected.
   * Verified against CLI 2.1.220: `[{"name":"walnut","status":"failed"}]`.
   */
  mcp_servers?: { name: string; status?: string }[]
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
  /** Subagent identity on inline-subagent lines (new CLI builds). Threaded to
   *  the UI so orphan children (parent tool_call gone after turn end) can still
   *  render a labelled task group. */
  subagent_type?: string
  task_description?: string
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
  /** Per-model session accounting. Each entry's contextWindow is the CLI's
   *  getContextWindowForModel(model) — the RAW model window (the exact
   *  denominator the official statusline divides by), NOT the auto-compact
   *  window. Live-verified on 2.1.220: fable[1m] reports 1000000. */
  modelUsage?: Record<string, { contextWindow?: number; inputTokens?: number }>
}

/** control_request for --permission-prompt-tool stdio protocol */
interface StreamControlRequestEvent {
  type: 'control_request'
  request_id: string
  request: Record<string, unknown>
}

/** The `applied` block of a get_settings control_response — the CLI's
 *  runtime-resolved settings AFTER env overrides + model downgrades. This is the
 *  authoritative "what the model will actually use" (path:
 *  control_response.response.response.applied). `effort` here already accounts for
 *  CLAUDE_CODE_EFFORT_LEVEL and unsupported-level→high downgrade. */
export interface CliAppliedSettings {
  model?: string
  /** True runtime effort (low/medium/high/xhigh/max) or null if none/unset. */
  effort?: string | null
  ultracode?: boolean
}

export interface CliEffectiveSettings {
  effortLevel?: string | null
}

export interface CliSettingsSnapshot {
  applied: CliAppliedSettings
  effective?: CliEffectiveSettings
}

/** Normalized get_context_usage payload — the CLI's own per-category context
 *  breakdown (same source as the interactive /context command). NB maxTokens
 *  semantics changed across CLI versions: newer CLIs (≥2.1.2xx) report the
 *  AUTO-COMPACT window (min(model window, CLAUDE_CODE_AUTO_COMPACT_WINDOW)),
 *  NOT the model's raw window — see contextWindowForPercent for how the
 *  context% denominator handles that. */
export interface CliContextUsage {
  categories: Array<{ name: string; tokens: number }>
  totalTokens: number | null
  maxTokens: number | null
  percentage: number | null
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

interface StreamToolProgressEvent {
  type: 'tool_progress'
}

/** control_cancel_request: the CLI WITHDRAWS a pending control_request it
 *  previously emitted (turn aborted / resume / restart). Must clear the
 *  matching pending permission or the session sticks "Waiting" forever. */
interface StreamControlCancelRequestEvent {
  type: 'control_cancel_request'
  request_id?: string
}

type StreamEvent = StreamInitEvent | StreamStatusEvent | StreamMessageEvent | StreamResultEvent | StreamControlRequestEvent | StreamControlResponseEvent | StreamPartialEvent | StreamToolProgressEvent | StreamControlCancelRequestEvent

/**
 * Map a CLI permissionMode string (JSONL/stream system events) to our internal
 * SessionMode. Delegates to the ONE registry in core/types.ts, so it covers
 * every mode the CLI can report — incl. `auto` and `dontAsk`. Unknown values
 * return null: a mode we don't model must never masquerade as another.
 */
function mapPermissionMode(cliMode: string): SessionMode | null {
  return sessionModeFromCli(cliMode)
}

function isMissingBypassCapabilityError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  // The CLI names the bare flag in its rejection text even though we launch with
  // the --allow- form; match the shared stem so both spellings are caught.
  return message.includes('bypassPermissions')
    && message.includes('dangerously-skip-permissions')
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
    // CLI startup advisories the user cannot act on from Walnut (see
    // stripCliStartupNoise). "Benign" here means only "not worth quoting as a death
    // reason" — it is NOT evidence the process exited cleanly. The advisory is
    // written at spawn and replayed on death, so it appears on healthy exits and
    // crashes alike; callers must still consult the exit code before treating a
    // death as a success (see handleRemoteProcessExit's suppressibleExit).
    if (CLI_STARTUP_NOISE.some(re => re.test(line))) return true
    return false
  })
}

/**
 * CLI startup advisories that are NOT failures. The `.err` file is written at spawn
 * and read again on process death, so these lines get quoted as if they were the
 * cause of death — e.g. a session that ran fine for 2h reported the managed-settings
 * advisory it printed at startup as its death reason (2026-08-10). The CLI itself
 * says the remaining valid policies are still enforced; it continues normally.
 */
const CLI_STARTUP_NOISE: RegExp[] = [
  /^Managed settings contain invalid entries/i,
  /Invalid entry was ignored: failed validation$/i,
]

/**
 * Reconcile the MCP servers we requested via `--mcp-config` against the ones the
 * CLI reported in its `init` event.
 *
 * The CLI lists ONLY servers it accepted; one refused by machine policy is absent
 * from the list and the refusal goes to stderr, which we classify as startup
 * noise. So absence is the single reliable signal of a rejected mount, and
 * `'blocked'` is our verdict for it. Present servers keep the CLI's own status
 * (connected | failed | needs-auth | pending | disabled).
 */
export function reconcileMcpMountStatus(
  requested: string[],
  reported: { name?: string; status?: string }[] | undefined,
): Record<string, string> {
  const list = Array.isArray(reported) ? reported : []
  const status: Record<string, string> = {}
  for (const name of requested) {
    const hit = list.find((s) => s?.name === name)
    status[name] = hit ? (hit.status ?? 'unknown') : 'blocked'
  }
  return status
}

/** Drop CLI startup advisories from stderr, so only real diagnostics get quoted. */
function stripCliStartupNoise(stderr: string): string {
  return stderr
    .split('\n')
    .filter(line => {
      const t = line.trim()
      return t.length > 0 && !CLI_STARTUP_NOISE.some(re => re.test(t))
    })
    .join('\n')
    .trim()
}

// Re-export types and helpers from session-io for backwards compatibility
export type { SshTarget } from './session-io.js'
export { shellQuote } from './session-io.js'

// Exported for testing
export { outputFileCheckResult, stripCliStartupNoise, isBenignSshStderr }

/**
 * Immediate fail-closed contract for ACP providers that do not advertise
 * session.fork. Routes should call this before creating a target task; the
 * runner calls it again as defense in depth before any provider/native start.
 */
export class AcpForkUnsupportedError extends Error {
  readonly code = 'ACP_FORK_UNSUPPORTED'
  readonly statusCode = 409

  constructor(sessionId: string) {
    super(`Fork is unavailable for Codex session ${sessionId}: the ACP provider does not advertise session.fork`)
    this.name = 'AcpForkUnsupportedError'
  }
}

export function assertSessionForkSupported(
  source: Pick<SessionRecord, 'claudeSessionId' | 'engine'>,
): void {
  if (source.engine === 'codex') {
    throw new AcpForkUnsupportedError(source.claudeSessionId)
  }
}

/**
 * Build the trailing `opts` object for a COLD-RESUME send() from a record's
 * profile/lane. Returns undefined when the session carries neither, so plain
 * sessions keep passing no opts at all (unchanged behavior).
 *
 * Why a helper: `--system-prompt` / `--mcp-config` / `--allowedTools` have no
 * live control_request, so every cold-spawn path must re-emit them. One helper
 * = one place to keep the resume paths honest.
 */
function resumeProfileOpts(
  profile: import('../core/types.js').SessionProfile | undefined,
  lane: string | undefined,
): { profile?: import('../core/types.js').SessionProfile; lane?: string } | undefined {
  if (!profile && !lane) return undefined
  return { ...(profile ? { profile } : {}), ...(lane ? { lane } : {}) }
}

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
  /** MCP server names passed via `--mcp-config` at the last spawn (see init handler). */
  private _requestedMcpServers: string[] = []
  /** Session-lifetime flag: survives across turns, checked by handleProcessDeath and
   *  server-restart recovery to suppress spurious events from dead/old processes.
   *  Set true on kill/interrupt/respawn; set false when a new turn begins. */
  private resultEmitted = false
  /** Per-turn flag: reset on writeMessage()/send(), prevents duplicate JSONL result
   *  events within a single turn (e.g., tailer emits result, then PID-death handler fires). */
  private _turnResultEmitted = false
  /** Monotonic counter of OBSERVED TURN-START EDGES. Stamped onto every SESSION_RESULT
   *  so a LATE consumer can tell "this result is still the current turn" from "a newer
   *  turn has already started" (incident ed347bde, 2026-08-05: the result's ~800ms-late
   *  AGENT_COMPLETE flip landed AFTER the next turn's start and repainted a visibly
   *  streaming session as Idle/completed for 44s).
   *
   *  Three edges bump it — the gate must not fail open on any delivery shape:
   *    1. writeMessage() on an idle→running delivery — the QUEUED-SEND shape, and the
   *       most common one: walnut holds the message while turn A runs and writes the
   *       FIFO the instant A's result lands. That write is the FIRST evidence of turn
   *       B, arriving BEFORE anything the CLI emits for it.
   *    2. session_state_changed{running} — the CLI's explicit turn-start signal.
   *    3. an `init` after this turn's result — the only signal when the CLI picks up a
   *       queued send without ever going idle (no {running} is emitted at all).
   *
   *  Semantics: "number of turn-start edges seen", NOT "number of turns". One turn can
   *  legitimately produce several edges (FIFO write, then the CLI's {running}, then an
   *  init) — that is harmless by construction, because every result is stamped with the
   *  gen CURRENT AT ITS OWN EMIT TIME, i.e. after all of its own turn's edges. So a
   *  turn's own result always compares equal to the live gen and flips normally; only a
   *  result emitted BEFORE a later edge reads as stale, which is exactly the intent.
   *
   *  Never reset — a reset would make a live gen look older than an in-flight result's
   *  gen, and the stale-result gate in core/phase.ts fails OPEN on that comparison. */
  private _turnGen = 0
  /** Did any MAIN-lane assistant text reach the UI stream during this turn?
   *
   *  Set as a side effect of emitting SESSION_TEXT_DELTA (both the `assistant`
   *  and `stream_event` paths), never at a decision site — so a new streaming
   *  path added later records delivery for free. Subagent text is excluded: it
   *  lands in its own lane and is never the turn's answer.
   *
   *  Read once at the terminal `result` to tell a turn whose answer already
   *  streamed from one that only ever carried it on `result` (upstream ACP
   *  issue #453 / fix #858): a cache-replayed turn can generate zero output
   *  tokens and skip streaming entirely, so without this fallback the UI
   *  renders an empty turn. Deliberately NOT keyed off `fullText`, which is
   *  ALSO written by the withheld-result and PID-death paths (and by the
   *  task-notification branch) — those writes would make a genuinely silent
   *  turn look like it had streamed. */
  private _emittedAssistantText = false
  /** L1 byte-offset (`v`) of the event currently being processed by handleStreamLine.
   *  Set at entry, valid only within that synchronous call. Undefined = old daemon. */
  private _currentEventV: number | undefined
  /** Consumed-offset watermark: `v` of the last RESULT this instance processed to
   *  turn completion. The positional twin of `resultEmitted`: a result whose v is
   *  ABOVE this watermark was never processed, no matter what the boolean claims
   *  (incident 10e7df54 — the boolean was seeded from a lying task-phase proxy and
   *  swallowed a real result forever). Persisted to SessionRecord.consumedOffset
   *  (monotonic) so it survives restarts; seeded from the record on attach.
   *  -1 = no watermark (old daemon / never seen a v). */
  private _consumedOffset = -1

  /** Stamp this turn's first thinking/text/tool emit time (once per turn, main
   *  lane only). INFO log on each first — so a live `walnut-logs.sh session
   *  <sid>` shows exactly when each kind of content first reached the UI bus,
   *  and the gap to turn-start is attributable per layer. */
  private _stampFirstEmit(kind: 'thinking' | 'text' | 'tool'): void {
    const field = kind === 'thinking' ? '_firstThinkingTs' : kind === 'text' ? '_firstTextTs' : '_firstToolTs'
    if (this[field] !== undefined) return
    const now = Date.now()
    this[field] = now
    const sinceTurnStartMs = this._turnStartTs !== undefined ? now - this._turnStartTs : null
    log.session.info(`first ${kind} emit of turn`, {
      sessionId: this.claudeSessionId,
      taskId: this.taskId,
      sinceTurnStartMs,
    })
  }

  /** True when the event being processed sits at or below the consumed watermark —
   *  i.e. it is a REPLAY of something this server already fully processed. Only
   *  meaningful when both sides have positions; without them, returns undefined
   *  (caller falls back to the boolean guards). */
  private _isReplayedByOffset(): boolean | undefined {
    if (this._currentEventV === undefined || this._consumedOffset < 0) return undefined
    return this._currentEventV <= this._consumedOffset
  }

  /** Advance the consumed watermark to the just-processed event and persist it.
   *  Monotonic: never moves backwards; MAX_SAFE_INTEGER (transport sentinel) is
   *  never adopted. Fire-and-forget persistence — the in-memory watermark is
   *  what the live guards read. */
  private _advanceConsumedOffset(): void {
    const v = this._currentEventV
    if (v === undefined || v >= Number.MAX_SAFE_INTEGER) return
    if (v <= this._consumedOffset) return
    this._consumedOffset = v
    if (this.claudeSessionId) {
      const sid = this.claudeSessionId
      import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
        updateSessionRecord(sid, { consumedOffset: v }),
      ).catch(() => {})
    }
  }
  /** ── Idle-debt conservation (ported from the ACP adapter's idle accounting) ──
   *  The CLI emits one session_state_changed{idle} companion for every turn-over
   *  it reports via a `result` line. When the RESULT handler completes the turn
   *  (the normal path), that companion idle is still in flight — and if the user
   *  sends the next message quickly, writeMessage() has already reset
   *  _turnResultEmitted by the time it lands, so the naive idle handler read it
   *  as "the NEW turn is over" and completed a turn that had produced zero output
   *  (the premature-idle family, [[premature_idle_completes_running_workflow]]).
   *  Every result-driven completion adds one owed idle; the idle handler consumes
   *  debt FIRST — an owed idle is the previous turn's companion, never a turn-over
   *  trigger. Deliberately NOT reset per turn (surviving the turn boundary is the
   *  whole point); reset only on spawn (fresh CLI process = fresh event stream). */
  private _idleDebt = 0
  /** Byte offset in the output file where the current turn started (for resume). */
  private _turnStartOffset = 0
  /** Cumulative cost from the last result event — used to detect stale/replayed results. */
  private _lastResultCost: number | undefined
  /** Converts the CLI's cumulative total_cost_usd into a billable per-result
   *  increment. Reset on every spawn (the new process's total restarts at 0).
   *  Without this, every turn re-recorded the whole running total → the 13×
   *  inflated "$222K" session cost. See core/usage/cost-watermark.ts. */
  private _costWatermark = new CostWatermark()
  /** stop_reason of the most recent assistant message_delta — the truncated-success
   *  invariant compares this against result.subtype (success + null = truncation). */
  private _lastStopReason: string | null | undefined
  /** CLI debug-stream marker for an upstream API timeout (system subtype
   *  api_timeout). Reset at every turn boundary; augments the human-readable
   *  result signature when the CLI's final error text is generic, so the
   *  retryExhausted signal on SESSION_RESULT stays reliable. */
  private _sawApiTimeoutThisTurn = false
  /** Delivery latency + path of the most recent delivered batch, surfaced into the
   *  per-turn wide event (forensic observability). Stamped by SessionRunner's
   *  logDeliveryLatency onto the target session instance (not `private` because the
   *  runner writes it across instances). */
  _lastDeliveryMs: number | undefined
  _lastDeliveryPath: string | undefined
  /** ── TTFT instrumentation (inc-1786665503510: "text shows only at the very end") ──
   *  Epoch ms of the turn-start edge (idle→running FIFO write / send()); anchor
   *  for all first-* latencies below. Undefined between turns. */
  private _turnStartTs: number | undefined
  /** Epoch ms when this turn's FIRST main-lane thinking/text/tool event was
   *  emitted to the UI bus. Each is stamped exactly once per turn, then the
   *  result handler logs turn-start→first-X latencies + feeds the metrics
   *  registry (session.first_thinking / first_text / first_tool). Distinguishes
   *  "model produced text late" (upstream/model behavior — firstTextMs huge,
   *  everything else on time) from "walnut sat on the text" (JSONL had it
   *  early; compare against the daemon's CLI-side timing). */
  private _firstThinkingTs: number | undefined
  private _firstTextTs: number | undefined
  private _firstToolTs: number | undefined
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
  /** Preserve status-event order while each event commits its durable projection. */
  private _statusCommit: Promise<void> = Promise.resolve()
  /** Model ID from JSONL assistant messages (e.g. "claude-opus-4-6"). */
  private _model: string | undefined
  /** Full model string from system init (e.g. "global.anthropic.claude-opus-4-6-v1[1m]"). */
  private _initModel: string | undefined
  /** CLI model string passed to --model (e.g. "opus[1m]"). Preserved for resume. */
  private _cliModel: string | undefined
  /** REQUESTED reasoning-effort passed to --effort (low/medium/high/xhigh/max). User intent;
   *  preserved for resume. NOT ground truth — see _effectiveEffort. */
  private _effort: import('../core/types.js').SessionEffort | undefined
  /** TRUE runtime effort last read back from the CLI via get_settings (applied.effort).
   *  Authoritative — reflects env override + model downgrade. Undefined until first read. */
  private _effectiveEffort: import('../core/types.js').SessionEffort | undefined
  /** Launch-config bundle expanded into spawn args. Persisted so a cold --resume
   *  re-applies it (spawn-time flags have no live control_request). */
  private _profile: import('../core/types.js').SessionProfile | undefined
  /** UI conversation lane this session backs, if any. Persisted so capacity
   *  counting and the default session lists skip it. */
  private _lane: string | undefined
  /** CLI-reported window (get_context_usage.maxTokens), cached from the
   *  session-start/model-change read. ⚠️ On newer CLIs (≥2.1.2xx) this is the
   *  AUTO-COMPACT window — min(model window, CLAUDE_CODE_AUTO_COMPACT_WINDOW) —
   *  NOT the raw model window, so it must never LOWER the context% denominator
   *  (see contextWindowForPercent). It still raises the string guess for
   *  >200K models the model string can't reveal (custom/proxy windows). */
  private _cliContextWindow: number | undefined
  /** The CLI's RAW model window, read from result.modelUsage[model].contextWindow
   *  (= the CLI's getContextWindowForModel — the exact denominator the official
   *  statusline uses; env auto-compact clamps do NOT apply to it). Arrives free
   *  on every turn-end result, no control_request round-trip. Preferred over
   *  every guess in contextWindowForPercent; cleared on model change (the old
   *  model's window must not leak into the new model's percent). */
  private _cliRawContextWindow: number | undefined
  /** One-shot guard for the attach-path window probe (see refreshAppliedSettings):
   *  an old CLI that can't answer get_context_usage must not be re-probed per turn. */
  private _cliContextWindowProbed = false
  /** Guard so the session-start effort read-back fires at most once per live process
   *  (init can re-fire on auto-continuation/compaction; we only want the first). */
  private _initEffortRead = false
  /** The session ID we expect after a --resume. If Claude returns a different ID,
   *  we rename the existing record instead of creating a phantom new one. */
  private _expectedSessionId: string | null = null
  /** Every claude session id this object has carried before the current one
   *  (resume-rename, result-id adoption). SESSION_RESULT's stuck-activeProcessing
   *  fixup uses this to verify the stale entry really belonged to THIS session —
   *  matching by taskId alone cross-wired unrelated sessions' results. */
  private _priorSessionIds = new Set<string>()

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

  // ── Cron (/loop) tracking ──
  /** True when a CronCreate was seen and not every cron has been CronDelete'd.
   *  The CLI's cron EXECUTION timer lives in-process, and Walnut only permits
   *  non-durable (session-scoped) crons, so killing the CLI loses the loop —
   *  the health monitor's idle timeout must use the extended cron threshold
   *  instead of killing between fires. (`durable:true` would additionally
   *  persist to {cwd}/.claude/scheduled_tasks.json and be adopted by another
   *  session in the same directory; see the INVARIANT block in daemon-core.ts,
   *  which denies those.) Deliberately
   *  NOT cleared by turn end or user anchor — crons span turns by design. */
  private _cronArmed = false
  /** CronCreate tool_use ids seen (used to resolve job ids from tool_results). */
  private _cronToolUseIds = new Set<string>()
  /** Live cron job ids (from CronCreate tool_use_result.id); CronDelete removes. */
  private _cronJobIds = new Set<string>()
  /** Public getter for the health monitor — extend idle timeout while armed. */
  get cronArmed(): boolean { return this._cronArmed }
  /** One-way arm from a daemon snapshot push ({cronActive:true}). The daemon's
   *  full-file fold sees a CronCreate that walnut's tail-window attach fold
   *  missed; dis-arm stays with the live CronDelete handler only. */
  setCronArmedFromSnapshot(): void { this._cronArmed = true }

  // ── Background task / dynamic-workflow tracking ──
  // A dynamic-workflow turn (or any background subagent) fans out N tasks that
  // outlive the agent's text turn. The CLI emits a `result` as soon as the main
  // turn produces output ("Workflow launched in background"), but background tasks
  // keep running — so `result` must NOT drive turn-completion while bg work is live.
  //
  // AUTHORITY for "is bg work in flight" is the LIVE SET of background tasks (`_bgTasks`,
  // keyed by task_id, each carrying a status), NOT the CLI's idle. POC-verified (see
  // [[claude_code_session_state_semantics]]): the CLI emits session_state_changed
  // {idle} ~20×/run — between every sub-agent/phase — NOT once at the end. So idle is
  // only the turn-over *trigger*: the turn is done when we see idle AND no task in the set
  // is still running. `_sessionStateSeen` flips true the first time we observe a
  // session_state event; when false (old CLI) we complete via `result` + the set + the
  // daemon-PULL liveness invariant instead.
  //
  // ⚠️ DESIGN — level-triggered, NOT edge-triggered (k8s-style). We deliberately do NOT
  // keep an incremental `++/--` counter of in-flight tasks. An accumulator assumes every
  // lifecycle event arrives exactly once; in reality they duplicate (daemon restart replays
  // JSONL), go missing (SSH drop / daemon restart never re-emits a notification), or gain
  // NEW kinds (a `task_updated{status:completed}` that lands BEFORE the matching
  // task_notification — the exact event that wedged incident inc-…afr3cs: it flipped the
  // status to 'completed', the decrement guard `status==='running'` then skipped, the
  // counter leaked, and the session showed "Running" 29 min after the turn ended). EVERY one
  // of those desyncs a counter permanently. Instead, in-flight is DERIVED on read from the
  // task set (count of status==='running'), so a duplicate/late/new-kind event that just
  // sets a status is automatically correct and idempotent. The remaining failure — a
  // genuinely LOST terminal event leaving a task forever 'running' — is backstopped by
  // process-death turn completion (see the comment block above hasActiveBackgroundWork).
  /** True once we've observed any session_state_changed event → idle is the turn-over trigger. */
  private _sessionStateSeen = false
  /** Most recent CLI session state, when emitted. */
  private _cliSessionState: 'running' | 'idle' | 'requires_action' | undefined
  /** THE authoritative set of background tasks (dynamic workflows / subagents), keyed by
   *  task_id, each carrying its latest status. "Is bg work in flight" is derived from this
   *  set (see hasActiveBackgroundWork) — there is no parallel scalar counter to desync. */
  private _bgTasks = new Map<string, { description?: string; subagentType?: string; taskType?: string; status: string; tokens?: number; lastTool?: string; summary?: string; workflowName?: string; isBackgrounded?: boolean; endedPerLevel?: boolean }>()
  /** Task ids that have EVER appeared in a `background_tasks_changed` payload — proof of
   *  membership in the CLI's level universe. Only a task the CLI itself once listed may be
   *  absent-marked by a later level (see the background_tasks_changed handler); a task the
   *  level universe never covered must not be touched by level evidence. Cleared on spawn
   *  (fresh process = fresh registry). */
  private _bgSeenInLevel = new Set<string>()
  /** The withheld user-turn outcome (port of upstream ACP #870 `Turn.deferredSettle`).
   *  Stored when the turn's terminal `result` arrives while background subagents are
   *  still live; the turn later completes WITH this outcome — at the drain idle, at the
   *  task-notification followup's terminal result, or at a level/daemon reconcile drain —
   *  instead of rewriting an error to success. Cleared on spawn, on a new turn's
   *  writeMessage (the user moving on outranks the hold — upstream's hand-off contract),
   *  and on interrupt/process-death teardown. */
  private _deferredOutcome: { isError: boolean; resultText?: string; totalCost?: number; duration?: number } | undefined
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

  /** Terminal task statuses — a task in any of these is no longer in flight. */
  private static readonly _BG_TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'cancelled', 'killed'])

  /** Number of background tasks still running. DERIVED from the authoritative task set on
   *  every read — never an accumulated counter, so no event can desync it.
   *
   *  GATING semantics (incident 07fffbe5): a task the CLI marked `is_backgrounded:true`
   *  (via task_updated patch) is excluded — the CLI's OWN turn-end does not wait for
   *  backgrounded tasks (it emits result+idle while they run), so neither may we.
   *  Counting one here held a finished turn "Running" for the 16-min lifetime of a
   *  backgrounded full-disk grep. The UI set (`backgroundTasks` getter) keeps ALL
   *  tasks including backgrounded ones — only turn-over gating uses this count. */
  private _runningBgCount(): number {
    let n = 0
    for (const t of this._bgTasks.values()) {
      if (t.isBackgrounded) continue
      // endedPerLevel (#870 port): a replace-semantics `background_tasks_changed`
      // payload omitted this task after having listed it — its terminal bookends were
      // lost. Gating on it would wedge the withheld turn forever. Excluded from
      // turn-over gating only; the entry stays for the UI and the daemon PULL.
      if (t.endedPerLevel) continue
      if (!ClaudeCodeSession._BG_TERMINAL_STATUSES.has(t.status)) n++
    }
    return n
  }

  /** True when any background subagent / dynamic-workflow task is still running.
   *  Single choke point: every "is this turn's result intermediate?" decision consults
   *  THIS, so adding a future bg mechanism only touches one place.
   *
   *  AUTHORITY = the live task set `_bgTasks` (count of non-terminal status), NOT the CLI's
   *  `idle`. POC-verified (see [[claude_code_session_state_semantics]]): the CLI emits
   *  `session_state_changed{idle}` ~20×/run — once between every sub-agent / phase — because
   *  its idle-wait loop excludes `in_process_teammate` tasks (fork `print.ts:2390-2459`). So
   *  `idle` means "foreground thread quiet right now", NOT "all background work done". An
   *  earlier version short-circuited this to `false` on idle; that's exactly what completed
   *  turns mid-workflow (→ false await_human). Deriving from the set means a duplicate, late,
   *  or new-kind lifecycle event that merely sets a status can never leave us wedged (the
   *  incident inc-…afr3cs failure mode); a genuinely lost terminal event is backstopped by
   *  process-death turn completion (see the comment block below). `_cliSessionState` is kept for
   *  status DISPLAY and as the turn-over *trigger* (see the idle handler), never as an override here. */
  hasActiveBackgroundWork(): boolean {
    return this._runningBgCount() > 0
  }

  /** True when the task set holds ANY non-terminal entry, INCLUDING backgrounded ones.
   *  Distinct from hasActiveBackgroundWork(), which excludes backgrounded tasks
   *  (turn-over gating only) — that exclusion is exactly why a backgrounded task's lost
   *  terminal event can wedge the UI panel forever with no self-heal opportunity
   *  (inc-1784012867247): _runningBgCount() already reads 0 for it, so nothing ever
   *  flags this session as worth a reconcileFromDaemon() PULL. This is that flag. */
  hasPendingBackgroundTasks(): boolean {
    for (const t of this._bgTasks.values()) {
      if (!ClaudeCodeSession._BG_TERMINAL_STATUSES.has(t.status)) return true
    }
    return false
  }

  // ── Why there is NO activity-based "reconcile" of stuck background tasks ──
  //
  // Layer 1 (deriving in-flight from the _bgTasks set) makes every DUPLICATE / OUT-OF-ORDER /
  // NEW-KIND lifecycle event benign. The only residual failure is a genuinely LOST terminal
  // event (SSH drop / daemon restart that never re-emits) leaving a task 'running' forever.
  //
  // It is TEMPTING to "reconcile" that by inferring liveness — e.g. the subagent transcript
  // file's mtime. We deliberately DON'T, because no such signal can answer the only question
  // that matters — "is this task alive RIGHT NOW?":
  //   • transcript mtime is PAST-tense: a fresh mtime proves it wrote a moment ago, not that
  //     it's alive now; a stale mtime cannot distinguish "dead" from "alive but blocked on a
  //     slow 5-min tool call that produces no output". Either way it's a guess that can KILL a
  //     live task (→ premature AGENT_COMPLETE, the mirror bug [[premature_idle_completes_running_workflow]]).
  //   • "CLI is idle ⟹ no subagent running" is FALSE — verified: the CLI reports idle ~20×/run
  //     while in-process subagents are still executing ([[claude_code_session_state_semantics]]).
  //   • The CLI exposes NO control_request to query task status over stdio (verified against the
  //     SDK control schema), the canonical JSONL records ZERO task_* events, and in-process
  //     subagents have no OS pid to probe.
  // So "is this in-process task alive now?" is simply NOT OBSERVABLE through any interface
  // Walnut can reach. The ONLY authoritative truth is process liveness:
  //   • CLI process DEAD (daemon-authoritative) ⟹ its in-process subagents are necessarily
  //     dead too → handleProcessDeath() already completes the turn (AGENT_COMPLETE), regardless
  //     of leftover _bgTasks state. This is the deterministic Layer-2 backstop — no guessing.
  //   • CLI process ALIVE but a terminal event was truly lost ⟹ unobservable → we do NOT guess;
  //     the session honestly shows 'running' until the daemon's 2h idle-kill / health-monitor
  //     idle-timeout reaps the process, which then funnels into the DEAD path above.
  // Net: zero risk of killing a live task, at the cost of slower convergence in the (rare)
  // truly-lost-event-without-process-death case. That trade is the honest one — we never claim
  // a liveness we cannot observe.

  /** ── ONE turn-start edge, called from every place a turn is observed to begin ──
   *
   *  Bumps the generation, flips the in-memory status to running, and pulls the task
   *  phase back to IN_PROGRESS. Extracted because the CLI-event turn-start paths — the
   *  `session_state_changed{running}` branch and the init-after-result branch — had
   *  divergent copies of this exact sequence (only one of them persisted the record).
   *
   *  Callers MUST apply their own replay guard first: a replayed event (daemon reattach
   *  re-streams history) describes a PAST turn and must not flip the present.
   *
   *  `persist` writes the running transition to the session record. Both CLI-event
   *  edges pass true (same semantic edge, and a turn started by a message injected
   *  straight into the daemon's FIFO never goes through writeMessage, so this write is
   *  the only one). writeMessage does its own richer record write and passes false.
   *
   *  `sidHint` covers the init edge, which runs BEFORE `claudeSessionId` is (re)assigned
   *  from the init line. */
  private _onTurnStartEdge(
    source: 'init-after-result' | 'state-running',
    persist: boolean,
    sidHint?: string,
  ): void {
    const sid = this.claudeSessionId ?? sidHint
    this._turnGen++
    if (this._processStatus !== 'running') {
      this._processStatus = 'running'
      // Clear in-memory activity too, not just the persisted column: emitStatusChanged
      // folds _activity into its own record write, so a stale value would land there
      // and race the explicit `activity: undefined` below.
      this._activity = undefined
      this.emitStatusChanged('IN_PROGRESS')
      // Persist the running transition — mirrors writeMessage()'s DB write. Carries
      // pid + host so the record stays verifiable (a 'running' row with both null is
      // un-verifiable and the health monitor rewrites it every tick — the orphan
      // dead-pool write-amp stall).
      if (persist && sid) {
        import('../core/session-tracker.js').then(({ updateSessionRecord }) => {
          updateSessionRecord(sid, {
            process_status: 'running',
            activity: undefined,
            last_status_change: new Date().toISOString(),
            status_reason: 'message_sent',
            status_changed_by: 'session-runner',
            ...(this.pid != null ? { pid: this.pid } : {}),
            ...(this._host ? { host: this._host } : {}),
          }).catch(() => {})
        }).catch(() => {})
      }
    }
    // ── Turn-start phase pullback (incidents 46f42871 + 1f11596b + ed347bde) ──
    // session:input only fires at SEND time — for a queued/mid-turn send the phase was
    // already IN_PROGRESS then (no-op), after which the PREVIOUS turn's result flipped
    // it to AGENT_COMPLETE (and triage possibly to AWAIT) with nothing pulling it back
    // when this turn started: task showed completed/red while the CLI was visibly
    // streaming. This is the missing turn-START half of the result↔phase symmetry.
    // Runs even when _processStatus was already 'running' (a late triage can repaint
    // the phase mid-turn without touching process_status); applySessionPhase no-ops
    // when the phase is already IN_PROGRESS.
    if (!this.taskId) return
    const turnStartTaskId = this.taskId
    import('../core/phase.js').then(({ applySessionPhase }) =>
      applySessionPhase(turnStartTaskId, 'session:turn-start', `session-runner:${source}`, {
        sessionId: sid,
      }),
    ).catch((err) => {
      log.session.warn('turn-start phase pullback failed', {
        source, sessionId: sid, taskId: turnStartTaskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Emit the withheld turn-over (AGENT_COMPLETE + SESSION_RESULT) exactly once. Called by
   *  the idle handler when the CLI goes idle with no background work left.
   *  `_turnResultEmitted` guards against the CLI's trailing idles re-firing it.
   *
   *  Settles with the STORED outcome when the withheld result recorded one (upstream ACP
   *  #870: "the hand-off reports the recorded stop reason instead of rewriting it to
   *  end_turn"). Pre-fix this lane hardcoded isError:false, so a turn whose own result
   *  was an error — withheld because a subagent was still live — completed as a SUCCESS:
   *  the task went AGENT_COMPLETE instead of surfacing the failure. */
  private _completeTurnOnIdle(): void {
    const sid = this.claudeSessionId
    if (!sid) return
    const outcome = this._deferredOutcome
    this._deferredOutcome = undefined
    this._activity = undefined
    this._processStatus = 'idle'
    this._turnResultEmitted = true
    // Idle is the CLI's authoritative turn-over signal, and this lane completes a
    // turn whose `result` was withheld — nothing here will run the result case's
    // clear. Close the delivery stretch so this turn's streamed text can't
    // suppress the NEXT turn's result-text fallback (#858).
    this._emittedAssistantText = false
    // The idle that completes a withheld turn is the turn's LAST lifecycle event —
    // advance the watermark to it so a replay of this whole turn (result + idle)
    // is positionally suppressed after a restart.
    this._advanceConsumedOffset()
    this.emitStatusChanged('AGENT_COMPLETE', outcome?.isError ? (outcome.resultText ?? '').slice(0, 500) || undefined : undefined)
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: sid, taskId: this.taskId,
      // Turn generation at emit time — lets a LATE consumer detect that a newer
      // turn has since started (stale-result gate, core/phase.ts).
      turnGen: this._turnGen,
      // Success: fullText — it carries the LATEST answer (a task-notification
      // followup's summary overwrites it after the withheld result was stored, and
      // that summary IS the turn's real answer). Error: the stored error text is
      // the signal; fullText would be pre-error prose.
      result: outcome?.isError ? (outcome.resultText ?? this.fullText) : this.fullText,
      isError: outcome?.isError ?? false,
      ...(outcome?.totalCost !== undefined ? {
        totalCost: outcome.totalCost,
        costDelta: this.billableCostDelta(outcome.totalCost),
      } : {}),
      ...(outcome?.duration !== undefined ? { duration: outcome.duration } : {}),
    }, ['main-ai', 'session-runner'], { source: 'session-runner' })
    // Read back the CLI's true settings (effort + model) at turn-end (fire-and-forget
    // — never blocks completion). Keeps the badge honest across turns: settings can
    // drift if a hook or env changed them mid-turn, and the CLI never pushes that to us.
    void this.refreshAppliedSettings('turn-end')
  }

  /** L2: reconcile the local task set against the DAEMON's authoritative state (the source of
   *  truth). The daemon sits closest to the CLI and persisted every event in the append-only
   *  jsonl, so it knows the true terminal status of a task even when Walnut's live event stream
   *  dropped the terminal bookend (SSH flap / daemon-restart gap / post-restart future-only
   *  subscribe — the inc-…afr3cs failure class).
   *
   *  We ONLY ever adopt a MORE-terminal status from the daemon — never revive, never infer death
   *  from silence. If the daemon says a task we hold 'running' is actually completed/failed/etc,
   *  we record that; if the daemon can't be reached (disconnected / old binary), getState returns
   *  null and we leave local state untouched (fall back to the derived count + process-death
   *  backstop). When this drains the last running task and the turn was withheld, we complete it. */
  async reconcileFromDaemon(): Promise<void> {
    const getState = this._transport?.getState
    if (!getState) return // local non-daemon transport or no support — nothing to PULL
    let daemonState: DaemonTaskState | null
    try { daemonState = await this._transport!.getState!() } catch { return }
    if (!daemonState) return // no authoritative answer — keep current state

    let adopted = 0
    for (const [taskId, local] of this._bgTasks) {
      if (ClaudeCodeSession._BG_TERMINAL_STATUSES.has(local.status)) continue // already terminal locally
      const remote = daemonState.tasks[taskId]
      if (!remote) continue
      if (ClaudeCodeSession._BG_TERMINAL_STATUSES.has(remote.status)) {
        // Daemon recorded a terminal status our live stream missed — adopt the source of truth.
        this._bgTasks.set(taskId, { ...local, status: remote.status })
        adopted++
      } else if (remote.isBackgrounded && !local.isBackgrounded) {
        // Same direction of monotone adoption: backgrounded = detached from turn-over
        // gating. If the live stream dropped the task_updated{is_backgrounded} patch
        // (SSH flap), the daemon's jsonl-rebuilt state still has it.
        this._bgTasks.set(taskId, { ...local, isBackgrounded: true })
        adopted++
      }
    }
    if (adopted === 0) return

    log.session.info('reconcileFromDaemon: adopted daemon-authoritative terminal status', {
      sessionId: this.claudeSessionId, taskId: this.taskId,
      adopted, remainingInFlight: this._runningBgCount(), daemonRv: daemonState.resourceVersion,
    })
    // The panel showed a stale count from before this correction — without this the
    // fix stays server-memory-only forever (inc-1784012867247: a "3/4" panel pinned
    // for 56+ min after every task had actually gone terminal, because nothing ever
    // told the browser the in-memory set had just changed underneath it).
    if (this.claudeSessionId) this._emitBackgroundTasksUpdate(this.claudeSessionId)
    // If the withheld turn can now complete (CLI already idle, all bg work terminal), finish it.
    if (this._runningBgCount() === 0 && !this.resultEmitted && !this._turnResultEmitted
      && this._cliSessionState === 'idle') {
      this._completeTurnOnIdle()
    }
  }

  /** Snapshot of background tasks for the UI (Workflow progress panel). */
  get backgroundTasks(): Array<{ taskId: string; description?: string; subagentType?: string; taskType?: string; status: string; tokens?: number; lastTool?: string; summary?: string; workflowName?: string }> {
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
      inFlight: this._runningBgCount(),
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
   * Billable cost INCREMENT for a result event (advances the per-process
   * watermark). The CLI's total_cost_usd is a running total for the current
   * process; we record only what's new since the last result so the same spend
   * isn't billed every turn (the root of the 13× inflated session cost).
   * Returns 0 for replayed/stale results. See core/usage/cost-watermark.ts.
   */
  private billableCostDelta(totalCostUsd: number | undefined): number {
    return this._costWatermark.bill(totalCostUsd)
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
        turnGen: this._turnGen,
        result: resultText ?? '(team-idle timeout)',
        totalCost,
        // Same total already billed by the teamActive emit — billableCostDelta
        // returns 0 here (total ≤ watermark), so this re-emit doesn't double-bill.
        costDelta: this.billableCostDelta(totalCost),
        duration: durationMs,
        isError: false,
      }, ['main-ai', 'session-runner'], { source: 'session-runner' })
    }, ClaudeCodeSession.TEAM_IDLE_TIMEOUT_MS)
  }
  /** Plan content captured from the most recent Write to ~/.claude/plans/ */
  private _lastPlanWriteContent: string | null = null
  /** True when we've already auto-replied to AskUserQuestion this turn. Reset on new turn. */
  private _askUserIntercepted = false
  /**
   * True when this process was spawned with `--permission-prompt-tool stdio`
   * (config.session.permission_prompt, default on). With the prompt tool active,
   * AskUserQuestion DOES reach the human (as a permission card in the UI), so the
   * "-p mode, the user can never see it" correction must not be injected. Default
   * true because the flag defaults on; only an explicit `permission_prompt: false`
   * flips it.
   */
  private _permissionPromptEnabled = true
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
  /** Pending Walnut→CLI control_requests that only need a success/error ACK (no
   *  nested payload) — e.g. `apply_flag_settings` for mid-session effort switch.
   *  Separate from _pendingSideQuestions because those parse a 3-level-nested
   *  answer string, whereas these resolve `true` on `subtype:'success'`.
   *  Same transport + same control_response inbound branch, matched by request_id. */
  private _pendingControlAcks = new Map<string, {
    resolve: (ok: boolean) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  /** Pending payload-carrying control_requests (get_settings, get_context_usage,
   *  get_usage, get_binary_version, …). Unlike _pendingControlAcks (which resolve
   *  `true`), these capture the whole `response.response` PAYLOAD object; each
   *  wrapper (getSettings/getContextUsage/…) extracts what it needs. One map + one
   *  inbound branch serves every read subtype — matched by request_id, so mixed
   *  in-flight reads can't cross wires. Same transport as the permission flow. */
  private _pendingPayloadReads = new Map<string, {
    resolve: (payload: Record<string, unknown> | null) => void
    reject: (err: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  /** Cached per-session model catalog from the CLI's `initialize` control
   *  response — the session's TRUE selectable models (already filtered by the
   *  host's availableModels + mapped through modelOverrides). Event-driven
   *  invalidation only (no clock TTL): teardown, explicit invalidate, or a
   *  read-back model that isn't in the cached set. null = never fetched /
   *  invalidated / CLI can't answer (old build). */
  private _modelCatalog: { models: SessionModelCatalogEntry[]; fetchedAt: number } | null = null
  /** Concurrency guard: parallel picker opens share ONE initialize round-trip. */
  private _modelCatalogInflight: Promise<SessionModelCatalogEntry[] | null> | null = null
  /** Incremented whenever the backing CLI transport is replaced. Async catalog
   *  work from an older generation must not publish into the new process state. */
  private _transportGeneration = 0
  /** Timestamp when spawn() was called — used to measure time-to-init for diagnostics. */
  private _spawnTs = 0
  /**
   * Resolves when the in-flight `startSpawn()` settles (transport up, or failed).
   * Null once settled / when no spawn is running.
   *
   * Why this exists: the UI now opens the real session panel the moment the id is
   * minted, i.e. BEFORE the CLI process exists (see the preassignedSessionId
   * comment in send()). So a user can type into a session whose transport is
   * still starting. Without a barrier, that send takes processNext's
   * "no live pipe" branch → `gracefulStop()` + `--resume` respawn, which SIGINTs
   * the CLI that is still booting: the first turn is lost and the session can
   * come back under a different id. Delivery waits on this instead.
   */
  private _spawnSettled: Promise<void> | null = null
  /** Wall-clock ts of the HTTP request that triggered this start (latency instrumentation only).
   *  Not `private` — SessionRunner stamps it on the instance before send(). */
  _requestTs = 0
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
  /** True once sessionReady settled (init seen / id pre-assigned+persisted). A death
   *  AFTER this point is an ordinary end-of-life, NOT "init failed" — see
   *  handleProcessDeath: reporting a long-lived session's shutdown as a startup
   *  failure produced a red "session init failed" toast every time the user marked
   *  a task done (completeTaskSessions SIGINTs the CLI, 2026-08-10). */
  private _sessionReadySettled = false
  /** Set by callers that kill this session on purpose (task completion, capacity
   *  eviction, idle timeout). Suppresses the death-path error toast/SESSION_ERROR:
   *  the user already knows, and the session record's status_reason carries the why. */
  private _expectedTeardown = false

  constructor(
    readonly taskId: string,
    readonly project: string,
    cliCommand?: string,
  ) {
    this.cliCommand = cliCommand ?? 'claude'
    this.sessionReady = new Promise<string>((resolve, reject) => {
      // Wrapped so EVERY settle path flips _sessionReadySettled — the death path
      // keys "init failure vs ordinary shutdown" off it.
      this._resolveSessionReady = (id) => { this._sessionReadySettled = true; resolve(id) }
      this._rejectSessionReady = (err) => { this._sessionReadySettled = true; reject(err) }
    })
    // Prevent unhandled rejection if nobody awaits sessionReady (e.g., taskless sessions)
    this.sessionReady.catch(() => {})
  }

  get active(): boolean {
    return this._active
  }

  /** Epoch ms this server spawned the CLI process (0 = attached, spawn time
   *  unknown). Freshness signal for catalog-source selection — an older
   *  process runs an older binary whose model registry may lack newer
   *  families, so its catalog answer is degraded, not authoritative. */
  get spawnTs(): number {
    return this._spawnTs
  }

  get sessionId(): string | null {
    return this.claudeSessionId
  }

  /** True if this session currently carries `id` or carried it earlier in its
   *  lifetime (resume-rename / result-id adoption). Used by the SESSION_RESULT
   *  fixup to prove a stale activeProcessing entry belongs to THIS session. */
  hasCarriedSessionId(id: string): boolean {
    return this.claudeSessionId === id || this._priorSessionIds.has(id)
  }

  get outputFile(): string | null {
    return this._outputFile
  }

  get processPid(): number | null {
    return this.pid
  }

  /** MCP servers this session asked the CLI to mount (see the init mount-health check). */
  get requestedMcpServers(): readonly string[] {
    return this._requestedMcpServers
  }

  get processStatus(): ProcessStatus {
    return this._processStatus
  }

  /** Current turn generation — see `_turnGen`. Read by core/phase.ts's stale-result
   *  gate to reject a SESSION_RESULT whose turn has already been superseded. */
  get turnGen(): number {
    return this._turnGen
  }

  /** Allow the health-monitor reconcile loop to sync the in-memory status after
   *  an authoritative DB converge — without this, the in-memory map would
   *  desync from the record and the next writeMessage would base its mid-turn
   *  decision on the stale pre-converge value. */
  setProcessStatusFromReconciler(status: ProcessStatus): void {
    this._processStatus = status
  }

  /**
   * Epoch-reset the in-memory consumed watermark from the snapshot layer.
   * The ONLY sanctioned backwards move (mirrors the record-side epoch
   * arbitration in applyUpdateToSession): a stream-file incarnation change
   * makes the old coordinate meaningless, and the live replay guards
   * (_isReplayedByOffset) read THIS field — a healed record alone leaves a
   * live instance swallowing every real result (incident 267a4b68: turn ended
   * at v=115M, watermark from the pre-move file said 134M, result + idle both
   * "suppressed as replay", record stuck Running until the next user message).
   */
  resetConsumedOffsetFromSnapshot(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v >= Number.MAX_SAFE_INTEGER) return
    if (this._consumedOffset <= v) return // not a regression — normal advance handles it
    log.session.warn('consumedOffset epoch reset (in-memory, from snapshot layer)', {
      sessionId: this.claudeSessionId, taskId: this.taskId,
      staleConsumedOffset: this._consumedOffset, resetTo: v,
    })
    this._consumedOffset = v
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

  /** Update in-memory mode without contacting the CLI. Reserved for trusted
   *  attach/reconcile paths; user mode changes use applyPermissionMode(). */
  setMode(mode: SessionMode): void {
    this._mode = mode
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
   * Await an in-flight spawn, if any (no-op once the transport is up).
   *
   * Delivery paths MUST call this before concluding "no live pipe → respawn":
   * the panel is now interactive while the CLI is still booting, so a message
   * typed in that window would otherwise SIGINT the process that is starting.
   */
  async awaitSpawn(): Promise<void> {
    if (this._spawnSettled) await this._spawnSettled
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
    effort?: import('../core/types.js').SessionEffort,
    // Invoked once the daemon settles the spawn: ok=true when the CLI process
    // actually started (pid returned), ok=false (with err) when spawn/SSH/daemon
    // deploy failed. CRITICAL: spawn is fire-and-forget (startSpawn runs async and
    // send() returns immediately), so callers MUST NOT treat send() returning as
    // "delivered". Removing the message from the queue / reporting delivery must
    // happen in THIS callback, never right after send() returns. See processNext.
    onSpawnSettled?: (ok: boolean, err?: Error) => void,
    opts?: {
      /**
       * Caller-chosen session id (pre-validated v4 UUID) forwarded as
       * `--session-id`. Set by the UI-initiated start paths so the session's
       * identity exists before the CLI does; the CLI adopts it on spawn.
       * Composes with `--resume --fork-session` (the fork gets THIS id while
       * still inheriting the parent conversation).
       */
      preassignedSessionId?: string
      /**
       * Launch-config bundle (system prompt / MCP mounts / allowedTools) expanded
       * into CLI args below and persisted on the record so a cold `--resume`
       * re-applies it (resolveResumeArgs). See core/types.ts SessionProfile.
       */
      profile?: import('../core/types.js').SessionProfile
      /** Marks this session as bound to a UI conversation lane — persisted so
       *  capacity counting and the default session lists skip it. */
      lane?: string
    },
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

    // Authorize the bypass CAPABILITY at startup without ACTIVATING it. Claude
    // Code rejects a later set_permission_mode(bypassPermissions) unless the
    // process was launched with the capability, so every session needs it —
    // including ones that start in Plan mode.
    //
    // ⚠️ It MUST be `--allow-dangerously-skip-permissions`, never the bare
    // `--dangerously-skip-permissions`. The bare flag doesn't just grant the
    // capability, it *selects the mode*, and it OUTRANKS --permission-mode:
    // initialPermissionModeFromCLI pushes 'bypassPermissions' onto orderedModes
    // FIRST and takes the first viable entry, so `--dangerously-skip-permissions
    // --permission-mode plan` silently starts in bypassPermissions. Measured on
    // CLI 2.1.220 — with the bare flag ALL SIX requested modes reported
    // `init permissionMode=bypassPermissions`; with the --allow- form each mode
    // reported itself. That bug is why plan/accept/default sessions never
    // actually restricted anything (see the mode-registry tests).
    args.push('--allow-dangerously-skip-permissions')

    // Requested mode → CLI vocabulary via the one registry (core/types.ts).
    // No mode = 'bypass': users shouldn't be prompted to approve every edit;
    // every restrictive mode must be asked for explicitly.
    const requestedMode: SessionMode = mode && VALID_SESSION_MODE_IDS.has(mode)
      ? mode as SessionMode
      : 'bypass'
    this._mode = requestedMode
    this._activity = requestedMode === 'plan' ? 'planning' : 'implementing'
    args.push('--permission-mode', SESSION_MODE_CLI_MAP[requestedMode])
    // Map picker short IDs → CLI model aliases via the SESSION_MODELS registry
    // (single source of truth in core/types.ts). The CLI understands the [1m]
    // suffix for the 1M context window. An unknown id falls through to passthrough
    // (CLI resolves it per provider).
    //
    // "Auto" (no model chosen in the picker) means DON'T pass --model at all —
    // Claude Code then picks its own default from its own settings layers
    // (env ANTHROPIC_MODEL, ~/.claude/settings.json, {cwd}/.claude/settings.json).
    // Walnut deliberately has NO implicit default here: a session's model is a
    // RUNTIME choice (the picker), never a Walnut config-time default. Only an
    // explicit picker selection is forwarded as --model.
    const cliModel = model ? (SESSION_MODEL_CLI_MAP[model] ?? model) : undefined
    this._cliModel = cliModel
    if (cliModel) {
      args.push('--model', cliModel)
    }
    // Reasoning effort (low/medium/high/max) → --effort. This is the SPAWN-TIME
    // path: initial start + cold --resume (mid-session changes go through
    // applyEffort()'s apply_flag_settings control_request instead, no respawn).
    // The flag here is the durable fallback: apply_flag_settings is in-memory only,
    // so a cold-resumed CLI needs record.effort re-applied as --effort (same idea as
    // cliModel restoring [1m]). Only pass it for effort-capable models (Haiku isn't);
    // unset = no flag = API default ('high'). max-gating is enforced upstream (UI).
    if (effort && modelSupportsEffort(cliModel)) {
      this._effort = effort
      args.push('--effort', effort)
    } else if (effort) {
      // effort requested but model can't use it (e.g. Haiku) — don't send the flag,
      // but keep _effort so the record/display still reflect the user's intent.
      this._effort = effort
    } else {
      this._effort = undefined
    }
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

    // Pre-assign the session id for EVERY spawn that mints a new session (fresh
    // start with or without a first message, and forks). Verified against the
    // real CLI: `--session-id` is honored alongside a first prompt and alongside
    // `--resume X --fork-session` — every JSONL line comes back with our id.
    //
    // Why this matters for UX: without it the id is only learned from the CLI's
    // first init JSONL line, which lands 3–6s after spawn (CLI cold start + MCP
    // load). The UI had to park on a placeholder panel for those seconds and then
    // REMOUNT the whole column on the pending→real id swap. Pre-assigning makes
    // the id known before the HTTP response, so the real session panel mounts at
    // once and the CLI warms up behind it.
    //
    // `initOnly` (empty first message) additionally needs the persist-and-resolve
    // shortcut below: that spawn emits NO JSONL at all until its first stdin
    // input, so nothing else would ever resolve sessionReady.
    // The id may already have been minted by the caller (route → SESSION_START →
    // handleStart), which is how a UI-initiated start gets a session id in its HTTP
    // response. Adopt that one when present; otherwise mint here so bus/RPC callers
    // that don't supply one still get the fast path.
    //
    // A FORK spawn with an empty message is init-only too: `--resume X
    // --fork-session` + no stdin runs no turn (draft semantics — the process
    // warms up and waits). Excluding it here painted a permanent "working…"
    // status on lane forks. A plain resume with an empty message stays NON-init
    // (the reinitialize/restart path owns its own status).
    const initOnly = !message && (!resumeSessionId || !!forkSession)
    let preassignedId: string | null = null
    if (!resumeSessionId || forkSession) {
      preassignedId = opts?.preassignedSessionId ?? crypto.randomUUID()
      args.push('--session-id', preassignedId)
      this.claudeSessionId = preassignedId
      this._expectedSessionId = preassignedId
    }

    // ── Profile expansion (see core/types.ts SessionProfile) ──
    // The three flags below are SPAWN-TIME ONLY — there is no control_request to
    // change them mid-session — so a cold --resume must re-emit them from the
    // persisted record. That's why the profile is stored (persistSessionRecord)
    // and re-resolved (resolveResumeArgs) rather than being a one-shot param.
    const profile = opts?.profile
    this._profile = profile
    this._lane = opts?.lane
    // 'replace' → --system-prompt (FULL replacement of the CLI's own prompt).
    // Anything else (append / unset) composes with the caller's append text:
    // profile prompt FIRST, caller's append after, so a profile establishes the
    // session's identity and per-turn context is layered on top.
    let appendParts: string[] = []
    // Size floor: the prompt rides the spawn argv, and for remote sessions that
    // argv is shell-quoted into a single SSH command line (twice: daemon quote +
    // `$SHELL -lc` wrapper). ARG_MAX won't hard-fail until ~1MB, but a runaway
    // profile (future per-agent builders, user config) must fail HERE with a
    // clear error, not as an opaque spawn failure on some hosts only.
    const MAX_PROFILE_PROMPT_BYTES = 65536
    if (profile?.systemPrompt && Buffer.byteLength(profile.systemPrompt, 'utf-8') > MAX_PROFILE_PROMPT_BYTES) {
      throw new Error(`session profile systemPrompt exceeds ${MAX_PROFILE_PROMPT_BYTES} bytes — too large to ride the spawn argv`)
    }
    if (profile?.systemPrompt && profile.systemPromptMode === 'replace') {
      args.push('--system-prompt', profile.systemPrompt)
    } else if (profile?.systemPrompt) {
      appendParts.push(profile.systemPrompt)
    }
    if (appendSystemPrompt) appendParts.push(appendSystemPrompt)
    if (appendParts.length > 0) {
      args.push('--append-system-prompt', appendParts.join('\n\n'))
    }
    // Inline JSON is safe in an arg: the bun daemon shell-quotes every element
    // and the JS daemon spawns without a shell (no re-parsing either way).
    if (profile?.mcpServers && Object.keys(profile.mcpServers).length > 0) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: profile.mcpServers }))
      // Remember what we ASKED for: the init event reports only the servers the
      // CLI accepted, so the requested set is what makes a silent refusal visible.
      this._requestedMcpServers = Object.keys(profile.mcpServers)
    }
    if (profile?.allowedTools && profile.allowedTools.length > 0) {
      args.push('--allowedTools', profile.allowedTools.join(','))
    }

    // Both local and SSH sessions use stream-json stdin via SessionIO
    args.push('--input-format', 'stream-json')

    // Permission prompt tool: intercepts sensitive-file and AskUserQuestion permission checks.
    // For remote sessions, control_response is routed through the daemon's `sendRaw`
    // command (see RemoteSessionManager.writeRaw → daemon-core.handleSendRawCommand).
    // Controlled by config.session.permission_prompt (default: true).
    this._permissionPromptEnabled = permissionPrompt !== false
    if (this._permissionPromptEnabled) {
      args.push('--permission-prompt-tool', 'stdio')
    }

    // Store host key for liveness checks and record persistence
    this._host = host ?? null

    // Callers that replace a live process stop it through the daemon's
    // SIGINT-first graceful path before send(). Never process.kill(this.pid)
    // here: remote PIDs are host-local and may identify an unrelated Mac process.
    if (this.pid !== null) {
      log.session.info('replacing previously stopped process', { taskId: this.taskId, oldPid: this.pid })
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
    // Init-only spawn (pre-assigned id): NO first turn — the CLI inits then
    // idles on its FIFO. Claiming 'running' here made the pre-spawn status
    // emit (below) mark the stream buffer streaming; the corrective 'idle'
    // then landed inside the markDone dedup window and was SUPPRESSED, so the
    // UI showed a stuck "working…" indicator on a session that was never
    // going to produce output.
    this._processStatus = initOnly ? 'idle' : 'running'
    this._exitCode = null
    this._exitStderr = undefined
    this.resultEmitted = false
    this._turnResultEmitted = false
    this._expectedTeardown = false    // Fresh process — a prior intentional kill must not mask THIS process's real crash
    this._idleDebt = 0                // Fresh process — a dead process's owed idles never arrive
    this._lastResultCost = undefined  // Fresh session — no previous cost to compare
    this._costWatermark.reset()       // Fresh process — its total_cost_usd restarts at 0
    this._askUserIntercepted = false
    this._sawApiTimeoutThisTurn = false
    this.fullText = ''
    this._emittedAssistantText = false  // Fresh process — nothing streamed yet
    this._emittedStreamKeys.clear()
    this._lastEmittedText.clear()
    this._currentStreamMsgId = null
    this._warnedUnknownTypes.clear()
    // TTFT anchor for the spawn path (init-only spawns get re-anchored by the
    // first real writeMessage; a stale anchor is overwritten there).
    this._turnStartTs = initOnly ? undefined : Date.now()
    this._firstThinkingTs = undefined
    this._firstTextTs = undefined
    this._firstToolTs = undefined
    // Fresh process ⇒ the OLD process's background tasks/teams are dead (they
    // were its children). Stale 'running' entries here make
    // hasActiveBackgroundWork() true forever → the new turn's completion is
    // withheld at the idle handler ("Background tasks running" stuck state).
    this._bgTasks.clear()
    this._bgSeenInLevel.clear()      // Fresh process — fresh level universe
    this._deferredOutcome = undefined // Fresh process — a dead process's withheld turn is gone
    this._resetWorkflowState()
    this._teamActive = false
    this._cliSessionState = undefined
    // Fresh process ⇒ fresh settings snapshot: the model catalog belongs to the
    // OLD process (its availableModels/modelOverrides at ITS spawn time).
    this._transportGeneration++
    this._modelCatalog = null
    this._modelCatalogInflight = null
    this._cwd = cwd ?? null

    const isResume = !!resumeSessionId && !forkSession
    // Pre-assigned id (init-only spawn) names the stream/FIFO files directly —
    // no renameForSession dance later, the id IS the final session id.
    const tmpId = isResume ? resumeSessionId : (preassignedId ?? crypto.randomBytes(8).toString('hex'))

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
      mode: this._mode,
      onOutput: (event) => this.handleStreamLine(event.line, event.v),
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
          // Startup advisories are not the cause of death — strip before quoting.
          const initStderr = stderr ? stripCliStartupNoise(stderr) : ''
          const parts = [`Process exited with code ${code} before initialization`]
          if (host) parts.push(`[${host}]`)
          if (initStderr) parts.push(initStderr.slice(0, 500))
          const errMsg = parts.join(' — ')
          log.session.error('session process died before init', {
            taskId: this.taskId, exitCode: code, host, fromPlanSessionId: this.fromPlanSessionId,
            stderr: initStderr.slice(0, 500) || undefined,
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

    // Publish the spawn barrier BEFORE awaiting it, so a send arriving during the
    // spawn window waits for the transport instead of respawning over it. Settles
    // on both success and failure (a failed spawn must not wedge delivery forever).
    const spawnPromise = startSpawn()
    this._spawnSettled = spawnPromise.then(() => {}, () => {})
      .finally(() => { this._spawnSettled = null })

    spawnPromise.then((result) => {
      this.pid = result.pid
      this._outputFile = result.outputFile
      this._turnStartOffset = result.fileSize

      // Stale-watermark guard on the (re)spawn path: fileSize is the stream
      // file's CURRENT size — a consumed line-end offset can never exceed the
      // size of the append-only file it was measured in, so watermark >
      // fileSize proves the watermark belongs to a DEAD incarnation (e.g. a
      // --resume respawn after the streams-dir move recreated the file at
      // offset ~0 — inc-1786428350008). Keeping it would positionally
      // suppress this session's next real result. In-memory only; the durable
      // record heals via the attach/reconcile epoch paths.
      if (this._consumedOffset > result.fileSize) {
        log.session.warn('spawn: consumedOffset exceeds stream file size — dead-incarnation watermark, resetting', {
          taskId: this.taskId, sessionId: this.claudeSessionId ?? undefined,
          staleConsumedOffset: this._consumedOffset, fileSize: result.fileSize, resume: isResume,
        })
        this._consumedOffset = -1
      }

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

      // Pre-assigned id: don't wait for the CLI's init JSONL line (3–6s away, and
      // for an init-only spawn it never comes at all). The daemon confirmed the
      // pid and we already know the id, so register the transport, refresh the
      // record with the real pid/outputFile, and resolve sessionReady NOW. The
      // init handler still runs later and is idempotent — same id, so it takes
      // the `expectedId === newId` branch and just persists model/settings.
      if (preassignedId) {
        registerSessionManager(preassignedId, transport)
        if (initOnly) {
          // No turn runs until the user sends — park as idle. Set BEFORE persist
          // so the record lands with the truthful status.
          this._processStatus = 'idle'
          this._activity = undefined
        }
        ;(async () => {
          try {
            await this.persistSessionRecord(preassignedId, this._cwd ?? undefined)
            this.emitStatusChanged('IN_PROGRESS')
          } catch (err) {
            log.session.error('CRITICAL: preassigned-id record persist failed', {
              sessionId: preassignedId, taskId: this.taskId, initOnly,
              error: err instanceof Error ? err.message : String(err),
            })
          } finally {
            this._resolveSessionReady(preassignedId)
          }
        })()
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
    // Init-only spawn: silence is EXPECTED (the CLI idles until the first user
    // message) — a 30s no-JSONL stall warning would be a false alarm.
    if (!preassignedId) {
      this.startStallDiagTimer('resume-spawn')
    }
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
    // An attached session's init is historic fact (the record exists because the CLI
    // already initialized), so a later death must not be reported as an init failure.
    session._sessionReadySettled = true
    session.claudeSessionId = record.claudeSessionId
    session.pid = record.pid ?? null
    session._outputFile = record.outputFile ?? null
    session._cwd = record.cwd ?? null
    session._active = true
    // The persisted profile is what this CLI was actually launched with, so an
    // attached session must inherit the requested mount list — otherwise every
    // init seen after an attach (server restart, reconnect, cold resume) skips
    // the mount-health check and the verdict is never recorded.
    session._requestedMcpServers = Object.keys(record.profile?.mcpServers ?? {})
    session._processStatus = record.process_status ?? 'running'
    session._mode = record.mode ?? 'default'
    session._activity = record.activity
    session.planFile = record.planFile ?? null
    session.planCompleted = record.planCompleted ?? false
    session._host = record.host ?? null
    // Restore _permissionPromptEnabled. The record does NOT persist spawn args, so
    // the only authority available here is the same config key the spawn path reads
    // (config.session.permission_prompt). Without this, a server restart would leave
    // the field at its `true` default and an installation that turned the prompt tool
    // OFF would stop getting the "-p mode, the user can't see AskUserQuestion"
    // correction. Best-effort: a config read failure keeps the default.
    try {
      const { getConfig } = await import('../core/config-manager.js')
      session._permissionPromptEnabled = (await getConfig()).session?.permission_prompt !== false
    } catch { /* keep default true — the CLI flag defaults on */ }
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
    // Profile/lane are durable identity — restore them so a later
    // persistSessionRecord() from this attached instance re-writes the same
    // values instead of clearing them (createSessionRecord only overwrites on
    // a truthy `extra` value, but keeping the instance honest avoids surprises).
    if (record.profile) session._profile = record.profile
    if (record.lane) session._lane = record.lane
    // Seed the consumed-offset watermark from the persisted record (sanitized:
    // non-negative finite integer only — a corrupt/sentinel value must never
    // become the guard, it would suppress every future result).
    if (typeof record.consumedOffset === 'number'
      && Number.isInteger(record.consumedOffset)
      && record.consumedOffset >= 0
      && record.consumedOffset < Number.MAX_SAFE_INTEGER) {
      session._consumedOffset = record.consumedOffset
    }

    // ── resultEmitted recovery after server restart (evidence-based) ──
    // `resultEmitted` is ephemeral — it lives only on the ClaudeCodeSession instance
    // in memory and is lost when the server restarts. New instances always start
    // with resultEmitted=false (the field default). Without recovery, the PID-death
    // liveness handler would emit a *synthetic* session:result for every session
    // that was already fully processed (git pull, usage tracking, task phase update,
    // triage dispatch) before the restart — flooding the user with stale notifications.
    //
    // The old recovery used the linked task's phase ALONE as the proxy for "server
    // already handled this result". Incident 10e7df54 proved the proxy lies: a
    // phase-drift reconciler had GUESSED the phase to AWAIT during a disconnect, the
    // proxy then seeded resultEmitted=true, and the daemon replay's REAL (never
    // processed) result was swallowed by the :resultEmitted guard — task wedged.
    //
    // Now the daemon STREAM file is consulted first (the only file that contains
    // result/idle events — the canonical JSONL has zero): a result must actually
    // EXIST for the current turn (fold.turnEnded) before the phase proxy may claim
    // it was processed. Evidence says no result → resultEmitted=false regardless of
    // what the (possibly guessed) phase says, so a replayed real result processes
    // normally. Evidence unavailable (host unreachable etc.) → degrade to the old
    // proxy, logged, per R1 (no guessing silently).
    let taskPhasePastInProgress = false
    if (record.taskId) {
      try {
        const { getTask } = await import('../core/task-manager.js')
        const task = await getTask(record.taskId)
        if (task && task.phase !== 'TODO' && task.phase !== 'IN_PROGRESS') {
          taskPhasePastInProgress = true
        }
      } catch { /* task not found — assume non-terminal */ }
    }
    let streamEvidence: Awaited<ReturnType<typeof import('../core/session-reconcile.js')['fetchStreamTailFold']>> = 'not-fetched'
    try {
      const { fetchStreamTailFold } = await import('../core/session-reconcile.js')
      // consumedOffset arms the whale-turn watermark fallback (incident 57b125ab:
      // a 37-min turn pushed the anchor beyond the tail-window cap, so every
      // attach returned 'tail-window-exhausted' and the stuck record never healed).
      streamEvidence = await fetchStreamTailFold(record.claudeSessionId, record.host,
        { consumedOffset: record.consumedOffset })
    } catch (err) {
      streamEvidence = 'evidence-fetch-threw'
      log.session.warn('attachToExisting: stream evidence fetch failed', {
        sessionId: record.claudeSessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (typeof streamEvidence !== 'string') {
      session.resultEmitted = record.process_status === 'error'
        || (streamEvidence.fold.turnEnded && taskPhasePastInProgress)
    } else {
      log.session.info('attachToExisting: no stream evidence — resultEmitted falls back to phase proxy', {
        sessionId: record.claudeSessionId, reason: streamEvidence, taskPhasePastInProgress,
      })
      session.resultEmitted = taskPhasePastInProgress
        || record.process_status === 'error'
    }

    // ── Stale-watermark heal (incident inc-1786428350008) ──
    // The watermark seeded above is a byte position in ONE file incarnation.
    // When the stream file was recreated (the /tmp→HOME streams move, a reboot
    // wiping /tmp, a fresh same-sid spawn), the record still carries the DEAD
    // file's offset — every event in the new (smaller) file sits "below" it,
    // so the replay guard suppresses the real end-of-turn result and the task
    // never reaches AGENT_COMPLETE. When the evidence proves the mismatch
    // (offset beyond EOF, or file epoch differs), drop the in-memory seed and
    // durably reset the record: consumedOffset 0 paired with the new epoch is
    // the tracker's sanctioned regression (epoch-reset arbitration). Without
    // an epoch from the daemon (pre-epoch fs.stat) the durable write is
    // skipped — the in-memory reset still unblocks this process lifetime.
    if (typeof streamEvidence !== 'string' && session._consumedOffset >= 0) {
      try {
        const { isStaleWatermark } = await import('../core/session-reconcile.js')
        if (isStaleWatermark(record, streamEvidence)) {
          log.session.warn('attachToExisting: consumedOffset belongs to a dead stream-file incarnation — resetting watermark', {
            sessionId: record.claudeSessionId,
            staleConsumedOffset: session._consumedOffset,
            fileSize: streamEvidence.fileSize,
            recordEpoch: record.streamEpoch ?? null,
            fileEpoch: streamEvidence.streamEpoch ?? null,
          })
          session._consumedOffset = -1
          if (streamEvidence.streamEpoch && record.claudeSessionId) {
            const { updateSessionRecord } = await import('../core/session-tracker.js')
            await updateSessionRecord(record.claudeSessionId, {
              consumedOffset: 0,
              streamEpoch: streamEvidence.streamEpoch,
            }).catch(() => {})
            record.consumedOffset = 0
            record.streamEpoch = streamEvidence.streamEpoch
          }
        }
      } catch (err) {
        log.session.warn('attachToExisting: stale-watermark check failed', {
          sessionId: record.claudeSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

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

    // ── Canonical-JSONL recovery REMOVED (2026-07-25) ──
    // This used to call recoverStateFromJsonl(), an UNBOUNDED full read of the
    // canonical JSONL, once per session on every attach. Measured cost: 533 reads
    // totalling 9.56 GB in one day, mean 18.4 MB, worst single file 118 MB — the
    // dominant driver of ~3 GB RSS within minutes of boot.
    //
    // It read all that to extract fields that DO NOT EXIST in the file. A census of
    // the six largest canonical JSONLs (42-231 MB) found `system/init` = 0,
    // `type:'result'` = 0 and `system/task_*` = 0 in every one — so model,
    // workStatus, bgTasks, cliSessionState and pendingControlRequest never came from
    // here on real data (see the stream-fold comment below, which already said so).
    // Everything it COULD extract has a better source that runs above:
    // record.model / record.mode (record was already authoritative — the recovered
    // mode was deliberately discarded) / record.planFile / record.planCompleted, all
    // persisted columns. jsonlByteLength was already unused.
    //
    // The one field with no persisted column, teamActive, now comes from the stream
    // fold below (fetchStreamTailFold folds TeamCreate/TeamDelete), which is
    // window-bounded at 256 KB-2 MB instead of unbounded.

    // ── Stream-tail state merge + authoritative downgrade ──
    // Runs OUTSIDE the canonical-recovery block above on purpose: the canonical
    // JSONL contains ZERO result/session_state/task_* events on real data (they
    // are stdout stream-json, captured only into the daemon stream file), and
    // canonical recovery can fail entirely — the stream evidence must still apply.
    if (typeof streamEvidence !== 'string') {
      const fold = streamEvidence.fold
      // Merge the fold's bg-task set on top of whatever canonical recovery seeded
      // (usually nothing). Terminal is terminal; isBackgrounded is sticky.
      for (const [taskId, t] of Object.entries(fold.bgTasks)) {
        const prev = session._bgTasks.get(taskId)
        const status = prev && ClaudeCodeSession._BG_TERMINAL_STATUSES.has(prev.status)
          ? prev.status : t.status
        session._bgTasks.set(taskId, {
          ...prev,
          status,
          isBackgrounded: t.isBackgrounded || prev?.isBackgrounded,
          // #870: the fold's level verdict rides along so a wedged hold stays
          // un-wedged across an attach (gating skips endedPerLevel entries).
          endedPerLevel: t.endedPerLevel || prev?.endedPerLevel,
        })
        if (t.endedPerLevel) session._bgSeenInLevel.add(taskId)
      }
      if (fold.cliState != null) {
        session._sessionStateSeen = true
        session._cliSessionState = fold.cliState
      }
      // teamActive from the stream fold (TeamCreate/TeamDelete). This is the only
      // piece of attach state with no persisted column, so the stream tail is its
      // sole surviving source once canonical recovery is gone. The team-idle
      // timeout (_maybeClearTeamActive) remains the safety net against a stuck
      // true — a fold that ends on TeamCreate can only ever over-report.
      if (fold.teamActive) session._teamActive = true
      // cronActive: re-arm the idle-kill protection across a walnut restart.
      // Window-scoped best-effort (a create in an earlier turn is outside the
      // tail window); the daemon's own full-file fold guards its reaper
      // independently, so a miss here only exposes the health-monitor path.
      if (fold.cronActive) session._cronArmed = true
      // If the fold shows non-backgrounded bg work still in flight, the turn is
      // genuinely live — mirror the canonical-recovery branch's running upgrade.
      if (session.hasActiveBackgroundWork() && session._processStatus !== 'running') {
        session._processStatus = 'running'
        session._activity = 'Background tasks running'
        log.session.info('attach: stream fold shows background work in flight — keeping running status', {
          sessionId: record.claudeSessionId,
          gatingBgCount: fold.gatingBgCount,
        })
      }
      // ── Authoritative DOWNGRADE (incidents ed81e36d + 10e7df54) ──
      // Every recovery _processStatus write is upward-only (→ 'running'). When the
      // true result landed exactly in the restart window, the record stays 'running'
      // forever — and the task can stay IN_PROGRESS — while the stream file proves
      // the turn ended. Converge both. (The pre-stream version gated this on
      // recovered.workStatus from the canonical JSONL, which never fired on real
      // data.) reconcileProcessStatus re-checks bg/team debt from the same fold and
      // no-ops unless the record or phase is genuinely stuck.
      if (fold.turnEnded) {
        try {
          const { reconcileProcessStatus } = await import('../core/session-reconcile.js')
          const outcome = await reconcileProcessStatus(record, {
            evidence: streamEvidence,
            teamActiveHint: session._teamActive && session._areTeammatesStillActive(),
          })
          if (outcome.converged) {
            if (outcome.to !== record.process_status) {
              session._processStatus = outcome.to
              record.process_status = outcome.to
            }
            session.resultEmitted = true
            // The verdict accounts for the whole folded file — adopt EOF as the
            // in-memory watermark too (the record write already did, monotonically),
            // so a daemon replay of this ended turn is positionally suppressed.
            if (streamEvidence.fileSize > session._consumedOffset) {
              session._consumedOffset = streamEvidence.fileSize
            }
          }
        } catch (err) {
          log.session.warn('attachToExisting: authoritative downgrade failed', {
            sessionId: record.claudeSessionId,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
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
    // fromOffset semantics: the daemon stream file is ~/.open-walnut/tmp/streams/<sid>.jsonl,
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
      // are byte positions in the STREAM file (~/.open-walnut/tmp/streams/<sid>.jsonl),
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
        fromOffset: fromOffset === Number.MAX_SAFE_INTEGER ? 'MAX_SAFE_INTEGER (skip replay)' : fromOffset,
      })
      try {
        const attachResult = await session._transport.attach({
          sessionId: record.claudeSessionId,
          fromOffset,
          mode: session._mode,
          onOutput: (event) => session.handleStreamLine(event.line, event.v),
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
        // Authoritative cross-check (incident a172ce49): the daemon's pendingCtrl
        // is the live truth for "is the CLI actually blocked on a permission?".
        // The CLI withdraws requests on abort/restart (control_cancel_request),
        // and record.pendingPermission historically never learned about it — so
        // Layer 2 can resurrect a request nobody can answer (respond → 404,
        // Waiting badge forever). Any recovered request the daemon does NOT
        // vouch for is stale: drop it, stop its re-emit timer, settle the UI,
        // and clear the persisted copy. Runs BEFORE pendingCtrl adoption so a
        // stale Layer-2 entry can't block adopting the daemon's genuine one.
        // Only runs when attach succeeded — on attach failure we keep the
        // fail-safe "stay pending for recovery" behavior.
        const authoritativeReqId = attachResult?.pendingCtrl?.reqId ?? null
        for (const staleId of [...session._pendingPermissionRequests.keys()]) {
          if (staleId === authoritativeReqId) continue
          const stale = session._pendingPermissionRequests.get(staleId)
          session._pendingPermissionRequests.delete(staleId)
          session._clearPermissionReEmitTimer(staleId)
          session._resolvedPermissionRequestIds.add(staleId)
          log.session.info('dropped stale recovered permission — daemon has no matching pendingCtrl', {
            sessionId: record.claudeSessionId,
            requestId: staleId,
            toolName: stale?.request.tool_name,
            daemonPendingReqId: authoritativeReqId,
          })
          bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
            sessionId: record.claudeSessionId,
            taskId: record.taskId,
            requestId: staleId,
            toolName: stale?.request.tool_name,
            allowed: false,
            cancelled: true,
          }, ['*'], { source: 'session-runner' })
        }
        if (record.pendingPermission && record.pendingPermission.requestId !== authoritativeReqId) {
          import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
            updateSessionRecord(record.claudeSessionId, { pendingPermission: undefined }),
          ).catch(() => {})
        }
        if (attachResult?.pendingCtrl && session._pendingPermissionRequests.size === 0) {
          const pc = attachResult.pendingCtrl
          const pcReq = pc.request as { subtype?: string; tool_name?: string; input?: Record<string, unknown>; decision_reason?: string }
          session._pendingPermissionRequests.set(pc.reqId, {
            request_id: pc.reqId,
            request: pcReq as { subtype: string; tool_name?: string; input?: Record<string, unknown>; decision_reason?: string },
          })
          session._startPermissionReEmitTimer(pc.reqId, pcReq as { subtype: string; tool_name?: string; input?: Record<string, unknown> })
          // Persist to the record too (incident fd089463, 2026-08-15): the
          // arrival-time persist lives in the control_request stream handler,
          // which never ran if the request landed while walnut was down or
          // restarting (deploy window). In-memory-only recovery left
          // record.pendingPermission empty → canonicalStatusProjection had no
          // pendingPermissionTool → no red Waiting badge on any list surface,
          // and the doctor's category-B exemption missed the session. The
          // daemon vouches for this request, so the record copy is authoritative.
          if (record.pendingPermission?.requestId !== pc.reqId) {
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(record.claudeSessionId, {
                pendingPermission: {
                  requestId: pc.reqId,
                  toolName: pc.toolName ?? pcReq.tool_name,
                  input: pcReq.input,
                  reason: pcReq.decision_reason,
                  subtype: pcReq.subtype ?? 'can_use_tool',
                  receivedAt: Number.isFinite(pc.receivedAt)
                    ? new Date(pc.receivedAt).toISOString()
                    : new Date().toISOString(),
                },
              }),
            ).catch(() => {})
          }
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
        // AskUserQuestion is EXEMPT from bypass auto-approve here too — same reason
        // as the live can_use_tool handler: auto-allowing sends empty `answers` and
        // the CLI tells the model the user answered nothing. Re-emit to the UI instead.
        if (session._mode === 'bypass' && autoApproveBypassed && pending.request.tool_name !== 'AskUserQuestion') {
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
    // A killed process can never settle its own turn — reject rather than let
    // a caller await forever (SessionRunner clears activeProcessing separately;
    // this only settles the ledger's promise for whoever is awaiting THIS turn).
    if (this.claudeSessionId) abortTurn(this.claudeSessionId, 'session-killed')
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
    // Fresh-turn reset ONLY on idle→running (a new turn actually starts).
    //
    // A MID-TURN injection (injectMidTurn → writeMessage while _processStatus is
    // already 'running') must NOT reset stream-dedup state: the current assistant
    // message is still streaming, and its final `assistant` JSONL line dedups
    // against the text the SSE path accumulated in _lastEmittedText. Wiping that
    // map mid-message makes the handler see previousText='' and re-emit the FULL
    // text — the "same paragraph rendered twice" bug (incident inc-1783315267620:
    // three injections at :07/:24/:35 each duplicated the assistant message that
    // completed seconds later). Keys are per-msgId (unique across turns), so
    // keeping them until the next idle→running reset is harmless.
    const isMidTurnInjection = this._processStatus === 'running'
    if (!isMidTurnInjection) {
      this._processStatus = 'running'  // Back to running from idle
      this._activity = undefined
      this.resultEmitted = false
      this._turnResultEmitted = false  // New turn starting — allow result emission
      this._expectedTeardown = false   // Live turn on this process — a stale teardown mark must not mask a real crash
      // ── THE QUEUED-SEND turn-start edge (incident ed347bde, 2026-08-05) ──
      // This FIFO write is a genuine idle→running turn-start, and for the most
      // common shape it is the EARLIEST evidence of the new turn: walnut queues
      // the message while turn A runs (processNext → writeMessage) and delivers
      // it the instant A's result lands. The line above resets
      // _turnResultEmitted BEFORE the CLI's `init` for turn B arrives, so the
      // init-after-result edge (gated on that flag) never fires for this shape —
      // and the CLI may emit no session_state_changed{running} either. Without a
      // bump here the stale-result gate in core/phase.ts fails OPEN: turn A's
      // ~800ms-late AGENT_COMPLETE flip carries eventGen == liveGen, passes the
      // strict `liveGen > eventGen` test, and repaints turn B as completed while
      // it visibly streams. Mid-turn injections deliberately skip this block —
      // they join the SAME turn and must not bump.
      this._turnGen++
      // #870 hand-off: the user moving on outranks a still-pending hold. A stale
      // withheld outcome must not settle the NEW turn (a withheld turn that reached
      // this reset already completed via idle/followup/reconcile, or its process
      // died — either way the outcome is spent). Mid-turn injections skip this
      // block, so an ACTIVE hold (status 'running') is never cleared here.
      this._deferredOutcome = undefined
      this._turnStartOffset = this._transport?.fileSize ?? 0  // Track where this turn's data begins
      this._askUserIntercepted = false
      this._sawApiTimeoutThisTurn = false
      this._toolInputFilePaths.clear()  // Fresh turn — clear stale cached tool input paths
      this._emittedStreamKeys.clear()   // Fresh turn — allow new events through dedup
      this._lastEmittedText.clear()     // Fresh turn — reset progressive delta tracking
      this._currentStreamMsgId = null   // Fresh turn — stream_event message tracking
      this._warnedUnknownTypes.clear()  // Fresh turn — reset unknown-event warn set
      // TTFT anchor: this FIFO write is the earliest turn-start evidence.
      this._turnStartTs = Date.now()
      this._firstThinkingTs = undefined
      this._firstTextTs = undefined
      this._firstToolTs = undefined
    }
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
   * Unlike interrupt(), this does NOT clean up FIFO or modify session state.
   * It settles process-bound control requests before stopping because the replacement
   * process cannot answer request IDs issued to the old transport.
   *
   * THIS IS CRITICAL: Without graceful stop, send() would SIGTERM the old process,
   * which doesn't give Claude Code time to flush session state. Then --resume fails,
   * creates a new session with a different ID, and activeProcessing gets permanently stuck.
   */
  async gracefulStop(suppressExit = false): Promise<void> {
    if (!this._transport) return
    if (suppressExit) {
      this.resultEmitted = true
      this.stopMonitoring()
    }
    this._rejectAllSideQuestions(Object.assign(new Error('session transport replaced'), {
      code: 'SESSION_TRANSPORT_REPLACED',
    }))
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
    this._deferredOutcome = undefined // #870: a cancelled hold never settles later
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

  /**
   * Mark this session's imminent death as intentional (task marked done, capacity
   * eviction, idle timeout). Callers that signal the CLI directly — i.e. WITHOUT
   * going through interrupt()/gracefulStop(), which already suppress the death path
   * via resultEmitted — must call this FIRST, so the liveness monitor logs the exit
   * as expected instead of raising an error notification.
   */
  markExpectedTeardown(reason: string): void {
    this._expectedTeardown = true
    log.session.debug('session teardown expected', { taskId: this.taskId, sessionId: this.claudeSessionId ?? undefined, reason })
  }

  /** Reject + clear any in-flight side questions (e.g. on session teardown) so the
   *  drawer's promise settles instead of hanging until its own timeout. */
  private _rejectAllSideQuestions(reason: string | Error): void {
    const error = reason instanceof Error ? reason : new Error(reason)
    for (const pending of this._pendingSideQuestions.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pendingSideQuestions.clear()
    // Also settle any ACK-only control_requests (effort switches) so their
    // promises don't hang until their own timeout on teardown.
    for (const pending of this._pendingControlAcks.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pendingControlAcks.clear()
    // Ordinary payload reads settle to null on teardown; strict callers such
    // as set_permission_mode reject through their per-request wrapper.
    for (const pending of this._pendingPayloadReads.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this._pendingPayloadReads.clear()
    // The model catalog is a property of the CLI PROCESS (its settings snapshot
    // at spawn) — a respawn/cold-resume may see different settings, so drop it
    // here; the new process's init event triggers the eager refetch + push.
    this._transportGeneration++
    this._modelCatalog = null
    this._modelCatalogInflight = null
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

    // Diagnostics for the death. For local sessions, read stderr from the .err file
    // on disk; for remote sessions the local path doesn't exist — use _exitStderr
    // from the daemon exit event.
    let initStderr = ''
    if (this._outputFile) {
      try {
        initStderr = fs.readFileSync(this._outputFile + '.err', 'utf-8').slice(0, 2048).trim()
      } catch { /* no stderr file (expected for remote sessions) */ }
    }
    if (!initStderr && this._exitStderr) {
      initStderr = this._exitStderr.slice(0, 2048)
    }
    initStderr = stripCliStartupNoise(initStderr)
    // A death only means "init failed" while sessionReady is still unsettled. Once
    // the id is known (init line seen, or pre-assigned + persisted) this is the
    // ordinary end of a long-lived CLI — and if WE asked for it (task completion,
    // capacity eviction, idle timeout) it isn't even noteworthy. Reporting those as
    // an init failure fired a red toast quoting stale spawn-time stderr every time
    // the user marked a task done (2026-08-10).
    const wasInitFailure = !this._sessionReadySettled
    const parts = [wasInitFailure ? 'process died before session init' : 'session process exited']
    if (this._host) parts.push(`[SSH → ${this._host}]`)
    if (this._exitCode !== null) parts.push(`[exit code: ${this._exitCode}]`)
    if (this.pid) parts.push(`[pid: ${this.pid}]`)
    if (initStderr) parts.push(`stderr: ${initStderr}`)
    else parts.push('(no stderr captured)')
    const errMsg = parts.join(' ')
    const deathMeta = {
      taskId: this.taskId,
      sessionId: this.claudeSessionId ?? undefined,
      pid: this.pid,
      exitCode: this._exitCode,
      host: this._host,
      stderr: initStderr || undefined,
      outputFile: this._outputFile,
      timeSinceSpawnMs: this._spawnTs ? Date.now() - this._spawnTs : undefined,
    }
    if (wasInitFailure) {
      log.session.error('session init failed — process died before init event', deathMeta)
    } else if (this._expectedTeardown) {
      log.session.info('session process exited (expected teardown)', deathMeta)
    } else {
      // Unexpected death of an initialized session: real signal, but not an
      // init failure. warn (not error) so it doesn't toast — the session's own
      // status/errorMessage already surfaces it in the session panel.
      log.session.warn('session process exited unexpectedly after init', deathMeta)
    }
    // Idempotent no-op when sessionReady already resolved.
    this._rejectSessionReady(new Error(errMsg))

    // If no result was emitted by the tailer, determine fallback behavior.
    if (!this.resultEmitted && !this._turnResultEmitted) {
      const { hasResult: hasResultInFile, errorMessage: resultErrorMessage } = this._outputFile
        ? outputFileCheckResult(this._outputFile, this._turnStartOffset)
        : { hasResult: false, errorMessage: undefined }

      this.resultEmitted = true
      this._turnResultEmitted = true
      // Process death ends the turn without running the result case — close the
      // delivery stretch so partial streamed text can't suppress the next turn's
      // result-text fallback (#858). Every branch below is terminal for this turn.
      this._emittedAssistantText = false

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
          turnGen: this._turnGen,
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
            turnGen: this._turnGen,
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
    // The daemon replays the CLI's spawn-time `.err` file on death, so startup
    // advisories arrive here as if they caused the exit. Strip them before they
    // can be quoted as a death reason (2026-08-10: marking a task done killed the
    // CLI we spawned, and the managed-settings advisory it printed at startup was
    // reported as "Session Error" on a turn that had already succeeded).
    const cleanStderr = stderr ? stripCliStartupNoise(stderr) : ''

    // A teardown WE asked for (task completed, capacity eviction, idle timeout) is
    // not an error, regardless of the CLI's exit code — SIGINT surfaces as -1 here.
    if (this._expectedTeardown) {
      this._active = false
      this._processStatus = 'stopped'
      this._activity = undefined
      this.pid = null
      log.session.info('remote session process exited (expected teardown)', {
        taskId: this.taskId,
        sessionId: this.claudeSessionId,
        exitCode: code,
        host: this._host,
        stderr: cleanStderr.slice(0, 200) || undefined,
      })
      if (this.claudeSessionId) {
        const sid = this.claudeSessionId
        import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
          updateSessionRecord(sid, {
            process_status: 'stopped',
            status_reason: 'expected_teardown',
            status_changed_by: 'system',
            pid: undefined,
          } as Record<string, unknown>),
        ).catch((err) => {
          log.session.warn('failed to persist expected teardown', { sessionId: sid, error: String(err) })
        })
      }
      this.emitStatusChanged('AGENT_COMPLETE')
      return
    }

    // Unexpected exit whose ONLY stderr was startup noise: still not something the
    // user can act on, and the turn already produced its result. Keep it out of the
    // error channel (which toasts) but log it as a warning — a real signal, just not
    // an error the user must see.
    //
    // EXIT CODE STILL DECIDES. The advisory is written at spawn and replayed on
    // death, so its presence says nothing about WHY the process exited: a 127
    // (`claude` missing from the remote PATH) prints the same advisory and nothing
    // else, and silencing that turned an actionable "CLI not found" into a session
    // that looks quietly finished. Only a code that is plausibly a clean or
    // signalled stop may be suppressed; a real failure code falls through to the
    // error path.
    const suppressibleExit = code === 0 || code === -1 || code === 143 || code === 130
    if (!cleanStderr && stderr && suppressibleExit) {
      this._active = false
      this._processStatus = 'stopped'
      this._activity = undefined
      this.pid = null
      log.session.warn('remote session exited with only CLI startup advisories', {
        taskId: this.taskId,
        sessionId: this.claudeSessionId,
        exitCode: code,
        host: this._host,
        suppressedStderr: stderr.slice(0, 200),
      })
      this.emitStatusChanged('AGENT_COMPLETE')
      return
    }

    const parts: string[] = []
    if (code === 127) {
      parts.push(this._host ? 'Claude CLI not found on remote host' : 'Claude CLI not found')
    } else {
      // "Remote" ONLY when there is an actual remote host — the __local__ daemon
      // takes this path too, and telling a local user to "check remote host
      // configuration" sent them to the wrong settings page (2026-08-10).
      parts.push(this._host
        ? `Remote session exited with code ${code}`
        : `Session process exited with code ${code}`)
    }
    if (this._host) parts.push(`[${this._host}]`)
    if (cleanStderr) parts.push(cleanStderr.slice(0, 500))
    const errMsg = parts.join(' — ')

    log.session.error('remote session process exited with error', {
      taskId: this.taskId,
      sessionId: this.claudeSessionId,
      exitCode: code,
      host: this._host,
      stderr: cleanStderr.slice(0, 200) || undefined,
    })

    this._active = false
    this._processStatus = 'error'
    this._activity = undefined
    this.pid = null

    // Persist error state to session record. "No conversation found" in stderr
    // means a cold `--resume` of an id the CLI never persisted (e.g. the
    // original spawn died before its first turn) — that session can NEVER
    // revive, so archive it like the other two conversation-lost paths do.
    // Without this a lane-bound record wedges its conversation forever:
    // getSessionByLane keeps returning the corpse and every send replays the
    // same doomed resume (observed 2026-08-15, mentor lane).
    //
    // The archive rides its OWN patch, deliberately separate from the status
    // write below: that one carries the ('system','daemon_reported_exit')
    // category-① pair, which the C2 snapshot gate drops WHOLESALE in enforce
    // mode — an archive folded into it silently never lands.
    const conversationLost = cleanStderr.includes('No conversation found')
    if (this.claudeSessionId) {
      const sid = this.claudeSessionId
      import('../core/session-tracker.js').then(async ({ updateSessionRecord }) => {
        if (conversationLost) {
          await updateSessionRecord(sid, {
            archived: true,
            archive_reason: 'remote_conversation_lost',
            errorMessage: errMsg,
          } as Record<string, unknown>)
        }
        await updateSessionRecord(sid, {
          process_status: 'error',
          errorMessage: errMsg,
          status_reason: 'daemon_reported_exit',
          status_changed_by: 'system',
          pid: undefined,
        } as Record<string, unknown>)
      }).catch((err) => {
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
   *
   * Pass `streaming: true` for PARTIAL text (per-delta rewrites): paths that
   * touch the chunk edges are skipped — a path split across two deltas would
   * otherwise be rewritten as two bogus standalone paths, permanently
   * corrupting fullText/history.
   */
  private rewriteRemoteImages(text: string, opts?: { streaming?: boolean }): string {
    if (!this._transport?.isRemote) return text
    const sessionId = this.claudeSessionId ?? 'unknown'
    return this._transport.processInbound(text, sessionId, this._cwd ?? undefined, opts)
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

  private handleStreamLine(line: string, v?: number): void {
    // L1 versioned-event position of THIS line (byte offset at end-of-line in the
    // daemon stream file). Held for the duration of this synchronous call so the
    // result/idle handlers can compare it against the consumed watermark and
    // advance it on turn completion. Undefined on old daemons without `v`.
    this._currentEventV = v
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
            // ── init-after-result IS a turn-start edge (incident ed347bde, 2026-08-05) ──
            // The CLI can pick up a queued mid-turn send the instant the previous
            // turn's result lands (128ms in that incident) WITHOUT ever going idle,
            // so it emits NO session_state_changed{running} — the state-running
            // pullback below never fires for this shape. This init is then the only
            // CLI-side evidence a new turn began: the result handler had just set
            // _processStatus='idle' and the server's ~800ms-late SESSION_RESULT
            // handler flips the phase to AGENT_COMPLETE, so the badge reads Idle and
            // the task row reads completed/attention while the CLI is visibly
            // streaming (44s in that incident; 185 same-shape divergences that day).
            // Auto-continuation / post-compaction inits take this path too — also
            // "actively working", also correct to show as running. (When walnut
            // itself delivered the send, writeMessage already bumped the generation
            // — a second bump for the same turn is harmless, see _turnGen.)
            //
            // Replay guard mirrors the state-running branch: a replayed init (daemon
            // reattach re-streams history) describes a PAST turn and must not flip
            // the present status/phase, nor bump the generation.
            if (this._isReplayedByOffset() !== true) {
              this._onTurnStartEdge('init-after-result', true, sys.session_id as string)
            } else {
              log.session.info('ignoring replayed init-after-result (at/below consumed watermark)', {
                sessionId: this.claudeSessionId, taskId: this.taskId,
                v: this._currentEventV, consumedOffset: this._consumedOffset,
              })
            }
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
          if (oldSessionId && oldSessionId !== newId) this._priorSessionIds.add(oldSessionId)
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
            // Model changed across a resume (e.g. /model) — the old model's raw
            // window must not survive as the new model's context% denominator.
            if (this._initModel && this._initModel !== rawModel) this._cliRawContextWindow = undefined
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

          // Session-start settings read-back (once per live process). Fire slightly
          // deferred so the CLI has finished wiring its ask() loop before we send a
          // control_request. Fire-and-forget; getSettings() returns null (no-op) if
          // the CLI isn't ready or is an old build. This seeds effectiveEffort (and
          // reconciles a stale model) so the badge is correct from the first render.
          if (!this._initEffortRead) {
            this._initEffortRead = true
            setTimeout(() => {
              void this.refreshAppliedSettings('session-start')
              // Also seed the CLI's effective context window (context% denominator).
              this.seedCliContextWindow('session-start')
            }, 1500)
          }

          // Eager model-catalog fetch (ACP-style): pull list_models the moment a
          // fresh CLI process announces itself, instead of waiting for a picker
          // to open. getModelCatalog() is cache-guarded — init fires per TURN,
          // but only a fresh process (spawn/respawn nulls _modelCatalog) pays a
          // round-trip; every real fetch pushes SESSION_MODEL_CATALOG and writes
          // the host-level store from inside getModelCatalog itself. Same 1.5s
          // deferral as the settings read-back: the CLI must finish wiring its
          // ask() loop before control_requests get answered.
          if (!this._modelCatalog && !this._modelCatalogInflight) {
            setTimeout(() => { void this.getModelCatalog().catch(() => {}) }, 1500)
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
                // consumedOffset MUST reset on a sid change: the watermark is a byte
                // position in the OLD sid's stream file; the new sid gets a new file
                // with its own coordinates, so carrying the old number over could
                // positionally suppress the new session's very first real results.
                this._consumedOffset = -1
                const renamed = await renameSessionId(expectedId, newId, {
                  outputFile: this._outputFile ?? undefined,
                  pid: this.pid ?? undefined,
                  consumedOffset: undefined,
                })
                if (!renamed) {
                  // Original record not found — fall back to creating a fresh record
                  await this.persistSessionRecord(newId, this._cwd ?? undefined)
                }
                // Move any still-queued messages to the new identity. Without
                // this, rows enqueued against the OLD id strand forever: the
                // old record no longer resolves, so every startup recovery
                // retries them into "No active session found" (inc-2026-08-10:
                // one message stuck 27 days). Mirrors the ACP identity
                // migration's queue move.
                await migrateSessionQueue(expectedId, newId)
              } else {
                await this.persistSessionRecord(newId, this._cwd ?? undefined)
              }
              // Write model after persist — record is guaranteed to exist now
              if (initModel) {
                const { updateSessionRecord } = await import('../core/session-tracker.js')
                await updateSessionRecord(newId, { model: initModel })
              }
              this.emitStatusChanged('IN_PROGRESS')
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
        }

        // ── MCP mount health (init only) ──
        // The CLI lists ONLY the servers it accepted. A server refused by machine
        // policy is absent entirely and the refusal goes to stderr, which we
        // deliberately treat as startup noise — so the mount used to die in
        // silence and the UI hardcoded a guess. Record the real per-server
        // verdict instead, marking anything we requested but init omitted as
        // 'blocked'. Read-only bookkeeping: nothing here changes session state.
        if (sys.subtype === 'init' && this._requestedMcpServers.length > 0) {
          const status = reconcileMcpMountStatus(
            this._requestedMcpServers,
            sys.mcp_servers as { name?: string; status?: string }[] | undefined,
          )
          // 'pending' is the CLI still finishing its MCP handshake, NOT a failure:
          // init fires before the server answers, and the tools work moments later
          // (verified 2026-08-16 — a lane reporting 'pending' successfully called
          // mcp__walnut__walnut_status in the same turn). Warning on it produced a
          // false alarm on every healthy mount, so only genuinely bad states warn.
          const degraded = Object.entries(status).filter(
            ([, v]) => v !== 'connected' && v !== 'pending',
          )
          if (degraded.length > 0) {
            log.session.warn('MCP mount did not come up', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
              mcpMountStatus: status,
              hint: degraded.some(([, v]) => v === 'blocked')
                ? 'server absent from init — refused before startup (machine policy blocks it); the session falls back to the walnut CLI'
                : undefined,
            })
          }
          if (this.claudeSessionId) {
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(this.claudeSessionId!, { mcpMountStatus: status }).catch(() => {}),
            ).catch(() => {})
          }
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
            // Post-compact authoritative usage pull (ACP Phase 2): the badge's
            // context% still shows the PRE-compact numerator until the next
            // assistant usage arrives — which on an idle session is never. Ask
            // the CLI directly (same source as /context) and push the corrected
            // figure. Fire-and-forget: an unreadable CLI keeps the stale badge,
            // strictly no worse than before.
            void this.getContextUsage().then((cu) => {
              if (!cu || cu.totalTokens == null || !this.claudeSessionId) return
              if (cu.maxTokens && cu.maxTokens > 0) this._cliContextWindow = cu.maxTokens
              const windowSize = this.contextWindowForPercent(cu.totalTokens)
              bus.emit(EventNames.SESSION_USAGE_UPDATE, {
                sessionId: this.claudeSessionId,
                model: this._model,
                contextPercent: Math.round(cu.totalTokens / windowSize * 100),
                inputTokens: cu.totalTokens,
              }, ['main-ai'], { source: 'session-runner' })
              log.session.info('post-compact context usage re-seeded from CLI', {
                sessionId: this.claudeSessionId, taskId: this.taskId,
                totalTokens: cu.totalTokens, maxTokens: cu.maxTokens,
              })
            }).catch(() => {})
          } else if (sys.subtype === 'scheduled_task_fire') {
            // Daemon-appended marker (checkCronFires): a CLI cron fired into
            // this session. Foreign fires (cron_foreign) mean the directory-
            // scoped scheduler lock adopted ANOTHER session's task — surface
            // loudly so the user knows the turn wasn't started by them.
            const foreign = sys.cron_foreign === true
            bus.emit(EventNames.SESSION_SYSTEM_EVENT, {
              sessionId: sid, taskId: this.taskId,
              variant: foreign ? 'error' as const : 'info' as const,
              message: String(sys.content || 'Scheduled task fired'),
            }, ['main-ai'], { source: 'session-runner', urgency: foreign ? 'urgent' : undefined })
            log.session[foreign ? 'warn' : 'info']('scheduled task fired into session', {
              sessionId: sid, taskId: this.taskId,
              cronTaskId: sys.cron_task_id, createdBy: sys.cron_created_by, foreign,
            })
            // Structured hook event (→ onCronFired) beside the display emit.
            bus.emit(EventNames.SESSION_CRON_FIRED, {
              sessionId: sid, taskId: this.taskId,
              cronTaskId: sys.cron_task_id ? String(sys.cron_task_id) : undefined,
              createdBySessionId: sys.cron_created_by ? String(sys.cron_created_by) : undefined,
              foreign,
            }, ['main-ai'], { source: 'session-runner' })
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
          } else if (sys.subtype === 'api_timeout') {
            // CLI marked an upstream API timeout for this turn. Remember it so the
            // result handler can stamp retryExhausted even when the final error
            // text is generic (feeds session-auto-continue).
            this._sawApiTimeoutThisTurn = true
            log.session.warn('CLI reported upstream API timeout marker', {
              sessionId: sid, taskId: this.taskId,
            })
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
            // (→ false await_human). So idle completes the turn ONLY when no task in the set
            // is still running (`!hasActiveBackgroundWork()`). The task set is authoritative;
            // idle is just the signal that, IF nothing is in flight, the turn is over.
            // 'running' keeps us active; 'requires_action' = paused on a
            // permission/AskUserQuestion prompt (NOT done).
            this._sessionStateSeen = true
            const newState = sys.state as 'running' | 'idle' | 'requires_action' | undefined
            this._cliSessionState = newState
            log.session.info('session_state_changed', {
              sessionId: sid, taskId: this.taskId, state: newState,
              runningBgTasks: this._runningBgCount(), idleDebt: this._idleDebt,
            })
            if (newState === 'running') {
              // Positional replay guard — same P3 rule as the idle branch below.
              // A replayed running (daemon reattach re-streams history) describes
              // a PAST turn; without this guard it flips a settled record back to
              // 'running' while the matching replayed idle is (correctly) ignored
              // by its own guard — a one-way door into a false "Running".
              if (this._isReplayedByOffset() === true) {
                log.session.info('ignoring replayed running (at/below consumed watermark)', {
                  sessionId: sid, taskId: this.taskId,
                  v: this._currentEventV, consumedOffset: this._consumedOffset,
                })
                break
              }
              // The CLI's explicit turn-start signal. Same semantic edge as the
              // init-after-result branch above — one shared implementation
              // (_onTurnStartEdge): bump the generation, flip + PERSIST 'running',
              // pull the task phase back to IN_PROGRESS. Persisting matters here
              // because this event also fires for turns started by messages injected
              // directly into the daemon's FIFO (e.g. phone → cloud bridge → daemon),
              // which never go through this class's own writeMessage(); without it
              // process_status stays on whatever the PREVIOUS turn left behind
              // (idle/error/stopped) for the whole new turn, since the only other
              // writer is the SESSION_RESULT/SESSION_ERROR handler at turn-END.
              // A second bump for a turn walnut itself delivered is harmless — the
              // counter is "turn-start edges seen", see _turnGen.
              this._onTurnStartEdge('state-running', true, sid)
            } else if (newState === 'idle') {
              // Idle-debt consumption: every idle settles an owed companion first
              // (FIFO stream order guarantees a result's companion idle arrives
              // before any later turn's events, so this accounting is exact within
              // one instance's continuous stream — see _idleDebt doc). Whether this
              // idle may COMPLETE a turn is decided below; a debt-consuming idle
              // never may (it belongs to the already-completed previous turn).
              // Positional replay guard (P3): an idle at/below the consumed watermark
              // belongs to a turn this server already completed — a daemon replay
              // after restart/reattach. It must never trigger a turn-over for the
              // CURRENT turn (deterministic version of what idle-debt catches
              // heuristically). Status bookkeeping is skipped too: the replayed
              // idle describes a past moment, not the present.
              if (this._isReplayedByOffset() === true) {
                log.session.info('ignoring replayed idle (at/below consumed watermark)', {
                  sessionId: sid, taskId: this.taskId,
                  v: this._currentEventV, consumedOffset: this._consumedOffset,
                })
                break
              }
              const wasCompanionIdle = this._idleDebt > 0
              if (wasCompanionIdle) this._idleDebt--
              // The idle handler only withholds completion while the derived count says
              // background work is in flight. A genuinely lost terminal event is backstopped by
              // process-death turn completion + the daemon idle-kill, not by an inline reconcile
              // here (see the comment block above hasActiveBackgroundWork).
              if (this.hasActiveBackgroundWork()) {
                // Mid-workflow idle: a task in the set is still running. NOT turn-over —
                // do NOT complete. Stay running; the real end-of-workflow idle (once every
                // task is terminal) completes below.
                log.session.info('idle while background work in flight — staying running, awaiting drain', {
                  sessionId: sid, taskId: this.taskId, runningBgTasks: this._runningBgCount(),
                })
                if (this._processStatus !== 'running') {
                  this._processStatus = 'running'
                  this._activity = this._workflowName ? `Workflow: ${this._workflowName}` : 'Background tasks running'
                  this.emitStatusChanged('IN_PROGRESS')
                }
              } else if (!this.resultEmitted && this._turnResultEmitted) {
                // result already processed this turn (normal single-turn path) — nothing to do.
              } else if (wasCompanionIdle) {
                // The PREVIOUS turn's companion idle (its result already completed
                // that turn and banked this debt). Never a turn-over for the
                // CURRENT turn — even though writeMessage() has since reset
                // _turnResultEmitted. Pre-debt, this exact race completed a brand-new
                // turn with zero output (premature-idle family). Status untouched:
                // if a new turn is already running, it stays running.
                log.session.info('companion idle consumed by idle-debt — not a turn-over', {
                  sessionId: sid, taskId: this.taskId, idleDebtRemaining: this._idleDebt,
                })
              } else if (!this.resultEmitted) {
                // Authoritative turn-over: idle AND no background work in flight.
                this._completeTurnOnIdle()
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
            // Idempotent: just record the task as 'running' in the authoritative set. A
            // replayed task_started (daemon restart) overwrites with the same status — no
            // double-count, because in-flight is DERIVED from the set, not accumulated.
            const taskId = sys.task_id as string | undefined
            if (taskId) {
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
              const prevStarted = this._bgTasks.get(taskId)
              // Terminal is terminal: never let an out-of-order / replayed task_started
              // revive a task that already reached a terminal status.
              const startedStatus = prevStarted && ClaudeCodeSession._BG_TERMINAL_STATUSES.has(prevStarted.status)
                ? prevStarted.status : 'running'
              this._bgTasks.set(taskId, {
                ...prevStarted,
                description: sys.description as string | undefined,
                subagentType: sys.subagent_type as string | undefined,
                taskType: (sys.task_type as string | undefined) ?? prevStarted?.taskType,
                status: startedStatus,
                workflowName,
                // Today the CLI flags backgrounding via a later task_updated patch, but
                // read it here too in case a future CLI stamps it at start. Never
                // un-background: keep a previously-recorded true.
                isBackgrounded: sys.is_backgrounded === true || prevStarted?.isBackgrounded,
              })
              if (this._processStatus !== 'running') {
                this._processStatus = 'running'
                this._activity = workflowName ? `Workflow: ${workflowName}` : 'Background task running'
              }
              this._emitBackgroundTasksUpdate(sid)
            }
          } else if (sys.subtype === 'task_progress') {
            // Heartbeat — refresh the task set + UI.
            const taskId = sys.task_id as string | undefined
            // Dynamic-workflow per-subagent breakdown rides on task_progress in the
            // `workflow_progress` array — accumulate it (the CLI sends only the currently
            // active agents per snapshot). This is the data behind the rich progress panel.
            const wp = sys.workflow_progress as unknown[] | undefined
            const ingestedWorkflow = Array.isArray(wp) && wp.length > 0
            if (ingestedWorkflow) this._ingestWorkflowProgress(wp as unknown[])
            if (taskId) {
              const prev = this._bgTasks.get(taskId) ?? { status: 'running' }
              const usage = sys.usage as { total_tokens?: number } | undefined
              // Terminal is terminal: a late progress event must NOT revive a finished task.
              const progressStatus = ClaudeCodeSession._BG_TERMINAL_STATUSES.has(prev.status)
                ? prev.status : 'running'
              this._bgTasks.set(taskId, {
                ...prev,
                description: (sys.description as string | undefined) ?? prev.description,
                subagentType: (sys.subagent_type as string | undefined) ?? prev.subagentType,
                status: progressStatus,
                tokens: usage?.total_tokens ?? prev.tokens,
                lastTool: (sys.last_tool_name as string | undefined) ?? prev.lastTool,
                summary: (sys.summary as string | undefined) ?? prev.summary,
              })
            }
            // Emit if EITHER bookkeeping ran — a workflow_progress snapshot without a
            // task_id must still push the accumulated agents to the panel.
            if (taskId || ingestedWorkflow) this._emitBackgroundTasksUpdate(sid)
          } else if (sys.subtype === 'task_updated') {
            // Status patch — merge into the task set. If patch.status is terminal, this is
            // ALSO a terminal bookend (newer CLIs emit it BEFORE the matching
            // task_notification). No counter to touch: in-flight is derived from the set, so
            // simply recording the terminal status here is correct AND idempotent with the
            // later notification. (Pre-fix this exact ordering wedged incident inc-…afr3cs.)
            const taskId = sys.task_id as string | undefined
            const patch = sys.patch as Record<string, unknown> | undefined
            if (taskId && patch) {
              const prev = this._bgTasks.get(taskId) ?? { status: 'running' }
              const patchStatus = patch.status as string | undefined
              const nextStatus = patchStatus ?? prev.status
              // is_backgrounded (incident 07fffbe5): the CLI detaches this task from its
              // turn — it will emit result+idle without waiting for it, and the task may
              // NEVER get a terminal event. Dropping this field made hasActiveBackgroundWork()
              // gate turn-over on a task the CLI itself doesn't wait for → stuck "Running".
              // Sticky true: never un-background (no CLI path un-backgrounds a task).
              const isBackgrounded = patch.is_backgrounded === true || prev.isBackgrounded
              this._bgTasks.set(taskId, {
                ...prev,
                status: nextStatus,
                description: (patch.description as string | undefined) ?? prev.description,
                isBackgrounded,
              })
              if (patch.is_backgrounded === true && !prev.isBackgrounded) {
                log.session.info('background task detached from turn (is_backgrounded)', {
                  sessionId: sid, taskId: this.taskId, bgTaskId: taskId,
                  remainingInFlight: this._runningBgCount(), via: 'task_updated',
                })
              }
              if (patchStatus && ClaudeCodeSession._BG_TERMINAL_STATUSES.has(patchStatus)) {
                log.session.info('background task terminal', {
                  sessionId: sid, taskId: this.taskId, bgTaskId: taskId, status: patchStatus,
                  remainingInFlight: this._runningBgCount(), via: 'task_updated',
                })
              }
              this._emitBackgroundTasksUpdate(sid)
            }
          } else if (sys.subtype === 'task_notification') {
            // Terminal bookend — task reached completed|failed|stopped. Just record the
            // status; in-flight is derived from the set, so this is idempotent whether or
            // not an earlier task_updated already reported the same terminal status.
            const taskId = sys.task_id as string | undefined
            const status = (sys.status as string | undefined) ?? 'completed'
            if (taskId) {
              const prev = this._bgTasks.get(taskId)
              this._bgTasks.set(taskId, { ...(prev ?? {}), status })
              log.session.info('background task terminal', {
                sessionId: sid, taskId: this.taskId, bgTaskId: taskId, status,
                remainingInFlight: this._runningBgCount(), via: 'task_notification',
              })
              this._emitBackgroundTasksUpdate(sid)
            }
          } else if (sys.subtype === 'background_tasks_changed') {
            // ── Level reconciliation (port of upstream ACP #870) ──
            // Replace-semantics snapshot of the CLI's OWN live background-task set
            // ({tasks:[{task_id,…}]}; verified shape on real streams — local_agent +
            // local_bash entries, empty array when everything drained). This is the
            // self-heal signal for the residual failure the derived count can't fix
            // alone: a task whose terminal bookends (task_updated/task_notification)
            // were ALL lost (SSH flap, daemon-restart gap) stays 'running' in _bgTasks
            // forever, wedging the withheld turn until the 2h idle-kill.
            //
            // Rules (each cost upstream a review round — don't simplify):
            //  • Universe guard: only a task the level has EVER listed may be
            //    absent-marked (_bgSeenInLevel). A live sync subagent is legitimately
            //    absent from level payloads (measured 4–9×/session on real streams),
            //    and a payload built before a spawn's registration would absent-mark
            //    a brand-new task — both are outside the level's proven universe.
            //  • Absent = endedPerLevel, NOT deleted and NOT status-rewritten: the
            //    entry stays for the UI/daemon-PULL; only turn-over gating stops
            //    waiting on it (see _runningBgCount). We never manufacture a
            //    'completed' status the CLI didn't report.
            //  • Reversible: a later level that lists the id again clears the mark
            //    (upstream's corrective-inclusive-level rescue).
            //  • Terminal entries are untouched (terminal is terminal).
            const levelTasks = Array.isArray(sys.tasks) ? sys.tasks as Array<Record<string, unknown>> : null
            if (levelTasks) {
              const present = new Set<string>()
              for (const t of levelTasks) {
                const id = t?.task_id
                if (typeof id !== 'string') continue
                present.add(id)
                this._bgSeenInLevel.add(id)
                const prev = this._bgTasks.get(id)
                if (prev?.endedPerLevel) {
                  this._bgTasks.set(id, { ...prev, endedPerLevel: undefined })
                }
                // A level entry for an id we've never seen a task_started for: record
                // it (level is CLI ground truth; the started event may have been lost).
                if (!prev) {
                  this._bgTasks.set(id, {
                    status: 'running',
                    description: t.description as string | undefined,
                    taskType: t.task_type as string | undefined,
                  })
                }
              }
              let marked = 0
              for (const [id, t] of this._bgTasks) {
                if (present.has(id)) continue
                if (!this._bgSeenInLevel.has(id)) continue // outside the level's proven universe
                if (ClaudeCodeSession._BG_TERMINAL_STATUSES.has(t.status)) continue
                if (!t.endedPerLevel) {
                  this._bgTasks.set(id, { ...t, endedPerLevel: true })
                  marked++
                }
              }
              if (marked > 0) {
                log.session.info('level reconcile: absent-marked tasks no longer in background_tasks_changed', {
                  sessionId: sid, taskId: this.taskId, marked,
                  remainingInFlight: this._runningBgCount(),
                })
              }
              this._emitBackgroundTasksUpdate(sid)
              // If the level just drained the last gating task and the CLI is already
              // idle with a withheld turn, complete it now — the drain idle already
              // passed and will not re-fire (the exact wedge this reconcile heals).
              if (this._runningBgCount() === 0 && !this.resultEmitted && !this._turnResultEmitted
                && this._cliSessionState === 'idle' && this._deferredOutcome) {
                log.session.info('level reconcile drained last gating task — completing withheld turn', {
                  sessionId: sid, taskId: this.taskId,
                })
                this._completeTurnOnIdle()
              }
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
        const subagentType = parentToolUseId ? (msg.subagent_type ?? undefined) : undefined
        const taskDescription = parentToolUseId ? (msg.task_description ?? undefined) : undefined
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

            // Rewrite remote image paths to local paths (no-op for local
            // sessions). This is a PARTIAL delta — edge-touching paths are
            // skipped so a path split across deltas isn't mangled.
            const rewrittenDelta = this.rewriteRemoteImages(deltaText, { streaming: true })
            // Subagent text must not leak into fullText — it becomes the turn's
            // result fallback, which should be the MAIN conversation only.
            if (!parentToolUseId && this.fullText.length < MAX_FULL_TEXT) {
              this.fullText += rewrittenDelta
            }
            // Main-lane answer delivered — the result-text fallback must stay off
            // for this turn. Recorded even past MAX_FULL_TEXT: the cap truncates
            // what we keep, it does not undo what the UI already rendered.
            if (!parentToolUseId) {
              this._emittedAssistantText = true
              this._stampFirstEmit('text')
            }
            log.session.debug('JSONL event: text-delta', { sessionId: this.claudeSessionId, taskId: this.taskId, parentToolUseId })
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: rewrittenDelta,
              ...(msgId ? { msgId } : {}),
              ...(parentToolUseId ? { parentToolUseId } : {}),
              ...(subagentType ? { subagentType } : {}),
              ...(taskDescription ? { taskDescription } : {}),
              ...(this._isReplayedByOffset() !== undefined ? { replayed: this._isReplayedByOffset() } : {}),
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

            // Cron detection — CronCreate/CronDelete tool_use. A cron-armed
            // session's /loop lives INSIDE the CLI process; the health
            // monitor's idle-timeout must not kill it between fires.
            // Optimistic arm on tool_use (before the result): over-report is
            // the safe direction — a validation-rejected create merely
            // extends the idle threshold, never blocks a kill forever.
            if (block.name === 'CronCreate' && block.id) {
              this._cronToolUseIds.add(block.id)
              this._cronArmed = true
              log.session.info('cron created — extending idle-kill protection', {
                sessionId: this.claudeSessionId, taskId: this.taskId, toolUseId: block.id,
              })
            }
            if (block.name === 'CronDelete') {
              const cronJobId = (block.input as Record<string, unknown>)?.id
              if (typeof cronJobId === 'string') this._cronJobIds.delete(cronJobId)
              if (this._cronJobIds.size === 0 && this._cronToolUseIds.size === 0) {
                this._cronArmed = false
                log.session.info('last cron deleted — resuming normal idle-kill thresholds', {
                  sessionId: this.claudeSessionId, taskId: this.taskId,
                })
              }
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

            // ── AskUserQuestion auto-intercept (only WITHOUT the permission prompt tool) ──
            // In -p (non-interactive) mode with no `--permission-prompt-tool`,
            // AskUserQuestion never reaches the user. Claude often calls it
            // repeatedly (7+ times), wasting tokens. Auto-inject a corrective
            // message once per turn so Claude stops trying.
            // Gated on !_permissionPromptEnabled: when the prompt tool IS active
            // (the default), the tool's control_request is forwarded to walnut and
            // rendered as a real question card, so the human DOES answer — telling
            // the model "the user cannot see AskUserQuestion" would then be a lie.
            // Registered in the unified hook registry as an inline intervention
            // ('askuserquestion-p-mode-correction') — enforcement stays here
            // because it needs the live control pipe + per-turn state; the
            // hooks.overrides toggle is honored via isInlineHookEnabled.
            if (block.name === 'AskUserQuestion' && !this._permissionPromptEnabled
              && !this._askUserIntercepted && this._transport?.hasPipe) {
              this._askUserIntercepted = true
              const correction = 'You are running in non-interactive (-p) mode. '
                + 'The user cannot see AskUserQuestion — it will always fail here. '
                + 'Instead, print your questions or assumptions directly in your text output, and wait for user response.'
              Promise.all([
                import('../core/config-manager.js').then(({ getConfig }) => getConfig()),
                import('../core/hooks/registry.js'),
              ]).then(([cfg, { isInlineHookEnabled }]) => {
                if (!isInlineHookEnabled('askuserquestion-p-mode-correction', cfg)) return undefined
                return Promise.resolve(this._transport?.writeMessage(correction)).then((injected) => {
                  log.session.info('auto-intercepted AskUserQuestion in -p mode', {
                    sessionId: this.claudeSessionId,
                    taskId: this.taskId,
                    injected: injected ?? false,
                  })
                })
              }).catch(() => {})
            }

            // For ExitPlanMode, resolve plan content: prefer captured Write content, fall back to input.plan
            const exitPlanContent = block.name === 'ExitPlanMode'
              ? (this._lastPlanWriteContent
                ?? (typeof block.input?.plan === 'string' && block.input.plan ? block.input.plan : null))
              : null

            if (!parentToolUseId) this._stampFirstEmit('tool')
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
              ...(subagentType ? { subagentType } : {}),
              ...(taskDescription ? { taskDescription } : {}),
              ...(this._isReplayedByOffset() !== undefined ? { replayed: this._isReplayedByOffset() } : {}),
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
            const contextWindowSize = this.contextWindowForPercent(totalInput)
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
        if (!Array.isArray(msg.message?.content)) {
          // Delivery-path-independent auto-title trigger: the daemon appends a
          // walnut-injected marker for EVERY injected message — including sends
          // that bypass this server's pipeline entirely (phone → cloud replica →
          // bridge → daemon FIFO write), which never emit SESSION_SEND and so
          // never reach the onMessageSend hook. Tailing the JSONL is the one
          // vantage point every path shares. Fire-and-forget; all placeholder/
          // attempt guards live inside.
          if (isWalnutInjected && this.claudeSessionId && this.taskId
              && typeof msg.message?.content === 'string') {
            const sid = this.claudeSessionId
            const tid = this.taskId
            const content = msg.message.content
            import('../core/session-hooks/builtins.js')
              .then(({ autoTitleFromObservedMessage }) => autoTitleFromObservedMessage(sid, tid, content))
              .catch(() => { /* titling is best-effort */ })
          }
          break
        }
        const userParentToolUseId = msg.parent_tool_use_id ?? undefined
        for (const block of msg.message.content) {
          if (block.type === 'tool_result') {
            // Resolve a pending CronCreate: adopt the CLI's job id (what
            // CronDelete takes) on success; on an error result drop the
            // optimistic arm so a rejected create doesn't extend thresholds.
            if (block.tool_use_id && this._cronToolUseIds.has(block.tool_use_id)) {
              this._cronToolUseIds.delete(block.tool_use_id)
              const isErr = (block as { is_error?: boolean }).is_error === true
              if (!isErr) {
                const tur = (msg as unknown as { tool_use_result?: { id?: unknown } }).tool_use_result
                // Fall back to the tool_use id so a shape change never drops an armed cron.
                this._cronJobIds.add(typeof tur?.id === 'string' ? tur.id : block.tool_use_id)
              } else if (this._cronJobIds.size === 0 && this._cronToolUseIds.size === 0) {
                this._cronArmed = false
              }
            }
            let resultContent: string
            // If the tool_result has image content blocks, use the cached file path
            // from the tool_use input instead of the base64 data. This keeps the
            // streaming pipeline lightweight — paths are short and the frontend's
            // findImagePaths() detects them and renders via /api/local-image.
            const hasImageBlocks = Array.isArray(block.content) && block.content.some((c) => (c as { type?: string }).type === 'image')
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

        // Harvest the CLI's raw context window (context% denominator) BEFORE any
        // early-exit guard: replayed/followup results carry a correct modelUsage
        // too, and this is pure bookkeeping with no turn-lifecycle effect.
        if (result.modelUsage) this.harvestRawContextWindow(result.modelUsage)

        // ── Positional replay guard (the watermark, P3) ──
        // A result at or below the consumed watermark was already processed TO
        // COMPLETION by this server (possibly a previous incarnation — the
        // watermark persists). Deterministic: position, not a boolean that a
        // restart can lose or a proxy can mis-seed. Intermediate workflow results
        // never advance the watermark, so replays of an UNFINISHED turn still
        // pass through here and hit the bg-work withhold below — correct.
        if (this._isReplayedByOffset() === true) {
          log.session.info('suppressing replayed result (at/below consumed watermark)', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            v: this._currentEventV, consumedOffset: this._consumedOffset,
          })
          this._turnResultEmitted = true
          break
        }

        // ── Task-notification-origin results (#870) — checked BEFORE the duplicate
        // guards. A followup result is not a turn-over, so it never sets
        // _turnResultEmitted; but when the hold already settled (drain idle / level
        // reconcile), _turnResultEmitted IS set and the guard below would swallow
        // the followup result — which is the only guaranteed closer of the followup
        // cycle (its running state pulled the status back to 'running', and its own
        // trailing idle can be lost). The positional watermark guard above still
        // runs first: a JSONL-replayed followup is suppressed by position.
        const resultOrigin = (event as { origin?: { kind?: string } }).origin
        const isTaskNotificationResult = resultOrigin?.kind === 'task-notification'
        if (isTaskNotificationResult) {
          log.session.info('result is task-notification origin — bookkeeping only, no turn-over', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
          })
          // Capture final text for display but do NOT complete the turn or set
          // _turnResultEmitted (a real result or idle still has to arrive).
          //
          // is_error guard (#870 hardening, upstream-confirmed defect): a FOLLOWUP's
          // error ("Please run /login", a failed notification turn) must never touch
          // the user turn's lifecycle — adopting its text here overwrote the answer
          // the user turn already streamed with followup error prose.
          if (!result.is_error && typeof result.result === 'string' && result.result) this.fullText = result.result
          // #870: settle the withheld turn at the followup's terminal result — the
          // promised summary has fully streamed by then (upstream's common case).
          // Waiting only for the trailing idle left a lost-idle wedge: the followup
          // result was the LAST event a flaky stream delivered. Guarded on the same
          // drain predicate as the idle lane so a followup that lands while OTHER
          // spawned tasks still run keeps the hold.
          if (this._deferredOutcome && this._runningBgCount() === 0
            && !this.resultEmitted && !this._turnResultEmitted) {
            log.session.info('followup result with all background work drained — completing withheld turn', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
            })
            this._completeTurnOnIdle()
            // The followup result's OWN companion idle is still in flight (upstream
            // #870 hardening: "the followup's trailing idle was un-owed"). If the
            // next user message lands before it, writeMessage resets
            // _turnResultEmitted and that idle would complete the brand-new turn
            // with zero output (#825 false-fail / premature-idle family). Bank it.
            this._idleDebt = Math.min(this._idleDebt + 1, 4)
          } else if (this._turnResultEmitted && this._runningBgCount() === 0
            && this._processStatus === 'running') {
            // Followup-cycle CLOSURE for an already-settled turn. When the hold
            // settled BEFORE the followup arrived (drain idle or level reconcile),
            // the followup's own session_state_changed{running} pulled the status
            // back to 'running' — and this origin-marked result is the only event
            // guaranteed to end that cycle (its trailing idle can be lost, and the
            // idle handler's already-completed branch was a no-op). Close the
            // status only: the turn's SESSION_RESULT already fired at the settle,
            // re-emitting it would double-run triage.
            log.session.info('followup result after settled turn — closing followup cycle to idle', {
              sessionId: this.claudeSessionId, taskId: this.taskId,
            })
            this._processStatus = 'idle'
            this._activity = undefined
            this.emitStatusChanged('AGENT_COMPLETE')
            this._idleDebt = Math.min(this._idleDebt + 1, 4)
          }
          break
        }

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
        if (this.resultEmitted && this._isReplayedByOffset() !== false) {
          // The boolean claims "already complete" AND the position doesn't refute it
          // (either genuinely at/below the watermark, or no positions available).
          //
          // The `!== false` clause is the incident-10e7df54 fix: when the event's v
          // is ABOVE the persisted watermark, this result was provably NEVER
          // processed — the boolean is lying (it was seeded from a task-phase proxy
          // that a disconnected-window reconciler had guessed wrong). Positional
          // evidence beats the boolean: let the result through and process it.
          //
          // INFO, not debug (same incident): at debug level this swallow was
          // invisible in prod logs — the one line that explained the wedge. Keep it
          // loud, with enough result metadata (turns/duration) to tell a genuine
          // replay (small, matches a past turn) from a swallowed real result.
          log.session.info('suppressing replayed result (session already complete)', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            numTurns: (result as { num_turns?: number }).num_turns,
            durationMs: (result as { duration_ms?: number }).duration_ms,
            isError: result.is_error === true,
            v: this._currentEventV, consumedOffset: this._consumedOffset,
          })
          this._turnResultEmitted = true
          break
        }
        if (this.resultEmitted) {
          // Positional override engaged: v > watermark proves this result is NEW.
          log.session.warn('resultEmitted=true but event v exceeds consumed watermark — processing as new result', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            v: this._currentEventV, consumedOffset: this._consumedOffset,
          })
          this.resultEmitted = false
        }

        // ── Background-work intermediate result (dynamic workflows) ──
        // A dynamic-workflow turn emits MANY `result` events: the main turn's own
        // result (often "Workflow launched in background...") PLUS one per background
        // subagent completion that the CLI feeds back into a fresh ask(). NONE of these
        // mean "session is done". The turn is over only at a session_state_changed{idle}
        // that arrives AFTER every task in the set is terminal — NOT at the first idle
        // (POC-verified: idle fires ~20×/run, between every sub-agent; see
        // [[claude_code_session_state_semantics]] and the session_state_changed handler).
        //
        // Two filters:
        //  (a) origin.kind === 'task-notification' → handled ABOVE the duplicate
        //      guards (see the task-notification block before them) — never a real
        //      turn-over, but it may settle or close a #870 hold.
        //  (b) the derived running-count shows live background tasks → withhold
        //      AGENT_COMPLETE; stay running. The idle-after-drain event completes it.
        if (this.hasActiveBackgroundWork()) {
          log.session.info('result while background work in flight — staying running, awaiting idle', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            runningBgTasks: this._runningBgCount(), cliState: this._cliSessionState,
          })
          if (typeof result.result === 'string' && result.result) this.fullText = result.result
          if (result.total_cost_usd !== undefined) this._lastResultCost = result.total_cost_usd
          // #870 (`Turn.deferredSettle`): record the withheld outcome so the turn later
          // completes WITH it. Pre-fix, the drain lane (_completeTurnOnIdle) hardcoded
          // isError:false — a turn whose own result was an ERROR, withheld because a
          // subagent was live, completed as a success and the failure vanished.
          this._deferredOutcome = {
            isError: result.is_error === true,
            resultText: typeof result.result === 'string' && result.result ? result.result : undefined,
            totalCost: result.total_cost_usd,
            duration: result.duration_ms,
          }
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
          if (this.claudeSessionId && this.claudeSessionId !== result.session_id) {
            this._priorSessionIds.add(this.claudeSessionId)
          }
          this.claudeSessionId = result.session_id
        }

        // Snapshot the delivery record BEFORE anything below can emit text of its
        // own, and clear it here so every exit from this case starts the next turn
        // clean. Clearing only at the bottom would leave the flag set on the early
        // `break` paths (soft-error / conversation-lost), and a following replayed
        // turn's fallback would be wrongly suppressed. The task-notification and
        // background-withhold branches returned earlier and deliberately do NOT
        // clear: they run alongside a user turn whose answer is still pending.
        const deliveredAssistantText = this._emittedAssistantText
        this._emittedAssistantText = false

        // Extract error messages from the result (e.g. "No conversation found with session ID: ...")
        let resultText = result.result ?? this.fullText
        const resultErrors = Array.isArray((result as { errors?: unknown }).errors)
          ? ((result as { errors?: string[] }).errors)
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
          // Idle-debt: the alive CLI emits this turn's companion
          // session_state_changed{idle} shortly after this result. If the next
          // user message lands first (writeMessage resets _turnResultEmitted),
          // that companion must not read as the NEW turn's turn-over. Capped so
          // a companion lost to a daemon-replay gap can only eat a bounded
          // number of future idles (see _idleDebt doc).
          this._idleDebt = Math.min(this._idleDebt + 1, 4)
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
        // This result was processed to completion — advance the consumed watermark
        // to its position so any future replay of it is positionally suppressed.
        // (Withheld intermediate results broke out earlier and never reach here.)
        this._advanceConsumedOffset()

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
          // TTFT: turn-start → first thinking/text/tool emit (null = never seen).
          firstThinkingMs: this._turnStartTs !== undefined && this._firstThinkingTs !== undefined
            ? this._firstThinkingTs - this._turnStartTs : null,
          firstTextMs: this._turnStartTs !== undefined && this._firstTextTs !== undefined
            ? this._firstTextTs - this._turnStartTs : null,
          firstToolMs: this._turnStartTs !== undefined && this._firstToolTs !== undefined
            ? this._firstToolTs - this._turnStartTs : null,
          teamActive: this._teamActive,
          backgroundActive: this.hasActiveBackgroundWork(),
        })

        // ── Result-text fallback: the turn answered on `result` alone ──
        // (upstream ACP issue #453 / fix #858, adapted). The `result` line is
        // normally a trailing COPY of text that already streamed, so forwarding it
        // unconditionally would render every answer twice. But a cache-replayed
        // turn generates no output tokens and some backends then skip streaming
        // entirely: no stream_event deltas, no consolidated `assistant` message —
        // only the `result`. The UI's session:result handler treats the event as a
        // pure turn boundary and never renders its text, and history parsing keeps
        // only user/assistant roles, so that answer was lost in BOTH surfaces and
        // the turn rendered empty.
        //
        // Two guards keep this to exactly the replayed lane:
        //  • !deliveredAssistantText — a turn that already showed its answer can
        //    never emit it a second time. This is the guard the naive
        //    "output_tokens === 0 && result" check lacks; upstream measured that
        //    version double-emitting, including when a mid-turn echo makes the
        //    consolidated message dedupe to nothing.
        //  • output_tokens === 0 — pins the fallback to the replay signature so a
        //    normal turn whose text somehow bypassed both delta paths still can't
        //    duplicate. `?? 0` because third-party backends have been observed
        //    omitting usage fields entirely, and the replay lane comes from exactly
        //    such a backend — a missing count reads as the replay signature rather
        //    than silently disabling the fallback.
        // Errors are excluded: an is_error result's text is already surfaced as the
        // error message (resultText feeds emitStatusChanged + SESSION_RESULT
        // isError), and re-emitting it as assistant prose would show it twice.
        // Task-notification and background-withheld results returned earlier.
        const needsResultTextFallback = !deliveredAssistantText
          && !effectiveIsError
          && typeof result.result === 'string'
          && result.result.trim().length > 0
          && (result.usage?.output_tokens ?? 0) === 0
        if (needsResultTextFallback && this.claudeSessionId) {
          const forwarded = this.rewriteRemoteImages(result.result)
          log.session.info('forwarding result text — turn emitted no assistant message', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            resultLength: forwarded.length,
            outputTokens: result.usage?.output_tokens,
            numTurns: result.num_turns,
          })
          // msgId ties the block to this turn's result so the render filter can
          // absorb it if a persisted twin ever appears; without one the block is
          // kept visible (never deleted) — the safe direction.
          const msgId = `result-fallback:${this.claudeSessionId}:${this._currentEventV ?? Date.now()}`
          if (this.fullText.length < MAX_FULL_TEXT) this.fullText += forwarded
          bus.emit(EventNames.SESSION_TEXT_DELTA, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            delta: forwarded,
            msgId,
          }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
        }

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
            turnGen: this._turnGen,
            result: resultText,
            totalCost: result.total_cost_usd,
            costDelta: this.billableCostDelta(result.total_cost_usd),
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
          // retryExhausted: terminal upstream retry-exhaustion signature. Text match
          // (shared with session-auto-continue — keep ONE signature list) covers the
          // CLI's timeout result texts; the api_timeout debug marker covers turns
          // whose final error text is generic. Feeds session-auto-continue.
          const retryExhausted = !!effectiveIsError && (
            matchesRetryExhaustion(resultText)
            || this._sawApiTimeoutThisTurn
          )
          bus.emit(EventNames.SESSION_RESULT, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            // Stamped at emit time; the server's phase flip compares it against the
            // live instance's CURRENT gen so a late flip can't repaint a newer turn
            // (incident ed347bde — see _turnGen).
            turnGen: this._turnGen,
            result: resultText,
            totalCost: result.total_cost_usd,
            costDelta: this.billableCostDelta(result.total_cost_usd),
            duration: result.duration_ms,
            isError: effectiveIsError ?? false,
            retryExhausted,
          }, ['main-ai', 'session-runner'], { source: 'session-runner' })
          // Turn-end read-back of the CLI's true settings (effort + model, fire-and-
          // forget). Same rationale as _completeTurnOnIdle: keep the badge in sync with
          // what the model actually used, which the CLI never pushes to us. Skipped for
          // team (intermediate) results above — only fires on real turn-over.
          void this.refreshAppliedSettings('turn-end')
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
          // AskUserQuestion is EXEMPT from bypass auto-approve. It is a
          // requiresUserInteraction tool whose result echoes `answers` from the
          // permission response's updatedInput, so auto-allowing hands the model a
          // fabricated "user answered your questions" with NO answers. Falling into
          // the else-branch below runs the ordinary emit-to-UI path (pending map +
          // persisted pendingPermission + re-emit timer + SESSION_PERMISSION_REQUEST)
          // so the human answers for real. Behavior for every other tool is unchanged.
          if (this._mode === 'bypass' && request.tool_name !== 'AskUserQuestion') {
            // Bypass mode: check auto_approve_bypass config (default: true).
            // Config read is async — use .then() since handleStreamLine is sync.
            // Add sentinel BEFORE async gap so hasPendingPermission is true during config read.
            this._pendingPermissionRequests.set(request_id, { request_id, request })
            import('../core/config-manager.js').then(({ getConfig }) => getConfig()).then(cfg => {
              if (!this._active) return  // Session killed during async gap — discard
              // Withdrawn during the async gap (control_cancel_request removed the
              // sentinel) — don't answer a request the CLI no longer has open.
              if (!this._pendingPermissionRequests.has(request_id)) return
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
              if (!this._pendingPermissionRequests.has(request_id)) return // withdrawn (cancel) during gap
              // Config read failed — default to auto-approve in bypass
              this._pendingPermissionRequests.delete(request_id)
              this.respondToControlRequest(request_id, request, true)
            })
          } else {
            // Non-bypass modes (and AskUserQuestion in any mode): emit to UI for user decision.
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
        // Payload reads (get_settings / get_context_usage / get_usage / …):
        // capture the whole response.response object; the wrapper that issued the
        // request extracts its fields. Checked first — these carry a payload,
        // unlike the ACK-only requests below.
        const payloadRead = this._pendingPayloadReads.get(requestId)
        if (payloadRead) {
          this._pendingPayloadReads.delete(requestId)
          clearTimeout(payloadRead.timer)
          if (cr.response?.subtype === 'error') {
            payloadRead.reject(new Error(cr.response.error || 'control request failed'))
          } else {
            const payload = (cr.response?.response as Record<string, unknown> | undefined) ?? null
            log.session.debug('control_request payload read resolved', {
              sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
              keys: payload ? Object.keys(payload).slice(0, 8) : null,
            })
            payloadRead.resolve(payload)
          }
          break
        }
        // ACK-only control_requests (apply_flag_settings, etc.): resolve true on
        // success, reject on error. Checked first — these carry no nested answer.
        const ack = this._pendingControlAcks.get(requestId)
        if (ack) {
          this._pendingControlAcks.delete(requestId)
          clearTimeout(ack.timer)
          if (cr.response?.subtype === 'error') {
            ack.reject(new Error(cr.response.error || 'control request failed'))
          } else {
            log.session.info('control_request ack resolved', {
              sessionId: this.claudeSessionId, taskId: this.taskId, requestId,
            })
            ack.resolve(true)
          }
          break
        }
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

      // ── control_cancel_request: the CLI WITHDRAWS a pending control_request ──
      // Emitted when the request's turn is aborted CLI-side (interrupt, resume,
      // process restart re-planning). Before this handler existed the cancel fell
      // into the control_* swallow below, so the pending permission NEVER cleared:
      // permanent Waiting badge, 60s re-emit loop, and a stale card whose
      // allow/deny 404s (incident a172ce49 — two ExitPlanMode requests each
      // cancelled by the CLI, session stuck "Waiting" for days).
      case 'control_cancel_request': {
        const cc = event as unknown as { type: 'control_cancel_request'; request_id?: string }
        const requestId = cc.request_id
        if (!requestId) break
        // Poison the id first: a daemon replay of the ORIGINAL control_request
        // after this cancel must not resurrect the prompt.
        this._resolvedPermissionRequestIds.add(requestId)
        const pending = this._pendingPermissionRequests.get(requestId)
        this._pendingPermissionRequests.delete(requestId)
        this._clearPermissionReEmitTimer(requestId)
        log.session.info('control_cancel_request — CLI withdrew pending permission request', {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          requestId,
          toolName: pending?.request.tool_name,
          wasPending: !!pending,
        })
        if (this.claudeSessionId) {
          // Settle the UI card (renders as dismissed/denied) and stop the Waiting badge.
          bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
            sessionId: this.claudeSessionId,
            taskId: this.taskId,
            requestId,
            toolName: pending?.request.tool_name,
            allowed: false,
            cancelled: true,
          }, ['*'], { source: 'session-runner' })
          // Clear the persisted Layer-2 copy — but only if it belongs to THIS
          // request; a newer pending permission must not be wiped by an old cancel.
          import('../core/session-tracker.js').then(async ({ getSessionByClaudeId, updateSessionRecord }) => {
            const record = await getSessionByClaudeId(this.claudeSessionId!)
            if (record?.pendingPermission?.requestId === requestId) {
              await updateSessionRecord(this.claudeSessionId!, { pendingPermission: undefined })
            }
          }).catch(() => {})
        }
        break
      }

      case 'tool_progress': {
        // Heartbeat progress marker for long-running tools, emitted about once
        // every 30 seconds per tool. It has no user value as a timeline block;
        // swallowing it keeps it out of the unknown-event catch-all.
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

            // PARTIAL delta — skip edge-touching paths (split-path guard).
            const rewritten = this.rewriteRemoteImages(text, { streaming: true })
            if (this.fullText.length < MAX_FULL_TEXT) {
              this.fullText += rewritten
            }
            // See the `assistant` path: records that this turn's answer reached
            // the UI. stream_event lines carry no parent_tool_use_id (verified
            // across the local corpus), so every delta here is main-lane.
            this._emittedAssistantText = true
            this._stampFirstEmit('text')
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: rewritten,
              ...(msgId ? { msgId } : {}),
              ...(this._isReplayedByOffset() !== undefined ? { replayed: this._isReplayedByOffset() } : {}),
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (deltaType === 'thinking_delta') {
            const text = delta?.thinking ?? ''
            // trim(): a whitespace-only delta would otherwise create a new
            // (empty-looking) thinking block in the UI stream.
            if (!text.trim()) break
            this._stampFirstEmit('thinking')
            bus.emit(EventNames.SESSION_THINKING_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: text,
              ...(msgId ? { msgId } : {}),
              ...(this._isReplayedByOffset() !== undefined ? { replayed: this._isReplayedByOffset() } : {}),
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          } else if (deltaType === 'citations_delta') {
            // Surface citation as a text_delta with the reference mark so it
            // appears in the normal text flow. More elaborate UI can come later.
            const citation = JSON.stringify(delta)
            // Text reached the main lane (see the text_delta path above).
            this._emittedAssistantText = true
            bus.emit(EventNames.SESSION_TEXT_DELTA, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              delta: ` ※${citation} `,
              ...(msgId ? { msgId } : {}),
              ...(this._isReplayedByOffset() !== undefined ? { replayed: this._isReplayedByOffset() } : {}),
            }, ['main-ai'], { source: 'session-runner', urgency: 'urgent' })
          }
          break
        }

        break
      }

      default: {
        const unknownType = (event as { type?: string }).type ?? 'null'
        // The control_* family is stream-json RPC plumbing, not conversation
        // content — surfacing it through the unknown-event catch-all rendered a
        // PERMANENT "control_request_progress" system block pinned under the
        // chat (inc-1786165723472: the CLI heartbeats in-flight side_question
        // requests). The daemon already strips control lines on replay for the
        // same reason. Known members are handled by their cases above; anything
        // else with the prefix is a future protocol variant — log, never render.
        if (unknownType.startsWith('control_')) {
          log.session.debug('unhandled control-protocol line (not surfaced to UI)', {
            sessionId: this.claudeSessionId, taskId: this.taskId,
            eventType: unknownType, linePreview: line.slice(0, 200),
          })
          break
        }
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
    const sessionId = this.claudeSessionId
    if (!sessionId) return
    const updates = {
      process_status: this._processStatus,
      activity: this._activity,
      mode: this._mode,
      planCompleted: this.planCompleted,
      errorMessage,
    }
    const commit = this._statusCommit.then(async () => {
      const {
        emitSessionStatusChanged,
        updateSessionRecord,
      } = await import('../core/session-tracker.js')
      const record = await updateSessionRecord(sessionId, updates)
      emitSessionStatusChanged(
        record,
        { phase },
        ['*'],
        { source: 'session-runner', urgency: 'urgent' },
      )
    })
    this._statusCommit = commit.catch((err) => {
      log.session.warn('failed to commit session status event', {
        sessionId,
        phase,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  // ── Permission prompt tool helpers ──

  /**
   * Send a control_response to Claude Code via the FIFO.
   * @param allow — true to allow, false to deny
   * @param updatedInputPatch — shallow-merged OVER request.input in the allow
   *   response. The CLI hands `updatedInput` back to the tool as its arguments,
   *   so this is how a human decision becomes tool input — used by
   *   AskUserQuestion to inject `answers` (question text → chosen label).
   * @returns true if the response was written (or at least attempted), false if no transport
   */
  private respondToControlRequest(
    requestId: string,
    request: { tool_name?: string; input?: Record<string, unknown> },
    allow: boolean,
    denyMessage?: string,
    updatedInputPatch?: Record<string, unknown>,
  ): boolean {
    const result = allow
      ? {
        behavior: 'allow' as const,
        updatedInput: updatedInputPatch ? { ...(request.input ?? {}), ...updatedInputPatch } : request.input,
      }
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
   * Ask the CLI to generate a session title from a description (usually the
   * user's first real message) via the `generate_session_title` control_request
   * subtype — the same Haiku titler the CLI uses natively, riding the session's
   * existing stream-json stdin (no separate LLM plumbing in Walnut). The CLI
   * handles it fire-and-forget, so a mid-turn request doesn't block the stdin
   * loop. `persist:false` — Walnut owns the title (task + session record); the
   * CLI's own session store must not become a second source of truth.
   *
   * Returns the title, or null on ANY failure (dead transport, timeout, CLI
   * error) — callers treat null as "keep the placeholder".
   */
  async generateSessionTitle(description: string, timeoutMs = 20_000): Promise<string | null> {
    const payload = await this.readControlPayloadWithRequest(
      `title-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      { subtype: 'generate_session_title', description, persist: false },
      timeoutMs,
    )
    const title = payload && typeof payload.title === 'string' ? payload.title.trim() : ''
    return title || null
  }

  /**
   * Change the session's reasoning effort MID-SESSION, without respawning the CLI.
   *
   * ── How it works (stream-json control protocol, OUTBOUND — same as askSideQuestion) ──
   * Sends `{subtype:'apply_flag_settings', settings:{effortLevel:<level>}}` over the
   * FIFO (writeRaw → daemon sendRaw → CLI stdin). The fork merges it into the in-memory
   * flag-settings layer and syncs AppState.effortValue (fork print.ts:3699 →
   * applySettingsChange.ts:88), so the NEXT turn's API call picks up the new effort.
   * The running turn is NOT interrupted; no --resume, no respawn.
   *
   * Live-verified against binary 2.1.170 (Bedrock): apply_flag_settings{effortLevel:'low'}
   * flipped get_settings' applied.effort high→low on the same live process, and the CLI
   * NEVER errors on invalid/unsupported values (garbage is ignored; `max` on a non-Opus-4.6
   * model is a no-op guard we enforce in the UI, since the CLI silently accepts it).
   *
   * NOTE: apply_flag_settings is IN-MEMORY only (setFlagSettingsInline — never written to
   * disk, verified in fork bootstrap/state.ts). So if this CLI later dies and cold-resumes,
   * the effort is gone; the caller persists record.effort and send() re-applies `--effort`
   * on the cold --resume spawn as the durable fallback (same pattern as cliModel/[1m]).
   *
   * @param effort  one of low/medium/high/xhigh/max — caller must have gated
   *                `xhigh`/`max` to capable models (CLI won't reject them).
   */
  async applyEffort(effort: import('../core/types.js').SessionEffort, timeoutMs = 15_000): Promise<boolean> {
    if (!this._transport) throw new Error('session not started')
    this._effort = effort  // reflect immediately for persistSessionRecord / display
    return this.sendFlagSettings(`eff-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      { effortLevel: effort }, timeoutMs)
  }

  /**
   * Change the session's MODEL mid-session, without respawning the CLI — the exact
   * same apply_flag_settings mechanism as applyEffort above.
   *
   * Live-verified against binary 2.1.170: apply_flag_settings{model:'sonnet'} on a
   * process spawned with --model opus[1m] made the NEXT turn answer as
   * claude-sonnet-4-6 (assistant message model field), with get_settings'
   * applied.model flipping accordingly. `[1m]` suffixes round-trip intact
   * (model:'sonnet[1m]' → applied "…sonnet-4-6[1m]"). A garbage model value is
   * ACKed success but silently ignored — same untrustworthy-ACK contract as effort,
   * so callers MUST read back applied.model (refreshAppliedSettings) to know the truth.
   *
   * This replaces the old pendingModel → interrupt + --resume respawn path, which
   * killed the running turn and broke on remote daemons (empty-message start
   * rejected: "start: missing required fields"). Like effort, apply_flag_settings is
   * IN-MEMORY only — the caller persists record.cliModel so a cold --resume respawns
   * with the new --model.
   *
   * @param cliModel  a CLI --model value (e.g. 'sonnet[1m]', 'haiku') — caller
   *                  validates against the SESSION_MODELS registry.
   */
  async applyModel(cliModel: string, timeoutMs = 15_000): Promise<boolean> {
    if (!this._transport) throw new Error('session not started')
    this._cliModel = cliModel  // reflect immediately for persistSessionRecord / resume
    return this.sendFlagSettings(`mdl-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      { model: cliModel }, timeoutMs)
  }

  /**
   * Change the session's PERMISSION MODE mid-session, without respawning — the
   * third member of the live-settings family (model/effort/mode), completing the
   * retirement of the pending-switch respawn paths.
   *
   * Uses the dedicated `set_permission_mode` control_request (NOT
   * apply_flag_settings). Live-verified on 2.1.170: the response ECHOES the new
   * mode ({"mode":"plan"}) — a real confirmation, unlike apply_flag_settings'
   * blind ACK — and the CLI then emits a `system`/`status` event with the new
   * permissionMode. This method verifies the echo, then updates local state and
   * daemon policy itself; the status event is an additional reconciliation path.
   *
   * Durability: record.mode is persisted by the caller (PATCH route) and
   * processNext already falls back to record.mode on a cold --resume
   * (`resumeMode = … ?? record.mode`), so no pendingMode flag is needed.
   *
   * @param mode  Any Walnut SessionMode — mapped to the CLI's permission-mode
   *              vocabulary through the shared registry. All six (incl. `auto`
   *              and `dontAsk`) are live-switchable: verified on CLI 2.1.220,
   *              each one echoed itself back from set_permission_mode.
   */
  async applyPermissionMode(mode: SessionMode, timeoutMs = 15_000): Promise<boolean> {
    if (!this._transport) throw new Error('session not started')
    const cliMode = SESSION_MODE_CLI_MAP[mode] ?? mode
    const payload = await this.readControlPayloadWithRequest(
      `pmode-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      { subtype: 'set_permission_mode', mode: cliMode }, timeoutMs, true)
    const echoed = (payload as { mode?: string } | null)?.mode
    log.session.info('set_permission_mode applied', {
      sessionId: this.claudeSessionId, taskId: this.taskId, requested: cliMode, echoed: echoed ?? null,
    })
    if (echoed !== cliMode) return false

    // Only confirmed state is user-visible or persisted. Keep the daemon's
    // auto-response policy in sync immediately instead of waiting for a later
    // system/status event that may be delayed or absent.
    this._mode = mode
    const daemonUpdated = await this._transport.setMode?.(mode)
    if (daemonUpdated === false) {
      log.session.warn('set_permission_mode confirmed but daemon policy update failed', {
        sessionId: this.claudeSessionId, taskId: this.taskId, mode,
      })
    }
    return true
  }

  /** Shared transport plumbing for apply_flag_settings control_requests (ACK-only). */
  private sendFlagSettings(requestId: string, settings: Record<string, unknown>, timeoutMs: number): Promise<boolean> {
    const envelope = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'apply_flag_settings', settings },
    })
    log.session.info('apply_flag_settings dispatching', {
      sessionId: this.claudeSessionId, taskId: this.taskId, requestId, settings,
    })
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingControlAcks.delete(requestId)
        reject(new Error('apply_flag_settings timed out'))
      }, timeoutMs)
      this._pendingControlAcks.set(requestId, { resolve, reject, timer })
      Promise.resolve(this._transport!.writeRaw(envelope)).then((ok) => {
        if (!ok) {
          const pending = this._pendingControlAcks.get(requestId)
          if (pending) {
            this._pendingControlAcks.delete(requestId)
            clearTimeout(pending.timer)
            reject(new Error('failed to write apply_flag_settings control_request to session'))
          }
        }
      }).catch((err) => {
        const pending = this._pendingControlAcks.get(requestId)
        if (pending) {
          this._pendingControlAcks.delete(requestId)
          clearTimeout(pending.timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  /**
   * Read the CLI's TRUE runtime settings via a `get_settings` control_request.
   * Returns `applied` — the runtime-resolved values AFTER env overrides + model
   * downgrades (path: control_response.response.response.applied). Use
   * `applied.effort` as the authoritative effort the model will actually use:
   * it reflects a CLAUDE_CODE_EFFORT_LEVEL override and an unsupported-level→high
   * downgrade, whereas `effective.effortLevel` (the disk merge) does NOT.
   * Verified verbatim against binary 2.1.170.
   *
   * This is the source-of-truth read behind the effort badge: Walnut's optimistic
   * record.effort is only a REQUEST; the CLI can silently ignore/override it and
   * still ACK success (apply_flag_settings has no error path for effort). So we
   * never trust the ACK alone — we read back.
   *
   * Returns null (never throws) when the read can't be trusted: no transport, the
   * FIFO write fails, the CLI is an old build that doesn't answer get_settings, or
   * it times out. Callers MUST treat null as "don't change what you have" (same
   * contract as reconcileFromDaemon) — never clobber a known value with null.
   */
  async getSettingsSnapshot(timeoutMs = 5_000): Promise<CliSettingsSnapshot | null> {
    const payload = await this.readControlPayload('gs', 'get_settings', timeoutMs) as {
      applied?: CliAppliedSettings
      effective?: CliEffectiveSettings
    } | null
    if (!payload?.applied) return null
    return {
      applied: payload.applied,
      ...(payload.effective ? { effective: payload.effective } : {}),
    }
  }

  async getSettings(timeoutMs = 5_000): Promise<CliAppliedSettings | null> {
    return (await this.getSettingsSnapshot(timeoutMs))?.applied ?? null
  }

  /**
   * Fetch the session's TRUE model catalog. Primary: the `list_models`
   * control_request — the CLI's purpose-built READ-ONLY catalog query
   * (2.1.199+; the CLI's own thin-client picker uses it). Fallback: an empty
   * `initialize` control_request — a handshake that happens to carry the same
   * `models[]` (the two subtypes serve the catalog from the same function in
   * the CLI), supported since ancient builds. Older CLIs (≤2.1.170) answer
   * list_models with a FAST explicit "Unsupported control request subtype"
   * error, so the fallback engages within ~a second, not after a timeout.
   *
   * The rows are the CLI's own picker source: already filtered by the host's
   * availableModels allowlist and already mapped through modelOverrides —
   * each row's `value` is the ONLY universally-safe string to hand back to
   * set_model / --model. (Live-verified on 2.1.199: aliases get rejected
   * under an allowlist; canonical short IDs ack success but 400 at the wire;
   * catalog values always work.)
   *
   * Returns null (never throws) when the read can't be trusted — neither
   * subtype answered, dead transport, timeout — same contract as getSettings.
   * Callers fall back to the static SESSION_MODELS registry.
   *
   * BUDGET: 10s total across BOTH attempts (the HTTP client caps at 15s), not
   * getSettings' 5s — the CLI answers control_requests serially on its stdin
   * loop, so a read can queue behind a heavy get_context_usage (measured
   * 16s+), plus remote-daemon RTT. A list_models failure with little budget
   * left means the CLI isn't answering at all (timeout, not old-build error) —
   * initialize would hang the same way, so don't burn a second wait on it.
   */
  private async fetchModelCatalog(
    budgetMs = 10_000,
    generation = this._transportGeneration,
  ): Promise<SessionModelCatalogEntry[] | null> {
    const t0 = Date.now()
    let payload = await this.readControlPayload('lm', 'list_models', budgetMs)
    if (generation !== this._transportGeneration) return null
    if (!payload) {
      const remaining = budgetMs - (Date.now() - t0)
      if (remaining < 1_500) return null
      payload = await this.readControlPayload('init', 'initialize', remaining)
      if (generation !== this._transportGeneration) return null
    }
    const rows = (payload as { models?: unknown } | null)?.models
    if (!Array.isArray(rows)) return null
    const models: SessionModelCatalogEntry[] = []
    for (const row of rows as Array<Record<string, unknown>>) {
      if (!row || typeof row.value !== 'string' || !row.value.trim()) continue
      if (typeof row.displayName !== 'string' || !row.displayName.trim()) continue
      models.push({
        value: row.value,
        ...(typeof row.resolvedModel === 'string' && row.resolvedModel ? { resolvedModel: row.resolvedModel } : {}),
        displayName: row.displayName,
        ...(typeof row.description === 'string' && row.description ? { description: row.description } : {}),
        ...(row.disabled === true ? { disabled: true } : {}),
        ...(typeof row.supportsEffort === 'boolean' ? { supportsEffort: row.supportsEffort } : {}),
        ...(Array.isArray(row.supportedEffortLevels)
          ? { supportedEffortLevels: (row.supportedEffortLevels as unknown[])
              .filter((l): l is SessionEffort => typeof l === 'string' && VALID_SESSION_EFFORT_IDS.has(l)) }
          : {}),
      })
    }
    // Empty-after-sanitize = old/odd CLI — treat as "can't answer" so callers fall back.
    return models.length > 0 ? models : null
  }

  /**
   * Cached accessor for the model catalog. Cache lives on the session instance
   * and is invalidated by EVENTS, not a clock: transport teardown / respawn
   * (fresh process = fresh settings snapshot), invalidateModelCatalog(), or a
   * read-back model that isn't in the cached set (refreshAppliedSettings).
   * Parallel callers share one in-flight catalog round-trip.
   */
  async getModelCatalog(opts?: { force?: boolean }): Promise<{ models: SessionModelCatalogEntry[]; fetchedAt: number } | null> {
    if (!opts?.force && this._modelCatalog) return this._modelCatalog
    if (this._modelCatalogInflight) {
      const models = await this._modelCatalogInflight
      return models ? this._modelCatalog : null
    }
    const generation = this._transportGeneration
    const inflight = this.fetchModelCatalog(10_000, generation)
    this._modelCatalogInflight = inflight
    try {
      const models = await inflight
      if (generation !== this._transportGeneration) return null
      if (models) {
        this._modelCatalog = { models, fetchedAt: Date.now() }
        log.session.info('model catalog fetched', {
          sessionId: this.claudeSessionId, taskId: this.taskId, modelCount: models.length,
        })
        // Every REAL fetch (cache hits returned above): write through to the
        // host-level store, and IF the store accepts it (freshness gate — an
        // older/attached CLI's degraded answer must not clobber a newer
        // process's catalog) push the same rows to clients. Store decision and
        // client push are deliberately one decision: pushing what the store
        // rejected would poison every picker's cache with the degraded menu.
        const catSnapshot = this._modelCatalog
        void import('../core/host-model-catalog.js')
          .then(({ saveHostModelCatalog }) => {
            if (generation !== this._transportGeneration) return false
            return saveHostModelCatalog(
              this._host,
              models,
              this._cwd ?? undefined,
              this._spawnTs || undefined,
              () => generation === this._transportGeneration,
            )
          })
          .then((accepted) => {
            if (!accepted || generation !== this._transportGeneration || !this.claudeSessionId) return
            bus.emit(EventNames.SESSION_MODEL_CATALOG, {
              sessionId: this.claudeSessionId,
              taskId: this.taskId,
              ...(this._host ? { host: this._host } : {}),
              models,
              fetchedAt: new Date(catSnapshot.fetchedAt).toISOString(),
            }, ['main-ai'], { source: 'session-runner' })
          })
          .catch(() => {})
        return this._modelCatalog
      }
      return null
    } finally {
      if (this._modelCatalogInflight === inflight) {
        this._modelCatalogInflight = null
      }
    }
  }

  /** Drop the cached catalog AND refetch in the background — called when
   *  read-back truth disagrees with the cached set (allowlist/overrides
   *  evidently changed under us) or after a failed switch. Only live-session
   *  code paths call this (teardown nulls the field directly), so the eager
   *  refetch is safe: it pushes the corrected catalog to clients instead of
   *  waiting for the next picker open. */
  invalidateModelCatalog(): void {
    if (this._modelCatalog) {
      log.session.info('model catalog invalidated — refetching', {
        sessionId: this.claudeSessionId, taskId: this.taskId,
      })
    }
    this._modelCatalog = null
    void this.getModelCatalog().catch(() => {})
  }

  /** Loose membership check: is `model` one of the cached catalog's rows?
   *  Compares against value and resolvedModel, tolerating [1m] and -vN suffix
   *  decoration differences between the read-back string and catalog strings. */
  private modelInCachedCatalog(model: string): boolean {
    if (!this._modelCatalog) return true // no cache → nothing to contradict
    const strip = (s: string) => s.toLowerCase().replace(/\[1m\]$/, '').replace(/[-_]v\d+(:\d+)?$/, '')
    const needle = strip(model)
    return this._modelCatalog.models.some((m) =>
      strip(m.value) === needle || (m.resolvedModel ? strip(m.resolvedModel) === needle : false))
  }

  /**
   * Read the CLI's own per-category context breakdown via `get_context_usage` —
   * the same data source as the interactive `/context` command (fork:
   * collectContextData → analyzeContextUsage), so the numbers reflect what the
   * model ACTUALLY sees: system prompt / tools / MCP / memory / skills /
   * messages / autocompact buffer, plus the CLI's own effective window size.
   *
   * Live-verified on 2.1.170: categories[] + totalTokens + maxTokens +
   * percentage. NOTE maxTokens is the CLI's EFFECTIVE window — e.g. with
   * CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000 a sonnet[1m] session reports
   * maxTokens=400000, not 1M. That's exactly why this read exists: Walnut's
   * own [1m]→1M guess can't know about env clamps.
   *
   * Returns null (never throws) when unreadable — dead CLI / old build /
   * timeout — same untrusted-read contract as getSettings.
   *
   * TIMEOUT: measured 16s on a real remote session with a large MCP surface
   * (the CLI tokenizes every tool schema to answer). 45s covers pathological
   * sessions; a long timeout is harmless — the promise resolves the moment the
   * answer arrives, a dead CLI fails fast on writeRaw, and teardown settles
   * pending reads to null.
   */
  async getContextUsage(timeoutMs = 45_000): Promise<CliContextUsage | null> {
    const payload = await this.readControlPayload('cu', 'get_context_usage', timeoutMs)
    if (!payload) return null
    const categories = Array.isArray(payload.categories)
      ? (payload.categories as Array<Record<string, unknown>>)
          .filter((c) => typeof c.name === 'string' && typeof c.tokens === 'number')
          .map((c) => ({ name: c.name as string, tokens: c.tokens as number }))
      : []
    return {
      categories,
      totalTokens: typeof payload.totalTokens === 'number' ? payload.totalTokens : null,
      maxTokens: typeof payload.maxTokens === 'number' ? payload.maxTokens : null,
      percentage: typeof payload.percentage === 'number' ? payload.percentage : null,
    }
  }

  /**
   * Read structured per-model usage + cost via `get_usage` (live-verified on
   * 2.1.170: session.total_cost_usd, per-model tokens, contextWindow). This is
   * the CLI's own accounting — includes subagent calls Walnut never sees.
   *
   * TIMEOUT: cheap by itself, but the CLI answers control_requests serially on
   * its stdin loop — when fired alongside getContextUsage (the details pull),
   * this answer queues behind that 16s+ tokenization. Same 45s bound.
   */
  async getUsage(timeoutMs = 45_000): Promise<Record<string, unknown> | null> {
    const payload = await this.readControlPayload('gu', 'get_usage', timeoutMs)
    return (payload as { session?: Record<string, unknown> } | null)?.session ?? null
  }

  /** Read the CLI build version via `get_binary_version` ({version, buildTime}).
   *  45s: queues behind getContextUsage in the details pull (see getUsage). */
  async getBinaryVersion(timeoutMs = 45_000): Promise<{ version?: string; buildTime?: string } | null> {
    const payload = await this.readControlPayload('bv', 'get_binary_version', timeoutMs)
    return (payload as { version?: string; buildTime?: string } | null) ?? null
  }

  /**
   * Context% denominator — matches the official CLI statusline's
   * `context_window.used_percentage`, which divides by the model's RAW window
   * (calculateContextPercentages ÷ getContextWindowForModel), NOT the
   * auto-compact window. get_context_usage.maxTokens on newer CLIs (≥2.1.2xx)
   * reports min(model window, CLAUDE_CODE_AUTO_COMPACT_WINDOW) — e.g. 400K on
   * a 1M fable session with the user's global AUTO_COMPACT_WINDOW=400000 —
   * so using it verbatim showed 200K/400K = 50% where the official UI says
   * 20% (2026-08-11 report). Resolution order:
   *   1) _cliRawContextWindow — the CLI's own getContextWindowForModel answer
   *      harvested from result.modelUsage (see harvestRawContextWindow).
   *      Verbatim: this is EXACTLY the official statusline denominator, no
   *      string-parsing involved.
   *   2) string guess from the model markers: [1m] → 1M, else 200K default —
   *      only until the first turn-end result arrives. (No natively-1M
   *      special case — the CLI's own registry gives plain opus-5 a 200K row
   *      and a separate "[1m]" row; trust the markers.)
   *      _cliContextWindow can only RAISE that guess — it's ≤ the raw window
   *      by construction (min-clamp), so taking the max keeps its one real
   *      contribution (a >200K window the string can't reveal, e.g. a custom
   *      proxy model) while ignoring the auto-compact clamp.
   *   3) observed tokens can't exceed the window — a totalInput above the
   *      result forces 1M (resume paths that lose the [1m] suffix).
   */
  private contextWindowForPercent(totalInput?: number): number {
    let window = this._cliRawContextWindow
    if (window == null) {
      const is1M = this._initModel?.includes('[1m]') ?? false
      window = Math.max(is1M ? 1_000_000 : CONTEXT_WINDOW_DEFAULT, this._cliContextWindow ?? 0)
    }
    if (totalInput != null && totalInput > window) window = 1_000_000
    return window
  }

  /**
   * Seed _cliRawContextWindow from a result event's modelUsage block. Each
   * entry's contextWindow is the CLI's getContextWindowForModel(model) — the
   * raw window, immune to CLAUDE_CODE_AUTO_COMPACT_WINDOW (live-verified on
   * 2.1.220: fable[1m] under a 400K clamp still reports 1000000 here).
   *
   * modelUsage can hold several models (subagents run on cheaper ones), so
   * pick the MAIN model's entry: exact key match on _initModel, then a
   * decoration-tolerant match (provider prefix / -vN differences), then — only
   * when the map has a single entry — that entry. No "largest window wins"
   * fallback: a 1M subagent under a 200K main model would poison the percent.
   */
  private harvestRawContextWindow(modelUsage: NonNullable<StreamResultEvent['modelUsage']>): void {
    const keys = Object.keys(modelUsage)
    if (keys.length === 0) return
    const strip = (s: string) => s.toLowerCase().replace(/^.*\./, '').replace(/[-_]v\d+(:\d+)?(?=\[|$)/, '')
    const candidates = [this._initModel, this._model].filter((m): m is string => !!m)
    let key = candidates.find((m) => modelUsage[m] !== undefined)
    if (!key) {
      for (const m of candidates) {
        key = keys.find((k) => strip(k) === strip(m))
        if (key) break
      }
    }
    if (!key && keys.length === 1) key = keys[0]
    if (!key) return
    const win = modelUsage[key]?.contextWindow
    if (typeof win === 'number' && win > 0 && win !== this._cliRawContextWindow) {
      log.session.info('raw context window seeded from result.modelUsage', {
        sessionId: this.claudeSessionId, taskId: this.taskId,
        modelKey: key, contextWindow: win, prev: this._cliRawContextWindow ?? null,
      })
      this._cliRawContextWindow = win
    }
  }

  /** Seed _cliContextWindow from get_context_usage.maxTokens. NB on newer CLIs
   *  this is the AUTO-COMPACT window, not the raw model window — it only ever
   *  RAISES the context% denominator (see contextWindowForPercent). Called once
   *  at session-start and again after a model change (the only events that can
   *  change the window; NOT per turn — the read tokenizes the full tool surface
   *  on the CLI side, too heavy for turn-end).
   *  Fire-and-forget safe; an unreadable CLI just keeps the string-guess fallback. */
  private seedCliContextWindow(reason: string): void {
    void this.getContextUsage().then((cu) => {
      if (cu?.maxTokens && cu.maxTokens > 0 && cu.maxTokens !== this._cliContextWindow) {
        log.session.info('cli context window seeded', {
          sessionId: this.claudeSessionId, taskId: this.taskId, reason,
          maxTokens: cu.maxTokens, prev: this._cliContextWindow ?? null,
        })
        this._cliContextWindow = cu.maxTokens
      }
    }).catch(() => {})
  }

  /** Shared plumbing for payload-carrying control_request reads. Resolves the
   *  response.response object, or null on ANY failure mode (no transport, FIFO
   *  write failed, CLI errored/doesn't know the subtype, timeout) — callers
   *  treat null as "untrusted, don't change what you have". */
  private readControlPayload(prefix: string, subtype: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return this.readControlPayloadWithRequest(
      `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      { subtype }, timeoutMs)
  }

  /** Full-request variant for parameterized payload reads. Ordinary reads keep
   *  the null-on-failure contract; state-changing calls can request strict
   *  errors so the caller never persists an unconfirmed value. */
  private readControlPayloadWithRequest(
    requestId: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    strict = false,
  ): Promise<Record<string, unknown> | null> {
    if (!this._transport) {
      return strict ? Promise.reject(new Error('session not started')) : Promise.resolve(null)
    }
    const envelope = JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request,
    })
    return new Promise<Record<string, unknown> | null>((resolve, reject) => {
      const fail = (err: Error) => {
        if (strict) reject(err)
        else resolve(null)
      }
      const timer = setTimeout(() => {
        this._pendingPayloadReads.delete(requestId)
        log.session.debug('control payload read timed out', {
          sessionId: this.claudeSessionId, taskId: this.taskId, requestId, subtype: request.subtype,
        })
        fail(new Error(`${String(request.subtype)} control request timed out`))
      }, timeoutMs)
      this._pendingPayloadReads.set(requestId, {
        resolve,
        reject: (err) => {
          this._pendingPayloadReads.delete(requestId)
          clearTimeout(timer)
          fail(err)
        },
        timer,
      })
      Promise.resolve(this._transport!.writeRaw(envelope)).then((ok) => {
        if (!ok) {
          const pending = this._pendingPayloadReads.get(requestId)
          if (pending) {
            this._pendingPayloadReads.delete(requestId)
            clearTimeout(pending.timer)
            fail(new Error(`failed to write ${String(request.subtype)} control_request to session`))
          }
        }
      }).catch((err) => {
        const pending = this._pendingPayloadReads.get(requestId)
        if (pending) {
          this._pendingPayloadReads.delete(requestId)
          clearTimeout(pending.timer)
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })
  }

  /**
   * Read the CLI's true runtime settings via getSettings() and reconcile BOTH
   * `_effectiveEffort` AND the live model, persisting what changed. This is the
   * single write-path for effectiveEffort/model truth, called at the trust
   * points: session start, each turn-end, after an effort change, and after a
   * model change. Fire-and-forget safe — never throws, never blocks the caller.
   *
   * One get_settings round-trip serves both settings — effort and model share the
   * same untrustworthy-ACK problem (the CLI ACKs success even when it silently
   * ignores/overrides a value), so they share the same read-back.
   *
   * `reason` is for logging only. Returns `{effort, model}` as read (or null when
   * the read was untrusted — old CLI / timeout / write fail — in which case we
   * leave stored values untouched, mirroring reconcileFromDaemon).
   *
   * `preFetched`: callers that already hold a fresh get_settings `applied` block
   * (e.g. the picker-pull route, which just called getSettingsSnapshot) pass it
   * here so the reconcile reuses that read instead of issuing a SECOND
   * get_settings control round-trip (each is up to 5s on a busy CLI).
   */
  async refreshAppliedSettings(reason: string, preFetched?: CliAppliedSettings): Promise<{ effort: import('../core/types.js').SessionEffort | null; model: string | null } | null> {
    const sid = this.claudeSessionId
    if (!sid) return null
    const applied = preFetched ?? await this.getSettings().catch(() => null)
    if (!applied) return null // untrusted read — don't clobber

    // ── Effort ──
    // applied.effort may be null (no effort set → API default 'high') or a level
    // string. Normalize: null/absent means "API default", which we represent as
    // undefined effectiveEffort (badge then shows the DEFAULT_SESSION_EFFORT hint).
    const raw = applied.effort
    const { VALID_SESSION_EFFORT_IDS } = await import('../core/types.js')
    const next = (typeof raw === 'string' && VALID_SESSION_EFFORT_IDS.has(raw))
      ? (raw as import('../core/types.js').SessionEffort)
      : undefined

    // ── Model ──
    // applied.model is the full runtime ID (e.g. "us.anthropic.claude-sonnet-4-6[1m]").
    // Reconcile _model (short display form, same shortening as the init handler) so
    // usage events and the header pill reflect a live switch immediately, and persist
    // record.model so the UI is right after a reload too.
    const appliedModel = typeof applied.model === 'string' && applied.model ? applied.model : undefined
    let modelChanged = false
    if (appliedModel) {
      const shortModel = appliedModel.replace(/^.*\./, '').replace(/[-_]v\d+(\[1m\])?$/, '$1') || appliedModel
      if (shortModel !== this._model) {
        modelChanged = true
        this._model = shortModel
        this._initModel = appliedModel // keep 1M-context detection in sync with the switch
        // Window size can change with the model (200K↔1M, env clamps) — drop the
        // old model's raw window (next result re-harvests it) and re-seed the
        // control-read denominator from the CLI.
        this._cliRawContextWindow = undefined
        this.seedCliContextWindow('model-change')
        // Read-back truth outside the cached catalog ⇒ the allowlist/overrides
        // evidently shifted under us (or the CLI fell back to something we don't
        // know) — drop the cache so the next picker open refetches reality.
        if (!this.modelInCachedCatalog(appliedModel)) {
          this.invalidateModelCatalog()
        }
      }
    }
    // First settings read with no window seeded yet (e.g. a session ATTACHED
    // after a server restart — no init event fires, model never changes, so
    // neither seed trigger above would ever run). One attempt per process:
    // the flag (not the result) gates, so an old CLI that can't answer
    // get_context_usage doesn't get re-probed on every turn-end.
    if (this._cliContextWindow === undefined && !this._cliContextWindowProbed) {
      this._cliContextWindowProbed = true
      this.seedCliContextWindow('first-settings-read')
    }

    const effortChanged = next !== this._effectiveEffort
    if (!effortChanged && !modelChanged) return { effort: next ?? null, model: appliedModel ?? null }

    const prev = this._effectiveEffort
    this._effectiveEffort = next
    log.session.info('applied-settings read-back', {
      sessionId: sid, taskId: this.taskId, reason,
      requested: this._effort ?? null, effective: next ?? null, prev: prev ?? null,
      overridden: this._effort !== undefined && next !== undefined && next !== this._effort,
      model: appliedModel ?? null, modelChanged,
    })
    try {
      const { updateSessionRecord } = await import('../core/session-tracker.js')
      await updateSessionRecord(sid, {
        ...(effortChanged ? { effectiveEffort: next } : {}),
        ...(modelChanged ? { model: appliedModel } : {}),
      })
    } catch (err) {
      log.session.debug('applied-settings persist failed (non-fatal)', {
        sessionId: sid, error: err instanceof Error ? err.message : String(err),
      })
    }
    // Push the read-back to the browser. Persisting alone is NOT enough: the
    // panel fetches the record ONCE at mount, and this read-back lands ~1.5s
    // AFTER session start (the CLI must finish wiring its ask() loop first), so
    // the composer's effort badge would keep rendering its stale/default guess
    // until something unrelated refetched — while the picker, which live-pulls
    // get_settings on open, showed the true level. That's the two-surfaces-one-
    // truth mismatch (user report: picker says X-High, composer pill says High).
    // effectiveEffort is not part of SessionStatusSnapshot, so the status store
    // can't carry it — this dedicated event is the delivery path.
    // Destination 'web-ui' ⇒ broadcast to every client (no stream subscription
    // needed: the pill renders wherever a session row does).
    bus.emit(EventNames.SESSION_SETTINGS_APPLIED, {
      sessionId: sid,
      ...(this.taskId ? { taskId: this.taskId } : {}),
      effectiveEffort: next ?? null,
      requestedEffort: this._effort ?? null,
      ...(appliedModel ? { model: appliedModel } : {}),
    }, ['web-ui'], { source: 'session-runner' })
    return { effort: next ?? null, model: appliedModel ?? null }
  }

  /** Back-compat wrapper — effort-only view of refreshAppliedSettings. */
  async refreshEffectiveEffort(reason: string): Promise<import('../core/types.js').SessionEffort | null> {
    return (await this.refreshAppliedSettings(reason))?.effort ?? null
  }

  /**
   * Resolve a pending permission request from the UI.
   * Called by the API route when the user clicks allow/deny.
   *
   * `updatedInputPatch` is shallow-merged over the original tool input in the
   * allow response — the AskUserQuestion card uses it to send `{ answers }`.
   */
  resolvePermissionRequest(
    requestId: string,
    allow: boolean,
    denyMessage?: string,
    updatedInputPatch?: Record<string, unknown>,
  ): boolean {
    const pending = this._pendingPermissionRequests.get(requestId)
    if (!pending) return false
    this._pendingPermissionRequests.delete(requestId)
    this._clearPermissionReEmitTimer(requestId)
    const written = this.respondToControlRequest(requestId, pending.request, allow, denyMessage, updatedInputPatch)

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

  /**
   * Force-settle ALL pending permission requests as denied. For retired sessions
   * (archived plan sessions, etc.) — unlike resolvePermissionRequest, this never
   * re-queues on transport loss: the deny write to the CLI is best-effort (the
   * process is dead or about to be killed), but the re-emit timers, UI state and
   * persisted record are always cleaned up so the 60s re-ask loop stops.
   */
  forceSettlePermissionRequests(reason: string): void {
    for (const [requestId, pending] of [...this._pendingPermissionRequests]) {
      this._pendingPermissionRequests.delete(requestId)
      this._clearPermissionReEmitTimer(requestId)
      this.respondToControlRequest(requestId, pending.request, false, reason)
      if (this.claudeSessionId) {
        bus.emit(EventNames.SESSION_PERMISSION_RESOLVED, {
          sessionId: this.claudeSessionId,
          taskId: this.taskId,
          requestId,
          toolName: pending.request.tool_name,
          allowed: false,
        }, ['*'], { source: 'session-runner' })
      }
    }
    if (this.claudeSessionId) {
      import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
        updateSessionRecord(this.claudeSessionId!, { pendingPermission: undefined }),
      ).catch(() => {})
    }
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
      // Backstop: an archived session is retired — nobody will ever approve its
      // permissions, so settle them as denied instead of re-asking forever.
      // Covers any archive path that forgets to call forceSettlePermissionRequests.
      if (this.claudeSessionId) {
        import('../core/session-tracker.js')
          .then(({ getSessionByClaudeId }) => getSessionByClaudeId(this.claudeSessionId!))
          .then(record => {
            if (record?.archived && this._pendingPermissionRequests.has(requestId)) {
              log.session.info('permission re-emit: session archived — force-settling instead of re-asking', {
                sessionId: this.claudeSessionId, requestId, toolName: request.tool_name,
              })
              this.forceSettlePermissionRequests('Session archived — permission request retired')
            }
          })
          .catch(() => {})
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
      effort: this._effort,
      profile: this._profile,
      lane: this._lane,
      // Init-only spawn persists while parked ('idle' — no first turn). All
      // other callers persist mid-turn, where the default 'running' is right.
      initialProcessStatus: this._processStatus === 'idle' ? 'idle' : undefined,
    })
  }
}

// ── SessionRunner ──

export class SessionRunner {
  private sessions = new Map<string, ClaudeCodeSession>()
  /** ACP-backed sessions (engine='codex'), keyed by trackingId (providerSessionId or runtimeId). */
  private acpSessions = new Map<string, AcpSession>()
  /** One reattach constructor/consumer per durable session ID. */
  private acpAttachPromises = new Map<string, Promise<AcpSession | undefined>>()
  /** Explicit native restarts currently replacing a CLI transport. Hidden
   *  self-report requests use this barrier to retry once on the new process. */
  private nativeSessionReinitializations = new Map<string, Promise<void>>()
  /** Sessions constructed by reattach but not yet published into acpSessions. */
  private acpAttachingSessions = new Set<AcpSession>()
  /** Fences async reattach work that completes after runner destruction. */
  private acpLifecycleEpoch = 0
  private acpDestroyed = false
  private cliCommand: string
  private activeProcessing = new Set<string>()
  private batchCounts = new Map<string, number>()
  /** Queue message ids (`qm-…`) of the in-flight batch, parallel to batchCounts.
   *  Lets SESSION_BATCH_COMPLETED carry exact ids (frontend removes exactly
   *  these optimistic bubbles) instead of a bare count ("remove first N"). */
  private batchMessageIds = new Map<string, string[]>()
  /** Safety timers that auto-clear stuck activeProcessing entries */
  private activeProcessingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Explicit ACP interrupt barrier. A cancelled turn may emit its terminal
   *  event before acpAbortTurn has killed the worker process group; queue drain
   *  must wait for the operation's completion, not merely that terminal frame. */
  private acpAbortInProgress = new Set<string>()
  /** Prompt acceptance and its queue cleanup are separate async operations.
   *  A very fast ACP turn can emit its terminal fact between them; terminal
   *  drain waits on this barrier so the next oldest item cannot be stranded
   *  behind the accepted item's still-processing queue row. */
  private acpDeliverySettlements = new Map<string, Promise<void>>()

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
   * Worker A transport contract consumed by the runner. Keep this structural:
   * the lifecycle implementation stays in AcpSession, while the runner owns
   * queue ordering and task semantics.
   */
  private acpContract(session: AcpSession): {
    establish: () => Promise<string>
    send: (message: string, walnutMessageId: string) => Promise<void>
    abortTurn: () => Promise<void>
    requestTurnCompleteSelfReport?: (prompt: string, timeoutMs: number) => Promise<string>
  } {
    const candidate = session as unknown as {
      establish?: () => Promise<string>
      send?: (message: string, walnutMessageId: string) => Promise<void>
      abortTurn?: () => Promise<void>
      requestTurnCompleteSelfReport?: (prompt: string, timeoutMs: number) => Promise<string>
    }
    if (typeof candidate.establish !== 'function'
      || typeof candidate.send !== 'function'
      || typeof candidate.abortTurn !== 'function') {
      throw new Error(
        'ACP lifecycle contract unavailable: AcpSession must implement establish(), send(text, walnutMessageId), and abortTurn()',
      )
    }
    return {
      establish: candidate.establish.bind(session),
      send: candidate.send.bind(session),
      abortTurn: candidate.abortTurn.bind(session),
      requestTurnCompleteSelfReport:
        typeof candidate.requestTurnCompleteSelfReport === 'function'
          ? candidate.requestTurnCompleteSelfReport.bind(session)
          : undefined,
    }
  }

  /**
   * Await the CURRENTLY open turn for a session, if one is in flight.
   * Returns `undefined` immediately when no turn is open (nothing to wait on —
   * NOT the same as a settled/errored turn). Otherwise resolves with the same
   * `TurnOutcome` that `clearActiveProcessing()` settled the ledger with, or
   * rejects if the turn times out / gets aborted (kill, interrupt, spawn failure).
   *
   * This is the payoff of the turn ledger: a caller that today would poll
   * `hasPipe`/`processStatus` to guess "is it done yet?" can instead await a
   * deterministic promise resolved by the SAME code that already decides
   * turn-completion (clearActiveProcessing's call sites) — no new guessing.
   */
  currentTurn(sessionId: string): Promise<import('./turn-ledger.js').TurnOutcome> | undefined {
    return getOpenTurnPromise(sessionId)
  }

  /**
   * Clear activeProcessing + batchCounts + safety timer for a session, and
   * settle its turn-ledger promissory note with `outcome` (default: 'idle' —
   * the common "turn completed normally" case). Centralizes cleanup to
   * prevent dangling timers or stale entries.
   *
   * `activeProcessing` membership IS "a turn is in flight" — `setActiveProcessing`/
   * `clearActiveProcessing` already bracket exactly one turn per call. Routing
   * the ledger through these two existing chokepoints means every existing
   * call site gets promise-based turn accounting for free, with no new guessing
   * logic: the ledger only records outcomes this code already decided.
   */
  private clearActiveProcessing(sessionId: string, outcome: import('./turn-ledger.js').TurnOutcome = { kind: 'idle' }): void {
    this.activeProcessing.delete(sessionId)
    this.batchCounts.delete(sessionId)
    this.batchMessageIds.delete(sessionId)
    const timer = this.activeProcessingTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.activeProcessingTimers.delete(sessionId)
    }
    settleTurn(sessionId, outcome)
  }

  /**
   * Add a session to activeProcessing with a safety timeout, and open a
   * turn-ledger promissory note for it. The timeout auto-clears the entry
   * (default 60s) to prevent permanent stuck state (e.g., if SESSION_RESULT
   * arrives with a mismatched session ID) — that timeout used to be a bare
   * guess with no distinguishable cause; it now rejects the ledger promise
   * with 'no_result' via `abortTurn`, so any caller awaiting this turn gets a
   * precise failure instead of silently having activeProcessing cleared.
   * ACP callers pass a larger budget: their turn identity can't rename
   * mid-turn (immutable runtimeId), so the mismatch failure mode the 60s
   * guess covers doesn't exist there, and real ACP turns routinely run
   * minutes — the short timer fired a false 'no_result' on every one.
   */
  private setActiveProcessing(sessionId: string, batchCount: number, messageIds?: string[], safetyTimeoutMs = 60_000): void {
    this.activeProcessing.add(sessionId)
    this.batchCounts.set(sessionId, batchCount)
    if (messageIds) this.batchMessageIds.set(sessionId, [...messageIds])
    openTurn(sessionId)

    // Cancel any existing safety timer for this sessionId
    const existingTimer = this.activeProcessingTimers.get(sessionId)
    if (existingTimer) clearTimeout(existingTimer)

    // Set safety timeout — prevents permanent stuck state.
    //
    // It clears the in-flight FLAG (its actual job: unblock routing when a result
    // never arrives / arrives under a mismatched session id) but deliberately
    // KEEPS `batchMessageIds`. A normal turn routinely outlives 60s (228s observed
    // in inc-1785091339102), and deleting the ids here made the eventual
    // SESSION_BATCH_COMPLETED fire WITHOUT them (`ids=0` in the logs) — demoting
    // the frontend from exact-id bubble removal to the count fallback, which in
    // that incident left the user's message pinned at the bottom of the timeline
    // for 20 minutes. The ids are pure bookkeeping for the id-first removal path:
    // stale entries are harmless (the frontend only removes bubbles whose queueId
    // actually matches), the next batch overwrites the entry, and
    // `clearActiveProcessing` deletes it on the real turn end.
    //
    // DELIBERATELY NOT FIXED — `messageIds` at :5722 OVERWRITES rather than merges, so
    // when this timeout fires and `processNext` re-enters, the earlier turn's ids are
    // dropped and the eventual SESSION_BATCH_COMPLETED under-reports (measured on the
    // real corpus: 150/247 orphaned qm-ids, 89.9% co-signalled by this timeout).
    // Merging looks like the obvious fix and is WRONG: after a force-clear the CLI is
    // usually still chewing the FIRST turn, so a merged list reports the NEWLY queued
    // ids as "completed" before the CLI has consumed them. That is premature removal
    // proof — the one failure direction the bubble model forbids (a vanished message is
    // unacceptable; a briefly duplicated one is not). This event is therefore NOT a
    // removal signal and the frontend correctly refuses to treat it as one
    // (SessionChatHistory's `session:batch-completed` handler only bumps historyVersion;
    // bubbles are hidden from HISTORY evidence — see optimistic-dedup.ts). Under-reporting
    // costs only a status-badge fallback, so leave the overwrite alone.
    const timer = setTimeout(() => {
      if (this.activeProcessing.has(sessionId)) {
        log.session.warn(`activeProcessing safety timeout (${Math.round(safetyTimeoutMs / 1000)}s): force-clearing stuck entry (batch ids retained)`, { sessionId })
        this.activeProcessing.delete(sessionId)
        this.batchCounts.delete(sessionId)
        this.activeProcessingTimers.delete(sessionId)
        abortTurn(sessionId, 'activeProcessing-safety-timeout')
        // Try to process next messages if any accumulated while stuck
        this.processNext(sessionId).catch(() => {})
      }
    }, safetyTimeoutMs)
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
          // ACP (codex) sessions are NOT native CLI processes — attachToExisting
          // here would register a native wrapper that shadows the ACP registry
          // for this sid (2026-08-10: title side_questions were dispatched into
          // a codex session through such a wrapper and could only ever fail).
          // They re-attach lazily via maybeAttachAcpSession on first use.
          if (record.engine === 'codex') continue
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
          log.session.info('session start requested', { taskId: startData.taskId, host: startData.host, cwd: startData.cwd, mode: startData.mode, engine: startData.engine })
          await this.assertStartRouting(startData)
          if (startData.engine === 'codex') {
            log.session.info('session routing', { taskId: startData.taskId, type: 'acp' })
            await this.handleAcpStart(startData)
          } else if (this.sdkClient?.connected) {
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
          let acpSession = this.findAcpSession(sendData.sessionId)
          if (!acpSession && !this.sdkSessionMap.has(sendData.sessionId)) {
            // Server restarted since this ACP session was created? Re-attach from
            // the record (engine='codex') — journal replay restores the stream.
            acpSession = await this.maybeAttachAcpSession(sendData.sessionId)
          }
          if (acpSession) {
            // ACP prompts are one-at-a-time (the worker rejects a prompt while a
            // turn runs, no FIFO to inject into). Mid-turn sends stay queued and
            // drain at turn end via the SESSION_RESULT → processNext path.
            if (sendData.interrupt) {
              const abortIds = new Set([
                sendData.sessionId,
                acpSession.sessionId ?? sendData.sessionId,
              ])
              for (const id of abortIds) this.acpAbortInProgress.add(id)
              try {
                await this.acpContract(acpSession).abortTurn()
              } finally {
                for (const id of abortIds) this.acpAbortInProgress.delete(id)
              }
            }
            const providerSessionId = acpSession.sessionId ?? sendData.sessionId
            await this.drainAcpQueue(acpSession, providerSessionId)
            void this.syncPhaseAfterSend(providerSessionId)
          } else if (this.sdkSessionMap.has(sendData.sessionId)) {
            // Route to SDK if this session is tracked as an SDK session
            await this.handleSendSdk(sendData.sessionId, sendData.message, sendData.mode as SessionMode | undefined, sendData.interrupt)
          } else {
            await this.handleSend(sendData)
          }
        }
          break

        case EventNames.SESSION_INTERRUPT: {
          // Bare turn-stop (composer stop button): interrupt the running CLI
          // WITHOUT queuing a message. Reuses handleSend's interrupt prelude
          // (session.interrupt() + batch cleanup) but never calls processNext —
          // there is nothing to deliver, and the queue (if any) stays put until
          // the user actually sends.
          const { sessionId } = eventData<'session:interrupt'>(event)
          if (!sessionId) break
          log.session.info('bare interrupt requested', { sessionId })
          const acp = this.findAcpSession(sessionId)
          if (acp) {
            this.acpAbortInProgress.add(sessionId)
            try { await this.acpContract(acp).abortTurn() }
            catch (err) { log.session.warn('bare interrupt: acp abort failed', { sessionId, error: err instanceof Error ? err.message : String(err) }) }
            finally { this.acpAbortInProgress.delete(sessionId) }
            break
          }
          if (this.sdkSessionMap.has(sessionId)) {
            try { await this.sdkClient?.interrupt({ sessionId }) }
            catch (err) { log.session.warn('bare interrupt: sdk interrupt failed', { sessionId, error: err instanceof Error ? err.message : String(err) }) }
            break
          }
          for (const [, session] of this.sessions) {
            if (session.sessionId === sessionId) {
              await session.interrupt()
              break
            }
          }
          if (this.activeProcessing.has(sessionId)) {
            const oldBatchCount = this.batchCounts.get(sessionId) ?? 1
            const oldBatchIds = this.batchMessageIds.get(sessionId)
            this.clearActiveProcessing(sessionId, { kind: 'stopped' })
            bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
              sessionId,
              count: oldBatchCount,
              ...(oldBatchIds && oldBatchIds.length > 0 ? { messageIds: oldBatchIds } : {}),
            }, ['main-ai'], { source: 'session-runner' })
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
            // ACP sessions: the worker stays alive between turns — a turn-end
            // result means idle, never stopped (stopped would also wrongly
            // clear the task's session slot below).
            const acpSession = cliSession ? undefined : this.findAcpSession(sessionId)
            const status = isError ? 'error' : (acpSession ? 'idle' : (cliSession?.processStatus ?? 'stopped'))

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

          // Clear activeProcessing — try direct match first, then the rename fixup.
          // Session ID can change when --resume fails and Claude creates a new
          // session; activeProcessing still holds the OLD id. The fixup must prove
          // the stale entry belongs to THE SAME session object that emitted this
          // result — the old "any session with this taskId" heuristic cross-wired
          // UNRELATED sessions (a foreign result forced a fake turn-boundary onto
          // a session that was mid-stream: 22 cross-session fixups on 2026-07-08).
          let resolvedSessionId = sessionId
          if (!this.activeProcessing.has(sessionId)) {
            const taskId = eventData<'session:result'>(event).taskId
            // The session object that NOW carries the event's sessionId (it was
            // renamed in handleStreamLine before the result reached us).
            const emitter = this.findSessionByClaudeId(sessionId)
            if (emitter && (!taskId || emitter.taskId === taskId)) {
              for (const activeId of this.activeProcessing) {
                if (activeId === sessionId) continue
                if (emitter.hasCarriedSessionId(activeId)) {
                  resolvedSessionId = activeId
                  log.session.warn('SESSION_RESULT: sessionId mismatch — matched via prior id of same session', {
                    expectedSessionId: activeId,
                    actualSessionId: sessionId,
                    taskId,
                  })
                  break
                }
              }
            }
            if (resolvedSessionId === sessionId) {
              const acpEmitter = this.findAcpSession(sessionId)
              if (acpEmitter && (!taskId || acpEmitter.taskId === taskId)) {
                for (const activeId of this.activeProcessing) {
                  if (activeId !== sessionId
                    && this.findAcpSession(activeId) === acpEmitter) {
                    resolvedSessionId = activeId
                    log.session.warn('SESSION_RESULT: ACP provider ID changed — matched via runtime identity', {
                      expectedSessionId: activeId,
                      actualSessionId: sessionId,
                      runtimeId: acpEmitter.runtimeId,
                      taskId,
                    })
                    break
                  }
                }
              }
            }
            if (resolvedSessionId === sessionId && this.activeProcessing.size > 0) {
              // No provable owner — do NOT guess. The stale entry self-heals via
              // the 60s activeProcessing safety timeout.
              log.session.info('SESSION_RESULT: no activeProcessing match — leaving stale entries to safety timeout', {
                sessionId, taskId, activeCount: this.activeProcessing.size,
              })
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
          const batchIds = this.batchMessageIds.get(resolvedSessionId)
          const resultIsError = event.name === EventNames.SESSION_ERROR
            || (eventData<'session:result'>(event) as { isError?: boolean }).isError === true
          this.clearActiveProcessing(resolvedSessionId, { kind: 'result', isError: resultIsError })

          // NO un-scoped removeProcessed here. Every delivery point already removes
          // its own batch eagerly (FIFO write / mid-turn inject / settleResumeSuccess),
          // so by turn-end there is nothing legitimately left in 'processing'. The only
          // thing an un-scoped sweep could hit is a CONCURRENT in-flight batch (e.g. a
          // --resume spawn settling seconds later) — deleting it silently lost the
          // user's message. Worst case of not sweeping: a stuck 'processing' message
          // survives until restart and gets redelivered (duplicate > loss).

          // Tell frontend which optimistic messages to clear (ids when known)
          bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
            sessionId: resolvedSessionId,
            count: batchCount,
            ...(batchIds && batchIds.length > 0 ? { messageIds: batchIds } : {}),
          }, ['main-ai'], { source: 'session-runner' })

          // Process the next queued item only after an explicit ACP interrupt
          // has finished terminating the worker process group. The terminal
          // cancelled fact can arrive before acpAbortTurn resolves.
          if (!this.acpAbortInProgress.has(sessionId)
            && !this.acpAbortInProgress.has(resolvedSessionId)) {
            const deliverySettlement = this.acpDeliverySettlements.get(sessionId)
              ?? this.acpDeliverySettlements.get(resolvedSessionId)
            if (deliverySettlement) await deliverySettlement
            this.processNext(resolvedSessionId).catch((err) => {
              log.session.error('processNext failed after result/error', {
                sessionId: resolvedSessionId,
                error: err instanceof Error ? err.message : String(err),
              })
            })
          } else {
            log.session.info('acp: terminal event observed during abort — replacement remains queued', {
              sessionId,
            })
          }
          break
        }
      }
    })
  }

  /**
   * Force-refetch the model catalog from ONE live local session (settings.json
   * changed — running CLIs hot-reload it, so a live process answers with the
   * NEW menu). One fetch is enough: the catalog is a host property, and the
   * fetch itself pushes SESSION_MODEL_CATALOG + rewrites the host store for
   * every picker. No live local session → nothing to ask; the store refreshes
   * on the next spawn (or the picker's manual refresh).
   *
   * Ask the MOST RECENTLY SPAWNED session: settings hot-reload fixes the
   * allowlist/overrides view, but the model REGISTRY is baked into the binary
   * — a long-lived CLI on an old binary answers with a degraded menu (missing
   * newer families). Live-verified: an old attached process returned 2 rows
   * where a fresh spawn returns 6.
   */
  refreshLocalModelCatalogs(): void {
    let best: ClaudeCodeSession | null = null
    for (const [, session] of this.sessions) {
      if (session.host || !session.active) continue
      if (!best || session.spawnTs > best.spawnTs) best = session
    }
    if (best) void best.getModelCatalog({ force: true }).catch(() => {})
  }

  /**
   * Detach from all sessions (they survive) and unsubscribe.
   * Use this for graceful server shutdown — sessions continue running.
   */
  destroy(): void {
    this.acpLifecycleEpoch++
    this.acpDestroyed = true
    for (const [, session] of this.sessions) {
      session.detach()
    }
    for (const session of new Set([
      ...this.acpSessions.values(),
      ...this.acpAttachingSessions,
    ])) {
      session.detach()
    }
    this.sessions.clear()
    this.acpSessions.clear()
    this.acpAttachPromises.clear()
    this.acpAttachingSessions.clear()
    abortAllTurns('session-runner-destroyed')
    this.nativeSessionReinitializations.clear()
    this.activeProcessing.clear()
    this.batchCounts.clear()
    this.batchMessageIds.clear()
    for (const timer of this.activeProcessingTimers.values()) clearTimeout(timer)
    this.activeProcessingTimers.clear()
    this.acpAbortInProgress.clear()
    this.acpDeliverySettlements.clear()
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
    this.acpLifecycleEpoch++
    this.acpDestroyed = true
    for (const [, session] of this.sessions) {
      session.kill()
    }
    for (const session of new Set([
      ...this.acpSessions.values(),
      ...this.acpAttachingSessions,
    ])) {
      void session.kill().catch(() => {})
      session.detach()
    }
    // Stop SDK sessions via session server
    if (this.sdkClient?.connected) {
      for (const [sessionId] of this.sdkSessionMap) {
        this.sdkClient.stopSession({ sessionId }).catch(() => {})
      }
    }
    this.sessions.clear()
    this.acpSessions.clear()
    this.acpAttachPromises.clear()
    this.acpAttachingSessions.clear()
    abortAllTurns('session-runner-destroyed-and-killed')
    this.nativeSessionReinitializations.clear()
    this.activeProcessing.clear()
    this.batchCounts.clear()
    this.batchMessageIds.clear()
    for (const timer of this.activeProcessingTimers.values()) clearTimeout(timer)
    this.activeProcessingTimers.clear()
    this.acpAbortInProgress.clear()
    this.acpDeliverySettlements.clear()
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
   * Apply a permission mode to a live CLI and return only after confirmation.
   * Sessions launched before Walnut authorized the bypass capability are
   * gracefully resumed once with the requested mode and current startup flags.
   */
  async changePermissionMode(
    claudeSessionId: string,
    mode: SessionMode,
  ): Promise<'applied' | 'reinitialized' | 'not-live'> {
    const live = await this.getOrAttachLiveSession(claudeSessionId)
    if (!live) return 'not-live'

    try {
      const confirmed = await live.applyPermissionMode(mode)
      if (!confirmed) {
        // A non-echo means the CLI declined the mode without erroring — the
        // likely cause is a mode gated behind a model/feature check on that CLI
        // build. Name that possibility: a bare "did not confirm" reads like a
        // Walnut bug when it's the CLI's own policy.
        //
        // NOTE: `auto` is NOT provider-restricted. A firstParty-only-looking
        // branch in the CLI source selects the MODEL ALLOWLIST, not the feature.
        // Official changelog: 2.1.158 shipped auto on Bedrock/Vertex/Foundry
        // behind CLAUDE_CODE_ENABLE_AUTO_MODE; 2.1.207 made it available with no
        // opt-in. Measured here on 2.1.220 + Bedrock: init echoes `auto`, and a
        // Write the same session refused under `default` was auto-allowed under
        // `auto` — the classifier genuinely runs. Don't special-case auto.
        //
        // The real constraints, if this ever does fire for auto: the model must
        // be Sonnet 5 / Opus 4.7+ / Fable 5 on non-first-party providers, and
        // the classifier is a separate billed model invocation, so the account
        // must be able to invoke it.
        throw new Error(
          `Claude Code did not confirm permission mode "${mode}" — this CLI build may not support it`,
        )
      }
      return 'applied'
    } catch (err) {
      if (mode !== 'bypass' || !isMissingBypassCapabilityError(err)) throw err
      log.session.info('permission mode requires bypass startup capability — reinitializing', {
        sessionId: claudeSessionId, mode,
      })
      await this.reinitialize(claudeSessionId, mode)
      return 'reinitialized'
    }
  }

  /**
   * Kill orphaned claude processes from stopped/terminal sessions.
   * Scans sessions.json for sessions with PIDs where process_status is 'stopped'
   * or in terminal state, but the OS process is still alive.
   * This prevents accumulation of zombie claude processes over time.
   */
  private async killOrphanedSessionProcesses(): Promise<void> {
    // Single-flight: this runs fire-and-forget on every session start, and each
    // run scans the whole sessions table + execs `ps` per live pid. Without the
    // guard, launching several sessions back-to-back (or one Quick Start while a
    // cron start fires) stacks concurrent scans that each burn CPU and contend on
    // the same reads. Callers get the in-flight run's promise instead.
    if (this._orphanSweepInFlight) return this._orphanSweepInFlight
    const run = this._runOrphanSweep().finally(() => { this._orphanSweepInFlight = null })
    this._orphanSweepInFlight = run
    return run
  }

  private _orphanSweepInFlight: Promise<void> | null = null

  private async _runOrphanSweep(): Promise<void> {
    try {
      const { listSessions, isTerminalSession } = await import('../core/session-tracker.js')
      const sessions = await listSessions()

      // Cheap filters first (pure field reads, no syscalls), so the expensive
      // liveness probes below run only for genuine candidates.
      const candidates = sessions.filter((s) => {
        if (s.pid == null) return false
        if (s.provider === 'embedded' || s.provider === 'sdk') return false
        return s.process_status === 'stopped' || s.process_status === 'error' || isTerminalSession(s)
      })

      // Probe liveness in PARALLEL. Each isProcessAliveAsync spawns `ps` (up to a
      // 3s timeout); serially that was O(candidates) × exec latency — the bulk of
      // the old ~1–2s. They're independent reads, so fan them out.
      const alive = await Promise.all(
        candidates.map(async (s) => ({
          s,
          isAlive: await isProcessAliveAsync(s.pid!, s.host ? 'ssh' : 'claude'),
        })),
      )

      let killed = 0
      for (const { s, isAlive } of alive) {
        if (!isAlive) continue

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

        // Non-null: the candidate filter above admitted only pid != null rows.
        try { process.kill(s.pid!, 'SIGTERM') } catch { /* already dead */ }
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
  findSessionByClaudeId(claudeSessionId: string): ClaudeCodeSession | undefined {
    for (const [, session] of this.sessions) {
      if (session.sessionId === claudeSessionId) return session
    }
    return undefined
  }

  /**
   * Tell the in-memory session (if any) that the kill about to be delivered is
   * intentional, so its liveness monitor reports an expected exit instead of a
   * red "session init failed" error notification. Safe no-op when the session
   * isn't in memory (already reaped, or another server owns it).
   */
  markExpectedTeardown(claudeSessionId: string, reason: string): void {
    this.findSessionByClaudeId(claudeSessionId)?.markExpectedTeardown(reason)
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

  /** Check if a session has an armed cron (/loop). Used by the health monitor
   *  and by the terminate route (409 cron_owner): a cron-armed session looks
   *  idle between fires, but killing the CLI silently kills a session-scoped
   *  loop — and only CronDelete stops one for good, since `--resume` revives it
   *  from history replay. */
  isCronArmed(claudeSessionId: string): boolean {
    const session = this.findSessionByClaudeId(claudeSessionId)
    return session?.cronArmed ?? false
  }

  /** Check if a session has background workflow/subagent tasks still running.
   *  Used by health monitor to skip the idle-timeout kill — a dynamic workflow can run
   *  for many minutes with no main-turn output, but the session is NOT idle.
   *
   *  L2: PULLs the daemon-authoritative task state first (the source of truth) and reconciles
   *  any task Walnut still thinks is 'running' but the daemon — which persisted every event in
   *  the append-only jsonl — has recorded terminal. This deterministically heals a lost-terminal
   *  event (the inc-…afr3cs failure mode that survived a transport gap) WITHOUT guessing
   *  liveness: we adopt a more-authoritative record, we never infer "probably dead". Falls back
   *  to the local derived count when the daemon can't be reached or doesn't support getState.
   *  See docs/plan/daemon-source-of-truth-versioned-events.md. */
  async isBackgroundWorkActive(claudeSessionId: string): Promise<boolean> {
    const session = this.findSessionByClaudeId(claudeSessionId)
    if (!session) return false
    await session.reconcileFromDaemon()
    return session.hasActiveBackgroundWork()
  }

  /** PULL daemon-authoritative task state for a session that is NOT a turn-over
   *  gating candidate — i.e. it's already idle / AWAIT_HUMAN_ACTION, so neither
   *  checkHungSessions (running-only) nor checkIdleTimeout's isBackgroundWorkActive
   *  call (skipped for AWAIT_HUMAN_ACTION, and a no-op once _runningBgCount() is
   *  already 0 because the only outstanding entry is `isBackgrounded`) ever reaches
   *  reconcileFromDaemon() for it. A backgrounded task's lost terminal event then has
   *  NO self-heal opportunity for the lifetime of the session (inc-1784012867247: a
   *  workflow panel pinned at a stale count for 56+ minutes after the real work
   *  finished). Health monitor calls this on the periodic tick for exactly that class
   *  of session — reconcileFromDaemon() itself is a no-op (besides the daemon RPC)
   *  when nothing changed, so this is safe to poll unconditionally. */
  async reconcilePendingBackgroundTasks(claudeSessionId: string): Promise<void> {
    const session = this.findSessionByClaudeId(claudeSessionId)
    if (!session || !session.hasPendingBackgroundTasks()) return
    await session.reconcileFromDaemon()
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
    effort?: import('../core/types.js').SessionEffort
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
    forkedFromSessionId?: string
    engine?: import('../core/types.js').SessionEngine
    /** Launch-config bundle (see core/types.ts SessionProfile). */
    profile?: import('../core/types.js').SessionProfile
    /** Lane binding — exempts the session from capacity + default lists. */
    lane?: string
  }): Promise<{ claudeSessionId: string; title: string }> {
    await this.assertStartRouting(data)
    if (data.engine === 'codex') {
      return this.handleAcpStart(data)
    }

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

  private async assertStartRouting(data: {
    engine?: import('../core/types.js').SessionEngine
    forkedFromSessionId?: string
  }): Promise<void> {
    if (!data.forkedFromSessionId) return
    if (data.engine === 'codex') {
      throw new AcpForkUnsupportedError(data.forkedFromSessionId)
    }
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const source = await getSessionByClaudeId(data.forkedFromSessionId)
    if (source) assertSessionForkSupported(source)
  }

  /**
   * Re-attach an ACP session from its record after a web-server restart. The
   * daemon worker (or at least its journal) survived us; constructing an
   * AcpSession with the persisted runtimeId + providerSessionId lets the next
   * send hit the live worker (or lazy-resume via session/load). Returns
   * undefined for non-ACP records — callers fall through to the native path.
   */
  private async maybeAttachAcpSession(sessionId: string): Promise<AcpSession | undefined> {
    if (this.acpDestroyed) return undefined
    const attached = this.findAcpSession(sessionId)
    if (attached) return attached
    const {
      getAcpIdentityReplacementTarget,
      getSessionByClaudeId,
    } = await import('../core/session-tracker.js')
    const initialRecord = await getSessionByClaudeId(sessionId)
    if (!initialRecord || initialRecord.engine !== 'codex') return undefined
    const replacementTarget = getAcpIdentityReplacementTarget(initialRecord)
    if (initialRecord.archived && !replacementTarget) return undefined
    const runtimeKey = initialRecord.acpRuntimeId
      ? `runtime:${initialRecord.acpRuntimeId}`
      : `session:${sessionId}`
    const pending = this.acpAttachPromises.get(sessionId)
      ?? this.acpAttachPromises.get(runtimeKey)
    if (pending) return pending
    const epoch = this.acpLifecycleEpoch
    const attaching = this.attachAcpSessionFromRecord(sessionId, epoch, initialRecord)
    this.acpAttachPromises.set(sessionId, attaching)
    this.acpAttachPromises.set(runtimeKey, attaching)
    try {
      return await attaching
    } finally {
      for (const key of [sessionId, runtimeKey]) {
        if (this.acpAttachPromises.get(key) === attaching) {
          this.acpAttachPromises.delete(key)
        }
      }
    }
  }

  private async attachAcpSessionFromRecord(
    sessionId: string,
    epoch: number,
    initialRecord?: import('../core/types.js').SessionRecord,
  ): Promise<AcpSession | undefined> {
    const {
      deleteSessionRecords,
      getAcpIdentityReplacementTarget,
      getSessionByClaudeId,
    } = await import('../core/session-tracker.js')
    let record = initialRecord ?? await getSessionByClaudeId(sessionId)
    if (!record || record.engine !== 'codex') return undefined
    let migratedFrom: string | undefined
    if (record.archived) {
      const replacementId = getAcpIdentityReplacementTarget(record)
      if (!replacementId) return undefined
      const replacement = await getSessionByClaudeId(replacementId)
      if (!replacement
        || replacement.archived
        || replacement.engine !== 'codex'
        || replacement.acpRuntimeId !== record.acpRuntimeId
        || replacement.taskId !== record.taskId) {
        throw new Error(
          `ACP identity migration ${sessionId} -> ${replacementId} is incomplete or inconsistent`,
        )
      }
      const { replaceSessionIdLinks } = await import('../core/task-manager.js')
      if (record.taskId) {
        await replaceSessionIdLinks(record.taskId, sessionId, replacementId)
      }
      await migrateSessionQueue(sessionId, replacementId)
      await deleteSessionRecords(new Set([sessionId]), 'acp-identity-migration-attach')
      emitAcpIdentityBoundary(record.taskId, sessionId, replacementId)
      migratedFrom = sessionId
      record = replacement
    }
    let session: AcpSession | undefined
    try {
      session = new AcpSession({
        taskId: record.taskId ?? '',
        project: record.project ?? '',
        cwd: record.cwd || process.env.HOME || process.cwd(),
        mode: (record.mode as SessionMode | undefined) ?? 'default',
        providerSessionId: record.claudeSessionId,
        runtimeId: record.acpRuntimeId,
        acpConfig: record.acpConfig,
        ...(record.lane ? await buildAcpLaneConfig(record.lane) : {}),
        directWsUrl: this._testDaemonUrl,
        artifacts: this._testAcpArtifacts,
        onWorkerDead: (s) => this.scheduleAcpDrainAfterDeath(s),
      })
      this.acpAttachingSessions.add(session)
      let establishedId: string
      try {
        establishedId = await this.acpContract(session).establish()
      } finally {
        this.acpAttachingSessions.delete(session)
      }
      const currentRecord = await getSessionByClaudeId(establishedId)
        ?? await getSessionByClaudeId(sessionId)
      if (this.acpDestroyed
        || epoch !== this.acpLifecycleEpoch
        || !currentRecord
        || currentRecord.archived
        || currentRecord.engine !== 'codex'
        || currentRecord.acpRuntimeId !== session.runtimeId) {
        await this.retireAcpAttachment(session, establishedId, currentRecord?.taskId)
        return undefined
      }
      this.acpSessions.set(session.runtimeId, session)
      this.acpSessions.set(record.claudeSessionId, session)
      this.acpSessions.set(establishedId, session)
      if (migratedFrom) this.acpSessions.set(migratedFrom, session)
      await this.linkAcpSessionToTask(
        currentRecord.taskId,
        establishedId,
        currentRecord.mode,
      )
      const publishedRecord = await getSessionByClaudeId(establishedId)
      if (this.acpDestroyed
        || epoch !== this.acpLifecycleEpoch
        || !publishedRecord
        || publishedRecord.archived
        || publishedRecord.engine !== 'codex'
        || publishedRecord.acpRuntimeId !== session.runtimeId) {
        await this.retireAcpAttachment(
          session,
          establishedId,
          publishedRecord?.taskId ?? currentRecord.taskId,
        )
        return undefined
      }
      log.session.info('acp: re-attached session from record', {
        sessionId: establishedId, runtimeId: session.runtimeId,
      })
      // A turn's terminal fact may have landed while NO AcpSession was alive
      // to observe it (server-restart window): nothing projected session:result,
      // so processNext never fired and queued messages waited for an unrelated
      // poke (2026-08-10 incident: 4-minute stall until a browser GET attached
      // us). Turn state is worker-authoritative after establish(), so drain
      // now — drainAcpQueue's activity gate keeps a genuinely running turn
      // queued, and a rejected send reverts to pending.
      const drainTarget = session
      setImmediate(() => {
        void this.drainAcpQueue(drainTarget, establishedId).catch((err) => {
          log.session.warn('acp: post-attach queue drain failed', {
            sessionId: establishedId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      })
      return session
    } catch (err) {
      if (session) {
        this.acpAttachingSessions.delete(session)
        for (const [key, candidate] of this.acpSessions) {
          if (candidate === session) this.acpSessions.delete(key)
        }
        session.detach()
      }
      log.session.warn('acp: re-attach from record failed', {
        sessionId, error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private async retireAcpAttachment(
    session: AcpSession,
    sessionId: string,
    taskId?: string,
  ): Promise<void> {
    for (const [key, candidate] of this.acpSessions) {
      if (candidate === session) this.acpSessions.delete(key)
    }
    if (taskId) {
      const { clearSession, clearSessionSlot } = await import('../core/task-manager.js')
      await clearSessionSlot(taskId, sessionId).catch(() => {})
      await clearSession(taskId, sessionId).catch(() => {})
    }
    await session.kill().catch(() => {})
    session.detach()
  }

  /**
   * Worker death without a terminal journal fact leaves queued messages
   * stranded: no session:result → no processNext → the queue waits for an
   * unrelated poke. The daemon repairs the journal tail on the NEXT acpStart,
   * so drain shortly after death — abort paths are excluded (their own drain
   * runs after the abort completes), and drainAcpQueue's own send path
   * lazy-resumes the provider thread.
   */
  private scheduleAcpDrainAfterDeath(session: AcpSession): void {
    const sid = session.sessionId ?? session.runtimeId
    if (this.acpAbortInProgress.has(sid) || this.acpAbortInProgress.has(session.runtimeId)) return
    setTimeout(() => {
      if (this.acpDestroyed) return
      if (this.acpAbortInProgress.has(sid) || this.acpAbortInProgress.has(session.runtimeId)) return
      void this.drainAcpQueue(session, sid).catch((err) => {
        log.session.warn('acp: post-death queue drain failed', {
          sessionId: sid, error: err instanceof Error ? err.message : String(err),
        })
      })
    }, 1_000).unref()
  }

  /** Lookup an ACP session by its trackingId (providerSessionId or runtimeId). */
  findAcpSession(sessionId: string): AcpSession | undefined {
    const direct = this.acpSessions.get(sessionId)
    if (direct) return direct
    for (const s of this.acpSessions.values()) {
      if (s.sessionId === sessionId || s.runtimeId === sessionId) return s
    }
    return undefined
  }

  /** Find a live ACP session or lazily attach it from its durable record. */
  async findOrAttachAcpSession(sessionId: string): Promise<AcpSession | undefined> {
    return this.findAcpSession(sessionId) ?? await this.maybeAttachAcpSession(sessionId)
  }

  /**
   * Block until any in-flight native-session restart settles (looping in case
   * a NEWER restart replaced the one we awaited). Restart-race timeline this
   * protects: the OLD process still holds a pending side_question request id;
   * gracefulStop settles it with a dedicated "restarting" error; once this
   * barrier releases (replacement process published), the caller retries ONCE
   * against the new process using the REMAINING overall deadline — not a fresh
   * one. Collapsing this into a plain retry (or reusing the old session
   * reference across the barrier) makes turn-complete self-reports
   * intermittently vanish or double the timeout during restart windows.
   */
  private async awaitNativeReinitialization(
    sessionId: string,
    deadlineAt?: number,
  ): Promise<void> {
    while (true) {
      const operation = this.nativeSessionReinitializations.get(sessionId)
      if (!operation) return

      if (deadlineAt === undefined) {
        await operation
      } else {
        const remainingMs = deadlineAt - Date.now()
        if (remainingMs <= 0) throw new Error('side question timed out during session restart')
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('side question timed out during session restart')),
                remainingMs,
              )
            }),
          ])
        } finally {
          if (timer) clearTimeout(timer)
        }
      }

      const current = this.nativeSessionReinitializations.get(sessionId)
      if (!current || current === operation) return
    }
  }

  /**
   * Provider-neutral control channel used by the turn-complete summary hook.
   * Native Claude uses side_question; ACP provides an equivalent hidden report
   * request so the existing merge/phase/notify policy stays provider-agnostic.
   */
  async requestTurnCompleteSelfReport(
    sessionId: string,
    prompt: string,
    timeoutMs: number,
  ): Promise<string> {
    const deadlineAt = Date.now() + timeoutMs
    await this.awaitNativeReinitialization(sessionId, deadlineAt)

    let native = this.findSessionByClaudeId(sessionId)
    while (native) {
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) throw new Error('side question timed out during session restart')
      try {
        return await native.askSideQuestion(prompt, remainingMs)
      } catch (err) {
        const replaced = err instanceof Error
          && (err as Error & { code?: string }).code === 'SESSION_TRANSPORT_REPLACED'
        if (!replaced || !this.nativeSessionReinitializations.has(sessionId)) throw err

        await this.awaitNativeReinitialization(sessionId, deadlineAt)
        native = this.findSessionByClaudeId(sessionId)
        if (!native) throw new Error(`No live session found after restart: ${sessionId}`)
        log.session.info('turn-complete-summary: retrying self-report after session restart', {
          sessionId,
          remainingMs: Math.max(0, deadlineAt - Date.now()),
        })
      }
    }

    const acp = this.findAcpSession(sessionId) ?? await this.maybeAttachAcpSession(sessionId)
    if (!acp) throw new Error(`No live session found for self-report: ${sessionId}`)
    const request = this.acpContract(acp).requestTurnCompleteSelfReport
    if (!request) {
      throw new Error(
        'ACP self-report contract unavailable: AcpSession must implement requestTurnCompleteSelfReport(prompt, timeoutMs)',
      )
    }
    return request(prompt, timeoutMs)
  }

  private async linkAcpSessionToTask(
    taskId: string | undefined,
    sessionId: string,
    mode: SessionMode | undefined,
  ): Promise<void> {
    if (!taskId) return
    const {
      addSessionToHistory,
      getTask,
      linkSession,
      linkSessionSlot,
    } = await import('../core/task-manager.js')

    const slot: 'plan' | 'exec' = mode === 'plan' ? 'plan' : 'exec'
    let task = await getTask(taskId)
    let changed = false
    const slotValue = slot === 'plan' ? task.plan_session_id : task.exec_session_id
    if (slotValue !== sessionId) {
      task = (await linkSessionSlot(taskId, sessionId, slot)).task
      changed = true
    } else if (!task.session_ids?.includes(sessionId)) {
      task = (await addSessionToHistory(taskId, sessionId)).task
      changed = true
    }
    if (task.session_id !== sessionId) {
      task = (await linkSession(taskId, sessionId)).task
      changed = true
    }

    if (changed) {
      bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-link' })
    }
  }

  /**
   * Start an ACP-backed session (engine='codex'). Deliberately minimal next to
   * handleStart: no FIFO/JSONL transport, no system-prompt assembly (ACP
   * providers self-manage context) — the daemon acp* family + AcpSession own
   * everything. Returns once the first prompt is accepted.
   */
  private async handleAcpStart(data: {
    taskId: string
    message: string
    host?: string
    cwd?: string
    mode?: string
    project?: string
    title?: string
    lane?: string
    forkedFromSessionId?: string
  }): Promise<{ claudeSessionId: string; title: string }> {
    if (data.forkedFromSessionId) {
      throw new AcpForkUnsupportedError(data.forkedFromSessionId)
    }
    if (data.host && data.host !== '__local__') {
      throw new Error('Codex (ACP) sessions are local-only for now — remote host support is a later phase')
    }
    const cwd = data.cwd || process.env.HOME || process.cwd()
    const session = new AcpSession({
      taskId: data.taskId,
      project: data.project ?? '',
      cwd,
      mode: (data.mode as SessionMode | undefined) ?? 'default',
      ...(data.lane ? await buildAcpLaneConfig(data.lane) : {}),
      directWsUrl: this._testDaemonUrl,
      artifacts: this._testAcpArtifacts,
      onWorkerDead: (s) => this.scheduleAcpDrainAfterDeath(s),
    })
    // Key by runtimeId first; re-key to providerSessionId once known so
    // findAcpSession hits on both (records/API use providerSessionId).
    this.acpSessions.set(session.runtimeId, session)
    const sid = await this.acpContract(session).establish()
    this.acpSessions.set(sid, session)

    const title = data.title ?? data.message.slice(0, 120)
    try {
      const { updateSessionRecord } = await import('../core/session-tracker.js')
      await updateSessionRecord(sid, {
        title,
        description: data.message.slice(0, 500),
      })
    } catch (err) {
      log.session.warn('acp: failed to persist session title', {
        sessionId: sid,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      await this.linkAcpSessionToTask(
        data.taskId,
        sid,
        (data.mode as SessionMode | undefined) ?? 'default',
      )
    } catch (err) {
      log.session.warn('acp: failed to link session to task', {
        sessionId: sid,
        taskId: data.taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    if (data.taskId) {
      try {
        const { updateTask } = await import('../core/task-manager.js')
        await updateTask(data.taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
      } catch { /* task update is best-effort */ }
    }

    bus.emit(EventNames.SESSION_STARTED, {
      sessionId: sid,
      claudeSessionId: sid,
      taskId: data.taskId,
      project: data.project ?? '',
      provider: 'cli',
    }, ['main-ai'], { source: 'session-runner' })

    if (data.message) {
      const queued = await enqueueMessage(sid, data.message)
      bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
        sessionId: sid,
        messageId: queued.id,
        message: data.message,
        source: 'session-start',
      }, ['main-ai'], { source: 'session-start' })
      await this.drainAcpQueue(session, sid)
    }
    return { claudeSessionId: sid, title }
  }

  /** Test-only override for ACP worker/adapter command vectors (mock agent). */
  private _testAcpArtifacts: { workerCmd: string[]; adapterCmd: string[] } | undefined
  setTestAcpArtifacts(artifacts: { workerCmd: string[]; adapterCmd: string[] } | undefined): void {
    this._testAcpArtifacts = artifacts
  }

  /**
   * Drain queued messages into ONE ACP prompt. ACP is one-prompt-per-turn (the
   * worker rejects a prompt while a turn runs; there is no FIFO to inject into),
   * so a mid-turn send stays queued and re-drains when the turn's
   * SESSION_RESULT lands (processNext routes back here).
   */
  private async drainAcpQueue(session: AcpSession, sessionId: string): Promise<void> {
    if (session.activity === 'processing') {
      log.session.info('acp: turn active — message stays queued until turn end', { sessionId })
      return
    }
    const msgs = await markNextProcessing(sessionId)
    if (msgs.length === 0) return
    const [message] = msgs
    // ACP turns are worker-authoritative (journal turn-ended/interrupted facts)
    // and their identity never renames mid-turn — the 60s Claude-shaped safety
    // guess fired on EVERY ACP turn >60s (measured 63s/205s/1281s turns), each
    // time rejecting the turn ledger with a false 'no_result'. Budget ACP at
    // the worker's own op ceiling instead.
    this.setActiveProcessing(sessionId, 1, [message.id], 10 * 60_000)

    let releaseSettlement!: () => void
    const settlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve
    })
    this.acpDeliverySettlements.set(sessionId, settlement)
    try {
      await this.acpContract(session).send(message.message, message.id)
      const deliverySessionId = session.sessionId ?? sessionId
      // The durable prompt fact now owns recovery. Remove the queue copy before
      // releasing terminal drain; a terminal frame can race this exact await.
      await removeProcessed(deliverySessionId, [message.id])
      bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
        sessionId: deliverySessionId, count: 1, messageIds: [message.id],
      }, ['main-ai'], { source: 'session-runner' })
    } catch (err) {
      this.clearActiveProcessing(sessionId, { kind: 'stopped' })
      const deliverySessionId = session.sessionId ?? sessionId
      await revertToPending(msgs.map((queued) => ({
        ...queued,
        sessionId: deliverySessionId,
      })))
      throw err
    } finally {
      releaseSettlement()
      if (this.acpDeliverySettlements.get(sessionId) === settlement) {
        this.acpDeliverySettlements.delete(sessionId)
      }
    }
  }

  private async handleStart(data: {
    taskId: string
    message: string
    cwd?: string
    project?: string
    mode?: string
    model?: string
    effort?: import('../core/types.js').SessionEffort
    title?: string
    appendSystemPrompt?: string
    host?: string
    fromPlanSessionId?: string
    forkedFromSessionId?: string
    largePromptFile?: { localPath: string; originalLength: number }
    requestTs?: number
    preassignedSessionId?: string
    /** Launch-config bundle (system prompt / MCP mounts / allowedTools). Merged
     *  UNDER the config-driven walnut-MCP pre-mount below. */
    profile?: import('../core/types.js').SessionProfile
    /** Lane binding — exempts the session from capacity + default lists. */
    lane?: string
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
            const metadata = await getProjectMetadata(task.project || '')
            if (metadata?.default_cwd) cwd = metadata.default_cwd as string
          }
          // Last resort: project memory directory (LOCAL sessions only).
          // For remote sessions, a local path won't exist on the remote host —
          // fail with a clear error instead of sending a bogus cwd.
          if (!cwd) {
            if (data.host) {
              const projectLabel = task.project || 'Inbox'
              throw new Error(
                `No working directory found for remote session on host "${data.host}" ` +
                `(task: "${task.id}", project: "${projectLabel}"). ` +
                `Set a cwd on the task, or set default_cwd in project "${projectLabel}" metadata ` +
                `(e.g. /workplace/... on the remote host).`
              )
            }
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js')
            const path = await import('node:path')
            const nodeFs = await import('node:fs')
            const projectDir = path.join(PROJECTS_MEMORY_DIR, (task.project || 'inbox').toLowerCase())
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
    //
    // Deliberately NOT awaited: reaping OTHER sessions' leaked processes has no
    // causal relation to starting THIS one, but the scan is expensive (whole
    // sessions table + one `ps` exec per live pid — measured ~1–2s at 130 live
    // pids / 3.3k rows) and it sat directly in front of the spawn, so the user
    // paid all of it as click latency. Fire-and-forget keeps the cleanup while
    // letting the CLI start now. The in-flight guard inside makes a burst of
    // starts share ONE sweep instead of N concurrent table scans.
    void this.killOrphanedSessionProcesses()

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
    let taskProject: string | undefined
    if (taskId) {
      try {
        const { updateTask, getTask } = await import('../core/task-manager.js')
        await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
        const task = await getTask(taskId)
        taskTitle = task?.title
        taskProject = task?.project || undefined
      } catch (err) {
        log.session.warn('failed to update task phase on session start', { taskId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // Use agent-provided title if available, otherwise auto-generate
    if (data.title) {
      session.pendingTitle = data.title
    } else {
      const defaultPromptPrefix = 'Working on task:'
      // Empty message = init-only spawn (no first turn) — fall through to the
      // task title so the session isn't named "Title — " with a dangling dash.
      const isCustomPrompt = message.length > 0 && !message.startsWith(defaultPromptPrefix)

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

    // Resolve SSH host config from config
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()

    // Resolve model: explicit caller (picker) value ONLY. There is deliberately NO
    // config-time default — "Auto" (undefined) means send() passes no --model and
    // Claude Code uses its own settings-layer default. Model is a runtime choice.
    const resolvedModel = model
    // Resolve effort: explicit caller value > config default > undefined (no --effort, API default)
    const resolvedEffort = data.effort ?? config.agent?.session_effort

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
    // Profile: the caller's bundle, with the config-driven Walnut MCP pre-mount
    // merged ON TOP (`session.premount_walnut_mcp`, default off) so an install
    // that wants every coding session to reach the user's tasks gets it without
    // each caller opting in. mergeProfiles unions mcpServers per key, so a
    // caller's own mounts survive.
    const { mergeProfiles, walnutMcpProfile } = await import('../core/sessions/profiles.js')
    const resolvedProfile = config.session?.premount_walnut_mcp
      ? mergeProfiles(data.profile, walnutMcpProfile())
      : data.profile
    const sendOpts = {
      ...(data.preassignedSessionId ? { preassignedSessionId: data.preassignedSessionId } : {}),
      ...(resolvedProfile ? { profile: resolvedProfile } : {}),
      ...(data.lane ? { lane: data.lane } : {}),
    }
    session.send(message, cwd, resumeId, mode, resolvedModel, appendSystemPrompt, data.host, sshTarget, isFork, config.session?.permission_prompt, spillFile, config.session?.stream_partial_messages, resolvedEffort, undefined, Object.keys(sendOpts).length > 0 ? sendOpts : undefined)

    // Record directory usage for the frequent-dirs persistent store (fire-and-forget)
    if (cwd) {
      import('../core/frequent-dirs.js').then(({ recordDirectory }) => {
        recordDirectory(cwd, data.host ?? null, taskProject).catch(() => {})
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
            const metadata = await getProjectMetadata(task.project || '')
            if (metadata?.default_cwd) cwd = metadata.default_cwd as string
          }
          if (!cwd) {
            if (data.host) {
              const projectLabel = task.project || 'Inbox'
              throw new Error(
                `No working directory found for remote session on host "${data.host}" ` +
                `(task: "${task.id}", project: "${projectLabel}"). ` +
                `Set a cwd on the task, or set default_cwd in project "${projectLabel}" metadata.`
              )
            }
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js')
            const path = await import('node:path')
            const nodeFs = await import('node:fs')
            const projectDir = path.join(PROJECTS_MEMORY_DIR, (task.project || 'inbox').toLowerCase())
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
    let sdkTaskProject: string | undefined
    if (taskId) {
      try {
        const { updateTask, getTask } = await import('../core/task-manager.js')
        await updateTask(taskId, { phase: 'IN_PROGRESS' }, { source: 'session-start' })
        const task = await getTask(taskId)
        taskTitle = task?.title
        sdkTaskProject = task?.project || undefined
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
      // Empty message = init-only spawn — same dangling-dash guard as handleStart.
      const isCustomPrompt = message.length > 0 && !message.startsWith(defaultPromptPrefix)
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

    // Pass the requested mode through UNCHANGED — the session server maps it to
    // the SDK vocabulary via the same registry (see applySdkPermissionMode).
    //
    // This used to be an if-chain that fell through to 'bypass' for everything
    // that wasn't plan/accept. That is the SAME defect as the bare
    // --dangerously-skip-permissions flag: a session launched as 'dontAsk' (the
    // STRICTEST non-plan mode) ran with full write+shell trust while its record
    // — written a few lines below from `mode`, not from `sdkMode` — said
    // "dontAsk". Never re-narrow this to a hardcoded subset; add modes to
    // SESSION_MODES in core/types.ts and they arrive here for free.
    const sdkMode: SessionMode = (mode && VALID_SESSION_MODE_IDS.has(mode))
      ? mode as SessionMode
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
        recordDirectory(cwd, data.host ?? null, sdkTaskProject).catch(() => {})
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
    interrupt?: boolean
  }): Promise<void> {
    const { sessionId, mode, interrupt } = data

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
        const oldBatchIds = this.batchMessageIds.get(sessionId)
        this.clearActiveProcessing(sessionId, { kind: 'stopped' })

        bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
          sessionId,
          count: oldBatchCount,
          ...(oldBatchIds && oldBatchIds.length > 0 ? { messageIds: oldBatchIds } : {}),
        }, ['main-ai'], { source: 'session-runner' })
      }
    }

    // Model/mode switches no longer come through here — both are applied live at
    // the RPC/route layer (applyModel via apply_flag_settings; applyPermissionMode
    // via set_permission_mode — no interrupt/respawn), with cliModel/record.mode
    // persisted as the durable fallback that processNext reads on cold --resume.

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
    const restartPending = this.nativeSessionReinitializations.has(sessionId)
    log.session.info('handleSend: routing send', {
      sessionId,
      interrupt: !!interrupt,
      activeProcessing: this.activeProcessing.has(sessionId),
      restartPending,
      hasPipe: dbgTarget?.hasPipe ?? false,
      pid: dbgTarget?.processPid ?? null,
      host: dbgTarget?.host ?? null,
      path: restartPending || !this.activeProcessing.has(sessionId) ? 'processNext' : 'injectMidTurn',
    })
    if (restartPending || !this.activeProcessing.has(sessionId)) {
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
      const {
        emitSessionStatusChanged,
        getSessionByClaudeId,
        updateSessionRecord,
      } = await import('../core/session-tracker.js')
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
        const updated = await updateSessionRecord(sessionId, {
          activity: 'Processing follow-up...',
          errorMessage: undefined,  // Clear stale error on resume
        })
        // Emit status change so frontend clears the error banner immediately
        emitSessionStatusChanged(
          updated,
          { phase: 'IN_PROGRESS' },
          ['*'],
          { source: 'session-runner' },
        )
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

    // The panel accepts input while the CLI is still spawning (the id is minted
    // before the process exists), so the FIFO may not be created yet. Wait for the
    // spawn rather than writing into a missing pipe and taking the respawn path.
    await targetSession.awaitSpawn()

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
      this.batchMessageIds.set(sessionId, [...(this.batchMessageIds.get(sessionId) ?? []), ...newMsgs.map((m) => m.id)])
      // Echo-claim: the CLI re-logs this send as a canonical user line; bind its
      // uuid to these qm ids at the next history parse (exact-id dedup upstream).
      registerEchoClaims(sessionId, newMsgs.map((m) => m.id), combined)
      log.session.info('handleSend: message injected mid-turn via stdin', { sessionId, count: newMsgs.length })
      this.logDeliveryLatency(sessionId, 'mid-turn', newMsgs, targetSession)

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
        messageIds: newMsgs.map((m) => m.id),
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
  private logDeliveryLatency(sessionId: string, path: 'stdin' | 'mid-turn' | 'resume', msgs: QueuedMessage[], session?: ClaudeCodeSession): void {
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
    // Stash on the target session instance for its next per-turn wide event
    // (forensic observability). The result handler that reads these lives on
    // ClaudeCodeSession, so the values MUST land on that instance — not on the
    // runner. Fall back to a lookup if the caller didn't pass the instance.
    const target = session ?? this.findByClaudeId(sessionId)
    if (target) {
      target._lastDeliveryMs = maxMs
      target._lastDeliveryPath = path
    }
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
    // Echo-claim: --resume delivers the same combined payload via stdin — the
    // CLI echoes it as one canonical user line; bind at the next history parse.
    registerEchoClaims(sessionId, msgs.map((m) => m.id), msgs.map((m) => m.message).join('\n\n'))
    removeProcessed(sessionId, msgs.map((m) => m.id)).catch((err) => {
      log.session.warn('eager removeProcessed failed after --resume spawn', { sessionId, error: err instanceof Error ? err.message : String(err) })
    })
    bus.emit(EventNames.SESSION_MESSAGES_DELIVERED, {
      sessionId,
      count: msgs.length,
      messageIds: msgs.map((m) => m.id),
    }, ['main-ai'], { source: 'session-runner' })
    this.logDeliveryLatency(sessionId, 'resume', msgs, session)
  }

  /**
   * Settle a --resume spawn that FAILED (SSH/daemon-deploy/publickey error, EMFILE…).
   * The message was never delivered, so it MUST survive: revert the batch from
   * 'processing' back to 'pending' (recoverable on restart / user Retry) and tell the
   * UI to mark the optimistic rows 'failed' (keep text + Retry) via batch-failed —
   * NOT batch-completed (which deletes them). Called from send()'s onSpawnSettled(false).
   */
  private settleResumeFailure(sessionId: string, msgs: QueuedMessage[], err: Error): void {
    this.clearActiveProcessing(sessionId, { kind: 'error', message: err.message })
    log.session.warn('resume spawn failed — reverting batch to pending', { sessionId, error: err.message })
    // This batch produced no echo and never will. Drop its claim so a Retry of the
    // SAME text isn't shadowed by it (FIFO text-match binding would give the dead
    // claim the retry's echo line — see revokeEchoClaims).
    revokeEchoClaims(sessionId, msgs.map((m) => m.id))
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
   * Resolve the cold-resume spawn args (model + effort + profile) from the
   * persisted record. Model/mode/effort changes are applied LIVE via
   * control_requests (applyModel / applyPermissionMode / applyEffort — no
   * respawn); the record fields read here are the durable fallback so a cold
   * --resume re-applies them (control_requests are in-memory only, lost when the
   * CLI dies). The PROFILE has no live channel at all — `--system-prompt`,
   * `--mcp-config` and `--allowedTools` are spawn-time only — so re-emitting it
   * here is the ONLY thing that keeps a reaped session's identity intact.
   * Shared by processNext + reinitialize.
   */
  private async resolveResumeArgs(sessionId: string): Promise<{
    model?: string
    effort?: import('../core/types.js').SessionEffort
    profile?: import('../core/types.js').SessionProfile
    lane?: string
  }> {
    let resolvedModel: string | undefined
    let resolvedEffort: import('../core/types.js').SessionEffort | undefined
    let resolvedProfile: import('../core/types.js').SessionProfile | undefined
    let resolvedLane: string | undefined
    try {
      const { getSessionByClaudeId: getSession } = await import('../core/session-tracker.js')
      const record = await getSession(sessionId)
      if (record?.effort) {
        resolvedEffort = record.effort
      }
      if (record?.profile) resolvedProfile = record.profile
      if (record?.lane) resolvedLane = record.lane
      // Fall back to stored CLI model for --resume so the [1m] context window
      // marker is preserved.  record.cliModel stores the original --model arg
      // (e.g. "opus[1m]").  record.model stores the *reported* model from init
      // events (e.g. "global.anthropic.claude-opus-4-6-v1") which never includes
      // [1m] — using it for resume would silently downgrade to 200K context.
      // Skip malformed model strings (e.g. orphan "]" from old ANSI stripping bug).
      const storedCliModel = record?.cliModel
      const storedModel = record?.model
      if (storedCliModel) {
        resolvedModel = storedCliModel
      } else if (storedModel && (!storedModel.endsWith(']') || storedModel.endsWith('[1m]'))) {
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
          else resolvedModel = undefined  // → send() passes no --model; CLI --resume keeps the session's own model
        }
      }
    } catch (err) {
      log.session.warn('resolveResumeArgs: failed to read record', { sessionId, error: err instanceof Error ? err.message : String(err) })
    }
    return { model: resolvedModel, effort: resolvedEffort, profile: resolvedProfile, lane: resolvedLane }
  }

  /**
   * Settle an in-flight turn's batch bookkeeping (if any) so the UI stops showing
   * a streaming spinner / "Running" state. Used when a turn is killed out-of-band
   * (Restart respawn, Terminate) rather than completing naturally. Mirrors the
   * interrupt path in handleSend: clear activeProcessing + emit BATCH_COMPLETED
   * with the batch's message ids so the frontend resolves its optimistic rows.
   * No-op when the session isn't mid-turn. Does NOT sweep the disk queue —
   * pending/processing messages survive (they re-deliver on the next processNext).
   */
  settleInFlightTurn(sessionId: string): void {
    if (!this.activeProcessing.has(sessionId)) return
    const oldBatchCount = this.batchCounts.get(sessionId) ?? 1
    const oldBatchIds = this.batchMessageIds.get(sessionId)
    log.session.info('settleInFlightTurn: settling killed mid-turn batch', { sessionId, count: oldBatchCount })
    this.clearActiveProcessing(sessionId, { kind: 'stopped' })
    bus.emit(EventNames.SESSION_BATCH_COMPLETED, {
      sessionId,
      count: oldBatchCount,
      ...(oldBatchIds && oldBatchIds.length > 0 ? { messageIds: oldBatchIds } : {}),
    }, ['main-ai'], { source: 'session-runner' })
  }

  /**
   * Restart a session by respawning a fresh `claude -p --resume` process WITHOUT
   * running a turn. The new CLI re-emits its `init` event and re-runs the
   * SessionStart hook, so all spawn-time settings (CLAUDE.md, .claude/, skills,
   * MCP servers, model/effort) are reloaded — the thing users expect from "Restart".
   *
   * Why not just `mgr.kill()` (the old restart route did): a bare daemon `stop`
   * reaps the CLI and surfaces the death as `SESSION_ERROR` / "Remote session
   * exited with code -1", leaving the session in Error and never respawning. The
   * respawn path here instead detaches the old transport BEFORE spawning (send()
   * sets resultEmitted + detaches at claude-code-session.ts:1161), so the old
   * process's exit is suppressed, not surfaced as an error.
   *
   * Delivers no message (daemon cmdStart now treats message as optional → spawn
   * idle), so this costs no tokens and does NOT pollute the conversation. Any
   * pending queue is left untouched and drains on the next real send.
   */
  reinitialize(sessionId: string, modeOverride?: SessionMode): Promise<void> {
    // Coalescing rule: a restart WITHOUT a mode override is idempotent — any
    // in-flight restart satisfies it, so join it. A restart WITH an override
    // carries new state and must NOT coalesce: it chains AFTER the current
    // restart and runs again, else a permission-mode change arriving during a
    // restart window would be silently dropped.
    const existing = this.nativeSessionReinitializations.get(sessionId)
    if (existing && !modeOverride) return existing

    const operation = existing
      ? existing.then(() => this.performNativeReinitialize(sessionId, modeOverride))
      : Promise.resolve().then(() => this.performNativeReinitialize(sessionId, modeOverride))
    this.nativeSessionReinitializations.set(sessionId, operation)
    operation.then(
      () => {
        if (this.nativeSessionReinitializations.get(sessionId) === operation) {
          this.nativeSessionReinitializations.delete(sessionId)
        }
      },
      () => {
        if (this.nativeSessionReinitializations.get(sessionId) === operation) {
          this.nativeSessionReinitializations.delete(sessionId)
        }
      },
    )
    return operation
  }

  private async performNativeReinitialize(sessionId: string, modeOverride?: SessionMode): Promise<void> {
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const record = await getSessionByClaudeId(sessionId)
    if (!record) throw new Error(`reinitialize: no session record for ${sessionId}`)

    const { getConfig } = await import('../core/config-manager.js')
    const cfg = await getConfig()

    // Resolve SSH target for remote sessions so the respawn lands on the right host.
    // An unresolvable host must FAIL, not fall through — sshTarget=undefined would
    // route the send to the LOCAL daemon and silently resume a remote session here.
    let sshTarget: SshTarget | undefined
    if (record.host) {
      const hostDef = cfg.hosts?.[record.host]
      if (!hostDef) throw new Error(`reinitialize: host "${record.host}" not found in config.hosts`)
      const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string | undefined
      if (!hostname) throw new Error(`reinitialize: host "${record.host}" has no hostname configured`)
      sshTarget = { hostname, user: hostDef.user, port: hostDef.port, shell_setup: hostDef.shell_setup }
    }

    // Reuse the live session object if we have one (send() detaches its old
    // transport + suppresses the dying process's events); otherwise make a fresh one.
    let target: ClaudeCodeSession | undefined = this.findSessionByClaudeId(sessionId)
    if (!target) {
      target = new ClaudeCodeSession(record.taskId, record.project, this.cliCommand)
      target._testDaemonUrl = this._testDaemonUrl
      this.sessions.set(record.taskId || `reconnected-${sessionId}`, target)
    }

    // Mid-turn guard: if the session was actively processing a turn when Restart
    // was hit, the respawn kills that turn. Settle the in-flight batch NOW —
    // clear activeProcessing and tell the UI the batch completed — so the
    // frontend stops the streaming spinner / "Running" state immediately instead
    // of waiting out the 60s safety timeout. Mirrors handleSend's interrupt path.
    this.settleInFlightTurn(sessionId)

    // Stop through the daemon's SIGINT-first path and wait for its ack so the
    // canonical conversation is flushed before --resume reads it.
    await target.gracefulStop(true)

    // Model/effort routes persist BEFORE applying their process-local control
    // requests. Re-read after the old process is stopped so changes made during
    // the restart window are applied to the replacement CLI.
    const { model, effort, profile, lane } = await this.resolveResumeArgs(sessionId)
    const refreshedRecord = await getSessionByClaudeId(sessionId)
    const resumeMode = modeOverride ?? refreshedRecord?.mode ?? record.mode
    log.session.info('reinitialize: respawning fresh CLI (no turn)', { sessionId, taskId: record.taskId, host: record.host, model, mode: resumeMode })

    // Empty message ⇒ daemon spawns idle: init event + SessionStart hook fire,
    // no user turn runs. onSpawnSettled reports spawn success/failure only.
    await new Promise<void>((resolve, reject) => {
      target!.send('', record.cwd ?? undefined, sessionId, resumeMode, model, undefined, record.host ?? undefined, sshTarget, undefined, cfg.session?.permission_prompt, undefined, cfg.session?.stream_partial_messages, effort,
        (ok, err) => {
          if (ok) {
            import('../core/session-tracker.js').then(({ updateSessionRecord }) =>
              updateSessionRecord(sessionId, { process_status: 'running', errorMessage: undefined, status_reason: 'restart_reinitialize', status_changed_by: 'user' } as Record<string, unknown>)).catch(() => {})
            resolve()
          } else {
            reject(err ?? new Error('reinitialize spawn failed'))
          }
        },
        // Re-emit the profile's spawn-time flags on the replacement CLI —
        // "Restart" must not silently strip a session's identity.
        resumeProfileOpts(profile, lane))
    })
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

    const {
      getAcpIdentityReplacementTarget,
      getSessionByClaudeId,
    } = await import('../core/session-tracker.js')
    for (const sessionId of pendingSessions) {
      // Skip sessions mid-delivery — their batch is already in flight.
      if (this.activeProcessing.has(sessionId)) continue
      try {
        const record = await getSessionByClaudeId(sessionId)
        if (!record) continue
        // Don't resurrect an archived session on reconnect — it's been retired
        // (plan executed / user closed); resuming it would spawn a CLI for a
        // session no UI entry point points at. Leave its messages pending.
        if (record.archived && !getAcpIdentityReplacementTarget(record)) continue
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
    if (this.nativeSessionReinitializations.has(sessionId)) {
      log.session.info('processNext: waiting for explicit session restart before delivery', { sessionId })
      try {
        await this.awaitNativeReinitialization(sessionId)
      } catch (err) {
        log.session.warn('processNext: explicit restart failed — attempting normal recovery', {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ACP sessions have their own drain (one prompt per turn, no FIFO/--resume).
    const acpSession = this.findAcpSession(sessionId)
      ?? await this.maybeAttachAcpSession(sessionId)
    if (acpSession) {
      return this.drainAcpQueue(acpSession, acpSession.sessionId ?? sessionId)
    }

    const msgs = await markProcessing(sessionId)
    if (msgs.length === 0) return

    this.setActiveProcessing(sessionId, msgs.length, msgs.map((m) => m.id))

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

      // The local daemon can be mid-restart exactly when a queued message
      // arrives — its death is often WHY the message queued. Every delivery
      // path below (attachToExisting, --resume spawn) calls
      // createSessionManager, which THROWS 'Local daemon not running' if the
      // ws url isn't up yet. ensureLocalDaemon() joins the in-flight spawn
      // (in-flight guard in local-daemon.ts) instead of failing the turn —
      // observed as a chat ERROR bubble 6s into a daemon respawn.
      if (!targetSession) {
        try {
          const { getSessionByClaudeId } = await import('../core/session-tracker.js')
          const rec = await getSessionByClaudeId(sessionId)
          if (!rec?.host || rec.host === '__local__') {
            const { ensureLocalDaemon } = await import('./session-manager.js')
            await ensureLocalDaemon()
          }
        } catch (err) {
          // Let the delivery paths below produce their own (existing) errors.
          log.session.warn('processNext: local daemon ensure failed', {
            sessionId, error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Resolve cold-resume spawn args (model/effort) from the record — the durable
      // fallback re-applied on a cold --resume (live control_requests are in-memory only).
      const {
        model: resolvedModel,
        effort: resolvedEffort,
        profile: resolvedProfile,
        lane: resolvedLane,
      } = await this.resolveResumeArgs(sessionId)

      // Rehydrate: if this.sessions lost the entry (e.g. reconciler didn't flag the
      // record as reconnectable on startup, so init() never populated the map), try
      // to attach to the existing process before falling through to --resume spawn.
      // Without this, sending a message to a healthy remote session would kill the
      // running turn and emit the SDK's "[Request interrupted by user]" marker in
      // the JSONL stream (that string is emitted by @anthropic-ai/claude-agent-sdk
      // — not a Walnut string, don't grep locally — when its abortController is
      // aborted with a non-"interrupt" reason, i.e. exactly what a --resume respawn
      // does to the in-flight turn).
      if (!targetSession) {
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

      // Build walnutMessageIds from the batch — one synthetic event per queued message.
      // Each optimistic copy in the frontend has a unique queueId; we need a matching
      // walnutMessageId in the JSONL for each one so Layer 1 dedup can remove them all.
      const walnutMessageIds = msgs.map(m => m.id).filter(Boolean)

      // The session panel is interactive from the instant the id is minted, which is
      // BEFORE the CLI process exists. If the user types in that window, wait for the
      // spawn to land so we deliver over its fresh FIFO. Skipping this wait meant
      // reading hasPipe=false on a session that was merely still booting, taking the
      // respawn branch below, and SIGINT-ing the starting CLI (lost first turn).
      if (targetSession) {
        await targetSession.awaitSpawn()
      }

      // Try stdin write first (stream-json mode — reuses running process)
      if (targetSession) {
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
          this.logDeliveryLatency(sessionId, 'stdin', msgs, targetSession)
          // Echo-claim: bind the canonical user-echo uuid to these qm ids at the
          // next history parse (exact-id optimistic dedup upstream of text match).
          registerEchoClaims(sessionId, msgs.map((m) => m.id), combined)

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
            messageIds: msgs.map((m) => m.id),
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
        let record = await getSessionByClaudeId(sessionId)
        if (!record) {
          // Record lost but the canonical JSONL may survive (inc-2026-08-10):
          // self-heal so the queued message can ride --resume instead of being
          // stranded pending forever and retried on every server boot.
          const { recoverSessionRecordFromJsonl } = await import('../core/sessions/session-record-recovery.js')
          record = await recoverSessionRecordFromJsonl(sessionId)
        }
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
          const resumeMode = mode ?? record.mode
          log.session.info('resuming session via CLI', { sessionId, taskId: record.taskId, messageLength: combined.length, model: resolvedModel, mode: resumeMode })
          // Settle the queue from send()'s spawn callback — NOT synchronously after
          // send() returns. send() is fire-and-forget; the SSH/daemon deploy that can
          // fail (publickey denied) happens asynchronously. Removing the message before
          // that confirmation is what silently lost messages. See onSpawnSettled doc.
          session.send(combined, record.cwd ?? undefined, sessionId, resumeMode, resolvedModel, undefined, record.host ?? undefined, sshTarget, undefined, resumeConfig.session?.permission_prompt, undefined, resumeConfig.session?.stream_partial_messages, resolvedEffort,
            (ok, err) => {
              if (ok) this.settleResumeSuccess(sessionId, session, msgs)
              else this.settleResumeFailure(sessionId, msgs, err ?? new Error('resume spawn failed'))
            },
            // Cold resume: re-emit the record's profile flags (spawn-time only).
            resumeProfileOpts(resolvedProfile, resolvedLane))

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
      const existingResumeMode = mode ?? targetSession.mode
      log.session.info('resuming session via CLI (existing target)', { sessionId, taskId: targetSession.taskId, messageLength: combined.length, host: resumeHost, model: resolvedModel, mode: existingResumeMode })
      // Settle the queue from send()'s spawn callback, not synchronously — the remote
      // SSH/daemon deploy can fail AFTER send() returns. See onSpawnSettled doc on send().
      const settleTarget = targetSession
      targetSession.send(combined, targetSession.cwd ?? undefined, sessionId, existingResumeMode, resolvedModel, undefined, resumeHost ?? undefined, resumeSshTarget, undefined, resumeConfig2.session?.permission_prompt, undefined, resumeConfig2.session?.stream_partial_messages, resolvedEffort,
        (ok, err) => {
          if (ok) this.settleResumeSuccess(sessionId, settleTarget, msgs)
          else this.settleResumeFailure(sessionId, msgs, err ?? new Error('resume spawn failed'))
        },
        // Cold resume: re-emit the record's profile flags (spawn-time only).
        resumeProfileOpts(resolvedProfile, resolvedLane))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      // Clean up activeProcessing + batchCounts on any error (send() EMFILE, lookup failure, etc.)
      this.clearActiveProcessing(sessionId, { kind: 'error', message: errorMsg })

      log.session.warn('processNext failed', { sessionId, error: errorMsg })

      // Delivery failed (SSH/daemon down, spawn EMFILE, etc.). Revert the batch to
      // 'pending' instead of removing it — the messages were never delivered to the
      // CLI, so they must survive (server restart re-picks pending; user can Retry).
      // Then tell the UI to mark these specific messages 'failed' (keep text + Retry)
      // via batch-failed — NOT batch-completed, which would delete the optimistic rows.
      // Revoke the batch's echo-claim first: it will never bind, and left in place it
      // would steal a same-text Retry's echo line (see revokeEchoClaims).
      revokeEchoClaims(sessionId, msgs.map((m) => m.id))
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
