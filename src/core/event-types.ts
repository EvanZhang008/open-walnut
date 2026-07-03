/**
 * Centralized event payload types for the Walnut event bus.
 *
 * Every bus event has a typed payload defined here. Consumers use
 * `eventData<'event:name'>(event)` instead of manual `as { ... }` casts.
 */

import type { Task, TaskPhase, SessionMode, ProcessStatus, SessionProvider, ConversationMeta } from './types.js';

// ── Task events ──

export interface TaskCreatedEvent { task: Task }
export interface TaskUpdatedEvent { task: Task }
export interface TaskCompletedEvent { task: Task }
export interface TaskStarredEvent { task: Task; starred: boolean }
export interface TaskDeletedEvent { id?: string; task: Task }
export interface TaskReorderedEvent { category: string; project: string; taskIds: string[] }
export interface TaskUnblockedEvent { task: Task; unblockedBy: Task }
/** Virtual task-group membership or label changed (created / renamed / dissolved). */
export interface TaskGroupsChangedEvent { group_id?: string; label?: string; dissolved_group_ids?: string[] }

// ── Category events ──

export interface CategoryCreatedEvent { name: string; source: string }
export interface CategoryUpdatedEvent { name: string; source: string }

// ── Session lifecycle events ──

export interface SessionStartEvent {
  taskId: string;
  message: string;
  host?: string;
  cwd?: string;
  mode?: string;
  model?: string;
  effort?: import('./types.js').SessionEffort;
  project?: string;
  title?: string;
  appendSystemPrompt?: string;
  fromPlanSessionId?: string;
  forkedFromSessionId?: string;
  /**
   * When the original user message was spilled to a temp file (Quick Start long paste),
   * the pointer to that local file. For remote sessions, the file is uploaded to the
   * same path on the remote host before the session starts.
   */
  largePromptFile?: { localPath: string; originalLength: number };
  /**
   * Wall-clock timestamp (Date.now()) when the HTTP request that triggered this
   * session start was received. Used purely for latency instrumentation — lets the
   * init handler break down end-to-end time-to-init across each hop (route → send →
   * spawn → CLI init). Optional; absent for non-HTTP-triggered starts.
   */
  requestTs?: number;
}

export interface SessionSendEvent {
  sessionId: string;
  taskId?: string;
  message: string;
  mode?: string;
  interrupt?: boolean;
}

export interface SessionStartedEvent {
  sessionId?: string;
  taskId?: string;
  claudeSessionId?: string;
  project?: string;
  host?: string;
  title?: string;
  provider?: SessionProvider;
}

export interface SessionEndedEvent {
  sessionId?: string;
  taskId?: string;
  autoCompleted?: number;
}

export interface SessionResultEvent {
  sessionId: string;
  taskId?: string;
  result: string;
  isError?: boolean;
  /** CLI's cumulative cost for the current process (running total, restarts at 0
   *  on each --resume). For DISPLAY only — do NOT bill this; it would re-charge the
   *  whole running total every turn (the 13× session-cost inflation bug). */
  totalCost?: number;
  /** The billable INCREMENT since the last result (totalCost minus the per-process
   *  watermark). This is what gets recorded to the usage ledger. 0 for replayed
   *  results. Absent on legacy daemon payloads — consumers must NOT fall back to
   *  billing totalCost when this is undefined. */
  costDelta?: number;
  duration?: number;
  usage?: { input_tokens: number; output_tokens: number };
  /** True when a Claude Code team (in_process_teammate) is still active — this is an
   *  intermediate result, not turn-over. Consumers skip AGENT_COMPLETE/triage. */
  teamActive?: boolean;
  /** True when a dynamic-workflow / background subagent set is still in flight — this
   *  result is intermediate, not turn-over. Consumers skip AGENT_COMPLETE/triage. */
  backgroundActive?: boolean;
}

export interface SessionErrorEvent {
  error: string;
  taskId?: string;
  sessionId?: string;
  fromPlanSessionId?: string;
  /**
   * Structured error kind — lets downstream consumers (agent tools, UI) react
   * without string-matching the error message.
   * - 'conversation_lost': Claude CLI could not find the session JSONL on disk
   *   (typically the remote host's conversation store was wiped). The session
   *   record has already been auto-archived; caller should start a fresh session.
   * - 'delivery_failed': the message batch could NOT be delivered to the CLI
   *   (SSH/daemon down, spawn failure). The batch was reverted to 'pending' in
   *   the disk queue — it is NOT lost. This is a connectivity status, not a turn
   *   outcome: handlers must NOT emit SESSION_BATCH_COMPLETED, must NOT call
   *   removeProcessed, and must NOT re-trigger processNext (that combination
   *   caused the 2-req/s infinite retry loop of 2026-06-10).
   */
  errorKind?: 'conversation_lost' | 'delivery_failed';
}

// ── Session streaming events ──

export interface SessionTextDeltaEvent {
  sessionId: string;
  taskId?: string;
  delta: string;
}

export interface SessionToolUseEvent {
  sessionId: string;
  taskId?: string;
  toolName: string;
  toolUseId: string;
  input?: Record<string, unknown>;
  planContent?: string;
  /** Non-null when this tool call belongs to a subagent Task */
  parentToolUseId?: string;
}

export interface SessionToolResultEvent {
  sessionId: string;
  taskId?: string;
  toolUseId: string;
  result: string;
  /** Non-null when this result belongs to a subagent Task */
  parentToolUseId?: string;
}

export interface SessionThinkingDeltaEvent {
  sessionId: string;
  taskId?: string;
  delta: string;
}

/** Catch-all for Claude CLI event types we don't know how to parse.
 *  Surfaced as a SystemBlock in the UI so new CLI fields never silently
 *  disappear. `scope` identifies which layer saw it (top-level JSONL,
 *  stream_event subtype, or content_block_delta delta type). */
export interface SessionUnknownEventPayload {
  sessionId: string;
  taskId?: string;
  scope: 'top_level' | 'stream_event' | 'delta';
  eventType: string;
  /** First 500 chars of the raw JSONL line, for diagnostics. */
  snippet: string;
}

export interface SessionStatusChangedEvent {
  sessionId: string;
  taskId?: string;
  phase?: TaskPhase;
  process_status?: ProcessStatus;
  activity?: string;
  mode?: SessionMode;
  planCompleted?: boolean;
  fromPlanSessionId?: string;
  forkedFromSessionId?: string;
  archived?: boolean;
}

export interface SessionMessagesDeliveredEvent {
  sessionId: string;
  count: number;
}

export interface SessionBatchCompletedEvent {
  sessionId: string;
  count: number;
}

export interface SessionBatchFailedEvent {
  sessionId: string;
  messageIds: string[];
  error: string;
}

export interface SessionMessageQueuedEvent {
  sessionId: string;
  messageId: string;
}

export interface SessionSystemEventPayload {
  sessionId: string;
  taskId?: string;
  variant: 'compact' | 'error' | 'info';
  message: string;
  detail?: string;
}

/** A single background task / dynamic-workflow subagent for the progress UI. */
export interface BackgroundTaskInfo {
  taskId: string;
  description?: string;
  subagentType?: string;
  status: string; // running | completed | failed | stopped | paused
  tokens?: number;
  lastTool?: string;
  summary?: string;
  workflowName?: string;
}

/** A phase in a dynamic workflow (from task_progress.workflow_progress[] entries of
 *  type 'workflow_phase'). Phases group the subagents into stages (e.g. "Fan out"). */
export interface WorkflowPhaseInfo {
  index: number;
  title: string;
}

/** One subagent inside a dynamic workflow (from workflow_progress[] entries of type
 *  'workflow_agent'). The CLI sends only the currently-active agents per snapshot, so
 *  the backend accumulates these by agentId (latest-wins) to reconstruct the full set. */
export interface WorkflowAgentInfo {
  agentId: string;
  index: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  status: string; // normalized: running | completed | failed | stopped | pending
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  startedAt?: number;
}

/** Snapshot of a session's in-flight background tasks (dynamic workflows / subagents).
 *  Emitted whenever a task_started/progress/updated/notification event mutates the set,
 *  so the UI can render a live workflow-progress panel. For dynamic workflows, `phases`
 *  + `agents` carry the per-subagent breakdown and `scriptSource` the generated script. */
export interface SessionBackgroundTasksPayload {
  sessionId: string;
  taskId?: string;
  workflowName?: string;
  inFlight: number;
  tasks: BackgroundTaskInfo[];
  /** Workflow phases (dynamic workflows only). */
  phases?: WorkflowPhaseInfo[];
  /** Per-subagent breakdown, accumulated across snapshots (dynamic workflows only). */
  agents?: WorkflowAgentInfo[];
  /** The workflow script Claude generated (from task_started.prompt) — lets the UI
   *  show WHAT workflow was created. */
  scriptSource?: string;
  /** Human description of the workflow (from task_started.description). */
  workflowDescription?: string;
}

/** Native Claude Code side_question ("/btw") result, broadcast when the CLI's
 *  control_response arrives. Mirrors the persisted SideQuestion entry. */
export interface SessionSideQuestionDoneEvent {
  sessionId: string;
  id: string;
  question: string;
  answer: string;
  createdAt: string;
}

export interface SessionSideQuestionErrorEvent {
  sessionId: string;
  question: string;
  error: string;
}

export interface SessionUsageUpdateEvent {
  sessionId: string;
  model?: string;
  /** Context window usage percentage (0–100+, may exceed 100 near compaction). */
  contextPercent?: number;
  /** Total input tokens for the latest API call (incl. cache). */
  inputTokens?: number;
}

// ── Subagent events ──

export interface SubagentStartEvent {
  agentId: string;
  task: string;
  taskId?: string;
  model?: string;
  region?: string;
  deniedTools?: string[];
  context?: string;
  context_override?: Record<string, unknown>;
}

export interface SubagentSendEvent {
  runId: string;
  message: string;
}

export interface SubagentStartedEvent {
  runId: string;
  agentId: string;
  agentName: string;
  task?: string;
  taskId?: string;
}

export interface SubagentResultEvent {
  runId: string;
  agentId: string;
  agentName: string;
  task?: string;
  taskId?: string;
  result: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Structured notification from notify_main_agent tool (triage agents) */
  notification?: string;
  /** Set by main-ai handler for sanitized forwarding to web-ui */
  isTriageResult?: boolean;
}

export interface SubagentErrorEvent {
  runId?: string;
  agentId?: string;
  task?: string;
  taskId?: string;
  error: string;
}

// ── Team events (Claude Code Teams — parallel agents) ──

export interface TeamMemberInfo {
  name: string;
  agentType: string;
  model: string;
  isLead: boolean;
  backendType?: string;
}

export interface SessionTeamInfoEvent {
  sessionId: string;
  teamName: string;
  members: TeamMemberInfo[];
}

export interface SessionTeamAgentDeltaEvent {
  sessionId: string;
  agentName: string;
  events: Array<{
    type: 'text' | 'tool_use' | 'tool_result' | 'system';
    text?: string;
    toolName?: string;
    toolUseId?: string;
    input?: Record<string, unknown>;
    result?: string;
    subtype?: string;
    model?: string;
  }>;
}

// ── Inline subagent streaming events ──

export interface AgentSubagentStreamEvent {
  toolUseId: string;
  block: {
    type: 'text' | 'tool_call' | 'system';
    [key: string]: unknown;
  };
}

// ── Agent events (chat streaming, sent via WebSocket RPC) ──

export interface AgentTextDeltaEvent { delta: string; source?: string }
export interface AgentToolActivityEvent { toolName: string; status: 'calling' | 'done' }
export interface AgentToolCallEvent { toolName: string; input: Record<string, unknown> }
export interface AgentToolResultEvent { toolName: string; result: string }
export interface AgentThinkingEvent { text: string }
export interface ChatStats {
  apiMessageCount: number;
  estimatedTokens: number;
  systemTokens: number;
  toolsTokens: number;
  estimatedTotalTokens: number;
  compacted: boolean;
  contextWindow: number;
}
export interface AgentResponseEvent { text: string; aborted?: boolean; source?: string; stats?: ChatStats }
export interface AgentErrorEvent { error: string }

// ── Chat events ──

export interface ChatHistoryUpdatedEvent {
  entry: {
    role: string;
    content: string;
    source?: string;
    notification?: boolean;
    taskId?: string;
    sessionId?: string;
    timestamp?: string;
  };
  agentId?: string;
  conversationId?: string;
}

export interface ChatCompactingEvent { agentId?: string; conversationId?: string }
export interface ChatCompactedEvent { divider?: string; agentId?: string; conversationId?: string }

// ── Conversation events (multi-conversation per agent) ──

export interface ConversationCreatedEvent { agentId: string; conversation: ConversationMeta }
export interface ConversationDeletedEvent { agentId: string; conversationId: string; activeConversationId: string | null }
export interface ConversationUpdatedEvent { agentId: string; conversation?: ConversationMeta; activeConversationId?: string }

// ── Config events ──

export interface ConfigChangedEvent { key?: string; config?: Record<string, unknown> }

// ── System health events ──

export interface SystemHealthEvent {
  embedding: {
    total: number;
    indexed: number;
    unindexed: number;
    ollamaAvailable: boolean;
    lastReconcileAt?: string;
    lastError?: string;
  };
}

// ── Cron events (emitted via broadcastEvent, consumed by git-versioning) ──

export interface CronJobEvent {
  action: string;
  jobId?: string;
  summary?: string;
  [key: string]: unknown;
}

// ── Notes events ──

export interface NotesUpdatedEvent {
  /** Source URI, e.g. 'notes/global' or 'notes/recipes' */
  source: string;
  /** SHA256-based content hash after the write */
  contentHash: string;
}

// ── Audio capture events ──

export interface AudioStartedEvent {
  recordingId: string;
  source: 'system' | 'mic' | 'both';
  apps?: string[];
  startedAt: string;
}

export interface AudioStoppedEvent {
  recordingId: string;
  duration: number;
  chunks: number;
}

export interface AudioChunkSavedEvent {
  recordingId: string;
  chunkIndex: number;
  filePath: string;
  duration: number;
  size: number;
}

export interface AudioErrorEvent {
  recordingId?: string;
  error: string;
}

export interface AudioTranscriptionCompleteEvent {
  recordingId: string;
  chunkIndex: number;
  filePath: string;
  text: string;
  durationMs: number;
}

// ── Master type map: EventName → Payload ──

export interface EventPayloadMap {
  'task:created': TaskCreatedEvent;
  'task:updated': TaskUpdatedEvent;
  'task:completed': TaskCompletedEvent;
  'task:starred': TaskStarredEvent;
  'task:deleted': TaskDeletedEvent;
  'task:reordered': TaskReorderedEvent;
  'task:unblocked': TaskUnblockedEvent;
  'task:groups-changed': TaskGroupsChangedEvent;

  'category:created': CategoryCreatedEvent;
  'category:updated': CategoryUpdatedEvent;

  'session:start': SessionStartEvent;
  'session:send': SessionSendEvent;
  'session:started': SessionStartedEvent;
  'session:ended': SessionEndedEvent;
  'session:result': SessionResultEvent;
  'session:error': SessionErrorEvent;

  'session:text-delta': SessionTextDeltaEvent;
  'session:thinking-delta': SessionThinkingDeltaEvent;
  'session:tool-use': SessionToolUseEvent;
  'session:tool-result': SessionToolResultEvent;
  'session:unknown-event': SessionUnknownEventPayload;
  'session:status-changed': SessionStatusChangedEvent;
  'session:messages-delivered': SessionMessagesDeliveredEvent;
  'session:batch-completed': SessionBatchCompletedEvent;
  'session:batch-failed': SessionBatchFailedEvent;
  'session:message-queued': SessionMessageQueuedEvent;
  'session:system-event': SessionSystemEventPayload;
  'session:background-tasks': SessionBackgroundTasksPayload;
  'session:usage-update': SessionUsageUpdateEvent;
  'session:side-question-done': SessionSideQuestionDoneEvent;
  'session:side-question-error': SessionSideQuestionErrorEvent;

  'session:team-info': SessionTeamInfoEvent;
  'session:team-agent-delta': SessionTeamAgentDeltaEvent;

  'subagent:start': SubagentStartEvent;
  'subagent:send': SubagentSendEvent;
  'subagent:started': SubagentStartedEvent;
  'subagent:result': SubagentResultEvent;
  'subagent:error': SubagentErrorEvent;

  'agent:subagent-stream': AgentSubagentStreamEvent;
  'agent:text-delta': AgentTextDeltaEvent;
  'agent:tool-activity': AgentToolActivityEvent;
  'agent:tool-call': AgentToolCallEvent;
  'agent:tool-result': AgentToolResultEvent;
  'agent:thinking': AgentThinkingEvent;
  'agent:response': AgentResponseEvent;
  'agent:error': AgentErrorEvent;

  'chat:history-updated': ChatHistoryUpdatedEvent;
  'chat:compacting': ChatCompactingEvent;
  'chat:compacted': ChatCompactedEvent;

  'conversation:created': ConversationCreatedEvent;
  'conversation:deleted': ConversationDeletedEvent;
  'conversation:updated': ConversationUpdatedEvent;

  'notes:updated': NotesUpdatedEvent;

  'config:changed': ConfigChangedEvent;

  'system:health': SystemHealthEvent;

  'audio:started': AudioStartedEvent;
  'audio:stopped': AudioStoppedEvent;
  'audio:chunk-saved': AudioChunkSavedEvent;
  'audio:error': AudioErrorEvent;
  'audio:transcription-complete': AudioTranscriptionCompleteEvent;

  'cron:job-added': CronJobEvent;
  'cron:job-updated': CronJobEvent;
  'cron:job-removed': CronJobEvent;
  'cron:job-started': CronJobEvent;
  'cron:job-finished': CronJobEvent;
  'cron:notification': CronJobEvent;
}

// ── Type-safe helper ──

/** Extract typed payload from a BusEvent. Use instead of `event.data as { ... }`. */
export function eventData<E extends keyof EventPayloadMap>(event: { data: unknown }): EventPayloadMap[E] {
  return event.data as EventPayloadMap[E];
}
