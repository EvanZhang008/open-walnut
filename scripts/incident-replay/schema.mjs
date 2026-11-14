/**
 * The schema of a shape-only incident replay: the canonical texts, the names Walnut branches on,
 * and, per event type and system subtype, every key a fixture may carry with the kind of value it
 * holds. Data only (plus the two text rules); shape.mjs converts and validates against it.
 * Zero imports, like shape.mjs: the mock CLI loads both under any runtime.
 *
 * To keep a new field: add it here with the narrowest kind (an enum over a text, a text over
 * nothing), then run tests/core/incident-replay-privacy.test.ts. A field not listed here never
 * reaches a fixture.
 */

// ── Canonical texts ──

/** Placeholders for free text. Exported so tests and harnesses name them instead of retyping. */
export const PLACEHOLDER = Object.freeze({
  text: '(text)',
  thinking: '(thinking)',
  user: '(user text)',
  toolOutput: '(tool output)',
  result: '(result text)',
  error: '(error text)',
  command: '(command)',
  description: '(description)',
  header: '(header)',
  optionDescription: '(option description)',
  prompt: '(prompt)',
  plan: '(plan)',
  summary: '(summary)',
  reason: '(reason)',
  content: '(file content)',
  todo: '(todo)',
  rule: '(rule)',
  skill: '(skill)',
  cron: '0 * * * *',
  path: '/synthetic/path',
  cwd: '/synthetic/cwd',
})

/**
 * Canonical usage-limit texts, one per window the production reader tells apart
 * (usage-limit-model.ts claudeWindowFromText), each one a text the production detector
 * (usage-limit-text.ts matchesUsageLimitText) matches. `unknown`: limit words that name no
 * window (the older CLI form, which carries its reset as epoch seconds after the bar).
 */
export const USAGE_LIMIT_TEXT = Object.freeze({
  five_hour: 'You\'ve hit your session limit \u00b7 resets 3pm (UTC)',
  seven_day: 'You\'ve hit your weekly limit \u00b7 resets 3pm (UTC)',
  seven_day_opus: 'You\'ve hit your Opus limit \u00b7 resets 3pm (UTC)',
  seven_day_sonnet: 'You\'ve hit your Sonnet limit \u00b7 resets 3pm (UTC)',
  overage: 'You\'re out of extra usage \u00b7 resets 3pm (UTC)',
  unknown: 'Claude AI usage limit reached|1893456000',
})

/**
 * Canonical error texts. Production code reads an error's words with several detectors
 * (production.ts DETECTORS: retryable or terminal, the CLI's own phrasing, a full context, a lost
 * conversation, whose failure it is); a raw text becomes the canonical text the detectors read
 * the same way. The first four are the fallbacks when none matches exactly.
 */
export const ERROR_TEXT = Object.freeze({
  retryableCli: 'API Error: Request timed out.',
  retryable: '(error text) request timed out',
  terminalCli: 'API Error: 400 (error text)',
  terminal: PLACEHOLDER.error,
  contextFull: 'Prompt is too long',
  noConversation: 'No conversation found with session ID: (id)',
  signIn: 'Not logged in \u00b7 Please run /login',
  credentials: 'API Error: 401 (error text)',
  permissions: 'API Error: 403 (error text)',
  spending: 'Credit balance is too low',
})

export const RESULT_TEXTS = new Set(['', PLACEHOLDER.result, ...Object.values(USAGE_LIMIT_TEXT), ...Object.values(ERROR_TEXT)])

/**
 * The classifier used when none is injected: a canonical text stays itself, anything else is the
 * generic placeholder. Validation runs with it, so only canonical texts pass.
 * @param {string} text
 * @param {boolean} isError
 * @returns {string}
 */
export function canonicalOnlyClassifier(text, isError) {
  if (RESULT_TEXTS.has(text)) return text
  if (!text.trim()) return ''
  return isError ? ERROR_TEXT.terminal : PLACEHOLDER.result
}

/**
 * Prefixes of a user text that the session code branches on, exactly as the code tests them
 * (`startsWith('<local-command-stdout>')`, but `startsWith('<teammate-message')` with attributes
 * after it), each kept as its bare tag.
 */
export const USER_TAGS = [['<local-command-stdout>', 'local-command-stdout'], ['<local-command-stderr>', 'local-command-stderr'],
  ['<local-command-caveat>', 'local-command-caveat'], ['<task-notification>', 'task-notification'], ['<bash-stdout>', 'bash-stdout'],
  ['<bash-stderr>', 'bash-stderr'], ['<bash-input>', 'bash-input'], ['<teammate-message', 'teammate-message']]
export const USER_REMINDER = `${PLACEHOLDER.user}\n<system-reminder>${PLACEHOLDER.text}</system-reminder>`
export const USER_TEXTS = new Set(['', PLACEHOLDER.user, USER_REMINDER, ...USER_TAGS.map(([, t]) => `<${t}>${PLACEHOLDER.user}</${t}>`)])

/** @param {string} s */
export function shapeUserString(s) {
  const head = s.trimStart()
  if (!head) return ''
  for (const [prefix, t] of USER_TAGS) if (head.startsWith(prefix)) return `<${t}>${PLACEHOLDER.user}</${t}>`
  return s.includes('<system-reminder>') ? USER_REMINDER : PLACEHOLDER.user
}

// ── Names Walnut branches on ──

/** Claude Code's own tools: their names are public and the session code branches on several. */
export const BUILTIN_TOOLS = Object.freeze(['Agent', 'Task', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Read',
  'Write', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'ExitPlanMode',
  'EnterPlanMode', 'AskUserQuestion', 'Skill', 'SlashCommand', 'ToolSearch', 'TaskOutput', 'TaskStop', 'TaskCreate',
  'TaskGet', 'TaskList', 'TaskUpdate', 'Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'TeamCreate',
  'TeamDelete', 'SendMessage', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'EnterWorktree', 'ExitWorktree',
  'StructuredOutput'])
export const BUILTIN_TOOL_SET = new Set(BUILTIN_TOOLS)
export const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide'])
export const SYNTHETIC_MODEL = '<synthetic>'

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk']
export const STOP_REASONS = ['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal', 'pause_turn', 'model_context_window_exceeded']
export const TASK_STATUSES = ['pending', 'running', 'completed', 'failed', 'stopped', 'cancelled', 'killed']
export const TASK_TYPES = ['local_bash', 'local_agent', 'local_workflow', 'remote_agent', 'in_process_teammate', 'monitor', 'dream']
export const LIMIT_STATUSES = ['allowed', 'allowed_warning', 'rejected']
export const LIMIT_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification',
  'UserPromptSubmit', 'PreCompact', 'PostCompact']

// ── Spec constructors ──

export const MAX_NUM = 1e13
export const E = (...values) => ({ k: 'enum', values })
/**
 * An enum whose unlisted values become `fallback` instead of vanishing: for fields whose mere
 * presence the code reads (`status ?? 'completed'`, a truthy `error`), where dropping an unknown
 * value would flip the reading.
 */
export const EF = (fallback, ...values) => ({ k: 'enum', values, fallback })
export const ID = { k: 'id' }
export const NID = { k: 'nullable', of: ID }
export const PID = { k: 'pid' }
export const B = { k: 'bool' }
export const N = { k: 'num', min: 0 }
export const SN = { k: 'num', min: -MAX_NUM } // signed (an exit code)
export const NN = { k: 'nullable', of: N }
export const ISO = { k: 'iso' }
export const T = (ph) => ({ k: 'text', ph })
export const RT = { k: 'resultText' }
export const UT = { k: 'userText' }
export const TOOL = { k: 'name', space: 'tool' }
export const MODEL = { k: 'name', space: 'model' }
export const AGENT = { k: 'name', space: 'agent' }
export const SERVER = { k: 'name', space: 'server' }
export const O = (f) => ({ k: 'obj', f })
export const A = (of, max = 100000) => ({ k: 'arr', of, max })
export const C = (name) => ({ k: 'custom', name })

export const USAGE = O({
  input_tokens: N, output_tokens: N, cache_creation_input_tokens: N, cache_read_input_tokens: N,
  service_tier: E('standard', 'priority', 'batch'), speed: E('standard', 'fast'),
})
export const RATE_LIMIT_INFO = O({
  status: E(...LIMIT_STATUSES), rateLimitType: E(...LIMIT_WINDOWS), resetsAt: N, utilization: N, surpassedThreshold: N,
  overageStatus: E(...LIMIT_STATUSES), overageResetsAt: N,
  overageDisabledReason: E('out_of_credits', 'org_level_disabled', 'org_level_disabled_until', 'member_level_disabled', 'overage_not_provisioned', 'seat_tier_level_disabled', 'unknown'),
  isUsingOverage: B,
  unifiedWindows: O(Object.fromEntries(LIMIT_WINDOWS.map((w) => [w, O({ utilization: N, resetsAt: N })]))),
})
/** A user line's top-level tool_use_result: what the fold reads (ScheduleWakeup's scheduledFor, CronCreate's job id). */
export const TOOL_USE_RESULT = O({ scheduledFor: N, id: ID, status: E(...TASK_STATUSES), task_type: E(...TASK_TYPES), backgroundTaskId: ID,
  stdout: T(PLACEHOLDER.toolOutput), stderr: T(PLACEHOLDER.toolOutput), interrupted: B, isImage: B, noOutputExpected: B, success: B })
/** One model's entry in a result's modelUsage (keyed by the model name, which maps like every model). */
export const MODEL_USAGE_ENTRY = O({ inputTokens: N, outputTokens: N, cacheReadInputTokens: N, cacheCreationInputTokens: N,
  webSearchRequests: N, costUSD: N, contextWindow: N, maxOutputTokens: N })
export const BASE = { session_id: ID, uuid: ID, parent_tool_use_id: NID, timestamp: ISO }

/** Tool inputs: only the fields the session paths read, placeholder values. Unlisted tools keep `{}`. */
export const TOOL_INPUTS = {
  Bash: O({ command: T(PLACEHOLDER.command), description: T(PLACEHOLDER.description), run_in_background: B, timeout: N, dangerouslyDisableSandbox: B }),
  AskUserQuestion: C('askUserQuestion'),
  ExitPlanMode: O({ plan: T(PLACEHOLDER.plan) }),
  CronCreate: O({ cron: T(PLACEHOLDER.cron), prompt: T(PLACEHOLDER.prompt), recurring: B, durable: B }),
  CronDelete: O({ id: ID }),
  ScheduleWakeup: O({ delaySeconds: N, prompt: T(PLACEHOLDER.prompt), reason: T(PLACEHOLDER.reason) }),
  Agent: O({ description: T(PLACEHOLDER.description), prompt: T(PLACEHOLDER.prompt), subagent_type: AGENT, run_in_background: B }),
  Task: O({ description: T(PLACEHOLDER.description), prompt: T(PLACEHOLDER.prompt), subagent_type: AGENT, run_in_background: B }),
  TaskStop: O({ task_id: ID, shell_id: ID }),
  TaskOutput: O({ task_id: ID, block: B, timeout: N }),
  KillShell: O({ shell_id: ID }),
  BashOutput: O({ bash_id: ID }),
  TodoWrite: O({ todos: A(O({ content: T(PLACEHOLDER.todo), status: E('pending', 'in_progress', 'completed'), activeForm: T(PLACEHOLDER.todo) }), 200) }),
  Read: O({ file_path: T(PLACEHOLDER.path), offset: N, limit: N }),
  Write: O({ file_path: T(PLACEHOLDER.path), content: T(PLACEHOLDER.content) }),
  Edit: O({ file_path: T(PLACEHOLDER.path), old_string: T(PLACEHOLDER.content), new_string: T(PLACEHOLDER.content), replace_all: B }),
  Skill: O({ skill: T(PLACEHOLDER.skill) }),
  TeamCreate: O({}),
  TeamDelete: O({}),
}

export const CONTROL_SUBTYPES = E('can_use_tool', 'hook_callback', 'mcp_message', 'initialize', 'interrupt', 'set_permission_mode',
  'set_model', 'get_settings', 'get_context_usage', 'side_question', 'elicitation')
export const DECISION_REASON_TYPES = E('rule', 'mode', 'hook', 'classifier', 'subcommandResults', 'other', 'permissionPromptTool',
  'sandboxOverride', 'workingDir', 'safetyCheck', 'asyncAgent')
export const MCP_SOURCES = E('dynamic', 'plugin', 'user', 'project', 'local', 'sdk')

export const PERMISSION_SUGGESTION = O({
  type: E('addRules', 'replaceRules', 'removeRules', 'setMode', 'addDirectories', 'removeDirectories'),
  behavior: E('allow', 'deny', 'ask'),
  destination: E('session', 'localSettings', 'projectSettings', 'userSettings', 'cliArg'),
  mode: E(...PERMISSION_MODES),
  rules: A(O({ toolName: TOOL, ruleContent: T(PLACEHOLDER.rule) }), 100),
  directories: A(T(PLACEHOLDER.path), 100),
})

export const TASK_USAGE = O({ total_tokens: N, tool_uses: N, duration_ms: N })

/** system lines by subtype. Base fields only for the ones whose payload no session path reads. */
export const SYSTEM = {
  init: { cwd: T(PLACEHOLDER.cwd), model: MODEL, permissionMode: E(...PERMISSION_MODES), tools: A(TOOL, 2000),
    mcp_servers: A(O({ name: SERVER, status: E('connected', 'pending', 'failed', 'needs-auth', 'disabled') }), 500),
    fast_mode_state: E('off', 'on', 'cooldown') },
  session_state_changed: { state: E('idle', 'running', 'requires_action') },
  status: { status: { k: 'nullable', of: E('requesting', 'compacting') }, permissionMode: E(...PERMISSION_MODES),
    compact_result: E('success', 'failed'), compact_error: T(PLACEHOLDER.error) },
  task_started: { task_id: ID, tool_use_id: ID, description: T(PLACEHOLDER.description), task_type: E(...TASK_TYPES),
    is_backgrounded: B, owned_by_subagent: B, subagent_type: AGENT, prompt: T(PLACEHOLDER.prompt) },
  task_progress: { task_id: ID, tool_use_id: ID, description: T(PLACEHOLDER.description), usage: TASK_USAGE, last_tool_name: TOOL,
    workflow_progress: A(O({ type: E('workflow_agent', 'workflow_phase'), state: E('start', 'progress', 'done') }), 1000) },
  task_updated: { task_id: ID, tool_use_id: ID, patch: O({ status: EF('running', ...TASK_STATUSES), is_backgrounded: B, end_time: N, error: T(PLACEHOLDER.error) }) },
  task_notification: { task_id: ID, tool_use_id: ID, status: EF('running', ...TASK_STATUSES), output_file: T(PLACEHOLDER.path),
    summary: T(PLACEHOLDER.summary), run_id: ID, ambient: B, skip_transcript: B, usage: TASK_USAGE },
  background_tasks_changed: { tasks: A(O({ task_id: ID, task_type: E(...TASK_TYPES), description: T(PLACEHOLDER.description),
    parent_task_id: ID, run_id: ID, subagent_type: AGENT, status: EF('running', ...TASK_STATUSES), is_backgrounded: B }), 5000) },
  compact_boundary: { compact_metadata: O({ trigger: E('auto', 'manual'), pre_tokens: N, post_tokens: N, duration_ms: N }), logical_parent_uuid: ID },
  walnut_process: { walnutPid: PID, walnutTurn: B },
  walnut_fold_carry: { cron_ids: A(ID, 1000), wakeup_at: N },
  replay_truncated: { content: T(PLACEHOLDER.text), skipped_bytes: N, from_offset: N, resume_offset: N },
  api_retry: { attempt: N, max_retries: N, retry_delay_ms: N, error_status: NN,
    error: E('server_error', 'authentication_failed', 'unknown', 'rate_limit', 'overloaded', 'invalid_request', 'billing_error') },
  hook_started: { hook_event: E(...HOOK_EVENTS) },
  hook_response: { hook_event: E(...HOOK_EVENTS), outcome: E('success', 'cancelled', 'error'), exit_code: SN },
  informational: { level: E('warning', 'notice', 'info', 'error'), content: T(PLACEHOLDER.text) },
  notification: { priority: E('low', 'medium', 'high', 'immediate'), text: T(PLACEHOLDER.text) },
  permission_denied: { tool_name: TOOL, tool_use_id: ID },
  local_command: { content: T(PLACEHOLDER.text) },
  error: { content: T(PLACEHOLDER.error) },
  thinking_tokens: {}, task_summary: {}, scheduled_task_fire: {}, post_turn_summary: {}, api_timeout: {}, turn_retry: {},
  model_refusal_fallback: {}, model_refusal_no_fallback: {}, control_request_progress: {}, commands_changed: {},
  vcs_state_changed: {}, dev_intent: {},
}

/** Every other line type. `type` (and `subtype` for system) lead each line, in this key order. */
export const SCHEMAS = {
  user: O({ type: E('user'), subtype: E('walnut-injected'), message: O({ role: E('user'), content: C('userContent') }),
    ...BASE, isSynthetic: B, isReplay: B, isMeta: B, priority: E('now', 'next', 'later'),
    walnutMessageId: ID, walnutDelivery: E('ordered'), walnutPid: PID,
    tool_use_result: C('toolUseResult'),
    tool_result_meta: A(O({ id: ID, non_execution_kind: E('user-rejected', 'permission-rule', 'hook', 'classifier', 'mode') }), 1000) }),
  assistant: O({ type: E('assistant'),
    message: O({ id: ID, type: E('message'), role: E('assistant'), model: MODEL, content: A(C('assistantBlock'), 10000),
      stop_reason: { k: 'nullable', of: E(...STOP_REASONS) }, stop_details: O({ type: E('refusal') }), usage: USAGE }),
    ...BASE, request_id: ID, error: EF('unknown', 'rate_limit', 'invalid_request', 'server_error', 'unknown', 'authentication_failed', 'billing_error', 'overloaded', 'max_output_tokens'),
    isApiErrorMessage: B, api_error_params: O({ rate_limit_info: RATE_LIMIT_INFO }),
    subagent_type: AGENT, task_description: T(PLACEHOLDER.description),
    local_command_outcome: O({ kind: E('failed', 'succeeded') }) }),
  result: O({ type: E('result'),
    subtype: E('success', 'error', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'),
    is_error: B, num_turns: N, duration_ms: N, duration_api_ms: N, total_cost_usd: N, result: RT, errors: A(RT, 100),
    stop_reason: { k: 'nullable', of: E(...STOP_REASONS) },
    terminal_reason: E('completed', 'aborted_streaming', 'aborted_tools', 'api_error', 'stop_hook_prevented', 'max_turns', 'prompt_too_long'),
    api_error_status: NN, session_id: ID, uuid: ID, usage: USAGE, modelUsage: C('modelUsage'),
    permission_denials: A(C('permissionDenial'), 1000), origin: O({ kind: E('task-notification', 'peer') }),
    user_message_uuid: ID, user_message_uuids: A(ID, 1000), queued_turn_count: N, result_index: N, fast_mode_state: E('off', 'on', 'cooldown') }),
  control_request: O({ type: E('control_request'), request_id: ID, request: C('controlRequest') }),
  control_response: O({ type: E('control_response'), response: O({ subtype: E('success', 'error'), request_id: ID,
    error: T(PLACEHOLDER.error), response: O({ mode: E(...PERMISSION_MODES) }) }) }),
  control_cancel_request: O({ type: E('control_cancel_request'), request_id: ID }),
  command_lifecycle: O({ type: E('command_lifecycle'), command_uuid: ID,
    state: E('queued', 'started', 'completed', 'cancelled', 'discarded', 'refused'), uuid: ID, session_id: ID }),
  tool_progress: O({ type: E('tool_progress'), tool_use_id: ID, tool_name: TOOL, parent_tool_use_id: NID, elapsed_time_seconds: N, task_id: ID, uuid: ID, session_id: ID }),
  stream_event: O({ type: E('stream_event'), event: O({
    type: E('message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'),
    index: N, message: O({ id: ID, type: E('message'), role: E('assistant'), model: MODEL, usage: USAGE }),
    content_block: C('streamBlock'),
    delta: O({ type: E('text_delta', 'thinking_delta', 'input_json_delta', 'signature_delta'), text: T(PLACEHOLDER.text),
      thinking: T(PLACEHOLDER.thinking), stop_reason: { k: 'nullable', of: E(...STOP_REASONS) } }),
    usage: USAGE }), parent_tool_use_id: NID, session_id: ID, uuid: ID }),
  rate_limit_event: O({ type: E('rate_limit_event'), rate_limit_info: RATE_LIMIT_INFO, uuid: ID, session_id: ID }),
}
/**
 * Stand-ins for a line the schema does not know (an unlisted type or system subtype, or a line
 * that is not JSON), so the line still counts as "the CLI printed something" (line-fate-core.ts
 * outputAfterMarker) while saying nothing. The fold skips both.
 */
export const UNKNOWN_EVENT = '{"type":"unknown_event"}'
export const UNKNOWN_SYSTEM = '{"type":"system","subtype":"unknown_subtype"}'
SCHEMAS.unknown_event = O({ type: E('unknown_event') })
SCHEMAS['system/unknown_subtype'] = O({ type: E('system'), subtype: E('unknown_subtype') })

for (const [subtype, fields] of Object.entries(SYSTEM)) {
  SCHEMAS[`system/${subtype}`] = O({ type: E('system'), subtype: E(subtype), ...fields, session_id: ID, uuid: ID, timestamp: ISO })
}

/** @param {Record<string, unknown>} o */
export function schemaFor(o) {
  if (typeof o.type !== 'string' || o.type === 'system' && typeof o.subtype !== 'string') return undefined
  const key = o.type === 'system' ? `system/${o.subtype}` : o.type
  return Object.prototype.hasOwnProperty.call(SCHEMAS, key) ? SCHEMAS[key] : undefined
}
