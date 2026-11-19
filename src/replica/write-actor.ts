/**
 * Who a host replica's away write acts for (write-port.ts WriteActor), read off the request
 * in one place for every away route (away-writes.ts, away-notes.ts, ask-launch.ts,
 * away-starts.ts):
 *
 *   Bearer <device token>      the paired device of the token (its stable id from the device copy)
 *   Bearer <self-call token>   one of this host's own `walnut` calls this replica runs itself
 *                              (local-calls.ts, only with the `host-local-calls` capability):
 *                              x-walnut-caller-sid names the session, else x-walnut-plugin-id
 *                              and x-walnut-plugin-job name the plugin job
 *
 * The self-call token lives in this process's memory only (lib/self-api-root.ts): it never
 * leaves the process, the dispatcher never forwards a request that carries it, and nothing
 * outside this process can show it. A request with it that names neither is no actor.
 */
import type { IncomingMessage } from 'node:http'
import { isSelfCallToken } from '../lib/self-api-root.js'
import { CALLER_PLUGIN_HEADER, CALLER_PLUGIN_JOB_HEADER } from '../ops/executor.js'
import type { WriteActor } from './write-port.js'

const SID_HEADER = 'x-walnut-caller-sid'
const EXTERNAL = 'external'

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] ?? '' : v ?? '').trim()
}

/** The Bearer token of a request, or ''. */
function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : ''
}

/** Whether the request is this process's own call (its in-process credential). */
export function isSelfCall(req: IncomingMessage): boolean {
  const token = bearer(req)
  return !!token && isSelfCallToken(token)
}

/** The local caller a self-call names, or null (no session and no plugin job named). */
export function localCallerOf(req: IncomingMessage): Exclude<WriteActor, { kind: 'device' }> | null {
  if (!isSelfCall(req)) return null
  const sid = header(req, SID_HEADER)
  if (sid && sid !== EXTERNAL && sid.length <= 200) return { kind: 'session', sid }
  const plugin = header(req, CALLER_PLUGIN_HEADER)
  const job = header(req, CALLER_PLUGIN_JOB_HEADER)
  if (plugin && job && plugin.length <= 120 && job.length <= 120) return { kind: 'plugin-job', plugin, job }
  return null
}

export interface ActorDeps {
  /** The paired device of a device token, or null (host-server/device-copy.ts verifyDevice). */
  verifyDevice(token: string): { id?: string | null; name?: string } | null
  /** Whether this replica answers its host's own calls (the `host-local-calls` capability). */
  localCalls(): boolean
}

/** The actor reader the away routes share. */
export function writeActorOf(deps: ActorDeps): (req: IncomingMessage) => WriteActor | null {
  return (req) => {
    if (isSelfCall(req)) return deps.localCalls() ? localCallerOf(req) : null
    const token = bearer(req)
    const d = token ? deps.verifyDevice(token) : null
    return d && d.id ? { kind: 'device', deviceId: d.id, ...(d.name !== undefined ? { name: d.name } : {}) } : null
  }
}
