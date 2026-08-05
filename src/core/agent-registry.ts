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

// NOTE: The BUILTIN_TURN_COMPLETE_TRIAGE subagent was DELETED (2026-07). The session
// itself now writes the merged task summary via side_question (it re-receives the
// existing task.summary each turn, so multi-day/post-compaction sessions stay
// complete), and phase/notify comes from a deterministic PHASE_SIGNAL lookup in
// session-hooks/builtins.ts (decideNotify). A 4-model eval showed summary quality is
// prompt-bound while the notify decision is exactly where models disagree — so no
// model is asked to decide anything here anymore. The id 'turn-complete-triage' is
// still used as the agentId on self-report notification events (see runTriage) so
// the server's notify_mode gate, UI rendering, and usage classification are
// unchanged. Do NOT re-introduce a summarizer subagent without re-reading the eval
// notes in the memory file usage_dashboard_and_summarizer_cost_overhaul.md.

// NOTE: There used to be a BUILTIN_MESSAGE_SEND_TRIAGE agent here that dispatched an Opus
// subagent on EVERY user message just to classify "did the user change direction?". It was
// almost always a no-op CONTINUE yet cost a full Opus round-trip per message — a large share
// of the runaway "subagent" spend — so it was removed. The onMessageSend hook now only
// cancels the pending turn-complete summary (a free clearTimeout); see
// session-hooks/builtins.ts → messageSendTriageHook. The id 'message-send-triage' is still
// recognised by TRIAGE_AGENTS / session-db-migration so historical persisted runs classify
// correctly, but no agent definition is dispatched for it anymore.

/** All built-in agents. */
const BUILTIN_AGENTS = [BUILTIN_GENERAL, BUILTIN_MENTOR, BUILTIN_NOTE];

/** Set of builtin agent IDs for quick lookup. */
const BUILTIN_ID_SET = new Set(BUILTIN_AGENTS.map(a => a.id));

/** Returns the set of builtin agent IDs. */
export function getBuiltinIds(): ReadonlySet<string> { return BUILTIN_ID_SET; }

/** The agentId used on turn-complete self-report notification events. No agent
 *  definition exists for it anymore (see the deletion NOTE above) — it survives
 *  only as an event/usage classifier. */
export const DEFAULT_TRIAGE_AGENT_ID = 'turn-complete-triage';

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
  // Pre-consolidation standalone file tools (renamed files_* in Apr 2026, then file_*).
  // Old configs skipped straight from these to today's names, so map them directly.
  read_file: 'file_read',
  write_file: 'file_write',
  edit_file: 'file_edit',
  // The monolithic `memory` tool was split in Mar 2026. Its read half is the
  // closest surviving equivalent; its write actions (update_summary/append) have
  // no successor for project stores — those persist via <memory_update> instead
  // (see stateful-memory.ts). Mapping to file_read keeps an allowed_tools
  // whitelist from silently collapsing to almost nothing.
  memory: 'file_read',
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
