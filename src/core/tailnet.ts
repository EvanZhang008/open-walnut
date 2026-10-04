/**
 * Tailnet direct access: is this machine on a tailnet, and at which address?
 *
 * A tailnet (Tailscale, Headscale, Netbird; all hand out 100.64.0.0/10) lets a
 * phone reach this Mac from anywhere, straight to the server's own port. The
 * server already listens on every interface and every non-loopback request
 * still needs a device token, so offering the address grants nothing by itself.
 *
 * Two answers, two costs:
 *  - `detectTailnetAddress()` is a synchronous interface scan (no spawn), cheap
 *    enough for any request path;
 *  - `tailscaleStatus()` runs the Tailscale CLI (`status --json`) with an async
 *    spawn, a 3s deadline and a cached answer. Never a synchronous spawn: one
 *    on a route freezes every route (tests/core/event-loop-blocking-ratchet.test.ts).
 *    `tailscaleDetail()` reads the same probe (plus the sign-in link and the
 *    peers) for the console's setup card, and can ask again at most every 3s.
 */

import os from 'node:os'
import path from 'node:path'
import { access, constants as fsConstants } from 'node:fs/promises'
import { execFile } from 'node:child_process'

/** True for an IPv4 address in 100.64.0.0/10 (carrier-grade NAT, which tailnets reuse). */
export function isCgnatV4(ip: string): boolean {
  const p = ip.split('.')
  if (p.length !== 4 || p.some((s) => !/^\d{1,3}$/.test(s))) return false
  const n = p.map(Number)
  if (n.some((v) => v > 255)) return false
  return n[0] === 100 && n[1] >= 64 && n[1] <= 127
}

/** A browser origin host that is on a tailnet: a 100.64/10 address or a MagicDNS `*.ts.net` name. */
export function isTailnetHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return isCgnatV4(h) || /\.ts\.net\.?$/.test(h)
}

/**
 * Interfaces that are a real Wi-Fi or Ethernet link. A 100.64/10 address there
 * is the carrier's NAT (a phone hotspot, some ISPs), unreachable from anywhere
 * else, never a tailnet: Tailscale uses `utun*` (macOS) or `tailscale0` (Linux).
 */
const PHYSICAL_IFACE = /^(en|eth|wl)/

/** Tunnel names a tailnet client uses, ranked first. */
const TAILNET_IFACE = /^(tailscale|utun|wg|ts)/

/**
 * This machine's tailnet IPv4, if it has one. Only non-internal IPv4 in
 * 100.64/10 qualifies; tunnel interfaces rank first, physical links never count.
 */
export function detectTailnetAddress(): { address: string; iface: string } | null {
  const candidates: Array<{ address: string; iface: string }> = []
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    if (PHYSICAL_IFACE.test(iface)) continue
    for (const addr of addrs ?? []) {
      // Node 18.0 to 18.3 reported family as a number.
      const v4 = addr.family === 'IPv4' || (addr.family as unknown) === 4
      if (!v4 || addr.internal || !isCgnatV4(addr.address)) continue
      candidates.push({ address: addr.address, iface })
    }
  }
  if (candidates.length === 0) return null
  const rank = (iface: string) => (TAILNET_IFACE.test(iface) ? 0 : 1)
  candidates.sort((a, b) => rank(a.iface) - rank(b.iface))
  return candidates[0]
}

// ── Tailscale CLI probe ────────────────────────────────────────────────────

export interface TailscaleStatus {
  /** The `tailscale` CLI exists on this machine. */
  installed: boolean
  /** Its backend reports `Running` (logged in and connected). */
  running: boolean
  /** This machine's MagicDNS name, without the trailing dot. */
  dnsName?: string
  /** This machine's tailnet addresses (IPv4 and IPv6). */
  ips: string[]
}

/** Another machine on the same tailnet, as `status --json` lists it under `Peer`. */
export interface TailscalePeer {
  hostName: string
  /** `iOS`, `android`, `macOS`, `linux`, `windows`; empty when not reported. */
  os: string
  online: boolean
}

/** What the guided setup card needs beyond TailscaleStatus (src/web/routes/devices-tailscale.ts). */
interface TailscaleExtra {
  /** The sign-in page, only while the backend says NeedsLogin and printed one. */
  loginUrl?: string
  peers: TailscalePeer[]
}

/** This machine on the tailnet, for the console's setup card and a phone's routes. */
export interface TailscaleDetail {
  installed: boolean
  /**
   * The CLI says its backend runs; with no answer from a CLI, this machine has
   * a tailnet address anyway (Headscale, Netbird).
   */
  running: boolean
  dnsName?: string
  /** This machine's 100.64/10 IPv4. */
  address?: string
  loginUrl?: string
  peers: TailscalePeer[]
}

type ExecResult = { stdout: string; stderr: string }
type ExecFn = (file: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<ExecResult>

const PROBE_TIMEOUT_MS = 3_000
const PROBE_MAX_BUFFER = 400 * 1024
const OK_TTL_MS = 60_000
const FAILED_TTL_MS = 10_000
/** A `refresh` asks the CLI again, but never more often than this. */
const REFRESH_FLOOR_MS = 3_000
const MAX_PEERS = 50

/** Where the CLI lives when it is not on PATH: the macOS app, then the usual bin dirs. */
const FALLBACK_CLI_PATHS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
]

const realExec: ExecFn = (file, args, opts) => new Promise((resolve, reject) => {
  // SIGKILL at the deadline: a CLI that ignored SIGTERM would hold the probe open.
  execFile(file, args, { ...opts, killSignal: 'SIGKILL', encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) {
      // Keep what the CLI printed: it exits non-zero in some states but still says why.
      reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
      return
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
})

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `which tailscale` over PATH, then the fallback locations. Null = not installed. */
async function realLocate(): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'tailscale')
    if (await isExecutable(candidate)) return candidate
  }
  for (const candidate of FALLBACK_CLI_PATHS) {
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

/**
 * One probe's answer as the cache keeps it. `at` = when it landed; `definite` =
 * the CLI printed its JSON (logged out, stopped and running all count).
 */
type Entry = { value: TailscaleStatus; extra: TailscaleExtra; definite: boolean; at: number; expiresAt: number }

let execImpl: ExecFn = realExec
let locateImpl: () => Promise<string | null> = realLocate
let cached: Entry | null = null
let inFlight: Promise<Entry> | null = null
/** Bumped by forgetTailscaleStatus(): a probe that began before it never writes the cache. */
let generation = 0

type StatusDoc = {
  BackendState: string
  AuthURL?: unknown
  Self?: { DNSName?: unknown; TailscaleIPs?: unknown }
  Peer?: unknown
}

function parseDoc(raw: string): StatusDoc | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || typeof (parsed as { BackendState?: unknown }).BackendState !== 'string') return null
  return parsed as StatusDoc
}

function statusOf(doc: StatusDoc): Omit<TailscaleStatus, 'installed'> {
  const dns = typeof doc.Self?.DNSName === 'string' ? doc.Self.DNSName.replace(/\.$/, '') : ''
  const ips = Array.isArray(doc.Self?.TailscaleIPs)
    ? doc.Self.TailscaleIPs.filter((ip): ip is string => typeof ip === 'string')
    : []
  return { running: doc.BackendState === 'Running', ...(dns ? { dnsName: dns } : {}), ips }
}

const isMobileOs = (os: string) => /^(ios|ipados|android)$/i.test(os)

function extraOf(doc: StatusDoc): TailscaleExtra {
  // Only an https page goes into a link the console renders.
  const loginUrl = doc.BackendState === 'NeedsLogin' && typeof doc.AuthURL === 'string' && /^https:\/\/\S+$/.test(doc.AuthURL)
    ? doc.AuthURL : undefined
  const peers: TailscalePeer[] = []
  if (doc.Peer && typeof doc.Peer === 'object') {
    for (const p of Object.values(doc.Peer as Record<string, unknown>)) {
      if (!p || typeof p !== 'object') continue
      const { HostName, DNSName, OS, Online } = p as { HostName?: unknown; DNSName?: unknown; OS?: unknown; Online?: unknown }
      // The tailnet's machine name (the DNSName's first label, what the Tailscale
      // app and admin console show) beats the OS hostname: an iPhone reports
      // HostName "localhost" while its machine name is "iphone182".
      const dnsLabel = typeof DNSName === 'string' ? DNSName.split('.')[0] : ''
      const hostName = dnsLabel || (typeof HostName === 'string' ? HostName : '')
      if (!hostName) continue
      peers.push({ hostName: hostName.slice(0, 120), os: typeof OS === 'string' ? OS.slice(0, 40) : '', online: Online === true })
    }
  }
  // A busy tailnet is cut at MAX_PEERS: online phones first, so the cut never hides the one the card looks for.
  const rank = (p: TailscalePeer) => (p.online ? 0 : 2) + (isMobileOs(p.os) ? 0 : 1)
  peers.sort((a, b) => rank(a) - rank(b) || a.hostName.localeCompare(b.hostName))
  return { ...(loginUrl ? { loginUrl } : {}), peers: peers.slice(0, MAX_PEERS) }
}

/** Read `status --json` output. Null when it is not the JSON the CLI prints. */
export function parseTailscaleStatusJson(raw: string): Omit<TailscaleStatus, 'installed'> | null {
  const doc = parseDoc(raw)
  return doc ? statusOf(doc) : null
}

/** The exec, but never past its deadline plus a second, whatever the child does. */
function execWithDeadline(cli: string): Promise<ExecResult> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('tailscale status: no answer')), PROBE_TIMEOUT_MS + 1_000)
    timer.unref?.()
  })
  return Promise.race([execImpl(cli, ['status', '--json'], { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BUFFER }), deadline])
    .finally(() => clearTimeout(timer))
}

/** One probe. `ok` = a definite answer (cached longer); a timeout or garbage is not. */
async function probe(): Promise<{ value: TailscaleStatus; extra: TailscaleExtra; ok: boolean; definite: boolean }> {
  const cli = await locateImpl()
  if (!cli) return { value: { installed: false, running: false, ips: [] }, extra: { peers: [] }, ok: true, definite: false }
  let stdout = ''
  let ok = true
  try {
    stdout = (await execWithDeadline(cli)).stdout
  } catch (err) {
    // Non-zero exit: a stopped or logged-out client may still print its JSON.
    stdout = typeof (err as { stdout?: unknown }).stdout === 'string' ? (err as { stdout: string }).stdout : ''
    ok = false
  }
  const doc = parseDoc(stdout)
  if (!doc) return { value: { installed: true, running: false, ips: [] }, extra: { peers: [] }, ok: false, definite: false }
  return { value: { installed: true, ...statusOf(doc) }, extra: extraOf(doc), ok, definite: true }
}

/**
 * The cached probe, or a new one. `force` (a refresh) skips the TTL but reuses
 * an answer younger than REFRESH_FLOOR_MS. Concurrent callers share one probe.
 */
function loadEntry(force: boolean): Promise<Entry> {
  const now = Date.now()
  if (cached && (force ? now - cached.at < REFRESH_FLOOR_MS : now < cached.expiresAt)) return Promise.resolve(cached)
  if (inFlight) return inFlight
  const gen = generation
  const p: Promise<Entry> = (async () => {
    let entry: Entry
    try {
      const { value, extra, ok, definite } = await probe()
      const at = Date.now()
      entry = { value, extra, definite, at, expiresAt: at + (ok ? OK_TTL_MS : FAILED_TTL_MS) }
    } catch {
      const at = Date.now()
      entry = { value: { installed: false, running: false, ips: [] }, extra: { peers: [] }, definite: false, at, expiresAt: at + FAILED_TTL_MS }
    }
    if (gen === generation) cached = entry
    return entry
  })().finally(() => {
    if (inFlight === p) inFlight = null
  })
  inFlight = p
  return p
}

/**
 * Tailscale's own view of this machine. Cached 60s (10s after a failed probe),
 * and concurrent callers share one probe. Never throws.
 */
export async function tailscaleStatus(): Promise<TailscaleStatus> {
  return (await loadEntry(false)).value
}

/** Drop the cached answer (Tailscale was just installed): the next caller asks the CLI again. */
export function forgetTailscaleStatus(): void {
  generation += 1
  cached = null
  inFlight = null
}

function detailOf(entry: Entry): TailscaleDetail {
  const { value, extra, definite } = entry
  const iface = detectTailnetAddress()
  // The CLI's own answer wins: another VPN can hold a 100.64/10 address too
  // (Cloudflare WARP does), and "Connected" over a Tailscale that still needs a
  // sign-in would hide the Sign in step. The interface scan stands in only when
  // the CLI gave no answer: not installed (Headscale, Netbird), or a failed probe.
  const running = definite ? value.running : value.running || iface !== null
  const address = definite
    ? (value.running ? value.ips.find(isCgnatV4) ?? iface?.address : undefined)
    : iface?.address
  return {
    installed: value.installed,
    running,
    ...(value.dnsName ? { dnsName: value.dnsName } : {}),
    ...(address ? { address } : {}),
    ...(extra.loginUrl ? { loginUrl: extra.loginUrl } : {}),
    peers: extra.peers,
  }
}

/** The setup card's view. `refresh` asks the CLI again (at most every 3s). Never throws. */
export async function tailscaleDetail(opts: { refresh?: boolean } = {}): Promise<TailscaleDetail> {
  return detailOf(await loadEntry(!!opts.refresh))
}

/** How long a request path waits for the very first probe before answering without it. */
export const PEEK_WAIT_MS = 800
let peekWaitMs = PEEK_WAIT_MS

/**
 * tailscaleStatus() for request paths: a fresh cached answer at once; a stale
 * one at once while a refresh runs in the background; with no answer yet, the
 * first probe for at most `waitMs`, then null ("not known yet"), so a slow CLI
 * never holds a console list for its whole 3s deadline.
 */
export async function peekTailscaleStatus(waitMs = peekWaitMs): Promise<TailscaleStatus | null> {
  return (await peekEntry(waitMs))?.value ?? null
}

async function peekEntry(waitMs: number): Promise<Entry | null> {
  if (cached && Date.now() < cached.expiresAt) return cached
  const stale = cached
  const refresh = loadEntry(false)
  if (stale) return stale
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([refresh, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** What the console shows next to the pairing targets (no addresses); null while not known yet. */
export async function tailscaleSummary(): Promise<{ installed: boolean; running: boolean; dnsName?: string } | null> {
  const s = await peekTailscaleStatus()
  if (!s) return null
  return { installed: s.installed, running: s.running, ...(s.dnsName ? { dnsName: s.dnsName } : {}) }
}

/**
 * The setup card's `installed` / `running` / `dnsName` for a request path that
 * must not wait out the CLI (a phone's GET /api/v1/routes); null while not known yet.
 */
export async function peekTailscaleBrief(waitMs = peekWaitMs): Promise<{ installed: boolean; running: boolean; dnsName?: string } | null> {
  const entry = await peekEntry(waitMs)
  if (!entry) return null
  const { installed, running, dnsName } = detailOf(entry)
  return { installed, running, ...(dnsName ? { dnsName } : {}) }
}

/**
 * Test seam: replace the CLI lookup and/or the spawn (and the request-path
 * wait). `null` restores all three.
 * Always clears the cache, so a case never sees the previous case's answer.
 */
export function _setTailscaleProbeForTesting(
  impl: { locate?: () => Promise<string | null>; exec?: ExecFn; peekWaitMs?: number } | null,
): void {
  locateImpl = impl?.locate ?? realLocate
  execImpl = impl?.exec ?? realExec
  peekWaitMs = impl?.peekWaitMs ?? PEEK_WAIT_MS
  forgetTailscaleStatus()
}
