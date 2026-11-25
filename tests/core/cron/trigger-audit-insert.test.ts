/**
 * insertAuditByTime (src/core/cron/trigger-audit.ts): a check a host reports late goes into the
 * history in its place. A replay older than every row of a full history changes nothing and must
 * hand back the same list, or the caller writes the whole routines file for nothing (a daemon sends
 * its kept reports again after a restart or an unread send: trigger-unsent-checks.ts).
 */
import { describe, it, expect } from 'vitest'
import { insertAuditByTime } from '../../../src/core/cron/trigger-audit.js'

const row = (atMs: number, outcome = 'quiet') => ({ atMs, outcome } as Parameters<typeof insertAuditByTime>[1])

describe('insertAuditByTime', () => {
  it('puts a late row in its place, newest first', () => {
    expect(insertAuditByTime([row(30), row(10)], row(20), 12).map((e) => e.atMs)).toEqual([30, 20, 10])
  })

  it('a row of the same time and outcome is the same list', () => {
    const list = [row(30), row(10)]
    expect(insertAuditByTime(list, row(10), 12)).toBe(list)
  })

  it('older than every row of a full list: the same list, nothing to write', () => {
    const full = Array.from({ length: 12 }, (_, i) => row(1000 - i))
    expect(insertAuditByTime(full, row(5), 12)).toBe(full)
  })

  it('older than every row of a list with room: appended', () => {
    expect(insertAuditByTime([row(30)], row(5), 12).map((e) => e.atMs)).toEqual([30, 5])
  })
})
