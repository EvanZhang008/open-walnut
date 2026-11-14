/**
 * Agent Registry — manages agent definitions from 2 sources:
 *
 * 1. Built-in (hardcoded "general" agent)
 * 2. Config-defined (config.yaml → agent.agents[])
 *
 * Priority: config > builtin (later source wins on ID conflict).
 */

import { getConfig, updateConfig, _resetWriteLockForTest } from './config-manager.js';
import type { AgentDefinition } from './types.js';
import type { Disposable } from './plugins/disposable.js';
import { OwnedRegistry } from './plugins/owned-registry.js';
import { log } from '../logging/index.js';

// ── Built-in agents ──

const BUILTIN_GENERAL: AgentDefinition = {
  id: 'general',
  name: 'Walnut',
  description: 'Your main AI — tasks, sessions, memory, and everything else.',
  console: true,
  source: 'builtin',
};

const BUILTIN_MENTOR: AgentDefinition = {
  id: 'mentor',
  name: 'Mentor',
  description: 'Thoughtful companion for reflection, planning, journaling, and self-exploration.',
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
  context_sources: [
    { id: 'global_memory', enabled: true },
  ],
  source: 'builtin',
};

/**
 * Inbox Triage — the agent a triage run speaks as. Every run is a NEW task and a
 * NEW session (src/core/triage/), so this persona plus the notes it writes ARE
 * the continuity; there is no long-lived triage session to remember anything.
 *
 * Kept under 1200 characters so the lane prompt cap (personal-ai-lane.ts) is
 * never the binding constraint. The procedure itself lives in the
 * `walnut-inbox-triage` skill, which the session's injected index carries.
 */
const BUILTIN_TRIAGE: AgentDefinition = {
  id: 'triage',
  name: 'Inbox Triage',
  description: 'Works through each batch of new mail and Slack: hands items to the tasks that already own them, keeps the project tracking notes true, marks the noise read when allowed, and asks you, with the homework done, about anything that needs a decision.',
  console: true,
  system_prompt: `You are Inbox Triage. Once every batch of new mail and Slack you decide what each item means for work the user already has, and you keep the project tracking notes true. In order: read State.md and the batch; read what you need; match items to projects and tasks; update Tracking.md; hand an item to the task that already owns its work (task_send) so that task carries on; for anything that needs the user, do the homework first (read the thread, gather the related mail, tasks and notes, draft the reply) and then ask, in at most three decision letters, with one summary letter only when the run has something for the user; then rewrite State.md, append the run journal, and memory_write anything durable you learned. You never send mail, post to Slack or unsubscribe on your own: you ask (mail_request_send, slack_request_post, mail_unsubscribe_request). You mark mail read only when your run instructions allow it, and nothing you have deletes, archives or moves mail. You never invent a project or a task for something the user has not shown they care about.`,
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
const BUILTIN_AGENTS = [BUILTIN_GENERAL, BUILTIN_MENTOR, BUILTIN_NOTE, BUILTIN_TRIAGE];

/** Set of builtin agent IDs for quick lookup. */
const BUILTIN_ID_SET = new Set(BUILTIN_AGENTS.map(a => a.id));
const pluginAgents = new OwnedRegistry<AgentDefinition>();

export function registerOwnedAgent(
  owner: string,
  definition: Omit<AgentDefinition, 'source' | 'overrides_builtin'>,
): Disposable {
  if (BUILTIN_ID_SET.has(definition.id)) {
    throw new Error(`Plugin agent "${definition.id}" cannot replace a builtin agent`);
  }
  const agent: AgentDefinition = { ...liveAgentFields(definition), source: 'plugin' };
  return pluginAgents.register(owner, agent.id, agent);
}

export function removeOwnedAgents(owner: string): number {
  return pluginAgents.removeOwner(owner);
}

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
  // General is always a console agent even if a config override drops the flag
  // (same compat rule as getConsoleAgent) — a stray `agents: [{id: general}]`
  // entry must never make the main agent vanish from the chat pickers.
  return all.filter((a) => a.console || a.id === 'general');
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

// ── Live fields ──

/**
 * The agent fields something reads: the persona builder (system_prompt, name),
 * the context loader (context_sources, id), the chat pickers (console,
 * description). Every run is a Claude Code session, so the fields of the removed
 * in-process loop (runner, model, provider, region, max_tokens, max_tool_rounds,
 * allowed_tools, denied_tools, working_directory, skills, stateful) are read by
 * nothing. A stored definition or a request that still carries them loads and
 * saves fine: they are left out here, never refused.
 */
const LIVE_AGENT_FIELDS = ['id', 'name', 'description', 'system_prompt', 'context_sources', 'console'] as const;

type LiveAgentFields = Pick<AgentDefinition, (typeof LIVE_AGENT_FIELDS)[number]>;

/** `raw` with only the live agent fields (an absent field stays absent). */
export function liveAgentFields<T extends Partial<LiveAgentFields>>(raw: T): T {
  const out: Record<string, unknown> = {};
  const src = raw as Record<string, unknown>;
  for (const key of LIVE_AGENT_FIELDS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out as T;
}

/**
 * Get all agent definitions, merged by priority (config > plugin > builtin).
 */
export async function getAllAgents(): Promise<AgentDefinition[]> {
  const config = await getConfig();
  const configAgents: AgentDefinition[] = (config.agent?.agents ?? []).map((a) => ({
    ...liveAgentFields(a),
    source: 'config' as const,
  }));

  // Merge by ID: builtin first, then Plugin, then user config overrides.
  const merged = new Map<string, AgentDefinition>();
  for (const b of BUILTIN_AGENTS) merged.set(b.id, b);
  for (const agent of pluginAgents.values()) merged.set(agent.id, agent);
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
 * Create a config agent. Persisted to config.yaml.
 */
export async function createAgent(
  input: Omit<AgentDefinition, 'source'>,
): Promise<AgentDefinition> {
  const definition = liveAgentFields(input);
  // Check for ID collision with builtin or existing config agents
  const all = await getAllAgents();
  const existing = all.find((a) => a.id === definition.id);
  if (existing) {
    throw new Error(`Agent "${definition.id}" already exists (source: ${existing.source}). Use update instead.`);
  }

  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  configAgents.push(definition);
  await updateConfig({ agent: { ...config.agent, agents: configAgents } });

  const agent: AgentDefinition = { ...definition, source: 'config' };
  log.subagent.info('agent created', { id: agent.id, name: agent.name });
  return agent;
}

/**
 * Update a config-defined agent. Persisted to config.yaml.
 * Builtin agents cannot be updated.
 */
export async function updateAgent(
  id: string,
  input: Partial<Omit<AgentDefinition, 'id' | 'source'>>,
): Promise<AgentDefinition> {
  const { id: _id, ...updates } = liveAgentFields(input as Partial<AgentDefinition>);

  const config = await getConfig();
  const configAgents = config.agent?.agents ?? [];
  const configIdx = configAgents.findIndex((a) => a.id === id);
  if (configIdx !== -1) {
    // Over the stored entry, so a retired field the user's config.yaml still
    // holds stays in the file as they left it (read by nothing either way).
    const merged = { ...configAgents[configIdx], ...updates };
    configAgents[configIdx] = merged;
    await updateConfig({ agent: { ...config.agent, agents: configAgents } });

    log.subagent.info('agent updated', { id });
    return { ...liveAgentFields(merged), id, source: 'config' } as AgentDefinition;
  }

  if (pluginAgents.has(id)) {
    throw new Error(`Agent "${id}" is plugin-defined and cannot be updated through config.`);
  }

  // Check builtin — auto-promote to config override
  const builtin = BUILTIN_AGENTS.find(b => b.id === id);
  if (builtin) {
    const { source: _source, ...builtinFields } = builtin;
    const overrideEntry = { ...builtinFields, ...updates };
    configAgents.push(overrideEntry);
    await updateConfig({ agent: { ...config.agent, agents: configAgents } });

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
  pluginAgents.clear();
  _resetWriteLockForTest();
}
