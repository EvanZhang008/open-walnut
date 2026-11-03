/**
 * Can this process reach the local network at all? (macOS only; local-network-alert.ts acts on it.)
 *
 * 2026-11-03: macOS judged Walnut's whole process tree as a re-bundled copy of Walnut.app whose
 * "Local Network" prompt had been answered Don't Allow. From then on every TCP connect to a
 * local-network address failed at once with EHOSTUNREACH, while the internet kept working.
 *
 * The check asks the router: the default gateway is on the local network by definition, so a
 * connect to it on 53, 80 or 443 either gets there (it connects, or the gateway refuses it,
 * which also proves the packet arrived) or macOS stops it before it leaves (EHOSTUNREACH at
 * once). Anything else (a timeout, no route, no private gateway) proves nothing and reads
 * 'unknown', which never opens or closes anything.
 *
 * EHOSTUNREACH alone is not proof: a gateway that stopped answering ARP fails the same way. So
 * 'blocked' also needs the gateway's link-layer address in the ARP table (`arp -n`), which says
 * the machine itself still talks to it; a block is per process, the ARP table is the system's.
 *
 * A second proof that the LAN works, asked for (`deep`) only while an episode is open and the
 * gateway's three ports said nothing: a gateway that drops them (or a full-tunnel VPN, which has
 * no gateway at all) would otherwise keep a letter open after the user fixed the setting. All at
 * once: a few more of the gateway's ports, and a few ports of up to MAX_NEIGHBORS machines the
 * ARP table already knows on a Wi-Fi or Ethernet interface (`en*`; never a VM bridge, which the
 * Local Network rule may not cover). Any one that connects or refuses proves it, since a blocked
 * process gets EHOSTUNREACH from every local address.
 *
 * Pure decision plus an injectable io; the default io is async only (execFile, node:net), so the
 * check never blocks the event loop.
 */
import { execFile } from 'node:child_process'
import net from 'node:net'

export type LocalNetworkVerdict = 'reachable' | 'blocked' | 'unknown'

/** One connect attempt: it connected, the gateway refused it, or the error code it failed with. */
export type ConnectOutcome = 'connected' | 'refused' | string

export interface LocalNetworkProbeIo {
  /** stdout of `route -n get default` ('' when it failed). */
  routeDefault: () => Promise<string>
  /** One TCP connect, settled within `timeoutMs`. */
  connect: (host: string, port: number, timeoutMs: number) => Promise<ConnectOutcome>
  /** stdout of `arp -n <gateway>` ('' when it failed); read only when every connect said EHOSTUNREACH. */
  gatewayArp: (gateway: string) => Promise<string>
  /** stdout of `arp -an` ('' when it failed); read only by a deep probe. */
  arpTable: () => Promise<string>
}

export interface LocalNetworkProbeResult {
  verdict: LocalNetworkVerdict
  gateway: string | null
  attempts: Array<{ port: number; outcome: ConnectOutcome }>
  /** The gateway's ARP entry is complete (null: not read, or unreadable). */
  linkKnown: boolean | null
  /** A deep probe's second proof: the address that answered. */
  proof?: { host: string; port: number; outcome: ConnectOutcome }
}

export const GATEWAY_PORTS = [53, 80, 443] as const
export const CONNECT_TIMEOUT_MS = 1500
export const ROUTE_TIMEOUT_MS = 3000
/** A deep probe's extra gateway ports, and the ports it tries on each known neighbour. */
export const RECOVERY_GATEWAY_PORTS = [22, 8080, 8443] as const
export const NEIGHBOR_PORTS = [80, 443, 22] as const
export const MAX_NEIGHBORS = 4

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** The `gateway:` of `route -n get default`, when it is an IPv4 address (an interface or IPv6 is null). */
export function parseDefaultGateway(routeOutput: string): string | null {
  const m = /^\s*gateway:\s*(\S+)\s*$/m.exec(routeOutput ?? '')
  const ip = m?.[1] ?? ''
  const parts = IPV4.exec(ip)
  if (!parts || parts.slice(1).some((o) => Number(o) > 255)) return null
  return ip
}

/** 10/8, 172.16/12, 192.168/16 and link-local 169.254/16: the addresses Local Network privacy covers. */
export function isPrivateIPv4(ip: string): boolean {
  const parts = IPV4.exec(ip)
  if (!parts) return false
  const [a, b] = [Number(parts[1]), Number(parts[2])]
  if (parts.slice(1).some((o) => Number(o) > 255)) return false
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/**
 * Whether `arp -n <gateway>` shows a link-layer address for it: true for a MAC, false for an
 * incomplete entry or none, null for output it does not recognise.
 */
export function parseArpLink(arpOutput: string, gateway: string): boolean | null {
  const line = (arpOutput ?? '').split('\n').find((l) => l.includes(`(${gateway})`))
  if (!line) return /no entry/i.test(arpOutput ?? '') ? false : null
  if (/\(incomplete\)|no entry/i.test(line)) return false
  return /\bat\s+[0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5}\b/i.test(line) ? true : null
}

const ARP_LINE = /^\S+\s+\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\s+on\s+(\S+)(.*)$/i

/**
 * The machines `arp -an` knows on a Wi-Fi or Ethernet interface (`en*`), private IPv4 only, in table
 * order. Never this Mac's own address (`permanent`), a broadcast or multicast entry, or one still
 * incomplete.
 */
export function parseArpNeighbors(arpAll: string): string[] {
  const out: string[] = []
  for (const line of (arpAll ?? '').split('\n')) {
    const m = ARP_LINE.exec(line.trim())
    if (!m) continue
    const [, ip, mac, iface, rest] = m as unknown as [string, string, string, string, string]
    if (!/^en\d+$/.test(iface) || /\bpermanent\b/.test(rest)) continue
    if (/^ff(?::ff){5}$/i.test(mac) || /^0?1:0?0:5e:/i.test(mac)) continue
    const last = Number(ip.split('.')[3])
    if (!isPrivateIPv4(ip) || last === 0 || last === 255 || out.includes(ip)) continue
    out.push(ip)
  }
  return out
}

/**
 * The verdict of the attempts made. Reachable as soon as one got there (connected or refused);
 * blocked only when there were attempts, every one failed with EHOSTUNREACH, and the machine
 * itself knows the gateway's link-layer address; else unknown.
 */
export function decideLocalNetwork(gateway: string | null, outcomes: readonly ConnectOutcome[], linkKnown: boolean | null = null): LocalNetworkVerdict {
  if (!gateway || !isPrivateIPv4(gateway)) return 'unknown'
  if (outcomes.some((o) => o === 'connected' || o === 'refused')) return 'reachable'
  if (outcomes.length > 0 && outcomes.every((o) => o === 'EHOSTUNREACH') && linkKnown === true) return 'blocked'
  return 'unknown'
}

/**
 * Ask the route table, then knock on the gateway's ports one at a time until one gets there.
 * `deep`: when that says nothing, look for a second proof that the LAN works (see the header).
 */
export async function probeLocalNetwork(io: LocalNetworkProbeIo, opts: { deep?: boolean } = {}): Promise<LocalNetworkProbeResult> {
  const gateway = parseDefaultGateway(await io.routeDefault().catch(() => ''))
  const main = await knockOnGateway(io, gateway)
  if (main.verdict !== 'unknown' || !opts.deep) return main
  const proof = await lanProof(io, gateway)
  return proof ? { ...main, verdict: 'reachable', proof } : main
}

async function knockOnGateway(io: LocalNetworkProbeIo, gateway: string | null): Promise<LocalNetworkProbeResult> {
  const attempts: LocalNetworkProbeResult['attempts'] = []
  if (!gateway || !isPrivateIPv4(gateway)) return { verdict: 'unknown', gateway, attempts, linkKnown: null }
  for (const port of GATEWAY_PORTS) {
    const outcome = await io.connect(gateway, port, CONNECT_TIMEOUT_MS).catch((err: unknown) => errCode(err))
    attempts.push({ port, outcome })
    if (outcome === 'connected' || outcome === 'refused') break
  }
  const outcomes = attempts.map((a) => a.outcome)
  // The ARP table is read only for a candidate block: a healthy network never spawns it.
  const linkKnown = outcomes.every((o) => o === 'EHOSTUNREACH')
    ? parseArpLink(await io.gatewayArp(gateway).catch(() => ''), gateway)
    : null
  return { verdict: decideLocalNetwork(gateway, outcomes, linkKnown), gateway, attempts, linkKnown }
}

/** Every candidate at once (each bounded by CONNECT_TIMEOUT_MS); the first that got there, or null. */
async function lanProof(io: LocalNetworkProbeIo, gateway: string | null): Promise<LocalNetworkProbeResult['proof'] | null> {
  const targets: Array<{ host: string; port: number }> = []
  if (gateway && isPrivateIPv4(gateway)) for (const port of RECOVERY_GATEWAY_PORTS) targets.push({ host: gateway, port })
  const known = parseArpNeighbors(await io.arpTable().catch(() => ''))
  // With no usable gateway (a full-tunnel VPN), the LAN's own router is one of the neighbours.
  for (const host of known.filter((h) => h !== gateway).slice(0, MAX_NEIGHBORS)) {
    for (const port of NEIGHBOR_PORTS) targets.push({ host, port })
  }
  const tried = await Promise.all(targets.map(async (t) => ({
    ...t, outcome: await io.connect(t.host, t.port, CONNECT_TIMEOUT_MS).catch((err: unknown) => errCode(err)),
  })))
  return tried.find((t) => t.outcome === 'connected' || t.outcome === 'refused') ?? null
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : 'ERROR'
}

// ── The real io (macOS) ──

function routeDefault(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/sbin/route', ['-n', 'get', 'default'], { timeout: ROUTE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      // No default route answers on stderr with a non-zero exit: no gateway, so unknown.
      resolve(err ? '' : String(stdout ?? ''))
    })
  })
}

function connect(host: string, port: number, timeoutMs: number): Promise<ConnectOutcome> {
  return new Promise((resolve) => {
    let done = false
    const socket = net.createConnection({ host, port })
    const timer = setTimeout(() => finish('ETIMEDOUT'), timeoutMs)
    timer.unref?.()
    socket.unref()
    function finish(outcome: ConnectOutcome): void {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(outcome)
    }
    socket.once('connect', () => finish('connected'))
    // `on`, not `once`: a late second error on a destroyed socket must never go unhandled.
    socket.on('error', (err) => {
      const code = errCode(err)
      finish(code === 'ECONNREFUSED' ? 'refused' : code)
    })
  })
}

function gatewayArp(gateway: string): Promise<string> {
  return new Promise((resolve) => {
    // `arp` exits non-zero for "no entry" but still says so on stdout, so stdout is read either way.
    execFile('/usr/sbin/arp', ['-n', gateway], { timeout: ROUTE_TIMEOUT_MS, encoding: 'utf8' }, (_err, stdout) => {
      resolve(String(stdout ?? ''))
    })
  })
}

function arpTable(): Promise<string> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/arp', ['-an'], { timeout: ROUTE_TIMEOUT_MS, encoding: 'utf8' }, (_err, stdout) => {
      resolve(String(stdout ?? ''))
    })
  })
}

export const defaultLocalNetworkProbeIo: LocalNetworkProbeIo = { routeDefault, connect, gatewayArp, arpTable }
