/**
 * The Demo's stop ends the SSH ControlMasters its own data dir holds.
 *
 * A server that stops keeps its masters for the next process (ssh-control-master.ts,
 * ControlPersist ends them later). A Demo that stops is not coming back to this data dir:
 * its reset removes it, and the reset refuses while a process of the generation still runs.
 * A master left that way (and a ProxyCommand it runs) held a reset for up to ControlPersist
 * (2026-11-12: a found host that connected through `ProxyCommand` left its master and the
 * proxy; the reset said "4 processes started in the Demo are still running").
 *
 * The sockets are named exactly as the connections name them: the daemon link's
 * (controlSocketPath with this data dir and the host's target) and the terminal's
 * (terminalControlSocket). Each is ended through its own socket only, with no ssh config
 * (exitOwnedControlMaster), and only when it is this user's socket.
 */
import type { Config } from '../core/types.js'
import { masterTargetIdentity } from '../providers/ssh-control-master.js'

type HostDef = NonNullable<Config['hosts']>[string]

export interface DemoSshMasterDeps {
  hosts(): Promise<Record<string, HostDef>>
  daemonSocket(host: string, target: string): string
  terminalSocket(host: string): string
  /** True when a master was there and was asked to exit. */
  end(socket: string, host: string): Promise<boolean>
}

/** End this data dir's masters; returns the sockets that had one. Never throws. */
export async function endDemoSshMasters(deps?: DemoSshMasterDeps): Promise<string[]> {
  const d = deps ?? await defaultDeps()
  const hosts = await d.hosts().catch(() => ({} as Record<string, HostDef>))
  const ended: string[] = []
  for (const [host, def] of Object.entries(hosts)) {
    if (!def || typeof def.hostname !== 'string' || !def.hostname || def.transport === 'net') continue
    for (const socket of new Set([d.daemonSocket(host, masterTargetIdentity(def)), d.terminalSocket(host)])) {
      if (await d.end(socket, host).catch(() => false)) ended.push(socket)
    }
  }
  return ended
}

async function defaultDeps(): Promise<DemoSshMasterDeps> {
  const [{ getConfig }, { controlSocketPath, exitOwnedControlMaster }, { terminalControlSocket }, { WALNUT_HOME }] = await Promise.all([
    import('../core/config-manager.js'),
    import('../providers/ssh-control-master.js'),
    import('../web/terminal/spawn.js'),
    import('../constants.js'),
  ])
  return {
    hosts: async () => ((await getConfig()).hosts ?? {}) as Record<string, HostDef>,
    daemonSocket: (host, target) => controlSocketPath({ hostKey: host, target, home: WALNUT_HOME }),
    terminalSocket: terminalControlSocket,
    end: (socket, host) => exitOwnedControlMaster(socket, host),
  }
}
