/**
 * The notes import panel writes its times in Walnut's shape (web/src/utils/time.ts), which a plugin
 * cannot import: "today 9:40 PM", "Nov 20, 9:40 PM", the year only when it is not this year.
 */
import { describe, expect, it } from 'vitest'
import { dayWords, pointWords } from '../../../plugin-store/notes-import/src/web/words'

const local = (daysAgo: number, h: number, m: number) => {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h, m, 0, 0)
  return d.toISOString()
}

describe('notes import time words', () => {
  it('says near days in words and a clock without seconds', () => {
    expect(pointWords(local(0, 21, 40))).toBe('today 9:40 PM')
    expect(pointWords(local(1, 9, 5))).toBe('yesterday 9:05 AM')
    expect(dayWords(local(1, 9, 5))).toBe('yesterday')
  })

  it('writes an older day by its date, the year only when not this year', () => {
    const year = new Date().getFullYear()
    expect(pointWords(new Date(year - 1, 10, 20, 18, 0).toISOString())).toBe(`Nov 20, ${year - 1}, 6:00 PM`)
    expect(dayWords(new Date(year - 1, 0, 2).toISOString())).toBe(`Jan 2, ${year - 1}`)
  })

  it('reads nothing from an empty or broken time', () => {
    expect(pointWords(undefined)).toBe('')
    expect(pointWords('not a date')).toBe('')
    expect(dayWords('')).toBe('')
  })
})
