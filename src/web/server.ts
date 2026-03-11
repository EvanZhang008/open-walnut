/**
 * Express + WebSocket server entry point.
 *
 * Serves the REST API, proxies bus events to WebSocket clients,
 * and serves static files in production mode.
 */

import { createServer, type Server as HttpServer } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { bus, EventNames, eventData } from '../core/event-bus.js'
import { attachWss, broadcastEvent, sendStreamEvent, closeWss } from './ws/handler.js'
import { sessionStreamBuffer } from './session-stream-buffer.js'
import { notFoundHandler, errorHandler } from './middleware/error-handler.js'
import { tasksRouter } from './routes/tasks.js'
import { dashboardRouter } from './routes/dashboard.js'
import { sessionsRouter } from './routes/sessions.js'
import { searchRouter } from './routes/search.js'
import { memoryRouter } from './routes/memory.js'
import { configRouter } from './routes/config.js'
import { categoriesRouter } from './routes/categories.js'
import { favoritesRouter } from './routes/favorites.js'
import { focusRouter } from './routes/focus.js'
import { orderingRouter } from './routes/ordering.js'
import { chatHistoryRouter } from './routes/chat-history.js'
import { contextInspectorRouter } from './routes/context-inspector.js'
import { registerChatRpc } from './routes/chat.js'
import { registerSessionChatRpc } from './routes/session-chat.js'
import { usageRouter } from './routes/usage.js'
import { imagesRouter } from './routes/images.js'
import { localImageRouter } from './routes/local-image.js'
import { createCronRouter, setCronService } from './routes/cron.js'
import { createAgentsRouter } from './routes/agents.js'
import { createCommandsRouter } from './routes/commands.js'
import { createSlashCommandsRouter } from './routes/slash-commands.js'
import { timelineRouter } from './routes/timeline.js'
import { CronService } from '../core/cron/index.js'
import { CRON_FILE } from '../constants.js'
import { sessionRunner } from '../providers/claude-code-session.js'
import { SessionHealthMonitor } from '../core/session-health-monitor.js'
import { subagentRunner } from '../providers/subagent-runner.js'
import { seedConfigDefaults } from '../core/config-manager.js'
import { getTask, listTasks } from '../core/task-manager.js'
import { log } from '../logging/index.js'
import { usageTracker } from '../core/usage/index.js'
import * as chatHistory from '../core/chat-history.js'
import { gitPullWalnut, ensureRepo, commitIfDirty, isGitAvailable, isLockContention } from '../integrations/git-sync.js'
import { registry } from '../core/integration-registry.js'
import { loadPlugins, migrateConfigToPlugins, runPluginMigrations } from '../core/integration-loader.js'
import type { SyncPollContext } from '../core/integration-types.js'
import { integrationsRouter } from './routes/integrations.js'
import { systemRouter } from './routes/system.js'
import { notesRouter } from './routes/notes.js'
import { authMiddleware } from './middleware/auth.js'
import { pushRouter } from './routes/push.js'
import { authRouter } from './routes/auth.js'
import { registerAuthRpc } from './routes/auth-rpc.js'
import { initPushNotifications } from '../core/push-notification.js'
import { enqueueMainAgentTurn, getQueueStatus } from './agent-turn-queue.js'
import { triggerBackgroundCompaction } from './background-compaction.js'
import {
  startHeartbeatRunner,
  isHeartbeatOk,
  type HeartbeatRunnerHandle,
} from '../heartbeat/index.js'


/**
 * Look up a task and build a rich reference: [id|Project / Title] or [id|Title].
 * Falls back to [id] if the task can't be found.
 */
async function resolveTaskRef(taskId: string): Promise<string> {
  try {
    const task = await getTask(taskId)
    const label = task.project && task.project !== task.category
      ? `${task.project} / ${task.title}`
      : task.title
    return `[${taskId}|${label}]`
  } catch {
    return `[${taskId}]`
  }
}

const DEFAULT_PORT = 3456
const SYNC_INTERVAL_MS = 30_000 // Default plugin sync interval (30s)

export interface ServerOptions {
  port?: number
  dev?: boolean
}

let httpServer: HttpServer | null = null
let pluginSyncTimers: ReturnType<typeof setInterval>[] = []
let cronServiceInstance: CronService | null = null
let healthMonitor: SessionHealthMonitor | null = null
let heartbeatHandle: HeartbeatRunnerHandle | null = null
let memoryWatcherHandle: { stop: () => void } | null = null
let gitAutoCommitHandle: { stop: () => void; health: GitAutoCommitHealth } | null = null

// ── Git auto-commit health state ──

interface GitAutoCommitHealth {
  protected: boolean
  error?: string
  lastCommitAt?: string
  consecutiveFailures: number
}

// ── Pending cron notifications for next-cycle delivery ──
// Queued when wakeMode is 'next-cycle'; injected into agent context on next user chat message.

export interface PendingCronNotification {
  text: string
  jobName: string
  timestamp: number
}

const pendingCronNotifications: PendingCronNotification[] = []

export function getPendingCronNotifications(): PendingCronNotification[] {
  return pendingCronNotifications
}

export function drainPendingCronNotifications(): PendingCronNotification[] {
  return pendingCronNotifications.splice(0, pendingCronNotifications.length)
}

// ── System health state (embedding, etc.) ──

export interface SystemHealthState {
  embedding: {
    total: number;
    indexed: number;
    unindexed: number;
    ollamaAvailable: boolean;
    lastReconcileAt?: string;
    lastError?: string;
  };
}

const systemHealth: SystemHealthState = {
  embedding: { total: 0, indexed: 0, unindexed: 0, ollamaAvailable: true },
}

export function getSystemHealth(): SystemHealthState {
  return systemHealth
}

/**
 * Create and start the server.
 * Returns the running HTTP server instance.
 */
export async function startServer(options: ServerOptions = {}): Promise<HttpServer> {
  if (httpServer) throw new Error('Server already running. Call stopServer() first.')

  // Seed config defaults (e.g. available_models) on first run
  await seedConfigDefaults()

  const port = options.port ?? DEFAULT_PORT
  const dev = options.dev ?? false
  const isEphemeral = !!process.env.WALNUT_EPHEMERAL

  const app = express()

  // -- Middleware --
  app.use(cors())
  app.use(express.json())
  // Auth middleware: localhost passthrough, remote requires Bearer token
  app.use('/api', authMiddleware)

  // -- Cron service --
  const cronService = new CronService({
    storePath: CRON_FILE,
    cronEnabled: true,
    log: log.cron,
    broadcastCronNotification: async (text, jobName, opts) => {
      const timestamp = new Date().toISOString()
      // Toast notification
      broadcastEvent('cron:notification', { text, jobName, timestamp: Date.now() })
      // Chat message (for inline display)
      broadcastEvent('cron:chat-message', { content: text, jobName, timestamp, agentWillRespond: opts?.agentWillRespond ?? false })
      // Persist notification to chat history (survives refresh)
      await chatHistory.addNotification({
        role: 'user', content: text, timestamp,
        source: 'cron', cronJobName: jobName,
      })
    },
    queueCronNotificationForAgent: (text, jobName) => {
      pendingCronNotifications.push({ text, jobName, timestamp: Date.now() })
      log.cron.info('queued cron notification for next agent interaction', { jobName })
    },
    runMainAgentWithPrompt: async (prompt, jobName) => {
      // Enqueue into the main agent turn queue — serialized with chat and triage turns
      await enqueueMainAgentTurn(`cron:${jobName}`, async () => {
        try {
          const { runAgentLoop } = await import('../agent/loop.js')
          const { estimateMessagesTokens } = await import('../core/daily-log.js')
          // Load history inside the queue (reads fresh state after any preceding turn)
          const history = await chatHistory.getApiMessages()
          const historyTokens = estimateMessagesTokens(history)
          log.cron.info('runMainAgentWithPrompt', {
            jobName,
            historyMessages: history.length,
            historyTokens: `~${Math.round(historyTokens / 1000)}K`,
          })
          const cronPrompt = `[Scheduled Job "${jobName}"] ${prompt}`
          const result = await runAgentLoop(cronPrompt, history, {
            onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'cron' }),
            onThinking: (text) => broadcastEvent('agent:thinking', { text }),
            onToolCall: (toolName, input, toolUseId) => broadcastEvent('agent:tool-call', { toolName, input, toolUseId }),
            onToolResult: (toolName, result, toolUseId) => broadcastEvent('agent:tool-result', { toolName, result, toolUseId }),
            onToolActivity: (activity) => broadcastEvent('agent:tool-activity', activity),
            // onText intentionally NOT provided — fires per text block per round.
            // agent:response is fired ONCE below after the loop completes.
            onUsage: (usage) => {
              try { usageTracker.record({ source: 'cron', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens }) } catch {}
            },
          }, { source: 'cron' })
          // Fire agent:response exactly once after loop completes
          if (result.response) {
            broadcastEvent('agent:response', { text: result.response, source: 'cron' })
          }
          // Persist agent response to chat history
          const newApiMsgs = result.messages.slice(history.length)
          await chatHistory.addAIMessages(newApiMsgs, { source: 'cron' })
          log.cron.info('agent done', { jobName, newMessages: newApiMsgs.length })
          // Trigger background compaction outside the turn queue
          triggerBackgroundCompaction(`cron:${jobName}`)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          log.cron.error('cron runMainAgentWithPrompt failed', { jobName, error: errMsg })
          // Broadcast error so the UI clears streaming state
          broadcastEvent('agent:error', { error: `Cron job "${jobName}" agent failed: ${errMsg}` })
          // Persist error to chat history so it survives page refresh
          await chatHistory.addNotification({
            role: 'assistant',
            content: `**Cron Error** (${jobName}): ${errMsg}`,
            source: 'agent-error',
            notification: true,
          })
          throw err // Re-throw so the cron system records the error status
        }
      })
    },
    runIsolatedAgentJob: async ({ job, message }) => {
      const { runAgentLoop } = await import('../agent/loop.js')
      const result = await runAgentLoop(message, [], {
        onUsage: (usage) => {
          try { usageTracker.record({ source: 'cron', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens }) } catch {}
        },
      }, { source: 'cron-isolated' })
      return { status: 'ok', summary: (result.response ?? '').slice(0, 2000) }
    },
    runAction: async (actionId, params) => {
      const { runAction } = await import('../actions/index.js')
      const ar = await runAction(actionId, params)
      // Adapt ActionResult { invoke, content, image } → CronServiceDeps shape { status, summary, data }
      if (!ar.invoke) {
        // invoke=false: either error/permission issue or screen unchanged — return ok, let agent handle via text
        return { status: 'ok', summary: ar.content }
      }
      return {
        status: 'ok',
        summary: ar.content,
        data: ar.image ? {
          thumbnailBase64: ar.image.base64,
          mediaType: ar.image.mediaType,
          timestampMs: Date.now(),
        } : undefined,
      }
    },
    runActionWithAgent: async (actionResult, agentId, modelOverride) => {
      const { getAgent } = await import('../core/agent-registry.js')
      const { runAgentLoop } = await import('../agent/loop.js')
      const { buildSubagentSystemPrompt, buildSubagentToolSet } = await import('../agent/subagent-context.js')
      const { buildStatefulMemorySection } = await import('../agent/stateful-memory.js')
      const { getProjectMemory } = await import('../core/project-memory.js')

      const agentDef = await getAgent(agentId)
      if (!agentDef) return { status: 'error' as const, error: `agent "${agentId}" not found` }

      // Build message from actionResult: multimodal if image present, text-only otherwise
      const actionData = actionResult.data as Record<string, unknown> | undefined
      let message: string | Array<{ type: string; [k: string]: unknown }>
      if (actionData?.thumbnailBase64 && actionData?.mediaType) {
        message = [
          {
            type: 'image',
            source: { type: 'base64', media_type: actionData.mediaType, data: actionData.thumbnailBase64 },
          },
          {
            type: 'text',
            text: `New data at ${new Date().toLocaleTimeString()}. ${actionResult.summary ?? ''}`,
          },
        ] as Array<{ type: string; [k: string]: unknown }>
      } else {
        // Text-only: screen unchanged, permission error, or non-image action
        message = actionResult.summary ?? '[action completed with no output]'
      }

      // Build system prompt
      const taskDesc = typeof message === 'string' ? message : 'Analyze the provided data.'
      let systemPrompt = buildSubagentSystemPrompt(agentDef, taskDesc)

      // If stateful: inject memory
      if (agentDef.stateful) {
        const memResult = getProjectMemory(agentDef.stateful.memory_project)
        systemPrompt += '\n\n' + buildStatefulMemorySection(memResult?.content ?? null, agentDef.stateful)
      }

      const tools = await buildSubagentToolSet(agentDef)

      try {
        const result = await runAgentLoop(message, [], {
          onUsage: (usage) => {
            try { usageTracker.record({ source: 'subagent', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, parent_source: 'cron' }) } catch {}
          },
        }, {
          system: systemPrompt,
          tools,
          modelConfig: { model: modelOverride ?? agentDef.model },
          maxToolRounds: agentDef.max_tool_rounds ?? 5,
          source: `cron-action-${agentId}`,
        })

        // Memory is now agent-driven: the agent uses the `memory` tool directly.

        return { status: 'ok' as const, summary: result.response?.slice(0, 2000) }
      } catch (err) {
        return { status: 'error' as const, error: err instanceof Error ? err.message : String(err) }
      }
    },
    onEvent: (evt) => {
      broadcastEvent(`cron:job-${evt.action}`, evt)
      // Wake heartbeat when a cron job finishes
      if (evt.action === 'finished' && heartbeatHandle) {
        heartbeatHandle.requestNow('cron-completed', `Cron job "${evt.summary ?? evt.jobId}" just finished.`)
      }
    },
  })
  cronServiceInstance = cronService
  setCronService(cronService)

  // -- Discover file-based cron actions --
  try {
    const { discoverActions } = await import('../actions/index.js')
    const actions = await discoverActions()
    log.cron.info('discovered cron actions', { count: actions.length, ids: actions.map(a => a.id) })
  } catch (err) {
    log.cron.debug('action discovery failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- API routes --
  app.use('/api/cron', createCronRouter(cronService))
  app.use('/api/tasks', tasksRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/sessions', sessionsRouter)
  app.use('/api/search', searchRouter)
  app.use('/api/memory', memoryRouter)
  app.use('/api/config', configRouter)
  app.use('/api/categories', categoriesRouter)
  app.use('/api/favorites', favoritesRouter)
  app.use('/api/focus', focusRouter)
  app.use('/api/ordering', orderingRouter)
  app.use('/api/chat', chatHistoryRouter)
  app.use('/api/context', contextInspectorRouter)
  app.use('/api/usage', usageRouter)
  app.use('/api/images', imagesRouter)
  app.use('/api/local-image', localImageRouter)
  app.use('/api/agents', createAgentsRouter())
  app.use('/api/commands', createCommandsRouter())
  app.use('/api/slash-commands', createSlashCommandsRouter())
  app.use('/api/heartbeat', (await import('./routes/heartbeat.js')).heartbeatRouter)
  app.use('/api/timeline', timelineRouter)
  app.use('/api/notes', notesRouter)
  app.use('/api/integrations', integrationsRouter)
  app.use('/api/system', systemRouter)
  app.use('/api/push', pushRouter)
  app.use('/api/auth', authRouter)
  app.get('/api/git-sync/status', (_req, res) => {
    const health = gitAutoCommitHandle?.health ?? { protected: false, error: 'not started', consecutiveFailures: 0 }
    res.json(health)
  })

  // -- Static files (production only) --
  if (!dev) {
    // Resolve static dir by walking up from the current file.
    // tsup inlines this into both dist/web/server.js and dist/cli.js,
    // so import.meta.url varies per bundle — walk up to find dist/web/static/.
    const staticDir = (() => {
      let dir = path.dirname(fileURLToPath(import.meta.url))
      for (let i = 0; i < 5; i++) {
        const candidate = path.join(dir, 'web', 'static', 'index.html')
        try { if (fs.statSync(candidate).isFile()) return path.join(dir, 'web', 'static') } catch {}
        // Also check if we're already in dist/web/
        const direct = path.join(dir, 'static', 'index.html')
        try { if (fs.statSync(direct).isFile()) return path.join(dir, 'static') } catch {}
        dir = path.dirname(dir)
      }
      // Fallback: assume dist/web/static relative to cwd
      return path.join(process.cwd(), 'dist', 'web', 'static')
    })()
    app.use(express.static(staticDir))
    // SPA fallback: serve index.html for non-API routes
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
      res.sendFile(path.join(staticDir, 'index.html'))
    })
  }

  // -- Error handlers (must be last) --
  app.use('/api', notFoundHandler)
  app.use(errorHandler)

  // -- HTTP + WebSocket --
  httpServer = createServer(app)
  attachWss(httpServer)

  // -- Bind port early (before heavy init) so no other process can grab it --
  await new Promise<void>((resolve, reject) => {
    httpServer!.listen(port, () => resolve())
    httpServer!.once('error', reject)
  })
  const label = dev ? 'dev' : 'production'
  log.web.info(`server listening on http://localhost:${port}`, { mode: label, port })
  console.log(`Walnut web server (${label}) listening on http://localhost:${port}`)

  // -- Register RPC methods on the WebSocket handler --
  registerChatRpc()
  registerSessionChatRpc()
  registerAuthRpc()

  // -- Push notification service --
  initPushNotifications()

  // -- Pull latest data from git (remote hooks may have pushed new data) --
  if (!isEphemeral) {
    await gitPullWalnut()
  }

  // -- Prewarm task store: force load + migration before accepting requests --
  // Without this, early HTTP requests can hit an uninitialized store and return [].
  try {
    await listTasks()
    log.web.info('task store prewarmed')
  } catch (err) {
    log.web.warn('task store prewarm failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // -- Reconcile zombie sessions + identify reconnectable ones --
  let reconnectable: import('../core/types.js').SessionRecord[] = []
  try {
    const { reconcileSessions } = await import('../core/session-reconciler.js')
    const result = await reconcileSessions()
    reconnectable = result.reconnectable
  } catch (err) {
    log.session.warn('session reconciliation failed on startup', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Migrate stale sessions from completed tasks --
  try {
    const { migrateCompletedTaskSessions } = await import('../core/task-manager.js')
    await migrateCompletedTaskSessions()
  } catch (err) {
    log.session.warn('completed-task session migration failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Clean up old stream files (preserve non-terminal sessions) --
  try {
    const { cleanupStreamFiles } = await import('../providers/claude-code-session.js')
    const { listSessions, TERMINAL_WORK_STATUSES } = await import('../core/session-tracker.js')
    const allSessions = await listSessions()
    const preserveIds = new Set(
      allSessions
        .filter(s => !TERMINAL_WORK_STATUSES.has(s.work_status))
        .map(s => s.claudeSessionId),
    )
    await cleanupStreamFiles(preserveIds)
  } catch (err) {
    log.session.debug('stream file cleanup failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Prune old usage records --
  try { usageTracker.prune() } catch (e) { log.usage.warn('usage prune failed', { error: String(e) }) }

  // -- Start memory file watcher (FTS5 reindex + chunk embedding on .md changes) --
  try {
    const { startMemoryWatcher } = await import('../core/memory-watcher.js')
    const { indexMemoryFiles } = await import('../core/memory-index.js')
    // Ensure FTS index is populated on startup
    indexMemoryFiles()
    memoryWatcherHandle = startMemoryWatcher()
    log.memory.info('memory watcher started')
  } catch (err) {
    log.memory.warn('memory watcher startup failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Reconcile embeddings (non-blocking background task) --
  // Runs after FTS index so chunk embeddings have data to work with.
  reconcileEmbeddingsBackground()

  // -- Git auto-commit polling (30s interval) --
  // Skip for ephemeral servers — they use a temp copy of data, no need to backup
  if (!isEphemeral) {
    gitAutoCommitHandle = startGitAutoCommit()
  }

  // -- Init SubagentRunner + SessionRunner --
  subagentRunner.init()
  sessionRunner.init(reconnectable)

  // -- Init Session Hook Dispatcher --
  try {
    const { SessionHookDispatcher, builtinHooks, discoverFileHooks, setSessionHookDispatcher } = await import('../core/session-hooks/index.js')
    const { getConfig: getHooksConfig } = await import('../core/config-manager.js')
    const hooksConfig = (await getHooksConfig()).session_hooks
    const fileHooks = await discoverFileHooks()
    const allHooks = [...builtinHooks, ...fileHooks]
    const hookDispatcher = new SessionHookDispatcher(hooksConfig)
    hookDispatcher.init(allHooks, hooksConfig)
    setSessionHookDispatcher(hookDispatcher)
    log.web.info('session hook dispatcher initialized', { hookCount: allHooks.length })
  } catch (err) {
    log.web.error('session hook dispatcher init failed — session triage and lifecycle hooks will NOT fire', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Connect to SDK session server (if enabled) --
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const config = await getConfig()
    if (config.session_server?.enabled) {
      const port = config.session_server.port ?? 7890
      const { SessionServerClient } = await import('../providers/session-server-client.js')
      const sdkClient = new SessionServerClient({
        url: `ws://localhost:${port}`,
        hostName: 'local',
        onEvent: (event) => {
          // Forward interactive events to browser via WebSocket
          broadcastEvent(event.name, event.data)
        },
      })

      try {
        await sdkClient.connect()
        sessionRunner.setSdkClient(sdkClient)
        log.session.info('SDK session server client connected', { port })
      } catch (err) {
        log.session.warn('failed to connect to SDK session server — falling back to CLI sessions', {
          port,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } catch (err) {
    log.session.debug('session server client init skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Start session health monitor --
  healthMonitor = new SessionHealthMonitor()
  healthMonitor.start()

  // -- Wire bus subscriber to push events to WS clients --
  bus.subscribe('web-ui', (event) => {
    broadcastEvent(event.name, event.data)
  })

  // -- Dependency unblock: emit task:unblocked when a completed task frees dependents --
  bus.subscribe('dependency-unblock', async (event) => {
    if (event.name !== EventNames.TASK_COMPLETED) return
    const { task: completedTask } = eventData<'task:completed'>(event)
    if (!completedTask?.id) return
    try {
      const { listTasks, isTaskBlocked } = await import('../core/task-manager.js')
      const allTasks = await listTasks({})
      // Find tasks that depend on the just-completed task
      const dependents = allTasks.filter(
        (t) => t.depends_on?.includes(completedTask.id) && t.phase !== 'COMPLETE',
      )
      for (const dep of dependents) {
        // Check if ALL of this task's deps are now complete
        if (!isTaskBlocked(dep, allTasks)) {
          bus.emit(EventNames.TASK_UNBLOCKED, { task: dep, unblockedBy: completedTask }, ['web-ui', 'main-agent'], { source: 'dependency-unblock' })
          log.web.info('task unblocked', { taskId: dep.id, unblockedBy: completedTask.id })
        }
      }
    } catch (err) {
      log.web.error('dependency-unblock subscriber error', { error: err instanceof Error ? err.message : String(err) })
    }
  }, { global: true })

  // -- Incremental embedding: re-embed tasks on create/update --
  let embeddingDebounce: ReturnType<typeof setTimeout> | null = null
  const pendingEmbedTaskIds = new Set<string>()
  const failedEmbedTaskIds = new Set<string>() // retry queue for failed embeddings
  let embeddingRetryTimer: ReturnType<typeof setTimeout> | null = null
  let embeddingRetryDelay = 60_000 // starts at 60s, doubles each failure, caps at 5min

  bus.subscribe('embedding-sync', async (event) => {
    if (event.name !== EventNames.TASK_CREATED && event.name !== EventNames.TASK_UPDATED) return
    const { task } = eventData<'task:created'>(event)
    if (!task?.id) return

    pendingEmbedTaskIds.add(task.id)
    if (embeddingDebounce) clearTimeout(embeddingDebounce)
    embeddingDebounce = setTimeout(async () => {
      const ids = [...pendingEmbedTaskIds]
      pendingEmbedTaskIds.clear()

      let failedCount = 0
      let embeddedCount = 0
      const succeededIds = new Set<string>()
      try {
        const { embedSingleTask } = await import('../core/embedding/pipeline.js')
        const { getTask: getTaskById } = await import('../core/task-manager.js')
        for (const id of ids) {
          try {
            const t = await getTaskById(id)
            const result = await embedSingleTask(t)
            if (result === 'failed') {
              failedCount++
              failedEmbedTaskIds.add(id)
            } else if (result === 'embedded') {
              embeddedCount++
              succeededIds.add(id)
              failedEmbedTaskIds.delete(id) // clear from retry queue on success
            }
          } catch (err) {
            // Task may have been deleted between event and embedding
            const msg = err instanceof Error ? err.message : String(err)
            log.memory.debug(`embedSingleTask skipped task ${id}: ${msg}`)
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.memory.warn(`Embedding pipeline error: ${msg}`)
        failedCount = ids.length - embeddedCount
        for (const id of ids) {
          if (!succeededIds.has(id)) failedEmbedTaskIds.add(id)
        }
      }

      if (embeddedCount > 0) {
        log.memory.debug(`Incremental embedding: ${embeddedCount} task(s) embedded`)
      }

      // Update health if incremental embedding failed
      if (failedCount > 0) {
        log.memory.warn(`Incremental embedding: ${failedCount} task(s) failed — queued for retry`)
        systemHealth.embedding.unindexed = failedEmbedTaskIds.size
        systemHealth.embedding.ollamaAvailable = false
        broadcastEvent('system:health', systemHealth)
        scheduleEmbeddingRetry()
      }
    }, 500) // 500ms debounce
  })

  // Retry failed embeddings with exponential backoff (60s -> 120s -> 240s -> 300s cap)
  function scheduleEmbeddingRetry(): void {
    if (embeddingRetryTimer) return // already scheduled
    embeddingRetryTimer = setTimeout(async () => {
      embeddingRetryTimer = null
      if (failedEmbedTaskIds.size === 0) return

      const ids = [...failedEmbedTaskIds]
      log.memory.info(`Retrying embedding for ${ids.length} task(s) (delay was ${embeddingRetryDelay / 1000}s)...`)

      try {
        const { embedSingleTask } = await import('../core/embedding/pipeline.js')
        const { getTask: getTaskById } = await import('../core/task-manager.js')
        let retrySuccess = 0
        let retryFail = 0

        for (const id of ids) {
          try {
            const t = await getTaskById(id)
            const result = await embedSingleTask(t)
            if (result === 'failed') {
              retryFail++
            } else {
              failedEmbedTaskIds.delete(id)
              if (result === 'embedded') retrySuccess++
            }
          } catch {
            failedEmbedTaskIds.delete(id) // task deleted, remove from retry
          }
        }

        if (retrySuccess > 0) {
          log.memory.info(`Embedding retry: ${retrySuccess} task(s) recovered`)
          // Update health — run full reconcile count
          reconcileEmbeddingsBackground()
          embeddingRetryDelay = 60_000 // reset backoff on success
        }
        if (retryFail > 0) {
          log.memory.warn(`Embedding retry: ${retryFail} task(s) still failing — scheduling another retry`)
          embeddingRetryDelay = Math.min(embeddingRetryDelay * 2, 300_000) // double delay, cap at 5min
          scheduleEmbeddingRetry()
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.memory.warn(`Embedding retry failed: ${msg}`)
        // Outer failure (e.g. dynamic import failed) — also retry with backoff
        embeddingRetryDelay = Math.min(embeddingRetryDelay * 2, 300_000)
        scheduleEmbeddingRetry()
      }
    }, embeddingRetryDelay)
  }

  // -- Heartbeat config reload: restart runner when heartbeat config changes --
  bus.subscribe('heartbeat-config', async (event) => {
    if (event.name !== EventNames.CONFIG_CHANGED) return
    // Re-read config and restart heartbeat if settings changed
    try {
      const { getConfig } = await import('../core/config-manager.js')
      const newConfig = await getConfig()
      const wasRunning = heartbeatHandle !== null
      const shouldRun = newConfig.heartbeat?.enabled === true

      if (wasRunning && !shouldRun) {
        // Heartbeat was disabled
        heartbeatHandle?.stop()
        heartbeatHandle = null
        log.heartbeat.info('heartbeat disabled via config change')
      } else if (shouldRun) {
        // Config changed — restart with new settings
        heartbeatHandle?.stop()
        heartbeatHandle = null
        await startHeartbeatIfConfigured()
        log.heartbeat.info('heartbeat restarted with new config')
      }
    } catch (err) {
      log.heartbeat.warn('heartbeat config reload failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // -- Main AI triage: process session results with AI judgment --
  // All session events now route through main-ai first; forward to web-ui for display.
  bus.subscribe('main-ai', async (event) => {
    // ── Streaming events: buffer server-side + broadcast to all clients (filtered client-side) ──
    if (event.name === 'session:text-delta') {
      const { sessionId, delta } = eventData<'session:text-delta'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendTextDelta(sessionId, delta)
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:tool-use') {
      const { sessionId, toolName, toolUseId, input, planContent, parentToolUseId } = eventData<'session:tool-use'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendToolUse(sessionId, toolUseId, toolName, input, planContent, parentToolUseId)
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:tool-result') {
      const { sessionId, toolUseId, result } = eventData<'session:tool-result'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendToolResult(sessionId, toolUseId, result)
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:system-event') {
      const { sessionId, variant, message, detail } = eventData<'session:system-event'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendSystem(sessionId, variant, message, detail)
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:usage-update') {
      const { sessionId } = eventData<'session:usage-update'>(event)
      if (sessionId) {
        sendStreamEvent(sessionId, event.name, event.data)
      }
    }

    // ── Non-streaming events: broadcast to all clients (low-frequency, needed everywhere) ──
    // Skip session:result from embedded subagents — they are handled via subagent:result below
    // (forwarding them here would send the full result to browsers, bypassing compact triage logic)
    const isSubagentSessionResult = (event.name === 'session:result' || event.name === 'session:error')
      && event.source === 'subagent-runner'
    if (!isSubagentSessionResult && (
      event.name === 'session:started' || event.name === 'session:result' || event.name === 'session:error'
      || event.name === 'session:status-changed' || event.name === 'session:batch-completed'
      || event.name === 'session:message-queued' || event.name === 'session:messages-delivered')) {
      const enrichedData = { ...(event.data as Record<string, unknown>) }
      if ((event.name === 'session:result' || event.name === 'session:error') && enrichedData.taskId) {
        try {
          const task = await getTask(enrichedData.taskId as string)
          enrichedData.taskTitle = task.title
          enrichedData.taskProject = task.project
          enrichedData.taskCategory = task.category
        } catch { /* task not found — frontend falls back gracefully */ }
      }
      bus.emit(event.name, enrichedData, ['web-ui'], { source: event.source, urgency: event.urgency, reemit: true })

      // Clear stream buffer after session ends (delayed to let subscribers process the result event)
      if (event.name === 'session:result' || event.name === 'session:error') {
        const sid = eventData<'session:result'>(event).sessionId
        if (sid) {
          sessionStreamBuffer.markDone(sid)
          setTimeout(() => sessionStreamBuffer.clear(sid), 2000)
        }
      }
    }

    // session:started — no further processing needed
    if (event.name === 'session:started') return

    // Persist session:result to chat history
    if (event.name === 'session:result') {
      // Skip session:result from embedded subagents — they have their own lifecycle
      // (e.g. triage subagent emits session:result when done, but we handle that via
      // subagent:result instead). Without this guard, a triage subagent's session:result
      // would re-trigger triage dispatch, creating an infinite loop.
      if (event.source === 'subagent-runner') return

      // Git pull: fetch data pushed by remote hooks (best-effort)
      if (!isEphemeral) {
        try {
          await gitPullWalnut()
          log.web.info('git pull completed for session result')
        } catch (err) {
          log.web.warn('git pull failed after session result', { error: String(err) })
        }
      }

      const { sessionId, taskId, result, isError, totalCost, duration } = eventData<'session:result'>(event)
      log.web.info('session result received', { sessionId, taskId, resultLength: result?.length ?? 0 })

      // Record session cost (external Claude Code CLI process)
      if (totalCost != null && totalCost > 0) {
        try { usageTracker.record({
          source: 'session',
          model: 'claude-code-cli',
          sessionId,
          taskId,
          external_cost_usd: totalCost,
          duration_ms: duration,
        }) } catch {}
      }

      const taskRef = taskId ? await resolveTaskRef(taskId) : null

      // For successful sessions with a taskId, the triage agent will produce a compact
      // notification — don't write the full session result to main chat.
      // For errors or sessions without a taskId (no triage), persist directly.
      const willBeTriage = !isError && !!taskId
      if (result && !willBeTriage) {
        const prefix = isError ? '**Session Error**' : '**Session Result**'
        const content = taskRef
          ? `${prefix} (${taskRef}):\n\n${result}`
          : `${prefix}:\n\n${result}`
        await chatHistory.addNotification({
          role: 'assistant', content,
          source: isError ? 'session-error' : 'session',
          notification: true, taskId,
        })
      }

      if (isError || !taskId) {
        // Clear active session from task on error
        if (taskId && sessionId) {
          try {
            const { clearSessionSlot, clearSession } = await import('../core/task-manager.js')
            const { task } = await clearSessionSlot(taskId, sessionId)
            // Also clear new single-slot field (parallel 1-slot transition)
            await clearSession(taskId, sessionId).catch(() => {})
            bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-error' })
          } catch (err) { log.web.warn('failed to clear session slot', { sessionId, taskId, error: String(err) }) }
        }
        // Emit session:ended so the Sessions page refreshes
        log.web.info('session ended event emitted', { sessionId, taskId })
        bus.emit(EventNames.SESSION_ENDED, { sessionId, taskId }, ['web-ui'], { source: 'session-result' })
        return
      }

      try {
        // Session record update is handled by session-runner (claude-code-session.ts)
        // which correctly sets idle vs stopped based on FIFO process liveness.
        // server.ts must NOT overwrite process_status — it lacks process state info.

        // Do NOT clear session slot here — turn_completed means the session
        // can still be resumed via send_to_session. The slot stays linked so the
        // UI shows which tasks have sessions. Slots are cleared only when:
        //   1. work_status transitions to 'completed' (agent/human sets it)
        //   2. work_status transitions to 'error' (handled above in isError branch)
        //   3. Task phase reaches COMPLETE (applyPhase clears slots)

        // Auto-progress task phase: ≤IN_PROGRESS → AGENT_COMPLETE on successful session
        try {
          const { getTask: getTaskById, updateTaskRaw } = await import('../core/task-manager.js')
          const { computeSessionCompletionPhase, applyPhase } = await import('../core/phase.js')
          const task = await getTaskById(taskId)
          const newPhase = computeSessionCompletionPhase(task.phase, false)
          if (newPhase) {
            applyPhase(task, newPhase)
            await updateTaskRaw(task.id, { phase: task.phase, status: task.status })
            bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-phase-sync' })
            log.web.info('auto-progressed task phase on session completion', { taskId, newPhase })
          }
        } catch (err) {
          log.web.warn('failed to auto-progress task phase', { taskId, error: String(err) })
        }

        // Triage dispatch is now handled by SessionHookDispatcher
        // (onTurnComplete hook) — no hardcoded triage here.
      } catch (err) {
        log.web.error('session result processing failed', { sessionId, taskId, error: err instanceof Error ? err.message : String(err) })
      }
      // Emit session:ended so the Sessions page refreshes
      log.web.info('session ended event emitted', { sessionId, taskId })
      bus.emit(EventNames.SESSION_ENDED, { sessionId, taskId }, ['web-ui'], { source: 'session-result' })
      return
    }

    // Persist session:error to chat history
    if (event.name === 'session:error') {
      // Git pull: fetch data pushed by remote hooks (best-effort)
      if (!isEphemeral) {
        try {
          await gitPullWalnut()
          log.web.info('git pull completed for session error')
        } catch (err) {
          log.web.warn('git pull failed after session error', { error: String(err) })
        }
      }

      const { error, taskId, sessionId } = eventData<'session:error'>(event)
      log.web.info('session error received', { sessionId, taskId, error: error?.slice(0, 200) })
      const errorTaskRef = taskId ? await resolveTaskRef(taskId) : null
      const content = `**Session Error**${errorTaskRef ? ` (${errorTaskRef})` : ''}: ${error}`
      await chatHistory.addNotification({
        role: 'assistant', content,
        source: 'session-error', notification: true, taskId,
      })
      // Clear active session from task on error
      if (taskId && sessionId) {
        try {
          const { clearSessionSlot, clearSession } = await import('../core/task-manager.js')
          await clearSessionSlot(taskId, sessionId)
          // Also clear new single-slot field (parallel 1-slot transition)
          await clearSession(taskId, sessionId).catch(() => {})
        } catch (err) { log.web.warn('failed to clear session slot', { sessionId, taskId, error: String(err) }) }
      }
      // Emit session:ended so the Sessions page refreshes
      log.web.info('session ended event emitted', { sessionId, taskId })
      bus.emit(EventNames.SESSION_ENDED, { sessionId, taskId }, ['web-ui'], { source: 'session-error' })
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ARCHITECTURE: Single Source of Truth for Chat Content
    //
    // PRINCIPLE: What AI sees = what human sees.
    //   - ONE content entry per event. Never build separate content for UI vs AI.
    //   - tag:'ai' entries are visible to BOTH the main agent AND the console.
    //   - NO displayText overrides to hide content. Console formats, never filters.
    //   - If content should be collapsible/highlighted, that's a frontend concern.
    //
    // ANTI-PATTERN (do NOT do this):
    //   const uiContent = "short summary"        // ← diverges
    //   const aiPrompt = "full analysis + context" // ← diverges
    //   addAIMessages(msgs, { displayText: uiContent }) // ← hides AI content
    //
    // CORRECT PATTERN:
    //   const content = "full content with all sections"
    //   Store as tag:'ai' → both AI and console see it
    //   Console renders sections (collapse, highlight) via CSS/React
    // ═══════════════════════════════════════════════════════════════════════

    // ── Subagent events ──

    // Forward subagent lifecycle events to web-ui for real-time display
    // NOTE: subagent:result is forwarded AFTER processing below (not here)
    // so triage content is assembled before reaching the browser.
    if (event.name === 'subagent:started' || event.name === 'subagent:error') {
      bus.emit(event.name, event.data, ['web-ui'], { source: 'subagent' })
    }

    // Persist subagent:result to chat history and run triage
    if (event.name === 'subagent:result') {
      const { runId, agentId, agentName, taskId, result, usage, notification } = eventData<'subagent:result'>(event)

      log.web.info('subagent result received', { runId, agentId, taskId, resultLength: result?.length ?? 0, hasNotification: !!notification })
      const subagentTaskRef = taskId ? await resolveTaskRef(taskId) : null

      // Check if this is a triage agent result — compact notification only
      const { DEFAULT_TRIAGE_AGENT_ID, DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID } = await import('../core/agent-registry.js')
      const { getConfig: getTriageConf } = await import('../core/config-manager.js')
      const triageConf2 = await getTriageConf()
      const triageAgentId = triageConf2.agent?.session_triage_agent ?? DEFAULT_TRIAGE_AGENT_ID
      const triageAgentIds = new Set([triageAgentId, DEFAULT_MESSAGE_SEND_TRIAGE_AGENT_ID])
      const isTriageResult = triageAgentIds.has(agentId)

      if (isTriageResult) {
        // Triage result: store full triage output for main chat (auto-collapsed in UI)
        // Strip internal tags — not user-facing
        const cleanedResult = result
          .replace(/<memory_update>[\s\S]*?<\/memory_update>/g, '')
          .replace(/<main_agent_notify>[\s\S]*?<\/main_agent_notify>/g, '')  // defensive: custom agents may still use old tag format
          .trim() || 'triage completed'

        // Notification decision comes from the structured notify_main_agent tool call,
        // not from parsing text tags. Tool calls are binary — called or not called.
        const triageUpdate = notification?.trim() ?? ''
        const willNotifyMainAgent = !!(triageUpdate && taskId)

        // Build display-safe task ref (uses <task-ref> XML tag for clickable link rendering)
        let displayTaskRef: string
        try {
          const refTask = await getTask(taskId)
          const refLabel = refTask.project && refTask.project !== refTask.category
            ? `${refTask.project} / ${refTask.title}` : refTask.title
          displayTaskRef = `<task-ref id="${taskId}" label="${refLabel}"/>`
        } catch {
          displayTaskRef = taskId
        }
        const triageTimestamp = new Date().toISOString()

        // Wake heartbeat after session triage
        if (heartbeatHandle) {
          heartbeatHandle.requestNow('session-ended', `Session for task ${taskId} just completed and was triaged.`)
        }

        if (willNotifyMainAgent) {
          // ── Single Source of Truth: AI and human see the SAME content ──
          // ONE entry with notification + full triage analysis.
          // Console collapses/expands sections; server never hides content.
          const triageContent = `**Triage** (${displayTaskRef}):\n\n**Main AI Notification:**\n\n${triageUpdate}\n\n---\n\n**Triage Analysis:**\n\n${cleanedResult}`
          log.web.info('triage will notify main agent (unified path)', { taskId, triageUpdate: triageUpdate.slice(0, 200) })

          // Push to browser immediately so user sees collapsed triage while AI thinks
          bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
            entry: { role: 'user', content: triageContent, source: 'triage', taskId, timestamp: triageTimestamp },
          }, ['web-ui'])

          // Fire-and-forget: enqueue a main agent turn
          // The prompt includes the full triage analysis so the AI can reason about it.
          // The browser already has the nice formatted content via the bus event above.
          void enqueueMainAgentTurn('triage', async () => {
            try {
              const task = await getTask(taskId)
              const taskNote = task?.note ?? '(no note yet)'
              const taskTitle = task ? `${task.project ?? task.category} / ${task.title}` : taskId
              const taskRef = task ? `[${task.id}]` : `[${taskId}]`

              // AI needs the full triage analysis to summarize for the user
              const prompt = `[Triage Update] Task "${taskTitle}" ${taskRef}\n\n${cleanedResult}\n\n<task_note>\n${taskNote}\n</task_note>\n\nInform the user concisely (2-4 sentences) about this task's status.\nFocus on what the triage analysis says — that's the new information.\nThe task note provides full context if needed.\nDo not use tools.`

              const { runAgentLoop } = await import('../agent/loop.js')
              const { estimateMessagesTokens, estimateFullPayload } = await import('../core/daily-log.js')
              const { getContextWindowSize } = await import('../agent/model.js')
              const { getConfig } = await import('../core/config-manager.js')
              const { buildSystemPrompt } = await import('../agent/context.js')
              const { getToolSchemas } = await import('../agent/tools.js')
              const history = await chatHistory.getApiMessages()
              const historyTokens = estimateMessagesTokens(history)

              // Pre-check: estimate full payload and bail to notification-only if near the limit.
              // This prevents burning API tokens on a 400 that the agent loop would have to recover from.
              const agentConfig = await getConfig()
              const mainModel = agentConfig.agent?.main_model
              const contextLimit = getContextWindowSize(mainModel)
              const TRIAGE_BAIL_PERCENT = 0.92 // bail if estimated > 92% of context window
              let estimatedTotal = historyTokens
              try {
                const system = await buildSystemPrompt()
                const tools = getToolSchemas()
                const full = estimateFullPayload({ system, tools, messages: history })
                estimatedTotal = full.total
              } catch (preCheckErr) {
                // If full estimation fails, be conservative — assume over limit to avoid 400
                log.web.warn('triage pre-check: full estimation failed, using conservative fallback', {
                  taskId, error: preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr),
                })
                estimatedTotal = contextLimit // force bail
              }

              if (estimatedTotal > contextLimit * TRIAGE_BAIL_PERCENT) {
                log.web.warn('triage main agent skipped: history near context limit', {
                  taskId,
                  estimatedTotal: `~${Math.round(estimatedTotal / 1000)}K`,
                  contextLimit: `${Math.round(contextLimit / 1000)}K`,
                  bailThreshold: `${Math.round(contextLimit * TRIAGE_BAIL_PERCENT / 1000)}K`,
                })
                // Fall back to notification-only (same as triageToChat: false path)
                const bailContent = `**Triage** (${displayTaskRef}):\n\n${cleanedResult}`
                await chatHistory.addNotification({
                  role: 'assistant', content: bailContent,
                  source: 'triage', notification: true, taskId,
                })
                broadcastEvent('agent:response', { text: bailContent, source: 'triage' })
                triggerBackgroundCompaction('triage-bail')
                return
              }

              log.web.info('triage main agent turn starting', {
                taskId,
                historyMessages: history.length,
                historyTokens: `~${Math.round(historyTokens / 1000)}K`,
                estimatedTotal: `~${Math.round(estimatedTotal / 1000)}K`,
              })

              const agentResult = await runAgentLoop(prompt, history, {
                onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'triage' }),
                onThinking: (text) => broadcastEvent('agent:thinking', { text }),
                onToolCall: (toolName, input) => broadcastEvent('agent:tool-call', { toolName, input }),
                onToolResult: (toolName, result) => broadcastEvent('agent:tool-result', { toolName, result }),
                onToolActivity: (activity) => broadcastEvent('agent:tool-activity', activity),
                onUsage: (u) => {
                  try { usageTracker.record({ source: 'triage', model: u.model ?? 'unknown', input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens }) } catch {}
                },
              }, { source: 'triage' })

              if (agentResult.response) {
                broadcastEvent('agent:response', { text: agentResult.response, source: 'triage' })
              }
              const newApiMsgs = agentResult.messages.slice(history.length)
              await chatHistory.addAIMessages(newApiMsgs, { source: 'triage', taskId })
              log.web.info('triage main agent done', { taskId, newMessages: newApiMsgs.length })
              triggerBackgroundCompaction('triage')
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              log.web.error('triage main agent failed', { taskId, error: errMsg })
              broadcastEvent('agent:error', { error: `Triage notify failed for task ${taskId}: ${errMsg}` })
              await chatHistory.addNotification({
                role: 'assistant',
                content: `**Triage Error** (${taskId}): ${errMsg}`,
                source: 'agent-error', notification: true,
              })
            }
          })
        } else {
          // ── UI-only path: no notify, store full triage analysis ──
          // notification: true → "UI Only" badge. Full content visible when expanded.
          const triageContent = `**Triage** (${displayTaskRef}):\n\n**Triage Analysis:**\n\n${cleanedResult}`
          await chatHistory.addNotification({
            role: 'assistant', content: triageContent,
            source: 'triage', notification: true, taskId,
            sessionId: runId,
            timestamp: triageTimestamp,
          })
          log.web.info('triage notification saved to chat (UI only)', { taskId, sessionId: runId })

          bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
            entry: { role: 'assistant', content: triageContent, source: 'triage', notification: true, taskId, sessionId: runId, timestamp: triageTimestamp },
          }, ['web-ui'])
        }

        // Safety net: if triage completed but task is still at AGENT_COMPLETE,
        // the triage failed to act (e.g. chose Outcome A without calling send_to_session,
        // or errored mid-execution). Fall back to AWAIT_HUMAN_ACTION so the user sees it.
        if (taskId) {
          setTimeout(async () => {
            try {
              const task = await getTask(taskId)
              if (task && task.phase === 'AGENT_COMPLETE') {
                const { updateTask } = await import('../core/task-manager.js')
                await updateTask(taskId, { phase: 'AWAIT_HUMAN_ACTION', needs_attention: true })
                log.web.warn('triage safety net: task still AGENT_COMPLETE after triage, falling back to AWAIT_HUMAN_ACTION', { taskId })
              }
            } catch (err) {
              log.web.warn('triage safety net error', { taskId, error: err instanceof Error ? err.message : String(err) })
            }
          }, 5000) // 5s delay: give send_to_session time to roll back phase to IN_PROGRESS
        }
      } else {
        // Non-triage subagent: persist full result as notification
        const usageStr = usage ? ` (${usage.input_tokens}+${usage.output_tokens} tokens)` : ''
        const notifContent = `**Subagent Result** (${agentName})${subagentTaskRef ? ` for task ${subagentTaskRef}` : ''}${usageStr}:\n\n${result.slice(0, 4000)}`
        const subagentTimestamp = new Date().toISOString()
        await chatHistory.addNotification({
          role: 'assistant', content: notifContent,
          source: 'subagent', notification: true, taskId,
          timestamp: subagentTimestamp,
        })

        // Push notification directly to browser
        bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
          entry: { role: 'assistant', content: notifContent, source: 'subagent', notification: true, taskId, timestamp: subagentTimestamp },
        }, ['web-ui'])
      }

      // Forward sanitized subagent:result to web-ui (without full result text)
      bus.emit(event.name, {
        runId, agentId, agentName, taskId, usage,
        isTriageResult,
        // Omit full result — browser gets compact notification via chat:history-updated
      }, ['web-ui'], { source: 'subagent' })
      return
    }

    // Persist subagent:error to chat history
    if (event.name === 'subagent:error') {
      const { agentId, taskId, error } = eventData<'subagent:error'>(event)
      const subErrTaskRef = taskId ? await resolveTaskRef(taskId) : null
      const content = `**Subagent Error**${agentId ? ` (${agentId})` : ''}${subErrTaskRef ? ` for task ${subErrTaskRef}` : ''}: ${error}`
      await chatHistory.addNotification({
        role: 'assistant', content,
        source: 'subagent', notification: true, taskId,
      })
    }
  })

  // -- Migrate legacy config to plugins format (before loading plugins) --
  try {
    const configMigrated = await migrateConfigToPlugins()
    if (configMigrated) log.web.info('legacy integration config migrated to plugins section')
  } catch (err) {
    log.web.error('config migration failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // -- Load integration plugins --
  try {
    await loadPlugins(registry)
    log.web.info('integration plugins loaded', { plugins: registry.getAll().map(p => p.id) })
  } catch (err) {
    log.web.error('failed to load integration plugins', { error: err instanceof Error ? err.message : String(err) })
  }

  // -- Run plugin data migrations (move legacy task fields to ext) --
  try {
    await runPluginMigrations(registry)
  } catch (err) {
    log.web.error('plugin data migrations failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // -- Start generic plugin sync polling --
  startPluginSyncPolling()

  // -- Process exit diagnostics --
  // Log WHY the server dies so we can diagnose silent crashes
  const exitLog = (reason: string, detail?: unknown) => {
    const msg = `SERVER EXIT: ${reason}`
    const meta = { pid: process.pid, uptime: process.uptime(), detail: detail instanceof Error ? detail.message : detail }
    log.web.error(msg, meta)
    console.error(`[${new Date().toISOString()}] ${msg}`, JSON.stringify(meta))
  }
  process.on('SIGTERM', () => { exitLog('SIGTERM (killed by another process)'); process.exit(143) })
  process.on('SIGHUP', () => { exitLog('SIGHUP (terminal closed or parent died)'); process.exit(129) })
  process.on('uncaughtException', (err) => { exitLog('uncaughtException', err); process.exit(1) })
  process.on('unhandledRejection', (reason) => { exitLog('unhandledRejection', reason) })
  process.on('beforeExit', (code) => { exitLog(`beforeExit code=${code}`) })
  process.on('exit', (code) => {
    // Sync-only: last chance to log (no async allowed)
    const msg = `[${new Date().toISOString()}] SERVER EXIT: code=${code} pid=${process.pid} uptime=${process.uptime()}s`
    try { require('node:fs').appendFileSync('/tmp/walnut-exit.log', msg + '\n') } catch { /* ignore */ }
  })

  // -- Start post-listen services (port already bound above) --
  cronService.start().catch((err) => {
    log.cron.error('failed to start cron service', { error: err instanceof Error ? err.message : String(err) })
  })

  // -- Start heartbeat runner (if enabled in config) --
  startHeartbeatIfConfigured().catch((err) => {
    log.heartbeat.error('failed to start heartbeat', { error: err instanceof Error ? err.message : String(err) })
  })

  return httpServer!
}

// ── Git auto-commit polling ──

const GIT_POLL_INTERVAL_MS = 30_000

function startGitAutoCommit(): { stop: () => void; health: GitAutoCommitHealth } {
  const health: GitAutoCommitHealth = { protected: false, consecutiveFailures: 0 }
  let notifiedForEpisode = false // only send chat notification once per failure episode
  let lockContentionCount = 0

  const emitStatus = () => {
    broadcastEvent('git-sync:status', health)
  }

  // Check git availability
  const repo = ensureRepo()
  if (!repo.available) {
    const msg = repo.error ?? 'git not available'
    console.error(`\u26A0 WARNING: data NOT protected \u2014 ${msg}`)
    log.git.warn('data not protected', { error: msg })
    health.error = msg
    emitStatus()
    return { stop() {}, health }
  }

  health.protected = true

  // Commit any leftover dirty state from a previous crash
  try {
    if (commitIfDirty()) {
      health.lastCommitAt = new Date().toISOString()
      log.git.info('committed leftover dirty state on startup')
    }
  } catch (err) {
    log.git.warn('startup commit failed', { error: String(err) })
  }

  // Pull remote if configured
  try { gitPullWalnut() } catch (err) {
    log.git.warn('startup git pull failed', { error: String(err) })
  }

  const timer = setInterval(() => {
    try {
      if (commitIfDirty()) {
        health.lastCommitAt = new Date().toISOString()
        health.consecutiveFailures = 0
        health.error = undefined
        notifiedForEpisode = false
        lockContentionCount = 0
        log.git.debug('auto-committed')
        emitStatus()
      }
    } catch (err) {
      if (isLockContention(err)) {
        // Lock contention is transient (e.g. orphaned server processes or concurrent git pull).
        // Don't count toward consecutive failures — the retry in commitIfDirty already tried once.
        lockContentionCount++
        log.git.debug('auto-commit skipped (lock contention)', { lockContentionCount })
        // If lock contention persists for 10+ cycles (~5 min), surface it in health state
        if (lockContentionCount >= 10 && lockContentionCount % 10 === 0) {
          health.error = 'persistent lock contention — check for orphaned server processes'
          log.git.warn(health.error, { lockContentionCount })
          emitStatus()
        }
      } else {
        lockContentionCount = 0
        health.consecutiveFailures++
        health.error = err instanceof Error ? err.message : String(err)
        log.git.warn('auto-commit failed', {
          error: health.error,
          consecutiveFailures: health.consecutiveFailures,
        })
        emitStatus()
        // Send a one-time chat notification when failures first reach the threshold
        if (health.consecutiveFailures >= 3 && !notifiedForEpisode) {
          const notifContent = `Data backup failing \u2014 git auto-commit has failed ${health.consecutiveFailures}+ times consecutively. Check logs: \`walnut logs -s git\``
          notifiedForEpisode = true
          chatHistory.addNotification({
            role: 'assistant',
            content: notifContent,
            source: 'agent-error',
            notification: true,
          }).then(() => {
            bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
              entry: { role: 'assistant', content: notifContent, source: 'agent-error', notification: true, timestamp: new Date().toISOString() },
            }, ['web-ui'])
          }).catch(() => {
            notifiedForEpisode = false // reset so next cycle retries
          })
        }
      }
    }
  }, GIT_POLL_INTERVAL_MS)

  log.git.info('git auto-commit started', { intervalMs: GIT_POLL_INTERVAL_MS })
  emitStatus()

  return {
    stop() {
      clearInterval(timer)
      // Final commit on shutdown
      try { commitIfDirty() } catch {}
    },
    health,
  }
}

/**
 * Start the heartbeat runner if enabled in config.
 * The heartbeat periodically wakes the AI agent to check HEARTBEAT.md
 * and decide whether anything needs the user's attention.
 */
async function startHeartbeatIfConfigured(): Promise<void> {
  const { getConfig } = await import('../core/config-manager.js')
  const config = await getConfig()

  if (!config.heartbeat?.enabled) {
    log.heartbeat.info('heartbeat disabled (set heartbeat.enabled: true in config.yaml)')
    return
  }

  heartbeatHandle = startHeartbeatRunner(
    config.heartbeat,
    {
      runAgentTurn: async (prompt) => {
        // Run heartbeat as a main-agent turn, serialized with chat and triage
        return enqueueMainAgentTurn('heartbeat', async () => {
          const { runAgentLoop } = await import('../agent/loop.js')
          const { estimateMessagesTokens } = await import('../core/daily-log.js')

          // Load chat history (fresh state after any preceding turn)
          const history = await chatHistory.getApiMessages()
          const historyTokens = estimateMessagesTokens(history)
          log.heartbeat.info('running heartbeat agent turn', {
            historyMessages: history.length,
            historyTokens: `~${Math.round(historyTokens / 1000)}K`,
          })

          const heartbeatUserContent = '[Heartbeat] Periodic self-check…'
          const heartbeatTs = new Date().toISOString()

          // Broadcast heartbeat as a user message so frontend shows it
          broadcastEvent('heartbeat:chat-message', {
            content: heartbeatUserContent,
            timestamp: heartbeatTs,
          })
          // Persist the heartbeat trigger as a user notification
          await chatHistory.addNotification({
            role: 'user',
            content: heartbeatUserContent,
            timestamp: heartbeatTs,
            source: 'heartbeat',
            notification: true,
          })

          const result = await runAgentLoop(prompt, history, {
            onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'heartbeat' }),
            onThinking: (text) => broadcastEvent('agent:thinking', { text }),
            onToolCall: (toolName, input, toolUseId) => broadcastEvent('agent:tool-call', { toolName, input, toolUseId }),
            onToolResult: (toolName, result, toolUseId) => broadcastEvent('agent:tool-result', { toolName, result, toolUseId }),
            onToolActivity: (activity) => broadcastEvent('agent:tool-activity', activity),
            // onText intentionally NOT provided — fires per text block per round.
            // agent:response is fired ONCE below after the loop completes (same
            // pattern as the chat handler in routes/chat.ts).
            onUsage: (usage) => {
              try {
                usageTracker.record({
                  source: 'heartbeat',
                  model: usage.model ?? 'unknown',
                  input_tokens: usage.input_tokens,
                  output_tokens: usage.output_tokens,
                  cache_creation_input_tokens: usage.cache_creation_input_tokens,
                  cache_read_input_tokens: usage.cache_read_input_tokens,
                })
              } catch { /* non-critical */ }
            },
          }, { source: 'heartbeat' })

          // Fire agent:response exactly once after loop completes
          const responseText = result.response ?? ''
          if (responseText) {
            broadcastEvent('agent:response', { text: responseText, source: 'heartbeat' })
          }

          // Persist agent response to chat history
          const newApiMsgs = result.messages.slice(history.length)

          // Check for HEARTBEAT_OK — if the AI says nothing needs attention,
          // persist a compact notification instead of full AI messages.
          const isSilent = isHeartbeatOk(responseText)

          if (isSilent) {
            // For silent heartbeats, persist a compact notification instead of full AI messages
            // to avoid bloating chat history with routine "all clear" responses
            await chatHistory.addNotification({
              role: 'assistant',
              content: '**Heartbeat** — all clear, nothing needs attention.',
              source: 'heartbeat',
              notification: true,
            })
          } else {
            // Substantive response — persist full AI messages with heartbeat source
            await chatHistory.addAIMessages(newApiMsgs, { source: 'heartbeat' })
          }

          // Trigger background compaction outside the turn queue
          triggerBackgroundCompaction('heartbeat')

          return responseText
        })
      },

      isQueueBusy: () => {
        const status = getQueueStatus()
        return status.active > 0
      },

      broadcastEvent,
    },
  )
}

/** Expose heartbeat handle for event-driven triggers from outside server.ts. */
export function getHeartbeatHandle(): HeartbeatRunnerHandle | null {
  return heartbeatHandle
}

/**
 * Run embedding reconciliation in the background (non-blocking).
 * Safe to call on startup — logs errors but never throws.
 */
function reconcileEmbeddingsBackground(): void {
  ;(async () => {
    try {
      const { reconcileAllEmbeddings } = await import('../core/embedding/pipeline.js')
      const result = await reconcileAllEmbeddings()

      // Update system health state
      systemHealth.embedding = {
        total: result.totalTasks,
        indexed: result.indexedTasks,
        unindexed: result.totalTasks - result.indexedTasks,
        ollamaAvailable: result.ollamaAvailable,
        lastReconcileAt: new Date().toISOString(),
      }

      // Broadcast to frontend if there are issues
      if (result.indexedTasks < result.totalTasks || !result.ollamaAvailable) {
        broadcastEvent('system:health', systemHealth)
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log.memory.warn('embedding reconciliation failed', { error: errMsg })

      systemHealth.embedding.ollamaAvailable = false
      systemHealth.embedding.lastError = errMsg
      systemHealth.embedding.lastReconcileAt = new Date().toISOString()
      broadcastEvent('system:health', systemHealth)
    }
  })()
}

/**
 * Start generic plugin sync polling.
 * Iterates all registered plugins (except 'local') and creates an interval timer
 * for each. Each tick: retry unsynced tasks, then call plugin.sync.syncPoll(ctx).
 */
function startPluginSyncPolling(): void {
  const plugins = registry.getAll().filter(p => p.id !== 'local')

  for (const plugin of plugins) {
    let syncing = false
    let consecutiveFailures = 0
    const intervalMs = (plugin.config.sync_interval_ms as number) ?? SYNC_INTERVAL_MS

    const timer = setInterval(async () => {
      if (syncing) return
      syncing = true
      try {
        const { listTasks, updateTaskRaw, addTaskFull, deleteTask, autoPushIfConfigured } = await import('../core/task-manager.js')
        const localTasks = await listTasks()

        // Step 1: Retry unsynced tasks (source matches plugin but no ext data yet)
        const unsynced = localTasks.filter(
          (t) => t.source === plugin.id && (!t.ext || !t.ext[plugin.id]) && t.status !== 'done',
        )
        for (const task of unsynced) {
          try {
            const ext = await plugin.sync.createTask(task)
            if (ext) {
              // ext is already scoped: { 'ms-todo': { id, list_id } } — spread to merge
              const mergedExt = { ...task.ext, ...ext as Record<string, unknown> }
              await updateTaskRaw(task.id, { ext: mergedExt } as any)
              Object.assign(task, { ext: mergedExt })
              bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: `${plugin.id}-sync` })
            }
          } catch (err) {
            log.web.debug(`${plugin.id} sync: retry push failed`, {
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        // Step 1.5: Retry tasks with sync_error that already have ext data
        // These are tasks that were created successfully but had a subsequent push failure
        const MAX_ERROR_RETRIES_PER_CYCLE = 5
        const errorRetries = localTasks.filter(
          (t) => t.source === plugin.id && t.sync_error && t.ext && t.ext[plugin.id] && t.status !== 'done',
        ).slice(0, MAX_ERROR_RETRIES_PER_CYCLE)
        for (const task of errorRetries) {
          try {
            await autoPushIfConfigured(task)
          } catch (err) {
            log.web.debug(`${plugin.id} sync: error retry push failed`, {
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        // Step 2: Build SyncPollContext and run delta pull
        const ctx: SyncPollContext = {
          getTasks: () => localTasks,
          updateTask: async (id, updates) => {
            // Clear stale sync_error when a remote pull successfully updates the task
            const existingTask = localTasks.find(t => t.id === id)
            const effectiveUpdates = (existingTask?.sync_error && !('sync_error' in updates))
              ? { ...updates, sync_error: undefined }
              : updates
            await updateTaskRaw(id, effectiveUpdates)
            const updatedTask = localTasks.find(t => t.id === id)
            if (updatedTask) {
              Object.assign(updatedTask, effectiveUpdates)
              bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: `${plugin.id}-sync` })
            }
            // Return updated task (or fetch fresh if not in local list)
            return updatedTask ?? await (await import('../core/task-manager.js')).getTask(id)
          },
          addTask: async (taskData) => {
            const task = await addTaskFull(taskData)
            bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: `${plugin.id}-sync` })
            return task
          },
          deleteTask: async (id) => {
            const { task } = await deleteTask(id)
            bus.emit(EventNames.TASK_DELETED, { task }, ['web-ui'], { source: `${plugin.id}-sync` })
          },
          emit: (event, data) => {
            bus.emit(event, data, ['web-ui'], { source: `${plugin.id}-sync` })
          },
        }

        // Call the plugin's syncPoll
        await plugin.sync.syncPoll(ctx)
        consecutiveFailures = 0
      } catch (err) {
        consecutiveFailures++
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (consecutiveFailures >= 5) {
          log.web.error(`${plugin.id} sync failing repeatedly`, { consecutiveFailures, error: errorMsg })
        } else {
          log.web.debug(`${plugin.id} sync failed`, { consecutiveFailures, error: errorMsg })
        }
      } finally {
        syncing = false
      }
    }, intervalMs)

    pluginSyncTimers.push(timer)
    log.web.info('started sync polling for plugin', { pluginId: plugin.id, intervalMs })
  }
}

/**
 * Gracefully shut down the server.
 */
export async function stopServer(): Promise<void> {
  if (heartbeatHandle) {
    heartbeatHandle.stop()
    heartbeatHandle = null
  }
  for (const timer of pluginSyncTimers) {
    clearInterval(timer)
  }
  pluginSyncTimers = []
  registry.clear()
  if (healthMonitor) {
    healthMonitor.stop()
    healthMonitor = null
  }
  if (cronServiceInstance) {
    cronServiceInstance.stop()
    setCronService(null)
    cronServiceInstance = null
  }
  // Destroy session hook dispatcher
  try {
    const { getSessionHookDispatcher, setSessionHookDispatcher } = await import('../core/session-hooks/index.js')
    const hookDispatcher = getSessionHookDispatcher()
    if (hookDispatcher) {
      hookDispatcher.destroy()
      setSessionHookDispatcher(null)
    }
  } catch {}
  subagentRunner.destroy()
  // Always detach — sessions are detached child processes and must survive
  // server shutdown. Never kill session PIDs from stopServer().
  sessionRunner.destroy()
  if (memoryWatcherHandle) {
    memoryWatcherHandle.stop()
    memoryWatcherHandle = null
  }
  if (gitAutoCommitHandle) {
    gitAutoCommitHandle.stop()
    gitAutoCommitHandle = null
  }
  bus.unsubscribe('web-ui')
  bus.unsubscribe('main-ai')
  bus.unsubscribe('heartbeat-config')
  bus.unsubscribe('embedding-sync')
  closeWss()

  if (httpServer) {
    return new Promise((resolve, reject) => {
      httpServer!.close((err) => {
        httpServer = null
        if (err) reject(err)
        else resolve()
      })
    })
  }
}
