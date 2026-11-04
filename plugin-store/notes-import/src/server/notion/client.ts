/**
 * A small Notion REST client: the bearer token, the API version, the rate limit and retries.
 *
 * Notion allows about three requests a second per connection and answers 429 with Retry-After
 * past that, so every request goes through one gate: at most `MAX_IN_FLIGHT` at once, started at
 * most `PER_SECOND` a second, and a 429 pauses every request of the client for its Retry-After.
 * A 429, a 5xx or a network failure is retried with backoff. 401 is the token (SourceAuthError, the run
 * stops); 403/404 is a page the connection cannot see (null, the caller skips it).
 *
 * Only reads are made: GET, and the POST/PATCH query endpoints that Notion uses for reading
 * (search, data source query). Nothing here can change the person's Notion.
 */
import { SourceAuthError } from '../types'

export const NOTION_VERSION = '2025-09-03'
const MAX_IN_FLIGHT = 3
const PER_SECOND = 3
const MAX_ATTEMPTS = 6
/** A 429 is Notion pacing us, not a failure: it may be waited out more often. */
const MAX_RATE_LIMITED = 12
const TIMEOUT_MS = 30_000
/** Tries for a request Notion never answers (a network error or a timeout). */
const MAX_UNREACHED = 3

/** Requests started per second; tests against a stand-in server raise it. */
function perSecond(): number {
  return Number(process.env.WALNUT_NOTION_PER_SECOND) || PER_SECOND
}

/** Tests point this at a stand-in server; nobody else sets it. */
function apiBase(): string {
  return (process.env.WALNUT_NOTION_API_BASE || 'https://api.notion.com').replace(/\/+$/, '')
}

const READ_POSTS = [/^\/v1\/search$/, /^\/v1\/data_sources\/[^/]+\/query$/, /^\/v1\/databases\/[^/]+\/query$/]

export interface NotionList<T> {
  results: T[]
  has_more: boolean
  next_cursor: string | null
}

export class NotionError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'NotionError'
  }
}

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const realSleep: Sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new Error('aborted')); return }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
  const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('aborted')) }
  signal?.addEventListener('abort', onAbort, { once: true })
})

/** When a secret's next request may start (the per-second pace), and the end of a 429 pause. */
interface Pace { nextStart: number; pausedUntil: number }
const PACES = new Map<string, Pace>()

export class NotionClient {
  private inFlight = 0
  private waiters: Array<() => void> = []
  /** The pace of this secret, shared with every other client using it. */
  private readonly pace: Pace
  /** Calls made, for the run's log line. */
  calls = 0
  /** Requests being made now (waiting, sending or retrying), and since when Notion last answered one. */
  private active = 0
  private heardAt = 0

  constructor(
    private readonly token: string,
    private readonly options: { fetch?: typeof fetch; sleep?: Sleep } = {},
  ) {
    this.pace = PACES.get(token) ?? { nextStart: 0, pausedUntil: 0 }
    PACES.set(token, this.pace)
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) this.inFlight++
    else {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      this.inFlight++
    }
    // Each request takes the next start slot before it sleeps, so requests stay spaced. A 429 seen
    // while it slept moves the pause on: it then waits that out too.
    for (;;) {
      const now = Date.now()
      const at = Math.max(now, this.pace.nextStart, this.pace.pausedUntil)
      this.pace.nextStart = at + Math.ceil(1000 / perSecond())
      if (at <= now) break
      const pausedBefore = this.pace.pausedUntil
      try { await (this.options.sleep ?? realSleep)(at - now, signal) } catch (error) { this.release(); throw error }
      if (this.pace.pausedUntil <= pausedBefore || Date.now() >= this.pace.pausedUntil) break
    }
  }

  private release(): void {
    this.inFlight--
    this.waiters.shift()?.()
  }

  async request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, signal?: AbortSignal): Promise<T | null> {
    if (method !== 'GET' && !READ_POSTS.some((pattern) => pattern.test(path.split('?')[0]))) {
      throw new Error(`Refusing ${method} ${path}: the importer only reads from Notion`)
    }
    if (this.active++ === 0) this.heardAt = Date.now()
    try { return await this.send<T>(method, path, body, signal) } finally { this.active-- }
  }

  /** How long Notion has not answered while requests wait on it (0 when none does). */
  quietMs(now = Date.now()): number {
    return this.active > 0 ? now - this.heardAt : 0
  }

  private async send<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, signal: AbortSignal | undefined): Promise<T | null> {
    const doFetch = this.options.fetch ?? fetch
    const sleep = this.options.sleep ?? realSleep
    let lastError: unknown
    let limited = 0
    let unreached = 0
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted()
      await this.acquire(signal)
      let response: Response
      try {
        this.calls++
        const timeout = AbortSignal.timeout(TIMEOUT_MS)
        response = await doFetch(`${apiBase()}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Notion-Version': NOTION_VERSION,
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        })
      } catch (error) {
        this.release()
        if (signal?.aborted) throw signal.reason ?? error
        // No answer at all (offline, refused, or nothing for 30 s): a few tries, then say so plainly.
        const timedOut = (error as { name?: string })?.name === 'TimeoutError'
        lastError = new NotionError(timedOut
          ? 'Notion did not answer for 30 seconds. Check the internet connection, then try again.'
          : 'Walnut could not reach Notion. Check the internet connection, then try again.', 0, 'unreachable')
        if (++unreached >= MAX_UNREACHED) break
        await sleep(Math.min(30_000, 1000 * 2 ** attempt), signal)
        continue
      }
      this.release()
      this.heardAt = Date.now()
      if (response.ok) return (await response.json()) as T
      const text = await response.text().catch(() => '')
      let code: string | undefined
      let message = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text) as { code?: string; message?: string }
        code = parsed.code
        if (parsed.message) message = parsed.message
      } catch { /* not JSON */ }
      if (response.status === 401) throw new SourceAuthError('Notion did not accept the secret. Paste it again from your connection\'s Configuration tab.')
      if (response.status === 403 || response.status === 404) return null
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after'))
        lastError = new NotionError(message || 'Notion asked to slow down', 429, code)
        // Every request waits, not only this one; and the wait does not use up the retries.
        this.pace.pausedUntil = Math.max(this.pace.pausedUntil, Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000))
        if (++limited < MAX_RATE_LIMITED) attempt--
        continue
      }
      if (response.status >= 500) {
        lastError = new NotionError(message || `Notion answered ${response.status}`, response.status, code)
        await sleep(Math.min(30_000, 1000 * 2 ** attempt), signal)
        continue
      }
      throw new NotionError(message || `Notion answered ${response.status}`, response.status, code)
    }
    throw lastError instanceof Error ? lastError : new Error('Notion did not answer')
  }

  /** Every page of a paginated list (GET with start_cursor, or POST with it in the body). */
  async all<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body: Record<string, unknown> | undefined, signal?: AbortSignal, onPage?: (count: number) => void): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null = null
    for (;;) {
      let page: NotionList<T> | null
      if (method === 'GET') {
        const sep = path.includes('?') ? '&' : '?'
        page = await this.request<NotionList<T>>('GET', `${path}${sep}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, signal)
      } else {
        page = await this.request<NotionList<T>>(method, path, { ...(body ?? {}), page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }, signal)
      }
      if (!page) break
      out.push(...page.results)
      onPage?.(out.length)
      if (!page.has_more || !page.next_cursor) break
      cursor = page.next_cursor
    }
    return out
  }

  /** Download a Notion-hosted file (a signed URL, valid about an hour). */
  async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; type: string } | null> {
    const doFetch = this.options.fetch ?? fetch
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      try {
        const timeout = AbortSignal.timeout(120_000)
        const response = await doFetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
        if (!response.ok) {
          if (response.status >= 500 || response.status === 429) { await realSleep(1000 * 2 ** attempt, signal); continue }
          return null
        }
        const length = Number(response.headers.get('content-length'))
        if (Number.isFinite(length) && length > maxBytes) return null
        const bytes = new Uint8Array(await response.arrayBuffer())
        if (bytes.byteLength > maxBytes) return null
        return { bytes, type: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() }
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error
        await realSleep(1000 * 2 ** attempt, signal)
      }
    }
    return null
  }
}
