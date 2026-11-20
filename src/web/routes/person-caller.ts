/**
 * Who is a person on a request: no session id (`x-walnut-caller-sid`), no automation mark from the
 * CLI (`x-walnut-caller-kind`), and an origin that is this computer or a paired device (the phone,
 * through the companion too), never a session on another host. The one rule the person-only routes
 * share (approvals-v1.ts, browser-v1.ts, topics-v1.ts).
 *
 * Known limit, the same on every route that uses it: a process on this computer that leaves those
 * headers off passes as the person. So it guards against an agent working through Walnut's tools,
 * not against a hostile process here.
 *
 * `isPersonNotAutomation` adds: a browser under automation is never the person on the user's own
 * install (core/sessions/automated-client.ts; the middleware scopes it only there, so a throwaway
 * server's fixtures still stand in for the person).
 */
import type { Request } from 'express'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { ambientAutomatedClient } from '../../core/sessions/automated-client.js'
import { requestOrigin } from '../middleware/request-origin.js'

function header(req: Request, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** A person's own request (see the file comment). */
export function isPersonCaller(req: Request): boolean {
  const origin = requestOrigin(req)
  return !header(req, 'x-walnut-caller-sid') && !header(req, CALLER_KIND_HEADER)
    && (origin === LOCAL_ORIGIN || origin === REMOTE_HTTP_ORIGIN)
}

/** A person's own request, and no browser under automation (see the file comment). */
export function isPersonNotAutomation(req: Request): boolean {
  return isPersonCaller(req) && !ambientAutomatedClient()
}
