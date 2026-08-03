/**
 * Agent Context Sources — loads and injects contextual data into subagent prompts.
 *
 * When a subagent is invoked with a taskId, this module loads relevant context
 * (task details, project memory, task list, etc.) and returns it as an XML-tagged
 * string for injection into the system prompt.
 *
 * Two sources are auto-inferred when taskId is present:
 *   - task_details (always)
 *   - project_memory (always)
 *
 * Additional sources can be toggled via the agent definition's context_sources field.
 */

import type { AgentDefinition, ContextSourceId, Task } from '../core/types.js';
import { estimateTokens } from '../core/daily-log.js';
import { truncateToTokenBudget, truncateToTokenBudgetTail } from '../utils/token-truncate.js';
import { log } from '../logging/index.js';

// ── Default token budgets per source ──

const DEFAULT_BUDGETS: Record<ContextSourceId, number> = {
  task_details: 1500,
  project_memory: 2000,
  project_task_list: 1500,
  global_memory: 2000,
  daily_log: 3000,
  session_history: 4000,
  conversation_log: 1000,
  main_global_memory: 2000,
  main_daily_log: 3000,
  journal_recent: 4000,
  working_memory: 4000,
};

// Auto-inferred sources — always loaded when taskId is present
const AUTO_SOURCES: ContextSourceId[] = ['task_details', 'project_memory'];

// ── Individual loaders ──

function formatTaskDetails(task: Task): string {
  const lines = [
    `ID: ${task.id}`,
    `Title: ${task.title}`,
    `Phase: ${task.phase}`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    `Category: ${task.category}`,
    `Project: ${task.project}`,
  ];

  if (task.starred) lines.push('Starred: yes');
  if (task.needs_attention) lines.push('Needs Attention: yes');
  if (task.parent_task_id) lines.push(`Parent Task: ${task.parent_task_id}`);
  if (task.start_date) lines.push(`Start: ${task.start_date}`);
  if (task.due_date) lines.push(`Due: ${task.due_date}`);

  if (task.description) {
    lines.push('', '### Description', task.description);
  }
  if (task.summary) {
    lines.push('', '### Summary', task.summary);
  }
  if (task.note) {
    lines.push('', '### Notes', task.note);
  }
  // Subtasks removed (now child tasks in the plugin system)

  return lines.join('\n');
}

async function loadTaskDetails(task: Task, budget: number): Promise<string> {
  const content = formatTaskDetails(task);
  return truncateToTokenBudget(content, budget);
}

/**
 * Legacy project store (memory/projects/<cat>/<proj>/MEMORY.md). The 2026-07
 * skills migration superseded it but left the existing files in place, so this
 * still returns real content for pre-migration projects and nothing for newer
 * ones. Kept read-only; new project knowledge belongs in a skill.
 */
async function loadProjectMemory(task: Task, budget: number): Promise<string> {
  const { getProjectMemory } = await import('../core/project-memory.js');
  const projectPath = `${task.category.toLowerCase()}/${task.project.toLowerCase()}`;
  const result = getProjectMemory(projectPath);
  if (!result) return '(no legacy project memory for this project)';
  return truncateToTokenBudget(result.content, budget);
}

async function loadProjectTaskList(task: Task, budget: number): Promise<string> {
  const { listTasks } = await import('../core/task-manager.js');
  const tasks = await listTasks({ category: task.category });
  const projectTasks = tasks.filter(
    (t) => t.project === task.project && t.status !== 'done' && t.id !== task.id,
  );

  if (projectTasks.length === 0) return '(no other active tasks in this project)';

  const lines = projectTasks.map(
    (t) => `- [${t.phase}] ${t.title} (${t.id}) — ${t.priority}`,
  );
  return truncateToTokenBudget(lines.join('\n'), budget);
}

async function loadGlobalMemory(budget: number, agentId?: string): Promise<string> {
  const { getMemoryFile } = await import('../core/memory-file.js');
  const result = getMemoryFile(agentId);
  if (!result) return '(no global memory yet)';
  return truncateToTokenBudget(result.content, budget);
}

async function loadDailyLog(budget: number, agentId?: string): Promise<string> {
  const { getDailyLogsWithinBudget } = await import('../core/daily-log.js');
  const logs = getDailyLogsWithinBudget(budget, agentId);
  if (!logs) return '(no daily logs)';
  return logs; // getDailyLogsWithinBudget already handles budget
}

async function loadSessionHistory(sessionId: string, budget: number, cwd?: string, host?: string): Promise<string> {
  const { readSessionHistory } = await import('../core/session-history.js');
  const messages = await readSessionHistory(sessionId, cwd, host);
  if (messages.length === 0) return '(no session history)';

  // User + Assistant messages with [index] prefix + per-message truncation + tail truncation
  const MAX_ASSISTANT_MSG = 500;
  const MAX_USER_MSG = 300; // User messages are shorter; crucial for detecting active conversation
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'assistant') {
      const toolInfo = m.tools?.length ? ` [${m.tools.map((t) => t.name).join(', ')}]` : '';
      const text = m.text.length > MAX_ASSISTANT_MSG
        ? m.text.slice(0, MAX_ASSISTANT_MSG) + `... [${m.text.length} chars]`
        : m.text;
      lines.push(`[${i}] Assistant${toolInfo}: ${text}`);
    } else if (m.role === 'user') {
      const text = m.text.length > MAX_USER_MSG
        ? m.text.slice(0, MAX_USER_MSG) + `... [${m.text.length} chars]`
        : m.text;
      lines.push(`[${i}] User: ${text}`);
    }
  }

  return truncateToTokenBudgetTail(lines.join('\n'), budget);
}

async function loadConversationLog(task: Task, budget: number): Promise<string> {
  if (!task.conversation_log) return '(no conversation log)';
  // Tail-truncate: keep the most recent entries
  const log = task.conversation_log;
  const tokens = estimateTokens(log);
  if (tokens <= budget) return log;

  // Tail-truncate by keeping the end of the log
  const charBudget = Math.floor(budget * 3.5);
  const truncated = log.slice(-charBudget);
  const firstNewline = truncated.indexOf('\n');
  const clean = firstNewline > 0 ? truncated.slice(firstNewline + 1) : truncated;
  return '[...earlier entries omitted]\n\n' + clean;
}

/** Load recent diary entries from the Obsidian vault (for Mentor). */
async function loadJournalRecent(budget: number): Promise<string> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { NOTES_DIR } = await import('../constants.js');

  // "Dairy" is the actual folder name in the user's Obsidian vault (not a typo for "Diary").
  // Vault went topic-first 2026-08 (PARA retired): journal/ is now top-level.
  const diaryDir = path.join(NOTES_DIR, 'journal', 'Dairy');
  let files: string[];
  try {
    files = fs.readdirSync(diaryDir)
      .filter((f: string) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 7);
  } catch {
    return '(no diary entries found)';
  }
  if (files.length === 0) return '(no diary entries found)';

  const entries: string[] = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(diaryDir, file), 'utf-8');
      entries.push(`--- ${file.replace('.md', '')} ---\n${content.trim()}`);
    } catch { /* skip unreadable */ }
  }
  if (entries.length === 0) return '(no diary entries found)';
  return truncateToTokenBudgetTail(entries.join('\n\n'), budget);
}

// ── XML tag names for each source ──

/**
 * Load current working memory (real-time scratchpad) for injection into a subagent.
 * A subagent sees the General agent's MAIN conversation scratchpad — the butler's
 * current working state. Resolving main explicitly keeps this working after the
 * global single-file working memory is migrated to per-conversation files.
 */
async function loadWorkingMemory(budget: number): Promise<string> {
  const { getWorkingMemory, isWorkingMemoryEmpty } = await import('../core/working-memory.js');
  let content: string | null = null;
  try {
    const { getMainConversationId } = await import('../core/conversations.js');
    const mainConvId = await getMainConversationId('general');
    content = getWorkingMemory('general', mainConvId);
  } catch {
    // Fall back to the legacy global file if conversation resolution isn't available.
    content = getWorkingMemory();
  }
  if (!content || isWorkingMemoryEmpty(content)) return '(no working memory yet)';
  return truncateToTokenBudget(content, budget);
}

/** Load General agent's global memory (read-only, for non-General console agents). */
async function loadMainGlobalMemory(budget: number): Promise<string> {
  const { getMemoryFile } = await import('../core/memory-file.js');
  // Explicitly pass undefined (= General) to always read General's memory
  const result = getMemoryFile(undefined);
  if (!result) return '(no main global memory yet)';
  return truncateToTokenBudget(result.content, budget);
}

/** Load General agent's daily logs (read-only, for non-General console agents). */
async function loadMainDailyLog(budget: number): Promise<string> {
  const { getDailyLogsWithinBudget } = await import('../core/daily-log.js');
  // Explicitly pass undefined (= General) to always read General's daily logs
  const logs = getDailyLogsWithinBudget(budget, undefined);
  if (!logs) return '(no main daily logs)';
  return logs;
}

const SOURCE_XML_TAGS: Record<ContextSourceId, string> = {
  task_details: 'task_context',
  project_memory: 'project_memory',
  project_task_list: 'project_tasks',
  global_memory: 'global_memory',
  daily_log: 'daily_log',
  session_history: 'session_history',
  conversation_log: 'conversation_log',
  main_global_memory: 'main_global_memory',
  main_daily_log: 'main_daily_log',
  journal_recent: 'recent_journal',
  working_memory: 'working_memory',
};

// ── Main entry point ──

export interface ContextSourcesInput {
  taskId?: string;
  sessionId?: string;
  /** Session working directory — needed for session_history source. */
  cwd?: string;
  /** Remote host — needed for session_history source on remote sessions. */
  host?: string;
  /** Source ids to skip loading even if the agent definition enables them.
   *  Used e.g. by turn-complete triage: when the session already provided a
   *  side_question self-report, suppress `session_history` so we don't pay the
   *  4000-token history read the report replaces. */
  suppressSources?: ContextSourceId[];
}

/**
 * Load context sources for a subagent based on its definition and invocation params.
 *
 * Auto-infers task_details and project_memory when taskId is present.
 * Additional sources are loaded based on the agent's context_sources config.
 *
 * Returns concatenated XML-tagged sections ready for system prompt injection.
 */
export async function loadContextSources(
  agentDef: AgentDefinition,
  input: ContextSourcesInput,
): Promise<string> {
  const { taskId, sessionId, cwd, host } = input;
  const suppress = new Set(input.suppressSources ?? []);

  // Console agents may have context_sources without a taskId (e.g. global_memory, daily_log).
  // Only skip if there's no taskId AND no agent-level context sources configured.
  const hasAgentSources = agentDef.context_sources && agentDef.context_sources.length > 0;
  if (!taskId && !hasAgentSources) return '';

  // Resolve the task (if taskId provided)
  let task: Task | null = null;
  if (taskId) {
    try {
      const { getTask } = await import('../core/task-manager.js');
      task = await getTask(taskId);
    } catch (err) {
      log.subagent.warn('context-sources: failed to resolve task', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Build the set of sources to load
  const enabledSources = new Map<ContextSourceId, number>();

  // Auto-inferred sources (only when task is available)
  if (task) {
    for (const sourceId of AUTO_SOURCES) {
      enabledSources.set(sourceId, DEFAULT_BUDGETS[sourceId]);
    }
  }

  // Agent-configured sources
  if (agentDef.context_sources) {
    for (const src of agentDef.context_sources) {
      if (src.enabled) {
        enabledSources.set(src.id, src.token_budget ?? DEFAULT_BUDGETS[src.id]);
      }
    }
  }

  // Caller-requested suppressions (e.g. triage with a self-report skips
  // session_history). Applied last so it wins over both auto + agent config.
  for (const id of suppress) enabledSources.delete(id);

  // Load all sources in parallel
  const loaders: Array<{ id: ContextSourceId; promise: Promise<string> }> = [];

  for (const [sourceId, budget] of enabledSources) {
    let promise: Promise<string>;

    switch (sourceId) {
      case 'task_details':
        if (!task) continue;
        promise = loadTaskDetails(task, budget);
        break;
      case 'project_memory':
        if (!task) continue;
        promise = loadProjectMemory(task, budget);
        break;
      case 'project_task_list':
        if (!task) continue;
        promise = loadProjectTaskList(task, budget);
        break;
      case 'global_memory':
        promise = loadGlobalMemory(budget, agentDef.id);
        break;
      case 'daily_log':
        promise = loadDailyLog(budget, agentDef.id);
        break;
      case 'session_history':
        if (!sessionId) {
          promise = Promise.resolve('(no session ID provided)');
        } else {
          promise = loadSessionHistory(sessionId, budget, cwd, host);
        }
        break;
      case 'conversation_log':
        if (!task) continue;
        promise = loadConversationLog(task, budget);
        break;
      case 'main_global_memory':
        promise = loadMainGlobalMemory(budget);
        break;
      case 'main_daily_log':
        promise = loadMainDailyLog(budget);
        break;
      case 'journal_recent':
        promise = loadJournalRecent(budget);
        break;
      case 'working_memory':
        promise = loadWorkingMemory(budget);
        break;
      default:
        continue;
    }

    loaders.push({ id: sourceId, promise });
  }

  // Resilient: individual failures don't block others
  const results = await Promise.allSettled(loaders.map((l) => l.promise));

  const sections: string[] = [];
  for (let i = 0; i < loaders.length; i++) {
    const { id } = loaders[i];
    const result = results[i];
    const tag = SOURCE_XML_TAGS[id];

    if (result.status === 'fulfilled' && result.value) {
      sections.push(`<${tag}>\n${result.value}\n</${tag}>`);
    } else if (result.status === 'rejected') {
      log.subagent.warn('context-sources: loader failed', {
        source: id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
      sections.push(`<${tag}>\n(failed to load)\n</${tag}>`);
    }
  }

  if (sections.length > 0) {
    log.subagent.info('context sources resolved', {
      taskId,
      loadedSources: loaders.filter((_, i) => results[i].status === 'fulfilled').map(l => l.id),
      totalTokens: sections.reduce((sum, s) => sum + estimateTokens(s), 0),
    });
  }

  return sections.join('\n\n');
}
