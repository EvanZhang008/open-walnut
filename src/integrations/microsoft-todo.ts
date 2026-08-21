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
import { generateId, routePulledListToProject } from '../utils/format.js';
import {
  remoteListNameFor,
  getProjectRecord,
  ensureProject,
  setProjectMetadata,
  findTaskByExtId,
} from '../core/task-manager.js';
import { isRemoteIdBlocked, recordRemoteLink } from '../core/task-remote-links.js';
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
  startDateTime?: { dateTime: string; timeZone: string };
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

/**
 * Cascade-delete the remote list that backs a project (the container itself,
 * not per-task deletes). Backs the plugin's `deleteProjectRemote` hook.
 *
 * Order matters for crash-safety:
 *   1. Tombstone every task's ms id (registerDeletedMsIds) FIRST — if the
 *      list delete fails partway, the next pull must not re-import the twins.
 *   2. DELETE the list on Graph. An already-missing list is SUCCESS (idempotent
 *      retry: a previous attempt may have deleted it and died before step 3).
 *   3. Scrub the list's deltaLink/listName from delta state — a deltaLink for
 *      a deleted list 404s forever on the next delta pull.
 */
export async function deleteListForProject(args: {
  project: string;
  remoteList?: string;
  tasks: Task[];
}): Promise<void> {
  const listName = (args.remoteList ?? args.project).trim();

  for (const task of args.tasks) {
    await registerDeletedMsIds(task);
  }

  const token = await getAccessToken();
  const lists = await fetchTaskLists(token);
  const match = lists.find((l) => l.displayName.toLowerCase() === listName.toLowerCase());
  if (match) {
    await deleteList(match.id);
    const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
      deltaLinks: {},
      listNames: {},
      lastSync: '',
    });
    if (deltaState.deltaLinks[match.id] !== undefined || deltaState.listNames[match.id] !== undefined) {
      delete deltaState.deltaLinks[match.id];
      delete deltaState.listNames[match.id];
      await writeJsonFile(DELTA_FILE, deltaState);
    }
    log.web.info('ms-todo: deleted remote list for project', {
      project: args.project, list: listName, listId: match.id, tombstoned: args.tasks.length,
    });
  } else {
    // Already gone remotely — fine (idempotent retry, or user deleted it in the
    // MS To-Do app). The tombstones above still matter for any stale twins.
    log.web.info('ms-todo: remote list already absent on cascade delete', {
      project: args.project, list: listName,
    });
  }
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
 *
 * The target list name comes from the project registry via `remoteListNameFor`:
 * a project migrated off the retired two-level model keeps its `remote_list`
 * alias (e.g. "Work / HomeLab") so pushes stay in the existing remote list,
 * while a new project pushes to a list named after the project itself.
 */
export async function resolveListIdForTask(task: Task): Promise<string> {
  const listName = await remoteListNameFor(task.project || '');
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
function composeMsTodoBody(description: string, summary: string, note: string, phase?: TaskPhase, parentTaskId?: string, conversationLog?: string, unread?: boolean, dependsOn?: string[]): string {
  // Header lines (Phase, Parent, Attention) are placed before the description/sections
  const headers: string[] = [];
  if (phase) headers.push(`Phase: ${phase}`);
  if (parentTaskId) headers.push(`Parent: ${parentTaskId.slice(0, 8)}`);
  // Note: Attention header is written for both true and false. On parse, an absent
  // header yields undefined (not false), so pre-existing tasks without the header
  // won't have their read marker cleared on pull — only tasks pushed with this
  // field round-trip correctly. This is intentional: absence = "no remote opinion."
  if (unread !== undefined) headers.push(`Attention: ${unread}`);
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
export function parseMsTodoBody(body: string): { description: string; summary: string; note: string; conversation_log?: string; phase?: TaskPhase; parent_task_id?: string; unread?: boolean; depends_on?: string[] } {
  if (!body || !body.trim()) return { description: '', summary: '', note: '' };

  // Extract header lines (Phase:, Parent:, Attention:, DependsOn:) from the top of the body
  let phase: TaskPhase | undefined;
  let parentTaskId: string | undefined;
  let unread: boolean | undefined;
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
      unread = value === 'true';
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
    return { description, summary, note, conversation_log, phase, parent_task_id: parentTaskId, ...(unread !== undefined ? { unread } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
  }

  // No separator — try to parse sections directly
  const hasSections = /^## (Summary|Notes|Conversation Log)\b/m.test(bodyToParse);
  if (hasSections) {
    const { summary, note, conversation_log } = parseSections(bodyToParse);
    return { description: '', summary, note, conversation_log, phase, parent_task_id: parentTaskId, ...(unread !== undefined ? { unread } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
  }

  // Unstructured body — put everything in note
  return { description: '', summary: '', note: bodyToParse.trim(), phase, parent_task_id: parentTaskId, ...(unread !== undefined ? { unread } : {}), ...(dependsOn ? { depends_on: dependsOn } : {}) };
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
  // The wire header stays `Attention:` — an established external format; renaming
  // it would strand every task already synced. Only the local field was renamed.
  //
  // Pass `task.unread` RAW: undefined must stay undefined, because
  // composeMsTodoBody then omits the header entirely and "absent header" means
  // "no remote opinion" on pull. Coercing with Boolean() here would start writing
  // `Attention: false` onto every task that never had a marker at all.
  const bodyContent = composeMsTodoBody(task.description, task.summary, task.note, task.phase, task.parent_task_id, task.conversation_log, task.unread, task.depends_on);
  if (bodyContent) {
    msTask.body = {
      content: bodyContent,
      contentType: 'text',
    };
  }

  if (task.due_date) {
    // due_date may be date-only "2026-04-10" or full ISO "2026-04-05T16:30:00.000Z"
    // MS Graph expects "YYYY-MM-DDT00:00:00.0000000" — extract date part only
    const datePart = task.due_date.split('T')[0];
    msTask.dueDateTime = {
      dateTime: datePart + 'T00:00:00.0000000',
      timeZone: 'UTC',
    };
  }

  if (task.start_date) {
    // Same day-precision contract as dueDateTime. The pull side's precision
    // echo guard (prepareRawUpdate) keeps this truncation from clobbering a
    // local time-level start_date.
    const datePart = task.start_date.split('T')[0];
    msTask.startDateTime = {
      dateTime: datePart + 'T00:00:00.0000000',
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
  // routePulledListToProject, NOT the raw split: 'Quick Start' / 'Inbox' lists
  // map to Inbox ('') exactly like the v5 migration routed them (see the WHY in
  // src/utils/format.ts — migration and pull must agree or sync undoes it).
  const project = routePulledListToProject(listDisplayName);

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
    project,
  };

  if (parsed) {
    local.description = parsed.description;
    local.summary = parsed.summary;
    local.note = parsed.note;
    if (parsed.conversation_log) local.conversation_log = parsed.conversation_log;
    // Parent task ID prefix — stored as-is; resolved to full ID during reconcile
    if (parsed.parent_task_id) local.parent_task_id = parsed.parent_task_id;
    // Wire header is `Attention:` (the external name for the read marker). Note the
    // sync reconciler drops the marker from remote patches anyway (local read state
    // wins) — this only matters for a freshly IMPORTED task.
    if (parsed.unread !== undefined) local.unread = parsed.unread;
    // Dependency ID prefixes — stored as-is; resolved to full IDs during reconcile
    if (parsed.depends_on) local.depends_on = parsed.depends_on;
  }

  // Deliberately OMIT the date keys when the remote has none, rather than
  // emitting an explicit clear: a pull that races a not-yet-pushed local edit
  // (push failed / remote had an unrelated newer edit) would otherwise wipe the
  // local date. Cost: a clear made in the MS To-Do app itself doesn't propagate
  // here — acceptable, since local clears DO propagate (pushTask PATCHes
  // dueDateTime/startDateTime: null explicitly), which kills the old
  // "cleared date resurrects on next pull" loop at the source.
  if (msTask.dueDateTime?.dateTime) {
    local.due_date = msTask.dueDateTime.dateTime.split('T')[0];
  }

  if (msTask.startDateTime?.dateTime) {
    local.start_date = msTask.startDateTime.dateTime.split('T')[0];
  }

  if (msTask.completedDateTime?.dateTime) {
    local.completed_at = new Date(msTask.completedDateTime.dateTime).toISOString();
  }

  return local;
}

// -- Project registry bridge (pull side) --

/**
 * "The task store isn't there at all" (missing native binding, handle never
 * opened) vs. a REAL store error. Only the former may degrade silently: it is
 * the unit-test shape, where no SQLite file exists. A real failure must not be
 * papered over — importing a list's tasks under an unverified project name is
 * how a pull re-claims a project another provider owns.
 */
function isStoreUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /task-db is not open/i.test(msg) ||
    /before database was successfully opened/i.test(msg) ||
    /bindings file/i.test(msg) ||            // better-sqlite3 native module missing
    /SQLITE_CANTOPEN/i.test(msg) ||
    /reading 'prepare'/.test(msg)            // getDb()! returned null
  );
}

/**
 * Registry side-effect of a pull: ensure the list's project exists, and for a
 * legacy "Category / Project" list name remember the FULL display name as the
 * project's `remote_list` alias so later pushes keep landing in that exact
 * remote list instead of forking a new one named after the project.
 *
 * Never renames or creates anything remote. Returns the canonical project name,
 * or null when this list must NOT be imported: either the name yields no project
 * (Inbox is structurally local-only, so a provider task can't live there) or the
 * project is already claimed by a different provider. Both cases used to surface
 * as a create-time throw; skipping is the same outcome without the noise.
 *
 * The alias is written only when the project has none yet (first writer wins).
 * Two legacy lists can flatten onto one project ("Work / VPA" + "Personal / VPA"
 * → "VPA"); silently repointing pushes at whichever list was pulled last would
 * shuffle tasks between remote lists on every tick. Updating an existing alias
 * happens only from the rename detector below, which knows it is the same list.
 *
 * Only called for lists that actually have items to import, so an empty remote
 * list never manufactures a registry row.
 */
async function ensureProjectForList(listDisplayName: string): Promise<string | null> {
  // Same routing rule as the v5 migration: a 'Quick Start' trailing segment or a
  // whole-name 'Inbox' list is Inbox ('') locally, which a provider can never
  // claim → skip the list rather than resurrect the retired grouping name as a
  // project (see routePulledListToProject's WHY).
  const parsed = routePulledListToProject(listDisplayName);
  if (!parsed) {
    log.web.debug('ms-todo: list name maps to Inbox / no project, skipping', { list: listDisplayName });
    return null;
  }
  try {
    // The EXISTING row always wins (spelling AND claim) — a pull can never
    // re-claim a project another provider owns.
    const { name, source } = await ensureProject(parsed, 'ms-todo');
    if (source !== 'ms-todo') {
      log.web.debug('ms-todo: project claimed by another source, skipping list', {
        project: name, source, list: listDisplayName,
      });
      return null;
    }
    // Case-insensitive: list resolution lowercases, so a spelling-only
    // difference is the same remote list and needs no alias.
    if (listDisplayName.toLowerCase() === name.toLowerCase()) return name;
    const existing = (await getProjectRecord(name))?.metadata?.remote_list;
    if (typeof existing === 'string' && existing.trim()) {
      if (existing !== listDisplayName) {
        log.web.debug('ms-todo: project already aliased to another remote list', {
          project: name, alias: existing, list: listDisplayName,
        });
      }
      return name;
    }
    await setProjectMetadata(name, { remote_list: listDisplayName });
    return name;
  } catch (err) {
    if (isStoreUnavailableError(err)) {
      // No task DB at all (unit-test env) — fall back to the routed name rather
      // than dropping the whole list's tasks.
      log.web.debug('ms-todo: project registry update skipped (no task store)', {
        list: listDisplayName,
        error: err instanceof Error ? err.message : String(err),
      });
      return parsed;
    }
    // A real store error means we do NOT know who owns this project. Importing
    // under an unverified name could steal another provider's claim — skip the
    // list loudly and let the next tick retry.
    log.web.error('ms-todo: project registry update failed, skipping list', {
      list: listDisplayName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A remote list we already track was renamed. Same list object, new display
 * name, so the project's alias must follow it — otherwise the next push
 * resolves the vanished old name and MS To-Do creates a duplicate list.
 *
 * Unlike ensureProjectForList this OVERWRITES an existing alias: we know it is
 * the same remote list, just renamed. Returns the canonical project name, or
 * null when the new name maps to nothing importable.
 */
async function syncProjectAliasAfterRename(listDisplayName: string): Promise<string | null> {
  const parsed = routePulledListToProject(listDisplayName);
  if (!parsed) return null;
  try {
    const { name, source } = await ensureProject(parsed, 'ms-todo');
    if (source !== 'ms-todo') return null;
    // Written even when it equals the project name: an alias identical to the
    // name resolves to the same list, so no separate "clear the alias" state is
    // needed — and leaving a stale alias behind would resolve the OLD name.
    const current = (await getProjectRecord(name))?.metadata?.remote_list;
    if (typeof current !== 'string' || current.toLowerCase() !== listDisplayName.toLowerCase()) {
      await setProjectMetadata(name, { remote_list: listDisplayName });
    }
    return name;
  } catch (err) {
    if (isStoreUnavailableError(err)) {
      log.web.debug('ms-todo: project alias update skipped (no task store)', {
        list: listDisplayName,
        error: err instanceof Error ? err.message : String(err),
      });
      return parsed;
    }
    log.web.error('ms-todo: project alias update failed, skipping list', {
      list: listDisplayName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// -- Push/pull operations --

export async function pushTask(task: Task): Promise<{ msTaskId: string; serverTimestamp: string }> {
  // Guard: never push a task whose project is claimed by a different source.
  // Keeps ms-todo from creating remote lists for projects another plugin owns.
  // Inbox ('') has no registry row and can never be claimed, so a provider task
  // there is itself a bug — refuse rather than create an unnamed remote list.
  const taskProject = task.project || '';
  if (!taskProject) {
    throw new Error(
      `pushTask: refusing to push task "${task.title}" to MS Todo — ` +
      `it has no project (Inbox tasks are local-only)`,
    );
  }
  try {
    const record = await getProjectRecord(taskProject);
    if (record && record.source !== 'ms-todo') {
      throw new Error(
        `pushTask: refusing to push task "${task.title}" to MS Todo — ` +
        `project "${taskProject}" is registered as ${record.source}`,
      );
    }
  } catch (err) {
    // Re-throw project source conflicts.
    if (err instanceof Error && err.message.startsWith('pushTask: refusing')) throw err;
    // No store at all (unit-test env) → proceed; the claim check is the store's
    // job and there is no store. A REAL store error means the claim is unknown,
    // and pushing anyway can create a remote list for a project another provider
    // owns — refuse instead and let the next tick retry.
    if (!isStoreUnavailableError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      log.web.error('ms-todo: project registry read failed, refusing push', {
        taskId: task.id, project: taskProject, error: message,
      });
      throw new Error(
        `pushTask: refusing to push task "${task.title}" to MS Todo — ` +
        `project registry unreadable (${message})`,
      );
    }
  }

  const token = await getAccessToken();
  const listId = await resolveListIdForTask(task);
  const msBody = mapToRemote(task);

  let msTaskId: string;
  let serverTimestamp: string = new Date().toISOString(); // fallback, overwritten by API response
  let actualListId = listId;

  const existingMsTodoId = getMsTodoId(task);
  const existingMsTodoList = getMsTodoList(task);

  if (existingMsTodoId) {
    // Check if the task moved to a different list (project changed)
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
      log.web.info('ms-todo POST create', {
        taskId: task.id,
        title: task.title,
        project: task.project,
        oldListId,
        newListId: listId,
        oldMsTodoId: existingMsTodoId,
        reason: 'list_migration',
      });
      const created = await graphRequest<MSTodoTask>(
        token,
        'POST',
        `/me/todo/lists/${listId}/tasks`,
        msBody,
      );
      msTaskId = created.id;
      serverTimestamp = created.lastModifiedDateTime;
      log.web.info('ms-todo ext.id assigned', {
        taskId: task.id,
        oldId: existingMsTodoId,
        newId: msTaskId,
        reason: 'list_migration',
      });

      // Layer 3: track old ID in previous_ids for pull-side dedup
      const prevIds = ((msExt(task) as any)?.previous_ids as string[] ?? []).slice();
      if (!prevIds.includes(existingMsTodoId)) prevIds.push(existingMsTodoId);
      // Cap at 10 to prevent unbounded growth
      if (prevIds.length > 10) prevIds.splice(0, prevIds.length - 10);
      if (!task.ext) task.ext = {};
      if (!task.ext['ms-todo']) task.ext['ms-todo'] = {};
      (task.ext['ms-todo'] as Record<string, unknown>).previous_ids = prevIds;
    } else {
      // Same list — update in place.
      // If PATCH fails (network, auth, 5xx, rate limit, or even 404), throw and let
      // the upper layer set sync_error. The next sync tick will retry the PATCH with
      // the same ext.id. NEVER fallback to POST create — doing so leaves the original
      // remote task as an orphan and produces ghost duplicates on the next full pull.
      try {
        // Clears must be explicit on PATCH: mapToRemote omits absent dates, and
        // Graph treats an omitted field as "leave unchanged" — so a locally
        // cleared start/due would survive remotely and resurrect on the next
        // pull. `null` is Graph's documented "delete this field" marker.
        const patchBody: Record<string, unknown> = { ...msBody };
        if (!task.due_date) patchBody.dueDateTime = null;
        if (!task.start_date) patchBody.startDateTime = null;
        const patched = await graphRequest<MSTodoTask>(
          token,
          'PATCH',
          `/me/todo/lists/${listId}/tasks/${existingMsTodoId}`,
          patchBody,
        );
        msTaskId = existingMsTodoId;
        serverTimestamp = patched.lastModifiedDateTime;
      } catch (err) {
        // Log before re-throwing — next tick will retry with the same ext.id
        const errMsg = err instanceof Error ? err.message : String(err);
        const httpStatus = (err as { status?: number })?.status;
        log.web.warn('ms-todo PATCH failed (will retry next tick with same ext.id)', {
          taskId: task.id,
          existingMsTodoId,
          listId,
          httpStatus,
          error: errMsg,
        });
        throw err;
      }
    }
  } else {
    // Create new — this is the ONLY path that creates a new remote task for a task
    // that currently has no ext.id. If you see this log firing repeatedly for the
    // same taskId, something is clearing ext.id between calls — that's the ghost bug.
    log.web.info('ms-todo POST create', {
      taskId: task.id,
      title: task.title,
      project: task.project,
      listId,
      reason: 'first_create',
    });
    const created = await graphRequest<MSTodoTask>(
      token,
      'POST',
      `/me/todo/lists/${listId}/tasks`,
      msBody,
    );
    msTaskId = created.id;
    serverTimestamp = created.lastModifiedDateTime;
    log.web.info('ms-todo ext.id assigned', {
      taskId: task.id,
      newId: msTaskId,
      reason: 'first_create',
    });
  }

  // Persist list ID change back to local task via ext
  // (caller should persist these changes)
  if (!task.ext) task.ext = {};
  if (!task.ext['ms-todo']) task.ext['ms-todo'] = {};
  (task.ext['ms-todo'] as Record<string, unknown>).id = msTaskId;
  (task.ext['ms-todo'] as Record<string, unknown>).list_id = actualListId;

  // Subtask checklist sync removed (subtasks are now child tasks)

  return { msTaskId, serverTimestamp };
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

/**
 * Full pull for reconciliation — fetch ALL tasks from ALL lists (no delta, no timestamp filter).
 * Returns a flat list of { remoteId, title, remoteUpdatedAt, fields } for three-way diff.
 */
export async function fullPullAllTasks(): Promise<Array<{
  remoteId: string;
  title: string;
  remoteUpdatedAt: string;
  fields: Partial<Task>;
}>> {
  const token = await getAccessToken();
  const lists = await fetchTaskLists(token);
  const result: Array<{ remoteId: string; title: string; remoteUpdatedAt: string; fields: Partial<Task> }> = [];

  // Load deleted MS IDs — skip tasks we intentionally deleted locally
  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });
  const deletedMsIds = new Set(deltaState.deletedMsIds ?? []);
  importLegacyTombstonesOnce(deltaState.deletedMsIds);

  for (const list of lists) {
    // Non-delta full fetch: /me/todo/lists/{listId}/tasks (no /delta suffix)
    let allTasks: MSTodoTask[] = [];
    let response = await graphRequest<GraphResponse<MSTodoTask>>(
      token, 'GET', `/me/todo/lists/${list.id}/tasks`,
    );
    allTasks.push(...response.value);
    let nextLink = response['@odata.nextLink'];
    while (nextLink) {
      response = await graphRequest<GraphResponse<MSTodoTask>>(token, 'GET', nextLink);
      allTasks.push(...response.value);
      nextLink = response['@odata.nextLink'];
    }

    // Registry row + remote_list alias for this list, before any task references
    // it. Also yields the canonical spelling, so two lists differing only in case
    // can't split one project. null = this list is not ours to import.
    if (allTasks.length === 0) continue;
    const listProject = await ensureProjectForList(list.displayName);
    if (listProject === null) continue;

    for (const msTask of allTasks) {
      if (deletedMsIds.has(msTask.id)) continue;
      // Same [Moved]-marker gate as the delta path: a marked item is a released
      // identity, not a task. Ledgered here so the reconciler's isRemoteIdBlocked
      // create-gate also refuses it forever after.
      if (ledgerMovedMarker(msTask, list.id)) continue;
      const fields = mapToLocal(msTask, list.displayName);
      fields.project = listProject;
      // Ensure ext includes list_id for completeness
      if (fields.ext?.['ms-todo']) {
        (fields.ext['ms-todo'] as Record<string, unknown>).list_id = list.id;
      }
      result.push({
        remoteId: msTask.id,
        title: msTask.title,
        remoteUpdatedAt: msTask.lastModifiedDateTime,
        fields,
      });
    }
  }

  return result;
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

  // Durable tombstone: the task_remote_links ledger is uncapped and survives
  // forever — the JSON array below is capped at 500 and silently evicted old
  // tombstones (it was FULL when the 2026-08-20 fork investigation ran).
  try {
    const { recordRemoteLink } = await import('../core/task-remote-links.js');
    const listId = getMsTodoList(task) ?? null;
    for (const id of idsToRegister) {
      recordRemoteLink({
        source: 'ms-todo', remoteId: id, taskId: task.id, remoteList: listId,
        state: 'deleted', reason: 'local-delete',
      });
    }
  } catch {
    // No task DB (unit-test env) — the JSON fallback below still applies.
  }

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

/** One-shot flag: legacy deletedMsIds → ledger import runs once per process. */
let legacyTombstonesImported = false;

/**
 * Merge the capped legacy deletedMsIds array into the durable ledger (once per
 * process; INSERT OR IGNORE makes re-runs no-ops). Called from the pull paths,
 * which have the delta state in hand anyway.
 */
function importLegacyTombstonesOnce(deletedMsIds: string[] | undefined): void {
  if (legacyTombstonesImported || !deletedMsIds?.length) return;
  legacyTombstonesImported = true;
  import('../core/task-remote-links.js')
    .then(({ importLegacyTombstones }) => importLegacyTombstones('ms-todo', deletedMsIds))
    .catch(() => { legacyTombstonesImported = false; });
}

// -- Auto-push (fire-and-forget with per-task dedup) --

/** Inflight push promises keyed by task ID. Prevents duplicate concurrent pushes. */
const msPushInflight = new Map<string, Promise<{ msTaskId: string; serverTimestamp: string } | null>>();

/**
 * Push a single task to Microsoft To-Do. Returns { msTaskId, serverTimestamp } on success, null on failure.
 * Designed for fire-and-forget usage — never throws.
 * Per-task dedup: concurrent calls for the same task reuse the inflight promise.
 */
export async function autoPushTask(task: Task): Promise<{ msTaskId: string; serverTimestamp: string } | null> {
  const key = task.id;
  const existing = msPushInflight.get(key);
  if (existing) return existing;

  const promise = pushTask(task)
    .catch(() => null)
    .finally(() => msPushInflight.delete(key));
  msPushInflight.set(key, promise);
  return promise;
}

// -- Shared pull-reconcile logic --

/**
 * Parse the "[Moved] <title> [open-walnut:<taskId>]" marker task-manager's
 * cross-source migration writes onto the OLD remote twin. A remote item wearing
 * it is never a new task — it is the corpse of an identity this store already
 * released. Returns the embedded local task id, or null when the title carries
 * no marker. Kept tolerant: the [Moved] prefix alone (id suffix lost to a
 * remote truncation) still counts, with a null taskId.
 */
export function parseMovedMarker(title: string): { taskId: string | null } | null {
  if (!/^\s*\[Moved\]/.test(title)) return null;
  const id = /\[open-walnut:([A-Za-z0-9-]+)\]/.exec(title)?.[1] ?? null;
  return { taskId: id };
}

/**
 * Shared "is this remote item a re-import trap?" gate for BOTH pull paths
 * (delta reconcile below + the sync-reconciler's fullPull consumer via
 * isRemoteIdBlocked). A [Moved]-marked item gets ledgered as released on
 * sight, so even a marker written by a pre-ledger build (or a ledger write
 * that failed mid-migration) converges to "never re-import" here.
 */
function ledgerMovedMarker(msTask: MSTodoTask, listId: string): boolean {
  const marker = parseMovedMarker(msTask.title ?? '');
  if (!marker) return false;
  try {
    recordRemoteLink({
      source: 'ms-todo', remoteId: msTask.id, taskId: marker.taskId,
      remoteList: listId, state: 'released', reason: 'moved-marker',
    });
  } catch {
    // No task DB (unit-test env) — skipping the create below still holds.
  }
  log.web.debug('ms-todo pull: skipped [Moved]-marked remote item', {
    title: msTask.title, msId: msTask.id, localTaskId: marker.taskId,
  });
  return true;
}

/**
 * @internal Exported for testing.
 *
 * Per-item lookup via `findTaskByExtId('ms-todo', …)` replaces the
 * former 6000-row `localByMsId` Map. `previousIdsMap` covers the rare case
 * where a remote delta still references an old ms id recorded in a local
 * task's `ext['ms-todo'].previous_ids` (Layer 4 rename fallback). The caller
 * builds that tiny map from the narrow set of ms-todo local tasks that have
 * previous_ids — typically < 20 entries across the whole fleet.
 */
export async function reconcilePulledTasks(
  msTasks: MSTodoTask[],
  list: MSTodoList,
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
  token?: string,
  deletedMsIds?: Set<string>,
  previousIdsMap?: Map<string, Task>,
): Promise<number> {
  let count = 0;
  if (msTasks.length === 0) return 0; // don't manufacture a registry row for an empty list
  // Registry row + remote_list alias for this list before any task claims it.
  // Also the canonical spelling, so two lists differing only in case can't split
  // one project. null = the list maps to no importable project (Inbox, or a
  // project another provider owns) — skip it wholesale.
  const listProject = await ensureProjectForList(list.displayName);
  if (listProject === null) {
    log.web.debug('reconcilePulledTasks: skipped list (no importable project)', {
      listName: list.displayName, tasks: msTasks.length,
    });
    return 0;
  }
  for (const msTask of msTasks) {
    // Skip tasks with missing or empty titles (tombstones, partial delta responses)
    if (!msTask.title || msTask.title.trim() === '') continue;

    // Skip tasks that were intentionally deleted locally (Layer 0b)
    if (deletedMsIds?.has(msTask.id)) continue;

    // [Moved]-marker gate, BEFORE the local match: a marked item is a released
    // identity — it must neither mint a new task nor let its rename echo
    // overwrite a matched local task's title with "[Moved] …". Also ledgers
    // the release, covering markers written before the ledger existed (or
    // whose ledger write failed mid-migration).
    if (ledgerMovedMarker(msTask, list.id)) continue;

    const existing =
      (await findTaskByExtId('ms-todo', msTask.id))
      ?? previousIdsMap?.get(msTask.id);
    if (existing) {
      const remoteUpdated = new Date(msTask.lastModifiedDateTime).getTime();
      const syncedAt = existing._syncedAt ? new Date(existing._syncedAt).getTime() : 0;
      if (remoteUpdated > syncedAt) {
        const updates = mapToLocal(msTask, list.displayName);
        updates.project = listProject;

        // Checklist-to-subtask sync removed (subtasks are now child tasks)

        await updateLocalTask(existing.id, updates);
        count++;
      }
    } else {
      // Ledger gate (create only): a remote id a local task once owned — then
      // released via source migration or deleted — must NEVER mint a new local
      // task. That re-import is the fork that split tasks into sync copies
      // (141 re-created, 35 losing session links, pre-2026-08-20). The
      // deletedMsIds check above is the legacy capped array; this is durable.
      if (isRemoteIdBlocked('ms-todo', msTask.id)) {
        log.web.debug('reconcilePulledTasks: skipped ledgered remote id', {
          title: msTask.title, listName: list.displayName,
        });
        continue;
      }
      const partial = mapToLocal(msTask, list.displayName);

      try {
        await addLocalTask({
          title: partial.title ?? msTask.title,
          status: partial.status ?? 'todo',
          phase: partial.phase ?? 'TODO',
          priority: partial.priority ?? 'none',
          project: listProject,
          source: 'ms-todo',
          session_ids: [],
          ext: { 'ms-todo': { id: msTask.id, list_id: list.id } },
          created_at: msTask.createdDateTime,
          updated_at: msTask.lastModifiedDateTime,
          due_date: partial.due_date,
          start_date: partial.start_date,
          ...(partial.parent_task_id ? { parent_task_id: partial.parent_task_id } : {}),
          description: partial.description ?? '',
          summary: partial.summary ?? '',
          note: partial.note ?? '',
          ...(partial.conversation_log ? { conversation_log: partial.conversation_log } : {}),
        } as Omit<Task, 'id'>);
        count++;
      } catch (err) {
        // Skip tasks that conflict with the project's claim (e.g. an ms-todo task
        // landing in a project reserved for another plugin).
        log.web.debug('reconcilePulledTasks: skipped creating task', {
          title: msTask.title, listName: list.displayName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

/**
 * Layer 4 rename fallback: map previous_ids → Task for the rare ms-todo tasks
 * that carry a `previous_ids` array in their ext. The primary id lookup is now
 * `findTaskByExtId('ms-todo', …)` (single-row indexed SELECT), so this
 * map is intentionally narrow — it skips tasks without `previous_ids` and the
 * current id (already indexed). Typical size: < 20 entries fleet-wide.
 *
 * Intentionally not an index: `previous_ids` is an unbounded JSON array and
 * SQLite cannot build a json_extract index on array contents. Fleet-wide size
 * is small (<20 tasks currently have previous_ids), so an in-process Map is
 * cheaper than any index we could maintain. Not deleted either — keeping
 * previous_ids lets renamed lists stay resolvable across migrations.
 */
function buildMsTodoPreviousIdsMap(localTasks: Task[]): Map<string, Task> {
  const map = new Map<string, Task>();
  for (const t of localTasks) {
    if (t.source !== 'ms-todo') continue;
    const prevIds = (msExt(t) as any)?.previous_ids as string[] | undefined;
    if (!prevIds || prevIds.length === 0) continue;
    for (const oldId of prevIds) {
      if (!map.has(oldId)) map.set(oldId, t);
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
  // Narrow the list-rename / catch-up iterations to ms-todo tasks only; reconcile
  // no longer needs the pre-built localByMsId Map — per-item SQLite lookup replaces it.
  const msLocalTasks = localTasks.filter((t) => t.source === 'ms-todo');
  const previousIdsMap = buildMsTodoPreviousIdsMap(msLocalTasks);
  let hasChanges = false;

  // -- Detect list renames and update local tasks --
  const deltaState = await readJsonFile<DeltaState>(DELTA_FILE, {
    deltaLinks: {},
    listNames: {},
    lastSync: '',
  });
  const storedNames = deltaState.listNames ?? {};

  // Cache the project name per list so the catch-up pass below doesn't re-ensure.
  // `null` = the list maps to no importable project; its tasks are left alone.
  const projectByListId = new Map<string, string | null>();

  for (const list of lists) {
    const oldName = storedNames[list.id];
    if (oldName && oldName !== list.displayName) {
      // List was renamed — move its tasks to the new project and re-point the
      // project's remote_list alias at the new display name.
      const project = await syncProjectAliasAfterRename(list.displayName);
      projectByListId.set(list.id, project);
      if (project === null) continue;
      for (const task of msLocalTasks) {
        if (getMsTodoList(task) === list.id
          && (task.project || '').toLowerCase() !== project.toLowerCase()) {
          await updateLocalTask(task.id, { project });
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

  // -- Catch-up: fix project mismatches + retire tasks from deleted lists --
  const listNameById = new Map(lists.map(l => [l.id, l.displayName]));
  for (const task of msLocalTasks) {
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
    let project = projectByListId.get(taskListId);
    if (project === undefined) {
      project = await ensureProjectForList(currentListName);
      projectByListId.set(taskListId, project);
    }
    if (project === null) continue;
    // Case-insensitive: project identity ignores case, so a spelling difference
    // must not trigger a write on every tick.
    if ((task.project || '').toLowerCase() !== project.toLowerCase()) {
      await updateLocalTask(task.id, { project });
      hasChanges = true;
    }
  }

  // -- Load deleted MS IDs ignore set (Layer 0b) --
  // Use deltaState already loaded above (it has deletedMsIds from disk)
  const deletedMsIds = new Set(deltaState.deletedMsIds ?? []);
  importLegacyTombstonesOnce(deltaState.deletedMsIds);

  // -- Pull task-level delta changes --
  for (const list of lists) {
    const { tasks: msTasks } = await pullTasks(list.id);
    if (msTasks.length === 0) continue;
    const count = await reconcilePulledTasks(msTasks, list, updateLocalTask, addLocalTask, token, deletedMsIds, previousIdsMap);
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
  const msLocalTasks = localTasks.filter((t) => t.source === 'ms-todo');
  const previousIdsMap = buildMsTodoPreviousIdsMap(msLocalTasks);

  // Pre-resolve list IDs to avoid N+1 calls during push
  const listByName = new Map<string, string>();
  for (const list of lists) {
    listByName.set(list.displayName.toLowerCase(), list.id);
  }
  const defaultListId = lists[0]?.id;

  // Push local tasks that don't have ms_todo_id (only ms-todo source tasks)
  for (const task of msLocalTasks) {
    if (!getMsTodoId(task)) {
      try {
        const { msTaskId } = await pushTask(task);
        // Use cached list lookup instead of extra API call
        const taskListName = await remoteListNameFor(task.project || '');
        const listId = listByName.get(taskListName.toLowerCase()) ?? defaultListId;
        await updateLocalTask(task.id, {
          ext: { 'ms-todo': { id: msTaskId, list_id: listId } },
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
  importLegacyTombstonesOnce(deltaState.deletedMsIds);

  // Pull changes from each list
  for (const list of lists) {
    try {
      const { tasks: msTasks } = await pullTasks(list.id);
      const count = await reconcilePulledTasks(msTasks, list, updateLocalTask, addLocalTask, token, deletedMsIds, previousIdsMap);
      result.pulled += count;
    } catch (err) {
      result.errors.push(`Pull failed for list "${list.displayName}": ${err}`);
    }
  }

  return result;
}
