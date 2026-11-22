/**
 * Settings > Real Use's rules (web/src/components/settings/sections/real-use-model.ts): the
 * number and time words, the find box, the "Problems first" order, the summary, a row's detail
 * lines, a page error's kind, and the watches' checks, results and states.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WATCH_CHECKS, alarmLine, noteRecipientName, alarmStatus, checksText, failuresText, matchesFind, msText, noteStatus, pageKindParts, pctText,
  recordedText, sizeText, sizesText, slowIsHigh, sortRows, spilledText, stamp, summaryOf, targetResultText, watchStatus, watchWhen,
} from '../../web/src/components/settings/sections/real-use-model'
import type { UsageRow } from '../../web/src/api/usage-watch'

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    kind: 'op', name: 'task_get', calls: 0, fails: 0, refused: 0, badArgs: 0, errors: 0, timeouts: 0, unreachable: 0, cut: 0, overLimit: 0,
    spilled: 0, over10k: 0, sizeP50: null, sizeP95: null, largest: 0, slow: 0, serverErrors: 0, msP95: null, codes: {}, series: [], alarm: null,
    ...over,
  }
}

// Local times, so the words are the same in every time zone.
const NOW = new Date(2026, 10, 21, 13, 35).getTime()

describe('number and time words', () => {
  it('writes sizes with K and M, times in ms or s, shares with one decimal', () => {
    expect(sizeText(null)).toBe('-')
    expect(sizeText(640)).toBe('640')
    expect(sizeText(12_600)).toBe('12.6K')
    expect(sizeText(141_300)).toBe('141.3K')
    expect(sizeText(10_000)).toBe('10K')
    expect(msText(null)).toBe('-')
    expect(msText(420)).toBe('420 ms')
    expect(msText(1_300)).toBe('1.3 s')
    expect(msText(2_000)).toBe('2 s')
    expect(pctText(82, 1_718)).toBe('4.8%')
    expect(pctText(0, 10)).toBe('')
    expect(pctText(1, 0)).toBe('')
    expect(pctText(1, 100_000)).toBe('<0.1%')
  })

  it('writes a local time with its date, or only the clock on the same day', () => {
    expect(stamp(new Date(2026, 10, 14, 13, 20).getTime())).toBe('11-14 13:20')
    expect(stamp(new Date(2026, 10, 21, 9, 5).getTime(), NOW)).toBe('09:05')
    expect(stamp(new Date(2026, 10, 20, 9, 5).getTime(), NOW)).toBe('11-20 09:05')
  })

  it('names the share recorded only when part of the range is missing', () => {
    expect(recordedText(1)).toBeNull()
    expect(recordedText(0.996)).toBe('recorded 99% of the time')
    expect(recordedText(0.5)).toBe('recorded 50% of the time')
  })
})

describe('the find box', () => {
  it('matches whatever the case and the separators between words', () => {
    expect(matchesFind('thread_update', '')).toBe(true)
    expect(matchesFind('thread_update', '  ')).toBe(true)
    expect(matchesFind('thread_update', 'THREAD')).toBe(true)
    expect(matchesFind('thread_update', 'thread update')).toBe(true)
    expect(matchesFind('thread_update', 'thread-up')).toBe(true)
    expect(matchesFind('thread_update', 'thred')).toBe(false)
  })
})

describe('the order of the rows', () => {
  const rows = [
    row({ name: 'b_calls', calls: 900 }),
    row({ name: 'a_calls', calls: 900 }),
    row({ name: 'over', calls: 10, overLimit: 3 }),
    row({ name: 'bad', calls: 10, badArgs: 2, overLimit: 50 }),
    row({ name: 'err', calls: 10, errors: 1, timeouts: 1, badArgs: 0 }),
    row({ name: 'cut', calls: 5, cut: 1 }),
    row({ name: 'alarm', calls: 1, alarm: { id: 'usage.errors{op=alarm}', state: 'ALARM', since: NOW } }),
  ]

  it('puts problems first: alarm, then cut, errors, bad args, over budget, then calls, then the name', () => {
    expect(sortRows(rows, 'problems').map((r) => r.name)).toEqual(['alarm', 'cut', 'err', 'bad', 'over', 'a_calls', 'b_calls'])
  })

  it('sorts by calls and by name', () => {
    expect(sortRows(rows, 'calls').map((r) => r.name).slice(0, 3)).toEqual(['a_calls', 'b_calls', 'bad'])
    expect(sortRows(rows, 'name').map((r) => r.name)[0]).toBe('a_calls')
  })

  it('orders requests by alarm, server errors, slow reads, then requests', () => {
    const http = [
      row({ kind: 'http', name: 'GET /a', calls: 500 }),
      row({ kind: 'http', name: 'GET /b', calls: 5, slow: 2 }),
      row({ kind: 'http', name: 'GET /c', calls: 5, serverErrors: 1 }),
    ]
    expect(sortRows(http, 'problems').map((r) => r.name)).toEqual(['GET /c', 'GET /b', 'GET /a'])
  })

  it('never changes the list it was given', () => {
    const copy = rows.map((r) => r.name)
    sortRows(rows, 'name')
    expect(rows.map((r) => r.name)).toEqual(copy)
  })
})

describe('the summary', () => {
  it('counts tools, requests and pages apart, and only alarms in alarm', () => {
    const s = summaryOf([
      row({ calls: 100, errors: 3, timeouts: 2, badArgs: 9, cut: 1, overLimit: 4, alarm: { id: 'x', state: 'ALARM', since: NOW } }),
      row({ name: 'task_list', calls: 50, alarm: { id: 'y', state: 'OK', since: NOW } }),
      row({ kind: 'http', name: 'GET /api/x', calls: 40, slow: 6, serverErrors: 2 }),
      row({ kind: 'page', name: 'TypeError in the ThreadCard chunk', calls: 7 }),
    ])
    expect(s).toEqual({ toolCalls: 150, realErrors: 5, cuts: 1, overBudget: 4, slowReads: 6, pageErrors: 7, alarms: 1 })
  })

  it('reads a request red when a tenth or more of it is slow', () => {
    expect(slowIsHigh({ calls: 100, slow: 10 })).toBe(true)
    expect(slowIsHigh({ calls: 100, slow: 9 })).toBe(false)
    expect(slowIsHigh({ calls: 0, slow: 0 })).toBe(false)
  })
})

describe("a row's detail", () => {
  it('lists every failure code, most first', () => {
    expect(failuresText({})).toBe('No failures.')
    expect(failuresText({ timeout: 1 })).toBe('1 failure: timeout 1.')
    expect(failuresText({ bad_input: 9, host_unreachable: 25, user_kind: 11, zero: 0, a_tie: 9 }))
      .toBe('All 54 failures: host_unreachable 25, user_kind 11, a_tie 9, bad_input 9.')
  })

  it('says the sizes and the answers saved to a file', () => {
    expect(sizesText({ sizeP50: null, sizeP95: null })).toBeNull()
    expect(sizesText({ sizeP50: 2_800, sizeP95: 12_600 })).toBe('Half under 2.8K characters, 95% under 12.6K.')
    expect(spilledText(0)).toBeNull()
    expect(spilledText(1)).toBe("1 answer over 60,000 characters was saved to a file by Walnut's MCP server.")
    expect(spilledText(3)).toBe("3 answers over 60,000 characters were saved to a file by Walnut's MCP server.")
  })

  it('says the alarm and what Walnut did, as a dot and a word', () => {
    const since = new Date(2026, 10, 21, 13, 13).getTime()
    expect(alarmLine(null, NOW)).toBe('No alarm has read it yet.')
    expect(alarmLine({ id: 'a', state: 'ALARM', since, did: 'delivered to "Walnut VP"' }, NOW)).toBe('In alarm since 13:13. What Walnut did: delivered to "Walnut VP"')
    expect(alarmLine({ id: 'a', state: 'OK', since }, NOW)).toBe('No alarm since 13:13.')
    expect(alarmStatus({ id: 'a', state: 'ALARM', since })).toEqual({ tone: 'error', text: 'Alarm' })
    expect(alarmStatus({ id: 'a', state: 'OK', since })).toEqual({ tone: 'ok', text: 'No alarm' })
    expect(alarmStatus({ id: 'a', state: 'INSUFFICIENT_DATA', since })).toEqual({ tone: 'muted', text: 'No data' })
    expect(alarmStatus(null)).toEqual({ tone: 'muted', text: 'No data' })
  })
})

describe("a page error's kind", () => {
  it('shows the request monospace, and a chunk as a code bundle', () => {
    expect(pageKindParts('GET /api/sessions/:id failed in the page')).toEqual([
      { text: 'GET /api/sessions/:id', mono: true }, { text: ' failed in the page', mono: false },
    ])
    expect(pageKindParts('TypeError in the ThreadCard chunk')).toEqual([
      { text: 'TypeError', mono: true }, { text: ' in the ', mono: false }, { text: 'ThreadCard', mono: true }, { text: ' code bundle', mono: false },
    ])
    expect(pageKindParts('TypeError in the unknown chunk')[2]).toEqual({ text: 'unknown', mono: false })
    expect(pageKindParts('GET unknown request failed in the page')).toEqual([{ text: 'GET unknown request failed in the page', mono: false }])
  })
})

describe('watches', () => {
  it('keeps the default checks equal to the server\'s', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/usage-watch/watches.ts'), 'utf8')
    const body = /DEFAULT_CHECKS: Required<WatchChecks> = \{([^}]*)\}/.exec(src)?.[1]
    expect(body, 'DEFAULT_CHECKS in watches.ts').toBeTruthy()
    const server = Object.fromEntries(body!.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [k, v] = p.split(':').map((x) => x.trim())
      return [k!, v === 'true' ? true : v === 'false' ? false : Number(v!.replace(/_/g, ''))]
    }))
    expect(server).toEqual({ ...DEFAULT_WATCH_CHECKS })
  })

  it('names the checks that apply to its targets, with the defaults', () => {
    expect(checksText({ checks: {}, targets: ['op:task_history'] })).toBe('Largest answer ≤ 20,000 chars; failures ≤ 5%; no new error code')
    expect(checksText({ checks: { max_p95_ms: 1_500 }, targets: ['route:POST /api/triage/rules'] })).toBe('Failures ≤ 5%; no new error code; p95 ≤ 1.5 s')
    expect(checksText({ checks: {}, targets: ['op:thread_update', 'page:ThreadCard'] })).toBe('Largest answer ≤ 20,000 chars; failures ≤ 5%; no new error code; no page error')
    expect(checksText({ checks: { min_uses: 5, no_new_codes: false }, targets: ['op:x'] })).toBe('Largest answer ≤ 20,000 chars; failures ≤ 5%; at least 5 uses each')
    expect(checksText({ checks: {}, targets: [], exempt: { kind: 'not_shipped', reason: 'only button labels changed' } })).toBe('Exempt: not shipped · only button labels changed')
    // A shipped task its lead closed with no watch: the gap shows, in its own words.
    expect(checksText({ checks: {}, targets: [], state: 'unwatched' })).toBe('Closed after it shipped, with nothing watching its real use')
    expect(watchStatus('unwatched')).toEqual({ tone: 'warn', text: 'Closed unwatched' })
  })

  it('says each target\'s result', () => {
    expect(targetResultText('op:x', undefined, 'watching')).toBe('no result yet')
    expect(targetResultText('op:x', undefined, 'dropped')).toBe('')
    expect(targetResultText('op:x', { target: 'op:x', uses: 412, ok: true, notes: [] }, 'passed')).toBe('412 uses ✓')
    expect(targetResultText('route:GET /a', { target: 'route:GET /a', uses: 1, ok: false, notes: ['failures 100% over 5%'] }, 'failed')).toBe('1 use: failures 100% over 5%')
    expect(targetResultText('page:ThreadCard', { target: 'page:ThreadCard', uses: 0, ok: true, notes: [] }, 'passed')).toBe('no page error ✓')
    expect(targetResultText('page:ThreadCard', { target: 'page:ThreadCard', uses: 2, ok: false, notes: ['2 page errors'] }, 'failed')).toBe('2 page errors')
  })

  it('maps every state to a dot and a word', () => {
    expect(watchStatus('watching')).toEqual({ tone: 'live', text: 'Watching' })
    expect(watchStatus('passed')).toEqual({ tone: 'ok', text: 'Passed' })
    expect(watchStatus('failed')).toEqual({ tone: 'error', text: 'Failed' })
    for (const s of ['too_little_use', 'unknown', 'exempt', 'dropped'] as const) expect(watchStatus(s).tone).toBe('muted')
    expect(watchStatus('too_little_use').text).toBe('Too little use')
  })

  it('says when it checks, or when it was checked', () => {
    const at = new Date(2026, 10, 22, 13, 2).getTime()
    expect(watchWhen({ state: 'watching', checkAt: at }, NOW)).toBe('checks 11-22 13:02')
    expect(watchWhen({ state: 'passed', checkAt: at, checkedAt: at }, NOW)).toBe('checked 11-22 13:02')
    expect(watchWhen({ state: 'exempt', checkAt: at }, NOW)).toBe('')
  })
})

describe('notes', () => {
  it('says sent, when the next goes, or why it was not delivered', () => {
    const due = new Date(2026, 10, 21, 17, 0).getTime()
    expect(noteStatus({ state: 'sent', dueAt: due, tries: 1 }, NOW)).toEqual({ tone: 'ok', text: 'Sent' })
    expect(noteStatus({ state: 'pending', dueAt: due, tries: 0 }, NOW)).toEqual({ tone: 'live', text: 'Next at 17:00' })
    expect(noteStatus({ state: 'failed', dueAt: due, tries: 6, detail: '"Fix it" has no session to tell' }, NOW))
      .toEqual({ tone: 'error', text: 'Not delivered after 6 tries: "Fix it" has no session to tell' })
    expect(noteStatus({ state: 'failed', dueAt: due, tries: 1 }, NOW).text).toBe('Not delivered after 1 try')
  })
})

describe('whom a note went to', () => {
  it('its title, else the name the send recorded, else its id', () => {
    expect(noteRecipientName({ recipient: 't1', recipientTitle: 'Walnut VP', detail: 'told "Old name"' })).toBe('Walnut VP')
    expect(noteRecipientName({ recipient: 't1', recipientTitle: null, detail: 'told "Walnut VP"' })).toBe('Walnut VP')
    expect(noteRecipientName({ recipient: 't1', recipientTitle: null, detail: '"X" has no session to tell' })).toBe('t1')
  })
})

