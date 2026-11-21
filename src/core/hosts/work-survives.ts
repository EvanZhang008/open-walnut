/**
 * Whether this server asks a host to run work so it outlives the host's daemon (the experiment
 * `work_survives_restart`, off by default): a host_exec run (`detach`), a plugin script
 * (`scriptId` + `detach`) and an ACP worker (`survive`). Each is asked only of a daemon that says
 * the matching capability; without the switch or the capability the work runs on the daemon's pipes
 * as before, and an older daemon never sees a field it does not know.
 */
import { experimentCache } from '../experimental-cache.js'

export const HOST_EXEC_DETACH_CAPABILITY = 'host-exec-detach-v1'
export const HOST_SCRIPT_DETACH_CAPABILITY = 'host-script-detach-v1'
export const ACP_SURVIVE_CAPABILITY = 'acp-survive-v1'

const flag = experimentCache('work_survives_restart')

interface CapConn { hasCapability?(name: string): boolean }

/** True when the switch is on and the daemon behind `conn` follows `capability`. */
export async function workSurvives(conn: CapConn, capability: string): Promise<boolean> {
  if (typeof conn.hasCapability !== 'function' || !conn.hasCapability(capability)) return false
  return flag.on()
}
