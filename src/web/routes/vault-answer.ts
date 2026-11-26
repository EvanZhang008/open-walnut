/**
 * How a vault route answers a refusal (a VaultError, a locked note's error, a fill-login's), in one place.
 *
 * Some refusals say what state the vault is in, which only the person (or a clock) changes: it is locked,
 * not set up, this device needs its Secret Key, agent access is Off, this task's asks are paused. A caller that waits for that state to change
 * asks again and again and gets the same answer each time. 2026-11-26: a trigger's check script asked
 * `password_list` every 2 minutes while the vault stayed locked overnight, one `423` warn line each, until
 * the log-spike alarm rang. The first such answer to a caller is the signal and logs at warn; a repeat
 * of it (same caller, route and code within the hour, core/hosts/repeat-answers.ts) is marked a repeat
 * answer and logs at info (web/middleware/handled-failure.ts). The response itself is unchanged.
 *
 * Every other refusal (a wrong password, a bad item, a stale write) keeps its warn line each time: a
 * repeat of one of those is news (someone guessing a password reads as many lines, not one).
 */
import type { Request, Response } from 'express'
import { noteFinalAnswer } from '../../core/hosts/repeat-answers.js'
import { markRepeatAnswer } from '../middleware/handled-failure.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { CALLER_KIND_HEADER } from '../../lib/cli-sender.js'

/**
 * The refusals that report a standing state, not a fault in the request: asking again unchanged gets
 * the same answer until the person acts or a clock runs out. tests/web/vault-answer.test.ts classifies
 * every vault code, so a new one is put here or on its list of request answers.
 */
export const VAULT_STATE_CODES: ReadonlySet<string> = new Set([
  'vault_locked', // the vault is locked (core/vault/state.ts)
  'vault_session_needed', // the vault is locked in this window
  'vault_not_set_up',
  'vault_not_here', // a follower holds no vault (a 5xx: the request log keeps its warn regardless)
  'secret_key_needed', // this device has not got the Secret Key yet
  'agents_off', // the person's agent switch
  'agent_paused', // asks of this task pause after the person said no several times
  'agent_rate', // releases to this task are rate limited for a window
  'too_many_asks', // this task's asks already wait for the person
])

function header(req: Request, name: string): string {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' ? v.trim().slice(0, 120) : ''
}

/** Mark `res` a repeat answer when `code` is a state answer this caller already got from this route. */
export function markVaultStateRepeat(res: Response, code: unknown): void {
  if (typeof code !== 'string' || !VAULT_STATE_CODES.has(code)) return
  const req = res.req as Request | undefined
  if (!req) return
  const route = String(req.originalUrl ?? req.url ?? '').split('?')[0]
  const caller = header(req, 'x-walnut-caller-sid') || header(req, CALLER_KIND_HEADER) || requestOrigin(req)
  if (noteFinalAnswer(`vault\u0000${req.method} ${route}\u0000${caller}\u0000${code}`) > 0) markRepeatAnswer(res)
}

/** Send a vault refusal: its status and body as given, marked a repeat when it is one (above). */
export function sendVaultRefusal(res: Response, status: number, body: Record<string, unknown>): void {
  markVaultStateRepeat(res, body.code)
  res.status(status).json(body)
}
