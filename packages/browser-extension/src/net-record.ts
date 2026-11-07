/**
 * What an agent's recording of its own tab keeps (agent-net.ts attaches the debugger and feeds
 * the events here): the tab's requests (address, method, status, type, timing, size) and its
 * console messages, each list a ring of its own. Never a request's or response's body: those are
 * asked of the browser by request id when an agent wants one (network_body). Pure, so
 * tests/core/browser-control/net-record.test.ts drives it with the debugger's own event shapes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export const NET_MAX = 500
export const CONSOLE_MAX = 300
export const TEXT_MAX = 2000
export const URL_MAX = 2000

export interface NetEntry {
  id: string
  url: string
  method: string
  type?: string
  status?: number
  statusText?: string
  mime?: string
  /** Bytes over the wire. */
  size?: number
  /** When it was sent (ms since 1970). */
  at: number
  /** From sent to finished, ms. */
  ms?: number
  failed?: string
  fromCache?: boolean
  redirects?: number
  /** The request carried a body (network_request_body reads it). */
  hasBody?: boolean
  /** The page that sent it. */
  page?: string
  /** The addresses it was redirected from, oldest first: each is judged like its address (agent-net.ts). */
  chain?: string[]
  /** The debugger's own clock at the send (seconds), for the timing. */
  t0?: number
}

/** `origin`: the page (execution context) that logged it, when the browser said; a message with none is judged as unknown. */
export interface ConsoleEntry { level: string; text: string; at: number; source: string; where?: string; origin?: string }

export interface NetRecord {
  since: number
  requests: Map<string, NetEntry>
  console: ConsoleEntry[]
  dropped: { requests: number; console: number }
  /** Each execution context's origin (Runtime.executionContextCreated), to tell which page logged a message. */
  contexts: Map<number, string>
}

export function newRecord(now = Date.now()): NetRecord {
  return { since: now, requests: new Map(), console: [], dropped: { requests: 0, console: 0 }, contexts: new Map() }
}

/**
 * An address as an agent may see it when its site is one Walnut signed the agent in on: no query and
 * no fragment (a sign-in sent over GET carries the password there). The one masking every address
 * field of a listing goes through (review 2026-11-07: the page address kept it).
 */
export function maskUrl(u: string): string {
  const i = u.search(/[?#]/)
  return i < 0 ? u : `${u.slice(0, i)}${u[i] === '?' ? '?…' : '#…'}`
}

/** Every address field of an entry, masked. */
export function maskEntry<E extends { url: string; page?: string; chain?: string[] }>(e: E): E {
  return { ...e, url: maskUrl(e.url), ...(e.page ? { page: maskUrl(e.page) } : {}), ...(e.chain ? { chain: e.chain.map(maskUrl) } : {}) }
}

/** Every address an entry names: where it went, the page that sent it, where it was redirected from. */
export const urlsOf = (e: { url: string; page?: string; chain?: string[] }): string[] => [e.url, ...(e.page ? [e.page] : []), ...(e.chain ?? [])]

const cut = (s: unknown, n: number) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : undefined)

/** A logged value as text: a string as it is, anything else by what the debugger calls it. */
function argText(a: unknown): string {
  const o = (a ?? {}) as { type?: string; value?: unknown; description?: string; unserializableValue?: string; subtype?: string }
  if (typeof o.value === 'string') return o.value
  if (o.value !== undefined) return JSON.stringify(o.value) ?? String(o.value)
  return o.unserializableValue ?? o.description ?? (o.subtype === 'null' ? 'null' : o.type ?? '')
}

function pushConsole(r: NetRecord, e: ConsoleEntry): void {
  r.console.push({ ...e, text: cut(e.text, TEXT_MAX) ?? '' })
  if (r.console.length > CONSOLE_MAX) { r.console.shift(); r.dropped.console++ }
}

/** One debugger event into the record. */
export function fold(r: NetRecord, method: string, p: Record<string, any> = {}, now = Date.now()): void {
  switch (method) {
    case 'Network.requestWillBeSent': {
      const id = String(p.requestId ?? '')
      if (!id) return
      const had = r.requests.get(id)
      const req = (p.request ?? {}) as { url?: string; method?: string; hasPostData?: boolean }
      const entry: NetEntry = {
        id, url: cut(req.url, URL_MAX) ?? '', method: req.method ?? 'GET', at: typeof p.wallTime === 'number' ? Math.round(p.wallTime * 1000) : now,
        ...(typeof p.type === 'string' ? { type: p.type } : {}),
        ...(req.hasPostData ? { hasBody: true } : {}),
        ...(typeof p.documentURL === 'string' ? { page: cut(p.documentURL, URL_MAX) } : {}),
        ...(typeof p.timestamp === 'number' ? { t0: p.timestamp } : {}),
      }
      // A redirect reuses the id: the entry follows it to the new address.
      if (had && p.redirectResponse) {
        r.requests.set(id, { ...entry, at: had.at, t0: had.t0, redirects: (had.redirects ?? 0) + 1, chain: [...new Set([...(had.chain ?? []), had.url, ...(had.page && had.page !== entry.page ? [had.page] : [])])].slice(-20) })
        return
      }
      r.requests.delete(id)
      r.requests.set(id, entry)
      while (r.requests.size > NET_MAX) { r.requests.delete(r.requests.keys().next().value as string); r.dropped.requests++ }
      return
    }
    case 'Network.responseReceived': {
      const e = r.requests.get(String(p.requestId ?? ''))
      if (!e) return
      const res = (p.response ?? {}) as { status?: number; statusText?: string; mimeType?: string; fromDiskCache?: boolean; fromServiceWorker?: boolean }
      e.status = res.status
      if (res.statusText) e.statusText = cut(res.statusText, 200)
      if (res.mimeType) e.mime = cut(res.mimeType, 200)
      if (res.fromDiskCache || res.fromServiceWorker) e.fromCache = true
      if (typeof p.type === 'string') e.type = p.type
      return
    }
    case 'Network.requestServedFromCache': {
      const e = r.requests.get(String(p.requestId ?? ''))
      if (e) e.fromCache = true
      return
    }
    case 'Network.loadingFinished': case 'Network.loadingFailed': {
      const e = r.requests.get(String(p.requestId ?? ''))
      if (!e) return
      if (typeof p.timestamp === 'number' && typeof e.t0 === 'number') e.ms = Math.max(0, Math.round((p.timestamp - e.t0) * 1000))
      if (typeof p.encodedDataLength === 'number') e.size = p.encodedDataLength
      if (method === 'Network.loadingFailed') e.failed = cut(p.canceled ? 'canceled' : p.errorText ?? 'failed', 200)
      return
    }
    case 'Runtime.executionContextCreated': {
      const ctx = (p.context ?? {}) as { id?: number; origin?: string }
      if (typeof ctx.id === 'number' && typeof ctx.origin === 'string') r.contexts.set(ctx.id, ctx.origin)
      if (r.contexts.size > 500) r.contexts.delete(r.contexts.keys().next().value as number)
      return
    }
    case 'Runtime.consoleAPICalled': {
      const args = Array.isArray(p.args) ? p.args : []
      const frame = p.stackTrace?.callFrames?.[0] as { url?: string; lineNumber?: number } | undefined
      const level = p.type === 'warning' ? 'warn' : typeof p.type === 'string' ? p.type : 'log'
      const origin = typeof p.executionContextId === 'number' ? r.contexts.get(p.executionContextId) : undefined
      pushConsole(r, { level, text: args.map(argText).join(' '), at: typeof p.timestamp === 'number' ? Math.round(p.timestamp) : now, source: 'console',
        ...(frame?.url ? { where: `${cut(frame.url, 300)}:${(frame.lineNumber ?? 0) + 1}` } : {}), ...(origin ? { origin } : {}) })
      return
    }
    case 'Runtime.exceptionThrown': {
      const d = (p.exceptionDetails ?? {}) as { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number; executionContextId?: number }
      const origin = typeof d.executionContextId === 'number' ? r.contexts.get(d.executionContextId) : undefined
      pushConsole(r, { level: 'error', text: d.exception?.description ?? d.text ?? 'An uncaught error', at: now, source: 'exception',
        ...(d.url ? { where: `${cut(d.url, 300)}:${(d.lineNumber ?? 0) + 1}` } : {}), ...(origin ? { origin } : {}) })
      return
    }
    case 'Log.entryAdded': {
      const e = (p.entry ?? {}) as { level?: string; text?: string; url?: string; lineNumber?: number; source?: string; timestamp?: number }
      pushConsole(r, { level: e.level === 'warning' ? 'warn' : e.level ?? 'info', text: e.text ?? '', at: typeof e.timestamp === 'number' ? Math.round(e.timestamp) : now,
        source: e.source ?? 'browser', ...(e.url ? { where: `${cut(e.url, 300)}${typeof e.lineNumber === 'number' ? `:${e.lineNumber + 1}` : ''}` } : {}) })
      return
    }
  }
}

/** Resources a page loads to show itself: left out of a listing unless asked for. */
const STATIC = new Set(['Image', 'Font', 'Media', 'Stylesheet'])

export interface NetFilter { url?: string; method?: string; status?: number | string; type?: string; limit?: number; includeStatic?: boolean }

/** `status` as a number (404) or a class (4xx). */
function statusMatches(s: number | undefined, want: number | string): boolean {
  if (typeof want === 'number') return s === want
  const m = /^([1-5])xx$/i.exec(want.trim())
  if (m) return s !== undefined && Math.floor(s / 100) === Number(m[1])
  const n = Number(want)
  return Number.isInteger(n) && s === n
}

/** What an agent may see of an entry: all of it, its addresses masked, or nothing (agent-net.ts decides). */
export type Judge = 'show' | 'mask' | 'drop'

/**
 * The requests that match, newest last, at most `limit` (default 50, at most NET_MAX). Each entry is
 * first judged (`judge`: a site agents may not use is dropped, one Walnut signed the agent in on is
 * masked), and the filters run on what the agent may see, never on the hidden part: a filter on a
 * hidden query could be guessed a character at a time from the counts (review 2026-11-07).
 */
export function listRequests(r: NetRecord, f: NetFilter, judge: (e: NetEntry) => Judge = () => 'show'): { requests: Array<Omit<NetEntry, 't0'>>; total: number; matched: number; withheld: number } {
  let withheld = 0
  const seen: Array<Omit<NetEntry, 't0'>> = []
  for (const e of r.requests.values()) {
    const j = judge(e)
    if (j === 'drop') { withheld++; continue }
    const { t0: _t, ...rest } = e
    seen.push(j === 'mask' ? maskEntry(rest) : rest)
  }
  const method = f.method?.toUpperCase()
  const type = f.type?.toLowerCase()
  const hits = seen.filter((e) => (f.includeStatic || !STATIC.has(e.type ?? ''))
    && (!f.url || e.url.includes(f.url))
    && (!method || e.method === method)
    && (!type || (e.type ?? '').toLowerCase() === type)
    && (f.status === undefined || f.status === '' || statusMatches(e.status, f.status)))
  const limit = Math.min(NET_MAX, Math.max(1, Math.floor(f.limit ?? 50)))
  return { requests: hits.slice(-limit), total: seen.length, matched: hits.length, withheld }
}

const LEVELS = ['debug', 'log', 'info', 'warn', 'error']
/**
 * The console messages at `level` or above (debug < log < info < warn < error), newest last, of
 * those `keep` lets through (agent-net.ts: none from a page Walnut signed the agent in on, kept per
 * message by the page that logged it, so navigating away does not open them; review 2026-11-07).
 * A message's place loses its query, as an address does.
 */
export function listConsole(r: NetRecord, f: { level?: string; limit?: number }, keep: (m: ConsoleEntry) => boolean = () => true): { messages: ConsoleEntry[]; total: number; withheld: number } {
  const lv = f.level ? LEVELS.indexOf(f.level === 'warning' ? 'warn' : f.level) : -1
  const rank = (l: string) => { const i = LEVELS.indexOf(l); return i < 0 ? 1 : i }
  const kept = r.console.filter(keep)
  const hits = lv < 0 ? kept : kept.filter((m) => rank(m.level) >= lv)
  const limit = Math.min(CONSOLE_MAX, Math.max(1, Math.floor(f.limit ?? 100)))
  return { messages: hits.slice(-limit).map((m) => (m.where ? { ...m, where: maskUrl(m.where.replace(/:\d+$/, '')) + (/:\d+$/.exec(m.where)?.[0] ?? '') } : m)), total: kept.length, withheld: r.console.length - kept.length }
}

export const BODY_MAX = 200_000
export const BODY_MAX_LIMIT = 1_000_000

/** A body as the agent gets it: text cut at `max` characters; bytes as base64, cut the same. */
export function bodyOut(raw: { body?: string; base64Encoded?: boolean }, max = BODY_MAX): { body: string; base64?: true; cut?: true; length: number } {
  const body = raw.body ?? ''
  const n = Math.min(BODY_MAX_LIMIT, Math.max(1000, Math.floor(max)))
  return { body: body.length > n ? body.slice(0, n) : body, ...(raw.base64Encoded ? { base64: true as const } : {}), ...(body.length > n ? { cut: true as const } : {}), length: body.length }
}
