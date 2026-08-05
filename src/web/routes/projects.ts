/**
 * Project routes — the single grouping layer (`task_projects` registry).
 *
 * A project is identified case-insensitively, carries at most ONE provider
 * claim (`source`), and owns its settings in the registry row's `metadata`
 * blob (default_cwd, default_host, summary, remote_list, …).
 *
 * Inbox is the ABSENCE of a project ('' / null on the task). It has no registry
 * row, so it is never listed here, never renamable, and never claimable — its
 * task counts ride along on GET / as a separate `inbox` field.
 *
 * Express 5 ALREADY percent-decodes route params, so `req.params.name` is the
 * literal project name. Do NOT wrap it in decodeURIComponent(): a name with a
 * literal '%' (e.g. "50% done") double-decodes and throws URIError → 500.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  ensureProject,
  renameProject,
  deleteProject,
  listTasksSlim,
  getStoreProjects,
  getProjectRecord,
  getProjectMetadata,
  setProjectMetadata,
  ProjectSourceConflictError,
  InvalidProjectNameError,
} from '../../core/task-manager.js'
import { getProjectSummary } from '../../core/project-memory.js'
import { getConfig } from '../../core/config-manager.js'
import { registry } from '../../core/integration-registry.js'
import type { TaskSource } from '../../core/types.js'

export const projectsRouter = Router()

interface Counts { todo: number; active: number; done: number }

function emptyCounts(): Counts {
  return { todo: 0, active: 0, done: 0 }
}

function tally(counts: Counts, phase: string): void {
  if (phase === 'TODO') counts.todo++
  else if (phase === 'COMPLETE') counts.done++
  else counts.active++
}

/** 409 body for a project claim conflict. */
function conflictBody(err: ProjectSourceConflictError) {
  return {
    error: err.message,
    project: err.project,
    intended_source: err.intendedSource,
    existing_source: err.existingSource,
  }
}

/** Per-project + Inbox task counts, computed in one pass over the slim list. */
async function collectCounts(): Promise<{ byProject: Map<string, Counts>; inbox: Counts }> {
  // minimal projection: this endpoint only needs project/phase/title.
  const tasks = await listTasksSlim({ minimal: true })
  const byProject = new Map<string, Counts>()
  const inbox = emptyCounts()
  for (const t of tasks) {
    if (t.title.startsWith('.metadata')) continue
    const project = (t.project || '').trim()
    if (!project) { tally(inbox, t.phase); continue }
    const key = project.toLowerCase()
    let entry = byProject.get(key)
    if (!entry) { entry = emptyCounts(); byProject.set(key, entry) }
    tally(entry, t.phase)
  }
  return { byProject, inbox }
}

// GET /api/projects — registry rows + task counts + favorite flag, plus Inbox counts.
// Envelope (NOT a bare array — Inbox has no registry row and needs its own slot):
//   { projects: [{ name, source, order_index?, metadata?, favorite, counts }], inbox: { counts } }
projectsRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [storeProjects, { byProject, inbox }, config] = await Promise.all([
      getStoreProjects(),
      collectCounts(),
      getConfig(),
    ])
    const favorites = new Set((config.favorites?.projects ?? []).map((p) => p.toLowerCase()))

    const projects = Object.entries(storeProjects).map(([name, record]) => ({
      name,
      source: record.source,
      ...(record.order_index !== undefined ? { order_index: record.order_index } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      favorite: favorites.has(name.toLowerCase()),
      counts: byProject.get(name.toLowerCase()) ?? emptyCounts(),
    }))

    res.json({ projects, inbox: { counts: inbox } })
  } catch (err) {
    next(err)
  }
})

// POST /api/projects — create a project registry row { name, source? }.
// IDEMPOTENT (ensureProject): re-posting an existing name is a 200 with
// created:false and the EXISTING row's source — a second caller can never
// steal a claim.
projectsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, source } = req.body as { name?: unknown; source?: unknown }

    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name must be a non-empty string' })
      return
    }
    if (source !== undefined) {
      // Any registered plugin id (plus 'local') is valid — no hardcoded list, so
      // an installed third-party plugin can claim a project.
      const validSources = new Set(['local', ...registry.getAll().map((p) => p.id)])
      if (typeof source !== 'string' || !validSources.has(source)) {
        res.status(400).json({ error: `source must be one of: ${[...validSources].join(', ')}` })
        return
      }
    }

    const result = await ensureProject(name, (source as TaskSource | undefined) ?? 'local')
    res.status(result.created ? 201 : 200).json(result)
  } catch (err) {
    if (err instanceof ProjectSourceConflictError) {
      res.status(409).json(conflictBody(err))
      return
    }
    // Bad NAME SHAPE (path separators, '..', NUL, leading '.') is a client error.
    if (err instanceof InvalidProjectNameError) {
      res.status(400).json({ error: err.message, project: err.project })
      return
    }
    next(err)
  }
})

// PATCH /api/projects/:name — rename (merges on collision, case-insensitive).
projectsRouter.patch('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const from = req.params.name as string
    const { name } = req.body as { name?: unknown }

    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name must be a non-empty string' })
      return
    }

    const result = await renameProject(from, name)
    res.json(result)
  } catch (err) {
    if (err instanceof ProjectSourceConflictError) {
      res.status(409).json(conflictBody(err))
      return
    }
    if (err instanceof InvalidProjectNameError) {
      res.status(400).json({ error: err.message, project: err.project })
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (/^No project /.test(msg)) {
      res.status(404).json({ error: msg })
      return
    }
    if (msg.includes('mixed sources')) {
      res.status(409).json({ error: msg })
      return
    }
    next(err)
  }
})

// DELETE /api/projects/:name — drop the registry row; its tasks fall back to
// Inbox (project ''). Refused for a provider-claimed project: the remote list
// still exists, so silently orphaning its tasks into Inbox would desync the
// twin. Unclaim/rename it in the plugin first.
//
// The move + row removal MUST be one transaction (a half-applied delete leaves
// tasks pointing at a project with no row), which only the storage layer can do,
// hence core's deleteProject:
//   deleteProject(project: string): Promise<{ movedToInbox: number }>
//   — case-insensitive; clears `project` on every matching task, deletes the
//     task_projects row, emits TASK_UPDATED {task:null, taskIds, oldProject,
//     newProject:''}; throws /^No project /  when the name is unknown.
projectsRouter.delete('/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.params.name as string
    if (!name.trim()) {
      res.status(400).json({ error: 'Inbox is not a project — nothing to delete' })
      return
    }
    const record = await getProjectRecord(name)
    if (!record) {
      res.status(404).json({ error: `No project "${name}" found` })
      return
    }
    if (record.source !== 'local') {
      res.status(409).json({
        error: `Project "${record.name}" is claimed by ${record.source}. Remove the claim in that integration before deleting it.`,
        project: record.name,
        existing_source: record.source,
      })
      return
    }

    const result = await deleteProject(record.name)
    res.json({ project: record.name, ...result })
  } catch (err) {
    next(err)
  }
})

// GET /api/projects/:name/metadata — everything the project detail pane needs
// in one call: registry settings, memory summary, task counts, claim.
projectsRouter.get('/:name/metadata', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.params.name as string
    if (!name.trim()) {
      res.status(400).json({ error: 'Inbox has no project settings' })
      return
    }
    const record = await getProjectRecord(name)
    const canonical = record?.name ?? name
    const { byProject } = await collectCounts()
    res.json({
      name: canonical,
      source: record?.source ?? 'local',
      metadata: record?.metadata ?? {},
      // MEMORY.md header for memory/projects/<project>/ — a FLAT one-segment
      // path (memory-dir-migration flattened the old two-segment layout).
      memorySummary: getProjectSummary(canonical)?.description ?? null,
      counts: byProject.get(canonical.toLowerCase()) ?? emptyCounts(),
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/projects/:name/metadata — MERGE settings into the registry row
// (default_cwd / default_host / …). Creates the row when absent. Returns the
// merged blob.
//
// A field is cleared by sending it as JSON `null` — NOT `undefined`, which
// JSON.stringify drops client-side so the field never reaches the server (the
// old value merged straight back and the clear looked like a self-revert).
// `null` is normalized to `undefined` here because the merge is a spread: a key
// whose value is undefined disappears on serialization, which is exactly
// delete-key semantics, whereas a stored literal `null` would linger as a
// falsy-but-present setting.
projectsRouter.put('/:name/metadata', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.params.name as string
    const settings = req.body as Record<string, unknown>

    if (!name.trim()) {
      res.status(400).json({ error: 'Inbox has no project settings' })
      return
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      res.status(400).json({ error: 'body must be a JSON object' })
      return
    }

    const normalized: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(settings)) {
      normalized[key] = value === null ? undefined : value
    }

    const result = await setProjectMetadata(name, normalized)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/projects/:name/summary/regenerate — rebuild the fast-model project
// summary on demand (backfill for pre-existing projects; the automatic path is
// the task-count thresholds in project-summary.ts).
projectsRouter.post('/:name/summary/regenerate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = req.params.name as string
    if (!name.trim()) {
      res.status(400).json({ error: 'Inbox has no AI summary' })
      return
    }
    const { refreshProjectSummary } = await import('../../core/project-summary.js')
    const ok = await refreshProjectSummary(name)
    if (!ok) {
      res.status(422).json({ error: 'summary generation produced nothing (no tasks, or model unavailable)' })
      return
    }
    const metadata = await getProjectMetadata(name)
    res.json({
      summary: metadata?.summary ?? null,
      summary_task_count: metadata?.summary_task_count ?? null,
    })
  } catch (err) {
    next(err)
  }
})
