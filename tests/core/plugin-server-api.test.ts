import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('plugin-server-api-test'))
vi.mock('../../src/core/config-manager.js', () => ({
  // `defaults` is here because the real task manager reads it when a plugin creates a task
  // (project and priority both fall back to it), and this mock replaces the whole module.
  getConfig: vi.fn(async () => ({ plugins: { 'sample-plugin': { color: 'blue' } }, defaults: {} })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
  // Reached only through the real task manager, which `tasks.create` opens. A no-op, because the
  // config this file cares about is the mocked pair above.
  seedConfigDefaults: vi.fn(async () => undefined),
}))

import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { getAgent } from '../../src/core/agent-registry.js'
import { resolveProvider } from '../../src/model/providers/registry.js'
import { IntegrationRegistry } from '../../src/core/integration-registry.js'
import { PluginContext, type PluginLogger } from '../../src/core/plugins/plugin-context.js'
import { createServerPluginApi } from '../../src/core/plugins/server-api.js'
import { createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js'
import { _getRpcMethodForTesting, removeOwnedMethods } from '../../src/web/ws/handler.js'
import { getAction, _resetActionsForTesting, runAction } from '../../src/core/cron/actions.js'
import { HookDispatcher, setSessionHookDispatcher } from '../../src/core/session-hooks/index.js'
import { activate as activateCalendar } from '../../src/integrations/calendar/index.js'
import { activate as activateMsTodo } from '../../src/integrations/ms-todo/index.js'
import { activate as activateJira } from '../../src/integrations/jira/index.js'
import { disposeCoreServices, publishCoreService } from '../../src/core/platform-services.js'
import { getServiceEntry } from '../../src/core/plugins/service-registry.js'
import { createMockCalendarSource } from '../helpers/mock-calendar-source.js'
import { createMockPlugin, createTestPluginApi } from './plugin-test-utils.js'

const logger: PluginLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(() => logger),
}

const contexts: PluginContext[] = []
const dispatchers: HookDispatcher[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.dispose().catch(() => undefined)
  for (const dispatcher of dispatchers.splice(0)) dispatcher.destroy()
  _resetActionsForTesting()
  removeOwnedMethods('sample-plugin')
  setSessionHookDispatcher(null)
  bus.unsubscribe('test-observer')
  disposeCoreServices()
})

/**
 * The host half of `core:calendar-source`, over a mock source. The real one reaches the
 * signed EventKit helper, which compiles Swift and reads the developer's own calendars.
 */
function publishMockCalendarSource(): void {
  publishCoreService('calendar-source', {
    createSource: () => createMockCalendarSource().source,
    authStatus: async () => 'granted',
    requestAccess: async () => 'granted',
    helperFallback: () => null,
  })
}

function setup(
  pluginId = 'sample-plugin',
  pluginName = 'Sample Plugin',
  dependencies?: Record<string, string>,
) {
  const context = new PluginContext({
    id: pluginId,
    dataDir: path.join(WALNUT_HOME, 'plugin-data', pluginId),
    logger,
  })
  contexts.push(context)
  const { api: legacyApi, collected } = createTestPluginApi({ id: pluginId, name: pluginName })
  const registry = new IntegrationRegistry()
  const api = createServerPluginApi({
    context,
    pluginName,
    legacyApi,
    contributions: collected,
    integrationRegistry: registry,
    ...(dependencies ? { dependencies } : {}),
  })
  return { api, context, collected, registry }
}

describe('createServerPluginApi', () => {
  it('adapts first-party integrations into owner-scoped registrations', async () => {
    const msTodo = setup('ms-todo', 'Microsoft To-Do')
    await activateMsTodo(msTodo.api)

    expect(msTodo.collected.sync).not.toBeNull()
    expect(msTodo.collected.claim?.priority).toBe(0)
    expect(msTodo.collected.display?.badge).toBe('M')
    expect(msTodo.collected.extIndex?.source).toBe('ms-todo')
    expect(msTodo.collected.migrations).toHaveLength(1)

    const jira = setup('jira', 'Jira')
    await activateJira(jira.api)

    expect(jira.collected.sync).not.toBeNull()
    expect(jira.collected.claim?.priority).toBe(0)
    expect(jira.collected.display?.badge).toBe('J')
    expect(jira.collected.extIndex?.source).toBe('jira')
    expect(jira.collected.migrations).toHaveLength(1)

    const calendar = setup('calendar', 'Calendar')
    publishMockCalendarSource()
    // The calendar is a plugin now, so its activate hands back the lifetime that owns the
    // adopted service and its refresh poll. Dispose it or the poll outlives the test.
    const calendarLifetime = await activateCalendar(calendar.api)
    expect(calendar.collected.tools.map((tool) => tool.name)).toEqual([
      'calendar_query',
      'calendar_event_create',
      'calendar_event_update',
      'calendar_event_delete',
    ])
    expect(new Set(calendar.collected.tools.map((tool) => tool.name)).size).toBe(4)

    await msTodo.context.dispose()
    await jira.context.dispose()
    await calendarLifetime.dispose()
    await calendar.context.dispose()
    expect(msTodo.collected).toMatchObject({
      sync: null,
      claim: null,
      display: null,
      migrations: [],
      extIndex: null,
    })
    expect(jira.collected).toMatchObject({
      sync: null,
      claim: null,
      display: null,
      migrations: [],
      extIndex: null,
    })
    expect(calendar.collected.tools).toEqual([])
  })

  it('registers tool, route, cron, and context contributions', async () => {
    const { api, collected, registry } = setup()
    api.registry.tool({
      name: 'inspect',
      description: 'Inspect state',
      execute: async () => ({ ok: true }),
    })
    api.registry.cronAction('collect', 'Collect data', async () => ({ status: 'ok', summary: 'done' }))
    api.registry.agentContext('Sample Plugin is available.')
    api.http.route('GET', '/status', async () => ({ json: { active: true } }))

    registry.register('sample-plugin', createMockPlugin({
      id: 'sample-plugin',
      tools: collected.tools,
      httpRoutes: collected.httpRoutes,
      agentContext: collected.agentContext ?? undefined,
    }))
    const app = express()
    app.use('/api/plugins', createPluginRouteDispatcher(registry))

    expect(collected.tools.map((tool) => tool.name)).toEqual(['sample_plugin_inspect'])
    expect(await collected.tools[0].execute({})).toBe(JSON.stringify({ ok: true }, null, 2))
    expect(getAction('sample-plugin:collect')).toBeDefined()
    expect((await runAction('sample-plugin:collect', {})).summary).toBe('done')
    await request(app).get('/api/plugins/sample-plugin/status').expect(200, { active: true })
    expect(collected.agentContext).toBe('Sample Plugin is available.')
  })

  it('disposes every owner-scoped contribution and event subscriber', async () => {
    const { api, context, collected } = setup()
    const received = vi.fn()
    api.registry.tool({ name: 'inspect', description: 'Inspect', execute: async () => 'ok' })
    api.registry.cronAction('collect', 'Collect', async () => ({ status: 'ok' }))
    api.registry.wsMethod('ping', async (payload) => ({ payload }))
    api.registry.agent({ id: 'helper', name: 'Helper', runner: 'embedded' })
    api.registry.provider('custom', {
      sendMessage: async () => ({ content: [], stopReason: 'end_turn' }),
      sendMessageStream: async () => ({ content: [], stopReason: 'end_turn' }),
    })
    api.http.route('GET', '/status', async () => ({ json: {} }))
    api.events.on('task:', received)

    bus.emit('task:created', { task: { id: 'one' } }, ['web-ui'], { source: 'test' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toHaveBeenCalledOnce()
    expect(await _getRpcMethodForTesting('sample-plugin:ping')?.({ ready: true }, {} as never)).toEqual({
      payload: { ready: true },
    })
    await expect(getAgent('sample-plugin:helper')).resolves.toMatchObject({ source: 'plugin' })
    expect(resolveProvider('custom', {
      custom: { api: 'sample-plugin:custom' },
    }).adapter.protocol).toBe('sample-plugin:custom')

    await context.dispose()
    bus.emit('task:created', { task: { id: 'two' } }, ['web-ui'], { source: 'test' })
    await new Promise((resolve) => setImmediate(resolve))

    expect(received).toHaveBeenCalledOnce()
    expect(collected.tools).toEqual([])
    expect(collected.httpRoutes).toEqual([])
    expect(getAction('sample-plugin:collect')).toBeUndefined()
    expect(_getRpcMethodForTesting('sample-plugin:ping')).toBeUndefined()
    await expect(getAgent('sample-plugin:helper')).resolves.toBeUndefined()
    expect(() => resolveProvider('custom', {
      custom: { api: 'sample-plugin:custom' },
    })).toThrow('Unknown protocol')
  })

  it('namespaces config, custom events, and persistent storage', async () => {
    const { api } = setup()
    const custom = vi.fn()
    bus.subscribe('test-observer', (event) => {
      if (event.name === 'plugin:sample-plugin:changed') custom(event.data)
    }, { global: true, interest: ['plugin:sample-plugin:'] })

    expect(await api.config.get()).toEqual({ color: 'blue' })
    await api.storage.writeJson('state.json', { ready: true })
    api.events.emit('changed', { ready: true })
    await new Promise((resolve) => setImmediate(resolve))

    expect(await api.storage.readJson('state.json', {})).toEqual({ ready: true })
    expect(custom).toHaveBeenCalledWith({ ready: true })
  })

  /**
   * A task a plugin makes has to announce itself like every other created task.
   *
   * `addTask` emits nothing by design, so every create path in Walnut emits at its own call site.
   * This one did not, and the symptom was a task nobody could see: an open browser's list only
   * refetches on the event, and the search index is fed from the same event, so a task a plugin made
   * was invisible and unfindable until something unrelated forced a full reload.
   */
  it('emits task:created for a task a plugin makes', async () => {
    const { api } = setup()
    const seen: Array<{ data: unknown; source: string }> = []
    bus.subscribe('test-observer', (event) => {
      if (event.name === EventNames.TASK_CREATED) seen.push({ data: event.data, source: event.source })
    }, { global: true, interest: [EventNames.TASK_CREATED] })

    const task = await api.tasks.create({ title: 'From a plugin', tags: ['mail'] })
    await new Promise((resolve) => setImmediate(resolve))

    expect(seen).toHaveLength(1)
    expect((seen[0]!.data as { task: { id: string; title: string } }).task)
      .toMatchObject({ id: task.id, title: 'From a plugin' })
    // Attributed to the plugin, so a subscriber can tell a plugin's task from the user's own.
    expect(seen[0]!.source).toBe('plugin/sample-plugin')
  })

  /**
   * A plugin that files tasks needs the folder a task sits in, the sessions behind it, a way to
   * add one tag without overwriting the rest, and a batch filing call: one `update` per task
   * rewrites the whole store, which at thousands of tasks held the event loop for minutes.
   */
  it('files tasks into folders in one batch, shows folder and sessions, and edits single tags', async () => {
    const { api } = setup()
    const groupEvents: unknown[] = []
    const updateEvents: Array<{ task?: unknown; taskIds?: string[] }> = []
    bus.subscribe('test-observer', (event) => {
      if (event.name === EventNames.TASK_GROUPS_CHANGED) groupEvents.push(event.data)
      if (event.name === EventNames.TASK_UPDATED) updateEvents.push(event.data as { task?: unknown; taskIds?: string[] })
    }, { global: true, interest: [EventNames.TASK_GROUPS_CHANGED, EventNames.TASK_UPDATED] })

    const first = await api.tasks.create({ title: 'Investigate this ticket', project: 'Filing Import', tags: ['walnut:external-sessions'] })
    const second = await api.tasks.create({ title: 'Second', project: 'Filing Import' })
    const synced = await api.tasks.create({ title: 'Synced elsewhere', project: 'Filing Import' })
    const bystander = await api.tasks.create({ title: 'Bystander', project: 'Filing Import' })
    const tm = await import('../../src/core/task-manager.js')
    await tm.linkSession(first.id, 'sess-first')
    await tm.updateTasksBulk([{ id: synced.id, patch: { source: 'ms-todo' } }])
    const bystanderBefore = await tm.getTask(bystander.id)

    // A folder in a project the board does not have yet brings the project with it.
    const folder = await api.tasks.createFolder({ label: 'Robot runs', project: 'Filing Team' })
    expect(folder).toMatchObject({ label: 'Robot runs', project: 'Filing Team', memberCount: 0 })
    expect(await tm.getProjectRecord('Filing Team')).toMatchObject({ source: 'local' })

    updateEvents.length = 0
    const result = await api.tasks.fileIntoFolder(folder.id, [
      { id: first.id, addTags: ['ticket:P123'], title: 'Nodes stuck NotReady' },
      { id: second.id },
      { id: synced.id },
      { id: 'no-such-task' },
      { id: first.id, addTags: ['duplicate item ignored'] },
    ])
    expect(result.filed.sort()).toEqual([first.id, second.id].sort())
    expect(result.skipped).toEqual([{ id: synced.id, reason: 'synced' }, { id: 'no-such-task', reason: 'missing' }])

    const filed = await api.tasks.get(first.id)
    expect(filed).toMatchObject({ title: 'Nodes stuck NotReady', project: 'Filing Team', groupId: folder.id, sessionIds: ['sess-first'] })
    expect(filed?.tags?.sort()).toEqual(['ticket:P123', 'walnut:external-sessions'])
    expect(await api.tasks.get(second.id)).toMatchObject({ project: 'Filing Team', groupId: folder.id })
    expect(await api.tasks.get(synced.id)).toMatchObject({ project: 'Filing Import' })
    // Only the filed rows changed.
    expect((await tm.getTask(bystander.id)).updated_at).toBe(bystanderBefore.updated_at)
    const summaries = await api.tasks.query({ groupId: folder.id })
    expect(summaries.map((one) => one.id).sort()).toEqual([first.id, second.id].sort())
    expect((await api.tasks.folders()).find((one) => one.id === folder.id)).toMatchObject({ memberCount: 2 })
    // One bulk frame for the batch, not one per task; created + filed each refresh the folders.
    expect(updateEvents).toEqual([expect.objectContaining({ task: null, taskIds: expect.arrayContaining([first.id, second.id]) })])
    expect(groupEvents).toHaveLength(2)

    // Filing again as asked changes nothing and says so.
    expect(await api.tasks.fileIntoFolder(folder.id, [{ id: first.id, addTags: ['ticket:P123'] }])).toEqual({ filed: [], skipped: [] })
    await expect(api.tasks.fileIntoFolder('g_missing', [{ id: first.id }])).rejects.toThrow(/not found/)

    // removeTags leaves the other tags alone; `tags` still replaces the whole set.
    await api.tasks.update(first.id, { removeTags: ['walnut:external-sessions'] })
    expect((await api.tasks.get(first.id))?.tags).toEqual(['ticket:P123'])
    await api.tasks.update(first.id, { tags: ['only'], addTags: ['ignored'] })
    expect((await api.tasks.get(first.id))?.tags).toEqual(['label:only'])

    // A folder never follows a task into another project.
    await api.tasks.update(first.id, { project: 'Elsewhere' })
    expect((await api.tasks.get(first.id))?.groupId).toBeUndefined()
  })

  it('files a large batch in chunks, one bulk event each', async () => {
    const { api } = setup()
    const tm = await import('../../src/core/task-manager.js')
    const made = await tm.addTasksBulk(Array.from({ length: 205 }, (_, i) => ({
      title: `Bulk ${i}`, project: 'Filing Bulk', source: 'local', status: 'todo', phase: 'TODO', priority: 'none',
    }) as never))
    const folder = await api.tasks.createFolder({ label: 'All of them', project: 'Filing Bulk' })
    const frames: string[][] = []
    bus.subscribe('test-observer', (event) => {
      const data = event.data as { task?: unknown; taskIds?: string[] }
      if (event.name === EventNames.TASK_UPDATED && data.taskIds) frames.push(data.taskIds)
    }, { global: true, interest: [EventNames.TASK_UPDATED] })

    const result = await api.tasks.fileIntoFolder(folder.id, made.map((task) => ({ id: task.id, addTags: ['bulk'] })))
    expect(result.filed).toHaveLength(205)
    expect(frames.map((ids) => ids.length)).toEqual([200, 5])
    expect((await api.tasks.folders()).find((one) => one.id === folder.id)).toMatchObject({ memberCount: 205 })
  })

  /**
   * A plugin that files into a project with no folder, then cleans up the folder it filed into
   * before: the batch move lands tasks at the project's top level, and only an empty folder can
   * be deleted, so a plugin never reshapes work the user filed there.
   */
  it('files tasks into a project with no folder in chunks, and deletes only an empty folder', async () => {
    const { api } = setup()
    const tm = await import('../../src/core/task-manager.js')
    const made = await tm.addTasksBulk(Array.from({ length: 203 }, (_, i) => ({
      title: `Run ${i}`, project: 'Root Import', source: 'local', status: 'todo', phase: 'TODO', priority: 'none',
    }) as never))
    const old = await api.tasks.createFolder({ label: 'Old home', project: 'Root Old' })
    await api.tasks.fileIntoFolder(old.id, made.slice(0, 3).map((task) => ({ id: task.id })))
    const frames: string[][] = []
    const groupEvents: unknown[] = []
    bus.subscribe('test-observer', (event) => {
      const data = event.data as { task?: unknown; taskIds?: string[] }
      if (event.name === EventNames.TASK_UPDATED && data.taskIds) frames.push(data.taskIds)
      if (event.name === EventNames.TASK_GROUPS_CHANGED) groupEvents.push(event.data)
    }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_GROUPS_CHANGED] })

    const result = await api.tasks.fileIntoProject('Root Target', made.map((task) => ({ id: task.id, addTags: ['moved'] })))
    expect(result).toMatchObject({ skipped: [] })
    expect(result.filed).toHaveLength(203)
    expect(frames.map((ids) => ids.length)).toEqual([200, 3])
    const sample = await api.tasks.get(made[0]!.id)
    expect(sample).toMatchObject({ project: 'Root Target', tags: ['label:moved'] })
    expect(sample?.groupId).toBeUndefined()
    expect(await tm.getProjectRecord('Root Target')).toMatchObject({ source: 'local' })
    await expect(api.tasks.fileIntoProject(' ', [{ id: made[0]!.id }])).rejects.toThrow(/cannot be empty/)

    // The old folder is empty now: it can go. One the user still keeps work in cannot.
    const busy = await api.tasks.createFolder({ label: 'Mine', project: 'Root Target' })
    await api.tasks.fileIntoFolder(busy.id, [{ id: made[5]!.id }])
    groupEvents.length = 0
    await api.tasks.deleteFolder(old.id)
    expect((await api.tasks.folders()).some((one) => one.id === old.id)).toBe(false)
    expect(groupEvents).toEqual([expect.objectContaining({ group_id: old.id })])
    await expect(api.tasks.deleteFolder(busy.id)).rejects.toThrow(/not empty/)
    expect(await api.tasks.get(made[5]!.id)).toMatchObject({ groupId: busy.id })
    await expect(api.tasks.deleteFolder('g_missing')).rejects.toThrow(/not found/)
  })

  it('lists the hosts, runs a script on this machine, and refuses a host it does not know', async () => {
    const { getConfig } = await import('../../src/core/config-manager.js')
    vi.mocked(getConfig).mockResolvedValue({
      plugins: {}, defaults: {},
      hosts: { devbox: { hostname: 'devbox.example.test', user: 'me', port: 2222, label: 'Dev box' }, hidden: { hostname: 'hidden.example.test', enabled: false } },
    } as never)
    try {
      const { api } = setup()
      expect(await api.hosts.list()).toEqual([
        { alias: '__local__', local: true, enabled: true },
        { alias: 'devbox', label: 'Dev box', local: false, enabled: true, hostname: 'devbox.example.test', user: 'me', port: 2222 },
        { alias: 'hidden', local: false, enabled: false, hostname: 'hidden.example.test' },
      ])
      expect(await api.hosts.get('devbox')).toMatchObject({ hostname: 'devbox.example.test' })
      expect(await api.hosts.get('nope')).toBeNull()

      const run = await api.hosts.run('__local__', { script: 'printf "%s|" "$@"; echo; echo warn >&2; exit 3', args: ["it's", 'a $HOME'] })
      expect(run).toEqual({ code: 3, stdout: "it's|a $HOME|\n", stderr: 'warn\n', timedOut: false, truncated: false })
      await expect(api.hosts.run('nope', { script: 'true' })).rejects.toThrow(/no host named "nope"/)
    } finally {
      vi.mocked(getConfig).mockResolvedValue({ plugins: { 'sample-plugin': { color: 'blue' } }, defaults: {} } as never)
    }
  })

  it("tells a plugin the importer's tag and projects, and when an import run ends", async () => {
    const { api, context } = setup()
    const { externalImportProject } = await import('../../src/core/sessions/external-session-import.js')
    const { EXTERNAL_SESSION_IMPORT_TAG } = await import('../../src/core/types.js')
    expect(api.sessionImports.tag).toBe(EXTERNAL_SESSION_IMPORT_TAG)
    expect(api.sessionImports.projectFor('devbox')).toBe(externalImportProject('devbox'))
    expect(api.sessionImports.projectFor('__local__')).toBe(externalImportProject('__local__'))

    const runs = vi.fn()
    api.sessionImports.onRun(runs)
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    // The run's one coarse frame counts; a per-task rename from the importer and anyone else's frame do not.
    bus.emit(EventNames.TASK_UPDATED, {}, [], { source: 'external-session-import' })
    bus.emit(EventNames.TASK_UPDATED, { task: { id: 'renamed' } }, ['web-ui'], { source: 'external-session-import' })
    bus.emit(EventNames.TASK_UPDATED, {}, [], { source: 'someone-else' })
    await settle()
    expect(runs).toHaveBeenCalledOnce()

    await context.dispose()
    bus.emit(EventNames.TASK_UPDATED, {}, [], { source: 'external-session-import' })
    await settle()
    expect(runs).toHaveBeenCalledOnce()
  })

  it('lets a plugin claim its program\'s runs for the importer until it stops', async () => {
    const { isClaimedImport, _resetImportClaimsForTesting } = await import('../../src/core/sessions/external-session-import.js')
    _resetImportClaimsForTesting()
    const { api, context } = setup()
    expect(api.sessionImports.include('devbox', ['run-1', 'run-2', 'no good'])).toBe(2)
    expect(isClaimedImport('devbox', 'run-1')).toBe(true)
    expect(isClaimedImport('__local__', 'run-1')).toBe(false)
    // A later call replaces the list for that host.
    api.sessionImports.include('devbox', ['run-2'])
    expect(isClaimedImport('devbox', 'run-1')).toBe(false)
    expect(isClaimedImport('devbox', 'run-2')).toBe(true)
    expect(() => api.sessionImports.include('', ['run-3'])).toThrow(/Host/)
    // A second generation of the same plugin keeps its own claims when the first stops.
    const next = setup()
    next.api.sessionImports.include('devbox', ['run-9'])
    await context.dispose()
    expect(isClaimedImport('devbox', 'run-2')).toBe(false)
    expect(isClaimedImport('devbox', 'run-9')).toBe(true)
    await next.context.dispose()
    expect(isClaimedImport('devbox', 'run-9')).toBe(false)
  })

  it('registers typed multi-point hooks with filters and timeouts', async () => {
    const dispatcher = new HookDispatcher()
    dispatchers.push(dispatcher)
    dispatcher.init([])
    setSessionHookDispatcher(dispatcher)
    const { api, context } = setup()
    const handler = vi.fn()

    api.registry.hook({
      id: 'lifecycle',
      points: ['onTaskCreated', 'onSessionWillReap'],
      priority: 25,
      timeoutMs: 1_500,
      filter: { projects: ['Example'], requiresSession: true },
      handler,
    })

    expect(dispatcher.getHooks()).toEqual([
      expect.objectContaining({
        id: 'sample-plugin:lifecycle',
        hooks: ['onTaskCreated', 'onSessionWillReap'],
        priority: 25,
        timeoutMs: 1_500,
        filter: { projects: ['Example'], requiresSession: true },
        source: 'plugin',
      }),
    ])

    await context.dispose()
    expect(dispatcher.getHooks()).toEqual([])
  })

  it('keeps activation usable when hooks are disabled', async () => {
    setSessionHookDispatcher(null)
    const { api, context } = setup()
    const warningsBefore = vi.mocked(logger.warn).mock.calls.length

    const registration = api.registry.hook({
      id: 'optional-hook',
      point: 'onTaskCreated',
      handler: vi.fn(),
    })

    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warningsBefore + 1)
    await registration.dispose()
    await context.dispose()
  })

  it('tells a plugin which box it is on, and who called its service', () => {
    // `replica` exists so a plugin that owns an OUTSIDE account (a mailbox, a chat workspace)
    // can refuse to poll from two boxes. It mirrors the host's cloud-mode flag, which the test
    // constants pin to false, so the assertion here is that the field is wired at all: a
    // missing one reads as `undefined`, which is falsy, so every replica would quietly poll.
    const { api } = setup()
    expect(api.replica).toBe(false)
    expect(typeof api.replica).toBe('boolean')

    // `caller()` is only meaningful inside a service method body. Outside one it is undefined,
    // never a stale value from the last call.
    expect(api.services.caller()).toBeUndefined()

    const consumer = setup('consumer-plugin', 'Consumer Plugin', { 'sample-plugin': '^1' })
    const seen: Array<string | undefined> = []
    api.services.publish('greeter', { greet: () => { seen.push(api.services.caller()) } })
    consumer.api.services.get<{ greet(): void }>('sample-plugin:greeter').greet()

    expect(seen).toEqual(['consumer-plugin'])
    expect(api.services.caller()).toBeUndefined()
  })

  /**
   * The reload bug in one test. `publishService` REPLACES whatever holds the key and `own()`
   * only notices the context is gone afterwards, so a late publish from the REPLACED
   * generation used to overwrite the live instance's row and then delete it by token — a
   * reload that ended with no service at all and a consumer told the running plugin is down.
   */
  it('refuses a late publish from a replaced generation instead of overwriting the live one', async () => {
    const first = setup()
    first.api.services.publish('greeter', { greet: () => 'first' })
    await first.context.dispose()

    const second = setup()
    second.api.services.publish('greeter', { greet: () => 'second' })
    expect(getServiceEntry('sample-plugin:greeter')?.api.greet()).toBe('second')

    expect(() => first.api.services.publish('greeter', { greet: () => 'late first' }))
      .toThrow('was disposed')

    expect(getServiceEntry('sample-plugin:greeter')?.api.greet()).toBe('second')
  })

  it('refuses every registration from a disposed context before it touches the host', async () => {
    const { api, context, collected } = setup()
    const timerHandler = vi.fn()
    await context.dispose()

    const refused = [
      () => api.registry.tool({ name: 'inspect', description: 'Inspect', execute: async () => 'ok' }),
      () => api.registry.cronAction('collect', 'Collect', async () => ({ status: 'ok' as const })),
      () => api.registry.wsMethod('ping', async () => ({})),
      () => api.registry.agent({ id: 'helper', name: 'Helper', runner: 'embedded' as const }),
      () => api.registry.provider('custom', {
        sendMessage: async () => ({ content: [], stopReason: 'end_turn' }),
        sendMessageStream: async () => ({ content: [], stopReason: 'end_turn' }),
      }),
      () => api.registry.agentContext('Sample Plugin is available.'),
      () => api.http.route('GET', '/status', async () => ({ json: {} })),
      () => api.events.on('task:', vi.fn()),
      () => api.config.onChange(vi.fn()),
      () => api.services.onChange(vi.fn()),
      () => api.letters.onAnswered(vi.fn()),
      () => api.timers.timeout(timerHandler, 1),
      () => api.timers.interval(timerHandler, 1),
    ]
    for (const attempt of refused) expect(attempt).toThrow('was disposed')

    // Nothing landed, and no timer was armed: the guard runs before the write, not after it.
    expect(collected.tools).toEqual([])
    expect(collected.httpRoutes).toEqual([])
    expect(collected.agentContext).toBeNull()
    expect(getAction('sample-plugin:collect')).toBeUndefined()
    expect(_getRpcMethodForTesting('sample-plugin:ping')).toBeUndefined()
    await expect(getAgent('sample-plugin:helper')).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(timerHandler).not.toHaveBeenCalled()
  })

  it('keeps a teardown able to log and persist while refusing new registrations', async () => {
    const { api, context, collected } = setup()
    const observed: { wrote?: boolean; refused?: string } = {}
    context.onDispose(async () => {
      // The signal is already aborted here, and this is exactly when a plugin flushes state.
      // Storage is owned by the api bag and disposed LAST, so it is still open.
      await api.storage.writeJson('final.json', { flushed: true })
      observed.wrote = true
      api.log.info('plugin flushed its state')
      try { api.registry.tool({ name: 'late', description: 'Late', execute: async () => 'x' }) }
      catch (error) { observed.refused = error instanceof Error ? error.message : String(error) }
    })

    await context.dispose()

    expect(observed.wrote).toBe(true)
    expect(observed.refused).toContain('was disposed')
    expect(collected.tools).toEqual([])
  })

  it('logs unsafe access once', () => {
    const { api } = setup()
    const warningsBefore = vi.mocked(logger.warn).mock.calls.length
    void api.unsafe
    void api.unsafe

    expect(vi.mocked(logger.warn).mock.calls.length).toBe(warningsBefore + 1)
  })
})
