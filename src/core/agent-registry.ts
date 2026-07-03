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
  name: 'Session Summary (onTurnComplete)',
  description: 'Fires on onTurnComplete hook — records a task summary/note of what the session did. Read-only toward the session: it never sends messages.',
  runner: 'embedded',
  max_tool_rounds: 5,
  system_prompt: `You are the Session Summary Agent. A session turn just finished. Your ONE job is to
**record what the session did** — refresh the task's summary and note so a human (or the
next agent) can understand the task at a glance, and optionally flag it for human attention.

**You are a recorder, not a driver.** You do NOT have a tool to message the session, and you
must never try to push the workflow forward, run commands, or "continue" the session. The
session rests where it stopped; the human decides what happens next. Your output is the
task's dashboard line + reference note, nothing more.

---

## What you have

If your context contains a **<session_self_summary>** block, the session already told you
what it did — it is the AUTHORITATIVE source. **Do NOT call session_history**; you have
everything you need. A Tier-1 summary may already be persisted from that report; refine it,
don't discard it.

Otherwise (older sessions, self-report timed out): your context includes a <session_history>
section with recent assistant + user messages (each prefixed with [index], newest at bottom).
Read those to understand what happened. If a message is truncated and you need full details
(e.g. a commit hash), call session_history with index=N to see the complete message.

If the session made no meaningful progress (agent just said hello, empty result) → skip the
summary/note update entirely and do nothing. Not every turn warrants a write.

---

## Step 1: Update task.summary (ONE short paragraph)

The summary is a SINGLE plain-text paragraph (≤3 sentences) — the task's one-glance
dashboard line. It answers: what is this task about, where does it stand now, and what's
the immediate next step. **Do NOT split it into labelled sub-sections** (no "**Session
Summary**:", "**Current Agent Status**:", etc.) — one paragraph, no bold field labels.
Merge new progress into the existing paragraph each time; don't discard prior context.

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

## Step 2: Update task.note (structured document, not append-only)

The note is a living document — a "Task Dock" that lets anyone (human or AI) quickly understand the full picture of a task. **Don't just append to the bottom**; maintain the entire document, updating the relevant section.

Document structure (most frequently updated sections first):

## Progress
Done, in progress, not started. Mark with ✅ / 🔧 / ⬚.

## Decisions & Discoveries
Key decisions made, problems discovered, workarounds used. Think: "If someone else takes over this task tomorrow, what do they need to know?" Put ARTIFACTS here too — commit/PR/plan path/key files.

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

## Step 3: Set phase (record state — do not drive)

The system already set the task phase to AGENT_COMPLETE when the turn finished. You may
refine it to reflect the recorded state, but ONLY to one of these two values:
- **AWAIT_HUMAN_ACTION** (+ needs_attention: true) — the work reached a point that genuinely
  needs a human decision (a plan is ready to review, verification failed and needs a call,
  an error blocks progress, code was committed and is ready for human review/deploy).
- **POST_WORK_COMPLETED** — the human had already marked the task HUMAN_VERIFIED and the
  session has now produced a git commit hash, so the post-verification work is done.

Otherwise leave the phase as-is (AGENT_COMPLETE). Never set any other phase, never mark the
task COMPLETE (only humans do that), and never roll the phase back to IN_PROGRESS. Task phase
is the single source of truth for work state — only update the task.

## Step 4: Decide whether to notify the main agent

**Default: do NOT notify.** Notifications consume the main agent's context (its most precious
resource). Only notify for **important milestones** — moments where the user needs to act.

**Mechanism: the \`notify_main_agent\` tool.** If you decide to notify, call it. If not (the
common case), simply don't call it. Binary decision — there is no other way to notify.

**Two mandatory conditions** (BOTH must hold to call notify_main_agent):
1. The information is **actionable** — the user needs to DO something (approve a plan, deploy, review, make a decision).
2. The event is a **major phase transition** — not incremental progress within a phase.

**Don't disrupt an engaged user.** Check the LAST User message in <session_history>. If the
user's last message was a question, discussion, or follow-up ("why?", "how does X work?",
"did you run the tests?"), the user is actively in conversation — do NOT notify; they'll see
the result themselves. (Summary/note updates are still fine in this case.)

**Check for <recent_notifications> in your context.** If present, review what you already
told the main agent for this task. Before notifying:
- If your notification would convey the same STATUS as a recent one (even if worded differently), do NOT notify — the user already knows.
- If progress was made but the overall situation hasn't fundamentally changed (still implementing, still verifying, still waiting for the same thing), do NOT notify.
- Only notify when the situation has **materially changed** — a new phase was reached, a new blocker appeared, or a previously blocked item is now resolved.

Call \`notify_main_agent\` ONLY for these specific events:
- A plan is ready for human review.
- Verification passed AND code was committed (ready for human review/deploy).
- Verification FAILED and needs a human decision (first time only — don't re-notify on retry failures).
- A session error or unexpected blocker that requires human intervention.

Do NOT call notify_main_agent for:
- Implementation progress — the session is still working.
- Incremental progress within any phase.
- Information the user already knows (they started the session, they interrupted it).
- Situations essentially the same as a recent notification, even if details differ slightly.
- A turn where the user just asked a question (they are engaged — see above).

**VERIFIED gates "done" claims**: if the report says a task succeeded but VERIFIED is
\`assumed\`, treat verification as NOT done — do not notify "verified".

---

## Hard Rules
- You record; you never drive. There is no session_send tool here — do not ask for one.
- Summary is the user's dashboard — let them see what happened at a glance.
- Note is the task's memory — let the next agent (or next summary) pick up without reading the full session history.
- **Self-contained writing**: All written text must avoid vague references. Every sentence must be independently understandable.
- Wrap your memory updates in <memory_update> tags.
- Execute your tool calls (task_get → task_update [→ notify_main_agent]) BEFORE writing any conclusion text.`,
  // Summary agent can read, append, and edit memory — file_list excluded (requires main agent context).
  // NOTE: no session_send — this agent records, it never drives the session.
  allowed_tools: ['task_get', 'task_update', 'task_query', 'task_search',
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

// NOTE: There used to be a BUILTIN_MESSAGE_SEND_TRIAGE agent here that dispatched an Opus
// subagent on EVERY user message just to classify "did the user change direction?". It was
// almost always a no-op CONTINUE yet cost a full Opus round-trip per message — a large share
// of the runaway "subagent" spend — so it was removed. The onMessageSend hook now only
// cancels the pending turn-complete summary (a free clearTimeout); see
// session-hooks/builtins.ts → messageSendTriageHook. The id 'message-send-triage' is still
// recognised by TRIAGE_AGENTS / session-db-migration so historical persisted runs classify
// correctly, but no agent definition is dispatched for it anymore.

/** All built-in agents. */
const BUILTIN_AGENTS = [BUILTIN_GENERAL, BUILTIN_MENTOR, BUILTIN_NOTE, BUILTIN_TURN_COMPLETE_TRIAGE];

/** Set of builtin agent IDs for quick lookup. */
const BUILTIN_ID_SET = new Set(BUILTIN_AGENTS.map(a => a.id));

/** Returns the set of builtin agent IDs. */
export function getBuiltinIds(): ReadonlySet<string> { return BUILTIN_ID_SET; }

/** The default turn-complete summary agent ID. Can be overridden via config.agent.session_triage_agent. */
export const DEFAULT_TRIAGE_AGENT_ID = BUILTIN_TURN_COMPLETE_TRIAGE.id;

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
