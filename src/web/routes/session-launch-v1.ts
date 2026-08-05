/**
 * /api/v1 session launch endpoints (additive) — create a NEW Claude Code
 * session from mobile, with the same host/path semantics as the web Quick
 * Start launcher.
 *
 *   GET  /sessions/launch-options → { hosts, dirs } — where can a session run
 *        (the primary box + every enabled config.hosts entry) and which paths
 *        the user launches from (frequent-dirs store, same source + scoring
 *        as the web launcher's suggestions).
 *   POST /sessions { cwd, host?, message?, taskId?, model?, mode? }
 *        → 201 { sessionId, taskId, title }
 *
 * Creation reuses quickStartSession() — the exact task-create/reuse →
 * SESSION_START → session-runner chain the web launcher uses — so a mobile
 * launch spawns the CLI locally or via the chosen host's SSH daemon with
 * identical semantics. `taskId` links the new session to an existing task
 * (retry-mode: archives that task's error/stopped sessions to free the slot).
 *
 * 201 means ACCEPTED, not spawned: quickStartSession returns right after the
 * SESSION_START bus emit; the CLI spawn is async in session-runner. A bad
 * remote host or a cwd typo surfaces as session `error` status later, not as
 * an HTTP failure here — the record is pre-seeded so the returned sessionId
 * immediately resolves on the transcript/stream/messages endpoints.
 *
 * Primary box only: a cloud companion (REPLICA) has no spawn path — the
 * /bridge command allowlist deliberately excludes `start` — so both endpoints
 * return 503 not_supported_cloud there. The iOS app hides its create entry
 * points when /api/v1/status reports REPLICA, and the sheet additionally
 * degrades to a clear unavailable state if it ever hits the 503.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import { CLOUD_MODE, QUICK_START_MESSAGE_HARD_LIMIT } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { getFrequentDirs, scoreFrequentDir } from '../../core/frequent-dirs.js'
import { quickStartSession, QuickStartError } from '../../core/sessions/quick-start.js'
import { resolveModelSwitchValue, VALID_SESSION_MODEL_IDS } from '../../core/types.js'
import { log } from '../../logging/index.js'

export const sessionLaunchV1Router = Router()

// Same frozen error shape as api-v1.ts / session-stream-v1.ts.
function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } })
}

function cloudUnsupported(res: Response): void {
  sendError(
    res, 503, 'not_supported_cloud',
    'Creating sessions runs on the primary box — connect the app to it directly',
  )
}

const VALID_MODES = new Set(['bypass', 'accept', 'default', 'plan'])
const MAX_SUGGESTED_DIRS = 30

// GET /api/v1/sessions/launch-options — hosts + suggested working dirs for
// the mobile New Session sheet. Hosts: the primary box (alias '' — matching
// ProjectedSession.host semantics) plus every enabled config.hosts entry.
// Dirs: the frequent-directories store, scored by the shared launcher formula
// (scoreFrequentDir — same as GET /api/sessions/working-dirs), capped at 30.
sessionLaunchV1Router.get('/sessions/launch-options', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      cloudUnsupported(res)
      return
    }
    const config = await getConfig()
    const hostsCfg = config.hosts ?? {}
    const hosts = [
      { alias: '', label: 'This Mac' },
      ...Object.entries(hostsCfg)
        .filter(([, h]) => h.enabled !== false)
        .map(([alias, h]) => ({ alias, label: h.label ?? alias })),
    ]
    const offeredAliases = new Set(hosts.map((h) => h.alias))

    const raw = await getFrequentDirs()
    const now = Date.now()
    let maxAgeMs = 1
    let maxCount = 1
    for (const d of raw) {
      const age = now - new Date(d.lastUsed).getTime()
      if (age > maxAgeMs) maxAgeMs = age
      if (d.count > maxCount) maxCount = d.count
    }
    const dirs = raw
      // count===0 rows are recordLaunchPrefs placeholders (a launch pref was
      // remembered but no session ever started there) — their fresh lastUsed
      // would rank them TOP by recency, and the sheet preselects rank #1, so
      // they'd become the default path despite never having worked. Dirs on
      // hosts we don't offer (disabled/removed) are unlaunchable dead payload.
      .filter((d) => d.count > 0 && offeredAliases.has(d.host ?? ''))
      .map((d) => ({
        cwd: d.cwd,
        // The store uses null for local; mobile gets '' so Dir.host
        // string-equals Host.alias (the sheet filters suggestions with ==).
        host: d.host ?? '',
        hostLabel: d.host ? hostsCfg[d.host]?.label ?? d.host : undefined,
        lastUsed: d.lastUsed,
        count: d.count,
        score: scoreFrequentDir(d, now, maxAgeMs, maxCount),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTED_DIRS)
      .map(({ score: _s, ...rest }) => rest)

    res.json({ hosts, dirs })
  } catch (err) {
    next(err)
  }
})

/** HTTP status → frozen v1 error code for QuickStartError passthrough. */
function quickStartErrorCode(status: number): string {
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'internal'
  return 'bad_request'
}

// POST /api/v1/sessions — create a session. Mirrors the web quick-start
// route's validation, then delegates to the shared quickStartSession() core.
// Returns 201 with the pre-assigned session id so the app can open the
// conversation view immediately (the record is pre-seeded before the spawn).
sessionLaunchV1Router.post('/sessions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      cloudUnsupported(res)
      return
    }
    const { cwd, host: rawHost, message, taskId, model: rawModel, mode } = (req.body ?? {}) as {
      cwd?: unknown
      host?: unknown
      message?: unknown
      taskId?: unknown
      model?: unknown
      mode?: unknown
    }

    if (typeof cwd !== 'string' || !cwd.trim()) {
      sendError(res, 400, 'bad_request', 'cwd is required')
      return
    }
    // Absolute-only: a relative path from a phone keyboard would still 201
    // (spawn is async — see header) and then die as an opaque session error.
    // Rejecting here is the only server-side gate; the sheet's hasPrefix("/")
    // check is just the client-side mirror.
    if (!cwd.startsWith('/')) {
      sendError(res, 400, 'bad_request', 'cwd must be an absolute path')
      return
    }
    if (cwd.length > 4096) {
      sendError(res, 400, 'bad_request', 'cwd too long (max 4096 chars)')
      return
    }
    // Empty/absent message = spawn + idle with no first turn (same contract as
    // the web launcher's path-first start).
    if (message !== undefined && typeof message !== 'string') {
      sendError(res, 400, 'bad_request', 'message must be a string')
      return
    }
    const msg = typeof message === 'string' ? message : ''
    if (msg.length > QUICK_START_MESSAGE_HARD_LIMIT) {
      sendError(res, 400, 'bad_request', `message too long (max ${QUICK_START_MESSAGE_HARD_LIMIT} chars)`)
      return
    }
    if (taskId !== undefined && (typeof taskId !== 'string' || !taskId)) {
      sendError(res, 400, 'bad_request', 'taskId must be a non-empty string')
      return
    }

    // Host: '' / absent = the primary box; otherwise must be an enabled
    // config.hosts alias — a clear 400 beats a doomed daemon connect.
    let host: string | undefined
    if (rawHost !== undefined && rawHost !== null && rawHost !== '') {
      if (typeof rawHost !== 'string') {
        sendError(res, 400, 'bad_request', 'host must be a string')
        return
      }
      const config = await getConfig()
      const entry = config.hosts?.[rawHost]
      if (!entry || entry.enabled === false) {
        sendError(res, 400, 'bad_request', `Unknown host: ${rawHost}. Use an alias from GET /api/v1/sessions/launch-options`)
        return
      }
      host = rawHost
    }

    // Model: same shared validator as the web quick-start / model-switch routes.
    let model: string | undefined
    if (typeof rawModel === 'string' && rawModel && rawModel !== 'default') {
      const resolved = resolveModelSwitchValue(rawModel)
      if (!resolved) {
        sendError(res, 400, 'bad_request', `Invalid model: ${rawModel}. Use one of: ${[...VALID_SESSION_MODEL_IDS].join('/')}`)
        return
      }
      model = resolved
    }

    if (mode !== undefined && (typeof mode !== 'string' || !VALID_MODES.has(mode))) {
      sendError(res, 400, 'bad_request', `Invalid mode: ${String(mode)}. Must be one of: ${[...VALID_MODES].join(', ')}`)
      return
    }

    const preassignedSessionId = randomUUID()
    try {
      const task = await quickStartSession({
        message: msg,
        cwd,
        host,
        model,
        mode: typeof mode === 'string' ? mode : undefined,
        existingTaskId: typeof taskId === 'string' ? taskId : undefined,
        source: 'mobile-launch',
        requestTs: Date.now(),
        preassignedSessionId,
      })
      log.web.info('mobile-launch: session created', {
        sessionId: preassignedSessionId, taskId: task.id, cwd, host: host ?? '',
      })
      res.status(201).json({ sessionId: preassignedSessionId, taskId: task.id, title: task.title })
    } catch (err) {
      if (err instanceof QuickStartError) {
        sendError(res, err.statusCode, quickStartErrorCode(err.statusCode), err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
// Same form as apiV1Router's funnel: guard headersSent (a handler may fail
// after partially writing) and treat err as unknown.
sessionLaunchV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 session launch error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
