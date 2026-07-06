/**
 * Memory routes — list and read memory/knowledge files.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response, type NextFunction } from 'express'
import { listMemories, getMemory } from '../../core/memory.js'
import { compactDailyLog, formatDateKey, getDailyLog, estimateTokens } from '../../core/daily-log.js'
import { getMemoryFile } from '../../core/memory-file.js'
import { MEMORY_FILE, USER_FILE, DAILY_DIR, MEMORY_DIR, REPOS_MEMORY_DIR } from '../../constants.js'
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

memoryRouter.get('/browse', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    // Global MEMORY.md
    let global: BrowseItem | null = null
    try {
      const result = getMemoryFile()
      if (result) {
        const stat = await fsp.stat(MEMORY_FILE)
        global = { path: 'MEMORY.md', title: 'Global Memory', updatedAt: stat.mtime.toISOString() }
      }
    } catch { /* no global memory file */ }

    // USER.md — user profile (sits next to MEMORY.md in the Global section)
    let user: BrowseItem | null = null
    try {
      const stat = await fsp.stat(USER_FILE)
      user = { path: 'USER.md', title: 'User Profile', updatedAt: stat.mtime.toISOString() }
    } catch { /* no user profile file */ }

    // Daily logs — reverse chronological
    const daily: BrowseDailyItem[] = []
    try {
      const files = (await fsp.readdir(DAILY_DIR)).filter(f => f.endsWith('.md')).sort().reverse()
      for (const f of files) {
        const stat = await fsp.stat(path.join(DAILY_DIR, f))
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

    // Repo environment memories
    const repos: BrowseItem[] = []
    try {
      const dirs = await fsp.readdir(REPOS_MEMORY_DIR, { withFileTypes: true })
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const memFile = path.join(REPOS_MEMORY_DIR, d.name, 'SKILL.md')
        try {
          const stat = await fsp.stat(memFile)
          repos.push({ path: `repos/${d.name}/SKILL.md`, title: d.name, updatedAt: stat.mtime.toISOString() })
        } catch { /* no MEMORY.md */ }
      }
    } catch { /* REPOS_MEMORY_DIR doesn't exist yet */ }

    // Topic files (Memory v2 — distilled wiki pages)
    const topics: BrowseItem[] = []
    try {
      const topicsDir = path.join(MEMORY_DIR, 'topics')
      const files = (await fsp.readdir(topicsDir)).filter(f => f.endsWith('.md'))
      for (const f of files) {
        const stat = await fsp.stat(path.join(topicsDir, f))
        topics.push({ path: `topics/${f}`, title: f.replace(/\.md$/, ''), updatedAt: stat.mtime.toISOString() })
      }
      topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    } catch { /* no topics dir */ }

    // Compaction snapshots (archived context compactions)
    const compaction: BrowseItem[] = []
    try {
      const compactionDir = path.join(MEMORY_DIR, 'compaction')
      const files = (await fsp.readdir(compactionDir)).filter(f => f.endsWith('.md')).sort().reverse()
      for (const f of files) {
        const stat = await fsp.stat(path.join(compactionDir, f))
        compaction.push({ path: `compaction/${f}`, title: f.replace(/\.md$/, ''), updatedAt: stat.mtime.toISOString() })
      }
    } catch { /* no compaction dir */ }

    // Working memory + index (top-level Memory v2 files)
    const special: BrowseItem[] = []
    for (const name of ['working-memory.md', 'index.md']) {
      try {
        const filePath = path.join(MEMORY_DIR, name)
        const stat = await fsp.stat(filePath)
        special.push({ path: name, title: name === 'working-memory.md' ? 'Working Memory' : 'Memory Index', updatedAt: stat.mtime.toISOString() })
      } catch { /* file not present */ }
    }

    res.json({ tree: { global, user, daily, projects, sessions, knowledge, repos, topics, compaction, special } })
  } catch (err) {
    next(err)
  }
})

// ── Global MEMORY.md dedicated endpoint ──

memoryRouter.get('/global', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const result = getMemoryFile()
    if (!result) {
      res.status(404).json({ error: 'Global MEMORY.md not found' })
      return
    }
    const stat = await fsp.stat(MEMORY_FILE)
    res.json({
      memory: {
        path: 'MEMORY.md',
        title: 'Global Memory',
        category: 'global',
        content: result.content,
        createdAt: stat.birthtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
      },
    })
  } catch (err) {
    next(err)
  }
})

// ── PUT /api/memory/global — write global MEMORY.md ──

memoryRouter.put('/global', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    await fsp.mkdir(path.dirname(MEMORY_FILE), { recursive: true })
    await fsp.writeFile(MEMORY_FILE, content, 'utf-8')
    const stat = await fsp.stat(MEMORY_FILE)
    log.memory.info('Global MEMORY.md updated via browser', { size: content.length })
    res.json({ ok: true, updatedAt: stat.mtime.toISOString() })
  } catch (err) {
    next(err)
  }
})

// GET /api/memory?category=session
// ── USER.md dedicated endpoints (user profile — mirrors /global) ──

memoryRouter.get('/user', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let content: string
    try {
      content = await fsp.readFile(USER_FILE, 'utf-8')
    } catch {
      res.status(404).json({ error: 'USER.md not found' })
      return
    }
    const stat = await fsp.stat(USER_FILE)
    res.json({
      memory: {
        path: 'USER.md',
        title: 'User Profile',
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

memoryRouter.put('/user', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { content } = req.body
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'content (string) is required' })
      return
    }
    await fsp.mkdir(path.dirname(USER_FILE), { recursive: true })
    await fsp.writeFile(USER_FILE, content, 'utf-8')
    const stat = await fsp.stat(USER_FILE)
    log.memory.info('USER.md updated via browser', { size: content.length })
    res.json({ ok: true, updatedAt: stat.mtime.toISOString() })
  } catch (err) {
    next(err)
  }
})

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
    const dailyResult = getDailyLog(dateKey)
    if (!dailyResult) {
      res.status(404).json({ error: `No daily log found for ${dateKey}` })
      return
    }

    const tokens = estimateTokens(dailyResult.content)
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
memoryRouter.use(async (req: Request, res: Response, next: NextFunction) => {
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
    try {
      await fsp.access(resolved)
    } catch {
      res.status(404).json({ error: 'Memory file not found' })
      return
    }
    await fsp.writeFile(resolved, content, 'utf-8')
    const stat = await fsp.stat(resolved)
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
