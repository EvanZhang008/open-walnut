/**
 * The leader's start-mode ceiling (core/sessions/delegated-mode.ts) on a start this host's replica
 * makes itself while the Mac is away (away-starts.ts, ask-launch.ts). The rule is the leader's own
 * function (applyStartModeCeiling); only who the caller is gets read here, from what this replica
 * holds, never from the request body:
 *
 *   device       a paired device: the person, no ceiling
 *   session      its own mode, from this replica's sessions (the copy and the ones started here);
 *                a mode it cannot read is 'default' (fail closed)
 *   plugin-job   uncapped only when its host's daemon vouched for it: the same in-process token the
 *                leader reads (plugin-jobs/job-caller.ts vouchedPluginJob, held by the relay in
 *                capability-router.ts only for a frame the daemon stamped `vouched: true`), naming
 *                this job, on this replica's own self-call; else an outside caller, capped at 'default'
 *   unproven     a request carrying the unproven mark (lib/caller-unproven.ts: the host's daemon
 *                could not prove the session sid the relayed call names; this replica's own
 *                self-calls for it carry it): an outside caller whatever its actor, as on the leader
 */
import type { IncomingMessage } from 'node:http'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { START_CHECK_BAD_MODE, startCheckAnswer, startCheckMode, startModeVerdict, type StartCaller } from '../core/sessions/delegated-mode.js'
import { vouchedPluginJob, type VouchedJob } from '../core/plugin-jobs/job-caller.js'
import type { SessionMode } from '../core/types.js'
import { claimedOrigin } from '../web/middleware/request-origin.js'
import type { PortAnswer, WriteActor } from './write-port.js'
import { isSelfCall } from './write-actor.js'
import { callerUnprovenOf } from '../lib/caller-unproven.js'

export interface StartCallerDeps {
  /** A session's mode as this replica shows it, or undefined when it names none or cannot be read. */
  sessionMode(sid: string): Promise<string | undefined>
  /** The plugin job the request's in-process credential vouches for, or null (vouchedPluginJob). */
  vouchedJob(req: IncomingMessage): VouchedJob | null
}

/** Who asks for a start here, for the leader's ceiling. */
export async function awayStartCaller(req: IncomingMessage, actor: WriteActor, deps: StartCallerDeps): Promise<StartCaller> {
  // Before the actor: the mark only lowers trust, so whoever carries it is capped (delegated-mode.ts startCallerOf).
  if (callerUnprovenOf(req)) return { kind: 'external' }
  if (actor.kind === 'device') return { kind: 'person' }
  if (actor.kind === 'session') {
    const mode = await deps.sessionMode(actor.sid).catch(() => undefined)
    // startModeCeiling reads an unknown or absent mode as 'default'.
    return { kind: 'session', mode: mode as SessionMode | undefined }
  }
  const job = deps.vouchedJob(req)
  return job && job.plugin === actor.plugin && job.job === actor.job
    ? { kind: 'plugin-job', plugin: job.plugin, job: job.job, host: job.host }
    : { kind: 'external' }
}

/**
 * The mode a start here runs in, as the leader's task start caps it (task-start.ts startOrWait):
 * `{mode}` (undefined: none named and no ceiling, so the start's own default stands), or the
 * leader's refusal of a looser mode the caller asked for, a 403 that is final (nothing started,
 * never handed back to the daemon's own away answer).
 */
export async function capAwayStart(caller: StartCaller, requested: string | undefined, opts: { unproven?: boolean } = {}): Promise<{ mode: SessionMode | undefined } | { refused: PortAnswer }> {
  const verdict = startModeVerdict(caller, requested || undefined, { unproven: opts.unproven })
  if (!('refused' in verdict)) return verdict
  const { launchErrorCode } = await import('../core/sessions/mobile-launch.js')
  return { refused: { answered: false, status: 403, body: { error: { code: launchErrorCode(403), message: verdict.refused } } } }
}

export interface StartCheckDeps {
  /** Who the request acts for (write-actor.ts writeActorOf), or null: no known caller, an outside one. */
  actorOf(req: Request): WriteActor | null
  startCaller: StartCallerDeps
}

/**
 * POST /api/v1/tasks/start-check (task_start_check) on a host replica: the leader's answer
 * (web/routes/task-start-check-v1.ts) with this replica's reading of the caller (awayStartCaller),
 * so a job asks the same question whether the Mac answers or is away. It says only what the ceiling
 * decides: a start of a task made on the Mac still needs the Mac. Reads nothing else, writes nothing.
 */
export function awayStartCheck(deps: StartCheckDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method.toUpperCase() !== 'POST' || req.path.replace(/\/+$/, '') !== '/v1/tasks/start-check') { next(); return }
    void (async () => {
      const mode = startCheckMode(req.body)
      if (!mode) { res.status(400).json({ error: { code: 'bad_request', message: START_CHECK_BAD_MODE } }); return }
      const actor = deps.actorOf(req)
      // No actor (a token this replica does not know as a caller): an outside caller, capped.
      const caller: StartCaller = actor ? await awayStartCaller(req, actor, deps.startCaller) : { kind: 'external' }
      res.json(startCheckAnswer(caller, mode, { unproven: !!callerUnprovenOf(req) }))
    })().catch(next)
  }
}

/** The real reads on a host replica. */
export const replicaStartCaller: StartCallerDeps = {
  sessionMode: async (sid) => {
    const { getSessionByClaudeId } = await import('../core/session-tracker.js')
    const mode = (await getSessionByClaudeId(sid))?.mode
    return typeof mode === 'string' ? mode : undefined
  },
  // A host replica's every port is a tunnel port, so loopback proves nothing here: its own self-call
  // (the in-process credential) is what makes the origin header its own.
  vouchedJob: (req) => (isSelfCall(req) ? vouchedPluginJob(req, Date.now(), claimedOrigin(req)) : null),
}
