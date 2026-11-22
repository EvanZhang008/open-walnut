/**
 * Walnut's idle compaction runs the CLI, but its turn is quiet: a task's status icon does not read
 * as Working through it (web/src/stores/idle-compacting-store.ts, web/src/utils/task-icon-state.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Task } from '@open-walnut/core'

type Cb = (data: unknown) => void
const ws = {
  events: new Map<string, Cb[]>(),
  conn: [] as Array<(s: string) => void>,
  onEvent(name: string, cb: Cb) { this.events.set(name, [...(this.events.get(name) ?? []), cb]) },
  offEvent() {},
  onConnectionChange(cb: (s: string) => void) { this.conn.push(cb) },
  offConnectionChange() {},
  emit(name: string, data: unknown = {}) { for (const cb of this.events.get(name) ?? []) cb(data) },
  setState(s: string) { for (const cb of this.conn) cb(s) },
}
vi.mock('@/api/ws', () => ({ wsClient: ws }))

const { idleCompactingStore, IDLE_COMPACTION_EVENT, IDLE_COMPACTING_END_GRACE_MS } = await import('@/stores/idle-compacting-store')
const { taskIconState } = await import('@/utils/task-icon-state')

const SID = 'sess-1'
// A parked task: Working only while a real turn runs.
const task = { id: 't1', status: 'todo', phase: 'WAITING', session_id: SID } as unknown as Task
const icon = () => taskIconState(task, running, false, SID)
const running = { process_status: 'running' }

beforeEach(() => { vi.useFakeTimers(); idleCompactingStore.resetForTest() })
afterEach(() => { vi.useRealTimers() })

describe("a task's status icon while Walnut's idle compaction runs", () => {
  it('reads as Working for a real turn, and not while the idle compaction runs', () => {
    expect(icon()).toBe('working')
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: true })
    expect(icon()).toBe('waiting')
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: false })
    // Its end comes a moment before the CLI's status leaves running: still quiet for that moment.
    expect(icon()).toBe('waiting')
    // The composer reads it exactly: a turn that follows shows its Stop at once.
    expect(idleCompactingStore.has(SID, true)).toBe(false)
    vi.advanceTimersByTime(IDLE_COMPACTING_END_GRACE_MS)
    expect(icon()).toBe('working')
  })

  it('a start inside the moment after an end keeps it quiet', () => {
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: true })
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: false })
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: true })
    vi.advanceTimersByTime(IDLE_COMPACTING_END_GRACE_MS * 2)
    expect(idleCompactingStore.has(SID)).toBe(true)
  })

  it('another session compacting leaves this one as it is', () => {
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: 'other', active: true })
    expect(icon()).toBe('working')
  })

  it("says which of Walnut's compactions runs: the context-full recovery is quiet too", () => {
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: true, reason: 'context' })
    expect(idleCompactingStore.kind(SID, true)).toBe('context')
    expect(icon()).toBe('waiting')
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: true })
    expect(idleCompactingStore.kind(SID, true)).toBe('idle')
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: false, reason: 'context' })
    expect(idleCompactingStore.kind(SID, true)).toBeNull()
    vi.advanceTimersByTime(IDLE_COMPACTING_END_GRACE_MS)
    expect(idleCompactingStore.kind(SID)).toBeNull()
  })

  it('a reconnect forgets what it may have missed the end of', () => {
    const seen: number[] = []
    const off = idleCompactingStore.subscribe(() => seen.push(1))
    ws.emit(IDLE_COMPACTION_EVENT, { sessionId: SID, active: true })
    ws.setState('connected')
    expect(idleCompactingStore.has(SID)).toBe(false)
    expect(seen.length).toBe(2)
    off()
  })
})
