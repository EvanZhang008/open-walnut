/**
 * The one exit of the file routes (`/api/file-content`, `/api/files`): every
 * sentence they answer about a remote host names it the way a person knows it.
 *
 * Errors from below the routes name a host by its alias on purpose (the daemon
 * pool's own messages are log lines and cause keys, host-display-name.ts), and
 * each route used to decide for itself whether to translate them. The read
 * paths did; the write paths did not, so a Save on the cloud box said "Could
 * not save on the remote host: DaemonConnection not connected to __cloudbox__"
 * and a new folder said the same (gate review, 2026-10-03). Here every answer
 * of these routes passes `inHostTerms` once, whatever the route wrote: the
 * sentence fields of a JSON body (`error`, `message`, `hint`, `staleReason`, at
 * the top and in the objects of a top-level list), and a plain-text body. File
 * content is never touched: only those named fields, and text only on an error.
 *
 * The host is the request's own `host` (query or JSON body). Its name is read
 * before the route runs, so the rewrite itself is synchronous, and kept for
 * NAME_TTL_MS: the Files tab sends many requests per second, and each config
 * read is a file read plus a YAML parse on the event loop.
 */
import type { NextFunction, Request, Response } from 'express'
import { hostDisplayNameFor, inHostTerms } from '../../core/hosts/host-display-name.js'

const SENTENCE_FIELDS = ['error', 'message', 'hint', 'staleReason'] as const

/** How long a host's name is reused (a rename in Settings shows within this). */
const NAME_TTL_MS = 10_000
const names = new Map<string, { name: string; at: number }>()

/** `host`'s display name, as the exit uses it (kept for NAME_TTL_MS). */
export async function exitHostName(host: string): Promise<string> {
  const kept = names.get(host)
  if (kept && Date.now() - kept.at < NAME_TTL_MS) return kept.name
  const name = await hostDisplayNameFor(host)
  names.set(host, { name, at: Date.now() })
  return name
}

/** Test seam: forget the kept names. */
export function resetHostTermsForTest(): void {
  names.clear()
}

function requestHost(req: Request): string | undefined {
  const fromQuery = req.query?.host
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery
  const fromBody = (req.body as { host?: unknown } | undefined)?.host
  return typeof fromBody === 'string' && fromBody ? fromBody : undefined
}

function rewriteFields(obj: Record<string, unknown>, host: string, name: string): Record<string, unknown> {
  let out: Record<string, unknown> | null = null
  for (const field of SENTENCE_FIELDS) {
    const v = obj[field]
    if (typeof v !== 'string') continue
    const next = inHostTerms(v, host, name)
    if (next !== v) (out ??= { ...obj })[field] = next
  }
  return out ?? obj
}

/** `body` with its sentences in the host's terms (a new object only when one changed). */
export function bodyInHostTerms(body: unknown, host: string, name: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  let out = rewriteFields(body as Record<string, unknown>, host, name)
  for (const [key, v] of Object.entries(out)) {
    if (!Array.isArray(v)) continue
    let changed = false
    const list = v.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      const next = rewriteFields(item as Record<string, unknown>, host, name)
      if (next !== item) changed = true
      return next
    })
    if (changed) out = { ...out, [key]: list }
  }
  return out
}

export function hostTermsAtExit(req: Request, res: Response, next: NextFunction): void {
  const host = requestHost(req)
  // Mounted on two routers that share a prefix: one rewrite per response.
  if (!host || res.locals.hostTermsAtExit) { next(); return }
  res.locals.hostTermsAtExit = true
  void exitHostName(host).then((name) => {
    if (name !== host) {
      const json = res.json.bind(res)
      res.json = ((body?: unknown) => json(bodyInHostTerms(body, host, name))) as Response['json']
      const send = res.send.bind(res)
      res.send = ((body?: unknown) => {
        // res.json serializes and comes back through here: its body is already done.
        const isJson = String(res.get('Content-Type') ?? '').includes('json')
        return send(typeof body === 'string' && res.statusCode >= 400 && !isJson ? inHostTerms(body, host, name) : body)
      }) as Response['send']
    }
    next()
  }, () => next())
}
