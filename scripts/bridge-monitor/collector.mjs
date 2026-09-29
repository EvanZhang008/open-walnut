#!/usr/bin/env node
/**
 * Bridge monitor collector: a long-running LaunchAgent process that records
 * the Mac side of the Mac to cloud bridge, change-only where it can, into
 * ~/Library/Logs/Walnut/bridge-monitor/YYYY-MM-DD.ndjson.
 *
 *   every 10 s   network (default route, scutil --nwi, utun, Wi-Fi link,
 *                egress route to the bridge host), power source, sleep gaps,
 *                and new bridge lines from the daemon + server logs
 *   every 60 s   load average, CPU idle, own CPU and memory
 *   every 5 min  public IP, bridge host DNS, Wi-Fi radio (also on every drop)
 *   every 15 min kernel tcp_connection_summary rows for the daemon (and the
 *                probe); the unified log keeps them only 1-2 hours
 *   daily        pmset sleep/wake log, sntp clock offset, retention
 *   live         an alert letter on a drop storm or a long awake outage
 *
 * Flags: --run-for <sec>  --print  --tcp-now  --daily-now  --radio-now
 *        --no-letters (a manual run: no alert, no outbox retry)
 * It must never crash-loop: config errors fall back to defaults, a missing
 * directory waits 10 minutes before exiting, and more than 5 starts in 10
 * minutes make it wait 10 minutes before working. One collector at a time
 * (a lock in the state dir); a second one exits 1.
 *
 * Privacy: no public IP, bridge host address, Wi-Fi name or BSSID is stored
 * (lib/privacy.mjs); the first start of this version scrubs older records.
 */

import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, readDaemonBridgeUrl } from './lib/config.mjs'
import { Store, localDay, prevDay, pruneStore } from './lib/store.mjs'
import { Tailer } from './lib/tail.mjs'
import { parseDaemonLine, parseServerLine } from './lib/parse-bridge.mjs'
import { buildLinks, classifyDrop, dropContext } from './lib/classify.mjs'
import { evaluateAlerts, freshAlertState } from './lib/alert.mjs'
import { buildAlertLetter } from './lib/letter.mjs'
import { deliverLetter, retryOutbox } from './lib/outbox.mjs'
import { killAllChildren, setChildRegistry, sweepRegistry } from './lib/run.mjs'
import { acquireLock, prepareDirs, releaseLock, StateWriter } from './lib/lifecycle.mjs'
import { fingerprint, loadKey, SCRUB_VERSION, scrubState, scrubStoreDir } from './lib/privacy.mjs'
import { heavyGuard } from './lib/pressure.mjs'
import { sweepWindowMin } from './lib/parse-tcp.mjs'
import { sleptInGap } from './lib/parse-net.mjs'
import * as S from './lib/samplers.mjs'

const VERSION = 'bridge-monitor-collector/4'
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const runForSec = Number(args[args.indexOf('--run-for') + 1]) || 0

const { cfg, error: cfgError } = loadConfig()
if (flag('--no-letters')) cfg.inbox = { ...cfg.inbox, enabled: false }
const store = new Store(cfg.logDir)
const STATE_FILE = path.join(cfg.stateDir, 'collector.json')
const LOCK_FILE = path.join(cfg.stateDir, 'collector.lock')
const CHILDREN_FILE = path.join(cfg.stateDir, 'children.json')
const NET_KEYS = ['primary', 'router', 'ipv4Ifaces', 'nwiIfaces', 'reachV4', 'reachV6', 'wifiLink', 'egressIface']
const TRANSITIONS = new Set(['connected', 'closed', 'silence', 'restart', 'conn-open', 'conn-close'])
const RECENT_MS = 3 * 3_600_000

async function loadState() {
  try { return JSON.parse(await fsp.readFile(STATE_FILE, 'utf-8')) } catch { return {} }
}

const state = {
  cursors: {}, last: {}, runs: {}, starts: [], tcpSeen: [], recent: [], recentServer: [], recentNet: [], recentLoad: [], gaps: [],
  alert: freshAlertState(), ...(await loadState()),
}
const tailer = new Tailer(state.cursors)
const writer = new StateWriter(STATE_FILE)
const inFlight = new Set()
const errorSeen = new Map()
let stopping = false
let privacyKey = null
/** An address of the bridge host for the egress route probe: memory only, never stored. */
let egressTo = null
let wifiInterface = cfg.wifiInterface
let lastWall = 0
let lastMono = 0
let lastCpu = os.cpus()
let lastSelfCpu = process.cpuUsage()
let maxTickLagMs = 0
const startedAt = Date.now()

function record(rec) {
  const r = { t: new Date().toISOString(), ...rec }
  if (flag('--print')) process.stdout.write(`${JSON.stringify(r)}\n`)
  return store.append(r)
}

function recordError(where, err) {
  const key = `${where}:${String(err).slice(0, 60)}`
  const last = errorSeen.get(key) ?? 0
  if (Date.now() - last < 600_000) return
  errorSeen.set(key, Date.now())
  void record({ kind: 'error', where, message: String(err?.message ?? err).slice(0, 300) })
}

/** Run a job at most once at a time; a heavy job never delays the 10 s tick. */
function job(name, fn) {
  if (inFlight.has(name)) return
  inFlight.add(name)
  Promise.resolve().then(fn).catch((err) => recordError(name, err)).finally(() => { inFlight.delete(name) })
}

const due = (name, everyMs) => Date.now() - (state.runs[name] ?? 0) >= everyMs
const mark = (name) => { state.runs[name] = Date.now() }
const trimRecent = (list) => list.filter((e) => Date.parse(e.t) > Date.now() - RECENT_MS)

// Sleep / starvation gaps
async function gapCheck() {
  const wall = Date.now()
  const mono = Number(process.hrtime.bigint() / 1_000_000n)
  const prevWall = lastWall
  const prevMono = lastMono
  lastWall = wall
  lastMono = mono
  if (prevWall) {
    const wallMs = wall - prevWall
    const monoMs = mono - prevMono
    const expected = cfg.netEverySec * 1000
    maxTickLagMs = Math.max(maxTickLagMs, monoMs - expected)
    if (wallMs > expected * 2.5) {
      // Asleep or starved? See sleptInGap: on macOS the monotonic clock runs
      // through sleep, so the kernel's last sleep and wake times decide.
      const kernel = await S.sampleSleepWake().catch(() => ({ sleepMs: null, wakeMs: null }))
      const sleptMs = sleptInGap({ startMs: prevWall, endMs: wall, monoMs, ...kernel, tickMs: expected })
      const iso = (x) => (x ? new Date(x).toISOString() : null)
      const gap = { kind: 'gap', wallMs, monoMs, sleptMs, kernelSleepAt: iso(kernel.sleepMs), kernelWakeAt: iso(kernel.wakeMs) }
      state.gaps = trimRecent([...state.gaps, { ...gap, t: new Date(wall).toISOString() }])
      void record(gap)
    }
  } else if (state.lastTickWall && wall - state.lastTickWall > cfg.netEverySec * 2500) {
    // The collector was not running: a hole in the coverage, sleep state unknown.
    const downMs = wall - state.lastTickWall
    state.gaps = trimRecent([...state.gaps, { t: new Date(wall).toISOString(), wallMs: downMs, sleptMs: null, resume: true }])
    void record({ kind: 'resume', downMs })
  }
  state.lastTickWall = wall
}

// Network + power (every tick, change-only)
async function netPass(trigger = null) {
  const snap = await S.sampleNet({ wifiInterface, egressTo })
  if (!snap.primary && !snap.nwiIfaces.length && !snap.reachV4) {
    // scutil answered nothing: a failed sample, not a network change.
    if (state.last.net?.primary) recordError('net', 'empty scutil sample')
    return
  }
  const prev = state.last.net
  // A key seen for the first time (null before, e.g. the egress route once
  // DNS resolved) is not a change.
  const changed = prev
    ? NET_KEYS.filter((k) => prev[k] != null && JSON.stringify(prev[k]) !== JSON.stringify(snap[k]))
    : []
  if (!prev || changed.length || trigger) {
    const rec = { kind: 'net', ...snap, changed, ...(prev ? {} : { first: true }), ...(trigger ? { trigger } : {}) }
    state.recentNet = trimRecent([...state.recentNet, { t: new Date().toISOString(), changed }])
    await record(rec)
  }
  state.last.net = snap
  const power = await S.samplePower()
  if (!power.source) return // failed sample (timeout or shutdown), not a change
  const p = state.last.power
  if (!p || p.source !== power.source || p.batteryState !== power.batteryState) await record({ kind: 'power', ...power })
  state.last.power = power
}

// Log tailing
function serverLogFiles() {
  const today = localDay(Date.now())
  return [prevDay(today), today].map((d) => path.join(cfg.serverLogDir, `open-walnut-${d}.log`))
}

async function firstSeenPolicy(file) {
  if (state.cursors[file]) return 'end'
  let st
  try { st = await fsp.stat(file) } catch { return 'end' }
  const cutoff = state.lastTailMs ? state.lastTailMs - 60_000 : Date.now() - cfg.backfillHours * 3_600_000
  return st.mtimeMs >= cutoff ? 'start' : 'end'
}

async function tailPass() {
  let names = []
  try { names = await fsp.readdir(cfg.daemonLogDir) } catch (err) { recordError('tail', err); return }
  const recs = []
  for (const name of names.filter((n) => /^daemon-d-.+\.log$/.test(n))) {
    const file = path.join(cfg.daemonLogDir, name)
    const lines = await tailer.read(file, { firstSeen: await firstSeenPolicy(file), filter: (l) => l.includes('"msg":"bridge') })
    for (const line of lines) {
      const e = parseDaemonLine(line)
      if (e) recs.push({ ...e, kind: 'daemon', file: name })
    }
  }
  for (const file of serverLogFiles()) {
    const lines = await tailer.read(file, { firstSeen: await firstSeenPolicy(file), filter: (l) => l.includes('DaemonConnection: ') })
    for (const line of lines) {
      const e = parseServerLine(line)
      if (e) recs.push({ ...e, kind: 'server' })
    }
  }
  state.lastTailMs = Date.now()
  if (!recs.length) return
  recs.sort((a, b) => Date.parse(a.t) - Date.parse(b.t))
  await store.append(recs)
  // Save the cursors now: a restart from a minute-old state would append these again.
  writer.requestWrite()
  if (flag('--print')) for (const r of recs) process.stdout.write(`${JSON.stringify(r)}\n`)
  const trans = recs.filter((r) => r.kind === 'daemon' && TRANSITIONS.has(r.ev))
  state.recent = trimRecent([...state.recent, ...trans])
  state.recentServer = trimRecent([...state.recentServer, ...recs.filter((r) => r.kind === 'server')])
  const freshDrop = trans.some((r) => (r.ev === 'closed' || r.ev === 'silence') && Date.now() - Date.parse(r.t) < 120_000)
  if (freshDrop) job('radio', () => radioPass('drop'))
}

// Alerts
async function alertPass() {
  const links = buildLinks(state.recent)
  const ctx = { server: state.recentServer, net: state.recentNet, gaps: state.gaps, pmset: [], tcp: [], daemonOther: [], load: state.recentLoad }
  for (const l of links) if (l.downMs != null) Object.assign(l, classifyDrop(l, dropContext(l.downMs, l, ctx)))
  const { alerts, state: next } = evaluateAlerts(state.alert, {
    links, gaps: state.gaps, load: state.recentLoad, nowMs: Date.now(), day: localDay(Date.now()),
  }, { ...cfg.alert, enabled: cfg.alert.enabled && cfg.inbox.enabled })
  state.alert = next
  if (alerts.length) writer.requestWrite() // never send the same alert twice after a crash
  for (const a of alerts) {
    const net = state.recentNet.filter((n) => n.changed?.length && Date.parse(n.t) > Date.now() - 15 * 60_000)
    const context = [`Mac network changes in the last 15 minutes: ${net.length}.`]
    // The letter lists exactly the drops the alert counted (a.drops), nothing from a wider window.
    const letter = buildAlertLetter(a, { drops: a.drops, tz: store.tz, context })
    const res = await deliverLetter(cfg, letter)
    // downMs + mech: what a later correction (lib/corrections.mjs) checks the verdict against.
    await record({
      kind: 'alert', reason: a.reason, count: a.count, durS: a.durS, downMs: a.downMs ?? null, fromMs: a.fromMs ?? null,
      mech: a.mech ?? null, basis: a.basis ?? null, delivered: res.ok, letterId: res.id ?? null, error: res.error ?? null,
    })
  }
}

// Periodic samplers
function bridgeHost() {
  const url = cfg.bridgeUrl || readDaemonBridgeUrl(cfg.daemonLogDir)
  try { return url ? new URL(url).hostname : null } catch { return null }
}

async function pubipPass() {
  // Only a keyed fingerprint of the address is kept (lib/privacy.mjs).
  const r = await S.samplePublicIp(cfg.publicIp.url, cfg.publicIp.timeoutMs, privacyKey)
  const prev = state.last.pubip
  const changed = !!(prev?.fp && r.fp && prev.fp !== r.fp)
  const heartbeat = Date.now() - (state.runs.pubipRecord ?? 0) > 3_600_000
  if (!prev || changed || heartbeat || (!!r.error !== !!prev?.error)) {
    await record({ kind: 'pubip', ms: r.ms, changed, ...(r.error ? { error: r.error } : {}) })
    state.runs.pubipRecord = Date.now()
  }
  if (r.fp || !prev) state.last.pubip = { fp: r.fp, ms: r.ms }
  job('dns', dnsPass)
}

async function dnsPass() {
  const host = bridgeHost()
  if (!host) return
  const d = await S.sampleDns(host)
  const fp = d.addrs.length ? fingerprint(privacyKey, d.addrs.join(',')) : null
  if ((fp && fp !== state.last.dnsFp) || d.error) {
    await record({ kind: 'dns', count: d.addrs.length, fp, ms: d.ms, changed: state.last.dnsFp != null && fp != null, ...(d.error ? { error: d.error } : {}) })
  }
  if (d.addrs.length) {
    state.last.dnsFp = fp
    egressTo = d.addrs.find((a) => a.includes('.')) ?? d.addrs[0]
  }
}

async function radioPass(trigger = 'timer') {
  if (!wifiInterface) return
  const { radio, cost } = await S.sampleWifiRadio()
  if (!radio) return
  const prev = state.last.radio
  const moved = !prev || ['channel', 'band', 'width', 'phy'].some((k) => prev[k] !== radio[k])
    || Math.abs((prev.signalDbm ?? 0) - (radio.signalDbm ?? 0)) >= 6
  if (moved || trigger === 'drop') await record({ kind: 'wifi', ...radio, trigger, cpuMs: cost?.cpuMs ?? null })
  state.last.radio = radio
}

async function probePid() {
  try {
    const pid = Number((await fsp.readFile(path.join(cfg.stateDir, 'probe.pid'), 'utf-8')).trim())
    if (!Number.isInteger(pid) || pid <= 1) return null
    process.kill(pid, 0) // existence check only, signal 0 sends nothing
    return pid
  } catch { return null }
}

/** Skip a heavy sample while the machine is saturated; say so in the record. */
async function heavyBusy(what) {
  const g = await heavyGuard(cfg.heavy)
  if (g.busy) await record({ kind: 'skip', what, reason: g.reason, slotsBusy: g.slotsBusy, pressure: g.pressure })
  return g.busy
}

async function tcpPass() {
  if (await heavyBusy('tcp-sweep')) {
    // Retry in retryMin; the window then stretches back to the last success.
    state.runs.tcp = Date.now() - (cfg.tcp.everyMin - cfg.tcp.retryMin) * 60_000
    return
  }
  const windowMin = sweepWindowMin(state.runs.tcpEnd ?? 0, Date.now(), cfg.tcp)
  const pid = await probePid()
  const res = await S.sweepTcp({ windowMin, processNames: cfg.tcp.processNames, pids: pid ? [pid] : [] })
  const seen = new Set(state.tcpSeen)
  const fresh = res.rows.filter((r) => !seen.has(r.soGen))
  state.tcpSeen = [...state.tcpSeen, ...fresh.map((r) => r.soGen)].slice(-5000)
  if (fresh.length) await store.append(fresh.map((r) => ({ ...r, kind: 'tcp', ...(pid && r.pid === pid ? { probe: true } : {}) })))
  state.runs.tcpEnd = Date.now()
  await record({
    kind: 'tcp-sweep', windowMin, rows: res.rows.length, newRows: fresh.length, wallMs: res.wallMs,
    cpuMs: res.cost?.cpuMs ?? null, maxRssMB: res.cost?.maxRssMB ?? null, timedOut: res.timedOut, error: res.error,
  })
}

async function loadPass() {
  const cpus = os.cpus()
  let idle = 0
  let total = 0
  cpus.forEach((c, i) => {
    const p = lastCpu[i]?.times
    if (!p) return
    const d = Object.fromEntries(Object.keys(c.times).map((k) => [k, c.times[k] - p[k]]))
    idle += d.idle
    total += Object.values(d).reduce((s, v) => s + v, 0)
  })
  lastCpu = cpus
  const self = process.cpuUsage(lastSelfCpu)
  lastSelfCpu = process.cpuUsage()
  const [l1, l5, l15] = os.loadavg()
  state.recentLoad = trimRecent([...state.recentLoad, { t: new Date().toISOString(), load1: +l1.toFixed(2) }])
  await record({
    kind: 'load', load1: +l1.toFixed(2), load5: +l5.toFixed(2), load15: +l15.toFixed(2),
    cpuIdlePct: total ? Math.round((idle / total) * 1000) / 10 : null,
    selfCpuMs: Math.round((self.user + self.system) / 1000), rssMB: Math.round(process.memoryUsage().rss / 1048576),
  })
}

async function dailyPass() {
  if (await heavyBusy('pmset-log')) {
    state.runs.dailyRetryAt = Date.now() + 30 * 60_000
    return
  }
  const since = Math.max(state.runs.pmsetLastMs ?? 0, Date.now() - cfg.daily.pmsetLookbackHours * 3_600_000)
  const { events, cost, error } = await S.samplePmsetLog(since)
  const fresh = events.filter((e) => Date.parse(e.t) > (state.runs.pmsetLastMs ?? 0))
  if (fresh.length) {
    await store.append(fresh.map((e) => ({ ...e, kind: 'pmset' })))
    state.runs.pmsetLastMs = Date.parse(fresh.at(-1).t)
  }
  // A cut-short read lost the NEWEST events (the log is oldest first): retry
  // in 30 minutes, and do not let this read vouch for the day's sleep.
  if (error) state.runs.dailyRetryAt = Date.now() + 30 * 60_000
  else state.runs.dailyDone = Date.now()
  const sntp = await S.sampleSntp(cfg.daily.sntpServer)
  const removed = await pruneStore(cfg.logDir, cfg.retentionDays, localDay(Date.now()))
  await tailer.prune() // forget cursors of logs that no longer exist
  await record({
    kind: 'daily', pmsetEvents: fresh.length, pmsetCpuMs: cost?.cpuMs ?? null, pmsetLookbackHours: cfg.daily.pmsetLookbackHours,
    pmsetError: error ?? null, pruned: removed.length,
  })
  await record({ kind: 'sntp', ...sntp })
  for (const name of ['collector.out.log', 'collector.err.log', 'probe.out.log', 'probe.err.log', 'summary.out.log', 'summary.err.log']) {
    const f = path.join(cfg.logDir, name)
    try { if ((await fsp.stat(f)).size > 5 * 1048576) await fsp.truncate(f, 0) } catch { /* absent */ }
  }
}

async function healthPass() {
  const cpu = process.cpuUsage()
  await record({
    kind: 'health', version: VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000),
    selfCpuS: Math.round((cpu.user + cpu.system) / 1e5) / 10, rssMB: Math.round(process.memoryUsage().rss / 1048576),
    maxTickLagMs: Math.round(maxTickLagMs), tailedFiles: Object.keys(state.cursors).length,
  })
  maxTickLagMs = 0
}

/** At most once a minute, only on change; forced on shutdown and after alerts / new records. */
function saveState(opts) {
  return writer.save(state, opts)
}

// Main loop
function dailyDue() {
  if (Date.now() < (state.runs.dailyRetryAt ?? 0)) return false
  if ((state.runs.dailyRetryAt ?? 0) > (state.runs.dailyDone ?? 0)) return true // a skipped run is owed
  const last = state.runs.daily ?? 0
  if (Date.now() - last > 24 * 3_600_000) return true
  // Once a day shortly before the 08:00 summary, so its sleep data is fresh.
  const hm = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date())
  return hm >= '07:40' && localDay(last) !== localDay(Date.now())
}

async function tick() {
  await gapCheck().catch((e) => recordError('gap', e))
  await Promise.all([netPass().catch((e) => recordError('net', e)), tailPass().catch((e) => recordError('tail', e))])
  await alertPass().catch((e) => recordError('alert', e))
  if (due('load', cfg.loadEverySec * 1000)) { mark('load'); job('load', loadPass) }
  if (due('pubip', cfg.publicIp.everyMin * 60_000)) { mark('pubip'); job('pubip', pubipPass) }
  if (due('radio', cfg.wifiRadioEveryMin * 60_000)) { mark('radio'); job('radio', () => radioPass('timer')) }
  if (due('tcp', cfg.tcp.everyMin * 60_000)) { mark('tcp'); job('tcp', tcpPass) }
  if (dailyDue()) { mark('daily'); job('daily', dailyPass) }
  if (cfg.inbox.enabled && due('outbox', 10 * 60_000)) { mark('outbox'); job('outbox', () => retryOutbox(cfg, record)) }
  if (due('health', 3_600_000)) { mark('health'); job('health', healthPass) }
  await saveState().catch((e) => recordError('state', e))
}

async function shutdown(code, why) {
  if (stopping) return
  stopping = true
  killAllChildren()
  try {
    await record({ kind: 'stop', why })
    await saveState({ force: true })
  } finally {
    releaseLock(LOCK_FILE)
    process.exit(code)
  }
}

async function crashLoopBackoff() {
  const now = Date.now()
  state.starts = [...(state.starts ?? []).filter((t) => now - t < 600_000), now]
  await saveState({ force: true })
  if (state.starts.length > 5) {
    await record({ kind: 'backoff', starts: state.starts.length, waitMin: 10 })
    await new Promise((r) => setTimeout(r, 600_000))
  }
}

/** Once per scrub version: remove what older versions stored (lib/privacy.mjs). */
async function scrubOnce(scrubbedEarly) {
  if ((state.scrubV ?? 0) >= SCRUB_VERSION) return
  const stateFields = [...scrubbedEarly, ...scrubState(state, privacyKey)]
  const counts = await scrubStoreDir(cfg.logDir, privacyKey)
  state.scrubV = SCRUB_VERSION
  await saveState({ force: true })
  await record({ kind: 'scrub', version: SCRUB_VERSION, files: counts.files, records: counts.records, fields: counts.fields, stateFields })
}

async function main() {
  // A directory that cannot be made would crash-loop before any backoff could run.
  if (!(await prepareDirs([cfg.logDir, cfg.stateDir]))) process.exit(1)
  const lock = await acquireLock(LOCK_FILE)
  if (!lock.ok) {
    // Exit 1: launchd starts the job again after ThrottleInterval, which is the retry.
    const why = lock.unknown ? `the lock holder pid ${lock.heldBy} could not be checked (ps failed), so it counts as running`
      : lock.heldBy ? `already running as pid ${lock.heldBy}` : lock.error
    process.stderr.write(`bridge monitor collector: ${why}; exiting\n`)
    process.exit(1)
  }
  // Every exit path: detached children are outside our process group.
  process.on('exit', () => { killAllChildren(); releaseLock(LOCK_FILE) })
  process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => void shutdown(0, 'SIGINT'))
  process.on('uncaughtException', (err) => { recordError('uncaught', err); void shutdown(1, 'uncaught') })
  process.on('unhandledRejection', (err) => recordError('unhandled', err))
  const orphans = await sweepRegistry(CHILDREN_FILE)
  for (const d of orphans.dropped) process.stderr.write(`bridge monitor collector: child registry entry pid ${d.pid} left alone (${d.reason})\n`)
  setChildRegistry(CHILDREN_FILE)
  privacyKey = loadKey(cfg.stateDir)
  const scrubbedEarly = scrubState(state, privacyKey) // before the first state write below
  await crashLoopBackoff()
  await scrubOnce(scrubbedEarly)
  wifiInterface = wifiInterface ?? (await S.detectWifiInterface())
  await record({
    kind: 'start', version: VERSION, pid: process.pid, node: process.version, wifiInterface,
    configError: cfgError, bridgeHostKnown: !!bridgeHost(), sleepCheck: 'kernel',
    ...(orphans.killed.length ? { orphansKilled: orphans.killed.length } : {}),
    ...(orphans.dropped.length ? { orphansLeftAlone: orphans.dropped.map((d) => d.reason) } : {}),
  })
  if (flag('--tcp-now')) state.runs.tcp = 0
  if (flag('--daily-now')) state.runs.daily = 0
  if (flag('--radio-now')) state.runs.radio = 0
  if (runForSec) setTimeout(() => void shutdown(0, `run-for ${runForSec}s`), runForSec * 1000)
  // The egress route needs the bridge host's address, which is kept in memory only.
  job('dns', dnsPass)
  const loop = async () => {
    if (stopping) return
    await tick().catch((e) => recordError('tick', e))
    setTimeout(loop, cfg.netEverySec * 1000)
  }
  await loop()
}

await main()
