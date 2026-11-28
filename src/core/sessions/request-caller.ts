/**
 * Who calls, as a route that acts on its caller's identity reads it off the request: the caller sid
 * header, the plugin job a credential vouches for (plugin-jobs/job-caller.ts vouchedPluginJob) and
 * the unproven mark (lib/caller-unproven.ts). The ONE reader for:
 *   - POST /tasks/:id/start and the start check (POST /tasks/start-check, task_start_check), so the
 *     check can never read a caller the start would not (tests/core/sessions/start-mode-ceiling-guard.test.ts
 *     holds both routes to it);
 *   - POST /messages, whose envelope names a vouched job as its App's job (session-send-core.ts).
 * The plugin headers (x-walnut-plugin-id / x-walnut-plugin-job) are not read here: anyone can set them.
 *
 * "No sid" is the person only for the person's own request (web/routes/person-caller.ts): any other
 * caller that names no session (a local process with no proof, a script marked as an automation, a
 * call through a host's link) reads as an outside caller (web/routes/changed-by.ts callerSidOrOutside).
 */
import type { IncomingHttpHeaders } from 'node:http'
import { callerUnprovenOf } from '../../lib/caller-unproven.js'
import { vouchedPluginJob, type VouchedJob } from '../plugin-jobs/job-caller.js'
import { callerSidHeader, callerSidOrOutside } from '../../web/routes/changed-by.js'

export interface RequestCaller {
  /** The caller sid header, trimmed; undefined only for the person, `external` for another caller that names none. */
  callerSid?: string
  /** The caller named no session and is not the person: callerSid is the outside caller's. */
  outside?: true
  callerJob?: VouchedJob
  callerUnproven?: true
}

interface RequestLike {
  socket?: { remoteAddress?: string; localPort?: number }
  headers: IncomingHttpHeaders
}

export function requestCaller(req: RequestLike): RequestCaller {
  const callerSid = callerSidOrOutside(req)
  const outside = !!callerSid && !callerSidHeader(req)
  const callerUnproven = callerUnprovenOf(req)
  // The unproven mark only lowers trust: whoever carries it is an outside caller, never a job
  // (as the ceiling and the host replica read it: delegated-mode.ts startCallerOf, start-ceiling.ts).
  const callerJob = callerUnproven ? undefined : vouchedPluginJob(req) ?? undefined
  return { ...(callerSid ? { callerSid } : {}), ...(outside ? { outside: true as const } : {}), ...(callerJob ? { callerJob } : {}), ...(callerUnproven ? { callerUnproven } : {}) }
}
