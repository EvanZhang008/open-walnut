/**
 * One command to an ACP worker that outlives its daemon ('acp-survive-v1'), asked until a daemon
 * answers it: when the link goes while the command waits (the host's daemon restarting), the same
 * command (the same `commandId`) is asked of the daemon that comes next. The worker answers a
 * command id it already took with its first answer (acp-worker/worker.ts checkDuplicate), so a
 * prompt, a steer, a permission answer or a cancel reaches the agent once, never twice. When no
 * daemon answers in time the caller gets `result unknown` (errorKind 'result_unknown'), never a
 * success it cannot know and never a second send.
 *
 * A worker on pipes (no survive) dies with its daemon: its commands fail as before.
 */
import { linkFailureKind, markLinkFailure } from './link-failure.js'

export interface AskConn {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

export class ResultUnknownError extends Error {
  readonly errorKind = 'result_unknown'
  constructor(readonly cmd: string, cause: unknown) {
    super(`${cmd}: result unknown. The link to the host's Walnut went before it answered and did not come back in time; the agent may have taken it. Read the session before sending it again.`)
    this.cause = cause
  }
}

/** The host still checks the worker that outlived its daemon (ps gave no answer for a minute): nothing was sent. */
export class WorkerAdoptingError extends Error {
  readonly errorKind = 'worker_adopting'
  constructor(detail: string) {
    super(`The agent's worker on the host outlived Walnut's restart there and could not be checked yet; nothing was sent. Try again in a minute. (${detail})`)
  }
}

export interface AskOnce {
  conn: AskConn
  /** The link now (a new one once the daemon is back); throws while there is none. */
  reconnect: () => Promise<AskConn>
  /** The worker outlives its daemon: a lost command is asked again. */
  survive: boolean
  cmd: string
  params: Record<string, unknown>
  timeoutMs?: number
  /** How long to wait for a daemon to answer after the link went. */
  waitMs?: number
  retryMs?: number
  /** How far apart a refusal while the worker is being adopted is asked again. */
  adoptStepMs?: number
}

/**
 * Asks while the host's daemon refuses because the worker that outlived the last daemon is still
 * being checked (`worker_adopting`: ps gave no answer yet), at most `waitMs`; then its last answer.
 * The refusal comes before the worker is reached, so asking again sends nothing twice.
 */
export async function untilAdopted(send: () => Promise<Record<string, unknown>>, o: { waitMs?: number; stepMs?: number } = {}): Promise<Record<string, unknown>> {
  const until = Date.now() + (o.waitMs ?? 60_000)
  for (;;) {
    const reply = await send()
    if (reply.ok !== false || reply.errorKind !== 'worker_adopting' || Date.now() >= until) return reply
    await new Promise((r) => setTimeout(r, o.stepMs ?? 2_000))
  }
}

export async function askOnce(o: AskOnce): Promise<Record<string, unknown>> {
  const adopt = { waitMs: o.waitMs, stepMs: o.adoptStepMs }
  // The call as the session made it before (no third argument when it named no timeout).
  const ask = (c: AskConn) => (o.timeoutMs === undefined ? c.send(o.cmd, o.params) : c.send(o.cmd, o.params, o.timeoutMs))
  if (!o.survive) return untilAdopted(() => ask(o.conn), adopt)
  const until = Date.now() + (o.waitMs ?? 60_000)
  let conn = o.conn
  let asked = false
  for (;;) {
    try {
      return await untilAdopted(() => ask(conn), adopt)
    } catch (err) {
      const kind = linkFailureKind(err)
      // The work's own failure, or a first ask that never reached the host: as before. After a
      // lost one, a link not back yet is waited for.
      if (kind !== 'lost' && !(asked && kind === 'no-link')) throw err
      asked = true
      for (;;) {
        if (Date.now() >= until) throw markLinkFailure(new ResultUnknownError(o.cmd, err), 'lost')
        await new Promise((r) => setTimeout(r, o.retryMs ?? 1_000))
        try { conn = await o.reconnect(); break } catch { /* not back yet */ }
      }
    }
  }
}
