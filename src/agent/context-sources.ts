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

async function loadProjectMemory(task: Task, budget: number): Promise<string> {
  const { getProjectMemory } = await import('../core/project-memory.js');
  const projectPath = `${task.category.toLowerCase()}/${task.project.toLowerCase()}`;
  const result = getProjectMemory(projectPath);
  if (!result) return '(no project memory yet)';
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

async function loadGlobalMemory(budget: number): Promise<string> {
  const { getMemoryFile } = await import('../core/memory-file.js');
  const result = getMemoryFile();
  if (!result) return '(no global memory yet)';
  return truncateToTokenBudget(result.content, budget);
}

async function loadDailyLog(budget: number): Promise<string> {
  const { getDailyLogsWithinBudget } = await import('../core/daily-log.js');
  const logs = getDailyLogsWithinBudget(budget);
  if (!logs) return '(no daily logs)';
  return logs; // getDailyLogsWithinBudget already handles budget
}

async function loadSessionHistory(sessionId: string, budget: number, cwd?: string, host?: string): Promise<string> {
  const { readSessionHistory } = await import('../core/session-history.js');
  const messages = await readSessionHistory(sessionId, cwd, host);
  if (messages.length === 0) return '(no session history)';

  // Assistant-only + [index] prefix + per-message truncation + tail truncation
  const MAX_PER_MSG = 500;
  const lines: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const toolInfo = m.tools?.length ? ` [${m.tools.map((t) => t.name).join(', ')}]` : '';
    const text = m.text.length > MAX_PER_MSG
      ? m.text.slice(0, MAX_PER_MSG) + `... [${m.text.length} chars]`
      : m.text;
    lines.push(`[${i}] Assistant${toolInfo}: ${text}`);
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

// ── XML tag names for each source ──

const SOURCE_XML_TAGS: Record<ContextSourceId, string> = {
  task_details: 'task_context',
  project_memory: 'project_memory',
  project_task_list: 'project_tasks',
  global_memory: 'global_memory',
  daily_log: 'daily_log',
  session_history: 'session_history',
  conversation_log: 'conversation_log',
};

// ── Main entry point ──

export interface ContextSourcesInput {
  taskId?: string;
  sessionId?: string;
  /** Session working directory — needed for session_history source. */
  cwd?: string;
  /** Remote host — needed for session_history source on remote sessions. */
  host?: string;
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

  // No taskId → no context sources to load
  if (!taskId) return '';

  // Resolve the task
  let task: Task;
  try {
    const { getTask } = await import('../core/task-manager.js');
    task = await getTask(taskId);
  } catch (err) {
    log.subagent.warn('context-sources: failed to resolve task', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    return '';
  }

  // Build the set of sources to load
  const enabledSources = new Map<ContextSourceId, number>();

  // Auto-inferred sources
  for (const sourceId of AUTO_SOURCES) {
    enabledSources.set(sourceId, DEFAULT_BUDGETS[sourceId]);
  }

  // Agent-configured sources
  if (agentDef.context_sources) {
    for (const src of agentDef.context_sources) {
      if (src.enabled) {
        enabledSources.set(src.id, src.token_budget ?? DEFAULT_BUDGETS[src.id]);
      }
    }
  }

  // Load all sources in parallel
  const loaders: Array<{ id: ContextSourceId; promise: Promise<string> }> = [];

  for (const [sourceId, budget] of enabledSources) {
    let promise: Promise<string>;

    switch (sourceId) {
      case 'task_details':
        promise = loadTaskDetails(task, budget);
        break;
      case 'project_memory':
        promise = loadProjectMemory(task, budget);
        break;
      case 'project_task_list':
        promise = loadProjectTaskList(task, budget);
        break;
      case 'global_memory':
        promise = loadGlobalMemory(budget);
        break;
      case 'daily_log':
        promise = loadDailyLog(budget);
        break;
      case 'session_history':
        if (!sessionId) {
          promise = Promise.resolve('(no session ID provided)');
        } else {
          promise = loadSessionHistory(sessionId, budget, cwd, host);
        }
        break;
      case 'conversation_log':
        promise = loadConversationLog(task, budget);
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
