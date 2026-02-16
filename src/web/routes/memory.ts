/**
 * Memory routes — list and read memory/knowledge files.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { listMemories, getMemory } from '../../core/memory.js'
import { compactDailyLog, formatDateKey, getDailyLog, estimateTokens } from '../../core/daily-log.js'
import { getMemoryFile } from '../../core/memory-file.js'
import { MEMORY_FILE, DAILY_DIR, MEMORY_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'

export const memoryRouter = Router()

// ── Browse endpoint — lightweight tree of all memory sources (metadata only) ──

interface BrowseItem {
  path: string
  title: string
  updatedAt: string
}

interface BrowseDailyItem extends BrowseItem {
  date: string
}

memoryRouter.get('/browse', (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Global MEMORY.md
    let global: BrowseItem | null = null
    try {
      const content = getMemoryFile()
      if (content) {
        const stat = fs.statSync(MEMORY_FILE)
        global = { path: 'MEMORY.md', title: 'Global Memory', updatedAt: stat.mtime.toISOString() }
      }
    } catch { /* no global memory file */ }

    // Daily logs — reverse chronological
    const daily: BrowseDailyItem[] = []
    try {
      const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.md')).sort().reverse()
      for (const f of files) {
        const stat = fs.statSync(path.join(DAILY_DIR, f))
        const date = f.replace(/\.md$/, '')
        daily.push({ path: `daily/${f}`, title: date, date, updatedAt: stat.mtime.toISOString() })
      }
    } catch { /* no daily dir */ }

    // Projects, Sessions, Knowledge — reuse listMemories but strip content
    const projects: BrowseItem[] = []
    const sessions: BrowseItem[] = []
    const knowledge: BrowseItem[] = []

    for (const category of ['project', 'session', 'knowledge'] as const) {
      const entries = listMemories(category)
      const target = category === 'project' ? projects : category === 'session' ? sessions : knowledge
      for (const e of entries) {
        target.push({ path: e.path, title: e.title, updatedAt: e.updatedAt })
      }
    }

    // Sort sessions by updatedAt desc
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    res.json({ tree: { global, daily, projects, sessions, knowledge } })
  } catch (err) {
    next(err)
  }
})

// ── Global MEMORY.md dedicated endpoint ──

memoryRouter.get('/global', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const content = getMemoryFile()
    if (!content) {
      res.status(404).json({ error: 'Global MEMORY.md not found' })
      return
    }
    const stat = fs.statSync(MEMORY_FILE)
    res.json({
      memory: {
        path: 'MEMORY.md',
        title: 'Global Memory',
        category: 'global',
        content,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── PUT /api/memory/global — write global MEMORY.md ──

memoryRouter.put('/global', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true })
    fs.writeFileSync(MEMORY_FILE, content, 'utf-8')
    const stat = fs.statSync(MEMORY_FILE)
    log.memory.info('Global MEMORY.md updated via browser', { size: content.length })
    res.json({ ok: true, updatedAt: stat.mtime.toISOString() })
  } catch (err) {
    next(err)
  }
})

// GET /api/memory?category=session
memoryRouter.get('/', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const category = _req.query.category as string | undefined
    const memories = listMemories(category)
    res.json({ memories })
  } catch (err) {
    next(err)
  }
})

// POST /api/memory/daily-log/compact — manually trigger daily log compaction
memoryRouter.post('/daily-log/compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dateKey = (req.body?.date as string) || formatDateKey()

    // Check if the file exists and report current size
    const content = getDailyLog(dateKey)
    if (!content) {
      res.status(404).json({ error: `No daily log found for ${dateKey}` })
      return
    }

    const tokens = estimateTokens(content)
    const threshold = (req.body?.threshold as number) || 8000

    if (tokens < threshold) {
      res.json({
        compacted: false,
        reason: `${tokens} tokens < ${threshold} threshold`,
        dateKey,
        tokens,
      })
      return
    }

    // Use a simple extractive summarizer (no LLM) for the REST endpoint.
    // For LLM-powered compaction, use the chat compaction path which has
    // access to the model. This endpoint provides a manual override.
    const summarizer = req.body?.summarizer === 'extract'
      ? async (c: string) => {
          // Simple extractive: keep headings and first line of each entry
          const lines = c.split('\n')
          const kept: string[] = []
          for (const line of lines) {
            if (line.startsWith('# ') || line.startsWith('## ')) {
              kept.push(line)
            }
          }
          return kept.join('\n')
        }
      : undefined

    if (!summarizer) {
      res.status(400).json({
        error: 'Summarizer required. Use { "summarizer": "extract" } for heading-only extraction, or trigger via /compact chat command for LLM-powered compaction.',
        dateKey,
        tokens,
        threshold,
      })
      return
    }

    const compacted = await compactDailyLog(dateKey, threshold, summarizer)

    log.memory.info('Daily log manual compaction', { dateKey, compacted, tokensBefore: tokens })

    res.json({
      compacted,
      dateKey,
      tokensBefore: tokens,
    })
  } catch (err) {
    next(err)
  }
})

// PUT /api/memory/* — write a memory file by path
memoryRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'PUT' || req.path === '/' || req.path === '/global') return next()
  try {
    const memPath = req.path.startsWith('/') ? req.path.slice(1) : req.path
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    // Resolve to actual file path within memory directory
    const fullPath = path.join(MEMORY_DIR, memPath)
    // Safety: ensure resolved path is within MEMORY_DIR
    const resolved = path.resolve(fullPath)
    if (!resolved.startsWith(path.resolve(MEMORY_DIR))) {
      res.status(403).json({ error: 'Path traversal not allowed' })
      return
    }
    if (!fs.existsSync(resolved)) {
      res.status(404).json({ error: 'Memory file not found' })
      return
    }
    fs.writeFileSync(resolved, content, 'utf-8')
    const stat = fs.statSync(resolved)
    log.memory.info('Memory file updated via browser', { path: memPath, size: content.length })
    res.json({ ok: true, updatedAt: stat.mtime.toISOString() })
  } catch (err) {
    next(err)
  }
})

// GET /api/memory/* — wildcard path for nested memory files
// Use middleware to handle wildcard since Express 5 path-to-regexp syntax varies by version
memoryRouter.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method !== 'GET' || req.path === '/') return next('router')
  try {
    const memPath = req.path.startsWith('/') ? req.path.slice(1) : req.path
    const entry = getMemory(memPath)
    if (!entry) {
      res.status(404).json({ error: 'Memory entry not found' })
      return
    }
    res.json({ memory: entry })
  } catch (err) {
    next(err)
  }
})
