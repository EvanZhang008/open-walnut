/**
 * The public drawing-library catalog (libraries.excalidraw.com), fetched by the server for the
 * editor's "Browse libraries": the Mac app's web view cannot open that site's own page and hand
 * the chosen library back, so Walnut lists the catalog and fetches a library itself.
 *
 *   catalog   https://libraries.excalidraw.com/libraries.json, cached CATALOG_TTL_MS; when the site
 *             does not answer, the last copy is served (marked stale), and with none it is a 503
 *   library   https://libraries.excalidraw.com/libraries/<source>   (`.excalidrawlib` JSON)
 *   preview   https://libraries.excalidraw.com/libraries/<source>   (png, jpg, webp or gif)
 *
 * Only that one origin is ever fetched: a source is a relative path checked segment by segment
 * (no `..`, no hidden segment, a known extension), the URL is built here, and redirects are refused.
 * Every fetch has a deadline (DEADLINE_MS, 503 when it passes) and a size cap (MAX_FETCH_BYTES,
 * read as a stream and cut off past it), at most MAX_PARALLEL run at once, and what came back is
 * kept in a small byte-bounded cache, so a page of previews costs the site one fetch each per hour.
 */

import { log } from '../../logging/index.js'
import { DrawingInputError, DrawingServiceError } from './scene.js'

export const LIBRARY_ORIGIN = 'https://libraries.excalidraw.com'
const CATALOG_URL = `${LIBRARY_ORIGIN}/libraries.json`
const FILES_PATH = '/libraries/'
export const CATALOG_TTL_MS = 60 * 60 * 1000
export const MAX_FETCH_BYTES = 5 * 1024 * 1024
const FILE_TTL_MS = 60 * 60 * 1000
const CACHE_BYTES = 32 * 1024 * 1024
const MAX_PARALLEL = 6
const MAX_SOURCE = 300
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const LIBRARY_EXT_RE = /\.excalidrawlib$/
const PREVIEW_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

/** Tunable by tests only: the network and the deadline. */
const tuning = {
  deadlineMs: 10_000,
  fetch: (url: string, init: RequestInit): Promise<Response> => globalThis.fetch(url, init),
}

export function _setLibraryProxyForTests(next: Partial<typeof tuning> | null): void {
  tuning.deadlineMs = next?.deadlineMs ?? 10_000
  tuning.fetch = next?.fetch ?? ((url, init) => globalThis.fetch(url, init))
  catalog = null
  catalogInFlight = null
  files.clear()
  filesBytes = 0
}

// ── Sources ─────────────────────────────────────────────────────────────────

/** A catalog source path (`author/name.excalidrawlib`, `author/name.png`), checked; null when unsafe. */
function safeSource(raw: unknown, ext: RegExp): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_SOURCE) return null
  const segments = raw.split('/')
  if (!segments.every((seg) => SEGMENT_RE.test(seg) && seg !== '..')) return null
  return ext.test(raw.toLowerCase()) ? raw : null
}

const PREVIEW_EXT_RE = new RegExp(`\\.(${Object.keys(PREVIEW_TYPES).join('|')})$`)

function sourceUrl(source: string): string {
  const url = new URL(`${FILES_PATH}${source}`, LIBRARY_ORIGIN)
  // Built from a checked relative path, so this always holds; checked anyway.
  if (url.origin !== LIBRARY_ORIGIN || !url.pathname.startsWith(FILES_PATH)) throw new DrawingInputError('source is not a library path')
  return url.href
}

/** The route the editor loads a preview through (never the site directly). */
export function previewRoute(source: string): string {
  return `/api/drawings/library/preview?source=${encodeURIComponent(source)}`
}

// ── Fetching ────────────────────────────────────────────────────────────────

let running = 0
const waiting: Array<() => void> = []

async function slot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) {
    await new Promise<void>((resolve, reject) => {
      const go = () => { signal.removeEventListener('abort', stop); resolve() }
      const stop = () => {
        const i = waiting.indexOf(go)
        if (i >= 0) waiting.splice(i, 1)
        reject(signal.reason)
      }
      waiting.push(go)
      signal.addEventListener('abort', stop, { once: true })
    })
  }
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

/** One GET of the library origin, whole body, within the deadline and the size cap. */
async function fetchCapped(url: string, what: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (new URL(url).origin !== LIBRARY_ORIGIN) throw new DrawingInputError('Only the public library site is fetched')
  const signal = AbortSignal.timeout(tuning.deadlineMs)
  const unreachable = (detail: string) =>
    new DrawingServiceError(`The public library site did not answer (${what}): ${detail}`, 503)
  try {
    return await slot(signal, async () => {
      const res = await tuning.fetch(url, { signal, redirect: 'error', headers: { accept: '*/*' } })
      if (res.status === 404) throw new DrawingInputError(`Not in the public library: ${what}`, 404)
      if (!res.ok) throw new DrawingServiceError(`The public library site answered ${res.status} (${what})`, 502)
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) throw new DrawingInputError(`${what} is larger than ${MAX_FETCH_BYTES} bytes`, 413)
      const chunks: Buffer[] = []
      let size = 0
      const reader = res.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_FETCH_BYTES) {
            await reader.cancel().catch(() => {})
            throw new DrawingInputError(`${what} is larger than ${MAX_FETCH_BYTES} bytes`, 413)
          }
          chunks.push(Buffer.from(value))
        }
      }
      return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') ?? '' }
    })
  } catch (err) {
    if (err instanceof DrawingInputError || err instanceof DrawingServiceError) throw err
    if (signal.aborted) throw unreachable(`no answer within ${Math.round(tuning.deadlineMs / 1000)} s`)
    throw unreachable((err as Error).message)
  }
}

// ── Catalog ─────────────────────────────────────────────────────────────────

export interface CatalogItem {
  id: string
  name: string
  description: string
  authors: Array<{ name: string; url?: string }>
  source: string
  /** The preview through Walnut (previewRoute), or null when the catalog names none usable. */
  preview: string | null
  created: string
  updated: string
  itemNames: string[]
}

export interface Catalog {
  items: CatalogItem[]
  fetchedAt: number
  /** True when the site did not answer and this is the last copy Walnut has. */
  stale?: boolean
}

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** The catalog's entries in the shape the editor reads; an entry without a safe source is left out. */
export function catalogItems(raw: unknown): CatalogItem[] {
  if (!Array.isArray(raw)) throw new DrawingServiceError('The public library catalog is not a list', 502)
  const out: CatalogItem[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const source = safeSource(e.source, LIBRARY_EXT_RE)
    if (!source) continue
    const preview = safeSource(e.preview, PREVIEW_EXT_RE)
    out.push({
      id: str(e.id, 200) || source,
      name: str(e.name, 200) || source,
      description: str(e.description),
      authors: Array.isArray(e.authors)
        ? e.authors.filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
          .map((a) => ({ name: str(a.name, 200), ...(typeof a.url === 'string' && /^https?:\/\//.test(a.url) ? { url: a.url.slice(0, 500) } : {}) }))
          .filter((a) => a.name)
        : [],
      source,
      preview: preview ? previewRoute(preview) : null,
      created: str(e.created, 40),
      updated: str(e.updated, 40),
      itemNames: Array.isArray(e.itemNames) ? e.itemNames.filter((n): n is string => typeof n === 'string').slice(0, 500).map((n) => n.slice(0, 200)) : [],
    })
  }
  return out
}

let catalog: Catalog | null = null
let catalogInFlight: Promise<Catalog> | null = null

async function loadCatalog(): Promise<Catalog> {
  const { bytes } = await fetchCapped(CATALOG_URL, 'the catalog')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf-8'))
  } catch {
    throw new DrawingServiceError('The public library catalog is not JSON', 502)
  }
  return { items: catalogItems(parsed), fetchedAt: Date.now() }
}

/** The catalog: cached for CATALOG_TTL_MS; one fetch at a time; the last copy when the site is down. */
export async function getCatalog(): Promise<Catalog> {
  if (catalog && Date.now() - catalog.fetchedAt < CATALOG_TTL_MS) return catalog
  catalogInFlight ??= loadCatalog().finally(() => { catalogInFlight = null })
  try {
    catalog = await catalogInFlight
    return catalog
  } catch (err) {
    if (catalog && err instanceof DrawingServiceError) {
      log.web.warn('public library catalog unreachable; serving the last copy', { error: err.message })
      return { ...catalog, stale: true }
    }
    throw err
  }
}

// ── Library files and previews ─────────────────────────────────────────────

const files = new Map<string, { bytes: Buffer; contentType: string; at: number }>()
let filesBytes = 0

function cached(key: string): { bytes: Buffer; contentType: string } | null {
  const hit = files.get(key)
  if (!hit) return null
  files.delete(key)
  if (Date.now() - hit.at > FILE_TTL_MS) {
    filesBytes -= hit.bytes.byteLength
    return null
  }
  files.set(key, hit) // most recently used last
  return hit
}

function remember(key: string, value: { bytes: Buffer; contentType: string }): void {
  if (value.bytes.byteLength > CACHE_BYTES / 4) return
  files.set(key, { ...value, at: Date.now() })
  filesBytes += value.bytes.byteLength
  for (const [k, v] of files) {
    if (filesBytes <= CACHE_BYTES) break
    files.delete(k)
    filesBytes -= v.bytes.byteLength
  }
}

/** One library (`.excalidrawlib` JSON bytes) of the catalog, by its catalog `source`. */
export async function fetchLibraryFile(rawSource: unknown): Promise<Buffer> {
  const source = safeSource(rawSource, LIBRARY_EXT_RE)
  if (!source) throw new DrawingInputError('source must be a catalog library path (author/name.excalidrawlib)')
  const key = `lib:${source}`
  const hit = cached(key)
  if (hit) return hit.bytes
  const { bytes } = await fetchCapped(sourceUrl(source), source)
  // A library is a JSON object; anything else (an HTML error page) is not passed on.
  const head = bytes.subarray(0, 64).toString('utf-8').trimStart()
  if (!head.startsWith('{')) throw new DrawingServiceError(`The public library site did not send a library for ${source}`, 502)
  remember(key, { bytes, contentType: 'application/json' })
  return bytes
}

/** One preview image of the catalog, by its catalog `preview` path. */
export async function fetchLibraryPreview(rawSource: unknown): Promise<{ bytes: Buffer; contentType: string }> {
  const source = safeSource(rawSource, PREVIEW_EXT_RE)
  if (!source) throw new DrawingInputError('source must be a catalog preview path (author/name.png)')
  const key = `preview:${source}`
  const hit = cached(key)
  if (hit) return hit
  const { bytes } = await fetchCapped(sourceUrl(source), source)
  // The type comes from the checked extension, never from the site: only these image types pass.
  const contentType = PREVIEW_TYPES[source.slice(source.lastIndexOf('.') + 1).toLowerCase()]!
  const value = { bytes, contentType }
  remember(key, value)
  return value
}
