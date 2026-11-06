/**
 * The session prompt's host line: which machines this Walnut can run work on
 * and what each can do (capabilities.ts), so a task on any host knows the Mac
 * has Xcode and the user's browser before it guesses (the user, 2026-10-31:
 * "it can see there is a Mac, and use the Mac for the iOS part").
 *
 * State, not a rule: session-context.ts puts it beside the task directory and
 * leaves it out of the default instructions, so a change never reaches a
 * running session as an instruction notice. Built without waiting on any host:
 * the last fleet read when there is one (a background read refreshes an old
 * one), else each host's probed profile on disk. Capabilities change rarely;
 * who is connected now changes often, so the line points at host_list for that.
 */
import { getConfig } from '../config-manager.js'
import { log } from '../../logging/index.js'
import { capabilityWords, hostCapabilities, type HostCapabilities } from './capabilities.js'
import { readHostProfile } from './host-profile.js'

const LOCAL = '__local__'
const MAX_HOSTS = 8
const REFRESH_AFTER_MS = 10 * 60_000
const PROFILE_DEADLINE_MS = 1_000

interface HostCaps { host: string; label: string; local: boolean; caps: HostCapabilities }

let refreshing = false
function refreshInBackground(): void {
  // Off in tests that wipe their data home: a read nobody awaits opens the session store at any moment, and a test
  // that wipes its data home meanwhile poisons that store for the rest of the file.
  if (refreshing || process.env.WALNUT_FLEET_PROMPT_REFRESH === '0') return
  refreshing = true
  void import('./fleet.js').then((m) => m.listFleet({ days: 7 }))
    .catch((err) => log.web.debug('fleet prompt: background read failed', { error: String(err) }))
    .finally(() => { refreshing = false })
}

async function fromProfiles(): Promise<HostCaps[]> {
  const config = await getConfig()
  // The fleet's own list: a found row for a joined machine is that machine, named once.
  const { fleetEntries } = await import('./fleet.js')
  const list = fleetEntries(config).filter((e) => e.kind !== 'bridge')
    .map((e) => ({ host: e.host, label: e.local || e.label === e.host ? '' : e.label, local: e.local, declared: e.declared }))
  return Promise.all(list.slice(0, MAX_HOSTS).map(async (h) => {
    const profile = await readHostProfile(h.host).catch(() => null)
    return { host: h.host, label: h.label, local: h.local, caps: hostCapabilities({ probed: profile?.probed ?? null, kind: profile?.kind ?? null, local: h.local, week: null, declared: h.declared }) }
  }))
}

/** The hosts and their capabilities, never waiting on a daemon. */
export async function promptHosts(now = Date.now()): Promise<HostCaps[]> {
  const { lastFleetRead } = await import('./fleet.js')
  const last = lastFleetRead()
  if (!last || now - last.at > REFRESH_AFTER_MS) refreshInBackground()
  if (last) {
    return last.cards.filter((c) => c.connection.kind !== 'bridge').slice(0, MAX_HOSTS)
      .map((c) => ({ host: c.host, label: c.local ? '' : (c.label === c.host ? '' : c.label), local: c.local, caps: c.capabilities }))
  }
  return Promise.race([
    fromProfiles(),
    new Promise<HostCaps[]>((resolve) => { const t = setTimeout(() => resolve([]), PROFILE_DEADLINE_MS); t.unref?.() }),
  ])
}

/** The line itself; '' with fewer than two hosts (one machine has nothing to choose from). */
export function fleetPromptLine(hosts: HostCaps[], sessionHost: string | undefined): string {
  if (hosts.length < 2) return ''
  const here = !sessionHost || sessionHost === 'local' ? LOCAL : sessionHost
  const rows = hosts.map((h) => {
    const name = h.local ? `"${LOCAL}" (the primary machine, where Walnut's server runs)` : `"${h.host}"${h.label ? ` (${h.label})` : ''}`
    const words = capabilityWords(h.caps)
    return `- ${name}: ${words || 'not probed yet'}${h.host === here ? '. This session runs here' : ''}`
  })
  return 'Hosts: Walnut can run work on these machines. To use one, name it as host in task_create or task_start, '
    + 'or ask by what it has (host "@ios", "@browser" for the user\'s own signed-in browser, "@mcp:<server>", '
    + '"@always-on"); host_list says which are connected now and lists each one\'s capabilities. '
    + 'For one command there (an xcodebuild, a CLI signed in on that machine), host_exec runs it and returns its output; '
    + 'host_mcp_list / host_mcp_call use an MCP server configured there, and host_http reaches a web service only it can (its localhost); '
    + 'the user allows that once per task and host.\n'
    + rows.join('\n') + '\n\n'
}

export async function buildFleetPromptLine(sessionHost: string | undefined): Promise<string> {
  try {
    // A follower (the companion, a host's own server) holds no fleet of its own and
    // answers /hosts/pick with needs-leader, so its sessions get no host line.
    const { isFollower } = await import('../server-role.js')
    if (isFollower()) return ''
    const secrets = await import('../secrets/fleet-secrets.js').then((m) => m.secretsPromptLine(sessionHost), () => '')
    return fleetPromptLine(await promptHosts(), sessionHost) + secrets
  } catch (err) {
    log.web.debug('fleet prompt: no host line', { error: String(err) })
    return ''
  }
}
