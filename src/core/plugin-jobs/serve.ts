/**
 * The leader's half of a plugin job that serves its plugin's routes (`"serves": true`).
 * A request to `/api/plugins/<id>/*` that no route of the plugin's server half answers
 * (web/plugin-route-dispatcher.ts) comes here when the plugin's manifest has such a job,
 * and goes to the daemon of the machine the job runs on (`plugin_jobs.<id>.run_on`) as
 * `jobs.http`, over the link the manager already keeps to it (manager.ts serveTarget):
 *
 *   browser ─► dispatcher ─► forwardJobRoute ─► daemon `jobs.http` ─► the job's socket
 *
 * The request carries what a plugin route gets (its method, in-plugin path with the
 * query, headers with the caller's origin) and never the caller's credentials: the same
 * rules and limits as the cloud relay (plugins/plugin-http-rules.ts), except that its body is
 * at most 256 KB (an upload to the job's machine; the answer may be 2 MB), and its answer never
 * sets a cookie on Walnut's origin. The daemon gives the job 9 s (providers/plugin-job-door.ts);
 * the leader waits 10 s for the daemon, inside the 12 s the Mac gives a request the companion
 * relayed, so a browser connection is never held. No machine to ask, a daemon without
 * `plugin-jobs-serve-v1`, or a job that is not running answers 503 with a plain reason, at once.
 * A link that went away while it waited answers 502 (the request may have run: never resent).
 */

import {
  isRelayablePluginPath,
  MAX_PLUGIN_HTTP_BODY_BYTES,
  MAX_PLUGIN_JOB_REQUEST_BODY_BYTES,
  PLUGIN_HTTP_METHODS,
  PluginHttpRuleError,
  relayedPluginHeaders,
} from '../plugins/plugin-http-rules.js'
import { withDeadline } from '../../lib/with-deadline.js'
import { linkFailureKind } from '../../providers/link-failure.js'
import { jobsVerdict, type JobsHost } from './manager.js'
import { servingJobOf, type PluginJobDeclaration } from './manifest.js'

/** How long the leader waits for the daemon's answer; the daemon's own forward is 9 s. */
export const JOB_ROUTE_TIMEOUT_MS = 10_000
/** A job that is not running yet is usually back within a few seconds (its first restart is 5 s on). */
const RETRY_AFTER_S = 5
/** The longest Retry-After the daemon's own word sets (a job backing off for minutes still gets asked again). */
const MAX_RETRY_AFTER_S = 60

export interface JobRouteRequest {
  pluginId: string
  method: string
  /** In the plugin, with its query: `/items?limit=5`. */
  path: string
  headers: Record<string, string>
  body: Buffer
}

export interface JobRouteResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** Why a request did not reach the job, as the HTTP answer the browser gets. */
export class JobRouteError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterS?: number) {
    super(message)
    this.name = 'JobRouteError'
  }
}

export interface JobRouteDeps {
  home: string
  serveTarget(pluginId: string): Promise<{ handle: JobsHost; where: string } | { error: string; retryAfterS?: number }>
  timeoutMs?: number
}

/** The daemon's refusal codes (plugin-jobs-core.ts http, plugin-job-door.ts) as HTTP statuses. */
const STATUS_OF: Record<string, number> = {
  bad_request: 400, request_too_large: 413, too_large: 502, timeout: 504, bad_answer: 502, no_answer: 502,
  not_serving: 503, not_running: 503, not_ready: 503, busy: 503, unsupported: 503,
}
const RETRY_OF = new Set(['not_running', 'not_ready', 'busy'])

/** The daemon's refusal as the browser's answer; its `retryAfterS` (when the job starts again) bounded. */
function refusalOf(r: Record<string, unknown>): JobRouteError {
  const code = typeof r.errorKind === 'string' ? r.errorKind : ''
  const said = typeof r.retryAfterS === 'number' && Number.isFinite(r.retryAfterS) ? Math.round(r.retryAfterS) : undefined
  const retry = RETRY_OF.has(code) ? Math.min(MAX_RETRY_AFTER_S, Math.max(1, said ?? RETRY_AFTER_S)) : undefined
  return new JobRouteError(String(r.error ?? 'the job did not answer'), STATUS_OF[code] ?? 502, retry)
}

/** A send that failed: the link's failure by its kind (providers/link-failure.ts), never by its words. */
function linkErrorOf(error: unknown, where: string, timeoutMs: number): JobRouteError {
  const message = error instanceof Error ? error.message : String(error)
  switch (linkFailureKind(error)) {
    case 'no-link': return new JobRouteError(`${where} could not be reached: ${message}`, 503, RETRY_AFTER_S)
    case 'lost': return new JobRouteError(`the link to ${where} closed before it answered; the request may have run there`, 502)
    case 'no-answer': return new JobRouteError(`${where} did not answer within ${Math.round(timeoutMs / 1000)} s`, 504)
    default: return new JobRouteError(`${where} could not be asked: ${message}`, 502)
  }
}

/** Never from a job's answer: a cookie on Walnut's own origin (the server half sets its own). */
const UNRELAYED_ANSWER_HEADERS = new Set(['set-cookie', 'set-cookie2'])

export async function forwardJobRoute(deps: JobRouteDeps, request: JobRouteRequest): Promise<JobRouteResponse> {
  const method = request.method.toUpperCase()
  if (!PLUGIN_HTTP_METHODS.has(method)) throw new JobRouteError('Unsupported Plugin HTTP method', 405)
  if (!isRelayablePluginPath(request.path)) throw new JobRouteError('Invalid Plugin HTTP path', 400)
  if (request.body.byteLength > MAX_PLUGIN_JOB_REQUEST_BODY_BYTES) {
    throw new JobRouteError(`the request body is ${Math.ceil(request.body.byteLength / 1024)} KB, more than the ${MAX_PLUGIN_JOB_REQUEST_BODY_BYTES / 1024} KB a plugin job's route takes (its answer may be up to ${MAX_PLUGIN_HTTP_BODY_BYTES / (1024 * 1024)} MB)`, 413)
  }
  if ((method === 'GET' || method === 'HEAD') && request.body.byteLength > 0) throw new JobRouteError(`${method} Plugin requests cannot have a body`, 400)
  let headers: Record<string, string>
  try { headers = relayedPluginHeaders(request.headers, 'drop') } catch (error) {
    if (error instanceof PluginHttpRuleError) throw new JobRouteError(error.message, error.status)
    throw error
  }
  const target = await deps.serveTarget(request.pluginId)
  if ('error' in target) throw new JobRouteError(target.error, 503, target.retryAfterS)
  const timeoutMs = deps.timeoutMs ?? JOB_ROUTE_TIMEOUT_MS
  let r: Record<string, unknown>
  try {
    // The connection's own deadline, and a backstop half a second on in case it never fires.
    r = await withDeadline(
      target.handle.send('jobs.http', {
        home: deps.home, plugin: request.pluginId, method, path: request.path, headers,
        size: request.body.byteLength, data: request.body.toString('base64'),
      }, timeoutMs),
      timeoutMs + 500,
      () => { throw new JobRouteError(`${target.where} did not answer within ${Math.round(timeoutMs / 1000)} s`, 504) },
    )
  } catch (error) {
    if (error instanceof JobRouteError) throw error
    throw linkErrorOf(error, target.where, timeoutMs)
  }
  if (r.ok !== true) throw refusalOf(r)
  const { status, size, data } = r
  if (
    typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > MAX_PLUGIN_HTTP_BODY_BYTES
    || typeof data !== 'string' || !r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)
  ) throw new JobRouteError('the job answered with something that is not an HTTP response', 502)
  const body = Buffer.from(data, 'base64')
  if (body.byteLength !== size) throw new JobRouteError('the job\'s answer is not the size it says', 502)
  let responseHeaders: Record<string, string>
  const answered = Object.fromEntries(Object.entries(r.headers as Record<string, unknown>).filter(([name]) => !UNRELAYED_ANSWER_HEADERS.has(name.toLowerCase())))
  try { responseHeaders = relayedPluginHeaders(answered, 'drop') } catch (error) {
    if (error instanceof PluginHttpRuleError) throw new JobRouteError(`the job's answer: ${error.message}`, 502)
    throw error
  }
  return { status, headers: responseHeaders, body }
}

/** A plugin as the dispatcher's check needs it (integration-loader.ts getPluginJobSources). */
export interface JobRouteSource { id: string; state: string; jobs: Record<string, PluginJobDeclaration> }

/** Whether a plugin's routes may come from its job: one serves, and the plugin is not off. */
export function servesFromJob(sources: JobRouteSource[], pluginId: string): boolean {
  const s = sources.find((x) => x.id === pluginId)
  return !!s && jobsVerdict(s.state) !== 'stop' && servingJobOf(s.jobs) !== undefined
}

/** The dispatcher's `jobs` option on the leader (web/plugin-route-dispatcher.ts). */
export function pluginJobRoutes(sources: () => JobRouteSource[]): {
  serves(pluginId: string): boolean
  forward(request: JobRouteRequest): Promise<JobRouteResponse>
} {
  return {
    serves: (pluginId) => servesFromJob(sources(), pluginId),
    forward: async (request) => (await import('./index.js')).forwardPluginJobRoute(request),
  }
}
