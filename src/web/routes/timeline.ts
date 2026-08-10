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
      // Leading whitespace is tolerated: this content comes from a YAML block
      // scalar, so every line after the first keeps the block's indentation.
      const match = line.match(/^\s*-\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/)
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
      // Parse: "- Coding: 4h 20m" (leading whitespace tolerated, see above)
      const match = line.match(/^\s*-\s+(.+?):\s+(.+)$/)
      if (match) {
        summary[match[1].trim().toLowerCase()] = match[2].trim()
      }
    }
  }

  return { entries, summary }
}

/** Test-only export of the parser above, so the write→render contract can be
 *  asserted without booting the HTTP server. */
export const __parseTimelineFromMemoryForTest = parseTimelineFromMemory

/** Typed error so both route shells (internal + /api/v1) map statuses identically. */
export class TimelineOpError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message)
    this.name = 'TimelineOpError'
  }
}

/** Build the timeline payload for one day (shared by /api and /api/v1). */
export async function getTimelineForDate(rawDate: unknown): Promise<TimelineResponse> {
  const date = typeof rawDate === 'string' && rawDate ? rawDate : new Date().toISOString().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new TimelineOpError('Invalid date format. Use YYYY-MM-DD.', 400)
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

  return { date, entries, summary, tracking }
}

/** List dates with thumbnail data, newest first (shared by /api and /api/v1). */
export async function listTimelineDates(): Promise<{ dates: string[] }> {
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
  return { dates }
}

/** Read one thumbnail JPG (validated). Shared by /api and /api/v1. */
export async function readTimelineImage(rawDate: unknown, rawFile: unknown): Promise<Buffer> {
  const date = String(rawDate)
  const file = String(rawFile)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TimelineOpError('Invalid date', 400)
  // Only allow JPG files
  if (!file.endsWith('.jpg') && !file.endsWith('.jpeg')) throw new TimelineOpError('Only JPEG files allowed', 400)
  // No directory traversal
  if (file.includes('..') || file.includes('/')) throw new TimelineOpError('Invalid path', 400)

  const filePath = path.join(TIMELINE_DIR, date, 'thumbnails', file)
  let stat
  try {
    stat = await fsp.stat(filePath)
  } catch (err) {
    log.web.debug('timeline image not found', { filePath, error: err instanceof Error ? err.message : String(err) })
    throw new TimelineOpError('Image not found', 404)
  }
  if (!stat.isFile()) throw new TimelineOpError('Not a file', 400)
  return await fsp.readFile(filePath)
}

/** Enable/disable the Life Tracker cron job. Shared by /api and /api/v1. */
export async function toggleLifeTracker(): Promise<{ enabled: boolean; jobId: string }> {
  const cronService = getCronService()
  if (!cronService) throw new TimelineOpError('Cron service not available', 503)

  const jobs = await cronService.list({ includeDisabled: true })
  const trackerJob = jobs.find(
    (j) => j.initProcessor?.actionId === 'screenshot-track',
  )
  if (!trackerJob) throw new TimelineOpError('Life Tracker cron job not found. Create one first.', 404)

  const updated = await cronService.toggle(trackerJob.id)
  return { enabled: updated.enabled, jobId: updated.id }
}

// GET /api/timeline?date=YYYY-MM-DD → timeline data for a specific day
timelineRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getTimelineForDate(req.query.date))
  } catch (err) {
    if (err instanceof TimelineOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// GET /api/timeline/dates → list dates that have thumbnail data
timelineRouter.get('/dates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await listTimelineDates())
  } catch (err) {
    next(err)
  }
})

// GET /api/timeline/images/:date/:file → serve thumbnail JPGs
timelineRouter.get('/images/:date/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const buffer = await readTimelineImage(req.params.date, req.params.file)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=86400')
    res.setHeader('Content-Length', buffer.length)
    res.send(buffer)
  } catch (err) {
    if (err instanceof TimelineOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

// POST /api/timeline/toggle → enable/disable the Life Tracker cron job
timelineRouter.post('/toggle', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await toggleLifeTracker())
  } catch (err) {
    if (err instanceof TimelineOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})
