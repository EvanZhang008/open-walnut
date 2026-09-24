/**
 * notes-corpus-store: the note list and tag counts are fetched once per page,
 * shared by every reader, and refreshed from the server's change events rather
 * than on every note switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Cb = (data: unknown) => void
const ws = {
  state: 'connected' as 'connected' | 'disconnected',
  events: new Map<string, Cb[]>(),
  conn: [] as Array<(s: string) => void>,
  onEvent(name: string, cb: Cb) { this.events.set(name, [...(this.events.get(name) ?? []), cb]) },
  offEvent() {},
  onConnectionChange(cb: (s: string) => void) { this.conn.push(cb) },
  offConnectionChange() {},
  emit(name: string, data: unknown = {}) { for (const cb of this.events.get(name) ?? []) cb(data) },
  setState(s: 'connected' | 'disconnected') { this.state = s; for (const cb of this.conn) cb(s) },
}
vi.mock('@/api/ws', () => ({ wsClient: ws }))

const api = {
  fetchNotesList: vi.fn(async (_opts?: unknown) => [{ path: 'a.md', name: 'a' }]),
  fetchTags: vi.fn(async (_opts?: unknown) => [{ tag: 'x', count: 1 }]),
}
vi.mock('@/api/notes-v2', () => api)

const store = await import('@/stores/notes-corpus-store')

beforeEach(() => {
  vi.useFakeTimers()
  store.notesListCorpus.reset()
  store.noteTagsCorpus.reset()
  api.fetchNotesList.mockClear()
  api.fetchTags.mockClear()
})
afterEach(() => { vi.useRealTimers() })

describe('notes corpus store', () => {
  it('fetches once and serves every later reader from memory', async () => {
    await store.notesListCorpus.ensure()
    await store.notesListCorpus.ensure()
    await Promise.all([store.notesListCorpus.ensure(), store.notesListCorpus.ensure()])
    expect(api.fetchNotesList).toHaveBeenCalledTimes(1)
    expect(store.notesListCorpus.get()).toEqual([{ path: 'a.md', name: 'a' }])
  })

  it('concurrent first readers share one request', async () => {
    await Promise.all([store.noteTagsCorpus.ensure(), store.noteTagsCorpus.ensure(), store.noteTagsCorpus.ensure()])
    expect(api.fetchTags).toHaveBeenCalledTimes(1)
  })

  it('a save event refreshes both corpora once per burst, after the reconcile window, at low priority', async () => {
    store.wireNotesCorpusEvents()
    await store.notesListCorpus.ensure()
    await store.noteTagsCorpus.ensure()
    api.fetchNotesList.mockClear(); api.fetchTags.mockClear()

    for (let i = 0; i < 5; i++) ws.emit('notes:updated', { source: 'notes/a' })
    expect(api.fetchNotesList).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1600)
    expect(api.fetchNotesList).toHaveBeenCalledTimes(1)
    expect(api.fetchTags).toHaveBeenCalledTimes(1)
    expect(api.fetchNotesList.mock.calls[0][0]).toEqual({ priority: 'low' })
  })

  it('a tree change refreshes the list but not the tags', async () => {
    store.wireNotesCorpusEvents()
    await store.notesListCorpus.ensure()
    await store.noteTagsCorpus.ensure()
    api.fetchNotesList.mockClear(); api.fetchTags.mockClear()
    ws.emit('notes:tree-changed', { path: 'b.md' })
    await vi.advanceTimersByTimeAsync(1600)
    expect(api.fetchNotesList).toHaveBeenCalledTimes(1)
    expect(api.fetchTags).not.toHaveBeenCalled()
  })

  it('an event before anyone has read does not fetch (the first reader will)', async () => {
    store.wireNotesCorpusEvents()
    ws.emit('notes:updated', {})
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.fetchNotesList).not.toHaveBeenCalled()
  })

  it('the old value stays visible while a refresh is in flight, then the new one lands and notifies', async () => {
    store.wireNotesCorpusEvents()
    await store.notesListCorpus.ensure()
    let resolve!: (v: unknown) => void
    api.fetchNotesList.mockImplementationOnce(() => new Promise((r) => { resolve = r }) as never)
    const seen: unknown[] = []
    store.notesListCorpus.subscribe(() => seen.push(store.notesListCorpus.get()))
    ws.emit('notes:updated', {})
    await vi.advanceTimersByTimeAsync(1600)
    expect(store.notesListCorpus.get()).toEqual([{ path: 'a.md', name: 'a' }])
    resolve([{ path: 'b.md', name: 'b' }])
    await vi.advanceTimersByTimeAsync(0)
    expect(store.notesListCorpus.get()).toEqual([{ path: 'b.md', name: 'b' }])
    expect(seen).toEqual([[{ path: 'b.md', name: 'b' }]])
  })

  it('a reconnect refreshes what someone holds, since events were missed', async () => {
    store.wireNotesCorpusEvents()
    await store.notesListCorpus.ensure()
    api.fetchNotesList.mockClear()
    ws.setState('disconnected')
    ws.setState('connected')
    await vi.advanceTimersByTimeAsync(10)
    expect(api.fetchNotesList).toHaveBeenCalledTimes(1)
    // tags were never read, so nothing to refresh there
    expect(api.fetchTags).not.toHaveBeenCalled()
  })

  it('prefetch warms both at low priority and is a no-op once warm', async () => {
    store.prefetchNotesCorpora()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchNotesList.mock.calls[0][0]).toEqual({ priority: 'low' })
    expect(api.fetchTags.mock.calls[0][0]).toEqual({ priority: 'low' })
    store.prefetchNotesCorpora()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.fetchNotesList).toHaveBeenCalledTimes(1)
  })
})
