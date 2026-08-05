/**
 * Jira plugin — two-way sync with Jira Cloud/Server.
 * Wraps the existing jira sync.ts implementation.
 */
import type { PluginApi, IntegrationSync, PushResult, RemoteSyncItem } from '../../core/integration-types.js';
import type { Task } from '../../core/types.js';

export default function register(api: PluginApi): void {
  const config = api.config;
  /** Walnut project reserved for Jira tasks — the claim point. */
  const reservedProject = (config.project as string) || '';

  const sync: IntegrationSync = {
    async createTask(task: Task) {
      const { autoPushTask, isJiraPushSuccess } = await import('./sync.js');
      const result = await autoPushTask(task);
      if (isJiraPushSuccess(result)) {
        return {
          jira: {
            issue_id: result.jiraIssueId,
            issue_key: result.jiraIssueKey,
            comment_id: result.commentId,
          },
        };
      }
      if (result.error) throw new Error(result.error);
      return null;
    },
    async deleteTask(_task: Task) {
      // Jira issues are not typically deleted via API
    },
    async updateTitle(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateDescription(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateSummary(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateNote(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateConversationLog(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updatePriority(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updatePhase(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateDueDate(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateStar(_task: Task) {
      // Could add/remove labels in future
    },
    async updateProject(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateDependencies(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async pushTask(task: Task): Promise<PushResult> {
      const { autoPushTask, isJiraPushSuccess } = await import('./sync.js');
      const result = await autoPushTask(task);
      if (isJiraPushSuccess(result)) {
        return {
          serverTimestamp: result.serverTimestamp ?? new Date().toISOString(),
          ext: {
            jira: {
              issue_id: result.jiraIssueId,
              issue_key: result.jiraIssueKey,
              comment_id: result.commentId,
            },
          },
        };
      }
      throw new Error(result.error);
    },
    async associateSubtask(_parent: Task, _child: Task) {
      // Jira: set parent link on child issue (native sub-issue support)
    },
    async disassociateSubtask(_parent: Task, _child: Task) {
      // Jira: remove parent link from child issue
    },
    async syncPoll(ctx) {
      const { deltaPull } = await import('./sync.js');
      await deltaPull(
        async (id, updates) => { await ctx.updateTask(id, updates); },
        async (taskData) => { const t = await ctx.addTask(taskData as any); return t as any; },
      );
    },
    async fullPull(): Promise<RemoteSyncItem[]> {
      const { fullPullAllIssues } = await import('./sync.js');
      return fullPullAllIssues();
    },
    extractRemoteId(task: Task): string | undefined {
      // NOTE: Jira REST API uses `issue.key` (e.g. "PROJ-123") and `issue.id`
      // (numeric). Walnut persists the human-readable key under
      // ext.jira.issue_key (NOT .key, to avoid collision with the API field
      // name). The SQLite index idx_tasks_ext_jira_key uses $.jira.issue_key —
      // keep the JSON path and the ext write path in sync.
      return (task.ext?.jira as Record<string, unknown>)?.issue_key as string | undefined;
    },
  };

  api.registerSync(sync);

  api.registerExtIndex({
    source: 'jira',
    paths: [{ key: 'issue_key', json: '$.jira.issue_key' }],
  });

  // Exact (case-insensitive) match on the configured project name. Unset = claim
  // nothing, so an unconfigured Jira plugin never steals a project.
  api.registerSourceClaim((project) => {
    return reservedProject ? project.toLowerCase() === reservedProject.toLowerCase() : false;
  }, { priority: 0 });

  api.registerDisplay({
    badge: 'J',
    badgeColor: '#0052CC',
    externalLinkLabel: 'Jira',
    getExternalUrl: (task) => task.external_url || null,
    isSynced: (task) => !!(task.ext as any)?.jira?.issue_key,
    syncTooltip: (task) => task.sync_error ? `Sync error: ${task.sync_error}` : 'Synced to Jira',
  });

  api.registerAgentContext(
    'Tasks with source "jira" sync bidirectionally with Jira. ' +
    'Phase maps to Jira workflow transitions (To Do → In Progress → In Review → Done).'
  );

  // Migration: jira_* fields → ext.jira
  api.registerMigration((tasks) => {
    for (const task of tasks) {
      const raw = task as any;
      if (raw.jira_issue_id && !task.ext?.jira) {
        if (!task.ext) task.ext = {};
        task.ext.jira = {
          issue_id: raw.jira_issue_id,
          issue_key: raw.jira_issue_key,
          project_key: raw.jira_project_key,
          comment_id: raw.jira_comment_id,
          status_name: raw.jira_status_name,
        };
        delete raw.jira_issue_id;
        delete raw.jira_issue_key;
        delete raw.jira_project_key;
        delete raw.jira_comment_id;
        delete raw.jira_status_name;
      }
    }
    return tasks;
  });
}
