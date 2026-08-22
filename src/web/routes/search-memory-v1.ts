/**
 * /api/v1 search + memory + notifications + favorites + notes utilities
 * (additive) — the Wave-1 read/utility set. Every endpoint reuses the SAME
 * core/shared functions as the internal web routes; no logic duplication.
 *
 *   GET  /search?q&types&limit        → { results }              (C: 501 on replica)
 *   GET  /notes/search?q&mode&limit   → { results, folders?, degraded? } (A: string leg on replica)
 *   GET  /memory/browse               → { tree }                 (A: git-synced files)
 *   GET  /memory?category=            → { memories }
 *   GET  /memory/global | /memory/user       → { memory } | 404
 *   PUT  /memory/global | /memory/user { content } → { ok, updatedAt }
 *   GET  /memory/telemetry            → { stores, note }          (Wave 3, A)
 *   POST /memory/daily-log/compact    → compaction result         (Wave 3, A)
 *   GET  /notifications               → { feed, unreadCount }    (B: relay on replica)
 *   POST /notifications/mark-read { ids? }        → { unreadCount }
 *   POST /notifications/dismiss { ids?, dedupKeys? } → { unreadCount, removed }
 *   GET  /favorites                   → { projects, notes }      (A)
 *   POST /favorites/notes { path }    → { notes }
 *   DELETE /favorites/notes { path }  → { notes }
 *   GET  /notes/attachment?path=      → attachment bytes          (A)
 *   POST /notes/attachment { notePath, data, mediaType } → { ok, path, name }
 *   POST /notes/move { from, to }     → { ok }
 *   POST /notes/folder { path }       → { ok }
 *
 * Replica classes: /search needs the QMD semantic store which never initializes
 * on the cloud box (would pin the small instance) → explicit 501
 * not_supported_cloud. Notes search degrades gracefully to its string leg
 * (performNotesSearch already gates the semantic leg on !CLOUD_MODE). Memory,
 * favorites, and notes ride the git-synced data dir (Class A — local files on
 * both boxes). Notifications live in the primary's store only → Class B relay
 * over the `session.control` bridge command's `server.*` action family
 * (sessionId is ignored; '__server__' is passed as a placeholder).
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { relayControlAction, sendV1Error as sendError } from './v1-control-relay.js'
import { stripEntityRefs } from '../../utils/entity-refs.js'

export const searchMemoryV1Router = Router()

/** Placeholder sessionId for the box-level `server.*` relay actions. */
const SERVER_RELAY_SID = '__server__'

// ─── Global search ───────────────────────────────────────────────────────────

// GET /api/v1/search?q=&types=task,memory,session&limit=20
// C-class on replica: the semantic QMD store never initializes on the cloud
// box, so answer an explicit 501 instead of a half-empty result set.
searchMemoryV1Router.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      sendError(res, 501, 'not_supported_cloud', 'Global search runs on the primary box only')
      return
    }
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    if (!q.trim()) {
      sendError(res, 400, 'bad_request', 'q (non-empty string) is required')
      return
    }
    // `type` accepted as an alias of `types` — same rationale as /api/search:
    // a guessed singular param must not silently fall back to default lanes.
    const rawTypes = req.query.types ?? req.query.type
    const typesParam = typeof rawTypes === 'string' ? rawTypes : undefined
    const VALID_TYPES = ['task', 'memory', 'session'] as const
    let types: Array<(typeof VALID_TYPES)[number]> | undefined
    if (typesParam) {
      const requested = typesParam.split(',')
      const invalid = requested.filter((t) => !(VALID_TYPES as readonly string[]).includes(t))
      if (invalid.length > 0) {
        sendError(res, 400, 'bad_request', `invalid types: ${invalid.join(', ')} (valid: ${VALID_TYPES.join(', ')})`)
        return
      }
      types = [...new Set(requested)] as Array<(typeof VALID_TYPES)[number]>
    }
    const limit = req.query.limit ? Math.max(1, Math.min(100, Number(req.query.limit) || 20)) : undefined
    const { search } = await import('../../core/search.js')
    res.json({ results: await search(q, { types, limit }) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/notes/search?q=&mode=&limit=&all=1 — hybrid notes search.
// Works on BOTH boxes: performNotesSearch gates its semantic leg on
// !CLOUD_MODE, so the replica serves the string/FTS leg (degraded flag set).
searchMemoryV1Router.get('/notes/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : ''
    const { performNotesSearch } = await import('./notes-v2.js')
    const payload = await performNotesSearch({
      q,
      limit: Number(req.query.limit) || 30,
      mode: ((typeof req.query.mode === 'string' && req.query.mode) || 'hybrid') as 'hybrid' | 'string' | 'semantic',
      includeAll: req.query.all === '1' || req.query.all === 'true',
    })
    res.json(payload)
  } catch (err) {
    next(err)
  }
})

// ─── Memory ──────────────────────────────────────────────────────────────────

// GET /api/v1/memory/browse — metadata tree of all memory sources.
searchMemoryV1Router.get('/memory/browse', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { buildMemoryBrowseTree } = await import('./memory.js')
    res.json({ tree: await buildMemoryBrowseTree() })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/memory/telemetry (Wave 3) — write-path evidence per memory entry
// (age, revision churn, provenance). A: reads git-synced files; the sidecar
// bootstrap side effect is confined to the answering box's telemetry file.
searchMemoryV1Router.get('/memory/telemetry', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { buildMemoryTelemetryPayload } = await import('./memory.js')
    res.json(await buildMemoryTelemetryPayload())
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/memory/daily-log/compact { date?, threshold?, summarizer } —
// manual daily-log compaction with the extractive (no-LLM) summarizer.
// Wave 3, Class A (daily logs ride git-sync).
searchMemoryV1Router.post('/memory/daily-log/compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { compactDailyLogManual, MemoryOpError } = await import('./memory.js')
    try {
      res.json(await compactDailyLogManual(req.body ?? {}))
    } catch (err) {
      if (err instanceof MemoryOpError) {
        sendError(res, err.statusCode, err.statusCode === 404 ? 'not_found' : 'bad_request', err.message, err.extra)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/memory?category= — list memory entries (project/session/knowledge).
searchMemoryV1Router.get('/memory', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined
    const { listMemories } = await import('../../core/memory.js')
    res.json({ memories: listMemories(category) })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/memory/global — read MEMORY.md.
searchMemoryV1Router.get('/memory/global', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { readGlobalMemoryDoc } = await import('./memory.js')
    const memory = await readGlobalMemoryDoc()
    if (!memory) {
      sendError(res, 404, 'not_found', 'Global MEMORY.md not found')
      return
    }
    res.json({ memory })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/memory/global { content } — write MEMORY.md (human-edit provenance).
searchMemoryV1Router.put('/memory/global', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const content = (req.body ?? {}).content
    if (typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content (string) is required')
      return
    }
    const { writeMemoryDoc } = await import('./memory.js')
    res.json(await writeMemoryDoc('memory', content))
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/memory/user — read USER.md.
searchMemoryV1Router.get('/memory/user', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { readUserMemoryDoc } = await import('./memory.js')
    const memory = await readUserMemoryDoc()
    if (!memory) {
      sendError(res, 404, 'not_found', 'USER.md not found')
      return
    }
    res.json({ memory })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/memory/user { content } — write USER.md.
searchMemoryV1Router.put('/memory/user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const content = (req.body ?? {}).content
    if (typeof content !== 'string') {
      sendError(res, 400, 'bad_request', 'content (string) is required')
      return
    }
    const { writeMemoryDoc } = await import('./memory.js')
    res.json(await writeMemoryDoc('user', content))
  } catch (err) {
    next(err)
  }
})

// ─── Notifications ──────────────────────────────────────────────────────────

/**
 * Read-time bound on feed bodies (same value as the internal route — keep in
 * sync with MAX_FEED_BODY_CHARS in the web client).
 */
const MAX_BODY_CHARS = 600

function sanitizeBody(body?: string): string | undefined {
  if (!body) return body
  const clean = stripEntityRefs(body)
  if (clean.length <= MAX_BODY_CHARS) return clean
  let cut = clean.slice(0, MAX_BODY_CHARS)
  // Don't split a surrogate pair (an emoji on the boundary would render as �).
  const last = cut.charCodeAt(cut.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
  return `${cut}…`
}

function parseStringArray(res: Response, value: unknown, field: string): { ok: boolean; value?: string[] } {
  if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) {
    sendError(res, 400, 'bad_request', `${field} must be an array of strings`)
    return { ok: false }
  }
  return { ok: true, value: value as string[] | undefined }
}

// GET /api/v1/notifications — feed (newest-last) + unread count.
// B-class: the durable store lives on the primary, so a replica relays via
// the `server.notifications` control action for freshness.
searchMemoryV1Router.get('/notifications', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.notifications', SERVER_RELAY_SID, undefined, 200)
      return
    }
    const { listNotifications } = await import('../../core/notifications/store.js')
    const { feed, unreadCount } = await listNotifications()
    // `detail` capped alongside `body` — same reasoning as the /api twin in
    // routes/notifications.ts (same producers, same UI, same read-time bound).
    res.json({
      feed: feed.map((n) => ({ ...n, body: sanitizeBody(n.body), detail: sanitizeBody(n.detail) })),
      unreadCount,
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notifications/mark-read { ids? } — no ids = mark ALL read.
searchMemoryV1Router.post('/notifications/mark-read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = parseStringArray(res, (req.body ?? {}).ids, 'ids')
    if (!ids.ok) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.notifications.mark-read', SERVER_RELAY_SID,
        ids.value ? { ids: ids.value } : undefined, 200)
      return
    }
    const { markRead } = await import('../../core/notifications/store.js')
    res.json(await markRead(ids.value))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notifications/dismiss { ids?, dedupKeys? } — no filter = ALL.
searchMemoryV1Router.post('/notifications/dismiss', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = (req.body ?? {}) as { ids?: unknown; dedupKeys?: unknown }
    const ids = parseStringArray(res, body.ids, 'ids')
    if (!ids.ok) return
    const dedupKeys = parseStringArray(res, body.dedupKeys, 'dedupKeys')
    if (!dedupKeys.ok) return
    if (CLOUD_MODE) {
      await relayControlAction(res, 'server.notifications.dismiss', SERVER_RELAY_SID, {
        ...(ids.value ? { ids: ids.value } : {}),
        ...(dedupKeys.value ? { dedupKeys: dedupKeys.value } : {}),
      }, 200)
      return
    }
    const { dismissNotifications } = await import('../../core/notifications/store.js')
    res.json(await dismissNotifications({ ids: ids.value, dedupKeys: dedupKeys.value }))
  } catch (err) {
    next(err)
  }
})

// ─── Favorites (formalizing paths iOS already calls out-of-contract) ─────────

// GET /api/v1/favorites → { projects, notes }
searchMemoryV1Router.get('/favorites', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    res.json({
      projects: config.favorites?.projects ?? [],
      notes: config.favorites?.notes ?? [],
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/favorites/notes { path } — add a note favorite (idempotent).
searchMemoryV1Router.post('/favorites/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = (req.body ?? {}).path
    if (typeof notePath !== 'string' || !notePath) {
      sendError(res, 400, 'bad_request', 'path is required')
      return
    }
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    if (!config.favorites.notes) config.favorites.notes = []
    if (!config.favorites.notes.includes(notePath)) config.favorites.notes.push(notePath)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ notes: config.favorites.notes })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/favorites/notes { path } (or ?path=) — remove a note favorite.
searchMemoryV1Router.delete('/favorites/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notePath = (req.body?.path ?? req.query.path) as unknown
    if (typeof notePath !== 'string' || !notePath) {
      sendError(res, 400, 'bad_request', 'path is required')
      return
    }
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    config.favorites.notes = (config.favorites.notes ?? []).filter((p) => p !== notePath)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ notes: config.favorites.notes })
  } catch (err) {
    next(err)
  }
})

// ─── Notes utilities (attachment / move / folder) ────────────────────────────
// The v1 notes namespace already exists in api-v1.ts (tree/content CRUD);
// these formalize the internal /api/notes-v2 paths iOS already calls, reusing
// the extracted notes-v2 operation functions (NotesOpError → frozen shape).

// GET /api/v1/notes/attachment?path=[&note=] — attachment bytes (image/PDF/Office).
// `note` is the vault path of the embedding note; it only breaks duplicate-name
// ties (a real vault has the same image filename in many `_attachment/` dirs).
searchMemoryV1Router.get('/notes/attachment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { readNoteAttachment, NotesOpError } = await import('./notes-v2.js')
    try {
      const { buffer, mime, contentDisposition } = await readNoteAttachment(req.query.path, req.query.note)
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Length', buffer.length)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.setHeader('Content-Disposition', contentDisposition)
      res.send(buffer)
    } catch (err) {
      if (err instanceof NotesOpError) {
        const code = err.statusCode === 404 ? 'not_found' : err.statusCode === 413 ? 'too_large' : 'bad_request'
        sendError(res, err.statusCode, code, err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notes/attachment { notePath, data, mediaType } — paste upload.
searchMemoryV1Router.post('/notes/attachment', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { saveNoteAttachment, NotesOpError } = await import('./notes-v2.js')
    const { notePath, data, mediaType } = (req.body ?? {}) as Record<string, unknown>
    try {
      res.json(await saveNoteAttachment(notePath, data, mediaType))
    } catch (err) {
      if (err instanceof NotesOpError) {
        const code = err.statusCode === 413 ? 'too_large' : 'bad_request'
        sendError(res, err.statusCode, code, err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notes/move { from, to } — rename/move a note or attachment.
searchMemoryV1Router.post('/notes/move', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { moveNote, NotesOpError } = await import('./notes-v2.js')
    const { from, to } = (req.body ?? {}) as Record<string, unknown>
    try {
      res.json(await moveNote(from, to))
    } catch (err) {
      if (err instanceof NotesOpError) {
        const code = err.statusCode === 404 ? 'not_found' : err.statusCode === 409 ? 'conflict' : 'bad_request'
        sendError(res, err.statusCode, code, err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/notes/folder { path } — create a vault folder.
searchMemoryV1Router.post('/notes/folder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { createNotesFolder, NotesOpError } = await import('./notes-v2.js')
    try {
      res.json(await createNotesFolder((req.body ?? {}).path))
    } catch (err) {
      if (err instanceof NotesOpError) {
        sendError(res, err.statusCode, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
searchMemoryV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 search/memory route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
