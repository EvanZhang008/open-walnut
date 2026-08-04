/**
 * Session routes — expose tracked sessions and summaries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import {
  emitSessionStatusChanged,
  getRecentSessions,
  getSessionByClaudeId,
  getSessionStatusSnapshots,
  getSessionSummaries,
  getSessionsForTask,
  isEnvironmentSession,
  isTriageSession,
  listSessions,
  toSessionStatusSnapshot,
  updateSessionRecord,
  updateSessionRecordConditionally,
} from '../../core/session-tracker.js'
import { readSessionHistory, readSingleSubagentHistory, reconstructWorkflowProgress, extractPlanContent, rewriteHistoryRemoteImages } from '../../core/session-history.js'
import { computeSessionChanges } from '../../core/session-changes.js'
import { computeSessionGitDiff, type GitDiffBase } from '../../core/session-git-diff.js'
import { listTasks, getTask, addTask, updateTask, togglePin, setFocusTier, linkSession, groupTasks, addToGroup, renameGroup } from '../../core/task-manager.js'
import { getConfig } from '../../core/config-manager.js'
import { bus, EventNames, eventData } from '../../core/event-bus.js'
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'path'
import { isSessionProcessAlive } from '../../utils/session-liveness.js'
import { readPlanFromSession, buildPlanExecutionMessage } from '../../utils/plan-message.js'
import { injectCompactBoundary, buildCompactSummary } from '../../utils/compact-inject.js'
import { findLocalJsonlPath } from '../../core/session-file-reader.js'
import { getFrequentDirs, compileFromSessions, recordLaunchPrefs } from '../../core/frequent-dirs.js'
import type { SessionRecord, SessionMode, Task, SessionEffort } from '../../core/types.js'
import { VALID_SESSION_MODEL_IDS, SESSION_MODEL_CLI_MAP, VALID_SESSION_EFFORT_IDS, modelSupportsEffort, modelSupportsXhighEffort, modelSupportsMaxEffort, matchSessionModelCatalogEntry, resolveModelSwitchValue, sessionModelsAsCatalog } from '../../core/types.js'
import { getHostModelCatalog, listHostModelCatalogs } from '../../core/host-model-catalog.js'
import type { SessionHistoryMessage } from '../../core/session-history.js'
import { processAndSaveImages, buildSessionImageContext } from './images.js'
import { sessionRunner } from '../../providers/claude-code-session.js'
import { readAcpSessionHistoryState } from '../../providers/acp-session-history.js'
import { listSideQuestions, addSideQuestion, getSideQuestion, markPromoted, deleteSideQuestion } from '../../core/side-questions.js'
import type { ImagePayload } from './images.js'
import { quickStartSession, QuickStartError } from '../../core/sessions/quick-start.js'
import { ensureCwd } from '../../core/sessions/ensure-cwd.js'
import { buildSessionVscodeUri, SessionVscodeUriError } from '../../core/session-vscode-uri.js'
import { listLocalDirs, listRemoteDirs } from '../../core/sessions/dir-listing.js'
import { QUICK_START_MESSAGE_HARD_LIMIT } from '../../constants.js'

/** Diagnose message ordering — logs whether user text messages are interleaved or bunched at end. */
function logMessageOrdering(phase: string, sessionId: string, messages: SessionHistoryMessage[], host?: string | null): void {
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && messages[i].text?.trim()) userIndices.push(i)
  }
  if (userIndices.length <= 1) return // no diagnostic needed for 0-1 user messages
  const lastAsst = messages.reduce((max, m, i) => m.role === 'assistant' ? i : max, -1)
  const usersAfterLastAsst = userIndices.filter(i => i > lastAsst).length
  const bunched = usersAfterLastAsst > userIndices.length / 2
  if (!bunched) return // only log anomalies — skip normal cases to reduce production noise
  log.web.warn('session history: user messages bunched at end', {
    phase,
    sessionId: sessionId.substring(0, 8),
    host: host ?? 'local',
    total: messages.length,
    userText: userIndices.length,
    lastAsstIdx: lastAsst,
    usersAfterLastAsst,
  })
}

/** Route-level ceiling on one liveness probe. A remote probe rides
 *  conn.send('status') whose own timeout is 30s — a wedged daemon would hold
 *  the sessions-list response (and one of the browser's 6 connections) that
 *  whole time, on one of the hottest endpoints in the app. Local PID checks
 *  are a sync syscall and never hit this. Timing out resolves `true`
 *  ("assume alive"): remote corrections are skipped anyway (transport
 *  uncertainty ≠ death), and the health monitor owns authoritative
 *  reconciliation on its own 30s cycle. */
const LIVENESS_PROBE_TIMEOUT_MS = 2_500

function probeWithDeadline(p: Promise<boolean>): Promise<boolean> {
  return Promise.race([
    p,
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(true), LIVENESS_PROBE_TIMEOUT_MS)
      t.unref?.()
    }),
  ])
}

/** Recompute process_status live via PID check (for GET responses).
 *  Runs all PID checks in parallel to avoid blocking the event loop. */
async function enrichWithLiveStatus(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  // Parallel liveness checks via unified session liveness utility.
  // Routes to local PID check for local sessions, daemon connection check for remote.
  const needsCheck: number[] = []
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    if (s.process_status === 'running' || s.process_status === 'idle') {
      needsCheck.push(i)
    }
  }

  if (needsCheck.length > 0) {
    const results = await Promise.allSettled(
      needsCheck.map(i => probeWithDeadline(isSessionProcessAlive(sessions[i])))
    )
    const corrections: Promise<void>[] = []
    for (let j = 0; j < needsCheck.length; j++) {
      const r = results[j]
      const alive = r.status === 'fulfilled' && r.value === true
      if (!alive) {
        const index = needsCheck[j]
        const checked = sessions[index]
        // A failed remote liveness check can mean only that the daemon/tunnel
        // is unreachable. GET must not turn transport uncertainty into durable
        // process death; the health monitor owns remote reconciliation.
        if (checked.host) continue
        // Not-yet-spawned session: the start routes seed the record BEFORE the CLI
        // exists (so the UI can open the real panel on the id it just got back),
        // so for a moment there is legitimately no pid to probe. For those rows
        // "no pid" is absence of evidence, not evidence of death — persisting
        // 'stopped' here would render a session the user just launched as already
        // dead. Keyed off the explicit `status_reason` the seed writes rather than
        // `pid == null` in general, because a pid-less row with any OTHER reason
        // really is dead (e.g. a record whose process was reaped) and must still
        // be corrected. The window mirrors the health monitor's ORPHAN_GRACE_MS,
        // which reaps a still-pid-less row afterwards, so nothing leaks.
        const SPAWN_GRACE_MS = 2 * 60 * 1000
        if (checked.pid == null && checked.status_reason === 'awaiting_spawn') {
          const since = new Date(checked.last_status_change ?? checked.startedAt ?? 0).getTime()
          if (Date.now() - since < SPAWN_GRACE_MS) continue
        }
        const checkedStatus = toSessionStatusSnapshot(checked)
        corrections.push((async () => {
          const updated = await updateSessionRecordConditionally(
            checked.claudeSessionId,
            {
              process_status: 'stopped',
              activity: undefined,
              last_status_change: new Date().toISOString(),
              status_reason: 'liveness_check_failed',
              status_changed_by: 'system',
            },
            (current) => {
              const status = toSessionStatusSnapshot(current)
              return status.statusRevision === checkedStatus.statusRevision
                && status.process_status === checkedStatus.process_status
                && (status.process_status === 'running' || status.process_status === 'idle')
            },
          )
          if (!updated) return
          sessions[index] = updated
          emitSessionStatusChanged(updated, {}, ['*'], {
            source: 'sessions-route:liveness',
            urgency: 'urgent',
          })
        })())
      }
    }
    await Promise.all(corrections)
  }

  return sessions
}

/** Resolve host aliases to full hostnames from config (for tooltip display). */
async function enrichWithHostnames(sessions: SessionRecord[]): Promise<SessionRecord[]> {
  const hostsNeeded = sessions.some(s => s.host && !s.hostname)
  if (!hostsNeeded) return sessions
  try {
    const config = await getConfig()
    const hosts = config.hosts
    if (!hosts) return sessions
    for (const s of sessions) {
      if (s.host && !s.hostname) {
        const def = hosts[s.host]
        if (def) {
          s.hostname = def.hostname
        }
      }
    }
  } catch { /* config read failure — non-critical */ }
  return sessions
}

export const sessionsRouter = Router()

// GET /api/sessions/working-dirs — deduplicated working directories from persistent store
sessionsRouter.get('/working-dirs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    const config = await getConfig()
    const hosts = config.hosts ?? {}
    const defaultCat = config.defaults?.category ?? 'Inbox'
    const now = Date.now()

    // Find max age and max count for normalization
    let maxAgeMs = 1
    let maxCount = 1
    for (const d of dirs) {
      const age = now - new Date(d.lastUsed).getTime()
      if (age > maxAgeMs) maxAgeMs = age
      if (d.count > maxCount) maxCount = d.count
    }

    // Compute score, hostLabel, resolved category at read time
    const entries = dirs.map(d => {
      // Majority vote for category
      let bestCat = defaultCat
      let bestCount = 0
      for (const [cat, cnt] of Object.entries(d.categoryVotes)) {
        if (cnt > bestCount) { bestCat = cat; bestCount = cnt }
      }

      const hostLabel = d.host ? hosts[d.host]?.label ?? d.host : undefined
      const ageMs = now - new Date(d.lastUsed).getTime()
      const recencyScore = 1 - (ageMs / maxAgeMs)
      const freqScore = d.count / maxCount
      const score = freqScore * 0.3 + recencyScore * 0.7

      return {
        cwd: d.cwd,
        host: d.host,
        hostLabel,
        category: bestCat,
        count: d.count,
        lastUsed: d.lastUsed,
        lastLaunch: d.lastLaunch,
        score,
      }
    })

    entries.sort((a, b) => b.score - a.score)
    const result = entries.map(({ score: _s, ...rest }) => rest)
    // Configured hosts ride along so the session launcher can offer every host
    // from config.hosts — not just hosts that already have session history.
    // Without this, a freshly added remote host never appears in Quick Start
    // until its first session exists (chicken-and-egg).
    // Only include enabled hosts (enabled defaults to true when unset).
    // rawName marks auto-discovered FQDN-only entries (alias == hostname, no
    // human-chosen alias) so the launcher can nudge the user to name them.
    const configuredHosts = Object.entries(hosts)
      .filter(([_alias, h]) => h.enabled !== false)
      .map(([alias, h]) => ({
        alias,
        label: h.label ?? alias,
        rawName: alias === h.hostname || undefined,
      }))
    res.json({ dirs: result, hosts: configuredHosts })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/working-dirs/recompile — rebuild frequent-directories.json from sessions
sessionsRouter.post('/working-dirs/recompile', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // compileFromSessions imported statically at top
    await compileFromSessions()
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    res.json({ status: 'ok', count: dirs.length })
  } catch (err) {
    next(err)
  }
})

// In-memory cache for SSH directory listings (avoid re-SSHing for 60s)
const dirCache = new Map<string, { dirs: string[]; exists: boolean; ts: number }>()
const DIR_CACHE_TTL = 60_000

// GET /api/sessions/list-dirs — list subdirectories on a host (local or daemon) for path auto-complete
// Remote hosts use DaemonConnection for fast directory listing.
sessionsRouter.get('/list-dirs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prefix = String(req.query.prefix ?? '/')
    const host = req.query.host as string | undefined
    const depth = Math.min(Number(req.query.depth) || 2, 4) // preload depth, default 2, max 4

    if (prefix.length > 4096) {
      res.status(400).json({ error: 'prefix too long' })
      return
    }

    // Sanitize: no shell metacharacters allowed in prefix
    if (/[;&|`$(){}!<>]/.test(prefix)) {
      res.status(400).json({ error: 'invalid characters in prefix' })
      return
    }

    // Expand ~ to home directory
    let expandedPrefix = prefix
    if (expandedPrefix === '~' || expandedPrefix.startsWith('~/')) {
      if (host) {
        // Remote: keep ~ as-is — the daemon's fs.ls handles ~ expansion on the remote host
      } else {
        const os = await import('node:os')
        const home = os.homedir()
        // Preserve trailing slash: ~/ → /Users/me/, ~/foo → /Users/me/foo
        expandedPrefix = home + expandedPrefix.slice(1)
      }
    }

    // Find the parent directory to list.
    // Partial matching is handled by the frontend's filterChildren — backend returns all entries.
    const dir = expandedPrefix.endsWith('/') ? expandedPrefix : path.dirname(expandedPrefix)

    if (host) {
      // Remote: resolve host from config and use DaemonConnection for directory listing
      const config = await getConfig()
      const hostDef = config.hosts?.[host]
      if (!hostDef) {
        res.status(400).json({ error: `Unknown host: ${host}` })
        return
      }
      const hostname = hostDef.hostname
      if (!hostname) {
        res.status(400).json({ error: `Host "${host}" has no hostname` })
        return
      }

      // Check in-memory cache first
      const cacheKey = `${host}::${dir}::${depth}`
      const cached = dirCache.get(cacheKey)
      if (cached && Date.now() - cached.ts < DIR_CACHE_TTL) {
        res.json({ dirs: cached.dirs, parent: dir, exists: cached.exists, cached: true })
        return
      }

      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname, user: hostDef.user, port: hostDef.port }
      // Race against a 15s timeout to cap HTTP request wait time.
      // The failure cache in daemon-connection.ts prevents retries for 60s after a failure.
      let timeoutId: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Remote connection to ${host} timed out`)), 15_000)
      })
      const conn = await Promise.race([
        getDaemonConnection(host, sshTarget),
        timeoutPromise,
      ]).finally(() => clearTimeout(timeoutId!))

      // BFS listing via daemon fs.ls (dir-listing.ts). ENOENT → exists:false (200);
      // other daemon/SSH errors throw and map to 400 below.
      const listing = await listRemoteDirs(conn, dir, depth)

      // Cache results (also under the resolved path — the daemon may have expanded ~)
      const resolvedCacheKey = `${host}::${listing.parent}::${depth}`
      dirCache.set(cacheKey, { dirs: listing.dirs, exists: listing.exists, ts: Date.now() })
      if (resolvedCacheKey !== cacheKey) {
        dirCache.set(resolvedCacheKey, { dirs: listing.dirs, exists: listing.exists, ts: Date.now() })
      }

      res.json({ dirs: listing.dirs, parent: listing.parent, exists: listing.exists })
    } else {
      const listing = await listLocalDirs(dir, depth)
      res.json({ dirs: listing.dirs, parent: listing.parent, exists: listing.exists })
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // SSH failures return 400, not 500
    res.status(400).json({ error: msg })
  }
})

/**
 * Fix-Walnut intent: wrap the user's bug report in a repair briefing. Kept
 * server-side so iOS/cloud clients reuse it and copy iterates without a web
 * redeploy. Repo-level safety rules (never kill :3456, dev:prod, log toolkit)
 * are NOT repeated here — the session's cwd is the Walnut checkout, so the CLI
 * auto-loads CLAUDE.md with all of them.
 */
function buildFixWalnutMessage(userReport: string): string {
  return [
    `The user reports something wrong with Walnut (this app — you are running inside its source checkout). Their report:`,
    ``,
    `"""`,
    userReport,
    `"""`,
    ``,
    `Fix it end to end:`,
    `1. Reproduce/diagnose first — structured logs live in /tmp/open-walnut/ (start with \`scripts/walnut-logs.sh diagnose\`, see CLAUDE.md for the toolkit). If a screenshot is attached, read it.`,
    `2. Find the root cause — fix causes, not symptoms.`,
    `3. Implement the fix, then build and verify per the repo's CLAUDE.md workflow.`,
    `4. Summarize root cause and what changed.`,
  ].join('\n')
}

// POST /api/sessions/quick-start — create task + start session in one step
sessionsRouter.post('/quick-start', async (req: Request, res: Response, next: NextFunction) => {
  const requestTs = Date.now()
  try {
    const { cwd, host, message, model: rawModel, mode, images, taskId: existingTaskId, taskMeta, intent, createCwd, engine } = req.body as {
      cwd: string
      host?: string
      message: string
      model?: string
      mode?: string
      images?: ImagePayload[]
      taskId?: string // retry mode: reuse existing task instead of creating a new one
      taskMeta?: {
        starred?: boolean
        needs_attention?: boolean
        priority?: 'immediate' | 'important' | 'backlog' | 'none'
        pinTier?: 'focus' | 'satellite' | 'wait'
      }
      /** Optional launch intent — 'fix-walnut' wraps the message in a repair briefing. */
      intent?: string
      /** User opted into "create & start": mkdir the cwd (recursive) before starting. */
      createCwd?: boolean
      /** Coding-agent engine ('claude' default | 'codex' via ACP). */
      engine?: string
    }

    if (!cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'cwd is required' })
      return
    }
    // An EMPTY message is allowed: spawn + init the CLI (SessionStart hook,
    // MCP/skills load) with no first turn — it idles on stdin until the user
    // sends. Same daemon contract as restart's empty-queue respawn.
    if (typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' })
      return
    }
    if (intent !== undefined && intent !== 'fix-walnut') {
      res.status(400).json({ error: `Invalid intent: ${intent}. Must be 'fix-walnut'` })
      return
    }

    // Normalize model through the shared switch validator (same ruleset as
    // POST /:sessionId/model): legacy alias ids map to their CLI form, catalog
    // values (full provider IDs from the host catalog dropdown) pass verbatim,
    // and 'default'/'' mean Auto. Garbage is an explicit 400 — the old
    // VALID_SESSION_MODEL_IDS check silently downgraded unknown strings to
    // Auto, which read as "my model choice was ignored".
    let model: string | undefined
    if (typeof rawModel === 'string' && rawModel && rawModel !== 'default') {
      const resolved = resolveModelSwitchValue(rawModel)
      if (!resolved) {
        res.status(400).json({ error: `Invalid model: ${rawModel}. Use a catalog value (GET /api/sessions/host-model-catalogs) or one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}` })
        return
      }
      model = resolved
    }

    if (mode) {
      const validModes = ['bypass', 'accept', 'default', 'plan']
      if (!validModes.includes(mode)) {
        res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
        return
      }
    }

    // Whitelist enum values from taskMeta — these flow into updateTask/setFocusTier
    // and would corrupt task state if arbitrary strings were accepted.
    if (taskMeta?.priority !== undefined && taskMeta.priority !== null) {
      const validPriorities = ['immediate', 'important', 'backlog', 'none']
      if (!validPriorities.includes(taskMeta.priority)) {
        res.status(400).json({ error: `Invalid taskMeta.priority: ${taskMeta.priority}. Must be one of: ${validPriorities.join(', ')}` })
        return
      }
    }
    if (taskMeta?.pinTier !== undefined && taskMeta.pinTier !== null) {
      const validTiers = ['focus', 'satellite', 'wait']
      if (!validTiers.includes(taskMeta.pinTier)) {
        res.status(400).json({ error: `Invalid taskMeta.pinTier: ${taskMeta.pinTier}. Must be one of: ${validTiers.join(', ')}` })
        return
      }
    }

    // Length limits
    if (cwd.length > 4096) {
      res.status(400).json({ error: 'cwd too long (max 4096 chars)' })
      return
    }
    if (message.length > QUICK_START_MESSAGE_HARD_LIMIT) {
      res.status(400).json({ error: `message too long (max ${QUICK_START_MESSAGE_HARD_LIMIT} chars)` })
      return
    }

    // Process attached images — save to disk and build session-friendly context.
    // Prefix is applied AFTER spill inside quickStartSession (same order as before).
    let messagePrefix: string | undefined
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) {
        messagePrefix = buildSessionImageContext(processed.savedImages)
      }
    }

    // No system-prompt hint is injected for quick-start sessions. (We used to
    // tell the session to rename/recategorize the task on completion, but that
    // pushed sessions into unrelated task-management side-quests.) Extension
    // point: pass an `appendSystemPrompt` on SESSION_START if a future need arises.

    // Fix-Walnut intent: wrap the report in the repair briefing and give the
    // task a recognizable title/project (instead of "Session: walnut" / Quick Start).
    const isFixWalnut = intent === 'fix-walnut'
    const sessionMessage = isFixWalnut ? buildFixWalnutMessage(message) : message
    const reportSnippet = message.replace(/\s+/g, ' ').trim().slice(0, 60)
    // Fix Walnut follows the SAME launch defaults as a regular quick session —
    // the web client sends its sticky launcher tier explicitly, and headless
    // clients (iOS/cloud) that send no pick get the launcher's Satellite
    // baseline instead of a hardcoded Focus override (the old behavior, which
    // ignored the user's remembered tier on every repair). `pinTier: null`
    // still opts out of pinning entirely. Keep this literal in sync with the
    // frontend baseline: DEFAULT_META.pinTier in
    // web/src/components/sessions/task-meta-constants.ts.
    const fixWalnutTaskMeta = isFixWalnut && taskMeta?.pinTier === undefined
      ? { ...taskMeta, pinTier: 'satellite' as const }
      : taskMeta
    const fixWalnutExtras = isFixWalnut
      ? { taskTitle: `Fix Walnut: ${reportSnippet}`, project: 'Fix Walnut' }
      : {}

    // Shared core (also used by the claude-code routine executor): task create/
    // reuse + TASK_CREATED + SESSION_START emit + remote failure-cache clear.
    try {
      if (createCwd === true) {
        // Same sanitize rule as list-dirs — this path flows into a daemon RPC.
        if (/[;&|`$(){}!<>]/.test(cwd)) {
          res.status(400).json({ error: 'invalid characters in cwd' })
          return
        }
        await ensureCwd(cwd, host)
      }
      // Mint the session id HERE so it can ride the response: the UI then mounts
      // the real session panel in the same frame as the click instead of parking
      // on a placeholder until the CLI's first init line (3–6s later). The CLI
      // adopts this id via --session-id. Codex/ACP is excluded (its adapter owns
      // id assignment), so those clients keep the poll-for-id path.
      const isNativeEngine = engine !== 'codex'
      const preassignedSessionId = isNativeEngine ? randomUUID() : undefined
      const updatedTask = await quickStartSession({
        message: sessionMessage, messagePrefix, cwd, host, model, mode,
        existingTaskId, taskMeta: fixWalnutTaskMeta, source: 'quick-start', requestTs,
        engine: engine === 'codex' ? 'codex' : undefined,
        preassignedSessionId,
        ...fixWalnutExtras,
      })
      // Remember this folder's launch config for next time (fire-and-forget).
      // Stores the RAW picker value (not the CLI-normalized `model`) so the
      // launcher dropdown can re-select it verbatim. Retries keep the original
      // memory (existingTaskId set → the user didn't re-pick anything), and
      // fix-walnut launches don't count — that's a repair intent with no
      // model pick, not a preference for the Walnut checkout dir.
      if (!existingTaskId && !isFixWalnut) {
        const rawPickerModel = typeof rawModel === 'string' && rawModel && rawModel !== 'default' ? rawModel : undefined
        recordLaunchPrefs(cwd, host ?? null, {
          model: rawPickerModel,
          engine: engine === 'codex' ? 'codex' : undefined,
        }).catch(() => {})
      }
      // sessionId is present for native starts (see preassignedSessionId above).
      // Clients MUST treat it as optional — a Codex start omits it.
      res.json({
        taskId: updatedTask.id,
        task: updatedTask,
        ...(preassignedSessionId ? { sessionId: preassignedSessionId } : {}),
      })
    } catch (err) {
      if (err instanceof QuickStartError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

async function readProviderSessionHistory(
  sessionId: string,
  record: SessionRecord | null | undefined,
  nativeHost: string | null | undefined,
  skipSubagents = true,
): Promise<{ messages: SessionHistoryMessage[]; sourceAvailable: boolean }> {
  if (record?.engine === 'codex') {
    const state = await readAcpSessionHistoryState(record)
    return { messages: state.messages, sourceAvailable: state.journalExists }
  }
  const messages = await readSessionHistory(
    sessionId,
    record?.cwd,
    nativeHost ?? undefined,
    record?.outputFile,
    { skipSubagents },
  )
  return { messages, sourceAvailable: messages.length > 0 }
}

function unavailableHistoryReason(record: SessionRecord): string {
  if (record.engine === 'codex') {
    if (!record.acpRuntimeId) {
      return 'Codex session has no ACP runtime ID, so its history journal cannot be located'
    }
    return record.host
      ? `Codex session history journal is unavailable on remote host "${record.host}"`
      : 'Codex session history journal not found'
  }
  return record.host
    ? `Remote host "${record.host}" is unreachable — session history is stored on that machine`
    : 'Session history file not found'
}

// GET /api/sessions
sessionsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await listSessions()
    const sessions = all.filter(s => !isEnvironmentSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/recent
sessionsRouter.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const all = await getRecentSessions(limit)
    const sessions = all.filter(s => !isEnvironmentSession(s) && !s.archived)
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/summaries
sessionsRouter.get('/summaries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    const summaries = await getSessionSummaries(limit)
    res.json({ summaries })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/host-model-catalogs — last-known CLI model catalog per host
// (written every time any session's list_models succeeds). Feeds the surfaces
// that have NO session yet: the quick-session model dropdown and host pickers.
// Keys: host alias, or '__local__' for the local machine.
// MUST be registered before the '/:sessionId' catch-all below.
sessionsRouter.get('/host-model-catalogs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ catalogs: await listHostModelCatalogs() })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/status?ids=<provider-id,...> — bounded snapshot hydration.
// Registered before /:sessionId so "status" is never interpreted as an ID.
sessionsRouter.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = Array.isArray(req.query.ids)
      ? req.query.ids.join(',')
      : req.query.ids
    if (typeof raw !== 'string' || raw.trim() === '') {
      res.status(400).json({ error: 'ids is required' })
      return
    }
    const ids = raw.split(',').map((id) => id.trim())
    if (ids.some((id) => id.length === 0 || id.length > 256)) {
      res.status(400).json({ error: 'ids contains an invalid provider session ID' })
      return
    }
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length > 100) {
      res.status(400).json({ error: 'ids supports at most 100 provider session IDs' })
      return
    }
    res.json({ statuses: await getSessionStatusSnapshots(uniqueIds) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/task/:taskId
sessionsRouter.get('/task/:taskId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Resolve task ID prefix to full ID (frontend may pass short prefix from URL params)
    let taskId = String(req.params.taskId)
    try {
      const task = await getTask(taskId)
      taskId = task.id
    } catch { /* task not found — use raw param as-is */ }
    const all = await getSessionsForTask(taskId)
    // Exclude environment sessions (archived sessions kept — frontend needs them for collapsed section)
    const sessions = all.filter(s => !isEnvironmentSession(s))
    res.json({ sessions: await enrichWithHostnames(await enrichWithLiveStatus(sessions)) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/vscode-uri
sessionsRouter.get('/:sessionId/vscode-uri', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionByClaudeId(String(req.params.sessionId))
    res.json({ uri: await buildSessionVscodeUri(session) })
  } catch (err) {
    if (err instanceof SessionVscodeUriError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId
sessionsRouter.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionByClaudeId(String(req.params.sessionId))
    if (!session) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    const [enriched] = await enrichWithHostnames(await enrichWithLiveStatus([session]))
    // Include provider-neutral live pending permissions. ACP sessions attach
    // lazily after a server restart, restoring pending state from the worker.
    let pendingPermissions: Array<{
      requestId: string
      toolName?: string
      input?: Record<string, unknown>
      reason?: string
    }> = []
    try {
      const sessionId = String(req.params.sessionId)
      const liveSession = session.engine === 'codex'
        ? await sessionRunner.findOrAttachAcpSession(sessionId)
        : sessionRunner.findByClaudeId(sessionId)
      pendingPermissions = liveSession?.hasPendingPermission
        ? liveSession.getPendingPermissionRequests()
        : []
    } catch (err) {
      log.web.warn('failed to restore pending session permissions', {
        sessionId: String(req.params.sessionId),
        error: err instanceof Error ? err.message : String(err),
      })
    }
    res.json({ session: enriched, pendingPermissions })
  } catch (err) {
    next(err)
  }
})

async function clearArchivedSessionTaskLinks(
  sessionId: string,
  taskId: string,
  eventSource: string,
  requireAuthoritativeArchive = false,
): Promise<boolean> {
  if (requireAuthoritativeArchive) {
    const authoritative = await getSessionByClaudeId(sessionId)
    if (!authoritative?.archived) return false
  }

  const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
  await clearSession(taskId, sessionId)
  const { task } = await clearSessionSlot(taskId, sessionId)
  bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: eventSource })
  return true
}

function sendSessionNotFound(res: Response): void {
  res.status(404).json({
    code: 'SESSION_NOT_FOUND',
    error: 'session not found',
  })
}

const CLAUDE_SESSION_MODES = ['default', 'plan', 'bypass', 'accept'] as const

async function applySessionModeControl(
  record: SessionRecord,
  sessionId: string,
  mode: SessionMode,
): Promise<void> {
  if (record.engine === 'codex') {
    const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch((err) => {
      log.web.warn('Codex mode compatibility update could not attach; persisting record only', {
        sessionId,
        mode,
        error: err instanceof Error ? err.message : String(err),
      })
      return undefined
    })
    if (!session) return
    const collaborationMode = mode === 'plan' ? 'plan' : 'default'
    if (!await session.setConfigOption('collaboration_mode', collaborationMode)) {
      throw new Error('Codex collaboration mode change was rejected')
    }
    return
  }

  const application = await sessionRunner.changePermissionMode(sessionId, mode)
  const expectedLive = record.pid != null
    && record.process_status !== 'stopped'
    && record.process_status !== 'error'
  if (application === 'not-live' && expectedLive) {
    throw new Error('Live session is unavailable; permission mode was not changed')
  }
}

async function persistSessionModeChange(
  existingRecord: SessionRecord,
  sessionId: string,
  mode: SessionMode,
  updates: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  const updated = await updateSessionRecord(sessionId, { ...updates, mode })
  emitSessionStatusChanged(updated, {}, ['*'])

  if (updated.taskId && existingRecord.mode !== mode) {
    try {
      const { getTask, linkSessionSlot, clearSessionSlot } = await import('../../core/task-manager.js')
      const task = await getTask(updated.taskId)
      if (mode === 'plan') {
        if (!task.plan_session_id || task.plan_session_id === sessionId) {
          if (task.exec_session_id === sessionId) await clearSessionSlot(updated.taskId, sessionId, 'exec')
          await linkSessionSlot(updated.taskId, sessionId, 'plan')
          const updatedTask = await getTask(updated.taskId)
          bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: 'session-mode-change' })
        }
      } else if (task.plan_session_id === sessionId) {
        await clearSessionSlot(updated.taskId, sessionId, 'plan')
        if (!task.exec_session_id) await linkSessionSlot(updated.taskId, sessionId, 'exec')
        const updatedTask = await getTask(updated.taskId)
        bus.emit(EventNames.TASK_UPDATED, { task: updatedTask }, ['web-ui'], { source: 'session-mode-change' })
      }

      const compensated = await clearArchivedSessionTaskLinks(
        sessionId,
        updated.taskId,
        'session-mode-archive-compensation',
        true,
      )
      if (compensated) {
        log.web.info('cleared task slots relinked during session archive', {
          sessionId,
          taskId: updated.taskId,
        })
      }
    } catch { /* task not found or lock contention — ignore */ }
  }
  return updated
}

async function changeSessionMode(
  existingRecord: SessionRecord,
  sessionId: string,
  mode: SessionMode,
  updates: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  await applySessionModeControl(existingRecord, sessionId, mode)
  return persistSessionModeChange(existingRecord, sessionId, mode, updates)
}

// GET /api/sessions/:sessionId/controls — provider-neutral selectable session controls.
sessionsRouter.get('/:sessionId/controls', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = String(req.params.sessionId)
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      sendSessionNotFound(res)
      return
    }
    if (record.engine === 'codex') {
      const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined)
      if (!session) {
        res.status(409).json({ error: 'Codex ACP session is not available' })
        return
      }
      res.json({
        engine: 'codex',
        controls: session.sessionControls.filter((control) => control.id !== 'model'),
      })
      return
    }
    res.json({
      engine: 'claude',
      controls: [{
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: record.mode || 'default',
        options: CLAUDE_SESSION_MODES.map((value) => ({
          value,
          name: value[0].toUpperCase() + value.slice(1),
        })),
      }],
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/controls — apply one provider-advertised control.
sessionsRouter.post('/:sessionId/controls', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = String(req.params.sessionId)
  const { id, value } = req.body as { id?: unknown; value?: unknown }
  try {
    if (typeof id !== 'string' || typeof value !== 'string' || !id || !value) {
      res.status(400).json({ error: 'id and value must be non-empty strings' })
      return
    }
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      sendSessionNotFound(res)
      return
    }

    if (record.engine === 'codex') {
      const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined)
      if (!session) {
        res.status(409).json({ error: 'Codex ACP session is not available' })
        return
      }
      const control = session.sessionControls.find((candidate) => candidate.id === id)
      if (!control || !control.options.some((option) => option.value === value)) {
        res.status(400).json({ error: 'unknown control or value' })
        return
      }
      if (!await session.setConfigOption(id, value)) {
        res.status(409).json({ error: 'Codex ACP control change failed' })
        return
      }
      if (id === 'collaboration_mode') {
        const mirroredMode: SessionMode = value === 'plan'
          ? 'plan'
          : record.mode === 'plan' ? 'default' : record.mode
        await persistSessionModeChange(record, sessionId, mirroredMode)
      }
      res.json({
        engine: 'codex',
        controls: session.sessionControls.filter((candidate) => candidate.id !== 'model'),
      })
      return
    }

    if (id !== 'mode' || !CLAUDE_SESSION_MODES.includes(value as typeof CLAUDE_SESSION_MODES[number])) {
      res.status(400).json({ error: 'Claude sessions only support the mode control' })
      return
    }
    const updated = await changeSessionMode(record, sessionId, value as SessionMode)
    res.json({
      engine: 'claude',
      controls: [{
        id: 'mode',
        name: 'Mode',
        type: 'select',
        currentValue: updated.mode,
        options: CLAUDE_SESSION_MODES.map((optionValue) => ({
          value: optionValue,
          name: optionValue[0].toUpperCase() + optionValue.slice(1),
        })),
      }],
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('session control change rejected', { sessionId, id, value, error: message })
    res.status(409).json({ error: message })
  }
})

// PATCH /api/sessions/:sessionId
sessionsRouter.patch('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, activity, human_note, archived, archive_reason, mode } = req.body as { title?: string; activity?: string; human_note?: string; archived?: boolean; archive_reason?: string; mode?: string }

    if (title !== undefined && (typeof title !== 'string' || title.length > 500)) {
      res.status(400).json({ error: 'title must be a string (max 500 chars)' })
      return
    }

    if (human_note !== undefined && (typeof human_note !== 'string' || human_note.length > 50000)) {
      res.status(400).json({ error: 'human_note must be a string (max 50000 chars)' })
      return
    }

    if (archived !== undefined && typeof archived !== 'boolean') {
      res.status(400).json({ error: 'archived must be a boolean' })
      return
    }

    const VALID_MODES = ['bypass', 'accept', 'default', 'plan'] as const
    if (mode !== undefined && !VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
      res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` })
      return
    }

    const sessionId = String(req.params.sessionId)
    // Route IDs are provider session IDs. ACP runtime IDs are transport-local
    // identities and must never select or implicitly create a durable record.
    const existingRecord = await getSessionByClaudeId(sessionId)
    if (!existingRecord) {
      sendSessionNotFound(res)
      return
    }

    // Archive/unarchive: validate session is in a terminal state before archiving
    if (archived === true) {
      if (existingRecord.process_status !== 'stopped' && existingRecord.process_status !== 'error') {
        res.status(400).json({ error: 'Stop session before archiving' })
        return
      }
    }

    const updates: Partial<SessionRecord> = {}
    if (title !== undefined) updates.title = title
    if (activity !== undefined) updates.activity = activity
    if (human_note !== undefined) updates.human_note = human_note
    if (archived !== undefined) {
      updates.archived = archived
      if (archived && archive_reason) updates.archive_reason = archive_reason
      if (!archived) updates.archive_reason = undefined  // clear reason on unarchive
    }

    let updated: SessionRecord
    if (mode !== undefined) {
      try {
        updated = await changeSessionMode(existingRecord, sessionId, mode as SessionMode, updates)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.web.warn('live permission mode change rejected', { sessionId, mode, error: message })
        res.status(409).json({ error: message })
        return
      }
    } else {
      updated = await updateSessionRecord(sessionId, updates)
    }
    log.web.info('session updated via REST', { sessionId, fields: Object.keys(updates) })

    // Emit status change so frontend updates in real time
    if (archived !== undefined && mode === undefined) {
      emitSessionStatusChanged(updated, {}, ['*'])
    }

    // Archive: clear task session slot to free it for new sessions
    if (archived === true && updated.taskId) {
      try {
        await clearArchivedSessionTaskLinks(sessionId, updated.taskId, 'session-archived')
      } catch { /* task may not exist */ }
    }

    // Task-slot work can await behind a concurrent PATCH. Return current state
    // so the caller cannot optimistically merge stale archive/mode fields.
    res.json({ session: await getSessionByClaudeId(sessionId) ?? updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/^Session not found:/.test(message)) {
      sendSessionNotFound(res)
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId/history
// ?source=streams — fast path: local-only reads (skip SSH).
// Local sessions: reads canonical JSONL (~1ms, same result as full path).
// Remote sessions: returns empty (no local files exist for remote sessions).
sessionsRouter.get('/:sessionId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const source = req.query.source as string | undefined
    const tail = req.query.tail ? parseInt(req.query.tail as string, 10) : undefined

    // Look up session record to get cwd
    const record = await getSessionByClaudeId(sessionId)

    if (source === 'streams') {
      if (record?.engine === 'codex') {
        const { messages } = await readProviderSessionHistory(sessionId, record, record.host)
        logMessageOrdering('P1:streams', sessionId, messages, record.host)
        const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
        res.json({ messages: sliced, total: messages.length })
        return
      }
      // Fast path: host=undefined forces local-only reads (canonical JSONL + streams fallback).
      // Skips SSH entirely. For local sessions this returns full data (~1ms).
      //
      // Remote sessions have no local streams file — readSessionHistory would still
      // walk the local filesystem and return empty. Short-circuit before even calling
      // it so the hook's Phase 1 doesn't waste an event loop tick (and doesn't race
      // with the Phase 2 SSH round-trip).
      if (record?.host) {
        // Serve disk cache for instant display (Phase 1) while Phase 2 does SSH
        const { readHistoryCache } = await import('../../core/history-disk-cache.js')
        const diskCached = await readHistoryCache(sessionId)
        if (diskCached && diskCached.messages.length > 0) {
          res.json({ messages: diskCached.messages, total: diskCached.messages.length })
          return
        }
        res.json({ messages: [], total: 0 })
        return
      }
      // skipSubagents: frontend lazy-loads each subagent via /subagent/:agentId/history on demand
      const { messages } = await readProviderSessionHistory(sessionId, record, undefined)
      logMessageOrdering('P1:streams', sessionId, messages, record?.host)
      const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
      res.json({ messages: sliced, total: messages.length })
      return
    }

    // Full path: reads from source of truth (SSH for remote sessions)
    let messages: Awaited<ReturnType<typeof readSessionHistory>>
    let historySourceAvailable = false
    try {
      // skipSubagents: frontend lazy-loads each subagent via /subagent/:agentId/history on demand
      const history = await readProviderSessionHistory(sessionId, record, record?.host)
      messages = history.messages
      historySourceAvailable = history.sourceAvailable
    } catch (err) {
      // Surface remote read errors (SSH auth, daemon connection, etc.) to the frontend
      const msg = err instanceof Error ? err.message : String(err)
      log.web.warn('session history read failed', { sessionId, host: record?.host, error: msg })
      // Degraded mode: an SSH-down window shouldn't blank the whole
      // conversation ("Failed to load history" over hours-old streaming
      // blocks — inc-1783406628291). Serve the last successfully parsed
      // history with a `stale` marker so the UI can render content + a
      // reconnecting banner. Delta requests (?since=) must NOT get this —
      // a stale total would corrupt the client cursor; they fail as before.
      if (req.query.since === undefined) {
        const { getCachedSessionHistory } = await import('../../core/session-history.js')
        const cached = getCachedSessionHistory(sessionId, record?.host)
        if (cached && cached.length > 0) {
          log.web.info('serving stale history cache (live read failed)', {
            sessionId, host: record?.host, messages: cached.length,
          })
          res.json({ messages: cached, total: cached.length, stale: true, staleReason: msg })
          return
        }
        // Disk cache fallback (survives app restarts)
        const { readHistoryCache } = await import('../../core/history-disk-cache.js')
        const diskCached = await readHistoryCache(sessionId)
        if (diskCached && diskCached.messages.length > 0) {
          log.web.info('serving disk-cached history (live read threw)', {
            sessionId, host: record?.host, messages: diskCached.messages.length, cachedAt: diskCached.cachedAt,
          })
          res.json({ messages: diskCached.messages, total: diskCached.messages.length, stale: true, staleReason: msg })
          return
        }
      }
      res.status(502).json({ error: msg })
      return
    }
    logMessageOrdering('P2:full', sessionId, messages, record?.host)
    if (messages.length === 0 && !record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Disk cache fallback: when the live read returned empty (remote JSONL gone,
    // daemon just restarted, etc.) but the session record exists, serve the last
    // successfully cached history so the user doesn't see "No history found".
    // Delta requests must continue to the cursor logic below: a stale cache has
    // a different cursor space, and ?since=0 on a genuinely empty archive is a
    // valid empty delta rather than a full history-unavailable response.
    if (messages.length === 0 && record && !historySourceAvailable && req.query.since === undefined) {
      const { readHistoryCache } = await import('../../core/history-disk-cache.js')
      const diskCached = await readHistoryCache(sessionId)
      if (diskCached && diskCached.messages.length > 0) {
        log.web.info('serving disk-cached history (live read returned empty)', {
          sessionId, host: record.host, messages: diskCached.messages.length, cachedAt: diskCached.cachedAt,
        })
        res.json({
          messages: diskCached.messages,
          total: diskCached.messages.length,
          cursor: diskCached.messages.length,
          delta: false,
          stale: true,
          staleReason: 'Session file unavailable — showing cached history',
        })
        return
      }
      // No disk cache either — return a meaningful reason so the UI can show
      // "host unreachable" instead of generic "No conversation history found".
      const reason = unavailableHistoryReason(record)
      res.json({ messages: [], total: 0, cursor: 0, delta: false, historyUnavailable: reason })
      return
    }

    // Rewrite remote image paths to local paths for remote sessions
    if (record?.host) {
      messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd)
    }

    // Fork-aware: prepend source session history when this session was forked.
    // Follows the fork chain (A forked from B forked from C) with cycle detection.
    let forkedFromSessionId: string | undefined
    let forkBoundaryIndex: number | undefined
    let forkLoadFailed = false
    if (record?.forkedFromSessionId) {
      forkedFromSessionId = record.forkedFromSessionId
      try {
        // Two-phase to avoid serializing SSH round-trips:
        //  1) Walk the fork pointers (getSessionByClaudeId — a LOCAL, now-cached
        //     SQLite lookup) to collect ancestor records in chain order. The
        //     next id depends on the current record, so this walk stays serial
        //     but is cheap.
        //  2) Fetch + image-rewrite every ancestor's history in PARALLEL (the
        //     expensive SSH/JSONL part). Previously this was a serial
        //     await-per-ancestor loop, so a 3-deep remote chain meant 3
        //     sequential SSH pulls (~24s); parallel collapses that to ~1 pull.
        const MAX_FORK_DEPTH = 5 // backstop against pathological/cyclic chains
        const ancestors: import('../../core/types.js').SessionRecord[] = []
        const visited = new Set<string>([sessionId])
        let currentForkId: string | undefined = record.forkedFromSessionId
        while (currentForkId && !visited.has(currentForkId) && ancestors.length < MAX_FORK_DEPTH) {
          visited.add(currentForkId)
          const sourceRecord = await getSessionByClaudeId(currentForkId)
          if (!sourceRecord) break
          ancestors.push(sourceRecord)
          currentForkId = sourceRecord.forkedFromSessionId
        }

        // ancestors[0] is the immediate parent … ancestors[n-1] the root.
        // History order must be root-first (oldest → newest), so reverse.
        const ordered = [...ancestors].reverse()
        const fetched = await Promise.all(
          ordered.map(async (sourceRecord) => {
            let { messages: sourceMessages } = await readProviderSessionHistory(
              sourceRecord.claudeSessionId,
              sourceRecord,
              sourceRecord.host,
            )
            if (sourceRecord.host) {
              sourceMessages = await rewriteHistoryRemoteImages(sourceMessages, sourceRecord.host, sourceRecord.claudeSessionId, sourceRecord.cwd)
            }
            return sourceMessages
          }),
        )

        const allSourceMessages = fetched.flat()
        if (allSourceMessages.length > 0) {
          messages = [...allSourceMessages, ...messages]
          forkBoundaryIndex = allSourceMessages.length
        }
      } catch (err) {
        forkLoadFailed = true
        log.web.warn('failed to load fork source history', {
          sessionId, forkedFrom: record.forkedFromSessionId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const total = messages.length

    // ── Delta mode (?since=<N>) — the turn-boundary incremental path ──
    // N = count of combined messages the client has already rendered. Native
    // history messages are immutable by the time this endpoint exposes them, so
    // slicing messages[N..] is a lossless "what's new since you last synced".
    //
    // ACP journals are different: several text chunks project into one assistant
    // message. A client can therefore mint cursor N after the first chunk, then
    // observe the same total N after later chunks complete that message. A
    // count-only delta would return [] and strand the partial text forever.
    // Codex cursor requests consequently fall through to a full replacement.
    //
    // Contract:
    //   native + since valid (0 <= since <= total)
    //     → { messages: slice(since), cursor: total, delta: true }
    //     · slice is empty when nothing new yet (archive hasn't flushed the turn) —
    //       client treats empty delta as "not caught up", keeps streaming blocks, retries.
    //   Codex, or since > total (file rewritten/rotated, or client ahead)
    //     → full payload + delta:false
    //     so the client rebuilds from scratch. Never silently drop.
    const sinceRaw = req.query.since as string | undefined
    if (sinceRaw !== undefined) {
      const since = parseInt(sinceRaw, 10)
      // forkLoadFailed guard: the client's cursor was minted against
      // (ancestorLen + ownLen). If the ancestor read failed transiently (SSH
      // flap), `total` here is just ownLen — a since computed in the combined
      // space would slice at a bogus offset (or read as "client ahead" and
      // full-replace with a history missing its fork prefix, wiping the
      // ancestor messages from the UI until the next full reload). Serve a
      // full rebuild only when the payload is complete; otherwise 503 so the
      // client keeps its current view and retries next turn.
      if (forkLoadFailed) {
        res.status(503).json({ error: 'fork ancestor history unavailable (transient) — retry' })
        return
      }
      if (record?.engine !== 'codex'
        && Number.isFinite(since) && since >= 0 && since <= total) {
        res.json({
          messages: messages.slice(since),
          cursor: total,
          total,
          delta: true,
          // Fork fields are static after first load; client already has them.
          ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
          ...(forkBoundaryIndex != null ? { forkBoundaryIndex } : {}),
        })
        return
      }
      // Fall through to full payload (since out of range → rebuild).
    }

    const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
    // Adjust forkBoundaryIndex for the sliced window
    const adjustedForkBoundary = forkBoundaryIndex != null && tail && tail > 0
      ? (forkBoundaryIndex >= total - tail ? forkBoundaryIndex - (total - tail) : undefined)
      : forkBoundaryIndex
    res.json({
      messages: sliced,
      total,
      cursor: total,
      delta: false,
      ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
      ...(adjustedForkBoundary != null ? { forkBoundaryIndex: adjustedForkBoundary } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/subagent/:agentId/history — lazy-load a single subagent's messages
sessionsRouter.get('/:sessionId/subagent/:agentId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const agentId = req.params.agentId as string

    // Validate agentId format: hex strings (Task subagents) or name@team (Team agents)
    if (!/^[a-zA-Z0-9_@.-]+$/.test(agentId)) {
      res.status(400).json({ error: 'Invalid agentId format' })
      return
    }

    const record = await getSessionByClaudeId(sessionId)
    const cwd = record?.cwd
    // ?workflow=1 → scan the nested subagents/workflows/<runId>/ layout (dynamic
    // workflow subagents); otherwise the flat Task/Team layout.
    const isWorkflow = req.query.workflow === '1' || req.query.workflow === 'true'

    let messages = await readSingleSubagentHistory(sessionId, agentId, cwd, record?.host, isWorkflow)

    // Rewrite remote image paths for remote sessions
    if (record?.host && messages.length > 0) {
      messages = await rewriteHistoryRemoteImages(messages, record.host, sessionId, record.cwd)
    }

    res.json({ messages })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/workflow — reconstruct the dynamic-workflow progress
// panel from the on-disk run manifest. Lets the panel survive page reload / server
// restart, when the live in-memory session state is gone. 204 = no workflow ran.
sessionsRouter.get('/:sessionId/workflow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    const payload = await reconstructWorkflowProgress(sessionId, record?.cwd, record?.host)
    if (!payload) {
      res.status(204).end()
      return
    }
    res.json(payload)
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/changes — the files this session changed, with
// reconstructed before/after content for a GitHub-style diff view.
//
// ?base= selects what to compare AGAINST:
//   (absent) / 'session' → JSONL-only, this session's OWN edits (default; the only
//                           mode that can attribute concurrent edits to a session).
//   'uncommitted'         → `git diff HEAD` (working tree vs last commit)
//   'previous'            → `git diff HEAD~1` (incl. last commit, vs the one before)
//   'remote'              → `git diff @{upstream}` (unpushed vs remote)
//
// ?base= chooses the comparison baseline; ?scope= selects WHICH of the session's
// touched repos' files to show. Both git and session modes are scoped to what
// THIS session actually edited (never the cwd repo wholesale):
//   base=session (default) → JSONL replay of the session's own edits (no git).
//   base=uncommitted|previous|remote → git diff of the repos the session touched,
//     against HEAD / HEAD~1 / @{upstream}, with:
//       scope=session (default) → only the files this session edited.
//       scope=all               → every change in those touched repos.
// scope is ignored for base=session (already session-scoped by definition).
// ?refresh=1 bypasses the mtime cache.
const GIT_BASES: ReadonlySet<string> = new Set(['uncommitted', 'previous', 'remote'])
sessionsRouter.get('/:sessionId/changes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    const base = typeof req.query.base === 'string' ? req.query.base : 'session'
    const scope = req.query.scope === 'all' ? 'all' : 'session'
    const noCache = req.query.refresh === '1' || req.query.refresh === 'true'
    let result
    try {
      if (GIT_BASES.has(base)) {
        // Repo universe + (for scope=session) file set both come from the session's
        // own edits — computeSessionGitDiff diffs only the repos it touched.
        result = await computeSessionGitDiff(sessionId, base as GitDiffBase, record.cwd, record.host, scope, record.outputFile, { noCache })
      } else {
        result = await computeSessionChanges(sessionId, record.cwd, record.host, record.outputFile, { noCache })
      }
    } catch (err) {
      // Surface remote read errors (SSH/daemon) + git failures to the frontend like /history does.
      const msg = err instanceof Error ? err.message : String(err)
      log.web.warn('session changes read failed', { sessionId, host: record.host, base, scope, error: msg })
      res.status(502).json({ error: msg })
      return
    }
    // ?light=1 → names/roots only (quick-access lists, e.g. the Files tab's
    // changed-repo shortcuts). Same compute + cache; just strips the heavy
    // reconstructed before/after payload.
    if (req.query.light === '1') {
      const light = result as unknown as { groups?: Array<{ files: Array<Record<string, unknown>> }> }
      res.json({
        ...result,
        groups: (light.groups ?? []).map((g) => ({
          ...g,
          files: g.files.map((f) => ({ ...f, before: '', after: '' })),
        })),
      })
      return
    }
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/plan — read plan content for a plan session (or its source plan session)
sessionsRouter.get('/:sessionId/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Exec sessions can re-enter plan mode via execute-continue, creating their own plan.
    // When that happens, the session's own plan is newer/fresher and takes priority over
    // the original source plan (which is now stale). planCompleted alone is sufficient —
    // planFile may be absent if the plan was only in ExitPlanMode.input.plan (no Write to
    // ~/.claude/plans/), but readPlanFromSession's JSONL slug and extractPlanContent
    // strategies can still find it.
    // See also: POST /execute-continue which uses the same !planCompleted check (~line 1009).
    const hasOwnPlan = !!record.planCompleted
    const planSessionId = hasOwnPlan ? sessionId : (record.fromPlanSessionId ?? sessionId)
    const isFollowedLink = planSessionId !== sessionId

    // Strategy 1: readPlanFromSession (planFile on disk, or JSONL slug → file)
    const planResult = await readPlanFromSession(planSessionId)
    if (!('error' in planResult)) {
      res.json({
        content: planResult.content,
        planFile: planResult.planFile,
        sourceSessionId: isFollowedLink ? planSessionId : undefined,
      })
      return
    }

    // Strategy 2: extractPlanContent from JSONL (Write to plans/ or ExitPlanMode.input.plan)
    const planRecord = isFollowedLink ? await getSessionByClaudeId(planSessionId) : record
    if (planRecord) {
      const extracted = await extractPlanContent(planSessionId, planRecord.cwd, planRecord.host)
      if (extracted) {
        res.json({
          content: extracted,
          planFile: planRecord.planFile ?? undefined,
          sourceSessionId: isFollowedLink ? planSessionId : undefined,
        })
        return
      }
    }

    res.status(404).json({ error: 'No plan content found for this session' })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute-continue — resume a completed plan session with bypass permissions
sessionsRouter.post('/:sessionId/execute-continue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const session = await getSessionByClaudeId(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    // Allows plan sessions (planCompleted=true) and execution sessions (fromPlanSessionId set, planCompleted never true on exec records)
    if (!session.planCompleted && !session.fromPlanSessionId) {
      res.status(400).json({ error: 'Not a plan or execution session' })
      return
    }
    // Update mode to bypass for execution
    await updateSessionRecord(session.claudeSessionId, { mode: 'bypass' })

    // If session process is alive (running or idle), stop it first
    // so it restarts with bypass permissions via --resume
    const needsInterrupt = session.process_status !== 'stopped'

    const message = 'Execute the plan. Implement all steps as planned.'
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    await sendMessageToSession(session.claudeSessionId, message, {
      source: 'web-api',
      taskId: session.taskId,
      mode: 'bypass',
      interrupt: needsInterrupt || undefined,
    })

    log.web.info('execute-continue: resuming plan session with bypass', { sessionId: session.claudeSessionId })

    res.json({ status: 'started', sessionId: session.claudeSessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/permission — resolve a pending permission request
sessionsRouter.post('/:sessionId/permission', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const { requestId, allow, message: denyMessage } = req.body as {
      requestId: string
      allow: boolean
      message?: string
    }
    if (!requestId || typeof allow !== 'boolean') {
      res.status(400).json({ error: 'requestId (string) and allow (boolean) are required' })
      return
    }
    // ACP sessions answer permissions via the daemon acpRespond RPC (async).
    const acpSession = sessionRunner.findAcpSession(sessionId)
    if (acpSession) {
      const ok = await acpSession.resolvePermissionRequest(requestId, allow)
      if (!ok) {
        res.status(404).json({ error: 'Permission request not found or already resolved' })
        return
      }
      res.json({ status: 'resolved', requestId, allow })
      return
    }
    const session = sessionRunner.findByClaudeId(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Live session not found' })
      return
    }
    const resolved = session.resolvePermissionRequest(requestId, allow, denyMessage)
    if (!resolved) {
      res.status(404).json({ error: 'Permission request not found or already resolved' })
      return
    }
    res.json({ status: 'resolved', requestId, allow })
  } catch (err) {
    next(err)
  }
})

// ── Side questions ("/btw") ─────────────────────────────────────────────────
// The native Claude Code side_question control_request, run INSIDE the live coding
// session (reuses its own prompt-cache prefix), answer kept OUT of the main
// transcript. See ClaudeCodeSession.askSideQuestion + side-questions.ts store.

// POST /api/sessions/:sessionId/effort — change reasoning effort mid-session.
// Delivers via apply_flag_settings control_request (no respawn) when the CLI is live;
// always persists record.effort so the badge reflects it and a cold --resume re-applies
// --effort. Validates the level (the CLI itself silently accepts an invalid `max`, so
// the guard MUST live here — verified against 2.1.170). Capability authority order:
// (1) the LIVE catalog row's supportedEffortLevels when present, (2) its
// supportsEffort boolean (can veto, but xhigh/max still need the static
// per-family gate), (3) the static model-family tables as the last resort when
// no live capability data exists.
sessionsRouter.post('/:sessionId/effort', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const { effort: rawEffort } = req.body as { effort?: string }
  try {
    if (typeof rawEffort !== 'string' || !VALID_SESSION_EFFORT_IDS.has(rawEffort)) {
      res.status(400).json({ error: `effort must be one of low/medium/high/xhigh/max` })
      return
    }
    const effort = rawEffort as SessionEffort

    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined)
    const recordModel = record.cliModel || record.model
    let model = recordModel
    let liveRow: ReturnType<typeof matchSessionModelCatalogEntry> = null
    if (session) {
      const [settings, catalog] = await Promise.all([
        session.getSettingsSnapshot().catch(() => null),
        session.getModelCatalog().catch(() => null),
      ])
      model = settings?.applied.model || recordModel
      liveRow = matchSessionModelCatalogEntry(catalog?.models ?? [], model)
    }
    if (!liveRow) {
      // Live catalog unavailable (dead session / CLI timeout): consult the
      // persisted host catalog — the SAME source the picker renders from — so
      // a level the UI shows enabled can't 409 here on static-table grounds.
      const hostCatalog = await getHostModelCatalog(record.host).catch(() => null)
      liveRow = matchSessionModelCatalogEntry(hostCatalog?.models ?? [], model)
    }

    // Effort-capability authority, most→least trusted: (1) the catalog row's
    // explicit supportedEffortLevels list, (2) its supportsEffort boolean (can
    // veto but not grant xhigh/max — those need the static per-family gate too),
    // (3) the static model tables as last resort (no catalog row anywhere).
    // Simplifying this nesting either rejects new provider models or allows
    // levels the CLI will silently downgrade.
    const liveLevels = liveRow?.supportedEffortLevels
    const supported = liveLevels !== undefined
      ? liveLevels.includes(effort)
      : effort === 'xhigh'
        ? liveRow?.supportsEffort !== false && modelSupportsXhighEffort(model)
        : effort === 'max'
          ? liveRow?.supportsEffort !== false && modelSupportsMaxEffort(model)
          : liveRow?.supportsEffort ?? modelSupportsEffort(model)
    if (!supported) {
      res.status(409).json({ error: `Model "${model ?? 'unknown'}" does not support "${effort}" reasoning effort` })
      return
    }

    // Persist first so the badge + cold-resume fallback reflect the choice even if
    // the session isn't live right now (idle-reaped → next spawn re-applies --effort).
    await updateSessionRecord(sessionId, { effort })

    // If the CLI is live, push the change now via control_request (no respawn).
    // Attach-on-demand (same as the side-question route) so a genuinely-alive session
    // the reconciler didn't map doesn't falsely report "not live".
    let applied = false
    let effectiveEffort: string | undefined
    if (session) {
      try {
        applied = await session.applyEffort(effort)
        // VERIFY: the apply_flag_settings ACK returns success even when the CLI
        // silently overrides (env CLAUDE_CODE_EFFORT_LEVEL) or downgrades the level.
        // So we don't trust the ACK — read back the CLI's true effort and report it.
        // null (old CLI / read failed) ⇒ leave effectiveEffort undefined, no clobber.
        if (applied) {
          effectiveEffort = (await session.refreshEffectiveEffort('effort-change').catch(() => null)) ?? undefined
        }
      } catch (err) {
        // Non-fatal: the persisted effort still applies on the next (re)spawn.
        log.web.warn('applyEffort control_request failed — persisted for next spawn', {
          sessionId, effort, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // overridden = the CLI is actually using a DIFFERENT level than requested (env
    // override or model downgrade). Only assert it when we got a trusted read-back.
    const overridden = effectiveEffort !== undefined && effectiveEffort !== effort
    log.web.info('session effort changed', { sessionId, effort, appliedLive: applied, effectiveEffort, overridden })
    res.json({ effort, appliedLive: applied, effectiveEffort, overridden })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/model — change the model mid-session.
// Same mechanism as /effort: apply_flag_settings control_request (no respawn, the
// running turn is untouched) + get_settings read-back for the true applied model.
// Persists record.cliModel so a cold --resume respawns with the new --model.
// Accepts BOTH a legacy picker alias ('sonnet-1m' → mapped to 'sonnet[1m]') and
// a catalog value from GET /:id/models ('global.anthropic.claude-fable-5[1m]',
// 'default' — passed through verbatim; the CLI is the authority on validity).
sessionsRouter.post('/:sessionId/model', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const { model: rawModel } = req.body as { model?: string }
  try {
    if (typeof rawModel !== 'string' || !rawModel.trim()) {
      res.status(400).json({ error: 'model must be a non-empty string' })
      return
    }

    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }

    if (record.engine === 'codex') {
      const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined)
      const applied = session
        ? await session.setModel(rawModel).catch((err) => {
            log.web.warn('ACP session model switch failed', {
              sessionId,
              model: rawModel,
              error: err instanceof Error ? err.message : String(err),
            })
            return false
          })
        : false
      if (!applied) {
        res.status(409).json({ error: 'model switch failed' })
        return
      }
      log.web.info('ACP session model changed', { sessionId, model: rawModel })
      res.json({ applied: true, model: rawModel })
      return
    }

    const cliModel = resolveModelSwitchValue(rawModel)
    if (!cliModel) {
      res.status(400).json({ error: `model must be a catalog value from GET /:sessionId/models or one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}` })
      return
    }

    // Persist first — the durable cold-resume fallback (apply_flag_settings is
    // in-memory only).
    await updateSessionRecord(sessionId, { cliModel })

    // If the CLI is live, push the change now via control_request (no respawn).
    let applied = false
    let effectiveModel: string | undefined
    const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined)
    if (session) {
      try {
        applied = await session.applyModel(cliModel)
        // VERIFY: the ACK is success even for a silently-ignored value (verified on
        // 2.1.170 with a garbage model). Read back applied.model as the truth.
        if (applied) {
          effectiveModel = (await session.refreshAppliedSettings('model-change').catch(() => null))?.model ?? undefined
          // Read-back disagrees with what we asked for ⇒ the CLI rejected or
          // silently substituted it (allowlist / wire-level fallback). Our
          // cached catalog is evidently stale — drop it so the picker's next
          // open refetches, and tell the caller the switch did NOT take.
          if (effectiveModel && !modelReadBackMatches(cliModel, effectiveModel)) {
            applied = false
            session.invalidateModelCatalog()
          }
        }
      } catch (err) {
        // Non-fatal: the persisted cliModel still applies on the next (re)spawn.
        log.web.warn('applyModel control_request failed — persisted for next spawn', {
          sessionId, model: cliModel, error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    log.web.info('session model changed', { sessionId, model: rawModel, cliModel, appliedLive: applied, effectiveModel })
    res.json({ model: rawModel, cliModel, appliedLive: applied, effectiveModel })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/model-catalog — live ACP-discovered Codex models.
sessionsRouter.get('/:sessionId/model-catalog', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    if (record.engine !== 'codex') {
      res.status(409).json({ error: 'model catalog is only available for Codex ACP sessions' })
      return
    }
    const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined)
    if (!session) {
      res.status(409).json({ error: 'Codex ACP session is not available' })
      return
    }
    const catalog = session.modelCatalog
    res.json({
      models: catalog.availableModels,
      currentModelId: catalog.currentModelId ?? record.acpModel,
      source: 'acp',
    })
  } catch (err) {
    next(err)
  }
})

/** Does the get_settings read-back string plausibly equal what we switched to?
 *  Tolerates decoration differences: 'global.anthropic.claude-opus-4-6-v1[1m]'
 *  vs 'claude-opus-4-6[1m]' vs 'opus[1m]' all describe the same runtime model.
 *  Aliases ('opus', 'sonnet[1m]') can't be compared literally — for those we
 *  only require family containment. 'default' can resolve to anything → always
 *  matches (the CLI decides what default means). */
function modelReadBackMatches(requested: string, effective: string): boolean {
  if (requested === 'default') return true
  const strip = (s: string) => s.toLowerCase().replace(/\[1m\]$/, '').replace(/[-_]v\d+(:\d+)?$/, '')
  const req = strip(requested)
  const eff = strip(effective)
  if (req === eff || eff.includes(req) || req.includes(eff)) return true
  // Alias forms: compare family + [1m]-ness instead of the raw strings.
  const fam = (s: string) => ['haiku', 'sonnet', 'fable', 'opus', 'mythos'].find((f) => s.includes(f))
  const is1m = (s: string) => /\[1m\]$/.test(s.toLowerCase())
  return fam(req) !== undefined && fam(req) === fam(eff) && is1m(requested) === is1m(effective)
}

// GET /api/sessions/:sessionId/models — the session's TRUE selectable model
// catalog, fetched from the CLI's `initialize` control response (already
// filtered by the host's availableModels allowlist and mapped through
// modelOverrides). Each row's `value` is what the picker must send back to
// POST /:sessionId/model. Degrades, never 5xxs:
//   source:'cli'      → live catalog (row values are full provider IDs)
//   source:'host'     → the host's last-known CLI catalog (same rows/shape as
//                       'cli' — the catalog is a host property) when THIS
//                       session can't answer (dead/unreachable/old CLI).
//   source:'fallback' → static SESSION_MODELS registry rendered in catalog
//                       shape (row values are legacy alias ids) — host never
//                       produced a catalog (first install).
// ?refresh=1 bypasses the session's cache (e.g. after a failed switch).
sessionsRouter.get('/:sessionId/models', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    // Same-shape degradation: prefer the host's last-known CLI catalog over the
    // static registry so pickers never flash between two row shapes.
    const hostFallback = async (live: boolean) => {
      const hostCatalog = await getHostModelCatalog(record.host).catch(() => null)
      if (hostCatalog) {
        res.json({ source: 'host', live, models: hostCatalog.models, fetchedAt: hostCatalog.fetchedAt })
      } else {
        res.json({ source: 'fallback', live, models: sessionModelsAsCatalog() })
      }
    }
    const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined)
    if (!session) {
      await hostFallback(false)
      return
    }
    const catalog = await session.getModelCatalog({ force: req.query.refresh === '1' }).catch(() => null)
    if (!catalog) {
      await hostFallback(true)
      return
    }
    res.json({
      source: 'cli', live: true, models: catalog.models,
      fetchedAt: new Date(catalog.fetchedAt).toISOString(),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/settings — LIVE pull of the CLI's true runtime
// settings (get_settings → applied.model/effort), paired with Walnut's requested
// values so the UI can show full visibility: what you asked for vs what the CLI
// is actually using (env overrides / silent downgrades / ignored values).
// `live:false` ⇒ CLI not reachable (dead/old build) → applied fields are null and
// the UI should fall back to the record values without claiming them as truth.
//
// ?details=1 additionally pulls the heavier live reads for the picker's
// collapsed "Live details" section (fetched lazily on expand, not on open):
//   • get_context_usage — the CLI's own per-category context breakdown, same
//     source as the /context command (incl. effective window after env clamps)
//   • get_usage        — CLI-accounted cost + per-model tokens (incl. subagents)
//   • get_binary_version
// All three run in parallel with the settings read; each degrades to null
// independently (same untrusted-read contract).
sessionsRouter.get('/:sessionId/settings', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const wantDetails = req.query.details === '1'
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    const requested = {
      model: record.cliModel ?? record.model,
      effort: record.effort,
      mode: record.mode,
    }
    // Attach-on-demand (same as /effort and /model) so a live-but-unmapped session
    // still answers. getSettings() resolves null on timeout/old CLI — never throws.
    let applied: { model: string | null; effort: string | null; mode: string | null } | null = null
    let effective: { effortLevel: SessionEffort | null } | null = null
    let details: {
      contextUsage: import('../../providers/claude-code-session.js').CliContextUsage | null
      usage: Record<string, unknown> | null
      binaryVersion: { version?: string; buildTime?: string } | null
    } | undefined
    const session = await sessionRunner.getOrAttachLiveSession(sessionId).catch(() => undefined)
    if (session) {
      const [settingsSnapshot, contextUsage, usage, binaryVersion] = await Promise.all([
        session.getSettingsSnapshot().catch(() => null),
        wantDetails ? session.getContextUsage().catch(() => null) : Promise.resolve(null),
        wantDetails ? session.getUsage().catch(() => null) : Promise.resolve(null),
        wantDetails ? session.getBinaryVersion().catch(() => null) : Promise.resolve(null),
      ])
      if (settingsSnapshot) {
        const settings = settingsSnapshot.applied
        // Mode has no field in get_settings' applied block — the live session's
        // _mode IS the runtime truth (reconciled from the CLI's system/status
        // events, incl. our set_permission_mode echoes and in-CLI EnterPlanMode).
        applied = { model: settings.model ?? null, effort: settings.effort ?? null, mode: session.mode ?? null }
        const configuredEffort = settingsSnapshot.effective?.effortLevel
        effective = {
          effortLevel: typeof configuredEffort === 'string' && VALID_SESSION_EFFORT_IDS.has(configuredEffort)
            ? configuredEffort as SessionEffort
            : null,
        }
        // Opportunistically reconcile record/badge state from this same read —
        // one round-trip serves both the picker and the persisted truth
        // (pass the snapshot so refresh doesn't issue a second get_settings).
        void session.refreshAppliedSettings('picker-pull', settingsSnapshot.applied).catch(() => null)
      }
      if (wantDetails) details = { contextUsage, usage, binaryVersion }
    } else if (wantDetails) {
      details = { contextUsage: null, usage: null, binaryVersion: null }
    }
    res.json({ live: applied !== null, requested, applied, effective, ...(details !== undefined ? { details } : {}) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/side-questions — history list for the drawer
sessionsRouter.get('/:sessionId/side-questions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await listSideQuestions(req.params.sessionId as string)
    res.json({ sideQuestions: list })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/side-question — ask + persist + broadcast
sessionsRouter.post('/:sessionId/side-question', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const { question } = req.body as { question?: string }
  try {
    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'question (non-empty string) is required' })
      return
    }
    // Attach-on-demand: findByClaudeId only sees the in-memory map (≈ the sessions
    // the startup reconciler flagged), so a genuinely-alive session the user can
    // chat with would falsely 404 here. getOrAttachLiveSession rehydrates via
    // attachToExisting — same resolution a normal send turn gets in processNext.
    const session = await sessionRunner.getOrAttachLiveSession(sessionId)
    if (!session) {
      res.status(404).json({ error: 'Live session not found' })
      return
    }
    const answer = await session.askSideQuestion(question.trim())
    const entry = await addSideQuestion(sessionId, question.trim(), answer)
    bus.emit(EventNames.SESSION_SIDE_QUESTION_DONE, {
      sessionId, id: entry.id, question: entry.question, answer: entry.answer, createdAt: entry.createdAt,
    }, ['*'], { source: 'session-runner' })
    res.json({ sideQuestion: entry })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.web.warn('side question failed', { sessionId, error: msg })
    bus.emit(EventNames.SESSION_SIDE_QUESTION_ERROR, {
      sessionId, question: question ?? '', error: msg,
    }, ['*'], { source: 'session-runner' })
    res.status(502).json({ error: msg })
  }
})

// POST /api/sessions/:sessionId/side-question/:id/promote — turn a Q&A into a task
sessionsRouter.post('/:sessionId/side-question/:id/promote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const id = req.params.id as string
    const entry = await getSideQuestion(sessionId, id)
    if (!entry) {
      res.status(404).json({ error: 'Side question not found' })
      return
    }
    // If this session is working on a task, file the promoted Q&A as a SUBTASK of
    // it (addTask inherits the parent's category/project/source). Ad-hoc sessions
    // with no originating task fall back to a top-level task.
    const sessionRecord = await getSessionByClaudeId(sessionId)
    const parentTaskId = sessionRecord?.taskId?.trim() || undefined
    const { task } = await addTask({
      title: entry.question,
      description: entry.answer,
      ...(parentTaskId ? { parent_task_id: parentTaskId } : {}),
    })
    // Link the task back to the session so it shows under that session's history.
    await linkSession(task.id, sessionId)
    await markPromoted(sessionId, id, task.id)
    res.json({ taskId: task.id, parentTaskId: task.parent_task_id })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/sessions/:sessionId/side-question/:id — remove a Q&A from history
sessionsRouter.delete('/:sessionId/side-question/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await deleteSideQuestion(req.params.sessionId as string, req.params.id as string)
    if (!ok) {
      res.status(404).json({ error: 'Side question not found' })
      return
    }
    res.json({ status: 'deleted' })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute-compact — execute plan by injecting compact boundary
// into the SAME session (clears plan conversation but preserves session ID, slug, and plan file).
// This avoids the "new session loses codebase context" problem while clearing the 200+ plan messages.
sessionsRouter.post('/:sessionId/execute-compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const planSessionId = req.params.sessionId as string
    const { task_id, working_directory, instructions, mode, host } = req.body as {
      task_id?: string
      working_directory?: string
      instructions?: string
      mode?: string
      host?: string
    }

    const sourceRecord = await getSessionByClaudeId(planSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Follow one hop to the source plan session
    let actualPlanSessionId = planSessionId
    if (sourceRecord.fromPlanSessionId && !sourceRecord.planCompleted) {
      actualPlanSessionId = sourceRecord.fromPlanSessionId
    }

    // Read plan content
    let planResult = await readPlanFromSession(actualPlanSessionId)
    if ('error' in planResult) {
      const planRecord = actualPlanSessionId !== planSessionId
        ? await getSessionByClaudeId(actualPlanSessionId)
        : sourceRecord
      if (planRecord) {
        const extracted = await extractPlanContent(actualPlanSessionId, planRecord.cwd, planRecord.host)
        if (extracted?.trim()) {
          planResult = { content: extracted, planFile: planRecord.planFile ?? `(extracted from session ${actualPlanSessionId} JSONL)` }
        }
      }
    }
    if ('error' in planResult) {
      const status = planResult.error.includes('not found') ? 404 : 400
      res.status(status).json({ error: planResult.error })
      return
    }

    const taskId = task_id ?? sourceRecord?.taskId
    const cwd = working_directory ?? sourceRecord?.cwd
    if (!cwd) {
      res.status(400).json({ error: 'working_directory is required' })
      return
    }

    const validModes = ['bypass', 'accept', 'default', 'plan']
    if (mode && !validModes.includes(mode)) {
      res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
      return
    }
    const execMode = (mode ?? 'bypass') as 'bypass' | 'accept' | 'default' | 'plan'

    // ── Find the session's JSONL file ──
    const jsonlPath = await findLocalJsonlPath(actualPlanSessionId, cwd)
    if (!jsonlPath) {
      log.web.warn('execute-compact: JSONL not found, use /execute instead', { planSessionId: actualPlanSessionId, cwd })
      res.status(400).json({ error: 'Could not find session JSONL file. Use /execute instead.' })
      return
    }

    // ── Stop the session process if alive (must stop before JSONL injection) ──
    if (sourceRecord.process_status !== 'stopped') {
      log.web.info('execute-compact: stopping session process before injection', { planSessionId: actualPlanSessionId })
      const liveSession = sessionRunner.findByClaudeId(actualPlanSessionId)
      if (liveSession) {
        liveSession.interrupt()
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    // ── Inject compact boundary + plan summary into JSONL ──
    const summary = buildCompactSummary(planResult.content, planResult.planFile)
    const injectResult = await injectCompactBoundary(jsonlPath, summary)
    if (!injectResult) {
      res.status(500).json({ error: 'Failed to inject compact boundary into session JSONL' })
      return
    }

    // ── Update session mode and send execute message ──
    await updateSessionRecord(actualPlanSessionId, { mode: execMode })

    const planMessage = buildPlanExecutionMessage(planResult.planFile, planResult.content, instructions)
    const { sendMessageToSession } = await import('../../core/session-message-queue.js')
    await sendMessageToSession(actualPlanSessionId, planMessage, {
      source: 'web-api',
      taskId,
      mode: execMode,
    })

    log.web.info('execute-compact: injected boundary and sent execute message', {
      sessionId: actualPlanSessionId,
      boundaryUuid: injectResult.boundaryUuid,
      planFile: planResult.planFile,
    })

    res.json({
      status: 'started',
      sessionId: actualPlanSessionId,
      strategy: 'compact',
      planSessionId: actualPlanSessionId,
      taskId,
      mode: execMode,
      boundaryUuid: injectResult.boundaryUuid,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute — execute a completed plan session
sessionsRouter.post('/:sessionId/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const planSessionId = req.params.sessionId as string
    const { task_id, working_directory, instructions, mode, host } = req.body as {
      task_id?: string
      working_directory?: string
      instructions?: string
      mode?: string
      host?: string
    }

    // Look up session record first to resolve fromPlanSessionId chain
    const sourceRecord = await getSessionByClaudeId(planSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Follow one hop to the source plan session for execution sessions. Exec sessions always point
    // directly to a plan session (never to another exec), so one hop is sufficient.
    let actualPlanSessionId = planSessionId
    if (sourceRecord.fromPlanSessionId && !sourceRecord.planCompleted) {
      actualPlanSessionId = sourceRecord.fromPlanSessionId
    }

    // Read plan file via shared resolver (same logic as agent tool's from_plan path).
    // Fallback: extractPlanContent from JSONL — covers plan sessions where planCompleted flag was never set
    // (e.g. ExitPlanMode event missed by stream handler) but JSONL contains the plan content.
    let planResult = await readPlanFromSession(actualPlanSessionId)
    if ('error' in planResult) {
      const planRecord = actualPlanSessionId !== planSessionId
        ? await getSessionByClaudeId(actualPlanSessionId)
        : sourceRecord
      if (planRecord) {
        const extracted = await extractPlanContent(actualPlanSessionId, planRecord.cwd, planRecord.host)
        if (extracted?.trim()) {
          planResult = { content: extracted, planFile: planRecord.planFile ?? `(extracted from session ${actualPlanSessionId} JSONL)` }
        }
      }
    }
    if ('error' in planResult) {
      const status = planResult.error.includes('not found') ? 404 : 400
      res.status(status).json({ error: planResult.error })
      return
    }

    const taskId = task_id ?? sourceRecord?.taskId
    const cwd = working_directory ?? sourceRecord?.cwd
    if (!cwd) {
      res.status(400).json({ error: 'working_directory is required (plan session has no stored cwd).' })
      return
    }

    const validModes = ['bypass', 'accept', 'default', 'plan']
    if (mode && !validModes.includes(mode)) {
      res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}` })
      return
    }
    const execMode = mode ?? 'bypass'

    // Build message with plan content + file path reference (survives compaction via re-read).
    const planMessage = buildPlanExecutionMessage(planResult.planFile, planResult.content, instructions)

    // Use host from request body, or inherit from the plan session
    const execHost = host ?? sourceRecord?.host

    // ── Start new session FIRST, archive old plan only after confirmation ──
    // This prevents the user from ending up with an archived plan and no execution
    // session if the new session fails to start (e.g. CLI not found, SSH failure).

    // Capture the live plan session NOW — the new exec session shares the same
    // taskId map key, so after SESSION_START the old ClaudeCodeSession is evicted
    // from the runner map and a lookup by planSessionId would come up empty.
    // getOrAttachLiveSession (not findByClaudeId) so a plan session that survived
    // a server restart (alive CLI, not in the in-memory map) is also retired.
    const livePlanSession = await sessionRunner.getOrAttachLiveSession(planSessionId).catch(() => undefined)

    // Nobody is listening for SESSION_START → nothing will ever start the session,
    // so the 30s wait below can only end in a timeout. Fail immediately instead of
    // holding the request open for half a minute: the answer is already known.
    //
    // This is not a test-only path. If the session runner is not subscribed (it
    // failed to init, or was torn down), every /execute call blocks its connection
    // for 30s before returning the same 502 — a slow failure that reads like a hang.
    if (!bus.has('session-runner')) {
      log.web.error('execute: no session-runner subscribed, cannot start execution session', {
        planSessionId, taskId,
      })
      res.status(502).json({
        error: 'Session runner is not available — cannot start the execution session',
        planSessionId,
        planPreserved: true,
      })
      return
    }

    // Set up a temporary bus listener BEFORE emitting SESSION_START so we
    // catch the status-changed event that carries the new session's ID,
    // or a SESSION_ERROR if the process dies before init.
    const WAIT_TIMEOUT_MS = 30_000
    const subName = `exec-wait-${planSessionId}`
    const newSessionPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        bus.unsubscribe(subName)
        reject(new Error('Timed out waiting for execution session to start'))
      }, WAIT_TIMEOUT_MS)

      bus.subscribe(subName, (event) => {
        if (event.name === EventNames.SESSION_STATUS_CHANGED) {
          const d = eventData<'session:status-changed'>(event)
          if (d.fromPlanSessionId === planSessionId && d.sessionId) {
            clearTimeout(timer)
            bus.unsubscribe(subName)
            resolve(d.sessionId)
          }
        }
        // Catch early process death (e.g. exit code 127 — CLI not found)
        if (event.name === EventNames.SESSION_ERROR) {
          const d = eventData<'session:error'>(event)
          if (d.fromPlanSessionId === planSessionId) {
            clearTimeout(timer)
            bus.unsubscribe(subName)
            reject(new Error(d.error ?? 'Execution session failed to start'))
          }
        }
      }, { global: true, interest: ['session:status-changed', 'session:error'] })
    })

    bus.emit(EventNames.SESSION_START, {
      taskId: taskId ?? '',
      message: planMessage,
      cwd,
      project: sourceRecord?.project ?? '',
      mode: execMode,
      title: `Execute plan from ${planSessionId.slice(0, 16)}...`,
      ...(execHost ? { host: execHost } : {}),
      fromPlanSessionId: planSessionId,
    }, ['session-runner'], { source: 'web-api' })

    // Wait for the new session to start (up to 30s). If it fails, the plan
    // session stays intact so the user can retry.
    let newSessionId: string
    try {
      newSessionId = await newSessionPromise
    } catch (waitErr) {
      log.web.error('execute: new session failed to start, plan NOT archived', {
        planSessionId, taskId, error: waitErr instanceof Error ? waitErr.message : String(waitErr),
      })
      res.status(502).json({
        error: waitErr instanceof Error ? waitErr.message : 'Execution session failed to start',
        planSessionId,
        planPreserved: true,
      })
      return
    }

    // ── New session confirmed — now archive the old plan session ──
    const archiveReason = sourceRecord.planCompleted ? 'plan_executed' : 'plan_re_executed'
    let archivedPlanRecord = sourceRecord
    if (!sourceRecord.archived) {
      archivedPlanRecord = await updateSessionRecord(planSessionId, {
        archived: true,
        archive_reason: archiveReason,
        ...(sourceRecord.planCompleted ? { planContent: planResult.content } : {}),
      })
      log.web.info('execute: archived session', { planSessionId, reason: archiveReason })
    }

    // ── Retire the plan session's live process ──
    // Without this, the old CLI stays alive on the (possibly remote) host until
    // the 2h idle reap, and any pending permission (e.g. an unapproved
    // ExitPlanMode) keeps re-emitting "needs approval" toasts every 60s for a
    // session the user has already abandoned. Deny first (needs the transport),
    // then kill.
    try {
      const liveSession = livePlanSession ?? sessionRunner.findByClaudeId(planSessionId)
      if (liveSession) {
        liveSession.forceSettlePermissionRequests('Plan archived — executing in a new session')
        liveSession.kill()
        log.web.info('execute: retired archived plan session process', { planSessionId })
      }
    } catch (retireErr) {
      log.web.warn('execute: failed to retire plan session process (continuing)', {
        planSessionId, error: retireErr instanceof Error ? retireErr.message : String(retireErr),
      })
    }

    // Clear task session slot so UI no longer shows archived plan as active
    if (taskId) {
      try {
        const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
        await clearSession(taskId, planSessionId)
        const { task } = await clearSessionSlot(taskId, planSessionId)
        bus.emit(EventNames.TASK_UPDATED, { task }, ['web-ui'], { source: 'session-archived' })
      } catch { /* task may not exist */ }
    }

    // Notify frontend about the archive
    emitSessionStatusChanged(archivedPlanRecord, {}, ['*'])

    res.json({ status: 'started', planSessionId, taskId, mode: execMode, sessionId: newSessionId, ...(execHost ? { host: execHost } : {}) })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/retry — retry a failed session
// Two paths: (1) resume via --resume if claudeSessionId exists (preserves history),
// (2) fallback to archive+new if no claudeSessionId (session failed before init).
sessionsRouter.post('/:sessionId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Only allow retry on failed/stopped sessions
    if (record.process_status !== 'error' && record.process_status !== 'stopped') {
      res.status(400).json({ error: `Session is ${record.process_status}, not retryable` })
      return
    }
    if (!record.taskId) {
      res.status(400).json({ error: 'Session has no associated task' })
      return
    }

    // ── Resume path: session has claudeSessionId → check if process is alive ──
    if (record.claudeSessionId) {
      const alive = await isSessionProcessAlive(record)

      if (alive) {
        // Case 2 — process alive, connection dropped: just clear error state
        const updated = await updateSessionRecord(sessionId, {
          process_status: 'running',
          errorMessage: undefined,
          status_reason: 'retry_reconnect',
          status_changed_by: 'user',
        } as any)
        emitSessionStatusChanged(updated, {}, ['*'])
        log.web.info('session retry: reconnected (process alive)', { sessionId, taskId: record.taskId })
        res.json({ status: 'reconnected', sessionId })
        return
      }

      // Case 1 — process dead: resume via --resume.
      // If the pending queue already holds the user's original message (reverted by
      // settleResumeFailure after a failed spawn), just re-trigger processNext which
      // picks up pending messages. This sends the ORIGINAL text, not "continue".
      // Only fall back to "continue" if the queue is empty (pure idle-dead process).
      const { sendMessageToSession, getQueue } = await import('../../core/session-message-queue.js')
      const pendingMsgs = await getQueue(sessionId)
      if (pendingMsgs.length > 0) {
        // Queue has the user's original message(s) — just kick processNext via SESSION_SEND
        bus.emit(EventNames.SESSION_SEND, {
          sessionId,
          taskId: record.taskId,
        }, ['session-runner'], { source: 'retry' })
        log.web.info('session retry: re-processing pending queue messages', { sessionId, taskId: record.taskId, count: pendingMsgs.length })
        res.json({ status: 'resuming', sessionId, restoredMessages: pendingMsgs.length })
      } else {
        await sendMessageToSession(sessionId, 'continue', {
          source: 'retry',
          taskId: record.taskId,
        })
        log.web.info('session retry: resuming via --resume (no pending messages)', { sessionId, taskId: record.taskId })
        res.json({ status: 'resuming', sessionId })
      }
      return
    }

    // ── Fallback: no claudeSessionId (failed before init) → archive + start new ──
    const task = await getTask(record.taskId)
    if (!task) {
      res.status(404).json({ error: 'Associated task not found' })
      return
    }

    await updateSessionRecord(sessionId, { archived: true, archive_reason: 'retry' })
    try {
      const { clearSession, clearSessionSlot } = await import('../../core/task-manager.js')
      await clearSession(task.id, sessionId)
      await clearSessionSlot(task.id, sessionId)
    } catch { /* task may not exist */ }

    let retryMessage = 'Retry session'
    try {
      const { messages } = await readProviderSessionHistory(sessionId, record, record.host, false)
      const firstUser = messages.find(m => m.role === 'user')
      if (firstUser?.text) retryMessage = firstUser.text
    } catch { /* history may be unavailable */ }

    bus.emit(EventNames.SESSION_START, {
      taskId: task.id,
      message: retryMessage,
      cwd: record.cwd,
      project: task.project ?? '',
      mode: record.mode !== 'default' ? record.mode : undefined,
      model: record.model,
      host: record.host,
    }, ['session-runner'], { source: 'retry' })

    log.web.info('session retry: no claudeSessionId, started new session', {
      oldSessionId: sessionId, taskId: task.id,
    })
    res.json({ status: 'pending', taskId: task.id, oldSessionId: sessionId })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/restart — respawn a fresh `claude -p --resume`
// process so the session RE-INITIALIZES: the new CLI re-emits its `init` event and
// re-runs the SessionStart hook, reloading all spawn-time settings (CLAUDE.md,
// .claude/, skills, MCP servers, model/effort). This is what users expect from
// "Restart" — a clean re-read of config, visibly back to Running.
//
// The old implementation bare-killed via SessionManager.kill() and only respawned
// if the queue held pending messages. With an empty queue (the common "I changed a
// setting, reload it" case) it left the session idle with no feedback, and the bare
// daemon `stop` surfaced the reap as "Remote session exited with code -1" (Error).
// sessionRunner.reinitialize() fixes all three: it detaches the old transport
// BEFORE spawning (suppressing the dying process's exit → no phantom error) and
// spawns with no message (init + hook fire, no turn → costs no tokens, no
// conversation pollution). Any pending queue is untouched and drains on next send.
sessionsRouter.post('/:sessionId/restart', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const startedAt = Date.now()
  log.web.info('session restart: request received', { sessionId })
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      log.web.warn('session restart: session not found', { sessionId })
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (record.archived) {
      res.status(400).json({ error: 'Cannot restart an archived session' })
      return
    }

    log.web.info('session restart: record loaded', {
      sessionId,
      recordPid: record.pid,
      processStatus: record.process_status,
      host: record.host,
      isRemote: !!record.host,
      taskId: record.taskId,
    })

    // Revert any in-flight 'processing' messages back to 'pending' — if the old CLI
    // was mid-send when we respawn, those messages must survive and re-deliver.
    const { getQueue, revertToPending } = await import('../../core/session-message-queue.js')
    const queue = await getQueue(sessionId)
    const stuck = queue.filter((m) => m.status === 'processing')
    if (stuck.length > 0) {
      await revertToPending(stuck)
      log.web.info('session restart: reverted processing → pending', { sessionId, count: stuck.length })
    }

    // Respawn a fresh CLI (idle — no turn). reinitialize() owns the graceful
    // transport swap that suppresses the old process's exit.
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    await sessionRunner.reinitialize(sessionId)

    // If messages are pending after the revert, kick processNext so the fresh CLI
    // drains them (reinitialize itself delivers nothing).
    const pendingAfterRevert = queue.filter((m) => m.status === 'pending').length + stuck.length
    if (pendingAfterRevert > 0) {
      const { bus, EventNames } = await import('../../core/event-bus.js')
      bus.emit(EventNames.SESSION_SEND, { sessionId, taskId: record.taskId, message: '' }, ['session-runner'], { source: 'restart' })
      log.web.info('session restart: kicked pending queue after reinit', { sessionId, pendingMessages: pendingAfterRevert })
    }

    log.web.info('session restart: complete', {
      sessionId,
      durationMs: Date.now() - startedAt,
      pendingMessages: pendingAfterRevert,
    })
    res.json({ status: 'restarted', sessionId, pendingMessages: pendingAfterRevert })
  } catch (err) {
    log.web.error('session restart: failed', {
      sessionId,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    next(err)
  }
})

// POST /api/sessions/:sessionId/terminate — close the CLI process, full stop.
//
// Unlike restart (which respawns), this just kills the running `claude -p` and
// marks the session 'stopped'. No respawn, no queue drain, no error banner — the
// intentional kill is suppressed the same way restart suppresses it (via the
// live session's interrupt(), which sets resultEmitted so the daemon's reap is
// not surfaced as "exited with code -1"). Pending messages are left in the queue.
sessionsRouter.post('/:sessionId/terminate', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const startedAt = Date.now()
  log.web.info('session terminate: request received', { sessionId })
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    // Prefer the live session object's interrupt() — it sets resultEmitted (so the
    // exit is suppressed, not reported as an error), stops monitoring, closes the
    // FIFO and marks the process stopped. Falls back to a raw process-group SIGTERM
    // if no in-memory session/manager is registered (e.g. after a server restart).
    const { sessionRunner } = await import('../../providers/claude-code-session.js')
    const acpLive = sessionRunner.findAcpSession(sessionId)
    if (acpLive) {
      log.web.info('session terminate: stopping ACP session', { sessionId })
      await acpLive.gracefulStop()
      await updateSessionRecord(sessionId, {
        process_status: 'stopped', activity: undefined,
        last_status_change: new Date().toISOString(),
        status_reason: 'user_stopped', status_changed_by: 'user',
      }).catch(() => {})
      res.json({ status: 'terminated', sessionId, tookMs: Date.now() - startedAt })
      return
    }
    const live = sessionRunner.findSessionByClaudeId(sessionId)
    if (live) {
      log.web.info('session terminate: interrupting live session', { sessionId, host: record.host })
      await live.interrupt()
    } else {
      const { getRegisteredSessionManager } = await import('../../providers/session-manager.js')
      const mgr = getRegisteredSessionManager(sessionId)
      if (mgr) {
        log.web.info('session terminate: killing via SessionManager', { sessionId, managerKind: mgr.constructor.name })
        mgr.kill()
      } else if (record.pid != null && !record.host) {
        // Local session, no manager — SIGTERM the process group directly.
        try {
          process.kill(-record.pid, 'SIGTERM')
          log.web.info('session terminate: SIGTERM sent to process group', { sessionId, pgid: record.pid })
        } catch (err) {
          log.web.warn('session terminate: process.kill failed (likely already dead)', { sessionId, error: err instanceof Error ? err.message : String(err) })
        }
      } else {
        log.web.info('session terminate: no live session/manager to kill', { sessionId, host: record.host })
      }
    }

    // Settle any killed mid-turn batch so the UI stops the streaming spinner /
    // "Running" state immediately instead of waiting out the 60s safety timeout.
    // No-op when the session wasn't processing a turn.
    sessionRunner.settleInFlightTurn(sessionId)

    // Persist stopped state + notify the UI so the status flips immediately.
    const updated = await updateSessionRecord(sessionId, {
      process_status: 'stopped',
      errorMessage: undefined,
      activity: undefined,
      pid: undefined,
      status_reason: 'user_terminated',
      status_changed_by: 'user',
    } as Record<string, unknown>)
    emitSessionStatusChanged(updated, {}, ['*'], { source: 'terminate' })

    log.web.info('session terminate: complete', { sessionId, durationMs: Date.now() - startedAt })
    res.json({ status: 'terminated', sessionId })
  } catch (err) {
    log.web.error('session terminate: failed', {
      sessionId,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    next(err)
  }
})

// POST /api/sessions/:sessionId/fork — fork a session to a different task
sessionsRouter.post('/:sessionId/fork', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sourceSessionId = req.params.sessionId as string
    const { task_id, create_child_task, child_title, message, title, model, images } = req.body as {
      task_id?: string
      create_child_task?: boolean
      child_title?: string
      message?: string
      title?: string
      model?: string
      images?: ImagePayload[]
    }

    if (!task_id && !create_child_task) {
      res.status(400).json({ error: 'Either task_id or create_child_task is required' })
      return
    }
    if (task_id && create_child_task) {
      res.status(400).json({ error: 'task_id and create_child_task are mutually exclusive' })
      return
    }

    // Look up source session
    const sourceRecord = await getSessionByClaudeId(sourceSessionId)
    if (!sourceRecord) {
      res.status(404).json({ error: 'Source session not found' })
      return
    }

    // Codex sessions run through ACP. The installed adapter does not advertise
    // ACP session.fork, and falling through to Claude's native --fork-session
    // creates an orphan task before failing to find the conversation. Fail
    // before validating or mutating any target task.
    if (sourceRecord.engine === 'codex') {
      res.status(409).json({
        code: 'ACP_FORK_UNSUPPORTED',
        error: 'Fork is unavailable for this Codex session',
      })
      return
    }

    // Validate source session has a working directory BEFORE creating any child tasks
    if (!sourceRecord.cwd) {
      res.status(400).json({ error: 'Source session has no working directory — cannot fork' })
      return
    }

    let task: Task | undefined
    let childTaskCreated = false

    if (create_child_task) {
      // Fork = create a SIBLING task and visually group it with the source task
      // (NOT a parent/subtask — they have independent lifecycles). The new task
      // inherits the source task's category/project/source but has NO parent; we
      // then put both the source task and the fork into a lightweight virtual
      // group (reusing the source task's existing group if it already has one).
      if (!sourceRecord.taskId) {
        res.status(400).json({ error: 'Source session has no task — cannot create fork task' })
        return
      }
      let sourceTask: Task
      try {
        sourceTask = await getTask(sourceRecord.taskId)
      } catch {
        res.status(404).json({ error: `Source task "${sourceRecord.taskId}" not found` })
        return
      }
      // When the caller didn't supply an explicit child_title, we use a plain
      // `Fork of <source>` placeholder now and (below, after addTask) refine it
      // asynchronously into `<2-4 word summary of the fork prompt> - fork of <source>`.
      // Use `||` (not `??`) so an empty-string child_title also falls back to the
      // placeholder — consistent with `autoTitle = !child_title` below.
      //
      // Fork-of-a-fork: strip any existing fork decoration from the source title
      // first, otherwise titles compound without bound ("X - fork of Y - fork of
      // Z - …" reached 290+ chars in practice and permanently failed external
      // sync plugins with title-length limits).
      const sourceBaseTitle = sourceTask.title
        .replace(/^Fork of\s+/i, '')
        .replace(/\s+-\s+fork of\s+.*$/i, '')
        .trim() || sourceTask.title
      const autoTitle = !child_title
      const newTitle = child_title || `Fork of ${sourceBaseTitle}`
      // No _skipPluginOps: a fork inherits the source's source (e.g. an external
      // sync plugin) and must pass the same content validation + push as any
      // other task. addTask throws on CJK → surfaced via next(err).
      const { task: newFork } = await addTask({
        title: newTitle,
        category: sourceTask.category,
        project: sourceTask.project,
        source: sourceTask.source,
      })
      // Inherit the source's pin/tier so a fork of a Focus task lands in Focus
      // too — addTask() never sets focus_tier. Best-effort, non-fatal on failure.
      if (sourceTask.pinned && sourceTask.focus_tier) {
        try {
          await togglePin(newFork.id)
          await setFocusTier(newFork.id, sourceTask.focus_tier)
        } catch (err) {
          log.web.warn('fork: failed to inherit pin/tier from source', {
            taskId: newFork.id,
            sourceTaskId: sourceTask.id,
            tier: sourceTask.focus_tier,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      // Visually group the source task + fork. Reuse the source task's existing
      // group if it already belongs to one (continuous forks accrete into one
      // group: source + fork1 + fork2…). Best-effort: a grouping failure must not
      // abort the fork — the fork task still exists standalone.
      let forkGroupId: string | undefined
      try {
        if (sourceTask.group_id) {
          const r = await addToGroup(sourceTask.group_id, [newFork.id])
          forkGroupId = r.group_id
        } else {
          // Seed label with the source title; refined to an AI group name below.
          const r = await groupTasks([sourceTask.id, newFork.id], sourceTask.title)
          forkGroupId = r.group_id
        }
      } catch (err) {
        log.web.warn('fork: failed to group source + fork', {
          sourceTaskId: sourceTask.id,
          forkTaskId: newFork.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Emit task:created with the FINAL persisted state, not the stale addTask()
      // reference: togglePin/setFocusTier/grouping above all mutated store clones,
      // so `newFork` still says pinned=false / no focus_tier / no group_id. The UI
      // treats task:created as authoritative for a new task — emitting the stale
      // object made forks of Focus tasks render in Satellite until a full refetch.
      try {
        task = await getTask(newFork.id)
      } catch {
        task = newFork // re-read is best-effort; stale beats no event
      }
      bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui', 'main-agent'], { source: 'fork' })
      childTaskCreated = true

      // Refine the auto-generated title in the background: summarize the fork's new
      // prompt into a few English words → `<words> - fork of <source>`. Fire-and-forget
      // so the fork response is not blocked; failures keep the `Fork of <source>`
      // placeholder. Only runs when the title was auto-generated AND a custom fork
      // message was provided (no point summarizing the "Continue working on:" default).
      if (autoTitle && message?.trim()) {
        const forkId = newFork.id
        const sourceTitle = sourceBaseTitle
        const placeholderTitle = newTitle
        void (async () => {
          try {
            const { summarizeForkPrompt } = await import('../../core/fork-title.js')
            const label = await summarizeForkPrompt(message)
            if (!label) return
            // Don't clobber a concurrent user rename: only refine if the title is
            // still the `Fork of <source>` placeholder we created moments ago.
            const current = await getTask(forkId)
            if (current.title !== placeholderTitle) {
              log.web.info('fork title refine skipped — title changed since fork', { taskId: forkId })
              return
            }
            const refinedTitle = `${label} - fork of ${sourceTitle}`
            const { task: updated } = await updateTask(forkId, { title: refinedTitle }, { source: 'fork-title' })
            bus.emit(EventNames.TASK_UPDATED, { task: updated }, ['web-ui', 'main-agent'], { source: 'fork-title' })
            log.web.info('fork title refined', { taskId: forkId, title: refinedTitle })
          } catch (err) {
            // Best-effort: a failed refine just leaves the `Fork of <source>` title.
            log.web.warn('fork title refine failed', {
              taskId: forkId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }

      // Refine the GROUP name in the background from both task titles (only when
      // we created a fresh group — an existing group keeps its established name).
      // Best-effort, fire-and-forget; failures keep the source-title placeholder.
      if (forkGroupId && !sourceTask.group_id) {
        const gid = forkGroupId
        const seedTitles = [sourceTask.title, newTitle]
        void (async () => {
          try {
            const { summarizeGroupLabel } = await import('../../core/fork-title.js')
            const label = await summarizeGroupLabel(seedTitles)
            if (!label) return
            await renameGroup(gid, label)
            bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: gid, label }, ['web-ui', 'main-agent'], { source: 'fork' })
            log.web.info('fork group label refined', { groupId: gid, label })
          } catch (err) {
            log.web.warn('fork group label refine failed', {
              groupId: gid,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }
    } else {
      // Look up target task by provided task_id
      task = await getTask(task_id!)
      if (!task) {
        res.status(404).json({ error: `Task "${task_id}" not found` })
        return
      }
    }

    // Check 1-session-per-task
    const existingSessions = await getSessionsForTask(task.id)
    const activeSessions = existingSessions.filter(s => !s.archived)
    if (activeSessions.length > 0) {
      res.status(409).json({
        error: 'Target task already has a session',
        existing_session_id: activeSessions[0].claudeSessionId,
      })
      return
    }

    // A fork inherits the full parent conversation via --resume, so the model tends
    // to keep grinding on the parent's task. Lead with a focus directive so it treats
    // the fork message as the new mission and only revisits prior work on request.
    const userRequest = message?.trim() || `Continue working on: ${task.title}`
    const FORK_FOCUS_PREFIX =
      'This is a forked session. Focus on the NEW request below — treat it as your primary task. ' +
      'Do not resume or continue the parent session\'s previous work unless the user explicitly asks you to.\n\n'

    // Attached images: save to disk + build a "read these files" annotation (same
    // path-based flow as quick-start, so the CLI can read them as files). The image
    // context sits AFTER the focus directive but BEFORE the request, so the directive
    // stays the first thing the model anchors on.
    let imageContext = ''
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) imageContext = buildSessionImageContext(processed.savedImages)
    }
    const forkMessage = `${FORK_FOCUS_PREFIX}${imageContext}New request:\n${userRequest}`

    // Mint the fork's session id up front (verified: --session-id composes with
    // --resume --fork-session, so the fork gets THIS id while still inheriting the
    // parent conversation). Returning it lets the UI open the real forked panel
    // immediately instead of showing a "Forking session..." placeholder and polling.
    const forkSessionId = randomUUID()

    // Seed the record before the spawn — same reason as quick-start: the UI opens
    // the real panel on this response, and its first GET /api/sessions/:id must
    // not 404 (a 404 reads as "no such session" and sticks the panel in its empty
    // state). The spawn's persistSessionRecord updates this same row in place.
    try {
      const { createSessionRecord } = await import('../../core/session-tracker.js')
      await createSessionRecord(forkSessionId, task.id, task.project ?? '', sourceRecord.cwd, {
        title: title ?? `Fork of ${sourceRecord.title ?? sourceSessionId.slice(0, 16)}`,
        mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
        host: sourceRecord.host,
        forkedFromSessionId: sourceSessionId,
        initialProcessStatus: 'idle',
        initialStatusReason: 'awaiting_spawn',
      })
    } catch (err) {
      log.web.warn('fork: pre-spawn session record seed failed', {
        sessionId: forkSessionId, taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Emit SESSION_START with forkedFromSessionId — handleStart() uses Claude Code's
    // native --resume + --fork-session to transfer conversation context efficiently.
    // No need to read source history or wait for session start; return immediately.
    bus.emit(EventNames.SESSION_START, {
      preassignedSessionId: forkSessionId,
      taskId: task.id,
      message: forkMessage,
      cwd: sourceRecord.cwd,
      project: task.project ?? '',
      mode: sourceRecord.mode !== 'default' ? sourceRecord.mode : undefined,
      // Fork must resume on the EXACT same model as the parent — the CLI does NOT
      // inherit a session's model on --resume/--fork-session (it falls back to the
      // account/config default), so an unspecified model would mismatch the parent
      // and invalidate the prompt cache the fork is reusing. `cliModel` is the parent's
      // original --model arg verbatim (e.g. "opus[1m]", incl. the 1M context marker) —
      // persisted on every session start (persistSessionRecord), so this is the exact
      // string, not an approximation. We deliberately do NOT fall back to the reported
      // `model` (a resolved id like "…claude-opus-4-6-v1" that has LOST the [1m] marker)
      // — using it would silently drop to 200K context, i.e. a DIFFERENT model than the
      // parent. On the rare pre-cliModel legacy record, leave model undefined and let
      // send() apply the default (same as quick-start) rather than send a mismatched id.
      // An explicit request-body `model` still wins as an override.
      model: model ?? sourceRecord.cliModel,
      title: title ?? `Fork of ${sourceRecord.title ?? sourceSessionId.slice(0, 16)}`,
      host: sourceRecord.host,
      forkedFromSessionId: sourceSessionId,
    }, ['session-runner'], { source: 'web-api' })

    res.json({
      status: 'pending',
      sourceSessionId,
      sessionId: forkSessionId,
      taskId: task.id,
      ...(childTaskCreated ? { childTaskCreated: true } : {}),
      ...(sourceRecord.host ? { host: sourceRecord.host } : {}),
    })
  } catch (err) {
    next(err)
  }
})
