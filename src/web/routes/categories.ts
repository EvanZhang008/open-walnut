/**
 * Category routes — rename, list, create, and manage category source.
 * V3: Categories are stored in tasks.json store.categories (first-class citizens).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import {
  renameCategory,
  CategorySourceConflictError,
  listTasks,
  createCategory,
  getStoreCategories,
  updateCategorySource,
  getProjectMetadata,
  setProjectMetadata,
} from '../../core/task-manager.js'
import { getProjectSummary } from '../../core/project-memory.js'
import { bus, EventNames } from '../../core/event-bus.js'
import type { TaskSource } from '../../core/types.js'

export const categoriesRouter = Router()

// GET /api/categories — list all categories with source and task counts
categoriesRouter.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tasks = await listTasks()
    const storeCategories = await getStoreCategories()
    const catMap = new Map<string, { source: TaskSource; todo: number; active: number; done: number }>()

    // Seed from store.categories (includes empty categories)
    for (const [name, record] of Object.entries(storeCategories)) {
      catMap.set(name, { source: record.source, todo: 0, active: 0, done: 0 })
    }

    // Overlay task counts (and add any categories not yet in store)
    for (const t of tasks) {
      if (!catMap.has(t.category)) {
        // Category exists in tasks but not in store — use task's source
        catMap.set(t.category, { source: t.source, todo: 0, active: 0, done: 0 })
      }
      const entry = catMap.get(t.category)!
      if (t.phase === 'TODO') entry.todo++
      else if (t.phase === 'COMPLETE') entry.done++
      else entry.active++
    }

    const result = [...catMap.entries()].map(([name, data]) => ({ name, ...data }))
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/categories — create a new category
categoriesRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, source } = req.body as { name: string; source: string }

    if (typeof name !== 'string' || name.trim() === '') {
      res.status(400).json({ error: 'name must be a non-empty string' })
      return
    }
    if (!source || !['local', 'ms-todo'].includes(source)) {
      res.status(400).json({ error: 'source must be "local" or "ms-todo"' })
      return
    }

    const result = await createCategory(name, source as TaskSource)
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof CategorySourceConflictError) {
      res.status(409).json({
        error: err.message,
        category: err.category,
        intended_source: err.intendedSource,
        existing_source: err.existingSource,
      })
      return
    }
    if (err instanceof Error && err.message.includes('already exists')) {
      res.status(409).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/categories/rename (must be before /:name to avoid matching "rename" as a name)
categoriesRouter.post('/rename', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { oldCategory, newCategory } = req.body as { oldCategory: string; newCategory: string }

    if (typeof oldCategory !== 'string' || oldCategory.trim() === '') {
      res.status(400).json({ error: 'oldCategory must be a non-empty string' })
      return
    }
    if (typeof newCategory !== 'string' || newCategory.trim() === '') {
      res.status(400).json({ error: 'newCategory must be a non-empty string' })
      return
    }

    const result = await renameCategory(oldCategory, newCategory)
    bus.emit(EventNames.TASK_UPDATED, { oldCategory, newCategory, count: result.count }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    if (err instanceof CategorySourceConflictError) {
      res.status(409).json({
        error: err.message,
        category: err.category,
        intended_source: err.intendedSource,
        existing_source: err.existingSource,
      })
      return
    }
    next(err)
  }
})

// GET /api/categories/:name/projects — list projects in a category with metadata + task counts
categoriesRouter.get('/:name/projects', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const categoryName = decodeURIComponent(req.params.name as string)
    const tasks = await listTasks()
    const storeCategories = await getStoreCategories()

    // Determine category source
    const catRecord = storeCategories[categoryName]
    const source = catRecord?.source ?? tasks.find((t) => t.category === categoryName)?.source ?? 'local'

    // Collect projects and task counts (exclude .metadata* tasks)
    const projMap = new Map<string, { todo: number; active: number; done: number }>()
    for (const t of tasks) {
      if (t.category !== categoryName) continue
      if (t.title.startsWith('.metadata')) continue
      const proj = t.project || categoryName
      if (!projMap.has(proj)) projMap.set(proj, { todo: 0, active: 0, done: 0 })
      const entry = projMap.get(proj)!
      if (t.phase === 'TODO') entry.todo++
      else if (t.phase === 'COMPLETE') entry.done++
      else entry.active++
    }

    // Build response with metadata + memory summary for each project
    const projects = await Promise.all(
      [...projMap.entries()].map(async ([name, counts]) => {
        const metadata = await getProjectMetadata(categoryName, name)
        const summary = getProjectSummary(`${categoryName}/${name}`)
        return {
          name,
          metadata: metadata ?? {},
          memorySummary: summary?.description ?? null,
          counts,
        }
      }),
    )

    const totalCounts = { todo: 0, active: 0, done: 0 }
    for (const p of projects) {
      totalCounts.todo += p.counts.todo
      totalCounts.active += p.counts.active
      totalCounts.done += p.counts.done
    }

    res.json({ category: categoryName, source, projects, totalCounts })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/categories/:category/projects/:project/metadata — update project metadata (cwd, host)
categoriesRouter.patch('/:category/projects/:project/metadata', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const category = decodeURIComponent(req.params.category as string)
    const project = decodeURIComponent(req.params.project as string)
    const settings = req.body as Record<string, unknown>

    if (!settings || typeof settings !== 'object') {
      res.status(400).json({ error: 'body must be a JSON object' })
      return
    }

    const result = await setProjectMetadata(category, project, settings)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/categories/:name/source — update category source via store.categories
categoriesRouter.post('/:name/source', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const name = decodeURIComponent(req.params.name as string)
    const { source } = req.body as { source: string }

    if (!source || !['local', 'ms-todo'].includes(source)) {
      res.status(400).json({ error: 'source must be "local" or "ms-todo"' })
      return
    }

    const result = await updateCategorySource(name, source as TaskSource)
    res.json(result)
  } catch (err) {
    if (err instanceof CategorySourceConflictError) {
      res.status(409).json({
        error: err.message,
        category: (err as CategorySourceConflictError).category,
        existing_source: (err as CategorySourceConflictError).existingSource,
      })
      return
    }
    if (err instanceof Error && err.message.includes('does not exist')) {
      res.status(404).json({ error: err.message })
      return
    }
    next(err)
  }
})
