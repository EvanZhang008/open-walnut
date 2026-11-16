/**
 * The shared drawing library (core/drawings/library.ts): CAS writes under the store lock, the size
 * cap, an unreadable file, the update event; and the public catalog proxy (library-catalog.ts)
 * against a mocked network: only the one origin, the deadline, the size cap and the caches.
 */
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('drawings-library'))

import { bus, EventNames } from '../../../src/core/event-bus.js'
import { LibraryConflictError, libraryFile, MAX_LIBRARY_BYTES, readLibrary, writeLibrary } from '../../../src/core/drawings/library.js'
import {
  _setLibraryProxyForTests, CATALOG_TTL_MS, catalogItems, fetchLibraryFile, fetchLibraryPreview, getCatalog, MAX_FETCH_BYTES,
} from '../../../src/core/drawings/library-catalog.js'
import { DrawingInputError, DrawingServiceError } from '../../../src/core/drawings/scene.js'

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: 'unpublished', created: 1, elements: [{ id: `${id}-el`, type: 'rectangle', x: 0, y: 0 }], ...extra })

async function status(p: Promise<unknown>): Promise<number> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err, 'expected a refusal').toBeTruthy()
  return (err as { status: number }).status
}

describe('drawing library store', () => {
  it('reads as an empty list with the revision of the empty file, and writes under that revision', async () => {
    const empty = await readLibrary()
    expect(empty.items).toBe('[]')
    const seen: unknown[] = []
    bus.subscribe('library-test', (e) => { seen.push(e.data) }, { global: true, interest: [EventNames.DRAWING_LIBRARY_UPDATED] })
    try {
      const saved = await writeLibrary({ revision: empty.revision, libraryItems: [item('a')] })
      expect(JSON.parse(saved.items)).toEqual([item('a')])
      const bytes = await fs.readFile(libraryFile(), 'utf-8')
      expect(JSON.parse(bytes)).toMatchObject({ type: 'excalidrawlib', version: 2, source: 'walnut', libraryItems: [item('a')] })
      expect(saved.revision).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(await readLibrary()).toEqual(saved)
      await vi.waitFor(() => expect(seen).toEqual([{ revision: saved.revision }]))
      // The same list again writes and announces nothing.
      expect(await writeLibrary(JSON.stringify({ revision: saved.revision, libraryItems: [item('a')] }))).toEqual(saved)
      await new Promise((r) => setTimeout(r, 20))
      expect(seen).toHaveLength(1)
    } finally {
      bus.unsubscribe('library-test')
    }
  })

  it('refuses a stale revision with the current list, and lets one of two racing writes win', async () => {
    const now = await readLibrary()
    const err = await writeLibrary({ revision: 'stale', libraryItems: [] }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(LibraryConflictError)
    expect((err as LibraryConflictError).current).toEqual(now)
    const race = await Promise.allSettled([
      writeLibrary({ revision: now.revision, libraryItems: [item('left')] }),
      writeLibrary({ revision: now.revision, libraryItems: [item('right')] }),
    ])
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as DrawingInputError).status).toBe(409)
  })

  it('refuses a bad body and a library over the size cap', async () => {
    const { revision } = await readLibrary()
    expect(await status(writeLibrary({ libraryItems: [] }))).toBe(400)
    expect(await status(writeLibrary({ revision, libraryItems: 'x' }))).toBe(400)
    expect(await status(writeLibrary({ revision, libraryItems: [{ id: 'no elements' }] }))).toBe(400)
    expect(await status(writeLibrary('{nope'))).toBe(400)
    const big = [item('big', { name: 'x'.repeat(MAX_LIBRARY_BYTES) })]
    expect(await status(writeLibrary({ revision, libraryItems: big }))).toBe(413)
    expect((await readLibrary()).revision).toBe(revision)
  }, 30_000)

  it('reads an unreadable file as empty and keeps a copy of it when it is replaced', async () => {
    await fs.writeFile(libraryFile(), '{"cut short')
    const broken = await readLibrary()
    expect(broken.items).toBe('[]')
    const saved = await writeLibrary({ revision: broken.revision, libraryItems: [item('fresh')] })
    expect(JSON.parse(saved.items)).toEqual([item('fresh')])
    expect(await fs.readFile(libraryFile().replace(/library\.json$/, 'library.unreadable.json'), 'utf-8')).toBe('{"cut short')
  })

  it('reads a version 1 .excalidrawlib file (bare element lists)', async () => {
    await fs.writeFile(libraryFile(), JSON.stringify({ type: 'excalidrawlib', version: 1, library: [[{ id: 'e', type: 'ellipse' }]] }))
    expect(JSON.parse((await readLibrary()).items)).toEqual([{ id: 'item-0', status: 'unpublished', elements: [{ id: 'e', type: 'ellipse' }], created: 0 }])
  })
})

// ── The public catalog ──────────────────────────────────────────────────────

const ORIGIN = 'https://libraries.excalidraw.com'
const CATALOG = [
  { id: 'id1', name: 'Icons', description: 'Some icons', authors: [{ name: 'Ann', url: 'https://ann.example' }, { name: 'Bob', url: 'javascript:alert(1)' }], source: 'ann/icons.excalidrawlib', preview: 'ann/icons.png', created: '2021-01-01', updated: '2021-02-01', version: 1, itemNames: ['Cloud'] },
  { id: 'id2', name: 'Shout', source: 'bob/shout.excalidrawlib', preview: 'bob/shout.PNG' },
  { id: 'bad1', name: 'Escape', source: '../etc/passwd.excalidrawlib', preview: 'x/y.png' },
  { id: 'bad2', name: 'Elsewhere', source: 'https://evil.example/a.excalidrawlib' },
  { id: 'bad3', name: 'Svg preview', source: 'c/d.excalidrawlib', preview: 'c/d.svg' },
]

function respond(body: string | Uint8Array, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, ...init })
}

function network(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  })
  _setLibraryProxyForTests({ fetch })
  return { calls, fetch }
}

afterEach(() => {
  _setLibraryProxyForTests(null)
  vi.restoreAllMocks()
})

describe('public library catalog', () => {
  it('lists the catalog in the editor\'s shape, previews through Walnut, unsafe entries left out', async () => {
    const { calls } = network(() => respond(JSON.stringify(CATALOG)))
    const { items, stale } = await getCatalog()
    expect(stale).toBeUndefined()
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/libraries.json`])
    expect(calls[0]!.init.redirect).toBe('error')
    expect(items.map((i) => i.id)).toEqual(['id1', 'id2', 'bad3'])
    expect(items[0]).toEqual({
      id: 'id1', name: 'Icons', description: 'Some icons', authors: [{ name: 'Ann', url: 'https://ann.example' }, { name: 'Bob' }],
      source: 'ann/icons.excalidrawlib', preview: '/api/drawings/library/preview?source=ann%2Ficons.png', created: '2021-01-01', updated: '2021-02-01', itemNames: ['Cloud'],
    })
    expect(items[1]!.preview).toBe('/api/drawings/library/preview?source=bob%2Fshout.PNG')
    expect(items[2]!.preview).toBeNull()
    expect(() => catalogItems({})).toThrow(DrawingServiceError)
  })

  it('caches the catalog for an hour and serves the last copy when the site is down', async () => {
    let up = true
    const { fetch } = network(() => (up ? respond(JSON.stringify(CATALOG)) : Promise.reject(new TypeError('fetch failed'))))
    const first = await getCatalog()
    await getCatalog()
    expect(fetch).toHaveBeenCalledTimes(1)
    up = false
    const later = Date.now() + CATALOG_TTL_MS + 1
    vi.spyOn(Date, 'now').mockReturnValue(later)
    const stale = await getCatalog()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(stale).toMatchObject({ items: first.items, stale: true })
  })

  it('answers 503 within the deadline when the site hangs, and with no copy yet', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    }))
    _setLibraryProxyForTests({ fetch, deadlineMs: 80 })
    const started = Date.now()
    const err = await getCatalog().then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(DrawingServiceError)
    expect((err as DrawingServiceError).status).toBe(503)
    expect(Date.now() - started).toBeLessThan(2000)
    _setLibraryProxyForTests({ fetch: async () => { throw new TypeError('getaddrinfo ENOTFOUND') } })
    expect(await status(getCatalog())).toBe(503)
  })

  it('fetches a library only from the library origin, by a checked source path', async () => {
    const { calls } = network(() => respond('{"type":"excalidrawlib","version":2,"libraryItems":[]}', { headers: { 'content-type': 'application/octet-stream' } }))
    const bytes = await fetchLibraryFile('ann/icons.excalidrawlib')
    expect(JSON.parse(bytes.toString())).toMatchObject({ type: 'excalidrawlib' })
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/libraries/ann/icons.excalidrawlib`])
    for (const bad of ['../x.excalidrawlib', 'a/../../x.excalidrawlib', 'https://evil.example/x.excalidrawlib', '//evil.example/x.excalidrawlib',
      'a/.hidden.excalidrawlib', 'a/b.json', 'a%2F..%2Fb.excalidrawlib', 'a/b c.excalidrawlib', '', undefined, ['a/b.excalidrawlib'], 'a'.repeat(400) + '.excalidrawlib']) {
      expect(await status(fetchLibraryFile(bad)), String(bad)).toBe(400)
    }
    expect(await status(fetchLibraryPreview('a/b.svg'))).toBe(400)
    expect(await status(fetchLibraryPreview('a/b.excalidrawlib'))).toBe(400)
    expect(calls).toHaveLength(1)
  })

  it('caches a fetched library and preview, and types a preview by its extension', async () => {
    const { fetch } = network((url) => respond(url.endsWith('.jpg') ? new Uint8Array([0xff, 0xd8, 0xff]) : '{"library":[]}', { headers: { 'content-type': 'text/html' } }))
    await fetchLibraryFile('ann/icons.excalidrawlib')
    await fetchLibraryFile('ann/icons.excalidrawlib')
    const preview = await fetchLibraryPreview('ann/icons.jpg')
    expect(preview.contentType).toBe('image/jpeg')
    expect([...preview.bytes]).toEqual([0xff, 0xd8, 0xff])
    await fetchLibraryPreview('ann/icons.jpg')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('maps the site\'s answers: 404, an error status, a page that is not a library, and the size cap', async () => {
    network(() => respond('nope', { status: 404 }))
    expect(await status(fetchLibraryFile('a/missing.excalidrawlib'))).toBe(404)
    network(() => respond('down', { status: 500 }))
    expect(await status(fetchLibraryFile('a/b.excalidrawlib'))).toBe(502)
    network(() => respond('<html>oops</html>'))
    expect(await status(fetchLibraryFile('a/b.excalidrawlib'))).toBe(502)
    network(() => respond('{}', { headers: { 'content-length': String(MAX_FETCH_BYTES + 1) } }))
    expect(await status(fetchLibraryFile('a/b.excalidrawlib'))).toBe(413)
    // No length given: the stream is cut off past the cap.
    const chunk = new Uint8Array(1024 * 1024).fill(0x20)
    network(() => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 6; i++) c.enqueue(chunk); c.close() },
    })))
    expect(await status(fetchLibraryFile('a/b.excalidrawlib'))).toBe(413)
  })
})
