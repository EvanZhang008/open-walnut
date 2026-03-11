/**
 * Browser console log persistence — intercepts console.log/info/warn/error,
 * buffers entries in a ring buffer, and sends them to the backend via WebSocket RPC
 * (with sendBeacon fallback on page unload).
 *
 * Logs are persisted to /tmp/walnut/walnut-YYYY-MM-DD.log with subsystem='browser'.
 * View them with: `walnut logs -s browser`
 *
 * Architecture:
 *   console.log() → monkey-patch (preserves DevTools behavior)
 *     → Ring buffer (max 200 entries, dedup consecutive identical messages)
 *     → Flush every 2s or when 50 entries buffered
 *     → WebSocket RPC 'browser:logs' { entries[] }
 *     → On page unload: sendBeacon POST /api/browser-logs (fallback)
 *
 * Safety:
 *   - Does NOT intercept console.debug (used by WS client — would cause recursion)
 *   - Internal logging uses saved originals, never triggers interception
 *   - All serialization wrapped in try-catch — failures silently skipped
 *   - Ring buffer capped at 200 entries — no unbounded memory growth
 */

import { wsClient } from '../api/ws'

// ── Types ──

interface BrowserLogEntry {
  time: string
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
  args?: string   // remaining args JSON, max 1000 chars
  url?: string    // location.pathname
  count?: number  // dedup count (only present when > 1)
}

// ── Config ──

const MAX_BUFFER = 200
const FLUSH_INTERVAL_MS = 2000
const FLUSH_THRESHOLD = 50
const MAX_MESSAGE_LEN = 2000
const MAX_ARGS_LEN = 1000

// ── State ──

const buffer: BrowserLogEntry[] = []
let flushTimer: ReturnType<typeof setInterval> | null = null
let initialized = false

// Save originals before patching — used internally to avoid recursion
const originals = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
}

// ── Serialization ──

/** Safely convert a single argument to string, handling circular refs, DOM nodes, etc. */
function safeStringify(val: unknown): string {
  if (val === undefined) return 'undefined'
  if (val === null) return 'null'
  if (typeof val === 'string') return val
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (typeof val === 'function') return `[Function: ${val.name || 'anonymous'}]`
  if (val instanceof Error) {
    const stack = val.stack?.slice(0, 500) ?? ''
    return stack || `${val.name}: ${val.message}`
  }

  // DOM nodes
  if (typeof Node !== 'undefined' && val instanceof Node) {
    return (val as Element).outerHTML?.slice(0, 200) ?? val.nodeName
  }

  try {
    const seen = new WeakSet()
    return JSON.stringify(val, (_key, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      if (typeof v === 'function') return `[Function: ${v.name || 'anonymous'}]`
      if (typeof v === 'bigint') return `${v}n`
      return v
    })
  } catch {
    return String(val)
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

// ── Buffer management ──

function addEntry(level: BrowserLogEntry['level'], args: unknown[]): void {
  if (args.length === 0) return

  try {
    const message = truncate(safeStringify(args[0]), MAX_MESSAGE_LEN)
    const extraArgs = args.length > 1
      ? truncate(args.slice(1).map(safeStringify).join(', '), MAX_ARGS_LEN)
      : undefined

    // Dedup: if last entry has same level + message, increment count
    const last = buffer[buffer.length - 1]
    if (last && last.level === level && last.message === message) {
      last.count = (last.count ?? 1) + 1
      return
    }

    const entry: BrowserLogEntry = {
      time: new Date().toISOString(),
      level,
      message,
    }
    if (extraArgs) entry.args = extraArgs
    try { entry.url = location.pathname } catch { /* SSR safety */ }

    // Ring buffer: drop oldest when full
    if (buffer.length >= MAX_BUFFER) {
      buffer.shift()
    }
    buffer.push(entry)

    // Auto-flush when threshold reached
    if (buffer.length >= FLUSH_THRESHOLD) {
      flush()
    }
  } catch {
    // Never throw from the logger interceptor
  }
}

function flush(): void {
  if (buffer.length === 0) return

  // Check WS BEFORE draining — keep entries in buffer if not connected
  // so they survive until next flush when WS may be available.
  if (wsClient.state !== 'connected') return

  const entries = buffer.splice(0, buffer.length)
  // Fire-and-forget — don't await
  wsClient.sendRpc('browser:logs', { entries }).catch(() => {
    // WS send failed — entries are lost (acceptable for debug logs)
  })
}

/** sendBeacon fallback for page unload — best-effort, no response expected */
function beaconFlush(): void {
  if (buffer.length === 0) return
  const entries = buffer.splice(0, buffer.length)
  try {
    const blob = new Blob([JSON.stringify({ entries })], { type: 'application/json' })
    navigator.sendBeacon('/api/browser-logs', blob)
  } catch {
    // Best-effort — page is unloading anyway
  }
}

// ── Monkey-patching ──

function patchConsole(): void {
  const levels: BrowserLogEntry['level'][] = ['log', 'info', 'warn', 'error']

  for (const level of levels) {
    const original = originals[level]
    console[level] = (...args: unknown[]) => {
      // Always call the original so DevTools still works
      original.apply(console, args)
      // Buffer the entry for persistence
      addEntry(level, args)
    }
  }
}

// ── Public API ──

/**
 * Initialize browser console log persistence.
 * Call once before React mount (in main.tsx).
 * Safe to call multiple times — only runs once.
 */
export function initBrowserLogger(): void {
  if (initialized) return
  initialized = true

  patchConsole()

  // Periodic flush
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)

  // Flush on page unload via sendBeacon
  window.addEventListener('beforeunload', beaconFlush)

  // Don't log from here — would trigger our own interceptor and buffer a meta-log.
  // DevTools will show the patched console is active via the normal log output.
}

/**
 * Tear down — restore original console methods (useful for tests).
 */
export function destroyBrowserLogger(): void {
  if (!initialized) return
  initialized = false

  console.log = originals.log
  console.info = originals.info
  console.warn = originals.warn
  console.error = originals.error

  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }

  window.removeEventListener('beforeunload', beaconFlush)
  buffer.length = 0
}
