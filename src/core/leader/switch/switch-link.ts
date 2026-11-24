/**
 * The copy link to `to` (peer.ts) and the settings, or why there is none: every switch call that acts on
 * `to` (the begin, a begin forwarded by `to` itself, the check, the handover) passes the same trust rule here
 * first (final-stop.ts beginRefusal); a target reached as a host must also say its service can lead.
 * Only in a leader server (it reads this server's config and its link to the host).
 */
import type { SwitchPeer } from './peer.js'
import type { LeaderSwitchSettings } from './settings.js'

export type SwitchLink = { peer: SwitchPeer; settings: LeaderSwitchSettings } | { refused: string }

/**
 * `forwardedBy`: the machine id of the host link a forwarded begin came over (null: not known), `forwardedHostKey` the
 * leader's own key of that link; both absent: asked on this machine.
 */
export async function switchLink(to: string, me: string, o: { forwardedBy?: string | null; forwardedHostKey?: string } = {}): Promise<SwitchLink> {
  const [{ readHomeSwitchConfig, machineById }, { peerFor }, { beginRefusal }, { WALNUT_HOME }, { getConfig }] = await Promise.all([
    import('./settings.js'), import('./peer.js'), import('./final-stop.js'), import('../../../constants.js'), import('../../config-manager.js'),
  ])
  const cfg = readHomeSwitchConfig(WALNUT_HOME)
  if (!cfg.settings) return { refused: cfg.problem ?? 'no leader_switch section' }
  if (!machineById(cfg.settings, me)) return { refused: `this machine (${me}) is not in leader_switch.machines` }
  const config = await getConfig()
  const raw = config.standby ?? {}
  const walnut = typeof raw.walnut === 'string' ? [raw.walnut] : Array.isArray(raw.walnut) ? raw.walnut : undefined
  const standby = { ...(raw.dir ? { dir: raw.dir } : {}), ...(raw.host ? { host: raw.host } : {}), ...(walnut ? { walnut } : {}) }
  // A target reached as a host: what this leader's link knows of its service (hello serviceRoles, launcher goodRoles).
  const hostService = standby.host ? ((await (await import('../../hosts/fleet.js')).getFleetHost(standby.host).catch(() => null))?.daemon ?? null) : undefined
  const why = beginRefusal({
    settings: cfg.settings, me, to, standby, hosts: Object.keys(config.hosts ?? {}),
    ...(hostService !== undefined ? { hostService } : {}), ...(o.forwardedBy !== undefined ? { forwardedBy: o.forwardedBy } : {}), ...(o.forwardedHostKey ? { forwardedHostKey: o.forwardedHostKey } : {}),
  })
  if (why) return { refused: why }
  const peer = await peerFor({ to: machineById(cfg.settings, to)!, standby, home: WALNUT_HOME })
  if ('refused' in peer) return peer
  // Over a daemon: its hello must name every command the copy link sends (named when one is missing).
  const notReady = await peer.ready()
  if (notReady) { peer.close(); return { refused: notReady } }
  return { peer, settings: cfg.settings }
}
