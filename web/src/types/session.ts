export type ProcessStatus = 'running' | 'idle' | 'stopped' | 'error';
export type TaskPhase = 'TODO' | 'IN_PROGRESS' | 'AGENT_COMPLETE' | 'AWAIT_HUMAN_ACTION' | 'HUMAN_VERIFIED' | 'POST_WORK_COMPLETED' | 'COMPLETE';
/** Mirrors SessionMode in src/core/types.ts — all six Claude permission modes. */
export type SessionMode = 'bypass' | 'accept' | 'default' | 'plan' | 'auto' | 'dontAsk';
export type SessionProvider = 'cli' | 'sdk' | 'embedded';
export type SessionEngine = 'claude' | 'codex';

export interface SessionRecord {
  claudeSessionId: string;
  taskId: string;
  project: string;
  process_status: ProcessStatus;
  mode: SessionMode;
  activity?: string;
  last_status_change?: string;
  startedAt: string;
  lastActiveAt: string;
  messageCount: number;
  cwd?: string;
  host?: string;
  /** Full hostname resolved from config.hosts (for display tooltips). */
  hostname?: string;
  title?: string;
  description?: string;
  slug?: string;
  planFile?: string;
  planCompleted?: boolean;
  fromPlanSessionId?: string;
  provider?: SessionProvider;
  /** Coding-agent CLI backing this session. Undefined = 'claude'. */
  engine?: SessionEngine;
  /** Current ACP base model for Codex sessions. */
  acpModel?: string;
  human_note?: string;
  /** Claude model used by this session (e.g. "claude-opus-4-6"). */
  model?: string;
  /** REQUESTED reasoning-effort level (low/medium/high/xhigh/max). User intent — the
   *  CLI may override it. Undefined = API default ('high'). */
  effort?: import('@open-walnut/core').SessionEffort;
  /** TRUE runtime effort the CLI actually uses (read back via get_settings). Reflects
   *  env override + model downgrade. Undefined until first read-back. Badge prefers this. */
  effectiveEffort?: import('@open-walnut/core').SessionEffort;
  /** Archived — hidden from UI but data preserved. */
  archived?: boolean;
  /** Why this session was archived (e.g. "plan_executed", user-provided reason). */
  archive_reason?: string;
  /** Error message when process_status is 'error' — for clear error display. */
  errorMessage?: string;
  /** Pending permission prompt (control_request) the CLI is PAUSED on. The CLI's
   *  session state is 'requires_action' — process_status stays 'running', so the
   *  badge derives an amber "Waiting" from this field (incident 7e26389d: a plan
   *  session sat on an unapproved ExitPlanMode for 15h showing a green Running). */
  pendingPermission?: {
    requestId: string;
    toolName?: string;
    reason?: string;
    receivedAt: string;
  };
  /** Monotonic revision for the centralized frontend status store. */
  statusRevision?: number;
  /** ISO timestamp attached to statusRevision. */
  statusUpdatedAt?: string;
  /** ONE-LINE recap of the session's latest turn(s) — rendered as a small tip under
   *  the session so the user can re-orient without re-reading the transcript. */
  recap?: string;
  /** ISO timestamp of the last recap update. */
  recapAt?: string;
}

export interface SessionSummaryInfo {
  slug: string;
  project: string;
  summary: string;
  status: string;
  date: string;
  task_ids: string[];
}

export interface SessionHistoryTool {
  name: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  result?: string;
  /** True when the tool_result carried is_error — render ✗, not ✓. */
  isError?: boolean;
  planContent?: string;
  /** agentId linking to subagent JSONL */
  agentId?: string;
  /** True when a <task-notification> proved this background Agent/Task run
   *  stopped — promote-blocks clears its subagent-lane streaming blocks on
   *  this flag (their transcript lives in a separate subagents/ JSONL, so
   *  twin-matching is structurally impossible). */
  bgTaskFinished?: boolean;
  /** Team name (for Claude Code Teams Agent tools) */
  teamName?: string;
  /** Team agent name (for Claude Code Teams Agent tools) */
  teamAgentName?: string;
  /** Child messages from subagent JSONL (populated for Task tools) */
  childMessages?: SessionHistoryMessage[];
}

export interface SessionHistoryMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  timestamp: string;
  /** For role='system': display variant (compact boundary / API error / info). */
  systemVariant?: 'compact' | 'error' | 'info';
  tools?: SessionHistoryTool[];
  thinking?: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  /** Stable message id: API `message.id` (`msg_…`) for assistant messages, else
   *  JSONL line uuid. Same id rides live-stream deltas (StreamingTextBlock.msgId),
   *  so streaming blocks and history messages match by id, not content. */
  msgId?: string;
  /** Walnut-generated message ID for deterministic dedup of optimistic user messages. */
  walnutMessageId?: string;
  /** Server-stamped: this row's content can still change (an Agent row awaiting its
   *  late `bgTaskFinished`, a tool row awaiting its result). We re-ask for these ids
   *  on the next delta — otherwise a prefix synced mid-flight stays frozen and that
   *  agent's lane blocks never get absorption proof (inc-1785965937858). */
  unsettled?: boolean;
  /** True for CLI-injected user lines the human did NOT type (skill content
   *  dumps, compaction continuation summaries, image-read metadata). Rendered
   *  as a collapsed context row, never a "You" bubble. */
  injected?: boolean;
}
