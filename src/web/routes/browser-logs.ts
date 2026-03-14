/**
 * Browser console log persistence — backend handler.
 *
 * Receives browser console entries via:
 *   1. WebSocket RPC 'browser:logs' (primary, batched)
 *   2. POST /api/browser-logs (sendBeacon fallback on page unload)
 *
 * Writes each entry to the shared log file via writeLogEntry()
 * with subsystem='browser'. View with: `open-walnut logs -s browser`
 *
 * Rate limiting: 500 entries per 10s window per WS client (silent drop).
 */

import { Router } from 'express'
import type { WebSocket } from 'ws'
import { registerMethod } from '../ws/handler.js'
import { log } from '../../logging/index.js'
import { writeLogEntry } from '../../logging/logger.js'
import type { LogLevel } from '../../logging/levels.js'

// ── Types ──

// Keep in sync with web/src/utils/browser-logger.ts:BrowserLogEntry
interface BrowserLogEntry {
  time: string
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
  args?: string
  url?: string
  count?: number
}

// ── Rate limiting ──

const RATE_WINDOW_MS = 10_000
const RATE_LIMIT = 500

const clientRates = new WeakMap<WebSocket, { count: number; windowStart: number }>()

function checkRate(client: WebSocket, entryCount: number): boolean {
  const now = Date.now()
  let state = clientRates.get(client)
  if (!state || now - state.windowStart > RATE_WINDOW_MS) {
    state = { count: 0, windowStart: now }
    clientRates.set(client, state)
  }
  if (state.count + entryCount > RATE_LIMIT) {
    return false // over limit
  }
  state.count += entryCount
  return true
}

// ── Validation & writing ──

/** Map browser log levels to server LogLevel */
function mapLevel(level: string): LogLevel {
  switch (level) {
    case 'error': return 'error'
    case 'warn': return 'warn'
    case 'info': return 'info'
    case 'log':
    default: return 'info'
  }
}

function isValidEntry(e: unknown): e is BrowserLogEntry {
  if (!e || typeof e !== 'object') return false
  const obj = e as Record<string, unknown>
  return typeof obj.time === 'string' && typeof obj.level === 'string' && typeof obj.message === 'string'
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}

function writeEntries(entries: BrowserLogEntry[]): void {
  for (const entry of entries) {
    if (!isValidEntry(entry)) continue

    const meta: Record<string, unknown> = {}
    if (entry.args) meta.args = truncate(entry.args, 1000)
    if (entry.url) meta.url = entry.url
    if (entry.count && entry.count > 1) meta.count = entry.count

    writeLogEntry({
      time: entry.time,
      level: mapLevel(entry.level),
      subsystem: 'browser',
      message: truncate(entry.message, 2000),
      browserLevel: entry.level, // preserve original level (e.g. 'log' vs 'info')
      ...meta,
    })
  }
}

// ── WebSocket RPC handler ──

export function registerBrowserLogsRpc(): void {
  registerMethod('browser:logs', async (payload: unknown, client: WebSocket) => {
    const data = payload as Record<string, unknown>
    if (!Array.isArray(data?.entries)) {
      throw new Error('browser:logs requires entries (array)')
    }

    const entries = data.entries as BrowserLogEntry[]
    if (entries.length === 0) return

    // Rate limit per client
    if (!checkRate(client, entries.length)) {
      log.browser.warn('browser log rate limit exceeded, dropping batch', { count: entries.length })
      return // silent drop
    }

    writeEntries(entries)
    // Fire-and-forget — no meaningful return value
  })
}

// ── REST endpoint (sendBeacon fallback) ──

/** Max entries per single REST request (sendBeacon is for page unload — small batches) */
const REST_MAX_ENTRIES = 100

export const browserLogsRouter = Router()

browserLogsRouter.post('/', (req, res) => {
  try {
    const { entries } = req.body ?? {}
    if (!Array.isArray(entries)) {
      res.status(400).json({ error: 'entries must be an array' })
      return
    }

    // Limit entries per request to prevent abuse
    const capped = entries.length > REST_MAX_ENTRIES ? entries.slice(0, REST_MAX_ENTRIES) : entries
    writeEntries(capped)
    res.status(204).end()
  } catch (err) {
    log.browser.error('browser-logs REST error', { error: String(err) })
    res.status(500).end()
  }
})
