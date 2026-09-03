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
import express, { Router } from 'express'
import cors from 'cors'
import compression from 'compression'
import { bus, EventNames, eventData } from '../core/event-bus.js'
import { attachWss, broadcastEvent, sendStreamEvent, closeWss } from './ws/handler.js'
import { sessionStreamBuffer } from './session-stream-buffer.js'
import { isStaticAssetPath } from './static-asset-path.js'
import { notFoundHandler, errorHandler } from './middleware/error-handler.js'
import { requestLogger, setRouteRecoveryPublisher } from './middleware/request-logger.js'
import { tasksRouter } from './routes/tasks.js'
import { dashboardRouter } from './routes/dashboard.js'
import { sessionsRouter } from './routes/sessions.js'
import { searchRouter } from './routes/search.js'
import { searchAgentRouter } from './routes/search-agent.js'
import { memoryRouter } from './routes/memory.js'
import { configRouter, setStaticRootReporter } from './routes/config.js'
import { backupRouter, setBackupScheduler } from './routes/backup.js'
import { projectsRouter } from './routes/projects.js'
import { favoritesRouter } from './routes/favorites.js'
import { uiPrefsRouter } from './routes/ui-prefs.js'
import { devicesRouter } from './routes/devices.js'
import { focusRouter } from './routes/focus.js'
import { orderingRouter } from './routes/ordering.js'
import { chatHistoryRouter } from './routes/chat-history.js'
import { contextInspectorRouter } from './routes/context-inspector.js'
import { registerChatRpc } from './routes/chat.js'
import { registerSessionChatRpc } from './routes/session-chat.js'
import { registerBrowserLogsRpc, browserLogsRouter } from './routes/browser-logs.js'
import { bugReportRouter } from './routes/bug-report.js'
import { usageRouter } from './routes/usage.js'
import { timeRouter, startTimeTracking, stopTimeTracking } from './routes/time.js'
import { imagesRouter } from './routes/images.js'
import { localImageRouter } from './routes/local-image.js'
import { fileContentRouter } from './routes/file-content.js'
import { calendarRouter } from './routes/calendar.js'
import { permissionsRouter } from './routes/permissions.js'
import { warmLauncherDetection } from '../core/permissions/darwin.js'
import { getCalendarService } from '../core/calendar/index.js'
import { filesRouter } from './routes/files.js'
import { fileOpsRouter } from './routes/file-ops.js'
import { fileRawRouter } from './routes/file-raw.js'
import { fileHistoryRouter } from './routes/file-history.js'
import { createCronRouter, setCronService } from './routes/cron.js'
import { createAgentsRouter } from './routes/agents.js'
import { createConversationsRouter } from './routes/conversations.js'
import { createCommandsRouter } from './routes/commands.js'
import { createSkillsRouter } from './routes/skills.js'
import { createSlashCommandsRouter } from './routes/slash-commands.js'
import { timelineRouter } from './routes/timeline.js'
import { CronService } from '../core/cron/index.js'
import os from 'node:os'
import { CLOUD_MODE, CRON_FILE, IS_EPHEMERAL, WALNUT_HOME } from '../constants.js'
import { sessionRunner } from '../providers/claude-code-session.js'
import { SessionHealthMonitor } from '../core/session-health-monitor.js'
import { SessionReaper } from '../core/session-reaper.js'
import { isClaudeCliInstalled } from '../core/claude-cli-detect.js'
import { subagentRunner } from '../providers/subagent-runner.js'
import { getTask, listTasks } from '../core/task-manager.js'
import type { Task } from '../core/types.js'
import { log } from '../logging/index.js'
import { usageTracker } from '../core/usage/index.js'
import * as chatHistory from '../core/chat-history.js'
import { gitPullWalnut, ensureRepo, commitIfDirty, autoSync, isGitAvailable, isLockContention, checkRepoSize, getSyncGuardState } from '../integrations/git-sync.js'
import { registry } from '../core/integration-registry.js'
import { clearPluginQuarantine, disableLoadedPlugin, disposeLoadedPlugins, getPluginLifecycleRecords, loadNewPlugins, loadPlugins, migrateConfigToPlugins, reloadLoadedPlugin, runPluginMigrations, getUnconfiguredPlugins } from '../core/integration-loader.js'
import type { SyncPollContext } from '../core/integration-types.js'
import { syncReconciler } from '../core/sync-reconciler.js'
import { integrationsRouter } from './routes/integrations.js'
import { createPluginSourcesRouter } from './routes/plugin-sources.js'
import { createPluginRuntimeRouter } from './routes/plugin-runtime.js'
import { relayPrimaryPluginHttpRequest } from './routes/plugin-runtime-bridge.js'
import { appsRouter, pluginAppStaticRouter } from './routes/apps.js'
import { createPluginBodyParser, createPluginRouteDispatcher } from './plugin-route-dispatcher.js'
import { setPluginApiBase } from '../core/plugins/server-api.js'
import { systemRouter } from './routes/system.js'
import { cloudSetupRouter } from './routes/cloud-setup.js'
import { searchIndexRouter } from './routes/search-index.js'
import { notesRouter } from './routes/notes.js'
import { notesV2Router } from './routes/notes-v2.js'
import { repositoriesRouter } from './routes/repositories.js'
import { audioRouter } from './routes/audio.js'
import { sttRouter } from './routes/stt.js'
import { migrateGlobalNotes } from '../core/notes-migration.js'
import { authMiddleware } from './middleware/auth.js'
import { pushRouter } from './routes/push.js'
import { authRouter } from './routes/auth.js'
import { setupRouter } from './routes/setup.js'
import { apiV1Router, closeApiV1Streams } from './routes/api-v1.js'
import { sessionStreamV1Router } from './routes/session-stream-v1.js'
import { sessionLaunchV1Router } from './routes/session-launch-v1.js'
import { sessionControlV1Router } from './routes/session-control-v1.js'
import { sessionLifecycleV1Router } from './routes/session-lifecycle-v1.js'
import { taskV1Router } from './routes/task-v1.js'
import { messagesV1Router } from './routes/messages-v1.js'
import { personalAiV1Router } from './routes/personal-ai-v1.js'
import { searchMemoryV1Router } from './routes/search-memory-v1.js'
import { eventsV1Router, startMobileEventsFeed, stopMobileEventsFeed } from './routes/events-v1.js'
import { sttV1Router, sttPayloadTooLargeHandler } from './routes/stt-v1.js'
import { inboxPayloadTooLargeHandler } from './routes/human-inbox-v1.js'
import { pastesRouter } from './routes/pastes.js'
import { mediaV1Router } from './routes/media-v1.js'
import { routinesV1Router } from './routes/routines-v1.js'
import { projectsV1Router } from './routes/projects-v1.js'
import { taskExtrasV1Router } from './routes/task-extras-v1.js'
import { sessionExtrasV1Router } from './routes/session-extras-v1.js'
import { filesV1Router } from './routes/files-v1.js'
import { consoleV1Router } from './routes/console-v1.js'
import { notesExtrasV1Router } from './routes/notes-extras-v1.js'
import { libraryV1Router } from './routes/library-v1.js'
import { consoleExtrasV1Router } from './routes/console-extras-v1.js'
import { incidentsRouter } from './routes/incidents.js'
import { metricsRouter } from './routes/metrics.js'
import { clientEvidenceRouter } from './routes/client-evidence.js'
import { notificationsRouter } from './routes/notifications.js'
import { hooksRouter } from './routes/hooks.js'
import { addNotification as addFeedNotification, upsertNotification as upsertFeedNotification, resolvePermissionNotification, recoverNotifications } from '../core/notifications/store.js'
import { createRecoveryTransitionTracker } from '../core/notifications/recovery-transition.js'
import { humanizeErrorNotification } from '../core/notifications/humanize.js'
import { causeKeyForError, hostCauseKey } from '../core/notifications/error-cause.js'
import { releaseAbsorbedKeys } from '../core/notifications/log-error-bridge.js'
import { compactPermissionInput, summarizePermissionRequest } from '../core/notifications/permission-detail.js'
import { redactSensitiveText } from '../logging/redact.js'
import { stripEntityRefs, extractFirstRefs } from '../utils/entity-refs.js'
import { registerAuthRpc } from './routes/auth-rpc.js'
import { initPushNotifications } from '../core/push-notification.js'
import { initLetterPush } from '../core/push/letter-push.js'
import { enqueueMainAgentTurn, getQueueStatus, recordLastTurnTokens, getLastTurnTokens } from './agent-turn-queue.js'
import { activeRelayedTurnCount } from './routes/chat-turn-relay.js'
import { effectiveTotalTokens, ESTIMATE_CORRECTION } from '../core/token-truth.js'
import { triggerBackgroundCompaction } from './background-compaction.js'
import {
  startHeartbeatRunner,
  isHeartbeatOk,
  type HeartbeatRunnerHandle,
} from '../heartbeat/index.js'


/**
 * Look up a task and build a rich reference: [id|Project / Title], or
 * [id|Inbox / Title] when the task has no project.
 * Falls back to [id] if the task can't be found.
 */
async function resolveTaskRef(taskId: string): Promise<string> {
  try {
    const task = await getTask(taskId)
    const label = `${task.project || 'Inbox'} / ${task.title}`
    return `[${taskId}|${label}]`
  } catch {
    return `[${taskId}]`
  }
}

/**
 * True when this agent's turns are answered by a lane-bound `claude` session
 * instead of the in-process agent loop (`config.agent.provider: 'claude-code'`).
 *
 * Read per turn, not once at boot: the flag is a live config value, and a config
 * edit must take effect on the NEXT background turn without a restart. Any
 * failure (unreadable config, unknown provider string) degrades to `false` — the
 * in-process loop — so a broken config can never leave a producer with no engine.
 */
async function usePersonalAiLaneEngine(agentId: string): Promise<boolean> {
  if (agentId !== 'general') return false
  try {
    const { getConfig, resolveAgentEngineProvider } = await import('../core/config-manager.js')
    return resolveAgentEngineProvider(await getConfig()) === 'claude-code'
  } catch {
    return false
  }
}

const DEFAULT_PORT = 3456
const SYNC_INTERVAL_MS = 30_000 // Default plugin sync interval (30s)
const MAX_ERROR_NOTIFICATION_BODY = 600

// Storm absorber for hand-published error notifications — same shape as the
// log-error bridge's REPEAT_TTL_MS. Without it, a failure sitting on a 30s timer
// (git:auto-commit) or a poll loop (disk watermark) does an unconditional
// read-modify-write of notifications.json (cross-process file lock) PLUS a WS
// broadcast on every single occurrence, forever.
let errorNotificationRepeatTtlMs = 60_000
/** Tests only: shrink/disable the absorber (0 = every occurrence reaches the store). */
export function setErrorNotificationRepeatTtlMs(ms: number): void {
  errorNotificationRepeatTtlMs = ms
  errorNotificationRecentScopes.clear()
  errorNotificationScopeRecoveryKeys.clear()
}
const errorNotificationRecentScopes = new Map<string, number>()
/** dedupScope → the keys a recovery can arrive by (recoveryKey and/or causeKey).
 *  publishRecovery needs the reverse direction (a recovering key must release
 *  its scopes' absorbers) and the absorber map itself is keyed by scope, so the
 *  mapping is recorded here as each notification is published rather than
 *  re-derived by string surgery. */
const errorNotificationScopeRecoveryKeys = new Map<string, string[]>()

/**
 * Permission requestIds already persisted to the durable feed.
 *
 * The CLI re-emits the SAME requestId every 60s while nobody answers. Without
 * this, each re-emit paid for a session lookup + a task lookup + a full
 * read-modify-write of notifications.json just to land on the store's dedup and
 * change nothing. A restart loses the set → at most ONE redundant (still
 * dedup-absorbed) write per pending request, which is acceptable.
 * Entries are removed when the request resolves.
 */
const persistedPermissionRequestIds = new Set<string>()

async function publishErrorNotification(input: {
  title: string
  body: string
  /**
   * The ONLY dedup axis (the key carries no body hash), so its granularity is a
   * correctness decision: one scope must mean one root cause. Two different
   * failures sharing a scope collapse into one card that keeps overwriting its
   * own body; splitting one failure across scopes floods the feed.
   */
  dedupScope: string
  sessionId?: string
  taskId?: string
  /**
   * The recoverable CONDITION this failure is about ('git', 'backup', 'disk',
   * `plugin:<id>`), so the matching success point can retire the card via
   * publishRecovery. Omitted = no lifecycle: the card stays until dismissed,
   * which is right for a one-shot event (a session that already ended).
   */
  recoveryKey?: string
}): Promise<boolean> {
  const timestamp = Date.now()
  const lastAt = errorNotificationRecentScopes.get(input.dedupScope)
  if (lastAt !== undefined && timestamp - lastAt < errorNotificationRepeatTtlMs) return false
  if (errorNotificationRecentScopes.size > 500) {
    for (const [scope, at] of errorNotificationRecentScopes) {
      if (timestamp - at > errorNotificationRepeatTtlMs) {
        errorNotificationRecentScopes.delete(scope)
        // Pruned in LOCKSTEP: the recovery-key map exists only to release entries
        // in the map above, so a survivor here would be unbounded garbage. The
        // handful of recovery keys (git/backup/disk/plugin:*) are all long-lived
        // anyway — the growth risk is per-session/per-subagent scopes.
        errorNotificationScopeRecoveryKeys.delete(scope)
      }
    }
  }
  // Session stderr / provider errors can embed tokens or keys; the log-error
  // bridge redacts its own path, but this hand-published path writes to the
  // durable store directly — redact BEFORE hashing/truncating/persisting.
  const plainBody = redactSensitiveText(stripEntityRefs(input.body))
  const cap = (text: string): string => text.length > MAX_ERROR_NOTIFICATION_BODY
    ? `${text.slice(0, MAX_ERROR_NOTIFICATION_BODY)}…`
    : text
  const rawBody = cap(plainBody)
  // Human copy + the family the Errors rail groups by. Most titles reaching here
  // are already prose ('Data Backup Failing'), and the humanizer's rules pass
  // those through unchanged — what every card gains is the `category`. When a
  // rule DOES rewrite the copy (Session Error / Delivery Failed / Subagent
  // Error), the producer's original body is kept as `detail` so nothing is lost.
  // sanitize is passed even though `plainBody` is already redacted: the TITLE
  // arrives un-redacted on this path (producers pass a literal), and one hook is
  // cheaper to reason about than two half-covered inputs.
  const human = humanizeErrorNotification({
    title: input.title,
    body: plainBody,
    ...(input.recoveryKey ? { recoveryKey: input.recoveryKey } : {}),
  }, { sanitize: redactSensitiveText })
  const body = human.message ? cap(human.message) : rawBody
  // Only when the humanizer actually replaced the body — an identical string in
  // both fields would render the same sentence twice (once inline, once behind
  // the toggle).
  const detail = body === rawBody ? undefined : rawBody
  // The ROOT CAUSE this failure shares with other conditions (a host's SSH/
  // daemon link down), derived from the producer's own words — this path has no
  // structured host, but the connectivity error shapes always name theirs.
  // A daemon reconnect then retires the whole fan-out via publishRecovery.
  const causeKey = causeKeyForError({ text: `${input.title}\n${plainBody}` })
  // Scope-only key (no body hash): one failing thing = ONE feed entry that folds
  // its repeats. Hashing the body used to split "same outage, slightly different
  // message" into a pile of near-identical cards.
  const dedupKey = `error:${input.dedupScope}`

  try {
    const { record, outcome } = await upsertFeedNotification({
      kind: 'operation-error',
      severity: 'error',
      title: human.title,
      body,
      timestamp,
      dedupKey,
      category: human.category,
      ...(detail ? { detail } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.recoveryKey ? { recoveryKey: input.recoveryKey } : {}),
      ...(causeKey ? { causeKey } : {}),
    })
    // Armed only after the write landed — a failed persist must not silence this
    // failure for a full TTL window with nothing durable to show for it.
    errorNotificationRecentScopes.set(input.dedupScope, timestamp)
    const releaseKeys = [input.recoveryKey, causeKey].filter((k): k is string => !!k)
    if (releaseKeys.length > 0) errorNotificationScopeRecoveryKeys.set(input.dedupScope, releaseKeys)
    // 'inserted' → a new card; 'refreshed' → the same card with a live count and
    // the latest body, so connected UIs patch in place instead of re-toasting.
    broadcastEvent(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record)
    return true
  } catch (err) {
    log.web.warn('failed to publish error notification', {
      title: input.title,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Retire the error cards for conditions that just recovered.
 *
 * The user's complaint this exists for: an error notification describes a
 * CONDITION (plugin auth expired, git auto-commit failing, backup failing, disk
 * full), and conditions recover — but the feed was fire-and-forget, so after the
 * user re-authenticated a plugin the wall of red stayed forever and the Errors
 * rail became something to scroll past instead of read. Every success point
 * signals here with the key it owns; everything unresolved under that key turns
 * quiet and leaves the rail.
 *
 * Callers MUST gate on a failure→success TRANSITION, not call this on every
 * healthy tick: a 30s poll would otherwise pay for a locked read-modify-write of
 * notifications.json forever just to scan and change nothing
 * (createRecoveryTransitionTracker is the shared gate).
 *
 * Exported so the e2e suite can drive a recovery without waiting out a real poll
 * interval; production callers are the success points below.
 */
export async function publishRecovery(keys: string[]): Promise<number> {
  if (keys.length === 0) return 0
  try {
    const { recovered } = await recoverNotifications(keys)
    // The TTL absorber must be released for these scopes even when nothing was
    // recovered. It is keyed by dedupScope and suppresses a repeat for 60s; if a
    // condition fails → recovers → fails again inside one window, an armed
    // absorber would swallow the RE-failure and leave the card sitting green
    // ('recovered', severity info) while the thing is broken again. Recovery is
    // exactly the moment that suppression stops being correct.
    for (const [scope, scopeKeys] of errorNotificationScopeRecoveryKeys) {
      if (!scopeKeys.some(k => keys.includes(k))) continue
      errorNotificationRecentScopes.delete(scope)
      errorNotificationScopeRecoveryKeys.delete(scope)
    }
    // The log-error BRIDGE keeps its own absorber (60s per dedup hash) for
    // everything that arrives as a log.error — routes, bus pairs, session
    // family. Same argument, different map, so release both: a route that 500s,
    // recovers, and 500s again seconds later is the common case, and only this
    // makes the second failure visible.
    releaseAbsorbedKeys(keys)
    if (recovered.length === 0) return 0
    // One frame per record: the panel patches in place (F2 merge), so the card
    // gains its Recovered chip live without a refresh.
    for (const record of recovered) broadcastEvent('notification:updated', record)
    log.notif.info('recovered error notifications', {
      keys: keys.join(','), count: recovered.length,
    })
    return recovered.length
  } catch (err) {
    log.web.warn('failed to publish notification recovery', {
      keys: keys.join(','),
      error: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}

// ── Session-scoped error lifecycle ────────────────────────────────────────────
//
// A session error ('Session Error', 'Session Delivery Failed', plus everything
// the session/obs subsystems log through the bridge with a sessionId) is a
// condition about ONE session, and it has both a recovery signal and a terminal
// point: the session's next clean result retires it, and the session's death
// expires it (session-tracker's terminal transition + the boot reconcile).

/**
 * Which sessions currently have an unresolved error card.
 *
 * `session:result` fires on every turn of every session, so the healthy path has
 * to be free: nothing is inserted unless an error was actually published for that
 * session, and the entry is dropped again on the recovery edge (`forget`) — so
 * this can't grow into a per-session-id leak over a long-running server.
 */
const sessionErrorTracker = createRecoveryTransitionTracker()

/** The condition id for a session's error family. */
function sessionRecoveryKey(sessionId: string): string {
  return `session:${sessionId}`
}

/**
 * A session's turn completed cleanly → retire its error cards.
 *
 * Called from the `session:result` handler on a NON-error result. Cheap by
 * construction: an isFailing() Map.get for a session that never failed, and only
 * a real failing→healthy edge reaches the store. The task key rides along because
 * 'transport start failed' knows only a taskId (the session it was starting never
 * existed), so its card is keyed `task:<id>` and would otherwise never retire.
 */
function recoverSessionErrors(sessionId: string | undefined, taskId: string | undefined): void {
  const keys: string[] = []
  if (sessionId && sessionErrorTracker.isFailing(sessionRecoveryKey(sessionId))) {
    sessionErrorTracker.forget(sessionRecoveryKey(sessionId))
    keys.push(sessionRecoveryKey(sessionId))
  }
  if (taskId && sessionErrorTracker.isFailing(`task:${taskId}`)) {
    sessionErrorTracker.forget(`task:${taskId}`)
    keys.push(`task:${taskId}`)
  }
  if (keys.length > 0) void publishRecovery(keys)
}

/**
 * Publish a session-scoped error AND mark the session failing, so the next clean
 * result recovers it. One helper rather than two lines at each of the two publish
 * sites, because forgetting the tracker half would leave a card that can never be
 * retired — exactly the class of bug this round is closing.
 */
function publishSessionErrorNotification(input: {
  title: string
  body: string
  dedupScope: string
  sessionId?: string
  taskId?: string
}): Promise<boolean> {
  const key = input.sessionId
    ? sessionRecoveryKey(input.sessionId)
    : input.taskId ? `task:${input.taskId}` : undefined
  if (key) sessionErrorTracker.observe(key, true)
  return publishErrorNotification({ ...input, ...(key ? { recoveryKey: key } : {}) })
}

/**
 * CORS origin gate. Allows requests with no `Origin` (native apps, curl,
 * same-origin navigations) and browser origins that are localhost or on a
 * private LAN (the dev Vite server + trusted-LAN devices). A public-internet
 * origin is refused — the cloud SPA is same-origin so it never needs a
 * cross-origin grant, and no wildcard is ever emitted.
 */
function corsOriginAllowed(
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
): void {
  if (!origin) { cb(null, true); return } // non-browser / same-origin
  try {
    const host = new URL(origin).hostname
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const isPrivateLan = /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    cb(null, isLoopback || isPrivateLan)
  } catch {
    cb(null, false)
  }
}

export interface ServerOptions {
  port?: number
  dev?: boolean
}

let httpServer: HttpServer | null = null
// Self-rescheduling timers keyed by owning plugin. A reload stops the old owner
// before replacing its code, so no tick can retain a stale plugin object.
const pluginSyncStops = new Map<string, () => Promise<void>>()
// Set during startup; invoked by the plugin-sources router after add/update.
let pluginSoftReload: () => Promise<void> = async () => {}
let pluginMutationTail: Promise<unknown> = Promise.resolve()

function runPluginMutation<T>(operation: () => Promise<T>): Promise<T> {
  const current = pluginMutationTail.catch(() => undefined).then(operation)
  pluginMutationTail = current
  return current
}

let cronServiceInstance: CronService | null = null
let healthMonitor: SessionHealthMonitor | null = null
let changesPrewarmer: import('../core/session-changes-prewarm.js').SessionChangesPrewarmer | null = null
let sessionReaper: SessionReaper | null = null
let heartbeatHandle: HeartbeatRunnerHandle | null = null
let recordingReaperHandle: { stop: () => void } | null = null
let externalSessionImporter:
  import('../core/sessions/external-session-import.js').ExternalSessionImporterHandle | null = null
let terminalReaperHandle: { stop: () => void } | null = null
let notesWatcherHandle: { stop: () => void } | null = null
let searchV2WiringHandle: { stop(): Promise<void> } | null = null
let gitAutoCommitHandle: { stop: () => void; health: GitAutoCommitHealth } | null = null
let diskWatermarkHandle: { stop: () => void; poll: () => Promise<unknown> } | null = null
let backupSchedulerHandle: import('../core/backup/backup-scheduler.js').BackupSchedulerHandle | null = null
let keepAwakeHandle: import('../core/keep-awake.js').KeepAwakeHandle | null = null
let gitMaintenanceHandle: { stop: () => void } | null = null
let sendPathCanaryHandle: import('../core/send-path-canary.js').SendPathCanaryHandle | null = null

/** For GET /api/v1/canary's ?fresh=1 forced re-poll. */
export function getCanaryHandle(): import('../core/send-path-canary.js').SendPathCanaryHandle | null {
  return sendPathCanaryHandle
}

/** Tests only: force a watermark poll through the SERVER's own notify/onRecovered
 *  wiring, rather than re-implementing that wiring in the test (which is how a
 *  test can pass while the real seam is unwired). */
export function getDiskWatermarkHandle(): { stop: () => void; poll: () => Promise<unknown> } | null {
  return diskWatermarkHandle
}
let taskProjectionHandle: { stop: () => void } | null = null
let foreignWriterWatchdog: { stop: () => void } | null = null
let sessionProjectionHandle: { stop: () => void } | null = null
let projectionSelfHealHandle: { stop: () => void } | null = null
/** Cloud box only: 60s drain of cache/task-queue/ (see core/task-queue.ts). */
let taskQueueFlushHandle: { stop: () => void } | null = null
/** Cloud box only: 60s drain of cache/control-queue/ (see core/control-queue.ts). */
let controlQueueFlushHandle: { stop: () => void } | null = null
/** Cloud box only: 60s drain of cache/send-queue/ (see core/send-queue.ts). */
let sendQueueFlushHandle: { stop: () => void } | null = null
let autoContinueHandle: { stop: () => void } | null = null
/** Primary box only: re-resumes sessions whose host/daemon died under them. */
let autoRecoverHandle: { stop: () => void } | null = null
/** Primary box only: daily retirement of completed pins (core/task-pin-retirement.ts). */
let pinRetirementHandle: import('../core/periodic-task.js').PeriodicHandle | null = null
let claudeSettingsWatcherStop: (() => void) | null = null
/** Unhooks the host-connected → publishRecovery listener (daemon-connection's
 *  listener set is module-global, so an in-process restart must not stack them). */
let unsubscribeHostRecovery: (() => void) | null = null
/** Daily error-notification reconcile (expiry + settled-receipt prune). */
let notificationReconcileTimer: ReturnType<typeof setInterval> | null = null
// Pending deferred-markDone timers from the session:status-changed handler.
// Hoisted to module scope so stopServer() can cancel them before teardown,
// otherwise a late-firing timer could mutate sessionStreamBuffer after the
// server has already stopped serving.
const deferredMarkDoneTimers: Set<ReturnType<typeof setTimeout>> = new Set()

// ── Fatal-signal ownership ──
//
// startServer() installs a SIGTERM/SIGHUP handler that ALWAYS terminates the
// process (see the fatalSignal() comment below for the 2026-08-09 zombie-server
// incident this prevents). A long-running owner that wants graceful teardown
// instead — commands/web.ts, which awaits stopServer() — calls
// armGracefulSignalExit() once its own handler is registered. Until then the
// signal is honoured immediately, so a SIGTERM during the multi-second boot
// window can never be swallowed into an unkillable server.
let signalExitArmed = false

/**
 * Declare that the caller has registered its own SIGTERM/SIGHUP handler which
 * WILL terminate the process (normally after awaiting stopServer()). Call this
 * AFTER registering that handler. Idempotent.
 */
export function armGracefulSignalExit(): void {
  signalExitArmed = true
}

/** Test/embedding escape hatch: revert to self-terminating on signal. */
export function disarmGracefulSignalExit(): void {
  signalExitArmed = false
}

let exitDiagnosticsInstalled = false

/**
 * Install process-level exit diagnostics + the always-fatal signal handlers.
 *
 * Called at the very TOP of startServer(), BEFORE any await. This placement is
 * the fix for the 2026-08-09 zombie-server incident and is load-bearing:
 *
 *   - Node semantics: registering ANY 'SIGTERM' listener REPLACES the OS default
 *     disposition. A listener that only logs makes the process IMMUNE to SIGTERM.
 *   - These handlers used to be registered ~1900 lines of `await` into boot, and
 *     were log-only, while the real terminating handler in commands/web.ts was
 *     registered only after `await startServer()` RESOLVED. A `kill -15` landing
 *     in that window — exactly what every dev-prod.sh deploy sends to the
 *     outgoing listener — was logged as "SERVER EXIT: SIGTERM" and then ignored.
 *   - Result measured on 2026-08-09: 62 unkillable servers, median survival 107
 *     minutes past their own SIGTERM, peak 43 alive at once, each running its own
 *     health monitor, cron, git auto-commit and plugin polling. Load average
 *     reached 94 on 14 cores; macOS then SIGTERM/SIGKILLed the user's GUI apps
 *     and relaunched the login session — experienced as "all my applications
 *     suddenly quit with no warning".
 *
 * So: handlers first, always fatal by default, graceful only when an owner has
 * explicitly armed itself via armGracefulSignalExit(). Idempotent — repeated
 * startServer() calls in one process (tests) must not stack listeners.
 */
function installExitDiagnostics(): void {
  if (exitDiagnosticsInstalled) return
  exitDiagnosticsInstalled = true

  // Log WHY the server dies so we can diagnose silent crashes
  const exitLog = (reason: string, detail?: unknown) => {
    const msg = `SERVER EXIT: ${reason}`
    // recoveryKey 'server-lifecycle': the next successful boot retires this card
    // (see the publishRecovery(['server-lifecycle']) call in startServer). Without
    // it, every deploy left a permanent red 'SERVER EXIT: SIGTERM' in the feed for
    // a server that had already been replaced by a healthy one.
    const meta = {
      pid: process.pid, uptime: process.uptime(),
      detail: detail instanceof Error ? detail.message : detail,
      recoveryKey: 'server-lifecycle',
    }
    log.web.error(msg, meta)
    console.error(`[${new Date().toISOString()}] ${msg}`, JSON.stringify(meta))
  }

  const fatalSignal = (name: NodeJS.Signals, reason: string) => {
    exitLog(reason)
    if (signalExitArmed) return // owner runs stopServer() then exits
    // No owner (still booting, or embedded without a handler): honour the signal.
    // Release the instance lock explicitly — otherwise the next server sees a
    // live-looking lock and refuses to start.
    try { releaseInstanceLockOnSignal() } catch { /* best-effort */ }
    // Re-raise with the default disposition so the exit status reflects the
    // signal (128+n) exactly as an unhandled signal would.
    process.removeAllListeners(name)
    try {
      process.kill(process.pid, name)
    } catch {
      process.exit(1) // signal delivery refused — must still die
    }
  }

  process.on('SIGTERM', () => fatalSignal('SIGTERM', 'SIGTERM (killed by another process)'))
  process.on('SIGHUP', () => fatalSignal('SIGHUP', 'SIGHUP (terminal closed or parent died)'))
  process.on('uncaughtException', (err) => { exitLog('uncaughtException', err); process.exit(1) })
  process.on('unhandledRejection', (reason) => {
    // Fatal ONLY during boot: a rejection there means startServer itself broke
    // (e.g. listen EADDRINUSE escaping the async main) and the deploy smoke
    // test needs the exit-1. Once serving, any stray floating promise — a
    // missed .catch() in a timer, a daemon probe — must NOT take down prod
    // (one un-awaited rejection killing :3456 is an outage, not a diagnostic).
    if (!bootCompleted) {
      exitLog('unhandledRejection', reason)
      process.exit(1)
    }
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    log.web.error('unhandledRejection (post-boot, non-fatal)', { detail })
  })
  process.on('beforeExit', (code) => { exitLog(`beforeExit code=${code}`) })
  process.on('exit', (code) => {
    // Sync-only: last chance to log (no async allowed)
    const msg = `[${new Date().toISOString()}] SERVER EXIT: code=${code} pid=${process.pid} uptime=${process.uptime()}s`
    try { fs.appendFileSync('/tmp/open-walnut-exit.log', msg + '\n') } catch { /* ignore */ }
  })
}

// False while startServer() is booting (rejections are fatal), true once the
// server is fully initialized (rejections log instead). Reset on each boot so
// repeated startServer() calls in one process (tests) get boot-fatality again.
let bootCompleted = false

// Captured when the instance lock is acquired, so the fatal-signal path can
// release it synchronously — a signal handler must not await a dynamic import.
let releaseInstanceLockSync: (() => void) | null = null

/** Best-effort synchronous instance-lock release on the fatal-signal path. */
function releaseInstanceLockOnSignal(): void {
  releaseInstanceLockSync?.()
}

// ── Git auto-commit health state ──

interface GitAutoCommitHealth {
  protected: boolean
  error?: string
  lastCommitAt?: string
  consecutiveFailures: number
  /** True while git-sync refuses auto-commits (mass-revert / torn-worktree guard). */
  safeMode?: boolean
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
  daemons?: Array<{ host: string; label: string; connected: boolean; bridgeConnected?: boolean | null }>;
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

/** Check if Claude Code CLI is available to Walnut. */
function checkClaudeCliAvailable(): boolean {
  return isClaudeCliInstalled()
}

/** Resolve provider readiness + where the Bedrock credential came from.
 *  Bedrock detection delegates to the unified credential resolver (config →
 *  ~/.claude/settings.json env → process.env → ~/.aws) so the Settings page,
 *  the Personal AI, and onboarding all agree on one priority chain. Non-Bedrock
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
      // claude-cli is keyless: ready when the local CLI is installed AND a
      // subscription credential exists (existence probe only, never the value).
      if (prov.api === 'claude-cli') {
        const { detectClaudeCli } = await import('../core/claude-cli-detect.js')
        if (detectClaudeCli().subscriptionReady) {
          return { hasReadyProvider: true, source: 'config', detail: 'claude-cli (subscription)' }
        }
        continue
      }
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
  bootCompleted = false // boot in progress → unhandled rejections are fatal again

  // FIRST, before any await: install exit diagnostics + always-fatal SIGTERM/
  // SIGHUP handlers. A `kill -15` during the multi-second boot below must kill
  // this process — a boot-window signal that gets logged and ignored is how 43
  // unkillable servers accumulated and starved the machine on 2026-08-09.
  installExitDiagnostics()

  // Ensure ~/.open-walnut/ directory structure exists and seed config defaults
  const { initDirectories } = await import('../core/init.js')
  await initDirectories()

  // Route every log.error()/log.fatal() into the notification center (deduped
  // + storm-throttled in the bridge). Installed before any subsystem starts so
  // boot-time errors are captured too. broadcastEvent is safe pre-attachWss
  // (no clients yet → no-op).
  {
    const { installLogErrorNotifications } = await import('../core/notifications/log-error-bridge.js')
    installLogErrorNotifications(broadcastEvent)

    // ── Recovery signals for the seams that must not import server.ts ──
    //
    // Both of these are on HOT paths (every HTTP request; every bus dispatch) and
    // both live in modules the server imports, so the dependency has to run this
    // way round: they hold an injected publisher, default no-op, and only ever
    // call it on a failing→healthy EDGE for a key that actually failed.
    setRouteRecoveryPublisher((keys) => { void publishRecovery(keys) })
    const { setBusRecoveryPublisher } = await import('../core/event-bus.js')
    setBusRecoveryPublisher((keys) => { void publishRecovery(keys) })

    // ── The server being up IS the recovery for a lifecycle card ──
    //
    // 'SERVER EXIT: SIGTERM' / uncaughtException / unhandledRejection describe a
    // condition — "this server died" — and the ONE observation that settles it is
    // this process running. There is no later success point to hook: by
    // definition the failing process is gone. So a boot retires the previous
    // life's exit cards (and, when a crash loop is what's happening, each boot's
    // recovery is immediately followed by the next exit card, which reads
    // correctly as a flapping condition rather than one stale card).
    void publishRecovery(['server-lifecycle'])
  }

  // ── Setup health checks: Claude CLI + provider readiness ──
  systemHealth.claudeCliAvailable = checkClaudeCliAvailable()
  if (!systemHealth.claudeCliAvailable) {
    log.web.warn('Claude Code CLI not found — sessions will not work')
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

  // Ops guardrails: a niced server process (inherited from launching dev:prod
  // out of a niced shell, e.g. a background claude session) is starved first
  // under machine overload — HTTP latency spikes that look like app bugs.
  // Can't renice without root; make it loud instead.
  try {
    const os = await import('node:os')
    const priority = os.getPriority()
    if (priority > 0) {
      log.web.error(`server running at nice ${priority} — HTTP latency will suffer under load; restart dev:prod from a non-niced shell`, { nice: priority })
    }
    const cores = os.cpus().length
    const load1 = os.loadavg()[0]
    if (load1 > cores * 2) {
      log.web.warn('machine heavily overloaded at server start', { load1: Math.round(load1), cores })
    }
  } catch { /* diagnostics only */ }

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
  //
  // Cloud companion: by DEFAULT it has no Claude Code CLI, so no daemon to run.
  // With `cloud.exec.enabled` it becomes a real execution host and starts THE
  // SAME daemon over loopback (no SSH, no bridge, no deploy — the binary is
  // already in dist/daemon-binaries from its own build). See core/cloud-exec.ts
  // for the transport/auth/ownership reasoning.
  const cloudExec = CLOUD_MODE
    ? await (async () => {
      try {
        const [{ readCloudExecConfig, cloudExecStatus }, { getConfig }] = await Promise.all([
          import('../core/cloud-exec.js'),
          import('../core/config-manager.js'),
        ])
        const cfg = await getConfig()
        const status = cloudExecStatus(cfg, true)
        if (!status.enabled) {
          log.web.info('cloud mode: session execution disabled', { reason: status.reason })
        }
        return readCloudExecConfig(cfg, true)
      } catch (err) {
        // Config unreadable → stay a pure relay. Failing OPEN into exec mode on
        // an internet-facing box would be the wrong default.
        log.web.warn('cloud exec config unreadable — staying relay-only', {
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    })()
    : null
  if (CLOUD_MODE && !cloudExec?.enabled) {
    log.web.info('cloud mode: skipping local session daemon startup')
  } else try {
    const { localDaemon } = await import('../providers/local-daemon.js')
    await localDaemon.ensureRunning()
    log.web.info('local daemon ready', {
      port: localDaemon.port,
      ...(cloudExec?.enabled ? { cloudExec: true, cwdRoots: cloudExec.cwdRoots.length } : {}),
    })
  } catch (err) {
    log.web.error('failed to start local daemon — local sessions will fail', {
      error: err instanceof Error ? err.message : String(err),
    })
    // Don't throw — remote sessions may still work, and user can fix daemon issues
  }

  // Not const: an unrelated process holding this port makes the listen below step to
  // the next one rather than ending the boot with a raw EADDRINUSE.
  let port = options.port ?? DEFAULT_PORT
  const dev = options.dev ?? false
  const isEphemeral = IS_EPHEMERAL
  // Own-server URL for agent-facing skills/tools (e.g. the install-plugin skill curls
  // the REST API). Sandbox/demo servers on other ports inherit the right value.
  // Set again after listen, since port 0 and the busy-port shift both resolve there.
  process.env.WALNUT_SERVER_URL = `http://localhost:${port}`

  // Tripwire: never serve the PRODUCTION port from a test/temp home. A shell with
  // leaked vitest env (VITEST / NODE_ENV=test / OPEN_WALNUT_HOME=…test-global) makes
  // constants.ts silently redirect WALNUT_HOME to an empty temp dir; if that process
  // then binds 3456 it "successfully" serves zero tasks and 404s every session —
  // production data looks wiped until the next clean restart (incident
  // inc-1783280584117, 2026-07-05). Fail fast with an actionable message instead.
  if (port === DEFAULT_PORT && !dev && !isEphemeral) {
    const home = WALNUT_HOME
    const looksLikeTestHome = /open-walnut-test|walnut-test/.test(home) || home.startsWith(os.tmpdir())
    if (looksLikeTestHome) {
      throw new Error(
        `Refusing to bind production port ${DEFAULT_PORT} with WALNUT_HOME=${home} (a test/temp dir).\n` +
        `  Your shell likely has leaked test env vars. Fix with:\n` +
        `    env -u VITEST -u VITEST_MODE -u VITEST_WORKER_ID -u NODE_ENV -u OPEN_WALNUT_HOME npm run dev:prod`,
      )
    }
  }

  // Single-instance lock on WALNUT_HOME: a second server on the SAME data dir
  // (even on a different port) silently corrupts task data — each process's
  // whole-store cache goes stale against the other's writes, and writeStore()'s
  // full-snapshot rewrite then DELETES the rows it never saw (2026-08-04: a
  // stray `web --port 3467` erased every task/fork created via :3456 for a
  // day). Different port ≠ different data; the lock guards the data directory.
  // Ephemeral/test servers run on their own snapshot HOME → their own lock.
  //
  // Three layers, because the lock file only binds lock-AWARE builds:
  //   1. lock file      — new builds refuse to double-start (instant, free)
  //   2. lsof gate      — an OLD binary already holding tasks.sqlite blocks
  //                       startup too (it can't know about the lock; we can
  //                       still see it). Skipped in cloud mode (no local DB
  //                       contention model) — lock file still applies.
  //   3. watchdog       — a rogue writer arriving AFTER startup raises a
  //                       notification-center error within ~2 ticks.
  {
    const {
      acquireInstanceLock, assertNoForeignDbHolders, startForeignWriterWatchdog, releaseInstanceLock,
      TASK_DB_WRITERS_RECOVERY_KEY,
    } = await import('../core/instance-lock.js')
    acquireInstanceLock(port)
    // Capture for the fatal-signal path (which cannot await an import).
    releaseInstanceLockSync = releaseInstanceLock
    if (!CLOUD_MODE) {
      await assertNoForeignDbHolders()
      // The all-clear (the user killed the rogue writer) retires the SECOND
      // WRITER card. Edge-gated inside the watchdog, so a healthy box's 60s tick
      // stays a bare lsof and never touches notifications.json.
      foreignWriterWatchdog = startForeignWriterWatchdog(undefined, () => {
        void publishRecovery([TASK_DB_WRITERS_RECOVERY_KEY])
      })
    }
  }

  const app = express()

  // Never auto-generate ETags for API JSON. Express's default weak ETag let the
  // browser turn concurrent duplicate GETs into If-None-Match revalidations; a
  // cache race then surfaced the empty-body 304 to fetch() as "200 with no JSON"
  // (inc-1784686852150 / inc-1784752220440: session panel opened as "Untitled
  // session" + "History unavailable" until refresh). API payloads are dynamic
  // session/task state — conditional caching buys nothing here, and hashing
  // multi-MB JSON bodies per response was pure waste. Static assets are NOT
  // affected: express.static/res.sendFile use their own etag option.
  app.set('etag', false)

  // Cloud mode sits behind a local reverse proxy (Caddy) — trust loopback so
  // req.ip reflects the real client (X-Forwarded-For) for auth rate limiting.
  // NOT set in trusted-LAN mode: there, honoring X-Forwarded-For would let a
  // remote caller spoof a private IP and ride the LAN bypass.
  if (CLOUD_MODE) {
    app.set('trust proxy', 'loopback')
  }

  // -- Middleware --
  // CORS: reflect only trusted origins — NEVER `*`. A wildcard let any public
  // web page drive the API cross-origin (the LAN auth bypass + arbitrary
  // file-content read made that a real data-exfil / agent-RCE vector). Native
  // apps and same-origin SPA fetches send no cross-origin preflight, so they're
  // unaffected; only browser pages from an untrusted origin are refused.
  app.use(cors({ origin: corsOriginAllowed }))

  // Git smart HTTP for the cloud data hub (cloud mode only). MUST be mounted
  // BEFORE compression() and express.json(): git POST bodies are raw binary
  // streams the router pipes to `git http-backend` stdin (a body parser would
  // consume them), and pack responses must reach the client byte-exact
  // (compression() re-encoding them corrupts the pack protocol). The router
  // carries its own device-token auth — the /api auth middleware below does
  // not cover /git. See src/web/routes/git-http.ts.
  if (CLOUD_MODE) {
    const { gitHttpRouter } = await import('./routes/git-http.js')
    app.use('/git/data', gitHttpRouter)
  }

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
  // STT uploads get a higher body cap BEFORE the global parser (express.json
  // skips an already-parsed body, so first mount wins): voice recordings have
  // no duration limit (iOS field data-loss incident 2026-08-09) and 16kHz AAC
  // is ~14.4MB base64/hour — the 15mb default 413'd at ~62 minutes, in the
  // wrong error shape for the v1 contract. 35mb ≈ the routes' own 25MB-base64
  // audio cap (~100min) plus JSON envelope headroom; past that the routes
  // return a contract-shaped 413 themselves.
  app.use(['/api/v1/stt/transcribe', '/api/stt/transcribe'], express.json({ limit: '35mb' }))
  // Overflow (>35mb) → contract-shaped 413 (the phone keys preserve/retry UX
  // off error.code). Must sit at app level right here: the parser above
  // raises before any router runs, and Express skips routers in error mode.
  app.use(['/api/v1/stt/transcribe', '/api/stt/transcribe'], sttPayloadTooLargeHandler)
  app.use('/api/plugins/:pluginId', createPluginBodyParser(registry, CLOUD_MODE))
  // Letters carry inline media (a digest's base64 audio/video), so their write
  // routes get their own parser above the 15mb default — same shape as the STT
  // route right above. This bounds the INLINE lane only: a document bigger than
  // this is streamed to `POST /human-inbox/body` as raw bytes (no JSON parser
  // touches a non-json Content-Type) and the letter then carries `html_ref`, so
  // LETTER_HTML_MAX_BYTES (100MB) is not a function of this number. Past 32mb of
  // inline JSON the handler below answers with a contract-shaped 413 that names
  // the staging lane, instead of Express's bare HTML one. Kept OFF the global
  // parser deliberately: every other route should still refuse a 30MB body.
  //
  // 24mb, not more, and the reason is the ONE frame an inline send still crosses:
  // a cloud replica relays the whole letter JSON to the primary over the bridge,
  // and `ws` answers a frame past its 32MB maxPayload by closing the socket with
  // 1009 before any handler runs. So the inline lane is bounded by the frame minus
  // envelope headroom, exactly as before — and the 100MB lane simply does not use
  // this parser.
  app.use(['/api/v1/human-inbox', '/api/human-inbox'], express.json({ limit: '24mb' }))
  app.use(['/api/v1/human-inbox', '/api/human-inbox'], inboxPayloadTooLargeHandler)
  app.use(express.json({ limit: '15mb' }))
  // Paste spill-over (>200K chars from the web UI) — needs req.body, so must
  // mount AFTER the json parser above.
  app.use('/api/pastes', pastesRouter)
  // Default API responses to no-store so the browser HTTP cache never
  // revalidates/synthesizes them (see the etag note above — same incident).
  // Routes that WANT caching (images, media, timeline …) set their own
  // Cache-Control inside the handler, which overwrites this default.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  // Auth middleware: localhost passthrough, remote requires Bearer token
  app.use('/api', authMiddleware)
  app.use('/api', requestLogger)
  // Disk-full guard: when the data disk crosses the critical watermark,
  // mutating routes answer a clear 507 instead of crashing mid-write with
  // ENOSPC (2026-08-12 cloud outage). Reads stay fully available.
  const { diskGuardMiddleware } = await import('./middleware/disk-guard.js')
  app.use('/api', diskGuardMiddleware)

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
      // The feed is a plain-text surface: strip <task-ref>/<session-ref> markup
      // down to labels, but first lift the referenced ids onto the record so the
      // notification card can deep-link to the session/task the job produced.
      const refs = extractFirstRefs(text)
      void addFeedNotification({
        kind: 'cron', severity: 'info', title: jobName, body: stripEntityRefs(text), timestamp: eventTs,
        dedupKey: `cron:${jobName}:${eventTs}`, ...refs,
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
        // Hoisted above the engine branch so both engines send the byte-identical prompt.
        const cronPrompt = `[Scheduled Job "${jobName}"] ${prompt}`
        try {
          // ── Engine branch: Personal AI lane (config.agent.provider='claude-code') ──
          if (await usePersonalAiLaneEngine('general')) {
            const laneTs = new Date().toISOString()
            // The in-process path persists the prompt as part of result.newMessages;
            // here the model context lives in the CLI's own transcript, so only the
            // human-visible notification is persisted (same shape heartbeat uses).
            await chatHistory.addNotification({
              role: 'user', content: cronPrompt, source: 'cron', cronJobName: jobName,
              notification: true, agentId: 'general', conversationId, timestamp: laneTs,
            })
            const { runLaneTurn } = await import('../core/sessions/lane-turn.js')
            const { sessionId: laneSessionId, resultText } =
              await runLaneTurn('general', conversationId, cronPrompt, { source: 'cron' })
            if (resultText === null) {
              // Same contract as the in-process failure: the catch below broadcasts
              // agent:error and re-throws so the cron system records a failed run.
              throw new Error('cron lane turn timed out or errored')
            }
            await chatHistory.addNotification({
              role: 'assistant', content: resultText, source: 'cron', cronJobName: jobName,
              notification: true, sessionId: laneSessionId, agentId: 'general', conversationId,
            })
            broadcastEvent('agent:response', { text: resultText, source: 'cron', agentId: 'general', conversationId })
            log.cron.info('cron lane turn done', { jobName, sessionId: laneSessionId, resultLength: resultText.length })
            // No triggerBackgroundCompaction on the lane path — the CLI compacts its own context.
            return
          }

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
          const result = await runAgentLoop(cronPrompt, history, {
            onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'cron', agentId: 'general', conversationId }),
            onThinking: (text) => broadcastEvent('agent:thinking', { text, agentId: 'general', conversationId }),
            onToolCall: (toolName, input, toolUseId) => broadcastEvent('agent:tool-call', { toolName, input, toolUseId, agentId: 'general', conversationId }),
            onToolResult: (toolName, result, toolUseId) => broadcastEvent('agent:tool-result', { toolName, result, toolUseId, agentId: 'general', conversationId }),
            onToolActivity: (activity) => broadcastEvent('agent:tool-activity', { ...activity, agentId: 'general', conversationId }),
            // onText intentionally NOT provided — fires per text block per round.
            // agent:response is fired ONCE below after the loop completes.
            onUsage: (usage) => {
              try { usageTracker.record({ source: 'cron', model: usage.model ?? 'unknown', input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, agentId: 'general' }) } catch {}
            },
          }, { source: 'cron', agentId: 'general', conversationId })
          // Fire agent:response exactly once after loop completes
          if (result.response) {
            broadcastEvent('agent:response', { text: result.response, source: 'cron', agentId: 'general', conversationId })
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
          broadcastEvent('agent:error', { error: `Cron job "${jobName}" agent failed: ${errMsg}`, agentId: 'general', conversationId })
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
      const { buildStatefulMemorySection, persistMemoryUpdate } = await import('../agent/stateful-memory.js')
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

        // Persist the agent's <memory_update> block — the only write path to a
        // stateful agent's memory_project (see stateful-memory.ts). Without this
        // the protocol we just injected into the prompt would be a no-op.
        if (agentDef.stateful) {
          await persistMemoryUpdate(result.response, agentDef.stateful, agentDef.name, { agentId, source: 'cron' })
        }

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
  // Agent search mounts BEFORE /api/search so Express never routes it there.
  app.use('/api/search/agent', searchAgentRouter)
  app.use('/api/search', searchRouter)
  app.use('/api/memory', memoryRouter)
  app.use('/api/config', configRouter)
  // Primary box only: these endpoints sign real AWS requests with the box's
  // credential (incl. an EC2 instance role in the cloud). A replica reachable
  // by any paired device must not offer them — same audience rationale as the
  // cloud-mode config redaction above.
  if (!CLOUD_MODE) {
    app.use('/api/backup', backupRouter)
  }
  app.use('/api/projects', projectsRouter)
  app.use('/api/favorites', favoritesRouter)
  app.use('/api/ui-prefs', uiPrefsRouter)
  app.use('/api/devices', devicesRouter)
  app.use('/api/focus', focusRouter)
  app.use('/api/ordering', orderingRouter)
  app.use('/api/chat', chatHistoryRouter)
  app.use('/api/context', contextInspectorRouter)
  app.use('/api/usage', usageRouter)
  app.use('/api/time', timeRouter)
  app.use('/api/images', imagesRouter)
  app.use('/api/local-image', localImageRouter)
  app.use('/api/file-content', fileContentRouter)
  // Path-shaped raw bytes: an HTML preview's relative <img>/<link> URLs resolve
  // against this URL's PATH, which the query-shaped route above cannot offer.
  app.use('/api/file-raw', fileRawRouter)
  // Per-file version timeline (Walnut snapshots + git) for the file the editor has open.
  app.use('/api/file-history', fileHistoryRouter)
  app.use('/api/calendar', calendarRouter)
  app.use('/api/permissions', permissionsRouter)
  app.use('/api/files', filesRouter)
  // Mutations (mkdir/create/rename/duplicate/delete) share the /api/files
  // prefix; no path collides with the read-only router above.
  app.use('/api/files', fileOpsRouter)
  app.use('/api/agents', createAgentsRouter())
  // Conversations share the /api/agents prefix. Registered AFTER the agents
  // router; the agents router only matches single-segment ids (/:id), so the
  // deeper /:agentId/conversations paths fall through here without collision.
  app.use('/api/agents', createConversationsRouter())
  app.use('/api/engines', (await import('./routes/engines.js')).enginesRouter)
  app.use('/api/commands', createCommandsRouter())
  app.use('/api/skills', createSkillsRouter())
  app.use('/api/slash-commands', createSlashCommandsRouter())
  app.use('/api/heartbeat', (await import('./routes/heartbeat.js')).heartbeatRouter)
  app.use('/api/keep-awake', (await import('./routes/keep-awake.js')).keepAwakeRouter)
  app.use('/api/timeline', timelineRouter)
  app.use('/api/notes', notesRouter)
  app.use('/api/notes-v2', notesV2Router)
  app.use('/api/repositories', repositoriesRouter)
  app.use('/api/integrations', integrationsRouter)
  // Lazy indirection: pluginSoftReload is assigned later in startup, after the
  // initial loadPlugins — the router must call the CURRENT value, not capture it.
  app.use('/api/plugin-sources', createPluginSourcesRouter(() => pluginSoftReload()))
  app.use('/api/plugin-runtime', createPluginRuntimeRouter({
    registry,
    list: () => getPluginLifecycleRecords(registry),
    discover: async (pluginId) => {
      await pluginSoftReload()
      const plugin = getPluginLifecycleRecords(registry).find((record) => record.id === pluginId)
      if (!plugin) throw new Error(`Plugin "${pluginId}" was not discovered`)
      return plugin
    },
    reload: (pluginId) => runPluginMutation(async () => {
      await stopPluginSyncPolling(pluginId)
      try {
        const plugin = await reloadLoadedPlugin(registry, pluginId)
        bus.emit('plugin:runtime-changed', { pluginId, action: 'reloaded' }, ['web-ui'], { source: 'plugin-runtime' })
        return plugin
      } finally { startPluginSyncPolling() }
    }),
    disable: (pluginId) => runPluginMutation(async () => {
      await stopPluginSyncPolling(pluginId)
      try {
        const plugin = await disableLoadedPlugin(registry, pluginId)
        bus.emit('plugin:runtime-changed', { pluginId, action: 'disabled' }, ['web-ui'], { source: 'plugin-runtime' })
        return plugin
      } finally { startPluginSyncPolling() }
    }),
    clearQuarantine: (pluginId) => runPluginMutation(async () => {
      await stopPluginSyncPolling(pluginId)
      try {
        await clearPluginQuarantine(registry, pluginId)
        await reloadLoadedPlugin(registry, pluginId)
        bus.emit('plugin:runtime-changed', { pluginId, action: 'reloaded' }, ['web-ui'], { source: 'plugin-runtime' })
      } finally { startPluginSyncPolling() }
    }),
  }))

  // Live dispatcher: each request resolves the current owner from the registry, so
  // disable/reload removes old handlers without mutating Express's private stack.
  app.use('/api/plugins', createPluginRouteDispatcher(registry, {
    ...(CLOUD_MODE ? { relay: relayPrimaryPluginHttpRequest } : {}),
  }))

  // Plugin apps: the catalogue (under /api, so it inherits auth) and the static
  // file surface for a plugin's own HTML. Both read the registry live per request,
  // so ONE mount here covers plugins installed later by the plugin-store soft
  // reload — nothing to re-mount, nothing to double-register.
  //
  // /plugin-apps MUST be mounted here, ahead of the production SPA static
  // middleware and its catch-all index.html fallback further down; otherwise every
  // app URL would serve the Walnut shell instead of the plugin's page.
  app.use('/api/apps', appsRouter)
  // Not mounted in cloud mode. The route sits outside /api, so authMiddleware never
  // runs on it (that middleware treats everything outside /api as a public SPA
  // asset). On a Mac that is fine: the files are the user's own, on their own box.
  // On a reachable cloud replica it would be the one world-readable route, so the
  // deliberate call is to serve plugin apps on the primary only.
  if (!CLOUD_MODE) app.use('/plugin-apps', pluginAppStaticRouter)

  app.use('/api/system', systemRouter)
  // One-click cloud-companion provisioning (Mac-side job engine).
  app.use('/api/cloud-setup', cloudSetupRouter)
  // /api/search-index (canonical) + /api/qmd (legacy alias, one release).
  app.use(['/api/search-index', '/api/qmd'], searchIndexRouter)
  app.use('/api/push', pushRouter)
  app.use('/api/auth', authRouter)
  // First-boot claim flow (cloud mode) — publicly reachable by design; the
  // auth middleware exempts /api/v1/setup/* (see CLOUD_EXEMPT_PREFIXES).
  app.use('/api/v1/setup', setupRouter)
  // Frozen REST+SSE facade for mobile clients (see docs/reference/api-v1.md).
  app.use('/api/v1', apiV1Router)
  // Session talk endpoints (additive): send into + stream out of CC sessions.
  app.use('/api/v1', sessionStreamV1Router)
  // Session launch endpoints (additive): create a session from mobile
  // (host + path picker). Primary box only — REPLICA returns 503.
  app.use('/api/v1', sessionLaunchV1Router)
  // Session control endpoints (additive): model/effort switch, fork, and the
  // picker's model-options — relayed over the daemon bridge on a REPLICA.
  app.use('/api/v1', sessionControlV1Router)
  // Session lifecycle endpoints (additive, Wave 1): detail/patch/terminate/
  // restart/retry/permission/execute-continue/changes/history — B-class
  // relay on a REPLICA (new actions on the same session.control command).
  app.use('/api/v1', sessionLifecycleV1Router)
  // Task + focus endpoints (additive, Wave 1): detail/delete/star/notes/
  // reorder/batch + pin/tier — A-class (local store; replica rides the outbox).
  app.use('/api/v1', taskV1Router)
  // Unified send surface (additive): POST /messages (session_send core) +
  // GET /requests/:id (expect_reply status). Primary-only — 501 on a replica.
  app.use('/api/v1', messagesV1Router)
  // Personal AI conversation management (additive, Wave 1): rename/delete/stop/
  // answer — A-class (the replica runs its own Personal AI).
  app.use('/api/v1', personalAiV1Router)
  // Search/memory/notifications/favorites/notes utilities (additive, Wave 1).
  // Mixed classes: search 501 on replica, notifications B-relay, rest A.
  app.use('/api/v1', searchMemoryV1Router)
  // Live events feed (additive): one SSE stream of slim task/session updates
  // for mobile — bus-fed on the primary, bridge-fed on a REPLICA. Started
  // unconditionally (one lifecycle-interest bus subscription — cheap even on
  // ephemeral servers, and tests exercise the feed through real servers).
  app.use('/api/v1', eventsV1Router)
  startMobileEventsFeed()
  // Voice input (additive): phone audio → text, works on primary AND cloud.
  app.use('/api/v1', sttV1Router)
  // Image bytes for mobile (additive): local file, daemon, or bridge proxy.
  app.use('/api/v1', mediaV1Router)
  // Routines/cron (additive, Wave 2): full CRUD + toggle/run-now — B-class
  // relay on a REPLICA (the primary's cron engine is the single writer).
  app.use('/api/v1', routinesV1Router)
  // Projects registry (additive, Wave 2): list/create/ordering/favorites A;
  // rename/delete 501 on a REPLICA (no registry write-back channel).
  app.use('/api/v1', projectsV1Router)
  // Task extras (additive, Wave 2): tags/groups/quick-parse/focus tiers —
  // groups + tier CRUD 501 on a REPLICA (outbox whitelist lacks them).
  app.use('/api/v1', taskExtrasV1Router)
  // Session extras (additive, Wave 2): controls/settings/side-questions/
  // workflow/plan/subagent-history/execute-compact/queue + list-dirs — all
  // B-class relay on a REPLICA.
  app.use('/api/v1', sessionExtrasV1Router)
  // File browsing (additive, Wave 2): list/resolve relay on a REPLICA;
  // file-content reads relay via the bounded fs.readBounded bridge command
  // (2MB cap + host-side sandbox — see files-v1.ts / file-content-bridge.ts).
  app.use('/api/v1', filesV1Router)
  // Console reads (additive, Wave 2): config allowlist projection (A),
  // usage overview (C: 501 on replica), slash-commands (B), skills read (A).
  app.use('/api/v1', consoleV1Router)
  // Notes extras (additive, Wave 2): global notes, backlinks/links, tags,
  // attachment/folder delete — all A-class (git-synced vault).
  app.use('/api/v1', notesExtrasV1Router)
  // Library (additive, Wave 3): agents CRUD (writes 501 on a REPLICA —
  // machine-local config), commands, skills write (walnut-managed dir only;
  // ~/.claude/skills stays read-only), repositories — mostly A-class.
  app.use('/api/v1', libraryV1Router)
  // Console extras (additive, Wave 3): usage breakdowns, provider status
  // (key_hint stripped), search-index status, integrations read, timeline, heartbeat —
  // primary-bound stores answer 501 on a REPLICA.
  app.use('/api/v1', consoleExtrasV1Router)
  app.use('/api/browser-logs', browserLogsRouter)
  // One-shot diagnostic bundle (Settings → Bug Report; also curl-able).
  app.use('/api/bug-report', bugReportRouter)
  app.use('/api/audio', audioRouter)
  app.use('/api/stt', sttRouter)
  app.use('/api/incidents', incidentsRouter)
  app.use('/api/metrics', metricsRouter)
  app.use('/api/client-evidence', clientEvidenceRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/hooks', hooksRouter)
  // Deprecated alias — served from the unified hook registry (same shape as
  // the retired task-phase-hooks endpoint).
  app.get('/api/task-phase-hooks', async (_req, res) => {
    const { getHookInfoListLegacy } = await import('../core/hooks/registry.js')
    res.json(await getHookInfoListLegacy())
  })

  app.get('/api/git-sync/status', (_req, res) => {
    const health = gitAutoCommitHandle?.health ?? { protected: false, error: 'not started', consecutiveFailures: 0 }
    res.json(health)
  })

  // In-flight Personal AI turns — the deploy drain's probe (scripts/dev-prod.sh).
  //
  // A SIGTERM landing mid lane turn strands the answer: the CLI survives and
  // writes it, but the process holding the turn's promise dies, so nothing
  // persists it into the conversation. The deploy waits on this count before
  // killing. Two sources, deliberately: the per-agent turn queue covers every
  // transport (WS chat, REST, cron/heartbeat/triage), and the relay map covers
  // the window where a phone turn is accepted but not yet enqueued.
  //
  // Read-only, purely in-memory (two map walks, no I/O, no await) so it stays
  // answerable even while the machine is busy — a probe that can hang is a
  // probe the deploy has to ignore.
  app.get('/api/deploy/active-turns', (_req, res) => {
    const queue = getQueueStatus()
    const relayed = activeRelayedTurnCount()
    res.json({
      activeTurns: queue.active + queue.queued + relayed,
      queueActive: queue.active,
      queueQueued: queue.queued,
      relayedTurns: relayed,
      ts: new Date().toISOString(),
    })
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
    // The static root can DISAPPEAR under a running server: deploys boot from a
    // staged copy under TMPDIR, and on 2026-09-02 a later deploy's reap loop
    // deleted the live server's stage. cli.js was already in memory, so the API
    // stayed green while `/` and every hashed asset answered ENOENT — for four
    // hours, felt as "the app is laggy" because open windows kept running their
    // in-memory bundle with every lazy chunk and image gone. Nobody noticed
    // because nothing SAID it. Check once a minute, log it as an error, and
    // report it in /api/config (which every client and monitor already reads).
    const checkStaticRoot = (): boolean => {
      try { return fs.statSync(path.join(staticDir, 'index.html')).isFile() } catch { return false }
    }
    let staticRootOk = checkStaticRoot()
    if (!staticRootOk) {
      log.web.error('web assets are NOT servable at startup', { staticDir })
    }
    const staticRootTimer = setInterval(() => {
      const ok = checkStaticRoot()
      if (ok === staticRootOk) return
      staticRootOk = ok
      if (ok) log.web.info('web assets are servable again', { staticDir })
      else log.web.error('web assets VANISHED from under the running server', { staticDir })
    }, 60_000)
    staticRootTimer.unref()
    setStaticRootReporter(() => ({ staticDir, ok: staticRootOk }))
    // SPA fallback: serve index.html for non-API routes
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next()
      // A build artifact express.static could NOT find is a stale chunk: every
      // deploy re-hashes and wipes /assets, so tabs opened before it still ask
      // for the old names. Answering those with index.html made the browser
      // parse HTML as a module — a failure the app could only see as "this
      // lazily-loaded feature does nothing" (a .go file with no syntax colors
      // for the rest of the tab's life). 404 keeps it loud, and lets the
      // client's vite:preloadError recovery reload onto the current build.
      if (isStaticAssetPath(req.path)) return next()
      res.sendFile('index.html', { root: staticDir })
    })
  }

  // -- Error handlers (must be last) --
  app.use('/api', notFoundHandler)
  app.use(errorHandler)

  // Force task-store initialization and migrations before accepting traffic.
  // A successful but incomplete response during lazy initialization is worse
  // than a short connection wait: the SPA can persist the bogus empty state.
  const taskPrewarmStartedAt = Date.now()
  try {
    const tasks = await listTasks()
    log.web.info('startup: task store prewarmed before listen', {
      tasks: tasks.length,
      durationMs: Date.now() - taskPrewarmStartedAt,
    })
  } catch (err) {
    log.web.error('task store prewarm failed; refusing to listen', {
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  // -- HTTP + WebSocket --
  httpServer = createServer(app)
  attachWss(httpServer)

  // -- Bind port early (before heavy init) so no other process can grab it --
  // A busy port used to end the boot with a raw EADDRINUSE stack, which tells a new
  // user nothing about what to do. A second Walnut on this data dir is already refused
  // by the instance lock above, so a taken port here means some UNRELATED process holds
  // it: step to the next one and say so, the way dev servers do. Port 0 (tests, probes)
  // is resolved by the OS and can never collide.
  const requestedPort = port
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err)
        httpServer!.once('error', onError)
        httpServer!.listen(port, () => { httpServer!.removeListener('error', onError); resolve() })
      })
      break
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException)?.code === 'EADDRINUSE'
      if (!busy || requestedPort === 0 || attempt >= 9) throw err
      port += 1
      log.web.warn(`port ${port - 1} is in use by another process, trying ${port}`, { requestedPort, port })
    }
  }
  const label = dev ? 'dev' : 'production'
  log.web.info(`server listening on http://localhost:${port}`, { mode: label, port })
  if (port !== requestedPort) {
    // stdout, not just the log file: this is the address the human has to open.
    process.stdout.write(`\nPort ${requestedPort} was busy. Walnut is at http://localhost:${port}\n\n`)
  }
  // Record the REAL port in the instance lock (port 0 resolves at listen time, and a
  // busy port shifted us above). Everything derived from the port has to be re-derived
  // here, including WALNUT_SERVER_URL, which agent-facing skills curl.
  {
    const bound = httpServer.address()
    if (bound && typeof bound === 'object') {
      const { updateInstanceLockPort } = await import('../core/instance-lock.js')
      updateInstanceLockPort(bound.port)
      setPluginApiBase(`http://127.0.0.1:${bound.port}`)
      process.env.WALNUT_SERVER_URL = `http://localhost:${bound.port}`
    }
  }

  // -- Cloud mode: first-boot claim banner --
  // While zero devices are paired, print the one-time setup token so the
  // operator can claim the instance (POST /api/v1/setup/claim). The plain
  // multiline banner is intentional — greppable via journalctl on the box.
  if (CLOUD_MODE) {
    try {
      const { getSetupTokenIfUnclaimed, printSetupTokenBanner } = await import('../core/device-auth.js')
      const setup = await getSetupTokenIfUnclaimed()
      if (setup?.provisioned) {
        // Provisioning supplied the token (a pairing code from the operator's
        // own Walnut). Printing it would put a live secret in the journal for
        // no benefit — whoever provisioned the box already holds it.
        process.stdout.write([
          '',
          '==============================================================',
          '  WALNUT CLOUD SETUP — instance is UNCLAIMED',
          '',
          '  Setup token provisioned via pairing code (not shown).',
          `  Valid until: ${new Date(setup.expiresAt).toISOString()}`,
          '',
          '  Claim from your Walnut app, or read the token from your',
          '  provisioning input.',
          '==============================================================',
          '',
        ].join('\n'))
      } else if (setup) {
        printSetupTokenBanner(setup.token, setup.expiresAt)
      } else {
        log.web.info('cloud mode: instance already claimed (device tokens active)')
      }
    } catch (err) {
      log.web.error('cloud mode: failed to initialize device auth', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

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
      // Only an instance that OWNS the dtach socket dir may reap in it. The
      // reaper's rule is "socket whose sessionId is absent from my registry →
      // kill", so an instance with an isolated (empty) registry pointed at
      // someone else's sockets classifies all of them as orphans. Ownership is
      // now structural: DTACH_SOCKET_DIR is derived from LOG_DIR, so an isolated
      // runtime dir gets its own socket dir (see constants.ts). CLOUD_MODE has no
      // local terminals at all. IS_EPHEMERAL stays gated for a second reason: it
      // runs over a SNAPSHOT of production's registry, so its view of "which
      // sessions still exist" is stale by construction.
      if (!IS_EPHEMERAL && !CLOUD_MODE) {
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

  // Reset search-index route state to clear a stale rebuild status from a previous run
  {
    const { resetSearchIndexRouteState } = await import('./routes/search-index.js')
    resetSearchIndexRouteState()
  }

  // -- Cloud-companion setup job: resume one that was mid-flight when the Mac
  //    restarted. A cdk deploy or a 15-minute first boot easily outlives a
  //    server restart, and the job is the only thing holding the pairing code
  //    that will claim the box. Mac-side only (guarded inside). --
  {
    const { resumeCloudSetupJobIfAny } = await import('../core/cloud-setup/job.js')
    resumeCloudSetupJobIfAny().catch((err) => {
      log.web.warn('cloud-setup: resume failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }
  registerAuthRpc()
  registerBrowserLogsRpc()

  // -- Time tracking: agent-time collector (session:result) + rollup warm-up. --
  startTimeTracking()

  // -- Push notification service --
  initPushNotifications()
  // Human Inbox letters push on their own path, NOT through the sender above:
  // that one suppresses whenever any browser WebSocket is open, which meant a
  // Mac console tab silently swallowed every letter push. Letters are addressed
  // to the human, so the decision is per DEVICE (its own foreground state + the
  // user's chosen mode). Primary only — letters live here, and a replica relays
  // every human-inbox route to this box.
  if (!CLOUD_MODE) initLetterPush()

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

  // -- Metrics registry: periodic flush of windowed histograms (http/llm/tool/
  //    search/event-loop latencies) into `obs` wide log lines. The live registry
  //    is served at GET /api/metrics. --
  try {
    const { startMetricsFlush } = await import('../core/observability/metrics.js')
    startMetricsFlush()
  } catch (err) {
    log.web.warn('metrics flush loop not started', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- Audio transcription + capture (macOS ScreenCaptureKit — not on cloud) --
  if (CLOUD_MODE) {
    log.web.info('cloud mode: skipping audio transcriber + capture resume')
  } else {
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

    // -- STT prewarm (opt-in): load dictation models now, not on first use --
    void (async () => {
      const { getConfig } = await import('../core/config-manager.js')
      const config = await getConfig()
      if (!config.stt?.prewarm_on_start) return
      const { prewarmSttEngines } = await import('../core/stt/index.js')
      await prewarmSttEngines(config)
    })().catch((err) => {
      log.web.warn('STT prewarm failed', { error: err instanceof Error ? err.message : String(err) })
    })
  }

  // -- Startup timing: track each phase to diagnose slow startups --
  const startupT0 = Date.now()
  const startupPhase = (name: string) => {
    const elapsed = Date.now() - startupT0
    log.web.info(`startup: ${name}`, { elapsedSinceListenMs: elapsed })
  }

  // Pull after listen without gating HTTP. Once any remote outbox/projection is
  // reconciled, broadcast the existing bulk task signal so early clients fetch
  // the post-pull source of truth.
  if (!isEphemeral) {
    void gitPullWalnut()
      .then(async () => {
        startupPhase('background git pull done')
        const { reconcileAfterPull } = await import('../core/task-outbox.js')
        await reconcileAfterPull()
        bus.emit(
          EventNames.TASK_UPDATED,
          { task: null } as any,
          ['web-ui'],
          { source: 'startup-git-pull' },
        )
      })
      .catch((err) => {
        log.git.warn('startup git pull failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }

  // -- Reconcile zombie sessions + identify reconnectable ones --
  // Cloud mode: no daemon to reconcile against — sessions.json is read-only
  // synced state from the Mac; touching it here would mark live Mac sessions dead.
  let reconnectable: import('../core/types.js').SessionRecord[] = []
  // Sessions whose process did NOT survive — handed to auto-recover once its
  // watcher is up (it starts later in boot, so the list has to wait here).
  let reconciledDead: import('../core/types.js').SessionRecord[] = []
  if (CLOUD_MODE) {
    log.session.info('cloud mode: skipping session reconciliation')
  } else try {
    const { reconcileSessions } = await import('../core/session-reconciler.js')
    const result = await reconcileSessions()
    reconnectable = result.reconnectable
    reconciledDead = result.dead
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

  // -- Session↔task referential integrity (detect only, never repair) --
  // Counts orphaned session.task_id pointers AND duplicate remote sync ids. Both
  // corruptions are silent by nature: an orphaned session is invisible on every
  // task surface, and duplicate rows only reveal themselves when one twin is
  // deleted and strands its sessions. A 2026-08-20 sweep found 254 orphans and 69
  // duplicate groups that had built up unnoticed over ~6 months. Repair needs a
  // human to classify each row (scripts/repair-orphan-session-links.mjs), so this
  // only reports. Cloud mode is skipped: a replica's sessions.sqlite is synced
  // read-only state, and its task projection legitimately lags the primary.
  if (!CLOUD_MODE) {
    try {
      const { checkSessionTaskIntegrity } = await import('../core/session-integrity.js')
      const report = await checkSessionTaskIntegrity()
      startupPhase(`session integrity check done (${report.orphanedSessions} orphans, ${report.duplicateRemoteIdGroups} dup groups)`)
    } catch (err) {
      log.session.debug('session integrity check failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
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

  // (Dream directory init removed with the retired dream loop — topics/ and
  // index.md are legacy; the skills/ tree is the knowledge store now.)

  // -- Filesystem watcher for the markdown roots --
  // The search index itself is wired below; this is only the fs.watch leg that
  // feeds it (and the notes structural reconciler). It must run even when the
  // index is off: git-synced notes never pass through a write route, so
  // without file events a synced note stays unsearchable until the next
  // restart's drift scan (a note saved from the phone was invisible to the
  // phone's own search minutes later, dogfood R14).
  if (process.env.WALNUT_DISABLE_SEARCH === '1') {
    log.memory.info('search indexing disabled via WALNUT_DISABLE_SEARCH=1 — keyword-only search')
  }
  try {
    const { startNotesWatcher } = await import('../core/notes-watcher.js')
    // semantic:false = structural only (cloud replica / indexing disabled):
    // the notes reconciler still runs, nothing feeds the search index.
    const semantic = process.env.WALNUT_DISABLE_SEARCH !== '1' && !CLOUD_MODE
    notesWatcherHandle = startNotesWatcher({ semantic })
    log.memory.info('notes/memory watcher started', { semantic })
  } catch (err) {
    log.memory.warn('notes/memory watcher failed to start', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── Search index wiring (hybrid-search) ──
  // Primary only: on a cloud replica the embed model would pin the instance.
  // The outer check keeps a disabled host from loading the wiring module
  // (and its better-sqlite3 chain) at all.
  if (process.env.WALNUT_DISABLE_SEARCH !== '1' && !CLOUD_MODE) {
    try {
      const wiring = await import('../core/search/wiring.js')
      if (wiring.isSearchV2Enabled()) {
        searchV2WiringHandle = wiring.startSearchV2Wiring(bus)
        log.memory.info('search-v2 wiring started')
      }
    } catch (err) {
      log.memory.warn('search-v2 startup failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // -- Git auto-commit polling (30s interval) --
  // Skip for ephemeral servers — they use a temp copy of data, no need to backup
  if (!isEphemeral) {
    gitAutoCommitHandle = startGitAutoCommit()

    // Disk watermark monitor: warn at 80% used, block writes (507) + git
    // pull-only at 90% (see src/core/disk-watermark.ts). Runs on every
    // non-ephemeral box — the 2026-08-12 ENOSPC outage hit the cloud
    // companion, but the primary box has the same failure mode.
    const { startDiskWatermarkMonitor } = await import('../core/disk-watermark.js')
    diskWatermarkHandle = startDiskWatermarkMonitor({
      // Both levels share the 'disk' condition: freeing space fixes them
      // together, so one recovery signal retires whichever card is showing.
      notify: (title, body, dedupScope) => {
        void publishErrorNotification({ title, body, dedupScope, recoveryKey: 'disk' })
      },
      // Already an edge (the module only calls this when the level CHANGES to
      // ok), so no transition tracker is needed on this side.
      onRecovered: () => { void publishRecovery(['disk']) },
    })

    // Scheduled git maintenance (weekly / size-triggered): sweeps the debris
    // killed git processes leave behind (tmp packs, orphaned .keep pins,
    // receive-pack quarantine dirs, stale gc.log) and runs a niced,
    // single-threaded gc on the data worktree — plus the bare hub repo and
    // stale deploy bundles on the cloud box. The 2026-08-12 disk-full outage
    // was exactly this debris accumulating with no one ever gc'ing.
    const { startGitMaintenance } = await import('../integrations/git-maintenance.js')
    gitMaintenanceHandle = startGitMaintenance()

    // Send-path canary (cloud box only — returns null elsewhere): evaluates
    // the exact gates a phone send passes (disk-guard 507, bridge sockets,
    // banked queue) every 5 min and notifies on degradation TRANSITIONS,
    // naming the failing hop. Born from 2026-08-21: the disk crossed the 90%
    // watermark and the user discovered it by watching their sends fail.
    const { startSendPathCanary } = await import('../core/send-path-canary.js')
    sendPathCanaryHandle = startSendPathCanary({
      notify: (title, body, dedupScope) => {
        // The canary computes its own edges: 'canary:recovered' is the
        // all-clear alert, which maps to the condition system's recovery for
        // every canary card (they share the 'send-path' condition) instead of
        // becoming yet another card.
        if (dedupScope === 'canary:recovered') {
          void publishRecovery(['send-path'])
          return
        }
        void publishErrorNotification({ title, body, dedupScope, recoveryKey: 'send-path' })
      },
    })

    // Task projection export (primary box only): tasks.sqlite is machine-
    // local, so a slim projection is written to cache/projections/ and
    // bridge-pushed to the cloud companion, which serves it at
    // GET /api/v1/tasks (legacy git-synced tasks/projection.json rides along
    // while sync.legacy_projection_files is on). Cloud mode only reads.
    if (!CLOUD_MODE) {
      // S3 backup scheduler (primary box only): a cloud replica backing up its
      // git-synced copy would race the primary and double-pay for uploads.
      // Self-gates on config backup.enabled; the routes 400 when unset here.
      const { startBackupScheduler } = await import('../core/backup/backup-scheduler.js')
      backupSchedulerHandle = startBackupScheduler({
        emit: broadcastEvent,
        notify: (n) => publishErrorNotification(n),
        // The scheduler owns the transition gate (it holds consecutiveFailures),
        // so this only ever fires on a failing→success edge.
        onRecovered: () => { void publishRecovery(['backup']) },
      })
      setBackupScheduler(backupSchedulerHandle)

      // Keep-Awake (macOS console only): holds the Mac awake while local CLI
      // sessions run — opt-in via config keep_awake.enabled, released on low
      // battery / prolonged offline. See src/core/keep-awake.ts.
      if (process.platform === 'darwin') {
        const { startKeepAwakeMonitor } = await import('../core/keep-awake.js')
        keepAwakeHandle = startKeepAwakeMonitor({
          notify: (title, body, dedupScope) => {
            // lifecycle: one-shot — "assertion released" is a completed past
            // event, not an ongoing condition; there is nothing to recover.
            // The 48h keyless debris sweep is its terminal point.
            void publishErrorNotification({ title, body, dedupScope })
          },
        })
      }

      // Model catalog freshness: settings.json edits invisibly change the CLI
      // model menu (live CLIs hot-reload it). Watch the file and force one
      // live local session to refetch — that pushes the new catalog to every
      // picker and rewrites the host store.
      const { watchClaudeSettings } = await import('../core/claude-settings-watcher.js')
      claudeSettingsWatcherStop = watchClaudeSettings(() => {
        sessionRunner.refreshLocalModelCatalogs()
      })

      const { startTaskProjectionExport } = await import('../core/task-projection.js')
      taskProjectionHandle = startTaskProjectionExport()
      // Session projection rides the same pipeline: sessions.json is
      // machine-local, so a slim session projection reaches the companion
      // (cache write + bridge push; legacy git file while
      // sync.legacy_projection_files is on) for the read-only GET /api/v1/sessions.
      const { startSessionProjectionExport } = await import('../core/session-projection.js')
      sessionProjectionHandle = startSessionProjectionExport()
      // Self-heal: every 5 min re-push both projections + alive-session
      // transcript tails from the local cache files, bounding cloud staleness
      // after a bridge outage (per-write pushes are fire-and-forget).
      const { startProjectionCacheSelfHeal } = await import('../core/projection-cache.js')
      projectionSelfHealHandle = startProjectionCacheSelfHeal()

      // Auto-continue: recover a turn that died to upstream retry exhaustion by
      // scheduling one delayed `continue` nudge (b12 retry hardening). Primary box
      // only — the cloud replica proxies sessions and must not double-fire.
      // hooks.overrides['session-auto-continue'].enabled=false wins over the env
      // default (the module itself only reads WALNUT_AUTO_CONTINUE_*).
      const { getConfig: getAcConfig } = await import('../core/config-manager.js')
      const autoContinueOverride = (await getAcConfig()).hooks?.overrides?.['session-auto-continue']?.enabled
      if (autoContinueOverride === false) {
        log.web.info('session auto-continue disabled via hooks.overrides')
      } else {
        const { startSessionAutoContinue } = await import('../core/session-auto-continue.js')
        autoContinueHandle = startSessionAutoContinue()
      }

      // Auto-recover: bring back sessions whose EXECUTION HOST or daemon died
      // under them (weekly patch reboot, tunnel death, daemon upgrade). The
      // daemon's own turn-retry cannot cover this — it dies with the host — so
      // the Mac owns it. Primary box only, same reason as auto-continue.
      // hooks.overrides['session-auto-recover'].enabled=false wins over the env.
      const autoRecoverOverride = (await getAcConfig()).hooks?.overrides?.['session-auto-recover']?.enabled
      if (autoRecoverOverride === false) {
        log.web.info('session auto-recover disabled via hooks.overrides')
      } else {
        const { startSessionAutoRecover, scheduleSessionAutoRecover } =
          await import('../core/session-auto-recover.js')
        autoRecoverHandle = startSessionAutoRecover()
        // Catch-up pass: sessions the startup reconciler found dead. Their cause
        // is 'server_restart' (infra), so a Walnut restart that outlived a CLI no
        // longer needs a human to retype the last request. Each candidate still
        // has to clear every guard (task IN_PROGRESS, budget, per-host stagger).
        let armed = 0
        for (const rec of reconciledDead) {
          if (scheduleSessionAutoRecover(rec, 'server_restart')) armed++
        }
        if (reconciledDead.length > 0) {
          log.web.info('auto-recover startup catch-up', {
            candidates: reconciledDead.length, armed,
          })
        }
      }
    } else {
      // Cloud box: two-way task sync. Writer half (Phase 4) — every local task
      // mutation is pushed to the primary SYNCHRONOUSLY over the bridge RPC
      // (`server.tasks.apply`), NOT written into git. A failed RPC falls back to
      // the non-git queue under cache/task-queue/ (and, only for an old primary
      // that predates the action, additionally to the legacy git outbox file);
      // see core/task-queue.ts for the full ladder. This subscriber is the ONE
      // interception point for every task write — REST routes, batch phase
      // endpoints and Personal AI tools alike — so routes stay unaware.
      //
      // Reader half (projection import) is triggered by the Phase 3 bridge push
      // (events-v1) and by reconcileAfterPull() from the auto-commit loop below.
      const { importProjectionOnCloud } = await import('../core/task-outbox.js')
      const { dispatchTaskOp, startTaskQueueFlush } = await import('../core/task-queue.js')
      bus.subscribe('task-outbox', (event) => {
        // Ops the apply path itself produced (import/apply) are event-silent, but
        // guard on source anyway in case that ever changes — echoing an applied
        // op back to the primary would be an infinite round trip.
        if (event.source === 'cloud-outbox') return
        const data = event.data as {
          task?: import('../core/types.js').Task; id?: string
          // Additive op-scoping extras some emitters attach (see task-queue.ts):
          // fields = Task keys the mutation actually set (scopes the primary-side
          // patch so replica-blind blobs are never wiped); appendNote = an
          // append-style note entry the primary must CONCATENATE, not replace.
          fields?: string[]; appendNote?: string
          // task:reordered payload (whole-list order, no per-row snapshot).
          project?: string; taskIds?: string[]; pins?: boolean
        }
        if (event.name === EventNames.TASK_DELETED) {
          if (data.id) void dispatchTaskOp({ type: 'delete', id: data.id })
        } else if (event.name === EventNames.TASK_CREATED) {
          if (data.task) void dispatchTaskOp({ type: 'create', task: data.task })
        } else if (event.name === EventNames.TASK_REORDERED) {
          if (!Array.isArray(data.taskIds) || data.taskIds.length === 0) return
          if (data.pins) void dispatchTaskOp({ type: 'reorder-pins', taskIds: data.taskIds })
          else if (typeof data.project === 'string') {
            void dispatchTaskOp({ type: 'reorder', project: data.project, taskIds: data.taskIds })
          }
        } else if (data.task) {
          void dispatchTaskOp({
            type: 'update', task: data.task,
            ...(Array.isArray(data.fields) && data.fields.length > 0 ? { touched: data.fields } : {}),
            ...(typeof data.appendNote === 'string' && data.appendNote ? { append: { note: data.appendNote } } : {}),
          })
        }
        // Interest is the EXACT primary-write event set — derived events
        // (task:phase-changed rides beside every completed/updated emit) would
        // dispatch the same change twice.
      }, {
        global: true,
        interest: ['task:created', 'task:updated', 'task:completed', 'task:deleted', 'task:reordered'],
      })
      // Drain ops banked during a bridge outage: every 60s (the floor for a
      // quiet box) plus opportunistically after any successful RPC.
      taskQueueFlushHandle = startTaskQueueFlush()
      // Session-metadata patches accepted while the bridge was down ride their
      // own durable queue (core/control-queue.ts) — same drain triggers.
      const { startControlQueueFlush } = await import('../core/control-queue.js')
      controlQueueFlushHandle = startControlQueueFlush()
      // Phone sends accepted while the session's host had no bridge ride their
      // own durable queue (core/send-queue.ts) — same drain triggers, so a
      // banked message reaches the CLI on reconnect with no human retry.
      const { startSendQueueFlush } = await import('../core/send-queue.js')
      sendQueueFlushHandle = startSendQueueFlush()
      // Seed the local replica from the synced projection shortly after boot.
      setTimeout(() => { void importProjectionOnCloud() }, 5_000)
    }

    // Git history compaction rewrites local refs — running it on BOTH the Mac
    // and the cloud companion would make their histories diverge. The Mac stays
    // the sole compactor; the cloud box only commits/pulls/pushes.
    if (CLOUD_MODE) {
      log.git.info('cloud mode: skipping git history compaction (Mac is the sole compactor)')
    } else {
      // Recover from any crashed compaction, then schedule if due
      const { recoverFromCrashedCompaction } = await import('../integrations/git-compaction.js')
      recoverFromCrashedCompaction()
      // Compaction runs in a FORKED WORKER (dist/workers/git-compaction-worker.js):
      // it is execSync-based and took 303s on the real 89k-commit repo — inline
      // that would freeze the event loop for minutes. The worker self-gates on
      // isCompactionDue(), so the daily re-check is a no-op until due.
      // Failures MUST escalate to a notification, not just a warn line: a
      // paging bug (ENOBUFS) silently killed every compaction run for months —
      // the data repo grew to 15GB/161k commits and each 30s sync tick's push
      // repacked 5.2GB, starving the whole machine (2026-07-25, load avg 211).
      const { fork } = await import('node:child_process')
      const { fileURLToPath } = await import('node:url')
      const workerPath = (() => {
        const baseDir = path.dirname(fileURLToPath(import.meta.url))
        const candidates = [
          path.join(baseDir, 'workers', 'git-compaction-worker.js'),
          path.join(baseDir, '..', 'workers', 'git-compaction-worker.js'),
          path.join(process.cwd(), 'dist', 'workers', 'git-compaction-worker.js'),
        ]
        return candidates.find((c) => fs.existsSync(c)) ?? null
      })()
      // `scope` splits the two root causes the caller already distinguishes: a
      // MISSING worker build (a packaging bug — fixed by a rebuild) vs a real RUN
      // failure (tree mismatch, ENOBUFS). One dedupScope for both would let
      // whichever fires first hide the other behind its card.
      // Compaction has its OWN condition key, not the git family's.
      //
      // Round-1 bug: these cards carried 'git', so the auto-commit tick's
      // failing→healthy edge retired them. Those are different conditions on
      // different clocks — auto-commit runs every 30s and compaction once a day —
      // so a perfectly healthy commit tick was silently marking a compaction that
      // is STILL broken as recovered, which is worse than never recovering it: the
      // user is told the repo-growth problem is fixed while it keeps growing.
      // Both compaction scopes share one key (missing-worker vs run are two causes
      // of one condition, and a successful run disproves both).
      const COMPACTION_RECOVERY_KEY = 'git:compaction'
      const reportCompactionFailure = (failure: string, scope: 'missing-worker' | 'run'): void => {
        log.git.warn('git compaction failed', { error: failure })
        void publishErrorNotification({
          title: 'Data Repo Compaction Failing',
          body: `Git history compaction failed: ${failure}. The data repo will grow unbounded until this is fixed — check open-walnut logs -s git.`,
          dedupScope: `git:compaction:${scope}`,
          recoveryKey: COMPACTION_RECOVERY_KEY,
        })
      }
      const attemptCompaction = async (retriesLeft = 2): Promise<void> => {
        if (!workerPath) {
          reportCompactionFailure('compaction worker build is missing from dist/workers', 'missing-worker')
          return
        }
        // Pause the 30s auto-commit/sync tick IN THIS PROCESS for the worker's
        // whole lifetime. The worker sets compactionInProgress too, but that's
        // its own forked memory — it pauses nothing here. When only the worker
        // set it, ticks kept moving `main` mid-rewrite and every run failed
        // tree verification for 9 days straight (the repo regrew to 6.5GB and
        // its pushes CPU-starved the cloud companion, 2026-08 incident).
        const { setCompactionInProgress, waitForSyncSettled } = await import('../integrations/git-sync.js')
        setCompactionInProgress(true)
        await waitForSyncSettled() // a tick already in flight still moves main — let it drain first
        const child = fork(workerPath, [], { stdio: 'ignore' })
        let reply: { ok: boolean; result?: { skipped?: boolean; before: number; after: number; error?: string }; error?: string } | null = null
        child.on('message', (msg) => { reply = msg as typeof reply })
        // 'error' without 'exit' (spawn failure) must not leave the tick
        // paused forever — that would silently stop ALL data backups.
        child.on('error', (err) => {
          setCompactionInProgress(false)
          reportCompactionFailure(`compaction worker failed to spawn: ${err.message}`, 'run')
        })
        child.on('exit', () => {
          setCompactionInProgress(false)
          const result = reply?.ok ? reply.result : null
          if (result && !result.skipped && !result.error) {
            log.git.info('git compaction complete', { before: result.before, after: result.after })
            // A completed run is the ONLY honest proof the compaction condition is
            // gone, so this is where its cards retire. Not transition-gated: this
            // path runs once a day at most (a `skipped`/not-due reply returns
            // below without reaching here), so a store scan per success is free —
            // the tracker exists for 30s polls, not for a daily job.
            void publishRecovery([COMPACTION_RECOVERY_KEY])
            return
          }
          // result.error (e.g. tree-verification mismatch) is returned, not
          // thrown — treat it as a failure too or it stays invisible.
          const failure = result?.error ?? (reply && !reply.ok ? reply.error ?? 'unknown error' : null)
          if (!failure) return // skipped / not due — normal
          // Lock contention with the 30s auto-commit tick is transient — retry
          // off-phase instead of alerting (45s keeps us misaligned with the tick).
          if (isLockContention(new Error(failure)) && retriesLeft > 0) {
            log.git.debug('git compaction hit lock contention — retrying', { retriesLeft })
            setTimeout(() => { void attemptCompaction(retriesLeft - 1) }, 45_000).unref?.()
            return
          }
          reportCompactionFailure(failure, 'run')
        })
      }
      // 75s start delay: deliberately NOT a multiple of the 30s sync tick —
      // at 60s the two collided on index.lock at every single boot.
      setTimeout(() => { void attemptCompaction() }, 75_000)
      setInterval(() => { void attemptCompaction() }, 24 * 60 * 60 * 1000).unref?.()
    }
  }

  // -- Init Hook Dispatcher (unified: session + task + cron domains) --
  // Deliberately BEFORE subagentRunner/sessionRunner init: those can start
  // emitting bus events (reconnect replays, plugin sync mutating tasks) and
  // hooks registered after the fact would silently miss them.
  try {
    const { SessionHookDispatcher, builtinHooks, discoverFileHooks, setSessionHookDispatcher } = await import('../core/session-hooks/index.js')
    const { loadConfigHooks, mergedOverrides } = await import('../core/hooks/config-hooks.js')
    const { getConfig: getHooksConfig } = await import('../core/config-manager.js')
    const bootConfig = await getHooksConfig()
    if (bootConfig.hooks?.enabled === false) {
      log.web.info('hook dispatcher disabled via config hooks.enabled=false')
    } else {
      const fileHooks = await discoverFileHooks()
      const buildDefs = (cfg: typeof bootConfig) =>
        [...builtinHooks, ...fileHooks, ...loadConfigHooks(cfg)]
      const buildCfg = (cfg: typeof bootConfig) =>
        ({ ...cfg.session_hooks, overrides: mergedOverrides(cfg) })
      const hookDispatcher = new SessionHookDispatcher(buildCfg(bootConfig))
      // Cloud replica: session domain stays live (session hooks are display/triage
      // side), but task/cron actions must not double-fire — the primary already
      // dispatches them for the same phase change arriving via task sync.
      const domains = CLOUD_MODE ? (['session'] as const) : undefined
      hookDispatcher.init(buildDefs(bootConfig), buildCfg(bootConfig), domains ? { domains: [...domains] } : undefined)
      setSessionHookDispatcher(hookDispatcher)
      // Live reload on config change: pure in-memory recompute of defs/overrides
      // (no resubscribe; .mjs files are NOT re-scanned — restart for those).
      // global+interest instead of a name in PUT /api/config's destination list:
      // other config writers emit to ['web-ui'] only and would miss a named sub.
      bus.subscribe('hook-dispatcher-reload', () => {
        void getHooksConfig().then((cfg) => {
          hookDispatcher.reload(buildDefs(cfg), buildCfg(cfg))
        }).catch((err) => {
          log.web.warn('hook dispatcher reload failed', { error: err instanceof Error ? err.message : String(err) })
        })
        // Daemon-runtime hooks ride the same trigger: recompile the YAML rules
        // and hot-push to every connected daemon (hash-skipped when unchanged).
        void import('../providers/daemon-connection.js').then(({ pushDaemonHooksToAllHosts }) => {
          pushDaemonHooksToAllHosts()
        }).catch(() => {})
      }, { global: true, interest: ['config:changed'] })
      log.web.info('hook dispatcher initialized', { cloudMode: CLOUD_MODE })
    }
  } catch (err) {
    log.web.error('hook dispatcher init failed — session triage and lifecycle hooks will NOT fire', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // -- expect_reply deadline sweeper (primary only) --
  // The phase-edge hook above is a HINT; this sweep is the guarantee: a pending
  // session-request whose target never produced an edge (killed daemon, stale
  // result gate, host offline) still notifies the asker at its deadline.
  if (!CLOUD_MODE) {
    const sweep = setInterval(() => {
      void import('../core/sessions/session-request-notify.js')
        .then(({ sweepSessionRequests }) => sweepSessionRequests())
        .then((n) => { if (n > 0) log.session.info('session-request sweep notified askers', { count: n }) })
        .catch((err) => log.session.warn('session-request sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        }))
    }, 60_000)
    sweep.unref?.()
  }

  // -- Lane orphan recovery (answers stranded by a mid-turn server death) --
  // A deploy/crash that kills the server mid Personal AI lane turn leaves the
  // CLI alive: it finishes the answer and writes it to its stream file, but the
  // code that persists it into the conversation died with the process, and
  // re-attach skips replay by design. Nothing else ever re-checks, so the
  // conversation is left reading user→user (2 of 14 relayed phone turns over two
  // days). This pass pairs each orphaned user message with the result that sits
  // in ITS turn slot in the stream and adopts it.
  //
  // Spaced passes, not one: the surviving CLI usually writes its result a few
  // SECONDS AFTER the replacement server is already up, so a single boot-time
  // pass would find nothing. Adoption is idempotent, so re-running is free.
  // Fully detached + individually caught — a healer must never affect startup.
  if (!CLOUD_MODE) {
    const laneOrphanPassesMs = [8_000, 60_000, 300_000]
    for (const delayMs of laneOrphanPassesMs) {
      const timer = setTimeout(() => {
        void (async () => {
          try {
            // No client-notify hook on purpose: a recovered turn ended long ago,
            // and every terminal frame this server can send would settle the
            // turn that is live NOW (see the emit note in lane-orphan-recovery).
            // The reconciler emits its own advisory bus event; clients pick the
            // adopted message up on their next history read.
            const { reconcileLaneOrphanTurns } = await import('../core/sessions/lane-orphan-recovery.js')
            const report = await reconcileLaneOrphanTurns()
            if (report.adopted > 0 || report.orphansFound > 0) {
              log.web.info('lane orphan recovery pass', { delayMs, ...report })
            }
          } catch (err) {
            log.web.warn('lane orphan recovery pass failed', {
              delayMs, error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }, delayMs)
      timer.unref?.()
    }
  }

  // -- Pin retirement (completed pins expire off the board) --
  // task_create pins by default and completion deliberately does NOT unpin, so
  // without a clock the pinned set only grows: measured 2026-08-31 on the live
  // box, 1,237 pins of which 91 were open work, and the Focus tier alone held
  // 703 rows for 16 real tasks. The sweep unpins any COMPLETED pin finished more
  // than `tasks.pin_retirement_days` (default 3) ago; the FIRST run is therefore
  // also the one-time cleanup of the accumulated backlog (no migration script).
  //
  // Primary only: task rows on the replica are a projection of these, so a sweep
  // there would race the import and be overwritten by it.
  if (!CLOUD_MODE) {
    void (async () => {
      try {
        const { sweepPinRetirement, PIN_RETIREMENT_SWEEP_INTERVAL_MS, PIN_RETIREMENT_BOOT_DELAY_MS } =
          await import('../core/task-pin-retirement.js')
        const { runPeriodic } = await import('../core/periodic-task.js')
        // runPeriodic (the mandatory shape for periodic background work) gives
        // the reentrancy lock, the per-tick budget the chunked sweep checks
        // between chunks, stall attribution by name, and jitter. Its first tick
        // is one interval away, so the boot pass is an explicit early kick.
        pinRetirementHandle = runPeriodic('pin-retirement', PIN_RETIREMENT_SWEEP_INTERVAL_MS, 60_000, async (ctx) => {
          const report = await sweepPinRetirement({ shouldStop: () => ctx.overBudget() })
          if (report.retired > 0 || report.stoppedEarly) {
            log.web.info('pin retirement pass', {
              retired: report.retired, candidates: report.candidates,
              scanned: report.scanned, days: report.days,
              oldestKept: report.oldestKept, stoppedEarly: report.stoppedEarly,
            })
          }
        })
        const kick = setTimeout(() => { pinRetirementHandle?.kick?.() }, PIN_RETIREMENT_BOOT_DELAY_MS)
        kick.unref?.()
      } catch (err) {
        log.web.warn('pin retirement wiring failed — completed pins will not retire', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()
  }

  // -- Init SubagentRunner + SessionRunner --
  subagentRunner.init()
  sessionRunner.init(reconnectable)

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
        // The fallback decision is FINAL for this server run: setSdkClient() was
        // never called, so even a later successful reconnect would connect an
        // orphaned client nobody uses. Without destroy() the ws 'close' handler
        // (wired inside connect()) keeps exponential-backoff reconnecting for 10
        // attempts against a port nothing listens on — ~50 warn/info log lines
        // per boot of pure noise (observed live with session_server.enabled=true
        // but no server on the port).
        sdkClient.destroy()
      }
    }
  } catch (err) {
    log.session.debug('session server client init skipped', {
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // Session health monitor / reapers probe local PIDs + daemons and mutate
  // sessions.json — on the cloud box that state belongs to the Mac (git-synced),
  // so running them would falsely mark live Mac sessions dead.
  if (CLOUD_MODE) {
    log.web.info('cloud mode: skipping session health monitor + session/recording reapers')
  } else {
    // -- Start session health monitor --
    healthMonitor = new SessionHealthMonitor()
    healthMonitor.start()
    startupPhase('health monitor started')

    // -- Start session-changes pre-warmer --
    // Computes every recent session's Changed-tab data in the background
    // (startup sweep + after each turn + periodic), strictly one at a time and
    // paced, so the first tab open never pays the 40-80s whale parse itself.
    const { SessionChangesPrewarmer } = await import('../core/session-changes-prewarm.js')
    changesPrewarmer = new SessionChangesPrewarmer()
    changesPrewarmer.start()

    // -- Start side-thread manager --
    // Side threads are taskless hidden forks, so no other reaper will ever touch
    // them: this owns their standby TTL, live cap and idle retirement, and sweeps
    // standbys orphaned by the previous process at boot.
    const { sideThreadManager } = await import('../core/sessions/side-thread-manager.js')
    sideThreadManager.start()

    // -- Start session reaper (periodic cleanup of high-volume triage session records) --
    sessionReaper = new SessionReaper()
    sessionReaper.start()

    // -- One-shot heal: stale pendingPermission on terminal sessions --
    // A permission request cannot outlive its CLI process, but until the
    // control_cancel_request handler existed nothing cleared the persisted
    // copy on dead sessions — leaving permanent "Waiting" badges and
    // unanswerable cards (incident a172ce49; 28 stale rows found). Runs after
    // listen, best-effort, off the startup critical path.
    // -- …then expire the NOTIFICATION half of those same dead requests --
    // The record-side clear above always left the durable notification
    // (`perm:<requestId>`) unresolved, and the panel reads unresolved as
    // "pending" — a permanent phantom in the Needs Action rail whose
    // Approve/Deny 404s. Both live death paths now stamp as they clear; this
    // sweep drains the BACKLOG. Chained after the heal (not parallel) so it
    // sees healed state and can't mistake a mid-heal row for a live pending one.
    import('../core/session-tracker.js')
      .then(({ healStalePendingPermissions }) => healStalePendingPermissions())
      .then(healed => {
        if (healed > 0) log.web.info('startup: healed stale pendingPermission rows', { healed })
      })
      .then(() => import('../core/notifications/permission-expiry.js'))
      .then(async ({ expireOrphanedPermissionNotifications, expireStaleErrorNotifications }) => {
        const expired = await expireOrphanedPermissionNotifications()
        if (expired > 0) log.web.info('startup: expired orphaned permission notifications', { expired })
        // -- …and the ERROR half of the same lifecycle problem --
        // An error card is about a CONDITION, and a condition needs a recovery
        // signal to retire it. Two families can never receive one: a session
        // error whose session is dead (no future turn will ever complete), and a
        // keyless record written before recoveryKey existed (nothing to signal
        // against). Both are stamped 'expired' here — see expireStaleErrorNotifications.
        const errors = await expireStaleErrorNotifications()
        if (errors.deadSession > 0 || errors.keylessDebris > 0 || errors.prunedResolved > 0) {
          log.web.info('startup: expired unresolvable error notifications', errors)
        }
        // The same reconcile, daily: a long-lived server (the cloud replica
        // runs for weeks) would otherwise never age out settled receipts or
        // newly-dead sessions between boots. Cheap — every sweep has a
        // lock-free pre-check, so a quiet day costs three file reads.
        notificationReconcileTimer = setInterval(() => {
          expireStaleErrorNotifications().catch(() => {})
        }, 24 * 60 * 60 * 1000)
        notificationReconcileTimer.unref?.()
      })
      .catch(err => log.web.warn('startup: pendingPermission heal failed', {
        error: err instanceof Error ? err.message : String(err),
      }))

    // -- Start recording reaper (periodic cleanup of old audio recordings) --
    {
      const { recordingReaper } = await import('../core/recording-reaper.js')
      recordingReaper.start()
      recordingReaperHandle = recordingReaper
    }

    // -- Start external-session importer --
    // Sessions a human started OUTSIDE Walnut (terminal `claude`, Claude
    // Desktop, codex TUI) are invisible to the UI. Each daemon scans its OWN
    // transcript dirs and returns a small list; the server files them under a
    // per-host holder task. Primary box only: the cloud replica has no exec
    // host of its own and would double-import through the bridge.
    {
      const { startExternalSessionImporter } = await import('../core/sessions/external-session-import.js')
      externalSessionImporter = startExternalSessionImporter()
    }
  }

  // -- Start overview maintainer (task lifecycle → project skill upkeep) --
  {
    const { startOverviewMaintainer } = await import('../agent/overview-maintainer.js')
    startOverviewMaintainer()
  }

  // -- Start project summary maintainer (task counts → fast-model project summaries) --
  {
    const { startProjectSummaryMaintainer } = await import('../core/project-summary.js')
    startProjectSummaryMaintainer()
  }

  // -- Wire bus subscriber to push events to WS clients --
  // Deliberately NON-global and with NO `interest` filter: it is gated purely by
  // each emit's `destinations`. So any event emitted to 'web-ui' reaches the
  // browser with zero wiring here — including project:created (ensureProject),
  // which is how the project lists update live. Don't add an interest allowlist:
  // that would silently drop every future web-ui event not listed in it.
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
    const { setOnDaemonStatusChange, getDaemonPoolStatus, addOnDaemonHostConnected } = await import('../providers/daemon-connection.js')
    const { getConfig } = await import('../core/config-manager.js')
    // Host link restored → retire every error card that outage produced, across
    // conditions (`task:…` session-start failures, `route:…` 5xx cards,
    // `session:…` delivery failures all share the `host:<alias>` causeKey).
    // setConnected(true) fires on TRANSITIONS only, so this is already
    // edge-gated; recoverNotifications' lock-free pre-check makes the common
    // "healthy reconnect, nothing to retire" case a single file read.
    // Release a previous registration first: a second in-process startServer()
    // would otherwise orphan the old listener AND let its stopServer() remove
    // the new one.
    unsubscribeHostRecovery?.()
    unsubscribeHostRecovery = addOnDaemonHostConnected((hostKey) => {
      if (hostKey === '__local__') return
      void publishRecovery([hostCauseKey(hostKey)])
    })
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
          // null = unknown / no cloud bridge configured for this host.
          bridgeConnected: activeMap.get(key)?.bridgeConnected ?? null,
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

  // -- Recent-task ledger (Personal AI context) --
  // Any task mutation invalidates the cached render; a fresh task gets its
  // one-liner generated in the background (cheap Haiku-tier call, fire-and-
  // forget — see task-ledger-desc.ts). Deliberately OUTSIDE the search block:
  // the ledger derives from the task store alone and must work with semantic
  // search disabled.
  bus.subscribe('task-ledger', (event) => {
    void import('../core/task-ledger.js').then(m => m.invalidateTaskLedger()).catch(() => {})
    if (event.name === EventNames.TASK_CREATED) {
      const taskId = (event.data as { task?: { id?: string } })?.task?.id;
      if (taskId) {
        void import('../core/task-ledger-desc.js')
          .then(m => m.scheduleLedgerDesc(taskId))
          .catch(() => { /* best-effort */ })
      }
    }
  }, { global: true, interest: ['task:created', 'task:updated', 'task:completed', 'task:deleted'] })

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

  // Short-circuit repeated delivery-failure notification writes during an outage.
  // The durable notification store also de-dupes by session + error text, while
  // the per-message retry state remains in the session panel.
  const deliveryFailureNotifiedAt = new Map<string, number>()
  const DELIVERY_FAILURE_NOTIFY_WINDOW_MS = 5 * 60_000

  // Sessions already checked for the "streaming ⇒ not awaiting human" invariant in
  // the CURRENT streaming run. Throttles the per-delta phase check to ONE getTask
  // per turn (deltas are high-frequency). Cleared when the run ends (markDone /
  // session:result / session:error) so the next turn re-checks. See the
  // session:text-delta handler below for why this lives on the delta path.
  const streamingPhaseChecked = new Set<string>()

  // Enforce the invariant "a session producing real output cannot be in WAIT"
  // at the SOLE point every streaming turn must pass through:
  // the text/thinking delta. The discrete session:status-changed{running} signal
  // MISSES pure-text turns — claude-code-session.ts emits text-delta WITHOUT an
  // accompanying emitStatusChanged('IN_PROGRESS') (only init / ExitPlanMode / mode
  // changes emit that), so a task left stuck at WAIT by a transient
  // session:error never gets corrected while the agent visibly streams text. A
  // real delta is ground truth that the CLI is producing output right now (replay
  // is deduped upstream via _emittedStreamKeys, so this only fires on live output).
  // sessionStreamingPhase() only touches WAIT → a genuinely
  // human-paused task is never disturbed unless output actually resumes.
  const enforceStreamingPhase = (sessionId: string, taskId?: string, replayed?: boolean): void => {
    if (!taskId || streamingPhaseChecked.has(sessionId)) return
    // A positionally-replayed delta must not consume the once-per-run check —
    // a LIVE delta arriving later in the same run still needs its chance to raise.
    if (replayed === true) return
    streamingPhaseChecked.add(sessionId)
    void (async () => {
      try {
        // Guard (incident 10e7df54): a daemon REPLAY delta must never raise the phase.
        // After a server restart the fresh session object has an empty stream-dedup set,
        // so replayed deltas pass upstream dedup and land here looking like live output —
        // in that incident one raised WAIT back to IN_PROGRESS on a session
        // whose turn had already ended, wedging the task.
        //
        // The verdict is POSITIONAL when available: `replayed` carries the emitter's
        // v-vs-consumedOffset comparison (same yardstick as the live result/idle
        // replay guards). replayed===false is ground truth that the CLI is producing
        // positionally NEW output right now, so the raise may proceed even off a
        // settled/error record — this is the self-heal for a record wrongly converged
        // to error while the turn was still running (inc-1783644415695: a stale
        // record-status check here kept the false error pinned forever).
        // Only without positional info (legacy emit paths) fall back to the record
        // check: live output normally rides a record flipped 'running' at send time
        // (writeMessage persists it before the first delta can arrive).
        // (replayed===true already returned above, before consuming the check.)
        const {
          emitSessionStatusChanged,
          getSessionByClaudeId,
          updateSessionRecordConditionally,
        } = await import('../core/session-tracker.js')
        const record = await getSessionByClaudeId(sessionId)
        if (replayed === undefined) {
          if (record && record.process_status !== 'running') {
            log.web.info('skipping streaming-phase raise: record not running (replayed delta)', {
              taskId, sessionId, processStatus: record.process_status,
            })
            return
          }
        } else if (record?.process_status === 'error') {
          // Record self-heal: positionally NEW output on an 'error' record means
          // the error verdict was wrong (or is stale) — the CLI is demonstrably
          // working right now. Flip it back to running and clear the pinned
          // banner. Scoped to 'error' ONLY: an 'idle' record with new bytes is
          // the normal background-subagent-after-turn-end shape and must stay
          // idle. If the error was real, the (positionally new) error result
          // will re-converge the record right back — self-correcting.
          const healed = await updateSessionRecordConditionally(
            sessionId,
            {
              process_status: 'running',
              errorMessage: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'streaming_evidence_self_heal',
              status_changed_by: 'system',
            },
            (current) => current.process_status === 'error',
          )
          if (healed) {
            log.web.warn('streaming-evidence self-heal: error record revived by positionally-new output', {
              taskId, sessionId,
            })
            emitSessionStatusChanged(
              healed,
              {},
              ['*'],
              { source: 'server:stream-delta', urgency: 'urgent' },
            )
          }
        }
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
      const { sessionId, taskId, delta, msgId, parentToolUseId, subagentType, taskDescription, replayed } = eventData<'session:text-delta'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendTextDelta(sessionId, delta, msgId, parentToolUseId, subagentType, taskDescription)
        sendStreamEvent(sessionId, event.name, event.data)
        enforceStreamingPhase(sessionId, taskId, replayed)
      }
    } else if (event.name === 'session:tool-use') {
      const { sessionId, toolName, toolUseId, input, planContent, parentToolUseId, subagentType, taskDescription } = eventData<'session:tool-use'>(event)
      if (sessionId) {
        // DUP-DEBUG: server.ts is the choke point between bus.emit and SSE
        // fan-out. If the same toolUseId reaches this branch twice, the
        // duplication originates at or before bus.emit (= claude-code-session
        // / RSM / daemon). If it arrives once but the UI still shows two,
        // duplication is in stream buffer or frontend.
        log.ws.debug('server: session:tool-use received', {
          sessionId, toolUseId, toolName, parentToolUseId,
        })
        sessionStreamBuffer.appendToolUse(sessionId, toolUseId, toolName, input, planContent, parentToolUseId, subagentType, taskDescription)
        sendStreamEvent(sessionId, event.name, event.data)
        enforceStreamingPhase(sessionId, eventData<'session:tool-use'>(event).taskId, eventData<'session:tool-use'>(event).replayed)
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
      const { sessionId, taskId, delta, msgId, parentToolUseId, replayed } = eventData<'session:thinking-delta'>(event)
      if (sessionId) {
        sessionStreamBuffer.appendThinkingDelta(sessionId, delta, msgId, parentToolUseId)
        sendStreamEvent(sessionId, event.name, event.data)
        enforceStreamingPhase(sessionId, taskId, replayed)
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
      const { sessionId, taskId, requestId, toolName, input, reason, acpOptions } = event.data as {
        sessionId?: string; taskId?: string; requestId?: string; toolName?: string;
        input?: Record<string, unknown>; reason?: string;
        acpOptions?: Array<{ optionId?: string; kind?: string; name?: string }>;
      }
      if (sessionId) {
        // Buffer the permission block so stream-subscribe snapshots include it
        if (requestId && toolName) {
          sessionStreamBuffer.appendPermission(sessionId, requestId, toolName, input, reason, acpOptions)
        }
        sendStreamEvent(sessionId, event.name, event.data)
        // Agent blocked on a human decision → the task goes red NOW
        // (session:awaiting-human → AGENT_COMPLETE), not when the turn ends.
        // 2026-08-18 user call: permission / AskUserQuestion / plan approval
        // all mean "agent 完事要等" — same handed-back semantics as a result.
        // Auto-approved prompts never reach this branch (bypass auto-allow and
        // ACP full-access answer before the bus emit). The 60s re-emit lands
        // here again but applySessionPhase no-ops on AGENT_COMPLETE.
        void (async () => {
          try {
            let phaseTaskId = taskId
            if (!phaseTaskId) {
              const { getSessionByClaudeId } = await import('../core/session-tracker.js')
              phaseTaskId = (await getSessionByClaudeId(sessionId))?.taskId ?? undefined
            }
            if (phaseTaskId) {
              const { applySessionPhase } = await import('../core/phase.js')
              await applySessionPhase(phaseTaskId, 'session:awaiting-human', 'server.ts:permission-request', { sessionId })
            }
          } catch (err) {
            log.web.warn('awaiting-human phase flip failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
          }
        })()
        // Persist to the durable notification feed (survives refresh). Fire-and-forget;
        // de-duped by requestId so the 60s permission re-ask never doubles the feed.
        // The in-memory set short-circuits a re-emit BEFORE the two lookups + the
        // store write, which would all end at that same dedup having changed nothing.
        if (requestId && toolName && !persistedPermissionRequestIds.has(requestId)) {
          void (async () => {
            const timestamp = Date.now()
            // Enrichment is best-effort context (host / friendly title / project):
            // a lookup failure must degrade the card, never drop the notification.
            let enrichment: { host?: string; sessionTitle?: string; project?: string; taskId?: string } = {}
            try {
              const { getSessionByClaudeId } = await import('../core/session-tracker.js')
              const sessionRecord = await getSessionByClaudeId(sessionId)
              const resolvedTaskId = taskId || sessionRecord?.taskId || undefined
              let sessionTitle = sessionRecord?.title || sessionRecord?.description || undefined
              let project = sessionRecord?.project || undefined
              if (resolvedTaskId) {
                try {
                  const task = await getTask(resolvedTaskId)
                  if (task?.title) sessionTitle = task.title
                  if (task?.project) project = task.project
                } catch { /* task gone / not a task-backed session — keep session labels */ }
              }
              enrichment = {
                ...(sessionRecord?.hostname || sessionRecord?.host ? { host: sessionRecord.hostname || sessionRecord.host } : {}),
                ...(sessionTitle ? { sessionTitle } : {}),
                ...(project ? { project } : {}),
                ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
              }
            } catch (err) {
              log.web.warn('permission notification enrichment failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
            }
            const compactInput = compactPermissionInput(toolName, input)
            const record = await addFeedNotification({
              kind: 'permission', severity: 'warning', title: toolName,
              body: summarizePermissionRequest(toolName, input), sessionId,
              timestamp,
              dedupKey: `perm:${requestId}`,
              requestId,
              toolName,
              ...(compactInput ? { input: compactInput } : {}),
              ...(reason ? { reason } : {}),
              ...(acpOptions ? { acpOptions } : {}),
              ...enrichment,
            })
            persistedPermissionRequestIds.add(requestId)
            // Insert detection via the store's contract: on a dedup hit it returns
            // the EXISTING record, so timestamps only match when this call created
            // it. The CLI's 60s re-ask must not re-toast connected UIs.
            if (record.timestamp === timestamp) {
              broadcastEvent('notification:new', record)
            }
          })().catch(err => log.web.warn('failed to persist permission notification', { sessionId, error: err instanceof Error ? err.message : String(err) }))
        }
      }
    } else if (event.name === 'session:permission-resolved') {
      const { sessionId, requestId, allowed, cancelled, expired } = event.data as {
        sessionId?: string; requestId?: string; allowed?: boolean; cancelled?: boolean; expired?: boolean;
      }
      if (sessionId) {
        // Update the buffered permission block status
        if (requestId) {
          persistedPermissionRequestIds.delete(requestId)
          sessionStreamBuffer.resolvePermission(sessionId, requestId, allowed ? 'allowed' : 'denied')
          // Stamp the outcome onto the feed record too, so the notification
          // center can show resolved permissions as settled (and hide the
          // approve/deny actions). Fire-and-forget like the add path. `allowed`
          // is optional on the event — skip the stamp rather than persist a
          // missing value as "denied" (the store's idempotence check would then
          // block a later correct stamp).
          //
          // A WITHDRAWN request (control_cancel_request, a daemon reconcile
          // dropping a stale ask, the terminal-transition expiry) gets
          // 'expired': nobody decided, so recording it as the user's "Denied"
          // would be a lie. cancelled/expired are checked FIRST for exactly
          // that reason — those emitters ALSO send `allowed: false` to keep the
          // event's required field populated, so a boolean-first branch would
          // swallow the flag and mislabel every withdrawal as a deny.
          const outcome: 'allowed' | 'denied' | 'expired' | null =
            (cancelled === true || expired === true) ? 'expired'
            : typeof allowed === 'boolean' ? (allowed ? 'allowed' : 'denied')
            : null
          if (outcome) {
            void resolvePermissionNotification(requestId, outcome)
              .catch(err => log.web.warn('failed to resolve permission notification', { sessionId, error: err instanceof Error ? err.message : String(err) }))
          }
          // Human answered (allow/deny/AskUserQuestion) → the agent resumes; pull
          // the red row back to IN_PROGRESS. NOT for 'expired': the session died
          // with the prompt open — nobody decided, nothing resumes, and the
          // handed-back AGENT_COMPLETE is exactly right.
          if (outcome === 'allowed' || outcome === 'denied') {
            void (async () => {
              try {
                const { getSessionByClaudeId } = await import('../core/session-tracker.js')
                const phaseTaskId = (event.data as { taskId?: string }).taskId
                  || (await getSessionByClaudeId(sessionId))?.taskId || undefined
                if (phaseTaskId) {
                  const { applySessionPhase } = await import('../core/phase.js')
                  await applySessionPhase(phaseTaskId, 'session:human-answered', 'server.ts:permission-resolved', { sessionId })
                }
              } catch (err) {
                log.web.warn('human-answered phase pullback failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
              }
            })()
          }
        }
        sendStreamEvent(sessionId, event.name, event.data)
      }
    } else if (event.name === 'session:usage-update') {
      const { sessionId, inputTokens } = eventData<'session:usage-update'>(event)
      if (sessionId) {
        sendStreamEvent(sessionId, event.name, event.data)
        // Token-truth feed for personal-ai-lane turns. On the in-process path the
        // loop's onUsage callback records the turn's EXACT input tokens (the
        // ground-truth half of effectiveTotalTokens); a lane turn never enters
        // that loop, so without this the conversation's compaction gate and
        // triage bail keep reasoning from the last in-process number — i.e.
        // from before the lane took over. The CLI's own usage payload is the
        // same measurement, so adopt it.
        //
        // Deliberately NOT awaited: this is the highest-frequency session event
        // (one per assistant message) and the stream push above must not queue
        // behind a record read.
        if (typeof inputTokens === 'number' && inputTokens > 0) {
          void (async () => {
            try {
              const { getSessionByClaudeId } = await import('../core/session-tracker.js')
              const rec = await getSessionByClaudeId(sessionId)
              const { parseLaneKey } = await import('../core/sessions/personal-ai-lane.js')
              const laneIds = parseLaneKey(rec?.lane)
              if (laneIds) recordLastTurnTokens(laneIds.conversationId, inputTokens)
            } catch { /* token truth is an optimization; a miss falls back to the estimate */ }
          })()
        }
      }
    } else if (event.name === 'session:model-catalog') {
      // Eager catalog push (fetched on init / invalidation refetch). Broadcast to
      // ALL clients, not just stream subscribers: the quick-session dropdown and
      // host-level caches need it without being subscribed to any session.
      broadcastEvent(event.name, event.data)
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
    // directly; we re-emit below with enrichment (taskTitle, taskProject).
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
          // '' = Inbox; the frontend renders the label, the event carries the raw value.
          enrichedData.taskProject = task.project || ''
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
          // Convergence sentinel: capture the streamed text msgIds BEFORE
          // clearSoon wipes the buffer, then verify (T+15s) that every one of
          // them exists in persisted history. A miss = the "visible while
          // streaming, gone when done" class → auto-incident.
          // Subagent-lane blocks (parentToolUseId set) are EXCLUDED: their
          // transcript persists to a separate subagents/agent-<id>.jsonl, so
          // they are never in THIS session's history — checking them produced
          // 49-id false VIOLATIONs on every background-agent turn (0b253ffe).
          if (event.name === 'session:result') {
            const streamedIds = sessionStreamBuffer.getSnapshot(sid).blocks
              .flatMap((b) => (b.type === 'text' && b.msgId && !b.parentToolUseId ? [b.msgId] : []))
            if (streamedIds.length > 0) {
              import('../core/observability/stream-convergence.js')
                .then(({ armStreamConvergenceCheck }) => armStreamConvergenceCheck(sid, streamedIds))
                .catch(() => {})
            }
          }
          sessionStreamBuffer.markDone(sid)
          // Release dedup-timestamp entry so lastMarkStreamingAt cannot grow
          // unbounded across long-lived servers. (Handled here, not only in the
          // status-changed 'stopped'/'error' branch, because session:result is
          // the primary end-of-turn signal and fires even when the session
          // stays 'running' for a subsequent turn.)
          lastMarkStreamingAt.delete(sid)
          // Turn ended → re-arm the streaming-phase check for the NEXT turn.
          streamingPhaseChecked.delete(sid)
          // clearSoon (NOT a bare setTimeout): a new turn starting inside the
          // 2s window cancels this via markStreaming — a bare timer wiped the
          // NEW turn's blocks + streaming flag (blank snapshot on mid-turn reload).
          sessionStreamBuffer.clearSoon(sid, 2000)
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
          // daemon-reconnect's 'running' is a reconciliation artifact ("the CLI
          // process is alive"), NOT "a turn is producing output". Marking the
          // stream buffer streaming on it left a permanent Streaming badge +
          // isStreaming=true snapshots (with hours-old blocks) during SSH-down
          // windows — every reconnect flap re-armed it and no turn ever ended
          // it (inc-1783406628291). Only session-runner knows a real turn
          // started; it emits with source 'session-runner'.
          if (event.source !== 'daemon-reconnect') {
            sessionStreamBuffer.markStreaming(sid)
            lastMarkStreamingAt.set(sid, Date.now())
          }
          // Invariant: a streaming session can't be "awaiting human action".
          // Undo a stale WAIT left by a transient/late session:error
          // that lost the race against recovery (e.g. clean turn-end at send-time
          // → --resume recovered the session, but the bogus error flipped phase).
          // sessionStreamingPhase() only touches WAIT, so a session
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
            // A genuine instantaneous turn can also reach idle inside this
            // window. Re-check durable state after the window so suppression
            // delays markDone instead of permanently dropping it.
            const timer = setTimeout(() => {
              deferredMarkDoneTimers.delete(timer)
              void (async () => {
                try {
                  const { getSessionByClaudeId } = await import('../core/session-tracker.js')
                  const rec = await getSessionByClaudeId(sid)
                  const isStillDone = rec?.process_status === 'idle'
                    || rec?.process_status === 'stopped'
                    || rec?.process_status === 'error'
                  if (isStillDone && sessionStreamBuffer.getSnapshot(sid).isStreaming) {
                    sessionStreamBuffer.markDone(sid)
                    if (rec.process_status === 'stopped' || rec.process_status === 'error') {
                      sessionStreamBuffer.clear(sid)
                      lastMarkStreamingAt.delete(sid)
                    }
                    log.ws.info('markDone applied after idle deferral (session is still done)', {
                      sessionId: sid, process_status: rec.process_status,
                    })
                  } else {
                    log.ws.info('markDone skipped after idle deferral (session recovered or buffer done)', {
                      sessionId: sid,
                      process_status: rec?.process_status,
                      isStreaming: sessionStreamBuffer.getSnapshot(sid).isStreaming,
                    })
                  }
                } catch (err) {
                  log.ws.warn('deferred idle markDone check failed', {
                    sessionId: sid, error: err instanceof Error ? err.message : String(err),
                  })
                }
              })()
            }, MARK_DONE_DEDUP_MS + 100)
            deferredMarkDoneTimers.add(timer)
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

      const { sessionId, taskId, result, isError, totalCost, costDelta, duration, turnGen } = eventData<'session:result'>(event)
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
        try {
          // Attribution fork (Personal AI lane): a lane-bound session IS the Personal AI's
          // own turn, not an external coding session. Recording it as
          // source:'session' parked the Personal AI's whole spend in the dashboard's
          // pass-through session_cost bucket and zeroed its per-agent row. The
          // event payload carries no lane, so read it off the record — one cheap
          // indexed sqlite read, and only on results that actually cost money.
          const { getSessionByClaudeId } = await import('../core/session-tracker.js')
          const laneRecord = sessionId ? await getSessionByClaudeId(sessionId) : null
          const { parseLaneKey } = await import('../core/sessions/personal-ai-lane.js')
          const laneIds = parseLaneKey(laneRecord?.lane)
          // Side threads: a hidden fork of a coding session, so the cost IS a
          // pass-through external-CLI cost and stays source:'session' — a new
          // source value would move it out of the dashboard's session_cost bucket
          // and into Walnut's own spend (every aggregate keys off `!= 'session'`).
          // What it lacks is a task: the thread has no task row, so bill it to the
          // PARENT session's task and the parent's cost stays complete.
          const { parseSideLaneKey } = await import('../core/sessions/side-thread-fork.js')
          const sideIds = parseSideLaneKey(laneRecord?.lane)
          const sideParentTaskId = sideIds
            ? (await getSessionByClaudeId(sideIds.parentSid).catch(() => null))?.taskId || undefined
            : undefined
          usageTracker.record({
            ...(laneIds ? { source: 'chat' as const, agentId: laneIds.agentId } : { source: 'session' as const }),
            model: 'claude-code-cli',
            sessionId,
            taskId: sideParentTaskId ?? taskId,
            external_cost_usd: costDelta,
            duration_ms: duration,
          })
        } catch {}
      }

      const taskRef = taskId ? await resolveTaskRef(taskId) : null

      // Successful task sessions are summarized by triage. Taskless successful
      // results stay in chat; errors belong exclusively in Notifications.
      // Lane-bound sessions are the main AI answering its own chat — the chat
      // route already persists the answer as an ordinary assistant message, so
      // the "Session Result" notification would be a duplicate (and always lands
      // in the MAIN conversation, even for another conversation's lane).
      const { getSessionByClaudeId: laneCheckRead } = await import('../core/session-tracker.js')
      const isLaneSession = !!(sessionId && (await laneCheckRead(sessionId).catch(() => null))?.lane)
      const willBeTriage = !isError && !!taskId
      if (isError) {
        await publishSessionErrorNotification({
          title: 'Session Error',
          body: `${taskRef ? `${taskRef}: ` : ''}${result || 'Session ended with an error.'}`,
          dedupScope: `session:${sessionId ?? taskId ?? 'unknown'}:runtime`,
          sessionId,
          taskId,
        })
      } else {
        // A clean result is this session's recovery signal: the turn ran, so
        // whatever its previous error card described (a failed turn, a delivery
        // outage, a transport that wouldn't start) is over. Placed on the result
        // path rather than on `message delivered`: delivery lives in the provider
        // layer, which would need its own injected seam, and a session cannot
        // produce a clean result without its message having been delivered — so
        // the result already implies delivery recovery, one signal instead of two.
        // No-ops for a session that never failed (see recoverSessionErrors).
        recoverSessionErrors(sessionId, taskId)
      }
      if (!isError && result && !willBeTriage && !isLaneSession) {
        const content = taskRef
          ? `**Session Result** (${taskRef}):\n\n${result}`
          : `**Session Result**:\n\n${result}`
        const { getMainConversationId } = await import('../core/conversations.js')
        const conversationId = await getMainConversationId('general')
        await chatHistory.addNotification({
          role: 'assistant', content,
          source: 'session',
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
          // Phase sync: session error → WAIT
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
        // Detached (run_in_background) command still working: the reply was
        // delivered (real turn-over — triage and session:ended proceed as
        // normal below) but the agent is NOT done, so the task must not flip
        // AGENT_COMPLETE (user decision 2026-08-28, inc-1787893885321). The
        // runner's followup-closure applies the final flip when the last
        // detached task drains.
        const detachedBgActive = (event.data as Record<string, unknown>)?.detachedBgActive === true
        if (!teamActive && !detachedBgActive) {
          try {
            const { applySessionPhase } = await import('../core/phase.js')
            // turnGen threads the emitting session's turn generation into the
            // stale-result gate: by the time this flip runs (enrichment above adds
            // ~800ms) the CLI may already be running the NEXT turn (incident
            // ed347bde). Undefined on non-CLI emitters → gate fails open.
            await applySessionPhase(taskId, 'session:result', 'server.ts:session-result', { sessionId, turnGen })
          } catch (err) {
            log.web.warn('failed to apply session:result phase', { taskId, error: String(err) })
          }
        } else {
          log.web.info(teamActive
            ? 'team active — skipping AGENT_COMPLETE phase transition'
            : 'detached background work active — skipping AGENT_COMPLETE phase transition', { sessionId, taskId })
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

    // Route session errors to Notifications. Session panels retain their own
    // contextual error/retry state; the general chat must remain conversational.
    if (event.name === 'session:error') {
      const { error, taskId, sessionId, errorKind } = eventData<'session:error'>(event)
      const isDeliveryFailure = errorKind === 'delivery_failed'
      let shouldPublish = true

      // delivery_failed = connectivity status, not a turn outcome. The session is
      // still valid and the message batch is safely back in 'pending'. Avoid
      // hammering the durable store while repeated sends hit the same outage.
      if (isDeliveryFailure) {
        const key = `${sessionId ?? taskId ?? 'unknown'}`
        const now = Date.now()
        const lastAt = deliveryFailureNotifiedAt.get(key) ?? 0
        if (now - lastAt < DELIVERY_FAILURE_NOTIFY_WINDOW_MS) {
          shouldPublish = false
          log.web.info('session delivery notification suppressed (deduped)', { sessionId, taskId })
        }
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
      if (shouldPublish) {
        const body = isDeliveryFailure
          ? `${errorTaskRef ? `${errorTaskRef}: ` : ''}${error}\n\nYour message was not lost. It stays queued and will be re-sent when you press Retry, send another message, or the connection recovers.`
          : `${errorTaskRef ? `${errorTaskRef}: ` : ''}${error}`
        const published = await publishSessionErrorNotification({
          title: isDeliveryFailure ? 'Session Delivery Failed' : 'Session Error',
          body,
          dedupScope: `session:${sessionId ?? taskId ?? 'unknown'}:${isDeliveryFailure ? 'delivery' : 'runtime'}`,
          sessionId,
          taskId,
        })
        // Arm the suppression window only after the write actually landed — a
        // failed persist must not silence this outage for the next 5 minutes.
        if (published && isDeliveryFailure) {
          deliveryFailureNotifiedAt.set(`${sessionId ?? taskId ?? 'unknown'}`, Date.now())
        }
      }

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
        // Phase sync: session error → WAIT
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
          const refLabel = `${refTask.project || 'Inbox'} / ${refTask.title}`
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
              const taskTitle = task ? `${task.project || 'Inbox'} / ${task.title}` : taskId
              const taskRef = task ? `[${task.id}]` : `[${taskId}]`

              // AI needs the full triage analysis to summarize for the user.
              // Built ABOVE the engine branch so both engines send the same prompt.
              const prompt = `[Triage Update] Task "${taskTitle}" ${taskRef}\n\n${cleanedResult}\n\n<task_note>\n${taskNote}\n</task_note>\n\nInform the user concisely (2-4 sentences) about this task's status.\nFocus on what the triage analysis says — that's the new information.\nThe task note provides full context if needed.\nDo not use tools.`

              // ── Engine branch: Personal AI lane (config.agent.provider='claude-code') ──
              // Skips the whole in-process block below (bail pre-check, system-prompt
              // estimation, runAgentLoop): the CLI owns its own context, so estimating
              // OUR history against OUR model window would gate a turn that isn't
              // ours to gate.
              if (await usePersonalAiLaneEngine('general')) {
                const { runLaneTurn } = await import('../core/sessions/lane-turn.js')
                const { sessionId: laneSessionId, resultText } =
                  await runLaneTurn('general', conversationId, prompt, { source: 'triage' })
                if (resultText === null) {
                  log.web.warn('triage lane turn produced no result (timeout or error)', { taskId, sessionId: laneSessionId })
                  broadcastEvent('agent:error', { error: `Triage notify failed for task ${taskId}: lane turn timed out or errored`, agentId: 'general', conversationId })
                  return
                }
                broadcastEvent('agent:response', { text: resultText, source: 'triage', agentId: 'general', conversationId })
                await chatHistory.addNotification({
                  role: 'assistant', content: resultText, source: 'triage',
                  notification: true, taskId, sessionId: laneSessionId,
                  agentId: 'general', conversationId,
                })
                log.web.info('triage lane turn done', { taskId, sessionId: laneSessionId, resultLength: resultText.length })
                // No triggerBackgroundCompaction on the lane path — the CLI compacts itself.
                return
              }

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
                broadcastEvent('agent:response', { text: bailContent, source: 'triage', agentId: 'general', conversationId })
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
                onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'triage', agentId: 'general', conversationId }),
                onThinking: (text) => broadcastEvent('agent:thinking', { text, agentId: 'general', conversationId }),
                onToolCall: (toolName, input) => broadcastEvent('agent:tool-call', { toolName, input, agentId: 'general', conversationId }),
                onToolResult: (toolName, result) => broadcastEvent('agent:tool-result', { toolName, result, agentId: 'general', conversationId }),
                onToolActivity: (activity) => broadcastEvent('agent:tool-activity', { ...activity, agentId: 'general', conversationId }),
                onUsage: (u) => {
                  try { usageTracker.record({ source: 'triage', model: u.model ?? 'unknown', input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens, cache_read_input_tokens: u.cache_read_input_tokens, agentId: 'general' }) } catch {}
                  // Fix 2: cache the EXACT input-token count (incl. cache) so the next
                  // triage turn's bail pre-check can reason in real-token space.
                  try { recordLastTurnTokens(conversationId, (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) } catch {}
                },
              }, { source: 'triage', tools: readOnlyTools, agentId: 'general', conversationId })

              if (agentResult.response) {
                broadcastEvent('agent:response', { text: agentResult.response, source: 'triage', agentId: 'general', conversationId })
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
              broadcastEvent('agent:error', { error: `Triage notify failed for task ${taskId}: ${errMsg}`, agentId: 'general', conversationId })
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

        // Post-triage phase sync: RETIRED 2026-08-17 (inc-1786983019552) — it
        // pushed AGENT_COMPLETE → WAIT after every triage, repainting normal
        // completions as "waiting on a human" with zero added signal. WAIT is
        // reserved for genuine blockage (session:error / idle-timeout kill /
        // all-dead reconcile); AGENT_COMPLETE is the terminal state of a
        // normal turn.
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

    // Subagent failures are operational events, not conversation turns.
    if (event.name === 'subagent:error') {
      const { runId, agentId, taskId, error } = eventData<'subagent:error'>(event)
      const subErrTaskRef = taskId ? await resolveTaskRef(taskId) : null
      // liveness contract: a subagent belongs to its task — the helper keys the
      // card `task:<id>` and marks it failing, so the task's next clean session
      // result retires it (and task death expires it). runId is a subagent run
      // id, not a claude session id, so it must NOT feed the session:<sid> key —
      // hence sessionId is deliberately omitted from the key derivation input.
      // With no taskId the failure is a one-shot (48h debris sweep applies).
      await publishSessionErrorNotification({
        title: 'Subagent Error',
        body: `${agentId ? `${agentId}${subErrTaskRef ? ` for ${subErrTaskRef}` : ''}: ` : ''}${error}`,
        // No shared 'unknown' bucket: with every id missing there is nothing
        // proving two failures are the same one, so each gets its own scope
        // (a fold would silently hide unrelated subagent failures).
        dedupScope: `subagent:${runId ?? agentId ?? taskId ?? `anon:${Date.now()}`}`,
        taskId,
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
  startupPhase('plugin sync polling started')

  // -- Calendar service (EventKit cache + periodic refresh; no-op off-macOS/cloud) --
  getCalendarService()
    .init()
    .catch((err) => log.web.warn('calendar service init failed', { error: String(err).slice(0, 200) }))

  // Permission Doctor: snapshot the launcher chain NOW — deploy-script parents
  // exit within seconds and the chain reparents to launchd, after which the
  // responsible process (what TCC checks grants against) is unknowable.
  warmLauncherDetection()

  // Soft-reload for the Plugin Store: source installs use additive discovery,
  // while explicit per-Plugin actions use the targeted lifecycle methods above.
  const loadInstalledPlugins = () => runPluginMutation(async () => {
    await stopPluginSyncPolling()
    try {
      await loadNewPlugins(registry)
      try {
        await runPluginMigrations(registry)
      } catch (err) {
        log.web.error('plugin data migrations failed during soft reload', { error: err instanceof Error ? err.message : String(err) })
      }
      bus.emit('plugin:runtime-changed', { action: 'reloaded-all' }, ['web-ui'], { source: 'plugin-runtime' })
      log.web.info('plugin additive load complete', { plugins: registry.getAll().map(p => p.id) })
    } finally {
      startPluginSyncPolling()
    }
  })
  pluginSoftReload = loadInstalledPlugins

  // A config save may complete one or more needs-config Plugins. Reload only
  // those owners; rebuilding the whole manager would interrupt every active Plugin.
  bus.subscribe('plugin-config-reload', async (event) => {
    if (event.name !== EventNames.CONFIG_CHANGED) return
    if (getUnconfiguredPlugins().length === 0) return

    await runPluginMutation(async () => {
      const pending = [...getUnconfiguredPlugins()]
      if (pending.length === 0) return
      const { getConfig: readPluginConfig } = await import('../core/config-manager.js')
      const config = await readPluginConfig()
      const ready = pending.filter((plugin) => {
        const pluginConfig = config.plugins?.[plugin.id] ?? {}
        return plugin.missing.every((field) => field in pluginConfig)
      })
      if (ready.length === 0) return

      for (const plugin of ready) await stopPluginSyncPolling(plugin.id)
      try {
        let activated = false
        for (const plugin of ready) {
          try {
            const record = await reloadLoadedPlugin(registry, plugin.id)
            activated ||= record.state === 'active'
            bus.emit('plugin:runtime-changed', {
              pluginId: plugin.id,
              action: 'reloaded',
            }, ['web-ui'], { source: 'plugin-runtime' })
          } catch (err) {
            log.web.warn('Plugin reload after config completion failed', {
              pluginId: plugin.id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        if (activated) {
          try { await runPluginMigrations(registry) }
          catch (err) {
            log.web.error('Plugin data migrations failed after config completion', {
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } finally {
        startPluginSyncPolling()
      }
    })
  })

  // -- Process exit diagnostics --
  // Installed at the TOP of startServer() (see installExitDiagnostics), not here.
  // Keeping it here left the whole multi-second boot without a SIGTERM handler.

  // -- Start post-listen services (port already bound above) --
  cronService.start().catch((err) => {
    log.cron.error('failed to start cron service', { error: err instanceof Error ? err.message : String(err) })
  })

  // -- Start heartbeat runner (if enabled in config) --
  startHeartbeatIfConfigured().catch((err) => {
    log.heartbeat.error('failed to start heartbeat', { error: err instanceof Error ? err.message : String(err) })
  })

  // Dream consolidation RETIRED (2026-07 memory/skill/history unification): it
  // wrote to the retired memory/topics/ + index.md wiki and kept regrowing the
  // old structure after migration. Its job (periodic knowledge consolidation)
  // is covered by the in-conversation skill_manage triggers + the every-N-turn
  // background self-review fork. src/core/dream.ts remains for manual runs.

  // Conversation distill sweep REMOVED (unified memory redesign): the append-only
  // background distiller was the main source of MEMORY.md rot. Condensation now
  // happens in-conversation via skill_manage triggers.

  startupPhase('ALL DONE — server fully initialized')
  bootCompleted = true // steady state → stray rejections log, never kill prod
  return httpServer!
}

// ── Git auto-commit polling ──

const GIT_POLL_INTERVAL_MS = 30_000

function startGitAutoCommit(): { stop: () => void; health: GitAutoCommitHealth } {
  const health: GitAutoCommitHealth = { protected: false, consecutiveFailures: 0 }
  let notifiedForEpisode = false // only send one feed notification per failure episode
  let lockContentionCount = 0
  /** Fires publishRecovery(['git']) on the failing→healthy edge only. */
  const gitRecoveryTracker = createRecoveryTransitionTracker()

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

  // Commit any leftover dirty state from a previous crash, THEN pull.
  //
  // These two used to be fired independently: commitIfDirty() ran detached and
  // gitPullWalnut() was called on the next line, so a boot ran `add -A` and
  // `pull` against the same repo concurrently — the pull could move HEAD and
  // rewrite the worktree while the commit was mid-`add`, photographing a
  // half-checked-out tree (the same torn-worktree shape as the 2026-08-04
  // incident, just self-inflicted at startup instead of by a human rebase).
  // Chained, the pull only starts once the commit has settled.
  //
  // Still non-blocking: this is a detached promise chain, so server listen and
  // the rest of startup are not gated on git.
  void commitIfDirty()
    .then((committed) => {
      if (committed) {
        health.lastCommitAt = new Date().toISOString()
        log.git.info('committed leftover dirty state on startup')
      }
    })
    .catch((err) => {
      log.git.warn('startup commit failed', { error: String(err) })
    })
    // .then (not .finally): runs after either outcome above, and a failed
    // startup commit must not block the pull — receiving upstream is still safe.
    .then(() => gitPullWalnut())
    .catch((err) => {
      log.git.warn('startup git pull failed', { error: String(err) })
    })

  let syncTick = 0
  // setTimeout self-reschedule (not setInterval): the next tick is armed only
  // AFTER the current one finishes, so slow network git ops can never stack
  // concurrent ticks — same shape as startPluginSyncPolling below.
  let gitTickTimer: ReturnType<typeof setTimeout> | null = null
  let gitTickStopped = false
  const gitTick = async (): Promise<void> => {
    try {
      const committed = await commitIfDirty()
      if (committed) {
        health.lastCommitAt = new Date().toISOString()
        health.consecutiveFailures = 0
        health.error = undefined
        notifiedForEpisode = false
        lockContentionCount = 0
        log.git.debug('auto-committed')
        emitStatus()
      }
      // Pull remote changes + push our own commits, on BOTH sides: the cloud
      // box has no other sync path, and the primary needs it so edits reach
      // the hub (and cloud-side edits land back) without a manual push.
      // autoSync() self-gates on hasRemote() and never throws. All git ops in
      // this tick are async now (execFile), so network round-trips no longer
      // block the event loop; the every-other-cycle throttle on an idle tree
      // (60s) stays to keep remote traffic modest.
      syncTick++
      if (committed || syncTick % 2 === 0) {
        await autoSync()
        // Two-way task reconcile after the pull half of autoSync():
        // primary applies cloud outbox ops; cloud imports the fresh projection.
        // Self-gating (mode + mtime), never throws, fire-and-forget.
        import('../core/task-outbox.js')
          .then(({ reconcileAfterPull }) => reconcileAfterPull())
          .catch(() => { /* best-effort */ })
      }
      // Repo-size sentinel (self-throttled to one real check per 6h): the
      // last line of defense if gitignores/compaction/timeout-reaping all
      // fail again — a ballooning .git warns here instead of starving the box.
      const sizeWarning = checkRepoSize()
      if (sizeWarning) {
        log.git.warn(sizeWarning)
        void publishErrorNotification({
          title: 'Data Repo Growing Too Large',
          body: sizeWarning,
          dedupScope: 'git:repo-size',
          recoveryKey: 'git',
        })
      }
      // Mass-revert / torn-worktree safe mode: surface the refusal to the
      // human (health + one notification per episode) — commits are paused
      // until the anomaly clears, so silence here would hide data-loss risk.
      const guardState = getSyncGuardState()
      if (guardState.safeMode !== health.safeMode) {
        health.safeMode = guardState.safeMode
        emitStatus()
        if (guardState.safeMode) {
          void publishErrorNotification({
            title: 'Data Sync Paused (Safe Mode)',
            body: 'git-sync detected a suspicious mass change (possible stale-worktree revert) and stopped auto-committing. Pull-only mode is active. Check open-walnut logs -s git.',
            dedupScope: 'git:safe-mode',
            recoveryKey: 'git',
          })
        }
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
        // Surface a persistent notification when failures first reach the threshold.
        if (health.consecutiveFailures >= 3 && !notifiedForEpisode) {
          notifiedForEpisode = true
          void publishErrorNotification({
            title: 'Data Backup Failing',
            body: `Git auto-commit has failed ${health.consecutiveFailures}+ times consecutively. Check logs with open-walnut logs -s git.`,
            dedupScope: 'git:auto-commit',
            recoveryKey: 'git',
          }).then((published) => {
            if (!published) notifiedForEpisode = false // reset so next cycle retries
          })
        }
      }
    } finally {
      // Recovery edge for the auto-commit git family (auto-commit, repo-size,
      // safe mode). NOT compaction — that has its own key ('git:compaction') and
      // its own success point, because a healthy commit tick says nothing about a
      // daily history rewrite and used to retire its card while it was still
      // broken. Placed in `finally` so BOTH exits are observed by one gate — the
      // try's own success paths and the catch's failure. The tracker fires exactly
      // once per failing→healthy edge, which is why a 30s poll doesn't turn into a
      // permanent store scan (the reason this is transition-gated and not "signal
      // on every success").
      if (gitRecoveryTracker.observe('git', health.consecutiveFailures > 0 || health.safeMode === true)) {
        void publishRecovery(['git'])
      }
      if (!gitTickStopped) {
        gitTickTimer = setTimeout(() => { void gitTick() }, GIT_POLL_INTERVAL_MS)
        gitTickTimer.unref?.()
      }
    }
  }
  gitTickTimer = setTimeout(() => { void gitTick() }, GIT_POLL_INTERVAL_MS)
  gitTickTimer.unref?.()

  log.git.info('git auto-commit started', { intervalMs: GIT_POLL_INTERVAL_MS })
  emitStatus()

  return {
    stop() {
      gitTickStopped = true
      if (gitTickTimer) clearTimeout(gitTickTimer)
      // Final commit on shutdown (fire-and-forget — process is exiting)
      commitIfDirty().catch(() => {})
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
  // config.yaml is git-synced from the primary box — if heartbeat is enabled
  // there, running it here too would double-fire the same agent turns.
  if (CLOUD_MODE) {
    log.heartbeat.info('cloud mode: heartbeat skipped (primary box owns heartbeat turns)')
    return
  }
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
          // Background turn → general's stable MAIN conversation (see rationale in
          // broadcastCronNotification above).
          const { getMainConversationId } = await import('../core/conversations.js')
          const conversationId = await getMainConversationId('general')
          // Engine for this turn — a lane turn never enters the in-process loop, so
          // it needs neither the API history nor the agent module.
          const laneEngine = await usePersonalAiLaneEngine('general')

          // Load chat history (fresh state after any preceding turn)
          let history: Awaited<ReturnType<typeof chatHistory.getApiMessages>> = []
          if (!laneEngine) {
            const { estimateMessagesTokens } = await import('../core/daily-log.js')
            history = await chatHistory.getApiMessages('general', conversationId)
            const historyTokens = estimateMessagesTokens(history)
            log.heartbeat.info('running heartbeat agent turn', {
              historyMessages: history.length,
              historyTokens: `~${Math.round(historyTokens / 1000)}K`,
            })
          }

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

          // Turn-end persistence shared by BOTH engines: a silent "all clear" is
          // stored as one compact line instead of the routine full response.
          const persistSilentHeartbeat = () => chatHistory.addNotification({
            role: 'assistant',
            content: '**Heartbeat** — all clear, nothing needs attention.',
            source: 'heartbeat',
            notification: true,
            agentId: 'general', conversationId,
          })

          // ── Engine branch: Personal AI lane (config.agent.provider='claude-code') ──
          // Everything above ran for both engines (trigger broadcast + persist).
          if (laneEngine) {
            const { runLaneTurn } = await import('../core/sessions/lane-turn.js')
            const { sessionId: laneSessionId, resultText } =
              await runLaneTurn('general', conversationId, prompt, { source: 'heartbeat' })
            // heartbeat-runner records the error and emits heartbeat:error.
            if (resultText === null) throw new Error('heartbeat lane turn timed out')
            if (resultText) {
              broadcastEvent('agent:response', { text: resultText, source: 'heartbeat', agentId: 'general', conversationId })
            }
            if (isHeartbeatOk(resultText)) {
              await persistSilentHeartbeat()
            } else {
              // The model context lives in the CLI's transcript, so the substantive
              // answer is persisted as one assistant notification (with a link back
              // to the session that produced it) rather than as API messages.
              await chatHistory.addNotification({
                role: 'assistant', content: resultText, source: 'heartbeat',
                notification: true, sessionId: laneSessionId,
                agentId: 'general', conversationId,
              })
            }
            // No triggerBackgroundCompaction on the lane path — the CLI compacts itself.
            return resultText
          }

          const { runAgentLoop } = await import('../agent/loop.js')
          const result = await runAgentLoop(prompt, history, {
            onTextDelta: (delta) => broadcastEvent('agent:text-delta', { delta, source: 'heartbeat', agentId: 'general', conversationId }),
            onThinking: (text) => broadcastEvent('agent:thinking', { text, agentId: 'general', conversationId }),
            onToolCall: (toolName, input, toolUseId) => broadcastEvent('agent:tool-call', { toolName, input, toolUseId, agentId: 'general', conversationId }),
            onToolResult: (toolName, result, toolUseId) => broadcastEvent('agent:tool-result', { toolName, result, toolUseId, agentId: 'general', conversationId }),
            onToolActivity: (activity) => broadcastEvent('agent:tool-activity', { ...activity, agentId: 'general', conversationId }),
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
            broadcastEvent('agent:response', { text: responseText, source: 'heartbeat', agentId: 'general', conversationId })
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
            await persistSilentHeartbeat()
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
async function stopPluginSyncPolling(pluginId?: string): Promise<void> {
  if (pluginId) {
    const stop = pluginSyncStops.get(pluginId)
    pluginSyncStops.delete(pluginId)
    if (stop) await stop().catch(() => { /* best-effort shutdown */ })
    return
  }
  const stops = [...pluginSyncStops.values()]
  pluginSyncStops.clear()
  await Promise.all(stops.map((stop) => stop().catch(() => { /* best-effort shutdown */ })))
}

function startPluginSyncPolling(): void {
  // External-sync plugins write tasks.json — polling from BOTH the primary box
  // and the cloud companion would double-create synced tasks + churn git-sync.
  // The primary box owns external sync; the cloud box only serves the API.
  if (CLOUD_MODE) {
    log.web.info('cloud mode: skipping plugin sync polling (primary box owns external sync)')
    return
  }
  // Idempotent: callable again after a plugin soft-reload — only plugins that
  // don't have a polling loop yet get one (existing loops keep running).
  // hasSync === false means a ui/tools/skills-only plugin whose `sync` is an
  // inert stub: polling it would burn a timer forever to call no-ops.
  const plugins = registry.getAll().filter(p =>
    p.id !== 'local' && p.hasSync !== false && !pluginSyncStops.has(p.id))
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
    const stop = async () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (currentTickPromise) {
        try { await currentTickPromise } catch { /* tick errors already logged */ }
      }
    }
    pluginSyncStops.set(plugin.id, stop)

    const tick = async () => {
      if (syncing) {
        scheduleNext(intervalMs)
        return
      }
      syncing = true
      const syncT0 = Date.now()
      let changeCount = 0 // captured by ctx closures — accumulates across delta pull + reconciler.tick
      // Per-change events for web-ui. The old contract sent ONE bulk `{task:null}`
      // signal per tick, which every open tab answers with a full task-list
      // refetch (5.5MB at ~6k tasks) — measured as a main contributor to the
      // periodic UI freezes. Typical ticks change 1-3 tasks, so deliver those
      // individually (frontend merges in place); bulk stays as the big-sync path.
      const tickEvents: Array<{ name: string; data: unknown }> = []
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
            tickEvents.push({ name: EventNames.TASK_UPDATED, data: { task: updatedTask } })
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

        // Step 1.6: Retry unconfirmed remote deletions. A local delete ledgers
        // the remote id (state='deleted', unconfirmed) and tries the remote
        // delete once, fire-and-forget; this loop keeps retrying survivors
        // each tick until the provider acknowledges (success or 404), so a
        // network blip can't leave a remote twin alive forever. The tombstone
        // itself already blocks re-import while unconfirmed.
        if (plugin.sync.confirmRemoteDeleted) {
          try {
            const { listUnconfirmedRemoteDeletes, confirmRemoteDelete } = await import('../core/task-remote-links.js')
            const pending = listUnconfirmedRemoteDeletes(plugin.id, 5)
            for (const link of pending) {
              try {
                const gone = await plugin.sync.confirmRemoteDeleted(link.remote_id, link.remote_list)
                if (gone) confirmRemoteDelete(plugin.id, link.remote_id)
              } catch (err) {
                log.web.debug(`${plugin.id} sync: remote delete retry failed`, {
                  remoteId: link.remote_id,
                  error: err instanceof Error ? err.message : String(err),
                })
              }
            }
          } catch (err) {
            log.web.debug(`${plugin.id} sync: remote delete retry pass failed`, {
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
              // NOTE: this re-applies the raw patch even when updateTaskRaw's
              // precision-echo guard dropped a due_date/start_date echo — the tick
              // cache may briefly hold the day-level date the DB rejected. Harmless
              // today (pushes truncate anyway); don't read guarded fields from this
              // cache as truth.
              Object.assign(updatedTask, effectiveUpdates)
              if (changed) {
                bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, [], { source: `${plugin.id}-sync` })
                changeCount++
                tickEvents.push({ name: EventNames.TASK_UPDATED, data: { task: updatedTask } })
              }
            }
            // Return updated task (or fetch fresh if not in local list)
            return updatedTask ?? await (await import('../core/task-manager.js')).getTask(id)
          },
          addTask: async (taskData) => {
            const task = await addTaskFull(taskData)
            bus.emit(EventNames.TASK_CREATED, { task }, [], { source: `${plugin.id}-sync` })
            changeCount++
            tickEvents.push({ name: EventNames.TASK_CREATED, data: { task } })
            return task
          },
          deleteTask: async (id) => {
            const { task } = await deleteTask(id)
            bus.emit(EventNames.TASK_DELETED, { task }, [], { source: `${plugin.id}-sync` })
            changeCount++
            // web-ui's task:deleted handler keys on `id` (the raw event carries `task`)
            tickEvents.push({ name: EventNames.TASK_DELETED, data: { id: task?.id ?? id, task } })
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
        // A sync that completed is proof the plugin's whole condition (auth,
        // network, remote API) is healthy again — so this is where its wall of
        // red retires. Gated on the failure→success EDGE: firing on every
        // healthy tick would mean a locked read-modify-write scan of
        // notifications.json every 30s, per plugin, forever, to change nothing.
        // Every record under this key retires at once, including the ones the
        // log bridge wrote from the plugin's own subsystem (its http client, the
        // sync reconciler) — they all carry `plugin:<id>`.
        const recovered = consecutiveFailures > 0
        consecutiveFailures = 0
        if (recovered) void publishRecovery([`plugin:${plugin.id}`])
        const syncElapsed = Date.now() - syncT0
        if (syncElapsed > 2000) {
          log.web.warn(`${plugin.id} sync: slow tick`, { elapsed: syncElapsed })
        }
      } catch (err) {
        consecutiveFailures++
        const errorMsg = err instanceof Error ? err.message : String(err)
        if (consecutiveFailures >= 5) {
          // pluginId in meta is load-bearing, not decoration: the log-error
          // bridge derives this record's recoveryKey from it (the 'web'
          // subsystem is core, so without pluginId the card would have no
          // lifecycle and stay red after the plugin recovered).
          log.web.error(`${plugin.id} sync failing repeatedly`, {
            pluginId: plugin.id, consecutiveFailures, error: errorMsg,
          })
        } else {
          log.web.debug(`${plugin.id} sync failed`, { consecutiveFailures, error: errorMsg })
        }
      } finally {
        // outer finally ensures bulk signal fires even if delta fails — reconciler runs in inner finally and may produce additional changes via ctx closures
        try {
          // Small ticks (the overwhelmingly common case: 1-3 changed tasks) ship
          // the per-task events to web-ui — the frontend merges them in place with
          // a shallow-equal bail, so unaffected rows never re-render. The bulk
          // `{task:null}` signal (frontend answers with a FULL list refetch) is
          // reserved for big syncs and for drift safety (a site that bumped
          // changeCount without recording its event). reemit:true so global
          // subscribers, which already saw the originals, skip these copies.
          if (changeCount > 0) {
            const MAX_INDIVIDUAL_SYNC_EVENTS = 25
            if (changeCount === tickEvents.length && tickEvents.length <= MAX_INDIVIDUAL_SYNC_EVENTS) {
              for (const ev of tickEvents) {
                bus.emit(ev.name as 'task:updated', ev.data as any, ['web-ui'], { source: `${plugin.id}-sync-batch`, reemit: true })
              }
              log.web.info(`${plugin.id} sync: batch complete`, { changeCount, delivery: 'individual' })
            } else {
              // null task = bulk signal; frontend useTasks handles by calling refetch()
              bus.emit(EventNames.TASK_UPDATED, { task: null } as any, ['web-ui'], { source: `${plugin.id}-sync-batch` })
              log.web.info(`${plugin.id} sync: batch complete`, { changeCount, delivery: 'bulk' })
            }
            tickEvents.length = 0
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
  if (unsubscribeHostRecovery) {
    unsubscribeHostRecovery()
    unsubscribeHostRecovery = null
  }
  if (notificationReconcileTimer) {
    clearInterval(notificationReconcileTimer)
    notificationReconcileTimer = null
  }
  // Close /api/v1 SSE streams so open connections + ping timers don't keep
  // the HTTP server alive (tests / graceful shutdown).
  try { closeApiV1Streams() } catch { /* best-effort */ }
  // Close daemon bridge sockets + their sweep timer (cloud mode).
  try {
    const { closeAllBridges } = await import('./ws/bridge-registry.js')
    closeAllBridges()
  } catch { /* best-effort */ }
  // Cancel pending deferred-markDone callbacks so they don't mutate
  // sessionStreamBuffer after shutdown.
  for (const timer of deferredMarkDoneTimers) {
    clearTimeout(timer)
  }
  deferredMarkDoneTimers.clear()
  // Await each stop() so any in-flight plugin tick completes before we tear down
  // the registry and other dependencies. Otherwise a mid-tick ctx.updateTask /
  // ctx.addTask / bus.emit could fire after shutdown.
  await pluginMutationTail.catch(() => undefined)
  await stopPluginSyncPolling()
  try { await disposeLoadedPlugins(registry) } catch { /* best-effort shutdown */ }
  pluginSoftReload = async () => {}
  pluginMutationTail = Promise.resolve()
  registry.clear()
  if (healthMonitor) {
    healthMonitor.stop()
    healthMonitor = null
  }
  if (changesPrewarmer) {
    changesPrewarmer.stop()
    changesPrewarmer = null
  }
  try {
    const { sideThreadManager } = await import('../core/sessions/side-thread-manager.js')
    sideThreadManager.stop()
  } catch { /* import failed (partial dist) — nothing to stop; stop() itself is a no-op when never started */ }
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
  // Awaited: an in-flight import writes task/session rows, so shutdown must not
  // return while one is mid-write.
  if (externalSessionImporter) {
    try { await externalSessionImporter.stop() } catch { /* already logged */ }
    externalSessionImporter = null
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
  if (searchV2WiringHandle) {
    await searchV2WiringHandle.stop().catch(() => {})
    searchV2WiringHandle = null
  }
  bus.unsubscribe('task-ledger')
  if (notesWatcherHandle) {
    notesWatcherHandle.stop()
    notesWatcherHandle = null
  }
  // Detach the log-error → notification bridge (a test's next startServer()
  // reinstalls it; leaving it set would write to a torn-down store).
  import('../core/notifications/log-error-bridge.js')
    .then(({ uninstallLogErrorNotifications }) => uninstallLogErrorNotifications())
    .catch(() => {})
  if (gitAutoCommitHandle) {
    gitAutoCommitHandle.stop()
    gitAutoCommitHandle = null
  }
  if (diskWatermarkHandle) {
    diskWatermarkHandle.stop()
    diskWatermarkHandle = null
  }
  if (backupSchedulerHandle) {
    backupSchedulerHandle.stop()
    setBackupScheduler(null)
    backupSchedulerHandle = null
  }
  if (keepAwakeHandle) {
    keepAwakeHandle.stop()
    // Release the pmset hold — a dead server must never leave the Mac sleepless.
    await keepAwakeHandle.release().catch(() => {})
    keepAwakeHandle = null
  }
  if (gitMaintenanceHandle) {
    gitMaintenanceHandle.stop()
    gitMaintenanceHandle = null
  }
  if (sendPathCanaryHandle) {
    sendPathCanaryHandle.stop()
    sendPathCanaryHandle = null
  }
  if (taskProjectionHandle) {
    taskProjectionHandle.stop()
    taskProjectionHandle = null
  }
  if (sessionProjectionHandle) {
    sessionProjectionHandle.stop()
    sessionProjectionHandle = null
  }
  if (projectionSelfHealHandle) {
    projectionSelfHealHandle.stop()
    projectionSelfHealHandle = null
  }
  if (taskQueueFlushHandle) {
    taskQueueFlushHandle.stop()
    taskQueueFlushHandle = null
  }
  if (controlQueueFlushHandle) {
    controlQueueFlushHandle.stop()
    controlQueueFlushHandle = null
  }
  if (sendQueueFlushHandle) {
    sendQueueFlushHandle.stop()
    sendQueueFlushHandle = null
  }
  stopMobileEventsFeed()
  if (pinRetirementHandle) {
    pinRetirementHandle.stop()
    pinRetirementHandle = null
  }
  if (autoContinueHandle) {
    autoContinueHandle.stop()
    autoContinueHandle = null
  }
  if (autoRecoverHandle) {
    autoRecoverHandle.stop()
    autoRecoverHandle = null
  }
  if (claudeSettingsWatcherStop) {
    claudeSettingsWatcherStop()
    claudeSettingsWatcherStop = null
  }
  bus.unsubscribe('web-ui')
  bus.unsubscribe('task-outbox')
  bus.unsubscribe('main-ai')
  bus.unsubscribe('heartbeat-config')
  bus.unsubscribe('plugin-config-reload')
  bus.unsubscribe('embedding-sync')
  bus.unsubscribe('setup-health')
  stopTimeTracking()
  import('../agent/overview-maintainer.js')
    .then(({ stopOverviewMaintainer }) => stopOverviewMaintainer())
    .catch(() => {})
  // Release local terminal ptys (dtach sessions on targets survive).
  try {
    const { terminalManager } = await import('./terminal/terminal-manager.js')
    terminalManager.shutdown()
  } catch { /* terminal feature may be disabled */ }
  closeWss()

  if (foreignWriterWatchdog) {
    foreignWriterWatchdog.stop()
    foreignWriterWatchdog = null
  }
  // Release the single-instance lock so the next startServer() (tests restart
  // in-process; dev:prod restarts across processes) can acquire it cleanly.
  import('../core/instance-lock.js')
    .then(({ releaseInstanceLock }) => releaseInstanceLock())
    .catch(() => {})

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
