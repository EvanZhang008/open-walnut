/**
 * The Mac's requests to the box's /bridge/build door (wire.ts), and the Mac's
 * own record of the builds it gave up on. mac.ts drives the flow with these.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { fetchErrorText } from '../../lib/fetch-error.js'
import type { BoxBuildStatus } from './wire.js'

export type Endpoint = { url: string; token: string }
export interface Reply { status: number; json: Record<string, unknown> | null }

/** A request's error with the code fetch hides, on Node and on bun (src/lib/fetch-error.ts). */
export function requestError(err: unknown): string {
  return fetchErrorText(err)
}

/** One request to `<origin>/bridge/build<sub>`. Throws on a network error or the timeout. */

export async function call(ep: Endpoint, method: 'GET' | 'PUT' | 'POST', sub: string, body: Buffer | string | undefined, timeoutMs: number): Promise<Reply> {
  const headers: Record<string, string> = { Authorization: `Bearer ${ep.token}` }
  if (typeof body === 'string') headers['Content-Type'] = 'application/json'
  else if (body) headers['Content-Type'] = 'application/octet-stream'
  // A Buffer from fs over a plain ArrayBuffer is a valid body; the DOM type wants it said.
  const init: RequestInit = { method, headers, ...(body !== undefined ? { body: body as unknown as BodyInit } : {}), signal: AbortSignal.timeout(timeoutMs) }
  const res = await fetch(`${ep.url}/build${sub}`, init)
  const text = await res.text().catch(() => '')
  let json: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(text) as unknown
    json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { /* not JSON */ }
  return { status: res.status, json }
}

/**
 * A refusal before the door: a companion without it (404/405), or a credential
 * it does not take (401/403, bridge-ingest.ts `authenticate`). The door's own
 * answers always carry `ok`, whatever their status.
 */
export function doorRefusal(r: Reply): 'unmanaged' | 'refused' | null {
  if (r.json && typeof r.json.ok === 'boolean') return null
  if (r.status === 401 || r.status === 403) return 'refused'
  if (r.status === 404 || r.status === 405) return 'unmanaged'
  return null
}

function isStatus(json: Record<string, unknown> | null): json is Record<string, unknown> & BoxBuildStatus {
  const running = json?.running as { id?: unknown } | undefined
  return !!json && json.ok === true && typeof json.accepts === 'boolean' && typeof running?.id === 'string' && Array.isArray(json.failed)
}

export type Look =
  | { kind: 'ok'; status: BoxBuildStatus }
  | { kind: 'unmanaged'; httpStatus: number }
  | { kind: 'refused'; httpStatus: number }
  | { kind: 'error'; message: string }

/** GET the box's build status. Never throws. */
export async function look(ep: Endpoint, timeoutMs: number): Promise<Look> {
  let r: Reply
  try {
    r = await call(ep, 'GET', '', undefined, timeoutMs)
  } catch (err) {
    return { kind: 'error', message: requestError(err) }
  }
  const refusal = doorRefusal(r)
  if (refusal) return { kind: refusal, httpStatus: r.status }
  if (r.status === 200 && isStatus(r.json)) return { kind: 'ok', status: r.json }
  // An older companion answers an unknown path with its app shell.
  if (r.status === 200) return { kind: 'unmanaged', httpStatus: r.status }
  return { kind: 'error', message: `HTTP ${r.status}` }
}

const HASH_SLICE = 4 * 1024 * 1024

/** sha256 of a package of tens of MB, in slices with a turn of the loop between them. */
export async function sha256InSlices(buf: Buffer): Promise<string> {
  const hash = crypto.createHash('sha256')
  for (let i = 0; i < buf.length; i += HASH_SLICE) {
    hash.update(buf.subarray(i, i + HASH_SLICE))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return hash.digest('hex')
}

type GaveUp = Record<string, { why: string; at: number }>
const GAVE_UP_KEPT = 20

/** `{gaveUp: {[id]: {why, at}}}` in one file: read once, every change written atomically, in order. */
export function createGaveUpRecord(file: () => string) {
  let cache: GaveUp | null = null
  let writing: Promise<void> = Promise.resolve()
  const read = async (): Promise<GaveUp> => {
    if (cache) return cache
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file(), 'utf8')) as { gaveUp?: unknown }
      cache = parsed.gaveUp && typeof parsed.gaveUp === 'object' ? parsed.gaveUp as GaveUp : {}
    } catch {
      cache = {}
    }
    return cache
  }
  return {
    read,
    write(change: (map: GaveUp) => void): Promise<void> {
      writing = writing.then(async () => {
        const map = { ...(await read()) }
        change(map)
        const kept = Object.fromEntries(Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, GAVE_UP_KEPT))
        cache = kept
        const target = file()
        const tmp = `${target}.tmp-${process.pid}`
        await fs.promises.mkdir(path.dirname(target), { recursive: true })
        await fs.promises.writeFile(tmp, JSON.stringify({ gaveUp: kept }, null, 2))
        await fs.promises.rename(tmp, target)
      }).catch((err) => {
        log.session.warn('companion build: could not save what was given up', { error: err instanceof Error ? err.message : String(err) })
      })
      return writing
    },
    /** Every write asked for so far is on disk. */
    settled: (): Promise<void> => writing,
    forget(): void { cache = null },
  }
}
