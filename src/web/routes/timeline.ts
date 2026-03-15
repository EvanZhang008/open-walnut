/**
 * Timeline routes — serve Life Tracker data and thumbnail images.
 *
 * GET  /api/timeline?date=YYYY-MM-DD  → parsed timeline from Life Tracker project memory
 * GET  /api/timeline/dates            → list dates with timeline data
 * GET  /api/timeline/images/:date/:file → serve thumbnail JPGs
 * POST /api/timeline/toggle           → enable/disable the Life Tracker cron job
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { TIMELINE_DIR, PROJECTS_MEMORY_DIR } from '../../constants.js'
import { log } from '../../logging/index.js'
import { getCronService } from './cron.js'

export const timelineRouter = Router()

// Memory file path for the Life Tracker agent
const LIFE_TRACKER_MEMORY_PROJECT = 'life/tracker'

// ── Types ──

interface TimelineEntry {
  startTime: string
  endTime: string
  application: string
  category: string
  description: string
}

interface TimelineResponse {
  date: string
  entries: TimelineEntry[]
  summary: Record<string, string>
  tracking: boolean
}

// ── Helpers ──

/**
 * Parse the activity timeline from the Life Tracker's MEMORY.md description.
 * Expected format in the YAML description field (after agent writes it):
 *
 * ## Day Record: YYYY-MM-DD
 * ### Activity Timeline
 * - HH:MM-HH:MM | App | Category | Description
 * ### Summary
 * - Coding: Xh Ym
 */
function parseTimelineFromMemory(content: string): { entries: TimelineEntry[]; summary: Record<string, string> } {
  const entries: TimelineEntry[] = []
  const summary: Record<string, string> = {}

  // Find the Activity Timeline section
  const timelineMatch = content.match(/### Activity Timeline\s*\n([\s\S]*?)(?=###|$)/)
  if (timelineMatch) {
    const lines = timelineMatch[1].trim().split('\n')
    for (const line of lines) {
      // Parse: "- HH:MM-HH:MM | App | Category | Description"
      const match = line.match(/^-\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/)
      if (match) {
        entries.push({
          startTime: match[1],
          endTime: match[2],
          application: match[3].trim(),
          category: match[4].trim().toLowerCase(),
          description: match[5].trim(),
        })
      }
    }
  }

  // Find the Summary section
  const summaryMatch = content.match(/### Summary\s*\n([\s\S]*?)(?=###|$)/)
  if (summaryMatch) {
    const lines = summaryMatch[1].trim().split('\n')
    for (const line of lines) {
      // Parse: "- Coding: 4h 20m"
      const match = line.match(/^-\s+(.+?):\s+(.+)$/)
      if (match) {
        summary[match[1].trim().toLowerCase()] = match[2].trim()
      }
    }
  }

  return { entries, summary }
}

// GET /api/timeline?date=YYYY-MM-DD → timeline data for a specific day
timelineRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10)

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' })
      return
    }

    // Read the Life Tracker's MEMORY.md
    const memFile = path.join(PROJECTS_MEMORY_DIR, LIFE_TRACKER_MEMORY_PROJECT, 'MEMORY.md')
    let memoryContent = ''
    try {
      memoryContent = await fsp.readFile(memFile, 'utf-8')
    } catch (err) {
      log.web.debug('no life tracker memory file yet', { error: err instanceof Error ? err.message : String(err) })
    }

    // Parse the YAML description from MEMORY.md — the agent's working memory
    const descMatch = memoryContent.match(/^---\n[\s\S]*?description:\s*([\s\S]*?)\n---/)
    const description = descMatch ? descMatch[1] : memoryContent

    const { entries, summary } = parseTimelineFromMemory(description || memoryContent)

    // Check if tracking is enabled (look for a matching cron job)
    let tracking = false
    try {
      const cronService = getCronService()
      if (cronService) {
        const jobs = await cronService.list({ includeDisabled: true })
        const trackerJob = jobs.find(
          (j) => j.initProcessor?.actionId === 'screenshot-track',
        )
        tracking = trackerJob?.enabled ?? false
      }
    } catch (err) {
      log.web.debug('cron service not available for tracking status', { error: err instanceof Error ? err.message : String(err) })
    }

    const response: TimelineResponse = { date, entries, summary, tracking }
    res.json(response)
  } catch (err) {
    next(err)
  }
})

// GET /api/timeline/dates → list dates that have thumbnail data
timelineRouter.get('/dates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const dates: string[] = []
    try {
      const entries = await fsp.readdir(TIMELINE_DIR, { withFileTypes: true })
      for (const entry of entries) {
        // Only directories matching YYYY-MM-DD
        if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
          dates.push(entry.name)
        }
      }
    } catch (err) {
      log.web.debug('timeline directory not available', { error: err instanceof Error ? err.message : String(err) })
    }
    dates.sort().reverse()
    res.json({ dates })
  } catch (err) {
    next(err)
  }
})

// GET /api/timeline/images/:date/:file → serve thumbnail JPGs
timelineRouter.get('/images/:date/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const date = String(req.params.date)
    const file = String(req.params.file)

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date' })
      return
    }

    // Only allow JPG files
    if (!file.endsWith('.jpg') && !file.endsWith('.jpeg')) {
      res.status(400).json({ error: 'Only JPEG files allowed' })
      return
    }

    // No directory traversal
    if (file.includes('..') || file.includes('/')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }

    const filePath = path.join(TIMELINE_DIR, date, 'thumbnails', file)

    let stat
    try {
      stat = await fsp.stat(filePath)
    } catch (err) {
      log.web.debug('timeline image not found', { filePath, error: err instanceof Error ? err.message : String(err) })
      res.status(404).json({ error: 'Image not found' })
      return
    }

    if (!stat.isFile()) {
      res.status(400).json({ error: 'Not a file' })
      return
    }

    const buffer = await fsp.readFile(filePath)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    next(err)
  }
})

// POST /api/timeline/toggle → enable/disable the Life Tracker cron job
timelineRouter.post('/toggle', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const cronService = getCronService()
    if (!cronService) {
      res.status(503).json({ error: 'Cron service not available' })
      return
    }

    const jobs = await cronService.list({ includeDisabled: true })
    const trackerJob = jobs.find(
      (j) => j.initProcessor?.actionId === 'screenshot-track',
    )

    if (!trackerJob) {
      res.status(404).json({ error: 'Life Tracker cron job not found. Create one first.' })
      return
    }

    const updated = await cronService.toggle(trackerJob.id)
    res.json({ enabled: updated.enabled, jobId: updated.id })
  } catch (err) {
    next(err)
  }
})
