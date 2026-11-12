/**
 * Favorites routes — manage project/note favorites via config.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { getConfig, updateConfig } from '../../core/config-manager.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { isCompanion, isFollower, isHostReplicaProgram } from '../../core/server-role.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'
import { COPY_AS_OF_HEADER, KIND_NOT_COPIED } from '../../core/replication/kinds/gate.js'
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
 * A replica holds the Mac's favorites in its prefs copy (core/replication/kinds/prefs.ts),
 * never in its own config.yaml (machine-local, no sync carries it). With no copy yet, a
 * host replica answers needs_leader kind_not_copied, never "no favorites"; the companion
 * answers its own config as before the copy existed (a Mac too old to send it).
 * `asOf`: when the copy's rows were the Mac's (the x-walnut-copy-as-of header), null off a copy.
 */
export async function readFavoritesAsOf(): Promise<{ favorites: Favorites; asOf: number | null }> {
  const { favorites, asOf } = await readUserFavorites()
  // A test run reads the user's favorites with its own changes on top (test-run-prefs.ts).
  return { favorites: withTestRunFavorites(favorites), asOf }
}

export async function readFavorites(): Promise<Favorites> {
  return (await readFavoritesAsOf()).favorites
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
    const now = withTestRunFavorites((await readUserFavorites()).favorites)
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
  // A replica's favorites are the Mac's copy: a change made here waits for the Mac.
  if (isFollower()) throw new NeedsLeaderError('prefs_writes_need_mac')
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

async function readUserFavorites(): Promise<{ favorites: Favorites; asOf: number | null }> {
  const gate = await import('../../core/replication/kinds/gate.js')
  // Turned off for this replica (Settings): the Mac's favorites alone, never this box's config.
  await gate.assertCopyKept('prefs')
  if (gate.keepsCopies('prefs')) {
    const asOf = await gate.copyKindAsOf('prefs')
    // The companion's copy counts once a round landed; a host replica's copy file is the copy.
    const fav = isHostReplicaProgram() || asOf !== null ? await (await import('../../core/replication/kinds/prefs.js')).readFavoritesCopy() : null
    if (fav) return { favorites: { projects: fav.projects ?? [], notes: fav.notes ?? [] }, asOf }
    if (isHostReplicaProgram()) throw new NeedsLeaderError(KIND_NOT_COPIED)
  }
  const config = await getConfig()
  return { favorites: { projects: config.favorites?.projects ?? [], notes: config.favorites?.notes ?? [] }, asOf: null }
}

/**
 * A console write on a replica: the Mac's favorites, so it is the Mac's to make. The companion
 * carries it to the Mac's phone twin (same write, same answer) over its bridge; a host replica's
 * front already forwards it while the Mac answers, so here it only waits (needs_leader).
 * A test run's write stays its own (editFavorites).
 */
favoritesRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' || req.method === 'HEAD' || !isFollower() || ambientTestRun()) return next()
  if (!isCompanion()) return next(new NeedsLeaderError('prefs_writes_need_mac'))
  writeOnMac(req, res).catch(next)
})

/** One bridge frame carries the write: a body larger than this is refused, never sent. */
const MAX_RELAYED_BYTES = 64 * 1024

async function writeOnMac(req: Request, res: Response): Promise<void> {
  const body = req.body && typeof req.body === 'object' && Object.keys(req.body).length ? Buffer.from(JSON.stringify(req.body), 'utf8') : null
  if (body && body.byteLength > MAX_RELAYED_BYTES) { res.status(413).json({ error: 'favorites change too large to send to the Mac' }); return }
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const r = await callPrimaryControl('server.http', '__server__', {
    method: req.method,
    url: req.originalUrl.replace(/^\/api\/favorites/, '/api/v1/favorites'),
    headers: body ? { 'content-type': 'application/json' } : {},
    timeoutMs: 13_000,
    ...(body ? { data: body.toString('base64'), size: body.byteLength } : {}),
  }, 15_000)
  if (!r.ok) {
    // Went out and got no answer: the Mac may hold it already, so the client must not retry blindly.
    // A 504 the relay answered (the Mac's own route ran past its time) is the same unanswered write.
    if ((r.failure.kind === 'bridge_offline' && !r.failure.notSent) || (r.failure.kind === 'error' && r.failure.status === 504)) {
      res.status(504).json({ error: { code: 'primary_timeout', sent: true, message: 'Your Mac did not answer in time. It may have applied this change: check before you try again.' } })
      return
    }
    // The relay answered with its own error: pass it on as it is, never as "wait for the Mac".
    if (r.failure.kind === 'error') {
      res.status(r.failure.status).json({ error: { code: r.failure.code, message: r.failure.message } })
      return
    }
    // Never sent, or the Mac is too old for the relay: nothing was applied, so the client may retry.
    throw new NeedsLeaderError('prefs_writes_need_mac')
  }
  const out = r.result as { status?: unknown; data?: unknown }
  const status = typeof out.status === 'number' && out.status >= 100 && out.status < 600 ? out.status : 502
  res.status(status).type('application/json').setHeader('X-Walnut-Answered-By', 'primary')
  res.end(typeof out.data === 'string' ? Buffer.from(out.data, 'base64') : Buffer.alloc(0))
}

// GET /api/favorites
favoritesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { favorites, asOf } = await readFavoritesAsOf()
    if (asOf !== null) res.setHeader(COPY_AS_OF_HEADER, String(asOf))
    res.json(favorites)
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
