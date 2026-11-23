/**
 * Who asks for a start, as a start route reads it off its request: the caller sid header, the
 * plugin job a credential vouches for (plugin-jobs/job-caller.ts vouchedPluginJob) and the unproven
 * mark (lib/caller-unproven.ts). The ONE reader for POST /tasks/:id/start and for the start check
 * (POST /tasks/start-check, task_start_check), so the check can never read a caller the start would
 * not (tests/core/sessions/start-mode-ceiling-guard.test.ts holds both routes to it).
 */
import type { IncomingHttpHeaders } from 'node:http'
import { callerUnprovenOf } from '../../lib/caller-unproven.js'
import { vouchedPluginJob, type VouchedJob } from '../plugin-jobs/job-caller.js'
import { CALLER_SID_HEADER } from '../../ops/executor.js'

export interface StartRequestCaller {
  /** The caller sid header, trimmed; undefined when none (the person's own CLI or UI). */
  callerSid?: string
  callerJob?: VouchedJob
  callerUnproven?: true
}

interface RequestLike {
  socket?: { remoteAddress?: string; localPort?: number }
  headers: IncomingHttpHeaders
}

export function startRequestCaller(req: RequestLike): StartRequestCaller {
  const raw = req.headers[CALLER_SID_HEADER]
  const callerSid = (Array.isArray(raw) ? raw[0] : raw ?? '').trim() || undefined
  const callerJob = vouchedPluginJob(req) ?? undefined
  const callerUnproven = callerUnprovenOf(req)
  return { ...(callerSid ? { callerSid } : {}), ...(callerJob ? { callerJob } : {}), ...(callerUnproven ? { callerUnproven } : {}) }
}
