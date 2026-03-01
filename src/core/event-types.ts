/**
 * Centralized event payload types for the Walnut event bus.
 *
 * Every bus event has a typed payload defined here. Consumers use
 * `eventData<'event:name'>(event)` instead of manual `as { ... }` casts.
 */

import type { Task, SessionMode, WorkStatus, ProcessStatus, SessionProvider } from './types.js';

// ── Task events ──

export interface TaskCreatedEvent { task: Task }
export interface TaskUpdatedEvent { task: Task }
export interface TaskCompletedEvent { task: Task }
export interface TaskStarredEvent { task: Task; starred: boolean }
export interface TaskDeletedEvent { id?: string; task: Task }
export interface TaskReorderedEvent { category: string; project: string; taskIds: string[] }
export interface TaskUnblockedEvent { task: Task; unblockedBy: Task }

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
  project?: string;
  title?: string;
  appendSystemPrompt?: string;
  fromPlanSessionId?: string;
}

export interface SessionSendEvent {
  sessionId: string;
  taskId?: string;
  message: string;
  mode?: string;
  model?: string;
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
  totalCost?: number;
  duration?: number;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface SessionErrorEvent {
  error: string;
  taskId?: string;
  sessionId?: string;
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

export interface SessionStatusChangedEvent {
  sessionId: string;
  taskId?: string;
  work_status?: WorkStatus;
  process_status?: ProcessStatus;
  previousWorkStatus?: WorkStatus;
  activity?: string;
  mode?: SessionMode;
  planCompleted?: boolean;
  fromPlanSessionId?: string;
}

export interface SessionMessagesDeliveredEvent {
  sessionId: string;
  count: number;
}

export interface SessionBatchCompletedEvent {
  sessionId: string;
  count: number;
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

export interface SessionUsageUpdateEvent {
  sessionId: string;
  model?: string;
  /** Context window usage percentage (0–100). */
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

// ── Agent events (chat streaming, sent via WebSocket RPC) ──

export interface AgentTextDeltaEvent { delta: string; source?: string }
export interface AgentToolActivityEvent { toolName: string; status: 'calling' | 'done' }
export interface AgentToolCallEvent { toolName: string; input: Record<string, unknown> }
export interface AgentToolResultEvent { toolName: string; result: string }
export interface AgentThinkingEvent { text: string }
export interface AgentResponseEvent { text: string; aborted?: boolean; source?: string }
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
}

export interface ChatCompactingEvent {}
export interface ChatCompactedEvent { divider?: string }

// ── Config events ──

export interface ConfigChangedEvent { key?: string; config?: Record<string, unknown> }

// ── Cron events (emitted via broadcastEvent, consumed by git-versioning) ──

export interface CronJobEvent {
  action: string;
  jobId?: string;
  summary?: string;
  [key: string]: unknown;
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

  'category:created': CategoryCreatedEvent;
  'category:updated': CategoryUpdatedEvent;

  'session:start': SessionStartEvent;
  'session:send': SessionSendEvent;
  'session:started': SessionStartedEvent;
  'session:ended': SessionEndedEvent;
  'session:result': SessionResultEvent;
  'session:error': SessionErrorEvent;

  'session:text-delta': SessionTextDeltaEvent;
  'session:tool-use': SessionToolUseEvent;
  'session:tool-result': SessionToolResultEvent;
  'session:status-changed': SessionStatusChangedEvent;
  'session:messages-delivered': SessionMessagesDeliveredEvent;
  'session:batch-completed': SessionBatchCompletedEvent;
  'session:message-queued': SessionMessageQueuedEvent;
  'session:system-event': SessionSystemEventPayload;
  'session:usage-update': SessionUsageUpdateEvent;

  'subagent:start': SubagentStartEvent;
  'subagent:send': SubagentSendEvent;
  'subagent:started': SubagentStartedEvent;
  'subagent:result': SubagentResultEvent;
  'subagent:error': SubagentErrorEvent;

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

  'config:changed': ConfigChangedEvent;

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
