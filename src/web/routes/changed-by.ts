/**
 * Who made a change through a route (CLAUDE.md, "Every human action is an agent action too"): the
 * calling session's task (`task:<id>`), another session ('agent'), else a person ('human'). Every
 * route that records `by` on a write takes this one rule.
 *
 * The session id a caller sends is its own word, so `by` adds what the server itself knows: a call
 * that came through a host's link (x-walnut-origin `host:<key>`, which the server sets and a caller
 * can only lower) says ` via host:<key>`, a session id the host's daemon could not prove says
 * ` (unproven)`, and only a person's own request (person-caller.ts: no session id, no automation
 * mark, this machine or a paired device) reads `human`; any other call with no session is 'agent'.
 */
import type { Request } from 'express'
import { isRemoteHostOrigin } from '../../lib/caller-origin.js'
import { callerUnprovenOf } from '../../lib/caller-unproven.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { isPersonCaller } from './person-caller.js'

export async function changedBy(req: Request): Promise<string> {
  const raw = req.headers['x-walnut-caller-sid']
  const sid = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  const origin = requestOrigin(req)
  const via = isRemoteHostOrigin(origin) ? ` via ${origin}` : ''
  if (!sid) return isPersonCaller(req) ? 'human' : `agent${via}`
  const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
  const caller = await resolveCaller(sid).catch(() => null)
  const who = caller?.kind === 'session' && caller.record.taskId ? `task:${caller.record.taskId}` : 'agent'
  return `${who}${via}${callerUnprovenOf(req) ? ' (unproven)' : ''}`
}
