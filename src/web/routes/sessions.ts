/**
 * Session routes — expose tracked sessions and summaries.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import {
  emitSessionStatusChanged,
  getRecentSessions,
  getSessionByClaudeId,
  resolveSessionByIdOrPrefix,
  getSessionStatusSnapshots,
  getSessionSummaries,
  getSessionsForTask,
  isEnvironmentSession,
  isListableSession,
  isTriageSession,
  listRecentSessionRecords,
  listSessions,
  toSessionStatusSnapshot,
  updateSessionRecord,
  updateSessionRecordConditionally,
} from '../../core/session-tracker.js'
import { readSessionHistory, extractPlanContent, rewriteHistoryRemoteImages, isWindowedHistory, HISTORY_COLD_TAIL_READ_BYTES } from '../../core/session-history.js'
import { resolveDeltaStart, deltaCursor, collectRequestedRevisions, isUnsettledRow } from '../../core/history-delta.js'
import { computeSessionChanges } from '../../core/session-changes.js'
import { computeSessionGitDiff, type GitDiffBase } from '../../core/session-git-diff.js'
import { listTasksByIds, getTask, getCustomTiers } from '../../core/task-manager.js'
import { getConfig } from '../../core/config-manager.js'
import { bus, EventNames, eventData } from '../../core/event-bus.js'
import fsp from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'os'
import path from 'path'
import { isSessionProcessAlive } from '../../utils/session-liveness.js'
import { readPlanFromSession, buildPlanExecutionMessage } from '../../utils/plan-message.js'
import { getFrequentDirs, compileFromSessions, recordLaunchPrefs, scoreFrequentDir } from '../../core/frequent-dirs.js'
import type { SessionRecord, SessionMode, Task, SessionEffort } from '../../core/types.js'
import { VALID_SESSION_MODEL_IDS, VALID_SESSION_EFFORT_IDS, resolveModelSwitchValue, sessionModelsAsCatalog } from '../../core/types.js'
import { getHostModelCatalog, listHostModelCatalogs } from '../../core/host-model-catalog.js'
import type { SessionHistoryMessage } from '../../core/session-history.js'
import { processAndSaveImages, buildSessionImageContext } from './images.js'
import { sessionRunner } from '../../providers/claude-code-session.js'
import { readAcpSessionHistoryState } from '../../providers/acp-session-history.js'
import type { ImagePayload } from './images.js'
import { quickStartSession, QuickStartError } from '../../core/sessions/quick-start.js'
import { ensureCwd } from '../../core/sessions/ensure-cwd.js'
import { buildSessionVscodeUri, SessionVscodeUriError } from '../../core/session-vscode-uri.js'
import { buildSessionVscodeEmbed, SessionVscodeEmbedError } from '../../core/session-vscode-embed.js'
import {
  listSessionDirs, getSessionControls, applySessionControl, getSessionSettings,
  listSessionSideQuestions, askSessionSideQuestion, promoteSessionSideQuestion,
  removeSessionSideQuestion, getSessionWorkflowPayload, getSessionPlanPayload,
  getSubagentHistoryPayload, executeCompactSession,
} from '../../core/sessions/session-extras.js'
import { filterSessionsByQuery } from '../../core/session-search.js'
import { QUICK_START_MESSAGE_HARD_LIMIT, WALNUT_HOME } from '../../constants.js'
import { engineCaps, isAcpEngine, isKnownEngine, normalizeEngine } from '../../core/agents/engine-registry.js'
import { splitAcpModelId } from '../../providers/acp-session.js'
import { SESSION_ENGINE_IDS } from '../../core/types.js'

/** Client-supplied session ids must be well-formed UUIDs (they become CLI --session-id args and file names). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Condense a live-read failure into a short, human-readable banner reason.
 * The raw error can embed an entire multi-line ssh command plus ANSI-colored
 * proxy/auth stderr (observed: a banner filling the whole page). The full
 * text still goes to the server log; the UI only needs the cause in one line.
 */
function condenseStaleReason(msg: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = msg.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim()
  const host = /^Remote read failed \(([^)]+)\)/.exec(clean)?.[1]
  const at = host ? ` (${host})` : ''
  if (/authenticat|cookie is invalid or expired/i.test(clean)) return `SSH auth expired${at} — re-authenticate to the host`
  if (/timeout|timed out/i.test(clean)) {
    const dur = /timeout \(([^)]*)\)/i.exec(clean)?.[1]
    return `Remote read timeout${dur ? ` (${dur})` : ''}${at}`
  }
  if (/Command failed: ssh/i.test(clean)) return `SSH connection failed${at}`
  return clean.length > 120 ? clean.slice(0, 117) + '…' : clean
}

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

// Liveness correction + hostname resolution moved to
// core/sessions/session-enrich.ts (shared with the /api/v1 mobile routes).
import { enrichWithLiveStatus, enrichWithHostnames } from '../../core/sessions/session-enrich.js'

export const sessionsRouter = Router()

// GET /api/sessions/working-dirs — deduplicated working directories from persistent store
sessionsRouter.get('/working-dirs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // getFrequentDirs imported statically at top to avoid cold-start latency
    const dirs = await getFrequentDirs()
    const config = await getConfig()
    const hosts = config.hosts ?? {}
    // '' = Inbox. The default project is optional; an unset default means a
    // dir with no votes suggests Inbox rather than inventing a group name.
    const defaultProject = config.defaults?.project ?? ''
    const now = Date.now()

    // Find max age and max count for normalization
    let maxAgeMs = 1
    let maxCount = 1
    for (const d of dirs) {
      const age = now - new Date(d.lastUsed).getTime()
      if (age > maxAgeMs) maxAgeMs = age
      if (d.count > maxCount) maxCount = d.count
    }

    // Compute score, hostLabel, resolved project at read time
    const entries = dirs.map(d => {
      // Majority vote for project
      let bestProject = defaultProject
      let bestCount = 0
      for (const [proj, cnt] of Object.entries(d.projectVotes ?? {})) {
        if (cnt > bestCount) { bestProject = proj; bestCount = cnt }
      }

      const hostLabel = d.host ? hosts[d.host]?.label ?? d.host : undefined
      // Shared with GET /api/v1/sessions/launch-options (mobile) — retune the
      // weights in frequent-dirs.ts, not here, or the two pickers drift.
      const score = scoreFrequentDir(d, now, maxAgeMs, maxCount)

      return {
        cwd: d.cwd,
        host: d.host,
        hostLabel,
        // Currently unread by the web picker (its category consumer was removed
        // with the category tier); kept so dir→project suggestions can return
        // without an API change.
        project: bestProject,
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

// POST /api/sessions/import-external — run the external-session import NOW.
// The importer already runs on a 10-minute tick; this is the "don't make me
// wait" button (and what E2E drives). Coalesces with an in-flight tick.
sessionsRouter.post('/import-external', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { importExternalSessions, DEFAULT_EXTERNAL_SCAN_WINDOW_MS } =
      await import('../../core/sessions/external-session-import.js')
    const days = Number(req.body?.days)
    const windowMs = Number.isFinite(days) && days > 0
      ? days * 24 * 60 * 60 * 1000
      : DEFAULT_EXTERNAL_SCAN_WINDOW_MS
    res.json(await importExternalSessions({ windowMs }))
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/list-dirs — list subdirectories on a host (local or daemon) for path auto-complete
// Remote hosts use DaemonConnection for fast directory listing.
sessionsRouter.get('/list-dirs', async (req: Request, res: Response) => {
  // Core logic lives in core/sessions/session-extras.ts (listSessionDirs) —
  // shared with the /api/v1 mobile route and the daemon control relay.
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    res.json(await listSessionDirs(req.query.prefix, host, req.query.depth))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // SSH failures return 400, not 500 (SessionControlError carries 400 too)
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
    const { cwd: rawCwd, host, message, model: rawModel, mode, images, taskId: existingTaskId, taskMeta, project, projectFromFolder, intent, createCwd, engine, walnutAgent } = req.body as {
      cwd: string
      host?: string
      message: string
      model?: string
      mode?: string
      images?: ImagePayload[]
      taskId?: string // retry mode: reuse existing task instead of creating a new one
      /** File the new task under this project (created if unknown). Omitted/empty = Inbox. */
      project?: string
      /** `project` was derived from the picked folder — a NEWLY created registry
       *  row gets the launch folder stamped as its default_cwd. */
      projectFromFolder?: boolean
      // A retired `starred` key from an older client is silently ignored (this
      // is a body cast — unlisted JSON fields never reach quickStartSession).
      taskMeta?: {
        /** Start the new task marked unread. */
        unread?: boolean
        priority?: 'immediate' | 'important' | 'backlog' | 'none'
        // Built-in tier or a registered custom tier id (ct_*). `null` is the
        // client's explicit "don't pin this one"; omitted leaves the new task
        // on the board default (pinned, Satellite).
        pinTier?: string | null
        /** Task dates (ISO) — same trio as POST /api/tasks. */
        due_date?: string
        start_date?: string
        end_date?: string
      }
      /** Optional launch intent — 'fix-walnut' wraps the message in a repair briefing. */
      intent?: string
      /** User opted into "create & start": mkdir the cwd (recursive) before starting. */
      createCwd?: boolean
      /** Coding-agent engine: 'claude' (default) or any registered ACP engine. */
      engine?: string
      /** "Ask Walnut" launch: spawn with the Personal AI profile. The server
       *  owns cwd (WALNUT_HOME) — the client sends none. Native engine only. */
      walnutAgent?: boolean
    }

    const isWalnutAgent = walnutAgent === true
    if (isWalnutAgent) {
      // The profile rides the CLI's system-prompt flags; ACP has no channel for it,
      // so an ACP Ask-Walnut would silently launch a bare provider chat.
      if (engine !== undefined && isAcpEngine(normalizeEngine(engine))) {
        res.status(400).json({ error: 'walnutAgent requires the claude engine' })
        return
      }
      // Remote is meaningless here: the Personal AI runs where the server runs.
      if (host) {
        res.status(400).json({ error: 'walnutAgent sessions run on the server host' })
        return
      }
    }
    if (!isWalnutAgent && (!rawCwd || typeof rawCwd !== 'string')) {
      res.status(400).json({ error: 'cwd is required' })
      return
    }
    // A local `~/…` cwd is expanded ONCE here so ensureCwd's mkdir and the CLI
    // spawn agree on one absolute path (a literal ~ ENOENTs at spawn). Remote
    // hosts keep the literal ~ untouched — the server must not paste ITS
    // homedir into a path on another machine. (The daemon's mkdir expands ~,
    // but its spawn does not; remote callers should send absolute paths.)
    // Ask Walnut ignores any client cwd: the Personal AI's home is a server fact
    // (same directory a main-chat lane spawns in), not a client choice.
    const cwd = isWalnutAgent
      ? WALNUT_HOME
      : !host && (rawCwd === '~' || rawCwd.startsWith('~/'))
        ? path.join(os.homedir(), rawCwd.slice(1))
        : rawCwd
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
    if (project !== undefined && typeof project !== 'string') {
      res.status(400).json({ error: 'project must be a string' })
      return
    }
    if (typeof project === 'string' && project.length > 256) {
      res.status(400).json({ error: 'project too long (max 256 chars)' })
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
      if (engine !== undefined && isAcpEngine(normalizeEngine(engine))) {
        // ACP engines: the id belongs to the PROVIDER's catalog (probed at
        // draft time — GET /api/engines/:id/models), not the claude switch
        // validator, so only shape-check it here. The adapter stays the
        // authority: the spawn applies it through standard ACP config, which
        // only accepts ids the provider actually advertises.
        const trimmed = rawModel.trim()
        // No whitespace/control chars, bounded length, and a non-empty BASE id
        // after the effort split ("[high]" alone persists a lie otherwise).
        if (!trimmed || trimmed.length > 256 || /[\s\x00-\x1f]/.test(trimmed)
          || !splitAcpModelId(trimmed).base) {
          res.status(400).json({ error: `Invalid model: ${rawModel}` })
          return
        }
        model = trimmed
      } else {
        const resolved = resolveModelSwitchValue(rawModel)
        if (!resolved) {
          res.status(400).json({ error: `Invalid model: ${rawModel}. Use a catalog value (GET /api/sessions/host-model-catalogs) or one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}` })
          return
        }
        model = resolved
      }
    }

    if (mode) {
      if (!CLAUDE_SESSION_MODES.includes(mode as SessionMode)) {
        res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${CLAUDE_SESSION_MODES.join(', ')}` })
        return
      }
    }

    // Reject an unknown engine explicitly — the sibling enums above all 400 on
    // garbage, and conversations.ts does the same. Without this, a misspelled
    // engine ('gemni') silently coerces to claude (isAcpEngine→false,
    // normalizeEngine→undefined) and launches the wrong provider, masking the
    // client bug. Undefined stays valid (the default).
    if (engine !== undefined && !isKnownEngine(engine)) {
      res.status(400).json({ error: `engine must be one of: ${SESSION_ENGINE_IDS.join(', ')}` })
      return
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
      const validTiers = ['focus', 'satellite', 'backlog', 'wait', ...(await getCustomTiers()).map((t) => t.id)]
      // A ct_*-shaped id that's NOT registered is a STALE remembered pick, not a
      // bad request: the launcher persists the last tier in localStorage (and
      // ui-prefs-sync mirrors it across browsers), so after the user deletes that
      // tier in Settings every quick-start would 400 forever. Let it through —
      // setFocusTier self-heals unknown tiers to Satellite (same contract the
      // client comments rely on). Only reject values that were never tier ids.
      if (!validTiers.includes(taskMeta.pinTier) && !/^ct_[a-z0-9]+$/.test(taskMeta.pinTier)) {
        res.status(400).json({ error: `Invalid taskMeta.pinTier: ${taskMeta.pinTier}. Must be one of: ${validTiers.join(', ')}` })
        return
      }
    }
    // Task dates must at least parse — they flow into updateTask verbatim and an
    // unparseable string would render as "Invalid Date" on every task surface.
    for (const field of ['due_date', 'start_date', 'end_date'] as const) {
      const v = taskMeta?.[field]
      if (v !== undefined && (typeof v !== 'string' || Number.isNaN(Date.parse(v)))) {
        res.status(400).json({ error: `Invalid taskMeta.${field}: not a parseable date` })
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
    // tell the session to rename/re-file the task on completion, but that
    // pushed sessions into unrelated task-management side-quests.) Extension
    // point: pass an `appendSystemPrompt` on SESSION_START if a future need arises.

    // Fix-Walnut intent: wrap the report in the repair briefing and give the
    // task a recognizable title/project (instead of "Session: walnut" / Inbox).
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
    // Repairs file under the real 'Walnut' project (recognizable via the title
    // prefix), NOT a parallel 'Fix Walnut' project — that split scattered the
    // same product's work across two projects (user-reported 2026-08-09).
    const fixWalnutExtras = isFixWalnut
      ? { taskTitle: `Fix Walnut: ${reportSnippet}`, project: 'Walnut' }
      : {}

    // Ask Walnut defaults, same shape as the fix-walnut block above: the task
    // files under the real 'Walnut' project and lands in Focus unless the
    // client picked a tier explicitly (`null` still opts out of pinning).
    const walnutTaskMeta = isWalnutAgent && taskMeta?.pinTier === undefined
      ? { ...taskMeta, pinTier: 'focus' as const }
      : taskMeta
    const walnutExtras = isWalnutAgent
      // Its OWN project, deliberately NOT 'Walnut' — that's where the user's
      // app-dev tasks and fix-walnut repairs live; Personal-AI asks mixing into
      // it made "whose task is this" unreadable. Keep in sync with the client's
      // ASK_WALNUT_PROJECT (web/src/components/sessions/draft-column.ts).
      ? { project: project?.trim() || 'Ask Walnut', projectFromFolder: false, walnutAgent: true }
      : {}

    // Shared core (also used by the claude-code routine executor): task create/
    // reuse + TASK_CREATED + SESSION_START emit + remote failure-cache clear.
    try {
      if (createCwd === true) {
        // Same sanitize rule as list-dirs — this path flows into a daemon RPC.
        // Checked against the CLIENT's value, not the expanded one: the guard
        // sanitizes input, and a homedir containing e.g. `(` must not turn a
        // clean `~/x` into a 400.
        if (/[;&|`$(){}!<>]/.test(rawCwd)) {
          res.status(400).json({ error: 'invalid characters in cwd' })
          return
        }
        await ensureCwd(cwd, host)
      }
      // Mint the session id HERE so it can ride the response: the UI then mounts
      // the real session panel in the same frame as the click instead of parking
      // on a placeholder until the CLI's first init line (3–6s later). The CLI
      // adopts this id via --session-id. ACP engines are excluded (the adapter
      // owns id assignment), so those clients keep the poll-for-id path.
      //
      // A client-supplied `sessionId` wins over minting: it makes the launch
      // reconcilable when the HTTP response never reaches the browser (client
      // AbortSignal timeout under load — 2026-08-03: server 200 in 2.7s, browser
      // gave up at 15s, pending panel showed a false "Failed" and Retry created
      // a duplicate session). With the client owning the id, it can poll
      // GET /api/sessions/<id> regardless of the response's fate.
      const isNativeEngine = !isAcpEngine(engine)
      const clientSessionId = typeof (req.body as { sessionId?: unknown }).sessionId === 'string'
        && UUID_RE.test((req.body as { sessionId: string }).sessionId)
        ? (req.body as { sessionId: string }).sessionId : undefined
      const preassignedSessionId = isNativeEngine ? (clientSessionId ?? randomUUID()) : undefined
      const updatedTask = await quickStartSession({
        message: sessionMessage, messagePrefix, cwd, host, model, mode,
        existingTaskId, taskMeta: isWalnutAgent ? walnutTaskMeta : fixWalnutTaskMeta,
        source: 'quick-start', requestTs,
        engine: normalizeEngine(engine),
        preassignedSessionId,
        // Client project seed (project-header "+ → Add session"). fixWalnutExtras
        // spreads AFTER so a repair launch always files under 'Walnut' — and a
        // repair also drops the folder-derived flag with it (its project wasn't
        // derived from the folder anymore). walnutExtras same idea for Ask Walnut.
        ...(project?.trim() ? { project: project.trim(), projectFromFolder: projectFromFolder === true } : {}),
        ...(isFixWalnut ? { projectFromFolder: false } : {}),
        ...fixWalnutExtras,
        ...walnutExtras,
      })
      // Remember this folder's launch config for next time (fire-and-forget).
      // Stores the RAW picker value (not the CLI-normalized `model`) so the
      // launcher dropdown can re-select it verbatim. Retries keep the original
      // memory (existingTaskId set → the user didn't re-pick anything), and
      // fix-walnut launches don't count — that's a repair intent with no
      // model pick, not a preference for the Walnut checkout dir.
      // Ask Walnut doesn't count either: WALNUT_HOME is a server fact, not a
      // folder preference the user picked.
      if (!existingTaskId && !isFixWalnut && !isWalnutAgent) {
        const rawPickerModel = typeof rawModel === 'string' && rawModel && rawModel !== 'default' ? rawModel : undefined
        recordLaunchPrefs(cwd, host ?? null, {
          model: rawPickerModel,
          // LaunchPrefs stores the persisted shape (explicit non-default engine
          // or absent), which is exactly normalizeEngine's contract.
          engine: normalizeEngine(engine),
        }).catch(() => {})
      }
      // sessionId is present for native starts (see preassignedSessionId above).
      // Clients MUST treat it as optional — an ACP start omits it.
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

// readProviderSessionHistory moved to core/sessions/session-lifecycle.ts
// (shared with the /api/v1 rich-history endpoint + daemon control relay).
import {
  readProviderSessionHistory,
  clearArchivedSessionTaskLinks,
  patchSession,
  terminateSession,
  restartSession,
  retrySession,
  recheckSession,
  respondSessionPermission,
  executeContinueSession,
  getSessionChanges,
  getSessionFileChange,
  getSessionPendingPermissions,
  isHistoryStartupWindow,
  CLAUDE_SESSION_MODES,
} from '../../core/sessions/session-lifecycle.js'
import { SessionControlError } from '../../core/sessions/session-controls.js'

/**
 * Stamp `unsettled: true` on rows whose content can still change (an Agent row awaiting
 * its late `bgTaskFinished`, a tool row awaiting its result).
 *
 * The client uses this to know WHICH rows to re-ask for on the next delta. Keeping the
 * predicate server-side means the client never re-implements it — it just reads a flag —
 * and the server stays the single definition of "settled" (inc-1785965937858).
 */
function markUnsettled(messages: readonly SessionHistoryMessage[]): SessionHistoryMessage[] {
  return messages.map(m => (isUnsettledRow(m) ? { ...m, unsettled: true } : m))
}

function unavailableHistoryReason(record: SessionRecord): string {
  const caps = engineCaps(record.engine)
  if (caps.historySource === 'acp-journal') {
    if (!record.acpRuntimeId) {
      return `${caps.displayName} session has no ACP runtime ID, so its history journal cannot be located`
    }
    return record.host
      ? `${caps.displayName} session history journal is unavailable on remote host "${record.host}"`
      : `${caps.displayName} session history journal not found`
  }
  return record.host
    ? `Remote host "${record.host}" is unreachable — session history is stored on that machine`
    : 'Session history file not found'
}

/** Apply the optional `?q=` list filter (title / owning-task title / cwd / host / hostname).
 *  Task titles are looked up once per request so the pure filter stays sync.
 *  Hostname: records from SQLite carry only the host ALIAS (enrichWithHostnames
 *  runs after filtering), so resolve alias→hostname from config here — otherwise
 *  searching by full hostname silently never matches. */
async function applySessionSearch(sessions: SessionRecord[], q: unknown): Promise<SessionRecord[]> {
  const query = typeof q === 'string' ? q.trim() : ''
  if (!query) return sessions
  const taskIds = new Set(sessions.map(s => s.taskId).filter(Boolean))
  const titleById = new Map<string, string>()
  if (taskIds.size > 0) {
    // Bounded batch lookup (predicate pushed into SQL) — a full listTasks()
    // table read per debounced keystroke was the browser-pool-saturation
    // class fixed in c0320af.
    const tasks = await listTasksByIds([...taskIds] as string[])
    for (const t of tasks) if (taskIds.has(t.id)) titleById.set(t.id, t.title)
  }
  let hosts: Record<string, { hostname: string }> = {}
  try {
    hosts = (await getConfig()).hosts ?? {}
  } catch { /* config read failure — hostname search degrades to alias-only */ }
  return filterSessionsByQuery(
    sessions,
    query,
    (id) => titleById.get(id),
    (alias) => hosts[alias]?.hostname,
  )
}

/** Cap on the pre-filter candidate set for `?q=` searches. These routes run on
 *  every debounced finder keystroke — an unbounded whole-table read here is the
 *  browser-pool-saturation class fixed in c0320af. 2000 most-recent rows (an
 *  ordered, index-backed SQL read) covers months of history; anything older is
 *  out of finder scope by design. */
const SEARCH_CANDIDATE_LIMIT = 2000

// GET /api/sessions?q=<filter>
/** Multi-KB spawn-time bookkeeping never belongs on a LIST payload — it is
 *  read back record-by-record where needed (side-thread fork, cold resume). */
function stripHeavyRecordFields<T extends { appliedAppendSystemPrompt?: string }>(sessions: T[]): T[] {
  return sessions.map((s) => {
    if (s.appliedAppendSystemPrompt === undefined) return s
    const { appliedAppendSystemPrompt: _dropped, ...rest } = s
    return rest as T
  })
}

sessionsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    // With q: bounded most-recent-first candidate window (see cap above).
    const all = query ? await listRecentSessionRecords(SEARCH_CANDIDATE_LIMIT) : await listSessions()
    // isListableSession = not an environment session AND not lane-bound (a lane
    // session backs a UI conversation surface, not a listed session).
    let sessions = all.filter(s => isListableSession(s) && !s.archived)
    sessions = await applySessionSearch(sessions, query)
    res.json({ sessions: stripHeavyRecordFields(await enrichWithHostnames(await enrichWithLiveStatus(sessions))) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/recent?q=<filter>
sessionsRouter.get('/recent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10
    // With a query, search a WIDE bounded window then cap — filtering only the
    // tiny recent window would miss older matches (defeats a finder), but the
    // candidate set stays bounded (SEARCH_CANDIDATE_LIMIT, index-backed) so a
    // keystroke can never trigger a whole-table read.
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const all = query ? await listRecentSessionRecords(SEARCH_CANDIDATE_LIMIT) : await getRecentSessions(limit)
    let sessions = all.filter(s => isListableSession(s) && !s.archived)
    if (query) {
      sessions = (await applySessionSearch(sessions, query))
        .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
        .slice(0, limit)
    }
    res.json({ sessions: stripHeavyRecordFields(await enrichWithHostnames(await enrichWithLiveStatus(sessions))) })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/mention-index — light projection powering the composer's
// "@" session picker. The picker filters IN THE BROWSER on every keystroke, so
// it needs the whole candidate set once, small and fast: no live-status enrich
// (the client's WS-fed status store is fresher), no hostname enrich, no recap /
// summary / status_history baggage. ~110 bytes/row vs ~2KB on /recent.
sessionsRouter.get('/mention-index', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requested = req.query.limit ? parseInt(req.query.limit as string, 10) : 800
    const limit = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 800, SEARCH_CANDIDATE_LIMIT)
    const all = await listRecentSessionRecords(limit)
    const sessions = all
      .filter(s => isListableSession(s) && !s.archived)
      .map(s => ({
        id: s.claudeSessionId,
        title: s.title ?? '',
        host: s.host ?? '',
        status: s.process_status,
        lastActiveAt: s.lastActiveAt ?? '',
        // Owning task — the chat's session-envelope card resolves a peer's short
        // id here and shows its task pill, so the receiving human sees WHICH task
        // messaged them. ~20 extra bytes/row; the "@" palette ignores it.
        taskId: s.taskId ?? '',
      }))
    res.json({ sessions })
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

// POST /api/sessions/:sessionId/vscode-embed — ensure a code-server for this
// session's host (installing on first use unless ?install=false) and answer a
// browser-loadable 127.0.0.1 URL (local instance or SSH-forwarded). POST, not
// GET: it can start processes and download an installer.
sessionsRouter.post('/:sessionId/vscode-embed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await getSessionByClaudeId(String(req.params.sessionId))
    const result = await buildSessionVscodeEmbed(session, {
      install: String(req.query.install ?? '') !== 'false',
    })
    res.json(result)
  } catch (err) {
    if (err instanceof SessionVscodeEmbedError) {
      res.status(err.status).json({ error: err.message, hint: err.hint })
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId
sessionsRouter.get('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestedId = String(req.params.sessionId)
    // Accept a unique id prefix: the UI only ever displays the first 8 chars, so
    // that string lands in deep links and would otherwise 404 forever (the client
    // retries a missing session for ~15s, then leaves a dead column behind).
    const resolution = await resolveSessionByIdOrPrefix(requestedId)
    if (resolution.status === 'ambiguous') {
      // Refuse to guess — same contract as an ambiguous short git SHA.
      res.status(409).json({
        code: 'SESSION_ID_AMBIGUOUS',
        error: 'session id prefix matches more than one session — use the full id',
      })
      return
    }
    let session = resolution.status === 'found' ? resolution.session : null
    if (!session) {
      // Record lost but transcript may survive (inc-2026-08-10 "Untitled
      // session"): self-heal from the canonical JSONL instead of 404ing a
      // session whose /history still renders. Cheap on genuine 404s — the
      // recovery module negative-caches misses. Runs after prefix resolution
      // because recovery needs the full id to find the transcript.
      const { recoverSessionRecordFromJsonl } = await import('../../core/sessions/session-record-recovery.js')
      session = await recoverSessionRecordFromJsonl(requestedId)
    }
    if (!session) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    // Canonical id — live-session maps are keyed by the full id, so a prefix must
    // never be passed downstream.
    const sessionId = session.claudeSessionId
    if (resolution.status === 'found' && resolution.resolvedByPrefix) {
      // Logged so a code path that truncates ids stays visible instead of being
      // silently absorbed by prefix resolution.
      log.web.warn('session resolved from an id prefix — caller should use the full id', {
        requestedId,
        sessionId,
      })
    }
    const [enriched] = await enrichWithHostnames(await enrichWithLiveStatus([session]))
    // Canonical id from the resolved record is already on `enriched`. The
    // shared helper uses the live provider when attached, then falls back to
    // the durable record during the restart attach window.
    const pendingPermissions = await getSessionPendingPermissions(enriched)
    res.json({ session: enriched, pendingPermissions })
  } catch (err) {
    next(err)
  }
})

// clearArchivedSessionTaskLinks / mode-change helpers moved to
// core/sessions/session-lifecycle.ts (shared with /api/v1 + daemon relay).

function sendSessionNotFound(res: Response): void {
  res.status(404).json({
    code: 'SESSION_NOT_FOUND',
    error: 'session not found',
  })
}

// GET /api/sessions/:sessionId/controls — provider-neutral selectable session
// controls. Core logic lives in core/sessions/session-extras.ts (shared with
// the /api/v1 mobile route and the daemon control relay).
sessionsRouter.get('/:sessionId/controls', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = String(req.params.sessionId)
  try {
    res.json(await getSessionControls(sessionId))
  } catch (err) {
    if (err instanceof SessionControlError) {
      if (err.statusCode === 404) { sendSessionNotFound(res); return }
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/sessions/:sessionId/controls — apply one provider-advertised control.
sessionsRouter.post('/:sessionId/controls', async (req: Request, res: Response) => {
  const sessionId = String(req.params.sessionId)
  const { id, value } = req.body as { id?: unknown; value?: unknown }
  try {
    res.json(await applySessionControl(sessionId, id, value))
  } catch (err) {
    if (err instanceof SessionControlError) {
      if (err.statusCode === 404) { sendSessionNotFound(res); return }
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    // Legacy behavior: any other failure surfaces as a 409 rejection.
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('session control change rejected', { sessionId, id, value, error: message })
    res.status(409).json({ error: message })
  }
})

// PATCH /api/sessions/:sessionId — core logic (validation, terminal-state
// archive guard, live mode apply, task-slot clearing) lives in
// core/sessions/session-lifecycle.ts, shared with the /api/v1 mobile route
// and the daemon control relay.
sessionsRouter.patch('/:sessionId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = String(req.params.sessionId)
    // Route IDs are provider session IDs. ACP runtime IDs are transport-local
    // identities and must never select or implicitly create a durable record.
    try {
      const session = await patchSession(sessionId, (req.body ?? {}) as Record<string, unknown>)
      log.web.info('session updated via REST', { sessionId, fields: Object.keys(req.body ?? {}) })
      res.json({ session })
    } catch (err) {
      if (err instanceof SessionControlError) {
        if (err.statusCode === 404) {
          sendSessionNotFound(res)
          return
        }
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/^Session not found:/.test(message)) {
      sendSessionNotFound(res)
      return
    }
    next(err)
  }
})

/** First user message of the FULL parse — a ?tail= payload may not contain it,
 *  and the client used to fake one from its window head (the pinned "Initial
 *  Prompt" bubble showed a recent message instead of the session's real first
 *  prompt). Callers must NOT attach this for windowed reads: there the array
 *  head isn't the session head, and a confident wrong answer is worse than none. */
function initialUserTextOf(messages: Array<{ role?: string; text?: string }>): string | undefined {
  const first = messages.find(m => m.role === 'user' && typeof m.text === 'string' && m.text.trim().length > 0)
  if (!first?.text) return undefined
  // Cap: this rides EVERY full history response; a pasted-novel first prompt
  // shouldn't tax them all.
  return first.text.length > 10_000 ? `${first.text.slice(0, 10_000)}…` : first.text
}

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
      if (record && engineCaps(record.engine).historySource === 'acp-journal') {
        // Tail-bounded P1: bound a COLD fold to the journal's last few MB so a
        // whale journal paints instantly; the fold cache serves the follow-ups.
        const { messages, windowed } = await readProviderSessionHistory(sessionId, record, record.host, true,
          tail && tail > 0 ? { maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES } : undefined)
        logMessageOrdering('P1:streams', sessionId, messages, record.host)
        const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
        const initialUserText = windowed ? undefined : initialUserTextOf(messages)
        res.json({ messages: sliced, total: messages.length, ...(initialUserText ? { initialUserText } : {}) })
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
          const cachedSlice = tail && tail > 0 ? diskCached.messages.slice(-tail) : diskCached.messages
          res.json({
            messages: cachedSlice, total: diskCached.messages.length,
            ...(diskCached.finishedAgentIds?.length ? { finishedAgentIds: diskCached.finishedAgentIds } : {}),
          })
          return
        }
        res.json({ messages: [], total: 0 })
        return
      }
      // skipSubagents: frontend lazy-loads each subagent via /subagent/:agentId/history on demand.
      // Tail-bounded request → bound a COLD local read too (same contract as the
      // full path below): an 8+ MB whale JSONL parsed whole on the event loop
      // took seconds and stalled every other route, only for the tail slice to
      // throw most of it away.
      const { messages, finishedAgentIds: p1FinishedIds, windowed: p1Windowed } = await readProviderSessionHistory(sessionId, record, undefined, true,
        tail && tail > 0 ? { maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES } : undefined)
      logMessageOrdering('P1:streams', sessionId, messages, record?.host)
      const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
      const p1InitialUserText = p1Windowed ? undefined : initialUserTextOf(messages)
      res.json({
        messages: sliced, total: messages.length,
        ...(p1InitialUserText ? { initialUserText: p1InitialUserText } : {}),
        ...(p1FinishedIds && p1FinishedIds.length > 0 ? { finishedAgentIds: p1FinishedIds } : {}),
      })
      return
    }

    // Full path: reads from source of truth (SSH for remote sessions)
    let messages: Awaited<ReturnType<typeof readSessionHistory>>
    let historySourceAvailable = false
    // Whale transcript served from a bounded sliding tail — captured here, before
    // image rewriting / fork concatenation replace the array, because the flag
    // lives on the object the reader returned. Sticky through those transforms:
    // a derived array is windowed iff its own-session part was.
    let historyWindowed = false
    // Orphan finished-agent ids (nested agents with no history row — see
    // readProviderSessionHistory). Captured HERE like `windowed`: image
    // rewriting / fork concatenation below REPLACE the messages array, and the
    // parser's mark lives on the exact object the reader returned. Fork
    // ancestors may carry their own set — unioned where their fetches merge.
    const finishedAgentIdSet = new Set<string>()
    try {
      // skipSubagents: frontend lazy-loads each subagent via /subagent/:agentId/history on demand.
      // Tail-bounded request → bound a COLD read to the last few MB too
      // (inc-1786572252481: ?tail=400 bounded the response but the server still
      // pulled the whole 9.5 MB remote JSONL over SSH on every cold panel open).
      const history = await readProviderSessionHistory(sessionId, record, record?.host, true,
        tail && tail > 0 ? { maxColdReadBytes: HISTORY_COLD_TAIL_READ_BYTES } : undefined)
      messages = history.messages
      historySourceAvailable = history.sourceAvailable
      historyWindowed = history.windowed
      for (const id of history.finishedAgentIds ?? []) finishedAgentIdSet.add(id)
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
        const { getCachedSessionHistory, getOrphanFinishedAgentIds } = await import('../../core/session-history.js')
        const cached = getCachedSessionHistory(sessionId, record?.host)
        if (cached && cached.length > 0) {
          log.web.info('serving stale history cache (live read failed)', {
            sessionId, host: record?.host, messages: cached.length,
          })
          // The cached array is the exact object the parser marked, so its
          // orphan finished-agent ids are still readable from the WeakMap.
          const staleOrphans = getOrphanFinishedAgentIds(cached)
          res.json({
            messages: cached, total: cached.length, stale: true, staleReason: condenseStaleReason(msg),
            ...(staleOrphans && staleOrphans.size > 0 ? { finishedAgentIds: [...staleOrphans].sort() } : {}),
          })
          return
        }
        // Disk cache fallback (survives app restarts)
        const { readHistoryCache } = await import('../../core/history-disk-cache.js')
        const diskCached = await readHistoryCache(sessionId)
        if (diskCached && diskCached.messages.length > 0) {
          log.web.info('serving disk-cached history (live read threw)', {
            sessionId, host: record?.host, messages: diskCached.messages.length, cachedAt: diskCached.cachedAt,
          })
          res.json({
            messages: diskCached.messages, total: diskCached.messages.length, stale: true, staleReason: condenseStaleReason(msg),
            ...(diskCached.finishedAgentIds?.length ? { finishedAgentIds: diskCached.finishedAgentIds } : {}),
          })
          return
        }
      }
      res.status(502).json({ error: condenseStaleReason(msg) })
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
    // ...but NOT for a fork: "nothing to show" may only be decided after the
    // fork ancestors are consulted (the fork-aware block further down). A fresh
    // fork's OWN transcript is legitimately empty — its whole value is the
    // inherited parent conversation — so answering here reported "History
    // unavailable" on a fork that had plenty to show, AND skipped loading the
    // parent entirely. The verdict is deferred to `forkHistoryVerdict` below.
    if (messages.length === 0 && record && !historySourceAvailable && req.query.since === undefined
        && !record.forkedFromSessionId) {
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
          ...(diskCached.finishedAgentIds?.length ? { finishedAgentIds: diskCached.finishedAgentIds } : {}),
        })
        return
      }
      // Still in the startup window: the CLI hasn't written its first JSONL line
      // yet (measured: ~4s after spawn, while the UI fetches history at ~0.8s).
      // "File not found" is TRUE here but not a fault — reporting it made every
      // task creation flash "History unavailable". Serve a plain empty history so
      // the panel shows its normal starting state; the next turn's fetch fills in.
      if (isHistoryStartupWindow(record)) {
        res.json({ messages: [], total: 0, cursor: 0, delta: false })
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
            const src = await readProviderSessionHistory(
              sourceRecord.claudeSessionId,
              sourceRecord,
              sourceRecord.host,
            )
            let sourceMessages = src.messages
            if (sourceRecord.host) {
              sourceMessages = await rewriteHistoryRemoteImages(sourceMessages, sourceRecord.host, sourceRecord.claudeSessionId, sourceRecord.cwd)
            }
            return { messages: sourceMessages, windowed: src.windowed, finishedAgentIds: src.finishedAgentIds }
          }),
        )

        // A windowed ANCESTOR poisons the combined cursor space just as badly as a
        // windowed own-session read: the prefix length shifts under the client.
        if (fetched.some(f => f.windowed)) historyWindowed = true
        // Ancestor orphan finished-agent ids ride the combined payload too — a
        // fork inherits the parent's lane blocks via replayed streams, so their
        // absorption proof must survive the concatenation.
        for (const f of fetched) {
          for (const id of f.finishedAgentIds ?? []) finishedAgentIdSet.add(id)
        }
        let allSourceMessages = fetched.flatMap(f => f.messages)
        // ── REWIND cut ──
        // A rewound session IS a fork, so the block above just pulled in the
        // parent's FULL transcript, including the turns the human rewound away (the
        // parent's JSONL is never edited). Reconcile the two views here — the one
        // place they are concatenated. See cutAncestorHistoryAtRewindPoint.
        if (record.rewoundAtMessageUuid) {
          const { cutAncestorHistoryAtRewindPoint } = await import('../../core/sessions/session-rewind.js')
          const cut = cutAncestorHistoryAtRewindPoint(allSourceMessages, record.rewoundAtMessageUuid)
          allSourceMessages = cut.messages
          if (cut.found) {
            if (cut.dropped > 0) {
              log.web.debug('rewind: trimmed ancestor transcript at the rewind point', {
                sessionId, rewoundAt: record.rewoundAtMessageUuid, dropped: cut.dropped,
              })
            }
          } else {
            log.web.warn('rewind: rewind point not found in the ancestor transcript — history may show rewound turns', {
              sessionId, rewoundAt: record.rewoundAtMessageUuid, ancestorMessages: allSourceMessages.length,
            })
          }
        }
        // ── EMBED detection ──
        // `claude --resume X --fork-session` COPIES the resumed prefix into the
        // fork's own JSONL (message uuids preserved, sessionId rewritten), so a
        // fork that has run a turn already CONTAINS its ancestors — prepending
        // them again rendered the parent conversation twice (measured live:
        // 2-msg parent → 6-msg thread history). Detect the embed by looking for
        // the ancestors' last message id inside the fork's own transcript; when
        // found, skip the prepend and put the boundary AT the embedded copy.
        // Streams-source reads and not-yet-turned forks don't embed → prepend
        // as before.
        let embeddedBoundary = -1
        if (allSourceMessages.length > 0 && messages.length > 0) {
          for (let a = allSourceMessages.length - 1; a >= 0 && a >= allSourceMessages.length - 3; a--) {
            const anchorId = allSourceMessages[a]?.msgId
            if (!anchorId) continue
            const idx = messages.findIndex((m) => m.msgId === anchorId)
            if (idx >= 0) { embeddedBoundary = idx + (allSourceMessages.length - 1 - a); break }
          }
        }
        if (embeddedBoundary >= 0) {
          forkBoundaryIndex = embeddedBoundary + 1
        } else if (allSourceMessages.length > 0) {
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

    // Deferred verdict for a FORK whose own transcript was empty (the
    // short-circuit above deliberately skipped it so the ancestors got their
    // chance). If the ancestors supplied nothing either, THIS is where "nothing to
    // show" finally becomes true. Same three-way answer as the non-fork path:
    // disk cache → startup grace → explained reason. Delta requests are excluded
    // for the same reason as above (a stale cache has a different cursor space);
    // a transient ancestor failure is NOT a verdict — it keeps the existing
    // degraded-payload behavior rather than claiming the history is gone.
    if (messages.length === 0 && record?.forkedFromSessionId && !historySourceAvailable
        && !forkLoadFailed && req.query.since === undefined) {
      const { readHistoryCache } = await import('../../core/history-disk-cache.js')
      const diskCached = await readHistoryCache(sessionId)
      if (diskCached && diskCached.messages.length > 0) {
        res.json({
          messages: diskCached.messages,
          total: diskCached.messages.length,
          cursor: diskCached.messages.length,
          delta: false,
          stale: true,
          staleReason: 'Session file unavailable — showing cached history',
          ...(diskCached.finishedAgentIds?.length ? { finishedAgentIds: diskCached.finishedAgentIds } : {}),
        })
        return
      }
      if (isHistoryStartupWindow(record)) {
        res.json({ messages: [], total: 0, cursor: 0, delta: false })
        return
      }
      res.json({
        messages: [], total: 0, cursor: 0, delta: false,
        historyUnavailable: unavailableHistoryReason(record),
      })
      return
    }

    const total = messages.length
    // Sorted-array form for the response payloads (a handful of ids; cheap).
    // Rides OUTSIDE the messages array on BOTH delta and full responses so the
    // cursor space never changes.
    const finishedAgentIds = finishedAgentIdSet.size > 0 ? [...finishedAgentIdSet].sort() : undefined

    // ── Delta mode (?since=<N>) — the turn-boundary incremental path ──
    // The client sends the count it holds PLUS the identity (`anchorMsgId`) of its
    // newest uniquely-identified message. Identity picks the split point; the count
    // is only a fallback, because the parsed-message array is NOT the append-only
    // space a count assumes — a /compact rewrite, the retroactive subagent
    // regrouping, and a whale session's 4 MiB sliding tail all shift or shrink it.
    // Slicing by a stale count then silently omits the NEWEST messages, which is how
    // a user's own echo went missing and left their bubble pinned at the bottom
    // forever (inc-1785993576822). See src/core/history-delta.ts for the rules.
    //
    // ACP journals are different: several text chunks project into one assistant
    // message. A client can therefore mint cursor N after the first chunk, then
    // observe the same total N after later chunks complete that message. A
    // count-only delta would return [] and strand the partial text forever.
    // ACP cursor requests consequently fall through to a full replacement.
    //
    // Contract:
    //   native + resolvable split point
    //     → { messages: slice(start), cursor, delta: true }
    //     · slice is empty when nothing new yet (archive hasn't flushed the turn) —
    //       client treats empty delta as "not caught up", keeps streaming blocks, retries.
    //   ACP, anchor missing/ambiguous, client ahead, or a windowed read with no
    //   anchor → full payload + delta:false so the client rebuilds. Never silently drop.
    const sinceRaw = req.query.since as string | undefined
    if (sinceRaw !== undefined) {
      const since = parseInt(sinceRaw, 10)
      const anchorMsgId = typeof req.query.anchorMsgId === 'string' ? req.query.anchorMsgId : undefined
      const anchorTailRaw = req.query.anchorTail as string | undefined
      const anchorTail = anchorTailRaw !== undefined ? parseInt(anchorTailRaw, 10) : 0
      // msgIds the client holds an UNSETTLED copy of and wants re-served.
      const reviseIds = typeof req.query.revise === 'string'
        ? req.query.revise.split(',').map(s => s.trim()).filter(Boolean)
        : []
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
      if (engineCaps(record?.engine).historySource !== 'acp-journal') {
        const anchorReq = {
          since,
          anchorMsgId,
          anchorTail: Number.isFinite(anchorTail) ? anchorTail : 0,
        }
        const resolved = resolveDeltaStart(messages, anchorReq, { windowed: historyWindowed })
        if (resolved.kind === 'delta') {
          const slice = messages.slice(resolved.start)
          // The client re-asks for rows it holds an UNSETTLED copy of (an Agent row
          // still awaiting its late `bgTaskFinished`, a tool row awaiting its result).
          // Serving those again by identity is what un-freezes a prefix the client
          // synced mid-flight (inc-1785965937858). Ambiguous/unanswerable → rebuild,
          // which also stops the client from re-asking forever.
          const { revised, ambiguous } = collectRequestedRevisions(messages, reviseIds)
          if (!ambiguous) {
            res.json({
              messages: markUnsettled(slice),
              ...(revised.length > 0 ? { revisedMessages: markUnsettled(revised) } : {}),
              cursor: deltaCursor(anchorReq, slice.length, total),
              total,
              delta: true,
              // Fork fields are static after first load; client already has them.
              ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
              ...(forkBoundaryIndex != null ? { forkBoundaryIndex } : {}),
              // NOT static: a nested agent finishing mid-session adds an id, and
              // its lane blocks may already sit in the client — ship on every delta.
              ...(finishedAgentIds ? { finishedAgentIds } : {}),
            })
            return
          }
          log.web.info('history delta declined — revision request unanswerable', {
            sessionId, since, total, requested: reviseIds.length,
          })
        } else {
          log.web.info('history delta declined — serving full rebuild', {
            sessionId, reason: resolved.reason, since, anchorMsgId, total, windowed: historyWindowed,
          })
        }
      }
      // Fall through to full payload (unresolvable split point → rebuild).
    }

    const sliced = tail && tail > 0 ? messages.slice(-tail) : messages
    // Adjust forkBoundaryIndex for the sliced window. `dropped` is clamped at 0:
    // a tail LARGER than the transcript drops nothing, and the raw `total - tail`
    // would go negative and INFLATE the boundary past the array (a 6-msg thread
    // asked with tail=200 reported boundary 196 → clients sliced to empty).
    const dropped = tail && tail > 0 ? Math.max(0, total - tail) : 0
    const adjustedForkBoundary = forkBoundaryIndex != null
      ? (forkBoundaryIndex >= dropped ? forkBoundaryIndex - dropped : undefined)
      : forkBoundaryIndex
    // True initial prompt of the conversation (fork prefix included) — computed
    // BEFORE the tail slice, because the slice is exactly what drops it. Windowed
    // read / failed fork prefix: the head we hold isn't the real head — omit.
    const initialUserText = historyWindowed || forkLoadFailed ? undefined : initialUserTextOf(messages)
    res.json({
      // Full payloads carry the flag too — a client that first loads mid-flight must
      // know which rows to re-ask for on its next delta.
      messages: markUnsettled(sliced),
      total,
      cursor: total,
      delta: false,
      ...(initialUserText ? { initialUserText } : {}),
      // Windowed parse: `total` is the WINDOW length, not the file's message
      // count — the client can't compute a real olderHidden from it. The flag
      // lets it show an uncounted "Load earlier messages" affordance instead of
      // silently hiding the button (the full fetch it triggers bypasses the
      // windowed cache and does the real read).
      ...(historyWindowed ? { windowed: true } : {}),
      ...(forkedFromSessionId ? { forkedFromSessionId } : {}),
      ...(adjustedForkBoundary != null ? { forkBoundaryIndex: adjustedForkBoundary } : {}),
      ...(finishedAgentIds ? { finishedAgentIds } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/subagent/:agentId/history — lazy-load a single subagent's messages
// Core logic lives in core/sessions/session-extras.ts (getSubagentHistoryPayload)
// — shared with the /api/v1 mobile route and the daemon control relay.
// ?workflow=1 → scan the nested subagents/workflows/<runId>/ layout (dynamic
// workflow subagents); otherwise the flat Task/Team layout.
sessionsRouter.get('/:sessionId/subagent/:agentId/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isWorkflow = req.query.workflow === '1' || req.query.workflow === 'true'
    res.json(await getSubagentHistoryPayload(String(req.params.sessionId), String(req.params.agentId), isWorkflow))
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId/workflow — reconstruct the dynamic-workflow progress
// panel from the on-disk run manifest. Lets the panel survive page reload / server
// restart, when the live in-memory session state is gone. 204 = no workflow ran.
// Core logic (incl. the 5s route-level deadline that saved the browser's
// connection pool from wedged daemons) lives in core/sessions/session-extras.ts.
sessionsRouter.get('/:sessionId/workflow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = await getSessionWorkflowPayload(String(req.params.sessionId))
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
// Core logic lives in core/sessions/session-lifecycle.ts (getSessionChanges) —
// shared with the /api/v1 mobile route and the daemon control relay.
sessionsRouter.get('/:sessionId/changes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    try {
      res.json(await getSessionChanges(sessionId, {
        base: req.query.base,
        scope: req.query.scope,
        light: req.query.light === '1',
        refresh: req.query.refresh === '1' || req.query.refresh === 'true',
        swr: req.query.swr === '1',
      }))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/changes/file?path=<abs> — ONE file's change
// record with full before/after. Pairs with ?light=1/&swr=1 list fetches: the
// list paints instantly without content, each diff loads on selection.
sessionsRouter.get('/:sessionId/changes/file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const filePath = String(req.query.path ?? '')
    if (!filePath) { res.status(400).json({ error: 'path query param required' }); return }
    try {
      res.json(await getSessionFileChange(String(req.params.sessionId), filePath))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/changes/summary?path=<abs> — a short AI summary
// of ONE changed file. Cache-first (content-hash on disk); a miss asks the
// SESSION'S OWN CLI via a hidden side question (it has the context — it wrote
// the diff), never Walnut's model API. Deadlines: content fetch 15s / side
// question 30s inside the core module, plus a 40s overall cap HERE (the
// content path rides daemon RPCs — house rule: answer degraded, never pin a
// browser connection). Error contract the client depends on: 503 +
// {code:'ai_disabled'} is the ONLY signal that permanently hides the feature;
// 422 = never-summarizable file (hidden, no retry); other statuses (incl. the
// dead-CLI 503) show "unavailable · Retry".
sessionsRouter.get('/:sessionId/changes/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPath = req.query.path
    const filePath = typeof rawPath === 'string' ? rawPath : ''
    if (!filePath) { res.status(400).json({ error: 'path query param required (exactly one)' }); return }
    let deadline: NodeJS.Timeout | undefined
    try {
      const { summarizeSessionFileChange } = await import('../../core/diff-summary.js')
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new SessionControlError('Summary timed out', 504)), 40_000)
      })
      // lang = the browser locale (config agent.language overrides server-side).
      const langHint = typeof req.query.lang === 'string' ? req.query.lang : undefined
      res.json(await Promise.race([
        summarizeSessionFileChange(String(req.params.sessionId), filePath, { langHint }),
        timeout,
      ]))
    } catch (err) {
      // DiffSummaryError extends SessionControlError — one check covers both.
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      throw err
    } finally {
      clearTimeout(deadline)
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/changes/triage — ONE side question that asks the
// session which changed files are CRITICAL (reviewer-must-read-first), strict
// JSON out, cached by changeset shape. Also seeds the per-file summary cache
// with the returned one-liners, so clicking a starred file is an instant hit.
// Same error contract as /changes/summary (ai_disabled marker, 503 dead CLI).
sessionsRouter.get('/:sessionId/changes/triage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let deadline: NodeJS.Timeout | undefined
    try {
      const { triageSessionChangeset } = await import('../../core/diff-summary.js')
      const langHint = typeof req.query.lang === 'string' ? req.query.lang : undefined
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new SessionControlError('Triage timed out', 504)), 40_000)
      })
      res.json(await Promise.race([
        triageSessionChangeset(String(req.params.sessionId), { langHint }),
        timeout,
      ]))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      throw err
    } finally {
      clearTimeout(deadline)
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/plan — read plan content for a plan session
// (or its source plan session). Core logic lives in
// core/sessions/session-extras.ts (getSessionPlanPayload) — shared with the
// /api/v1 mobile route and the daemon control relay.
sessionsRouter.get('/:sessionId/plan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getSessionPlanPayload(String(req.params.sessionId)))
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/sessions/:sessionId/execute-continue — resume a completed plan
// session with bypass permissions. Core logic lives in
// core/sessions/session-lifecycle.ts (shared with /api/v1 + daemon relay).
sessionsRouter.post('/:sessionId/execute-continue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    try {
      res.json(await executeContinueSession(sessionId))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/interrupt — stop the running turn (no message,
// no queue drain). Same contract as the WS RPC session:interrupt; REST parity
// so scripts/API users can interrupt without a WS client (gap found during the
// 2026-08-12 codex live stress run).
sessionsRouter.post('/:sessionId/interrupt', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    log.web.info('session interrupt via REST', { sessionId })
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId }, ['session-runner'], { source: 'api' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/permission — resolve a pending permission
// request. Core logic lives in core/sessions/session-lifecycle.ts (shared
// with /api/v1 + daemon relay).
sessionsRouter.post('/:sessionId/permission', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    // `answers` carries an AskUserQuestion decision (question text → chosen label);
    // it becomes the tool's `answers` input so the model sees the real answers.
    const { requestId, allow, message: denyMessage, optionId, answers } = req.body as {
      requestId?: unknown
      allow?: unknown
      message?: unknown
      optionId?: unknown
      answers?: unknown
    }
    try {
      res.json(await respondSessionPermission(sessionId, requestId, allow, denyMessage, optionId, answers))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ── Side questions ("/btw") ─────────────────────────────────────────────────
// The native Claude Code side_question control_request, run INSIDE the live coding
// session (reuses its own prompt-cache prefix), answer kept OUT of the main
// transcript. See ClaudeCodeSession.askSideQuestion + side-questions.ts store.

// POST /api/sessions/:sessionId/effort — change reasoning effort mid-session.
// Core logic (validation, capability authority order, persist-first, live
// apply + read-back) lives in core/sessions/session-controls.ts — shared with
// the /api/v1 mobile route and the daemon control relay.
sessionsRouter.post('/:sessionId/effort', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const { effort: rawEffort } = req.body as { effort?: string }
  try {
    const { applySessionEffortChange, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      res.json(await applySessionEffortChange(sessionId, rawEffort))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/model — change the model mid-session.
// Core logic (alias/catalog resolution, ACP path, persist-first, live apply +
// read-back verification) lives in core/sessions/session-controls.ts — shared
// with the /api/v1 mobile route and the daemon control relay.
sessionsRouter.post('/:sessionId/model', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const { model: rawModel } = req.body as { model?: string }
  try {
    const { applySessionModelChange, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      res.json(await applySessionModelChange(sessionId, rawModel))
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/sessions/:sessionId/model-catalog — live ACP-discovered provider models.
sessionsRouter.get('/:sessionId/model-catalog', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  try {
    const record = await getSessionByClaudeId(sessionId)
    if (!record) {
      res.status(404).json({ error: 'session not found' })
      return
    }
    const caps = engineCaps(record.engine)
    if (caps.modelCatalog !== 'provider-advertised') {
      res.status(409).json({ error: 'model catalog is only available for ACP sessions' })
      return
    }
    const session = await sessionRunner.findOrAttachAcpSession(sessionId).catch(() => undefined)
    if (!session) {
      res.status(409).json({ error: `${caps.displayName} ACP session is not available` })
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

// modelReadBackMatches moved to core/sessions/session-controls.ts (shared with v1 + relay).

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
// Core logic lives in core/sessions/session-extras.ts (getSessionSettings) —
// shared with the /api/v1 mobile route and the daemon control relay.
sessionsRouter.get('/:sessionId/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getSessionSettings(String(req.params.sessionId), req.query.details === '1'))
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// GET /api/sessions/:sessionId/side-questions — history list for the drawer
sessionsRouter.get('/:sessionId/side-questions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listSessionSideQuestions(String(req.params.sessionId)))
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/side-question — ask + persist + broadcast.
// Core logic (attach-on-demand, DONE/ERROR bus events) lives in session-extras.ts.
sessionsRouter.post('/:sessionId/side-question', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await askSessionSideQuestion(String(req.params.sessionId), (req.body ?? {}).question))
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/sessions/:sessionId/side-question/:id/promote — turn a Q&A into a task
sessionsRouter.post('/:sessionId/side-question/:id/promote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await promoteSessionSideQuestion(String(req.params.sessionId), String(req.params.id))
    res.json({ taskId: result.taskId, parentTaskId: result.parentTaskId })
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// DELETE /api/sessions/:sessionId/side-question/:id — remove a Q&A from history
sessionsRouter.delete('/:sessionId/side-question/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await removeSessionSideQuestion(String(req.params.sessionId), String(req.params.id)))
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// ── Side threads ─────────────────────────────────────────────────────────────
// A side thread is a HIDDEN fork session of this session (no task row) that
// answers an aside without touching the main transcript. Follow-up messages need
// no route here — the client sends them to the thread's session id through the
// ordinary session:send RPC. Lifecycle lives in core/sessions/side-thread-*.ts.

/** The manager (TTL timers, boot/idle sweeps — the ONLY reaper for these
 *  sessions) runs on the PRIMARY only, so a replica accepting a create would
 *  mint hidden CLI processes nothing ever retires. GET stays available (it is
 *  a pure read); every mutating route refuses on the replica. */
function refuseSideThreadsOnReplica(res: Response): boolean {
  if (!process.env.WALNUT_CLOUD_MODE) return false
  res.status(501).json({ error: 'Side threads are managed by the primary server' })
  return true
}

/** SessionControlError → HTTP, with the fork veto reported by code. */
function sendSideThreadError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof SessionControlError) {
    if (err.extra?.code === 'ACP_FORK_UNSUPPORTED') {
      res.status(409).json({ error: 'fork_unsupported' })
      return
    }
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  next(err)
}

// GET /api/sessions/:sessionId/side-threads — threads + legacy one-shot Q&As
sessionsRouter.get('/:sessionId/side-threads', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { sideThreadManager } = await import('../../core/sessions/side-thread-manager.js')
    res.json(await sideThreadManager.listThreads(String(req.params.sessionId)))
  } catch (err) {
    sendSideThreadError(err, res, next)
  }
})

// POST /api/sessions/:sessionId/side-threads/standby — prewarm a fork so the
// first ask pays no spawn latency. Answers IMMEDIATELY: the spawn takes seconds
// and the client only needs to know the request was accepted.
sessionsRouter.post('/:sessionId/side-threads/standby', async (req: Request, res: Response) => {
  if (refuseSideThreadsOnReplica(res)) return
  const sessionId = String(req.params.sessionId)
  res.json({ ok: true })
  try {
    const { sideThreadManager } = await import('../../core/sessions/side-thread-manager.js')
    await sideThreadManager.ensureStandby(sessionId)
  } catch (err) {
    log.web.warn('side thread standby prewarm failed', {
      sessionId, error: err instanceof Error ? err.message : String(err),
    })
  }
})

// POST /api/sessions/:sessionId/side-threads — open a thread and ask in it
sessionsRouter.post('/:sessionId/side-threads', async (req: Request, res: Response, next: NextFunction) => {
  if (refuseSideThreadsOnReplica(res)) return
  try {
    const { question, title } = (req.body ?? {}) as { question?: unknown; title?: unknown }
    if (!question || typeof question !== 'string' || !question.trim()) {
      res.status(400).json({ error: 'question (non-empty string) is required' })
      return
    }
    const { sideThreadManager } = await import('../../core/sessions/side-thread-manager.js')
    const thread = await sideThreadManager.createThread(String(req.params.sessionId), {
      question,
      ...(typeof title === 'string' && title.trim() ? { title } : {}),
    })
    res.json({ thread })
  } catch (err) {
    sendSideThreadError(err, res, next)
  }
})

// POST /api/sessions/:sessionId/side-threads/:threadId/promote — task + un-hide
sessionsRouter.post('/:sessionId/side-threads/:threadId/promote', async (req: Request, res: Response, next: NextFunction) => {
  if (refuseSideThreadsOnReplica(res)) return
  try {
    const { title } = (req.body ?? {}) as { title?: unknown }
    const { promoteSideThread } = await import('../../core/sessions/side-thread-promote.js')
    const result = await promoteSideThread(
      String(req.params.sessionId),
      String(req.params.threadId),
      typeof title === 'string' && title.trim() ? { title } : undefined,
    )
    res.json({
      taskId: result.taskId,
      ...(result.parentTaskId ? { parentTaskId: result.parentTaskId } : {}),
      sessionId: result.sessionId,
    })
  } catch (err) {
    sendSideThreadError(err, res, next)
  }
})

// DELETE /api/sessions/:sessionId/side-threads/:threadId — stop + archive + forget
sessionsRouter.delete('/:sessionId/side-threads/:threadId', async (req: Request, res: Response, next: NextFunction) => {
  if (refuseSideThreadsOnReplica(res)) return
  try {
    const { sideThreadManager } = await import('../../core/sessions/side-thread-manager.js')
    await sideThreadManager.retireThread(String(req.params.sessionId), String(req.params.threadId))
    res.json({ ok: true })
  } catch (err) {
    sendSideThreadError(err, res, next)
  }
})

// POST /api/sessions/:sessionId/execute-compact — execute plan by injecting a
// compact boundary into the SAME session (clears plan conversation but
// preserves session ID, slug, and plan file). Core logic lives in
// core/sessions/session-extras.ts (executeCompactSession) — shared with the
// /api/v1 mobile route and the daemon control relay.
sessionsRouter.post('/:sessionId/execute-compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task_id, working_directory, instructions, mode } = (req.body ?? {}) as {
      task_id?: string
      working_directory?: string
      instructions?: string
      mode?: string
    }
    res.json(await executeCompactSession(String(req.params.sessionId), {
      task_id, working_directory, instructions, mode,
    }))
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
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

    if (mode && !CLAUDE_SESSION_MODES.includes(mode as SessionMode)) {
      res.status(400).json({ error: `Invalid mode: ${mode}. Must be one of: ${CLAUDE_SESSION_MODES.join(', ')}` })
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

// POST /api/sessions/:sessionId/retry — RECONNECT a failed session. It never
// synthesizes message text: with a pending queue it re-sends the user's original
// message, with an empty queue it just clears the stale error and leaves the
// conversation resumable ('resumable'), and only a conversation that never
// reached disk falls back to archive+new.
// Logic lives in core/sessions/session-lifecycle.ts (shared with /api/v1 + relay).
sessionsRouter.post('/:sessionId/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const result = await retrySession(sessionId)
    res.json(result)
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/sessions/:sessionId/recheck — ask the session's host, right now,
// whether it is reachable and whether the CLI is alive, and reconcile the record
// from the daemon's own snapshot. Sends nothing, spawns nothing, never dials a
// new connection, and answers within its own RPC deadline (see recheckSession).
// The panel fires this when it opens a record sitting in 'error'.
sessionsRouter.post('/:sessionId/recheck', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = req.params.sessionId as string
    const result = await recheckSession(sessionId)
    res.json(result)
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
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
// Logic lives in core/sessions/session-lifecycle.ts (shared with /api/v1 + relay).
sessionsRouter.post('/:sessionId/restart', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const startedAt = Date.now()
  log.web.info('session restart: request received', { sessionId })
  try {
    const result = await restartSession(sessionId)
    log.web.info('session restart: complete', {
      sessionId,
      durationMs: Date.now() - startedAt,
      pendingMessages: result.pendingMessages,
    })
    res.json(result)
  } catch (err) {
    if (err instanceof SessionControlError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
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
// Logic lives in core/sessions/session-lifecycle.ts (shared with /api/v1 + relay),
// including the cron-owner guard (409 unless force) — see terminateSession.
sessionsRouter.post('/:sessionId/terminate', async (req: Request, res: Response, next: NextFunction) => {
  const sessionId = req.params.sessionId as string
  const startedAt = Date.now()
  log.web.info('session terminate: request received', { sessionId })
  try {
    const force = req.body?.force === true || req.query?.force === '1'
    const result = await terminateSession(sessionId, { force })
    log.web.info('session terminate: complete', { sessionId, durationMs: Date.now() - startedAt })
    res.json(result)
  } catch (err) {
    if (err instanceof SessionControlError) {
      if (err.extra?.code === 'cron_owner') {
        // Preserve the web contract's exact 409 body shape.
        res.status(409).json({ error: 'cron_owner', message: err.message, sessionId })
        return
      }
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    log.web.error('session terminate: failed', {
      sessionId,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    })
    next(err)
  }
})

// POST /api/sessions/:sessionId/fork — fork a session to a different task.
// Core logic (sibling-task creation, grouping, title refinement, 1-session-
// per-task guard, record seed + SESSION_START emit) lives in
// core/sessions/session-controls.ts — shared with the /api/v1 mobile route and
// the daemon control relay. This route only handles the web-specific extras:
// image uploads (saved to disk → path annotation in the fork message).
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

    // Attached images: save to disk + build a "read these files" annotation
    // (same path-based flow as quick-start). The image context sits AFTER the
    // focus directive but BEFORE the request inside the core fork message.
    let imageContext = ''
    if (images && images.length > 0) {
      const processed = await processAndSaveImages(images)
      if (processed) imageContext = buildSessionImageContext(processed.savedImages)
    }

    const { forkSessionToTask, SessionControlError } = await import('../../core/sessions/session-controls.js')
    try {
      const result = await forkSessionToTask(sourceSessionId, {
        task_id, create_child_task, child_title, message, title, model,
        ...(imageContext ? { imageContext } : {}),
      }, 'web-api')
      // Web and mobile now share the SAME core result shape (including the
      // additive `title` field); clients ignore fields they don't know.
      res.json(result)
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/sessions/:sessionId/rewind — take the conversation back to a message.
//   { message_uuid, dry_run?, mode?, restore_files?, keep_source?, message? }
// mode: 'in-place' (default) rewinds THIS conversation; 'fork' continues under
// a new session id and archives the source. dry_run answers with the blast
// radius (files changed, +/- lines, dropped messages) and writes NOTHING, so
// the confirm dialog can show it. Core logic + the reasoning about which CLI
// channel does what lives in core/sessions/session-rewind.ts.
sessionsRouter.post('/:sessionId/rewind', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const sessionId = String(req.params.sessionId)
    const { message_uuid, dry_run, mode, restore_files, keep_source, message } = (req.body ?? {}) as {
      message_uuid?: string
      dry_run?: boolean
      mode?: string
      restore_files?: boolean
      keep_source?: boolean
      message?: string
    }
    const { SessionControlError } = await import('../../core/sessions/session-controls.js')
    const { previewSessionRewind, rewindSessionToMessage } = await import('../../core/sessions/session-rewind.js')
    try {
      if (dry_run) {
        res.json({ preview: await previewSessionRewind(sessionId, String(message_uuid ?? '')) })
        return
      }
      const result = await rewindSessionToMessage(sessionId, {
        messageUuid: String(message_uuid ?? ''),
        // Unknown mode strings fall back to the in-place default rather than 400:
        // the field is additive and older clients never send it.
        ...(mode === 'fork' ? { mode: 'fork' as const } : {}),
        ...(restore_files !== undefined ? { restoreFiles: !!restore_files } : {}),
        ...(keep_source !== undefined ? { keepSource: !!keep_source } : {}),
        ...(message !== undefined ? { message: String(message) } : {}),
      }, 'web-api')
      log.web.info('session rewound via REST', {
        sessionId, rewoundId: result.sessionId, mode: result.mode, restoreFiles: !!restore_files,
      })
      // Web and mobile now share the SAME core result shape (including the
      // additive `title` field); clients ignore fields they don't know.
      res.json(result)
    } catch (err) {
      if (err instanceof SessionControlError) {
        res.status(err.statusCode).json({ error: err.message, ...(err.extra ?? {}) })
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})
