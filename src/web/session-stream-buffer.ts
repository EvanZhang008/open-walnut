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
  /** API message id (`msg_…`) of the assistant message this block belongs to.
   *  Same id appears on the persisted JSONL line, so promotion/dedup can match
   *  by id instead of content. ACP-dialect: a CHANGE in msgId = a new message
   *  (and therefore a new block). Optional: absent for legacy events. */
  msgId?: string
  /** Non-null when this text belongs to an inline subagent (Agent/Task) —
   *  rendered inside the parent's task group, never as main-conversation text. */
  parentToolUseId?: string
  /** Subagent identity (inline-subagent lines) — labels an ORPHAN task group
   *  when the parent Agent tool_call is gone (background agent after turn end). */
  subagentType?: string
  taskDescription?: string
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
  /** See StreamingTextBlock.subagentType/taskDescription. */
  subagentType?: string
  taskDescription?: string
}

export interface StreamingSystemBlock {
  type: 'system'
  variant: 'compact' | 'error' | 'info'
  message: string
  detail?: string
}

export interface StreamingPermissionBlock {
  type: 'permission'
  requestId: string
  toolName: string
  input?: Record<string, unknown>
  reason?: string
  status: 'pending' | 'allowed' | 'denied'
}

export interface StreamingThinkingBlock {
  type: 'thinking'
  content: string
  /** See StreamingTextBlock.msgId. */
  msgId?: string
  /** See StreamingTextBlock.parentToolUseId. */
  parentToolUseId?: string
}

export type StreamingBlock = StreamingTextBlock | StreamingToolCallBlock | StreamingSystemBlock | StreamingPermissionBlock | StreamingThinkingBlock

export interface StreamSnapshot {
  blocks: StreamingBlock[]
  isStreaming: boolean
  /** How many leading blocks belong to already-finished turns. Clients that
   *  stamp turn boundaries must use this rather than deriving it from
   *  isStreaming — a snapshot taken after the NEXT turn's markStreaming but
   *  before its first delta carries the previous turn's blocks with
   *  isStreaming=true (deriving would mislabel them "live"). */
  completedLen: number
  /** Monotonic mutation counter for this session's buffer. Bumps on every
   *  append/clear/markDone, so clients can compare "which side is newer"
   *  by sequence instead of guessing from block-array lengths
   *  (snapshot-adoption heuristics). Resets only when the entry is pruned;
   *  a fresh entry restarts at 1, and `seq === 0` means "no buffer". */
  seq: number
}

// ── Buffer implementation ──

const PRUNE_INTERVAL_MS = 5 * 60_000  // check every 5 min
const STALE_THRESHOLD_MS = 10 * 60_000 // prune after 10 min idle

interface BufferEntry {
  blocks: StreamingBlock[]
  /** Full accumulated text for the current text run (used to reconstruct streamBuffer on snapshot) */
  textAccumulator: string
  /** Current thinking block's full accumulated text (mirrors textAccumulator's role). */
  thinkingAccumulator: string
  lastActivity: number
  /** Set by markDone: the held blocks belong to a FINISHED turn (kept for
   *  cross-turn viewing). The first data append of the NEXT turn resets the
   *  entry, and getSnapshot never serves finished-turn blocks as a live turn.
   *  Without this, a snapshot taken after the next turn's markStreaming but
   *  before its first delta returned old blocks with isStreaming=true — the
   *  client stamped them completedLen=0 ("live"), evidence-promotion never
   *  touched them, and they duplicated persisted history until a reload. */
  turnEnded?: boolean
  /** Monotonic mutation counter — see StreamSnapshot.seq. */
  seq: number
}

class SessionStreamBuffer {
  private buffers = new Map<string, BufferEntry>()
  private streaming = new Set<string>()
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  /** Pending deferred clears (clearSoon) — cancelled when a new turn starts. */
  private pendingClears = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() {
    this.pruneTimer = setInterval(() => this.pruneStale(), PRUNE_INTERVAL_MS)
  }

  /** Stamp activity time and bump the monotonic mutation counter. Every
   *  buffer mutation goes through here so `seq` is a total order on this
   *  session's buffer states (the id snapshot-adoption compares instead of
   *  block-array lengths). */
  private touch(entry: BufferEntry): void {
    entry.lastActivity = Date.now()
    entry.seq++
  }

  /** First block-creating append of a NEW turn drops the finished turn's blocks
   *  (they live in persisted history now). Not called from appendToolResult /
   *  resolvePermission — those mutate blocks of the turn they belong to. */
  private resetIfTurnEnded(entry: BufferEntry, sessionId: string): void {
    if (!entry.turnEnded) return
    log.ws.info('stream buffer: new turn data — dropping finished-turn blocks', {
      sessionId, dropped: entry.blocks.length,
    })
    entry.blocks = []
    entry.textAccumulator = ''
    entry.thinkingAccumulator = ''
    entry.turnEnded = false
  }

  /** Last non-subagent block, or undefined. The CLI interleaves inline-subagent
   *  lines (parent_tool_use_id set) into the MIDDLE of the main turn's token
   *  stream; merging main-lane deltas into "the last block" would split main
   *  text at every subagent line (the mid-token markdown-corruption bug). Main
   *  lane must anchor to the last MAIN-lane block instead. */
  private lastMainLaneBlock(blocks: StreamingBlock[]): StreamingBlock | undefined {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if ((b.type === 'text' || b.type === 'thinking' || b.type === 'tool_call') && b.parentToolUseId) continue
      return b
    }
    return undefined
  }

  appendTextDelta(sessionId: string, delta: string, msgId?: string, parentToolUseId?: string, subagentType?: string, taskDescription?: string): void {
    const entry = this.getOrCreate(sessionId)
    // ⚠️  DO NOT add `this.streaming.add(sessionId)` here. This is "Root Cause 5"
    // of the stuck-Streaming-badge bug: JSONL replay / late events re-populated the
    // streaming Set *after* markDone had cleared it, leaving the badge stuck forever.
    // Four prior attempts (resultEmitted guard, belt-and-suspenders cleanup, stale
    // subscribe backstop, daemon recovery) all fought the symptom — the architectural
    // fix is to keep data events out of the streaming flag entirely. The flag is
    // driven exclusively by lifecycle events via markStreaming/markDone.

    if (parentToolUseId) {
      // Subagent lane. Deliberately NO resetIfTurnEnded: a background subagent
      // keeps producing after the MAIN turn's result (or after a re-send to it) —
      // its late lines must not wipe the finished turn's blocks (that orphans
      // the children by deleting their parent Agent tool_call). Only MAIN-lane
      // data starts a new turn.
      this.touch(entry)
      // Merge into the same lane+message block; never touches the main-lane
      // accumulator, so interleaved subagent lines can't split main text.
      for (let i = entry.blocks.length - 1; i >= 0; i--) {
        const b = entry.blocks[i]
        if (b.type === 'text' && b.parentToolUseId === parentToolUseId) {
          if (!msgId || !b.msgId || b.msgId === msgId) {
            b.content += delta
            if (msgId && !b.msgId) b.msgId = msgId
            return
          }
          break // same lane, different message → new block
        }
        if (b.type === 'tool_call' && b.parentToolUseId === parentToolUseId) break // lane's text flow interrupted
      }
      entry.blocks.push({
        type: 'text', content: delta, ...(msgId ? { msgId } : {}), parentToolUseId,
        ...(subagentType ? { subagentType } : {}), ...(taskDescription ? { taskDescription } : {}),
      })
      return
    }

    this.resetIfTurnEnded(entry, sessionId)
    this.touch(entry)

    const anchor = this.lastMainLaneBlock(entry.blocks)
    // ACP message boundary: a CHANGE in msgId means a new assistant message —
    // start a new block so stream blocks match history messages 1:1 instead of
    // gluing consecutive messages' text into one block. When either side lacks
    // an id (legacy events), fall back to the historical "last block is text"
    // accumulation.
    const sameMessage = anchor && anchor.type === 'text' && (!msgId || !anchor.msgId || anchor.msgId === msgId)
    if (sameMessage) {
      entry.textAccumulator += delta
      anchor.content = entry.textAccumulator
      if (msgId && !anchor.msgId) anchor.msgId = msgId
    } else {
      entry.textAccumulator = delta
      entry.blocks.push({ type: 'text', content: delta, ...(msgId ? { msgId } : {}) })
    }
  }

  appendToolUse(sessionId: string, toolUseId: string, name: string, input?: Record<string, unknown>, planContent?: string, parentToolUseId?: string, subagentType?: string, taskDescription?: string): void {
    const entry = this.getOrCreate(sessionId)
    // ⚠️  DO NOT add `this.streaming.add(sessionId)` here — see appendTextDelta
    // for the Root Cause 5 explanation. Data events must never flip the lifecycle flag.
    // Subagent tool calls (parentToolUseId set) live in their own lane: they must
    // NOT cut the main turn's text mid-token, and (background agents) must NOT
    // start a new turn — see the subagent-lane note in appendTextDelta.
    if (!parentToolUseId) {
      this.resetIfTurnEnded(entry, sessionId)
      entry.textAccumulator = ''
    }
    this.touch(entry)
    // DUP-DEBUG: detect if the same toolUseId is appended twice — that means
    // two SESSION_TOOL_USE events reached the buffer for the same logical
    // tool call, which is what causes the duplicate panel in the chat UI.
    const existing = entry.blocks.find((b) => b.type === 'tool_call' && b.toolUseId === toolUseId)
    if (existing) {
      log.ws.warn('appendToolUse DUPLICATE — same toolUseId already in buffer', {
        sessionId, toolUseId, toolName: name,
        existingStatus: existing.type === 'tool_call' ? existing.status : undefined,
        blocksTotal: entry.blocks.length,
      })
    }
    entry.blocks.push({
      type: 'tool_call', toolUseId, name, input, status: 'calling',
      ...(planContent ? { planContent } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      ...(subagentType ? { subagentType } : {}),
      ...(taskDescription ? { taskDescription } : {}),
    })
  }

  appendToolResult(sessionId: string, toolUseId: string, result: string): void {
    const entry = this.getOrCreate(sessionId)
    this.touch(entry)
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

  /** Append a permission request block (idempotent — skips if requestId already exists). */
  appendPermission(sessionId: string, requestId: string, toolName: string, input?: Record<string, unknown>, reason?: string): void {
    const entry = this.getOrCreate(sessionId)
    // Idempotent: don't add duplicate permission blocks (re-emit timer may fire multiple times)
    const existing = entry.blocks.find(b => b.type === 'permission' && b.requestId === requestId) as StreamingPermissionBlock | undefined
    if (existing) return
    this.resetIfTurnEnded(entry, sessionId)
    entry.textAccumulator = ''  // permission event breaks text flow
    this.touch(entry)
    entry.blocks.push({ type: 'permission', requestId, toolName, input, reason, status: 'pending' })
  }

  /** Update a permission block status after resolution. */
  resolvePermission(sessionId: string, requestId: string, status: 'allowed' | 'denied'): void {
    const entry = this.buffers.get(sessionId)
    if (!entry) return
    for (const b of entry.blocks) {
      if (b.type === 'permission' && (b as StreamingPermissionBlock).requestId === requestId) {
        (b as StreamingPermissionBlock).status = status
        this.touch(entry)
        break
      }
    }
  }

  appendSystem(sessionId: string, variant: 'compact' | 'error' | 'info', message: string, detail?: string): void {
    const entry = this.getOrCreate(sessionId)
    this.resetIfTurnEnded(entry, sessionId)
    entry.textAccumulator = ''  // system event breaks text flow
    entry.thinkingAccumulator = ''
    this.touch(entry)
    entry.blocks.push({ type: 'system', variant, message, ...(detail ? { detail } : {}) } as StreamingSystemBlock)
  }

  /** Accumulate thinking text deltas (model's reasoning, gated behind thinking mode). */
  appendThinkingDelta(sessionId: string, delta: string, msgId?: string, parentToolUseId?: string): void {
    const entry = this.getOrCreate(sessionId)

    if (parentToolUseId) {
      // Subagent lane — same isolation rule as appendTextDelta (incl. NO
      // resetIfTurnEnded: late background-subagent lines must not wipe the
      // finished turn's blocks).
      this.touch(entry)
      for (let i = entry.blocks.length - 1; i >= 0; i--) {
        const b = entry.blocks[i]
        if (b.type === 'thinking' && b.parentToolUseId === parentToolUseId) {
          if (!msgId || !b.msgId || b.msgId === msgId) {
            b.content += delta
            if (msgId && !b.msgId) b.msgId = msgId
            return
          }
          break
        }
        if ((b.type === 'text' || b.type === 'tool_call') && b.parentToolUseId === parentToolUseId) break
      }
      entry.blocks.push({ type: 'thinking', content: delta, ...(msgId ? { msgId } : {}), parentToolUseId })
      return
    }

    this.resetIfTurnEnded(entry, sessionId)
    this.touch(entry)

    const anchor = this.lastMainLaneBlock(entry.blocks)
    // Same ACP message-boundary rule as appendTextDelta.
    const sameMessage = anchor && anchor.type === 'thinking' && (!msgId || !anchor.msgId || anchor.msgId === msgId)
    if (sameMessage) {
      entry.thinkingAccumulator += delta
      anchor.content = entry.thinkingAccumulator
      if (msgId && !anchor.msgId) anchor.msgId = msgId
    } else {
      entry.thinkingAccumulator = delta
      entry.blocks.push({ type: 'thinking', content: delta, ...(msgId ? { msgId } : {}) })
    }
  }


  /**
   * SOLE "on"-path for the streaming flag. Must be called ONLY from lifecycle events
   * (currently just the `session:status-changed` handler in server.ts with
   * process_status='running'). If you are tempted to call this from a data handler
   * (appendTextDelta / appendToolUse / appendSystem), STOP — you are re-introducing
   * Root Cause 5 (stuck-badge bug where JSONL replay/late events re-populated the
   * streaming Set after markDone cleared it). The invariant that makes this fix
   * work is: data events append blocks only; lifecycle events flip the flag.
   *
   * Paired "off"-paths: markDone (result/error/idle/stopped/error status-changed)
   * and clear (session reaped / terminal status).
   */
  markStreaming(sessionId: string): void {
    const had = this.streaming.has(sessionId)
    this.streaming.add(sessionId)
    // A new turn is starting — a deferred clear scheduled by the PREVIOUS
    // turn's result must not fire mid-turn (it would wipe the new turn's
    // blocks AND delete the streaming flag → blank snapshot on reload).
    const pending = this.pendingClears.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      this.pendingClears.delete(sessionId)
      log.ws.info('stream buffer: cancelled deferred clear (new turn started)', { sessionId })
    }
    if (!had) log.ws.info('stream buffer markStreaming', { sessionId })
  }

  markDone(sessionId: string): void {
    const had = this.streaming.has(sessionId)
    this.streaming.delete(sessionId)
    const entry = this.buffers.get(sessionId)
    // Blocks are retained for cross-turn viewing but stamped as finished — the
    // next turn's first data append drops them, and getSnapshot never serves
    // them as a live turn (see BufferEntry.turnEnded).
    if (entry) {
      entry.turnEnded = true
      entry.seq++
    }
    log.ws.info('stream buffer markDone', { sessionId, wasStreaming: had, blocksRetained: entry?.blocks.length ?? 0 })
  }

  /** Deferred clear that a new turn's markStreaming can cancel. Use this
   *  instead of a bare setTimeout(clear) — a turn started inside the delay
   *  window must not have its buffer wiped mid-stream. */
  clearSoon(sessionId: string, delayMs: number): void {
    const prev = this.pendingClears.get(sessionId)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      this.pendingClears.delete(sessionId)
      this.clear(sessionId)
    }, delayMs)
    timer.unref?.()
    this.pendingClears.set(sessionId, timer)
  }

  clear(sessionId: string): void {
    const entry = this.buffers.get(sessionId)
    log.ws.debug('stream buffer cleared', { sessionId, eventsDropped: entry?.blocks.length ?? 0 })
    this.buffers.delete(sessionId)
    this.streaming.delete(sessionId)
    const pending = this.pendingClears.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      this.pendingClears.delete(sessionId)
    }
  }

  getSnapshot(sessionId: string): StreamSnapshot {
    const entry = this.buffers.get(sessionId)
    if (!entry) {
      const isStr = this.streaming.has(sessionId)
      log.ws.info('getSnapshot (no buffer)', { sessionId, isStreaming: isStr })
      return { blocks: [], isStreaming: isStr, completedLen: 0, seq: 0 }
    }
    const isStr = this.streaming.has(sessionId)
    // turnEnded ⇒ every held block belongs to a finished turn, even when the
    // streaming flag is already true for the NEXT turn (markStreaming fired,
    // first delta hasn't). Otherwise the buffer holds only the live turn.
    const completedLen = entry.turnEnded ? entry.blocks.length : 0
    log.ws.info('getSnapshot', { sessionId, blocks: entry.blocks.length, isStreaming: isStr, completedLen, seq: entry.seq })
    // Return a deep-enough copy so mutations don't leak
    return {
      blocks: entry.blocks.map((b) => ({ ...b })),
      isStreaming: isStr,
      completedLen,
      seq: entry.seq,
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
      entry = { blocks: [], textAccumulator: '', thinkingAccumulator: '', lastActivity: Date.now(), seq: 1 }
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
    for (const timer of this.pendingClears.values()) clearTimeout(timer)
    this.pendingClears.clear()
    this.buffers.clear()
    this.streaming.clear()
  }
}

export const sessionStreamBuffer = new SessionStreamBuffer()
