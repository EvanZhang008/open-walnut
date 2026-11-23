/**
 * Who calls, as a route that acts on its caller's identity reads it off the request: the caller sid
 * header, the plugin job a credential vouches for (plugin-jobs/job-caller.ts vouchedPluginJob) and
 * the unproven mark (lib/caller-unproven.ts). The ONE reader for:
 *   - POST /tasks/:id/start and the start check (POST /tasks/start-check, task_start_check), so the
 *     check can never read a caller the start would not (tests/core/sessions/start-mode-ceiling-guard.test.ts
 *     holds both routes to it);
 *   - POST /messages, whose envelope names a vouched job as its App's job (session-send-core.ts).
 * The plugin headers (x-walnut-plugin-id / x-walnut-plugin-job) are not read here: anyone can set them.
 */
import type { IncomingHttpHeaders } from 'node:http'
import { callerUnprovenOf } from '../../lib/caller-unproven.js'
import { vouchedPluginJob, type VouchedJob } from '../plugin-jobs/job-caller.js'
import { CALLER_SID_HEADER } from '../../ops/executor.js'

export interface RequestCaller {
  /** The caller sid header, trimmed; undefined when none (the person's own CLI or UI). */
  callerSid?: string
  callerJob?: VouchedJob
  callerUnproven?: true
}

interface RequestLike {
  socket?: { remoteAddress?: string; localPort?: number }
  headers: IncomingHttpHeaders
}

export function requestCaller(req: RequestLike): RequestCaller {
  const raw = req.headers[CALLER_SID_HEADER]
  const callerSid = (Array.isArray(raw) ? raw[0] : raw ?? '').trim() || undefined
  const callerUnproven = callerUnprovenOf(req)
  // The unproven mark only lowers trust: whoever carries it is an outside caller, never a job
  // (as the ceiling and the host replica read it: delegated-mode.ts startCallerOf, start-ceiling.ts).
  const callerJob = callerUnproven ? undefined : vouchedPluginJob(req) ?? undefined
  return { ...(callerSid ? { callerSid } : {}), ...(callerJob ? { callerJob } : {}), ...(callerUnproven ? { callerUnproven } : {}) }
}
