export type ProcessStatus = 'running' | 'idle' | 'stopped' | 'error';
export type TaskPhase = 'TODO' | 'IN_PROGRESS' | 'AGENT_COMPLETE' | 'AWAIT_HUMAN_ACTION' | 'HUMAN_VERIFIED' | 'POST_WORK_COMPLETED' | 'COMPLETE';
export type SessionMode = 'bypass' | 'accept' | 'default' | 'plan';
export type SessionProvider = 'cli' | 'sdk' | 'embedded';

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
}

export interface SessionTreeTask {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  taskPriority: string;
  taskStarred: boolean;
  sessions: SessionRecord[];
}

export interface SessionTreeProject {
  project: string;
  tasks: SessionTreeTask[];
}

export interface SessionTreeCategory {
  category: string;
  projects: SessionTreeProject[];
  directTasks: SessionTreeTask[];
}

export interface SessionTreeResponse {
  tree: SessionTreeCategory[];
  orphanSessions: SessionRecord[];
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
  planContent?: string;
  /** agentId linking to subagent JSONL */
  agentId?: string;
  /** Team name (for Claude Code Teams Agent tools) */
  teamName?: string;
  /** Team agent name (for Claude Code Teams Agent tools) */
  teamAgentName?: string;
  /** Child messages from subagent JSONL (populated for Task tools) */
  childMessages?: SessionHistoryMessage[];
}

export interface SessionHistoryMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
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
}
