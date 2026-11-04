/**
 * What this Mac reads about the machines on the host network from the daemons
 * (net-mac.ts uses it): where each one is now, how this Mac reaches it, and which relay
 * choice this Mac's own walnut-net can run.
 */
import { log } from '../../logging/index.js'
import { socketAddr } from '../../providers/net-config-core.js'
import type { Daemon } from './net-local.js'
import { choiceOfMode, directAddr, PUBLIC_RELAYS, type MachineLink, type RelayChoice } from './net-relay.js'
import { netRows, type HostRows } from './net-rows.js'
import { mergeAddrs, noteWhere } from './net-where.js'

/**
 * Note where a machine is now (net-where.ts): the address this Mac reaches it at first, and
 * its relay when it is one of `ours` (the relays of this Mac's choice, relaysOfChoice) or one
 * this Mac's walnut-net runs on now (its home relay, n0's while it runs public relays).
 * 2026-11-04: a PC seen on n0's relay while this Mac ran public relays was not kept, so once
 * a companion was paired and this Mac moved to its relay, the PC (away then) was never found.
 */
export async function noteSeen(local: Daemon, conn: Daemon, name: string, endpoint: string, ours: string[]): Promise<void> {
  try {
    const [st, mine] = await Promise.all([
      conn.send('net.status', {}, 10_000) as Promise<{ node?: { addrs?: unknown; homeRelay?: unknown } | null }>,
      local.send('net.status', {}, 10_000) as Promise<{ node?: { peers?: Array<{ id: string; link?: unknown }>; relayMode?: unknown; homeRelay?: unknown } | null }>,
    ])
    const own = Array.isArray(st.node?.addrs) ? st.node.addrs.filter(socketAddr) as string[] : []
    const at = directAddr(mine.node?.peers?.find((p) => p.id === endpoint)?.link)
    const running = [
      ...(typeof mine.node?.homeRelay === 'string' ? [mine.node.homeRelay] : []),
      ...(choiceOfMode(mine.node?.relayMode) === 'public' ? PUBLIC_RELAYS : []),
    ]
    // Its relay is kept only when it is one of this Mac's own (net-where.ts relayToKeep).
    const home = typeof st.node?.homeRelay === 'string' ? st.node.homeRelay : null
    if (await noteWhere(endpoint, { addrs: mergeAddrs(at ? [at] : [], own), home, ours: [...ours, ...running], self: own })) log.session.info('net: noted where a machine is', { host: name, at, home })
  } catch (err) { log.session.debug('net: could not read where a machine is', { host: name, error: (err as Error).message }) }
}

/**
 * Whether this Mac's walnut-net has relay modes (protocol 2 reports its `relayMode`), or
 * null while it does not answer (starting, or restarting for a change just made): that
 * says nothing about its version.
 */
export async function runsModes(local: Daemon, timeoutMs = 10_000): Promise<boolean | null> {
  try {
    const s = await local.send('net.status', {}, timeoutMs) as { node?: { relayMode?: unknown } | null }
    return s.node ? typeof s.node.relayMode === 'string' : null
  } catch { return null }
}

/** runsModes, asked again while it does not answer, for at most `waitMs` in all. */
export async function waitForModes(local: Daemon, waitMs: number): Promise<boolean | null> {
  const end = Date.now() + waitMs
  let modes = await runsModes(local, 2_000)
  while (modes === null && Date.now() + 500 < end) {
    await new Promise((r) => setTimeout(r, 500))
    modes = await runsModes(local, Math.min(2_000, Math.max(1, end - Date.now())))
  }
  return modes
}

/** The choice this Mac's walnut-net runs on now, or null when it does not run. */
export async function runningChoice(local: Daemon): Promise<RelayChoice | null> {
  try {
    const s = await local.send('net.status', {}, 10_000) as { node?: { relayMode?: unknown } | null }
    return choiceOfMode(s.node?.relayMode)
  } catch { return null }
}

/** Every listed machine: how this Mac reaches it now, and where it says it listens. */
export async function machineLinks(local: Daemon): Promise<MachineLink[]> {
  const [{ getConfig }, { peekDaemonConnection }] = await Promise.all([import('../config-manager.js'), import('../../providers/daemon-connection.js')])
  const mine = await local.send('net.status', {}, 10_000) as { node?: { peers?: Array<{ id: string; link?: { path?: string } }> } | null }
  const rows = netRows(((await getConfig()).hosts ?? {}) as HostRows)
  return Promise.all(rows.map(async ([alias, h]) => {
    const link = mine.node?.peers?.find((p) => p.id === h.endpoint)?.link
    const conn = peekDaemonConnection(alias)
    let own: string[] = []
    if (conn?.connected) {
      try {
        const st = await conn.send('net.status', {}, 10_000) as { node?: { addrs?: unknown } | null }
        own = Array.isArray(st.node?.addrs) ? st.node.addrs.filter(socketAddr) as string[] : []
      } catch { /* treated as a router in between */ }
    }
    const connected = !!link && link.path !== undefined && link.path !== 'none'
    return { name: typeof h.label === 'string' && h.label ? h.label : alias, connected, path: link?.path, at: directAddr(link), own }
  }))
}

