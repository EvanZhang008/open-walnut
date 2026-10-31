/**
 * Favorites routes — manage project/note favorites via config.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { isHostReplicaProgram } from '../../core/server-role.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'
import { KIND_NOT_COPIED } from '../../core/replication/kinds/gate.js'
import { testRunPrefsRead, testRunPrefsWrite } from '../../core/test-run-prefs.js'
import { ambientTestRun } from '../../core/test-run.js'

// Express 5 ALREADY percent-decodes route params. Do NOT re-decode
// `req.params.name`: a project name with a literal '%' double-decodes and
// throws URIError → 500.
export const favoritesRouter = Router()

/**
 * Project identity is case-INSENSITIVE (task_projects is NOCASE), so favorites
 * must compare that way too — otherwise favoriting "HomeLab" leaves a task on
 * "homelab" unfavorited and the toggle appears dead. Resolve to the registry's
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

/**
 * The favorites a GET answers (this route and the phone's GET /api/v1/favorites).
 * A host replica holds the Mac's favorites in its prefs copy
 * (core/replication/kinds/prefs.ts); with no copy yet (or the host turned it
 * off) it answers needs_leader kind_not_copied, never "no favorites".
 */
export async function readFavorites(): Promise<Favorites> {
  // A test run reads the user's favorites with its own changes on top (test-run-prefs.ts).
  return withTestRunFavorites(await readUserFavorites())
}

interface Favorites { projects: string[]; notes: string[] }

/** A test run's changes: a project (by lowercased name) added under its name, or removed (null); a note added or removed. */
interface FavoritesChanges { projects: Map<string, string | null>; notes: Map<string, boolean> }

/** `f` with the current test run's changes on top (as is for a real request). */
export function withTestRunFavorites(f: Favorites): Favorites {
  const own = testRunPrefsRead<FavoritesChanges>('favorites')
  if (!own) return f
  const projects = f.projects.filter((p) => own.projects.get(p.toLowerCase()) !== null)
  for (const [lower, name] of own.projects) if (name && !projects.some((p) => p.toLowerCase() === lower)) projects.push(name)
  const notes = f.notes.filter((n) => own.notes.get(n) !== false)
  for (const [n, on] of own.notes) if (on && !notes.includes(n)) notes.push(n)
  return { projects, notes }
}

/** Apply `edit` to the favorites this request writes: a test run's changes, else config.yaml. */
export async function editFavorites(edit: (f: Favorites) => void): Promise<Favorites> {
  if (ambientTestRun()) {
    const now = withTestRunFavorites(await readUserFavorites())
    const next: Favorites = { projects: [...now.projects], notes: [...now.notes] }
    edit(next)
    const own = testRunPrefsWrite<FavoritesChanges>('favorites', () => ({ projects: new Map(), notes: new Map() }))!
    const lower = (list: string[]) => new Set(list.map((p) => p.toLowerCase()))
    const had = lower(now.projects)
    const has = lower(next.projects)
    for (const p of now.projects) if (!has.has(p.toLowerCase())) own.projects.set(p.toLowerCase(), null)
    for (const p of next.projects) if (!had.has(p.toLowerCase())) own.projects.set(p.toLowerCase(), p)
    for (const n of now.notes) if (!next.notes.includes(n)) own.notes.set(n, false)
    for (const n of next.notes) if (!now.notes.includes(n)) own.notes.set(n, true)
    return next
  }
  const config = await getConfig()
  if (!config.favorites) config.favorites = {}
  const f: Favorites = { projects: [...(config.favorites.projects ?? [])], notes: [...(config.favorites.notes ?? [])] }
  edit(f)
  if (config.favorites.projects || f.projects.length) config.favorites.projects = f.projects
  if (config.favorites.notes || f.notes.length) config.favorites.notes = f.notes
  await updateConfig({ favorites: config.favorites })
  bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui'])
  return f
}

async function readUserFavorites(): Promise<Favorites> {
  // Turned off for this replica (Settings): the Mac's favorites alone, never this box's config.
  await (await import('../../core/replication/kinds/gate.js')).assertCopyKept('prefs')
  if (isHostReplicaProgram()) {
    const fav = await (await import('../../core/replication/kinds/prefs.js')).readFavoritesCopy()
    if (!fav) throw new NeedsLeaderError(KIND_NOT_COPIED)
    return { projects: fav.projects ?? [], notes: fav.notes ?? [] }
  }
  const config = await getConfig()
  return { projects: config.favorites?.projects ?? [], notes: config.favorites?.notes ?? [] }
}

// A host replica's favorites are the Mac's copy: every change waits for the Mac.
favoritesRouter.use((req: Request, _res: Response, next: NextFunction) => {
  if (isHostReplicaProgram() && req.method !== 'GET' && req.method !== 'HEAD') return next(new NeedsLeaderError('prefs_writes_need_mac'))
  next()
})

// GET /api/favorites
favoritesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await readFavorites())
  } catch (err) {
    next(err)
  }
})

// POST /api/favorites/projects/:name — add project favorite
favoritesRouter.post('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = await canonicalProjectName(req.params.name as string)
    const lower = name.toLowerCase()
    const f = await editFavorites((f) => {
      if (!f.projects.some((p) => p.toLowerCase() === lower)) f.projects.push(name)
    })
    res.json({ projects: f.projects })
  } catch (err) {
    next(err)
  }
})

// DELETE /api/favorites/projects/:name — remove project favorite
favoritesRouter.delete('/projects/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const lower = (req.params.name as string).toLowerCase()
    const f = await editFavorites((f) => { f.projects = f.projects.filter((p) => p.toLowerCase() !== lower) })
    res.json({ projects: f.projects })
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
    const f = await editFavorites((f) => { if (!f.notes.includes(path)) f.notes.push(path) })
    res.json({ notes: f.notes })
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
    const f = await editFavorites((f) => { f.notes = f.notes.filter((p) => p !== path) })
    res.json({ notes: f.notes })
  } catch (err) {
    next(err)
  }
})
