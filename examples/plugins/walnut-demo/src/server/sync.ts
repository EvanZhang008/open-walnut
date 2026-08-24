import type {
  PluginIntegrationSync,
  PluginSyncPollContext,
  PluginSyncPushResult,
  PluginSyncTask,
  TaskPhase,
  TaskPriority,
} from '@open-walnut/plugin-api/server'
import { DEMO_PROJECT } from './constants'

export interface SyncCallLog {
  calls: string[]
  total: number
}

const CALL_LOG_LIMIT = 12

export function createSyncCallLog(): SyncCallLog {
  return { calls: [], total: 0 }
}

// Every method is a safe no-op: no network, no external write, no task mutation, so the host can call any of them freely.
export function createDemoSyncAdapter(
  log: SyncCallLog,
  onCall: (method: string) => void,
): PluginIntegrationSync {
  const note = (method: string): void => {
    log.calls.push(method)
    if (log.calls.length > CALL_LOG_LIMIT) log.calls.shift()
    log.total += 1
    onCall(method)
  }

  return {
    async createTask(task: PluginSyncTask) {
      note('createTask')
      void task
      return null
    },
    async deleteTask(task: PluginSyncTask) {
      note('deleteTask')
      void task
    },

    async updateTitle(_task: PluginSyncTask, _title: string) { note('updateTitle') },
    async updateDescription(_task: PluginSyncTask, _description: string) { note('updateDescription') },
    async updateSummary(_task: PluginSyncTask, _summary: string) { note('updateSummary') },
    async updateNote(_task: PluginSyncTask, _value: string) { note('updateNote') },
    async updateConversationLog(_task: PluginSyncTask, _value: string) { note('updateConversationLog') },
    async updatePriority(_task: PluginSyncTask, _priority: TaskPriority) { note('updatePriority') },
    async updatePhase(_task: PluginSyncTask, _phase: TaskPhase) { note('updatePhase') },
    async updateDueDate(_task: PluginSyncTask, _date: string | null) { note('updateDueDate') },
    async updateProject(_task: PluginSyncTask, _project: string) { note('updateProject') },
    async updateDependencies(_task: PluginSyncTask, _dependsOn: string[]) { note('updateDependencies') },

    async associateSubtask(_parent: PluginSyncTask, _child: PluginSyncTask) { note('associateSubtask') },
    async disassociateSubtask(_parent: PluginSyncTask, _child: PluginSyncTask) { note('disassociateSubtask') },

    validateContent(_task: PluginSyncTask, _field: string, _value: string) {
      note('validateContent')
      return null
    },
    contentRequirement(_field: string) {
      note('contentRequirement')
      return null
    },

    async pushTask(_task: PluginSyncTask): Promise<PluginSyncPushResult> {
      note('pushTask')
      return { serverTimestamp: new Date().toISOString() }
    },
    async syncPoll(context: PluginSyncPollContext) {
      note('syncPoll')
      void context.getTasks().length
    },
    async fullPull(_context: PluginSyncPollContext) {
      note('fullPull')
      // Undefined means "no remote snapshot"; an empty array would read as a real empty remote and delete local records.
      return undefined
    },

    async renameProjectRemote(_args) {
      note('renameProjectRemote')
    },
    async deleteProjectRemote(_args) {
      note('deleteProjectRemote')
      return { outcome: 'container-deleted' }
    },

    extractRemoteId(task: PluginSyncTask) {
      const ext = task.ext?.['walnut-demo']
      if (!ext || typeof ext !== 'object') return undefined
      const id = (ext as { id?: unknown }).id
      return typeof id === 'string' ? id : undefined
    },
    extractRemoteIdAliases(_task: PluginSyncTask) {
      note('extractRemoteIdAliases')
      return []
    },
    async confirmRemoteDeleted(_remoteId: string, _remoteList?: string | null) {
      note('confirmRemoteDeleted')
      return false
    },
  }
}

export async function exerciseDemoSyncAdapter(
  adapter: PluginIntegrationSync,
  context: PluginSyncPollContext,
): Promise<void> {
  const parent: PluginSyncTask = {
    id: 'demo-sync-parent',
    title: 'Demo sync parent',
    description: '',
    summary: '',
    priority: 'none',
    phase: 'TODO',
    project: DEMO_PROJECT,
    ext: { 'walnut-demo': { id: 'demo-remote-parent' } },
  }
  const child: PluginSyncTask = {
    ...parent,
    id: 'demo-sync-child',
    title: 'Demo sync child',
    parent_task_id: parent.id,
  }

  await adapter.createTask(parent)
  await adapter.updateTitle(parent, parent.title)
  await adapter.updateDescription(parent, parent.description)
  await adapter.updateSummary(parent, parent.summary)
  await adapter.updateNote(parent, 'demo note')
  await adapter.updateConversationLog(parent, 'demo log')
  await adapter.updatePriority(parent, parent.priority)
  await adapter.updatePhase(parent, parent.phase)
  await adapter.updateDueDate(parent, null)
  await adapter.updateProject(parent, parent.project ?? '')
  await adapter.updateDependencies(parent, [])
  await adapter.associateSubtask(parent, child)
  await adapter.disassociateSubtask(parent, child)
  adapter.validateContent?.(parent, 'title', parent.title)
  adapter.contentRequirement?.('title')
  await adapter.pushTask(parent)
  await adapter.syncPoll(context)
  await adapter.fullPull?.(context)
  adapter.extractRemoteId?.(parent)
  adapter.extractRemoteIdAliases?.(parent)
  await adapter.confirmRemoteDeleted?.('demo-remote-parent', null)
  await adapter.renameProjectRemote?.({ oldRemoteName: DEMO_PROJECT, newName: DEMO_PROJECT })
  await adapter.deleteProjectRemote?.({ project: DEMO_PROJECT, tasks: [parent, child] })
  await adapter.deleteTask(parent)
}

// Reads report empty and every write throws, so a local adapter probe cannot mutate real data even if the adapter changed.
export function inertPollContext(): PluginSyncPollContext {
  const refuse = (method: string): never => {
    throw new Error(`The demo sync adapter never calls ${method}`)
  }
  return {
    getTasks: () => [],
    updateTask: async () => refuse('updateTask'),
    addTask: async () => refuse('addTask'),
    deleteTask: async () => refuse('deleteTask'),
    emit: () => undefined,
  }
}
