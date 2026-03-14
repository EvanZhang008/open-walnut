import * as msal from '@azure/msal-node';
import https from 'node:https';
import path from 'node:path';
import { SYNC_DIR } from '../constants.js';
import { readJsonFile, writeJsonFile } from '../utils/fs.js';
import { getConfig } from '../core/config-manager.js';
import { log } from '../logging/index.js';
import type { Task, TaskPhase, TaskPriority, TaskStatus } from '../core/types.js';
import { deriveStatusFromPhase, VALID_PHASES } from '../core/phase.js';
import { phaseToMsStatus, phaseFromMsStatus } from './ms-todo/phase.js';

/** Legacy Subtask interface — kept here for backward compat during plugin migration. */
interface Subtask {
  id: string;
  title: string;
  done: boolean;
  ms_checklist_id?: string;
  created_at: string;
  updated_at: string;
}
import { generateId, parseGroupFromCategory } from '../utils/format.js';
import { buildListName } from '../core/task-manager.js';
import type { Config } from '../core/types.js';

// ── Plugin-system helpers ──

interface MsTodoConfig {
  client_id: string;
  list_mapping?: Record<string, string>;
}

/** Get MS To-Do config from plugin system */
function getMsTodoConfig(config: Config): MsTodoConfig | undefined {
  return config.plugins?.['ms-todo'] as MsTodoConfig | undefined;
}

/** Extract ms-todo ext data from a task */
function msExt(task: Task): Record<string, unknown> | undefined {
  return task.ext?.['ms-todo'] as Record<string, unknown> | undefined;
}

/** Get ms_todo_id from ext data */
function getMsTodoId(task: Task): string | undefined {
  return msExt(task)?.id as string | undefined;
}

/** Get ms_todo_list from ext data */
function getMsTodoList(task: Task): string | undefined {
  return msExt(task)?.list_id as string | undefined;
}

const TOKENS_FILE = path.join(SYNC_DIR, 'ms-todo-tokens.json');
const DELTA_FILE = path.join(SYNC_DIR, 'ms-todo-delta.json');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Tasks.ReadWrite'];

interface TokenCache {
  accessToken: string;
  expiresAt: string;
  msalCache: string;
}

interface DeltaState {
  deltaLinks: Record<string, string>;
  listNames: Record<string, string>;
  lastSync: string;
  /** Remote MS To-Do IDs that were intentionally deleted locally — skip on pull */
  deletedMsIds?: string[];
}

interface MSTodoTask {
  id: string;
  title: string;
  status: 'notStarted' | 'inProgress' | 'completed';
  importance: 'high' | 'normal' | 'low';
  body?: { content: string; contentType: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  completedDateTime?: { dateTime: string; timeZone: string };
  createdDateTime: string;
  lastModifiedDateTime: string;
}

interface MSTodoList {
  id: string;
  displayName: string;
}

interface GraphResponse<T> {
  value: T[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

// -- Priority mapping --

const PRIORITY_TO_IMPORTANCE: Record<TaskPriority, string> = {
  immediate: 'high',
  important: 'normal',
  backlog: 'low',
  none: 'normal',
};

const IMPORTANCE_TO_PRIORITY: Record<string, TaskPriority> = {
  high: 'immediate',
  low: 'backlog',
  normal: 'none',
};

// -- Status mapping --

const STATUS_TO_MS: Record<TaskStatus, string> = {
  todo: 'notStarted',
  in_progress: 'inProgress',
  done: 'completed',
};

const MS_TO_STATUS: Record<string, TaskStatus> = {
  notStarted: 'todo',
  inProgress: 'in_progress',
  completed: 'done',
};

// -- MSAL client --

async function createMsalClient(): Promise<msal.PublicClientApplication> {
  const config = await getConfig();
  const clientId = getMsTodoConfig(config)?.client_id;
  if (!clientId) {
    throw new Error(
      'Microsoft To-Do client_id not configured. Add ms_todo.client_id to ~/.open-walnut/config.yaml',
    );
  }

  const msalConfig: msal.Configuration = {
    auth: {
      clientId,
      authority: 'https://login.microsoftonline.com/consumers',
    },
  };

  const app = new msal.PublicClientApplication(msalConfig);

  // Restore cached tokens if available
  const cached = await readJsonFile<TokenCache | null>(TOKENS_FILE, null);
  if (cached?.msalCache) {
    app.getTokenCache().deserialize(cached.msalCache);
  }

  return app;
}

async function saveTokenCache(app: msal.PublicClientApplication, accessToken: string, expiresOn?: Date | null): Promise<void> {
  const cache: TokenCache = {
    accessToken,
    expiresAt: (expiresOn ?? new Date(Date.now() + 3600 * 1000)).toISOString(),
    msalCache: app.getTokenCache().serialize(),
  };
  await writeJsonFile(TOKENS_FILE, cache);
}

// -- Authentication --

export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  message: string;
}

export async function authenticate(
  onDeviceCode: (info: DeviceCodeInfo) => void,
): Promise<{ account: string; lists: MSTodoList[] }> {
  const app = await createMsalClient();

  const result = await app.acquireTokenByDeviceCode({
    scopes: SCOPES,
    deviceCodeCallback: (response) => {
      onDeviceCode({
        userCode: response.userCode,
        verificationUri: response.verificationUri,
        message: response.message,
      });
    },
  });

  if (!result) {
    throw new Error('Authentication failed: no token received');
  }

  await saveTokenCache(app, result.accessToken, result.expiresOn);

  const lists = await fetchTaskLists(result.accessToken);
  const account = result.account?.username ?? 'unknown';

  return { account, lists };
}

// -- Token acquisition --

export async function getAccessToken(): Promise<string> {
  const app = await createMsalClient();

  // Try silent acquisition first
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({
        scopes: SCOPES,
        account: accounts[0],
      });
      if (result) {
        await saveTokenCache(app, result.accessToken, result.expiresOn);
        return result.accessToken;
      }
    } catch {
      // Silent acquisition failed, fall through
    }
  }

  // Fall back to cached token if still valid
  const cached = await readJsonFile<TokenCache | null>(TOKENS_FILE, null);
  if (cached && new Date(cached.expiresAt) > new Date()) {
    return cached.accessToken;
  }

  throw new Error(
    'Not authenticated with Microsoft To-Do. Run "open-walnut auth" to sign in.',
  );
}

// -- HTTP helpers --

export function graphRequest<T>(
  token: string,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath.startsWith('http') ? urlPath : `${GRAPH_BASE}${urlPath}`);
    const postData = body ? JSON.stringify(body) : undefined;

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          if (!data) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch (parseErr) {
            reject(new Error(`Graph API ${method} ${urlPath}: invalid JSON response`));
          }
        } else {
          reject(new Error(`Graph API ${method} ${urlPath} returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Graph API ${method} ${urlPath} timed out after 30s`));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

// -- Task list operations --

async function fetchTaskLists(token: string): Promise<MSTodoList[]> {
  const response = await graphRequest<GraphResponse<MSTodoList>>(
    token,
    'GET',
    '/me/todo/lists',
  );
  return response.value;
}

// -- Checklist item operations --

export interface MSChecklistItem {
  id: string;
  displayName: string;
  isChecked: boolean;
  createdDateTime?: string;
  checkedDateTime?: string;
}

export async function fetchChecklistItems(
  token: string,
  listId: string,
  taskId: string,
): Promise<MSChecklistItem[]> {
  const response = await graphRequest<GraphResponse<MSChecklistItem>>(
    token,
    'GET',
    `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
  );
  return response.value;
}

export async function pushChecklistItem(
  token: string,
  listId: string,
  taskId: string,
  item: { displayName: string; isChecked: boolean; id?: string },
): Promise<string> {
  if (item.id) {
    // Update existing
    await graphRequest<MSChecklistItem>(
      token,
      'PATCH',
      `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${item.id}`,
      { displayName: item.displayName, isChecked: item.isChecked },
    );
    return item.id;
  } else {
    // Create new
    const created = await graphRequest<MSChecklistItem>(
      token,
      'POST',
      `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems`,
      { displayName: item.displayName, isChecked: item.isChecked },
    );
    return created.id;
  }
}

export async function deleteChecklistItem(
  token: string,
  listId: string,
  taskId: string,
  itemId: string,
): Promise<void> {
  await graphRequest<Record<string, never>>(
    token,
    'DELETE',
    `/me/todo/lists/${listId}/tasks/${taskId}/checklistItems/${itemId}`,
  );
}

export async function getTaskLists(): Promise<MSTodoList[]> {
  const token = await getAccessToken();
  return fetchTaskLists(token);
}

// -- List CRUD --

export async function createList(displayName: string): Promise<MSTodoList> {
  const token = await getAccessToken();
  return graphRequest<MSTodoList>(token, 'POST', '/me/todo/lists', { displayName });
}

export async function renameList(listId: string, newName: string): Promise<MSTodoList> {
  const token = await getAccessToken();
  const result = await graphRequest<MSTodoList>(token, 'PATCH', `/me/todo/lists/${listId}`, { displayName: newName });
  // Invalidate cache — old name→id mapping is stale, new name needs fresh lookup
  clearListIdCache();
  return result;
}

export async function deleteList(listId: string): Promise<void> {
  const token = await getAccessToken();
  await graphRequest<Record<string, never>>(token, 'DELETE', `/me/todo/lists/${listId}`);
  // Invalidate cache — the deleted list ID is now invalid
  clearListIdCache();
}

/**
 * Delete a single task from a MS To-Do list by list ID and task ID.
 */
export async function deleteMsTodoTask(listId: string, taskId: string): Promise<void> {
  const token = await getAccessToken();
  await graphRequest<Record<string, never>>(token, 'DELETE', `/me/todo/lists/${listId}/tasks/${taskId}`);
}

/**
 * Rename a remote list by its current display name.
 * Finds the list by case-insensitive name match, then renames it.
 */
export async function renameListByName(oldName: string, newName: string): Promise<MSTodoList> {
  const token = await getAccessToken();
  const lists = await fetchTaskLists(token);
  const match = lists.find(
    (l) => l.displayName.toLowerCase() === oldName.toLowerCase(),
  );
  if (!match) {
    throw new Error(`No remote list found with name "${oldName}"`);
  }
  return renameList(match.id, newName);
}

// -- List ID resolution (with concurrency dedup) --

/**
 * In-memory cache: normalized list name → list ID.
 * Populated on successful resolve; avoids repeated API calls for the same list.
 * TTL: lives for the process lifetime (acceptable — list IDs don't change).
 */
const listIdCache = new Map<string, string>();

/**
 * Inflight promise map: normalized list name → pending resolve promise.
 * When multiple callers resolve the same list concurrently, only the first
 * performs the actual fetch+create. All others await the same promise.
 * Entries are removed once the promise settles (success or failure).
 */
const listIdInflight = new Map<string, Promise<string>>();

/**
 * Clear the list ID cache. Useful after operations that change list names
 * (e.g. renameList, deleteList) or for testing.
 * @internal Exported for testing and internal use by renameList/deleteList.
 */
export function clearListIdCache(): void {
  listIdCache.clear();
  // Don't clear inflight — let pending operations complete
}

/**
 * Resolve the MS To-Do list ID for a task.
 * Builds the list name from category + project (e.g. "Work / HomeLab").
 */
export async function resolveListIdForTask(task: Task): Promise<string> {
  const listName = buildListName(task.category, task.project);
  return resolveListId(listName);
}

async function resolveListId(listName: string): Promise<string> {
  const config = await getConfig();
  const mapping = getMsTodoConfig(config)?.list_mapping ?? {};

  // Check explicit mapping first
  if (mapping[listName]) {
    return mapping[listName];
  }

  const cacheKey = listName.toLowerCase();

  // Fast path: already resolved
  const cached = listIdCache.get(cacheKey);
  if (cached) return cached;

  // Dedup path: another caller is already resolving this exact list name
  const inflight = listIdInflight.get(cacheKey);
  if (inflight) return inflight;

  // We are the first caller — do the actual work
  const promise = resolveListIdImpl(listName, cacheKey);
  listIdInflight.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    listIdInflight.delete(cacheKey);
  }
}

/**
 * Internal implementation: fetch lists from MS To-Do, find or create the list.
 * Only one concurrent call per list name will reach here (guarded by inflight map).
 */
async function resolveListIdImpl(listName: string, cacheKey: string): Promise<string> {
  // Find list by name
  const token = await getAccessToken();
  const lists = await fetchTaskLists(token);
  const match = lists.find(
    (l) => l.displayName.toLowerCase() === cacheKey,
  );
  if (match) {
    listIdCache.set(cacheKey, match.id);
    return match.id;
  }

  // No matching list — create one with this name
  if (listName) {
    const created = await createList(listName);
    listIdCache.set(cacheKey, created.id);
    return created.id;
  }

  // Fall back to default "Tasks" list for empty list name
  const defaultList = lists.find(
    (l) => l.displayName === 'Tasks' || l.displayName === 'Aufgaben',
  );
  if (defaultList) {
    listIdCache.set(cacheKey, defaultList.id);
    return defaultList.id;
  }

  if (lists.length > 0) {
    listIdCache.set(cacheKey, lists[0].id);
    return lists[0].id;
  }

  throw new Error('No task lists found in Microsoft To-Do');
}

// -- Body composition/parsing helpers --

/**
 * Compose a MS To-Do body from the 3 text fields.
 * Format: description, then --- separator, then ## Summary / ## Notes sections.
 */
function composeMsTodoBody(description: string, summary: string, note: string, phase?: TaskPhase, parentTaskId?: string, conversationLog?: string, needsAttention?: boolean, dependsOn?: string[]): string {
  // Header lines (Phase, Parent, Attention) are placed before the description/sections
  const headers: string[] = [];
  if (phase) headers.push(`Phase: ${phase}`);
  if (parentTaskId) headers.push(`Parent: ${parentTaskId.slice(0, 8)}`);
  // Note: Attention header is written for both true and false. On parse, an absent
  // header yields undefined (not false), so pre-existing tasks without the header
  // won't have needs_attention cleared on pull — only tasks pushed with this field
  // round-trip correctly. This is intentional: absence = "no remote opinion."
  if (needsAttention !== undefined) headers.push(`Attention: ${needsAttention}`);
  if (dependsOn?.length) headers.push(`DependsOn: ${dependsOn.map(id => id.slice(0, 8)).join(',')}`);
  const prefix = headers.length > 0 ? headers.join('\n') + '\n\n' : '';
  const sections: string[] = [];
  if (description) sections.push(description);
  const sub: string[] = [];
  if (summary) sub.push(`## Summary\n${summary}`);
  if (note) sub.push(`## Notes\n${note}`);
  if (conversationLog) sub.push(`## Conversation Log\n${conversationLog}`);
  if (sub.length > 0) {
    sections.push(sub.join('\n\n'));
  }
  if (sections.length === 0) return prefix.trimEnd();
  return prefix + sections.join('\n\n---\n\n');
}

/**
 * Parse a MS To-Do body back into description, summary, and note.
 * If the body doesn't have the expected structure, put everything in note.
 */
export function parseMsTodoBody(body: string): { description: string; summary: string; note: string; conversation_log?: string; phase?: TaskPhase; parent_task_id?: string; needs_attention?: boolean; depends_on?: string[] } {
  if (!body || !body.trim()) return { description: '', summary: '', note: '' };

  // Extract header lines (Phase:, Parent:, Attention:, DependsOn:) from the top of the body
  let phase: TaskPhase | undefined;
  let parentTaskId: string | undefined;
  let needsAttention: boolean | undefined;
  let dependsOn: string[] | undefined;
  let bodyToParse = body;

  // Strip header lines one at a time from the top (allow \n or end-of-string)
  const headerPattern = /^(Phase|Parent|Attention|DependsOn):\s*(\S+)\s*(?:\n|$)/;
  let match: RegExpMatchArray | null;
  while ((match = bodyToParse.match(headerPattern))) {
    const [fullMatch, key, value] = match;
    if (key === 'Phase' && VALID_PHASES.has(value)) {
      phase = value as TaskPhase;
    } else if (key === 'Parent') {
      parentTaskId = value;
    } else if (key === 'Attention') {
      needsAttention = value === 'true';
    } else if (key === 'DependsOn') {
      dependsOn = value.split(',').filter(Boolean);
    }
    bodyToParse = bodyToParse.slice(fullMatch.length);
  }
  // Strip leading blank line after headers
  bodyToParse = bodyToParse.replace(/^\n/, '');

  // Try to split on --- separator
  const hrParts = bodyToParse.split(/\n\n---\n\n/);
  if (hrParts.length >= 2) {
    const description = hrParts[0].trim();
    const rest = hrParts.slice(1).join('\n\n---\n\n');
    const { summary, note, conversation_log } = parseSections(rest);
    return { description, summary, note, conversation_log, phase, parent_task_id: parentTaskId, ...(needsAttention !== undefined ? { needs_attention: needsAttention } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
  }

  // No separator — try to parse sections directly
  const hasSections = /^## (Summary|Notes|Conversation Log)\b/m.test(bodyToParse);
  if (hasSections) {
    const { summary, note, conversation_log } = parseSections(bodyToParse);
    return { description: '', summary, note, conversation_log, phase, parent_task_id: parentTaskId, ...(needsAttention !== undefined ? { needs_attention: needsAttention } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
  }

  // Unstructured body — put everything in note
  return { description: '', summary: '', note: bodyToParse.trim(), phase, parent_task_id: parentTaskId, ...(needsAttention !== undefined ? { needs_attention: needsAttention } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
}

/** Parse ## Summary, ## Notes, and ## Conversation Log sections from text. */
function parseSections(text: string): { summary: string; note: string; conversation_log?: string } {
  let summary = '';
  let note = '';
  let conversationLog = '';

  const summaryMatch = text.match(/## Summary\n([\s\S]*?)(?=\n## (?:Notes|Conversation Log)\b|$)/);
  if (summaryMatch) summary = summaryMatch[1].trim();

  const noteMatch = text.match(/## Notes\n([\s\S]*?)(?=\n## Conversation Log\b|$)/);
  if (noteMatch) note = noteMatch[1].trim();

  const logMatch = text.match(/## Conversation Log\n([\s\S]*?)$/);
  if (logMatch) conversationLog = logMatch[1].trim();

  // If no sections matched, put it all in note
  if (!summary && !note && !conversationLog && text.trim()) {
    note = text.trim();
  }

  return { summary, note, ...(conversationLog ? { conversation_log: conversationLog } : {}) };
}

// -- Format conversion --

export function mapToRemote(task: Task): Partial<MSTodoTask> {
  const msTask: Record<string, unknown> = {
    title: task.title,
    status: phaseToMsStatus(task.phase) ?? 'notStarted',
    importance: PRIORITY_TO_IMPORTANCE[task.priority] ?? 'normal',
  };

  // Combine description + summary + note into body with section markers
  const bodyContent = composeMsTodoBody(task.description, task.summary, task.note, task.phase, task.parent_task_id, task.conversation_log, task.needs_attention, task.depends_on);
  if (bodyContent) {
    msTask.body = {
      content: bodyContent,
      contentType: 'text',
    };
  }

  if (task.due_date) {
    msTask.dueDateTime = {
      dateTime: task.due_date + 'T00:00:00.0000000',
      timeZone: 'UTC',
    };
  }

  if (task.phase === 'COMPLETE' && task.completed_at) {
    msTask.completedDateTime = {
      dateTime: task.completed_at,
      timeZone: 'UTC',
    };
  }

  return msTask as Partial<MSTodoTask>;
}

export function mapToLocal(
  msTask: MSTodoTask,
  listDisplayName: string,
): Partial<Task> {
  const { group, listName } = parseGroupFromCategory(listDisplayName);

  // Parse body first to extract phase
  const parsed = msTask.body?.content ? parseMsTodoBody(msTask.body.content) : undefined;

  // Phase determination: MS To-Do status overrides for explicit user actions
  let phase: TaskPhase;
  if (msTask.status === 'completed') {
    phase = 'COMPLETE';
  } else if (msTask.status === 'notStarted' && parsed?.phase && parsed.phase !== 'TODO') {
    phase = 'TODO'; // user reopened
  } else {
    phase = parsed?.phase ?? phaseFromMsStatus(msTask.status);
  }

  const local: Partial<Task> = {
    title: msTask.title,
    status: deriveStatusFromPhase(phase),
    phase,
    priority: IMPORTANCE_TO_PRIORITY[msTask.importance] ?? 'none',
    ext: { 'ms-todo': { id: msTask.id } },
    category: group,
    project: listName,
  };

  if (parsed) {
    local.description = parsed.description;
    local.summary = parsed.summary;
    local.note = parsed.note;
    if (parsed.conversation_log) local.conversation_log = parsed.conversation_log;
    // Parent task ID prefix — stored as-is; resolved to full ID during reconcile
    if (parsed.parent_task_id) local.parent_task_id = parsed.parent_task_id;
    if (parsed.needs_attention !== undefined) local.needs_attention = parsed.needs_attention;
    // Dependency ID prefixes — stored as-is; resolved to full IDs during reconcile
    if (parsed.depends_on) local.depends_on = parsed.depends_on;
  }

  if (msTask.dueDateTime?.dateTime) {
    local.due_date = msTask.dueDateTime.dateTime.split('T')[0];
  }

  if (msTask.completedDateTime?.dateTime) {
    local.completed_at = new Date(msTask.completedDateTime.dateTime).toISOString();
  }

  return local;
}

// -- Push/pull operations --

export async function pushTask(task: Task): Promise<string> {
  const token = await getAccessToken();
  const listId = await resolveListIdForTask(task);
  const msBody = mapToRemote(task);

  let msTaskId: string;
  let actualListId = listId;

  const existingMsTodoId = getMsTodoId(task);
  const existingMsTodoList = getMsTodoList(task);

  if (existingMsTodoId) {
    // Check if the task moved to a different list (category changed)
    const oldListId = existingMsTodoList;
    if (oldListId && oldListId !== listId) {
      // Task moved lists: delete from old list, create in new list
      try {
        await graphRequest<Record<string, never>>(
          token,
          'DELETE',
          `/me/todo/lists/${oldListId}/tasks/${existingMsTodoId}`,
        );
      } catch (err) {
        // Old task may already be gone — log warning and continue with create
        log.web.warn('MS To-Do: failed to delete task from old list during migration', {
          taskId: task.id, oldListId, msTaskId: existingMsTodoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const created = await graphRequest<MSTodoTask>(
        token,
        'POST',
        `/me/todo/lists/${listId}/tasks`,
        msBody,
      );
      msTaskId = created.id;

      // Layer 3: track old ID in previous_ids for pull-side dedup
      const prevIds = ((msExt(task) as any)?.previous_ids as string[] ?? []).slice();
      if (!prevIds.includes(existingMsTodoId)) prevIds.push(existingMsTodoId);
      // Cap at 10 to prevent unbounded growth
      if (prevIds.length > 10) prevIds.splice(0, prevIds.length - 10);
      if (!task.ext) task.ext = {};
      if (!task.ext['ms-todo']) task.ext['ms-todo'] = {};
      (task.ext['ms-todo'] as Record<string, unknown>).previous_ids = prevIds;
    } else {
      // Same list — update in place
      try {
        await graphRequest<MSTodoTask>(
          token,
          'PATCH',
          `/me/todo/lists/${listId}/tasks/${existingMsTodoId}`,
          msBody,
        );
        msTaskId = existingMsTodoId;
      } catch {
        // PATCH failed (task not found in list) — try creating fresh
        const created = await graphRequest<MSTodoTask>(
          token,
          'POST',
          `/me/todo/lists/${listId}/tasks`,
          msBody,
        );
        msTaskId = created.id;

        // Track old ID as previous if we had to re-create
        if (existingMsTodoId !== msTaskId) {
          const prevIds = ((msExt(task) as any)?.previous_ids as string[] ?? []).slice();
          if (!prevIds.includes(existingMsTodoId)) prevIds.push(existingMsTodoId);
          if (prevIds.length > 10) prevIds.splice(0, prevIds.length - 10);
          if (!task.ext) task.ext = {};
          if (!task.ext['ms-todo']) task.ext['ms-todo'] = {};
          (task.ext['ms-todo'] as Record<string, unknown>).previous_ids = prevIds;
        }
      }
    }
  } else {
    // Create new
    const created = await graphRequest<MSTodoTask>(
      token,
      'POST',
      `/me/todo/lists/${listId}/tasks`,
      msBody,
    );
    msTaskId = created.id;
  }

  // Persist list ID change back to local task via ext
  // (caller should persist these changes)
  if (!task.ext) task.ext = {};
  if (!task.ext['ms-todo']) task.ext['ms-todo'] = {};
  (task.ext['ms-todo'] as Record<string, unknown>).id = msTaskId;
  (task.ext['ms-todo'] as Record<string, unknown>).list_id = actualListId;

  // Subtask checklist sync removed (subtasks are now child tasks)

  return msTaskId;
}

export async function pullTasks(
  listId: string,
): Promise<{ tasks: MSTodoTask[]; deltaLink?: string }> {
  const token = await getAccessToken();

  // Check for existing delta link
  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });
  const existingDelta = deltaState.deltaLinks[listId];

  let allTasks: MSTodoTask[] = [];
  let nextLink: string | undefined;
  let deltaLink: string | undefined;

  // Use delta link if available, otherwise full fetch
  const initialUrl = existingDelta ?? `/me/todo/lists/${listId}/tasks/delta`;

  let response: GraphResponse<MSTodoTask>;
  try {
    response = await graphRequest<GraphResponse<MSTodoTask>>(
      token,
      'GET',
      initialUrl,
    );
  } catch (err) {
    // Delta link expired (410 Gone or similar) — fall back to full initial sync
    if (existingDelta && err instanceof Error && err.message.includes(' 410')) {
      log.web.info('MS To-Do delta link expired, performing full resync', { listId });
      delete deltaState.deltaLinks[listId];
      await writeJsonFile(DELTA_FILE, deltaState);
      response = await graphRequest<GraphResponse<MSTodoTask>>(
        token,
        'GET',
        `/me/todo/lists/${listId}/tasks/delta`,
      );
    } else {
      throw err;
    }
  }
  allTasks.push(...response.value);
  nextLink = response['@odata.nextLink'];
  deltaLink = response['@odata.deltaLink'];

  // Follow pagination
  while (nextLink) {
    response = await graphRequest<GraphResponse<MSTodoTask>>(
      token,
      'GET',
      nextLink,
    );
    allTasks.push(...response.value);
    nextLink = response['@odata.nextLink'];
    deltaLink = response['@odata.deltaLink'];
  }

  // Save new delta link
  if (deltaLink) {
    deltaState.deltaLinks[listId] = deltaLink;
    deltaState.lastSync = new Date().toISOString();
    await writeJsonFile(DELTA_FILE, deltaState);
  }

  return { tasks: allTasks, deltaLink };
}

// -- Sync status --

export interface MsTodoSyncStatus {
  configured: boolean;
  authenticated: boolean;
  lastSync: string | null;
  deltaLinksCount: number;
}

export async function getMsTodoSyncStatus(): Promise<MsTodoSyncStatus> {
  const config = await getConfig();
  const configured = !!getMsTodoConfig(config)?.client_id;

  if (!configured) {
    return { configured: false, authenticated: false, lastSync: null, deltaLinksCount: 0 };
  }

  let authenticated = false;
  try {
    await getAccessToken();
    authenticated = true;
  } catch {
    // Not authenticated
  }

  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });

  return {
    configured,
    authenticated,
    lastSync: deltaState.lastSync || null,
    deltaLinksCount: Object.keys(deltaState.deltaLinks).length,
  };
}

// -- Deleted ID tracking (prevents re-import of intentionally deleted tasks) --

/**
 * Register a remote MS To-Do task ID as "deleted locally".
 * The next pull will skip any remote task with this ID instead of re-importing it.
 * Also registers any previous_ids associated with the task.
 */
export async function registerDeletedMsIds(task: Task): Promise<void> {
  const msId = getMsTodoId(task);
  const prev = (msExt(task) as any)?.previous_ids as string[] | undefined;
  const idsToRegister = [msId, ...(prev ?? [])].filter(Boolean) as string[];
  if (idsToRegister.length === 0) return;

  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });
  const existing = new Set(deltaState.deletedMsIds ?? []);
  for (const id of idsToRegister) existing.add(id);
  // Cap at 500 entries to prevent unbounded growth
  const arr = [...existing];
  deltaState.deletedMsIds = arr.length > 500 ? arr.slice(arr.length - 500) : arr;
  await writeJsonFile(DELTA_FILE, deltaState);
}

// -- Auto-push (fire-and-forget with per-task dedup) --

/** Inflight push promises keyed by task ID. Prevents duplicate concurrent pushes. */
const pushInflight = new Map<string, Promise<string | null>>();

/**
 * Push a single task to Microsoft To-Do. Returns the ms_todo_id on success, null on failure.
 * Designed for fire-and-forget usage — never throws.
 * Per-task dedup: concurrent calls for the same task reuse the inflight promise.
 */
export async function autoPushTask(task: Task): Promise<string | null> {
  const key = task.id;
  const existing = pushInflight.get(key);
  if (existing) return existing;

  const promise = pushTask(task)
    .catch(() => null)
    .finally(() => pushInflight.delete(key));
  pushInflight.set(key, promise);
  return promise;
}

// -- Shared pull-reconcile logic --

/** @internal Exported for testing. */
export async function reconcilePulledTasks(
  msTasks: MSTodoTask[],
  list: MSTodoList,
  localByMsId: Map<string, Task>,
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
  token?: string,
  deletedMsIds?: Set<string>,
): Promise<number> {
  let count = 0;
  const { group: listCategory, listName: listProject } = parseGroupFromCategory(list.displayName);
  for (const msTask of msTasks) {
    // Skip tasks with missing or empty titles (tombstones, partial delta responses)
    if (!msTask.title || msTask.title.trim() === '') continue;

    // Skip tasks that were intentionally deleted locally (Layer 0b)
    if (deletedMsIds?.has(msTask.id)) continue;

    const existing = localByMsId.get(msTask.id);
    if (existing) {
      const remoteUpdated = new Date(msTask.lastModifiedDateTime).getTime();
      const localUpdated = new Date(existing.updated_at).getTime();
      if (remoteUpdated > localUpdated) {
        const updates = mapToLocal(msTask, list.displayName);

        // Checklist-to-subtask sync removed (subtasks are now child tasks)

        await updateLocalTask(existing.id, updates);
        count++;
      }
    } else {
      const partial = mapToLocal(msTask, list.displayName);

      await addLocalTask({
        title: partial.title ?? msTask.title,
        status: partial.status ?? 'todo',
        phase: partial.phase ?? 'TODO',
        priority: partial.priority ?? 'none',
        category: partial.category ?? listCategory,
        project: partial.project ?? listProject,
        source: 'ms-todo',
        session_ids: [],
        ext: { 'ms-todo': { id: msTask.id, list_id: list.id } },
        created_at: msTask.createdDateTime,
        updated_at: msTask.lastModifiedDateTime,
        due_date: partial.due_date,
        ...(partial.parent_task_id ? { parent_task_id: partial.parent_task_id } : {}),
        description: partial.description ?? '',
        summary: partial.summary ?? '',
        note: partial.note ?? '',
        ...(partial.conversation_log ? { conversation_log: partial.conversation_log } : {}),
      } as Omit<Task, 'id'>);
      count++;
    }
  }
  return count;
}

/** Merge remote checklist items into existing local subtasks by ms_checklist_id. */
function mergeChecklistItems(localSubtasks: Subtask[], remoteItems: MSChecklistItem[]): Subtask[] {
  const byMsId = new Map<string, Subtask>();
  for (const sub of localSubtasks) {
    if (sub.ms_checklist_id) byMsId.set(sub.ms_checklist_id, sub);
  }

  const result: Subtask[] = [...localSubtasks];

  for (const item of remoteItems) {
    const existing = byMsId.get(item.id);
    if (existing) {
      // Update existing subtask
      existing.title = item.displayName;
      existing.done = item.isChecked;
      existing.updated_at = item.checkedDateTime ?? new Date().toISOString();
    } else {
      // New remote checklist item — add locally
      result.push({
        id: generateId(),
        title: item.displayName,
        done: item.isChecked,
        ms_checklist_id: item.id,
        created_at: item.createdDateTime ?? new Date().toISOString(),
        updated_at: item.checkedDateTime ?? new Date().toISOString(),
      });
    }
  }

  return result;
}

function buildLocalByMsId(localTasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of localTasks) {
    const msId = getMsTodoId(t);
    if (msId) map.set(msId, t);
    // Layer 4: also map previous_ids so orphaned remote tasks are recognized
    const prevIds = (msExt(t) as any)?.previous_ids as string[] | undefined;
    if (prevIds) {
      for (const oldId of prevIds) {
        if (!map.has(oldId)) map.set(oldId, t);
      }
    }
  }
  return map;
}

// -- Delta pull for TUI polling --

/**
 * Pull delta changes from all To-Do lists. Returns true if any changes were found.
 * Designed for TUI polling — applies changes via provided callbacks.
 */
export async function deltaPull(
  localTasks: Task[],
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
): Promise<boolean> {
  const token = await getAccessToken();
  const lists = await fetchTaskLists(token);
  const localByMsId = buildLocalByMsId(localTasks);
  let hasChanges = false;

  // -- Detect list renames and update local tasks --
  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });
  const storedNames = deltaState.listNames ?? {};

  for (const list of lists) {
    const oldName = storedNames[list.id];
    if (oldName && oldName !== list.displayName) {
      // List was renamed — update all local tasks that belong to it
      const { group, listName } = parseGroupFromCategory(list.displayName);
      for (const task of localTasks) {
        if (getMsTodoList(task) === list.id && (task.category !== group || task.project !== listName)) {
          await updateLocalTask(task.id, { category: group, project: listName });
          hasChanges = true;
        }
      }
    }
  }

  // Persist current list names for next comparison
  const newListNames: Record<string, string> = {};
  for (const list of lists) {
    newListNames[list.id] = list.displayName;
  }
  deltaState.listNames = newListNames;
  await writeJsonFile(DELTA_FILE, deltaState);

  // -- Catch-up: fix category mismatches + remove orphaned tasks from deleted lists --
  const listNameById = new Map(lists.map(l => [l.id, l.displayName]));
  for (const task of localTasks) {
    const taskListId = getMsTodoList(task);
    if (!taskListId) continue;
    const currentListName = listNameById.get(taskListId);
    if (!currentListName) {
      // List was deleted from MS To-Do — mark task as done
      if (task.phase !== 'COMPLETE') {
        await updateLocalTask(task.id, { phase: 'COMPLETE' });
        hasChanges = true;
      }
      continue;
    }
    const { group, listName } = parseGroupFromCategory(currentListName);
    if (task.category !== group || task.project !== listName) {
      await updateLocalTask(task.id, { category: group, project: listName });
      hasChanges = true;
    }
  }

  // -- Load deleted MS IDs ignore set (Layer 0b) --
  // Use deltaState already loaded above (it has deletedMsIds from disk)
  const deletedMsIds = new Set(deltaState.deletedMsIds ?? []);

  // -- Pull task-level delta changes --
  for (const list of lists) {
    const { tasks: msTasks } = await pullTasks(list.id);
    if (msTasks.length === 0) continue;
    const count = await reconcilePulledTasks(msTasks, list, localByMsId, updateLocalTask, addLocalTask, token, deletedMsIds);
    if (count > 0) hasChanges = true;
  }

  return hasChanges;
}

// -- Full sync --

export interface SyncResult {
  pushed: number;
  pulled: number;
  errors: string[];
}

export async function syncTasks(
  localTasks: Task[],
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
): Promise<SyncResult> {
  const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

  const token = await getAccessToken();
  const lists = await fetchTaskLists(token);
  const localByMsId = buildLocalByMsId(localTasks);

  // Pre-resolve list IDs to avoid N+1 calls during push
  const listByName = new Map<string, string>();
  for (const list of lists) {
    listByName.set(list.displayName.toLowerCase(), list.id);
  }
  const defaultListId = lists[0]?.id;

  // Push local tasks that don't have ms_todo_id (only ms-todo source tasks)
  for (const task of localTasks) {
    if (task.source !== 'ms-todo') continue;
    if (!getMsTodoId(task)) {
      try {
        const msId = await pushTask(task);
        // Use cached list lookup instead of extra API call
        const taskListName = buildListName(task.category, task.project);
        const listId = listByName.get(taskListName.toLowerCase()) ?? defaultListId;
        await updateLocalTask(task.id, {
          ext: { 'ms-todo': { id: msId, list_id: listId } },
        } as Partial<Task>);
        result.pushed++;
      } catch (err) {
        result.errors.push(`Push failed for "${task.title}": ${err}`);
      }
    }
  }

  // Load deleted MS IDs ignore set (Layer 0b)
  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });
  const deletedMsIds = new Set(deltaState.deletedMsIds ?? []);

  // Pull changes from each list
  for (const list of lists) {
    try {
      const { tasks: msTasks } = await pullTasks(list.id);
      const count = await reconcilePulledTasks(msTasks, list, localByMsId, updateLocalTask, addLocalTask, token, deletedMsIds);
      result.pulled += count;
    } catch (err) {
      result.errors.push(`Pull failed for list "${list.displayName}": ${err}`);
    }
  }

  return result;
}
