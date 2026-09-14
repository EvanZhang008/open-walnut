import { describe, expect, it } from 'vitest'
import { timeAgo } from '../../../web/src/utils/time'

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('timeAgo default (short) format is unchanged', () => {
  it('keeps the site-wide short strings byte for byte', () => {
    expect(timeAgo(ago(10_000), { now: NOW })).toBe('just now')
    expect(timeAgo(ago(3 * MIN), { now: NOW })).toBe('3m ago')
    expect(timeAgo(ago(2 * HOUR), { now: NOW })).toBe('2h ago')
    expect(timeAgo(ago(1 * DAY), { now: NOW })).toBe('1d ago')
    expect(timeAgo(ago(3 * DAY), { now: NOW })).toBe('3d ago')
    expect(timeAgo(ago(14 * DAY), { now: NOW })).toBe('2w ago')
    expect(timeAgo(ago(60 * DAY), { now: NOW })).toBe('2mo ago')
    expect(timeAgo(ago(400 * DAY), { now: NOW })).toBe('1y ago')
  })

  it('returns an empty string for garbage and just now for the future', () => {
    expect(timeAgo('not a date')).toBe('')
    expect(timeAgo(new Date(NOW + 5000).toISOString(), { now: NOW })).toBe('just now')
  })

  it('reads the real clock when no reference is given', () => {
    expect(timeAgo(new Date(Date.now() - 5 * MIN).toISOString())).toBe('5m ago')
  })
})

describe('timeAgo long format (Plugins header and chip tooltips)', () => {
  const long = (ms: number) => timeAgo(ago(ms), { long: true, now: NOW })

  it('just now under a minute, same threshold as short', () => {
    expect(long(0)).toBe('just now')
    expect(long(59_000)).toBe('just now')
  })

  it('N min ago under an hour', () => {
    expect(long(1 * MIN)).toBe('1 min ago')
    expect(long(3 * MIN)).toBe('3 min ago')
    expect(long(42 * MIN)).toBe('42 min ago')
    expect(long(59 * MIN + 59_000)).toBe('59 min ago')
  })

  it('N h ago under a day', () => {
    expect(long(1 * HOUR)).toBe('1 h ago')
    expect(long(2 * HOUR)).toBe('2 h ago')
    expect(long(23 * HOUR + 59 * MIN)).toBe('23 h ago')
  })

  it('yesterday between 24 and 48 hours', () => {
    expect(long(24 * HOUR)).toBe('yesterday')
    expect(long(47 * HOUR + 59 * MIN)).toBe('yesterday')
  })

  it('N days ago under a week, then falls back to the short week and month rules', () => {
    expect(long(48 * HOUR)).toBe('2 days ago')
    expect(long(3 * DAY)).toBe('3 days ago')
    expect(long(6 * DAY + 23 * HOUR)).toBe('6 days ago')
    expect(long(7 * DAY)).toBe('1w ago')
    expect(long(45 * DAY)).toBe('1mo ago')
  })
})
