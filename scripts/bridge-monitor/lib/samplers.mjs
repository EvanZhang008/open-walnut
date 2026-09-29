/**
 * Samplers: each runs macOS tools (async, bounded) and returns a record or
 * null. Change-only decisions live in the collector; these just measure.
 * Every binary is called by absolute path because a LaunchAgent starts with
 * a minimal PATH.
 */

import dns from 'node:dns'
import { run, runMeasured } from './run.mjs'
import { fingerprint } from './privacy.mjs'
import {
  parseIpconfigSummary, parseNwi, parsePmsetLog, parsePmsetPs, parseRouteGet,
  parseScutilState, parseSleepWake, parseSntp, parseSystemProfilerWifi,
} from './parse-net.mjs'
import { parseTcpSummaries, processFilter } from './parse-tcp.mjs'

const BIN = {
  scutil: '/usr/sbin/scutil',
  route: '/sbin/route',
  ipconfig: '/usr/sbin/ipconfig',
  pmset: '/usr/bin/pmset',
  networksetup: '/usr/sbin/networksetup',
  systemProfiler: '/usr/sbin/system_profiler',
  log: '/usr/bin/log',
  sntp: '/usr/bin/sntp',
}

const SCUTIL_SCRIPT = 'show State:/Network/Global/IPv4\nlist State:/Network/Interface/[^/]+/IPv4\n'

/** Wi-Fi device name from `networksetup -listallhardwareports` (null if none). */
export async function detectWifiInterface() {
  const res = await run(BIN.networksetup, ['-listallhardwareports'], { timeoutMs: 5000 })
  const m = /Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)/.exec(res.stdout)
  return m ? m[1] : null
}

/**
 * One network snapshot. `egressTo` = an IP of the bridge host, so the route
 * actually used to reach the cloud is recorded (a split-tunnel VPN can send
 * it through a utun while the default route stays on Wi-Fi).
 */
export async function sampleNet({ wifiInterface, egressTo }) {
  const [state, nwi, wifi, egress] = await Promise.all([
    run(BIN.scutil, [], { input: SCUTIL_SCRIPT, timeoutMs: 5000 }),
    run(BIN.scutil, ['--nwi'], { timeoutMs: 5000 }),
    wifiInterface ? run(BIN.ipconfig, ['getsummary', wifiInterface], { timeoutMs: 5000 }) : null,
    egressTo ? run(BIN.route, ['-n', 'get', egressTo], { timeoutMs: 5000 }) : null,
  ])
  const s = parseScutilState(state.stdout)
  const n = parseNwi(nwi.stdout)
  const w = wifi ? parseIpconfigSummary(wifi.stdout) : null
  const e = egress ? parseRouteGet(egress.stdout) : null
  return {
    primary: s.primary,
    router: s.router,
    ipv4Ifaces: s.ipv4Ifaces,
    utun: s.ipv4Ifaces.filter((i) => i.startsWith('utun')),
    nwiIfaces: n.ifaces,
    reachV4: n.reachV4,
    reachV6: n.reachV6,
    wifiLink: w?.link ?? null,
    egressIface: e?.iface ?? null,
  }
}

export async function samplePower() {
  const res = await run(BIN.pmset, ['-g', 'ps'], { timeoutMs: 5000 })
  return parsePmsetPs(res.stdout)
}

/** Wi-Fi radio (channel, signal) from system_profiler: slow (~10 s wall), so run rarely. */
export async function sampleWifiRadio() {
  const res = await runMeasured(BIN.systemProfiler, ['SPAirPortDataType', '-detailLevel', 'basic'], { timeoutMs: 90_000, track: true })
  return { radio: parseSystemProfilerWifi(res.stdout), cost: res.cost, timedOut: res.timedOut }
}

/**
 * Whether the public IP changed, from a plain-text echo service. The address
 * itself never leaves this function: only its keyed fingerprint (privacy.mjs).
 */
export async function samplePublicIp(url, timeoutMs = 5000, key = null, fetchImpl = fetch) {
  const started = Date.now()
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'walnut-bridge-monitor' } })
    const body = (await res.text()).trim()
    if (!res.ok || !/^[0-9a-fA-F:.]{3,45}$/.test(body)) return { fp: null, ms: Date.now() - started, error: `HTTP ${res.status}` }
    return { fp: key ? fingerprint(key, body) : null, ms: Date.now() - started }
  } catch (err) {
    return { fp: null, ms: Date.now() - started, error: String(err?.cause?.code ?? err?.name ?? err) }
  }
}

let lookupPending = false

/**
 * The bridge host's addresses, with a deadline. `dns.lookup` runs on the libuv
 * thread pool and cannot be cancelled, so a lookup that never answers is
 * abandoned (not awaited) and no second one starts until it settles: four
 * wedged lookups would hold every pool thread and stall all file I/O.
 */
export async function sampleDns(host, { timeoutMs = 5000, lookup = dns.promises.lookup } = {}) {
  const started = Date.now()
  if (lookupPending) return { addrs: [], ms: 0, error: 'previous lookup still running' }
  lookupPending = true
  const pending = Promise.resolve().then(() => lookup(host, { all: true })).finally(() => { lookupPending = false })
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs) })
  try {
    const addrs = await Promise.race([pending, deadline])
    return { addrs: [...new Set(addrs.map((a) => a.address))].sort(), ms: Date.now() - started }
  } catch (err) {
    pending.catch(() => {}) // the abandoned lookup may still fail later
    return { addrs: [], ms: Date.now() - started, error: String(err?.code ?? err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Kernel tcp_connection_summary rows for the watched processes, from the
 * last `windowMin` minutes of the unified log. The unified log keeps these
 * for only 1-2 hours, so this has to run on a timer; it cannot be done later.
 */
export async function sweepTcp({ windowMin, processNames, pids = [] }) {
  const procTerms = [
    ...processNames.map((n) => `eventMessage CONTAINS "process: ${n.slice(0, 16).replace(/"/g, '')}"`),
    ...pids.filter((p) => Number.isInteger(p) && p > 1)
      .flatMap((p) => [`eventMessage CONTAINS ":${p} Duration"`, `eventMessage CONTAINS ":${p} flowctl"`]),
  ]
  const predicate = `process == "kernel" AND eventMessage CONTAINS "tcp_connection_summary"${procTerms.length ? ` AND (${procTerms.join(' OR ')})` : ''}`
  const res = await runMeasured(BIN.log, ['show', '--last', `${windowMin}m`, '--style', 'ndjson', '--predicate', predicate], {
    timeoutMs: 300_000, maxBytes: 256 * 1024 * 1024, track: true,
  })
  const rows = parseTcpSummaries(res.stdout, { keep: processFilter(processNames, pids) })
  return { rows, cost: res.cost, wallMs: res.ms, timedOut: res.timedOut, error: res.error ?? (res.code !== 0 ? `exit ${res.code}` : null) }
}

/**
 * Sleep and wake events from `pmset -g log`. The log is oldest first, so a
 * read cut short (timeout, output cap) silently loses the NEWEST events: the
 * caller must treat timedOut / truncated / a non-zero exit as a failed read.
 */
export async function samplePmsetLog(sinceMs) {
  const res = await runMeasured(BIN.pmset, ['-g', 'log'], { timeoutMs: 300_000, maxBytes: 256 * 1024 * 1024, track: true })
  const failed = res.timedOut || res.truncated || res.code !== 0
  return {
    events: parsePmsetLog(res.stdout, { sinceMs }), cost: res.cost, wallMs: res.ms,
    error: failed ? (res.error ?? (res.truncated ? 'output cap' : `exit ${res.code}`)) : null,
  }
}

export async function sampleSntp(server) {
  const res = await run(BIN.sntp, ['-t', '5', server], { timeoutMs: 15_000 })
  return parseSntp(res.stdout) ?? { error: (res.stderr || res.error || `exit ${res.code}`).trim().slice(0, 120) }
}

/** The kernel's last sleep and wake times (epoch ms), a few ms of sysctl. */
export async function sampleSleepWake() {
  const res = await run('/usr/sbin/sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], { timeoutMs: 3000 })
  return parseSleepWake(res.stdout)
}
