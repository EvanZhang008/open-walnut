/**
 * Favorites routes — manage project/note favorites via config.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'

// Express 5 ALREADY percent-decodes route params. Do NOT re-decode
// `req.params.name`: a project name with a literal '%' double-decodes and
// throws URIError → 500.
export const favoritesRouter = Router()

/**
 * Project identity is case-INSENSITIVE (task_projects is NOCASE), so favorites
 * must compare that way too — otherwise favoriting "HomeLab" leaves a task on
 * "homelab" unstarred and the toggle appears dead. Resolve to the registry's
 * canonical spelling on add so the stored string matches what the UI renders.
 * The registry lookup is best-effort: a project with no row yet (or an
 * unavailable task DB) falls back to the caller's spelling.
 */
async function canonicalProjectName(name: string): Promise<string> {
  try {
    const { getProjectRecord } = await import('../../core/task-manager.js')
    const record = await getProjectRecord(name)
    return record?.name ?? name
  } catch {
    return name
  }
}

// GET /api/favorites
favoritesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await getConfig()
    res.json({
      projects: config.favorites?.projects ?? [],
      notes: config.favorites?.notes ?? [],
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/favorites/projects/:name — add project favorite
favoritesRouter.post('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = await canonicalProjectName(req.params.name as string)
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

// DELETE /api/favorites/projects/:name — remove project favorite
favoritesRouter.delete('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lower = (req.params.name as string).toLowerCase()
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

// Note favorites carry the vault-relative path (slashes + .md) in the request BODY
// rather than a URL param, since path-encoding slash-bearing names is fragile.

// POST /api/favorites/notes — add note favorite { path }
favoritesRouter.post('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = req.body?.path
    if (typeof path !== 'string' || !path) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    if (!config.favorites.notes) config.favorites.notes = []
    if (!config.favorites.notes.includes(path)) {
      config.favorites.notes.push(path)
    }
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ notes: config.favorites.notes })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/favorites/notes — remove note favorite { path } (or ?path=)
favoritesRouter.delete('/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const path = (req.body?.path ?? req.query.path) as unknown
    if (typeof path !== 'string' || !path) {
      res.status(400).json({ error: 'path is required' })
      return
    }
    const config = await getConfig()
    if (!config.favorites) config.favorites = {}
    config.favorites.notes = (config.favorites.notes ?? []).filter((p) => p !== path)
    await updateConfig({ favorites: config.favorites })
    bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
    res.json({ notes: config.favorites.notes })
  } catch (err) {
    next(err)
  }
})
