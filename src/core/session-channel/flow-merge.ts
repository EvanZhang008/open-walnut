/**
 * The host's text and thinking deltas, merged for up to FLOW_MERGE_MS into one flow frame
 * (docs/plan/one-service-every-host.md, the plan's "facts and flow"): a busy session writes a
 * delta every few milliseconds, and each one was a frame the leader parsed and said on its bus.
 * Only flow is merged; facts stay as they are (durable, one record each).
 *
 * Consecutive deltas of one session merge while everything but the text is the same (the event,
 * its message, its lane, its destinations); anything else of that session (another kind of flow,
 * another message) sends what is open first, so a session's flow keeps its order. The channel
 * sends a session's open deltas before a facts frame that names it (HostChannel.live), so deltas
 * said before a fact still reach the leader before it. A merged frame has the shape of one delta
 * with the longer text, so an older leader reads it as it always did.
 */

export const FLOW_MERGE_MS = 50
const MERGED: ReadonlySet<string> = new Set(['session:text-delta', 'session:thinking-delta'])

interface Group { name: string; data: Record<string, unknown> & { delta: string }; to?: string[]; key: string }

export class FlowMerger {
  private readonly open = new Map<string, Group>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly send: (sid: string, name: string, data: unknown, to?: string[]) => void,
    private readonly ms = FLOW_MERGE_MS,
  ) {}

  add(sid: string, name: string, data: unknown, to?: string[]): void {
    const d = data as Record<string, unknown> | null
    if (this.ms <= 0 || !MERGED.has(name) || !d || typeof d !== 'object' || typeof d.delta !== 'string') {
      this.flush(sid)
      this.send(sid, name, data, to)
      return
    }
    const { delta, ...rest } = d
    const key = `${name}\u0000${JSON.stringify(rest)}\u0000${to ? to.join('\u0001') : ''}`
    const g = this.open.get(sid)
    if (g && g.key === key) { g.data.delta += delta as string; return }
    if (g) this.flush(sid)
    this.open.set(sid, { name, data: { ...d, delta: delta as string }, ...(to ? { to } : {}), key })
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flushAll() }, this.ms)
      this.timer.unref?.()
    }
  }

  /** Send what `sid` has open now. */
  flush(sid: string): void {
    const g = this.open.get(sid)
    if (!g) return
    this.open.delete(sid)
    this.send(sid, g.name, g.data, g.to)
  }

  flushAll(): void {
    for (const sid of [...this.open.keys()]) this.flush(sid)
  }

  /** Nothing open is sent (the channel has no reader to send it to). */
  drop(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.open.clear()
  }
}
