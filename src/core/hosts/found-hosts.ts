/**
 * Found hosts: a Host block of the person's ~/.ssh/config that Walnut lists on
 * Remote Hosts and never dials until the person says yes (2026-11-02, the user:
 * "we shouldn't do auto connection ... default we discover only"). Before this,
 * every found host was merged as on, and anything that walks the enabled hosts
 * (a path clicked in agent text, the tunnel's Auto placement, the terminal
 * sweep) dialled machines the person never set up.
 *
 * `hosts.<alias>.connect` on a found host (`discovered: true`):
 *   ask      listed with "Connect to it?", never dialled
 *   yes      a normal host: dialled now and at every start
 *   not_now  listed, never dialled, not asked again (its row can still connect it)
 *   absent   not decided yet: a row an older Walnut wrote. The server decides it
 *            at start from what Walnut recorded (found-hosts-store.ts) and, until
 *            then, reads it the way that older Walnut did.
 *
 * A found host waiting for the yes reads as off (`enabled: false`) everywhere, so
 * every place that skips a host the person turned off skips it too, and an older
 * Walnut reading the file sees it off as well. The field is additive: an older
 * Walnut ignores it and keeps the row.
 *
 * Pure: config-manager.ts calls the merge and the read rule, the store module the
 * decision.
 */

import type { Config } from '../types.js'
import type { DiscoveredHost } from '../ssh-config-scanner.js'

export type FoundHostAnswer = 'ask' | 'yes' | 'not_now'

type HostRow = NonNullable<Config['hosts']>[string]
/** The fields of a host row these rules read (a stored row is untyped YAML). */
export interface FoundHostRow {
  hostname?: unknown
  user?: unknown
  port?: unknown
  label?: unknown
  enabled?: unknown
  discovered?: unknown
  connect?: unknown
  connect_by?: unknown
  [key: string]: unknown
}

/** The two fields the predicates read. */
export interface FoundFlags {
  discovered?: unknown
  connect?: unknown
  connect_by?: unknown
}

export function isFoundHostAnswer(value: unknown): value is FoundHostAnswer {
  return value === 'ask' || value === 'yes' || value === 'not_now'
}

/** A found host still waiting for the person's yes (asked, or Not now): nothing dials it. */
export function foundHostWaits(def: FoundFlags | null | undefined): boolean {
  return !!def && def.discovered === true && (def.connect === 'ask' || def.connect === 'not_now')
}

/**
 * A found host Walnut must not treat as configured: no yes on it (an undecided older row
 * included), or a yes Walnut gave itself when it decided an older row from what it recorded
 * (`connect_by: 'walnut'`). That one is dialled when used, as found hosts always were, and
 * never warmed at every start: only the person's own Connect makes a found host one Walnut
 * keeps connected.
 */
export function foundHostUnadopted(def: FoundFlags | null | undefined): boolean {
  return !!def && def.discovered === true && (def.connect !== 'yes' || def.connect_by === 'walnut')
}

/** The read rule: a found host waiting for the yes is off. Mutates `hosts` in place. */
export function applyFoundHostAnswers(hosts: Config['hosts']): void {
  for (const def of Object.values(hosts ?? {})) {
    if (def && foundHostWaits(def)) def.enabled = false
  }
}

/** Has the server started asking (the older rows decided once)? */
export function askingAboutFoundHosts(config: Pick<Config, 'hosts_found'>): boolean {
  return typeof config.hosts_found?.asking_since === 'string' && config.hosts_found.asking_since.length > 0
}

/**
 * Merge the ~/.ssh/config hosts into config.hosts, in memory. A host is skipped when
 * its alias or its hostname is already there (the person's own entry IS that machine)
 * or its alias is reserved. Once the server asks (`asking`), a new one waits for the
 * yes; before that it is merged on, as an older Walnut did, so the first start of
 * this version reads the rows it decides exactly as they were.
 */
export function mergeFoundHosts(
  config: Config,
  discovered: ReadonlyMap<string, DiscoveredHost>,
  opts: { reserved?: ReadonlySet<string>; asking: boolean },
): void {
  if (discovered.size === 0) return
  if (!config.hosts) config.hosts = {}
  const hosts = config.hosts
  const known = new Set(Object.values(hosts).map((h) => String(h?.hostname ?? '').toLowerCase()))
  for (const [alias, host] of discovered) {
    if (opts.reserved?.has(alias) || hosts[alias] || known.has(host.hostname.toLowerCase())) continue
    const row: HostRow = {
      hostname: host.hostname,
      user: host.user,
      port: host.port,
      label: host.label,
      enabled: !opts.asking,
      discovered: true,
      ...(opts.asking ? { connect: 'ask' as const } : {}),
    }
    hosts[alias] = row
    known.add(host.hostname.toLowerCase())
  }
}

/** What Walnut recorded about each host, by alias: the facts an older found host is decided from. */
export interface FoundHostFacts {
  /** A session record names the host. */
  sessionHosts: ReadonlySet<string>
  /** A task's last start or transfer, or a project's default host, names it. */
  taskHosts: ReadonlySet<string>
  /** Its daemon answered at least once (a probed host profile). */
  connectedHosts: ReadonlySet<string>
  /** A Walnut server was set up there (host-servers.json). */
  serverHosts: ReadonlySet<string>
}

export type FoundHostReason =
  | 'turned_off' | 'session' | 'task' | 'connected' | 'tunnel' | 'server' | 'edited' | 'unused'

/** Fields only a person (or Walnut acting on a host it uses) writes on a host row. */
const EDIT_FIELDS = ['shell_setup', 'keep', 'capabilities', 'server', 'transport', 'endpoint', 'server_program'] as const

function text(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

/** Did the person change the row from what ~/.ssh/config says? */
export function foundHostEdited(row: FoundHostRow, scanned: DiscoveredHost | undefined): boolean {
  for (const key of EDIT_FIELDS) {
    const v = row[key]
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0) continue
    return true
  }
  if (row.autofix === false || row.place === false) return true
  if (!scanned) return false
  return text(row.hostname).toLowerCase() !== scanned.hostname.toLowerCase()
    || text(row.user) !== text(scanned.user)
    || text(row.port) !== text(scanned.port)
    || (text(row.label) !== '' && text(row.label) !== text(scanned.label))
}

/**
 * The answer for a found host no answer was recorded for, from what Walnut recorded,
 * never from a clock: a host someone uses (it ever connected, sessions or tasks name
 * it, it carries the tunnel or a server, the person edited it) is a yes; one the
 * person turned off is Not now; any other waits for the question.
 */
export function decideFoundHost(
  alias: string,
  row: FoundHostRow,
  ctx: { facts: FoundHostFacts; runOn?: unknown; scanned?: DiscoveredHost; persisted: boolean },
): { answer: FoundHostAnswer; reason: FoundHostReason } {
  if (ctx.persisted && row.enabled === false) return { answer: 'not_now', reason: 'turned_off' }
  if (ctx.facts.connectedHosts.has(alias)) return { answer: 'yes', reason: 'connected' }
  if (ctx.facts.sessionHosts.has(alias)) return { answer: 'yes', reason: 'session' }
  if (ctx.facts.taskHosts.has(alias)) return { answer: 'yes', reason: 'task' }
  if (typeof ctx.runOn === 'string' && ctx.runOn.trim() === alias) return { answer: 'yes', reason: 'tunnel' }
  const server = row.server as { enabled?: unknown } | undefined
  if (server?.enabled === true || ctx.facts.serverHosts.has(alias)) return { answer: 'yes', reason: 'server' }
  if (ctx.persisted && foundHostEdited(row, ctx.scanned)) return { answer: 'yes', reason: 'edited' }
  return { answer: 'ask', reason: 'unused' }
}

/**
 * A host row with this answer written: `enabled` follows it (yes on, the others off). `by`
 * says who answered: the person (the default, and no field), or Walnut deciding an older row.
 */
export function withFoundHostAnswer<T extends FoundHostRow>(row: T, answer: FoundHostAnswer, by: 'person' | 'walnut' = 'person'): T {
  const { connect_by: _was, ...rest } = row
  return { ...rest, discovered: true, connect: answer, enabled: answer === 'yes', ...(by === 'walnut' ? { connect_by: 'walnut' } : {}) } as T
}

/** Why a dial of a found host waiting for the yes is refused, with where the yes is given. */
export function foundHostWaitingNote(label: string): string {
  return `Walnut found ${label} in ~/.ssh/config and does not connect to it until you say so. Connect it in Settings, Remote Hosts.`
}
