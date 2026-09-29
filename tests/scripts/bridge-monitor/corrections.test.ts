/**
 * Corrections to live alerts: when the full analysis (the daily pmset read,
 * the kernel sweeps) changes an alert's verdict, one plain sentence goes into
 * that letter's thread, once.
 */
import { describe, expect, it } from 'vitest'
import http from 'node:http'
import { analyze } from '../../../scripts/bridge-monitor/lib/classify.mjs'
import { postReply } from '../../../scripts/bridge-monitor/lib/letter.mjs'
import { ASLEEP_SENTENCE, dailyCorrection, DAILY_LETTER_VERSION, findCorrections, verdictChange } from '../../../scripts/bridge-monitor/lib/corrections.mjs'

type AnyRec = Record<string, any>
const T0 = Date.parse('2026-03-10T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
const dev = (s: number, ev: string, extra: AnyRec = {}) => ({ t: at(s), kind: 'daemon', ev, ...extra })

describe('corrections to alerts', () => {
  const alertRec = (extra: AnyRec = {}) => ({ t: at(492), kind: 'alert', reason: 'outage', durS: 492, delivered: true, letterId: 'lt-test-1', ...extra })
  // The live case: a silence drop, then 8 minutes down; pmset (read later) shows the Mac asleep.
  const records = () => [
    dev(-1500, 'connected'), dev(0, 'silence', { silentMs: 276_000 }), dev(0.1, 'closed'), dev(500, 'connected'),
    ...Array.from({ length: 30 }, (_, k) => ({ t: at(-1500 + k * 60), kind: 'load' })),
  ]
  const pmset = [{ t: at(-277), kind: 'pmset', type: 'Sleep', state: 'asleep', text: 'Entering Sleep' }, { t: at(0), kind: 'pmset', type: 'DarkWake', state: 'darkwake', text: 'DarkWake' }, { t: at(8), kind: 'pmset', type: 'Sleep', state: 'asleep', text: 'Entering Sleep' }]

  it('an outage alert the pmset read later shows asleep gets the one-sentence correction', () => {
    const before = analyze(records(), { nowMs: T0 + 600_000 })
    expect(verdictChange(alertRec(), before)).toBeNull() // nothing new: the verdict stands
    const after = analyze([...records(), ...pmset], { nowMs: T0 + 600_000 })
    expect(verdictChange(alertRec(), after)).toBe(ASLEEP_SENTENCE)
    expect(ASLEEP_SENTENCE).toBe('Correction: the Mac was asleep then, so this was not a drop while awake.')
  })

  it('a changed mechanism is corrected too, and each letter is corrected once', () => {
    const a = analyze(records(), { nowMs: T0 + 600_000 })
    const drop = a.links.find((l: AnyRec) => l.downMs === T0)
    expect(drop.mech).toBe('M5')
    expect(verdictChange(alertRec({ downMs: T0, mech: 'M1' }), a)).toBe('Correction: this drop was M5 (silent while awake), not M1 (reset or closed from the far side).')
    const all = [...records(), ...pmset, alertRec()]
    const withPmset = analyze(all, { nowMs: T0 + 600_000 })
    expect(findCorrections(all, withPmset, { nowMs: T0 + 3_600_000 })).toEqual([
      { kind: 'alert-correction', letterId: 'lt-test-1', alertAt: at(492), reason: 'outage', text: ASLEEP_SENTENCE },
    ])
    const done = [...all, { t: at(4000), kind: 'alert-correction', letterId: 'lt-test-1', delivered: true }]
    expect(findCorrections(done, withPmset, { nowMs: T0 + 3_600_000 })).toEqual([])
    // Too old for an automatic correction, unless asked for by id.
    expect(findCorrections(all, withPmset, { nowMs: T0 + 40 * 3_600_000 })).toEqual([])
    expect(findCorrections(all, withPmset, { nowMs: T0 + 40 * 3_600_000, only: ['lt-test-1'] })).toHaveLength(1)
    expect(findCorrections(all, withPmset, { nowMs: T0 + 3_600_000, only: ['lt-other'] })).toEqual([])
  })

  it('the reply goes to the letter thread route as {text}', async () => {
    const seen: AnyRec[] = []
    const srv = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, json: JSON.parse(raw) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"letter":{"id":"lt-test-1"}}')
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    try {
      const api = `http://127.0.0.1:${(srv.address() as AnyRec).port}`
      expect(await postReply(api, 'lt-test-1', ASLEEP_SENTENCE)).toEqual({ ok: true, status: 200 })
      expect(seen).toEqual([{ method: 'POST', url: '/api/v1/human-inbox/lt-test-1/reply', json: { text: ASLEEP_SENTENCE } }])
      expect((await postReply('http://127.0.0.1:9', 'lt-test-1', 'x', { timeoutMs: 2000 })).ok).toBe(false)
    } finally {
      await new Promise((r) => srv.close(r))
    }
  })
})

describe('corrections to storm alerts', () => {
  // Four plain closes in 5 minutes, and a storm alert at 320 s (limit 3 per 10 minutes).
  const drops = () => [
    dev(-1500, 'connected'),
    ...[10, 100, 200, 300].flatMap((s) => [dev(s, 'closed', { code: 1006 }), dev(s + 10, 'connected')]),
    ...Array.from({ length: 32 }, (_, k) => ({ t: at(-1500 + k * 60), kind: 'load' })),
  ]
  const storm = { t: at(320), kind: 'alert', reason: 'storm', count: 4, delivered: true, letterId: 'lt-storm-1' }
  const sleep = (s: number) => ({ t: at(s), kind: 'pmset', type: 'Sleep', state: 'asleep', text: 'Entering Sleep' })
  const wake = (s: number) => ({ t: at(s), kind: 'pmset', type: 'Wake', state: 'awake', text: 'Wake from Deep Idle' })
  const judge = (extra: AnyRec[]) => verdictChange(storm, analyze([...drops(), ...extra], { nowMs: T0 + 3_600_000 }), { maxDropsPer10Min: 3 })

  it('a storm the pmset read shows asleep throughout is corrected: none of it was awake', () => {
    expect(judge([sleep(0), wake(900)])).toBe('Correction: the Mac was asleep through that window, so none of those 4 drops happened while it was awake and this was not a storm.')
  })

  it('asleep for part of it: only the awake drops count, and under the limit it was not a storm', () => {
    expect(judge([sleep(0), wake(150)])).toBe('Correction: the Mac was asleep for part of that window, so only 2 of those 4 drops happened while it was awake and this was not a storm.')
  })

  it('awake throughout: the storm stands and nothing is sent', () => {
    expect(judge([])).toBeNull()
    const a = analyze([...drops(), storm], { nowMs: T0 + 3_600_000 })
    expect(findCorrections([...drops(), storm], a, { nowMs: T0 + 3_600_000, maxDropsPer10Min: 3 })).toEqual([])
  })
})

describe('corrections to daily letters (on request only)', () => {
  const DAY = { day: '2026-03-10', startMs: Date.parse('2026-03-10T00:00:00Z'), endMs: Date.parse('2026-03-11T00:00:00Z') }
  const records = [
    dev(-1500, 'connected'), dev(10, 'closed', { code: 1006 }), dev(20, 'connected'), dev(100, 'closed', { code: 1006 }), dev(110, 'connected'),
    ...Array.from({ length: 32 }, (_, k) => ({ t: at(-1500 + k * 60), kind: 'load' })),
  ]
  const a = analyze(records, { dayBounds: [DAY], reportDay: DAY.day, nowMs: DAY.endMs + 3_600_000 })
  const row = a.days.find((d: AnyRec) => d.day === DAY.day)
  const summary = (extra: AnyRec = {}) => ({ t: '2026-03-11T08:00:05Z', kind: 'summary', reportDay: DAY.day, drops: row.drops, byMech: row.byMech, delivered: true, letterId: 'lt-day-1', ...extra })

  it('a letter from before the day-bounded evidence gets one sentence with the current counts', () => {
    const old = summary({ byMech: { ...row.byMech, M5: (row.byMech.M5 ?? 0) + 1, 'M?': 0 } })
    const text = dailyCorrection(old, a)
    expect(text).toMatch(/^Correction: counted again with the current rules, 2026-03-10 had \d+ drops?: .+; the evidence lines in this letter also counted events from after 2026-03-10\.$/)
    expect(text).not.toMatch(/[\u2013\u2014]/)
    expect(text!.split('. ').length).toBe(1) // one sentence
  })

  it('a current letter whose counts still hold is left alone; changed counts are corrected without the evidence note', () => {
    expect(dailyCorrection(summary({ letterVersion: DAILY_LETTER_VERSION }), a)).toBeNull()
    const changed = dailyCorrection(summary({ letterVersion: DAILY_LETTER_VERSION, drops: row.drops + 1 }), a)
    expect(changed).toMatch(/^Correction: counted again with the current rules, 2026-03-10 had/)
    expect(changed).not.toContain('evidence lines')
  })

  it('only when named, and once', () => {
    const all = [...records, summary()]
    expect(findCorrections(all, a, { nowMs: DAY.endMs + 7_200_000 })).toEqual([])
    const owed = findCorrections(all, a, { nowMs: DAY.endMs + 7_200_000, only: ['lt-day-1'] })
    expect(owed).toEqual([{ kind: 'daily-correction', letterId: 'lt-day-1', alertAt: '2026-03-11T08:00:05Z', reason: 'daily', text: dailyCorrection(summary(), a) }])
    const done = [...all, { t: '2026-03-11T09:00:00Z', kind: 'daily-correction', letterId: 'lt-day-1', delivered: true }]
    expect(findCorrections(done, a, { nowMs: DAY.endMs + 7_200_000, only: ['lt-day-1'] })).toEqual([])
  })
})
