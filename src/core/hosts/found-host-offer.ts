/**
 * Which found hosts Walnut offers (a host found in ~/.ssh/config, found-hosts.ts): ONE rule
 * that the server's lists and the browser's read alike (web alias `@open-walnut/found-host-offer`),
 * so no surface offers a host the others leave out.
 *
 * A found host is not offered once its SSH probe said it is not Linux. 2026-11-13: a Mac found in
 * ~/.ssh/config, said Connect to once, showed "Could not connect" on Home after every reload ("I
 * don't want it keep showing"). `hosts.<alias>.not_offered` keeps it:
 *   reason: not_linux   what `uname -s` named (`os`), on the SSH target it was learned on
 *                       (`target`: hostname, user, port). The row is also turned off
 *                       (`enabled: false`): nothing dials it again, and an older Walnut, which
 *                       reads past the field, sees it off too.
 *   at                  when Walnut learned it (ISO).
 * The mark holds only for that target: once the alias names another one (~/.ssh/config or a hand
 * edit changed it), the host is asked again (`withoutStaleNotLinux`), and a connect that works
 * clears it (found-host-marks.ts).
 *
 * A found host that is a machine already joined with a link is NOT marked: that match is read live
 * from the machine's current addresses (joined-twins.ts), because an address match can be an
 * accident (a laptop on a cafe network takes the address of a Linux box behind a VPN). A
 * `same_machine` entry an earlier build of this change wrote is ignored.
 *
 * Import-free: the browser bundles this file.
 */

/** The SSH target a mark was learned on. */
export interface NotOfferedTarget {
  hostname: string
  user?: string
  port?: number
}

export interface HostNotOffered {
  reason: 'not_linux'
  /** What `uname -s` said ("Darwin"). */
  os?: string
  /** The target it was learned on; absent on a mark written before the field (never stale). */
  target?: NotOfferedTarget
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
  hostname?: unknown
  user?: unknown
  port?: unknown
  discovered?: unknown
  connect?: unknown
  connect_by?: unknown
  enabled?: unknown
  label?: unknown
  not_offered?: unknown
}
type Rows = Record<string, OfferRow | null | undefined>

function text(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim()
}

/** The SSH target a row dials now. */
export function targetOf(row: OfferRow): NotOfferedTarget {
  const port = typeof row.port === 'number' ? row.port : Number(text(row.port)) || undefined
  return { hostname: text(row.hostname), ...(text(row.user) ? { user: text(row.user) } : {}), ...(port ? { port } : {}) }
}

/** One target: the hostname in any case, the user, the port (22 when none is named). */
export function sameTarget(a: NotOfferedTarget, b: NotOfferedTarget): boolean {
  return a.hostname.toLowerCase() === b.hostname.toLowerCase() && text(a.user) === text(b.user) && (a.port ?? 22) === (b.port ?? 22)
}

function targetIn(v: unknown): NotOfferedTarget | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const t = targetOf(v as OfferRow)
  return t.hostname ? t : undefined
}

/** The row's `not_offered`, when it is one these rules know (any other reason is ignored). */
export function notOfferedOf(row: OfferRow | null | undefined): HostNotOffered | undefined {
  const m = row?.not_offered
  if (!m || typeof m !== 'object' || Array.isArray(m)) return undefined
  const o = m as Record<string, unknown>
  if (o.reason !== 'not_linux') return undefined
  const target = targetIn(o.target)
  return { reason: 'not_linux', ...(typeof o.os === 'string' && o.os ? { os: o.os } : {}), ...(target ? { target } : {}), at: typeof o.at === 'string' ? o.at : '' }
}

/** The mark was learned on another target than the one the row names now: it says nothing of this one. */
export function notLinuxMarkStale(row: OfferRow): boolean {
  const target = notOfferedOf(row)?.target
  return !!target && !sameTarget(target, targetOf(row))
}

/** What Walnut learned still keeps this host from being offered. */
export function notOfferedStands(row: OfferRow | null | undefined): boolean {
  return !!row && !!notOfferedOf(row) && !notLinuxMarkStale(row)
}

/** A found host Walnut may offer: found in ~/.ssh/config, and nothing learned keeps it out. */
export function foundHostOffered(row: OfferRow | null | undefined): boolean {
  return !!row && row.discovered === true && !notOfferedStands(row)
}

function labelOf(alias: string, row: OfferRow): string {
  return typeof row.label === 'string' && row.label.trim() ? row.label.trim() : alias
}

/** The found hosts to ask "Connect to it?" (asked, not answered yet), with what each is called. */
export function foundHostsToAsk(hosts: Rows | undefined): Array<{ host: string; label: string }> {
  return Object.entries(hosts ?? {}).filter(([, h]) => !!h && h.connect === 'ask' && foundHostOffered(h))
    .map(([host, h]) => ({ host, label: labelOf(host, h!) }))
}

/** The found hosts the person said Connect to, still on and offered: their setup is shown until it is done. */
export function consentedFoundHosts(hosts: Rows | undefined): Array<{ host: string; label: string }> {
  return Object.entries(hosts ?? {}).filter(([, h]) => !!h && h.connect === 'yes' && h.enabled !== false && foundHostOffered(h))
    .map(([host, h]) => ({ host, label: labelOf(host, h!) }))
}

/** The system a not_linux connect error names (host-connect-hint.ts notLinuxSentence). */
export function osOfNotLinuxError(error: string | undefined): string | undefined {
  const m = /\bruns (.{1,40}?): walnut sets up ssh hosts on linux only/i.exec(error ?? '')
  return m ? m[1].trim() : undefined
}

/** The row marked not Linux on `target` (default: the one it names now), and off. */
export function withNotLinuxMark<T extends OfferRow>(row: T, os: string | undefined, now: Date, target: NotOfferedTarget = targetOf(row)): T {
  return { ...row, enabled: false, not_offered: { reason: 'not_linux', ...(os ? { os } : {}), target, at: now.toISOString() } }
}

/** The row without its not_linux mark; the same object when it has none. */
export function withoutNotLinuxMark<T extends OfferRow>(row: T): T {
  if (!notOfferedOf(row)) return row
  const { not_offered: _gone, ...rest } = row
  return rest as T
}

/**
 * A found host whose not Linux mark no longer holds (the alias names another target now) is
 * asked again: the mark goes, `connect: ask`, and it stays off until the person answers. The
 * same object when the mark still holds or there is none.
 */
export function withoutStaleNotLinux<T extends OfferRow>(row: T): T {
  if (row.discovered !== true || !notLinuxMarkStale(row)) return row
  const { not_offered: _gone, connect_by: _by, ...rest } = row
  return { ...rest, connect: 'ask', enabled: false } as T
}

/**
 * A whole hosts map written back by an editor that does not know `not_offered` (Remote Hosts'
 * does not) keeps each found host's stored one, so a Settings save never offers the host again.
 * A row the sender names `not_offered` on keeps its own; a row it leaves out is gone as sent.
 */
export function keepNotOfferedRows(sent: Record<string, unknown>, was: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!was) return sent
  let out: Record<string, unknown> | null = null
  for (const [alias, row] of Object.entries(sent)) {
    const old = Object.hasOwn(was, alias) ? was[alias] as OfferRow | undefined : undefined
    if (!row || typeof row !== 'object' || !old || typeof old !== 'object') continue
    const r = row as OfferRow
    if ('not_offered' in r || old.not_offered === undefined || old.discovered !== true || r.discovered !== true) continue
    out ??= { ...sent }
    out[alias] = { ...r, not_offered: old.not_offered }
  }
  return out ?? sent
}
