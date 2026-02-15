/**
 * In-memory per-session streaming buffer.
 *
 * Accumulates streaming blocks (text deltas, tool uses, tool results) for each
 * active session. When a frontend client subscribes to a session, it receives
 * a snapshot of the current buffer so it can catch up on missed output.
 *
 * Buffers are cleared shortly after session:result / session:error.
 */

import { log } from '../logging/index.js'

// ── Types (mirror the frontend StreamingBlock types) ──

export interface StreamingTextBlock {
  type: 'text'
  content: string
}

export interface StreamingToolCallBlock {
  type: 'tool_call'
  toolUseId: string
  name: string
  input?: Record<string, unknown>
  result?: string
  status: 'calling' | 'done'
  planContent?: string
  /** Non-null when this tool call belongs to a subagent Task */
  parentToolUseId?: string
}

export interface StreamingSystemBlock {
  type: 'system'
  variant: 'compact' | 'error' | 'info'
  message: string
  detail?: string
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock

export interface StreamSnapshot {
  blocks: StreamingBlock[]
  isStreaming: boolean
}

// ── Buffer implementation ──

const PRUNE_INTERVAL_MS = 5 * 60_000  // check every 5 min
const STALE_THRESHOLD_MS = 10 * 60_000 // prune after 10 min idle

interface BufferEntry {
  blocks: StreamingBlock[]
  /** Full accumulated text for the current text run (used to reconstruct streamBuffer on snapshot) */
  textAccumulator: string
  lastActivity: number
}

class SessionStreamBuffer {
  private buffers = new Map<string, BufferEntry>()
  private streaming = new Set<string>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS)
  }

  appendTextDelta(sessionId: string, delta: string): void {
    const entry = this.getOrCreate(sessionId)
    this.streaming.add(sessionId)
    entry.textAccumulator += delta
    entry.lastActivity = Date.now()

    const last = entry.blocks[entry.blocks.length - 1]
    if (last && last.type === 'text') {
      last.content = entry.textAccumulator
    } else {
      entry.blocks.push({ type: 'text', content: entry.textAccumulator })
    }
  }

  appendToolUse(sessionId: string, toolUseId: string, name: string, input?: Record<string, unknown>, planContent?: string, parentToolUseId?: string): void {
    const entry = this.getOrCreate(sessionId)
    this.streaming.add(sessionId)
    // Tool call interrupts text flow — reset text accumulator
    entry.textAccumulator = ''
    entry.lastActivity = Date.now()
    entry.blocks.push({ type: 'tool_call', toolUseId, name, input, status: 'calling', ...(planContent ? { planContent } : {}), ...(parentToolUseId ? { parentToolUseId } : {}) })
  }

  appendToolResult(sessionId: string, toolUseId: string, result: string): void {
    const entry = this.getOrCreate(sessionId)
    entry.lastActivity = Date.now()
    // Find matching tool_call and mark done
    for (let i = entry.blocks.length - 1; i >= 0; i--) {
      const b = entry.blocks[i]
      if (b.type === 'tool_call' && b.toolUseId === toolUseId && b.status === 'calling') {
        b.status = 'done'
        b.result = result
        break
      }
    }
  }

  appendSystem(sessionId: string, variant: 'compact' | 'error' | 'info', message: string, detail?: string): void {
    const entry = this.getOrCreate(sessionId)
    entry.textAccumulator = ''  // system event breaks text flow
    entry.lastActivity = Date.now()
    entry.blocks.push({ type: 'system', variant, message, ...(detail ? { detail } : {}) } as StreamingSystemBlock)
  }

  markDone(sessionId: string): void {
    this.streaming.delete(sessionId)
  }

  clear(sessionId: string): void {
    const entry = this.buffers.get(sessionId)
    log.ws.debug('stream buffer cleared', { sessionId, eventsDropped: entry?.blocks.length ?? 0 })
    this.buffers.delete(sessionId)
    this.streaming.delete(sessionId)
  }

  getSnapshot(sessionId: string): StreamSnapshot {
    const entry = this.buffers.get(sessionId)
    if (!entry) {
      return { blocks: [], isStreaming: this.streaming.has(sessionId) }
    }
    // Return a deep-enough copy so mutations don't leak
    return {
      blocks: entry.blocks.map((b) => ({ ...b })),
      isStreaming: this.streaming.has(sessionId),
    }
  }

  /** Prune buffers that haven't received events in a while. */
  private pruneStale(): void {
    const now = Date.now()
    for (const [id, entry] of this.buffers) {
      if (now - entry.lastActivity > STALE_THRESHOLD_MS && !this.streaming.has(id)) {
        log.ws.info('stale stream buffer pruned', { sessionId: id, ageMs: now - entry.lastActivity })
        this.buffers.delete(id)
      }
    }
  }

  private getOrCreate(sessionId: string): BufferEntry {
    let entry = this.buffers.get(sessionId)
    if (!entry) {
      entry = { blocks: [], textAccumulator: '', lastActivity: Date.now() }
      this.buffers.set(sessionId, entry)
      log.ws.debug('stream buffer created', { sessionId })
    }
    return entry
  }

  /** Stop the prune timer (for clean shutdown / tests). */
  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    this.buffers.clear()
    this.streaming.clear()
  }
}

export const sessionStreamBuffer = new SessionStreamBuffer()
