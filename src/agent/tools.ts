/**
 * Agent tool definitions.
 * Each tool wraps existing core modules and exposes them to the LLM.
 */
import {
  addTask,
  listTasks,
  deleteTask,
  mergeTaskInto,
  ActiveSessionError,
  ProjectSourceConflictError,
  CircularDependencyError,
  isTaskBlocked,
  queryTasks,
  updateTask,
  addNote,
  updateNote,
  updateDescription,
  updateSummary,
  appendConversationLog,
  getTask,
  getProjectMetadata,
  setProjectMetadata,
  renameProject,
  ensureProject,
  getStoreProjects,
  getProjectRecord,
  togglePin,
  setFocusTier,
  getCustomTiers,
  getPinnedTasks,
  groupTasks,
  addToGroup,
  removeFromGroup,
  renameGroup,
  listGroups,
} from '../core/task-manager.js';
import { AGENT_WRITABLE_PHASES, isAgentWritablePhase } from '../core/phase.js';
import {
  LEGACY_STATUS_TO_COMPLETION,
  MAX_QUERY_LIMIT,
  TaskQueryError,
  computeBlockedIds,
  type TaskQuery,
  type TaskQueryTime,
} from '../core/task-query.js';
import {
  bm25ScoreTasks,
  expandChildTasks,
  searchTaskAndSessionReferences,
} from '../core/search.js';
import {
  listSessions,
  getSessionSummaries,
  getSessionsForTask,
  getSessionByClaudeId,
  updateSessionRecord,
  emitSessionStatusChanged,
  importSessionRecord,
  checkSessionLimit,
  TRIAGE_AGENTS,
  isTriageSession,
  isEnvironmentSession,
} from '../core/session-tracker.js';
import type { SessionLimitResult } from '../core/session-tracker.js';
import { bus, EventNames } from '../core/event-bus.js';
import { getConfig, updateConfig } from '../core/config-manager.js';
import { SESSION_MODES, SESSION_MODE_IDS } from '../core/types.js';
import type { Config, SessionRecord, Task, TaskPhase, TaskPriority, TaskSource } from '../core/types.js';
import { getOp, opInputJsonSchema } from '../ops/index.js';
import path from 'node:path';
import { log } from '../logging/index.js';
import { CLAUDE_HOME } from '../constants.js';
// standalone read_file, edit_file, write_file removed — unified into file_* tools
import { execTool } from './tools/exec-tool.js';
import { slackTool } from './tools/slack-tool.js';
import { ttsTool } from './tools/tts-tool.js';
import { calendarTools } from './tools/calendar-tools.js';

import { webFetchTool } from './tools/web-fetch-tool.js';
import { webSearchTool } from './tools/web-search-tool.js';

import { agentCrudTools } from './tools/agent-crud-tools.js';
import { commandCrudTools } from './tools/command-tools.js';
import { heartbeatTools } from './tools/heartbeat-tools.js';
import { askQuestionTool } from './tools/ask-question-tool.js';
import { createSubagentTool } from './tools/create-subagent.js';
import { filesTools } from './tools/files-tools.js';
import { memoryNotesSearchTool } from './tools/memory-notes-search-tool.js';
import { memoryManageTool } from './tools/memory-manage-tool.js';
import { historySearchTool } from './tools/history-search-tool.js';
import { skillManageTool } from './tools/skill-manage-tool.js';
import { skillViewTool } from './tools/skill-view-tool.js';



/** Escape double-quotes in a string for use inside an XML attribute value. */
function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/**
 * Permission-mode enum + description for the Personal AI's session tool schemas,
 * derived from the SESSION_MODES registry (src/core/types.ts) so a new mode
 * reaches the Personal AI automatically. These schemas used to hardcode subsets
 * (['plan','bypass'] and ['bypass','accept','plan']), which made modes the UI
 * offered un-requestable by the agent.
 */
const SESSION_MODE_ENUM: string[] = [...SESSION_MODE_IDS];
const SESSION_MODE_DESC =
  'Session permission mode (CLI only). ' +
  SESSION_MODES.map((m) => `'${m.id}' = ${m.description.toLowerCase()}`).join('; ') + '.';

/** Build a `<session-ref>` XML tag. */
function sessionRef(id: string, label: string): string {
  return `<session-ref id="${escAttr(id)}" label="${escAttr(label)}"/>`;
}

/** Build a `<task-ref>` XML tag. */
function taskRef(id: string, label: string): string {
  return `<task-ref id="${escAttr(id)}" label="${escAttr(label)}"/>`;
}

/**
 * Fire-and-forget: refine a freshly-created group's name from its members' titles
 * via a cheap LLM call. Best-effort — failures leave the placeholder label.
 */
async function refineGroupLabel(groupId: string, memberIds: string[]): Promise<void> {
  try {
    const titles: string[] = [];
    for (const id of memberIds) {
      try { titles.push((await getTask(id)).title); } catch { /* skip */ }
    }
    if (titles.length === 0) return;
    const { summarizeGroupLabel } = await import('../core/fork-title.js');
    const label = await summarizeGroupLabel(titles);
    if (!label) return;
    const result = await renameGroup(groupId, label);
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'agent' });
  } catch (err) {
    log.agent?.warn?.('refineGroupLabel failed', { groupId, error: err instanceof Error ? err.message : String(err) });
  }
}

// readPlanFromSession and buildPlanExecutionMessage removed — plan execution now handled by UI buttons via REST endpoints

/** Structured content blocks returned by tools (matches Anthropic API's ToolResultBlockParam.content). */
export type ToolTextBlock = { type: 'text'; text: string };
export type ToolImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ToolContentBlock = ToolTextBlock | ToolImageBlock;

/** Content returned by a tool: plain string or structured content blocks (text + image). */
export type ToolResultContent = string | ToolContentBlock[];

/** Metadata passed to tool execute functions (e.g. toolUseId for correlation). */
export interface ToolExecuteMeta {
  toolUseId?: string;
  /** runAgentLoop `source` of the turn that called this tool (e.g. 'chat',
   *  'background-review'). Used for write provenance — a memory entry written by
   *  the unattended review fork carries weaker evidence than one written while
   *  the user was present. */
  source?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (params: Record<string, unknown>, meta?: ToolExecuteMeta) => Promise<ToolResultContent>;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function delegateAgentTool(): ToolDefinition {
  const op = getOp('delegate');
  if (!op) throw new Error('Missing registry op: delegate');
  return {
    name: op.name,
    description: op.description,
    input_schema: opInputJsonSchema(op),
    async execute(params, meta) {
      try {
        const { delegateWork } = await import('../core/delegate-work.js');
        return json(await delegateWork(params as never, meta?.source ?? 'agent'));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

/** Where a resolved host/cwd value came from — used to arbitrate conflicts (more specific wins). */
type HostSource = 'param' | 'project' | 'none';
type CwdSource = 'param' | 'task' | 'project' | 'memory' | 'none';

/** Explicit "run locally" sentinels for the host param — block project default_host inheritance. */
function isLocalHostSentinel(host: string | null | undefined): boolean {
  if (host === null) return true;
  if (typeof host !== 'string') return false;
  return ['', 'local', '__local__', 'none', 'null'].includes(host.trim().toLowerCase());
}

/**
 * Resolve host and working directory for a session via the 5-priority inheritance chain.
 * Shared by session_start and session_import.
 *
 * Resolution chain:
 *   CWD:  ① explicit param → ② task.cwd → ③ parent chain walk → ④ project metadata (default_cwd) → ⑤ project memory dir
 *   Host: ① explicit param (empty string / "local" / null = force local, no inheritance) → ② project metadata (default_host)
 */
async function resolveSessionContext(
  task: Task | null,
  explicitHost?: string | null,
  explicitCwd?: string,
): Promise<{
  resolvedHost: string | undefined;
  resolvedCwd: string | undefined;
  hostSource: HostSource;
  cwdSource: CwdSource;
}> {
  // host was explicitly set to a local sentinel → never inherit project default_host
  const forceLocal = explicitHost !== undefined && isLocalHostSentinel(explicitHost);
  let resolvedHost = forceLocal ? undefined : (explicitHost ?? undefined);
  let hostSource: HostSource = resolvedHost ? 'param' : 'none';
  let resolvedCwd = explicitCwd;
  let cwdSource: CwdSource = resolvedCwd ? 'param' : 'none';

  // Priority 2 & 3: task cwd → walk up parent chain
  if (!resolvedCwd && task) {
    let current: Task | undefined = task;
    const seen = new Set<string>();  // cycle guard
    while (current && !resolvedCwd) {
      if (current.cwd) {
        resolvedCwd = current.cwd;
        cwdSource = 'task';
        break;
      }
      if (!current.parent_task_id || seen.has(current.parent_task_id)) break;
      seen.add(current.id);
      current = await getTask(current.parent_task_id).catch(() => undefined);
    }
  }

  // Priority 4: project metadata
  if (task && ((!resolvedHost && !forceLocal) || !resolvedCwd)) {
    const metadata = await getProjectMetadata(task.project || '');
    if (metadata) {
      if (!resolvedHost && !forceLocal && metadata.default_host) {
        resolvedHost = metadata.default_host as string;
        hostSource = 'project';
      }
      if (!resolvedCwd && metadata.default_cwd) {
        resolvedCwd = metadata.default_cwd as string;
        cwdSource = 'project';
      }
    }
  }

  // Priority 5: project memory directory as last-resort fallback
  // Better than home dir — at least scoped to the project context
  if (!resolvedCwd && task) {
    const { PROJECTS_MEMORY_DIR } = await import('../constants.js');
    const { default: path } = await import('node:path');
    const { default: fs } = await import('node:fs');
    const projectDir = path.join(PROJECTS_MEMORY_DIR, (task.project || 'inbox').toLowerCase());
    fs.mkdirSync(projectDir, { recursive: true });
    resolvedCwd = projectDir;
    cwdSource = 'memory';
  }

  return { resolvedHost, resolvedCwd, hostSource, cwdSource };
}

/** Build a blocked response for session concurrency limit. */
function buildSessionLimitBlocked(host: string | undefined, limitResult: SessionLimitResult): string {
  const result: Record<string, unknown> = {
    blocked: true,
    reason: `Active session limit reached for ${host || 'local'}: ${limitResult.running}/${limitResult.limit} in_progress.`,
    host: host || 'local',
    active: limitResult.running,
    limit: limitResult.limit,
    active_sessions: limitResult.runningSessions.map((s) => ({
      session_id: s.claudeSessionId,
      task_id: s.taskId,
      title: s.title,
      process_status: s.process_status,
      started_at: s.startedAt,
    })),
    hint: 'Wait for an active session to finish, use session_send to reuse an existing session, or increase the limit in config.yaml under session_limits.',
  };
  if (limitResult.totalAlive != null) result.total_alive = limitResult.totalAlive;
  if (limitResult.evicted) {
    result.evicted = limitResult.evicted.map((s) => ({
      session_id: s.claudeSessionId,
      task_id: s.taskId,
      title: s.title,
    }));
  }
  return json(result);
}

// ── task_query (type=task) adapter ─────────────────────────────────────────
//
// Legacy shape in, canonical TaskQuery out. Two compat behaviors live HERE and
// nowhere else (the canonical contract has neither):
//   1. no completion/phases/phase/status given → exclude COMPLETE;
//   2. where.parent_task_id is a PREFIX match (the REST/canonical field is exact).

/** where.parent_task_id stayed a prefix here, so it can't ride the SQL pushdown. */
function parentPrefixMatches(task: Task, prefix: string): boolean {
  return task.parent_task_id?.startsWith(prefix) === true;
}

/**
 * Legacy `true`/'true' booleans from a model that stringified the value. Any
 * other string throws so the model SEES `pinned must be true or false` and
 * retries — silently reading 'yes' as false returns a wrong answer instead.
 */
function looseBool(value: unknown, field: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${field} must be true or false`);
}

function buildToolTaskQuery(params: Record<string, unknown>, where: Record<string, unknown>): TaskQuery {
  const query: TaskQuery = {};

  // A bare string (a model that skipped the array) is accepted as a 1-element
  // list; it must NOT fall through to the legacy default below.
  if (typeof where.completion === 'string') {
    query.completion = [where.completion] as TaskQuery['completion'];
  } else if (Array.isArray(where.completion)) {
    query.completion = where.completion as TaskQuery['completion'];
  }
  if (where.phase) query.phases = [where.phase as TaskPhase];
  else if (where.status && query.completion === undefined) {
    // Legacy status alias → completion group (todo/in_progress/done).
    const mapped = LEGACY_STATUS_TO_COMPLETION[String(where.status)];
    if (mapped) query.completion = [mapped];
  }
  // LEGACY DEFAULT, adapter-only: bare task_query hides completed tasks.
  if (query.completion === undefined && query.phases === undefined) {
    query.completion = ['todo', 'in_progress'];
  }

  if (where.project !== undefined) query.projects = [String(where.project)];
  if (where.priority) query.priorities = [where.priority as TaskPriority];
  if (where.source) query.sources = [String(where.source)];
  if (where.sprint) query.sprints = [String(where.sprint)];
  if (Array.isArray(where.tags) && where.tags.length > 0) query.tagsAny = where.tags as string[];
  if (Array.isArray(where.tags_all) && where.tags_all.length > 0) query.tagsAll = where.tags_all as string[];
  if (where.pinned !== undefined) query.pinned = looseBool(where.pinned, 'pinned');
  if (where.unread !== undefined) query.unread = looseBool(where.unread, 'unread');
  if (where.blocked !== undefined) query.blocked = looseBool(where.blocked, 'blocked');
  if (where.group_id) query.groupId = String(where.group_id);

  if (where.time && typeof where.time === 'object' && !Array.isArray(where.time)) {
    const raw = where.time as Record<string, unknown>;
    const time: TaskQueryTime = { basis: raw.basis as TaskQueryTime['basis'] };
    if (raw.last_n_hours !== undefined) time.last = { value: Number(raw.last_n_hours), unit: 'hours' };
    else if (raw.last_n_days !== undefined) time.last = { value: Number(raw.last_n_days), unit: 'days' };
    if (raw.from !== undefined) time.from = String(raw.from);
    if (raw.until !== undefined) time.until = String(raw.until);
    query.time = time;
  }

  if (params.sort !== undefined) query.sort = params.sort as TaskQuery['sort'];
  if (params.limit !== undefined) query.limit = Number(params.limit);
  return query;
}

async function runTaskQueryTool(
  params: Record<string, unknown>,
  where: Record<string, unknown>,
  matchMode: string,
): Promise<string> {
  const parentPrefix = where.parent_task_id ? String(where.parent_task_id) : undefined;
  let query: TaskQuery;
  try {
    query = buildToolTaskQuery(params, where);
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
  // `match: 'contains'` is a project-name convenience the canonical contract
  // doesn't carry — resolve it to the concrete matching project names first.
  if (matchMode === 'contains' && where.project !== undefined && String(where.project) !== '') {
    const wanted = String(where.project).toLowerCase();
    const known = new Set<string>([
      ...Object.keys(await getStoreProjects()),
      ...(await listTasks({})).map((t) => t.project || '').filter(Boolean),
    ]);
    query.projects = [...known].filter((name) => name.toLowerCase().includes(wanted));
  }

  let tasks: Task[];
  try {
    // Limit is applied here only when no prefix compat filter follows it —
    // otherwise the prefix drop would eat limit slots.
    tasks = await queryTasks(parentPrefix ? { ...query, limit: undefined } : query);
  } catch (err) {
    if (err instanceof TaskQueryError) return `Error: ${err.message}`;
    throw err;
  }
  if (parentPrefix) {
    tasks = tasks.filter((t) => parentPrefixMatches(t, parentPrefix));
    if (query.limit !== undefined) tasks = tasks.slice(0, query.limit);
  }

  // The full task list is needed only by the empty-result hints and by the
  // blocked flag (dependencies can point outside the result). Load it LAZILY —
  // most queries return rows without dependencies and never touch it.
  let allTasksCache: Task[] | undefined;
  const loadAllTasks = async (): Promise<Task[]> => {
    if (allTasksCache === undefined) {
      allTasksCache = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'));
    }
    return allTasksCache;
  };

  if (tasks.length === 0) {
    const allTasks = await loadAllTasks();
    // Smart hints when a project was specified
    if (where.project !== undefined) {
      const wanted = String(where.project);
      const label = wanted === '' ? 'Inbox' : wanted;
      // Honor matchMode here too, or a `contains` miss reports the wrong hint
      // ("no project matching" vs "N completed").
      const inProject = allTasks.filter((t) => {
        const project = (t.project || '').toLowerCase();
        if (wanted === '') return project === '';
        return matchMode === 'contains'
          ? project.includes(wanted.toLowerCase())
          : project === wanted.toLowerCase();
      });
      if (inProject.length > 0) {
        const doneCount = inProject.filter((t) => t.phase === 'COMPLETE').length;
        return `No active tasks in '${label}'. ${doneCount} completed — use where.phase='COMPLETE'.`;
      }
      if (wanted === '') return 'Inbox is empty.';
      const available = [...new Set(allTasks.map((t) => t.project || '').filter(Boolean))];
      return `No project matching '${wanted}'. Available: [${available.join(', ')}]`;
    }
    return 'No tasks found.';
  }

  const includeNoteFlags = params.fields === 'all';
  // One shared blocked set (computeBlockedIds builds ONE id map) instead of
  // isTaskBlocked() rebuilding a Map per returned row. Only computed when some
  // returned row actually declares dependencies.
  const blockedIds = tasks.some((t) => t.depends_on?.length)
    ? computeBlockedIds(await loadAllTasks())
    : undefined;
  return json(tasks.map((t) => {
    const entry: Record<string, unknown> = {
      id: t.id,
      title: t.title,
      priority: t.priority,
      project: t.project || '',
      phase: t.phase,
      // status/pinned/timestamps are always present now so a time-windowed or
      // sorted result is explainable without a follow-up task_get.
      status: t.status,
      pinned: Boolean(t.pinned),
      created_at: t.created_at,
      updated_at: t.updated_at,
    };
    if (t.completed_at) entry.completed_at = t.completed_at;
    if (t.unread) entry.unread = true;
    if (t.due_date) entry.due_date = t.due_date;
    if (t.start_date) entry.start_date = t.start_date;
    if (t.end_date) entry.end_date = t.end_date;
    if (t.sprint) entry.sprint = t.sprint;
    if (t.tags?.length) entry.tags = t.tags;
    if (t.depends_on?.length) entry.depends_on = t.depends_on;
    if (blockedIds?.has(t.id)) entry.blocked = true;
    if (t.plan_session_id) entry.plan_session = t.plan_session_id;
    if (t.exec_session_id) entry.exec_session = t.exec_session_id;
    if (t.parent_task_id) entry.parent_task_id = t.parent_task_id;
    if (t.group_id) entry.group_id = t.group_id;
    if (includeNoteFlags) {
      entry.has_description = !!t.description;
      entry.has_summary = !!t.summary;
      entry.has_note = !!t.note;
      entry.has_conversation_log = !!t.conversation_log;
    }
    return entry;
  }));
}

export const tools: ToolDefinition[] = [
  delegateAgentTool(),

  // ── Task Tools ──
  {
    name: 'task_query',
    description: 'Query tasks or projects. Use `type` to pick the entity level. For tasks: defaults to non-completed. Use where.completion=[\'complete\'] (or where.phase=\'COMPLETE\') when the user asks about completed tasks or wants to delete/clean up. Different where fields AND together; arrays inside one field OR.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['task', 'project'],
          description: 'Entity to query. Default: "task".',
        },
        where: {
          type: 'object',
          description: 'Filter conditions. Project: { name }. Task: any combination of the fields below (AND). Legacy: status (todo/in_progress/done) still works as a convenience alias.',
          properties: {
            name: { type: 'string', description: 'Filter projects by name.' },
            completion: {
              type: 'array',
              items: { type: 'string', enum: ['todo', 'in_progress', 'complete'] },
              description: 'Coarse 3-group state (OR within the array). todo=TODO; in_progress=the five middle phases; complete=COMPLETE. Combine with phase to narrow further (they AND).',
            },
            phase: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION', 'HUMAN_VERIFIED', 'POST_WORK_COMPLETED', 'COMPLETE'], description: 'Filter by exact 7-state phase.' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'done'], description: 'Legacy 3-state filter. Maps to phases: todo→TODO, in_progress→IN_PROGRESS+AGENT_COMPLETE+AWAIT_HUMAN_ACTION+HUMAN_VERIFIED+POST_WORK_COMPLETED, done→COMPLETE.' },
            project: { type: 'string', description: 'Filter by project name. Pass "" to get Inbox (tasks with no project).' },
            priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'] },
            source: { type: 'string', description: 'Filter by task source (exact), e.g. "local".' },
            pinned: { type: 'boolean', description: 'Filter pinned/unpinned tasks. Combine with completion to find e.g. recently finished pinned work.' },
            unread: { type: 'boolean', description: 'Filter to UNREAD tasks — the agent produced output the human has not opened yet. Set automatically when a session turn ends; cleared when the human opens the task.' },
            parent_task_id: { type: 'string', description: 'Filter to children of a parent task (by ID prefix).' },
            group_id: { type: 'string', description: 'Filter to members of a virtual group (exact group id, e.g. "g_xxx").' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter to tasks with any of these tags (OR match).' },
            tags_all: { type: 'array', items: { type: 'string' }, description: 'Filter to tasks carrying every one of these tags (AND match).' },
            blocked: { type: 'boolean', description: 'Filter to tasks that are blocked/unblocked by dependencies.' },
            sprint: { type: 'string', description: 'Filter by sprint name (exact match).' },
            time: {
              type: 'object',
              description: 'Filter by a created/updated time window. Give basis plus EITHER last_n_hours/last_n_days (relative) OR from/until (absolute ISO-8601).',
              properties: {
                basis: { type: 'string', enum: ['created', 'updated', 'created_or_updated'], description: 'Which timestamp the window applies to.' },
                last_n_hours: { type: 'number', description: 'Relative window: the last N hours (positive integer, max 8760).' },
                last_n_days: { type: 'number', description: 'Relative window: the last N days (positive integer, max 365).' },
                from: { type: 'string', description: 'Absolute window start, ISO-8601 (inclusive).' },
                until: { type: 'string', description: 'Absolute window end, ISO-8601 (exclusive).' },
              },
              required: ['basis'],
            },
          },
        },
        sort: {
          type: 'string',
          enum: ['updated_desc', 'created_desc', 'completed_desc', 'priority', 'title_asc'],
          description: 'Result order. Default: "updated_desc". Always tie-broken by id.',
        },
        limit: {
          type: 'number',
          description: `Max tasks to return (1-${MAX_QUERY_LIMIT}). Applied after filtering and sorting. Default: no limit.`,
        },
        match: {
          type: 'string',
          enum: ['exact', 'contains'],
          description: 'String match mode for project/name values. Default: "exact".',
        },
        fields: {
          type: 'string',
          enum: ['all'],
          description: 'For type=task: include has_description/summary/note flags.',
        },
      },
    },
    async execute(params) {
      const type = (params.type as string) || 'task';
      const where = (params.where as Record<string, unknown>) || {};
      const matchMode = (params.match as string) || 'exact';

      // The task listing is a thin adapter over queryTasks(); only the
      // entity-level project summary below still walks the task list itself.
      if (type === 'task') {
        return await runTaskQueryTool(params, where, matchMode);
      }

      if (type === 'project') {
        // Project-name matcher — only this branch matches names by string.
        const strMatch = (value: string, filter: string): boolean => {
          if (matchMode === 'contains') {
            return value.toLowerCase().includes(filter.toLowerCase());
          }
          return value.toLowerCase() === filter.toLowerCase();
        };

        const allTasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'));
        // Merge the registry (includes empty projects) with task-derived data.
        const storeProjects = await getStoreProjects();
        const nameSet = new Set<string>([
          ...Object.keys(storeProjects),
          ...allTasks.map((t) => t.project || '').filter(Boolean),
        ]);
        let names = [...nameSet];
        if (where.name) {
          names = names.filter((n) => strMatch(n, where.name as string));
        }
        const results = await Promise.all(names.map(async (name) => {
          const projTasks = allTasks.filter((t) => (t.project || '').toLowerCase() === name.toLowerCase());
          const storeKey = Object.keys(storeProjects).find((k) => k.toLowerCase() === name.toLowerCase());
          const entry: Record<string, unknown> = {
            name,
            source: storeKey ? storeProjects[storeKey].source : (projTasks[0]?.source ?? 'local'),
            todo: projTasks.filter((t) => t.phase === 'TODO').length,
            active: projTasks.filter((t) => t.phase !== 'TODO' && t.phase !== 'COMPLETE').length,
            done: projTasks.filter((t) => t.phase === 'COMPLETE').length,
          };
          const metadata = await getProjectMetadata(name);
          if (metadata) entry.settings = metadata;
          try {
            const { getProjectSummary } = await import('../core/project-memory.js');
            const summary = getProjectSummary(name.toLowerCase());
            if (summary) entry.memory = summary;
          } catch { /* no memory */ }
          return entry;
        }));
        // Inbox is not a registry row but is worth reporting when it holds tasks.
        const inboxTasks = allTasks.filter((t) => !(t.project || ''));
        if (inboxTasks.length > 0 && (!where.name || strMatch('Inbox', where.name as string))) {
          results.push({
            name: '',
            label: 'Inbox',
            source: 'local',
            todo: inboxTasks.filter((t) => t.phase === 'TODO').length,
            active: inboxTasks.filter((t) => t.phase !== 'TODO' && t.phase !== 'COMPLETE').length,
            done: inboxTasks.filter((t) => t.phase === 'COMPLETE').length,
          });
        }
        return json(results);
      }

      return `Error: unknown type '${type}'. Use type='task' or type='project'.`;
    },
  },

  {
    name: 'task_get',
    description: 'Get full details of a task or project.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'project'], description: 'Entity type. Default: "task".' },
        id: { type: 'string', description: 'Task ID or prefix. Required when type=task.' },
        project: { type: 'string', description: 'Project name. Required when type=project.' },
      },
    },
    async execute(params) {
      const type = (params.type as string) || 'task';
      try {
        if (type === 'project') {
          const project = (params.project as string | undefined)?.trim();
          if (!project) return 'Error: project is required for type=project.';

          const allTasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'));
          const projTasks = allTasks.filter(
            (t) => (t.project || '').toLowerCase() === project.toLowerCase(),
          );
          const record = await getProjectRecord(project);
          const result: Record<string, unknown> = {
            name: record?.name ?? project,
            source: record?.source ?? (projTasks[0]?.source ?? 'local'),
            todo: projTasks.filter((t) => t.phase === 'TODO').length,
            active: projTasks.filter((t) => t.phase !== 'TODO' && t.phase !== 'COMPLETE').length,
            done: projTasks.filter((t) => t.phase === 'COMPLETE').length,
          };
          const metadata = await getProjectMetadata(project);
          if (metadata) result.settings = metadata;
          try {
            const { getProjectSummary } = await import('../core/project-memory.js');
            const summary = getProjectSummary(project.toLowerCase());
            if (summary) result.memory = summary;
          } catch { /* no memory */ }
          return json(result);
        }

        // type === 'task'
        const id = params.id as string;
        if (!id) return 'Error: id is required for type=task.';
        const task = await getTask(id);
        const allTasks = await listTasks();
        const children = allTasks.filter((t) => t.parent_task_id === task.id);
        const result: Record<string, unknown> = { ...task };
        if (children.length > 0) {
          result.children = children.map((c) => ({
            id: c.id, title: c.title, status: c.status, phase: c.phase,
            plan_session: c.plan_session_id ?? null,
            exec_session: c.exec_session_id ?? null,
          }));
        }
        // Dependency info
        if (task.depends_on?.length) {
          result.dependencies = task.depends_on.map((depId: string) => {
            const depTask = allTasks.find((t: Task) => t.id === depId);
            return depTask
              ? { id: depTask.id, title: depTask.title, phase: depTask.phase }
              : { id: depId, title: '(not found)', phase: 'UNKNOWN' };
          });
          result.is_blocked = isTaskBlocked(task, allTasks);
        }
        // Reverse: tasks that depend on this one
        const dependents = allTasks.filter((t: Task) => t.depends_on?.includes(task.id));
        if (dependents.length > 0) {
          result.dependents = dependents.map((t: Task) => ({ id: t.id, title: t.title, phase: t.phase }));
        }
        return json(result);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'task_create',
    description: `Record a task or empty project without starting any work or session.

- type=task (default): Use only when the user wants tracking without execution. If work should start now, use delegate instead. Tasks optionally belong to a **project**; no project = **Inbox**. Prefer an existing project (matched case-insensitively). A project name that doesn't exist yet is created automatically. Use parent_task_id for child tasks (inherits project and source from parent).
- type=project: Create an empty project up front (rarely needed; task creation auto-creates a project by name).`,
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'project'], description: 'Entity type. Default: "task".' },
        // Project fields
        name: { type: 'string', description: 'Project name. Required for type=project (alias: project).' },
        source: { type: 'string', description: 'Sync provider claim for a NEW project (type=project). "local" (default) = never synced; otherwise any installed integration plugin id (e.g. "ms-todo"). Validated at runtime against the plugin registry — no hardcoded list, so third-party plugins work.' },
        // Task fields
        title: { type: 'string', description: 'Task title. Required for type=task. Format: "<≤3-word prefix> — <short description>". Prefix MUST be the most unique identifier of the task (max 3 words) — the thing that instantly tells you WHICH task this is. Use em-dash (—). Good: "Sprint选择器 — 查询/选择当前sprint", "Task不跳转 — 点击task不定位到列表位置". Bad: generic prefixes like "Sprint功能增强", "Bug:", "Tool Description".' },
        priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'], description: 'Priority: immediate (urgent), important (can wait), backlog (future), none' },
        project: { type: 'string', description: 'Project — the single grouping layer (e.g. Walnut, HomeLab, Costco). Omit or pass "" to file the task in Inbox.' },
        due_date: { type: 'string', description: 'Due date — the deadline (YYYY-MM-DD, or ISO datetime for a specific time)' },
        start_date: { type: 'string', description: 'Start date — when to begin working (YYYY-MM-DD, or ISO datetime). Tasks with a future start_date are hidden from the "Now" view until that time arrives.' },
        end_date: { type: 'string', description: 'End of the working block (YYYY-MM-DD, or ISO datetime). With start_date it gives the task a duration on the calendar; independent of due_date (the deadline).' },
        parent_task_id: { type: 'string', description: 'Create as child of this task. Child inherits project and source from parent.' },
        description: { type: 'string', description: 'What & why context for the task (pre-action). Synced to configured plugins on creation.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Initial tags. Convention: "key:value" for structured data (e.g. "team:backend", "blocked").' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Full IDs of prerequisite tasks that must complete before this one can start.' },
        cwd: { type: 'string', description: 'Task-level working directory override (type=task only). Takes precedence over project default_cwd when starting sessions.' },
      },
      required: [],
    },
    async execute(params, meta) {
      const entityType = (params.type as string) || 'task';
      try {
        if (entityType === 'project') {
          const name = ((params.name as string | undefined) ?? (params.project as string | undefined))?.trim();
          if (!name) return 'Error: "name" is required for type=project';
          const source = (params.source as TaskSource | undefined) ?? 'local';
          // Same rule as POST /api/projects: 'local' or any registered plugin id.
          if (source !== 'local') {
            const { registry } = await import('../core/integration-registry.js');
            if (!registry.has(source)) {
              const valid = ['local', ...registry.getAll().map((p) => p.id)];
              return `Error: unknown source "${source}". Valid sources: ${valid.join(', ')}.`;
            }
          }
          const result = await ensureProject(name, source);
          if (!result.created) {
            return `Project "${result.name}" already exists (source: ${result.source}).`;
          }

          // Prompt AI to confirm working directory with the user
          const metadata = await getProjectMetadata(result.name);
          let response = `Project created: "${result.name}" (source: ${result.source})`;
          if (!metadata?.default_cwd) {
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js');
            const { default: path } = await import('node:path');
            const memDir = path.join(PROJECTS_MEMORY_DIR, result.name.toLowerCase());
            response += `\n⚠️ No default_cwd set — sessions will use: ${memDir}`;
            response += `\nPlease confirm with the user what the correct working directory should be for this project, then set it via default_cwd.`;
          }
          return response;
        }

        // type === 'task' (default)
        const title = params.title as string;
        if (!title) return 'Error: "title" is required for type=task';

        // Idempotency backstop for UNATTENDED creators (cron / triage / review
        // forks): an exact-title live duplicate on the same day means the turn
        // is a replay — return the existing task instead of minting another.
        // 2026-08-04 incident: a cron job re-fired ~19× and created 33
        // identical daily-report tasks. Interactive chat is exempt — a human
        // re-asking for a same-titled task is deliberate.
        const unattended = typeof meta?.source === 'string'
          && /^(cron|triage|background|heartbeat)/.test(meta.source);
        if (unattended) {
          const { listTasks } = await import('../core/task-manager.js');
          const today = new Date().toISOString().slice(0, 10);
          const dup = (await listTasks()).find((t) =>
            t.title === title.trim()
            && t.phase !== 'COMPLETE'
            && (t.created_at ?? '').slice(0, 10) === today,
          );
          if (dup) {
            return `Task already exists (created today, same title — not duplicating): ${taskRef(dup.id, dup.title)} (${dup.priority}, ${dup.project || 'Inbox'}). Reuse this task.`;
          }
        }

        // Preserve an explicit '' — the schema promises `""` = Inbox, and addTask
        // only bypasses config.defaults.project when the caller PASSED a value
        // (undefined = "no opinion", '' = "Inbox, explicitly").
        const project = params.project === undefined
          ? undefined
          : String(params.project).trim();
        const parentTaskId = params.parent_task_id as string | undefined;

        // A named project is auto-created by addTask (which also resolves its
        // source from the plugin claim chain — so do NOT pre-create the row here,
        // that would stamp it 'local' before the claim is consulted). We only
        // peek beforehand so the reply can flag a brand-new project to the model.
        const projectWasNew = !!project && !parentTaskId && !(await getProjectRecord(project));

        const { task, syncResult } = await addTask({
          title,
          priority: params.priority as TaskPriority | undefined,
          project,
          due_date: params.due_date as string | undefined,
          start_date: params.start_date as string | undefined,
          end_date: params.end_date as string | undefined,
          parent_task_id: parentTaskId,
          description: params.description as string | undefined,
          tags: params.tags as string[] | undefined,
          depends_on: params.depends_on as string[] | undefined,
          cwd: params.cwd as string | undefined,
        });
        bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'agent' });
        const syncStatus = syncResult?.success === false
          ? `, ⚠️ sync failed: ${syncResult.error}`
          : ', synced';
        const groupLabel = task.project || 'Inbox';
        const newNote = projectWasNew ? ' (new project)' : '';
        return `Task created: ${taskRef(task.id, task.title)} (${task.priority}, ${groupLabel}${newNote} → ${task.source}${syncStatus})`;
      } catch (err) {
        if (err instanceof ProjectSourceConflictError) {
          return `Error: Project "${err.project}" is synced from ${err.existingSource}; tasks there must come from that provider (cannot add a ${err.intendedSource} task).`;
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'task_update',
    description: `Update a task or a project. Supports multiple fields in a single call.

For tasks (type='task'): update structural fields (priority, phase, project, unread, due_date, start_date, end_date, title, pinned, focus_tier) and/or text fields (description, summary, note, append_note) in one call. Use phase='AGENT_COMPLETE' to mark a task done (only humans can set COMPLETE). Use pinned + focus_tier to pin/unpin tasks for the Focus Bar. Pass project='' to move a task to Inbox.

For projects (type='project'): set default_host and default_cwd for session defaults, or rename the project across all its tasks (old_name + new_name; renaming onto an existing project merges them).`,
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'project'], description: 'Entity type. Default: "task".' },
        // Task fields
        id: { type: 'string', description: 'Task ID or prefix. Required for type=task.' },
        title: { type: 'string', description: 'New title. Format: "<≤3-word prefix> — <short description>". Prefix MUST be the most unique identifier of the task (max 3 words) — the thing that instantly tells you WHICH task this is. Use em-dash (—). Good: "Sprint选择器 — 查询/选择当前sprint", "Task不跳转 — 点击task不定位到列表位置". Bad: generic prefixes like "Sprint功能增强", "Bug:", "Tool Description".' },
        priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'], description: 'New priority: immediate (urgent), important (can wait), backlog (future), none.' },
        phase: { type: 'string', enum: [...AGENT_WRITABLE_PHASES], description: 'Agent-writable task phase. Use AGENT_COMPLETE or AWAIT_HUMAN_ACTION to hand work back.' },
        project: { type: 'string', description: 'New project for the task (empty string moves it to Inbox). For type=project: the project to update settings on.' },
        due_date: { type: 'string', description: 'New due date — the deadline (YYYY-MM-DD, or ISO datetime). Empty string clears.' },
        start_date: { type: 'string', description: 'New start date — when to begin working (YYYY-MM-DD, or ISO datetime). Tasks with a future start_date are hidden from the "Now" view until then. Empty string clears.' },
        end_date: { type: 'string', description: 'New end of the working block (YYYY-MM-DD, or ISO datetime). With start_date it gives the task a duration on the calendar; independent of due_date. Empty string clears.' },
        unread: { type: 'boolean', description: 'Read/unread marker (red dot in UI). true = there is agent output the human has not seen. Normally managed automatically by the session lifecycle — set it manually only to re-flag a task for review.' },
        parent_task_id: { type: 'string', description: 'Set or change the parent task. Pass empty string to remove parent.' },
        sprint: { type: 'string', description: 'Set sprint name (e.g. "Feb16-Feb27"). Empty string clears. Plugins map this to platform-specific sprint/iteration fields.' },
        description: { type: 'string', description: 'Set task description (what & why — pre-action context).' },
        summary: { type: 'string', description: 'Set AI-maintained summary.' },
        note: { type: 'string', description: 'Replace entire note.' },
        append_note: { type: 'string', description: 'Append to note.' },
        append_conversation_log: { type: 'string', description: 'Append an entry to the conversation log. Format: "**User:** <request summary>\\n**AI:** <response summary>". Timestamp heading is auto-prepended. Normally auto-managed by the system — use only for manual corrections.' },
        // Tag fields
        add_tags: { type: 'array', items: { type: 'string' }, description: 'Add tags (idempotent). Convention: "key:value" for structured data (e.g. "team:backend", "blocked").' },
        remove_tags: { type: 'array', items: { type: 'string' }, description: 'Remove specific tags.' },
        set_tags: { type: 'array', items: { type: 'string' }, description: 'Replace all tags (overwrite). Pass empty array to clear.' },
        // Dependency fields
        add_depends_on: { type: 'array', items: { type: 'string' }, description: 'Add dependency IDs (idempotent). Tasks with incomplete deps are "blocked".' },
        remove_depends_on: { type: 'array', items: { type: 'string' }, description: 'Remove specific dependency IDs.' },
        set_depends_on: { type: 'array', items: { type: 'string' }, description: 'Replace all dependencies (overwrite). Pass empty array to clear.' },
        // Task-level cwd
        cwd: { type: 'string', description: 'Task-level working directory override. Takes precedence over project default_cwd when starting sessions. Empty string clears.' },
        // Pin / Focus tier
        pinned: { type: 'boolean', description: 'Pin or unpin the task. Pinned tasks appear in the Focus Bar sidebar.' },
        focus_tier: { type: 'string', description: 'Set focus tier (task must be pinned). Built-ins: focus=current sprint, satellite=needs doing soon (default), backlog=someday/low-priority, wait=parked/blocked. Custom tiers (user-defined in Settings) are also accepted by id or label.' },
        // Project fields
        default_host: { type: 'string', description: 'SSH host alias for remote sessions (type=project).' },
        default_cwd: { type: 'string', description: 'Default working directory (type=project).' },
        // Project rename fields
        old_name: { type: 'string', description: 'Current project name (type=project rename).' },
        new_name: { type: 'string', description: 'New project name (type=project rename). Renaming onto an existing project merges them.' },
      },
    },
    async execute(params) {
      const type = (params.type as string) || 'task';

      if (type === 'project') {
        // Rename takes precedence when old_name/new_name are supplied.
        const oldName = (params.old_name as string | undefined)?.trim();
        const newName = (params.new_name as string | undefined)?.trim();
        if (oldName || newName) {
          if (!oldName || !newName) return 'Error: both old_name and new_name are required to rename a project.';
          try {
            const { count, merged } = await renameProject(oldName, newName);
            const mergeNote = merged ? ' — merged into the existing project' : '';
            return `Renamed project "${oldName}" to "${newName}" (${count} tasks updated)${mergeNote}`;
          } catch (err) {
            if (err instanceof ProjectSourceConflictError) {
              return `Error: Project "${err.project}" is synced from ${err.existingSource}; tasks there must come from that provider.`;
            }
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        const project = (params.project as string | undefined)?.trim();
        if (!project) return 'Error: project is required for type=project.';
        const settings: Record<string, unknown> = {};
        if (params.default_host !== undefined) settings.default_host = params.default_host;
        if (params.default_cwd !== undefined) settings.default_cwd = params.default_cwd;
        if (Object.keys(settings).length === 0) return 'Error: no project settings to update. Provide default_host, default_cwd, or old_name+new_name to rename.';
        try {
          const merged = await setProjectMetadata(project, settings);
          return `Project "${project}" updated: ${json(merged)}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // type === 'task'
      const id = params.id as string;
      if (!id) return 'Error: id is required for type=task.';

      if (params.phase !== undefined && !isAgentWritablePhase(params.phase)) {
        return 'Error: Agents may set TODO, IN_PROGRESS, AGENT_COMPLETE, or AWAIT_HUMAN_ACTION only.';
      }

      try {
        const results: string[] = [];

        // Resolve focus_tier BEFORE any write below: built-ins match
        // case-insensitively and pass through verbatim; custom tiers match by id
        // OR label (case-insensitive) and resolve to the id (the schema can't
        // enumerate them — the tier set is dynamic). Doing this first keeps the
        // whole update atomic from the model's view: an unknown tier fails the
        // call before title/note/etc have been written, so a retry can't
        // double-apply the parts that did land.
        let resolvedTier: string | undefined;
        if (params.focus_tier !== undefined) {
          const raw = String(params.focus_tier).trim().toLowerCase();
          if (raw === 'focus' || raw === 'satellite' || raw === 'backlog' || raw === 'wait') {
            resolvedTier = raw;
          } else {
            const customTiers = await getCustomTiers();
            const match = customTiers.find(
              (t) => t.id.toLowerCase() === raw || t.label.trim().toLowerCase() === raw,
            );
            if (!match) {
              const valid = ['focus', 'satellite', 'backlog', 'wait', ...customTiers.map((t) => t.label)];
              return `Error: unknown focus_tier "${String(params.focus_tier)}". Valid tiers: ${valid.join(', ')}`;
            }
            resolvedTier = match.id;
          }
        }

        // Structural fields
        const hasStructural = params.title !== undefined || params.priority !== undefined ||
          params.phase !== undefined ||
          params.project !== undefined || params.due_date !== undefined ||
          params.start_date !== undefined || params.end_date !== undefined ||
          params.unread !== undefined ||
          params.parent_task_id !== undefined || params.sprint !== undefined ||
          params.add_tags !== undefined || params.remove_tags !== undefined ||
          params.set_tags !== undefined ||
          params.add_depends_on !== undefined || params.remove_depends_on !== undefined ||
          params.set_depends_on !== undefined ||
          params.cwd !== undefined;

        if (hasStructural) {
          try {
            const { task } = await updateTask(id, {
              title: params.title as string | undefined,
              priority: params.priority as TaskPriority | undefined,
              phase: params.phase as TaskPhase | undefined,
              due_date: params.due_date as string | undefined,
              start_date: params.start_date as string | undefined,
              end_date: params.end_date as string | undefined,
              // Trim at the boundary like task_create does ('' stays '', = Inbox).
              project: params.project === undefined ? undefined : String(params.project).trim(),
              unread: (params.unread === true || params.unread === 'true') ? true : (params.unread === false || params.unread === 'false') ? false : undefined,
              parent_task_id: params.parent_task_id as string | undefined,
              sprint: params.sprint as string | undefined,
              add_tags: params.add_tags as string[] | undefined,
              remove_tags: params.remove_tags as string[] | undefined,
              set_tags: params.set_tags as string[] | undefined,
              add_depends_on: params.add_depends_on as string[] | undefined,
              remove_depends_on: params.remove_depends_on as string[] | undefined,
              set_depends_on: params.set_depends_on as string[] | undefined,
              cwd: params.cwd as string | undefined,
            }, { source: 'agent', ifPhase: params._ifPhase as TaskPhase | undefined });
            if (params.phase === 'AGENT_COMPLETE') {
              bus.emit(EventNames.TASK_COMPLETED, { task }, ['web-ui'], { source: 'agent' });
            }
            results.push('structural fields updated');
          } catch (err) {
            if (err instanceof CircularDependencyError) {
              return `Error: Adding that dependency would create a circular chain. ${err.message}`;
            }
            throw err;
          }
        }

        // Text fields — each helper auto-emits TASK_UPDATED internally.
        if (params.description !== undefined) {
          await updateDescription(id, params.description as string);
          results.push('description set');
        }
        if (params.summary !== undefined) {
          await updateSummary(id, params.summary as string);
          results.push('summary set');
        }
        if (params.note !== undefined) {
          await updateNote(id, params.note as string);
          results.push('note replaced');
        }
        if (params.append_note !== undefined) {
          await addNote(id, params.append_note as string);
          results.push('note appended');
        }
        if (params.append_conversation_log !== undefined) {
          await appendConversationLog(id, params.append_conversation_log as string);
          results.push('conversation log appended');
        }

        // Pin / Focus tier (resolvedTier was validated before any write above).
        if (params.pinned !== undefined) {
          const task = await getTask(id);
          const wantPinned = params.pinned === true || params.pinned === 'true';
          if (wantPinned && !task.pinned) {
            await togglePin(task.id);
            const tier = resolvedTier || 'satellite';
            await setFocusTier(task.id, tier);
            results.push(`pinned → ${tier} tier`);
          } else if (!wantPinned && task.pinned) {
            await togglePin(task.id);
            results.push('unpinned');
          } else if (wantPinned && task.pinned && resolvedTier) {
            // Already pinned, just change tier
            await setFocusTier(task.id, resolvedTier);
            results.push(`tier → ${resolvedTier}`);
          } else if (wantPinned && task.pinned) {
            // Already pinned, no tier change requested
            results.push('already pinned');
          } else if (!wantPinned && !task.pinned) {
            results.push('already unpinned');
          }
        } else if (resolvedTier !== undefined) {
          const task = await getTask(id);
          if (!task.pinned) {
            results.push('Error: task is not pinned — pin it first with pinned=true');
          } else {
            await setFocusTier(task.id, resolvedTier);
            results.push(`tier → ${resolvedTier}`);
          }
        }

        if (results.length === 0) {
          return 'Error: no update fields provided.';
        }

        // Get final task state for the response
        const task = await getTask(id);
        return `Task updated: ${taskRef(task.id, task.title)} — ${results.join(', ')}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'task_delete',
    description: 'Permanently delete a task. Fails if the task has active sessions — complete or stop those sessions first.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task'], description: 'Entity type. Default: "task".' },
        id: { type: 'string', description: 'Task ID or prefix.' },
      },
      required: ['id'],
    },
    async execute(params) {
      try {
        const { task } = await deleteTask(params.id as string);
        bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui'], { source: 'agent' });
        return `Task deleted: ${taskRef(task.id, task.title)}`;
      } catch (err) {
        if (err instanceof ActiveSessionError) {
          return `Cannot delete: task has ${err.activeSessionIds.length} active session(s): ${err.activeSessionIds.join(', ')}. Stop or complete those sessions first.`;
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'task_merge',
    description: 'Merge duplicate copies of a task into one survivor, then delete the copies. Session links (session_ids, session slots, sessions.task_id) move onto the survivor first, so no conversation history is lost. ALWAYS use this for duplicate cleanup instead of task_delete — deleting a duplicate directly destroys whichever session links that copy held.',
    input_schema: {
      type: 'object',
      properties: {
        survivor_id: { type: 'string', description: 'Task ID (or unique prefix) that survives the merge. Pick the copy with the most context (sessions, notes).' },
        victim_ids: { type: 'array', items: { type: 'string' }, description: 'Duplicate task IDs (or unique prefixes) to merge into the survivor and delete.' },
      },
      required: ['survivor_id', 'victim_ids'],
    },
    async execute(params) {
      try {
        const survivor = await getTask(params.survivor_id as string);
        const victimIds = params.victim_ids as string[];
        if (!Array.isArray(victimIds) || victimIds.length === 0) {
          return 'Error: victim_ids must be a non-empty array of task ids.';
        }
        let sessionsRelinked = 0;
        const mergedTitles: string[] = [];
        for (const prefix of victimIds) {
          const victim = await getTask(prefix);
          if (victim.id === survivor.id) return 'Error: survivor cannot be one of the victims.';
          const result = await mergeTaskInto(survivor.id, victim.id);
          sessionsRelinked += result.sessionsRelinked;
          mergedTitles.push(victim.title);
        }
        const merged = await getTask(survivor.id);
        return `Merged ${mergedTitles.length} duplicate(s) into ${taskRef(merged.id, merged.title)} — ${sessionsRelinked} session link(s) moved, ${merged.session_ids.length} total sessions on the survivor.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'task_group',
    description: `Group related tasks together into a lightweight VISUAL group — they render boxed together in the task list, ordered right after the group's lead (top-sorted) task.

This is NOT a parent/subtask relationship: grouped tasks stay flat and fully independent (separate lifecycles, no inherited fields, none is "under" another). Use it to say "these tasks belong together" (e.g. a task and its forks, or several tasks tackling one theme) without the heaviness of subtasks.

Rules:
- Any tasks can be grouped together — there is no project restriction (a group is a pure visual cluster).
- A group needs ≥2 tasks. Removing members until fewer than 2 remain dissolves the group automatically.
- The group name is AI-suggested but you can set/override it via 'label'.

Actions:
- create: make a new group from 2+ tasks (task_ids). If a task is already grouped, its existing group is merged in.
- add: add task(s) to an existing group (group_id + task_ids).
- remove: remove task(s) from their group (task_ids).
- rename: change a group's name (group_id + label).
- list: list all groups with their members.`,
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'add', 'remove', 'rename', 'list'], description: 'The grouping operation to perform.' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Task IDs or prefixes. Required for create (≥2), add (≥1), remove (≥1).' },
        group_id: { type: 'string', description: 'Target group id (e.g. "g_xxx"). Required for add and rename.' },
        label: { type: 'string', description: 'Group name. Optional for create (AI-generated if omitted); required for rename.' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;
      const taskIds = (params.task_ids as string[] | undefined) ?? [];
      const groupId = params.group_id as string | undefined;
      const label = params.label as string | undefined;
      try {
        if (action === 'list') {
          const groups = await listGroups();
          if (groups.length === 0) return 'No task groups.';
          return groups
            .map((g) => `${g.label} (${g.group_id}): ${g.member_ids.length} tasks`)
            .join('\n');
        }

        if (action === 'create') {
          if (taskIds.length < 2) return 'Error: "create" needs at least 2 task_ids.';
          const result = await groupTasks(taskIds, label);
          bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'agent' });
          // Refine the name in the background when the caller didn't supply one.
          if (!label?.trim()) void refineGroupLabel(result.group_id, result.member_ids);
          return `Grouped ${result.member_ids.length} tasks as "${result.label}" (${result.group_id}).`;
        }

        if (action === 'add') {
          if (!groupId) return 'Error: "add" requires group_id.';
          if (taskIds.length < 1) return 'Error: "add" requires task_ids.';
          const result = await addToGroup(groupId, taskIds);
          bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'agent' });
          return `Group "${result.label}" now has ${result.member_ids.length} tasks.`;
        }

        if (action === 'remove') {
          if (taskIds.length < 1) return 'Error: "remove" requires task_ids.';
          const result = await removeFromGroup(taskIds);
          bus.emit(EventNames.TASK_GROUPS_CHANGED, { dissolved_group_ids: result.dissolved_group_ids }, ['web-ui'], { source: 'agent' });
          const dissolvedNote = result.dissolved_group_ids.length
            ? ` (${result.dissolved_group_ids.length} group(s) dissolved — fewer than 2 members left)`
            : '';
          return `Removed ${result.removed_ids.length} task(s) from their group${dissolvedNote}.`;
        }

        if (action === 'rename') {
          if (!groupId) return 'Error: "rename" requires group_id.';
          if (!label?.trim()) return 'Error: "rename" requires a non-empty label.';
          const result = await renameGroup(groupId, label);
          bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'agent' });
          return `Group renamed to "${result.label}" (${result.group_id}).`;
        }

        return `Error: unknown action "${action}".`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Search Tools ──
  {
    name: 'task_search',
    description: `Search tasks via hybrid search (QMD: BM25 + vector + reranking) with BM25 keyword fallback. QMD indexes human-readable fields: title, description, summary, note, conversation_log, tags, and project. Task IDs, session IDs, and external URLs are resolved directly from structured records before QMD. Auto-expands child tasks of matched parents.

## How matching works

Each query you pass runs TWICE against the task index:
1. **BM25 keyword** (lex) — every word in the query must appear in the task text (AND logic). Uses Porter stemmer, so "allowlisting" matches "allowlist", but "AIHub" does NOT match "AI Hub" (tokenizer splits on space).
2. **Vector similarity** (semantic) — finds tasks semantically close to the query, even if exact words differ.

Results from all queries merge via RRF (Reciprocal Rank Fusion). More queries = better recall.

## Why multiple queries matter

A single long query is a recall disaster. Example:
- Target task: "Track PAPINS SigV4 Allowlisting for Pipeline APIs — P382997071"
- Task body mentions: PAPINS, SigV4, Pipeline APIs, Allowlisting, EKS AI Hub
- Task body does NOT mention: "AIHub" (connected), "deploy", "CDK", "NGS"

queries: ["AIHub pipeline API allowlist deploy CDK"]  → **0 BM25 hits** (task has no "AIHub"/"deploy"/"CDK"), falls back to vec, returns wrong tasks.

queries: ["pipeline API allowlisting", "PAPINS SigV4", "pipeline allowlist"]  → first query matches (3 words all present), BM25 finds target at rank 1.

## Rules

1. **Split your user's mental model from the task's actual words.** User may say "AIHub deploy work" but task text uses "EKS AI Hub" and mentions no "deploy". Include BOTH: what the user said AND what might literally be in the task.
2. **First query: natural language** (for reranker) — e.g., "pipeline API allowlisting request"
3. **Rest: 2-3 word keyword phrases** covering acronyms/aliases/synonyms — e.g., "PAPINS", "SigV4 pipeline", "pipeline allowlist"
4. **Prefer specific identifiers** (ticket IDs, acronyms like PAPINS/SigV4) over generic terms
5. **Beware tokenizer splits:** "AIHub" ≠ "AI Hub" ≠ "eksaihub". Include variants if unsure.

**Good:** queries: ["pipeline API allowlisting request", "PAPINS SigV4", "pipeline allowlist", "AI Hub pipeline"]
**Bad:**  queries: ["pipeline API allowlisting NGS search deploy CDK"]   ← 6-word AND, any missing word = 0 hits`,
    input_schema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 5,
          description: '1-5 focused search queries. First = natural language (for reranking), rest = short keyword phrases (2-3 words each, with synonyms/aliases). Each query runs independently; results merge via RRF.',
        },
        limit: { type: 'number', description: 'Max results to return. Default: 20' },
      },
      required: ['queries'],
    },
    async execute(params) {
      const queries = Array.isArray(params.queries)
        ? (params.queries as string[]).map(q => q.trim()).filter(q => q.length > 0)
        : [];
      if (queries.length === 0) return 'Error: queries is required (non-empty array of strings).';
      const limit = (params.limit as number) ?? 20;

      const [allTasks, allSessions] = await Promise.all([
        listTasks(),
        listSessions(),
      ]);
      const referenceResults: import('../core/search.js').SearchResult[] = [];
      const semanticQueries: string[] = [];
      for (const query of queries) {
        const references = searchTaskAndSessionReferences(
          allTasks,
          allSessions,
          query,
        );
        referenceResults.push(...references);
        // Exact copied references are navigation commands. Partial references
        // stay pinned first but still receive semantic expansion.
        if (!references.some((result) => result.score === 1)) {
          semanticQueries.push(query);
        }
      }

      const bestByTask = new Map<string, import('../core/search.js').SearchResult>();
      const appendResult = (result: import('../core/search.js').SearchResult) => {
        if (!result.taskId || bestByTask.has(result.taskId)) return;
        bestByTask.set(result.taskId, result);
      };
      for (const result of referenceResults) appendResult(result);

      try {
        if (semanticQueries.length > 0) {
          // rerank:false. "It's an agent tool, nobody's watching a spinner" is NOT
          // a reason to keep the reranker here: the agent loop runs IN THE WEB
          // SERVER PROCESS (src/web/server.ts imports agent/loop.js directly), and
          // QMD's reranker is a native llama.cpp call. Measured on this vault:
          // task_search 14.7s with rerank vs 0.26s without, and it stalled the
          // event loop 609ms — i.e. every tool call degraded the whole app for
          // every user. Quality delta was nil where it matters (top-1 hit
          // identical across 4 probe queries; 46x total latency).
          const { memoryNotesSearch } = await import('../core/memory-search.js');
          const qmdResults = await memoryNotesSearch(
            semanticQueries,
            ['task'],
            limit,
            undefined,
            { rerank: false },
          );
          for (const result of qmdResults) {
            appendResult({
              type: 'task',
              title: result.title,
              snippet: result.snippet,
              taskId: result.taskId,
              score: result.finalScore,
              matchField: 'task',
            });
          }
        }
      } catch {
        // Graceful degradation: QMD unavailable — fallback to BM25 keyword search
        // Run each query, keep best score per task
        const merged = new Map<string, import('../core/search.js').SearchResult>();
        for (const q of semanticQueries) {
          for (const r of bm25ScoreTasks(allTasks, q)) {
            const prev = merged.get(r.taskId!);
            if (!prev || r.score > prev.score) merged.set(r.taskId!, r);
          }
        }
        for (const result of [...merged.values()].sort((a, b) => b.score - a.score)) {
          appendResult(result);
        }
      }

      // Auto-expand child tasks of matched parents
      let results = expandChildTasks(
        [...bestByTask.values()].slice(0, limit),
        allTasks.filter(t => !t.title.startsWith('.metadata')),
      );
      if (results.length === 0) return 'No tasks found.';
      return json(results.map((r) => ({
        task_id: r.taskId,
        title: r.title,
        snippet: r.snippet,
        score: r.score,
        match_field: r.matchField,
        parent_task_id: r.parentTaskId,
        auto_expanded: r.isAutoExpanded,
      })));
    },
  },

  memoryNotesSearchTool,
  memoryManageTool,
  historySearchTool,
  skillManageTool,
  skillViewTool,

  // ── Unified Files Tools ──
  ...filesTools,

  // ── Session Tools ──
  {
    name: 'session_list',
    description: 'List tracked sessions — both CLI (Claude Code) sessions and embedded subagent runs. Archived sessions (including auto-archived plan sessions) are hidden by default.',
    input_schema: {
      type: 'object',
      properties: {
        process_status: { type: 'string', enum: ['running', 'idle', 'stopped', 'error'], description: 'Filter by process status' },
        task_id: { type: 'string', description: 'Filter sessions for a specific task (supports ID prefix)' },
        runner: { type: 'string', enum: ['cli', 'embedded', 'all'], description: 'Filter by runner type. Default: all.' },
        include_triage: { type: 'boolean', description: 'Include triage/message-send-triage subagent sessions. Default: false — these are high-volume internal housekeeping runs.' },
        include_archived: { type: 'boolean', description: 'Include archived sessions (manually archived + auto-archived plan sessions). Default: false.' },
      },
    },
    async execute(params) {
      const runnerFilter = (params.runner as string) ?? 'all';
      const includeTriage = params.include_triage === true;
      const includeArchived = params.include_archived === true;
      const results: Array<Record<string, unknown>> = [];

      // Resolve task_id prefix to full ID (consistent with other tools)
      let resolvedTaskId: string | undefined;
      if (params.task_id) {
        try {
          const task = await getTask(params.task_id as string);
          resolvedTaskId = task.id;
        } catch {
          return `Error: No task found matching "${params.task_id}"`;
        }
      }

      // CLI sessions
      if (runnerFilter === 'all' || runnerFilter === 'cli') {
        const sessions = resolvedTaskId
          ? await getSessionsForTask(resolvedTaskId)
          : await listSessions();
        let filtered = sessions.filter((s) => s.provider !== 'embedded');
        if (!includeArchived) {
          filtered = filtered.filter((s) => !s.archived);
        }
        if (params.process_status) {
          filtered = filtered.filter((s) => s.process_status === params.process_status);
        }
        for (const s of filtered) {
          results.push({
            session_id: s.claudeSessionId,
            runner: 'cli',
            title: s.title,
            project: s.project,
            process_status: s.process_status,
            mode: s.mode,
            activity: s.activity,
            task_id: s.taskId,
            started: s.startedAt,
            last_active: s.lastActiveAt,
            message_count: s.messageCount,
            ...(s.archived ? { archived: true, archive_reason: s.archive_reason } : {}),
          });
        }
      }

      // Embedded subagent runs
      if (runnerFilter === 'all' || runnerFilter === 'embedded') {
        try {
          const { subagentRunner } = await import('../providers/subagent-runner.js');
          let runs = subagentRunner.getAllRuns();
          if (!includeTriage) {
            runs = runs.filter((r) => !TRIAGE_AGENTS.has(r.agentId));
          }
          if (resolvedTaskId) {
            runs = runs.filter((r) => r.taskId === resolvedTaskId);
          }
          if (params.process_status) {
            runs = runs.filter((r) => r.status === params.process_status);
          }
          for (const r of runs) {
            results.push({
              run_id: r.runId,
              runner: 'embedded',
              agent_id: r.agentId,
              task: r.task.slice(0, 200),
              status: r.status,
              task_id: r.taskId,
              started: r.startedAt,
              completed: r.completedAt,
            });
          }
        } catch {
          // SubagentRunner may not be initialized
        }
      }

      if (results.length === 0) return 'No sessions found.';
      return json(results);
    },
  },

  {
    name: 'session_summary',
    description: 'Get summaries of recent Claude Code sessions from markdown files.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max number of summaries to return (default 5)' },
      },
    },
    async execute(params) {
      const limit = (params.limit as number) ?? 5;
      const summaries = await getSessionSummaries(limit);
      if (summaries.length === 0) return 'No session summaries found.';
      return json(summaries);
    },
  },

  // ── Session Management Tools ──
  {
    name: 'session_start',
    description: `Start a NEW persistent Claude Code session that runs in the BACKGROUND. Results appear in the session panel, NOT in this conversation. A task_id, title, and prompt are required.

USE FOR: Code implementation, debugging, multi-round coding, anything needing task tracking
or persistent conversation history — work that lives in the session panel.

DO NOT USE FOR: Quick research, one-shot file analysis, or codebase investigation where you
need the answer back in THIS conversation — use subagent_create instead.

Key difference:
  session_start    → runs in BACKGROUND, results in the session panel (async, needs a task)
  subagent_create  → result comes back INLINE to this conversation (sync, no task needed)

Each task allows exactly ONE session — ever. If the task already has a session (active, stopped,
or completed), this tool returns a BLOCKED response. Use session_send to continue in the
existing session, or create a child task (task_create with parent_task_id) for a fresh session.

Per-host concurrency limits: Each host (local or remote) has a maximum number of
concurrent CLI sessions (default: local=7, remote=20, configurable via session_limits
in config.yaml). If the limit is reached, this tool returns a BLOCKED response listing
the running sessions on that host.

For CLI sessions: working_directory is required. For embedded sessions: working_directory is not needed.

Remote execution (SSH):
Sessions can run on remote machines. You usually do NOT need to set host or working_directory —
most projects already have defaults configured (default_host, default_cwd).
Just call session_start with task_id, title, and prompt, and the correct machine is picked automatically.

Only pass host/working_directory explicitly when:
- The user specifically asks to run on a different machine
- You have a good reason to override the project default

Override priority: explicit params > task cwd > project defaults > local.

Three ways to use:

1. Normal session:
   session_start({ task_id, title, prompt, working_directory })
   → Full-capability session that can read, write, and execute.

2. Plan-only session:
   session_start({ task_id, title, prompt, working_directory, mode: 'plan' })
   → Read-only session. Claude explores the codebase, designs an approach,
     writes a plan file, and calls ExitPlanMode when done. Cannot edit files.
   → When plan completes, use the UI execute buttons to run the plan.

3. Fork session:
   session_start({ task_id, title, prompt, fork_session_id: "existing-session-id" })
   → Creates a new session with the source session's full conversation context.
   → Inherits working_directory, host, and mode from the source session.
   → Use when a session scope-creeps and you want to branch to a new task.

PREFER session_send over session_start for follow-up work. session_send
preserves the full conversation history and codebase context, has no slot limits,
and is always allowed.`,
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID or prefix. Required — every session must be linked to a task. Create one with task_create first if needed.' },
        title: { type: 'string', description: 'Short human-readable title for this session (e.g. "Fix login validation", "Add API endpoint"). Required.' },
        prompt: { type: 'string', description: 'Prompt/message to send. Required.' },
        working_directory: { type: 'string', description: 'Absolute path to working directory (required for CLI sessions). For remote sessions, this is the path on the remote machine. If not specified, uses project defaults (see task_update type=\'project\').' },
        host: { type: 'string', description: 'SSH host alias for remote execution (matches keys in config.hosts). If not specified, uses the project default_host from project settings. Pass "local" (or an empty string) to force local execution and skip project default_host inheritance.' },
        mode: { type: 'string', enum: SESSION_MODE_ENUM, description: SESSION_MODE_DESC },
        fork_session_id: { type: 'string', description: 'Fork from an existing session: copies its conversation context into a new session on a different task. When set, working_directory/host/mode are inherited from the source session and must NOT be provided.' },
        runner: { type: 'string', enum: ['embedded', 'cli'], description: "Runner type. 'cli' = Claude Code process (default if no agent_id). 'embedded' = in-process subagent (default if agent_id is set)." },
        agent_id: { type: 'string', description: 'Agent definition ID (e.g. "general", "researcher"). For embedded runs. Defaults to "general".' },
        model: { type: 'string', description: 'Model override for this run.' },
        denied_tools: { type: 'array', items: { type: 'string' }, description: 'Extra tools to deny for this run.' },
        context: { type: 'string', description: 'Extra context to include in the subagent system prompt.' },
      },
      required: ['task_id', 'title', 'prompt'],
    },
    async execute(params) {
      try {
        const agentId = params.agent_id as string | undefined;
        const runner = (params.runner as string) ?? (agentId ? 'embedded' : 'cli');
        const taskId = params.task_id as string | undefined;

        // Resolve task if provided
        let task = null;
        if (taskId) {
          task = await getTask(taskId);
          if (task.phase === 'COMPLETE') {
            return `Error: Task "${task.title}" is already complete.`;
          }
          // Soft warning if task has incomplete dependencies
          if (task.depends_on?.length) {
            const allTasks = await listTasks({});
            if (isTaskBlocked(task, allTasks)) {
              // Informational only — does not block session start
              log.agent.info('starting session for blocked task', { taskId: task.id });
            }
          }
        }

        // ── Strict 1-session-per-task: block if task already has a non-archived session ──
        if (task) {
          const allSessions = await getSessionsForTask(task.id);
          // Skip triage sessions — they are short-lived housekeeping runs that should
          // never block new CLI sessions. Also skip archived sessions.
          const nonArchived = allSessions.filter(s => !s.archived && !isEnvironmentSession(s));

          // Auto-archive terminal sessions (stopped/error) to free the slot.
          // This preserves the strict 1-session rule while letting new sessions
          // start after old ones finish or fail.
          const terminal = nonArchived.filter(s =>
            s.process_status === 'stopped' || s.process_status === 'error'
          );
          if (terminal.length > 0) {
            const { clearSessionSlot } = await import('../core/task-manager.js');
            for (const s of terminal) {
              await updateSessionRecord(s.claudeSessionId, {
                archived: true,
                archive_reason: 'auto_cleared_for_new_session',
              });
              if (s.taskId) {
                try { await clearSessionSlot(s.taskId, s.claudeSessionId); } catch { /* best-effort */ }
              }
              log.agent.info('auto-archived terminal session to free task slot', {
                sessionId: s.claudeSessionId, taskId: task.id,
                process_status: s.process_status,
              });
            }
          }

          // After auto-archiving, check if any alive sessions remain
          const alive = nonArchived.filter(s =>
            s.process_status !== 'stopped' && s.process_status !== 'error'
          );
          if (alive.length > 0) {
            const latest = alive[alive.length - 1];
            return json({
              blocked: true,
              reason: 'Task already has a session. Each task allows only ONE session (strict enforcement).',
              session_ids: alive.map(s => s.claudeSessionId),
              existing_session: {
                session_id: latest.claudeSessionId,
                title: latest.title,
                process_status: latest.process_status,
              },
              hint: `Use session_send({ session_id: "${latest.claudeSessionId}", message: "..." }) to continue in the existing session, or create a new task / subtask with task_create({ parent_task_id: "${task.id}", title: "..." }) for a fresh session.`,
            });
          }
          // Fallback: check task.session_ids for IDs not in the session store
          // (e.g. linked via linkSession but never created as a full record)
          const storeIds = new Set(allSessions.map(s => s.claudeSessionId));
          const orphanIds = (task.session_ids ?? []).filter(sid => sid && !storeIds.has(sid));
          if (orphanIds.length > 0) {
            const latestId = orphanIds[orphanIds.length - 1];
            return json({
              blocked: true,
              reason: 'Task already has a session. Each task allows only ONE session (strict enforcement).',
              session_ids: orphanIds,
              existing_session: null,
              hint: `Use session_send({ session_id: "${latestId}", message: "..." }) to continue in the existing session, or create a new task / subtask with task_create({ parent_task_id: "${task.id}", title: "..." }) for a fresh session.`,
            });
          }
        }

        const prompt = (params.prompt as string) ?? (task ? `Working on task: ${task.title}` : 'Please help.');

        // ── Fork session flow ──
        const forkSessionId = params.fork_session_id as string | undefined;
        if (forkSessionId) {
          // Validate mutual exclusivity: fork inherits everything from source
          const conflicting = ['working_directory', 'host', 'mode'].filter(k => params[k]);
          if (conflicting.length > 0) {
            return `Error: fork_session_id is mutually exclusive with ${conflicting.join(', ')}. These are inherited from the source session.`;
          }
          if (runner === 'embedded') {
            return `Error: fork_session_id only works with CLI sessions (not embedded runners).`;
          }

          // Look up source session
          const { getSessionByClaudeId } = await import('../core/session-tracker.js');
          const sourceSession = await getSessionByClaudeId(forkSessionId);
          if (!sourceSession) {
            return `Error: Source session "${forkSessionId}" not found.`;
          }

          // Read and format source session history for context injection
          const { readSessionHistory, formatForkHistory } = await import('../core/session-history.js');
          const sourceMessages = await readSessionHistory(
            forkSessionId, sourceSession.cwd, sourceSession.host, sourceSession.outputFile,
          );
          let forkContext = '';
          if (sourceMessages.length > 0) {
            const historyText = formatForkHistory(sourceMessages);
            forkContext = `<forked_session_context>\nThis session was forked from session ${forkSessionId}.\nBelow is the conversation history from the source session:\n\n${historyText}\n</forked_session_context>`;
          }

          // Inherit host, cwd, mode from source session
          const forkHost = sourceSession.host;
          const forkCwd = sourceSession.cwd;
          const forkMode = sourceSession.mode !== 'default' ? sourceSession.mode : undefined;

          if (!forkCwd) {
            return `Error: Source session "${forkSessionId}" has no working directory — cannot fork.`;
          }

          // Per-host concurrency check
          {
            const config = await getConfig();
            const limitResult = await checkSessionLimit(forkHost, config.session_limits, config.session);
            if (!limitResult.allowed) return buildSessionLimitBlocked(forkHost, limitResult);
          }

          const { sessionRunner } = await import('../providers/claude-code-session.js');
          const sessionResult = await sessionRunner.startSession({
            taskId: task?.id ?? '',
            message: prompt,
            cwd: forkCwd,
            project: task?.project ?? '',
            mode: forkMode,
            model: (params.model as string | undefined) ?? sourceSession.model,
            title: params.title as string | undefined,
            host: forkHost,
            appendSystemPrompt: forkContext || undefined,
            forkedFromSessionId: forkSessionId,
          });

          const sRef = sessionRef(sessionResult.claudeSessionId, sessionResult.title);
          const hostNote = forkHost ? ` on ${forkHost}` : '';
          const forkNote = ` (forked from ${forkSessionId.slice(0, 16)}...)`;
          if (task) {
            // One work item = one link: the task ref opens the chat column, so no session ref here.
            return `Started work on ${taskRef(task.id, task.title)}${hostNote}${forkNote}. Running in background.`;
          }
          return `CLI session ${sRef} started${hostNote}${forkNote}. Running in background.`;
        }

        if (runner === 'embedded') {
          // Dispatch to SubagentRunner
          bus.emit(EventNames.SUBAGENT_START, {
            agentId: agentId ?? 'general',
            task: prompt,
            taskId: task?.id,
            model: params.model as string | undefined,
            deniedTools: params.denied_tools as string[] | undefined,
            context: params.context as string | undefined,
          }, ['subagent-runner'], { source: 'agent' });

          const agentLabel = agentId ?? 'general';
          const embeddedTaskPart = task ? ` for task ${taskRef(task.id, task.title)}` : '';
          return `Embedded session started (agent: ${agentLabel})${embeddedTaskPart}. Running in background.`;
        }

        // CLI runner — resolve host and cwd via shared resolution chain
        let { resolvedHost, resolvedCwd, hostSource, cwdSource } = await resolveSessionContext(
          task,
          params.host as string | null | undefined,
          params.working_directory as string | undefined,
        );

        // Validate: remote sessions MUST have a cwd
        if (resolvedHost && !resolvedCwd) {
          return `Error: Remote host "${resolvedHost}" specified but no working directory. Set working_directory or configure via task_update(type:'project', ...).`;
        }

        // Local-looking paths can never run on a remote host. Arbitration: the more
        // specific source wins. A cwd given explicitly (param) or set on the task beats
        // a host that was merely INHERITED from the project default → run locally.
        // Only a genuinely explicit host param, or a self-contradictory project config
        // (remote default_host + local default_cwd), remains an error.
        // (Runs before the config.hosts check — a dropped host needn't exist in config.)
        if (resolvedHost && resolvedCwd && /^\/Users\//.test(resolvedCwd)) {
          if (hostSource === 'project' && (cwdSource === 'param' || cwdSource === 'task')) {
            log.agent.info('session_start: local cwd overrides inherited project default_host — running locally', {
              taskId: task?.id, project: task?.project, cwd: resolvedCwd, droppedHost: resolvedHost, cwdSource,
            });
            resolvedHost = undefined;
            hostSource = 'none';
          } else if (hostSource === 'param') {
            return `Error: Local path "${resolvedCwd}" cannot be used on remote host "${resolvedHost}" (explicit host param). ` +
              `The cwd must exist on the remote machine. Either:\n` +
              `  1. Provide a remote path as working_directory (e.g. /workplace/...)\n` +
              `  2. Pass host: "local" to run on this machine instead of "${resolvedHost}"`;
          } else {
            // Both host and cwd inherited from the project — the project config contradicts itself.
            return `Error: Project "${task?.project}" config is self-contradictory: default_host "${resolvedHost}" is remote but default_cwd "${resolvedCwd}" is a local Mac path. ` +
              `Fix the project settings:\n` +
              `  1. If this project runs locally: task_update(type:'project', project:'${task?.project}', default_host:'') to clear the host\n` +
              `  2. If it runs on "${resolvedHost}": task_update(type:'project', project:'${task?.project}', default_cwd:'/remote/path')\n` +
              `Or override for this session only: pass host: "local" or a remote working_directory.`;
          }
        }

        // Validate host exists in config
        if (resolvedHost) {
          const config = await getConfig();
          if (!config.hosts?.[resolvedHost]) {
            return `Error: Unknown host "${resolvedHost}". Configure it in config.yaml under hosts.${resolvedHost}`;
          }
        }

        // Local sessions still require a cwd — give actionable guidance
        if (!resolvedCwd) {
          const hint = task
            ? task.project
              ? ` Set working_directory explicitly, or configure a default via task_update(id:'${task.id}', cwd:'/path') or task_update(type:'project', project:'${task.project}', default_cwd:'/path').`
              : ` Set working_directory explicitly, or configure a default via task_update(id:'${task.id}', cwd:'/path'). This task is in Inbox, so there is no project default to set.`
            : ' Provide working_directory for taskless sessions.';
          return `Error: No working directory resolved for this session.${hint}`;
        }

        // ── Per-host session concurrency limit check ──
        {
          const config = await getConfig();
          const limitResult = await checkSessionLimit(resolvedHost, config.session_limits, config.session);
          if (!limitResult.allowed) return buildSessionLimitBlocked(resolvedHost, limitResult);
        }

        const { sessionRunner } = await import('../providers/claude-code-session.js');
        const sessionResult = await sessionRunner.startSession({
          taskId: task?.id ?? '',
          message: prompt,
          cwd: resolvedCwd,
          project: task?.project ?? '',
          mode: params.mode as string | undefined,
          model: params.model as string | undefined,
          title: params.title as string | undefined,
          host: resolvedHost,
        });

        const sRef = sessionRef(sessionResult.claudeSessionId, sessionResult.title);
        const hostNote = resolvedHost ? ` on ${resolvedHost}` : '';
        if (task) {
          // One work item = one link: the task ref opens the chat column, so no session ref here.
          return `Started work on ${taskRef(task.id, task.title)}${hostNote}. Running in background.`;
        }
        return `Taskless CLI session ${sRef} started${hostNote}. Running in background.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'session_import',
    description: `Import an external Claude Code session into Walnut (backfill). Use this to bring
sessions started outside Walnut (e.g. via \`claude -p\` on a remote machine) under full Walnut
management — history viewing, session_send, UI tracking, etc.

The session must already exist as a JSONL file on the local or remote machine.
host and working_directory are optional — if omitted, they inherit from the task's project
defaults (same resolution chain as session_start).`,
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude Code session UUID to import.' },
        task_id: { type: 'string', description: 'Task ID or prefix to associate this session with.' },
        working_directory: { type: 'string', description: 'Working directory where the session ran. Optional — inherits from task/project defaults if omitted.' },
        host: { type: 'string', description: 'SSH host alias where the session ran. Optional — inherits from project default_host if omitted. Omit for local sessions.' },
        title: { type: 'string', description: 'Custom title. If omitted, extracted from the first user message in the JSONL.' },
      },
      required: ['session_id', 'task_id'],
    },
    async execute(params) {
      try {
        const sessionId = params.session_id as string;
        const taskIdPrefix = params.task_id as string;

        // ① Resolve task
        const task = await getTask(taskIdPrefix);

        // ①b Strict 1-session-per-task: block if task already has a non-archived session
        // Skip environment sessions (triage, hook, cron, embedded subagent) — they never occupy a user slot.
        const existingSessions = await getSessionsForTask(task.id);
        const nonArchived = existingSessions.filter(s => !s.archived && !isEnvironmentSession(s));

        // Auto-archive terminal sessions (stopped/error) to free the slot — same logic as session_start
        const { clearSessionSlot } = await import('../core/task-manager.js');
        for (const s of nonArchived.filter(s => s.process_status === 'stopped' || s.process_status === 'error')) {
          await updateSessionRecord(s.claudeSessionId, {
            archived: true,
            archive_reason: 'auto_cleared_for_import',
          });
          if (s.taskId) {
            try { await clearSessionSlot(s.taskId, s.claudeSessionId); } catch { /* best-effort */ }
          }
        }

        // Block only if alive user sessions remain
        const alive = nonArchived.filter(s => s.process_status !== 'stopped' && s.process_status !== 'error');
        if (alive.length > 0) {
          const latest = alive[alive.length - 1];
          return `Error: Task ${task.id} already has a session (${latest.claudeSessionId}). Each task allows only ONE session. ` +
            `Use session_send to interact with the existing session, or create a subtask for a new session.`;
        }

        // ② Check if session is already tracked
        const existing = await getSessionByClaudeId(sessionId);
        if (existing) {
          return `Error: Session ${sessionId} is already tracked (task: ${existing.taskId}). Use session_send to interact with it.`;
        }

        // ③ Resolve host/cwd via shared inheritance chain (CWD is tentative — may be corrected by JSONL truth)
        let { resolvedHost, resolvedCwd } = await resolveSessionContext(
          task,
          params.host as string | undefined,
          params.working_directory as string | undefined,
        );

        // ④ Validate host exists in config (if resolved)
        if (resolvedHost) {
          const config = await getConfig();
          if (!config.hosts?.[resolvedHost]) {
            return `Error: Unknown host "${resolvedHost}". Configure it in config.yaml under hosts.${resolvedHost}`;
          }
        }

        // ⑤ Locate JSONL — try canonical path first, then fallback search.
        //    resolvedCwd is used to compute the canonical path, but may be wrong.
        //    After finding the JSONL, we extract the actual CWD from it (source of truth)
        //    and reconcile against resolvedCwd / task.cwd.
        const { remoteJsonlPath, encodeProjectPath } = await import('../core/session-file-reader.js');

        if (!resolvedCwd) {
          return `Error: No working directory resolved for session ${sessionId}. Provide working_directory explicitly.`;
        }

        let jsonlContent: string | null = null;

        // Daemon-uniform: local (__local__) and remote both go through DaemonFileReader.
        // Try the canonical tilde path first, then fall back to findSession (daemon fs.find
        // over ~/.claude/projects). One code path — no separate local fs branch.
        {
          const { DaemonFileReader } = await import('../core/daemon-file-reader.js');
          const daemonHost = resolvedHost ?? '__local__';
          const reader = new DaemonFileReader(daemonHost);
          const exactPath = remoteJsonlPath(sessionId, resolvedCwd);
          jsonlContent = await reader.readFile(exactPath);
          if (!jsonlContent) {
            // Canonical path missed — try `find` via the daemon.
            // findSession returns { content, path } (or null), not a raw string.
            const found = await reader.findSession(sessionId);
            if (found) {
              jsonlContent = found.content;
              log.session.info('import_session: JSONL found via daemon find fallback', {
                sessionId, host: daemonHost, triedPath: exactPath, foundPath: found.path,
              });
            }
          }
          if (!jsonlContent) {
            const encoded = encodeProjectPath(resolvedCwd);
            return `Error: JSONL not found for session ${sessionId}.\n` +
              `  Searched on: ${resolvedHost ?? 'local machine'}\n` +
              `  Tried canonical: ~/.claude/projects/${encoded}/${sessionId}.jsonl\n` +
              `  Also ran: find ~/.claude/projects -name '${sessionId}.jsonl'\n` +
              `  CWD used: ${resolvedCwd}\n` +
              `The session JSONL may be on a different host, or the CWD may be wrong.`;
          }
        }

        // ⑥ Extract metadata from JSONL
        const lines = jsonlContent.split('\n').filter(Boolean);
        let firstTimestamp: string | undefined;
        let lastTimestamp: string | undefined;
        let messageCount = 0;
        let extractedTitle: string | undefined;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            // Count user and assistant messages
            if (entry.type === 'human' || entry.type === 'assistant' || entry.role === 'user' || entry.role === 'assistant') {
              messageCount++;
            }
            // Extract timestamps
            const ts = entry.timestamp || entry.createdAt;
            if (ts) {
              if (!firstTimestamp) firstTimestamp = ts;
              lastTimestamp = ts;
            }
            // Extract title from first user message
            if (!extractedTitle && (entry.type === 'human' || entry.role === 'user')) {
              const text = typeof entry.message === 'string' ? entry.message
                : entry.message?.content?.[0]?.text
                || entry.content?.[0]?.text
                || (typeof entry.content === 'string' ? entry.content : undefined);
              if (text) {
                extractedTitle = text.slice(0, 80).replace(/\n/g, ' ');
              }
            }
          } catch { /* skip malformed lines */ }
        }

        const title = (params.title as string) || extractedTitle || `Imported session ${sessionId.slice(0, 8)}`;

        // ⑥b Extract actual CWD from JSONL (source of truth)
        const { extractCwdFromJsonlContent } = await import('../core/session-file-reader.js');
        const jsonlCwd = extractCwdFromJsonlContent(jsonlContent);
        const cwdWarnings: string[] = [];

        if (jsonlCwd) {
          // JSONL CWD is the ground truth — reconcile everything against it
          if (resolvedCwd && resolvedCwd !== jsonlCwd) {
            cwdWarnings.push(`CWD corrected: "${resolvedCwd}" → "${jsonlCwd}" (from session JSONL)`);
          }
          // Also fix task.cwd if it doesn't match
          if (task.cwd && task.cwd !== jsonlCwd) {
            const { updateTask } = await import('../core/task-manager.js');
            await updateTask(task.id, { cwd: jsonlCwd });
            cwdWarnings.push(`Task CWD updated: "${task.cwd}" → "${jsonlCwd}"`);
          } else if (!task.cwd) {
            const { updateTask } = await import('../core/task-manager.js');
            await updateTask(task.id, { cwd: jsonlCwd });
            cwdWarnings.push(`Task CWD set to "${jsonlCwd}" (was empty)`);
          }
          resolvedCwd = jsonlCwd;
        } else {
          // JSONL has no CWD — can't verify, use resolved value but warn
          cwdWarnings.push(`JSONL has no CWD field — using resolved value "${resolvedCwd}". Verify manually.`);
          if (!resolvedCwd) {
            return `Error: Cannot determine CWD for session ${sessionId}. ` +
              `JSONL has no CWD, no working_directory passed, no task/project CWD configured. ` +
              `Pass working_directory explicitly.`;
          }
        }

        // ⑦ Create SessionRecord (stopped — no running process)
        const record = await importSessionRecord({
          claudeSessionId: sessionId,
          taskId: task.id,
          project: task.project || '',
          cwd: resolvedCwd,
          host: resolvedHost,
          title,
          startedAt: firstTimestamp,
          lastActiveAt: lastTimestamp,
          messageCount,
        });

        // ⑧ Link to task
        const { linkSession } = await import('../core/task-manager.js');
        await linkSession(task.id, sessionId);

        // ⑨ Emit task updated event
        bus.emit(EventNames.TASK_UPDATED, { taskId: task.id }, [], { source: 'agent' });

        // ⑩ Return success + CWD warnings
        const sRef = sessionRef(record.claudeSessionId, record.title ?? title);
        const hostNote = resolvedHost ? ` (${resolvedHost})` : '';
        const cwdNote = resolvedCwd ? ` cwd=${resolvedCwd}` : '';
        const warningBlock = cwdWarnings.length > 0
          ? '\n' + cwdWarnings.map(w => `⚠️ ${w}`).join('\n')
          : '';
        return `Imported session ${sRef}${hostNote}${cwdNote} → task ${taskRef(task.id, task.title)}. Messages: ${messageCount}.${warningBlock}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'session_send',
    description: 'Resume an existing session with a follow-up message. PREFERRED over session_start for follow-up work — preserves full conversation history and codebase context, no slot limits. Provide session_id (for CLI) or run_id (for embedded). Runs in the background. Use mode to override permissions on resume (e.g. "bypass").',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session ID to resume (for CLI sessions)' },
        run_id: { type: 'string', description: 'Subagent run ID to resume (for embedded sessions)' },
        message: { type: 'string', description: 'Message to send to the session' },
        mode: { type: 'string', enum: SESSION_MODE_ENUM, description: `Override permission mode for this resume. ${SESSION_MODE_DESC}` },
        interrupt: { type: 'boolean', description: 'Stop the running session turn and send this message as a fresh turn. Use when the session is going in the wrong direction.' },
      },
      required: ['message'],
    },
    async execute(params) {
      try {
        const sessionId = params.session_id as string | undefined;
        const runId = params.run_id as string | undefined;
        const message = params.message as string;
        const mode = params.mode as string | undefined;
        const interrupt = params.interrupt as boolean | undefined;

        if (runId) {
          // Resume an embedded subagent run
          bus.emit(EventNames.SUBAGENT_SEND, {
            runId,
            message,
          }, ['subagent-runner'], { source: 'agent' });

          // Notify UI so the message appears in the session panel
          // (same as the CLI path — source: 'agent' so SessionChatHistory
          // picks it up via onAgentQueued)
          bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
            sessionId: runId,
            messageId: `emb-${Date.now()}`,
            message,
            source: 'agent',
          }, ['main-ai'], { source: 'agent' });

          return `Message sent to embedded run ${runId.slice(0, 16)}... Resuming in the background. Results will arrive asynchronously.`;
        }

        if (sessionId) {
          const { sendMessageToSession } = await import('../core/session-message-queue.js');
          const record = await getSessionByClaudeId(sessionId);

          // Pre-flight: reject resume on sessions that were auto-archived because
          // Claude CLI lost their conversation JSONL on the remote host (clouddev
          // cleanup, repo re-clone, etc.). Retrying --resume will just fail again;
          // the caller should start a fresh session instead.
          if (record?.archived && record?.archive_reason === 'remote_conversation_lost') {
            const hostNote = record.host ? ` on host "${record.host}"` : '';
            const cwdNote = record.cwd ? ` (cwd: ${record.cwd})` : '';
            return `Error: Session ${sessionId.slice(0, 16)}...${hostNote} was auto-archived because its remote conversation was lost${cwdNote}. The remote JSONL file no longer exists, so --resume cannot recover it. Start a fresh session with session_start (same task_id, cwd, host) instead of resuming.`;
          }
          await sendMessageToSession(sessionId, message, {
            source: 'agent',
            taskId: record?.taskId,
            mode,
            interrupt: interrupt || undefined,
          });
          const sessionLabel = record?.title ?? sessionId.slice(0, 16);
          const sRef = sessionRef(sessionId, sessionLabel);

          // Unconditional phase transition: session input → IN_PROGRESS
          if (record?.taskId) {
            try {
              const { applySessionPhase } = await import('../core/phase.js');
              await applySessionPhase(record.taskId, 'session:input', 'tools.ts:send-to-session', { sessionId });
            } catch (err) {
              log.agent.warn('session_send: phase update failed', { taskId: record.taskId, error: err instanceof Error ? err.message : String(err) });
            }
          }

          const modeNote = mode ? ` (mode: ${mode})` : '';
          const interruptNote = interrupt ? ' (interrupted running turn)' : '';
          return `Message sent to session ${sRef}${modeNote}${interruptNote}. Resuming in background.`;
        }

        return 'Error: Provide either session_id (CLI) or run_id (embedded).';
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'session_history',
    description: 'Read the conversation history of a session. Default overview: each message prefixed with [index] and truncated to 500 chars. Use role to filter, index to drill into a specific message with full text + tool results.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session ID (for CLI sessions)' },
        run_id: { type: 'string', description: 'Subagent run ID (for embedded sessions)' },
        role: { type: 'string', enum: ['user', 'assistant'], description: 'Filter messages by role (default: all)' },
        index: { type: 'number', description: 'Return full content of message at this 0-based index, including complete tool inputs and results' },
        include_tool_output: { type: 'boolean', description: 'In overview mode, include first 200 chars of each tool result (default: false)' },
        plan_only: { type: 'boolean', description: 'Return only the plan content from this session (lightweight — skips full history parsing)' },
        page_size: { type: 'number', description: 'Messages per page for reverse pagination. Page 1 = most recent messages.' },
        page: { type: 'number', description: '1-based page number from newest. Requires page_size.' },
        summarize: { type: 'boolean', description: 'Invoke the configured summarizer agent to analyze the session and update the linked task (uses agent.session_summarizer_agent from config)' },
      },
    },
    async execute(params) {
      try {
        const runId = params.run_id as string | undefined;

        if (runId) {
          // Embedded subagent run history — no new modes apply
          const { subagentRunner } = await import('../providers/subagent-runner.js');
          const run = subagentRunner.getRun(runId);
          if (!run) return `No run found for ID: ${runId}`;
          return json({
            run_id: run.runId,
            agent_id: run.agentId,
            status: run.status,
            task: run.task,
            result: run.result?.slice(0, 4000),
            error: run.error,
            usage: run.usage,
            started: run.startedAt,
            completed: run.completedAt,
          });
        }

        const sessionId = params.session_id as string | undefined;
        if (!sessionId) return 'Error: Provide either session_id or run_id.';

        const planOnly = params.plan_only as boolean | undefined;
        const pageSize = params.page_size as number | undefined;
        const page = params.page as number | undefined;
        const summarize = params.summarize as boolean | undefined;
        const roleFilter = params.role as 'user' | 'assistant' | undefined;
        const drillIndex = params.index as number | undefined;
        const includeToolOutput = params.include_tool_output as boolean | undefined;

        // Validate mutual exclusivity
        if (planOnly && summarize) {
          return 'Error: plan_only and summarize are mutually exclusive.';
        }
        if (page !== undefined && pageSize === undefined) {
          return 'Error: page requires page_size.';
        }
        if ((planOnly || summarize) && pageSize !== undefined) {
          return 'Error: plan_only/summarize cannot be combined with pagination.';
        }
        if (pageSize !== undefined && pageSize < 1) {
          return 'Error: page_size must be >= 1.';
        }
        if (page !== undefined && page < 1) {
          return 'Error: page must be >= 1.';
        }

        const record = await getSessionByClaudeId(sessionId);

        // ── plan_only: lightweight plan extraction ──
        if (planOnly) {
          const { extractPlanContent } = await import('../core/session-history.js');
          const plan = await extractPlanContent(sessionId, record?.cwd, record?.host);
          if (!plan) {
            return 'No plan found in this session. The session may not have used ExitPlanMode or written to ~/.claude/plans/.';
          }
          return plan;
        }

        // ── summarize: delegate to configured agent ──
        if (summarize) {
          const { summarizeSession } = await import('./tools/session-summarizer.js');
          return await summarizeSession(sessionId, record ?? null);
        }

        // ── drill-in: full content of a specific message ──
        if (drillIndex !== undefined) {
          const { readSessionHistory } = await import('../core/session-history.js');
          const allMessages = await readSessionHistory(sessionId, record?.cwd, record?.host, record?.outputFile);
          if (drillIndex < 0 || drillIndex >= allMessages.length) {
            return `Error: index ${drillIndex} out of range (0-${allMessages.length - 1}).`;
          }
          const m = allMessages[drillIndex];
          const MAX_DRILL_CHARS = 20_000;
          return json({
            index: drillIndex,
            role: m.role,
            text: m.text.slice(0, MAX_DRILL_CHARS),
            timestamp: m.timestamp,
            tools: m.tools?.map(t => ({
              name: t.name,
              input: t.input,
              result: t.result?.slice(0, MAX_DRILL_CHARS),
            })),
            thinking: m.thinking?.slice(0, 2000),
            total_messages: allMessages.length,
          });
        }

        // ── pagination: reverse-paginated history ──
        if (pageSize !== undefined) {
          const { readSessionHistoryPaginated } = await import('../core/session-history.js');
          const result = await readSessionHistoryPaginated(sessionId, record?.cwd, {
            pageSize,
            page: page ?? 1,
          }, record?.host, record?.outputFile);

          if (result.messages.length === 0 && result.pagination.total === 0) {
            return 'No history found for this session.';
          }

          // Apply budget truncation to the page
          const MAX_PAGE_CHARS = 80_000;
          const totalChars = result.messages.reduce((sum, m) => sum + m.text.length, 0);

          return json({
            messages: result.messages.map(m => {
              let text = m.text;
              if (totalChars > MAX_PAGE_CHARS && m.text.length > 500) {
                const budget = Math.max(500, Math.floor((m.text.length / totalChars) * MAX_PAGE_CHARS));
                if (m.text.length > budget) {
                  text = m.text.slice(0, budget) + `\n... [truncated, ${m.text.length} chars total]`;
                }
              }
              return {
                role: m.role,
                text,
                tools: m.tools?.map(t => t.name),
                timestamp: m.timestamp,
              };
            }),
            pagination: result.pagination,
          });
        }

        // ── default: overview with [index] prefix, role filter, budget truncation ──
        const { readSessionHistory } = await import('../core/session-history.js');
        const messages = await readSessionHistory(sessionId, record?.cwd, record?.host, record?.outputFile);

        if (messages.length === 0) {
          return 'No history found for this session.';
        }

        // Apply role filter (preserve original indices)
        const indexed = messages.map((m, i) => ({ ...m, originalIndex: i }));
        const filtered = roleFilter
          ? indexed.filter(m => m.role === roleFilter)
          : indexed;

        if (filtered.length === 0) {
          return `No ${roleFilter} messages found in this session (${messages.length} total messages).`;
        }

        // Budget-based truncation: full text for short/medium sessions,
        // proportional allocation for very long ones (~20k tokens max)
        const MAX_TOTAL_CHARS = 80_000;
        const totalChars = filtered.reduce((sum, m) => sum + m.text.length, 0);

        return json(filtered.map(m => {
          let text = m.text;
          if (totalChars > MAX_TOTAL_CHARS && m.text.length > 500) {
            const budget = Math.max(500, Math.floor((m.text.length / totalChars) * MAX_TOTAL_CHARS));
            if (m.text.length > budget) {
              text = m.text.slice(0, budget) + `\n... [truncated, ${m.text.length} chars total]`;
            }
          }
          const entry: Record<string, unknown> = {
            index: m.originalIndex,
            role: m.role,
            text,
            tools: m.tools?.map(t => t.name),
            timestamp: m.timestamp,
          };
          // Include tool output snippets if requested
          if (includeToolOutput && m.tools?.length) {
            entry.tool_outputs = m.tools.map(t => ({
              name: t.name,
              result: t.result?.slice(0, 200),
            }));
          }
          return entry;
        }));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'session_update',
    description: 'Update a Claude Code session — title, activity, or archive state. Always set a descriptive title when a session lacks one or when the scope changes. ⚠️ NEVER set archived=true unless the user EXPLICITLY asks for it. Do NOT archive sessions proactively — even if they appear idle, error, or completed. The user may still be actively working on the task.',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session ID' },
        title: { type: 'string', description: 'Short title / one-sentence summary for the session' },
        activity: { type: 'string', description: 'Freetext activity description (e.g. "planning", "testing")' },
        cwd: { type: 'string', description: 'Override session working directory. Use to fix wrong CWD after import.' },
        task_id: { type: 'string', description: 'Move session to a different task (ID or prefix). Pass empty string "" to dissociate from current task entirely.' },
        archived: { type: 'boolean', description: '⚠️ NEVER set archived=true unless the user EXPLICITLY requests archiving. Do NOT archive sessions proactively — even if they appear idle, error, or completed. The user may still be actively working on the task. Archive (true) or unarchive (false) a session. Session must be stopped before archiving. Archived sessions free the task session slot.' },
        archive_reason: { type: 'string', description: 'Why this session is being archived (e.g. "wrong directory", "obsolete"). Optional.' },
      },
      required: ['session_id'],
    },
    async execute(params) {
      try {
        const sessionId = params.session_id as string;
        const title = params.title as string | undefined;
        const activity = params.activity as string | undefined;
        const newCwd = params.cwd as string | undefined;
        const newTaskId = params.task_id as string | undefined;
        const archived = params.archived as boolean | undefined;
        const archiveReason = params.archive_reason as string | undefined;

        // Handle archive/unarchive
        if (archived !== undefined) {
          const session = await getSessionByClaudeId(sessionId);
          if (!session) return `Error: Session not found: ${sessionId}`;

          if (archived) {
            if (session.process_status !== 'stopped' && session.process_status !== 'error') {
              return `Error: Stop session before archiving. Session ${sessionId} process is still alive (${session.process_status}).`;
            }
            const updated = await updateSessionRecord(sessionId, {
              archived: true,
              ...(archiveReason ? { archive_reason: archiveReason } : {}),
            });
            // Release task session slot
            if (session.taskId) {
              try {
                const { clearSession, clearSessionSlot } = await import('../core/task-manager.js');
                await clearSession(session.taskId, sessionId);
                await clearSessionSlot(session.taskId, sessionId);
              } catch { /* task may not exist */ }
            }
            emitSessionStatusChanged(updated, {}, ['*'], { source: 'agent' });
            const sRef = sessionRef(sessionId, session.title ?? sessionId.slice(0, 16));
            return `Session ${sRef} archived${archiveReason ? ` (${archiveReason})` : ''}. Task session slot freed — you can now start a new session for this task.`;
          } else {
            const updated = await updateSessionRecord(
              sessionId,
              { archived: false, archive_reason: undefined },
            );
            emitSessionStatusChanged(updated, {}, ['*'], { source: 'agent' });
            const sRef = sessionRef(sessionId, session.title ?? sessionId.slice(0, 16));
            return `Session ${sRef} unarchived.`;
          }
        }

        // Handle task_id change (dissociate or re-associate)
        if (newTaskId !== undefined) {
          const session = await getSessionByClaudeId(sessionId);
          if (!session) return `Error: Session not found: ${sessionId}`;
          if (session.process_status !== 'stopped') {
            return `Error: Stop session before changing task association. Session ${sessionId} is still ${session.process_status}.`;
          }

          const { clearSession, clearSessionSlot, linkSession } = await import('../core/task-manager.js');

          // Clear old task association
          const oldTaskId = session.taskId;
          if (oldTaskId) {
            try {
              await clearSession(oldTaskId, sessionId);
              await clearSessionSlot(oldTaskId, sessionId);
            } catch { /* old task may not exist */ }
            bus.emit(EventNames.TASK_UPDATED, { taskId: oldTaskId }, [], { source: 'agent' });
          }

          if (newTaskId === '') {
            // Dissociate from task entirely
            const updated = await updateSessionRecord(sessionId, { taskId: undefined });
            emitSessionStatusChanged(updated, {}, ['*'], { source: 'agent' });
            const sRef = sessionRef(sessionId, session.title ?? sessionId.slice(0, 16));
            return `Session ${sRef} dissociated from task. Session is now unlinked.`;
          } else {
            // Re-associate to a different task
            const newTask = await getTask(newTaskId);

            // Strict 1-session-per-task: block if target task already has a non-archived session
            const targetSessions = await getSessionsForTask(newTask.id);
            const targetActive = targetSessions.filter(s => !s.archived);
            if (targetActive.length > 0) {
              const latest = targetActive[targetActive.length - 1];
              return `Error: Target task ${newTask.id} already has a session (${latest.claudeSessionId}). Each task allows only ONE session. ` +
                `Use session_send to interact with the existing session, or create a subtask for a new session.`;
            }

            const updated = await updateSessionRecord(
              sessionId,
              { taskId: newTask.id, project: newTask.project },
            );
            await linkSession(newTask.id, sessionId);
            bus.emit(EventNames.TASK_UPDATED, { taskId: newTask.id }, [], { source: 'agent' });
            emitSessionStatusChanged(updated, {}, ['*'], { source: 'agent' });
            const sRef = sessionRef(sessionId, session.title ?? sessionId.slice(0, 16));
            return `Session ${sRef} moved to task ${taskRef(newTask.id, newTask.title)}.`;
          }
        }

        const updates: Record<string, unknown> = {};
        if (title !== undefined) updates.title = title;
        if (activity !== undefined) updates.activity = activity;
        if (newCwd !== undefined) updates.cwd = newCwd;

        if (Object.keys(updates).length === 0) {
          return 'Error: No updates provided. Specify title, activity, cwd, or task_id.';
        }

        // Look up session for the ref tag label (no prior fetch in this branch)
        const session = await getSessionByClaudeId(sessionId);
        if (!session) return `Error: Session not found: ${sessionId}`;
        const updated = await updateSessionRecord(sessionId, updates as Partial<SessionRecord>);
        if (activity !== undefined) {
          emitSessionStatusChanged(updated, {}, ['*'], { source: 'agent' });
        }
        const sRef = sessionRef(sessionId, title ?? session.title ?? sessionId.slice(0, 16));
        const parts = [];
        if (title) parts.push(`title="${title}"`);
        if (activity) parts.push(`activity="${activity}"`);
        if (newCwd) parts.push(`cwd="${newCwd}"`);
        return `Session ${sRef} updated: ${parts.join(', ')}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Config Tools ──
  {
    name: 'config_get',
    description: 'Read the current user configuration.',
    input_schema: {
      type: 'object',
      properties: {},
    },
    async execute() {
      const config = await getConfig();
      return json(config);
    },
  },

  {
    name: 'config_update',
    description: 'Update user configuration fields.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: { type: 'string', description: 'Update user name' },
        default_priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'], description: 'Default task priority' },
        default_project: { type: 'string', description: 'Default project for new tasks. Empty string = Inbox.' },
      },
    },
    async execute(params) {
      const config = await getConfig();
      const partial: Partial<Config> = {};
      if (params.user_name !== undefined) partial.user = { ...config.user, name: params.user_name as string };
      if (params.default_priority !== undefined || params.default_project !== undefined) {
        partial.defaults = {
          ...config.defaults,
          ...(params.default_priority !== undefined ? { priority: params.default_priority as TaskPriority } : {}),
          ...(params.default_project !== undefined ? { project: params.default_project as string } : {}),
        };
      }
      await updateConfig(partial);
      const updated = await getConfig();
      return `Config updated: ${json(updated)}`;
    },
  },

  // ── Exec Tool ──
  execTool,

  // ── Integration Tools ──
  slackTool,
  ttsTool,

  // ── Calendar Tools (external calendars via EventKit) ──
  ...calendarTools,

  // ── Web Tools ──
  webSearchTool,
  webFetchTool,

  // ── Routine (cron) Tools ──
  {
    name: 'cron_list',
    description: 'List all routines (scheduled jobs) with their status, schedule, executor, and last run info.',
    input_schema: {
      type: 'object',
      properties: {
        include_disabled: { type: 'boolean', description: 'Include disabled routines (default: false)' },
      },
    },
    async execute(params) {
      const { getCronService } = await import('../web/routes/cron.js');
      const service = getCronService();
      if (!service) return 'Cron service is not running.';
      const jobs = await service.list({ includeDisabled: params.include_disabled as boolean ?? false });
      if (jobs.length === 0) return 'No routines found.';
      return json(jobs.map((j) => ({
        id: j.id, name: j.name, enabled: j.enabled,
        schedule: j.schedule,
        executor: j.executor ?? { type: j.sessionTarget === 'main' ? 'main-agent' : 'walnut-agent' },
        wakeMode: j.wakeMode,
        ...(j.initProcessor ? { initProcessor: j.initProcessor } : {}),
        nextRunAtMs: j.state.nextRunAtMs,
        lastStatus: j.state.lastStatus,
        lastRunAtMs: j.state.lastRunAtMs,
        lastError: j.state.lastError,
      })));
    },
  },

  {
    name: 'cron_manage',
    description: 'Manage routines (scheduled jobs). Actions: add, update, remove, toggle (enable/disable), run (manual trigger), status (scheduler info). A routine = schedule + executor. Executor types: "main-agent" (inject instructions into the Personal AI conversation), "walnut-agent" (isolated in-process agent run), "claude-code" (start a real Claude Code session — config needs cwd, optional host alias for remote / omit for local, optional model).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'toggle', 'run', 'status'], description: 'The action to perform' },
        job_id: { type: 'string', description: 'Routine ID (required for update, remove, toggle, run)' },
        name: { type: 'string', description: 'Routine name (for add/update)' },
        description: { type: 'string', description: 'Routine description (for add/update)' },
        schedule: { type: 'object', description: 'Schedule config: { kind: "at"|"every"|"cron", at?: string, everyMs?: number, expr?: string, tz?: string }' },
        executor: { type: 'object', description: 'Where to run: { type: "main-agent"|"walnut-agent"|"claude-code", config: { instructions: string, cwd?: string (claude-code required), host?: string (claude-code, omit=local), model?: string, timeoutSeconds?: number } }. Preferred over session_target/payload.' },
        session_target: { type: 'string', enum: ['main', 'isolated'], description: 'LEGACY (use executor instead): main session or isolated' },
        wake_mode: { type: 'string', enum: ['now', 'next-cycle'], description: 'How urgently to notify' },
        payload: { type: 'object', description: 'LEGACY (use executor instead): { kind: "systemEvent"|"agentTurn", text?: string, message?: string }' },
        init_processor: { type: 'object', description: 'Optional pre-step action: { actionId: string, params?: object, invokeAgent?: boolean, targetAgent?: string, targetAgentModel?: string, timeoutSeconds?: number }. Set to null to remove.' },
        enabled: { type: 'boolean', description: 'Enable/disable (for update)' },
      },
      required: ['action'],
    },
    async execute(params) {
      const { getCronService } = await import('../web/routes/cron.js');
      const service = getCronService();
      if (!service) return 'Cron service is not running.';
      const action = params.action as string;
      try {
        if (action === 'status') {
          const s = await service.status();
          return json(s);
        }
        if (action === 'add') {
          const { normalizeCronJobCreate } = await import('../core/cron/index.js');
          const input = normalizeCronJobCreate({
            name: params.name, description: params.description,
            schedule: params.schedule, executor: params.executor,
            sessionTarget: params.session_target,
            wakeMode: params.wake_mode, payload: params.payload,
            init_processor: params.init_processor,
            enabled: params.enabled,
          });
          if (!input) return 'Error: invalid input. Provide at least schedule and executor (or legacy payload).';
          const job = await service.add(input);
          return `Routine created: [${job.id}] "${job.name}" — next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'none'}`;
        }
        if (action === 'update') {
          if (!params.job_id) return 'Error: job_id is required for update.';
          const { normalizeCronJobPatch } = await import('../core/cron/index.js');
          const patch = normalizeCronJobPatch({
            name: params.name, description: params.description,
            schedule: params.schedule, executor: params.executor,
            sessionTarget: params.session_target,
            wakeMode: params.wake_mode, payload: params.payload,
            init_processor: params.init_processor,
            enabled: params.enabled,
          });
          if (!patch) return 'Error: invalid patch input.';
          const job = await service.update(params.job_id as string, patch);
          return `Routine updated: [${job.id}] "${job.name}"`;
        }
        if (action === 'remove') {
          if (!params.job_id) return 'Error: job_id is required for remove.';
          await service.remove(params.job_id as string);
          return `Cron job removed: ${params.job_id}`;
        }
        if (action === 'toggle') {
          if (!params.job_id) return 'Error: job_id is required for toggle.';
          const job = await service.toggle(params.job_id as string);
          return `Cron job toggled: [${job.id}] "${job.name}" — now ${job.enabled ? 'enabled' : 'disabled'}`;
        }
        if (action === 'run') {
          if (!params.job_id) return 'Error: job_id is required for run.';
          const result = await service.run(params.job_id as string, 'force');
          return json(result);
        }
        return `Error: Unknown action "${action}".`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Agent CRUD Tools ──
  ...agentCrudTools,

  // ── Command CRUD Tools ──
  ...commandCrudTools,

  // ── Heartbeat Tools ──
  ...heartbeatTools,

  // ── User Interaction ──
  askQuestionTool,

  // ── Inline Subagent ──
  createSubagentTool,

];

/**
 * Get tool definitions in the format expected by the Anthropic API.
 */
export function getToolSchemas(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/**
 * Read-only tool allowlist for non-interactive notification paths (e.g. triage).
 *
 * Fail-closed by design: this is an ALLOWLIST, not a denylist. Any tool not
 * named here is excluded — so a future write tool is barred by default and a
 * notification path can never silently regain the ability to mutate state.
 *
 * Why this exists: the triage "notify the user about a task's status" path
 * re-runs the main agent loop. With the full tool set it could call
 * `task_create` and — when the bloated history got blind-trimmed past the
 * "Do not use tools" instruction — actually did, spawning near-duplicate tasks
 * in a self-propagating loop. Triage only ever needs to read state to phrase a
 * 2-4 sentence summary, so it gets read-only tools only.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Task read
  'task_query', 'task_get', 'task_search',
  // Session read
  'session_list', 'session_summary', 'session_history',
  // Config read
  'config_get',
  // Cron read
  'cron_list',
  // File read
  'file_read', 'file_list', 'file_glob', 'file_grep',
  // Agent/command read
  'agent_list', 'agent_get', 'command_list', 'command_get',
  // Memory / heartbeat read
  'memory_notes_search', 'heartbeat_get',
  // Web read (no local state mutation)
  'web_fetch', 'web_search',
]);

/**
 * Tool schemas filtered to the read-only allowlist (see READ_ONLY_TOOL_NAMES).
 * Used by notification-only agent turns that must not mutate state.
 */
export function getReadOnlyToolSchemas(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return getToolSchemas().filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
}

/**
 * Full ToolDefinitions filtered to the read-only allowlist (see READ_ONLY_TOOL_NAMES).
 * Pass as runAgentLoop({ tools }) so the model only ever sees read-only schemas.
 */
export function getReadOnlyTools(): ToolDefinition[] {
  return tools.filter((t) => READ_ONLY_TOOL_NAMES.has(t.name));
}

/**
 * Execute a tool by name with given parameters.
 */
export async function executeTool(name: string, params: Record<string, unknown>, meta?: ToolExecuteMeta): Promise<ToolResultContent> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    log.agent.warn(`unknown tool requested: ${name}`);
    return `Error: Unknown tool "${name}"`;
  }
  try {
    const result = await tool.execute(params, meta);
    log.agent.debug(`tool ${name} completed`, {
      resultLength: typeof result === 'string' ? result.length : `${result.length} blocks`,
    });
    return result;
  } catch (err) {
    log.agent.error(`tool ${name} threw`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return `Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
