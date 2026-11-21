/**
 * Who a plugin job's call is, on the server its host's daemon relays it to.
 *
 * A job runs on a host's daemon and calls Walnut ops (`walnut.ops.call`). The daemon relays those
 * calls under the anonymous caller sid `external`, which no route trusts: the start-mode ceiling
 * (sessions/delegated-mode.ts) caps it at `default`, so a job could not start its tasks in the
 * mode its plugin asks for (a ticket investigator's sessions run in `bypass`, as the user decided).
 *
 * The chain of trust, each link checked where it is made (the same chain trigger-caller.ts keeps
 * for a trigger check's call):
 *   1. The host's daemon stamps `caller: {kind: 'plugin-job', plugin, job, vouched: true}` on the
 *      relayed frame, `vouched` only once it checked the calling process descends from that job's
 *      own run (a run id alone is no proof: a session of the same user can read it). A frame
 *      without `vouched` (an older daemon, a host's own replica) names the job for provenance only,
 *      and gateway-answer.ts keeps `vouched` only when it is the literal `true`.
 *   2. daemon-connection.ts keeps it (as `call.pluginJob`) only when the call comes over that
 *      host's link, under the caller sid `external`, for a job this server gives that host now
 *      (plugin-jobs relayedJobOf).
 *   3. The relay (capability-router.ts) holds it here with the host whose link relayed it, only when
 *      it is vouched and the op can start a task, and gives the op's self-calls a token only this
 *      process made (holdRelayJob).
 *   4. A start route reads the token (vouchedPluginJob), only on a self-call made for that same
 *      anonymous caller from that same host, and capStartMode takes the job only for an outside
 *      caller, never for a session's sid.
 * A bare `x-walnut-plugin-id` / `x-walnut-plugin-job` pair names a job but vouches for none: the
 * routes (task-v1.ts, api-v1.ts, messages-v1.ts) take those headers from anyone, so the only thing
 * that lifts the ceiling is a credential vouchedPluginJob(req) reads.
 */
import { CALLER_JOB_HEADER, CALLER_PLUGIN_HEADER, CALLER_PLUGIN_JOB_HEADER, CALLER_SID_HEADER } from '../../ops/executor.js'
import { createRelayHold } from '../../lib/relay-hold.js'
import { hostOrigin } from '../../lib/caller-origin.js'
import { EXTERNAL_CALLER_SID } from '../../providers/gateway-core.js'
import { requestOrigin } from '../../web/middleware/request-origin.js'
import { log } from '../../logging/index.js'
import type { IncomingHttpHeaders } from 'node:http'

/** A plugin's job, as the host whose daemon runs it vouched for it. */
export interface VouchedJob { plugin: string; job: string; host: string }

const holds = createRelayHold<VouchedJob>({ ttlMs: 60_000, max: 500 })
/** The longest plugin or job id a relayed call keeps (plugin-jobs/index.ts RELAYED_JOB_ID_MAX). */
const PART_MAX = 120

function part(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const v = raw.trim()
  return v && v.length <= PART_MAX && !/[\s,]/.test(v) ? v : undefined
}

/** The ops whose calls the vouched job matters to: those that start a task (POST /tasks/:id/start). */
const START_PATH = '/tasks/:id/start'
const START_OPS = new Set(['task_create', 'task_start'])

/**
 * Whether a relayed op can start a task, so its self-calls need the job: task_create, task_start
 * and any op that declares the start route. A job's reads and other writes hold no token, so a
 * job that polls never fills the hold its starts need.
 */
export function opStartsTask(op: { name: string; bind?: { path?: string }; routes?: ReadonlyArray<{ path: string }> }): boolean {
  return START_OPS.has(op.name) || op.bind?.path === START_PATH || !!op.routes?.some((r) => r.path === START_PATH)
}

/**
 * Keep a relayed call's plugin job for the op's own calls; returns the token its self-calls carry.
 * `host` is the host whose daemon relayed the call (never one the caller named).
 */
export function holdRelayJob(job: { plugin: string; job: string } | undefined, host: string, now = Date.now()): string | undefined {
  const plugin = part(job?.plugin)
  const name = part(job?.job)
  const from = typeof host === 'string' ? host.trim() : ''
  if (!plugin || !name || !from) return undefined
  const token = holds.hold({ plugin, job: name, host: from }, now)
  // Full of live ones: the call goes on as the anonymous caller, capped (the start says so).
  if (!token) log.session.warn('plugin job caller: the hold is full; this call goes on as an outside caller', { plugin, job: name, host: from })
  return token
}

interface RequestLike {
  socket?: { remoteAddress?: string; localPort?: number }
  headers: IncomingHttpHeaders
}

function header(req: RequestLike, name: string): string | undefined {
  const raw = req.headers[name]
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

/**
 * The job a request's credential names, else null. Only on a self-call made for the call the job
 * was held for: the anonymous gateway caller, with the relaying host's origin, naming that plugin
 * and job if it names any. A token copied onto another call (a session's, another host's) or read
 * after its minute names none.
 */
export function vouchedPluginJob(req: RequestLike, now = Date.now()): VouchedJob | null {
  const held = holds.get(req.headers[CALLER_JOB_HEADER], now)
  if (!held) return null
  if (header(req, CALLER_SID_HEADER) !== EXTERNAL_CALLER_SID) return null
  // The self-call's origin is the relaying host's by construction (capability-router.ts), the link and not a session's host.
  if (requestOrigin(req) !== hostOrigin(held.host)) return null
  const plugin = header(req, CALLER_PLUGIN_HEADER)
  const name = header(req, CALLER_PLUGIN_JOB_HEADER)
  if ((plugin && plugin !== held.plugin) || (name && name !== held.job)) return null
  return { ...held }
}

/** A job as stored with a start that runs later (a workspace's replay), or null when malformed. */
export function storedVouchedJob(raw: unknown): VouchedJob | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const plugin = part(r.plugin)
  const job = part(r.job)
  const host = typeof r.host === 'string' && r.host.trim() ? r.host.trim() : undefined
  return plugin && job && host ? { plugin, job, host } : null
}

export function _clearRelayJobsForTesting(): void { holds.clear() }
