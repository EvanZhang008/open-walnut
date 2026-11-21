/**
 * The frozen /api/v1 says `""` for the Inbox, as it did before the Inbox was a real project
 * (docs/reference/api-v1.md, v1ProjectName in src/core/inbox-project.ts): an installed phone app
 * shows one fixed Inbox entry, groups on `""` and keeps its saved `""` filters.
 *
 * One place for every JSON answer of /api/v1: any `project` field naming the Inbox is written
 * `""`, however deep (a task, a folder, a task inside a board card), so a route added later
 * keeps the contract without knowing it. Copy-on-write: an answer is never changed in place
 * (it may be the store's own objects), and one with nothing to change is passed as it is.
 * The events stream does not go through res.json; its tasks are shaped by projectTask, which
 * applies the same rule.
 */
import type { Request, Response, NextFunction } from 'express'
import { isInboxProject } from '../../core/inbox-project.js'

const MAX_DEPTH = 12

/** `body` with every `project` that names the Inbox as `""` (the same reference when none does). */
export function inboxOnV1Wire<T>(body: T, depth = 0): T {
  if (depth > MAX_DEPTH || body === null || typeof body !== 'object') return body
  if (Array.isArray(body)) {
    let out: unknown[] | null = null
    for (let i = 0; i < body.length; i++) {
      const next = inboxOnV1Wire(body[i], depth + 1)
      if (next !== body[i]) {
        out ??= body.slice()
        out[i] = next
      }
    }
    return (out ?? body) as T
  }
  if (Object.getPrototypeOf(body) !== Object.prototype && Object.getPrototypeOf(body) !== null) return body
  const src = body as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const key of Object.keys(src)) {
    const value = src[key]
    const next = key === 'project' && typeof value === 'string'
      ? (value !== '' && isInboxProject(value) ? '' : value)
      : inboxOnV1Wire(value, depth + 1)
    if (next !== value) {
      out ??= { ...src }
      out[key] = next
    }
  }
  return (out ?? body) as T
}

/** Mounted on /api/v1 before every v1 router (server.ts). */
export function v1InboxWire(_req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res)
  res.json = ((body?: unknown) => json(inboxOnV1Wire(body))) as Response['json']
  next()
}
