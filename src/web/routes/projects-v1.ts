/**
 * /api/v1 projects + ordering + project favorites (additive, Wave 2).
 * Semantics identical to the web routes (projects.ts / ordering.ts /
 * favorites.ts) — same core functions, zero duplicated logic.
 *
 *   GET    /projects                     → { projects, inbox }
 *   POST   /projects { name, source? }   → 200/201 ensureProject result
 *   PATCH  /projects/:name { name }      → rename result
 *   DELETE /projects/:name[?remote=1]    → delete/cascade result
 *   GET    /ordering                     → { projects }
 *   PUT    /ordering/projects { order }  → { projects }
 *   POST   /favorites/projects/:name     → { projects }
 *   DELETE /favorites/projects/:name     → { projects }
 *
 * Replica classes:
 * - Listing/create: Class A. The replica has a real local task store; a new
 *   project registry row also materializes on the primary the moment a task
 *   op naming it rides the outbox (same path POST /v1/tasks uses).
 * - Rename/delete: Class C — 501 not_supported_cloud on a REPLICA. The
 *   registry has NO outbox channel, so a replica-local rename/delete would be
 *   silently reverted by the next projection import, and cascade delete needs
 *   the primary's provider plugin auth. Doing it wrong is worse than a clear
 *   501 (same single-writer lesson as routines).
 * - Ordering/favorites: Class A — config-backed, same as the Wave-1 note
 *   favorites (config rides git-sync between the boxes).
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const projectsV1Router = Router()

/**
 * Map the task-manager's project errors onto the frozen v1 vocabulary.
 * Returns true when the error was handled (response sent).
 */
async function sendProjectError(res: Response, err: unknown): Promise<boolean> {
  const tm = await import('../../core/task-manager.js')
  if (err instanceof tm.ProjectSourceConflictError) {
    sendError(res, 409, 'conflict', err.message, {
      project: err.project,
      intended_source: err.intendedSource,
      existing_source: err.existingSource,
    })
    return true
  }
  if (err instanceof tm.InvalidProjectNameError) {
    sendError(res, 400, 'bad_request', err.message, { project: err.project })
    return true
  }
  if (err instanceof tm.ProjectRemoteDeleteUnsupportedError) {
    sendError(res, 409, 'conflict', err.message, { project: err.project, existing_source: err.source })
    return true
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/^No project /.test(msg)) {
    sendError(res, 404, 'not_found', msg)
    return true
  }
  if (msg.includes('mixed sources')) {
    sendError(res, 409, 'conflict', msg)
    return true
  }
  return false
}

// GET /api/v1/projects — registry rows + task counts + favorite flags + Inbox.
projectsV1Router.get('/projects', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { buildProjectsPayload } = await import('./projects.js')
    res.json(await buildProjectsPayload())
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/projects { name, source? } — idempotent create (ensureProject):
// re-posting an existing name is a 200 with created:false and the EXISTING
// row's source — a second caller can never steal a claim.
projectsV1Router.post('/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, source } = (req.body ?? {}) as { name?: unknown; source?: unknown }
    if (typeof name !== 'string' || name.trim() === '') {
      sendError(res, 400, 'bad_request', 'name must be a non-empty string')
      return
    }
    const { registry } = await import('../../core/integration-registry.js')
    if (source !== undefined) {
      // Any registered plugin id (plus 'local') is valid — no hardcoded list.
      const validSources = new Set(['local', ...registry.getAll().map((p) => p.id)])
      if (typeof source !== 'string' || !validSources.has(source)) {
        sendError(res, 400, 'bad_request', `source must be one of: ${[...validSources].join(', ')}`)
        return
      }
    }
    const tm = await import('../../core/task-manager.js')
    try {
      const result = await tm.ensureProject(name, (source as import('../../core/types.js').TaskSource | undefined) ?? 'local')
      res.status(result.created ? 201 : 200).json(result)
    } catch (err) {
      if (await sendProjectError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/projects/:name { name } — rename (merges on collision,
// case-insensitive). REPLICA: 501 — see the header comment.
projectsV1Router.patch('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      sendError(res, 501, 'not_supported_cloud', 'Project rename runs on the primary box only (the registry has no replica write-back channel)')
      return
    }
    const from = String(req.params.name ?? '')
    const { name } = (req.body ?? {}) as { name?: unknown }
    if (typeof name !== 'string' || name.trim() === '') {
      sendError(res, 400, 'bad_request', 'name must be a non-empty string')
      return
    }
    const tm = await import('../../core/task-manager.js')
    try {
      res.json(await tm.renameProject(from, name))
    } catch (err) {
      if (await sendProjectError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/projects/:name[?remote=1] — drop the registry row; tasks fall
// back to Inbox. Provider-claimed projects refuse a plain DELETE (409) because
// the remote container still exists; ?remote=1 opts into the irreversible
// cascade (plugin deletes the remote container, local tasks detach to Inbox).
// REPLICA: 501 — see the header comment.
projectsV1Router.delete('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      sendError(res, 501, 'not_supported_cloud', 'Project delete runs on the primary box only (cascade needs the primary\'s provider plugins)')
      return
    }
    const name = String(req.params.name ?? '')
    if (!name.trim()) {
      sendError(res, 400, 'bad_request', 'Inbox is not a project — nothing to delete')
      return
    }
    const cascade = req.query.remote === '1' || req.query.remote === 'true'
    const tm = await import('../../core/task-manager.js')
    const { registry } = await import('../../core/integration-registry.js')
    try {
      const record = await tm.getProjectRecord(name)
      if (!record) {
        sendError(res, 404, 'not_found', `No project "${name}" found`)
        return
      }
      if (record.source !== 'local' && !cascade) {
        sendError(res, 409, 'conflict',
          `Project "${record.name}" is claimed by ${record.source}. Re-request with ?remote=1 to also delete the remote container (irreversible), or delete the container in the provider's app first.`, {
            project: record.name,
            existing_source: record.source,
            cascade_available: !!registry.get(record.source)?.sync.deleteProjectRemote,
          })
        return
      }
      if (record.source !== 'local') {
        const result = await tm.deleteProjectCascade(record.name)
        res.json({ project: record.name, ...result })
        return
      }
      const result = await tm.deleteProject(record.name)
      res.json({ project: record.name, ...result, remoteDeleted: false, source: 'local' })
    } catch (err) {
      if (await sendProjectError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ─── Ordering (project display order, config-backed) ─────────────────────────

// GET /api/v1/ordering → { projects: [names in display order] }
projectsV1Router.get('/ordering', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    res.json({ projects: config.ordering?.projects ?? [] })
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/ordering/projects { order } — replace the flat project order.
projectsV1Router.put('/ordering/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { order } = (req.body ?? {}) as { order?: unknown }
    if (!Array.isArray(order) || !order.every((p) => typeof p === 'string')) {
      sendError(res, 400, 'bad_request', 'order must be an array of strings')
      return
    }
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (!config.ordering) config.ordering = {}
    config.ordering.projects = order as string[]
    await updateConfig({ ordering: config.ordering })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'ordering' }, ['web-ui'])
    res.json({ projects: config.ordering.projects })
  } catch (err) {
    next(err)
  }
})

// ─── Project favorites (completes the Wave-1 note-favorites pair) ────────────

// POST /api/v1/favorites/projects/:name — add (idempotent, case-insensitive;
// stored under the registry's canonical spelling when the row exists).
projectsV1Router.post('/favorites/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = String(req.params.name ?? '')
    if (!raw.trim()) {
      sendError(res, 400, 'bad_request', 'project name is required')
      return
    }
    // Resolve to the registry's canonical spelling (project identity is
    // case-insensitive); best-effort — a project with no row keeps the
    // caller's spelling.
    let name = raw
    try {
      const { getProjectRecord } = await import('../../core/task-manager.js')
      name = (await getProjectRecord(raw))?.name ?? raw
    } catch { /* registry unavailable — keep the caller's spelling */ }
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    if (!config.favorites.projects) config.favorites.projects = []
    const lower = name.toLowerCase()
    if (!config.favorites.projects.some((p) => p.toLowerCase() === lower)) {
      config.favorites.projects.push(name)
    }
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ projects: config.favorites.projects })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/v1/favorites/projects/:name — remove (case-insensitive).
projectsV1Router.delete('/favorites/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = String(req.params.name ?? '')
    if (!raw.trim()) {
      sendError(res, 400, 'bad_request', 'project name is required')
      return
    }
    const lower = raw.toLowerCase()
    const { getConfig, updateConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    config.favorites.projects = (config.favorites.projects ?? []).filter((p) => p.toLowerCase() !== lower)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ projects: config.favorites.projects })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
projectsV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 projects route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
