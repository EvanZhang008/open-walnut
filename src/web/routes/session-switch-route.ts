/**
 * What the task routes that start a new session for a task (switch-engine, move) share: who
 * called, and how a refusal is answered (its status, its words, its code and its facts).
 */
import type { NextFunction, Request, Response } from 'express'
import { QuickStartError } from '../../core/sessions/quick-start.js'
import { callerSidOrOutside } from './changed-by.js'

/** Who called: its session, none only for the person's own request, else an outside caller (changed-by.ts). */
export const callerSid: (req: Request) => string | undefined = callerSidOrOutside

/** A refusal with a status answers as itself; `detail` (a sign-in refusal's engine and host) rides along, never over error or code. */
export function sendSwitchError(res: Response, err: unknown, next: NextFunction): void {
  const status = (err as { status?: number }).status
  if (typeof status === 'number') {
    const detail = (err as { detail?: Record<string, unknown> }).detail
    res.status(status).json({ ...(detail ?? {}), error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code })
    return
  }
  // The new session's start was refused with its own answer (task-start.ts): a setting is 422 engine_config.
  if (err instanceof QuickStartError && typeof err.body?.code === 'string') {
    res.status(err.statusCode).json({ error: err.message, code: err.body.code })
    return
  }
  next(err)
}
