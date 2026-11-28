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
 *
 * `callerSidOrOutside` is the same rule for a route that hands the caller's session id to a core rule
 * reading "no session id" as the person (resolveCaller, resolveCallerPlacement, resolveBoardCaller,
 * answeredByCaller): "no session" there must mean the person, so any other caller that names none
 * goes on as an outside caller. Never pass the raw header to those (the ratchet:
 * tests/web/routes/no-sid-is-not-person-ratchet.test.ts).
 */
import type { Request } from 'express'
import { isRemoteHostOrigin } from '../../lib/caller-origin.js'
import { callerUnprovenOf } from '../../lib/caller-unproven.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { callerMarkedNotPerson, isPersonCaller, noSessionIsPerson } from './person-caller.js'

type CallerRequest = Parameters<typeof isPersonCaller>[0]

/** The sid resolveCaller reads as an outside caller (session-send-core.ts): never a session, never the person. */
export const OUTSIDE_CALLER_SID = 'external'

/** The session id the caller names (`x-walnut-caller-sid`), trimmed; undefined when it names none. */
export function callerSidHeader(req: CallerRequest): string | undefined {
  const raw = req.headers['x-walnut-caller-sid']
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined
}

/**
 * The caller's session id for a core rule that reads "none" as the person: its own, none only for the
 * person himself (isPersonCaller), else OUTSIDE_CALLER_SID (a local process with no proof, a script
 * marked as an automation, a call through a host's link that names no session).
 */
export function callerSidOrOutside(req: CallerRequest): string | undefined {
  return callerSidHeader(req) ?? (noSessionIsPerson(req) ? undefined : OUTSIDE_CALLER_SID)
}

/**
 * The caller's session id for words or acts recorded in the person's name (a message into a session,
 * a letter's answer, the person's Send now): callerSidOrOutside, and a caller that marked itself not
 * the person (person-caller.ts callerMarkedNotPerson) is an outside caller in every proof mode.
 * callerSidOrOutside keeps the old reading outside enforce for gates (a cron's task_start keeps its
 * mode); no gate may make a script's words his (2026-11-28: in observe, a deep-test notice a script
 * sent through task_send was stored as `sentBy: "person"`).
 */
export function wordsCallerSid(req: CallerRequest): string | undefined {
  return callerSidOrOutside(req) ?? (callerMarkedNotPerson(req) ? OUTSIDE_CALLER_SID : undefined)
}

export async function changedBy(req: Request): Promise<string> {
  const sid = callerSidHeader(req)
  const origin = requestOrigin(req)
  const via = isRemoteHostOrigin(origin) ? ` via ${origin}` : ''
  if (!sid) return isPersonCaller(req) ? 'human' : `agent${via}`
  const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
  const caller = await resolveCaller(sid).catch(() => null)
  const who = caller?.kind === 'session' && caller.record.taskId ? `task:${caller.record.taskId}` : 'agent'
  return `${who}${via}${callerUnprovenOf(req) ? ' (unproven)' : ''}`
}
