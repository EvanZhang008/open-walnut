/**
 * Letters to the user's Walnut inbox: the daily summary and the anomaly
 * alert. Delivered through the real op path, POST /api/v1/human-inbox
 * {subject, type, markdown, text} (see src/web/routes/human-inbox-v1.ts).
 *
 * Privacy: a letter never names a host, an IP, a network, a URL or the
 * user's home directory. Public IP changes are counted, not printed.
 */

import os from 'node:os'
import { MECH_LABELS, MECHS } from './classify.mjs'

const MAX_MARKDOWN = 60_000

function fmtDur(s) {
  if (s == null) return '-'
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

function fmtPct(p) {
  return p == null ? '-' : `${p}%`
}

function localTime(msOrIso, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(msOrIso))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * `09-26 Sat` for a YYYY-MM-DD day, kept on one line in any reader: the
 * hyphen and the space are the non-breaking kinds (U+2011, U+00A0). Markdown
 * has no nowrap, and a wrapped date was the widest thing in the table.
 */
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number)
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${String(m).padStart(2, '0')}\u2011${String(d).padStart(2, '0')}\u00a0${wd}`
}

/**
 * The days worth a row. A day before the first record has nothing observed:
 * "0 drops" there would read as a clean day, so it is left out (the first
 * week has fewer rows).
 */
function shownDays(days) {
  return days.filter((d) => d.drops > 0 || d.observedH == null || d.observedH > 0)
}

/** Is the Up figure the share of AWAKE time? Not on a day without sleep records. */
function upIsAwake(d) {
  return d.sleepKnown !== false && d.awakeConnectedPct != null
}

/** Share of awake time connected, or of all observed time when sleep is unknown. */
function upPct(d) {
  return upIsAwake(d) ? d.awakeConnectedPct : d.connectedPct
}

/*
 * Two narrow tables instead of one wide one, so a phone shows both without
 * wrapping or sideways scrolling. Budget: the web reader leaves about 300 px
 * for a table at a 390 px wide window (13 px text, 24 px of cell padding),
 * and the iOS reader about 330 pt (a no-wrap grid, 16 pt between columns).
 * That holds four short columns per day, so the per-day table keeps only
 * drops, long outages and uptime (storms are listed under "Storms"), and the
 * causes run down the rows instead of across.
 */

/** Short mechanism names for the causes table (the full ones: MECH_LABELS in classify.mjs). */
// At most 12 characters: with a "09-28 Mon" header, "M4 daemon restart"
// wrapped in WebKit at 390 px.
const MECH_SHORT = {
  M1: 'far end',
  M2: 'network path',
  M3: 'Mac asleep',
  M4: 'restart',
  M5: 'silent awake',
  M6: 'daemon froze',
  'M?': 'no cause yet',
}

/** One row per day: how often it dropped, how long it stayed down, uptime. */
export function dayTable(days) {
  // "Out" alone (the legend gives the threshold): with "Out >60s" WebKit at
  // phone width either broke the header in two or ran 3 px past the reader.
  // The % sign lives in the header: "96.6%*" ran the table 1 px over at 390.
  const head = '| Day | Drops | Out | Up\u00a0% |'
  const sep = '|---|---:|---:|---:|'
  const shown = shownDays(days)
  if (!shown.length) return `${head}\n${sep}\n| no records yet |  |  |  |`
  const rows = shown.map((d) => {
    const out = d.longestOutageS != null ? `${d.outages60}\u00a0(${fmtDur(d.longestOutageS)})` : String(d.outages60)
    const up = upPct(d)
    return `| ${dayLabel(d.day)} | ${d.drops} | ${out} | ${up == null ? '-' : up}${upIsAwake(d) || up == null ? '' : '*'} |`
  })
  return [head, sep, ...rows].join('\n')
}

/** One row per mechanism: the report day's drops, and the whole table window's. */
export function causeTable(days, reportDay) {
  const shown = shownDays(days)
  const report = shown.find((d) => d.day === reportDay) ?? shown.at(-1)
  if (!report) return '| Cause | Drops |\n|---|---:|\n| no records yet |  |'
  const windowCol = shown.length > 1
  const total = (m) => shown.reduce((acc, d) => acc + (d.byMech[m] ?? 0), 0)
  const head = `| Cause | ${dayLabel(report.day)} |${windowCol ? ` ${shown.length}\u00a0days |` : ''}`
  const sep = `|---|---:|${windowCol ? '---:|' : ''}`
  const rows = MECHS.map((m) => `| ${m} ${MECH_SHORT[m]} | ${report.byMech[m] ?? 0} |${windowCol ? ` ${total(m)} |` : ''}`)
  return [head, sep, ...rows].join('\n')
}

/**
 * Short evidence bullets for the report window [windowStartMs, windowEndMs).
 * Both ends bound everything, drops included: a letter written the next
 * morning must not count the next morning's drops as the report day's (seen
 * in review: 5 drops after midnight showed up under a 0-drop day).
 */
export function evidenceBullets(a, { windowStartMs, windowEndMs, nowMs, netRecords = [], pubip = [], sntp = [], health = null }) {
  const endMs = Math.min(windowEndMs ?? Infinity, nowMs != null ? nowMs + 1 : Infinity)
  const inMs = (x) => x >= windowStartMs && x < endMs
  const inWin = (t) => inMs(Date.parse(t))
  const drops = a.drops.filter((d) => inMs(d.downMs))
  const out = []
  const net = netRecords.filter((n) => inWin(n.t) && n.changed?.length)
  const primaryChanges = net.filter((n) => n.changed.includes('primary')).length
  const ipChanges = pubip.filter((p) => inWin(p.t) && p.changed).length
  // Two sentences: a public IP change is not one of the Mac's own network changes.
  out.push(`Mac network changes: ${net.length} (default route moved ${primaryChanges} times). Public IP changed ${ipChanges} times.`)
  const sleeps = a.ctx.gaps.filter((g) => inWin(g.t) && (g.sleptMs ?? 0) > 2000)
  if (sleeps.length) {
    const h = sleeps.reduce((s, g) => s + g.sleptMs, 0) / 3_600_000
    out.push(`Mac slept ${sleeps.length} times (${h.toFixed(1)} h in total).`)
  }
  // Plain closes only: after the daemon's own close (watchdog, restart) the
  // cloud sends the first FIN by protocol, so "peer-fin" there says nothing
  // about who ended the link, and the tally would not match the causes.
  const endings = {}
  const plain = drops.filter((d) => d.cause === 'closed' && d.ctx?.tcp?.ending)
  for (const d of plain) endings[d.ctx.tcp.ending] = (endings[d.ctx.tcp.ending] ?? 0) + 1
  if (plain.length) {
    const asleep = plain.filter((d) => d.mech === 'M3').length
    out.push(`Kernel view of ${plain.length} plain closes (not the watchdog, not a restart)${asleep ? `, ${asleep} of them while the Mac slept` : ''}: ${Object.entries(endings).map(([k, v]) => `${k} ${v}`).join(', ')}.`)
  }
  const m6 = drops.filter((d) => d.mech === 'M6')
  if (m6.length) {
    const drift = Math.max(0, ...m6.map((d) => d.close?.loopDriftMax60sMs ?? 0))
    const loads = m6.map((d) => d.ctx?.load1).filter((x) => x != null)
    const idle = m6.map((d) => d.ctx?.cpuIdlePct).filter((x) => x != null)
    const at = [loads.length ? `machine load up to ${Math.round(Math.max(...loads))}` : null, idle.length ? `CPU idle down to ${Math.min(...idle)}%` : null].filter(Boolean)
    // Out of the watchdog closes on an awake, watched Mac (M5 + M6): the share that was a stall.
    const awakeSilence = m6.length + drops.filter((d) => d.mech === 'M5').length
    out.push(`The Walnut daemon on this Mac froze ${m6.length} times, ${m6.length} of the ${awakeSilence} silence watchdog closes while the Mac was awake (event loop stalled up to ${Math.round(drift / 1000)} s${at.length ? `, ${at.join(', ')}` : ''}); each stall alone was long enough for its own silence watchdog to close the link.`)
  }
  const m1 = drops.filter((d) => d.mech === 'M1')
  const cfg = m1.filter((d) => d.ctx?.configured).length
  if (m1.length) out.push(`A bridge.configure push landed within 1.5 s before ${cfg} of ${m1.length} far-side closes.`)
  const withClose = drops.filter((d) => d.close)
  if (withClose.length) {
    const maxFrame = Math.max(...withClose.map((d) => d.close.maxOutFrameBytes ?? 0))
    const maxBuf = Math.max(...withClose.map((d) => d.close.bufferedAmountPeak ?? 0))
    // A sleeping Mac stalls every timer, so drift measured across a sleep is
    // the length of the sleep, not event-loop lag (the first live letter said
    // "1039700 ms"). Only drops the collector PROVES awake count: a silence of
    // unknown state printed "2891705 ms" for what the pmset read later showed
    // was a 48-minute sleep.
    const awake = withClose.filter((d) => d.mech !== 'M3' && !d.ctx?.slept && d.ctx?.covered)
    const drift = awake.length ? `, worst event-loop drift while awake ${Math.max(...awake.map((d) => d.close.loopDriftMax60sMs ?? 0))} ms` : ''
    out.push(`Daemon close records: ${withClose.length}; largest outbound frame ${Math.round(maxFrame / 1024)} KB, peak send buffer ${Math.round(maxBuf / 1024)} KB${drift}.`)
  }
  const probeDrops = a.probeLinks.filter((l) => l.downMs != null && inMs(l.downMs))
  if (probeDrops.length || a.probeLinks.length) {
    const together = probeDrops.filter((p) => drops.some((d) => Math.abs(d.downMs - p.downMs) <= 5000)).length
    out.push(`Control probe: ${probeDrops.length} drops, ${together} within 5 s of a daemon drop.`)
  }
  // The clock reading taken in the window itself, not a later one.
  const clock = (Array.isArray(sntp) ? sntp : [sntp]).filter((r) => r?.offsetMs != null && inWin(r.t)).at(-1)
  if (clock) out.push(`Mac clock offset: ${clock.offsetMs} ms (+/- ${clock.errMs} ms).`)
  if (health) out.push(`Monitor overhead: ${health}.`)
  return out
}

/** The daily letter. */
export function buildDailyLetter(a, { days, bullets, storeDir, tz, reportDay, outageSec = 60 }) {
  const last = days.at(-1)
  const report = days.find((d) => d.day === reportDay) ?? last
  const upText = (d) => `up ${fmtPct(upPct(d))}${upIsAwake(d) ? ' while awake' : ''}`
  const state = a.hypothesis.state
  const subject = !report ? 'Bridge monitor: no data yet'
    : state === 'no-records' ? `Bridge monitor ${report.day}: no records`
      : state === 'never-connected' ? `Bridge monitor ${report.day}: bridge never connected`
        : `Bridge monitor ${report.day}: ${report.drops} drop${report.drops === 1 ? '' : 's'}, ${upText(report)}`
  const shown = shownDays(days)
  const today = shown.at(-1)
  const starred = shown.some((d) => !upIsAwake(d) && upPct(d) != null)
  const lines = [
    '## Top hypothesis',
    a.hypothesis.text,
    '',
    '## Per day',
    dayTable(days),
    '',
    `"Out": outages longer than ${fmtDur(outageSec)}, the longest in brackets. "Up %": share of awake time the bridge was connected${starred ? '; * marks a day without sleep records, where it is the share of all the time observed' : ''}.${today?.partial ? ' The last row is today so far.' : ''}`,
    '',
    '## Causes',
    causeTable(days, report?.day),
    '',
    '## Evidence',
    ...bullets.map((b) => `- ${b}`),
  ]
  const storms = a.storms.filter((s) => report && localDayOf(s.startMs, tz) === report.day)
  const stormDays = shownDays(days).filter((d) => d.storms > 0)
  if (storms.length || stormDays.length) {
    lines.push('', '## Storms')
    for (const s of storms.slice(0, 5)) {
      const mix = MECHS.filter((m) => s.mechs[m]).map((m) => `${m} ${s.mechs[m]}`).join(', ')
      lines.push(`- ${localTime(s.startMs, tz)} to ${localTime(s.endMs, tz)}: ${s.count} drops (${mix})`)
    }
    if (stormDays.length) lines.push(`${storms.length ? '\n' : ''}Storms per day: ${stormDays.map((d) => `${dayLabel(d.day)} ${d.storms}`).join(', ')}.`)
  }
  // Plain text and no home directory: a code span never wraps, and the full
  // path both named the user and ran 43 px past a phone-width reader.
  lines.push('', `Raw records are kept on this Mac in ${tildePath(storeDir)}.`)
  let markdown = lines.join('\n')
  if (markdown.length > MAX_MARKDOWN) markdown = `${markdown.slice(0, MAX_MARKDOWN)}\n\n(truncated)`
  const lead = report && !state ? `${report.drops} drop${report.drops === 1 ? '' : 's'}, ${upText(report)}. ` : ''
  const text = `${lead}${a.hypothesis.text}`.slice(0, 280)
  return homeSafeLetter({ subject, type: 'info', markdown, text })
}

function tildePath(p) {
  const home = os.homedir()
  return p && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
}

/**
 * Every letter's last pass: the home directory (it carries the user name)
 * becomes `~` wherever it appears, in an error text or a basis as much as in
 * the raw records line. Applied by the builders and again at posting.
 */
export function homeSafe(s, home = os.homedir()) {
  if (typeof s !== 'string' || !home || home === '/') return s
  return s.replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.\\w)`, 'g'), '~')
}

function homeSafeLetter(letter) {
  return { ...letter, subject: homeSafe(letter.subject), markdown: homeSafe(letter.markdown), text: homeSafe(letter.text) }
}

function localDayOf(msVal, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(msVal))
}

/**
 * The anomaly alert. Its title, its first line and its table cover the SAME
 * drops: the ones the alert counted (`drops`; a live storm letter once said
 * "4 drops in 10 minutes" over a table of 5 from half an hour). The table
 * keeps one short token per cell so a phone shows it without wrapping; the
 * why follows it, one line per cause with a count. Right after a drop the
 * kernel log and the sleep records are often not in yet: when no drop has a
 * cause, the letter says once that the morning report works them out.
 */
const ALERT_MAX_ROWS = 12
const knownBasis = (b) => b && b !== 'no corroborating evidence' ? b : null

export function buildAlertLetter(alert, { drops = [], tz, context = [] }) {
  const all = [...drops].filter((d) => d?.downMs != null).sort((x, y) => x.downMs - y.downMs)
  const n = all.length
  const hms = (msVal) => localTime(msVal, tz)
  const hm = (msVal) => hms(msVal).slice(0, 5)
  const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`
  let subject
  let lead
  if (alert.reason === 'storm') {
    subject = n ? `Bridge alert: ${plural(n, 'drop')} between ${hm(all[0].downMs)} and ${hm(all.at(-1).downMs)}` : `Bridge alert: ${plural(alert.count, 'drop')} in 10 minutes`
    lead = n ? `The Mac to cloud bridge dropped ${n} times between ${hms(all[0].downMs)} and ${hms(all.at(-1).downMs)}.` : `The Mac to cloud bridge dropped ${alert.count} times in 10 minutes.`
  } else {
    const since = alert.downMs ?? all[0]?.downMs
    const dur = `${fmtDur(alert.durS)}${alert.ongoing ? ' and counting' : ''}`
    subject = since != null ? `Bridge alert: down since ${hm(since)} (${dur})` : `Bridge alert: down for ${dur}`
    const silent = all.length === 1 && all[0].cause === 'silence' && all[0].silentMs
      ? `; nothing had arrived for ${Math.round(all[0].silentMs / 1000)} s when the daemon closed it` : ''
    lead = `The Mac to cloud bridge has been down${since != null ? ` since ${hms(since)}` : ''} (${dur}) while the Mac was awake${silent}.`
  }
  const known = all.filter((d) => (d.mech && d.mech !== 'M?') || knownBasis(d.basis))
  const shown = all.slice(-ALERT_MAX_ROWS)
  const withLikely = known.length > 0
  const lines = [lead, '']
  if (shown.length) {
    lines.push(withLikely ? '| Time | Up for | Cause | Likely |' : '| Time | Up for | Cause |', withLikely ? '|---|---:|---|---|' : '|---|---:|---|')
    for (const d of shown) lines.push(`| ${hms(d.downMs)} | ${fmtDur(d.upS)} | ${d.cause} |${withLikely ? ` ${d.mech ?? 'M?'} |` : ''}`)
    if (shown.length < n) lines.push('', `The latest ${shown.length} of the ${n} are listed.`)
  }
  // One line per cause, with a count and its evidence.
  const why = []
  for (const m of MECHS) {
    const mine = all.filter((d) => (d.mech ?? 'M?') === m)
    if (!mine.length) continue
    const bases = new Map()
    for (const d of mine) { const b = knownBasis(d.basis); if (b) bases.set(b, (bases.get(b) ?? 0) + 1) }
    if (m === 'M?' && !bases.size) {
      if (withLikely) why.push(`- M? ${MECH_LABELS['M?']}: ${plural(mine.length, 'drop')}; the morning report works ${mine.length === 1 ? 'it' : 'them'} out.`)
      continue
    }
    const detail = [...bases].map(([b, k]) => (bases.size > 1 || k !== mine.length ? `${b} ${k}` : b)).join(', ')
    why.push(`- ${m} ${MECH_LABELS[m]}: ${plural(mine.length, 'drop')}${detail ? ` (${detail})` : ''}.`)
  }
  if (why.length) lines.push('', ...why)
  // A paragraph, not a second list: two lists in a row would merge into one.
  if (context.length) lines.push('', context.join(' '))
  lines.push('', withLikely || !n
    ? 'The daily summary at 08:00 will include these. Alerts are rate limited.'
    : `No cause is known for ${n === 1 ? 'it' : 'these'} yet: the kernel log and the sleep records come in later, and the daily summary at 08:00 works ${n === 1 ? 'it' : 'them'} out. Alerts are rate limited.`)
  return homeSafeLetter({ subject, type: 'info', markdown: lines.join('\n'), text: lead.slice(0, 280) })
}

/**
 * POST the letter. Resolves {ok, status, id, error}; never throws.
 */
export async function postLetter(api, letter, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const url = `${api.replace(/\/$/, '')}/api/v1/human-inbox`
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(homeSafeLetter(letter)),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body = null
    try { body = await res.json() } catch { /* non-JSON error page */ }
    if (res.status === 201 && body?.id) return { ok: true, status: res.status, id: body.id }
    const error = typeof body?.error === 'string' ? body.error : body?.error?.message ?? `HTTP ${res.status}`
    return { ok: false, status: res.status, error }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}

/**
 * A reply in an existing letter's thread (a correction), through the agent
 * reply route POST /api/v1/human-inbox/:id/reply {text}; it marks the letter
 * unread again. Resolves {ok, status, error}; never throws.
 */
export async function postReply(api, letterId, text, { timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const url = `${api.replace(/\/$/, '')}/api/v1/human-inbox/${encodeURIComponent(letterId)}/reply`
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: homeSafe(text) }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    let body = null
    try { body = await res.json() } catch { /* non-JSON error page */ }
    if (res.status === 200 && body?.letter) return { ok: true, status: 200 }
    const error = typeof body?.error === 'string' ? body.error : body?.error?.message ?? `HTTP ${res.status}`
    return { ok: false, status: res.status, error }
  } catch (err) {
    return { ok: false, status: 0, error: String(err?.message ?? err) }
  }
}
