/**
 * note-content-cache: the page-lifetime store of recently seen note bytes that
 * lets a click paint before the server answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Cb = (data: unknown) => void
const ws = {
  events: new Map<string, Cb[]>(),
  onEvent(name: string, cb: Cb) { this.events.set(name, [...(this.events.get(name) ?? []), cb]) },
  offEvent() {},
  emit(name: string, data: unknown) { for (const cb of this.events.get(name) ?? []) cb(data) },
}
vi.mock('@/api/ws', () => ({ wsClient: ws }))

const api = {
  fetchNoteContent: vi.fn(async (path: string, _opts?: unknown) => ({
    content: `# ${path}`, updatedAt: '2026-09-24T00:00:00.000Z', contentHash: `h-${path}`,
  })),
}
vi.mock('@/api/notes-v2', () => api)

const cache = await import('@/stores/note-content-cache')

beforeEach(() => {
  vi.useFakeTimers()
  cache.clearNoteContentCache()
  cache.cancelHoverPrefetch()
  api.fetchNoteContent.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('note content cache', () => {
  it('stores, peeks without touching, and evicts the least recently used past the entry cap', () => {
    for (let i = 0; i < 40; i++) cache.putCachedNote(`n${i}.md`, { content: 'x', updatedAt: 'u', contentHash: `h${i}` })
    expect(cache.noteContentCacheStats().entries).toBe(40)
    vi.setSystemTime(Date.now() + 1000)
    cache.getCachedNote('n0.md') // touched: now the newest
    cache.putCachedNote('n40.md', { content: 'x', updatedAt: 'u', contentHash: 'h40' })
    expect(cache.noteContentCacheStats().entries).toBe(40)
    expect(cache.peekCachedNote('n0.md')).toBeDefined()
    expect(cache.peekCachedNote('n1.md')).toBeUndefined() // the oldest untouched one went
  })

  it('evicts by total bytes too', () => {
    const big = 'x'.repeat(2 * 1024 * 1024)
    for (let i = 0; i < 4; i++) cache.putCachedNote(`big${i}.md`, { content: big, updatedAt: 'u', contentHash: `h${i}` })
    expect(cache.noteContentCacheStats().bytes).toBeLessThanOrEqual(6 * 1024 * 1024)
    expect(cache.peekCachedNote('big0.md')).toBeUndefined()
    expect(cache.peekCachedNote('big3.md')).toBeDefined()
  })

  it('prefetch is single-flight, low priority, and a no-op once cached', async () => {
    const [a, b] = await Promise.all([cache.prefetchNoteContent('a.md'), cache.prefetchNoteContent('a.md')])
    expect(a).toEqual(b)
    expect(api.fetchNoteContent).toHaveBeenCalledTimes(1)
    expect(api.fetchNoteContent.mock.calls[0]).toEqual(['a.md', { priority: 'low' }])
    await cache.prefetchNoteContent('a.md')
    expect(api.fetchNoteContent).toHaveBeenCalledTimes(1)
  })

  it('a failed prefetch resolves null and leaves no entry', async () => {
    api.fetchNoteContent.mockRejectedValueOnce(Object.assign(new Error('404'), { status: 404 }))
    expect(await cache.prefetchNoteContent('missing.md')).toBeNull()
    expect(cache.peekCachedNote('missing.md')).toBeUndefined()
  })

  it('a pointer sweeping across rows fetches only the row it rests on', async () => {
    cache.prefetchNoteOnHover('a.md')
    vi.advanceTimersByTime(30)
    cache.prefetchNoteOnHover('b.md')
    vi.advanceTimersByTime(30)
    cache.prefetchNoteOnHover('c.md')
    await vi.advanceTimersByTimeAsync(100)
    expect(api.fetchNoteContent.mock.calls.map((c) => c[0])).toEqual(['c.md'])
  })

  it('a save event for another note drops its entry; our own bytes (same hash) stay', () => {
    cache.wireNoteContentCacheEvents()
    cache.putCachedNote('a.md', { content: 'a', updatedAt: 'u', contentHash: 'ha' })
    cache.putCachedNote('b.md', { content: 'b', updatedAt: 'u', contentHash: 'hb' })
    ws.emit('notes:updated', { source: 'notes/a', contentHash: 'ha' })
    expect(cache.peekCachedNote('a.md')).toBeDefined()
    ws.emit('notes:updated', { source: 'notes/b', contentHash: 'other' })
    expect(cache.peekCachedNote('b.md')).toBeUndefined()
    ws.emit('notes:updated', { source: 'memory/x', contentHash: 'z' }) // not a note
    expect(cache.peekCachedNote('a.md')).toBeDefined()
  })

  it('a vault shape change keeps entries: the editor revalidates on open and drops a 404 itself', () => {
    cache.wireNoteContentCacheEvents()
    cache.putCachedNote('a.md', { content: 'a', updatedAt: 'u', contentHash: 'ha' })
    ws.emit('notes:tree-changed', { path: 'x.md' })
    expect(cache.peekCachedNote('a.md')).toBeDefined()
  })
})
