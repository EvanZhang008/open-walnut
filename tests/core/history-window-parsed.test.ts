/**
 * Parsed older-history windows are kept by the bytes they came from (history-window-parsed.ts).
 * 2026-11-24: one caller paged one 60 MB session back 635 times in an hour, each page parsing up
 * to four 4 MB windows again.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetParsedWindowsForTests, keepParsedWindow, keptParsedWindow, parsedWindowKey } from '../../src/core/history-window-parsed.js'
import type { SessionHistoryMessage } from '../../src/core/session-history.js'

const msg = (text: string): SessionHistoryMessage => ({ role: 'user', text, timestamp: '2026-11-23T08:00:00Z' } as SessionHistoryMessage)
const FILE = '__local__\u0000/home/acme/.claude/projects/x/s.jsonl\u0000ino-7:1700000000'

beforeEach(() => _resetParsedWindowsForTests())

describe('kept parsed windows', () => {
  it('a window parsed once is handed back as a new array of the same rows', () => {
    const key = parsedWindowKey(FILE, 0, 4 << 20, [])
    const rows = [msg('Acme kickoff'), msg('Next step')]
    keepParsedWindow(key, rows, 1000)
    const a = keptParsedWindow(key)!
    const b = keptParsedWindow(key)!
    expect(a).toEqual(rows)
    expect(a).not.toBe(b)
    expect(a[0]).toBe(rows[0])
    a.push(msg('caller added this'))
    expect(keptParsedWindow(key)).toHaveLength(2)
  })

  it('another range, another incarnation of the file or other injected lines is another window', () => {
    const base = parsedWindowKey(FILE, 0, 4 << 20, [])
    keepParsedWindow(base, [msg('Acme kickoff')], 1000)
    expect(keptParsedWindow(parsedWindowKey(FILE, 4 << 20, 8 << 20, []))).toBeUndefined()
    expect(keptParsedWindow(parsedWindowKey(FILE.replace('ino-7', 'ino-8'), 0, 4 << 20, []))).toBeUndefined()
    expect(keptParsedWindow(parsedWindowKey(FILE, 0, 4 << 20, ['{"type":"user","subtype":"walnut-injected"}']))).toBeUndefined()
    expect(keptParsedWindow(base)).toHaveLength(1)
  })

  it('keeps at most its budget of source text, the oldest out first', () => {
    const big = 10 * 1024 * 1024
    const keys = [0, 1, 2].map((n) => parsedWindowKey(FILE, n * big, (n + 1) * big, []))
    keys.forEach((k, n) => keepParsedWindow(k, [msg(`window ${n}`)], big))
    expect(keptParsedWindow(keys[0]!)).toBeUndefined()
    expect(keptParsedWindow(keys[1]!)).toHaveLength(1)
    expect(keptParsedWindow(keys[2]!)).toHaveLength(1)
    // One window past the whole budget is never kept.
    const huge = parsedWindowKey(FILE, 0, 1, [])
    keepParsedWindow(huge, [msg('too big')], 64 * 1024 * 1024)
    expect(keptParsedWindow(huge)).toBeUndefined()
  })
})
