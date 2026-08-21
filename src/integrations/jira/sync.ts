/**
 * Jira sync logic — bidirectional sync between Walnut tasks and Jira.
 *
 * Exports: mapToLocal, autoPushTask, deltaPull, syncTasks, getJiraSyncStatus
 *
 * Follows the same pattern as ms-todo sync pattern:
 * - mapToLocal for field conversion (Jira → local)
 * - autoPushTask for fire-and-forget single-task push
 * - deltaPull for incremental pull (JQL updated >= timestamp)
 * - syncTasks for full bidirectional sync
 */

import path from 'node:path';
import { SYNC_DIR } from '../../constants.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { getConfig } from '../../core/config-manager.js';
import { createSubsystemLogger } from '../../logging/index.js';
import { bus, EventNames } from '../../core/event-bus.js';
import { deriveStatusFromPhase } from '../../core/phase.js';
import { findTaskByExtId, listUnsyncedTasks } from '../../core/task-manager.js';
import { isRemoteIdBlocked } from '../../core/task-remote-links.js';
import { JiraClient, type JiraConfig } from './jira-client.js';
import {
  PHASE_TO_JIRA_STATUS,
  phaseFromJiraStatus,
  shouldPreserveLocalPhaseJira,
  resolveTransition,
} from './workflow.js';
import { plainTextToAdf, markdownToAdf, adfToPlainText } from './adf.js';
import type { JiraIssue, JiraCreateIssueInput, JiraUpdateIssueInput } from './types.js';
import type { Task, TaskPhase, TaskPriority, Config } from '../../core/types.js';

const JIRA_SYNC_FILE = path.join(SYNC_DIR, 'jira-sync.json');

const syncLog = createSubsystemLogger('jira');

// ── Plugin-system helpers ──

/** Get the Jira config from the plugin system */
function getJiraConfig(config: Config): JiraConfig | undefined {
  return config.plugins?.jira as JiraConfig | undefined;
}

/** Extract jira ext data from a task */
function ext(task: Task): Record<string, unknown> | undefined {
  return task.ext?.jira as Record<string, unknown> | undefined;
}

interface JiraSyncState {
  lastSync: string;
}

// ── Priority mapping ──

const LOCAL_TO_JIRA_PRIORITY: Record<TaskPriority, string> = {
  immediate: 'Highest',
  important: 'High',
  backlog: 'Low',
  none: 'Medium',
};

const JIRA_TO_LOCAL_PRIORITY: Record<string, TaskPriority> = {
  'Highest': 'immediate',
  'High': 'important',
  'Medium': 'none',
  'Low': 'backlog',
  'Lowest': 'backlog',
};

// ── Field mapping: Jira → Local ──

export function mapToLocal(
  remote: JiraIssue,
  config: Config,
): Partial<Task> & { ext?: Record<string, unknown> } {
  const jiraConfig = getJiraConfig(config)!;
  const statusName = remote.fields.status.name;
  const statusCategoryKey = remote.fields.status.statusCategory?.key;
  const phase: TaskPhase = phaseFromJiraStatus(statusName, statusCategoryKey);
  const status = deriveStatusFromPhase(phase);

  // Priority mapping
  let priority: TaskPriority = 'none';
  if (remote.fields.priority?.name) {
    priority = JIRA_TO_LOCAL_PRIORITY[remote.fields.priority.name] ?? 'none';
  }

  // Walnut project from the Jira project key — reverse lookup in project_mapping,
  // fallback to the key itself. This is the ONLY grouping stamped on the task;
  // `jiraConfig.project` is the reservation/claim name, not the destination, so
  // that migrated tasks (which kept the Jira key as their project) stay put.
  let project = remote.fields.project.key;
  if (jiraConfig.project_mapping) {
    const entry = Object.entries(jiraConfig.project_mapping).find(
      ([, jiraKey]) => jiraKey === remote.fields.project.key,
    );
    if (entry) project = entry[0];
  }

  // Description — ADF to plain text
  const description = adfToPlainText(remote.fields.description);

  return {
    title: remote.fields.summary,
    status,
    phase,
    priority,
    project,
    source: 'jira',
    ext: {
      jira: {
        issue_id: remote.id,
        issue_key: remote.key,
        project_key: remote.fields.project.key,
        status_name: statusName,
      },
    },
    external_url: `${jiraConfig.base_url}/browse/${remote.key}`,
    description,
    due_date: remote.fields.duedate ?? undefined,
    created_at: remote.fields.created,
    updated_at: remote.fields.updated,
  };
}

// ── Comment composition (same pattern as MS To-Do) ──

function composeCommentBody(task: Task): string {
  const headers: string[] = [];
  if (task.parent_task_id) headers.push(`Parent: ${task.parent_task_id.slice(0, 8)}`);
  if (task.unread) headers.push(`Attention: true`);
  if (task.depends_on?.length) headers.push(`DependsOn: ${task.depends_on.map(id => id.slice(0, 8)).join(',')}`);
  const sections: string[] = [];
  if (task.summary) sections.push(`## Summary\n${task.summary}`);
  if (task.note) sections.push(`## Notes\n${task.note}`);
  if (task.conversation_log) sections.push(`## Conversation Log\n${task.conversation_log}`);
  const body = sections.join('\n\n');
  if (headers.length > 0 && body) return headers.join('\n') + '\n\n' + body;
  if (headers.length > 0) return headers.join('\n');
  return body;
}

// ── Push result ──

export interface JiraPushResult {
  jiraIssueId: string;
  jiraIssueKey: string;
  commentId?: string;
  serverTimestamp?: string;
}

/** Returned when autoPushTask fails — carries the specific error reason. */
export interface JiraPushError {
  error: string;
}

/** Type guard: is the push result a success? */
export function isJiraPushSuccess(r: JiraPushResult | JiraPushError): r is JiraPushResult {
  return 'jiraIssueId' in r;
}

// ── Push: single task to Jira ──

export async function autoPushTask(task: Task): Promise<JiraPushResult | JiraPushError> {
  try {
    const config = await getConfig();
    const jiraConfig = getJiraConfig(config);
    if (!jiraConfig?.base_url) {
      return { error: 'Jira base_url not configured' };
    }

    const client = new JiraClient(jiraConfig);
    const je = ext(task);
    const issueKey = je?.issue_key as string | undefined;
    const issueId = je?.issue_id as string | undefined;
    const statusName = je?.status_name as string | undefined;
    const commentId_raw = je?.comment_id as string | undefined;

    if (issueKey) {
      // ── Update existing issue ──
      const updateInput: JiraUpdateIssueInput = {
        fields: {
          summary: task.title,
          description: task.description ? plainTextToAdf(task.description) : undefined,
          priority: task.priority !== 'none' ? { name: LOCAL_TO_JIRA_PRIORITY[task.priority] } : undefined,
          duedate: task.due_date ?? null,
        },
      };
      await client.updateIssue(issueKey, updateInput);

      // Transition to target status if changed
      const targetStatus = PHASE_TO_JIRA_STATUS[task.phase];
      if (targetStatus && targetStatus.toLowerCase() !== (statusName ?? '').toLowerCase()) {
        try {
          const { transitions } = await client.getTransitions(issueKey);
          const transitionId = resolveTransition(transitions, targetStatus);
          if (transitionId) {
            await client.doTransition(issueKey, transitionId);
            syncLog.debug('transitioned Jira issue', { key: issueKey, to: targetStatus });
          }
        } catch (err) {
          syncLog.debug('failed to transition Jira issue', {
            key: issueKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Push comment (summary + note)
      const commentBody = composeCommentBody(task);
      let commentId = commentId_raw;
      if (commentBody) {
        const adfBody = markdownToAdf(commentBody);
        if (commentId) {
          try {
            await client.updateComment(issueKey, commentId, adfBody);
          } catch {
            try {
              const newComment = await client.addComment(issueKey, adfBody);
              commentId = newComment.id;
            } catch { /* silent */ }
          }
        } else {
          try {
            const newComment = await client.addComment(issueKey, adfBody);
            commentId = newComment.id;
          } catch { /* silent */ }
        }
      }

      // Fetch fresh issue to get server-side updated timestamp (Jira PUT returns 204)
      let serverTimestamp: string | undefined;
      try {
        const freshIssue = await client.getIssue(issueKey);
        serverTimestamp = freshIssue.fields.updated;
      } catch { /* non-fatal — _syncedAt just won't be set */ }

      syncLog.info('pushed task update to Jira', { key: issueKey, title: task.title });
      return { jiraIssueId: issueId ?? '', jiraIssueKey: issueKey, commentId, serverTimestamp };
    } else {
      // ── Create new issue ──
      const projectKey = resolveProjectKey(task, config);
      const createInput: JiraCreateIssueInput = {
        fields: {
          project: { key: projectKey },
          summary: task.title,
          issuetype: { name: jiraConfig.issue_type ?? 'Task' },
          description: task.description ? plainTextToAdf(task.description) : undefined,
          priority: task.priority !== 'none' ? { name: LOCAL_TO_JIRA_PRIORITY[task.priority] } : undefined,
          duedate: task.due_date,
        },
      };
      const created = await client.createIssue(createInput);

      // Post initial comment
      let commentId: string | undefined;
      const commentBody = composeCommentBody(task);
      if (commentBody) {
        try {
          const comment = await client.addComment(created.key, markdownToAdf(commentBody));
          commentId = comment.id;
        } catch { /* silent */ }
      }

      // Fetch fresh issue to get server-side updated timestamp
      let serverTimestamp: string | undefined;
      try {
        const freshIssue = await client.getIssue(created.key);
        serverTimestamp = freshIssue.fields.updated;
      } catch { /* non-fatal */ }

      syncLog.info('created issue in Jira', { key: created.key, title: task.title });
      return { jiraIssueId: created.id, jiraIssueKey: created.key, commentId, serverTimestamp };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    syncLog.error('failed to push task to Jira', {
      taskId: task.id,
      error: message,
    });
    return { error: message };
  }
}

// ── Pull: incremental delta ──

export async function deltaPull(
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
): Promise<boolean> {
  const config = await getConfig();
  const jiraConfig = getJiraConfig(config);
  if (!jiraConfig?.base_url) return false;

  const client = new JiraClient(jiraConfig);

  // Read sync state
  const syncState = await readJsonFile<JiraSyncState>(JIRA_SYNC_FILE, { lastSync: '' });

  // Build JQL
  const jqlParts: string[] = [];
  jqlParts.push(`project = "${jiraConfig.project_key}"`);
  if (syncState.lastSync) {
    // Jira JQL date format: "yyyy-MM-dd HH:mm"
    const since = formatJqlDate(syncState.lastSync);
    jqlParts.push(`updated >= "${since}"`);
  }
  if (jiraConfig.assignee_filter) {
    if (jiraConfig.assignee_filter === 'currentUser') {
      jqlParts.push('assignee = currentUser()');
    } else {
      jqlParts.push(`assignee = "${jiraConfig.assignee_filter}"`);
    }
  }
  if (jiraConfig.jql_filter) {
    jqlParts.push(`(${jiraConfig.jql_filter})`);
  }

  const jql = jqlParts.join(' AND ') + ' ORDER BY updated DESC';

  const searchResult = await client.searchIssues(jql, {
    maxResults: 100,
    fields: ['summary', 'description', 'status', 'priority', 'project', 'issuetype',
             'created', 'updated', 'duedate', 'assignee', 'comment', 'subtasks', 'parent'],
  });

  if (searchResult.issues.length === 0) {
    syncState.lastSync = new Date().toISOString();
    await writeJsonFile(JIRA_SYNC_FILE, syncState);
    return false;
  }

  let hasChanges = false;

  for (const remote of searchResult.issues) {
    // Indexed SQLite lookup per delta row — avoids the 6000-row in-memory map
    // that the old code rebuilt on every tick. `ext.jira.issue_key` is indexed
    // in task-db.ts (idx_tasks_ext_jira_key).
    // NOTE: Jira REST API returns `issue.key` ("PROJ-123"), which we persist
    // as ext.jira.issue_key (renamed to avoid colliding with the REST field
    // name). Keep this call and the index JSON path aligned.
    const existing = await findTaskByExtId('jira', remote.key);

    if (existing) {
      // Check if remote is newer than last synced timestamp (echo detection)
      const remoteUpdated = new Date(remote.fields.updated).getTime();
      const syncedAt = existing._syncedAt ? new Date(existing._syncedAt).getTime() : 0;

      if (remoteUpdated > syncedAt) {
        const updates = mapToLocal(remote, config);
        // Preserve local-only fields
        delete updates.source;
        delete updates.note;
        delete updates.summary;
        delete updates.conversation_log;
        // Phase preservation
        const remoteStatusName = remote.fields.status.name;
        if (existing.phase && updates.phase) {
          if (shouldPreserveLocalPhaseJira(existing.phase, remoteStatusName)) {
            delete updates.phase;
            delete updates.status;
          }
        }
        await updateLocalTask(existing.id, updates);
        bus.emit(EventNames.TASK_UPDATED, { task: { ...existing, ...updates } }, ['web-ui'], { source: 'jira-sync' });
        hasChanges = true;
        syncLog.debug('updated local task from Jira', { key: remote.key, title: remote.fields.summary });
      }
    } else {
      // Ledger gate: an issue key a local task once owned (released via source
      // migration or deleted) never mints a new local task — same framework
      // rule as the ms-todo pull paths.
      if (isRemoteIdBlocked('jira', remote.key)) {
        syncLog.debug('skipped ledgered remote id', { key: remote.key });
        continue;
      }
      // New task from Jira
      const partial = mapToLocal(remote, config);
      const now = remote.fields.created || new Date().toISOString();
      const newTask = await addLocalTask({
        title: partial.title ?? remote.fields.summary,
        status: partial.status ?? 'todo',
        phase: partial.phase ?? 'TODO',
        priority: partial.priority ?? 'none',
        // Falls back to the reserved project so a provider task never lands in
        // Inbox, which is structurally local-only.
        project: partial.project ?? jiraConfig.project,
        source: 'jira',
        ext: partial.ext,
        external_url: partial.external_url,
        session_ids: [],
        created_at: now,
        updated_at: remote.fields.updated || now,
        due_date: partial.due_date,
        description: partial.description ?? '',
        summary: '',
        note: '',
      } as Omit<Task, 'id'>);
      bus.emit(EventNames.TASK_CREATED, { task: newTask }, ['web-ui'], { source: 'jira-sync' });
      hasChanges = true;
      syncLog.debug('created local task from Jira', { key: remote.key, title: remote.fields.summary });
    }
  }

  // Save sync timestamp
  syncState.lastSync = new Date().toISOString();
  await writeJsonFile(JIRA_SYNC_FILE, syncState);

  if (hasChanges) {
    syncLog.info(`Jira sync: pulled ${searchResult.issues.length} issues`);
  }

  return hasChanges;
}

// ── Full pull for reconciliation ──

/**
 * Pull ALL Jira issues matching the plugin scope (no timestamp filter).
 * Returns standardized items for three-way diff in SyncReconciler.
 */
export async function fullPullAllIssues(): Promise<Array<{
  remoteId: string;
  title: string;
  remoteUpdatedAt: string;
  fields: Partial<Task>;
}>> {
  const config = await getConfig();
  const jiraConfig = getJiraConfig(config);
  if (!jiraConfig?.base_url) return [];

  const client = new JiraClient(jiraConfig);

  // Build JQL — same filters as deltaPull but WITHOUT the updated >= timestamp
  const jqlParts: string[] = [];
  jqlParts.push(`project = "${jiraConfig.project_key}"`);
  if (jiraConfig.assignee_filter) {
    if (jiraConfig.assignee_filter === 'currentUser') {
      jqlParts.push('assignee = currentUser()');
    } else {
      jqlParts.push(`assignee = "${jiraConfig.assignee_filter}"`);
    }
  }
  if (jiraConfig.jql_filter) {
    jqlParts.push(`(${jiraConfig.jql_filter})`);
  }

  const jql = jqlParts.join(' AND ') + ' ORDER BY updated DESC';
  const jqlFields = [
    'summary', 'description', 'status', 'priority', 'project', 'issuetype',
    'created', 'updated', 'duedate', 'assignee', 'parent',
  ];

  // Paginate through all results
  const result: Array<{ remoteId: string; title: string; remoteUpdatedAt: string; fields: Partial<Task> }> = [];
  let startAt = 0;
  const maxPerPage = 100;
  let total = Infinity;

  while (startAt < total) {
    const searchResult = await client.searchIssues(jql, {
      maxResults: maxPerPage,
      startAt,
      fields: jqlFields,
    });
    total = searchResult.total;
    for (const issue of searchResult.issues) {
      const fields = mapToLocal(issue, config);
      result.push({
        remoteId: issue.key,
        title: issue.fields.summary,
        remoteUpdatedAt: issue.fields.updated,
        fields,
      });
    }
    startAt += searchResult.issues.length;
    if (searchResult.issues.length === 0) break;
  }

  return result;
}

// ── Full sync ──

export interface JiraSyncResult {
  pushed: number;
  pulled: boolean;
}

export async function syncTasks(
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
  updateTaskRaw: (id: string, updates: Partial<Task>) => Promise<{ changed: boolean }>,
): Promise<JiraSyncResult> {
  let pushed = 0;
  const config = await getConfig();
  const jiraConfig = getJiraConfig(config);

  // Push unsynced local tasks (source=jira but no jira issue_key).
  // SQL-filtered via listUnsyncedTasks so we don't scan the whole task table.
  const unsynced = await listUnsyncedTasks('jira');
  for (const task of unsynced) {
    const result = await autoPushTask(task);
    if (isJiraPushSuccess(result)) {
      await updateTaskRaw(task.id, {
        ext: {
          jira: {
            issue_id: result.jiraIssueId,
            issue_key: result.jiraIssueKey,
            ...(result.commentId ? { comment_id: result.commentId } : {}),
          },
        },
        external_url: jiraConfig ? `${jiraConfig.base_url}/browse/${result.jiraIssueKey}` : '',
      });
      pushed++;
    }
  }

  // Pull
  const pulled = await deltaPull(updateLocalTask, addLocalTask);

  return { pushed, pulled };
}

// ── Sync status ──

export interface JiraSyncStatus {
  configured: boolean;
  hasCredentials: boolean;
  baseUrl?: string;
  /** Jira-side project key (e.g. "PROJ"). */
  projectKey?: string;
  /** Walnut project reserved for Jira tasks. */
  project?: string;
}

export async function getJiraSyncStatus(): Promise<JiraSyncStatus> {
  const config = await getConfig();
  const jiraConfig = getJiraConfig(config);

  if (!jiraConfig?.base_url) {
    return { configured: false, hasCredentials: false };
  }

  return {
    configured: true,
    hasCredentials: !!jiraConfig.auth?.token,
    baseUrl: jiraConfig.base_url,
    projectKey: jiraConfig.project_key,
    project: jiraConfig.project,
  };
}

// ── Helpers ──

/** Resolve Jira project key from task project name using config mapping. */
function resolveProjectKey(task: Task, config: Config): string {
  const jiraConfig = getJiraConfig(config)!;
  if (jiraConfig.project_mapping && task.project) {
    const mapped = jiraConfig.project_mapping[task.project];
    if (mapped) return mapped;
  }
  return jiraConfig.project_key;
}

/** Format ISO timestamp as JQL date: "yyyy-MM-dd HH:mm" */
function formatJqlDate(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
