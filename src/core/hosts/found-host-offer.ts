/**
 * Which found hosts Walnut offers (a host found in ~/.ssh/config, found-hosts.ts): ONE rule
 * that the server's lists and the browser's read alike (web alias `@open-walnut/found-host-offer`),
 * so no surface offers a host the others leave out.
 *
 * A found host is not offered once Walnut learned that it cannot be set up over SSH, or that it
 * is a machine already connected under another name. 2026-11-13: a Mac found in ~/.ssh/config,
 * said Connect to once, showed "Could not connect" on Home after every reload ("I don't want it
 * keep showing"), while the same Mac was already connected, joined with a link.
 *
 * `hosts.<alias>.not_offered` keeps what Walnut learned, for good:
 *   reason: not_linux     the SSH probe's `uname -s` named another system (`os`). The row is also
 *                         turned off (`enabled: false`): nothing dials it again, and an older Walnut,
 *                         which reads past the field, sees it off too. A connect that works later
 *                         (the alias names another machine now) clears it (found-host-marks.ts).
 *   reason: same_machine  it is the joined machine `same_as` (joined-twins.ts matched it). It stands
 *                         only while that machine's row can be used, so removing or turning off the
 *                         joined machine brings the found row back, as joined-twins.ts promises.
 *   at                    when Walnut learned it (ISO).
 *
 * Import-free: the browser bundles this file.
 */

export type NotOfferedReason = 'not_linux' | 'same_machine'

export interface HostNotOffered {
  reason: NotOfferedReason
  /** not_linux: what `uname -s` said ("Darwin"). */
  os?: string
  /** same_machine: the alias of the joined machine this found host is. */
  same_as?: string
  at: string
}

/**
 * The standing connect failures (host-problem.ts STANDING_FAILURE_KINDS) that mean the machine
 * cannot be set up over SSH at all: their first answer marks the found host.
 */
export const SSH_SETUP_REFUSED_KINDS: readonly string[] = ['not_linux']
/** The standing connect failures the person fixes outside Walnut (a login, a key, a name): the host stays offered. */
export const SSH_FIXABLE_STANDING_KINDS: readonly string[] = ['auth', 'host_key', 'dns', 'cert_expired', 'agent_missing', 'proxy_login']

/** The one Notifications entry a found host has (found-host-alert.ts), by alias. */
export const FOUND_HOST_CARD_PREFIX = 'found-host:'
export function foundHostCardKey(alias: string): string {
  return `${FOUND_HOST_CARD_PREFIX}${alias}`
}

/** The fields these rules read (a stored row is untyped YAML). */
export interface OfferRow {
  discovered?: unknown
  connect?: unknown
  enabled?: unknown
  label?: unknown
  transport?: unknown
  endpoint?: unknown
  not_offered?: unknown
}
type Rows = Record<string, OfferRow | null | undefined>

/** The row's `not_offered`, when it is one these rules know. */
export function notOfferedOf(row: OfferRow | null | undefined): HostNotOffered | undefined {
  const m = row?.not_offered
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined
  const o = m as Record<string, unknown>
  const at = typeof o.at === 'string' ? o.at : ''
  if (o.reason === 'not_linux') return { reason: 'not_linux', ...(typeof o.os === 'string' && o.os ? { os: o.os } : {}), at }
  if (o.reason === 'same_machine' && typeof o.same_as === 'string' && o.same_as) return { reason: 'same_machine', same_as: o.same_as, at }
  return undefined
}

/**
 * The joined machine `alias` names can be used: a host network row that is on, while the host
 * network is on. `net` undefined = not known here (the check is left to the row).
 */
export function joinedRowUsable(hosts: Rows, alias: string, net?: unknown): boolean {
  const h = Object.hasOwn(hosts, alias) ? hosts[alias] : undefined
  if (!h || h.transport !== 'net' || typeof h.endpoint !== 'string' || h.enabled === false) return false
  return net === undefined || (!!net && typeof net === 'object' && (net as { enabled?: unknown }).enabled === true)
}

/** What Walnut learned about this host still keeps it from being offered. */
export function notOfferedStands(row: OfferRow | null | undefined, hosts: Rows, net?: unknown): boolean {
  const m = notOfferedOf(row)
  if (!m) return false
  return m.reason === 'not_linux' || joinedRowUsable(hosts, m.same_as ?? '', net)
}

/** A found host Walnut may offer: found in ~/.ssh/config, and nothing learned keeps it out. */
export function foundHostOffered(row: OfferRow | null | undefined, hosts: Rows, net?: unknown): boolean {
  return !!row && row.discovered === true && !notOfferedStands(row, hosts, net)
}

function labelOf(alias: string, row: OfferRow): string {
  return typeof row.label === 'string' && row.label.trim() ? row.label.trim() : alias
}

/** The found hosts to ask "Connect to it?" (asked, not answered yet), with what each is called. */
export function foundHostsToAsk(hosts: Rows | undefined, net?: unknown): Array<{ host: string; label: string }> {
  const all = hosts ?? {}
  return Object.entries(all).filter(([, h]) => !!h && h.connect === 'ask' && foundHostOffered(h, all, net))
    .map(([host, h]) => ({ host, label: labelOf(host, h!) }))
}

/** The found hosts the person said Connect to, still on and offered: their setup is shown until it is done. */
export function consentedFoundHosts(hosts: Rows | undefined, net?: unknown): Array<{ host: string; label: string }> {
  const all = hosts ?? {}
  return Object.entries(all).filter(([, h]) => !!h && h.connect === 'yes' && h.enabled !== false && foundHostOffered(h, all, net))
    .map(([host, h]) => ({ host, label: labelOf(host, h!) }))
}

/** The system a not_linux connect error names (host-connect-hint.ts notLinuxSentence). */
export function osOfNotLinuxError(error: string | undefined): string | undefined {
  const m = /\bruns (.{1,40}?): walnut sets up ssh hosts on linux only/i.exec(error ?? '')
  return m ? m[1].trim() : undefined
}

/** The row marked not Linux, and off. */
export function withNotLinuxMark<T extends OfferRow>(row: T, os: string | undefined, now: Date): T {
  return { ...row, enabled: false, not_offered: { reason: 'not_linux', ...(os ? { os } : {}), at: now.toISOString() } }
}

/** The row marked as the joined machine `sameAs`. */
export function withSameMachineMark<T extends OfferRow>(row: T, sameAs: string, now: Date): T {
  return { ...row, not_offered: { reason: 'same_machine', same_as: sameAs, at: now.toISOString() } }
}

/** The row without a not_linux mark (any other mark stays); the same object when it has none. */
export function withoutNotLinuxMark<T extends OfferRow>(row: T): T {
  if (notOfferedOf(row)?.reason !== 'not_linux') return row
  const { not_offered: _gone, ...rest } = row
  return rest as T
}

/**
 * A settings write whose row carries no `not_offered` (an editor that does not know the field, as
 * Remote Hosts' does not) keeps the stored one, so saving Settings never offers the host again.
 */
export function keepNotOffered<T extends OfferRow>(sent: T, was: OfferRow | undefined): T {
  if (!was || 'not_offered' in sent || was.not_offered === undefined) return sent
  return { ...sent, not_offered: was.not_offered }
}
