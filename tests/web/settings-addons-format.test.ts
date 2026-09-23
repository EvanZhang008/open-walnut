/**
 * Pure wording and queue logic behind the add-on and machine panes of
 * Settings (Calendar Accounts, Plugins, Phones & Cloud, Remote Hosts).
 */
import { describe, expect, it } from 'vitest'
import {
  LatestWriteQueue,
  calendarDisplayName,
  formatAbsoluteTime,
  formatLastRefreshed,
  hiddenAfterBulk,
  hiddenAfterToggle,
  shownCount,
} from '../../web/src/components/settings/sections/addons-format'
import {
  firstSentence,
  humanizeField,
  needsSetupHelp,
  originSentence,
  rowTags,
} from '../../web/src/components/settings/sections/plugin-row-view'
import { plainText, updateDisabledTitle, REASON_DIRTY } from '../../web/src/components/settings/plugin-update-view'

const NOW = new Date(2026, 8, 23, 15, 30) // Wed Sep 23 2026, 3:30 PM local

describe('formatAbsoluteTime', () => {
  it('today is just the time', () => {
    expect(formatAbsoluteTime(new Date(2026, 8, 23, 23, 44), NOW)).toBe('11:44 PM')
  })
  it('within six days is weekday plus time', () => {
    expect(formatAbsoluteTime(new Date(2026, 8, 20, 9, 5), NOW)).toBe('Sun 9:05 AM')
    expect(formatAbsoluteTime(new Date(2026, 8, 17, 9, 5), NOW)).toBe('Thu 9:05 AM')
  })
  it('older than six days is month, day and time', () => {
    expect(formatAbsoluteTime(new Date(2026, 8, 12, 23, 44), NOW)).toBe('Sep 12, 11:44 PM')
  })
  it('never says ago and ignores junk', () => {
    expect(formatAbsoluteTime(new Date(2026, 8, 23, 1, 0), NOW)).not.toMatch(/ago/)
    expect(formatAbsoluteTime('not a date', NOW)).toBe('')
  })
})

describe('calendar wording', () => {
  it('Last refreshed help', () => {
    expect(formatLastRefreshed(new Date(2026, 8, 23, 23, 44).toISOString(), 212, NOW)).toBe('11:44 PM, 212 events cached')
    expect(formatLastRefreshed(undefined, 1, NOW)).toBe('Not refreshed yet, 1 event cached')
  })
  it('id-looking and empty titles become Untitled calendar', () => {
    expect(calendarDisplayName('0f8fad5b-d9cb-469f-a165-70867728950e')).toEqual({ name: 'Untitled calendar', untitled: true })
    expect(calendarDisplayName('9f3a0c1d2e4b5a6f7c8d')).toEqual({ name: 'Untitled calendar', untitled: true })
    expect(calendarDisplayName('  ')).toEqual({ name: 'Untitled calendar', untitled: true })
    expect(calendarDisplayName('Holidays')).toEqual({ name: 'Holidays', untitled: false })
  })
  it('counts and full hidden lists', () => {
    const all = ['a', 'b', 'c', 'd']
    const hidden = new Set(['b'])
    expect(shownCount(['a', 'b', 'c'], hidden)).toBe('2 of 3 shown')
    expect(hiddenAfterToggle(all, hidden, 'c', true)).toEqual(['b', 'c'])
    expect(hiddenAfterToggle(all, hidden, 'b', false)).toEqual([])
    expect(hiddenAfterBulk(all, hidden, ['a', 'b', 'c'], true)).toEqual(['a', 'b', 'c'])
    expect(hiddenAfterBulk(all, new Set(['d', 'a']), ['a', 'b'], false)).toEqual(['d'])
  })
})

describe('LatestWriteQueue', () => {
  it('keeps one write in flight and resends only the latest target', async () => {
    const sent: string[][] = []
    const resolvers: Array<() => void> = []
    const settled: unknown[] = []
    const q = new LatestWriteQueue<string[]>(
      (v) => { sent.push(v); return new Promise<void>((r) => resolvers.push(r)) },
      (r) => settled.push(r),
    )
    q.push(['a'])
    q.push(['a', 'b'])
    q.push(['a', 'b', 'c'])
    expect(sent).toEqual([['a']])
    expect(q.busy).toBe(true)
    resolvers.shift()!()
    await Promise.resolve(); await Promise.resolve()
    expect(sent).toEqual([['a'], ['a', 'b', 'c']])
    expect(settled).toEqual([])
    resolvers.shift()!()
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toEqual([{ ok: true, value: ['a', 'b', 'c'] }])
    expect(q.busy).toBe(false)
  })
  it('reports the failure of the last write', async () => {
    const settled: Array<{ ok: boolean }> = []
    const q = new LatestWriteQueue<number>(() => Promise.reject(new Error('down')), (r) => settled.push(r))
    q.push(1)
    await new Promise((r) => setTimeout(r, 0))
    expect(settled).toHaveLength(1)
    expect(settled[0].ok).toBe(false)
  })
})

describe('plugin row wording', () => {
  it('humanizes config field names', () => {
    expect(humanizeField('base_url')).toBe('base URL')
    expect(humanizeField('clientId')).toBe('client ID')
    expect(humanizeField('API_KEY')).toBe('API key')
    expect(needsSetupHelp(['base_url'])).toBe('Needs setup: base URL.')
    expect(needsSetupHelp(['base_url', 'api_key', 'imap_host'])).toBe('Needs setup: base URL, API key and IMAP host.')
  })
  it('takes the first sentence in settings punctuation', () => {
    expect(firstSentence('Syncs tasks. Also does more.')).toBe('Syncs tasks.')
    expect(firstSentence('Up to date \u00b7 2 ahead')).toBe('Up to date, 2 ahead')
    expect(firstSentence(undefined)).toBe('')
  })
  it('tags: no On tag, Failed for quarantine, Needs setup for missing config', () => {
    expect(rowTags({ status: 'active' })).toEqual([])
    expect(rowTags({ status: 'quarantined' })).toEqual([{ text: 'Failed', tone: 'warning' }])
    expect(rowTags({ status: 'needs-config' })).toEqual([{ text: 'Needs setup', tone: 'warning' }])
    expect(rowTags({ status: 'active', restartPending: true })).toEqual([{ text: 'Restart to activate', tone: 'warning' }])
  })
  it('origin sentence for the row title', () => {
    expect(originSentence('Built in', ['Task sync'])).toBe('Built in. Adds task sync.')
    expect(originSentence('npm \u00b7 @acme/plugin')).toBe('npm, @acme/plugin.')
  })
})

// Separator characters are written as \\u escapes: they are the test data here.
describe('update copy on screen', () => {
  it('plainText drops the compact separators', () => {
    expect(plainText('3 behind \u00b7 Local changes')).toBe('3 behind, Local changes')
    expect(plainText('Checking\u2026')).toBe('Checking...')
    expect(plainText('Open Settings \u2192 Plugins there')).toBe('Open Settings: Plugins there')
    expect(plainText('a \u2014 b')).toBe('a, b')
  })
  it('a dirty checkout says local changes would be overwritten', () => {
    expect(updateDisabledTitle(REASON_DIRTY)).toBe('Local changes would be overwritten.')
  })
})
