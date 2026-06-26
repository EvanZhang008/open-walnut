export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type TaskPhase =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'AGENT_COMPLETE'
  | 'AWAIT_HUMAN_ACTION'
  | 'HUMAN_VERIFIED'
  | 'POST_WORK_COMPLETED'
  | 'COMPLETE';
export type TaskPriority = 'immediate' | 'important' | 'backlog' | 'none';
/** Canonical list of valid priority values — use for runtime validation. */
export const VALID_PRIORITIES: readonly TaskPriority[] = ['immediate', 'important', 'backlog', 'none'] as const;
export type TaskSource = string;

// ── Session model registry ────────────────────────────────────────────────
// Single source of truth for the set of selectable Claude Code session models.
// Both backend (CLI --model mapping, web RPC allowlist) and frontend (picker,
// settings dropdown) derive from this — adding a new model means one edit here.
//
// Walnut passes only the SHORT alias (e.g. 'fable', 'fable[1m]') to `claude
// --model`; the CLI resolves it to a full Bedrock ID via ~/.claude/settings.json.
// NOTE: opus/sonnet/haiku are built-in CLI aliases that resolve unconditionally.
// `fable` is NOT built-in — it resolves only because ANTHROPIC_DEFAULT_FABLE_MODEL
// is set in settings.json. If that env var is missing on a host (e.g. a remote
// daemon host), `fable` will fail there while the other three keep working.
export type SessionModelFamily = 'opus' | 'sonnet' | 'haiku' | 'fable';
export interface SessionModelEntry {
  /** Picker / config alias, e.g. 'fable-1m'. */
  id: string;
  /** Display label, e.g. 'Fable 1M'. */
  label: string;
  /** Dropdown description. */
  description: string;
  /** Value passed to `claude --model`, e.g. 'fable[1m]'. */
  cliModel: string;
  family: SessionModelFamily;
  /** Whether this entry uses the 1M extended context window. */
  is1m: boolean;
}
export const SESSION_MODELS: readonly SessionModelEntry[] = [
  { id: 'opus',      label: 'Opus',      description: 'Most capable',      cliModel: 'opus',       family: 'opus',   is1m: false },
  { id: 'opus-1m',   label: 'Opus 1M',   description: '1M context window', cliModel: 'opus[1m]',   family: 'opus',   is1m: true  },
  { id: 'sonnet',    label: 'Sonnet',    description: 'Balanced',          cliModel: 'sonnet',     family: 'sonnet', is1m: false },
  { id: 'sonnet-1m', label: 'Sonnet 1M', description: '1M context window', cliModel: 'sonnet[1m]', family: 'sonnet', is1m: true  },
  { id: 'haiku',     label: 'Haiku',     description: 'Fastest',           cliModel: 'haiku',      family: 'haiku',  is1m: false },
  { id: 'fable',     label: 'Fable',     description: 'Fast & capable',    cliModel: 'fable',      family: 'fable',  is1m: false },
  { id: 'fable-1m',  label: 'Fable 1M',  description: '1M context window', cliModel: 'fable[1m]',  family: 'fable',  is1m: true  },
] as const;
/** alias id → CLI --model value. Derived from SESSION_MODELS. */
export const SESSION_MODEL_CLI_MAP: Record<string, string> =
  Object.fromEntries(SESSION_MODELS.map((m) => [m.id, m.cliModel]));
/** Set of valid picker/config alias ids — use for runtime allowlist validation. */
export const VALID_SESSION_MODEL_IDS: ReadonlySet<string> =
  new Set(SESSION_MODELS.map((m) => m.id));
/** Distinct model families — used by raw-model-string parsers (formatModelName, etc.). */
export const SESSION_MODEL_FAMILIES: readonly SessionModelFamily[] = ['opus', 'sonnet', 'haiku', 'fable'] as const;
/** Default session model alias (config.agent.session_model fallback). */
export const DEFAULT_SESSION_MODEL_ID = 'opus-1m';
/** Default CLI --model value when no model is specified. */
export const DEFAULT_CLI_MODEL = 'opus[1m]';

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
  plan_session_status?: { process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: SessionProvider; planCompleted?: boolean };
  /** @deprecated Use session_status instead. Kept for backward compat during migration. */
  exec_session_status?: { process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: SessionProvider };
  parent_task_id?: string;     // If set, this is a child task of the parent
  /** Local-only virtual grouping. Tasks sharing a group_id render as ONE visual
   *  group in the list (boxed together, ordered after the group's lead task) —
   *  this is NOT a parent/subtask relationship: the tasks stay flat and fully
   *  independent (separate lifecycles). All members must share the same
   *  category + project. Never pushed to external sync backends; round-trips via
   *  the SQLite `payload` blob (not a dedicated column). The human-readable group
   *  name lives in TaskStore.task_groups. */
  group_id?: string;
  depends_on?: string[];       // Full IDs of tasks that must complete before this one
  description: string;
  summary: string;
  note: string;
  conversation_log?: string;  // Append-only markdown log of user↔agent interactions
  /** Append-only compact milestone log — ONE line per major PHASE_SIGNAL transition
   *  (plan-written, implement-done, verify-pass/fail, review-done, committed). Written
   *  by turn-complete triage from the session's own WHAT_I_DID self-report. Replaces the
   *  verbose per-turn conversation_log in the UI; conversation_log is kept but hidden. */
  milestones?: string;
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
  pinned?: boolean;
  pin_order?: number;  // lower = higher in list, undefined = not pinned
  focus_tier?: 'focus' | 'wait';  // undefined = satellite (default)
  needs_attention?: boolean;
  /** Last sync error message — set on push failure, cleared on success. */
  sync_error?: string;
  /** ISO timestamp — last session interaction (start/resume). Drives "Recent" sort in sidebar. */
  last_session_update?: string;
  /** Task-level working directory override. Takes precedence over project default_cwd in session resolution. */
  cwd?: string;
  /** Set by the cwd rename detector / turn-end check when task.cwd no longer exists on disk.
   *  UI surfaces a warning; cleared when cwd is updated to a valid path. */
  cwd_missing?: boolean;
  /** ISO timestamp — server-side lastModified from last successful push response.
   *  Used for echo detection on pull. Local-only, never pushed to remote. */
  _syncedAt?: string;
  /** Plugin-specific extension data. Keys are plugin IDs (e.g. 'ms-todo', 'plugin-a'). */
  ext?: Record<string, unknown>;
}

export interface CategoryRecord {
  source: TaskSource;
}

export interface TaskStore {
  /** Legacy on-disk version marker. Preserved for existing tasks.json files
   *  and tests; no live code reads it. */
  version?: 1 | 2 | 3 | 4;
  tasks: Task[];
  categories?: Record<string, CategoryRecord>;
  /** Virtual task-group name registry: group_id → { label }. Maps the local-only
   *  Task.group_id to a human-readable (AI-generated) group name. Groups with
   *  fewer than 2 live members are pruned. Local-only; never synced. */
  task_groups?: Record<string, TaskGroupRecord>;
}

export interface TaskGroupRecord {
  /** Human-readable group name (AI-generated on creation; user-renamable). */
  label: string;
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
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log'
  | 'main_global_memory' | 'main_daily_log'
  | 'journal_recent'
  | 'working_memory';

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
  /** True for agents that appear in the main chat console (AgentSwitcher). */
  console?: boolean;
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
  /**
   * Triage throttling. Turn-complete triage trailing-debounces by `debounce_minutes`
   * (default 3) so a burst of interactive turns collapses into one end-of-interaction
   * triage. `notify_mode` gates the expensive main-agent notification:
   *   - 'off' (default): never wake the main agent; task.summary still updates (poll model)
   *   - 'buffered': don't wake in real time, but nudge the heartbeat to review soon
   *   - 'realtime': enqueue a main-agent turn immediately on each Outcome-B milestone
   */
  triage?: {
    debounce_minutes?: number;
    notify_mode?: 'off' | 'buffered' | 'realtime';
  };
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
  defaults: {
    priority: TaskPriority;
    category: string;
    /** Default platform/source for new tasks created via quick-add. Unset = 'local'
     *  (created locally, never blocks on an external sync round-trip). User picks this
     *  in Settings → General. */
    platform?: TaskSource;
    /** Optional default project for new quick-add tasks. */
    project?: string;
  };
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
    /** Vault-relative note paths (WITH .md), e.g. "PARA/foo.md". Toggled from the notes editor/tree. */
    notes?: string[];
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
    /** Enable --permission-prompt-tool stdio for local sessions.
     *  When enabled, Walnut intercepts permission prompts from Claude Code
     *  (sensitive file writes, AskUserQuestion) and handles them:
     *  - Bypass mode + auto_approve_bypass: auto-approves all requests
     *  - Other modes: forwards to UI for user decision
     *  Default: true. */
    permission_prompt?: boolean;
    /** Auto-approve all permission prompts in bypass mode.
     *  Bypass = full trust: Claude can write files, run commands, etc. without asking.
     *  Default: true. Set to false to manually review every permission even in bypass. */
    auto_approve_bypass?: boolean;
    /** Which session modes are available in the mode toggle cycle.
     *  Default: all four ['default', 'bypass', 'plan', 'accept'].
     *  Set to e.g. ['bypass', 'plan'] to only cycle between those two. */
    enabled_modes?: SessionMode[];
    /** Pass --include-partial-messages to `claude -p` so the CLI emits
     *  Anthropic SSE stream_event records (token-level deltas). With this on,
     *  assistant text streams into the UI character-by-character instead of
     *  appearing all at once when the message completes.
     *  Default: true. Set to false to fall back to per-message delivery. */
    stream_partial_messages?: boolean;
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
  ui?: {
    /** How many session panels to show side-by-side: '1', '2', or 'auto' (breakpoint-driven).
     *  Default: '2'. */
    session_panels?: '1' | '2' | 'auto';
    /** Per-tier control of "chatting with a pinned task bumps it to the front of its tier".
     *  Each tier independently configurable. Defaults (when a key is undefined):
     *  focus=false (preserve the manually ordered current sprint), next/satellite/wait=true. */
    bump_tiers?: {
      focus?: boolean;
      next?: boolean;
      satellite?: boolean;
      wait?: boolean;
    };
  };
  /** Audio capture configuration (system audio recording) */
  audio?: {
    /** Bundle IDs of apps to exclude from recording (e.g. 'com.spotify.client') */
    exclude_apps?: string[];
    /** How often to refresh the app list during recording, in seconds (default: 60) */
    refresh_interval_sec?: number;
    /** Delete WAV after successful transcription. Default: true */
    delete_after_transcription?: boolean;
    /** Auto-delete recordings older than N days. 0 = keep forever. Default: 7 */
    retention_days?: number;
  };
  /** Speech-to-text configuration for voice input */
  stt?: {
    engine?: 'sherpa-onnx' | 'openai' | 'whisper-cpp' | 'whisper-server';
    /** ISO 639-1 language hint (e.g. zh, en). Empty = auto-detect. */
    language?: string;
    // sherpa-onnx — local (SenseVoice / Whisper / Paraformer / other ONNX models)
    sherpa_model_dir?: string;
    sherpa_model_type?: 'sense_voice' | 'whisper' | 'paraformer';
    // OpenAI-compatible — cloud (OpenAI / Groq / Fireworks etc.)
    openai_api_key?: string;
    openai_base_url?: string;
    openai_model?: string;
    // whisper.cpp — local CLI (cold start each call)
    whisper_cpp_path?: string;
    whisper_cpp_model?: string;
    whisper_cpp_vad_model?: string;
    whisper_cpp_prompt?: string;
    // whisper-server — local HTTP daemon (model stays in memory)
    whisper_server_path?: string;
    whisper_server_model?: string;
    whisper_server_vad_model?: string;
    whisper_server_prompt?: string;
    whisper_server_port?: number;
    /** Idle TTL in minutes — server auto-shuts after inactivity (default: 10) */
    whisper_server_idle_ttl_minutes?: number;
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
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat' | 'quick-start';
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
  source?: 'cron' | 'triage' | 'session' | 'session-error' | 'agent-error' | 'subagent' | 'compaction' | 'heartbeat' | 'quick-start';
  cronJobName?: string;
  notification?: boolean;
  taskId?: string;
  sessionId?: string;          // Linked session ID (e.g. embedded triage run ID)
  // Compaction marker
  compacted?: boolean;         // true = excluded from model context, kept for scroll-back
  // Per-field content hashes for task context dedup (keys like "note:{taskId}", "pm:life/tax")
  contextHashes?: Record<string, string>;
  // Unique turn ID for eager-persist dedup (prevents double-write on error paths)
  turnId?: string;
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

/**
 * Metadata for one conversation under an agent. The conversation's actual
 * messages live in a separate ChatHistoryStore file ({conversationId}.json);
 * this is the lightweight registry entry used for listing/sorting/distill.
 */
export interface ConversationMeta {
  id: string;                          // 'conv-<uuid>'
  agentId: string;
  title: string;                       // auto from 1st user msg (≤60 chars), renameable
  createdAt: string;                   // ISO
  lastMessageAt: string;               // ISO — sort key (desc)
  messageCount: number;                // logical message count (approx, for display)
  pinned?: boolean;
  /** Exactly ONE conversation per agent is the "main" one (invariant). It receives
   *  background/system notifications (cron, heartbeat, triage, subagent results) and
   *  cannot be deleted via the UI. */
  isMain?: boolean;
  lastDistilledAt: string | null;      // null = never distilled
  lastDistilledMessageCount: number;   // messageCount at last distill (dedup key)
  /** True once the title has been set by the LLM auto-titler OR by a manual rename.
   *  Gates one-shot auto-titling so we neither re-label nor clobber a user's title. */
  titleAutoGenerated?: boolean;
}

/** Per-agent conversation registry, persisted as _index.json. */
export interface ConversationIndex {
  version: 1;
  activeConversationId: string | null; // currently-selected conversation for this agent
  conversations: ConversationMeta[];   // sorted lastMessageAt desc by convention
}

export type ProcessStatus = 'running' | 'idle' | 'stopped' | 'error';
export type SessionMode = 'bypass' | 'accept' | 'default' | 'plan';
export type SessionProvider = 'cli' | 'sdk' | 'embedded';
export type SessionType = 'interactive' | 'triage' | 'hook' | 'cron' | 'subagent';

export type StatusReason =
  | 'session_started'
  | 'turn_completed'
  | 'message_sent'
  | 'normal_completion'
  | 'idle_timeout'
  | 'idle_eviction'
  | 'server_restart'
  | 'process_exited_no_result'
  | 'remote_unreachable'
  | 'api_error'
  | 'liveness_check_failed'
  | 'orphan_no_pid'
  | 'daemon_reported_exit'
  | 'daemon_reconnected'
  | 'retry_reconnect'
  | 'user_stopped';

export type StatusChangedBy =
  | 'health-monitor'
  | 'reconciler'
  | 'session-runner'
  | 'subagent-runner'
  | 'daemon'
  | 'user'
  | 'system';

export interface StatusTransition {
  timestamp: string;
  process_status: ProcessStatus;
  reason: StatusReason;
  changed_by: StatusChangedBy;
  message?: string | null;
}

export interface SessionRecord {
  claudeSessionId: string;
  taskId: string;
  project: string;
  process_status: ProcessStatus;
  mode: SessionMode;
  provider?: SessionProvider;
  /** Session type — determines lifecycle and cleanup behavior. Undefined = 'interactive'. */
  type?: SessionType;
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
  /** Claude model used by this session (e.g. "claude-opus-4-6"). Display only. */
  model?: string;
  /** CLI model string passed to --model (e.g. "opus[1m]"). Preserves [1m] suffix for resume. */
  cliModel?: string;
  /** Archived — hidden from UI but data preserved. */
  archived?: boolean;
  /** Why this session was archived (e.g. "plan_executed", user-provided reason). */
  archive_reason?: string;
  /** Plan text stored on execution session (from the archived plan session). */
  planContent?: string;
  /** LLM-generated gist (topics/decisions/questions) for search indexing. Set by onSessionEnd summary agent. */
  summary?: string;
  /** ISO timestamp of last summary generation — used to skip re-summarizing recently-summarized sessions. */
  summaryGeneratedAt?: string;
  /** Error message when process_status is 'error' — persisted for post-mortem display. */
  errorMessage?: string;
  /** Why the last process_status change happened (K8s condition style). */
  status_reason?: StatusReason;
  /** Who triggered the last process_status change. */
  status_changed_by?: StatusChangedBy;
  /** Recent status transitions, newest first. Max 10 entries. */
  status_history?: StatusTransition[];
  /** Pending permission request — persisted so it survives server crashes.
   *  Set when Claude Code emits control_request, cleared on resolve. */
  pendingPermission?: {
    requestId: string;
    subtype?: string;     // control_request subtype (e.g. 'can_use_tool')
    toolName?: string;
    input?: Record<string, unknown>;
    reason?: string;
    receivedAt: string;  // ISO timestamp — for stale detection
  };
}
