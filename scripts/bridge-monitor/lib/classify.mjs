/**
 * Flap classifier: turns daemon bridge events into links (connected
 * intervals), then explains every drop with the evidence around it.
 * Port of the investigation's census.py (links), join.py (replica join) and
 * the M1-M4 rules behind flaps-classified.tsv, extended with Mac-side
 * evidence so a drop can still be classified before replica logs exist.
 *
 *   M1  reset or closed from the far side: the replica saw the close within
 *       2 s (or its silence sweep closed it), or the Mac kernel saw a peer
 *       reset / FIN, or the far end sent a close frame, with no Mac network
 *       change. Without a replica log this cannot tell the cloud from a
 *       middlebox on the way, and the wording says so.
 *   M2  network path drop: the replica never saw the close (it only noticed
 *       when the redial replaced it), or the Mac's SSH links died at the same
 *       moment, or the Mac network changed, or the kernel gave up on the
 *       socket (timeout or lost local address).
 *   M3  Mac asleep / DarkWake, whether the watchdog or a plain close ended it.
 *   M4  daemon restart (deploy or reconfigure).
 *   M5  silent while awake: the watchdog fired, the collector sampled the
 *       Mac awake through the whole silence, and the daemon's own event loop
 *       was not stalled long enough to explain it (or its stall is unknown:
 *       the letter then says so). The Mac side cannot say where the traffic
 *       stopped.
 *   M6  Mac daemon froze: the watchdog fired while the Mac was awake, and the
 *       daemon's event-loop stall covers so much of the silence that what is
 *       left is under the 75 s watchdog limit. Without the stall it would not
 *       have fired; the cause is on the Mac. (Live 2026-09-27/28: 7 of 8
 *       "silent while awake" drops were this, at load around 300.)
 *   M?  no cause found yet: a close with no corroborating evidence, a local
 *       abort, or a silence with no record of whether the Mac was awake.
 */

import { isPowerEvent, powerStateAt } from './parse-net.mjs'
import { tcpEnding } from './parse-tcp.mjs'

export const MECH_LABELS = {
  M1: 'reset or closed from the far side',
  M2: 'network path drop',
  M3: 'Mac asleep or DarkWake',
  M4: 'daemon restart',
  M5: 'silent while awake',
  M6: 'Mac daemon froze',
  'M?': 'no cause found yet',
}
export const MECHS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M?']

/** The daemon's inbound silence watchdog (BRIDGE_SILENCE_MS in daemon-standalone.ts). */
export const BRIDGE_SILENCE_MS = 75_000
/** Load samples come every 60 s; two more than this apart leave a hole in the coverage. */
export const MAX_SAMPLE_GAP_MS = 120_000

const ms = (t) => (typeof t === 'number' ? t : Date.parse(t))
const byTime = (a, b) => ms(a.t) - ms(b.t)

/**
 * Links from daemon events (census.py): a `connected` opens a link, the next
 * transition event closes it with a cause. conn-open / conn-close records
 * (newer daemons) attach their fields to the link they describe.
 */
export function buildLinks(daemonEvents) {
  const events = daemonEvents.filter((e) => e.ev).slice().sort(byTime)
  const links = []
  let cur = null
  let pendingOpen = null
  for (const e of events) {
    const t = ms(e.t)
    if (e.ev === 'conn-open') {
      if (cur && Math.abs(t - cur.upMs) < 5000 && !cur.connId) Object.assign(cur, { connId: e.connId, dialMs: e.dialMs })
      else pendingOpen = e
      continue
    }
    if (e.ev === 'conn-close') {
      const target = cur ?? links.at(-1)
      if (target && (!target.downMs || Math.abs(t - target.downMs) < 5000)) target.close = pickClose(e)
      continue
    }
    if (e.ev === 'connected') {
      if (cur) continue
      const last = links.at(-1)
      if (last?.downMs != null && last.reconnectS == null) last.reconnectS = (t - last.downMs) / 1000
      cur = { upAt: e.t, upMs: t, file: e.file ?? null }
      if (e.connId != null) Object.assign(cur, { connId: e.connId, dialMs: e.dialMs })
      else if (pendingOpen && Math.abs(ms(pendingOpen.t) - t) < 5000) {
        Object.assign(cur, { connId: pendingOpen.connId, dialMs: pendingOpen.dialMs })
      }
      pendingOpen = null
      continue
    }
    if (!cur) continue
    let cause = null
    if (e.ev === 'closed') cause = 'closed'
    else if (e.ev === 'silence') cause = 'silence'
    else if (e.ev === 'restart') cause = 'restart'
    if (!cause) continue
    Object.assign(cur, {
      downAt: e.t, downMs: t, upS: (t - cur.upMs) / 1000, cause,
      ...(e.silentMs != null ? { silentMs: e.silentMs } : {}),
      ...(e.reason != null && cause === 'restart' ? { restartReason: e.reason } : {}),
    })
    links.push(cur)
    cur = null
  }
  if (cur) links.push(cur)
  return links
}

const CLOSE_FIELDS = ['connId', 'uptimeMs', 'code', 'reason', 'wasClean', 'lastError', 'bytesIn', 'bytesOut',
  'framesIn', 'framesOut', 'maxOutFrameBytes', 'maxOutFrameKind', 'bufferedAmountPeak', 'bufferedAmountAtClose',
  'lastInboundAgeMs', 'rttMsP50', 'rttMsMax', 'loopDriftMax60sMs', 'loopDriftMax5sMs']

function pickClose(e) {
  const out = {}
  for (const k of CLOSE_FIELDS) if (e[k] !== undefined) out[k] = e[k]
  return out
}

function within(list, T, fromS, toS) {
  return list.filter((x) => {
    const d = (ms(x.t) - T) / 1000
    return d >= fromS && d <= toS
  })
}

/**
 * The kernel summary for this link's socket. Best match: the connect time
 * (row end minus its duration) equals the link's up time; the summary itself
 * can be logged well after the close (FIN_WAIT sockets linger).
 */
function matchTcp(rows, link, T) {
  const byStart = rows.filter((r) => r.durS != null && link.upMs != null
    && Math.abs(ms(r.t) - r.durS * 1000 - link.upMs) <= 5000)
  if (byStart.length) return byStart.sort((a, b) => Math.abs(ms(a.t) - T) - Math.abs(ms(b.t) - T))[0]
  // The fallback matches by end time, so it must not borrow the socket of the
  // NEXT link: a socket that opened after this drop never carried it. No slack
  // here: the redial can connect within a second (seen live: a row that opened
  // 3 s after one drop was counted as the evidence for it and for the next).
  const openedByDrop = (r) => r.durS == null || ms(r.t) - r.durS * 1000 <= T
  const near = within(rows, T, -5, 120).filter(openedByDrop)
  if (!near.length || link.upS == null) return near[0] ?? null
  return near.sort((a, b) => Math.abs((a.durS ?? 0) - link.upS) - Math.abs((b.durS ?? 0) - link.upS))[0]
}

/** join.py: what the replica logged around a Mac-side drop at T. */
export function replicaJoin(T, replicaEvents) {
  if (!replicaEvents.length) return { cls: null, near: [] }
  const near = within(replicaEvents, T, -120, 15).map((r) => ({ ...r, dS: (ms(r.t) - T) / 1000 }))
  const silentBefore = near.filter((n) => n.kind === 'silent' && n.dS <= 0.5)
  const closedNear = near.filter((n) => (n.kind === 'disconnected' && (n.reason ?? 'socket closed') === 'socket closed'
    || n.kind === 'closed') && n.dS >= -2 && n.dS <= 2)
  const replacedAfter = near.filter((n) => n.kind === 'replaced' && n.dS >= 0 && n.dS <= 15)
  let cls
  if (silentBefore.length && closedNear.length) cls = 'replica-silence-sweep-closed-it'
  else if (closedNear.length) cls = 'both-saw-close-within-2s'
  else if (replacedAfter.length) cls = 'replica-never-saw-close'
  else if (silentBefore.length) cls = 'replica-silence-then-?'
  else cls = 'no-replica-event-nearby'
  const initiator = closedNear.find((n) => n.initiator)?.initiator ?? null
  return { cls, initiator, near }
}

const SSH_DOWN = new Set(['ssh-ws-closed', 'ssh-lost', 'ssh-died'])

const gapSpan = (g) => [ms(g.t) - (g.wallMs ?? 0), ms(g.t)]

/**
 * A collector gap the kernel proves the Mac did not sleep through: the
 * collector read the kernel's sleep and wake times at its end and found no
 * sleep inside. The collector was starved, the Mac awake.
 */
export function provenAwake(g) {
  return typeof g.kernelWakeAt === 'string' && typeof g.kernelSleepAt === 'string' && !g.resume && (g.sleptMs ?? 0) <= 2000
}

/**
 * Was the Mac provably awake through [startMs, endMs]? Every instant must be
 * within MAX_SAMPLE_GAP_MS after a collector load sample, or inside a gap
 * the kernel proves awake; and no other collector gap (asleep, a failed
 * kernel read, an old record, the collector not running) may touch it.
 * Samples on both sides of the window are NOT enough: a starved or sleeping
 * collector leaves a hole in the middle (seen in review: a 282 s gap across
 * a whole silence counted as "awake").
 */
export function awakeThrough({ load = [], gaps = [] }, startMs, endMs) {
  if (gaps.some((g) => { const [a, b] = gapSpan(g); return a < endMs && b > startMs && !provenAwake(g) })) return false
  const iv = [
    ...load.map((x) => [ms(x.t), ms(x.t) + MAX_SAMPLE_GAP_MS]),
    ...gaps.filter(provenAwake).map(gapSpan),
  ].filter(([a, b]) => b >= startMs && a <= endMs).sort((x, y) => x[0] - y[0])
  let reach = startMs
  for (const [a, b] of iv) {
    if (a > reach) return false
    reach = Math.max(reach, b)
    if (reach >= endMs) return true
  }
  return false
}

/** Did the Mac sleep (or dark wake) at any point in [startMs, endMs]? */
export function sleptDuring({ gaps = [], pmset = [] }, startMs, endMs) {
  const byGap = gaps.some((g) => { const [a, b] = gapSpan(g); return (g.sleptMs ?? 0) > 2000 && a < endMs + 10_000 && b > startMs - 10_000 })
  const events = pmset.filter(isPowerEvent)
  const inside = events.some((e) => (e.state === 'asleep' || e.state === 'darkwake') && ms(e.t) >= startMs && ms(e.t) <= endMs)
  const atStart = powerStateAt(events, startMs).state
  return byGap || inside || atStart === 'asleep' || atStart === 'darkwake'
}

/** Mac-side context for one drop at T. All inputs are sorted by t. */
export function dropContext(T, link, ctx) {
  // Remote SSH links only: '__local__' is the Mac's own daemon socket.
  const ssh = within(ctx.server ?? [], T, -15, 15)
    .filter((s) => SSH_DOWN.has(s.ev) && s.host !== '__local__')
  const net = within(ctx.net ?? [], T, -60, 30).filter((n) => n.changed?.length)
  const netKeys = [...new Set(net.flatMap((n) => n.changed))]
  // A silence drop is judged over the whole silent window, not just T.
  const silentMs = link.silentMs ?? (link.cause === 'silence' ? link.close?.lastInboundAgeMs : null) ?? 0
  const lookbackMs = silentMs + 10_000
  const gap = (ctx.gaps ?? []).find((g) => {
    const end = ms(g.t)
    const start = end - (g.wallMs ?? 0)
    return (g.sleptMs ?? 0) > 2000 && T >= start - 10_000 && T - lookbackMs <= end + 10_000
  })
  const pmset = (ctx.pmset ?? []).filter(isPowerEvent)
  const power = powerStateAt(pmset, T)
  const pmsetSleepInWindow = within(pmset, T - lookbackMs, 0, lookbackMs / 1000 + 5)
    .some((e) => e.state === 'asleep' || e.state === 'darkwake')
  // Collector coverage through the whole silent window (awakeThrough).
  const covered = awakeThrough({ load: ctx.load ?? [], gaps: ctx.gaps ?? [] }, T - lookbackMs, T)
  const loads = within(ctx.load ?? [], T - lookbackMs, -60, lookbackMs / 1000 + 60).filter((x) => x.load1 != null)
  const tcp = matchTcp(ctx.tcp ?? [], link, T)
  const configured = within(ctx.daemonOther ?? [], T, -1.5, 0.2).some((e) => e.ev === 'configured')
  return {
    sshDied: ssh.length > 0,
    netKeys,
    slept: !!gap || power.state === 'asleep' || power.state === 'darkwake' || pmsetSleepInWindow,
    power: gap ? 'asleep' : pmsetSleepInWindow && power.state === 'awake' ? 'woke during the window' : power.state,
    covered,
    load1: loads.length ? Math.max(...loads.map((x) => x.load1)) : null,
    cpuIdlePct: loads.some((x) => x.cpuIdlePct != null) ? Math.min(...loads.filter((x) => x.cpuIdlePct != null).map((x) => x.cpuIdlePct)) : null,
    tcp: tcp ? { ending: tcpEnding(tcp), rxmit: tcp.rxmit, soError: tcp.soError, closefn: tcp.closefn } : null,
    configured,
    replica: replicaJoin(T, ctx.replica ?? []),
  }
}

/** Server close codes that mean the far end sent a proper close frame. */
const SERVER_CLOSE_CODES = new Set([1000, 1001, 1008, 1009, 1011, 1012, 1013, 4000, 4001])

const secs = (x) => `${Math.round(x / 1000)} s`

/** One drop's mechanism. basis: which evidence decided it, in words. */
export function classifyDrop(link, c) {
  if (link.cause === 'restart') return { mech: 'M4', basis: `restart: ${link.restartReason ?? '?'}` }
  const lastError = String(link.close?.lastError ?? '')
  // The daemon closes the socket itself (code 1000, clean) and says so; that
  // close frame is the Mac's, never evidence of the far end.
  const daemonClosed = /\(daemon closed\)/.test(lastError)
  if (link.cause === 'silence' || /inbound silence/.test(lastError)) {
    if (c.slept) return { mech: 'M3', basis: `silence watchdog, Mac ${c.power}` }
    if (!c.covered) return { mech: 'M?', basis: 'silence watchdog, Mac state unknown (no collector samples through the silence)' }
    const drift = link.close?.loopDriftMax60sMs
    const silentMs = link.silentMs ?? link.close?.lastInboundAgeMs
    if (drift != null && silentMs != null && silentMs - drift < BRIDGE_SILENCE_MS) {
      return { mech: 'M6', basis: `daemon event loop stalled ${secs(drift)} of ${secs(silentMs)} silent${c.load1 != null ? `, load ${Math.round(c.load1)}` : ''}` }
    }
    return { mech: 'M5', basis: drift == null ? 'silence watchdog while the Mac was awake, no drift data' : `silence watchdog while the Mac was awake, daemon loop drift ${secs(drift)}` }
  }
  const rc = c.replica?.cls
  if (rc === 'both-saw-close-within-2s' || rc === 'replica-silence-sweep-closed-it') return { mech: 'M1', basis: `replica: ${rc}` }
  if (rc === 'replica-never-saw-close') return { mech: 'M2', basis: 'replica: never saw the close' }
  if (c.replica?.initiator === 'server') return { mech: 'M1', basis: 'replica: server initiated' }
  if (c.slept) return { mech: 'M3', basis: `Mac ${c.power}` }
  if (c.sshDied) return { mech: 'M2', basis: 'SSH links died at the same time' }
  if (c.netKeys.length) return { mech: 'M2', basis: `network change: ${c.netKeys.join(',')}` }
  const ending = c.tcp?.ending
  if (ending === 'drop') return { mech: 'M2', basis: 'kernel gave up on the socket' }
  // The daemon reset it itself; retransmits say whether the path had stopped delivering first.
  if (ending === 'local-abort') return { mech: 'M?', basis: `kernel: the Mac side aborted the socket${c.tcp.rxmit ? ` after ${c.tcp.rxmit} retransmits` : ''}` }
  if (daemonClosed) return { mech: 'M?', basis: `the daemon closed it: ${lastError.replace(/\s*\(daemon closed\)/, '')}` }
  if (ending === 'peer-reset' || ending === 'peer-fin') return { mech: 'M1', basis: `kernel: ${ending}` }
  const code = link.close?.code
  if (code != null && SERVER_CLOSE_CODES.has(Number(code))) return { mech: 'M1', basis: `close code ${code}` }
  return { mech: 'M?', basis: 'no corroborating evidence' }
}

/** Storms: runs of drops where more than `maxDrops` fall in any `windowMs`. */
export function findStorms(drops, { windowMs = 600_000, maxDrops = 3 } = {}) {
  const ts = drops.map((d) => d.downMs).sort((a, b) => a - b)
  const member = new Array(ts.length).fill(false)
  let lo = 0
  for (let hi = 0; hi < ts.length; hi++) {
    while (ts[hi] - ts[lo] > windowMs) lo++
    if (hi - lo + 1 > maxDrops) for (let k = lo; k <= hi; k++) member[k] = true
  }
  const storms = []
  for (let i = 0; i < ts.length; i++) {
    if (!member[i]) continue
    const last = storms.at(-1)
    if (last && ts[i] - last.endMs <= windowMs) { last.endMs = ts[i]; last.count++ } else storms.push({ startMs: ts[i], endMs: ts[i], count: 1 })
  }
  for (const s of storms) {
    s.mechs = {}
    for (const d of drops) if (d.downMs >= s.startMs && d.downMs <= s.endMs) s.mechs[d.mech] = (s.mechs[d.mech] ?? 0) + 1
  }
  return storms
}

/** Outages longer than `thresholdS`, including one still in progress at `nowMs`. */
export function findOutages(links, { thresholdS = 60, nowMs = Date.now() } = {}) {
  const out = []
  links.forEach((l, i) => {
    if (l.downMs == null) return
    const ongoing = l.reconnectS == null && i === links.length - 1
    const durS = ongoing ? (nowMs - l.downMs) / 1000 : l.reconnectS
    if (durS != null && durS > thresholdS) out.push({ downMs: l.downMs, durS, ongoing, mech: l.mech })
  })
  return out
}

/**
 * Do these drops line up with one point of a fixed cycle? Two measures on
 * (epoch seconds mod period): the circular mean length R (near 1 = all at
 * one phase), and the densest `binS`-second window, which still finds a
 * partial alignment (a periodic job killing some links, not all). The
 * replica's 5-minute tick is anchored at its own start, so compare drops
 * from one replica uptime (in practice: one day), not a whole week.
 */
export function cyclePhase(drops, periodS = 300, binS = 20) {
  const phases = drops.map((d) => ((d.downMs / 1000) % periodS + periodS) % periodS).sort((a, b) => a - b)
  if (phases.length === 0) return { n: 0, phaseSec: null, R: 0, near: 0, share: 0, expectedShare: binS / periodS }
  let x = 0
  let y = 0
  for (const p of phases) { x += Math.cos((2 * Math.PI * p) / periodS); y += Math.sin((2 * Math.PI * p) / periodS) }
  const R = Math.hypot(x / phases.length, y / phases.length)
  let best = 0
  let bestStart = phases[0]
  for (const p0 of phases) {
    const count = phases.filter((p) => ((p - p0 + periodS) % periodS) < binS).length
    if (count > best) { best = count; bestStart = p0 }
  }
  const phaseSec = Math.round(((bestStart + binS / 2) % periodS) * 10) / 10
  return {
    n: phases.length, phaseSec, R: Math.round(R * 100) / 100, near: best,
    share: Math.round((best / phases.length) * 100) / 100, expectedShare: Math.round((binS / periodS) * 100) / 100,
  }
}

/** A cycle alignment worth reporting: 5+ drops, 3x what chance gives. */
export function isAligned(phase) {
  return !!phase && phase.near >= 5 && phase.share >= 3 * phase.expectedShare
}

export function quantile(values, q) {
  if (!values.length) return null
  const s = values.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

/** Sum of overlap between [a0,a1) and each interval in `intervals`. */
function overlapMs(a0, a1, intervals) {
  let sum = 0
  for (const [b0, b1] of intervals) sum += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
  return sum
}

/**
 * Per-day table rows. `dayBounds` = [{day, startMs, endMs}] in local time.
 */
export function dayRows(links, drops, storms, outages, { dayBounds, nowMs, firstObsMs, sleeps = [], sleepKnown = null }) {
  const up = links.map((l) => [l.upMs, l.downMs ?? nowMs])
  return dayBounds.map(({ day, startMs, endMs }) => {
    const obs0 = Math.max(startMs, firstObsMs ?? startMs)
    const obs1 = Math.min(endMs, nowMs)
    const observedMs = Math.max(0, obs1 - obs0)
    const inDay = (t) => t >= startMs && t < endMs
    const dd = drops.filter((d) => inDay(d.downMs))
    const byMech = Object.fromEntries(MECHS.map((m) => [m, dd.filter((d) => d.mech === m).length]))
    const od = outages.filter((o) => inDay(o.downMs))
    const sleepMs = observedMs > 0 ? overlapMs(obs0, obs1, sleeps) : 0
    const upMs = observedMs > 0 ? overlapMs(obs0, obs1, up) : 0
    const upWhileSleepMs = observedMs > 0 ? sleeps.reduce((acc, [s0, s1]) => acc
      + overlapMs(Math.max(obs0, s0), Math.min(obs1, s1), up), 0) : 0
    const awakeMs = observedMs - sleepMs
    // Sleep is known where a pmset read or the collector's kernel check
    // covered the time; elsewhere "awake" would just mean "not seen asleep".
    const knownMs = sleepKnown ? overlapMs(obs0, obs1, sleepKnown) : observedMs
    return {
      day,
      partial: nowMs < endMs,
      observedH: Math.round((observedMs / 3_600_000) * 10) / 10,
      drops: dd.length,
      byMech,
      storms: storms.filter((s) => inDay(s.startMs)).length,
      outages60: od.length,
      longestOutageS: od.length ? Math.round(Math.max(...od.map((o) => o.durS))) : null,
      upP50S: quantile(dd.map((d) => d.upS).filter((x) => x != null), 0.5),
      connectedPct: observedMs > 0 ? Math.round((upMs / observedMs) * 1000) / 10 : null,
      awakeConnectedPct: awakeMs > 60_000 ? Math.round(((upMs - upWhileSleepMs) / awakeMs) * 1000) / 10 : null,
      sleepH: Math.round((sleepMs / 3_600_000) * 10) / 10,
      sleepKnown: observedMs > 0 && knownMs >= 0.9 * observedMs,
    }
  })
}

const ACTIONABLE = ['M1', 'M2', 'M5', 'M6', 'M?']
const countOf = (list, pred) => list.filter(pred).length

/** One sentence per mechanism, saying only what its evidence shows. */
function mechText(mech, k, n, drops, phase) {
  const mine = drops.filter((d) => d.mech === mech)
  if (mech === 'M1') {
    const byReplica = countOf(mine, (d) => String(d.basis ?? '').startsWith('replica:'))
    const lead = byReplica === k
      ? `${k} of ${n} drops were closed by the cloud side: the replica log saw each close.`
      : `${k} of ${n} drops were reset or closed from the far side (the cloud, or a middlebox on the way), with no Mac network change around them${byReplica ? `; the replica log confirms ${byReplica}` : ''}.`
    const cycle = isAligned(phase)
      ? `${phase.near} of ${phase.n} land in one 20-second slot of a 5-minute cycle (around ${phase.phaseSec} s past each 5-minute mark; chance would put ${Math.round(phase.expectedShare * 100)}% there, not ${Math.round(phase.share * 100)}%): look first at what the replica or its proxy runs every 5 minutes.`
      : 'They do not line up with a 5-minute cycle; the replica close log and the proxy in front of it can say which end sent them.'
    return `${lead} ${cycle}`
  }
  if (mech === 'M2') {
    const parts = [
      [countOf(mine, (d) => String(d.basis).startsWith('network change')), 'came with a Mac network change'],
      [countOf(mine, (d) => d.basis === 'SSH links died at the same time'), "with the Mac's SSH links dying at the same moment"],
      [countOf(mine, (d) => d.basis === 'kernel gave up on the socket'), 'were sockets the Mac kernel gave up on (a timeout or a lost local address)'],
      [countOf(mine, (d) => d.basis === 'replica: never saw the close'), 'were never seen closing by the replica'],
    ].filter(([c]) => c > 0).map(([c, what]) => `${c} ${what}`)
    return `${k} of ${n} drops point at the network path: ${parts.join(', ')}.`
  }
  if (mech === 'M3') {
    const watchdog = countOf(mine, (d) => d.cause === 'silence' || String(d.basis).startsWith('silence watchdog'))
    return `${k} of ${n} drops happened while the Mac slept or was in DarkWake (${watchdog} ended by the daemon's silence watchdog, ${k - watchdog} by a plain close). This is expected with the lid closed.`
  }
  if (mech === 'M4') return `${k} of ${n} drops were daemon restarts (deploys or reconfigures).`
  if (mech === 'M5') {
    // "Not stalled" is a measurement: say it only for the drops that have one.
    const measured = countOf(mine, (d) => d.close?.loopDriftMax60sMs != null)
    const stall = measured === k ? ' and the daemon was not stalled'
      : measured > 0 ? ` (the daemon's stall was measured for ${measured} of them and was too short to explain the silence; ${k - measured} have no measurement)`
        : ' (the daemon recorded no stall measurement for them)'
    return `${k} of ${n} drops were the daemon's silence watchdog firing while the Mac was awake${stall}: nothing arrived from the cloud for 75 s or more. The Mac side cannot say where the traffic stopped (the replica, its proxy, or the path between); the replica close log for these times can.`
  }
  if (mech === 'M6') {
    const drift = Math.max(0, ...mine.map((d) => d.close?.loopDriftMax60sMs ?? 0))
    const loads = mine.map((d) => d.ctx?.load1).filter((x) => x != null)
    return `${k} of ${n} drops were the Walnut daemon on this Mac freezing: its event loop stalled for up to ${Math.round(drift / 1000)} s${loads.length ? ` at a machine load of up to ${Math.round(Math.max(...loads))}` : ''}, long enough for its own 75 s silence watchdog to close the link. The stall alone explains these, so the fix is on the Mac: less load, or a daemon that stays responsive under it.`
  }
  const unknown = countOf(mine, (d) => String(d.basis).includes('Mac state unknown'))
  return `${k} of ${n} drops have no cause yet${unknown ? ` (${unknown} were silences with no record of whether the Mac was awake)` : ''}. The replica close log (initiator, code) will settle the closes.`
}

/**
 * Which mechanism to lead with: actionable ones win once there are a few.
 * `row` (the report day's dayRows entry) words the no-drop cases: a day the
 * bridge never connected is not a clean day.
 */
export function topHypothesis(drops, phase, row = null) {
  const n = drops.length
  if (n === 0) {
    if (row && row.observedH === 0) return { mech: null, state: 'no-records', text: 'The monitor has no records for this day.' }
    if (row && row.connectedPct === 0) {
      return { mech: null, state: 'never-connected', text: 'The bridge never connected on this day, so there were no drops to classify. Check that the Walnut daemon on this Mac is running with the cloud bridge configured.' }
    }
    const awake = row?.sleepKnown && row?.awakeConnectedPct != null
    const up = row ? (awake ? row.awakeConnectedPct : row.connectedPct) : null
    if (up != null && up < 99.5) {
      return { mech: null, state: 'down', text: `No drops on this day, but the bridge was connected only ${up}% of the ${awake ? 'awake ' : ''}time: it stayed down rather than flapping.` }
    }
    return { mech: null, state: 'clean', text: `No drops on this day. The bridge stayed connected${awake ? ' whenever the Mac was awake' : ''}.` }
  }
  const count = Object.fromEntries(MECHS.map((m) => [m, drops.filter((d) => d.mech === m).length]))
  const actionable = ACTIONABLE.slice().sort((a, b) => count[b] - count[a])
  const actionableTotal = ACTIONABLE.reduce((acc, m) => acc + count[m], 0)
  const overall = MECHS.slice().sort((a, b) => count[b] - count[a])
  // Sleep drops (M3) and restarts (M4) are expected; three or more drops of
  // an actionable kind are what the user needs to hear about first.
  const mech = actionableTotal >= 3 ? actionable[0] : overall[0]
  const parts = [mechText(mech, count[mech], n, drops, phase)]
  const second = overall.find((m) => m !== mech && count[m] > 0)
  if (second) parts.push(`Next most common: ${second} ${MECH_LABELS[second]} (${count[second]}).`)
  return { mech, text: parts.join(' '), count }
}

/**
 * Gaps the collector recorded before it read the kernel's sleep times say
 * sleptMs 0 on a Mac whose monotonic clock runs through sleep. A pmset sleep
 * or dark wake inside such a gap settles it: the whole gap was asleep.
 */
export function settleOldGaps(gaps, pmset) {
  return gaps.map((g) => {
    if ((g.sleptMs ?? 0) > 2000 || !g.wallMs || g.kernelWakeAt !== undefined) return g
    const end = ms(g.t)
    const start = end - g.wallMs
    const slept = pmset.some((e) => (e.state === 'asleep' || e.state === 'darkwake') && ms(e.t) >= start - 5000 && ms(e.t) <= end)
    return slept ? { ...g, sleptMs: g.wallMs, sleptBy: 'pmset' } : g
  })
}

/**
 * Everything the letter needs from raw store records.
 * @param {object[]} records  store records (collector + probe), any order
 * @param {object} opts  { dayBounds, nowMs, replica: [], alert: {maxDropsPer10Min, outageSec} }
 */
export function analyze(records, { dayBounds, reportDay, nowMs = Date.now(), replica = [], maxDropsPer10Min = 3, outageSec = 60 } = {}) {
  const sorted = records.slice().sort(byTime)
  const daemon = sorted.filter((r) => r.kind === 'daemon')
  // "Wake Requests" rows stored by older versions are not wakes (parse-net.mjs).
  const pmset = sorted.filter((r) => r.kind === 'pmset' && isPowerEvent(r))
  // A collector restart is a hole too: `resume` says how long it was down.
  const holes = sorted.filter((r) => r.kind === 'gap' || (r.kind === 'resume' && r.downMs > 0))
    .map((r) => (r.kind === 'resume' ? { t: r.t, kind: 'gap', wallMs: r.downMs, sleptMs: null, resume: true } : r))
  const ctx = {
    server: sorted.filter((r) => r.kind === 'server'),
    net: sorted.filter((r) => r.kind === 'net'),
    gaps: settleOldGaps(holes, pmset),
    pmset,
    tcp: sorted.filter((r) => r.kind === 'tcp' && !r.probe),
    load: sorted.filter((r) => r.kind === 'load'),
    daemonOther: daemon.filter((r) => r.ev === 'configured'),
    replica: replica.slice().sort(byTime),
  }
  const links = buildLinks(daemon)
  const drops = []
  for (const l of links) {
    if (l.downMs == null) continue
    const c = dropContext(l.downMs, l, ctx)
    Object.assign(l, classifyDrop(l, c), { ctx: c })
    drops.push(l)
  }
  const storms = findStorms(drops, { maxDrops: maxDropsPer10Min })
  const outages = findOutages(links, { thresholdS: outageSec, nowMs })
  // The hypothesis and the cycle phase cover the report day only; the
  // records before it are read just to know whether the link was up at its start.
  const windowStart = dayBounds?.[0]?.startMs ?? -Infinity
  const windowDrops = drops.filter((d) => d.downMs >= windowStart)
  const phaseDay = dayBounds?.find((b) => b.day === reportDay) ?? dayBounds?.at(-1)
  const dayDrops = windowDrops.filter((d) => !phaseDay || (d.downMs >= phaseDay.startMs && d.downMs < phaseDay.endMs))
  const phaseDrops = dayDrops.filter((d) => d.mech === 'M1')
  const phase = cyclePhase(phaseDrops)
  const sleeps = ctx.gaps.filter((g) => (g.sleptMs ?? 0) > 2000).map((g) => [ms(g.t) - g.sleptMs, ms(g.t)])
  const firstObsMs = sorted.length ? ms(sorted[0].t) : nowMs
  const sleepKnown = sleepKnownIntervals(sorted, nowMs)
  const days = dayBounds ? dayRows(links, drops, storms, outages, { dayBounds, nowMs, firstObsMs, sleeps, sleepKnown }) : []
  const probeLinks = buildLinks(sorted.filter((r) => r.kind === 'probe').map((r) => ({ ...r })))
  // The hypothesis is about the report day, like the subject line: over the
  // whole window, days from before the kernel sweeps ran (all "M?") drowned
  // out the day's real signal (the first letters led with "120 of 226 drops
  // unexplained" on a day with 13 cloud closes and 4 unexplained).
  const reportRow = days.find((d) => d.day === phaseDay?.day) ?? null
  return { links, drops, storms, outages, phase, days, ctx, probeLinks, hypothesis: topHypothesis(dayDrops, phase, reportRow) }
}

/**
 * When the Mac's sleep is known: the span each successful daily pmset read
 * covered (its lookback, 26 h unless recorded), and the time since the first
 * collector that checks the kernel's sleep times at every gap.
 */
export function sleepKnownIntervals(sorted, nowMs) {
  const out = sorted.filter((r) => r.kind === 'daily' && !r.pmsetError)
    .map((r) => [ms(r.t) - (r.pmsetLookbackHours ?? 26) * 3_600_000, ms(r.t)])
  const kernel = sorted.find((r) => r.kind === 'start' && r.sleepCheck === 'kernel')
  if (kernel) out.push([ms(kernel.t), nowMs])
  // Merged, so an overlap is never counted twice.
  const merged = []
  for (const iv of out.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1)
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else merged.push([...iv])
  }
  return merged
}
