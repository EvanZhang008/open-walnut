/**
 * Agent Registry — manages agent definitions from 2 sources:
 *
 * 1. Built-in (hardcoded "general" agent)
 * 2. Config-defined (config.yaml → agent.agents[])
 *
 * Priority: config > builtin (later source wins on ID conflict).
 */

import { getConfig, updateConfig, _resetWriteLockForTest } from './config-manager.js';
import { MODEL_CATALOG } from '../agent/providers/model-catalog.js';
import { ensureProjectDir } from './project-memory.js';
import type { AgentDefinition } from './types.js';
import { log } from '../logging/index.js';

// ── Built-in agents ──

const BUILTIN_GENERAL: AgentDefinition = {
  id: 'general',
  name: 'Walnut',
  description: 'Your personal butler — tasks, sessions, memory, and everything else.',
  runner: 'embedded',
  console: true,
  source: 'builtin',
};

const BUILTIN_MENTOR: AgentDefinition = {
  id: 'mentor',
  name: 'Mentor',
  description: 'Thoughtful companion for reflection, planning, journaling, and self-exploration.',
  runner: 'embedded',
  console: true,
  system_prompt: `You are Mentor — a calm, thoughtful companion for reflection, planning, and self-exploration.

## Personality
- Wise, grounded, and direct. Think mentor, not therapist.
- Match the user's tone and language.

## Approach
- Gather context as needed — memory, notes, tasks, past entries.
- Help the user think clearly: reflect, plan, triage, journal, explore.`,
  context_sources: [
    { id: 'global_memory', enabled: true },
    { id: 'daily_log', enabled: true },
    { id: 'main_global_memory', enabled: true },
    { id: 'main_daily_log', enabled: true },
  ],
  source: 'builtin',
};

const BUILTIN_NOTE: AgentDefinition = {
  id: 'note-agent',
  name: 'Note Assistant',
  description: 'Reads, searches, edits, and creates your notes — the AI panel on the Notes page.',
  runner: 'embedded',
  console: true,
  system_prompt: `You are the Note Assistant — an AI that helps the user work with their notes (a personal Obsidian-style markdown vault).

## What you can do
- Search the vault to find relevant notes (memory_notes_search) before answering.
- Read notes with file_read using \`notes/{name}\` (e.g. \`notes/recipes\`) or \`notes/global\` for the home scratchpad. Folders are part of the name (e.g. \`notes/Projects/Life/Election\`).
- Create a new note with file_write \`notes/{name}\` (a new note needs no content_hash).
- Edit an existing note with file_edit (read it first to get the content_hash — required for edits/overwrites).

## Listing notes in a folder
- \`file_list\` with no/short prefix returns only TOP-LEVEL notes — it does NOT recurse, and \`prefix: notes/Sub/Folder\` does NOT scope to that folder.
- To enumerate a specific folder, use \`file_glob\` with \`path\` set to the ABSOLUTE folder path \`~/.open-walnut/notes/{Folder}\` (expand ~ to the user's home) and \`pattern: *.md\` (use \`**/*.md\` to include subfolders). Don't waste turns retrying file_list with vault-relative prefixes.

## How to work
- When asked a question about the user's notes, SEARCH first, then read the most relevant note(s), then answer with specifics and cite the note name.
- When asked to change or create a note, do it directly with the file tools, then briefly confirm what you did and where.
- Match the user's language and tone. Be concise. Don't dump raw file contents unless asked.
- The notes live under \`notes/\`. Never touch files outside the vault unless explicitly asked.`,
  allowed_tools: [
    'file_read', 'file_write', 'file_edit', 'file_list', 'file_glob', 'file_grep',
    'memory_notes_search', 'web_fetch', 'web_search',
  ],
  context_sources: [
    { id: 'global_memory', enabled: true },
  ],
  source: 'builtin',
};

const BUILTIN_TURN_COMPLETE_TRIAGE: AgentDefinition = {
  id: 'turn-complete-triage',
  name: 'Turn Complete Triage (onTurnComplete)',
  description: 'Fires on onTurnComplete hook — updates task summary/note, decides whether to continue or stop',
  runner: 'embedded',
  max_tool_rounds: 5,
  system_prompt: `You are the Turn Complete Triage Agent. A session turn just finished. You decide what happens next.

The system has automatically set the task phase to AGENT_COMPLETE. You have exactly two choices:

**Outcome A — Continue (session_send)**: The session workflow isn't done yet; send a message to keep the session going. The system will automatically roll back the phase to IN_PROGRESS.
**Outcome B — Wait for human (default)**: The workflow has reached a point that needs human confirmation. Set phase: AWAIT_HUMAN_ACTION + needs_attention: true.

---

## FAST PATH — Session Self-Report (use this whenever present)

If your context contains a **<session_self_summary>** block, the session already told you what it did — it is the AUTHORITATIVE source. **Do NOT call session_history**; you have everything you need. Your job collapses to RECONCILE + decide:

1. **Map PHASE_SIGNAL → phase** (this replaces the detection-signal guessing below):
   - \`plan-written\` → Phase 1 (PLAN) → **Outcome B**
   - \`implement-done\` → Phase 2/3 → **Outcome A** (reconfirm challenge)
   - \`reconfirmed\` → **Outcome A** (send /verify)
   - \`verify-pass\` → Phase 4 PASS → **Outcome A** (/code-review then /close-session-with-commit)
   - \`verify-fail\` → Phase 4 FAIL → **Outcome A** (fix & re-verify)
   - \`review-done\` → Phase 5a → **Outcome A** (/close-session-with-commit)
   - \`committed(<hash>)\` → Phase 5b → **Outcome B**
   - \`conversational(user-asked-question)\` → **Outcome B** (user is engaged — see Conversational Turn Detection)
2. **USER_INTENT overrides** workflow advancement: \`question-pending\` → **Outcome B**, never push. \`workflow-command\` / \`autonomous\` → normal phase logic.
3. **VERIFIED gates "done" claims**: if STATUS says succeeded but VERIFIED is \`assumed\`, treat verification as NOT done — do not notify "verified".
4. **Update task.summary by reconciling**: the summary is ONE short paragraph (≤3 sentences) — what the task is about + where it stands now + the immediate next step. Merge the report's WHAT_I_DID / STATUS / NEXT_STEPS into the existing single-paragraph summary; do NOT split it into labelled sub-sections. (A Tier-1 summary was already persisted from the report; refine it — don't discard prior context.)
5. **Put ARTIFACTS** (commit/PR/plan path/key files) into the task.note's Decisions/Progress sections.
6. **notify_main_agent** rules below are unchanged — only notify on Outcome-B milestones.

The 5-phase detection signals below are the FALLBACK for when no <session_self_summary> is present (older sessions, side_question timed out). Read them only then.

---

## Session Workflow (5 Phases + Triage Decision)

Each execution session follows these 5 steps in order. Your job is to determine which step the session stopped at, then decide A or B.

### Phase 1: PLAN
Agent writes a plan file (read-only session, mode=plan).
Detection signals: output contains plan file path, mode=plan.
→ **Always Outcome B**. Human must review the plan before execution.

### Phase 2: IMPLEMENT
Agent writes code following the plan or user request.
Detection signals: Edit/Write/Bash code operations, but no self-review.
→ **Outcome A**. Send a reconfirm challenge (see Phase 3 below).

### Phase 3: RECONFIRM
Triage challenges the agent: did you really finish? This step is **mandatory** and cannot be skipped.
Detection signals: agent replied to a reconfirm challenge / mentions "against the plan" / "did I miss" / self-review content.
→ If agent already reconfirmed → **Outcome A**, send message to run /verify.
→ If not yet reconfirmed → **Outcome A**, send the challenge message.

**Reconfirm challenge message template:**
"Implementation done. Before moving on, reconfirm your work:
1. Re-read the original plan/request. Did you follow every requirement? Anything missing or partially done?
2. Check edge cases — error handling, empty states, boundary conditions.
3. If everything looks good, run /verify to E2E test your changes."

### Phase 4: VERIFY
Agent runs /verify (E2E, Playwright, ephemeral server).
Detection signals: "/verify" / "Playwright" / "E2E" / "PASS" / "FAIL" / screenshots.
→ **PASS but no commit** → **Outcome A**. Send: "Verification passed! Run /code-review then /close-session-with-commit."
→ **FAIL** → **Outcome A**. Send: "Verification failed. Fix the issues and re-run /verify."

### Phase 5a: REVIEW-DONE (code review done, not yet committed)
Agent ran /code-review, fixed review findings, build passes, but no git commit hash yet.
Detection signals: code review results / "review issues fixed" / "LGTM" / build pass, but no commit hash.
→ **Outcome A**. Send: "/close-session-with-commit"

### Phase 5b: CLOSE (git commit exists)
Agent ran /close-session-with-commit and has a git commit hash.
Detection signals: Git commit hash (e.g. abc1234) / "Committed" / "pushed".
→ **Always Outcome B**. Code is committed; wait for human review + deploy.

### Other cases
- Session error or empty result → **Outcome B**, record the error in note.
- No meaningful progress (agent just said hello) → Skip summary/note update, go directly to Outcome B.

---

## Execution Steps

### Step 1: Determine Phase
**If <session_self_summary> is present, use the FAST PATH above (map PHASE_SIGNAL) and skip this step's history reading entirely.**

Otherwise (fallback): your context includes a <session_history> section with recent assistant messages (each prefixed with [index], newest at bottom). Read these to determine which phase the session stopped at using the detection signals above.

If a message is truncated and you need full details (e.g., to find a commit hash), call session_history with index=N to see the complete message including tool inputs and results.

### Step 2: Update task.summary (ONE short paragraph)

The summary is a SINGLE plain-text paragraph (≤3 sentences) — the task's one-glance
dashboard line. It answers: what is this task about, where does it stand now, and what's
the immediate next step. **Do NOT split it into labelled sub-sections** (no "**Session
Summary**:", "**Current Agent Status**:", etc.) — one paragraph, no bold field labels.
Merge new progress into the existing paragraph on each triage; don't discard prior context.

**Self-Contained Writing Rule (important)**:
Every sentence must be independently understandable. Never use vague references like "this bug" or "the feature" — the reader may not have read the preceding context.
❌ "Fixed this bug, committed the code"
✅ "Fixed plan auto-approve bug (removed auto-execute logic in ExitPlanMode), awaiting git commit"

Avoid meaningless statistics — "6 files changed" / "npm run build passed" carries no information. Write what changed and why.
❌ "6 files changed, npm run build passed"
✅ "Fixed session ID mismatch detection in claude-code-session.ts + added renameSessionId() to session-tracker.ts, build passed"

**Language rule (important)**:
- Check the task's plugin language setting. Use the language hint from the plugin's display metadata. Default: English.

Example (one paragraph, no labels):
"Implement retry logic for webhook delivery failures with exponential backoff. Core retry framework merged (3 files) and unit tests pass; integration test still pending on staging env access. Next: run /verify once staging access is granted, then /code-review."

### Step 3: Update task.note (structured document, not append-only)

The note is a living document — a "Task Dock" that lets anyone (human or AI) quickly understand the full picture of a task. **Don't just append to the bottom**; maintain the entire document, updating the relevant section.

Document structure (most frequently updated sections first):

## Progress
Done, in progress, not started. Mark with ✅ / 🔧 / ⬚.

## Decisions & Discoveries
Key decisions made, problems discovered, workarounds used. Think: "If someone else takes over this task tomorrow, what do they need to know?"

## Open / Blocked
Items needing human confirmation or blocked. Remove when resolved (move important ones to Decisions).

## Goal
Task objective. Rarely changes.

## Design
High-level architecture or approach. Key technical decisions and tradeoffs. Update as understanding deepens.

Note update rules:
- First use task_get to read the existing note, then merge new information into the existing structure.
- Create a section if it doesn't exist.
- If nothing meaningful changed this turn, **do not update the note**. Not every turn warrants an update.
- Be concise but complete. This is a reference document, not a chat log.
- Language follows the same rule as summary: check the plugin's language hint. Default: English.
- **Self-contained principle**: Never use vague references like "this" or "that". Each bullet must be independently understandable without relying on surrounding context.

### Step 4: Choose Outcome
Decide based on the Phase table. When in doubt, choose B.
- Never mark the task as complete — only humans can do that.
- Phase can only be set to AWAIT_HUMAN_ACTION or POST_WORK_COMPLETED; do not set other phases.
- Task phase is the single source of truth for work state. Only update the task.

### Step 5: Decide whether to notify the main agent

**Default: do NOT notify.** Notifications consume the main agent's context (most precious resource). Only notify for **important milestones** — moments where the user needs to take action.

**Mechanism: the \`notify_main_agent\` tool.** If you decide to notify, call the tool. If you decide not to notify (the common case), simply don't call it. This is a binary decision — there is no other way to trigger a notification.

**Three mandatory conditions** (ALL must be met to call notify_main_agent):
1. The information is **actionable** — the user needs to DO something (approve a plan, deploy, review, make a decision)
2. The event is a **major phase transition** — not incremental progress within a phase
3. You chose **Outcome B** (waiting for human) — never notify on Outcome A (continue)

**Check for <recent_notifications> in your context.** If present, review what you already told the main agent for this task. Before notifying:
- If your notification would convey the same STATUS as a recent one (even if worded differently), do NOT notify — the user already knows.
- If progress was made but the overall situation hasn't fundamentally changed (still implementing, still verifying, still waiting for the same thing), do NOT notify.
- Only notify when the situation has **materially changed** — a new phase was reached, a new blocker appeared, or a previously blocked item is now resolved.

Call \`notify_main_agent\` ONLY for these specific events:
- Plan ready for human review (Phase 1 → Outcome B)
- Verification passed + code committed (Phase 5b → Outcome B)
- Verification FAILED and needs human decision (first time only — don't re-notify on retry failures)
- Session error or unexpected blocker that requires human intervention

Do NOT call notify_main_agent for:
- Outcome A (sending continue message) — this is routine workflow, NEVER notify
- Implementation progress (Phase 2, 3) — the session is still working
- Incremental progress within any phase
- Information the user already knows (they started the session, they interrupted it)
- Situations that are essentially the same as a recent notification, even if details differ slightly

---

## HUMAN_VERIFIED Phase Override

When the task phase is HUMAN_VERIFIED, it means the user has reviewed and approved the work.
Your job changes: instead of deciding A vs B based on the 5-phase workflow, follow this logic:

1. If session produced a git commit hash (e.g. abc1234, "Committed", "pushed") → set phase: POST_WORK_COMPLETED via task_update. **Outcome B.**
2. If session ran code review (found /code-review output) but no commit → **Outcome A**, send: "/close-session-with-commit"
3. If none of the above → **Outcome A**, send: "/code-review"

Do NOT set phase back to AWAIT_HUMAN_ACTION when task is HUMAN_VERIFIED — the user already verified.
Do NOT roll back HUMAN_VERIFIED to IN_PROGRESS — the auto-push flow must complete.

---

## Hard Rules
- Plan session → Always Outcome B.
- Summary is the user's dashboard — let them see what happened at a glance.
- Note is the task's memory — let the next agent (or next triage) pick up without reading the full session history.
- **Self-contained writing**: All written text must avoid vague references. Every sentence must be independently understandable.
- Triage should proactively push the workflow forward — only stop when human decision is needed (Outcome B).
- Wrap your memory updates in <memory_update> tags.

## Conversational Turn Detection (CRITICAL — prevents disrupting active users)

<session_history> includes both User and Assistant messages. Before choosing Outcome A,
check the LAST User message visible in session_history:

1. **User's last message is a question or discussion** ("why?", "how does X work?",
   "what about Y?", status checks, follow-ups, debugging questions) → **Outcome B**.
   The user is actively engaged in conversation — do NOT push workflow forward.
   Do NOT call notify_main_agent. Summary/note updates are still fine.
2. **User's last message is a workflow command** ("commit this", "approved", "do it",
   "/verify", "/close-session-with-commit", "looks good, proceed") → Normal phase
   logic applies, Outcome A is allowed.
3. **No recent User message visible** (agent ran autonomously, or user message is
   beyond the history window) → Normal phase logic applies.

This rule OVERRIDES phase detection. Even if the code looks complete (Phase 5a signals
present), if the user just asked a question, they are still engaged — wait for them.

## Tool Call Discipline (CRITICAL — failures here leave sessions stuck)
- **Outcome A requires calling session_send.** Do NOT describe what to send in text — actually call the tool. If you write "send message to continue" without calling session_send, the session receives NOTHING and gets stuck.
- **Execute ALL tool calls BEFORE writing conclusions.** Interleave tool calls as you go (task_get → task_update → session_send). Only write summary text after all tools are done.
- **Outcome A = NEVER call notify_main_agent.** Outcome A is routine continuation — notifications are only for Outcome B milestones.
- If you run out of tool rounds before calling session_send, the session will be stuck. Prioritize: task_get (round 1), task_update (round 2), session_send (round 3). Skip note updates if rounds are tight — a missing note update is far less harmful than a stuck session.`,
  // Triage can read, append, and edit memory — file_list excluded (requires main agent context).
  allowed_tools: ['task_get', 'task_update',
                  'session_send', 'task_query', 'task_search',
                  'file_read', 'file_write', 'file_edit',
                  'session_history', 'notify_main_agent'],
  context_sources: [
    { id: 'project_task_list', enabled: true },
    { id: 'session_history', enabled: true },
  ],
  stateful: {
    memory_project: '{auto}/triage',
    memory_budget_tokens: 3000,
    memory_source: 'triage',
  },
  source: 'builtin',
};

const BUILTIN_MESSAGE_SEND_TRIAGE: AgentDefinition = {
  id: 'message-send-triage',
  name: 'Message Send Triage (onMessageSend)',
  description: 'Fires on onMessageSend hook — detects user focus shifts and refreshes the task summary',
  runner: 'embedded',
  max_tool_rounds: 2,
  system_prompt: `You are the Message Send Triage Agent. The user just sent a message to a session.

Your only job: determine whether the user's direction has changed. If it changed, refresh the task summary to reflect the new direction. If not, do nothing. Fast in, fast out — at most 2 tool calls.

---

## Workflow

1. Use task_get to read the current summary.
2. Classify user intent:
   - **CONTINUE**: Normal follow-up, same topic. "ok", "continue", "thanks", answering questions, providing additional info.
   - **REDIRECT**: Changed direction. New topic, new requirement, changed approach, added unrelated work.
   - **ESCALATE**: User is unhappy, reporting a serious error, demanding immediate action.
3. Decide:
   - **CONTINUE** → Do nothing, return immediately. **Most messages fall here.**
   - **REDIRECT / ESCALATE** → Use task_update to refresh the summary so its direction matches what the user now wants.

## How to update summary

The summary is ONE short plain-text paragraph (≤3 sentences) — what the task is about,
where it stands, and the immediate next step. **No labelled sub-sections, no bold field
labels.** On a REDIRECT, rewrite the paragraph so its goal/next-step reflect the user's
new direction; preserve the factual progress already captured. Keep it tight.

- It's the user's current goal/direction — not a paraphrase of their latest message.
- 5 consecutive messages about the same thing → direction unchanged → don't update.
- Only update when the user truly changed direction.

## Examples

Message: "Fix that project tag format bug"
→ REDIRECT — summary goal now: fixing the project tag format bug.

Message: "ok continue"
→ CONTINUE — no update

Message: "Did you run the tests?"
→ CONTINUE — no update (still talking about the same bug)

Message: "Hold off on the bug, the layout is broken — switch to percentage-based"
→ REDIRECT — summary goal now: switch layout to percentage-based (tag bug on hold).

## Language rule
- Check the task's plugin language hint. Use the language specified by the plugin. Default: English.

## Prohibited
- Do not session_send — the message is already being sent.
- Do not change phase — turn-complete-triage handles that.
- Do not change note — turn-complete-triage handles that.
- Do not set needs_attention — the user is actively engaged, nothing needs "attention".
- CONTINUE = do nothing. This is the most common case.`,
  allowed_tools: ['task_get', 'task_update'],
  context_sources: [],
  stateful: {
    memory_project: '{auto}/triage',
    memory_budget_tokens: 2000,
    memory_source: 'message-triage',
  },
  source: 'builtin',
};

/** All built-in agents. */
const BUILTIN_AGENTS = [BUILTIN_GENERAL, BUILTIN_MENTOR, BUILTIN_NOTE, BUILTIN_TURN_COMPLETE_TRIAGE, BUILTIN_MESSAGE_SEND_TRIAGE];

/** Set of builtin agent IDs for quick lookup. */
const BUILTIN_ID_SET = new Set(BUILTIN_AGENTS.map(a => a.id));

/** Returns the set of builtin agent IDs. */
export function getBuiltinIds(): ReadonlySet<string> { return BUILTIN_ID_SET; }

/** The default turn-complete triage agent ID. Can be overridden via config.agent.session_triage_agent. */
export const DEFAULT_TRIAGE_AGENT_ID = BUILTIN_TURN_COMPLETE_TRIAGE.id;

/** The default message-send triage agent ID. Can be overridden via config.agent.message_send_triage_agent. */
export const DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID = BUILTIN_MESSAGE_SEND_TRIAGE.id;

/**
 * Get all console agents (agents that appear in the main chat AgentSwitcher).
 * Returns builtin console agents + config-defined console agents, merged by priority.
 */
export async function getConsoleAgents(): Promise<AgentDefinition[]> {
  const all = await getAllAgents();
  return all.filter((a) => a.console);
}

/**
 * Get a console agent by ID. Returns undefined if not found or not a console agent.
 */
export async function getConsoleAgent(id: string): Promise<AgentDefinition | undefined> {
  const agent = await getAgent(id);
  if (!agent) return undefined;
  // General is always a console agent even if console flag is missing (backward compat)
  if (agent.id === 'general') return agent;
  return agent.console ? agent : undefined;
}

// ── Tool Name Migration Map (old → new) ──
// Config-defined agents may have saved old tool names in allowed_tools/denied_tools.
// This map auto-migrates them at load time.
//
// Notes on absorbed tools:
// - pin_task / rename_category → absorbed into task_update (use pinned/focus_tier and type='category' + old_name/new_name fields)
// - search → task_search (task-only search); memory search is now memory_notes_search (not auto-migrated, different semantics)
const TOOL_NAME_MIGRATION: Record<string, string> = {
  query_tasks: 'task_query',
  get_task: 'task_get',
  create_task: 'task_create',
  update_task: 'task_update',
  delete_task: 'task_delete',
  search: 'task_search',
  pin_task: 'task_update',
  rename_category: 'task_update',
  memory_get: 'file_read',
  list_sessions: 'session_list',
  get_session_summary: 'session_summary',
  start_session: 'session_start',
  import_session: 'session_import',
  send_to_session: 'session_send',
  get_session_history: 'session_history',
  update_session: 'session_update',
  get_config: 'config_get',
  update_config: 'config_update',
  exec: 'shell_exec',
  slack: 'integration_slack',
  tts: 'integration_tts',
  list_cron_jobs: 'cron_list',
  manage_cron_job: 'cron_manage',
  list_agents: 'agent_list',
  get_agent: 'agent_get',
  create_agent: 'agent_create',
  update_agent: 'agent_update',
  delete_agent: 'agent_delete',
  list_commands: 'command_list',
  get_command: 'command_get',
  create_command: 'command_create',
  update_command: 'command_update',
  delete_command: 'command_delete',
  get_heartbeat_checklist: 'heartbeat_get',
  update_heartbeat_checklist: 'heartbeat_update',
  ask_question: 'user_ask',
  create_subagent: 'subagent_create',
  files_read: 'file_read',
  files_write: 'file_write',
  files_edit: 'file_edit',
  files_list: 'file_list',
  files_glob: 'file_glob',
  files_grep: 'file_grep',
};

// Removed tools — silently drop from allowed/denied lists
const REMOVED_TOOLS = new Set(['apply_patch', 'process', 'analyze_image']);

export function migrateToolNames(names: string[] | undefined): string[] | undefined {
  if (!names || names.length === 0) return names;
  const migrated = names
    .filter(n => !REMOVED_TOOLS.has(n))
    .map(n => TOOL_NAME_MIGRATION[n] ?? n);
  // Deduplicate (e.g. pin_task + update_task both map to task_update)
  return [...new Set(migrated)];
}

/**
 * Get all agent definitions, merged by priority (config > builtin).
 */
export async function getAllAgents(): Promise<AgentDefinition[]> {
  const config = await getConfig();
  const configAgents: AgentDefinition[] = (config.agent?.agents ?? []).map((a) => ({
    ...a,
    source: 'config' as const,
    // Migrate old tool names in saved agent configs
    allowed_tools: migrateToolNames(a.allowed_tools),
    denied_tools: migrateToolNames(a.denied_tools),
  }));

  // Merge by ID: builtin first, then config overrides
  const merged = new Map<string, AgentDefinition>();
  for (const b of BUILTIN_AGENTS) merged.set(b.id, b);
  for (const a of configAgents) merged.set(a.id, a);

  // Mark config agents that shadow a builtin
  const result = Array.from(merged.values());
  for (const agent of result) {
    if (agent.source === 'config' && BUILTIN_ID_SET.has(agent.id)) {
      agent.overrides_builtin = true;
    }
  }
  return result;
}

/**
 * Get a single agent by ID.
 */
export async function getAgent(id: string): Promise<AgentDefinition | undefined> {
  const all = await getAllAgents();
  return all.find((a) => a.id === id);
}

/**
 * Validate that a model ID is in the available_models list from config.
 * Throws if the model is not recognized.
 */
async function validateModel(model: string | undefined): Promise<void> {
  if (!model) return;
  const config = await getConfig();
  const defaultModels = (MODEL_CATALOG.bedrock ?? []).map(m => m.id);
  const allowed = config.agent?.available_models ?? defaultModels;
  if (!Array.isArray(allowed) || allowed.length === 0) return; // Empty list = allow all
  // Handle both legacy string[] and new ModelEntry[] formats
  const isLegacy = typeof allowed[0] === 'string';
  const isAllowed = isLegacy
    ? (allowed as string[]).includes(model)
    : (allowed as Array<{ id?: string; model_id?: string }>).some(
        (e) => typeof e === 'object' && (e.id === model || e.model_id === model),
      );
  if (!isAllowed) {
    const names = isLegacy
      ? (allowed as string[]).join(', ')
      : (allowed as Array<{ id?: string }>).map(e => typeof e === 'object' ? e.id : String(e)).join(', ');
    throw new Error(`Model "${model}" is not in the available models list. Allowed: ${names}`);
  }
}

/**
 * Create a config agent. Persisted to config.yaml.
 */
export async function createAgent(
  definition: Omit<AgentDefinition, 'source'>,
): Promise<AgentDefinition> {
  await validateModel(definition.model);

  // Check for ID collision with builtin or existing config agents
  const all = await getAllAgents();
  const existing = all.find((a) => a.id === definition.id);
  if (existing) {
    throw new Error(`Agent "${definition.id}" already exists (source: ${existing.source}). Use update instead.`);
  }

  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const { ...defWithoutSource } = definition;
  configAgents.push(defWithoutSource);
  await updateConfig({ agent: { ...config.agent, agents: configAgents } });

  const agent: AgentDefinition = { ...definition, source: 'config' };

  // Auto-create memory directory for stateful agents (best-effort)
  if (definition.stateful?.memory_project) {
    try { ensureProjectDir(definition.stateful.memory_project); } catch (err) {
      log.subagent.warn('failed to create memory dir for stateful agent', {
        agent: definition.id, project: definition.stateful.memory_project,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.subagent.info('agent created', { id: agent.id, name: agent.name });
  return agent;
}

/**
 * Update a config-defined agent. Persisted to config.yaml.
 * Builtin agents cannot be updated.
 */
export async function updateAgent(
  id: string,
  updates: Partial<Omit<AgentDefinition, 'id' | 'source'>>,
): Promise<AgentDefinition> {
  await validateModel(updates.model);

  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const configIdx = configAgents.findIndex((a) => a.id === id);
  if (configIdx !== -1) {
    const merged = { ...configAgents[configIdx], ...updates };
    configAgents[configIdx] = merged;
    await updateConfig({ agent: { ...config.agent, agents: configAgents } });

    // Auto-create memory directory if stateful config changed (best-effort)
    if (updates.stateful?.memory_project) {
      try { ensureProjectDir(updates.stateful.memory_project); } catch (err) {
        log.subagent.warn('failed to create memory dir for stateful agent', {
          agent: id, project: updates.stateful.memory_project,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.subagent.info('agent updated', { id });
    return { ...merged, id, source: 'config' } as AgentDefinition;
  }

  // Check builtin — auto-promote to config override
  const builtin = BUILTIN_AGENTS.find(b => b.id === id);
  if (builtin) {
    const { source: _source, ...builtinFields } = builtin;
    const overrideEntry = { ...builtinFields, ...updates };
    configAgents.push(overrideEntry);
    await updateConfig({ agent: { ...config.agent, agents: configAgents } });

    if (overrideEntry.stateful?.memory_project) {
      try { ensureProjectDir(overrideEntry.stateful.memory_project); } catch { /* best-effort */ }
    }

    log.subagent.info('builtin agent overridden', { id });
    return { ...overrideEntry, id, source: 'config', overrides_builtin: true } as AgentDefinition;
  }
  throw new Error(`Agent "${id}" not found.`);
}

/**
 * Delete a config-defined agent. Only config agents can be deleted.
 */
export async function deleteAgent(id: string): Promise<void> {
  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const idx = configAgents.findIndex((a) => a.id === id);
  if (idx !== -1) {
    configAgents.splice(idx, 1);
    await updateConfig({ agent: { ...config.agent, agents: configAgents } });
    log.subagent.info('agent deleted', { id });
    return;
  }

  const all = await getAllAgents();
  const other = all.find((a) => a.id === id);
  if (other) {
    throw new Error(`Agent "${id}" is ${other.source}-defined and cannot be deleted.`);
  }
  throw new Error(`Agent "${id}" not found.`);
}

/**
 * No-op kept for API compatibility with tests. Resets the config-manager
 * write lock to prevent cross-test lock chain stalls.
 */
export function _resetForTest(): void {
  _resetWriteLockForTest();
}
