/**
 * What a person can choose when they create and run a task in the web UI, and
 * the op argument that makes the same choice for an agent (2026-10-27, the user:
 * "did we make the AI able to ... create task using what engine, what model,
 * what effort, etc etc, same as human able to do?"; only task_transfer took an
 * effort then).
 *
 * Pure data. tests/mcp/launch-parity-ratchet.test.ts reads the UI's launch
 * payload (web/src/api/sessions.ts quickStartSession), the server's quick-start
 * body and task meta, the session settings a person can change, and the panel's
 * session actions, and fails when one of them is missing here or names an op
 * argument that does not exist. A new launch option therefore lands with its
 * op argument, or with the reason an agent has no use for it.
 *
 * `op` is `<op name>.<argument>` (or a bare op name for an action); `none` says
 * why an agent does not get it.
 */

export type ParityEntry = { op: string | readonly string[]; note?: string } | { none: string }

/** quickStartSession's options (web client) and POST /api/sessions/quick-start's body. */
export const LAUNCH_PARITY: Readonly<Record<string, ParityEntry>> = {
  message: { op: ['task_create.message', 'task_start.message'] },
  cwd: { op: ['task_create.cwd', 'task_start.cwd'] },
  host: { op: ['task_create.host', 'task_start.host'] },
  model: { op: ['task_create.model', 'task_start.model'], note: 'an ACP engine\'s effort rides inside its model id, as in the picker' },
  mode: { op: ['task_create.mode', 'task_start.mode'] },
  engine: { op: ['task_create.engine', 'task_start.engine'] },
  project: { op: 'task_create.project' },
  createCwd: { op: ['task_create.create_cwd', 'task_start.create_cwd'] },
  workspace: { op: ['task_create.workspace', 'task_start.workspace', 'workspace_providers'] },
  taskId: { op: 'task_start.id', note: 'a bound draft starts an existing task' },
  taskMeta: { op: 'task_create', note: 'each field is listed in TASK_META_PARITY' },
  images: { none: 'An agent hands files over as paths in message; a pasted image exists only in a browser.' },
  projectFromFolder: { none: 'Set when the draft derived the project from the picked folder; an agent names its project, or inherits its own.' },
  intent: { none: '"Customize Walnut" wraps a person\'s request in a repair briefing; an agent asking for Walnut work files a task in project Walnut.' },
  walnutAgent: { none: 'Starts a Personal AI conversation for the person in the chat slot, not work; agents talk to Walnut through ops.' },
  agentId: { none: 'Picks which console agent a Personal AI conversation speaks to; only with walnutAgent.' },
  overrideReadiness: { none: '"Start anyway" answers the host readiness gate of a person\'s launch; task_start does not run that gate.' },
  sessionId: { none: 'A browser-minted id so a lost HTTP answer stays reconcilable; the op reads the id from its answer.' },
}

/** QuickStartTaskMeta: the draft's task fields. */
export const TASK_META_PARITY: Readonly<Record<string, ParityEntry>> = {
  priority: { op: 'task_create.priority' },
  pinTier: { op: ['task_create.focus_tier', 'task_create.pinned'] },
  due_date: { op: 'task_create.due_date' },
  start_date: { op: 'task_create.start_date' },
  end_date: { op: 'task_create.end_date' },
  unread: { none: 'A person can only clear an unread flag the draft\'s AI set; a new task an agent files is read.' },
}

/** What a person changes on a running session (PATCH /sessions/:id fields, and the model / effort routes). */
export const SESSION_SETTING_PARITY: Readonly<Record<string, ParityEntry>> = {
  model: { op: 'task_session_set.model' },
  effort: { op: 'task_session_set.effort' },
  mode: { op: 'task_session_set.mode' },
  output_mode: { op: 'task_session_set.reply_style' },
  title: { op: 'task_update.title', note: 'a session takes its task\'s title' },
  activity: { none: 'Written by the session runner, not chosen.' },
  human_note: { none: 'The person\'s private note on a session.' },
  archived: { none: 'Hides an ended session from the person\'s panel lists.' },
  archive_reason: { none: 'Goes with archived.' },
  pinned_messages: { none: 'The person\'s pinned messages in the panel.' },
  thread_anchors: { none: 'Side-thread navigation state of the panel.' },
  thread_meta: { none: 'Side-thread navigation state of the panel.' },
}

/** /api/sessions/:id/<action> endpoints the web client calls (anywhere under web/src). */
export const SESSION_ACTION_PARITY: Readonly<Record<string, ParityEntry>> = {
  restart: { op: 'task_restart' },
  terminate: { op: 'task_stop' },
  model: { op: 'task_session_set.model' },
  effort: { op: 'task_session_set.effort' },
  retry: { op: ['task_send', 'task_restart'], note: 'a message resumes a failed or stopped session; task_restart respawns it' },
  'continue-in-new-folder': { op: 'api', note: 'POST /api/sessions/:id/continue-in-new-folder moves a session whose folder is gone into its task directory and sends what waited' },
  controls: { none: 'An ACP engine\'s own option pills (approval mode, thought level) for the session it runs; its effort rides the model id.' },
  fork: { op: 'task_transfer', note: 'a new task carrying the conversation' },
  permission: { none: 'The person answers a permission prompt; an agent never approves a tool for another session.' },
  plan: { none: 'The person approves or rejects a plan the session proposed.' },
  execute: { none: 'Runs an approved plan; follows the person\'s plan decision.' },
  'execute-continue': { none: 'Continues after an approved plan; follows the person\'s plan decision.' },
  rewind: { none: 'Rewinds the conversation and files on the person\'s review in the rewind dialog.' },
  recheck: { none: 'A diagnostic re-read of the host; task_get reports the session\'s state.' },
  supervision: { none: 'The person\'s auto-recovery switch for one session.' },
  history: { op: 'task_history' },
  subagent: { op: 'task_history', note: 'a subagent\'s transcript inside the conversation' },
  workflow: { op: 'task_history', note: 'read-only' },
  'model-catalog': { none: 'Read for the picker; task_start and task_session_set accept the same model ids.' },
  models: { none: 'Read for the picker.' },
  settings: { none: 'Reads the engine settings the popover edits (global engine config such as fast mode, not a launch choice).' },
  'service-preview': { none: 'The web view of a service the session serves.' },
  'vscode-embed': { none: 'Opens the editor beside the panel.' },
  'vscode-uri': { none: 'Opens the editor beside the panel.' },
  turns: { op: 'task_history', note: 'the conversation turn by turn' },
  changes: { none: 'Read for the Changed tab; the session itself (and git) knows what it changed.' },
  commit: { none: 'The commit dialog commits a session\'s changes on the person\'s review; a session commits with git itself.' },
  cost: { none: 'Read for the usage readout.' },
  'side-question': { none: 'A person\'s side question beside a session; an agent asks a task with task_send.' },
  'side-questions': { none: 'A person\'s side questions beside a session; an agent asks a task with task_send.' },
  'side-threads': { none: 'A person\'s side threads beside a session; an agent asks a task with task_send.' },
  'slash-commands': { none: 'Read for the composer\'s slash menu.' },
}
