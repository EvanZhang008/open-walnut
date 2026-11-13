/** Bounded, content-free per-socket traffic samples. The existing heartbeat drains them. */
import { LEAN_BACKGROUND_EVENT, LEAN_TASK_EVENTS } from '../../lib/ws-lean-protocol.js'
const taskEvents = new Set(LEAN_TASK_EVENTS)

export class SocketTraffic {
  private since: number
  private bytes = 0
  private plainBytes = 0
  private frames = 0
  private events = { background: 0, task: 0, response: 0, other: 0 }
  compare = true
  private label: { client?: string; tab?: string } = {}

  constructor(now = Date.now()) { this.since = now }

  /** Diagnostic labels only, never credentials or a source of trust. */
  identify(payload: unknown): void {
    const entries = (payload as { entries?: unknown } | null)?.entries
    if (!Array.isArray(entries)) return
    for (const entry of entries.slice(0, 200)) {
      if (!entry || typeof entry !== 'object') continue
      if (entry.client === 'mac-app') this.label.client = 'mac-app'
      if (typeof entry.tab === 'string' && /^[a-z0-9]{1,16}$/.test(entry.tab)) this.label.tab = entry.tab
    }
  }

  record(bytes: number, plainBytes = bytes, name?: string): void {
    this.bytes += bytes
    this.plainBytes += plainBytes
    this.frames++
    const key = name === undefined ? 'response' : name === LEAN_BACKGROUND_EVENT ? 'background' : taskEvents.has(name) ? 'task' : 'other'
    this.events[key] += bytes
  }

  sample(now = Date.now(), closing = false) {
    const elapsedMs = now - this.since
    if (elapsedMs <= 0 || (!closing && elapsedMs < 60_000)) return null
    const out = this.frames ? {
      ...this.label, elapsedMs, frames: this.frames, bytes: this.bytes, plainBytes: this.plainBytes,
      bytesPerMinute: Math.round(this.bytes * 60_000 / elapsedMs),
      plainBytesPerMinute: Math.round(this.plainBytes * 60_000 / elapsedMs),
      comparison: this.compare,
      backgroundBytes: this.events.background, taskBytes: this.events.task,
      responseBytes: this.events.response, otherBytes: this.events.other,
    } : null
    this.since = now
    this.bytes = this.plainBytes = this.frames = 0
    this.events = { background: 0, task: 0, response: 0, other: 0 }
    // Only the first minute pays for the old-frame comparison serialization.
    this.compare = false
    return out
  }
}
