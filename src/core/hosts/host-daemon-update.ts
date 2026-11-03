/**
 * Update a host's Walnut daemon to this server's build now, on request
 * (`host_daemon_update`, POST /api/v1/hosts/:host/daemon-update). For a machine on
 * the host network whose config says `autofix: false`, this is the only way it is
 * updated (src/providers/daemon-net-update.ts): someone guards that machine and
 * picks the moment. A task's session asks under the same grant rules as host_exec
 * (the user's grant for the task and host, asked once by letter; a host the user
 * closed refuses); the person at this machine needs none.
 *
 * The answer comes as soon as the update is decided or started (the upload and the
 * handover take minutes); asking again tells how it went.
 */
import { HostExecError, callerOf, hostName, targetHost } from './host-exec.js'
import { grantFor } from './host-exec-grant.js'

const LOCAL = '__local__'
/** A session on another host reaches this through its gateway, which gives up at 20 s: dial plus decision stay under it. */
const DIAL_MS = 8_000

/** Why a host of this kind is not updated this way, in the words the answer gives. */
const OTHER_PATH: Record<string, string> = {
  local: 'this Mac\'s daemon is updated by Walnut itself whenever it starts or reconnects',
  ssh: 'Walnut updates the daemon on a host it reaches over SSH by itself when it connects there',
  'cloud-tunnel': 'the cloud companion starts that daemon from its own build; deploying the companion updates it',
  'direct-url': 'this host is a test daemon reached by its URL',
}

export async function requestHostDaemonUpdate(raw: string, callerSid: string | undefined): Promise<Record<string, unknown>> {
  let host: string
  if (callerSid) {
    const caller = await callerOf(callerSid)
    host = await targetHost(raw, caller, 'ask from a session on another host, or the user asks from the Mac')
    await grantFor(caller, host, `walnut daemon update (to this server's build) on ${host}`)
  } else {
    host = raw.trim() === 'local' ? LOCAL : raw.trim()
    if (host !== LOCAL) {
      const { getConfig } = await import('../config-manager.js')
      if (!Object.hasOwn((await getConfig()).hosts ?? {}, host)) throw new HostExecError(`Unknown host: ${host} (host_list names them)`, 404, 'unknown_host')
    }
  }
  const name = await hostName(host)
  const { link } = await import('./link.js')
  let timer: ReturnType<typeof setTimeout> | undefined
  const conn = await Promise.race([
    link(host),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dial timeout')), DIAL_MS) }),
  ]).catch(async (err) => {
    throw new HostExecError(`Walnut cannot reach ${name} right now (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline')
  }).finally(() => clearTimeout(timer))
  const run = conn.requestDaemonUpdate()
  if (!run) {
    throw new HostExecError(`Nothing to ask for ${name}: ${OTHER_PATH[conn.linkKind] ?? 'its daemon is updated another way'}.`, 409, 'updates_itself', { kind: conn.linkKind })
  }
  return { ...(await run), host }
}
