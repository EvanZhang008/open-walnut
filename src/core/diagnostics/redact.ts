/**
 * Redaction for the doctor report and the bug report: what makes a pasted
 * block safe for a public issue.
 *
 * Two layers, applied in this order:
 *   1. secrets, ALWAYS (JSON and text, redacted or not): every string passes
 *      redactSensitiveText, so a token or a proxy password inside a fix log, a
 *      check error or a claude error never leaves the server (`maskSecrets`).
 *   2. identities, in the redacted form (`redactDiagnostics`):
 *      - this machine's home prefix becomes `~`; any other `/Users/<name>`,
 *        `/home/<name>` or `C:\Users\<name>` becomes `/Users/…`;
 *      - the local user names (home basename, os.userInfo, $USER, $LOGNAME),
 *        each remote home's basename and every name seen in a home path are
 *        masked wherever else they appear;
 *      - each remote host gets an ORDINAL marker, `[host:1]` / `[user:1]`. The
 *        marker never carries the alias, because an alias can itself be the
 *        FQDN or an IP (an ssh-config `Host build-7.corp.example.com` with no
 *        HostName); such an alias is masked too;
 *      - in error and warning text, any other domain-like or IPv4 fragment and
 *        any `user@` prefix, except a short allowlist of public install hosts.
 *
 * Names of two or more characters (`gp`, `gpu`, `al`) are replaced wherever
 * they stand as a whole word. A one-character name is replaced in its field
 * and where the context says what it is (`a@`, `@b`, `//b`): masking every
 * standalone "a" would turn prose ("a Claude account") into noise.
 */

import os from 'node:os'
import path from 'node:path'
import { redactSensitiveText } from '../../logging/index.js'
import type { DiagnosticsReport } from './types.js'

const ELLIPSIS = '\u2026'
/** Home-directory names that are not a person. */
const NOT_A_USER = new Set(['Shared', 'Guest', 'Public', 'root', ELLIPSIS])
/** `/Users/<name>`, `/home/<name>` (also `/var/home/<name>`), `C:\Users\<name>`. */
const HOME_PATH_RE = /(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)([^/\\\s:;'"`,)\]]+)/g
/** Public hosts an install hint or an error may name; kept readable. */
const PUBLIC_HOSTS = ['claude.ai', 'anthropic.com', 'github.com', 'githubusercontent.com', 'npmjs.org', 'npmjs.com', 'nodejs.org', 'bun.sh']
const KEEP_IPS = new Set(['127.0.0.1', '0.0.0.0'])
/** The last label of a file name, not a domain: `settings.local.json`, `install.sh`. */
const FILE_EXTENSIONS = new Set([
  'json', 'yaml', 'yml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'sh', 'txt', 'log', 'md', 'lock', 'toml', 'ini', 'conf',
  'plist', 'pid', 'sock', 'gz', 'tgz', 'zip', 'node', 'exe', 'dll', 'so', 'dylib', 'py', 'rb', 'c', 'h', 'o',
])
/** Two-label tokens count as a domain only with one of these endings (`config.yaml` is not). */
const TLDS = new Set([
  'com', 'net', 'org', 'io', 'dev', 'ai', 'co', 'cloud', 'app', 'internal', 'local', 'lan', 'corp', 'home', 'edu',
  'gov', 'mil', 'me', 'info', 'biz', 'us', 'uk', 'de', 'fr', 'jp', 'cn', 'in', 'au', 'ca', 'eu', 'xyz', 'tech', 'site',
])
/** Keys whose values are free text (errors, warnings, fix logs, commands). */
const FREE_TEXT_KEYS = new Set(['warnings', 'lastError', 'checkError', 'error', 'message', 'text', 'detail', 'commands', 'command', 'authDetail', 'unknown'])

/** A remote host as the redaction sees it. */
export interface HostIdentity {
  alias: string
  hostname?: string
  user?: string
  /** The host's home directory, when the connection reported it. */
  home?: string
}

/** This machine's identity: its home and the names its user goes by. */
export interface LocalIdentity {
  home?: string | null
  users?: string[]
}

export function localIdentity(env: Record<string, string | undefined> = process.env): LocalIdentity {
  const users = new Set<string>()
  let home: string | null = null
  try { home = os.homedir() || null } catch { /* no home */ }
  if (home) users.add(path.basename(home))
  try { users.add(os.userInfo().username) } catch { /* no passwd entry */ }
  for (const key of ['USER', 'LOGNAME']) if (env[key]) users.add(env[key] as string)
  return { home, users: [...users].filter((u) => u && !NOT_A_USER.has(u)) }
}

export function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/** An alias that names the machine itself (a dotted name, an IP, or the hostname) is private too. */
export function isSensitiveAlias(alias: string, hostname?: string): boolean {
  return alias.includes('.') || alias.includes(':') || isIpv4(alias) || (!!hostname && alias.toLowerCase() === hostname.toLowerCase())
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type Replacer = (s: string) => string

/** Replace `name` as a whole word (2+ chars) or only in identity contexts (one character). */
function nameReplacer(name: string, mask: string, kind: 'host' | 'user'): Replacer {
  const n = escapeRe(name)
  if (name.length >= 2) {
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${n}(?=$|[^A-Za-z0-9_-])`, 'g')
    return (s) => s.replace(re, (_m, lead: string) => `${lead}${mask}`)
  }
  const re = kind === 'host'
    ? new RegExp(`(@|//)${n}(?=$|[^A-Za-z0-9_.-])`, 'g')
    : new RegExp(`(^|[^A-Za-z0-9_.-])${n}(?=@)`, 'g')
  return (s) => s.replace(re, (_m, lead: string) => `${lead}${mask}`)
}

function homePrefixReplacer(home: string): Replacer {
  const h = home.replace(/[/\\]+$/, '')
  if (!h || h === '/' || h.length < 2) return (s) => s
  const re = new RegExp(`${escapeRe(h)}(?=$|[/\\\\\\s:;'"\`,)\\]])`, 'g')
  return (s) => s.replace(re, '~')
}

function mapStrings(value: unknown, fn: (s: string, key: string | undefined, inFreeText: boolean) => string, key?: string, inFree = false): unknown {
  const free = inFree || (key !== undefined && FREE_TEXT_KEYS.has(key))
  if (typeof value === 'string') return fn(value, key, free)
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, key, free))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn, k, free)
    return out
  }
  return value
}

/** Layer 1: every string through redactSensitiveText. Applied at the collector's exit. */
export function maskSecrets<T>(value: T): T {
  return mapStrings(value, (s) => redactSensitiveText(s)) as T
}

function isPublicHost(token: string): boolean {
  const t = token.toLowerCase()
  return PUBLIC_HOSTS.some((h) => t === h || t.endsWith(`.${h}`))
}

/** Unknown domains and IPv4 addresses in free text, and `user@` / URL user parts. */
function maskNetworkFragments(s: string): string {
  let out = s.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/:@[\]]+)(:[^\s/@]*)?@/gi, (_m, scheme: string, _user: string, pass: string | undefined) => `${scheme}[user]${pass ?? ''}@`)
  out = out.replace(/(^|[\s:/(='"<,])([A-Za-z0-9._-]+)@(?=[A-Za-z0-9[])/g, (_m, lead: string) => `${lead}[user]@`)
  return out.replace(/(?<![A-Za-z0-9_.-])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+(?![A-Za-z0-9_-])/g, (token) => {
    const labels = token.split('.')
    if (labels.every((l) => /^\d+$/.test(l))) return isIpv4(token) && !KEEP_IPS.has(token) ? '[ip]' : token
    const last = labels[labels.length - 1].toLowerCase()
    if (/^\d/.test(last) || FILE_EXTENSIONS.has(last) || isPublicHost(token)) return token
    if (labels.length >= 3 || TLDS.has(last)) return '[hostname]'
    return token
  })
}

export interface RedactOptions {
  /** Remote hosts in marker order. Default: the report's own hosts. */
  hosts?: HostIdentity[]
  /** Default: this process's home and user names. */
  local?: LocalIdentity
}

/** A text masker for the given identities (layer 2 without the report walk). */
export function identityMasker(hosts: HostIdentity[], local: LocalIdentity, extraNames: Iterable<string> = []): Replacer {
  const homes = [local.home, ...hosts.map((h) => h.home)].filter((h): h is string => !!h)
    .sort((a, b) => b.length - a.length).map(homePrefixReplacer)
  const hostReps: Array<[string, Replacer]> = []
  const userReps: Replacer[] = []
  hosts.forEach((h, i) => {
    const marker = `[host:${i + 1}]`
    if (h.hostname) hostReps.push([h.hostname, nameReplacer(h.hostname, marker, 'host')])
    if (isSensitiveAlias(h.alias, h.hostname) && h.alias !== h.hostname) hostReps.push([h.alias, nameReplacer(h.alias, marker, 'host')])
    if (h.user) userReps.push(nameReplacer(h.user, `[user:${i + 1}]`, 'user'))
  })
  hostReps.sort((a, b) => b[0].length - a[0].length)
  const names = new Set<string>([...(local.users ?? []), ...extraNames])
  for (const h of hosts) if (h.home) names.add(path.basename(h.home))
  const nameReps = [...names].filter((n) => n && !NOT_A_USER.has(n)).sort((a, b) => b.length - a.length)
    .map((n) => nameReplacer(n, ELLIPSIS, 'user'))
  return (s) => {
    let out = s
    for (const rep of homes) out = rep(out)
    out = out.replace(HOME_PATH_RE, (_m, prefix: string, name: string) => NOT_A_USER.has(name) ? `${prefix}${name}` : `${prefix}${ELLIPSIS}`)
    for (const [, rep] of hostReps) out = rep(out)
    for (const rep of userReps) out = rep(out)
    for (const rep of nameReps) out = rep(out)
    return out
  }
}

function homeNames(value: unknown): Set<string> {
  const names = new Set<string>()
  mapStrings(value, (s) => {
    for (const m of s.matchAll(HOME_PATH_RE)) if (!NOT_A_USER.has(m[2])) names.add(m[2])
    return s
  })
  return names
}

/** The report with identities masked (layer 2): safe to paste into a public issue. */
export function redactDiagnostics(report: DiagnosticsReport, opts: RedactOptions = {}): DiagnosticsReport {
  const own = report.hosts.map((h): HostIdentity => ({
    alias: h.alias, hostname: h.hostname, ...(h.user ? { user: h.user } : {}), ...(h.daemonDir?.home ? { home: h.daemonDir.home } : {}),
  }))
  // The caller's table keeps its order (its markers must match the rest of its text);
  // a host the table lacks (config changed, or unreadable) is appended, never left bare.
  const given = opts.hosts ?? []
  const byOwn = new Map(own.map((h) => [h.alias, h]))
  const known = new Set(given.map((h) => h.alias))
  const hosts: HostIdentity[] = [
    ...given.map((h) => ({ ...byOwn.get(h.alias), ...h, home: h.home ?? byOwn.get(h.alias)?.home })),
    ...own.filter((h) => !known.has(h.alias)),
  ]
  const mask = identityMasker(hosts, opts.local ?? localIdentity(), homeNames(report))
  // The fields that ARE an identity are replaced whole, whatever their length.
  const byAlias = new Map(hosts.map((h, i) => [h.alias, i + 1]))
  const fielded: DiagnosticsReport = {
    ...report,
    hosts: report.hosts.map((h) => {
      const n = byAlias.get(h.alias)
      if (n === undefined) return h
      return {
        ...h,
        alias: isSensitiveAlias(h.alias, h.hostname) ? `[host:${n}]` : h.alias,
        label: isSensitiveAlias(h.label, h.hostname) ? `[host:${n}]` : h.label,
        hostname: `[host:${n}]`,
        ...(h.user ? { user: `[user:${n}]` } : {}),
      }
    }),
  }
  return mapStrings(fielded, (s, _key, free) => {
    const out = mask(s)
    return free ? maskNetworkFragments(out) : out
  }) as DiagnosticsReport
}

/** The bug report's whole-text pass: the same host markers over free text. */
export function maskHostIdentitiesInText(text: string, hosts: HostIdentity[]): string {
  return identityMasker(hosts, { home: null, users: [] })(text)
}
