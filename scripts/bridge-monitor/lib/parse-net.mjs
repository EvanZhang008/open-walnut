/**
 * Pure parsers for the macOS tools the collector samples. Each takes raw
 * stdout and returns a small object; none of them runs anything.
 *
 * Wi-Fi network names and BSSIDs are dropped HERE, at parse time, so no
 * record or state file can ever hold one. (Since macOS 14.4 a process without
 * Location Services permission reads them as "<redacted>" anyway, and the
 * collector never asks for it.) The radio fields (channel, band, signal)
 * carry the roaming signal instead.
 */

/** `printf 'show State:/Network/Global/IPv4\nlist State:/Network/Interface/[^/]+/IPv4\n' | scutil` */
export function parseScutilState(out) {
  const primary = /PrimaryInterface : (\S+)/.exec(out)?.[1] ?? null
  const router = /Router : (\S+)/.exec(out)?.[1] ?? null
  const ipv4Ifaces = [...out.matchAll(/State:\/Network\/Interface\/([^/\s]+)\/IPv4/g)]
    .map((m) => m[1]).filter((n) => n !== 'lo0')
  return { primary, router, ipv4Ifaces: [...new Set(ipv4Ifaces)].sort() }
}

/** `scutil --nwi` */
export function parseNwi(out) {
  const ifaces = (/Network interfaces: ?(.*)/.exec(out)?.[1] ?? '').trim().split(/\s+/).filter(Boolean)
  const sections = out.split(/IPv6 network interface information/)
  const reach = (s) => /REACH : flags 0x[0-9a-f]+ \(([^)]*)\)/.exec(s ?? '')?.[1] ?? null
  const v4Ifaces = [...(sections[0] ?? '').matchAll(/^\s+(\S+) : flags\s+: 0x[0-9a-f]+ \(([^)]*)\)/gm)]
    .map((m) => ({ name: m[1], flags: m[2] }))
  return { ifaces, v4: v4Ifaces, reachV4: reach(sections[0]), reachV6: reach(sections[1]) }
}

/** `route -n get <dest>` */
export function parseRouteGet(out) {
  return {
    iface: /interface: (\S+)/.exec(out)?.[1] ?? null,
    gateway: /gateway: (\S+)/.exec(out)?.[1] ?? null,
  }
}

/** `ipconfig getsummary <iface>`: link state only; SSID and BSSID are never returned. */
export function parseIpconfigSummary(out) {
  const field = (name) => new RegExp(`^\\s*${name} : (.*)$`, 'm').exec(out)?.[1]?.trim() ?? null
  const type = field('InterfaceType')
  const link = field('LinkStatusActive')
  return {
    type,
    link: link == null ? null : link === 'TRUE',
    security: field('Security'),
  }
}

/** `pmset -g ps` */
export function parsePmsetPs(out) {
  const source = /Now drawing from '([^']+)'/.exec(out)?.[1] ?? null
  const batt = /(\d+)%;\s*([^;]+);/.exec(out)
  return {
    source: source === 'AC Power' ? 'ac' : source === 'Battery Power' ? 'battery' : source,
    batteryPct: batt ? Number(batt[1]) : null,
    batteryState: batt ? batt[2].trim() : null,
  }
}

/**
 * `system_profiler SPAirPortDataType`: the first "Current Network
 * Information" block that names a network (the Wi-Fi interface; awdl0's
 * block has no network line).
 */
export function parseSystemProfilerWifi(out) {
  const lines = out.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/Current Network Information:\s*$/.test(lines[i])) continue
    const baseIndent = lines[i].search(/\S/)
    const nameLine = lines[i + 1] ?? ''
    if (!/:\s*$/.test(nameLine) || nameLine.search(/\S/) <= baseIndent) continue
    const nameIndent = nameLine.search(/\S/)
    const kv = {}
    for (let j = i + 2; j < lines.length; j++) {
      const indent = lines[j].search(/\S/)
      if (indent <= nameIndent) break
      const m = /^\s*([^:]+): (.*)$/.exec(lines[j])
      if (m) kv[m[1].trim()] = m[2].trim()
    }
    const ch = /^(\d+)(?: \(([^,)]+)(?:, ([^)]+))?\))?/.exec(kv.Channel ?? '')
    const sn = /(-?\d+) dBm \/ (-?\d+) dBm/.exec(kv['Signal / Noise'] ?? '')
    // The block's name line is the network name: used to find the block, never returned.
    return {
      phy: kv['PHY Mode'] ?? null,
      channel: ch ? Number(ch[1]) : null,
      band: ch?.[2] ?? null,
      width: ch?.[3] ?? null,
      signalDbm: sn ? Number(sn[1]) : null,
      noiseDbm: sn ? Number(sn[2]) : null,
      txRate: kv['Transmit Rate'] ? Number(kv['Transmit Rate']) : null,
      mcs: kv['MCS Index'] ? Number(kv['MCS Index']) : null,
    }
  }
  return null
}

/** `sntp <server>` -> "+0.099108 +/- 0.037586 server addr" */
export function parseSntp(out) {
  const m = /^([+-]?\d+\.\d+) \+\/- (\d+\.\d+) (\S+)/m.exec(out)
  if (!m) return null
  return { offsetMs: Math.round(Number(m[1]) * 1e6) / 1e3, errMs: Math.round(Number(m[2]) * 1e6) / 1e3, server: m[3] }
}

/*
 * The type column is padded to a tab, so the type must be followed by a tab or
 * by two or more spaces: "Wake Requests" (logged a second after every sleep,
 * listing the wakes the Mac has scheduled) is NOT a wake. Read as one, it put
 * the Mac "awake" 1 to 4 s into every sleep.
 */
const PMSET_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) (Sleep|Wake|DarkWake|Notification)(?=\t| {2,})\s+(.*)$/

/** Local "YYYY-MM-DD HH:MM:SS" + "+HH","MM" offset -> ISO UTC. */
function isoFromLocal(stamp, offH, offM) {
  const sign = offH.startsWith('-') ? -1 : 1
  const mins = sign * (Math.abs(Number(offH)) * 60 + Number(offM))
  const utc = Date.parse(`${stamp.replace(' ', 'T')}Z`) - mins * 60_000
  return new Date(utc).toISOString()
}

/**
 * `pmset -g log` -> sleep / wake / dark-wake / display events.
 * state: the power state the event puts the Mac in (null for display lines).
 */
export function parsePmsetLog(out, { sinceMs = 0 } = {}) {
  const events = []
  for (const line of out.split('\n')) {
    const m = PMSET_RE.exec(line)
    if (!m) continue
    const type = m[4]
    const text = m[5].trim().replace(/\s{2,}/g, ' ')
    let state = null
    if (type === 'Sleep') state = /Entering DarkWake/.test(text) ? 'darkwake' : 'asleep'
    else if (type === 'DarkWake') state = 'darkwake'
    else if (type === 'Wake') state = 'awake'
    else if (/Display is turned on/.test(text)) state = 'display-on'
    else if (/Display is turned off/.test(text)) state = 'display-off'
    else continue
    const t = isoFromLocal(m[1], m[2], m[3])
    if (Date.parse(t) < sinceMs) continue
    events.push({ t, type, state, text: text.slice(0, 120) })
  }
  return events
}

/**
 * False for the "Wake Requests" rows that versions before the fix above
 * stored as wakes (their text starts with "Requests"); true for the rest.
 */
export function isPowerEvent(e) {
  return !(e?.type === 'Wake' && /^Requests\b/.test(e.text ?? ''))
}

/**
 * Power state at instant `ms` from sorted pmset events (port of the
 * investigation's correlate_sleep.state_at).
 */
export function powerStateAt(events, ms) {
  let state = 'unknown'
  let display = 'unknown'
  for (const e of events) {
    if (!isPowerEvent(e)) continue
    if (Date.parse(e.t) > ms) break
    if (e.state === 'display-on') display = 'on'
    else if (e.state === 'display-off') display = 'off'
    else if (e.state) state = e.state
  }
  return { state, display }
}

/** `sysctl -n kern.sleeptime kern.waketime`: two `{ sec = N, usec = M } ...` lines, as epoch ms. */
export function parseSleepWake(out) {
  const vals = [...String(out ?? '').matchAll(/sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)/g)]
    .map((m) => Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1000))
  return { sleepMs: vals[0] || null, wakeMs: vals[1] || null }
}

/**
 * How long the Mac slept inside a gap between two collector ticks.
 *
 * Wall time minus monotonic time is the textbook answer, but Node's monotonic
 * clock on macOS keeps counting through sleep: over a measured 635 s sleep
 * both clocks moved 645 s, so every sleep read as 0 and the alerts called a
 * sleeping Mac "down while awake". The kernel keeps its own last sleep and
 * wake times; a sleep that began after the last tick and a wake before this
 * one mean the collector was asleep, not starved, for the whole gap (a dark
 * wake in between does not run it either). Either measure wins; the clock one
 * still works where the monotonic clock stops during sleep.
 */
export function sleptInGap({ startMs, endMs, monoMs = null, sleepMs = null, wakeMs = null, tickMs = 10_000, slackMs = 5000 }) {
  const wallMs = endMs - startMs
  const byClock = monoMs == null ? 0 : Math.max(0, wallMs - monoMs)
  const kernelSlept = sleepMs != null && wakeMs != null && wakeMs >= sleepMs
    && sleepMs >= startMs - slackMs && wakeMs <= endMs + slackMs
  const byKernel = kernelSlept ? Math.max(0, wallMs - tickMs) : 0
  return Math.max(byClock, byKernel)
}
