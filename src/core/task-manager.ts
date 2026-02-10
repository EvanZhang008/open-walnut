import { TASKS_FILE } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { withFileLock } from '../utils/file-lock.js';
import { log } from '../logging/index.js';
import { generateId, parseGroupFromCategory } from '../utils/format.js';
import { initDirectories } from './init.js';
import { getConfig, saveConfig } from './config-manager.js';
import { bus, EventNames } from './event-bus.js';
import { VALID_PRIORITIES as VALID_PRIORITIES_ARRAY, type Task, type TaskStore, type TaskStatus, type TaskPhase, type TaskPriority, type TaskSource, type DashboardData } from './types.js';
import { applyPhase, deriveStatusFromPhase, phaseFromStatus, VALID_PHASES, migratePhase as migratePhaseValue } from './phase.js';
import { registry } from './integration-registry.js';
import yaml from 'js-yaml';

const EMPTY_STORE: TaskStore = { version: 1, tasks: [] };

let initialized = false;
let migrated = false;

/** Reset internal flags for test isolation (call in beforeEach). */
export function _resetForTesting(): void {
  initialized = false;
  migrated = false;
}

// ── Write lock: serializes all read-modify-write operations ──
// Two layers: in-process promise chain + cross-process file lock.
// The promise chain prevents concurrent async operations within the server.
// The file lock prevents races with hook child processes (on-stop, on-compact).
let writeLock: Promise<void> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let resolve: () => void;
  writeLock = new Promise<void>((r) => { resolve = r; });
  return prev.then(() => withFileLock(TASKS_FILE, fn)).finally(() => resolve!());
}

async function ensureInit(): Promise<void> {
  if (!initialized) {
    await initDirectories();
    initialized = true;
  }
}

/**
 * One-time migration: split slash-separated categories into category + project.
 * e.g. category "idea / work idea" → category="idea", project="work idea"
 */
async function migrateSlashCategories(store: TaskStore): Promise<boolean> {
  let changed = false;
  for (const task of store.tasks) {
    if (task.category && task.category.includes(' / ')) {
      const oldCategory = task.category;
      const parsed = parseGroupFromCategory(oldCategory);
      task.category = parsed.group;
      // Only set project if it wasn't explicitly set to something different
      if (!task.project || task.project === oldCategory || task.project.includes(' / ')) {
        task.project = parsed.listName;
      }
      changed = true;
    }
  }
  return changed;
}


/**
 * One-time migration: active_session_id (string) → active_session_ids (string[]).
 * (Legacy — kept for backward compat with very old stores.)
 */
function migrateActiveSessionIds(store: TaskStore): boolean {
  let changed = false;
  for (const task of store.tasks) {
    const raw = task as unknown as Record<string, unknown>;
    if (Array.isArray(raw.active_session_ids)) continue; // already migrated
    const oldId = raw.active_session_id as string | undefined;
    raw.active_session_ids = oldId ? [oldId] : [];
    delete raw.active_session_id;
    changed = true;
  }
  return changed;
}

/**
 * One-time migration: active_session_ids[] → typed plan_session_id / exec_session_id slots.
 * Reads session records to determine which slot each session belongs to.
 * Keeps session_ids[] as the historical record.
 */
async function migrateSessionSlots(store: TaskStore): Promise<boolean> {
  let changed = false;
  const { getSessionByClaudeId } = await import('./session-tracker.js');

  for (const task of store.tasks) {
    const raw = task as unknown as Record<string, unknown>;
    if (!('active_session_ids' in raw)) continue;

    const ids = raw.active_session_ids as string[] | undefined;
    if (ids?.length) {
      for (const sid of ids) {
        let rec;
        try {
          rec = await getSessionByClaudeId(sid);
        } catch { continue; }
        if (!rec || rec.work_status === 'completed' || rec.work_status === 'error') continue;
        if (rec.mode === 'plan' && !task.plan_session_id) {
          task.plan_session_id = sid;
        } else if (rec.mode !== 'plan' && !task.exec_session_id) {
          task.exec_session_id = sid;
        }
      }
    }
    delete raw.active_session_ids;
    changed = true;
  }
  return changed;
}

/**
 * One-time migration: notes: string[] → description + summary + note string fields.
 * Joins the old array into `note`, initializes `description` and `summary` to ''.
 * Also removes obsolete plugin-specific tracking fields (e.g. *_synced_note_count).
 */
function migrateNotesToFields(store: TaskStore): boolean {
  let changed = false;
  for (const task of store.tasks) {
    const raw = task as unknown as Record<string, unknown>;
    if (Array.isArray(raw.notes)) {
      (task as Task).note = (raw.notes as string[]).join('\n\n');
      delete raw.notes;
      changed = true;
    }
    if (raw.description === undefined) {
      (task as Task).description = '';
      changed = true;
    }
    if (raw.summary === undefined) {
      (task as Task).summary = '';
      changed = true;
    }
    if (raw.note === undefined && !Array.isArray(raw.notes)) {
      (task as Task).note = '';
      changed = true;
    }
    // Remove obsolete plugin tracking fields (legacy migration cleanup)
    for (const key of Object.keys(raw)) {
      if (key.endsWith('_synced_note_count')) {
        delete raw[key];
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * One-time migration: backfill phase from status for tasks that don't have it.
 */
function migratePhase(store: TaskStore): boolean {
  let changed = false;
  for (const task of store.tasks) {
    if (!task.phase) {
      (task as Task).phase = phaseFromStatus(task.status);
      changed = true;
    } else {
      // Migrate renamed phases: INVESTIGATION → TODO, HUMAN_VERIFICATION → AWAIT_HUMAN_ACTION
      const migrated = migratePhaseValue(task.phase as string);
      if (migrated !== task.phase) {
        applyPhase(task as Task, migrated);
        changed = true;
      }
    }
  }
  return changed;
}

const VALID_PRIORITIES_SET = new Set<string>(VALID_PRIORITIES_ARRAY);

/** Sanitize a priority value — maps legacy values to new 3-tier system, unknown → 'none'. */
function sanitizePriority(p: string | undefined): TaskPriority {
  if (!p) return 'none';
  if (VALID_PRIORITIES_SET.has(p)) return p as TaskPriority;
  // Legacy migrations
  if (p === 'high') return 'immediate';
  if (p === 'medium' || p === 'low') return 'backlog';
  return 'none';
}

/**
 * One-time migration: convert legacy priority values to new 3-tier system.
 * 'high' → 'immediate', 'medium'/'low' → 'backlog'.
 */
function migratePriorityToThreeTier(store: TaskStore): boolean {
  let changed = false;
  for (const task of store.tasks) {
    const p = task.priority as string;
    if (p === 'high') {
      task.priority = 'immediate';
      changed = true;
    } else if (p === 'medium' || p === 'low') {
      task.priority = 'backlog';
      changed = true;
    }
  }
  return changed;
}

/**
 * One-time migration: remove embedded subagent session IDs from task.session_ids.
 * Embedded runs (triage etc.) are agent actions, not user sessions — they were
 * incorrectly linked via linkSessionSlot before this fix.
 * Also clears plan_session_id / exec_session_id if they point to embedded sessions.
 */
async function migrateRemoveEmbeddedSessionIds(store: TaskStore): Promise<boolean> {
  let changed = false;
  // Collect all embedded session IDs from session records
  const { listSessions } = await import('./session-tracker.js');
  const sessions = await listSessions();
  const embeddedIds = new Set<string>();
  for (const s of sessions) {
    if (s.provider === 'embedded') embeddedIds.add(s.claudeSessionId);
  }
  if (embeddedIds.size === 0) return false;

  for (const task of store.tasks) {
    const before = task.session_ids.length;
    task.session_ids = task.session_ids.filter((sid) => !embeddedIds.has(sid));
    if (task.session_ids.length !== before) changed = true;

    if (task.plan_session_id && embeddedIds.has(task.plan_session_id)) {
      task.plan_session_id = undefined;
      changed = true;
    }
    if (task.exec_session_id && embeddedIds.has(task.exec_session_id)) {
      task.exec_session_id = undefined;
      changed = true;
    }
  }
  return changed;
}


/**
 * One-time migration: 2-slot (plan_session_id + exec_session_id) → 1-slot (session_id).
 * Sets session_id = exec_session_id || plan_session_id when session_id is not already set.
 */
function migrateToSingleSessionSlot(store: TaskStore): boolean {
  let changed = false;
  for (const task of store.tasks) {
    if (task.session_id) continue; // already migrated
    const candidate = task.exec_session_id || task.plan_session_id;
    if (candidate) {
      task.session_id = candidate;
      changed = true;
    }
  }
  return changed;
}

/**
 * V3 migration: populate store.categories from config + existing tasks.
 * Runs once when store.categories is undefined.
 */
async function migrateToV3Categories(store: TaskStore): Promise<boolean> {
  if (store.categories !== undefined) return false;

  const categories: Record<string, { source: TaskSource }> = {};
  const config = await getConfig();

  // 1. Config-based categories (may have no tasks yet)
  for (const cat of config.local?.categories ?? []) {
    categories[cat] = { source: 'local' };
  }
  // Check plugin configs for category reservations (generic loop over all plugins)
  const plugins = (config.plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, pluginCfg] of Object.entries(plugins)) {
    const cfg = pluginCfg as Record<string, unknown>;
    if (cfg.category && typeof cfg.category === 'string') {
      categories[cfg.category] = { source: pluginId };
    }
  }

  // 2. Seed from existing tasks — fill in any categories not already mapped by config
  for (const task of store.tasks) {
    if (task.title.startsWith('.metadata')) continue;
    const catLower = task.category.toLowerCase();
    if (!Object.keys(categories).some(k => k.toLowerCase() === catLower)) {
      categories[task.category] = { source: task.source };
    }
  }

  store.categories = categories;
  store.version = 3;
  log.task.info('migrated to v3 categories', { count: Object.keys(categories).length });
  return true;
}

/**
 * One-time migration: convert embedded subtasks[] to child tasks (parent_task_id).
 * For each task with subtasks[], creates a new full Task for each subtask entry:
 *   - Inherits category, project, source from parent
 *   - phase = COMPLETE if done, TODO otherwise
 *   - Preserves ms_checklist_id in ext['ms-todo'] and legacy plugin subtask keys in ext.*
 * Removes the subtasks[] array from the parent after migration.
 */
function migrateSubtasksToChildTasks(store: TaskStore): boolean {
  let changed = false;
  const newTasks: Task[] = [];

  for (const task of store.tasks) {
    const raw = task as unknown as Record<string, unknown>;
    const subtasks = raw.subtasks as Array<Record<string, unknown>> | undefined;

    if (!subtasks || subtasks.length === 0) continue;

    for (const sub of subtasks) {
      const now = new Date().toISOString();
      const isDone = !!sub.done;
      const childPhase = isDone ? 'COMPLETE' as TaskPhase : 'TODO' as TaskPhase;
      const childStatus = isDone ? 'done' as TaskStatus : 'todo' as TaskStatus;

      // Build ext data from legacy subtask fields (old data may have plugin-specific keys)
      const ext: Record<string, unknown> = {};
      if (sub.ms_checklist_id) {
        ext['ms-todo'] = { checklist_id: sub.ms_checklist_id };
      }
      // Migrate any legacy plugin subtask key (e.g. *_subtask_key fields from old data)
      for (const [key, val] of Object.entries(sub)) {
        if (key.endsWith('_subtask_key') && val) {
          const pluginId = key.replace('_subtask_key', '');
          ext[pluginId] = { issue_key: val };
        }
      }

      const childTask: Task = {
        id: generateId(),
        title: sub.title as string,
        status: childStatus,
        priority: 'none',
        category: task.category,
        project: task.project,
        session_ids: [],
        parent_task_id: task.id,
        description: '',
        summary: '',
        note: '',
        phase: childPhase,
        source: task.source,
        created_at: (sub.created_at as string) || now,
        updated_at: (sub.updated_at as string) || now,
        ...(isDone ? { completed_at: (sub.updated_at as string) || now } : {}),
        ...(Object.keys(ext).length > 0 ? { ext } : {}),
      };

      newTasks.push(childTask);
    }

    // Remove embedded subtasks from parent
    delete raw.subtasks;
    changed = true;
  }

  if (newTasks.length > 0) {
    store.tasks.push(...newTasks);
    log.task.info('migrated embedded subtasks to child tasks', { count: newTasks.length });
  }

  return changed;
}

/**
 * No-op migration: bump version to 4 for forward-compat detection.
 * Existing tasks have no depends_on — the field is optional.
 */
function migrateToV4DependsOn(store: TaskStore): boolean {
  if ((store.version ?? 1) >= 4) return false;
  store.version = 4;
  log.task.info('migrated to v4 (depends_on field)');
  return true;
}

async function readStore(): Promise<TaskStore> {
  await ensureInit();
  const store = await readJsonFile<TaskStore>(TASKS_FILE, { ...EMPTY_STORE, tasks: [] });

  // Run one-time migrations (core only — plugin migrations run via integration-loader)
  if (!migrated) {
    migrated = true;
    let changed = await migrateSlashCategories(store);
    changed = migrateActiveSessionIds(store) || changed;
    changed = await migrateSessionSlots(store) || changed;
    changed = migrateNotesToFields(store) || changed;
    changed = migratePhase(store) || changed;
    changed = migratePriorityToThreeTier(store) || changed;
    changed = await migrateRemoveEmbeddedSessionIds(store) || changed;
    changed = migrateToSingleSessionSlot(store) || changed;
    changed = await migrateToV3Categories(store) || changed;
    changed = migrateToV4DependsOn(store) || changed;
    changed = migrateSubtasksToChildTasks(store) || changed;
    if (changed) {
      await writeJsonFile(TASKS_FILE, store);
    }
  }

  return store;
}

async function writeStore(store: TaskStore): Promise<void> {
  await writeJsonFile(TASKS_FILE, store);
}

export interface AddTaskInput {
  title: string;
  priority?: TaskPriority;
  category?: string;
  project?: string;
  due_date?: string;
  parent_task_id?: string;
  description?: string;
  tags?: string[];
  depends_on?: string[];
  /** Explicit source override. Only needed for the first task in a new category (e.g. source='local'). */
  source?: TaskSource;
}

/**
 * Build the MS To-Do list name from category and project fields.
 * "Work" + "HomeLab" → "Work / HomeLab"
 * If category === project (e.g. "Inbox"), returns just the category.
 */
export function buildListName(category: string, project: string): string {
  if (!category || !project || category === project) return category || project;
  return `${category} / ${project}`;
}

// ── Category as first-class entity ──

/**
 * Create a new category in store.categories.
 * Only 'local' and 'ms-todo' can be created explicitly.
 * Plugin-reserved categories are created by their respective sync configuration.
 */
export async function createCategory(name: string, source: TaskSource): Promise<{ name: string; source: TaskSource }> {
  if (!name || !name.trim()) throw new Error('Category name must be a non-empty string');

  return withWriteLock(async () => {
    const store = await readStore();
    const categories = store.categories ?? {};
    const nameLower = name.toLowerCase();

    // Case-insensitive uniqueness check
    const existing = Object.keys(categories).find(k => k.toLowerCase() === nameLower);
    if (existing) {
      throw new Error(`Category "${existing}" already exists (case-insensitive match for "${name}")`);
    }

    // Validate against config reservations
    const config = await getConfig();
    const validation = validateCategorySource(store.tasks, name, source, config);
    if (!validation.ok) {
      throw new CategorySourceConflictError(validation.error, name, source, validation.existingSource);
    }

    categories[name] = { source };
    store.categories = categories;
    await writeStore(store);

    bus.emit(EventNames.CATEGORY_CREATED, { name, source }, ['web-ui', 'main-agent'], { source: 'task-manager' });
    log.task.info('category created', { name, source });
    return { name, source };
  });
}

/**
 * Create a project within an existing category.
 * Category must exist in store.categories.
 */
export async function createProject(category: string, project: string): Promise<{ category: string; project: string; source: TaskSource }> {
  if (!category || !category.trim()) throw new Error('Category name must be a non-empty string');
  if (!project || !project.trim()) throw new Error('Project name must be a non-empty string');

  const store = await readStore();
  const categories = store.categories ?? {};
  const catLower = category.toLowerCase();
  const catKey = Object.keys(categories).find(k => k.toLowerCase() === catLower);
  if (!catKey) {
    throw new Error(`Category "${category}" does not exist. Create it first with create_task type=category.`);
  }

  const source = categories[catKey].source;

  // Create .metadata task for the project
  await setProjectMetadata(catKey, project, {});

  return { category: catKey, project, source };
}

/**
 * Get all categories from the store.
 * Returns store.categories or empty object if not yet migrated.
 */
export async function getStoreCategories(): Promise<Record<string, { source: TaskSource }>> {
  const store = await readStore();
  return store.categories ?? {};
}

/**
 * Update the source of an existing category.
 * Validates that no tasks in the category conflict with the new source.
 */
export async function updateCategorySource(name: string, source: TaskSource): Promise<{ name: string; source: TaskSource }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const categories = store.categories ?? {};
    const nameLower = name.toLowerCase();
    const catKey = Object.keys(categories).find(k => k.toLowerCase() === nameLower);
    if (!catKey) {
      throw new Error(`Category "${name}" does not exist`);
    }

    // Check no conflicting tasks
    const conflicting = store.tasks.find(
      t => t.category.toLowerCase() === nameLower && t.source !== source,
    );
    if (conflicting) {
      throw new CategorySourceConflictError(
        `Category "${name}" has ${conflicting.source} tasks. Cannot change source to ${source}.`,
        name, source, conflicting.source,
      );
    }

    categories[catKey] = { source };
    store.categories = categories;
    await writeStore(store);

    bus.emit(EventNames.CATEGORY_UPDATED, { name: catKey, source }, ['web-ui'], { source: 'task-manager' });
    log.task.info('category source updated', { name: catKey, source });
    return { name: catKey, source };
  });
}

export interface SyncResult {
  success: boolean;
  error?: string;
}

/**
 * Push a specific field update to the task's plugin.
 * Fire-and-forget with sync_error tracking.
 */
async function pushToPlugin(
  task: Task,
  method: keyof import('./integration-types.js').IntegrationSync,
  ...args: unknown[]
): Promise<SyncResult> {
  try {
    const plugin = registry.get(task.source);
    if (!plugin) return { success: true }; // Unknown source, skip silently

    const syncFn = plugin.sync[method] as (...a: unknown[]) => Promise<unknown>;
    const result = await syncFn(task, ...args);

    // If createTask returned ExtData, merge into task.ext
    if (method === 'createTask' && result) {
      await withWriteLock(async () => {
        const store = await readStore();
        const found = store.tasks.find(t => t.id === task.id);
        if (found) {
          found.ext = { ...found.ext, ...result as Record<string, unknown> };
          found.sync_error = undefined;
          await writeStore(store);
          bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
        }
      });
    }

    // Clear sync_error on success
    if (task.sync_error) {
      await withWriteLock(async () => {
        const store = await readStore();
        const found = store.tasks.find(t => t.id === task.id);
        if (found && found.sync_error) {
          found.sync_error = undefined;
          await writeStore(store);
          bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
        }
      });
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.task.warn('plugin sync failed', { taskId: task.id, source: task.source, method, error: message });

    // Set sync_error
    await withWriteLock(async () => {
      const store = await readStore();
      const found = store.tasks.find(t => t.id === task.id);
      if (found && found.sync_error !== message) {
        found.sync_error = message;
        await writeStore(store);
        bus.emit(EventNames.TASK_UPDATED, { task: found }, ['web-ui'], { source: 'sync' });
      }
    });

    return { success: false, error: message };
  }
}

/**
 * Full task push — calls createTask for new tasks or pushes all fields for existing.
 * Replaces the old integration-specific autoPushIfConfigured().
 */
async function autoPushIfConfigured(task: Task): Promise<SyncResult> {
  const plugin = registry.get(task.source);
  if (!plugin || task.source === 'local') return { success: true };

  // For new tasks without ext data, do a full create
  const hasRemoteId = task.ext && Object.keys(task.ext).length > 0;
  if (!hasRemoteId) {
    return pushToPlugin(task, 'createTask');
  }

  // For existing tasks, push all fields (plugins can batch internally)
  try {
    const sync = plugin.sync;
    const extBefore = JSON.stringify(task.ext);
    await Promise.allSettled([
      sync.updateTitle(task, task.title),
      sync.updateDescription(task, task.description),
      sync.updatePhase(task, task.phase),
      sync.updatePriority(task, task.priority),
    ]);

    // Sync dependencies separately (not in the parallel batch) since it
    // needs a relationship delta computation against ext plugin relationships.
    await sync.updateDependencies(task, task.depends_on ?? []).catch((err) => {
      log.task.warn('dependency sync failed', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
    });

    // pushTask may have created a new remote item (if ext was missing/corrupted)
    // and updated task.ext in memory. Persist any ext changes to disk.
    if (JSON.stringify(task.ext) !== extBefore) {
      await withWriteLock(async () => {
        const store = await readStore();
        const found = store.tasks.find(t => t.id === task.id);
        if (found && JSON.stringify(found.ext) !== JSON.stringify(task.ext)) {
          found.ext = task.ext;
          found.sync_error = undefined;
          await writeStore(store);
          log.task.info('persisted ext data after update-path push', { taskId: task.id });
        }
      });
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

/**
 * Fire-and-forget: mark all sessions linked to a completed task as completed.
 * Uses dynamic import to avoid circular dependency with session-tracker.
 */
function autoCompleteTaskSessions(task: Task): void {
  if (!task.session_ids?.length) return;
  import('./session-tracker.js')
    .then(({ completeTaskSessions }) => completeTaskSessions(task.session_ids))
    .then((count) => {
      if (count > 0) {
        log.task.info('auto-completed sessions for task', { taskId: task.id, count });
        bus.emit(EventNames.SESSION_ENDED, { taskId: task.id, autoCompleted: count }, ['web-ui']);
      }
    })
    .catch((err) => {
      log.task.warn('failed to auto-complete task sessions', {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

/**
 * One-time migration: scan all COMPLETE tasks and mark their linked sessions as completed.
 * Safe to call multiple times — skips sessions already in terminal state.
 * Returns the total number of sessions updated.
 */
export async function migrateCompletedTaskSessions(): Promise<number> {
  const store = await readStore();
  const completeTasks = store.tasks.filter((t) => t.phase === 'COMPLETE' && t.session_ids?.length);
  if (completeTasks.length === 0) return 0;

  const allSessionIds = new Set<string>();
  for (const t of completeTasks) {
    for (const sid of t.session_ids) allSessionIds.add(sid);
  }

  const { completeTaskSessions } = await import('./session-tracker.js');
  const count = await completeTaskSessions([...allSessionIds]);
  if (count > 0) {
    log.task.info('migrated stale sessions from completed tasks', { count, tasks: completeTasks.length });
  }
  return count;
}

/**
 * Create a new task. Returns the created task.
 */
export async function addTask(input: AddTaskInput): Promise<{ task: Task; syncResult: SyncResult }> {
  // Read-modify-write under lock; sync push happens outside to avoid holding lock during network I/O
  const task = await withWriteLock(async () => {
    const config = await getConfig();
    const store = await readStore();

    const now = new Date().toISOString();

    // If parent_task_id is set, inherit category/project/source from parent
    let parentTask: Task | undefined;
    if (input.parent_task_id) {
      const matches = store.tasks.filter((t) => t.id.startsWith(input.parent_task_id!));
      if (matches.length === 0) {
        throw new Error(`Parent task not found: ${input.parent_task_id}`);
      }
      if (matches.length > 1) {
        throw new Error(`Ambiguous parent_task_id prefix: ${input.parent_task_id}`);
      }
      parentTask = matches[0];
    }

    let category = input.category ?? parentTask?.category ?? config.defaults.category;
    let project = input.project ?? parentTask?.project;

    // Parse slash-separated "category / project" format
    if (category.includes(' / ')) {
      const parsed = parseGroupFromCategory(category);
      category = parsed.group;
      project = project ?? parsed.listName;
    }

    // Auto-determine source: parent → store.categories → existing tasks → input.source → ms-todo
    const catLower = category.toLowerCase();
    const storeCatKey = Object.keys(store.categories ?? {}).find(k => k.toLowerCase() === catLower);
    const storeCatSource: TaskSource | undefined = storeCatKey ? store.categories![storeCatKey].source : undefined;

    // Fallback: if store.categories doesn't have this category, check existing tasks
    const existingSource = storeCatSource == null
      ? store.tasks.find(t => t.category.toLowerCase() === catLower)?.source
      : undefined;

    const source: TaskSource = parentTask?.source
      ?? storeCatSource
      ?? existingSource
      ?? input.source
      ?? (await registry.getForCategory(category)).id;

    // Validate category-source consistency
    const validation = validateCategorySource(store.tasks, category, source, config, store.categories);
    if (!validation.ok) {
      throw new CategorySourceConflictError(validation.error, category, source, validation.existingSource);
    }

    const newTask: Task = {
      id: generateId(),
      title: input.title,
      status: 'todo',
      phase: 'TODO',
      priority: sanitizePriority(input.priority ?? config.defaults.priority),
      category,
      project: project ?? category,
      source,
      session_ids: [],
      description: input.description ?? '',
      summary: '',
      note: '',
      created_at: now,
      updated_at: now,
      due_date: input.due_date,
      ...(parentTask ? { parent_task_id: parentTask.id } : {}),
      ...(input.tags?.length ? { tags: [...new Set(input.tags)] } : {}),
    };

    // Validate and attach depends_on before pushing to store
    if (input.depends_on?.length) {
      const deduped = [...new Set(input.depends_on)];
      validateDependencyIds(store, newTask.id, deduped);
      // No cycle check needed for new tasks — they can't be depended on yet
      newTask.depends_on = deduped;
    }

    store.tasks.push(newTask);

    // Auto-ensure: if category is not in store.categories, add it
    if (!store.categories) store.categories = {};
    if (!storeCatKey) {
      store.categories[category] = { source };
    }

    await writeStore(store);

    return newTask;
  });

  // Push to sync target and capture result (outside lock to avoid holding it during network I/O)
  const syncResult = await autoPushIfConfigured(task);

  // Re-read the task from the store to pick up ext fields set by the push (e.g. plugin ext data).
  // autoPushIfConfigured writes these to the store but the local `task` object is stale.
  if (syncResult.success) {
    const updatedStore = await readStore();
    const fresh = updatedStore.tasks.find((t) => t.id === task.id);
    if (fresh) Object.assign(task, fresh);
  }

  return { task, syncResult };
}

export interface ListTasksFilter {
  status?: string;
  category?: string;
}

/**
 * List tasks, optionally filtered by status and/or category.
 */
export async function listTasks(filter: ListTasksFilter = {}): Promise<Task[]> {
  const store = await readStore();
  let tasks = store.tasks;

  if (filter.status) {
    tasks = tasks.filter((t) => t.status === filter.status);
  }
  if (filter.category) {
    tasks = tasks.filter((t) => t.category === filter.category);
  }

  return tasks;
}

// ── Dependency helpers (used inside withWriteLock) ──

/**
 * Validate dependency IDs exist (full match, not prefix) and are not self-referencing.
 * Throws on validation failure.
 */
function validateDependencyIds(store: TaskStore, taskId: string, depIds: string[]): void {
  const taskMap = new Map(store.tasks.map(t => [t.id, t]));
  for (const depId of depIds) {
    if (depId === taskId) {
      throw new Error('A task cannot depend on itself.');
    }
    if (!taskMap.has(depId)) {
      throw new Error(`Dependency target not found: "${depId}". Use full task IDs for depends_on.`);
    }
  }
}

/**
 * BFS cycle detection: check if adding depIds to taskId would create a cycle.
 * Walks the transitive depends_on graph from each depId and checks if any path
 * leads back to taskId.
 */
function checkCircularDependency(store: TaskStore, taskId: string, depIds: string[]): void {
  const taskMap = new Map(store.tasks.map(t => [t.id, t]));
  const visited = new Set<string>();
  const queue = [...depIds];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) {
      throw new CircularDependencyError(taskId, depIds.find(d => depIds.includes(d)) ?? depIds[0]);
    }
    if (visited.has(current)) continue;
    visited.add(current);
    const depTask = taskMap.get(current);
    if (depTask?.depends_on) {
      for (const next of depTask.depends_on) {
        if (!visited.has(next)) queue.push(next);
      }
    }
  }
}

/**
 * Apply dependency mutations (add/remove/set) to a task, with validation.
 * Must be called inside withWriteLock.
 */
function applyDependencyMutations(
  store: TaskStore,
  task: Task,
  updates: Pick<UpdateTaskInput, 'add_depends_on' | 'remove_depends_on' | 'set_depends_on'>,
): void {
  if (updates.set_depends_on !== undefined) {
    // Replace all
    const deduped = [...new Set(updates.set_depends_on)];
    if (deduped.length > 0) {
      validateDependencyIds(store, task.id, deduped);
      checkCircularDependency(store, task.id, deduped);
      task.depends_on = deduped;
    } else {
      delete task.depends_on;
    }
  } else {
    if (updates.add_depends_on?.length) {
      validateDependencyIds(store, task.id, updates.add_depends_on);
      const existing = new Set(task.depends_on ?? []);
      const newDeps = updates.add_depends_on.filter(d => !existing.has(d));
      if (newDeps.length > 0) {
        checkCircularDependency(store, task.id, newDeps);
        for (const d of newDeps) existing.add(d);
        task.depends_on = [...existing];
      }
    }
    if (updates.remove_depends_on?.length) {
      const toRemove = new Set(updates.remove_depends_on);
      const remaining = (task.depends_on ?? []).filter(d => !toRemove.has(d));
      if (remaining.length > 0) {
        task.depends_on = remaining;
      } else {
        delete task.depends_on;
      }
    }
  }
}

/**
 * Check if a task is blocked: has depends_on entries where any referenced task is not COMPLETE.
 */
export function isTaskBlocked(task: Task, allTasks: Task[]): boolean {
  if (!task.depends_on?.length) return false;
  const taskMap = new Map(allTasks.map(t => [t.id, t]));
  return task.depends_on.some(depId => {
    const dep = taskMap.get(depId);
    return dep && dep.phase !== 'COMPLETE';
  });
}

/**
 * Guard: block completing a parent task that still has active (non-COMPLETE) children.
 * Call inside withWriteLock where the store is already loaded.
 */
function guardActiveChildren(store: TaskStore, task: Task): void {
  const activeChildren = store.tasks.filter(
    (t) => t.parent_task_id === task.id && t.phase !== 'COMPLETE',
  );
  if (activeChildren.length > 0) {
    throw new ActiveChildrenError(task.title, activeChildren);
  }
}

/**
 * Complete a task by partial ID match. Returns the completed task.
 * Throws if no match or ambiguous match.
 */
export async function completeTask(idPrefix: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  guardActiveChildren(store, task);
  applyPhase(task, 'COMPLETE');
  task.updated_at = new Date().toISOString();

  await writeStore(store);

  // Fire-and-forget: push to To-Do + mark linked sessions completed
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });
  autoCompleteTaskSessions(task);

  return { task };
  });
}

/**
 * Toggle a task between todo and done states by partial ID match.
 */
export async function toggleComplete(idPrefix: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  if (task.phase === 'COMPLETE') {
    applyPhase(task, 'TODO');
  } else {
    guardActiveChildren(store, task);
    applyPhase(task, 'COMPLETE');
  }
  task.updated_at = new Date().toISOString();

  await writeStore(store);

  // Fire-and-forget: push to To-Do + mark linked sessions completed (only when completing)
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });
  if (task.phase === 'COMPLETE') autoCompleteTaskSessions(task);

  return { task };
  });
}

export interface UpdateTaskInput {
  title?: string;
  priority?: TaskPriority;
  category?: string;
  status?: TaskStatus;
  phase?: TaskPhase;
  due_date?: string;
  project?: string;
  starred?: boolean;
  needs_attention?: boolean;
  parent_task_id?: string;  // Set or change parent. Empty string = remove parent.
  sprint?: string;          // Set sprint name (empty string clears)
  add_tags?: string[];      // Idempotent add
  remove_tags?: string[];   // Remove specific tags
  set_tags?: string[];      // Replace all tags (overwrite)
  add_depends_on?: string[];      // Add dependency IDs (idempotent)
  remove_depends_on?: string[];   // Remove specific dependency IDs
  set_depends_on?: string[];      // Replace all dependencies (overwrite)
}

/**
 * Update fields on a task by partial ID match.
 */
export async function updateTask(idPrefix: string, updates: UpdateTaskInput): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  if (updates.title !== undefined) task.title = updates.title;
  if (updates.priority !== undefined) task.priority = sanitizePriority(updates.priority);
  if (updates.category !== undefined) {
    // Parse slash-separated "category / project" format once, reuse result
    const hasSlash = updates.category.includes(' / ') && updates.project === undefined;
    const parsed = hasSlash ? parseGroupFromCategory(updates.category) : undefined;
    const newCategoryName = parsed ? parsed.group : updates.category;

    // Validate category-source consistency when category is actually changing
    if (newCategoryName.toLowerCase() !== task.category.toLowerCase()) {
      const config = await getConfig();
      const validation = validateCategorySource(store.tasks, newCategoryName, task.source, config, store.categories);
      if (!validation.ok) {
        throw new CategorySourceConflictError(
          `Cannot move task to category "${newCategoryName}" — it contains ${validation.existingSource} tasks but this task syncs to ${task.source}. Tasks cannot change sync backends. Delete and recreate the task in the target category instead.`,
          newCategoryName,
          task.source,
          validation.existingSource,
        );
      }
    }

    if (parsed) {
      task.category = parsed.group;
      task.project = parsed.listName;
    } else {
      task.category = updates.category;
    }
  }
  if (updates.phase !== undefined && VALID_PHASES.has(updates.phase)) {
    if (updates.phase === 'COMPLETE') guardActiveChildren(store, task);
    applyPhase(task, updates.phase);
  } else if (updates.status !== undefined) {
    // Legacy: status without phase → derive phase from status
    const derivedPhase = phaseFromStatus(updates.status);
    if (derivedPhase === 'COMPLETE') guardActiveChildren(store, task);
    applyPhase(task, derivedPhase);
  }
  if (updates.due_date !== undefined) task.due_date = updates.due_date;
  if (updates.project !== undefined) task.project = updates.project;
  if (updates.starred !== undefined) task.starred = updates.starred;
  if (updates.needs_attention !== undefined) task.needs_attention = updates.needs_attention;
  // Track parent change for plugin notification (fired after writeStore)
  let parentChangeAction: (() => void) | undefined;
  if (updates.parent_task_id !== undefined) {
    if (updates.parent_task_id === '') {
      // Remove parent
      const oldParent = store.tasks.find(t => t.id === task.parent_task_id);
      delete task.parent_task_id;
      if (oldParent) {
        const capturedOldParent = { ...oldParent };
        const capturedTask = { ...task };
        parentChangeAction = () => {
          pushToPlugin(capturedTask, 'disassociateSubtask', capturedOldParent, capturedTask).catch(() => {});
        };
      }
    } else {
      // Resolve parent by prefix
      const parentMatches = store.tasks.filter((t) => t.id.startsWith(updates.parent_task_id!));
      if (parentMatches.length === 0) {
        throw new Error(`Parent task not found: ${updates.parent_task_id}`);
      }
      if (parentMatches.length > 1) {
        throw new Error(`Ambiguous parent_task_id prefix: ${updates.parent_task_id}`);
      }
      const parentTask = parentMatches[0];
      if (parentTask.id === task.id) {
        throw new Error('A task cannot be its own parent.');
      }
      // Prevent circular references: walk up from parent to ensure task.id is not an ancestor
      let cursor: string | undefined = parentTask.parent_task_id;
      while (cursor) {
        if (cursor === task.id) {
          throw new Error('Circular reference: the target parent is a descendant of this task.');
        }
        const ancestor = store.tasks.find((t) => t.id === cursor);
        cursor = ancestor?.parent_task_id;
      }
      task.parent_task_id = parentTask.id;
      const capturedParent = { ...parentTask };
      const capturedTask = { ...task };
      parentChangeAction = () => {
        pushToPlugin(capturedTask, 'associateSubtask', capturedParent, capturedTask).catch(() => {});
      };
    }
  }

  // Sprint: direct field or via sprint:* tag convention
  if (updates.sprint !== undefined) {
    task.sprint = updates.sprint || undefined;
  }

  // Intercept sprint:* convention tags → redirect to task.sprint field
  if (updates.add_tags?.length) {
    const normalTags: string[] = [];
    for (const tag of updates.add_tags) {
      if (tag.startsWith('sprint:')) {
        task.sprint = tag.slice(7) || undefined; // last one wins
      } else {
        normalTags.push(tag);
      }
    }
    updates.add_tags = normalTags.length > 0 ? normalTags : undefined;
  }
  if (updates.set_tags?.length) {
    const normalTags: string[] = [];
    for (const tag of updates.set_tags) {
      if (tag.startsWith('sprint:')) {
        task.sprint = tag.slice(7) || undefined;
      } else {
        normalTags.push(tag);
      }
    }
    updates.set_tags = normalTags;
  }
  if (updates.remove_tags?.length) {
    const normalRemove: string[] = [];
    for (const tag of updates.remove_tags) {
      if (tag.startsWith('sprint:')) {
        task.sprint = undefined; // clear sprint
      } else {
        normalRemove.push(tag);
      }
    }
    updates.remove_tags = normalRemove.length > 0 ? normalRemove : undefined;
  }

  // Tag mutations
  if (updates.set_tags !== undefined) {
    // Replace all
    const deduped = [...new Set(updates.set_tags)];
    if (deduped.length > 0) {
      task.tags = deduped;
    } else {
      delete task.tags;
    }
  } else {
    if (updates.add_tags?.length) {
      const existing = new Set(task.tags ?? []);
      for (const tag of updates.add_tags) existing.add(tag);
      task.tags = [...existing];
    }
    if (updates.remove_tags?.length) {
      const toRemove = new Set(updates.remove_tags);
      const remaining = (task.tags ?? []).filter(t => !toRemove.has(t));
      if (remaining.length > 0) {
        task.tags = remaining;
      } else {
        delete task.tags;
      }
    }
  }

  // Dependency mutations (same pattern as tags)
  const hasDeps = updates.add_depends_on !== undefined ||
    updates.remove_depends_on !== undefined ||
    updates.set_depends_on !== undefined;
  if (hasDeps) {
    applyDependencyMutations(store, task, updates);
  }

  task.updated_at = new Date().toISOString();

  await writeStore(store);

  // Fire-and-forget: push to plugin + parent change + mark linked sessions completed
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });
  if (parentChangeAction) parentChangeAction();
  if (task.phase === 'COMPLETE') autoCompleteTaskSessions(task);

  return { task };
  });
}

/**
 * Add a note to a task by partial ID match.
 */
export async function addNote(idPrefix: string, content: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  task.note = task.note ? task.note + '\n\n' + content : content;
  task.updated_at = new Date().toISOString();

  await writeStore(store);

  // Fire-and-forget push to provider
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });

  return { task };
  });
}

/**
 * Append an entry to a task's conversation_log by partial ID match.
 * Auto-prepends a timestamp heading (### MM-DD HH:MM).
 */
export async function appendConversationLog(idPrefix: string, entry: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const fullEntry = `### ${yyyy}-${mm}-${dd} ${hh}:${min}\n${entry}`;

  task.conversation_log = task.conversation_log
    ? task.conversation_log + '\n\n' + fullEntry
    : fullEntry;
  task.updated_at = now.toISOString();

  await writeStore(store);

  // Fire-and-forget push to provider
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });

  return { task };
  });
}

/**
 * Replace the entire note blob on a task by partial ID match.
 */
export async function updateNote(idPrefix: string, content: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  task.note = content;
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });
  return { task };
  });
}

/**
 * Set/update the description field on a task by partial ID match.
 */
export async function updateDescription(idPrefix: string, content: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  task.description = content;
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });
  return { task };
  });
}

/**
 * Set/update the summary field on a task by partial ID match.
 */
export async function updateSummary(idPrefix: string, content: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  task.summary = content;
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  autoPushIfConfigured(task).then(r => {
    if (!r.success) log.task.warn('sync push failed (fire-and-forget)', { taskId: task.id, source: task.source, error: r.error });
  }).catch(err => {
    log.task.warn('sync push rejected (fire-and-forget)', { taskId: task.id, source: task.source, error: err instanceof Error ? err.message : String(err) });
  });
  return { task };
  });
}

/**
 * Get a single task by partial ID match.
 */
export async function getTask(idPrefix: string): Promise<Task> {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  return matches[0];
}

/**
 * Error thrown when a task's source conflicts with the target category's source.
 * e.g. trying to add an ms-todo task to a category that already has plugin-reserved tasks.
 */
export class CategorySourceConflictError extends Error {
  public readonly category: string;
  public readonly intendedSource: TaskSource;
  public readonly existingSource: TaskSource;
  constructor(message: string, category: string, intendedSource: TaskSource, existingSource: TaskSource) {
    super(message);
    this.name = 'CategorySourceConflictError';
    this.category = category;
    this.intendedSource = intendedSource;
    this.existingSource = existingSource;
  }
}

/**
 * Validate that a task's source is consistent with the target category.
 * Rules:
 * 1. If store.categories has an entry with a different source → conflict.
 * 2. If any existing task in the category has a different source → conflict.
 * 3. Config reservations (local.categories, plugins.*.category) checked for backward compat.
 * Returns { ok: true } or { ok: false, error: string, existingSource: TaskSource }.
 */
export function validateCategorySource(
  tasks: Task[],
  category: string,
  intendedSource: TaskSource,
  config: unknown,
  storeCategories?: Record<string, { source: TaskSource }>,
): { ok: true } | { ok: false; error: string; existingSource: TaskSource } {
  const catLower = category.toLowerCase();
  const cfg = config as Record<string, unknown>;

  // Check store.categories first (highest priority — source of truth for v3)
  if (storeCategories) {
    const storeCatKey = Object.keys(storeCategories).find(k => k.toLowerCase() === catLower);
    if (storeCatKey && storeCategories[storeCatKey].source !== intendedSource) {
      return {
        ok: false,
        error: `Category "${category}" is registered as ${storeCategories[storeCatKey].source}. Cannot add a ${intendedSource} task to it.`,
        existingSource: storeCategories[storeCatKey].source,
      };
    }
  }

  // Check config reservation: config.local.categories are reserved for local tasks only
  const localConfig = cfg.local as { categories?: string[] } | undefined;
  const localCategories = localConfig?.categories;
  if (localCategories?.some(c => c.toLowerCase() === catLower) && intendedSource !== 'local') {
    return {
      ok: false,
      error: `Category "${category}" is reserved for local tasks (config.local.categories). Only local tasks can use this category. Use a different category name for ${intendedSource} tasks.`,
      existingSource: 'local',
    };
  }

  // Check plugin config reservations: plugins.*.category or legacy top-level keys
  const plugins = (cfg.plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, pluginCfg] of Object.entries(plugins)) {
    if (pluginId === intendedSource) continue;
    const reservedCat = pluginCfg.category as string | undefined;
    if (reservedCat && catLower === reservedCat.toLowerCase()) {
      return {
        ok: false,
        error: `Category "${category}" is reserved for ${pluginId} sync (plugins.${pluginId}.category). Only ${pluginId} tasks can use this category.`,
        existingSource: pluginId,
      };
    }
  }
  // Check existing tasks in the category
  const existing = tasks.find(
    (t) => t.category.toLowerCase() === catLower && t.source !== intendedSource,
  );
  if (existing) {
    return {
      ok: false,
      error: `Category "${category}" already contains ${existing.source} tasks. Cannot add a ${intendedSource} task to it. Use a different category name, or move existing tasks out first.`,
      existingSource: existing.source,
    };
  }

  return { ok: true };
}

/**
 * Error thrown when attempting to delete a task that has active sessions.
 */
export class ActiveSessionError extends Error {
  public readonly activeSessionIds: string[];
  constructor(taskId: string, activeSessionIds: string[]) {
    super(
      `Cannot delete task "${taskId}": has ${activeSessionIds.length} active session(s): ${activeSessionIds.join(', ')}`,
    );
    this.name = 'ActiveSessionError';
    this.activeSessionIds = activeSessionIds;
  }
}

/**
 * Error thrown when attempting to complete a parent task that has active (non-COMPLETE) children.
 */
export class ActiveChildrenError extends Error {
  public readonly childTitles: string[];
  public readonly activeCount: number;
  constructor(taskTitle: string, activeChildren: { title: string }[]) {
    const count = activeChildren.length;
    const titles = activeChildren.slice(0, 5).map((t) => t.title);
    super(
      `Cannot complete task "${taskTitle}": ${count} child task(s) are still active (${titles.join(', ')}). Complete or delete them first.`,
    );
    this.name = 'ActiveChildrenError';
    this.childTitles = titles;
    this.activeCount = count;
  }
}

/**
 * Error thrown when a dependency mutation would create a circular dependency chain.
 */
export class CircularDependencyError extends Error {
  public readonly taskId: string;
  public readonly depId: string;
  constructor(taskId: string, depId: string) {
    super(`Circular dependency detected: adding dependency on "${depId}" from task "${taskId}" creates a cycle.`);
    this.name = 'CircularDependencyError';
    this.taskId = taskId;
    this.depId = depId;
  }
}

/**
 * Delete a task by partial ID match.
 * Throws ActiveSessionError if the task has active sessions.
 * Fire-and-forget deletes from MS To-Do / external plugins if applicable.
 */
export async function deleteTask(idPrefix: string): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];

  // Block deletion if task has active session slots
  const activeIds = [task.plan_session_id, task.exec_session_id].filter(Boolean) as string[];
  if (activeIds.length > 0) {
    throw new ActiveSessionError(task.id, activeIds);
  }

  // Remove from store
  store.tasks = store.tasks.filter((t) => t.id !== task.id);
  await writeStore(store);

  // Fire-and-forget: delete from remote provider via plugin
  pushToPlugin(task, 'deleteTask').catch((err) => {
    log.task.warn('failed to delete task from remote', {
      taskId: task.id,
      source: task.source,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return { task };
  });
}

/**
 * Rename a category both locally and on the remote.
 * Updates all tasks with the old category and renames the remote lists.
 */
export async function renameCategory(
  oldCategory: string,
  newCategory: string,
): Promise<{ count: number }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const config = await getConfig();
  const now = new Date().toISOString();
  let count = 0;

  // Determine the source of tasks being renamed
  const tasksToRename = store.tasks.filter(
    (t) => t.category.toLowerCase() === oldCategory.toLowerCase(),
  );

  // Allow renaming empty categories if they exist in store.categories
  const oldCatStoreKey = Object.keys(store.categories ?? {}).find(
    k => k.toLowerCase() === oldCategory.toLowerCase(),
  );
  if (tasksToRename.length === 0 && !oldCatStoreKey) {
    throw new Error(`No tasks found with category "${oldCategory}"`);
  }

  // Verify all tasks in the category share the same source
  const renameSource = tasksToRename.length > 0
    ? tasksToRename[0].source
    : (oldCatStoreKey ? store.categories![oldCatStoreKey].source : 'ms-todo');
  const mixedSource = tasksToRename.find((t) => t.source !== renameSource);
  if (mixedSource) {
    throw new Error(
      `Category "${oldCategory}" has mixed sources (${renameSource} and ${mixedSource.source}). Clean up the category before renaming.`,
    );
  }

  // Check 1: target category name is reserved by a plugin config
  const pluginsConfig = ((config as unknown as Record<string, unknown>).plugins ?? {}) as Record<string, Record<string, unknown>>;
  for (const [pluginId, pluginCfg] of Object.entries(pluginsConfig)) {
    if (pluginId === renameSource) continue;
    const reservedCat = pluginCfg.category as string | undefined;
    if (reservedCat && newCategory.toLowerCase() === reservedCat.toLowerCase()) {
      throw new CategorySourceConflictError(
        `Cannot rename to "${newCategory}" — it is configured as the ${pluginId} sync category. Only ${pluginId} tasks can use this category name.`,
        newCategory,
        renameSource,
        pluginId,
      );
    }
  }
  // Check 2: target category in store.categories has a different source
  if (store.categories) {
    const targetCatKey = Object.keys(store.categories).find(
      k => k.toLowerCase() === newCategory.toLowerCase() && k.toLowerCase() !== oldCategory.toLowerCase(),
    );
    if (targetCatKey && store.categories[targetCatKey].source !== renameSource) {
      throw new CategorySourceConflictError(
        `Cannot rename "${oldCategory}" to "${newCategory}" — category "${newCategory}" is registered as ${store.categories[targetCatKey].source} but "${oldCategory}" tasks sync to ${renameSource}. Choose a different target name.`,
        newCategory,
        renameSource,
        store.categories[targetCatKey].source,
      );
    }
  }

  // Check 3: target category already has tasks with a different source
  const targetConflict = store.tasks.find(
    (t) =>
      t.category.toLowerCase() === newCategory.toLowerCase() &&
      t.category.toLowerCase() !== oldCategory.toLowerCase() &&
      t.source !== renameSource,
  );
  if (targetConflict) {
    throw new CategorySourceConflictError(
      `Cannot rename "${oldCategory}" to "${newCategory}" — category "${newCategory}" already has ${targetConflict.source} tasks but "${oldCategory}" tasks sync to ${renameSource}. Choose a different target name.`,
      newCategory,
      renameSource,
      targetConflict.source,
    );
  }

  // Collect old list names for remote rename
  const oldListNames = new Set<string>();

  for (const task of store.tasks) {
    if (task.category.toLowerCase() === oldCategory.toLowerCase()) {
      const oldListName = buildListName(task.category, task.project);
      oldListNames.add(oldListName);
      task.category = newCategory;
      task.updated_at = now;
      count++;
    }
  }

  // Update store.categories: move old entry to new name
  if (store.categories) {
    const oldCatKey = Object.keys(store.categories).find(
      k => k.toLowerCase() === oldCategory.toLowerCase(),
    );
    if (oldCatKey) {
      const entry = store.categories[oldCatKey];
      delete store.categories[oldCatKey];
      store.categories[newCategory] = entry;
    }
  }

  await writeStore(store);

  // Update config.local.categories when renaming a local category
  if (renameSource === 'local') {
    const localCats = config.local?.categories;
    if (localCats?.some(c => c.toLowerCase() === oldCategory.toLowerCase())) {
      const freshConfig = await getConfig();
      if (freshConfig.local?.categories) {
        freshConfig.local.categories = freshConfig.local.categories
          .filter(c => c.toLowerCase() !== oldCategory.toLowerCase());
        if (!freshConfig.local.categories.some(c => c.toLowerCase() === newCategory.toLowerCase())) {
          freshConfig.local.categories.push(newCategory);
        }
        await saveConfig(freshConfig);
      }
    }
  }

  // Fire-and-forget: notify plugin about category change for each renamed task
  if (renameSource !== 'local') {
    const renamedTasks = store.tasks.filter(t => t.category === newCategory);
    for (const task of renamedTasks) {
      pushToPlugin(task, 'updateCategory', newCategory, task.project).catch(() => {
        // Silent — local rename succeeded, remote rename is best-effort
      });
    }
  }

  return { count };
  });
}

/**
 * Link a session to a task's typed slot (plan or exec).
 * Also pushes to session_ids history. Replaces old linkActiveSession().
 */
export async function linkSessionSlot(
  idPrefix: string,
  sessionId: string,
  slot: 'plan' | 'exec',
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  if (slot === 'plan') {
    task.plan_session_id = sessionId;
  } else {
    task.exec_session_id = sessionId;
  }
  if (!task.session_ids.includes(sessionId)) {
    task.session_ids.push(sessionId);
  }
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  return { task };
  });
}

/**
 * Clear a session slot from a task by partial ID match.
 * If sessionId is provided, only clears the slot if it matches that session.
 * If slot is omitted, clears whichever slot matches the sessionId.
 * If neither sessionId nor slot is provided, clears both slots.
 */
export async function clearSessionSlot(
  idPrefix: string,
  sessionId?: string,
  slot?: 'plan' | 'exec',
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];

  if (sessionId) {
    // Clear the specific session from whichever slot it occupies
    if (task.plan_session_id === sessionId && (!slot || slot === 'plan')) {
      task.plan_session_id = undefined;
    }
    if (task.exec_session_id === sessionId && (!slot || slot === 'exec')) {
      task.exec_session_id = undefined;
    }
  } else if (slot) {
    // Clear a specific slot
    if (slot === 'plan') task.plan_session_id = undefined;
    else task.exec_session_id = undefined;
  } else {
    // Clear both slots
    task.plan_session_id = undefined;
    task.exec_session_id = undefined;
  }
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  return { task };
  });
}

/**
 * Add a session ID to task.session_ids for UI visibility, WITHOUT occupying
 * a session slot (plan/exec). Used by embedded subagent sessions that should
 * appear in the task's session list but not block new CLI sessions.
 */
export async function addSessionToHistory(
  idPrefix: string,
  sessionId: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    if (!task.session_ids.includes(sessionId)) {
      task.session_ids.push(sessionId);
    }
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task };
  });
}

// ── Backward-compat aliases ──

/** @deprecated Use linkSessionSlot instead */
export const linkActiveSession = async (idPrefix: string, sessionId: string) =>
  linkSessionSlot(idPrefix, sessionId, 'exec');

/** @deprecated Use clearSessionSlot instead */
export const clearActiveSession = async (idPrefix: string, sessionId?: string) =>
  clearSessionSlot(idPrefix, sessionId);

/**
 * Link a session to the task's single session slot (new 1-slot model).
 * Also pushes to session_ids history.
 */
export async function linkSession(
  idPrefix: string,
  sessionId: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    task.session_id = sessionId;
    if (!task.session_ids.includes(sessionId)) {
      task.session_ids.push(sessionId);
    }
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task };
  });
}

/**
 * Clear the task's single session slot (new 1-slot model).
 * If sessionId is provided, only clears if it matches.
 */
export async function clearSession(
  idPrefix: string,
  sessionId?: string,
): Promise<{ task: Task }> {
  return withWriteLock(async () => {
    const store = await readStore();
    const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

    if (matches.length === 0) {
      throw new Error(`No task found matching ID prefix "${idPrefix}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
      );
    }

    const task = matches[0];
    if (sessionId) {
      if (task.session_id === sessionId) {
        task.session_id = undefined;
      }
    } else {
      task.session_id = undefined;
    }
    task.updated_at = new Date().toISOString();

    await writeStore(store);
    return { task };
  });
}

/**
 * Get child tasks of a parent task by partial ID match.
 */
export async function getChildTasks(taskIdPrefix: string): Promise<Task[]> {
  const parent = await getTask(taskIdPrefix);
  const store = await readStore();
  return store.tasks.filter((t) => t.parent_task_id === parent.id);
}

/**
 * Parse YAML description from a metadata task. Returns null on failure.
 */
function parseMetadataYaml(task: Task): Record<string, unknown> | null {
  if (!task.description) return null;
  try {
    const parsed = yaml.load(task.description);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    log.task.warn('failed to parse metadata YAML description', {
      taskId: task.id,
      title: task.title,
    });
    return null;
  }
}

/**
 * Get merged metadata for a project.
 * Resolution chain: .metadata_project (project-level) → .metadata_category (category-level) → null
 * Project-level settings override category-level settings.
 */
export async function getProjectMetadata(category: string, project: string): Promise<{
  default_host?: string;
  default_cwd?: string;
  [key: string]: unknown;
} | null> {
  const store = await readStore();
  const catLower = category.toLowerCase();

  // Category-level: title='.metadata_category', project='.metadata_category', same category
  const categoryMeta = store.tasks.find(
    (t) =>
      t.title === '.metadata_category' &&
      t.project === '.metadata_category' &&
      t.category.toLowerCase() === catLower,
  );

  // Project-level: title='.metadata_project', specific project, same category
  const projectMeta = store.tasks.find(
    (t) =>
      t.title === '.metadata_project' &&
      t.category.toLowerCase() === catLower &&
      t.project.toLowerCase() === project.toLowerCase(),
  );

  const catSettings = categoryMeta ? parseMetadataYaml(categoryMeta) : null;
  const projSettings = projectMeta ? parseMetadataYaml(projectMeta) : null;

  if (!catSettings && !projSettings) return null;

  // Merge: category defaults, then project overrides
  return { ...(catSettings ?? {}), ...(projSettings ?? {}) } as {
    default_host?: string;
    default_cwd?: string;
    [key: string]: unknown;
  };
}

/**
 * Create or update metadata at category or project level.
 * - level='category': creates/updates .metadata_category task (project='.metadata_category')
 * - level='project': creates/updates .metadata_project task in the specific project
 * Merges provided settings into existing YAML description (or creates the task).
 * Returns the merged settings object.
 */
export async function setProjectMetadata(
  category: string,
  project: string,
  settings: Record<string, unknown>,
  level: 'category' | 'project' = 'project',
): Promise<Record<string, unknown>> {
  const metaTitle = level === 'category' ? '.metadata_category' : '.metadata_project';
  const metaProject = level === 'category' ? '.metadata_category' : project;

  return withWriteLock(async () => {
    const store = await readStore();
    const metaTask = store.tasks.find(
      (t) =>
        t.title === metaTitle &&
        t.category.toLowerCase() === category.toLowerCase() &&
        t.project.toLowerCase() === metaProject.toLowerCase(),
    );

    if (metaTask) {
      // Parse existing YAML and merge
      const existing = parseMetadataYaml(metaTask) ?? {};
      const merged = { ...existing, ...settings };
      metaTask.description = yaml.dump(merged).trim();
      metaTask.updated_at = new Date().toISOString();
      await writeStore(store);
      return merged;
    }

    // Create new metadata task — resolve source from store.categories first, then registry fallback
    const now = new Date().toISOString();
    const catLower = category.toLowerCase();
    const storeCatKey = Object.keys(store.categories ?? {}).find(k => k.toLowerCase() === catLower);
    const source: TaskSource = storeCatKey
      ? store.categories![storeCatKey].source
      : (await registry.getForCategory(category)).id;

    const newTask: Task = {
      id: generateId(),
      title: metaTitle,
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      category,
      project: metaProject,
      source,
      session_ids: [],
      description: yaml.dump(settings).trim(),
      summary: '',
      note: '',
      created_at: now,
      updated_at: now,
    };
    store.tasks.push(newTask);
    await writeStore(store);
    return { ...settings };
  });
}

/**
 * Get dashboard summary data.
 */
export async function getDashboardData(): Promise<DashboardData> {
  const store = await readStore();
  const tasks = store.tasks;

  const active = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const urgent = active.filter((t) => t.priority === 'immediate');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayTasks = active.filter((t) => {
    if (!t.due_date) return false;
    const d = new Date(t.due_date);
    return d >= today && d < tomorrow;
  });

  const doneTasks = tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);

  const stats = {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
  };

  return {
    urgent_tasks: urgent,
    today_tasks: todayTasks,
    recent_tasks: doneTasks,
    recent_sessions: [],
    stats,
  };
}

/**
 * Toggle the starred state on a task by partial ID match.
 */
export async function toggleStar(idPrefix: string): Promise<{ task: Task; starred: boolean }> {
  return withWriteLock(async () => {
  const store = await readStore();
  const matches = store.tasks.filter((t) => t.id.startsWith(idPrefix));

  if (matches.length === 0) {
    throw new Error(`No task found matching ID prefix "${idPrefix}"`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous ID prefix "${idPrefix}" matches ${matches.length} tasks. Be more specific.`,
    );
  }

  const task = matches[0];
  task.starred = !task.starred;
  task.updated_at = new Date().toISOString();

  await writeStore(store);
  return { task, starred: !!task.starred };
  });
}

// ── Tag helpers ──

/**
 * Scan all tasks and return unique tags sorted by frequency (for autocomplete).
 */
export async function getAllTags(): Promise<{ tag: string; count: number }[]> {
  const store = await readStore();
  const tagCounts = new Map<string, number>();
  for (const task of store.tasks) {
    if (task.tags) {
      for (const tag of task.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }
  return [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// ── Reorder methods ──

/**
 * Reorder tasks within a category/project group.
 * `orderedIds` must contain exactly the IDs of all tasks matching the group.
 * Tasks are rearranged in-place at their original index slots in the store array.
 */
export async function reorderTasks(
  category: string,
  project: string,
  orderedIds: string[],
): Promise<void> {
  return withWriteLock(async () => {
  const store = await readStore();

  // Find tasks belonging to this group, preserving their store indices
  const groupEntries: { index: number; task: Task }[] = [];
  for (let i = 0; i < store.tasks.length; i++) {
    const t = store.tasks[i];
    if (t.category === category && t.project === project) {
      groupEntries.push({ index: i, task: t });
    }
  }

  const groupIds = new Set(groupEntries.map((e) => e.task.id));
  const orderedSet = new Set(orderedIds);

  // Validate: orderedIds must match group IDs exactly
  if (orderedSet.size !== orderedIds.length) {
    throw new Error('Duplicate task IDs in orderedIds');
  }
  if (orderedIds.length !== groupEntries.length) {
    throw new Error(
      `orderedIds length (${orderedIds.length}) does not match group size (${groupEntries.length})`,
    );
  }
  for (const id of orderedIds) {
    if (!groupIds.has(id)) {
      throw new Error(`Task ID "${id}" does not belong to group ${category}/${project}`);
    }
  }

  // Build a map from id → task for quick lookup
  const taskById = new Map(groupEntries.map((e) => [e.task.id, e.task]));

  // Place reordered tasks back into their original index slots
  const indices = groupEntries.map((e) => e.index);
  for (let i = 0; i < orderedIds.length; i++) {
    store.tasks[indices[i]] = taskById.get(orderedIds[i])!;
  }

  await writeStore(store);
  });
}

// ── Sync adapter methods ──

/**
 * Add a fully-formed task (used by sync pull to create local tasks from remote).
 * Bypasses defaults — caller provides all fields. Does NOT trigger auto-push.
 * Plugins use task.ext for deduplication via a lookup key convention.
 */
export async function addTaskFull(taskData: Omit<Task, 'id'>): Promise<Task> {
  return withWriteLock(async () => {
  // Guard: never create tasks with missing or empty titles (e.g. from partial delta responses)
  if (!taskData.title || taskData.title.trim() === '') {
    throw new Error('addTaskFull: refusing to create task with empty title');
  }

  const store = await readStore();

  // Plugin-generic dedup: find an existing task with matching ext data.
  // Plugins store a unique remote ID in task.ext (e.g. ext['ms-todo'].id).
  // If the incoming taskData.ext has keys, try to match against existing tasks.
  if (taskData.ext && Object.keys(taskData.ext).length > 0) {
    const existing = store.tasks.find((t) => {
      if (t.source !== taskData.source || !t.ext) return false;
      // Match on first shared key with equal value
      for (const [key, val] of Object.entries(taskData.ext!)) {
        if (val != null && t.ext[key] != null && t.ext[key] === val) return true;
      }
      return false;
    });
    if (existing) {
      existing.title = taskData.title;
      if (taskData.phase) {
        applyPhase(existing, taskData.phase);
      } else if (taskData.status) {
        applyPhase(existing, phaseFromStatus(taskData.status));
      }
      existing.priority = sanitizePriority(taskData.priority);
      existing.category = taskData.category;
      existing.project = taskData.project;
      existing.ext = { ...existing.ext, ...taskData.ext };
      if (taskData.due_date !== undefined) existing.due_date = taskData.due_date;
      if (taskData.completed_at !== undefined) existing.completed_at = taskData.completed_at;
      if (taskData.external_url) existing.external_url = taskData.external_url;
      existing.updated_at = taskData.updated_at ?? new Date().toISOString();
      await writeStore(store);
      return existing;
    }
  }

  // Race-condition guard: title + category + project + source match → update ext
  if (taskData.ext && Object.keys(taskData.ext).length > 0) {
    const dup = store.tasks.find((t) =>
      t.source === taskData.source &&
      t.title === taskData.title &&
      t.category === taskData.category &&
      t.project === taskData.project,
    );
    if (dup) {
      dup.ext = { ...dup.ext, ...taskData.ext };
      if (taskData.external_url) dup.external_url = taskData.external_url;
      dup.updated_at = taskData.updated_at ?? new Date().toISOString();
      await writeStore(store);
      return dup;
    }
  }

  const task: Task = {
    id: generateId(),
    ...taskData,
    priority: sanitizePriority(taskData.priority),
  };

  store.tasks.push(task);
  await writeStore(store);
  return task;
  });
}

/**
 * Update a task by exact ID with raw partial fields (used by sync pull).
 * Does NOT trigger auto-push to avoid sync loops.
 */
export async function updateTaskRaw(id: string, updates: Partial<Task>): Promise<void> {
  return withWriteLock(async () => {
  const store = await readStore();
  const task = store.tasks.find((t) => t.id === id);
  if (!task) return;

  const { id: _ignoreId, ...safeUpdates } = updates;
  if (safeUpdates.priority !== undefined) {
    safeUpdates.priority = sanitizePriority(safeUpdates.priority);
  }
  Object.assign(task, safeUpdates);
  // Re-derive phase↔status consistency when only one side is provided
  if (safeUpdates.status && !safeUpdates.phase) {
    task.phase = phaseFromStatus(task.status);
  } else if (safeUpdates.phase && !safeUpdates.status) {
    task.status = deriveStatusFromPhase(task.phase);
  }
  await writeStore(store);
  });
}
