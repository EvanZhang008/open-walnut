/**
 * What each host can do, so a task on any host can find the one that has what
 * it needs (the user, 2026-10-31: "each node has different capability ... if it
 * needs iOS testing it can use our Mac's capability"). Pure: built from what the
 * fleet card already holds (the host's probed facts, its uptime ledger, its
 * profile) plus the tags the user declared for it in config
 * (`hosts.<key>.capabilities`, `local_capabilities` for this machine). fleet-model.ts attaches it to every card, so
 * `host_list` / `GET /api/v1/hosts` carry it, and `@tag` host selectors
 * (`host: "@ios"`) are matched against `tags` (host-select.ts).
 *
 * Tags: always-on, cloud, local, macos, linux, windows, ios, browser, docker,
 * mcp:<server name>, and the user's own. A capability the host's daemon could
 * not report (one older than host-caps-v1, or a host never probed) is listed in
 * `unknown`, never read as "no".
 */
import type { HostFacts } from '../../providers/host-facts-core.js'

export interface HostCapabilities {
  /** What a `@tag` selector matches. */
  tags: string[]
  /** Up at least LONG_RUNNING share of the last 7 days and not a laptop; null without a day of history. */
  alwaysOn: boolean | null
  placement: 'cloud' | 'local' | null
  os: 'macos' | 'linux' | 'windows' | null
  /** Full Xcode and its iOS simulator runtimes; null when the host has no Xcode. The `ios` tag needs a runtime. */
  ios: { xcode: string; runtimes: string[] } | null
  /** Browsers the Walnut browser extension drives (the user's own, signed in); empty when none. */
  browsers: Array<{ name: string; relay: boolean }>
  /** Claude Code MCP servers of the account on that host, by name. */
  mcp: Array<{ name: string; plugin?: string }>
  /** Command line tools found on its PATH (the probe's list). */
  clis: string[]
  /** Tags the user declared in config for this host. */
  declared: string[]
  /** Capabilities that could not be read (`ios`, `browser`, `mcp`, `always-on`, `system`). */
  unknown: string[]
}

export interface CapabilityInputs {
  probed: HostFacts | null | undefined
  /** The profile's kind (laptop, desktop, server, ...). */
  kind: string | null | undefined
  local: boolean
  /** 7-day window from the host's ledger. */
  week: { online: number | null; minutes: number } | null | undefined
  declared: unknown
}

export const ALWAYS_ON_MIN_SHARE = 0.95
const TAG_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/

/** A tag as stored and matched: lower case, no spaces; null when it is not one. */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim().toLowerCase()
  return TAG_RE.test(t) ? t : null
}

function osOf(platform: string | undefined): HostCapabilities['os'] {
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  if (platform === 'win32') return 'windows'
  return null
}

// A probe is a remote host's own word, and these values reach every session's
// prompt (fleet-prompt.ts): only shapes a real probe gives pass, the rest is dropped.
const BROWSER_NAMES = new Set(['chrome', 'brave', 'edge', 'chromium'])
const XCODE_RE = /^Xcode \d+(\.\d+)*( beta( \d+)?)?$/
const RUNTIME_RE = /^iOS \d+(\.\d+)*$/
const MCP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/

function cleanIos(v: HostFacts['ios'] | undefined): HostCapabilities['ios'] {
  if (!v || typeof v.xcode !== 'string' || !XCODE_RE.test(v.xcode)) return null
  const runtimes = (Array.isArray(v.runtimes) ? v.runtimes : []).filter((r) => typeof r === 'string' && RUNTIME_RE.test(r)).slice(0, 12)
  return { xcode: v.xcode, runtimes }
}

export function hostCapabilities(i: CapabilityInputs): HostCapabilities {
  const f = i.probed ?? null
  const unknown: string[] = []
  const os = osOf(f?.os?.platform)
  if (!f) unknown.push('system')
  let placement: HostCapabilities['placement'] = f?.cloud ? (f.cloud.imds ? 'cloud' : 'local') : null

  let alwaysOn: boolean | null = null
  if (i.local && i.kind === 'laptop') alwaysOn = false
  else if (i.week && i.week.online !== null && i.week.minutes >= 24 * 60) alwaysOn = i.week.online >= ALWAYS_ON_MIN_SHARE

  // A probe older than host-caps-v1 has none of these keys: unknown, not "no".
  // iOS needs macOS, so any other system is a known "no" even from an old daemon.
  const ios = os && os !== 'macos' ? null : (f && 'ios' in f ? cleanIos(f.ios) : null)
  if (f && os === 'macos' && !('ios' in f)) unknown.push('ios')
  if (!f && os === null) unknown.push('ios')
  const browsers = Array.isArray(f?.browsers)
    ? f!.browsers!.filter((b) => b && BROWSER_NAMES.has(b.name)).map((b) => ({ name: b.name, relay: b.relay === true }))
    : []
  if (!f || !Array.isArray(f.browsers)) unknown.push('browser')
  const mcp = Array.isArray(f?.mcp)
    ? f!.mcp!.filter((m) => m && typeof m.name === 'string' && MCP_NAME_RE.test(m.name)).slice(0, 64)
      .map((m) => (typeof m.plugin === 'string' && MCP_NAME_RE.test(m.plugin) ? { name: m.name, plugin: m.plugin } : { name: m.name }))
    : []
  if (!f || !('mcp' in f)) unknown.push('mcp')
  const clis = Object.entries(f?.tools ?? {}).filter(([, v]) => typeof v === 'string' && v).map(([k]) => k).sort()

  const declared = (Array.isArray(i.declared) ? i.declared : []).map(normalizeTag).filter((t): t is string => !!t)
  // The user knows better than a probe: a box on a cloud without EC2's metadata reads
  // as local, and a home server the ledger has not watched for a day yet is always on.
  if (declared.includes('cloud') || declared.includes('local')) placement = declared.includes('cloud') ? 'cloud' : 'local'
  if (declared.includes('always-on')) alwaysOn = true
  if (alwaysOn === null) unknown.push('always-on')
  const tags = new Set<string>()
  if (alwaysOn) tags.add('always-on')
  if (placement) tags.add(placement)
  if (os) tags.add(os)
  // A Mac with Xcode but no iOS simulator runtime downloaded cannot run an iOS test.
  if (ios?.runtimes.length) tags.add('ios')
  if (browsers.some((b) => b.relay)) tags.add('browser')
  if (clis.includes('docker')) tags.add('docker')
  for (const m of mcp) {
    const t = normalizeTag(`mcp:${m.name}`)
    if (t) tags.add(t)
  }
  for (const t of declared) tags.add(t)
  return { tags: [...tags], alwaysOn, placement, os, ios, browsers, mcp, clis, declared: [...new Set(declared)], unknown }
}

/** The capabilities in a few words, for the agent line and the session prompt. */
export function capabilityWords(c: HostCapabilities, opts: { os?: boolean } = {}): string {
  const words: string[] = []
  if (c.os && opts.os !== false) words.push(c.os === 'macos' ? 'macOS' : c.os === 'linux' ? 'Linux' : 'Windows')
  if (c.placement) words.push(c.placement)
  if (c.alwaysOn === true) words.push('always on')
  else if (c.alwaysOn === false) words.push('not always on')
  if (c.ios) {
    words.push(c.ios.runtimes.length
      ? `iOS (${c.ios.xcode}, ${c.ios.runtimes.length} simulator runtime${c.ios.runtimes.length === 1 ? '' : 's'})`
      : `${c.ios.xcode} without an iOS simulator runtime`)
  }
  if (c.tags.includes('browser')) words.push(`the user's browser (${c.browsers.filter((b) => b.relay).map((b) => b.name).join(', ')})`)
  if (c.tags.includes('docker')) words.push('docker')
  if (c.mcp.length) words.push(`${c.mcp.length} MCP server${c.mcp.length === 1 ? '' : 's'}`)
  for (const t of c.declared) if (!words.includes(t)) words.push(t)
  return words.join(', ')
}
