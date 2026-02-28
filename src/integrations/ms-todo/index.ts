/**
 * Microsoft To-Do plugin — two-way sync with MS Graph API.
 * Wraps the existing microsoft-todo.ts implementation.
 */
import type { PluginApi, IntegrationSync } from '../../core/integration-types.js';
import type { Task } from '../../core/types.js';

export default function register(api: PluginApi): void {
  const sync: IntegrationSync = {
    async createTask(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      const msId = await autoPushTask(task);
      if (msId) {
        return { 'ms-todo': { id: msId, list_id: (task.ext?.['ms-todo'] as Record<string, unknown>)?.list_id } };
      }
      return null;
    },
    async deleteTask(task: Task) {
      const { deleteMsTodoTask, registerDeletedMsIds } = await import('../microsoft-todo.js');
      // Register ID in ignore list FIRST — even if remote delete fails, pull won't re-import
      await registerDeletedMsIds(task);
      const msId = (task.ext?.['ms-todo'] as Record<string, unknown>)?.id as string | undefined;
      const listId = (task.ext?.['ms-todo'] as Record<string, unknown>)?.list_id as string | undefined;
      if (!msId || !listId) return;
      try {
        await deleteMsTodoTask(listId, msId);
      } catch {
        // Task may already be gone on remote — acceptable
      }
    },
    async updateTitle(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateDescription(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateSummary(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateNote(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateConversationLog(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updatePriority(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updatePhase(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateDueDate(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateStar(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateCategory(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async updateDependencies(task: Task) {
      const { autoPushTask } = await import('../microsoft-todo.js');
      await autoPushTask(task);
    },
    async associateSubtask(_parent: Task, _child: Task) {
      // MS To-Do: encode Parent: header in child's body (done via full push)
    },
    async disassociateSubtask(_parent: Task, _child: Task) {
      // MS To-Do: remove Parent: header from child's body
    },
    async syncPoll(ctx) {
      const { deltaPull } = await import('../microsoft-todo.js');
      const tasks = ctx.getTasks();
      await deltaPull(
        tasks,
        async (id, updates) => { await ctx.updateTask(id, updates); },
        async (taskData) => { const t = await ctx.addTask(taskData as any); return t as any; },
      );
    },
  };

  api.registerSync(sync);

  api.registerSourceClaim((category) => {
    // MS To-Do claims categories that aren't claimed by higher-priority plugins
    // This is the default — priority 0 means it's below higher-priority plugins (10) but above local (-1)
    return true;
  }, { priority: 0 });

  api.registerDisplay({
    badge: 'M',
    badgeColor: '#0078D4',
    externalLinkLabel: 'Microsoft To-Do',
    getExternalUrl: () => 'https://to-do.microsoft.com',
    isSynced: (task) => !!(task.ext as any)?.['ms-todo']?.id,
    syncTooltip: (task) => task.sync_error ? `Sync error: ${task.sync_error}` : 'Synced to Microsoft To-Do',
  });

  api.registerAgentContext(
    'Tasks with source "ms-todo" sync bidirectionally with Microsoft To-Do. ' +
    'Phase maps to 3 MS To-Do statuses: notStarted/inProgress/completed.'
  );

  // Migration: ms_todo_id → ext['ms-todo'], double-nesting repair, list → list_id normalization
  api.registerMigration((tasks) => {
    for (const task of tasks) {
      const raw = task as any;

      // A: Legacy field migration (ms_todo_id → ext['ms-todo'])
      if (raw.ms_todo_id && !task.ext?.['ms-todo']) {
        if (!task.ext) task.ext = {};
        task.ext['ms-todo'] = {
          id: raw.ms_todo_id,
          list_id: raw.ms_todo_list,
        };
        delete raw.ms_todo_id;
        delete raw.ms_todo_list;
      } else if (raw.ms_todo_id) {
        // Legacy field exists but ext['ms-todo'] already present — clean up legacy fields
        // Warn if IDs conflict (data corruption indicator)
        const existingId = (task.ext?.['ms-todo'] as Record<string, unknown>)?.id;
        if (existingId && existingId !== raw.ms_todo_id) {
          api.logger.warn('migration conflict: ms_todo_id differs from ext id', {
            taskId: task.id, legacyId: raw.ms_todo_id, extId: existingId,
          });
        }
        delete raw.ms_todo_id;
        delete raw.ms_todo_list;
      }

      // B: Repair double-nested ext['ms-todo']['ms-todo'] (caused by server.ts bug)
      const msExt = task.ext?.['ms-todo'] as Record<string, unknown> | undefined;
      if (msExt && typeof msExt === 'object' && msExt['ms-todo'] && typeof msExt['ms-todo'] === 'object') {
        const inner = msExt['ms-todo'] as Record<string, unknown>;
        task.ext!['ms-todo'] = {
          id: inner.id ?? msExt.id,
          list_id: inner.list_id ?? inner.list ?? msExt.list_id ?? msExt.list,
        };
      }

      // C: Normalize 'list' → 'list_id' (field name mismatch fix)
      const msExtNorm = task.ext?.['ms-todo'] as Record<string, unknown> | undefined;
      if (msExtNorm && msExtNorm.list) {
        if (!msExtNorm.list_id) {
          msExtNorm.list_id = msExtNorm.list;
        }
        delete msExtNorm.list; // Always remove deprecated field
      }
    }
    return tasks;
  });
}
