/**
 * Agent tool definitions.
 * Each tool wraps existing core modules and exposes them to the LLM.
 */
import {
  addTask,
  listTasks,
  deleteTask,
  ActiveSessionError,
  CategorySourceConflictError,
  CircularDependencyError,
  isTaskBlocked,
  updateTask,
  addNote,
  updateNote,
  updateDescription,
  updateSummary,
  appendConversationLog,
  getTask,
  getProjectMetadata,
  setProjectMetadata,
  renameCategory,
  createCategory,
  createProject,
  getStoreCategories,
} from '../core/task-manager.js';
import { VALID_PHASES, shouldRollbackToInProgress } from '../core/phase.js';
import { search } from '../core/search.js';
import {
  listSessions,
  getSessionSummaries,
  getSessionsForTask,
  getSessionByClaudeId,
  updateSessionRecord,
  importSessionRecord,
  checkSessionLimit,
  TRIAGE_AGENTS,
} from '../core/session-tracker.js';
import type { SessionLimitResult } from '../core/session-tracker.js';
import { bus, EventNames } from '../core/event-bus.js';
import { getConfig, saveConfig } from '../core/config-manager.js';
import type { SessionRecord, Task, TaskPhase, TaskPriority, TaskSource, WorkStatus } from '../core/types.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { log } from '../logging/index.js';
import { CLAUDE_HOME } from '../constants.js';
import { readTool } from './tools/read-tool.js';
import { writeTool } from './tools/write-tool.js';
import { editTool } from './tools/edit-tool.js';
import { execTool } from './tools/exec-tool.js';
import { slackTool } from './tools/slack-tool.js';
import { ttsTool } from './tools/tts-tool.js';
import { imageTool } from './tools/image-tool.js';
import { webFetchTool } from './tools/web-fetch-tool.js';
import { webSearchTool } from './tools/web-search-tool.js';
import { createApplyPatchTool } from './tools/apply-patch.js';
import { createProcessTool } from './tools/process-tool.js';
import { agentCrudTools } from './tools/agent-crud-tools.js';
import { commandCrudTools } from './tools/command-tools.js';
import { heartbeatTools } from './tools/heartbeat-tools.js';


/** Escape double-quotes in a string for use inside an XML attribute value. */
function escAttr(s: string): string {
  return s.replace(/"/g, '&quot;');
}

/** Build a `<session-ref>` XML tag. */
function sessionRef(id: string, label: string): string {
  return `<session-ref id="${escAttr(id)}" label="${escAttr(label)}"/>`;
}

/** Build a `<task-ref>` XML tag. */
function taskRef(id: string, label: string): string {
  return `<task-ref id="${escAttr(id)}" label="${escAttr(label)}"/>`;
}

// readPlanFromSession and buildPlanExecutionMessage removed — plan execution now handled by UI buttons via REST endpoints

/** Structured content blocks returned by tools (matches Anthropic API's ToolResultBlockParam.content). */
export type ToolTextBlock = { type: 'text'; text: string };
export type ToolImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ToolContentBlock = ToolTextBlock | ToolImageBlock;

/** Content returned by a tool: plain string or structured content blocks (text + image). */
export type ToolResultContent = string | ToolContentBlock[];

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (params: Record<string, unknown>) => Promise<ToolResultContent>;
}

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Resolve host and working directory for a session via the 5-priority inheritance chain.
 * Shared by start_session and import_session.
 *
 * Resolution chain:
 *   CWD:  ① explicit param → ② task.cwd → ③ parent chain walk → ④ project metadata (default_cwd) → ⑤ project memory dir
 *   Host: ① explicit param → ② project metadata (default_host)
 */
async function resolveSessionContext(
  task: Task | null,
  explicitHost?: string,
  explicitCwd?: string,
): Promise<{ resolvedHost: string | undefined; resolvedCwd: string | undefined }> {
  let resolvedHost = explicitHost;
  let resolvedCwd = explicitCwd;

  // Priority 2 & 3: task cwd → walk up parent chain
  if (!resolvedCwd && task) {
    let current: Task | undefined = task;
    const seen = new Set<string>();  // cycle guard
    while (current && !resolvedCwd) {
      if (current.cwd) {
        resolvedCwd = current.cwd;
        break;
      }
      if (!current.parent_task_id || seen.has(current.parent_task_id)) break;
      seen.add(current.id);
      current = await getTask(current.parent_task_id).catch(() => undefined);
    }
  }

  // Priority 4: project/category metadata
  if (task && (!resolvedHost || !resolvedCwd)) {
    const metadata = await getProjectMetadata(task.category, task.project);
    if (metadata) {
      if (!resolvedHost) resolvedHost = metadata.default_host as string | undefined;
      if (!resolvedCwd) resolvedCwd = metadata.default_cwd as string | undefined;
    }
  }

  // Priority 5: project memory directory as last-resort fallback
  // Better than home dir — at least scoped to the project context
  if (!resolvedCwd && task) {
    const { PROJECTS_MEMORY_DIR } = await import('../constants.js');
    const { default: path } = await import('node:path');
    const { default: fs } = await import('node:fs');
    const projectDir = path.join(PROJECTS_MEMORY_DIR, task.category.toLowerCase(), task.project.toLowerCase());
    if (fs.existsSync(projectDir)) {
      resolvedCwd = projectDir;
    }
  }

  return { resolvedHost, resolvedCwd };
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
      work_status: s.work_status,
      started_at: s.startedAt,
    })),
    hint: 'Wait for an active session to finish, use send_to_session to reuse an existing session, or increase the limit in config.yaml under session_limits.',
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

export const tools: ToolDefinition[] = [
  // ── Task Tools (kubectl-style: query_tasks, get_task, create_task, update_task, delete_task) ──
  {
    name: 'query_tasks',
    description: 'Query tasks, categories, or projects. Use `type` to pick the entity level. For tasks: defaults to non-completed. Use where.phase=\'COMPLETE\' (or where.status=\'done\') when the user asks about completed tasks or wants to delete/clean up.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['task', 'category', 'project'],
          description: 'Entity to query. Default: "task".',
        },
        where: {
          type: 'object',
          description: 'Filter conditions. Category: { name }. Project: { name, category }. Task: { phase, category, project, priority, starred }. Legacy: status (todo/in_progress/done) still works as a convenience alias.',
          properties: {
            name: { type: 'string', description: 'Filter category/project by name.' },
            phase: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'AGENT_COMPLETE', 'AWAIT_HUMAN_ACTION', 'PEER_CODE_REVIEW', 'RELEASE_IN_PIPELINE', 'COMPLETE'], description: 'Filter by 7-state phase (preferred).' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'done'], description: 'Legacy 3-state filter. Maps to phases: todo→TODO, in_progress→IN_PROGRESS+AGENT_COMPLETE+AWAIT_HUMAN_ACTION+PEER_CODE_REVIEW+RELEASE_IN_PIPELINE, done→COMPLETE.' },
            category: { type: 'string' },
            project: { type: 'string' },
            priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'] },
            starred: { type: 'boolean', description: 'Filter starred/favorite tasks (includes individually starred tasks and tasks in favorited categories/projects).' },
            needs_attention: { type: 'boolean', description: 'Filter to tasks flagged as needing human attention.' },
            parent_task_id: { type: 'string', description: 'Filter to children of a parent task (by ID prefix).' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Filter to tasks with any of these tags (OR match).' },
            blocked: { type: 'boolean', description: 'Filter to tasks that are blocked/unblocked by dependencies.' },
          },
        },
        match: {
          type: 'string',
          enum: ['exact', 'contains'],
          description: 'String match mode for where values. Default: "exact".',
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

      const allTasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'));

      // String matcher helper
      const strMatch = (value: string, filter: string): boolean => {
        if (matchMode === 'contains') {
          return value.toLowerCase().includes(filter.toLowerCase());
        }
        return value.toLowerCase() === filter.toLowerCase();
      };

      // Apply category/project name filters to the full task list
      let filtered = allTasks;
      if (where.category) {
        filtered = filtered.filter((t) => strMatch(t.category, where.category as string));
      }
      if (where.project) {
        filtered = filtered.filter((t) => strMatch(t.project, where.project as string));
      }

      if (type === 'category') {
        // Merge store.categories (includes empty categories) with task-derived data
        const storeCategories = await getStoreCategories();
        const catSet = new Set<string>([
          ...Object.keys(storeCategories),
          ...allTasks.map((t) => t.category),
        ]);
        let cats = [...catSet];
        if (where.name) {
          cats = cats.filter((c) => strMatch(c, where.name as string));
        }
        return json(cats.map((cat) => {
          const catTasks = allTasks.filter((t) => t.category === cat);
          const catLower = cat.toLowerCase();
          const storeKey = Object.keys(storeCategories).find(k => k.toLowerCase() === catLower);
          return {
            name: cat,
            source: storeKey ? storeCategories[storeKey].source : (catTasks[0]?.source ?? 'ms-todo'),
            todo: catTasks.filter((t) => t.phase === 'TODO').length,
            active: catTasks.filter((t) => t.phase !== 'TODO' && t.phase !== 'COMPLETE').length,
            done: catTasks.filter((t) => t.phase === 'COMPLETE').length,
          };
        }));
      }

      if (type === 'project') {
        // Group by category+project
        const projMap = new Map<string, { category: string; project: string; tasks: typeof allTasks }>();
        for (const t of filtered) {
          const key = `${t.category}\0${t.project}`;
          if (!projMap.has(key)) {
            projMap.set(key, { category: t.category, project: t.project, tasks: [] });
          }
          projMap.get(key)!.tasks.push(t);
        }
        // Apply project name filter
        let projects = [...projMap.values()];
        if (where.name) {
          projects = projects.filter((p) => strMatch(p.project, where.name as string));
        }
        // Enrich with settings and memory
        const results = await Promise.all(projects.map(async (p) => {
          const entry: Record<string, unknown> = {
            category: p.category,
            name: p.project,
            todo: p.tasks.filter((t) => t.phase === 'TODO').length,
            active: p.tasks.filter((t) => t.phase !== 'TODO' && t.phase !== 'COMPLETE').length,
            done: p.tasks.filter((t) => t.phase === 'COMPLETE').length,
          };
          const metadata = await getProjectMetadata(p.category, p.project);
          if (metadata) entry.settings = metadata;
          try {
            const { getProjectSummary } = await import('../core/project-memory.js');
            const projPath = `${p.category.toLowerCase()}/${p.project.toLowerCase()}`;
            const summary = getProjectSummary(projPath);
            if (summary) entry.memory = summary;
          } catch { /* no memory */ }
          return entry;
        }));
        return json(results);
      }

      // type === 'task'
      let tasks = filtered;

      // Apply phase/status filter (phase takes priority)
      if (where.phase) {
        tasks = tasks.filter((t) => t.phase === where.phase);
      } else if (where.status) {
        tasks = tasks.filter((t) => t.status === where.status);
      } else {
        // Default: exclude completed tasks
        tasks = tasks.filter((t) => t.phase !== 'COMPLETE');
      }

      // Apply priority filter
      if (where.priority) {
        tasks = tasks.filter((t) => t.priority === where.priority);
      }

      // Apply starred filter
      if (where.starred !== undefined) {
        const config = await getConfig();
        const favCats = config.favorites?.categories ?? [];
        const favProjs = config.favorites?.projects ?? [];
        const wantStarred = where.starred === true || where.starred === 'true';
        tasks = tasks.filter((t) => {
          const isStarred = !!t.starred || favCats.some(c => c.toLowerCase() === t.category.toLowerCase()) || favProjs.some(p => p.toLowerCase() === t.project.toLowerCase());
          return wantStarred ? isStarred : !isStarred;
        });
      }

      // Apply needs_attention filter
      if (where.needs_attention !== undefined) {
        const wantAttention = where.needs_attention === true || where.needs_attention === 'true';
        tasks = tasks.filter((t) => wantAttention ? !!t.needs_attention : !t.needs_attention);
      }

      // Apply parent_task_id filter
      if (where.parent_task_id) {
        const parentPrefix = where.parent_task_id as string;
        tasks = tasks.filter((t) => t.parent_task_id?.startsWith(parentPrefix));
      }

      // Apply tags filter (OR match: task has any of the specified tags)
      if (where.tags && Array.isArray(where.tags) && (where.tags as string[]).length > 0) {
        const filterTags = new Set(where.tags as string[]);
        tasks = tasks.filter((t) => t.tags?.some(tag => filterTags.has(tag)));
      }

      // Apply blocked filter (tasks with incomplete dependencies)
      if (where.blocked !== undefined) {
        const wantBlocked = where.blocked === true || where.blocked === 'true';
        tasks = tasks.filter((t) => wantBlocked ? isTaskBlocked(t, allTasks) : !isTaskBlocked(t, allTasks));
      }

      if (tasks.length === 0) {
        // Smart hints when category was specified
        if (where.category) {
          const allForCategory = allTasks.filter((t) => strMatch(t.category, where.category as string));
          if (allForCategory.length > 0) {
            const doneCount = allForCategory.filter((t) => t.phase === 'COMPLETE').length;
            return `No active tasks in '${where.category}'. ${doneCount} completed — use where.phase='COMPLETE'.`;
          }
          const available = [...new Set(allTasks.map((t) => t.category))];
          return `No category matching '${where.category}'. Available: [${available.join(', ')}]`;
        }
        return 'No tasks found.';
      }

      const includeNoteFlags = params.fields === 'all';
      return json(tasks.map((t) => {
        const entry: Record<string, unknown> = {
          id: t.id,
          title: t.title,
          priority: t.priority,
          category: t.category,
          project: t.project,
          phase: t.phase,
        };
        if (t.starred) entry.starred = true;
        if (t.needs_attention) entry.needs_attention = true;
        if (t.due_date) entry.due_date = t.due_date;
        if (t.sprint) entry.sprint = t.sprint;
        if (t.tags?.length) entry.tags = t.tags;
        if (t.depends_on?.length) entry.depends_on = t.depends_on;
        if (isTaskBlocked(t, allTasks)) entry.blocked = true;
        if (t.plan_session_id) entry.plan_session = t.plan_session_id;
        if (t.exec_session_id) entry.exec_session = t.exec_session_id;
        if (t.parent_task_id) entry.parent_task_id = t.parent_task_id;
        if (includeNoteFlags) {
          entry.has_description = !!t.description;
          entry.has_summary = !!t.summary;
          entry.has_note = !!t.note;
          entry.has_conversation_log = !!t.conversation_log;
        }
        return entry;
      }));
    },
  },

  {
    name: 'get_task',
    description: 'Get full details of a task or project.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'project'], description: 'Entity type. Default: "task".' },
        id: { type: 'string', description: 'Task ID or prefix. Required when type=task.' },
        category: { type: 'string', description: 'Category name. Required when type=project.' },
        project: { type: 'string', description: 'Project name. Required when type=project.' },
      },
    },
    async execute(params) {
      const type = (params.type as string) || 'task';
      try {
        if (type === 'project') {
          const category = params.category as string;
          const project = params.project as string;
          if (!category || !project) return 'Error: category and project are required for type=project.';

          const allTasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'));
          const projTasks = allTasks.filter(
            (t) => t.category.toLowerCase() === category.toLowerCase() && t.project.toLowerCase() === project.toLowerCase(),
          );
          const result: Record<string, unknown> = {
            category,
            project,
            todo: projTasks.filter((t) => t.phase === 'TODO').length,
            active: projTasks.filter((t) => t.phase !== 'TODO' && t.phase !== 'COMPLETE').length,
            done: projTasks.filter((t) => t.phase === 'COMPLETE').length,
          };
          const metadata = await getProjectMetadata(category, project);
          if (metadata) result.settings = metadata;
          try {
            const { getProjectSummary } = await import('../core/project-memory.js');
            const projPath = `${category.toLowerCase()}/${project.toLowerCase()}`;
            const summary = getProjectSummary(projPath);
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
        // Truncate conversation_log to avoid consuming excessive tokens
        if (result.conversation_log && typeof result.conversation_log === 'string' && (result.conversation_log as string).length > 1500) {
          result.conversation_log = (result.conversation_log as string).slice(-1500) + '\n[older entries truncated]';
        }
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
    name: 'create_task',
    description: `Create a task, category, or project. Order matters: category first, then project, then task.

- type=category: Create a new category with a source (local or ms-todo). MUST be created before tasks can be added. Plugin-reserved categories are managed by their respective sync plugins.
- type=project: Create a project within an existing category. Category must exist first.
- type=task (default): Create a task. Category MUST exist (error if not). Project MUST exist if specified and different from category (error if not). Use parent_task_id for child tasks (inherits category, project, source from parent — skips existence checks).`,
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'category', 'project'], description: 'Entity type. Default: "task".' },
        // Category fields
        name: { type: 'string', description: 'Category name. Required for type=category.' },
        source: { type: 'string', enum: ['local', 'ms-todo'], description: 'Sync target for the category. Required for type=category. "local" = never synced.' },
        // Task fields
        title: { type: 'string', description: 'Task title. Required for type=task.' },
        priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'], description: 'Priority: immediate (urgent), important (can wait), backlog (future), none' },
        category: { type: 'string', description: 'Category — top-level group (e.g. Work, Life, Later). Required for type=project.' },
        project: { type: 'string', description: 'Project — list within category (e.g. HomeLab, Costco). Required for type=project. Defaults to category if omitted for type=task.' },
        due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        parent_task_id: { type: 'string', description: 'Create as child of this task. Child inherits category, project, and source from parent.' },
        description: { type: 'string', description: 'What & why context for the task (pre-action). Synced to configured plugins on creation.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Initial tags. Convention: "key:value" for structured data (e.g. "team:backend", "blocked").' },
        depends_on: { type: 'array', items: { type: 'string' }, description: 'Full IDs of prerequisite tasks that must complete before this one can start.' },
      },
      required: [],
    },
    async execute(params) {
      const entityType = (params.type as string) || 'task';
      try {
        if (entityType === 'category') {
          const name = params.name as string;
          const source = params.source as TaskSource;
          if (!name) return 'Error: "name" is required for type=category';
          if (!source) return 'Error: "source" is required for type=category (local or ms-todo)';
          const result = await createCategory(name, source);
          bus.emit(EventNames.CATEGORY_CREATED, { name: result.name, source: result.source }, ['web-ui'], { source: 'agent' });
          return `Category created: "${result.name}" (source: ${result.source})`;
        }

        if (entityType === 'project') {
          const category = params.category as string;
          const project = params.project as string;
          if (!category) return 'Error: "category" is required for type=project';
          if (!project) return 'Error: "project" is required for type=project';
          const result = await createProject(category, project);

          // Prompt AI to confirm working directory with the user
          const metadata = await getProjectMetadata(result.category, result.project);
          let response = `Project created: "${result.project}" in category "${result.category}" (source: ${result.source})`;
          if (!metadata?.default_cwd) {
            const { PROJECTS_MEMORY_DIR } = await import('../constants.js');
            const { default: path } = await import('node:path');
            const memDir = path.join(PROJECTS_MEMORY_DIR, result.category.toLowerCase(), result.project.toLowerCase());
            response += `\n⚠️ No default_cwd set — sessions will use: ${memDir}`;
            response += `\nPlease confirm with the user what the correct working directory should be for this project, then set it via default_cwd.`;
          }
          return response;
        }

        // type === 'task' (default)
        const title = params.title as string;
        if (!title) return 'Error: "title" is required for type=task';

        const category = params.category as string | undefined;
        const project = params.project as string | undefined;
        const parentTaskId = params.parent_task_id as string | undefined;

        // Strict validation: category and project must exist (skip for child tasks — they inherit)
        if (!parentTaskId && category) {
          const categories = await getStoreCategories();
          const catLower = category.toLowerCase();
          const catExists = Object.keys(categories).some(k => k.toLowerCase() === catLower);
          if (!catExists) {
            return `Error: Category "${category}" does not exist. Create it first:\n  create_task type=category, name="${category}", source="local" (or "ms-todo")`;
          }

          // Project must also exist if explicitly specified and different from category
          if (project && project.toLowerCase() !== catLower) {
            const metadata = await getProjectMetadata(category, project);
            if (!metadata) {
              const tasks = await listTasks();
              const projExists = tasks.some(t =>
                t.category.toLowerCase() === catLower &&
                t.project.toLowerCase() === project.toLowerCase(),
              );
              if (!projExists) {
                return `Error: Project "${project}" does not exist in category "${category}". Create it first:\n  create_task type=project, category="${category}", project="${project}"`;
              }
            }
          }
        }

        const { task, syncResult } = await addTask({
          title,
          priority: params.priority as TaskPriority | undefined,
          category,
          project,
          due_date: params.due_date as string | undefined,
          parent_task_id: parentTaskId,
          description: params.description as string | undefined,
          tags: params.tags as string[] | undefined,
          depends_on: params.depends_on as string[] | undefined,
        });
        bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'agent' });
        const syncStatus = syncResult?.success === false
          ? `, ⚠️ sync failed: ${syncResult.error}`
          : ', synced';
        return `Task created: [${task.id}] ${task.title} (${task.priority}, ${task.category} → ${task.source}${syncStatus})`;
      } catch (err) {
        if (err instanceof CategorySourceConflictError) {
          return `Error: ${err.message} (category "${err.category}" uses ${err.existingSource} — cannot add ${err.intendedSource} task)`;
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'update_task',
    description: `Update a task or project settings. Supports multiple fields in a single call.

For tasks (type='task'): update structural fields (priority, phase, category, project, starred, needs_attention, due_date, title) and/or text fields (description, summary, note, append_note) in one call. Use phase='AGENT_COMPLETE' to mark a task done (only humans can set COMPLETE).

For projects (type='project'): set default_host and default_cwd for remote session defaults.`,
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['task', 'project'], description: 'Entity type. Default: "task".' },
        // Task fields
        id: { type: 'string', description: 'Task ID or prefix. Required for type=task.' },
        title: { type: 'string', description: 'New title.' },
        priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'], description: 'New priority: immediate (urgent), important (can wait), backlog (future), none.' },
        phase: { type: 'string', enum: [...VALID_PHASES].filter(p => p !== 'COMPLETE'), description: 'Task lifecycle phase. Status is auto-derived. Only humans can set COMPLETE.' },
        category: { type: 'string', description: 'New category (also used for project identification when type=project).' },
        project: { type: 'string', description: 'New project (also used for project identification when type=project).' },
        due_date: { type: 'string', description: 'New due date (YYYY-MM-DD).' },
        starred: { type: 'boolean', description: 'Star or unstar the task.' },
        needs_attention: { type: 'boolean', description: 'Flag task as needing human attention (red dot in UI). Set true when human review/decision is required.' },
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
        // Project fields
        default_host: { type: 'string', description: 'SSH host alias for remote sessions (type=project).' },
        default_cwd: { type: 'string', description: 'Default working directory (type=project).' },
      },
    },
    async execute(params) {
      const type = (params.type as string) || 'task';

      if (type === 'project') {
        const category = params.category as string;
        const project = params.project as string;
        if (!category || !project) return 'Error: category and project are required for type=project.';
        const settings: Record<string, unknown> = {};
        if (params.default_host !== undefined) settings.default_host = params.default_host;
        if (params.default_cwd !== undefined) settings.default_cwd = params.default_cwd;
        if (Object.keys(settings).length === 0) return 'Error: no project settings to update. Provide default_host or default_cwd.';
        try {
          const merged = await setProjectMetadata(category, project, settings);
          return `Project "${category} / ${project}" updated: ${json(merged)}`;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // type === 'task'
      const id = params.id as string;
      if (!id) return 'Error: id is required for type=task.';

      // Validate: AI cannot set COMPLETE phase
      if (params.phase === 'COMPLETE') {
        return 'Error: AI cannot set phase to COMPLETE. Use AGENT_COMPLETE instead. Only humans can mark tasks as COMPLETE.';
      }

      try {
        const results: string[] = [];

        // Structural fields
        const hasStructural = params.title !== undefined || params.priority !== undefined ||
          params.phase !== undefined || params.category !== undefined ||
          params.project !== undefined || params.due_date !== undefined ||
          params.starred !== undefined || params.needs_attention !== undefined ||
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
              category: params.category as string | undefined,
              phase: params.phase as TaskPhase | undefined,
              due_date: params.due_date as string | undefined,
              project: params.project as string | undefined,
              starred: (params.starred === true || params.starred === 'true') ? true : (params.starred === false || params.starred === 'false') ? false : undefined,
              needs_attention: (params.needs_attention === true || params.needs_attention === 'true') ? true : (params.needs_attention === false || params.needs_attention === 'false') ? false : undefined,
              parent_task_id: params.parent_task_id as string | undefined,
              sprint: params.sprint as string | undefined,
              add_tags: params.add_tags as string[] | undefined,
              remove_tags: params.remove_tags as string[] | undefined,
              set_tags: params.set_tags as string[] | undefined,
              add_depends_on: params.add_depends_on as string[] | undefined,
              remove_depends_on: params.remove_depends_on as string[] | undefined,
              set_depends_on: params.set_depends_on as string[] | undefined,
              cwd: params.cwd as string | undefined,
            });
            bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'agent' });
            if (params.phase === 'AGENT_COMPLETE') {
              bus.emit(EventNames.TASK_COMPLETED, { task }, ['web-ui'], { source: 'agent' });
            }
            const starLabel = task.starred === true && params.starred != null ? ' (starred)' : task.starred === false && params.starred != null ? ' (unstarred)' : '';
            results.push(`structural fields updated${starLabel}`);
          } catch (err) {
            if (err instanceof CircularDependencyError) {
              return `Error: Adding that dependency would create a circular chain. ${err.message}`;
            }
            throw err;
          }
        }

        // Text fields
        if (params.description !== undefined) {
          const { task } = await updateDescription(id, params.description as string);
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'agent' });
          results.push('description set');
        }
        if (params.summary !== undefined) {
          const { task } = await updateSummary(id, params.summary as string);
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'agent' });
          results.push('summary set');
        }
        if (params.note !== undefined) {
          const { task } = await updateNote(id, params.note as string);
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'agent' });
          results.push('note replaced');
        }
        if (params.append_note !== undefined) {
          const { task } = await addNote(id, params.append_note as string);
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'agent' });
          results.push('note appended');
        }
        if (params.append_conversation_log !== undefined) {
          const { task } = await appendConversationLog(id, params.append_conversation_log as string);
          bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'agent' });
          results.push('conversation log appended');
        }

        if (results.length === 0) {
          return 'Error: no update fields provided.';
        }

        // Get final task state for the response
        const task = await getTask(id);
        return `Task updated: [${task.id}] ${task.title} — ${results.join(', ')}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'delete_task',
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
        return `Task deleted: [${task.id}] ${task.title}`;
      } catch (err) {
        if (err instanceof ActiveSessionError) {
          return `Cannot delete: task has ${err.activeSessionIds.length} active session(s): ${err.activeSessionIds.join(', ')}. Stop or complete those sessions first.`;
        }
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Memory/Knowledge Tools ──
  {
    name: 'search',
    description: 'Search across tasks and memory/knowledge files. Supports hybrid (keyword + semantic), keyword-only, or semantic-only modes.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        mode: { type: 'string', enum: ['hybrid', 'keyword', 'semantic'], description: 'Search mode. Default: hybrid (keyword + vector). Use keyword for exact matches, semantic for meaning-based.' },
      },
      required: ['query'],
    },
    async execute(params) {
      const mode = (params.mode as 'hybrid' | 'keyword' | 'semantic') ?? 'hybrid';
      const results = await search(params.query as string, { limit: 10, mode });
      if (results.length === 0) return 'No results found.';
      return json(results.map((r) => ({
        type: r.type,
        title: r.title,
        snippet: r.snippet,
        task_id: r.taskId,
        path: r.path,
        score: r.score,
      })));
    },
  },

  {
    name: 'memory',
    description: 'Manage long-term memory. Actions: "append" (add to daily log and/or project memory — use target param to choose), "update_summary" (update project YAML summary), "update_project" (replace entire body below YAML frontmatter — for full rewrites), "update_global" (update global MEMORY.md), "read" (read project or global memory), "edit" (⚠️ DESTRUCTIVE — replace or remove text in project memory by content matching, like the Edit tool. Omit new_content to delete. Data cannot be recovered. Only use when user explicitly requests. Prefer append to correct information over editing.).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['append', 'update_summary', 'update_project', 'update_global', 'read', 'edit'], description: 'The memory operation to perform' },
        project_path: { type: 'string', description: 'Project path (e.g. "work/event-service"). Required for update_summary, update_project, and edit, optional for append and read.' },
        content: { type: 'string', description: 'Content to write. Required for append, update_project, and update_global.' },
        name: { type: 'string', description: 'Project name. Required for update_summary.' },
        description: { type: 'string', description: 'Project description. Required for update_summary.' },
        target: { type: 'string', enum: ['daily', 'project', 'both'], description: 'Write target for append. "daily" = daily log only, "project" = project memory only (requires project_path), "both" = both (default).' },
        old_content: { type: 'string', description: 'Text to find in project memory (exact match). Required for edit. Use "read" first to see current content.' },
        new_content: { type: 'string', description: 'Replacement text for edit. Omit or empty string to delete the matched text.' },
      },
      required: ['action'],
    },
    async execute(params) {
      const action = params.action as string;

      if (action === 'append') {
        const content = params.content as string;
        if (!content) return 'Error: content is required for append action.';
        const projectPath = params.project_path as string | undefined;
        const target = (params.target as string) || 'both';

        if (target === 'project' && !projectPath) {
          return 'Error: project_path is required when target is "project".';
        }

        const writtenTo: string[] = [];

        // Write to daily log
        if (target === 'daily' || target === 'both') {
          const { appendDailyLog } = await import('../core/daily-log.js');
          appendDailyLog(content, 'agent', projectPath);
          writtenTo.push('daily');
        }

        // Write to project memory
        if ((target === 'project' || target === 'both') && projectPath) {
          const { appendProjectMemory } = await import('../core/project-memory.js');
          const result = appendProjectMemory(projectPath, content, 'agent');
          writtenTo.push('project');
          return json({
            status: 'saved',
            written_to: writtenTo,
            project: result.summary,
            recent_entries: result.tail,
            parent_summaries: result.parentSummaries,
          });
        }

        return `Saved to daily log.`;
      }

      if (action === 'update_summary') {
        const projectPath = params.project_path as string;
        const name = params.name as string;
        const description = params.description as string;
        if (!projectPath || !name || !description) return 'Error: project_path, name, and description are required.';
        const { updateProjectSummary } = await import('../core/project-memory.js');
        const result = updateProjectSummary(projectPath, name, description);
        return json({ status: 'updated', parent_summaries: result.parentSummaries });
      }

      if (action === 'update_project') {
        const projectPath = params.project_path as string;
        const content = params.content as string;
        if (!projectPath) return 'Error: project_path is required for update_project.';
        if (!content) return 'Error: content is required for update_project.';
        const { updateProjectBody } = await import('../core/project-memory.js');
        const result = updateProjectBody(projectPath, content);
        return json({ status: 'updated', summary: result.summary });
      }

      if (action === 'update_global') {
        const content = params.content as string;
        if (!content) return 'Error: content is required.';
        const { updateMemoryFile } = await import('../core/memory-file.js');
        updateMemoryFile(content);
        return 'Global memory updated.';
      }

      if (action === 'read') {
        const projectPath = params.project_path as string | undefined;
        if (projectPath) {
          const { getProjectMemory } = await import('../core/project-memory.js');
          const content = getProjectMemory(projectPath);
          return content ?? 'No memory found for this project.';
        }
        const { getMemoryFile } = await import('../core/memory-file.js');
        const content = getMemoryFile();
        return content ?? 'No global memory file found.';
      }

      if (action === 'edit') {
        const projectPath = params.project_path as string;
        const oldContent = params.old_content as string;
        if (!projectPath) return 'Error: project_path is required for edit action.';
        if (!oldContent) return 'Error: old_content is required for edit action.';
        const newContent = (params.new_content as string) ?? '';
        try {
          const { editProjectMemory } = await import('../core/project-memory.js');
          const result = editProjectMemory(projectPath, oldContent, newContent);
          return json({
            status: newContent ? 'updated' : 'deleted',
            old_content: result.oldContent,
            new_content: result.newContent,
          });
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return `Error: Unknown action "${action}". Use append, update_summary, update_project, update_global, read, or edit.`;
    },
  },

  // ── Session Tools ──
  {
    name: 'list_sessions',
    description: 'List tracked sessions — both CLI (Claude Code) sessions and embedded subagent runs. Absorbed (replaced) plan sessions are hidden by default.',
    input_schema: {
      type: 'object',
      properties: {
        work_status: { type: 'string', enum: ['in_progress', 'agent_complete', 'await_human_action', 'completed', 'error'], description: 'Filter by work status' },
        task_id: { type: 'string', description: 'Filter sessions for a specific task' },
        runner: { type: 'string', enum: ['cli', 'embedded', 'all'], description: 'Filter by runner type. Default: all.' },
        include_absorbed: { type: 'boolean', description: 'Include absorbed (replaced) plan sessions. Default: false.' },
        include_triage: { type: 'boolean', description: 'Include triage/message-send-triage subagent sessions. Default: false — these are high-volume internal housekeeping runs.' },
      },
    },
    async execute(params) {
      const runnerFilter = (params.runner as string) ?? 'all';
      const includeAbsorbed = params.include_absorbed === true;
      const includeTriage = params.include_triage === true;
      const results: Array<Record<string, unknown>> = [];

      // CLI sessions
      if (runnerFilter === 'all' || runnerFilter === 'cli') {
        const sessions = params.task_id
          ? await getSessionsForTask(params.task_id as string)
          : await listSessions();
        // Filter out embedded sessions (they belong in the embedded section),
        // absorbed sessions, and apply work_status filter
        let filtered = sessions.filter((s) => s.provider !== 'embedded');
        if (!includeAbsorbed) {
          filtered = filtered.filter((s) => !s.absorbed);
        }
        if (params.work_status) {
          filtered = filtered.filter((s) => s.work_status === params.work_status);
        }
        for (const s of filtered) {
          results.push({
            session_id: s.claudeSessionId,
            runner: 'cli',
            title: s.title,
            project: s.project,
            process_status: s.process_status,
            work_status: s.work_status,
            mode: s.mode,
            activity: s.activity,
            task_id: s.taskId,
            started: s.startedAt,
            last_active: s.lastActiveAt,
            message_count: s.messageCount,
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
          if (params.task_id) {
            runs = runs.filter((r) => r.taskId === params.task_id);
          }
          if (params.work_status) {
            runs = runs.filter((r) => r.status === params.work_status);
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
    name: 'get_session_summary',
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
    name: 'start_session',
    description: `Start a NEW session — either a CLI Claude Code session or an embedded subagent run. A task_id, title, and prompt are required.

Each task allows exactly ONE session — ever. If the task already has a session (active, stopped,
or completed), this tool returns a BLOCKED response. Use send_to_session to continue in the
existing session, or create a child task (create_task with parent_task_id) for a fresh session.

Per-host concurrency limits: Each host (local or remote) has a maximum number of
concurrent CLI sessions (default: local=7, remote=20, configurable via session_limits
in config.yaml). If the limit is reached, this tool returns a BLOCKED response listing
the running sessions on that host.

For CLI sessions: working_directory is required. For embedded sessions: working_directory is not needed.

Remote execution (SSH):
Sessions can run on remote machines. You usually do NOT need to set host or working_directory —
most categories and projects already have defaults configured (default_host, default_cwd).
Just call start_session with task_id, title, and prompt, and the correct machine is picked automatically.

Only pass host/working_directory explicitly when:
- The user specifically asks to run on a different machine
- You have a good reason to override the project/category default

Override priority: explicit params > project defaults > category defaults > local.

Two ways to use:

1. Normal session:
   start_session({ task_id, title, prompt, working_directory })
   → Full-capability session that can read, write, and execute.

2. Plan-only session:
   start_session({ task_id, title, prompt, working_directory, mode: 'plan' })
   → Read-only session. Claude explores the codebase, designs an approach,
     writes a plan file, and calls ExitPlanMode when done. Cannot edit files.
   → When plan completes, use the UI execute buttons to run the plan.

PREFER send_to_session over start_session for follow-up work. send_to_session
preserves the full conversation history and codebase context, has no slot limits,
and is always allowed.`,
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID or prefix. Required — every session must be linked to a task. Create one with create_task first if needed.' },
        title: { type: 'string', description: 'Short human-readable title for this session (e.g. "Fix login validation", "Add API endpoint"). Required.' },
        prompt: { type: 'string', description: 'Prompt/message to send. Required.' },
        working_directory: { type: 'string', description: 'Absolute path to working directory (required for CLI sessions). For remote sessions, this is the path on the remote machine. If not specified, uses project defaults (see update_task type=\'project\').' },
        host: { type: 'string', description: 'SSH host alias for remote execution (matches keys in config.hosts). If not specified, uses the project default_host from project settings. Omit for local execution.' },
        mode: { type: 'string', enum: ['plan', 'bypass'], description: "Session permission mode (CLI only). 'plan' = read-only, 'bypass' = no prompts." },
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

        // ── Strict 1-session-per-task: block if task already has ANY session (active or stopped) ──
        if (task) {
          const existingSessionIds = (task.session_ids ?? []).filter(Boolean);
          if (existingSessionIds.length > 0) {
            const latestId = task.session_id ?? existingSessionIds[existingSessionIds.length - 1];
            // Best-effort lookup for richer context; gracefully degrade if store is unavailable
            let latestSession: { claudeSessionId: string; title: string; work_status: string; process_status: string } | null = null;
            try {
              latestSession = latestId ? await getSessionByClaudeId(latestId) : null;
            } catch { /* store unavailable — proceed with session IDs only */ }

            return json({
              blocked: true,
              reason: 'Task already has a session. Each task allows only ONE session (strict enforcement).',
              session_ids: existingSessionIds,
              existing_session: latestSession ? {
                session_id: latestSession.claudeSessionId,
                title: latestSession.title,
                work_status: latestSession.work_status,
                process_status: latestSession.process_status,
              } : null,
              hint: `Use send_to_session({ session_id: "${latestId}", message: "..." }) to continue in the existing session, or create a new task / subtask with create_task({ parent_task_id: "${task.id}", title: "..." }) for a fresh session.`,
            });
          }
        }

        const prompt = (params.prompt as string) ?? (task ? `Working on task: ${task.title}` : 'Please help.');

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
        const { resolvedHost, resolvedCwd } = await resolveSessionContext(
          task,
          params.host as string | undefined,
          params.working_directory as string | undefined,
        );

        // Validate: remote sessions MUST have a cwd
        if (resolvedHost && !resolvedCwd) {
          return `Error: Remote host "${resolvedHost}" specified but no working directory. Set working_directory or configure via update_task(type:'project', ...).`;
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
            ? ` Set working_directory explicitly, or configure a default via update_task(id:'${task.id}', cwd:'/path') or update_task(type:'project', category:'${task.category}', project:'${task.project}', default_cwd:'/path').`
            : ' Provide working_directory for taskless sessions.';
          return `Error: No working directory resolved for this session.${hint}`;
        }

        // ── Per-host session concurrency limit check ──
        {
          const config = await getConfig();
          const limitResult = await checkSessionLimit(resolvedHost, config.session_limits);
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
          return `CLI session ${sRef} started${hostNote} for task ${taskRef(task.id, task.title)}. Running in background.`;
        }
        return `Taskless CLI session ${sRef} started${hostNote}. Running in background.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'import_session',
    description: `Import an external Claude Code session into Walnut (backfill). Use this to bring
sessions started outside Walnut (e.g. via \`claude -p\` on a remote machine) under full Walnut
management — history viewing, send_to_session, UI tracking, etc.

The session must already exist as a JSONL file on the local or remote machine.
host and working_directory are optional — if omitted, they inherit from the task's project/category
defaults (same resolution chain as start_session).`,
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude Code session UUID to import.' },
        task_id: { type: 'string', description: 'Task ID or prefix to associate this session with.' },
        working_directory: { type: 'string', description: 'Working directory where the session ran. Optional — inherits from task/project defaults if omitted.' },
        host: { type: 'string', description: 'SSH host alias where the session ran. Optional — inherits from project default_host if omitted. Omit for local sessions.' },
        title: { type: 'string', description: 'Custom title. If omitted, extracted from the first user message in the JSONL.' },
        work_status: { type: 'string', enum: ['agent_complete', 'completed', 'await_human_action'], description: 'Work status for the imported session. Default: agent_complete.' },
      },
      required: ['session_id', 'task_id'],
    },
    async execute(params) {
      try {
        const sessionId = params.session_id as string;
        const taskIdPrefix = params.task_id as string;

        // ① Resolve task
        const task = await getTask(taskIdPrefix);

        // ② Check if session is already tracked
        const existing = await getSessionByClaudeId(sessionId);
        if (existing) {
          return `Error: Session ${sessionId} is already tracked (task: ${existing.taskId}). Use send_to_session to interact with it.`;
        }

        // ③ Resolve host/cwd via shared inheritance chain
        const { resolvedHost, resolvedCwd } = await resolveSessionContext(
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

        // ⑤ Validate JSONL exists (local/remote transparent)
        const { readSessionJsonlContent, canonicalJsonlPath, remoteJsonlPath } = await import('../core/session-file-reader.js');
        const jsonlResult = await readSessionJsonlContent(sessionId, resolvedCwd, resolvedHost);

        if (!jsonlResult) {
          const paths: string[] = [];
          if (resolvedCwd) paths.push(canonicalJsonlPath(sessionId, resolvedCwd));
          if (resolvedHost && resolvedCwd) paths.push(`${resolvedHost}:${remoteJsonlPath(sessionId, resolvedCwd)}`);
          else if (resolvedHost) paths.push(`${resolvedHost}:${remoteJsonlPath(sessionId)}`);
          return `Error: JSONL file not found for session ${sessionId}. Looked in:\n${paths.map(p => `  - ${p}`).join('\n')}\nCheck that the session_id, host, and working_directory are correct.`;
        }

        // ⑥ Extract metadata from JSONL
        const lines = jsonlResult.content.split('\n').filter(Boolean);
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
        const workStatus = (params.work_status as 'agent_complete' | 'completed' | 'await_human_action') ?? 'agent_complete';

        // ⑦ Create SessionRecord (stopped — no running process)
        const record = await importSessionRecord({
          claudeSessionId: sessionId,
          taskId: task.id,
          project: task.project,
          cwd: resolvedCwd,
          host: resolvedHost,
          title,
          work_status: workStatus,
          startedAt: firstTimestamp,
          lastActiveAt: lastTimestamp,
          messageCount,
        });

        // ⑧ Link to task
        const { linkSession } = await import('../core/task-manager.js');
        await linkSession(task.id, sessionId);

        // ⑨ Emit task updated event
        bus.emit(EventNames.TASK_UPDATED, { taskId: task.id }, [], { source: 'agent' });

        // ⑩ Return success
        const sRef = sessionRef(record.claudeSessionId, record.title ?? title);
        const hostNote = resolvedHost ? ` (${resolvedHost})` : '';
        const cwdNote = resolvedCwd ? ` cwd=${resolvedCwd}` : '';
        return `Imported session ${sRef}${hostNote}${cwdNote} → task ${taskRef(task.id, task.title)}. Messages: ${messageCount}, source: ${jsonlResult.source}.`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'send_to_session',
    description: 'Resume an existing session with a follow-up message. PREFERRED over start_session for follow-up work — preserves full conversation history and codebase context, no slot limits. Provide session_id (for CLI) or run_id (for embedded). Runs in the background. Use mode to override permissions on resume (e.g. "bypass").',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session ID to resume (for CLI sessions)' },
        run_id: { type: 'string', description: 'Subagent run ID to resume (for embedded sessions)' },
        message: { type: 'string', description: 'Message to send to the session' },
        mode: { type: 'string', enum: ['bypass', 'accept', 'plan'], description: 'Override permission mode for this resume. bypass = full permissions, accept = accept edits, plan = read-only.' },
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
          // Enqueue message so it persists and SessionRunner can process it
          const { enqueueMessage } = await import('../core/session-message-queue.js');
          const msg = await enqueueMessage(sessionId, message);

          // Look up session record for taskId and title
          const record = await getSessionByClaudeId(sessionId);

          // Resume a CLI session (with optional mode/interrupt override)
          bus.emit(EventNames.SESSION_SEND, {
            sessionId,
            taskId: record?.taskId,
            message,
            mode,
            interrupt: interrupt || undefined,
          }, ['session-runner'], { source: 'agent' });

          // Notify main-ai (which forwards to web-ui) that a message was queued
          bus.emit(EventNames.SESSION_MESSAGE_QUEUED, {
            sessionId,
            messageId: msg.id,
            message,
            source: 'agent',
          }, ['main-ai'], { source: 'agent' });
          const sessionLabel = record?.title ?? sessionId.slice(0, 16);
          const sRef = sessionRef(sessionId, sessionLabel);

          // Auto-rollback phase if task was in a post-completion state
          if (record?.taskId) {
            try {
              const task = await getTask(record.taskId);
              if (task && shouldRollbackToInProgress(task.phase)) {
                await updateTask(record.taskId, { phase: 'IN_PROGRESS' });
                log.agent.info('send_to_session: rolled back phase to IN_PROGRESS', { taskId: record.taskId, oldPhase: task.phase });
              }
            } catch { /* best-effort */ }
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
    name: 'get_session_history',
    description: 'Read the conversation history of a session. Provide session_id for CLI sessions or run_id for embedded subagent runs. Supports plan_only (extract plan without loading full history), pagination (reverse, page 1 = newest), and summarize (delegate to configured summarizer agent).',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session ID (for CLI sessions)' },
        run_id: { type: 'string', description: 'Subagent run ID (for embedded sessions)' },
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

        // ── default: full history with budget truncation (existing behavior) ──
        const { readSessionHistory } = await import('../core/session-history.js');
        const messages = await readSessionHistory(sessionId, record?.cwd, record?.host, record?.outputFile);

        if (messages.length === 0) {
          return 'No history found for this session.';
        }

        // Budget-based truncation: full text for short/medium sessions,
        // proportional allocation for very long ones (~20k tokens max)
        const MAX_TOTAL_CHARS = 80_000;
        const totalChars = messages.reduce((sum, m) => sum + m.text.length, 0);

        return json(messages.map(m => {
          let text = m.text;
          if (totalChars > MAX_TOTAL_CHARS && m.text.length > 500) {
            const budget = Math.max(500, Math.floor((m.text.length / totalChars) * MAX_TOTAL_CHARS));
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
        }));
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  {
    name: 'update_session',
    description: 'Update a Claude Code session — title, work status, or activity. Always set a descriptive title when a session lacks one or when the scope changes. Agent can set work_status to await_human_action or agent_complete. Use await_human_action when a critical decision needs human input. Keep sessions at agent_complete and resume via send_to_session until work is truly done. Only humans can set completed. Cannot set in_progress or error (system-managed).',
    input_schema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session ID' },
        title: { type: 'string', description: 'Short title / one-sentence summary for the session' },
        work_status: { type: 'string', enum: ['await_human_action', 'agent_complete'], description: 'New work status. await_human_action = critical decision needs human input. agent_complete = session turn finished, can be resumed. Only humans can set completed.' },
        activity: { type: 'string', description: 'Freetext activity description (e.g. "planning", "testing")' },
      },
      required: ['session_id'],
    },
    async execute(params) {
      try {
        const sessionId = params.session_id as string;
        const title = params.title as string | undefined;
        const workStatus = params.work_status as WorkStatus | undefined;
        const activity = params.activity as string | undefined;

        const updates: Record<string, unknown> = {};
        if (title !== undefined) updates.title = title;
        if (activity !== undefined) updates.activity = activity;

        if (workStatus) {
          // Validate: agent can only set await_human_action or agent_complete.
          // completed is human-only. in_progress and error are system-managed.
          const agentSettable = new Set(['await_human_action', 'agent_complete']);
          if (!agentSettable.has(workStatus)) {
            return `Error: Cannot set work_status to "${workStatus}" — agent can set: await_human_action, agent_complete. Only humans can set completed.`;
          }

          // Look up current session to get previous status
          const session = await getSessionByClaudeId(sessionId);
          if (!session) return `Error: Session not found: ${sessionId}`;

          const previousWorkStatus = session.work_status;
          updates.work_status = workStatus;
          updates.last_status_change = new Date().toISOString();

          await updateSessionRecord(sessionId, updates as Partial<SessionRecord>);

          // Session slot is never cleared by the agent. Slots are only cleared when
          // the human sets 'completed' (via REST PATCH) or on error/task completion.

          // Emit status change event
          bus.emit(EventNames.SESSION_STATUS_CHANGED, {
            sessionId,
            taskId: session.taskId,
            process_status: session.process_status,
            work_status: workStatus,
            previousWorkStatus,
            activity,
          }, ['*'], { source: 'agent', urgency: 'urgent' });

          const sRef = sessionRef(sessionId, title ?? session.title ?? sessionId.slice(0, 16));
          const parts = [];
          if (title) parts.push(`title="${title}"`);
          parts.push(`work_status=${workStatus}`);
          if (activity) parts.push(`activity="${activity}"`);
          return `Session ${sRef} updated: ${parts.join(', ')}`;
        }

        if (Object.keys(updates).length === 0) {
          return 'Error: No updates provided. Specify title, work_status, or activity.';
        }

        // Look up session for the ref tag label (no prior fetch in this branch)
        const session = await getSessionByClaudeId(sessionId);
        await updateSessionRecord(sessionId, updates as Partial<SessionRecord>);
        const sRef = sessionRef(sessionId, title ?? session?.title ?? sessionId.slice(0, 16));
        const parts = [];
        if (title) parts.push(`title="${title}"`);
        if (activity) parts.push(`activity="${activity}"`);
        return `Session ${sRef} updated: ${parts.join(', ')}`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Config Tools ──
  {
    name: 'get_config',
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
    name: 'update_config',
    description: 'Update user configuration fields.',
    input_schema: {
      type: 'object',
      properties: {
        user_name: { type: 'string', description: 'Update user name' },
        default_priority: { type: 'string', enum: ['immediate', 'important', 'backlog', 'none'], description: 'Default task priority' },
        default_category: { type: 'string', description: 'Default task category' },
      },
    },
    async execute(params) {
      const config = await getConfig();
      if (params.user_name !== undefined) config.user.name = params.user_name as string;
      if (params.default_priority !== undefined) config.defaults.priority = params.default_priority as TaskPriority;
      if (params.default_category !== undefined) config.defaults.category = params.default_category as string;
      await saveConfig(config);
      return `Config updated: ${json(config)}`;
    },
  },

  {
    name: 'rename_category',
    description: 'Rename a category (top-level group) across all tasks and remote MS To-Do lists.',
    input_schema: {
      type: 'object',
      properties: {
        old_category: { type: 'string', description: 'Current category name' },
        new_category: { type: 'string', description: 'New category name' },
      },
      required: ['old_category', 'new_category'],
    },
    async execute(params) {
      try {
        const { count } = await renameCategory(
          params.old_category as string,
          params.new_category as string,
        );
        bus.emit(EventNames.TASK_UPDATED, { oldCategory: params.old_category, newCategory: params.new_category, count }, ['web-ui'], { source: 'agent' });
        return `Renamed category "${params.old_category}" to "${params.new_category}" (${count} tasks updated)`;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // ── Coding Tools ──
  readTool,
  writeTool,
  editTool,

  // ── Exec Tool ──
  execTool,

  // ── Patch & Process Tools ──
  createApplyPatchTool(),
  createProcessTool(),

  // ── Integration Tools ──
  slackTool,
  ttsTool,
  imageTool,

  // ── Web Tools ──
  webSearchTool,
  webFetchTool,

  // ── Cron Tools ──
  {
    name: 'list_cron_jobs',
    description: 'List all scheduled cron jobs with their status, schedule, and last run info.',
    input_schema: {
      type: 'object',
      properties: {
        include_disabled: { type: 'boolean', description: 'Include disabled jobs (default: false)' },
      },
    },
    async execute(params) {
      const { getCronService } = await import('../web/routes/cron.js');
      const service = getCronService();
      if (!service) return 'Cron service is not running.';
      const jobs = await service.list({ includeDisabled: params.include_disabled as boolean ?? false });
      if (jobs.length === 0) return 'No cron jobs found.';
      return json(jobs.map((j) => ({
        id: j.id, name: j.name, enabled: j.enabled,
        schedule: j.schedule, sessionTarget: j.sessionTarget,
        wakeMode: j.wakeMode,
        ...(j.initProcessor ? { initProcessor: j.initProcessor } : {}),
        payload: j.payload,
        nextRunAtMs: j.state.nextRunAtMs,
        lastStatus: j.state.lastStatus,
        lastRunAtMs: j.state.lastRunAtMs,
        lastError: j.state.lastError,
      })));
    },
  },

  {
    name: 'manage_cron_job',
    description: 'Manage cron jobs. Actions: add, update, remove, toggle (enable/disable), run (manual trigger), status (scheduler info).',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'toggle', 'run', 'status'], description: 'The action to perform' },
        job_id: { type: 'string', description: 'Job ID (required for update, remove, toggle, run)' },
        name: { type: 'string', description: 'Job name (for add/update)' },
        description: { type: 'string', description: 'Job description (for add/update)' },
        schedule: { type: 'object', description: 'Schedule config: { kind: "at"|"every"|"cron", at?: string, everyMs?: number, expr?: string, tz?: string }' },
        session_target: { type: 'string', enum: ['main', 'isolated'], description: 'Where to run: main session or isolated' },
        wake_mode: { type: 'string', enum: ['now', 'next-cycle'], description: 'How urgently to notify' },
        payload: { type: 'object', description: 'What to execute: { kind: "systemEvent"|"agentTurn", text?: string, message?: string }' },
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
            schedule: params.schedule, sessionTarget: params.session_target,
            wakeMode: params.wake_mode, payload: params.payload,
            init_processor: params.init_processor,
            enabled: params.enabled,
          });
          if (!input) return 'Error: invalid input. Provide at least schedule and payload.';
          const job = await service.add(input);
          return `Cron job created: [${job.id}] "${job.name}" — next run: ${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'none'}`;
        }
        if (action === 'update') {
          if (!params.job_id) return 'Error: job_id is required for update.';
          const { normalizeCronJobPatch } = await import('../core/cron/index.js');
          const patch = normalizeCronJobPatch({
            name: params.name, description: params.description,
            schedule: params.schedule, sessionTarget: params.session_target,
            wakeMode: params.wake_mode, payload: params.payload,
            init_processor: params.init_processor,
            enabled: params.enabled,
          });
          if (!patch) return 'Error: invalid patch input.';
          const job = await service.update(params.job_id as string, patch);
          return `Cron job updated: [${job.id}] "${job.name}"`;
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
 * Execute a tool by name with given parameters.
 */
export async function executeTool(name: string, params: Record<string, unknown>): Promise<ToolResultContent> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    log.agent.warn(`unknown tool requested: ${name}`);
    return `Error: Unknown tool "${name}"`;
  }
  try {
    const result = await tool.execute(params);
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
