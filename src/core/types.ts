export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPhase =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'AGENT_COMPLETE'
  | 'AWAIT_HUMAN_ACTION'
  | 'PEER_CODE_REVIEW'
  | 'RELEASE_IN_PIPELINE'
  | 'COMPLETE';
export type TaskPriority = 'immediate' | 'important' | 'backlog' | 'none';
/** Canonical list of valid priority values — use for runtime validation. */
export const VALID_PRIORITIES: readonly TaskPriority[] = ['immediate', 'important', 'backlog', 'none'] as const;
export type TaskSource = string;

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  category: string;
  project: string;
  /** @deprecated Backward-compat legacy field. Before the 2-slot model, a task could
   *  accumulate unbounded session IDs. Now we use plan_session_id + exec_session_id
   *  as the source of truth (one slot per type). This array is kept for migration
   *  compatibility but is NOT actively used — do not rely on it for new features. */
  session_ids: string[];
  /** Single session slot — replaces plan_session_id + exec_session_id. */
  session_id?: string;
  /** Enrichment-only (not stored): live status of the linked session. */
  session_status?: {
    work_status: WorkStatus;
    process_status: ProcessStatus;
    activity?: string;
    mode?: SessionMode;
    provider?: SessionProvider;
    planCompleted?: boolean;
  };
  /** @deprecated Use session_id instead. Kept for backward compat during migration. */
  plan_session_id?: string;
  /** @deprecated Use session_id instead. Kept for backward compat during migration. */
  exec_session_id?: string;
  /** @deprecated Use session_status instead. Kept for backward compat during migration. */
  plan_session_status?: { work_status: WorkStatus; process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: SessionProvider; planCompleted?: boolean };
  /** @deprecated Use session_status instead. Kept for backward compat during migration. */
  exec_session_status?: { work_status: WorkStatus; process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: SessionProvider };
  /** All unique work_statuses across every session in session_ids + active slots (enrichment only, not stored). */
  session_work_statuses?: WorkStatus[];
  parent_task_id?: string;     // If set, this is a child task of the parent
  depends_on?: string[];       // Full IDs of tasks that must complete before this one
  description: string;
  summary: string;
  note: string;
  conversation_log?: string;  // Append-only markdown log of user↔agent interactions
  phase: TaskPhase;
  sprint?: string;
  tags?: string[];
  source: TaskSource;
  external_url?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  due_date?: string;
  starred?: boolean;
  needs_attention?: boolean;
  /** Last sync error message — set on push failure, cleared on success. */
  sync_error?: string;
  /** Task-level working directory override. Takes precedence over project default_cwd in session resolution. */
  cwd?: string;
  /** Plugin-specific extension data. Keys are plugin IDs (e.g. 'ms-todo', 'plugin-a'). */
  ext?: Record<string, unknown>;
}

export interface CategoryRecord {
  source: TaskSource;
}

export interface TaskStore {
  version: 1 | 2 | 3 | 4;
  tasks: Task[];
  categories?: Record<string, CategoryRecord>;
}

export interface CacheConfig {
  enabled?: boolean;
  pruneEnabled?: boolean;
  pruneOptions?: {
    keepLastNTurns?: number;
    softTrimThreshold?: number;
    softTrimKeep?: number;
  };
}

export type ContextSourceId =
  | 'task_details' | 'project_memory' | 'project_task_list'
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log';

export interface ContextSourceConfig {
  id: ContextSourceId;
  enabled: boolean;
  token_budget?: number;  // override default budget
}

export interface AgentStatefulConfig {
  /** Project memory path (e.g. "life/tracker"). */
  memory_project: string;
  /** Max tokens of memory injected per call. Default: 4000. */
  memory_budget_tokens?: number;
  /** Source tag for memory writes. Default: agent id. */
  memory_source?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  runner: 'embedded' | 'cli';
  model?: string;
  /** Provider name — maps to config.providers[name]. Falls back to subagent default. */
  provider?: string;
  region?: string;
  max_tokens?: number;
  max_tool_rounds?: number;
  system_prompt?: string;
  denied_tools?: string[];
  allowed_tools?: string[];
  working_directory?: string;
  /** Context sources to inject when invoked with a task. */
  context_sources?: ContextSourceConfig[];
  /** Stateful mode: agent accumulates persistent memory across invocations. */
  stateful?: AgentStatefulConfig;
  /** Selective list of skill directory names to inject into this agent's prompt. */
  skills?: string[];
  source: 'builtin' | 'config';
  /** True when a config entry overrides (shadows) a builtin agent with the same ID. */
  overrides_builtin?: boolean;
}

export interface SubagentGlobalConfig {
  model?: string;
  /** Provider name for subagents. Maps to config.providers[name]. */
  provider?: string;
  region?: string;
  max_tokens?: number;
  max_concurrent?: number;
  max_tool_rounds?: number;
  denied_tools?: string[];
}

export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'error';

export interface AgentRun {
  runId: string;
  agentId: string;
  task: string;
  taskId?: string;
  runner: 'embedded' | 'cli';
  status: AgentRunStatus;
  startedAt: string;
  completedAt?: string;
  result?: string;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
  history?: unknown[];
}

export interface AgentConfig {
  model?: string;
  region?: string;
  maxTokens?: number;
  cache?: CacheConfig;
  subagent?: SubagentGlobalConfig;
  agents?: Omit<AgentDefinition, 'source'>[];
  /** Agent ID to use for session summarization (defined in config.yaml agent.agents[]). */
  session_summarizer_agent?: string;
  /** Agent ID to use for turn-complete triage. Default: 'turn-complete-triage' (builtin). */
  session_triage_agent?: string;
  /** Agent ID to use for message-send triage. Default: 'message-send-triage' (builtin). */
  message_send_triage_agent?: string;
  /** Predefined model IDs shown in the agent form dropdown. Supports both string[] (legacy Bedrock IDs)
   *  and ModelEntry[] (new multi-provider format). */
  available_models?: string[] | import('../agent/providers/types.js').ModelEntry[];
  /** Default model passed as --model to claude CLI sessions. Defaults to 'opus'. */
  session_model?: string;
  /** Model ID for the main AI agent. Defaults to DEFAULT_MODEL (Opus 4.6). */
  main_model?: string;
  /** Default provider name for the main agent. Maps to config.providers[name]. */
  main_provider?: string;
}

export interface Config {
  version: 1;
  user: { name?: string };
  defaults: { priority: TaskPriority; category: string };
  provider: {
    type: string;
    model?: string;
    bedrock_region?: string;
    bedrock_bearer_token?: string;
  };
  /** Multi-provider configuration. Each key is a provider name, value is protocol + auth config.
   *  When absent, auto-synthesized from legacy `provider.*` fields + env var auto-detection. */
  providers?: Record<string, import('../agent/providers/types.js').ProviderConfig>;
  agent?: AgentConfig;
  local?: {
    /** Category names reserved for local-only tasks (never synced to any external service). */
    categories?: string[];
  };
  /** Plugin configurations. Keys are plugin IDs (e.g. 'ms-todo'). Each plugin defines its own config schema. */
  plugins?: Record<string, Record<string, unknown> & { enabled?: boolean }>;
  favorites?: {
    categories?: string[];
    projects?: string[];
  };
  focus_bar?: {
    pinned_tasks?: string[];
  };
  ordering?: {
    categories?: string[];
    projects?: Record<string, string[]>;
  };
  session_server?: {
    /** Whether to use the SDK session server instead of CLI sessions. Default: false. */
    enabled?: boolean;
    /** Port for the local session server. Default: 7890. */
    port?: number;
    /** Auto-start the session server when Walnut starts. Default: true when enabled. */
    auto_start?: boolean;
  };
  hosts?: Record<string, {
    hostname: string;
    user?: string;
    port?: number;
    label?: string;
    /** Session server WebSocket URL for this host. Overrides CLI for this host. */
    session_server_url?: string;
    /** Shell snippet run before claude on remote sessions (e.g. 'source $HOME/.nvm/nvm.sh').
     *  Use to set up PATH for node managers (nvm, fnm, volta, asdf) or other env. */
    shell_setup?: string;
  }>;
  /** Per-host maximum concurrent CLI session limits.
   *  'local' key = sessions without a host.
   *  Other keys = host aliases from config.hosts (e.g. 'devbox', 'nas-server').
   *  Default: local=7, remote hosts=20. */
  session_limits?: Record<string, number>;
  session?: {
    /** How many minutes an idle FIFO session stays alive before being auto-killed.
     *  Set to 0 to disable idle timeout entirely. Default: 30. */
    idle_timeout_minutes?: number;
    /** Maximum number of idle sessions per host before evicting the oldest.
     *  Default: local=30, remote=40. Set to 0 to disable idle limit. */
    max_idle?: number;
  };
  heartbeat?: import('../heartbeat/types.js').HeartbeatConfig;
  tools?: {
    exec?: {
      security?: string;
      deny?: string[];
      allow?: string[];
      timeout?: number;
      max_output?: number;
    };
    slack?: { bot_token?: string; default_channel?: string };
    tts?: { provider?: string; voice?: string };
    web_search?: {
      provider?: string;
      api_key?: string;
      perplexity_api_key?: string;
      perplexity_base_url?: string;
      perplexity_model?: string;
      timeout?: number;
    };
    web_fetch?: {
      max_chars?: number;
      timeout?: number;
    };
  };
  search?: import('./embedding/types.js').EmbeddingConfig;
  git_versioning?: {
    enabled?: boolean;              // default: true
    commit_debounce_ms?: number;    // default: 30000
    push_enabled?: boolean;         // default: false
    push_interval_ms?: number;      // default: 600000 (10 min)
    push_on_session_end?: boolean;  // default: true
  };
  session_hooks?: import('./session-hooks/types.js').SessionHooksConfig;
  developer?: {
    /** Show "UI ONLY" triage messages in chat. Default: false (hidden for less noise). */
    show_ui_only_triage?: boolean;
    /** Show "UI ONLY" session result messages. Default: false. */
    show_ui_only_session?: boolean;
    /** Show "UI ONLY" session error messages. Default: false. */
    show_ui_only_session_error?: boolean;
    /** Show "UI ONLY" subagent result messages. Default: false. */
    show_ui_only_subagent?: boolean;
    /** Show "UI ONLY" heartbeat messages. Default: false. */
    show_ui_only_heartbeat?: boolean;
    /** Show "UI ONLY" agent error messages. Default: false. */
    show_ui_only_agent_error?: boolean;
  };
  /** API keys for remote client authentication (iOS app, etc.) */
  api_keys?: ApiKeyEntry[];
  /** Registered push notification tokens for mobile clients */
  push_tokens?: PushTokenEntry[];
}

export interface ApiKeyEntry {
  name: string;
  key: string;
  created_at: string;
}

export interface PushTokenEntry {
  /** Expo push token (e.g. ExponentPushToken[...]) */
  token: string;
  /** Platform: ios or android */
  platform: 'ios' | 'android';
  /** Name of the API key this token is bound to */
  key_name: string;
  /** Registration timestamp */
  registered_at: string;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string | AgentContentBlock[];
}

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface DashboardData {
  urgent_tasks: Task[];
  today_tasks: Task[];
  recent_tasks: Task[];
  recent_sessions: SessionSummary[];
  stats: { total: number; todo: number; in_progress: number; done: number };
}

export interface SessionSummary {
  id: string;
  project: string;
  slug: string;
  summary: string;
  status: string;
  date: string;
  task_ids: string[];
}

export interface GlobalOptions {
  json: boolean;
}

export interface DisplayMessageBlock {
  type: 'thinking' | 'tool_call' | 'text';
  content?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: string;
  status?: 'calling' | 'done';
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  blocks?: DisplayMessageBlock[];
  timestamp: string;
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
}

/**
 * Unified chat entry — single source of truth replacing parallel apiMessages/displayMessages.
 * - tag 'ai': model-facing message (Anthropic ContentBlock[] format). Included in model context unless compacted.
 * - tag 'ui': display-only message (notifications, cron, session results). Never sent to model.
 */
export interface ChatEntry {
  tag: 'ai' | 'ui';
  role: 'user' | 'assistant';
  content: unknown;           // Full Anthropic ContentBlock[] for 'ai', string for 'ui'
  timestamp: string;
  // For AI user messages where displayed text differs from model content (e.g. context prefix stripped)
  displayText?: string;
  // UI metadata (present on both tags, optional)
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
  sessionId?: string;          // Linked session ID (e.g. embedded triage run ID)
  // Compaction marker
  compacted?: boolean;         // true = excluded from model context, kept for scroll-back
  // Per-field content hashes for task context dedup (keys like "note:{taskId}", "pm:life/tax")
  contextHashes?: Record<string, string>;
}

export interface ChatHistoryStore {
  version: 1 | 2;
  lastUpdated: string;
  compactionCount: number;
  compactionSummary: string | null;
  // v1 fields (kept for migration detection)
  apiMessages?: unknown[];
  displayMessages?: DisplayMessage[];
  // v2 field
  entries?: ChatEntry[];
}

export type ProcessStatus = 'running' | 'idle' | 'stopped';
export type WorkStatus = 'in_progress' | 'agent_complete' | 'await_human_action' | 'completed' | 'error';
export type SessionMode = 'bypass' | 'accept' | 'default' | 'plan';
export type SessionProvider = 'cli' | 'sdk' | 'embedded';

export interface SessionRecord {
  claudeSessionId: string;
  taskId: string;
  project: string;
  process_status: ProcessStatus;
  work_status: WorkStatus;
  mode: SessionMode;
  provider?: SessionProvider;
  activity?: string;
  last_status_change?: string;
  startedAt: string;
  lastActiveAt: string;
  messageCount: number;
  cwd?: string;
  host?: string;
  /** Full hostname resolved from config.hosts (for display tooltips). Not persisted. */
  hostname?: string;
  title?: string;
  description?: string;
  pid?: number;
  outputFile?: string;
  planFile?: string;
  planCompleted?: boolean;
  fromPlanSessionId?: string;
  /** Source session ID when this session was forked from another session. */
  forkedFromSessionId?: string;
  human_note?: string;
  pendingModel?: string;
  pendingMode?: string;
  /** Claude model used by this session (e.g. "claude-opus-4-6"). */
  model?: string;
  /** Archived — hidden from UI but data preserved. */
  archived?: boolean;
  /** Why this session was archived (e.g. "plan_executed", user-provided reason). */
  archive_reason?: string;
  /** Plan text stored on execution session (from the archived plan session). */
  planContent?: string;
}
