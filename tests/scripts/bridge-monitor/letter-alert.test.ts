/**
 * Letters (daily + alert), their delivery through POST /api/v1/human-inbox,
 * the outbox retry, and the live alert detector's rate limits.
 */
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { analyze } from '../../../scripts/bridge-monitor/lib/classify.mjs'
import { buildAlertLetter, buildDailyLetter, causeTable, dayLabel, dayTable, evidenceBullets, homeSafe, postLetter, postReply } from '../../../scripts/bridge-monitor/lib/letter.mjs'
import { deliverLetter, retryOutbox } from '../../../scripts/bridge-monitor/lib/outbox.mjs'
import { evaluateAlerts, freshAlertState } from '../../../scripts/bridge-monitor/lib/alert.mjs'
import { sleptInGap } from '../../../scripts/bridge-monitor/lib/parse-net.mjs'

type AnyRec = Record<string, any>
const T0 = Date.parse('2026-03-10T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const dev = (s: number, ev: string, extra: AnyRec = {}) => ({ t: at(s), kind: 'daemon', ev, ...extra })
const DAY = { day: '2026-03-10', startMs: Date.parse('2026-03-10T00:00:00Z'), endMs: Date.parse('2026-03-11T00:00:00Z') }
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
const DASHES = /[\u2013\u2014]/ // en and em dash

function sampleAnalysis() {
  const records = [
    dev(0, 'connected'), dev(300, 'closed'), dev(301, 'connected'), dev(360, 'closed'), dev(361, 'connected'),
    dev(420, 'closed'), dev(421, 'connected'), dev(480, 'closed'), dev(600, 'connected'),
    { t: at(479), kind: 'server', ev: 'ssh-died', host: 'devbox.example.test' },
    { t: at(470), kind: 'net', changed: ['primary'], primary: 'en7', router: '192.0.2.1' },
    { t: at(500), kind: 'pubip', ip: '203.0.113.9', changed: true },
  ]
  return { records, a: analyze(records, { dayBounds: [DAY], reportDay: DAY.day, nowMs: DAY.endMs }) }
}

describe('daily letter', () => {
  // 2026-03-10 is a Tuesday. The label keeps one line: U+2011 hyphen, U+00A0 space.
  const MAR10 = '03\u201110\u00a0Tue'

  it('a compact one-line day label', () => {
    expect(dayLabel('2026-03-10')).toBe(MAR10)
    expect(dayLabel('2026-09-26')).toBe('09\u201126\u00a0Sat')
    expect(dayLabel('2026-12-31')).toBe('12\u201131\u00a0Thu')
  })

  it('two narrow tables: a row per day, then a row per mechanism', () => {
    const { a } = sampleAnalysis()
    const table = dayTable(a.days)
    expect(table.split('\n')).toHaveLength(3)
    expect(table.split('\n')[0]).toBe('| Day | Drops | Out | Up\u00a0% |')
    expect(table).toContain(`| ${MAR10} | 4 |`)
    const causes = causeTable(a.days, DAY.day)
    // One day in the window: no window column.
    expect(causes.split('\n')[0]).toBe(`| Cause | ${MAR10} |`)
    expect(causes.split('\n')).toHaveLength(9)
    expect(causes).toMatch(/\| M1 far end \| \d+ \|/)
    // Phone width: no cause label longer than "M5 silent awake" (the old "M4 daemon restart" wrapped).
    for (const row of causes.split('\n').slice(2)) expect(row.split('|')[1].trim().length, row).toBeLessThanOrEqual(15)
    expect(causes).toContain('| M6 daemon froze |')
    expect(causes).toContain('| M? no cause yet |')
    // Narrow enough for a phone (about 300 px of web table): at most 4 columns.
    for (const t of [table, causes]) expect(t.split('\n')[0].split('|').length - 2).toBeLessThanOrEqual(4)
  })

  it('the causes table adds a window total when there are several days', () => {
    const PREV = { day: '2026-03-09', startMs: Date.parse('2026-03-09T00:00:00Z'), endMs: DAY.startMs }
    const records = [dev(-86_000, 'connected'), dev(-85_000, 'closed'), dev(-84_990, 'connected'), ...sampleAnalysis().records]
    const a = analyze(records, { dayBounds: [PREV, DAY], reportDay: PREV.day, nowMs: DAY.endMs })
    const causes = causeTable(a.days, PREV.day)
    expect(causes.split('\n')[0]).toBe('| Cause | 03\u201109\u00a0Mon | 2\u00a0days |')
    const sum = (m: string) => a.days.reduce((acc: number, d: AnyRec) => acc + d.byMech[m], 0)
    expect(causes).toContain(`| M? no cause yet | ${a.days[0].byMech['M?']} | ${sum('M?')} |`)
  })

  it('days before the first record are left out, not shown as clean 0-drop days', () => {
    const PREV = { day: '2026-03-09', startMs: Date.parse('2026-03-09T00:00:00Z'), endMs: DAY.startMs }
    const { records } = sampleAnalysis()
    const a = analyze(records, { dayBounds: [PREV, DAY], reportDay: DAY.day, nowMs: DAY.endMs })
    expect(a.days.map((d: AnyRec) => d.observedH)).toEqual([0, expect.any(Number)])
    const table = dayTable(a.days)
    expect(table).not.toContain('03\u201109')
    expect(table).toContain(`| ${MAR10} | 4 |`)
    expect(causeTable(a.days, DAY.day)).not.toContain('03\u201109')
    const empty = analyze([], { dayBounds: [PREV], reportDay: PREV.day, nowMs: DAY.endMs })
    expect(dayTable(empty.days)).toContain('no records yet')
  })

  it('short English letter: hypothesis first, then the table, then evidence; type info', () => {
    const { records, a } = sampleAnalysis()
    const bullets = evidenceBullets(a, { windowStartMs: DAY.startMs, nowMs: DAY.endMs, netRecords: a.ctx.net, pubip: records.filter((r) => r.kind === 'pubip') })
    const letter = buildDailyLetter(a, { days: a.days, bullets, storeDir: '/tmp/store', tz: 'UTC', reportDay: DAY.day })
    expect(letter.type).toBe('info')
    expect(letter.subject).toMatch(/^Bridge monitor 2026-03-10: 4 drops, up \d+(\.\d)?%/)
    expect(letter.markdown.indexOf('## Per day')).toBeLessThan(letter.markdown.indexOf('## Causes'))
    expect(letter.markdown).toContain('"Out": outages longer than 60s')
    expect(letter.markdown.indexOf('## Top hypothesis')).toBeLessThan(letter.markdown.indexOf('## Per day'))
    expect(letter.markdown).toContain('Public IP changed 1 times.')
    expect(letter.markdown).toContain('## Storms')
    expect(letter.text.length).toBeLessThanOrEqual(280)
  })

  it('event-loop drift counts only drops proven awake (a sleep stalls every timer)', () => {
    const close = (drift: number) => ({ maxOutFrameBytes: 2048, bufferedAmountPeak: 0, loopDriftMax60sMs: drift })
    const drop = (mech: string, drift: number, slept = false, covered = !slept) => ({ downMs: DAY.startMs + 1000, mech, close: close(drift), ctx: { slept, covered } })
    const fake = (drops: AnyRec[]) => ({ drops, ctx: { gaps: [] }, probeLinks: [] })
    const opts = { windowStartMs: DAY.startMs, nowMs: DAY.endMs }
    const line = (drops: AnyRec[]) => evidenceBullets(fake(drops), opts).find((b: string) => b.startsWith('Daemon close records'))
    expect(line([drop('M3', 1_039_700), drop('M1', 120)])).toContain('worst event-loop drift while awake 120 ms')
    expect(line([drop('M?', 1_000_000, true), drop('M1', 80)])).toContain('while awake 80 ms')
    expect(line([drop('M3', 1_039_700)])).toBe('Daemon close records: 1; largest outbound frame 2 KB, peak send buffer 0 KB.')
    // Live: a silence of unknown state (a 48 minute sleep the pmset read had not reached yet) said 2891705 ms.
    expect(line([drop('M?', 2_891_705, false, false), drop('M6', 71_000)])).toContain('while awake 71000 ms')
  })

  it('never prints a host, an IP address or a dash character', () => {
    const { records, a } = sampleAnalysis()
    const bullets = evidenceBullets(a, { windowStartMs: DAY.startMs, nowMs: DAY.endMs, netRecords: a.ctx.net, pubip: records.filter((r) => r.kind === 'pubip') })
    const letter = buildDailyLetter(a, { days: a.days, bullets, storeDir: '/tmp/store', tz: 'UTC', reportDay: DAY.day })
    const all = `${letter.subject}\n${letter.markdown}\n${letter.text}`
    expect(all).not.toMatch(IPV4)
    expect(all).not.toContain('example.test')
    expect(all).not.toContain('en7')
    expect(all).not.toMatch(DASHES)
  })

  it('no data at all still yields a sendable letter', () => {
    const a = analyze([], { dayBounds: [DAY], reportDay: DAY.day, nowMs: DAY.endMs })
    const letter = buildDailyLetter(a, { days: a.days, bullets: [], storeDir: '/x', tz: 'UTC', reportDay: DAY.day })
    expect(letter.subject).toBe('Bridge monitor 2026-03-10: no records')
    expect(letter.markdown).toContain('The monitor has no records for this day.')
  })

  it('a day the bridge never connected is not "0 drops, up 0%" and not "stayed up"', () => {
    // The collector ran all day (load samples), the daemon never connected.
    const records = Array.from({ length: 24 }, (_, h) => ({ t: new Date(DAY.startMs + h * 3_600_000 + 60_000).toISOString(), kind: 'load' }))
    const a = analyze(records, { dayBounds: [DAY], reportDay: DAY.day, nowMs: DAY.endMs })
    const letter = buildDailyLetter(a, { days: a.days, bullets: [], storeDir: '/x', tz: 'UTC', reportDay: DAY.day })
    expect(letter.subject).toBe('Bridge monitor 2026-03-10: bridge never connected')
    expect(letter.markdown).toContain('The bridge never connected on this day')
    expect(`${letter.subject}\n${letter.markdown}\n${letter.text}`).not.toMatch(/0 drops|stayed up|stayed connected|No drops in this window/)
  })

  it('the evidence covers the report day only: the next morning\'s drops stay out', () => {
    // Review case: 0 drops on the day, 5 after midnight with a 99999 ms drift.
    const next = (k: number) => ({ downMs: DAY.endMs + 3_600_000 + k * 60_000, mech: 'M?', close: { maxOutFrameBytes: 9_000_000, bufferedAmountPeak: 0, loopDriftMax60sMs: 99_999 }, ctx: { slept: false, tcp: { ending: 'peer-reset' } } })
    const fake = { drops: [0, 1, 2, 3, 4].map(next), ctx: { gaps: [] }, probeLinks: [] }
    const netRecords = [{ t: new Date(DAY.endMs + 60_000).toISOString(), changed: ['primary'] }]
    const pubip = [{ t: new Date(DAY.endMs + 60_000).toISOString(), changed: true }]
    const sntp = [{ t: new Date(DAY.startMs + 3_600_000).toISOString(), offsetMs: 12.5, errMs: 3 }, { t: new Date(DAY.endMs + 60_000).toISOString(), offsetMs: 999, errMs: 1 }]
    const bullets = evidenceBullets(fake, { windowStartMs: DAY.startMs, windowEndMs: DAY.endMs, nowMs: DAY.endMs + 8 * 3_600_000, netRecords, pubip, sntp })
    const all = bullets.join('\n')
    expect(all).toContain('Mac clock offset: 12.5 ms (+/- 3 ms).') // the day's own reading, not the next morning's
    expect(all).not.toContain('Daemon close records')
    expect(all).not.toContain('99999')
    expect(all).not.toContain('Kernel view')
    expect(all).toContain('Mac network changes: 0 (default route moved 0 times). Public IP changed 0 times.')
  })

  it('the "Up" legend is true for days without sleep records: those are starred', () => {
    const known = { day: '2026-03-09', observedH: 24, drops: 1, outages60: 0, longestOutageS: null, connectedPct: 90, awakeConnectedPct: 99, sleepKnown: true, byMech: {} }
    const unknown = { ...known, day: DAY.day, connectedPct: 80, awakeConnectedPct: 80, sleepKnown: false }
    const table = dayTable([known, unknown])
    expect(table).toContain('| 03\u201109\u00a0Mon | 1 | 0 | 99 |')
    expect(table).toContain(`| ${MAR10} | 1 | 0 | 80* |`)
    const fake = { hypothesis: { text: 'x' }, storms: [] }
    const letter = buildDailyLetter(fake, { days: [known, unknown], bullets: [], storeDir: '/x', tz: 'UTC', reportDay: DAY.day })
    expect(letter.markdown).toContain('* marks a day without sleep records, where it is the share of all the time observed')
    expect(letter.subject).toBe('Bridge monitor 2026-03-10: 1 drop, up 80%')
    const clean = buildDailyLetter(fake, { days: [known], bullets: [], storeDir: '/x', tz: 'UTC', reportDay: known.day })
    expect(clean.markdown).not.toContain('* marks')
    expect(clean.subject).toBe('Bridge monitor 2026-03-09: 1 drop, up 99% while awake')
  })

  it('the raw records line names no home directory and can wrap', () => {
    const { a } = sampleAnalysis()
    const storeDir = path.join(os.homedir(), 'Library', 'Logs', 'Walnut', 'bridge-monitor')
    const letter = buildDailyLetter(a, { days: a.days, bullets: [], storeDir, tz: 'UTC', reportDay: DAY.day })
    expect(letter.markdown).not.toContain(os.homedir())
    expect(letter.markdown).toContain('Raw records are kept on this Mac in ~/Library/Logs/Walnut/bridge-monitor.')
    expect(letter.markdown).not.toMatch(/`[^`]*bridge-monitor[^`]*`/)
  })

  it('an M6 day says plainly that the daemon froze, with the stall and the load', () => {
    const drop = (drift: number, load1: number, idle: number) => ({ downMs: DAY.startMs + 3_600_000, mech: 'M6', close: { maxOutFrameBytes: 0, bufferedAmountPeak: 0, loopDriftMax60sMs: drift }, ctx: { slept: false, load1, cpuIdlePct: idle } })
    const m5 = { downMs: DAY.startMs + 7_200_000, mech: 'M5', close: { loopDriftMax60sMs: 900 }, ctx: { slept: false } }
    const fake = { drops: [drop(71_000, 301, 2.5), drop(176_130, 280, 0.8), m5], ctx: { gaps: [] }, probeLinks: [] }
    const bullets = evidenceBullets(fake, { windowStartMs: DAY.startMs, windowEndMs: DAY.endMs, nowMs: DAY.endMs })
    expect(bullets).toContain('The Walnut daemon on this Mac froze 2 times, 2 of the 3 silence watchdog closes while the Mac was awake (event loop stalled up to 176 s, machine load up to 301, CPU idle down to 0.8%); each stall alone was long enough for its own silence watchdog to close the link.')
  })

  it('alert letters: storm and outage wording, a table of the drops the alert counted', () => {
    const drops = [{ downMs: T0, upS: 50, cause: 'closed', mech: 'M2', basis: 'SSH links died at the same time' }]
    const storm = buildAlertLetter({ reason: 'storm', count: 1 }, { drops, tz: 'UTC' })
    expect(storm.subject).toBe('Bridge alert: 1 drop between 10:00 and 10:00')
    expect(storm.markdown).toContain('| Time | Up for | Cause | Likely |')
    expect(storm.markdown).toContain('| 10:00:00 | 50s | closed | M2 |')
    expect(storm.markdown).toContain('- M2 network path drop: 1 drop (SSH links died at the same time).')
    const outage = buildAlertLetter({ reason: 'outage', durS: 75, ongoing: true, downMs: T0 }, { drops, tz: 'UTC' })
    expect(outage.subject).toBe('Bridge alert: down since 10:00 (75s and counting)')
    expect(outage.markdown).toMatch(/^The Mac to cloud bridge has been down since 10:00:00 \(75s and counting\) while the Mac was awake\./)
    expect(`${storm.markdown}${outage.markdown}`).not.toMatch(DASHES)
  })

  it('regression: the alert table keeps one short token per cell, the long basis goes below it (it wrapped to 5 lines at 390 px)', () => {
    // The live 08:41 outage alert.
    const drops = [{ downMs: T0, upS: 1560, cause: 'silence', silentMs: 276_000, mech: 'M5', basis: 'silence watchdog while the Mac was awake, no drift data' }]
    const letter = buildAlertLetter({ reason: 'outage', durS: 480, ongoing: true, downMs: T0 }, { drops, tz: 'UTC', context: ['Mac network changes in the last 15 minutes: 1.'] })
    const rows = letter.markdown.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Time'))
    expect(rows).toEqual(['| 10:00:00 | 26m | silence | M5 |'])
    for (const cell of rows.flatMap((r) => r.split('|').map((c) => c.trim()).filter(Boolean))) expect(cell.length).toBeLessThanOrEqual(8)
    expect(letter.markdown).toContain('while the Mac was awake; nothing had arrived for 276 s when the daemon closed it.')
    expect(letter.markdown).toContain('- M5 silent while awake: 1 drop (silence watchdog while the Mac was awake, no drift data).')
    // The context is a paragraph of its own, not merged into the list above.
    expect(letter.markdown).toContain('no drift data).\n\nMac network changes in the last 15 minutes: 1.\n\nThe daily summary')
  })

  it('regression: title, first line and table cover the same drops (live: "4 drops in 10 minutes" over a table of 5 from 30 minutes)', () => {
    // lt-mumbh21k: sent at 23:50:07 local with no kernel lines in yet, so every drop was M? with no evidence.
    const drop = (s: number, up: number) => ({ downMs: T0 + s * 1000, upS: up, cause: 'closed', mech: 'M?', basis: 'no corroborating evidence' })
    const counted = [drop(0, 1080), drop(73, 71), drop(341, 240), drop(462, 120)]
    const live = buildAlertLetter({ reason: 'storm', count: 4 }, { drops: counted, tz: 'UTC' })
    expect(live.subject).toBe('Bridge alert: 4 drops between 10:00 and 10:07')
    expect(live.markdown.split('\n')[0]).toBe('The Mac to cloud bridge dropped 4 times between 10:00:00 and 10:07:42.')
    const rows = live.markdown.split('\n').filter((l) => /^\| \d/.test(l))
    expect(rows).toEqual(['| 10:00:00 | 18m | closed |', '| 10:01:13 | 71s | closed |', '| 10:05:41 | 4m | closed |', '| 10:07:42 | 2m | closed |'])
    // No cause yet anywhere: no Likely column, no per-row "no cause found yet", one sentence instead.
    expect(live.markdown).toContain('| Time | Up for | Cause |\n')
    expect(live.markdown).not.toContain('no cause found yet')
    expect(live.markdown.match(/No cause is known/g)).toHaveLength(1)
    expect(live.markdown).toContain('No cause is known for these yet: the kernel log and the sleep records come in later, and the daily summary at 08:00 works them out.')
    // Later, with causes: rows with the same cause become ONE line with a count and its evidence.
    const later = buildAlertLetter({ reason: 'storm', count: 5 }, {
      drops: [
        { ...counted[0], mech: 'M1', basis: 'kernel: peer-reset' }, { ...counted[1], mech: 'M1', basis: 'kernel: peer-reset' },
        { ...counted[2], mech: 'M1', basis: 'kernel: peer-fin' }, counted[3], { ...drop(500, 30), mech: 'M3', basis: 'Mac asleep' },
      ],
      tz: 'UTC',
    })
    expect(later.subject).toBe('Bridge alert: 5 drops between 10:00 and 10:08')
    const why = later.markdown.split('\n').filter((l) => l.startsWith('- '))
    expect(why).toEqual([
      '- M1 reset or closed from the far side: 3 drops (kernel: peer-reset 2, kernel: peer-fin 1).',
      '- M3 Mac asleep or DarkWake: 1 drop (Mac asleep).',
      '- M? no cause found yet: 1 drop; the morning report works it out.',
    ])
    expect(later.markdown).toContain('| Time | Up for | Cause | Likely |')
    // A long storm: every counted drop is in the count; the table says when it shows only the latest.
    const many = Array.from({ length: 15 }, (_, k) => drop(k * 30, 30))
    const big = buildAlertLetter({ reason: 'storm', count: 15 }, { drops: many, tz: 'UTC' })
    expect(big.subject).toBe('Bridge alert: 15 drops between 10:00 and 10:07')
    expect(big.markdown.split('\n').filter((l) => /^\| \d/.test(l))).toHaveLength(12)
    expect(big.markdown).toContain('The latest 12 of the 15 are listed.')
  })

  it('the storm alert carries exactly the drops it counted', () => {
    const cfg = { enabled: true, maxDropsPer10Min: 3, outageSec: 60, cooldownMin: 30, maxPerDay: 6, includeSleep: false }
    // One drop 25 minutes back (outside the 10 minutes), four inside.
    const link = (s: number) => ({ upMs: T0 + (s - 100) * 1000, downMs: T0 + s * 1000, reconnectS: 1 })
    const links = [link(-1500), link(0), link(60), link(120), link(180)]
    const [storm] = evaluateAlerts(freshAlertState(), { links, gaps: [], load: [], nowMs: T0 + 200_000, day: '2026-03-10' }, cfg).alerts
    expect(storm.count).toBe(4)
    expect(storm.drops.map((d: AnyRec) => d.downMs)).toEqual([T0, T0 + 60_000, T0 + 120_000, T0 + 180_000])
    expect(buildAlertLetter(storm, { drops: storm.drops, tz: 'UTC' }).subject).toBe('Bridge alert: 4 drops between 10:00 and 10:03')
    // The collector hands the letter these drops, not a wider window.
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'bridge-monitor', 'collector.mjs'), 'utf-8')
    expect(src).toContain('buildAlertLetter(a, { drops: a.drops,')
    expect(src).not.toMatch(/30 \* 60_000\)\s*\n\s*const net/)
  })

  it('no letter shows the home directory: a path under it is written with ~', () => {
    const home = os.homedir()
    expect(homeSafe(`kept in ${home}/Library/Logs/x, and ${home}.`)).toBe('kept in ~/Library/Logs/x, and ~.')
    expect(homeSafe(`${home}extra/y`)).toBe(`${home}extra/y`) // a different directory that only starts the same
    expect(homeSafe('/Users/alex/a', '/Users/alex')).toBe('~/a')
    const drops = [{ downMs: T0, upS: 50, cause: 'closed', mech: 'M?', basis: `the daemon closed it: cannot read ${home}/.open-walnut/bridge.json` }]
    const alert = buildAlertLetter({ reason: 'storm', count: 1 }, { drops, tz: 'UTC' })
    expect(alert.markdown).toContain('cannot read ~/.open-walnut/bridge.json')
    const { a } = sampleAnalysis()
    const daily = buildDailyLetter(a, {
      days: a.days, bullets: [`pmset failed: ${home}/Library/x not readable`], storeDir: path.join(home, 'Library', 'Logs', 'Walnut', 'bridge-monitor'), tz: 'UTC', reportDay: DAY.day,
    })
    for (const letter of [alert, daily]) expect(JSON.stringify(letter)).not.toContain(home)
  })
})

describe('delivery', () => {
  let server: http.Server | null = null
  let dir: string | null = null
  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r))
    server = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  async function inbox(handler: (body: AnyRec, res: http.ServerResponse) => void) {
    const seen: AnyRec[] = []
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        const body = { method: req.method, url: req.url, contentType: req.headers['content-type'], json: JSON.parse(raw || '{}') }
        seen.push(body)
        handler(body, res)
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return { api: `http://127.0.0.1:${(server!.address() as AnyRec).port}`, seen }
  }

  const letter = { subject: 'Bridge monitor test', type: 'info', markdown: '## Hi', text: 'Hi' }

  it('posts {subject, type, markdown, text} to /api/v1/human-inbox and returns the id', async () => {
    const { api, seen } = await inbox((_b, res) => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"id":"lt-abc"}') })
    const res = await postLetter(api, letter)
    expect(res).toEqual({ ok: true, status: 201, id: 'lt-abc' })
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/human-inbox', contentType: 'application/json', json: letter })
  })

  it('posting is the last gate: a letter or reply with the home directory in it goes out with ~', async () => {
    const home = os.homedir()
    const { api, seen } = await inbox((b, res) => {
      if (String(b.url).endsWith('/reply')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"letter":{"id":"lt-abc"}}'); return }
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"id":"lt-abc"}')
    })
    // A letter parked in the outbox by an older version still names the path.
    expect((await postLetter(api, { ...letter, markdown: `Raw records: \`${home}/Library/Logs/Walnut/bridge-monitor\`` })).ok).toBe(true)
    expect((await postReply(api, 'lt-abc', `see ${home}/x`)).ok).toBe(true)
    expect(seen.map((x) => x.json)).toEqual([{ ...letter, markdown: 'Raw records: `~/Library/Logs/Walnut/bridge-monitor`' }, { text: 'see ~/x' }])
  })

  it('a v1 error body is reported, not thrown', async () => {
    const { api } = await inbox((_b, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"code":"bad_request","message":"subject required"}}') })
    expect(await postLetter(api, letter)).toEqual({ ok: false, status: 400, error: 'subject required' })
  })

  it('a dead server is reported as status 0', async () => {
    const res = await postLetter('http://127.0.0.1:9', letter, { timeoutMs: 2000 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(0)
  })

  it('outbox: a failed delivery is parked, retried later, and removed once sent', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-outbox-'))
    let up = false
    const fetchImpl = async () => {
      if (!up) throw new Error('connect ECONNREFUSED')
      return new Response('{"id":"lt-late"}', { status: 201 })
    }
    const cfg = { stateDir: dir, inbox: { enabled: true, api: 'http://127.0.0.1:1', retryHours: 12 } }
    const first = await deliverLetter(cfg, letter, { fetchImpl })
    expect(first.ok).toBe(false)
    expect(fs.readdirSync(path.join(dir, 'outbox'))).toHaveLength(1)
    const recs: AnyRec[] = []
    expect(await retryOutbox(cfg, async (r: AnyRec) => { recs.push(r) }, { fetchImpl })).toMatchObject({ sent: 0, left: 1 })
    up = true
    expect(await retryOutbox(cfg, async (r: AnyRec) => { recs.push(r) }, { fetchImpl })).toMatchObject({ sent: 1, left: 0 })
    expect(fs.readdirSync(path.join(dir, 'outbox'))).toHaveLength(0)
    expect(recs.at(-1)).toMatchObject({ kind: 'letter', delivered: true, letterId: 'lt-late', tries: 3 })
  })

  it('outbox: a letter older than the retry window is dropped, not sent', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-outbox-'))
    const cfg = { stateDir: dir, inbox: { enabled: true, api: 'http://127.0.0.1:1', retryHours: 1 } }
    await deliverLetter(cfg, letter, { fetchImpl: async () => { throw new Error('down') } })
    let posted = 0
    const res = await retryOutbox(cfg, async () => {}, { fetchImpl: async () => { posted++; return new Response('{}', { status: 201 }) }, nowMs: Date.now() + 2 * 3_600_000 })
    expect(res).toMatchObject({ sent: 0, dropped: 1 })
    expect(posted).toBe(0)
  })

  it('a disabled inbox sends nothing', async () => {
    expect(await deliverLetter({ inbox: { enabled: false } }, letter)).toEqual({ ok: false, error: 'inbox disabled' })
  })
})

describe('live alerts', () => {
  const cfg = { enabled: true, maxDropsPer10Min: 3, outageSec: 60, cooldownMin: 30, maxPerDay: 6, includeSleep: false }
  const link = (downS: number, reconnectS?: number) => ({ upMs: T0 + (downS - 100) * 1000, downMs: T0 + downS * 1000, reconnectS })
  // The collector's load samples, every minute from well before the first link.
  const LOAD = Array.from({ length: 800 }, (_, k) => ({ t: at(-600 + k * 60) }))
  const input = (links: AnyRec[], nowS: number, gaps: AnyRec[] = [], load: AnyRec[] = LOAD) => ({
    links, gaps, load: load.filter((x) => Date.parse(x.t) <= T0 + nowS * 1000), nowMs: T0 + nowS * 1000, day: '2026-03-10',
  })

  it('storm: more than N drops in 10 minutes alerts once, then the cooldown holds', () => {
    const links = [link(0, 1), link(60, 1), link(120, 1), link(180, 1)]
    const r1 = evaluateAlerts(freshAlertState(), input(links, 200), cfg)
    expect(r1.alerts).toEqual([expect.objectContaining({ reason: 'storm', count: 4 })])
    const r2 = evaluateAlerts(r1.state, input([...links, link(240, 1)], 260), cfg)
    expect(r2.alerts).toEqual([])
    expect(r2.state.suppressed).toBe(1)
    expect(evaluateAlerts(freshAlertState(), input(links.slice(0, 3), 200), cfg).alerts).toEqual([])
  })

  it('outage: down longer than 60 s while awake alerts once for that outage', () => {
    const links = [link(0)]
    expect(evaluateAlerts(freshAlertState(), input(links, 50), cfg).alerts).toEqual([])
    const r = evaluateAlerts(freshAlertState(), input(links, 75), cfg)
    expect(r.alerts).toEqual([expect.objectContaining({ reason: 'outage', durS: 75, ongoing: true })])
    const again = evaluateAlerts(r.state, input(links, 3000), { ...cfg, cooldownMin: 0 })
    expect(again.alerts).toEqual([])
  })

  it('outage: one that already ended longer than 60 s still alerts', () => {
    const r = evaluateAlerts(freshAlertState(), input([link(0, 90), link(190)], 200), cfg)
    expect(r.alerts).toEqual([expect.objectContaining({ reason: 'outage', durS: 90, ongoing: false })])
  })

  it('outage overlapping a Mac sleep is expected and skipped unless includeSleep', () => {
    const gaps = [{ t: at(400), sleptMs: 390_000, wallMs: 400_000 }]
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 400, gaps), cfg).alerts).toEqual([])
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 400, gaps), { ...cfg, includeSleep: true }).alerts).toHaveLength(1)
  })

  it('regression: a sleep the monotonic clock ran through is still a sleep, so no "down while awake" alert', () => {
    // Live 2026-09-28: a 491 s gap with wall and mono both 491 s produced
    // "down for 8m while the Mac was awake". The kernel had slept in between.
    const startMs = T0 + 5_000
    const endMs = T0 + 496_000
    const sleptMs = sleptInGap({ startMs, endMs, monoMs: endMs - startMs, sleepMs: startMs + 2_000, wakeMs: endMs - 1_000 })
    const gaps = [{ t: new Date(endMs).toISOString(), wallMs: endMs - startMs, sleptMs }]
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 497, gaps), cfg).alerts).toEqual([])
  })

  it('regression: an outage across a collector hole of unknown state is not "down while awake"', () => {
    // Review case: a 282 s gap (starved, or the kernel read timed out) spanning the outage.
    const gap = { t: at(300), wallMs: 282_000, monoMs: 282_000, sleptMs: 0, kernelSleepAt: null, kernelWakeAt: null }
    const load = LOAD.filter((x) => { const s = (Date.parse(x.t) - T0) / 1000; return s < 18 || s >= 300 })
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 310, [gap], load), cfg).alerts).toEqual([])
    // No samples in the outage at all (collector not running): no alert either.
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 310, [], LOAD.filter((x) => Date.parse(x.t) < T0)), cfg).alerts).toEqual([])
    // The kernel proving the Mac awake through the same hole (a starved collector) does count.
    const starved = { ...gap, kernelSleepAt: at(-90_000), kernelWakeAt: at(-89_000) }
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 310, [starved], load), cfg).alerts).toHaveLength(1)
  })

  it('an alert carries what a later correction checks: the drop time and its mechanism', () => {
    const l = { ...link(0), mech: 'M5', basis: 'silence watchdog while the Mac was awake' }
    const [a] = evaluateAlerts(freshAlertState(), input([l], 75), cfg).alerts
    expect(a).toMatchObject({ reason: 'outage', downMs: T0, mech: 'M5', basis: 'silence watchdog while the Mac was awake' })
  })

  it('a storm of drops inside a sleep (dark wake redials) is not an alert either', () => {
    const links = [link(0, 1), link(60, 1), link(120, 1), link(180, 1)]
    const gaps = [{ t: at(200), wallMs: 230_000, sleptMs: 220_000 }]
    expect(evaluateAlerts(freshAlertState(), input(links, 200, gaps), cfg).alerts).toEqual([])
    expect(evaluateAlerts(freshAlertState(), input(links, 200, gaps), { ...cfg, includeSleep: true }).alerts).toHaveLength(1)
  })

  it('daily cap and the disabled switch', () => {
    let state = freshAlertState()
    let sent = 0
    for (let k = 0; k < 10; k++) {
      const r = evaluateAlerts(state, input([link(k * 4000)], k * 4000 + 100), { ...cfg, cooldownMin: 0, maxPerDay: 2 })
      sent += r.alerts.length
      state = r.state
    }
    expect(sent).toBe(2)
    expect(evaluateAlerts(freshAlertState(), input([link(0)], 100), { ...cfg, enabled: false }).alerts).toEqual([])
  })

  it('a new local day resets the daily count', () => {
    const r = evaluateAlerts({ ...freshAlertState(), day: '2026-03-09', today: 6 }, input([link(0)], 100), cfg)
    expect(r.alerts).toHaveLength(1)
    expect(r.state.today).toBe(1)
  })
})

describe('kernel view in the evidence', () => {
  it('tallies plain closes only, so it agrees with the causes table', () => {
    // After the daemon's own close the cloud sends the first FIN by protocol:
    // a watchdog drop that ends "peer-fin" says nothing about the far end.
    const drop = (cause: string, ending: string) => ({ downMs: DAY.startMs + 1000, cause, mech: 'M1', ctx: { tcp: { ending } } })
    const fake = { drops: [drop('closed', 'peer-reset'), drop('silence', 'peer-fin'), drop('restart', 'peer-fin'), drop('closed', 'local-abort')], ctx: { gaps: [] }, probeLinks: [] }
    const bullets = evidenceBullets(fake, { windowStartMs: DAY.startMs, windowEndMs: DAY.endMs, nowMs: DAY.endMs })
    expect(bullets).toContain('Kernel view of 2 plain closes (not the watchdog, not a restart): peer-reset 1, local-abort 1.')
  })
})
