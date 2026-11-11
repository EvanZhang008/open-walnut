/**
 * The typing record's verdict on a write to the box (web/src/utils/typing-integrity.ts): code
 * that takes away typed text is an overwrite, an "@" or "/" query replaced by what was picked
 * from its menu is not (2026-11-11: the first real window counted two mention picks as lost).
 */
import { describe, it, expect } from 'vitest'
import { removedSpan } from '../../web/src/utils/typing-integrity'

describe('removedSpan', () => {
  it('a write that only adds takes nothing', () => {
    expect(removedSpan('hello', 'hello world')).toEqual({ taken: 0, pick: false })
    expect(removedSpan('fix /com', 'fix /commit ')).toEqual({ taken: 0, pick: false })
  })
  it('older text put back is an overwrite', () => {
    expect(removedSpan('hello world', 'hello')).toEqual({ taken: 6, pick: false })
    expect(removedSpan('abc def', 'abd def')).toEqual({ taken: 1, pick: false })
    // Text typed before the query, cut with it, is still lost text.
    expect(removedSpan('note: thanks @gia', 'note: @[Slack · Gia] ').pick).toBe(false)
  })
  it('a mention or slash pick replacing its query is not', () => {
    expect(removedSpan('hello @gia', 'hello @[Slack · Gia] ')).toMatchObject({ pick: true })
    expect(removedSpan('@gia more', '@[Slack · Gia] more')).toMatchObject({ pick: true })
    expect(removedSpan('line one\n/rev', 'line one\n/review ')).toEqual({ taken: 0, pick: false })
    expect(removedSpan('run /cmt now', 'run /commit now')).toMatchObject({ pick: true })
  })
})
