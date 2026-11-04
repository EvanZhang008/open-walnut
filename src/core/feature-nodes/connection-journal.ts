/**
 * The feature-node connection journal: one JSON line per connection event, written by the
 * server a node attaches to, so an observer can tell a server restart from a node that failed.
 *
 *   WALNUT_HOME/local/feature-nodes/connections.jsonl   (local/: each box's own, never git-synced)
 *
 * Identifiers and protocol metadata only (node id, generation, close code): never an account,
 * a token, a payload or capability data. Appends go through one in-process queue, in order and
 * never with sync I/O. Bounded: compacted to the newest JOURNAL_MAX_LINES lines younger than
 * JOURNAL_MAX_AGE_MS at the first write and whenever it grows JOURNAL_SLACK_LINES past that.
 * One server owns a data home (instance lock), so one process writes this file.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { identifierSchema, type FailureCode } from './protocol.js'

export const JOURNAL_MAX_LINES = 2000
export const JOURNAL_SLACK_LINES = 500
export const JOURNAL_MAX_AGE_MS = 14 * 86_400_000
export const JOURNAL_MAX_QUEUE = 1000
/** Every read and compaction looks at most at this tail of the file. */
const MAX_READ_BYTES = 1024 * 1024
const MAX_LINE_BYTES = 2048

export const disconnectCauses = [
  'server_stopping', 'replaced', 'closed_by_node', 'abnormal', 'transport_error', 'refused',
  'revoked', 'credential_check_failed', 'protocol_error', 'send_failed',
] as const
export type DisconnectCause = typeof disconnectCauses[number]

export type JournalEvent =
  | { type: 'connected'; nodeId: string; generation: string }
  | {
    type: 'disconnected'; nodeId: string | null; generation?: string; cause: DisconnectCause
    code?: FailureCode; closeCode?: number; closeReason?: string; connectedForMs?: number
  }
  | { type: 'server_started'; build: string }
  | { type: 'server_stopping'; reason: string; build: string; signal?: string; nextBuild?: string }
export type JournalEntry = JournalEvent & { at: string }

export interface ConnectionLog {
  record(event: JournalEvent): void
  flush?(): Promise<void>
}

export interface JournalQuery { nodeId?: string; since?: number; limit?: number }

/** A string for the journal: control characters out, at most `max` characters. */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
  return cleaned || undefined
}

export function journalNodeId(value: unknown): string | null {
  return identifierSchema.safeParse(value).success ? value as string : null
}

function count(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : undefined
}

/** Only the fields an event kind declares, each bounded: nothing else reaches the file. */
export function cleanEvent(event: JournalEvent): JournalEvent | null {
  switch (event.type) {
    case 'connected': {
      const nodeId = journalNodeId(event.nodeId)
      const generation = text(event.generation, 160)
      return nodeId && generation ? { type: 'connected', nodeId, generation } : null
    }
    case 'disconnected': {
      if (!disconnectCauses.includes(event.cause)) return null
      const out: Extract<JournalEvent, { type: 'disconnected' }> = { type: 'disconnected', nodeId: journalNodeId(event.nodeId), cause: event.cause }
      const generation = text(event.generation, 160)
      if (generation) out.generation = generation
      const code = text(event.code, 32)
      if (code) out.code = code as FailureCode
      const closeCode = count(event.closeCode, 4999)
      if (closeCode !== undefined) out.closeCode = closeCode
      const closeReason = text(event.closeReason, 120)
      if (closeReason) out.closeReason = closeReason
      const connectedForMs = count(event.connectedForMs, Number.MAX_SAFE_INTEGER)
      if (connectedForMs !== undefined) out.connectedForMs = connectedForMs
      return out
    }
    case 'server_started':
      return { type: 'server_started', build: text(event.build, 96) ?? 'unknown' }
    case 'server_stopping': {
      const out: Extract<JournalEvent, { type: 'server_stopping' }> = {
        type: 'server_stopping', reason: text(event.reason, 64) ?? 'unknown', build: text(event.build, 96) ?? 'unknown',
      }
      const signal = text(event.signal, 16)
      if (signal) out.signal = signal
      const nextBuild = text(event.nextBuild, 96)
      if (nextBuild) out.nextBuild = nextBuild
      return out
    }
    default:
      return null
  }
}

/**
 * The newest lines of `file` (a partial first line dropped), or none when it is missing or
 * unreadable. `cut`: the file was longer than the tail read, so its head was left out.
 */
async function tailLines(file: string): Promise<{ lines: string[]; cut: boolean }> {
  let handle: fsp.FileHandle | undefined
  try {
    handle = await fsp.open(file, 'r')
    const { size } = await handle.stat()
    const length = Math.min(size, MAX_READ_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    const lines = buffer.toString('utf8').split('\n')
    if (length < size) lines.shift()
    return { lines: lines.filter((line) => line.length > 0 && line.length <= MAX_LINE_BYTES), cut: length < size }
  } catch {
    return { lines: [], cut: false }
  } finally {
    await handle?.close().catch(() => {})
  }
}

function parseEntry(line: string): JournalEntry | null {
  try {
    const value = JSON.parse(line) as JournalEntry
    return value && typeof value === 'object' && typeof value.at === 'string' && typeof value.type === 'string' ? value : null
  } catch { return null }
}

export class ConnectionJournal implements ConnectionLog {
  private pending: string[] = []
  private running: Promise<void> | null = null
  /** Lines in the file as far as this process knows; -1 until the first compaction. */
  private lines = -1
  private compactedAt = 0
  private dropped = 0
  private failures = 0

  constructor(
    readonly file: string,
    private readonly options: {
      now?: () => number
      maxLines?: number
      slackLines?: number
      maxAgeMs?: number
      maxQueue?: number
      onLine?: (entry: JournalEntry) => void
      onProblem?: (message: string, meta: Record<string, unknown>) => void
    } = {},
  ) {}

  private now(): number {
    try { return (this.options.now ?? Date.now)() } catch { return Date.now() }
  }

  record(event: JournalEvent): void {
    let line: string
    let entry: JournalEntry
    try {
      const clean = cleanEvent(event)
      if (!clean) return
      entry = { at: new Date(this.now()).toISOString(), ...clean }
      line = JSON.stringify(entry)
    } catch { return }
    try { this.options.onLine?.(entry) } catch { /* a log sink never stops the journal */ }
    if (this.pending.length >= (this.options.maxQueue ?? JOURNAL_MAX_QUEUE)) {
      if (this.dropped++ === 0) {
        try { this.options.onProblem?.('feature node journal queue full: dropping events', { file: this.file }) } catch { /* as above */ }
      }
      return
    }
    this.pending.push(line)
    this.kick()
  }

  /** Resolves once every event recorded before the call is written (or given up on). */
  async flush(): Promise<void> {
    while (this.running) await this.running
  }

  /** Events oldest first: one node's (or every node's) plus the server markers, at or after `since`. */
  async read(query: JournalQuery = {}): Promise<{ events: JournalEntry[]; truncated: boolean }> {
    await this.flush()
    const limit = Math.max(1, Math.min(query.limit ?? 200, JOURNAL_MAX_LINES + JOURNAL_SLACK_LINES))
    const oldest = Math.max(query.since ?? -Infinity, this.now() - (this.options.maxAgeMs ?? JOURNAL_MAX_AGE_MS))
    const matched: JournalEntry[] = []
    for (const line of (await tailLines(this.file)).lines) {
      const entry = parseEntry(line)
      if (!entry) continue
      if (!(Date.parse(entry.at) >= oldest)) continue
      const server = entry.type === 'server_started' || entry.type === 'server_stopping'
      if (!server && query.nodeId !== undefined && (entry as { nodeId?: unknown }).nodeId !== query.nodeId) continue
      matched.push(entry)
    }
    // The newest `limit` of the span: an observer asks about what just happened.
    return { events: matched.slice(-limit), truncated: matched.length > limit }
  }

  get resources(): { queued: number; dropped: number; failures: number } {
    return { queued: this.pending.length, dropped: this.dropped, failures: this.failures }
  }

  private kick(): void {
    if (this.running) return
    this.running = this.drain().finally(() => {
      this.running = null
      if (this.pending.length) this.kick()
    })
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const batch = this.pending.splice(0)
      try {
        await fsp.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
        if (this.lines < 0) await this.compactOrCount()
        await fsp.appendFile(this.file, `${batch.join('\n')}\n`, { mode: 0o600 })
        this.lines += batch.length
        this.dropped = 0
      } catch (err) {
        this.problem('feature node journal write failed', err, batch.length)
        continue
      }
      // Past the line bound, or a day since the last pass (a quiet server still ages lines out).
      if (this.lines > (this.options.maxLines ?? JOURNAL_MAX_LINES) + (this.options.slackLines ?? JOURNAL_SLACK_LINES)
        || this.now() - this.compactedAt > 86_400_000) {
        await this.compactOrCount()
      }
    }
  }

  /** A failed compaction loses nothing: the file only stays longer until the next one. */
  private async compactOrCount(): Promise<void> {
    try { await this.compact() } catch (err) {
      this.problem('feature node journal compaction failed', err, 0)
      this.lines = 0
      this.compactedAt = this.now()
    }
  }

  private problem(message: string, err: unknown, lost: number): void {
    if (this.failures++ % 100 !== 0) return
    try {
      this.options.onProblem?.(message, { file: this.file, lost, error: err instanceof Error ? err.message : String(err) })
    } catch { /* a log sink never stops the journal */ }
  }

  /** Keep the newest maxLines lines younger than maxAgeMs; written whole, then renamed over the file. */
  private async compact(): Promise<void> {
    const now = this.now()
    const oldest = now - (this.options.maxAgeMs ?? JOURNAL_MAX_AGE_MS)
    const { lines, cut } = await tailLines(this.file)
    const kept = lines.filter((line) => {
      const at = Date.parse(parseEntry(line)?.at ?? '')
      return Number.isFinite(at) && at >= oldest
    }).slice(-(this.options.maxLines ?? JOURNAL_MAX_LINES))
    if (cut || kept.length !== lines.length || this.lines >= 0) {
      const tmp = `${this.file}.${process.pid}.tmp`
      await fsp.writeFile(tmp, kept.length ? `${kept.join('\n')}\n` : '', { mode: 0o600 })
      await fsp.rename(tmp, this.file)
    }
    this.lines = kept.length
    this.compactedAt = now
  }
}
