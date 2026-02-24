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

  // Project from Jira project key — reverse lookup in project_mapping, fallback to key
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
    category: jiraConfig.category,
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
  if (task.needs_attention) headers.push(`Attention: true`);
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

      syncLog.info('pushed task update to Jira', { key: issueKey, title: task.title });
      return { jiraIssueId: issueId ?? '', jiraIssueKey: issueKey, commentId };
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

      syncLog.info('created issue in Jira', { key: created.key, title: task.title });
      return { jiraIssueId: created.id, jiraIssueKey: created.key, commentId };
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
  localTasks: Task[],
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

  // Build lookup: jira ext issue_key → local task
  const localByJiraKey = new Map<string, Task>();
  const localByJiraId = new Map<string, Task>();
  for (const t of localTasks) {
    const je = ext(t);
    if (je?.issue_key) localByJiraKey.set(je.issue_key as string, t);
    if (je?.issue_id) localByJiraId.set(je.issue_id as string, t);
  }

  let hasChanges = false;

  for (const remote of searchResult.issues) {
    const existing = localByJiraKey.get(remote.key) ?? localByJiraId.get(remote.id);

    if (existing) {
      // Check if remote is newer
      const remoteUpdated = new Date(remote.fields.updated).getTime();
      const localUpdated = new Date(existing.updated_at).getTime();

      if (remoteUpdated > localUpdated) {
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
      // New task from Jira
      const partial = mapToLocal(remote, config);
      const now = remote.fields.created || new Date().toISOString();
      const newTask = await addLocalTask({
        title: partial.title ?? remote.fields.summary,
        status: partial.status ?? 'todo',
        phase: partial.phase ?? 'TODO',
        priority: partial.priority ?? 'none',
        category: partial.category ?? jiraConfig.category,
        project: partial.project ?? jiraConfig.category,
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

// ── Full sync ──

export interface JiraSyncResult {
  pushed: number;
  pulled: boolean;
}

export async function syncTasks(
  localTasks: Task[],
  updateLocalTask: (id: string, updates: Partial<Task>) => Promise<void>,
  addLocalTask: (task: Omit<Task, 'id'>) => Promise<Task>,
  updateTaskRaw: (id: string, updates: Partial<Task>) => Promise<void>,
): Promise<JiraSyncResult> {
  let pushed = 0;
  const config = await getConfig();
  const jiraConfig = getJiraConfig(config);

  // Push unsynced local tasks (source=jira but no jira issue_key)
  const unsynced = localTasks.filter(
    (t) => t.source === 'jira' && !ext(t)?.issue_key && t.status !== 'done',
  );
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
  const pulled = await deltaPull(localTasks, updateLocalTask, addLocalTask);

  return { pushed, pulled };
}

// ── Sync status ──

export interface JiraSyncStatus {
  configured: boolean;
  hasCredentials: boolean;
  baseUrl?: string;
  projectKey?: string;
  category?: string;
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
    category: jiraConfig.category,
  };
}

// ── Helpers ──

/** Resolve Jira project key from task project name using config mapping. */
function resolveProjectKey(task: Task, config: Config): string {
  const jiraConfig = getJiraConfig(config)!;
  if (jiraConfig.project_mapping) {
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
