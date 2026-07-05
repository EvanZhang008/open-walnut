/**
 * Express + WebSocket server entry point.
 *
 * Serves the REST API, proxies bus events to WebSocket clients,
 * and serves static files in production mode.
 */

import { createServer, type Server as HttpServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { Router } from 'express'
import cors from 'cors'
import compression from 'compression'
import { bus, EventNames, eventData } from '../core/event-bus.js'
import { attachWss, broadcastEvent, sendStreamEvent, closeWss } from './ws/handler.js'
import { sessionStreamBuffer } from './session-stream-buffer.js'
import { notFoundHandler, errorHandler } from './middleware/error-handler.js'
import { requestLogger } from './middleware/request-logger.js'
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
import { registerBrowserLogsRpc, browserLogsRouter } from './routes/browser-logs.js'
import { usageRouter } from './routes/usage.js'
import { imagesRouter } from './routes/images.js'
import { localImageRouter } from './routes/local-image.js'
import { fileContentRouter } from './routes/file-content.js'
import { filesRouter } from './routes/files.js'
import { createCronRouter, setCronService } from './routes/cron.js'
import { createAgentsRouter } from './routes/agents.js'
import { createConversationsRouter } from './routes/conversations.js'
import { createCommandsRouter } from './routes/commands.js'
import { createSkillsRouter } from './routes/skills.js'
import { createSlashCommandsRouter } from './routes/slash-commands.js'
import { timelineRouter } from './routes/timeline.js'
import { CronService } from '../core/cron/index.js'
import { CRON_FILE, IS_EPHEMERAL } from '../constants.js'
import { sessionRunner } from '../providers/claude-code-session.js'
import { SessionHealthMonitor } from '../core/session-health-monitor.js'
import { SessionReaper } from '../core/session-reaper.js'
import { subagentRunner } from '../providers/subagent-runner.js'
import { getTask, listTasks } from '../core/task-manager.js'
import type { Task } from '../core/types.js'
import { log } from '../logging/index.js'
import { usageTracker } from '../core/usage/index.js'
import * as chatHistory from '../core/chat-history.js'
import { gitPullWalnut, ensureRepo, commitIfDirty, isGitAvailable, isLockContention } from '../integrations/git-sync.js'
import { registry } from '../core/integration-registry.js'
import { loadPlugins, migrateConfigToPlugins, runPluginMigrations } from '../core/integration-loader.js'
import type { SyncPollContext } from '../core/integration-types.js'
import { syncReconciler } from '../core/sync-reconciler.js'
import { integrationsRouter } from './routes/integrations.js'
import { systemRouter } from './routes/system.js'
import { qmdRouter } from './routes/qmd.js'
import { notesRouter } from './routes/notes.js'
import { notesV2Router } from './routes/notes-v2.js'
import { repositoriesRouter } from './routes/repositories.js'
import { audioRouter } from './routes/audio.js'
import { sttRouter } from './routes/stt.js'
import { migrateGlobalNotes } from '../core/notes-migration.js'
import { authMiddleware } from './middleware/auth.js'
import { pushRouter } from './routes/push.js'
import { authRouter } from './routes/auth.js'
import { incidentsRouter } from './routes/incidents.js'
import { notificationsRouter } from './routes/notifications.js'
import { addNotification as addFeedNotification } from '../core/notifications/store.js'
import { registerAuthRpc } from './routes/auth-rpc.js'
import { initPushNotifications } from '../core/push-notification.js'
import { enqueueMainAgentTurn, getQueueStatus, recordLastTurnTokens, getLastTurnTokens } from './agent-turn-queue.js'
import { effectiveTotalTokens, ESTIMATE_CORRECTION } from '../core/token-truth.js'
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
// Self-rescheduling timers — one active timer per plugin, replaced on each tick.
// Stored as an array of stop-callbacks so stopServer() can cancel the in-flight one.
// Each stop() returns a Promise that resolves once any in-flight tick has settled,
// so stopServer() can `await` it and guarantee no plugin writes happen after shutdown.
let pluginSyncStops: Array<() => Promise<void>> = []
let cronServiceInstance: CronService | null = null
let healthMonitor: SessionHealthMonitor | null = null
let sessionReaper: SessionReaper | null = null
let heartbeatHandle: HeartbeatRunnerHandle | null = null
let recordingReaperHandle: { stop: () => void } | null = null
let terminalReaperHandle: { stop: () => void } | null = null
let qmdWatcherHandle: { stop: () => void } | null = null
let gitAutoCommitHandle: { stop: () => void; health: GitAutoCommitHealth } | null = null
let dreamTimerHandle: ReturnType<typeof setInterval> | null = null
let dreamInitialHandle: ReturnType<typeof setTimeout> | null = null
// Pending deferred-markDone timers from the session:status-changed handler.
// Hoisted to module scope so stopServer() can cancel them before teardown,
// otherwise a late-firing timer could mutate sessionStreamBuffer after the
// server has already stopped serving.
const deferredMarkDoneTimers: Set<ReturnType<typeof setTimeout>> = new Set()

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

// ── System health state ──

export interface SystemHealthState {
  daemons?: Array<{ host: string; label: string; connected: boolean }>;
  claudeCliAvailable: boolean;
  hasReadyProvider: boolean;
  /** Where the active Bedrock credential was resolved from (for the onboarding UI).
   *  Undefined until a health refresh runs; 'none' when nothing is configured. */
  credentialSource?: import('../core/credential-resolver.js').CredentialSource;
  /** Short human-readable provenance, e.g. "AWS_BEARER_TOKEN_BEDROCK" or "profile: dev". */
  credentialDetail?: string;
}

const systemHealth: SystemHealthState = {
  claudeCliAvailable: false,
  hasReadyProvider: false,
}

export function getSystemHealth(): SystemHealthState {
  return systemHealth
}

/** Re-run all health checks, update shared state, and broadcast to clients. */
export async function refreshSystemHealth(): Promise<SystemHealthState> {
  systemHealth.claudeCliAvailable = checkClaudeCliAvailable()
  const cred = await resolveCredentialHealth()
  systemHealth.hasReadyProvider = cred.hasReadyProvider
  systemHealth.credentialSource = cred.source
  systemHealth.credentialDetail = cred.detail
  broadcastEvent('system:health', systemHealth)
  return systemHealth
}

/** Check if Claude Code CLI is on the PATH. */
function checkClaudeCliAvailable(): boolean {
  try {
    execFileSync('which', ['claude'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Resolve provider readiness + where the Bedrock credential came from.
 *  Bedrock detection delegates to the unified credential resolver (config →
 *  ~/.claude/settings.json env → process.env → ~/.aws) so the Settings page,
 *  the butler, and onboarding all agree on one priority chain. Non-Bedrock
 *  providers count as ready when they carry an explicit key. */
async function resolveCredentialHealth(): Promise<{
  hasReadyProvider: boolean
  source?: import('../core/credential-resolver.js').CredentialSource
  detail?: string
}> {
  try {
    const { getConfig } = await import('../core/config-manager.js')
    const { resolveCredentials } = await import('../core/credential-resolver.js')
    const { buildProviderMap } = await import('../agent/providers/registry.js')
    const config = await getConfig()

    // Bedrock — the primary path for our audience.
    const cred = resolveCredentials(config)
    if (cred.source !== 'none') {
      return { hasReadyProvider: true, source: cred.source, detail: cred.detail }
    }

    // Other providers (Anthropic direct, OpenAI, Google) — ready if they have a key.
    const providers = buildProviderMap(config.providers, config)
    for (const [, prov] of Object.entries(providers)) {
      if (prov.api === 'bedrock' || prov.api === 'ollama') continue
      const implemented = prov.api === 'anthropic-messages'
        || prov.api === 'openai-chat' || prov.api === 'google-generative-ai'
      if (implemented && (prov.api_key || prov.bearer_token)) {
        return { hasReadyProvider: true, source: 'config', detail: prov.api }
      }
    }
    return { hasReadyProvider: false, source: 'none' }
  } catch {
    return { hasReadyProvider: false, source: 'none' }
  }
}

/**
 * Create and start the server.
 * Returns the running HTTP server instance.
 */
export async function startServer(options: ServerOptions = {}): Promise<HttpServer> {
  if (httpServer) throw new Error('Server already running. Call stopServer() first.')

  // Ensure ~/.open-walnut/ directory structure exists and seed config defaults
  const { initDirectories } = await import('../core/init.js')
  await initDirectories()

  // ── Setup health checks: Claude CLI + provider readiness ──
  systemHealth.claudeCliAvailable = checkClaudeCliAvailable()
  if (!systemHealth.claudeCliAvailable) {
    log.web.warn('Claude Code CLI not found on PATH — sessions will not work')
  }
  {
    const cred = await resolveCredentialHealth()
    systemHealth.hasReadyProvider = cred.hasReadyProvider
    systemHealth.credentialSource = cred.source
    systemHealth.credentialDetail = cred.detail
    if (!systemHealth.hasReadyProvider) {
      log.web.warn('No AI provider configured — configure one in Settings')
    } else if (cred.source && cred.source !== 'config') {
      log.web.info('Auto-detected Bedrock credential', { source: cred.source, detail: cred.detail })
    }
  }

  // Event-loop lag monitor — makes starvation visible (logs a warn whenever a
  // single tick is blocked > threshold, naming the suspect periodic task).
  // Cheap libuv histogram + self-timer; safe to run in production.
  const { startEventLoopMonitor } = await import('../core/event-loop-monitor.js')
  startEventLoopMonitor()

  // Migrate global-notes.md → notes/global.md (one-time, idempotent)
  await migrateGlobalNotes()

  // Recover orphaned user messages from a previous crash. Orphans land in an
  // agent's MAIN conversation (where interrupted/background turns persist), so
  // recover there explicitly instead of the retired legacy file.
  try {
    const { getMainConversationId } = await import('../core/conversations.js')
    const mainConvId = await getMainConversationId('general')
    await chatHistory.recoverOrphanedUserMessage('general', mainConvId)
  } catch (err) {
    log.web.warn('orphan recovery skipped', { error: err instanceof Error ? err.message : String(err) })
  }

  // Start local daemon for session management. All sessions (local + remote)
  // go through a daemon — local uses the daemon on this machine, remote uses
  // a daemon on the SSH target. Must be running before any createSessionManager().
  try {
    const { localDaemon } = await import('../providers/local-daemon.js')
    await localDaemon.ensureRunning()
    log.web.info('local daemon ready', { port: localDaemon.port })
  } catch (err) {
    log.web.error('failed to start local daemon — local sessions will fail', {
      error: err instanceof Error ? err.message : String(err),
    })
    // Don't throw — remote sessions may still work, and user can fix daemon issues
  }

  const port = options.port ?? DEFAULT_PORT
  const dev = options.dev ?? false
  const isEphemeral = IS_EPHEMERAL

  const app = express()

  // -- Middleware --
  app.use(cors())
  // gzip JSON/text responses. The list payloads (/api/tasks, /api/sessions,
  // /api/sessions/:id/history) are 2-8MB of highly-repetitive JSON and dominate
  // how long each response holds one of the browser's ~5 HTTP/1.1 lanes — the
  // lane-hold that drives the NS_BINDING_ABORTED abort cascade under the home
  // fan-out. compression cuts them ~8-12x on the wire. The 1KB threshold lets
  // trivial responses (/api/config, /api/system/health) skip compression so
  // they never pay encode CPU. Env-gated for instant revert.
  if (process.env.WALNUT_HTTP_COMPRESS !== '0') {
    app.use(compression({ threshold: 1024 }))
  }
  app.use(express.json({ limit: '15mb' }))
  // Auth middleware: localhost passthrough, remote requires Bearer token
  app.use('/api', authMiddleware)
  app.use('/api', requestLogger)

  // -- Cron service --
  const cronService = new CronService({
    storePath: CRON_FILE,
    cronEnabled: true,
    log: log.cron,
    broadcastCronNotification: async (text, jobName, opts) => {
      const timestamp = new Date().toISOString()
      // Numeric epoch ms shared by the WS event AND the feed dedupKey below. The
      // frontend builds its dedupKey from this same numeric value, so the live
      // toast and the server-persisted feed record collapse to ONE entry on
      // refresh. Do NOT key off the ISO `timestamp` here — the two representations
      // would differ and the feed would show the cron notification twice.
      const eventTs = Date.now()
      // Background events have no UI "tab" — they target the agent's stable MAIN
      // conversation (NOT activeConversationId, which is whatever the user last
      // clicked). This is the bug fix: previously these wrote the orphaned legacy
      // chat-history file (no conversationId) instead of the visible conversation.
      const { getMainConversationId } = await import('../core/conversations.js')
      const conversationId = await getMainConversationId('general')
      // Toast notification
      broadcastEvent('cron:notification', { text, jobName, timestamp: eventTs })
      // Persist to the durable notification feed (survives refresh). Fire-and-forget:
      // a slow disk must never block the cron callback. dedupKey + timestamp use
      // eventTs so they match the frontend's live event (see comment above).
      void addFeedNotification({
        kind: 'cron', severity: 'info', title: jobName, body: text, timestamp: eventTs,
        dedupKey: `cron:${jobName}:${eventTs}`,
      }).catch(err => log.cron.warn('failed to persist cron notification', { jobName, error: err instanceof Error ? err.message : String(err) }))
      // Chat message (for inline display)
      broadcastEvent('cron:chat-message', { content: text, jobName, timestamp, agentWillRespond: opts?.agentWillRespond ?? false, conversationId })
      // Persist notification to chat history (survives refresh)
      await chatHistory.addNotification({
        role: 'user', content: text, timestamp,
        source: 'cron', cronJobName: jobName,
        agentId: 'general', conversationId,
      })
    },
    queueCronNotificationForAgent: (text, jobName) => {
      pendingCronNotifications.push({ text, jobName, timestamp: Date.now() })
      log.cron.info('queued cron notification for next agent interaction', { jobName })
    },
    runMainAgentWithPrompt: async (prompt, jobName) => {
      // Enqueue into the main agent turn queue — serialized with chat and triage turns
      await enqueueMainAgentTurn(`cron:${jobName}`, async () => {
        // Background turn → general's stable MAIN conversation (see rationale in
        // broadcastCronNotification above).
        const { getMainConversationId } = await import('../core/conversations.js')
        const conversationId = await getMainConversationId('general')
        try {
          const { runAgentLoop } = await import('../agent/loop.js')
          const { estimateMessagesTokens } = await import('../core/daily-log.js')
          // Load history inside the queue (reads fresh state after any preceding turn)
          const history = await chatHistory.getApiMessages('general', conversationId)
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
              try { usageTracker.record({ source: 'cron', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, agentId: 'general' }) } catch {}
            },
          }, { source: 'cron', agentId: 'general', conversationId })
          // Fire agent:response exactly once after loop completes
          if (result.response) {
            broadcastEvent('agent:response', { text: result.response, source: 'cron' })
          }
          // Persist agent response to chat history. newMessages (not slice(history.length))
          // is trim-safe — see chat.ts. NB: pass the WHOLE array incl. the user prompt at [0];
          // unlike chat.ts we did NOT eager-persist the prompt, so it must be persisted here.
          const newApiMsgs = result.newMessages
          await chatHistory.addAIMessages(newApiMsgs, { source: 'cron', agentId: 'general', conversationId })
          log.cron.info('agent done', { jobName, newMessages: newApiMsgs.length })
          // Trigger background compaction outside the turn queue
          triggerBackgroundCompaction(`cron:${jobName}`, { agentId: 'general', conversationId })
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          log.cron.error('cron runMainAgentWithPrompt failed', { jobName, error: errMsg })
          // Broadcast error so the UI clears streaming state
          broadcastEvent('agent:error', { error: `Cron job "${jobName}" agent failed: ${errMsg}`, conversationId })
          // Persist error to chat history so it survives page refresh
          await chatHistory.addNotification({
            role: 'assistant',
            content: `**Cron Error** (${jobName}): ${errMsg}`,
            source: 'agent-error',
            notification: true,
            agentId: 'general', conversationId,
          })
          throw err // Re-throw so the cron system records the error status
        }
      })
    },
    runIsolatedAgentJob: async ({ job, message }) => {
      const { runAgentLoop } = await import('../agent/loop.js')
      const result = await runAgentLoop(message, [], {
        onUsage: (usage) => {
          try { usageTracker.record({ source: 'cron', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, agentId: 'general' }) } catch {}
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
            try { usageTracker.record({ source: 'subagent', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, agentId, parent_source: 'cron' }) } catch {}
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
    runExecutor: async (job, executor, message) => {
      const { runExecutor } = await import('../core/routines/index.js')
      return await runExecutor(job, executor, message)
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

  // ── Routines executor registry ──
  // main-agent / walnut-agent reuse the cron dep closures above (the cron
  // engine still dispatches those two through its legacy paths, which own the
  // notification/announce plumbing); claude-code is dispatched via runExecutor.
  {
    const { registerExecutor, createMainAgentExecutor, createWalnutAgentExecutor, createClaudeCodeExecutor } =
      await import('../core/routines/index.js')
    const cronDeps = cronService.getDeps()
    registerExecutor(createMainAgentExecutor({
      broadcastCronNotification: cronDeps.broadcastCronNotification,
      runMainAgentWithPrompt: cronDeps.runMainAgentWithPrompt,
      queueCronNotificationForAgent: cronDeps.queueCronNotificationForAgent,
    }))
    registerExecutor(createWalnutAgentExecutor({
      runIsolatedAgentJob: cronDeps.runIsolatedAgentJob,
    }))
    registerExecutor(createClaudeCodeExecutor())
  }

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
  // Routines (canonical) + legacy /api/cron alias — same router, same engine.
  const routinesRouter = createCronRouter(cronService)
  app.use('/api/routines', routinesRouter)
  app.use('/api/cron', routinesRouter)
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
  app.use('/api/file-content', fileContentRouter)
  app.use('/api/files', filesRouter)
  app.use('/api/agents', createAgentsRouter())
  // Conversations share the /api/agents prefix. Registered AFTER the agents
  // router; the agents router only matches single-segment ids (/:id), so the
  // deeper /:agentId/conversations paths fall through here without collision.
  app.use('/api/agents', createConversationsRouter())
  app.use('/api/commands', createCommandsRouter())
  app.use('/api/skills', createSkillsRouter())
  app.use('/api/slash-commands', createSlashCommandsRouter())
  app.use('/api/heartbeat', (await import('./routes/heartbeat.js')).heartbeatRouter)
  app.use('/api/timeline', timelineRouter)
  app.use('/api/notes', notesRouter)
  app.use('/api/notes-v2', notesV2Router)
  app.use('/api/repositories', repositoriesRouter)
  app.use('/api/integrations', integrationsRouter)

  // Plugin routes — mounted as a single router that gets populated after plugin loading.
  // This router sits before notFoundHandler, so plugin routes registered later still work.
  const pluginRouter = Router()
  app.use('/api/plugins', pluginRouter)

  app.use('/api/system', systemRouter)
  app.use('/api/qmd', qmdRouter)
  app.use('/api/push', pushRouter)
  app.use('/api/auth', authRouter)
  app.use('/api/browser-logs', browserLogsRouter)
  app.use('/api/audio', audioRouter)
  app.use('/api/stt', sttRouter)
  app.use('/api/incidents', incidentsRouter)
  app.use('/api/notifications', notificationsRouter)
  app.get('/api/task-phase-hooks', async (_req, res) => {
    const { getHookInfoList } = await import('../core/task-phase-hooks/index.js')
    res.json(getHookInfoList())
  })

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

  // -- Register RPC methods on the WebSocket handler --
  registerChatRpc()
  registerSessionChatRpc()

  // -- Embedded terminal (xterm.js + node-pty over dtach) --
  {
    const { registerTerminalRpc } = await import('./terminal/register.js')
    const { onClientDisconnect } = await import('./ws/handler.js')
    const { terminalManager } = await import('./terminal/terminal-manager.js')
    const enabled = await registerTerminalRpc()
    if (enabled) {
      onClientDisconnect((ws) => terminalManager.onClientDisconnect(ws))
      // Ephemeral/sandbox instances share the machine-global dtach socket dir
      // (/tmp/open-walnut-term) but have an isolated, empty session registry, so
      // letting them run the orphan sweep / periodic reaper would enumerate
      // PRODUCTION's sockets, find none in their own registry, and kill prod's
      // live terminals. Gate both behind !IS_EPHEMERAL (3457/ephemeral never
      // touches 3456/production).
      if (!IS_EPHEMERAL) {
        // Sweep leaked walnut-*.dsock dtach sessions whose backing session is gone.
        import('./terminal/dtach-lifecycle.js')
          .then(({ reapOrphanDtach }) => reapOrphanDtach())
          .catch((err) => log.web.warn('reapOrphanDtach failed', { error: String(err) }))
        // Periodic reaper: the startup sweep above only runs once, and a dtach
        // session kept past task-completion (foreground build) needs rechecking
        // after the build finishes. Run both checks on a timer (same pattern as
        // sessionReaper).
        const { terminalReaper } = await import('../core/terminal-reaper.js')
        terminalReaper.start()
        terminalReaperHandle = terminalReaper
      }
    }
  }

  // Reset working memory updater state on server startup to clear stale state
  {
    const { resetUpdaterState } = await import('../agent/working-memory-updater.js')
    resetUpdaterState()
  }

  // Reset QMD route state to clear stale downloading/indexing status from a previous run
  {
    const { resetQmdRouteState } = await import('./routes/qmd.js')
    resetQmdRouteState()
  }
  registerAuthRpc()
  registerBrowserLogsRpc()

  // -- Push notification service --
  initPushNotifications()

  // -- Forensic observability: register the incident sink so invariant violations
  //    at turn-completion become durable incidents (+ bundle + notification). The
  //    recorder + invariants are always active; this wires the heavy sink. Dynamic
  //    import keeps server boot resilient if the module is mid-build. --
  try {
    const { initIncidentSink } = await import('../core/observability/incidents.js')
    initIncidentSink()
  } catch (err) {
    log.web.warn('forensic observability incident sink not initialized', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Audio transcription service (auto-transcribes recorded chunks via STT) --
  {
    const { initAudioTranscriber } = await import('../core/audio-transcriber.js')
    initAudioTranscriber()
  }

  // -- Resume audio recording if it was active before restart --
  {
    const { audioCaptureService } = await import('../core/audio-capture.js')
    audioCaptureService.resume().catch((err) => {
      log.web.warn('audio recording resume failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }

  // -- Startup timing: track each phase to diagnose slow startups --
  const startupT0 = Date.now()
  const startupPhase = (name: string) => {
    const elapsed = Date.now() - startupT0
    log.web.info(`startup: ${name}`, { elapsedSinceListenMs: elapsed })
  }

  // -- Pull latest data from git (remote hooks may have pushed new data) --
  if (!isEphemeral) {
    await gitPullWalnut()
    startupPhase('git pull done')
  }

  // -- Prewarm task store: force load + migration before accepting requests --
  // Without this, early HTTP requests can hit an uninitialized store and return [].
  try {
    const tasks = await listTasks()
    startupPhase(`task store prewarmed (${tasks.length} tasks)`)
  } catch (err) {
    log.web.warn('task store prewarm failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // -- Reconcile zombie sessions + identify reconnectable ones --
  let reconnectable: import('../core/types.js').SessionRecord[] = []
  try {
    const { reconcileSessions } = await import('../core/session-reconciler.js')
    const result = await reconcileSessions()
    reconnectable = result.reconnectable
    startupPhase(`session reconcile done (${reconnectable.length} reconnectable)`)
  } catch (err) {
    log.session.warn('session reconciliation failed on startup', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Migrate stale sessions from completed tasks --
  try {
    const { migrateCompletedTaskSessions } = await import('../core/task-manager.js')
    await migrateCompletedTaskSessions()
    startupPhase('completed-task session migration done')
  } catch (err) {
    log.session.warn('completed-task session migration failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Clean up old stream files (preserve non-terminal sessions) --
  try {
    const { cleanupStreamFiles } = await import('../providers/claude-code-session.js')
    const { listSessions, isTerminalSession } = await import('../core/session-tracker.js')
    const allSessions = await listSessions()
    const preserveIds = new Set(
      allSessions
        .filter(s => !isTerminalSession(s))
        .map(s => s.claudeSessionId),
    )
    await cleanupStreamFiles(preserveIds)
    startupPhase('stream file cleanup done')
  } catch (err) {
    log.session.debug('stream file cleanup failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Prune old usage records --
  try { usageTracker.prune() } catch (e) { log.usage.warn('usage prune failed', { error: String(e) }) }

  // Working memory is now per-conversation and created lazily on first use
  // (see resolveWorkingMemoryPath). No global file is pre-created at startup —
  // doing so would resurrect the deprecated global file that migration retires.

  // -- Ensure dream directories + memory index exist --
  try {
    const { ensureDreamDirectories } = await import('../core/dream.js')
    ensureDreamDirectories()
  } catch (err) {
    log.memory.warn('dream directory init failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- QMD hybrid search stores --
  // Opt-out for lean/clean-room deployments (Docker onboarding test, CI) where the
  // ~1.16GB embedding model download is unwanted and search isn't exercised.
  if (process.env.WALNUT_DISABLE_SEARCH === '1') {
    log.memory.info('QMD search disabled via WALNUT_DISABLE_SEARCH=1 — skipping embedding model init')
  } else try {
    const { initQmdStores } = await import('../core/qmd-store.js')
    const { startQmdWatcher } = await import('../core/qmd-watcher.js')
    const { setQmdRouteStatus } = await import('./routes/qmd.js')
    // Non-blocking: init stores in background (update + embed can be slow)
    setQmdRouteStatus('indexing')
    initQmdStores()
      .then(() => { setQmdRouteStatus('ready') })
      .catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        setQmdRouteStatus('error', msg)
        log.memory.warn('QMD store init failed', { error: msg })
      })
    qmdWatcherHandle = startQmdWatcher()
    log.memory.info('QMD watcher started')

    // Delay the initial bulk QMD sync by 60s so startup doesn't starve the event loop
    // with a fs.stat storm across ~2600 tasks + all sessions. Incremental sync via
    // bus.subscribe('qmd-task-sync') / ('qmd-session-sync') continues to run normally
    // for live writes — this only defers the startup backfill.
    setTimeout(() => {
      Promise.all([
        import('../core/qmd-task-sync.js').then(m => m.syncAllTasks()),
        import('../core/qmd-session-sync.js').then(m => m.syncAllSessions()),
      ]).then(() => {
        log.memory.info('Task + session QMD sync complete')
      }).catch(err => {
        log.memory.warn('Task/session QMD sync failed', { error: err instanceof Error ? err.message : String(err) })
      })
    }, 60_000)

    // ── Incremental QMD sync via event bus (debounced) ──
    // Collect changed task/session IDs in Sets, flush after 2s idle.
    // embed() is called once per flush (not per event) to avoid thrashing.
    {
      const pendingTaskIds = new Set<string>();
      const pendingDeletedTaskIds = new Set<string>();
      const pendingSessionIds = new Set<string>();
      let taskFlushTimer: ReturnType<typeof setTimeout> | null = null;
      let sessionFlushTimer: ReturnType<typeof setTimeout> | null = null;
      const DEBOUNCE_MS = 2000;

      async function flushTasks(): Promise<void> {
        taskFlushTimer = null;
        const toSync = [...pendingTaskIds];
        const toDelete = [...pendingDeletedTaskIds];
        pendingTaskIds.clear();
        pendingDeletedTaskIds.clear();
        if (toSync.length === 0 && toDelete.length === 0) return;
        try {
          const { syncTask, removeTask, flushTaskEmbeddings } = await import('../core/qmd-task-sync.js');
          const { getTask } = await import('../core/task-manager.js');
          for (const id of toDelete) {
            await removeTask(id).catch(() => {});
          }
          for (const id of toSync) {
            try {
              const task = await getTask(id);
              await syncTask(task);
            } catch { /* task may have been deleted between event and flush */ }
          }
          await flushTaskEmbeddings();
          log.memory.info('QMD incremental task sync', { synced: toSync.length, deleted: toDelete.length });
        } catch (err) {
          log.memory.warn('QMD incremental task sync failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      async function flushSessions(): Promise<void> {
        sessionFlushTimer = null;
        const toSync = [...pendingSessionIds];
        pendingSessionIds.clear();
        if (toSync.length === 0) return;
        try {
          const { syncSession, flushSessionEmbeddings } = await import('../core/qmd-session-sync.js');
          const { getSessionByClaudeId } = await import('../core/session-tracker.js');
          for (const id of toSync) {
            try {
              const session = await getSessionByClaudeId(id);
              if (session) await syncSession(session);
            } catch { /* session may have been removed */ }
          }
          await flushSessionEmbeddings();
          log.memory.info('QMD incremental session sync', { synced: toSync.length });
        } catch (err) {
          log.memory.warn('QMD incremental session sync failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      function scheduleTaskFlush(): void {
        if (taskFlushTimer) clearTimeout(taskFlushTimer);
        taskFlushTimer = setTimeout(() => { flushTasks().catch(() => {}) }, DEBOUNCE_MS);
      }

      function scheduleSessionFlush(): void {
        if (sessionFlushTimer) clearTimeout(sessionFlushTimer);
        sessionFlushTimer = setTimeout(() => { flushSessions().catch(() => {}) }, DEBOUNCE_MS);
      }

      bus.subscribe('qmd-task-sync', (event) => {
        if (event.name === EventNames.TASK_CREATED || event.name === EventNames.TASK_UPDATED || event.name === EventNames.TASK_COMPLETED) {
          const taskId = (event.data as { task?: { id?: string } })?.task?.id;
          if (taskId) {
            pendingTaskIds.add(taskId);
            scheduleTaskFlush();
          }
        } else if (event.name === EventNames.TASK_DELETED) {
          const taskId = (event.data as { task?: { id?: string } })?.task?.id;
          if (taskId) {
            pendingDeletedTaskIds.add(taskId);
            pendingTaskIds.delete(taskId);
            scheduleTaskFlush();
          }
        }
        // interest below keeps this off the high-frequency streaming fan-out
      }, { global: true, interest: ['task:created', 'task:updated', 'task:completed', 'task:deleted'] })

      bus.subscribe('qmd-session-sync', (event) => {
        if (event.name === EventNames.SESSION_STARTED || event.name === EventNames.SESSION_RESULT
          || event.name === EventNames.SESSION_ERROR || event.name === EventNames.SESSION_STATUS_CHANGED) {
          const sessionId = (event.data as { sessionId?: string })?.sessionId;
          if (sessionId) {
            pendingSessionIds.add(sessionId);
            scheduleSessionFlush();
          }
        }
      }, { global: true, interest: ['session:started', 'session:result', 'session:error', 'session:status-changed'] })
    }
  } catch (err) {
    log.memory.warn('QMD startup failed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Git auto-commit polling (30s interval) --
  // Skip for ephemeral servers — they use a temp copy of data, no need to backup
  if (!isEphemeral) {
    gitAutoCommitHandle = startGitAutoCommit()

    // Recover from any crashed compaction, then schedule if due
    const { recoverFromCrashedCompaction, runScheduledCompaction } = await import('../integrations/git-compaction.js')
    recoverFromCrashedCompaction()
    // Run compaction 60s after startup (low priority, non-blocking)
    setTimeout(() => {
      try {
        const result = runScheduledCompaction()
        if (result && !result.skipped) {
          log.git.info('git compaction complete', { before: result.before, after: result.after })
        }
      } catch (err) {
        log.git.warn('git compaction failed', { error: err instanceof Error ? err.message : String(err) })
      }
    }, 60_000)
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
  startupPhase('health monitor started')

  // -- Start session reaper (periodic cleanup of high-volume triage session records) --
  sessionReaper = new SessionReaper()
  sessionReaper.start()

  // -- Start recording reaper (periodic cleanup of old audio recordings) --
  {
    const { recordingReaper } = await import('../core/recording-reaper.js')
    recordingReaper.start()
    recordingReaperHandle = recordingReaper
  }

  // -- Wire bus subscriber to push events to WS clients --
  bus.subscribe('web-ui', (event) => {
    broadcastEvent(event.name, event.data)
  })

  // -- Wire daemon connection status changes to broadcast to frontend --
  // Root cause: the initial GET /api/system/health returns a daemons[] array, but no
  // subsequent WebSocket events were ever emitted when connection state changed, so the
  // frontend's daemon status stayed permanently stale after the first load.  This wires
  // every DaemonConnection state-change into a system:health broadcast so the UI reflects
  // live connected/disconnected transitions without a page reload.
  {
    const { setOnDaemonStatusChange, getDaemonPoolStatus } = await import('../providers/daemon-connection.js')
    const { getConfig } = await import('../core/config-manager.js')
    setOnDaemonStatusChange(async () => {
      try {
        const config = await getConfig()
        const hosts = config.hosts
        if (!hosts || Object.keys(hosts).length === 0) return

        const activeMap = new Map(getDaemonPoolStatus().map(d => [d.host, d]))
        const daemons = Object.entries(hosts).map(([key, def]) => ({
          host: key,
          label: def.label ?? def.hostname,
          connected: activeMap.get(key)?.connected ?? false,
        }))

        // Persist daemons onto systemHealth so all subsequent broadcasts include it.
        systemHealth.daemons = daemons
        broadcastEvent('system:health', systemHealth)
      } catch { /* config not ready yet */ }
    })
  }

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
  }, { global: true, interest: ['task:completed'] })

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

  // -- Re-check provider readiness when config changes (e.g. user adds API key in Settings) --
  bus.subscribe('setup-health', async (event) => {
    if (event.name !== EventNames.CONFIG_CHANGED) return
    try {
      const prev = systemHealth.hasReadyProvider
      const prevSource = systemHealth.credentialSource
      const cred = await resolveCredentialHealth()
      systemHealth.hasReadyProvider = cred.hasReadyProvider
      systemHealth.credentialSource = cred.source
      systemHealth.credentialDetail = cred.detail
      if (cred.hasReadyProvider !== prev || cred.source !== prevSource) {
        broadcastEvent('system:health', systemHealth)
      }
    } catch { /* non-critical */ }
  })

  // Last-markStreaming timestamp per sessionId — used to suppress stale
  // session:status-changed{idle|stopped|error} events from old transports that
  // race with a just-started new turn. Without this guard, the 22ms window we
  // observed between markStreaming(new turn) and markDone(old transport's
  // flush) can flip the server-side buffer's isStreaming off and cause a
  // downstream RPC snapshot to return isStreaming=false mid-live-turn.
  //
  // Cleaned up at terminal lifecycle events (session:result/error below) so the
  // map cannot grow unbounded across long-lived servers with many sessions.
  const lastMarkStreamingAt = new Map<string, number>()
  // 500ms: 25× the observed ~20ms race window (markStreaming → markDone within
  // 18-24ms during remote session resume). Tight enough that real terminations
  // aren't held up noticeably; loose enough to absorb DB-write lag from
  // session-tracker.ts persisting status changes asynchronously.
  const MARK_DONE_DEDUP_MS = 500

  // Dedup window for delivery-failure chat notifications. During an SSH outage
  // each send fast-fails (~400ms against the connection failure cache); without
  // dedup every failure persisted a permanent red box to the main chat
  // (150+ during the 2026-06-10 incident). One notification per session per
  // window is enough — the per-message state lives on the optimistic messages
  // (failed + Retry) in the session panel.
  const deliveryFailureNotifiedAt = new Map<string, number>()
  const DELIVERY_FAILURE_NOTIFY_WINDOW_MS = 5 * 60_000

  // Sessions already checked for the "streaming ⇒ not awaiting human" invariant in
  // the CURRENT streaming run. Throttles the per-delta phase check to ONE getTask
  // per turn (deltas are high-frequency). Cleared when the run ends (markDone /
  // session:result / session:error) so the next turn re-checks. See the
  // session:text-delta handler below for why this lives on the delta path.
  const streamingPhaseChecked = new Set<string>()

  // Enforce the invariant "a session producing real output cannot be
  // AWAIT_HUMAN_ACTION" at the SOLE point every streaming turn must pass through:
  // the text/thinking delta. The discrete session:status-changed{running} signal
  // MISSES pure-text turns — claude-code-session.ts emits text-delta WITHOUT an
  // accompanying emitStatusChanged('IN_PROGRESS') (only init / ExitPlanMode / mode
  // changes emit that), so a task left stuck at AWAIT_HUMAN_ACTION by a transient
  // session:error never gets corrected while the agent visibly streams text. A
  // real delta is ground truth that the CLI is producing output right now (replay
  // is deduped upstream via _emittedStreamKeys, so this only fires on live output).
  // sessionStreamingPhase() only touches AWAIT_HUMAN_ACTION → a genuinely
  // human-paused task is never disturbed unless output actually resumes.
  const enforceStreamingPhase = (sessionId: string, taskId?: string): void => {
    if (!taskId || streamingPhaseChecked.has(sessionId)) return
    streamingPhaseChecked.add(sessionId)
    void (async () => {
      try {
        const { applySessionPhase } = await import('../core/phase.js')
        await applySessionPhase(taskId, 'session:streaming', 'server.ts:stream-delta', { sessionId })
      } catch (err) {
        log.web.warn('failed to apply session:streaming phase from delta', { taskId, sessionId, error: String(err) })
      }
    })()
  }

  // deferredMarkDoneTimers lives at module scope (above) so stopServer() can
  // cancel it during teardown. No per-startServer reset needed: entries
  // always self-remove in their own callback (line in handler below).

  // -- Main AI triage: process session results with AI judgment --
  // All session events now route through main-ai first; forward to web-ui for display.
  // NO `interest` filter here ON PURPOSE: main-ai is the SOLE path streaming reaches the
  // browser (session:text-delta → sessionStreamBuffer → sendStreamEvent → ws broadcast),
  // so it must receive EVERY event including high-frequency deltas. Adding an interest
  // array here would silently break real-time streaming. Per-event cost is cheap
  // (in-memory append + ws send). The interest optimization targets the OTHER global
  // subscribers that would only early-return on these deltas anyway.
  bus.subscribe('main-ai', async (event) => {
    // ── Streaming events: buffer server-side + broadcast to all clients (filtered client-side) ──
    if (event.name === 'session:text-delta') {
      const { sessionId, taskId, delta } = eventData<'session:text-delta'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendTextDelta(sessionId, delta)
        sendStreamEvent(sessionId, event.name, event.data)
        enforceStreamingPhase(sessionId, taskId)
      }
    } else if (event.name === 'session:tool-use') {
      const { sessionId, toolName, toolUseId, input, planContent, parentToolUseId } = eventData<'session:tool-use'>(event)
      if (sessionId) {
        // DUP-DEBUG: server.ts is the choke point between bus.emit and SSE
        // fan-out. If the same toolUseId reaches this branch twice, the
        // duplication originates at or before bus.emit (= claude-code-session
        // / RSM / daemon). If it arrives once but the UI still shows two,
        // duplication is in stream buffer or frontend.
        log.ws.debug('server: session:tool-use received', {
          sessionId, toolUseId, toolName, parentToolUseId,
        })
        sessionStreamBuffer.appendToolUse(sessionId, toolUseId, toolName, input, planContent, parentToolUseId)
        sendStreamEvent(sessionId, event.name, event.data)
        enforceStreamingPhase(sessionId, eventData<'session:tool-use'>(event).taskId)
      }
    } else if (event.name === 'session:tool-result') {
      const { sessionId, toolUseId, result } = eventData<'session:tool-result'>(event)
      if (sessionId) {
        log.ws.debug('server: session:tool-result received', {
          sessionId, toolUseId,
        })
        sessionStreamBuffer.appendToolResult(sessionId, toolUseId, result)
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:system-event') {
      const { sessionId, variant, message, detail } = eventData<'session:system-event'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendSystem(sessionId, variant, message, detail)
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:background-tasks') {
      // Dynamic-workflow / background-subagent progress snapshot → forward to the UI
      // so it can render the live workflow-progress panel. No stream-buffer append
      // (it's a live snapshot, not part of the replayable transcript).
      const { sessionId } = eventData<'session:background-tasks'>(event)
      if (sessionId) {
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:thinking-delta') {
      const { sessionId, taskId, delta } = eventData<'session:thinking-delta'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendThinkingDelta(sessionId, delta)
        sendStreamEvent(sessionId, event.name, event.data)
        enforceStreamingPhase(sessionId, taskId)
      }
    } else if (event.name === 'session:unknown-event') {
      const { sessionId, scope, eventType, snippet } = eventData<'session:unknown-event'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendSystem(
          sessionId,
          'info',
          `Unknown Claude event: ${scope}:${eventType}`,
          snippet,
        )
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:permission-request') {
      const { sessionId, requestId, toolName, input, reason } = event.data as {
        sessionId?: string; requestId?: string; toolName?: string;
        input?: Record<string, unknown>; reason?: string;
      }
      if (sessionId) {
        // Buffer the permission block so stream-subscribe snapshots include it
        if (requestId && toolName) {
          sessionStreamBuffer.appendPermission(sessionId, requestId, toolName, input, reason)
        }
        sendStreamEvent(sessionId, event.name, event.data)
        // Persist to the durable notification feed (survives refresh). Fire-and-forget;
        // de-duped by requestId so the 60s permission re-ask never doubles the feed.
        if (requestId && toolName) {
          void addFeedNotification({
            kind: 'permission', severity: 'warning', title: toolName,
            body: 'Session needs permission approval', sessionId,
            dedupKey: `perm:${requestId}`,
          }).catch(err => log.web.warn('failed to persist permission notification', { sessionId, error: err instanceof Error ? err.message : String(err) }))
        }
      }
    } else if (event.name === 'session:permission-resolved') {
      const { sessionId, requestId, allowed } = event.data as {
        sessionId?: string; requestId?: string; allowed?: boolean;
      }
      if (sessionId) {
        // Update the buffered permission block status
        if (requestId) {
          sessionStreamBuffer.resolvePermission(sessionId, requestId, allowed ? 'allowed' : 'denied')
        }
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:usage-update') {
      const { sessionId } = eventData<'session:usage-update'>(event)
      if (sessionId) {
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:team-info' || event.name === 'session:team-agent-delta') {
      // Team events: broadcast to all clients (frontend filters by sessionId)
      broadcastEvent(event.name, event.data)
    }

    // ── Non-streaming events: broadcast to all clients (low-frequency, needed everywhere) ──
    // Skip session:result from embedded subagents — they are handled via subagent:result below
    // (forwarding them here would send the full result to browsers, bypassing compact triage logic)
    const isSubagentSessionResult = (event.name === 'session:result' || event.name === 'session:error')
      && event.source === 'subagent-runner'
    // ── Routing asymmetry ──
    // session:status-changed uses destinations ['*'] → web-ui receives it directly, no re-emit needed.
    // session:result / session:error use ['main-ai', 'session-runner'] → web-ui does NOT receive them
    // directly; we re-emit below with enrichment (taskTitle, taskProject, taskCategory).
    // INVARIANT: All session:status-changed emitters MUST use ['*'] destinations.
    if (!isSubagentSessionResult && (
      event.name === 'session:started' || event.name === 'session:result' || event.name === 'session:error'
      || event.name === 'session:batch-completed' || event.name === 'session:batch-failed'
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

      // Clear stream buffer + team pollers after session ends.
      // Skip delivery_failed: no turn ran or ended — clearing would wipe the
      // previous turn's blocks the user may be viewing, and the session stays valid.
      const isDeliveryFailedEvt = event.name === 'session:error'
        && (event.data as { errorKind?: string }).errorKind === 'delivery_failed'
      if ((event.name === 'session:result' || event.name === 'session:error') && !isDeliveryFailedEvt) {
        const sid = eventData<'session:result'>(event).sessionId
        if (sid) {
          sessionStreamBuffer.markDone(sid)
          // Release dedup-timestamp entry so lastMarkStreamingAt cannot grow
          // unbounded across long-lived servers. (Handled here, not only in the
          // status-changed 'stopped'/'error' branch, because session:result is
          // the primary end-of-turn signal and fires even when the session
          // stays 'running' for a subsequent turn.)
          lastMarkStreamingAt.delete(sid)
          // Turn ended → re-arm the streaming-phase check for the NEXT turn.
          streamingPhaseChecked.delete(sid)
          setTimeout(() => sessionStreamBuffer.clear(sid), 2000)
          // Cleanup team poller for this session
          import('./routes/session-chat.js').then(({ cleanupTeamPoller }) => {
            cleanupTeamPoller(sid)
          }).catch(() => {})
        }
      }

    }

    // Belt-and-suspenders: clean up stream buffer on terminal status-changed.
    // session:result/session:error is the primary cleanup path, but sessions can
    // terminate without emitting those events (health-monitor idle_timeout, kill,
    // server restart, process crash). session:status-changed with ['*'] destinations
    // always fires for ANY termination path, so use it as a fallback.
    //
    // Must live OUTSIDE the outer `if (!isSubagentSessionResult && (...))` guard:
    // that guard whitelists only started/result/error/batch-completed/message-queued/
    // messages-delivered and would silently skip status-changed events (the original
    // bug that left `isStreaming=true` in the buffer after health-monitor timeout →
    // stale snapshot on client reload → stuck Streaming badge).
    //
    // 'idle' = FIFO between turns (process alive, not streaming) → markDone only,
    //   keep blocks for cross-turn viewing.
    // 'stopped'/'error' = process terminated → markDone + clear.
    // markDone + clear are idempotent → safe even if result path already cleaned up.
    if (event.name === 'session:status-changed') {
      const { sessionId: sid, process_status: ps, taskId: statusTaskId } = event.data as { sessionId?: string; process_status?: string; taskId?: string }
      if (sid) {
        // Turn boundary → re-arm the per-turn streaming-phase check. 'running'
        // means a (new) turn is starting, anything else means it ended; either
        // way the next real delta should re-verify the invariant. (Mirrors the
        // session:result/error re-arm above for the status-changed cleanup path.)
        streamingPhaseChecked.delete(sid)
        // This handler is the single authority for the streaming flag:
        //   - running  → markStreaming  (sole "on"-path; see session-stream-buffer.ts
        //                for Root Cause 5 explanation of why data events never flip it)
        //   - idle     → markDone       (FIFO between turns; keep blocks for cross-turn view)
        //   - stopped  → markDone + clear
        //   - error    → markDone + clear
        // markDone/clear are idempotent; safe even if session:result already cleaned up above.
        // Asymmetric handling of running vs stopped/error is intentional:
        // - 'running' applies markStreaming immediately because it's the sole
        //   on-path (see session-stream-buffer.ts) and must race-win against
        //   any stale in-flight stopped/error events.
        // - 'stopped'/'error' defer within the dedup window because during
        //   remote session resume the daemon may emit a brief stopped→running
        //   flicker as the old transport flushes; applying markDone eagerly
        //   would clobber the fresh stream (the exact bug this handler fixes).
        if (ps === 'running') {
          sessionStreamBuffer.markStreaming(sid)
          lastMarkStreamingAt.set(sid, Date.now())
          // Invariant: a streaming session can't be "awaiting human action".
          // Undo a stale AWAIT_HUMAN_ACTION left by a transient/late session:error
          // that lost the race against recovery (e.g. clean turn-end at send-time
          // → --resume recovered the session, but the bogus error flipped phase).
          // sessionStreamingPhase() only touches AWAIT_HUMAN_ACTION, so a session
          // a human genuinely paused is unaffected until output actually resumes.
          //
          // Only correct on a genuine session-runner streaming signal —
          // daemon-reconnect also emits process_status:'running' for non-idle
          // sessions on tunnel flap, which is a reconciliation artifact, not real
          // output; correcting there would wrongly clear an await_human a human is
          // waiting on.
          if (statusTaskId && event.source === 'session-runner') {
            void (async () => {
              try {
                const { applySessionPhase } = await import('../core/phase.js')
                await applySessionPhase(statusTaskId, 'session:streaming', 'server.ts:session-streaming', { sessionId: sid })
              } catch (err) {
                log.web.warn('failed to apply session:streaming phase', { taskId: statusTaskId, sessionId: sid, error: String(err) })
              }
            })()
          }
        } else if (ps === 'stopped' || ps === 'error') {
          const lastRun = lastMarkStreamingAt.get(sid)
          const ageMs = lastRun != null ? Date.now() - lastRun : Infinity
          if (ageMs < MARK_DONE_DEDUP_MS) {
            log.ws.info('markDone deferred (stale stopped/error within dedup window)', {
              sessionId: sid, ageMs, dedupMs: MARK_DONE_DEDUP_MS, process_status: ps,
            })
            // Re-read the DB after the window, not the in-memory map: the map
            // only tracks WHEN markStreaming fired, not WHETHER the session
            // truly recovered. The session record is authoritative.
            const timer = setTimeout(() => {
              deferredMarkDoneTimers.delete(timer)
              void (async () => {
                try {
                  const { getSessionByClaudeId } = await import('../core/session-tracker.js')
                  const rec = await getSessionByClaudeId(sid)
                  if (rec?.process_status === 'stopped' || rec?.process_status === 'error') {
                    sessionStreamBuffer.markDone(sid)
                    sessionStreamBuffer.clear(sid)
                    lastMarkStreamingAt.delete(sid)
                    log.ws.info('markDone applied after deferral (session is truly terminal)', {
                      sessionId: sid, process_status: rec.process_status,
                    })
                  } else {
                    log.ws.info('markDone skipped after deferral (session recovered)', {
                      sessionId: sid, process_status: rec?.process_status,
                    })
                  }
                } catch (err) {
                  log.ws.warn('deferred markDone check failed', {
                    sessionId: sid, error: err instanceof Error ? err.message : String(err),
                  })
                }
              })()
            }, MARK_DONE_DEDUP_MS)
            deferredMarkDoneTimers.add(timer)
          } else {
            sessionStreamBuffer.markDone(sid)
            sessionStreamBuffer.clear(sid)
            lastMarkStreamingAt.delete(sid)
          }
        } else if (ps === 'idle') {
          // Dedup: if the session just went 'running' (<MARK_DONE_DEDUP_MS ago),
          // this 'idle' is almost certainly an old-transport flush racing with
          // the new turn. Ignore it — the real end-of-turn will fire via
          // session:result or a later status-changed.
          const lastRun = lastMarkStreamingAt.get(sid)
          if (lastRun != null && Date.now() - lastRun < MARK_DONE_DEDUP_MS) {
            log.ws.info('markDone suppressed (stale idle within dedup window)', {
              sessionId: sid, ageMs: Date.now() - lastRun, dedupMs: MARK_DONE_DEDUP_MS,
            })
          } else {
            sessionStreamBuffer.markDone(sid)
          }
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

      const { sessionId, taskId, result, isError, totalCost, costDelta, duration } = eventData<'session:result'>(event)
      log.web.info('session result received', { sessionId, taskId, resultLength: result?.length ?? 0 })

      // Record session cost (external Claude Code CLI process).
      // Bill the per-result INCREMENT (costDelta), never the cumulative totalCost:
      // the CLI's total_cost_usd is a running total for the current process, so
      // recording it every turn re-charged the entire history each turn (the 13×
      // inflated "$222K" session cost). costDelta is already net of the per-process
      // watermark and is 0 for replayed events. If costDelta is absent (legacy
      // daemon payload), skip billing rather than fall back to totalCost and
      // reintroduce the bug — a missed increment is far cheaper than a 13× overcount.
      if (costDelta != null && costDelta > 0) {
        try { usageTracker.record({
          source: 'session',
          model: 'claude-code-cli',
          sessionId,
          taskId,
          external_cost_usd: costDelta,
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
        // Background notification → general's stable MAIN conversation.
        const { getMainConversationId } = await import('../core/conversations.js')
        const conversationId = await getMainConversationId('general')
        await chatHistory.addNotification({
          role: 'assistant', content,
          source: isError ? 'session-error' : 'session',
          notification: true, taskId,
          agentId: 'general', conversationId,
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
          // Phase sync: session error → AWAIT_HUMAN_ACTION
          try {
            const { applySessionPhase } = await import('../core/phase.js')
            await applySessionPhase(taskId, 'session:error', 'server.ts:session-result-error', { sessionId })
          } catch (err) { log.web.warn('failed to apply session:error phase', { taskId, error: String(err) }) }
        }
        // Emit session:ended so the Sessions page refreshes
        log.web.info('session ended event emitted', { sessionId, taskId })
        bus.emit(EventNames.SESSION_ENDED, { sessionId, taskId }, ['web-ui'], { source: 'session-result' })
        return
      }

      // Team mode OR active background workflow: intermediate results should not
      // trigger AGENT_COMPLETE or triage. (Reuse the `teamActive` var name to thread
      // through the existing guards below — semantics widened to "background work live".)
      const teamActive = (event.data as Record<string, unknown>)?.teamActive === true
        || (event.data as Record<string, unknown>)?.backgroundActive === true

      try {
        // Session record update is handled by session-runner (claude-code-session.ts)
        // which correctly sets idle vs stopped based on FIFO process liveness.
        // server.ts must NOT overwrite process_status — it lacks process state info.

        // Do NOT clear session slot here — turn_completed means the session
        // can still be resumed via session_send. The slot stays linked so the
        // UI shows which tasks have sessions. Slots are cleared only when:
        //   1. Task phase reaches COMPLETE (user sets via PhasePicker)
        //   2. process_status transitions to 'error' (handled above in isError branch)

        // Phase transition: session result → AGENT_COMPLETE.
        // Skip when teamActive — the lead session is still coordinating in-process
        // teammates (Claude Code team mode). Intermediate results should NOT move
        // the task to AGENT_COMPLETE or trigger triage. The final result (after
        // TeamDelete) will go through the normal path.
        if (!teamActive) {
          try {
            const { applySessionPhase } = await import('../core/phase.js')
            await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', { sessionId })
          } catch (err) {
            log.web.warn('failed to apply session:result phase', { taskId, error: String(err) })
          }
        } else {
          log.web.info('team active — skipping AGENT_COMPLETE phase transition', { sessionId, taskId })
        }

        // Triage dispatch is now handled by SessionHookDispatcher
        // (onTurnComplete hook) — no hardcoded triage here.
        // When teamActive, dispatcher also skips onTurnComplete (see dispatcher.ts).
      } catch (err) {
        log.web.error('session result processing failed', { sessionId, taskId, error: err instanceof Error ? err.message : String(err) })
      }
      // Emit session:ended so the Sessions page refreshes.
      // Skip when teamActive — session is still coordinating teammates.
      if (!teamActive) {
        log.web.info('session ended event emitted', { sessionId, taskId })
        bus.emit(EventNames.SESSION_ENDED, { sessionId, taskId }, ['web-ui'], { source: 'session-result' })
      }
      return
    }

    // Persist session:error to chat history
    if (event.name === 'session:error') {
      const { error, taskId, sessionId, errorKind } = eventData<'session:error'>(event)
      const isDeliveryFailure = errorKind === 'delivery_failed'

      // delivery_failed = connectivity status, not a turn outcome. The session is
      // still valid and the message batch is safely back in 'pending'. Dedup the
      // chat notification (one per session per window) — during an SSH outage every
      // send fails fast against the failure cache, and persisting each occurrence
      // flooded the main chat with 150+ permanent red boxes (2026-06-10 incident).
      if (isDeliveryFailure) {
        const key = `${sessionId ?? taskId ?? 'unknown'}`
        const now = Date.now()
        const lastAt = deliveryFailureNotifiedAt.get(key) ?? 0
        if (now - lastAt < DELIVERY_FAILURE_NOTIFY_WINDOW_MS) {
          log.web.info('session delivery failure suppressed (deduped)', { sessionId, taskId })
          return
        }
        deliveryFailureNotifiedAt.set(key, now)
        // Opportunistic sweep so the map can't grow unbounded
        if (deliveryFailureNotifiedAt.size > 200) {
          for (const [k, t] of deliveryFailureNotifiedAt) {
            if (now - t > DELIVERY_FAILURE_NOTIFY_WINDOW_MS) deliveryFailureNotifiedAt.delete(k)
          }
        }
      }

      // Git pull: fetch data pushed by remote hooks (best-effort).
      // Skip for delivery failures — nothing remote ran, and the host may be down.
      if (!isEphemeral && !isDeliveryFailure) {
        try {
          await gitPullWalnut()
          log.web.info('git pull completed for session error')
        } catch (err) {
          log.web.warn('git pull failed after session error', { error: String(err) })
        }
      }

      log.web.info('session error received', { sessionId, taskId, error: error?.slice(0, 200), errorKind })
      const errorTaskRef = taskId ? await resolveTaskRef(taskId) : null
      const content = isDeliveryFailure
        ? `**Session Delivery Failed**${errorTaskRef ? ` (${errorTaskRef})` : ''}: ${error}\n\n_Your message was NOT lost — it stays queued and will be re-sent when you press Retry, send another message, or the connection recovers._`
        : `**Session Error**${errorTaskRef ? ` (${errorTaskRef})` : ''}: ${error}`
      // Background notification → general's stable MAIN conversation.
      const { getMainConversationId } = await import('../core/conversations.js')
      const conversationId = await getMainConversationId('general')
      await chatHistory.addNotification({
        role: 'assistant', content,
        source: 'session-error', notification: true, taskId,
        agentId: 'general', conversationId,
      })

      // Delivery failure: session is intact (batch back in pending) — do NOT clear
      // the task slot, do NOT flip the phase, do NOT announce session:ended.
      if (isDeliveryFailure) return
      // Clear active session from task on error
      if (taskId && sessionId) {
        try {
          const { clearSessionSlot, clearSession } = await import('../core/task-manager.js')
          await clearSessionSlot(taskId, sessionId)
          // Also clear new single-slot field (parallel 1-slot transition)
          await clearSession(taskId, sessionId).catch(() => {})
        } catch (err) { log.web.warn('failed to clear session slot', { sessionId, taskId, error: String(err) }) }
        // Phase sync: session error → AWAIT_HUMAN_ACTION
        try {
          const { applySessionPhase } = await import('../core/phase.js')
          await applySessionPhase(taskId, 'session:error', 'server.ts:session-error', { sessionId })
        } catch (err) { log.web.warn('failed to apply session:error phase', { taskId, error: String(err) }) }
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

      // Subagent/triage results are background notifications → general's stable MAIN
      // conversation (NOT activeConversationId). See rationale in broadcastCronNotification.
      const { getMainConversationId } = await import('../core/conversations.js')
      const conversationId = await getMainConversationId('general')

      log.web.info('subagent result received', { runId, agentId, taskId, resultLength: result?.length ?? 0, hasNotification: !!notification })
      const subagentTaskRef = taskId ? await resolveTaskRef(taskId) : null

      // Check if this is a triage agent result — compact notification only
      const { DEFAULT_TRIAGE_AGENT_ID } = await import('../core/agent-registry.js')
      const { getConfig: getTriageConf } = await import('../core/config-manager.js')
      const triageConf2 = await getTriageConf()
      const triageAgentId = triageConf2.agent?.session_triage_agent ?? DEFAULT_TRIAGE_AGENT_ID
      // 'message-send-triage' is a retired agent (no longer dispatched) but historical
      // persisted runs still carry that agentId — keep recognising it so old results render.
      const triageAgentIds = new Set([triageAgentId, 'message-send-triage'])
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
        // notify_mode gates the EXPENSIVE main-agent turn (loads the full, never-compacted
        // conversation into the costly model). Default 'off': the triage subagent already
        // wrote task.summary/note/phase via its own tools, so the main agent sees the work
        // when it next polls the task — no real-time wake needed. 'realtime' = legacy behavior
        // (enqueue a main-agent turn now). 'buffered' = don't enqueue, but nudge the heartbeat
        // to review on its next cycle.
        const notifyMode = triageConf2.agent?.triage?.notify_mode ?? 'off'
        const willNotifyMainAgent = !!(triageUpdate && taskId) && notifyMode === 'realtime'

        // Build display-safe task ref (uses <task-ref> XML tag for clickable link rendering)
        let displayTaskRef: string
        try {
          if (!taskId) throw new Error('no taskId')
          const refTask = await getTask(taskId)
          const refLabel = refTask.project && refTask.project !== refTask.category
            ? `${refTask.project} / ${refTask.title}` : refTask.title
          displayTaskRef = `<task-ref id="${taskId}" label="${refLabel}"/>`
        } catch {
          displayTaskRef = taskId ?? ''
        }
        const triageTimestamp = new Date().toISOString()

        // Wake heartbeat after session triage — only when notify_mode allows it. In 'off'
        // mode the user wants the main agent fully quiet (poll-only), so skip the wake too;
        // waking it would re-introduce the cost via a heartbeat turn. 'buffered' and
        // 'realtime' both let the heartbeat review on its next cycle.
        if (heartbeatHandle && notifyMode !== 'off') {
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
            conversationId,
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
              // Fix 1 (root cause): triage only ever needs to READ state to phrase a
              // 2-4 sentence status notification. It must NEVER hold task_create or any
              // other write tool — that's what let a blind-trimmed turn re-create
              // near-duplicate tasks in a self-propagating loop. Use the read-only set.
              const { getReadOnlyTools, getReadOnlyToolSchemas } = await import('../agent/tools.js')
              const history = await chatHistory.getApiMessages('general', conversationId)
              const historyTokens = estimateMessagesTokens(history)

              // Pre-check: estimate full payload and bail to notification-only if near the limit.
              // This prevents burning API tokens on a 400 that the agent loop would have to recover from.
              const agentConfig = await getConfig()
              const mainModel = agentConfig.agent?.main_model
              const contextLimit = getContextWindowSize(mainModel)
              const TRIAGE_BAIL_PERCENT = 0.92 // bail if estimated > 92% of context window
              let estimatedTotal = historyTokens
              try {
                const system = await buildSystemPrompt('general', conversationId)
                // Estimate against the SAME (read-only) tool set we actually send below.
                const tools = getReadOnlyToolSchemas()
                const full = estimateFullPayload({ system, tools, messages: history })
                estimatedTotal = full.total
              } catch (preCheckErr) {
                // If full estimation fails, be conservative — assume over limit to avoid 400
                log.web.warn('triage pre-check: full estimation failed, using conservative fallback', {
                  taskId, error: preCheckErr instanceof Error ? preCheckErr.message : String(preCheckErr),
                })
                estimatedTotal = contextLimit // force bail
              }

              // Decide in REAL-token space (estimator undercounts Claude 3+ by ~35%, so the
              // raw estimate sailed under the threshold even at a real ~1.03M tokens — the bail
              // never fired). effectiveTotalTokens = max(estimate × 1.35, last EXACT API tokens).
              // Same shared helper as background-compaction's needsCompaction gate — one impl,
              // one source-of-truth map. See token-truth.ts.
              const correctedEstimate = Math.round(estimatedTotal * ESTIMATE_CORRECTION)
              const lastExact = getLastTurnTokens(conversationId) ?? 0
              const effectiveTotal = effectiveTotalTokens(estimatedTotal, conversationId)

              if (effectiveTotal > contextLimit * TRIAGE_BAIL_PERCENT) {
                log.web.warn('triage main agent skipped: history near context limit', {
                  taskId,
                  rawEstimate: `~${Math.round(estimatedTotal / 1000)}K`,
                  correctedEstimate: `~${Math.round(correctedEstimate / 1000)}K`,
                  lastExact: lastExact ? `~${Math.round(lastExact / 1000)}K` : 'unknown',
                  effectiveTotal: `~${Math.round(effectiveTotal / 1000)}K`,
                  contextLimit: `${Math.round(contextLimit / 1000)}K`,
                  bailThreshold: `${Math.round(contextLimit * TRIAGE_BAIL_PERCENT / 1000)}K`,
                })
                // Fall back to notification-only (same as triageToChat: false path)
                const bailContent = `**Triage** (${displayTaskRef}):\n\n${cleanedResult}`
                await chatHistory.addNotification({
                  role: 'assistant', content: bailContent,
                  source: 'triage', notification: true, taskId,
                  agentId: 'general', conversationId,
                })
                broadcastEvent('agent:response', { text: bailContent, source: 'triage', conversationId })
                triggerBackgroundCompaction('triage-bail', { agentId: 'general', conversationId })
                return
              }

              const readOnlyTools = getReadOnlyTools()
              log.web.info('triage main agent turn starting', {
                taskId,
                historyMessages: history.length,
                historyTokens: `~${Math.round(historyTokens / 1000)}K`,
                effectiveTotal: `~${Math.round(effectiveTotal / 1000)}K`,
                toolCount: readOnlyTools.length,
                readOnlyTools: true,
              })

              const agentResult = await runAgentLoop(prompt, history, {
                onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'triage' }),
                onThinking: (text) => broadcastEvent('agent:thinking', { text }),
                onToolCall: (toolName, input) => broadcastEvent('agent:tool-call', { toolName, input }),
                onToolResult: (toolName, result) => broadcastEvent('agent:tool-result', { toolName, result }),
                onToolActivity: (activity) => broadcastEvent('agent:tool-activity', activity),
                onUsage: (u) => {
                  try { usageTracker.record({ source: 'triage', model: u.model ?? 'unknown', input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, agentId: 'general' }) } catch {}
                  // Fix 2: cache the EXACT input-token count (incl. cache) so the next
                  // triage turn's bail pre-check can reason in real-token space.
                  try { recordLastTurnTokens(conversationId, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) } catch {}
                },
              }, { source: 'triage', tools: readOnlyTools, agentId: 'general', conversationId })

              if (agentResult.response) {
                broadcastEvent('agent:response', { text: agentResult.response, source: 'triage', conversationId })
              }
              // newMessages (not slice(history.length)) is trim-safe — see chat.ts. NB: pass
              // the WHOLE array incl. the user prompt at [0]; unlike chat.ts we did NOT
              // eager-persist the prompt, so it must be persisted here.
              const newApiMsgs = agentResult.newMessages
              await chatHistory.addAIMessages(newApiMsgs, { source: 'triage', taskId, agentId: 'general', conversationId })
              log.web.info('triage main agent done', { taskId, newMessages: newApiMsgs.length })
              triggerBackgroundCompaction('triage', { agentId: 'general', conversationId })
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err)
              log.web.error('triage main agent failed', { taskId, error: errMsg })
              broadcastEvent('agent:error', { error: `Triage notify failed for task ${taskId}: ${errMsg}`, conversationId })
              await chatHistory.addNotification({
                role: 'assistant',
                content: `**Triage Error** (${taskId}): ${errMsg}`,
                source: 'agent-error', notification: true,
                agentId: 'general', conversationId,
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
            agentId: 'general', conversationId,
          })
          log.web.info('triage notification saved to chat (UI only)', { taskId, sessionId: runId })

          bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
            conversationId,
            entry: { role: 'assistant', content: triageContent, source: 'triage', notification: true, taskId, sessionId: runId, timestamp: triageTimestamp },
          }, ['web-ui'])
        }

        // Synchronous, not delayed. The old setTimeout(5000) caused a cross-turn race:
        // if a new session:input arrived during the 5s window, the delayed callback
        // would overwrite the correct IN_PROGRESS with AWAIT_HUMAN_ACTION.
        //
        // Synchronous phase check: if triage completed but task is still at AGENT_COMPLETE,
        // the triage failed to act. Transition to AWAIT_HUMAN_ACTION immediately (no timer).
        if (taskId) {
          try {
            const { applySessionPhase } = await import('../core/phase.js')
            await applySessionPhase(taskId, 'triage-sync', 'server.ts:triage-done', { sessionId: runId })
          } catch (err) {
            log.web.warn('triage phase sync error', { taskId, error: err instanceof Error ? err.message : String(err) })
          }
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
          agentId: 'general', conversationId,
        })

        // Push notification directly to browser
        bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
          conversationId,
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
      // Background notification → general's stable MAIN conversation.
      const { getMainConversationId } = await import('../core/conversations.js')
      const conversationId = await getMainConversationId('general')
      await chatHistory.addNotification({
        role: 'assistant', content,
        source: 'subagent', notification: true, taskId,
        agentId: 'general', conversationId,
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

  // Mount plugin-registered HTTP routes AFTER plugins are loaded.
  // Routes are added to pluginRouter (already mounted at /api/plugins before notFoundHandler).
  for (const plugin of registry.getAll()) {
    if (plugin.httpRoutes?.length) {
      for (const route of plugin.httpRoutes) {
        pluginRouter.use(`/${plugin.id}${route.path}`, route.handler)
        log.web.info('mounted plugin route', { plugin: plugin.id, path: `/api/plugins/${plugin.id}${route.path}` })
      }
    }
  }

  // -- Run plugin data migrations (move legacy task fields to ext) --
  try {
    await runPluginMigrations(registry)
  } catch (err) {
    log.web.error('plugin data migrations failed', { error: err instanceof Error ? err.message : String(err) })
  }

  // -- Start generic plugin sync polling --
  startPluginSyncPolling()
  startupPhase('plugin sync polling started')

  // -- Process exit diagnostics --
  // Log WHY the server dies so we can diagnose silent crashes
  const exitLog = (reason: string, detail?: unknown) => {
    const msg = `SERVER EXIT: ${reason}`
    const meta = { pid: process.pid, uptime: process.uptime(), detail: detail instanceof Error ? detail.message : detail }
    log.web.error(msg, meta)
    console.error(`[${new Date().toISOString()}] ${msg}`, JSON.stringify(meta))
  }
  // SIGTERM/SIGHUP: log but do NOT process.exit() — let web.ts's handler call stopServer() first.
  // If no handler catches it (e.g. running from tests), the default signal behavior terminates anyway.
  process.on('SIGTERM', () => { exitLog('SIGTERM (killed by another process)') })
  process.on('SIGHUP', () => { exitLog('SIGHUP (terminal closed or parent died)') })
  process.on('uncaughtException', (err) => { exitLog('uncaughtException', err); process.exit(1) })
  process.on('unhandledRejection', (reason) => { exitLog('unhandledRejection', reason) })
  process.on('beforeExit', (code) => { exitLog(`beforeExit code=${code}`) })
  process.on('exit', (code) => {
    // Sync-only: last chance to log (no async allowed)
    const msg = `[${new Date().toISOString()}] SERVER EXIT: code=${code} pid=${process.pid} uptime=${process.uptime()}s`
    try { require('node:fs').appendFileSync('/tmp/open-walnut-exit.log', msg + '\n') } catch { /* ignore */ }
  })

  // -- Start post-listen services (port already bound above) --
  cronService.start().catch((err) => {
    log.cron.error('failed to start cron service', { error: err instanceof Error ? err.message : String(err) })
  })

  // -- Start heartbeat runner (if enabled in config) --
  startHeartbeatIfConfigured().catch((err) => {
    log.heartbeat.error('failed to start heartbeat', { error: err instanceof Error ? err.message : String(err) })
  })

  // -- Dream consolidation — check periodically (every 2 hours) --
  dreamTimerHandle = setInterval(async () => {
    try {
      const { executeDream } = await import('../core/dream.js')
      await executeDream()
    } catch (err) {
      log.memory.debug('dream check failed', { error: String(err) })
    }
  }, 2 * 60 * 60 * 1000)

  // Initial dream check after a delay (avoid running during startup)
  dreamInitialHandle = setTimeout(async () => {
    try {
      const { executeDream } = await import('../core/dream.js')
      await executeDream()
    } catch { /* best-effort */ }
  }, 5 * 60 * 1000)

  // Conversation distill sweep REMOVED (unified memory redesign): the append-only
  // background distiller was the main source of MEMORY.md rot. Condensation now
  // happens in-conversation via memory_manage / skill_manage triggers.

  startupPhase('ALL DONE — server fully initialized')
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
          const notifContent = `Data backup failing \u2014 git auto-commit has failed ${health.consecutiveFailures}+ times consecutively. Check logs: \`open-walnut logs -s git\``
          notifiedForEpisode = true
          // Background notification \u2192 general's stable MAIN conversation.
          import('../core/conversations.js')
            .then(({ getMainConversationId }) => getMainConversationId('general'))
            .then((conversationId) =>
              chatHistory.addNotification({
                role: 'assistant',
                content: notifContent,
                source: 'agent-error',
                notification: true,
                agentId: 'general', conversationId,
              }).then(() => {
                bus.emit(EventNames.CHAT_HISTORY_UPDATED, {
                  conversationId,
                  entry: { role: 'assistant', content: notifContent, source: 'agent-error', notification: true, timestamp: new Date().toISOString() },
                }, ['web-ui'])
              })
            ).catch(() => {
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
          // Background turn → general's stable MAIN conversation (see rationale in
          // broadcastCronNotification above).
          const { getMainConversationId } = await import('../core/conversations.js')
          const conversationId = await getMainConversationId('general')

          // Load chat history (fresh state after any preceding turn)
          const history = await chatHistory.getApiMessages('general', conversationId)
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
            conversationId,
          })
          // Persist the heartbeat trigger as a user notification
          await chatHistory.addNotification({
            role: 'user',
            content: heartbeatUserContent,
            timestamp: heartbeatTs,
            source: 'heartbeat',
            notification: true,
            agentId: 'general', conversationId,
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
                  agentId: 'general',
                })
              } catch { /* non-critical */ }
            },
          }, { source: 'heartbeat', agentId: 'general', conversationId })

          // Fire agent:response exactly once after loop completes
          const responseText = result.response ?? ''
          if (responseText) {
            broadcastEvent('agent:response', { text: responseText, source: 'heartbeat' })
          }

          // Persist agent response to chat history. newMessages (not slice(history.length))
          // is trim-safe — see chat.ts. NB: pass the WHOLE array incl. the user prompt at [0];
          // unlike chat.ts we did NOT eager-persist the prompt, so it must be persisted here.
          const newApiMsgs = result.newMessages

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
              agentId: 'general', conversationId,
            })
          } else {
            // Substantive response — persist full AI messages with heartbeat source
            await chatHistory.addAIMessages(newApiMsgs, { source: 'heartbeat', agentId: 'general', conversationId })
          }

          // Trigger background compaction outside the turn queue
          triggerBackgroundCompaction('heartbeat', { agentId: 'general', conversationId })

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

/** Cooperative yield — give the event loop a chance to run pending I/O / handlers. */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * Start generic plugin sync polling.
 * Iterates all registered plugins (except 'local') and creates a self-rescheduling
 * timer for each. Each tick: retry unsynced tasks, then call plugin.sync.syncPoll(ctx).
 *
 * Uses setTimeout + self-reschedule (not setInterval) so:
 *   - The first tick is delayed by FIRST_TICK_DELAY_MS, avoiding boot-time pile-up
 *     (sync reconciler + session recovery + health monitor all fire around boot).
 *   - If a tick runs slow, the next tick starts intervalMs AFTER completion, not
 *     at the next wall-clock interval — prevents overlap / back-to-back churn.
 *
 * Inside the unsynced/retry loops we `await yieldToEventLoop()` every few iterations
 * so HTTP handlers, WS broadcasts, and session I/O don't starve while we await
 * dozens of serial plugin.sync.createTask() Graph calls.
 */
function startPluginSyncPolling(): void {
  const plugins = registry.getAll().filter(p => p.id !== 'local')
  const FIRST_TICK_DELAY_MS = 60_000 // boot grace — let startup quiet down first
  // Yield to the event loop every N sync iterations — a compromise between two
  // failure modes: N=1 adds needless loop overhead on every Graph call, while
  // N≥20 recreates the original event-loop starvation that wedged the server at
  // ~985 sessions. N=5 is small enough to keep HTTP/WS handlers responsive and
  // large enough that the setImmediate cost is amortized across multiple awaits.
  const YIELD_EVERY = 5

  for (const plugin of plugins) {
    let syncing = false
    let consecutiveFailures = 0
    const intervalMs = (plugin.config.sync_interval_ms as number) ?? SYNC_INTERVAL_MS

    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false
    // Tracks the Promise for the currently-executing tick (if any), so stopServer()
    // can await it and guarantee no plugin writes happen after shutdown returns.
    let currentTickPromise: Promise<void> | null = null
    const scheduleNext = (delayMs: number) => {
      if (stopped) return
      timer = setTimeout(() => { currentTickPromise = tick() }, delayMs)
    }
    // Register a stop-callback so stopServer() can cancel the pending timer
    // without needing to know which specific setTimeout handle is live right now.
    // The callback returns a Promise that resolves once the in-flight tick (if any)
    // has settled — stopServer() awaits it to prevent post-shutdown writes.
    pluginSyncStops.push(async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (currentTickPromise) {
        try { await currentTickPromise } catch { /* tick errors already logged */ }
      }
    })

    const tick = async () => {
      if (syncing) {
        scheduleNext(intervalMs)
        return
      }
      syncing = true
      const syncT0 = Date.now()
      let changeCount = 0 // captured by ctx closures — accumulates across delta pull + reconciler.tick
      try {
        const {
          listTasks,
          listUnsyncedTasks,
          listSyncErrorTasks,
          updateTaskRaw,
          updateTasksBulk,
          addTaskFull,
          deleteTask,
          autoPushIfConfigured,
        } = await import('../core/task-manager.js')

        // Step 1: Retry unsynced tasks (source matches plugin but no ext data yet).
        // Was `listTasks().filter(...)` — now pushed into SQL so we don't
        // materialize 6000+ rows just to pluck a handful of unsynced ones.
        const unsynced = await listUnsyncedTasks(plugin.id)
        if (unsynced.length > 0) {
          log.web.info('sync: unsynced tasks pending create', {
            pluginId: plugin.id,
            count: unsynced.length,
            // Sample up to 5 to spot if the same taskId keeps showing up across ticks
            sampleTaskIds: unsynced.slice(0, 5).map((t) => t.id),
          })
        }
        let unsyncedCounter = 0
        let unsyncedSuccesses = 0
        let unsyncedFailures = 0
        // Accumulate ext-merge patches across the loop and commit them in one
        // bulk transaction after all network calls finish. Each createTask() is
        // still awaited serially (network + per-item yield) — only the DB write
        // is batched to avoid N sequential SQLite transactions on large backlogs.
        const extUpdates: Array<{ id: string; patch: Partial<Task> }> = []
        for (const task of unsynced) {
          // Yield to the event loop periodically so HTTP/WS handlers don't starve
          // while we await dozens of serial Graph calls (each ~500ms).
          if (unsyncedCounter > 0 && unsyncedCounter % YIELD_EVERY === 0) {
            await yieldToEventLoop()
          }
          unsyncedCounter++
          try {
            const ext = await plugin.sync.createTask(task)
            if (ext) {
              // ext is already scoped: { 'ms-todo': { id, list_id } } — spread to merge
              const mergedExt = { ...task.ext, ...ext as Record<string, unknown> }
              extUpdates.push({ id: task.id, patch: { ext: mergedExt } })
              Object.assign(task, { ext: mergedExt })
              unsyncedSuccesses++
            }
          } catch (err) {
            unsyncedFailures++
            // Promoted from debug → warn so ghost-producing repro stays visible
            log.web.warn(`${plugin.id} sync: unsynced retry create failed`, {
              taskId: task.id,
              title: task.title,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        if (unsynced.length > 0) {
          log.web.info('sync: unsynced batch done', {
            pluginId: plugin.id,
            attempted: unsynced.length,
            succeeded: unsyncedSuccesses,
            failed: unsyncedFailures,
          })
        }
        if (extUpdates.length > 0) {
          const { changed } = await updateTasksBulk(extUpdates)
          // destinations: [] — only global subscribers (embedding-sync) receive
          // individual events; web-ui gets one bulk signal at end of sync cycle.
          for (const updatedTask of changed) {
            bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, [], { source: `${plugin.id}-sync` })
            changeCount++
          }
        }

        // Step 1.5: Retry tasks with sync_error that already have ext data
        // These are tasks that were created successfully but had a subsequent push failure.
        // SQL-filtered (listSyncErrorTasks) so we don't re-scan the whole task set.
        const MAX_ERROR_RETRIES_PER_CYCLE = 5
        const errorRetries = (await listSyncErrorTasks(plugin.id)).slice(0, MAX_ERROR_RETRIES_PER_CYCLE)
        let errorRetryCounter = 0
        for (const task of errorRetries) {
          // Same reason as the unsynced loop — yield periodically so the event loop
          // isn't starved while we await serial autoPushIfConfigured calls.
          if (errorRetryCounter > 0 && errorRetryCounter % YIELD_EVERY === 0) {
            await yieldToEventLoop()
          }
          errorRetryCounter++
          try {
            await autoPushIfConfigured(task)
          } catch (err) {
            log.web.debug(`${plugin.id} sync: error retry push failed`, {
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }

        // Step 2: Build SyncPollContext and run delta pull.
        // `listTasks()` is intentionally deferred to this step — Step 1/1.5
        // now go through targeted SQL (listUnsyncedTasks / listSyncErrorTasks).
        // We still need a snapshot here because SyncPollContext.getTasks() is
        // synchronous (plugins + reconciler can't await inside their diff loops),
        // and ctx.updateTask uses the array as a per-tick cache that it mutates
        // in-place so subsequent getTasks() calls in the same tick see the
        // just-applied change.
        const localTasks = await listTasks()
        const ctx: SyncPollContext = {
          getTasks: () => localTasks,
          updateTask: async (id, updates) => {
            // pushInflight guard: skip pull update if task has active push
            const { isPushInflight } = await import('../core/task-manager.js')
            if (isPushInflight(id)) {
              log.web.debug(`${plugin.id} sync: skipping pull update — push inflight`, { taskId: id })
              const existingTask = localTasks.find(t => t.id === id)
              return existingTask ?? await (await import('../core/task-manager.js')).getTask(id)
            }
            // Clear stale sync_error when a remote pull successfully updates the task
            const existingTask = localTasks.find(t => t.id === id)
            const effectiveUpdates = (existingTask?.sync_error && !('sync_error' in updates))
              ? { ...updates, sync_error: undefined }
              : updates
            const { changed } = await updateTaskRaw(id, effectiveUpdates)
            const updatedTask = localTasks.find(t => t.id === id)
            if (updatedTask) {
              Object.assign(updatedTask, effectiveUpdates)
              if (changed) {
                bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, [], { source: `${plugin.id}-sync` })
                changeCount++
              }
            }
            // Return updated task (or fetch fresh if not in local list)
            return updatedTask ?? await (await import('../core/task-manager.js')).getTask(id)
          },
          addTask: async (taskData) => {
            const task = await addTaskFull(taskData)
            bus.emit(EventNames.TASK_CREATED, { task }, [], { source: `${plugin.id}-sync` })
            changeCount++
            return task
          },
          deleteTask: async (id) => {
            const { task } = await deleteTask(id)
            bus.emit(EventNames.TASK_DELETED, { task }, [], { source: `${plugin.id}-sync` })
            changeCount++
          },
          emit: (event, data) => {
            // ctx.emit is for non-task plugin signals (e.g. sync:progress) — intentionally not batched
            bus.emit(event, data, ['web-ui'], { source: `${plugin.id}-sync` })
          },
        }

        // Call the plugin's syncPoll (delta pull)
        let deltaFailed = false
        try {
          await plugin.sync.syncPoll(ctx)
        } catch (deltaErr) {
          deltaFailed = true
          throw deltaErr // re-throw so outer catch still handles logging
        } finally {
          // Step 3: Full reconciliation check (runs even if delta succeeded)
          try {
            await syncReconciler.tick(plugin, ctx, { deltaFailed })
          } catch (reconcileErr) {
            log.web.debug(`${plugin.id} reconciler tick failed`, {
              error: reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr),
            })
          }
        }
        consecutiveFailures = 0
        const syncElapsed = Date.now() - syncT0
        if (syncElapsed > 2000) {
          log.web.warn(`${plugin.id} sync: slow tick`, { elapsed: syncElapsed })
        }
      } catch (err) {
        consecutiveFailures++
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (consecutiveFailures >= 5) {
          log.web.error(`${plugin.id} sync failing repeatedly`, { consecutiveFailures, error: errorMsg })
        } else {
          log.web.debug(`${plugin.id} sync failed`, { consecutiveFailures, error: errorMsg })
        }
      } finally {
        // outer finally ensures bulk signal fires even if delta fails — reconciler runs in inner finally and may produce additional changes via ctx closures
        try {
          // Send a single bulk signal to web-ui instead of 100+ individual events
          if (changeCount > 0) {
            // null task = bulk signal; frontend useTasks.ts:327 handles by calling refetch()
            bus.emit(EventNames.TASK_UPDATED, { task: null } as any, ['web-ui'], { source: `${plugin.id}-sync-batch` })
            log.web.info(`${plugin.id} sync: batch complete`, { changeCount })
          }
        } catch (emitErr) {
          log.web.warn(`${plugin.id} sync: bulk emit failed`, { error: emitErr instanceof Error ? emitErr.message : String(emitErr) })
        }
        syncing = false
        scheduleNext(intervalMs)
      }
    }

    // First tick is delayed to avoid boot-time pile-up with health monitor /
    // session recovery / reconciler, all of which fire around server start.
    scheduleNext(FIRST_TICK_DELAY_MS)
    log.web.info('started sync polling for plugin', { pluginId: plugin.id, intervalMs, firstTickDelayMs: FIRST_TICK_DELAY_MS })
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
  if (dreamTimerHandle) {
    clearInterval(dreamTimerHandle)
    dreamTimerHandle = null
  }
  if (dreamInitialHandle) {
    clearTimeout(dreamInitialHandle)
    dreamInitialHandle = null
  }
  // Cancel pending deferred-markDone callbacks so they don't mutate
  // sessionStreamBuffer after shutdown.
  for (const timer of deferredMarkDoneTimers) {
    clearTimeout(timer)
  }
  deferredMarkDoneTimers.clear()
  // Await each stop() so any in-flight plugin tick completes before we tear down
  // the registry and other dependencies. Otherwise a mid-tick ctx.updateTask /
  // ctx.addTask / bus.emit could fire after shutdown.
  await Promise.all(
    pluginSyncStops.map(stop => stop().catch(() => { /* best-effort shutdown */ })),
  )
  pluginSyncStops = []
  registry.clear()
  if (healthMonitor) {
    healthMonitor.stop()
    healthMonitor = null
  }
  if (sessionReaper) {
    sessionReaper.stop()
    sessionReaper = null
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
  if (recordingReaperHandle) {
    recordingReaperHandle.stop()
    recordingReaperHandle = null
  }
  if (terminalReaperHandle) {
    terminalReaperHandle.stop()
    terminalReaperHandle = null
  }
  // Save current audio recording chunk before shutdown (prevents data loss on restart)
  try {
    const { audioCaptureService } = await import('../core/audio-capture.js')
    if (audioCaptureService.getStatus().recording) {
      log.web.info('saving audio recording before shutdown')
      await audioCaptureService.stop()
    }
  } catch (err) {
    log.web.warn('audio capture shutdown failed', { error: err instanceof Error ? err.message : String(err) })
  }

  subagentRunner.destroy()
  // Always detach — sessions are detached child processes and must survive
  // server shutdown. Never kill session PIDs from stopServer().
  sessionRunner.destroy()
  if (qmdWatcherHandle) {
    qmdWatcherHandle.stop()
    qmdWatcherHandle = null
  }
  // Close QMD stores (non-blocking — best-effort)
  import('../core/qmd-store.js')
    .then(({ closeQmdStores }) => closeQmdStores())
    .catch(() => {})
  if (gitAutoCommitHandle) {
    gitAutoCommitHandle.stop()
    gitAutoCommitHandle = null
  }
  bus.unsubscribe('web-ui')
  bus.unsubscribe('main-ai')
  bus.unsubscribe('heartbeat-config')
  bus.unsubscribe('embedding-sync')
  bus.unsubscribe('setup-health')
  bus.unsubscribe('qmd-task-sync')
  bus.unsubscribe('qmd-session-sync')
  // Release local terminal ptys (dtach sessions on targets survive).
  try {
    const { terminalManager } = await import('./terminal/terminal-manager.js')
    terminalManager.shutdown()
  } catch { /* terminal feature may be disabled */ }
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
