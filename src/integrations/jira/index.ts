/**
 * Jira plugin — two-way sync with Jira Cloud/Server.
 * Wraps the existing jira sync.ts implementation.
 */
import type { PluginApi, IntegrationSync } from '../../core/integration-types.js';
import type { Task } from '../../core/types.js';

export default function register(api: PluginApi): void {
  const config = api.config;
  const category = (config.category as string) || '';

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
    async updateCategory(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async updateDependencies(task: Task) {
      const { autoPushTask } = await import('./sync.js');
      await autoPushTask(task);
    },
    async associateSubtask(_parent: Task, _child: Task) {
      // Jira: set parent link on child issue (native sub-issue support)
    },
    async disassociateSubtask(_parent: Task, _child: Task) {
      // Jira: remove parent link from child issue
    },
    async syncPoll(ctx) {
      const { deltaPull } = await import('./sync.js');
      const tasks = ctx.getTasks();
      await deltaPull(
        tasks,
        async (id, updates) => { await ctx.updateTask(id, updates); },
        async (taskData) => { const t = await ctx.addTask(taskData as any); return t as any; },
      );
    },
  };

  api.registerSync(sync);

  api.registerSourceClaim((cat) => {
    return category ? cat.toLowerCase() === category.toLowerCase() : false;
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
