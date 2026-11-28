/**
 * Who is a person on a request: no session id (`x-walnut-caller-sid`), no automation mark from the
 * CLI (`x-walnut-caller-kind`), and an origin that is this computer or a paired device (the phone,
 * through the companion too), never a session on another host. The one rule the person-only routes
 * share (approvals-v1.ts, browser-v1.ts, topics-v1.ts).
 *
 * A request from this computer needs more: what only the person's own clients send, a browser's
 * fetch metadata or the person's `walnut` CLI (local-person-proof.ts), so a bare local process (a
 * session's own `curl localhost`) is not the person. A process that forges those headers on purpose
 * still passes: this guards against an agent's plain request, not against a hostile program here.
 *
 * `isPersonNotAutomation` adds: a browser under automation is never the person on the user's own
 * install (core/sessions/automated-client.ts; the middleware scopes it only there, so a throwaway
 * server's fixtures still stand in for the person). `isPersonInOwnWindow` adds that the request is
 * no test run (core/test-run.ts) and no call another Walnut forwards here (the cloud companion's
 * forward keeps none of the caller's session headers, so every call it forwards would read as the
 * person): the one rule for what reads or writes a hidden note's text, hides or unhides one, and
 * moves, copies or deletes a hidden or locked note (docs/reference/locked-notes.md).
 */
import type { IncomingHttpHeaders } from 'node:http'
import type { Request } from 'express'
import { LOCAL_ORIGIN, REMOTE_HTTP_ORIGIN } from '../../lib/caller-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'
import { ambientAutomatedClient } from '../../core/sessions/automated-client.js'
import { ambientTestRun } from '../../core/test-run.js'
import { isOnBehalfOfRemote, requestOrigin } from '../middleware/request-origin.js'
import { claimedRemoteStands, loopbackPersonStands } from './local-person-proof.js'
import { classifyLocalRequest } from '../middleware/local-trust.js'

/** What the rule reads of a request: its headers and its socket (an HTTP request, or a WebSocket upgrade). */
type CallerRequest = { headers: IncomingHttpHeaders; socket?: { remoteAddress?: string; localPort?: number }; url?: string; method?: string }

function header(req: CallerRequest, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/** A person's own request (see the file comment); a `/ws` upgrade reads the same (ws/handler.ts). */
export function isPersonCaller(req: CallerRequest, opts: { quiet?: boolean } = {}): boolean {
  const origin = requestOrigin(req)
  if (header(req, 'x-walnut-caller-sid') || header(req, CALLER_KIND_HEADER)) return false
  if (origin === REMOTE_HTTP_ORIGIN) {
    // A paired device's own socket, or this server's forward for one; never a loopback claim alone.
    return !classifyLocalRequest(req).trusted || claimedRemoteStands(req, opts)
  }
  // This computer: only with what the person's own clients send (local-person-proof.ts).
  return origin === LOCAL_ORIGIN && loopbackPersonStands(req, opts)
}

/** A person's own request, and no browser under automation (see the file comment). */
export function isPersonNotAutomation(req: Request): boolean {
  return isPersonCaller(req) && !ambientAutomatedClient()
}

/** The person in their own window: no session, no automation, no test run, no forwarded call (see the file comment). */
export function isPersonInOwnWindow(req: Request): boolean {
  return isPersonNotAutomation(req) && !ambientTestRun() && !isOnBehalfOfRemote(req)
}
