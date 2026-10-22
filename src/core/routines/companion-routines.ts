/**
 * The cloud companion's routines (stage 4d of docs/plan/walnut-companion-unified-replica.md):
 * the Mac's engine owns cron-jobs.json, so the box's console (routes/cron.ts, through
 * routines-core.ts) never reads or writes the box's own engine for the Mac's jobs.
 *
 *   reads   the list, one routine and the status answer the `routines` copy once the
 *           box holds it (as the v1 reads do, routines-v1.ts); before, the Mac over
 *           `server.routines[.get|.status]`; a Mac that does not answer then: needs
 *           the Mac (`kind_not_copied`)
 *   writes  create, patch, delete, toggle, Run now, a trigger and a check test run on
 *           the Mac (`server.routines.*`, the same core there); a Mac that does not
 *           answer: needs the Mac (`routine_writes_need_mac`). Its refusal is its own
 *           status and words.
 *
 * The box's engine still runs (its own git sync and backup jobs: cron/jobs.ts
 * cloudModeSkipsJob), and the wake counter skips the Mac's jobs the same way
 * (wake-events.ts).
 */

import type { CronJob } from '../cron/types.js'
import { SessionControlError, type SessionControlAction } from '../sessions/session-controls.js'
import { NeedsLeaderError } from '../replication/needs-leader.js'
import { KIND_NOT_COPIED } from '../replication/kinds/gate.js'

const SERVER_RELAY_SID = '__server__'
/** The routine relays' budget (v1-control-relay.ts CONTROL_RELAY_TIMEOUT_MS). */
const RELAY_TIMEOUT_MS = 30_000
export const ROUTINE_WRITES_NEED_MAC = 'routine_writes_need_mac'

export type RoutineRelaySub = 'list' | 'get' | 'status' | 'create' | 'patch' | 'delete' | 'toggle' | 'run' | 'trigger' | 'check-test'

async function relay(sub: RoutineRelaySub, params: Record<string, unknown>, why: string): Promise<Record<string, unknown>> {
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
  const action = (sub === 'list' ? 'server.routines' : `server.routines.${sub}`) as SessionControlAction
  const r = await callPrimaryControl(action, SERVER_RELAY_SID, params, RELAY_TIMEOUT_MS)
  if (r.ok) return r.result
  if (r.failure.kind === 'error') throw new SessionControlError(r.failure.message, r.failure.status, { code: r.failure.code })
  if (r.failure.kind === 'needs_upgrade') throw new SessionControlError(r.failure.message, 400)
  throw new NeedsLeaderError(why)
}

async function copy(includeDisabled: boolean): Promise<CronJob[] | null> {
  const { companionRoutinesCopy } = await import('../replication/kinds/routines-follower.js')
  return companionRoutinesCopy({ includeDisabled })
}

export async function companionListRoutines(includeDisabled: boolean): Promise<{ jobs: unknown[] }> {
  const jobs = await copy(includeDisabled)
  if (jobs) return { jobs }
  return await relay('list', { includeDisabled }, KIND_NOT_COPIED) as { jobs: unknown[] }
}

export async function companionGetRoutine(id: string): Promise<{ job: unknown }> {
  const jobs = await copy(true)
  if (!jobs) return await relay('get', { id }, KIND_NOT_COPIED) as { job: unknown }
  const job = jobs.find((j) => j.id === id)
  if (!job) throw new SessionControlError(`Cron job not found: ${id}`, 404)
  return { job }
}

/** As a host replica reports it (routines-core.ts): the copy's count, the engine not running here. */
export async function companionRoutinesStatus(): Promise<Record<string, unknown>> {
  const jobs = await copy(true)
  if (jobs) return { enabled: false, storePath: '', jobs: jobs.length, nextWakeAtMs: null }
  return relay('status', {}, KIND_NOT_COPIED)
}

/** One routine write, run on the Mac. */
export function companionRoutineWrite(sub: Exclude<RoutineRelaySub, 'list' | 'get' | 'status'>, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return relay(sub, params, ROUTINE_WRITES_NEED_MAC)
}
