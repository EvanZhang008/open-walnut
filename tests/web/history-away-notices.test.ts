/**
 * A host session's history on a host replica while the Mac is away
 * (docs/plan/walnut-replica-servers-impl.md, WP7 review fix W7): the "Needs your
 * Mac" answer shows as its own words (no "Failed to load history:" in front),
 * an older page the Mac alone can build says so, and the older-messages hint
 * counts from the answer's cursor, so "Load earlier turns" is offered only for
 * what the copy can serve. Pure parts of SessionChatHistory / useSessionHistory.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { historyErrorText, olderUnavailableText } from '../../web/src/components/sessions/history-notice-text'
import { sourceCountOf } from '../../web/src/hooks/history-merge'
import { leaderErrorMessage } from '../../web/src/api/leader-presence'

describe('the history notices', () => {
  it('a "Needs your Mac" answer is shown as it is; any other error keeps the prefix', () => {
    const words = leaderErrorMessage({ error: { code: 'needs_leader', why: 'session_on_mac' } })!
    expect(historyErrorText(words)).toBe('Needs your Mac. This session runs through your Mac; its conversation is there.')
    expect(historyErrorText(new Error('HTTP 502'))).toBe('Failed to load history: Error: HTTP 502')
    expect(historyErrorText('Session not found')).toBe('Failed to load history: Session not found')
  })

  it('older pages only the Mac can build say so; any other reason keeps the size note', () => {
    expect(olderUnavailableText('history_pages_need_mac')).toBe('Older messages load when your Mac is back.')
    expect(olderUnavailableText('fork')).toBe('Earlier messages of this session are too large to load here.')
    expect(olderUnavailableText(null)).toBe('Earlier messages of this session are too large to load here.')
    expect(olderUnavailableText(undefined)).toBe('Earlier messages of this session are too large to load here.')
  })
})

describe('the older-messages hint counts from the answer\'s cursor', () => {
  it('a host copy\'s answer: its cursor wins over total, so nothing older is promised', () => {
    // 3 rows on screen; the copy's parse has 40, but it can serve only what it answered.
    expect(sourceCountOf({ cursor: 3, total: 40 })).toBe(3)
  })
  it('the Mac\'s streams read carries only total: unchanged', () => {
    expect(sourceCountOf({ total: 40 })).toBe(40)
    expect(sourceCountOf({})).toBeUndefined()
    expect(sourceCountOf({ cursor: 0, total: 12 })).toBe(0)
  })
  it('Phase 1 of useSessionHistory seeds the hint through it (never from total alone)', () => {
    const src = readFileSync(new URL('../../web/src/hooks/useSessionHistory.ts', import.meta.url), 'utf8')
    expect(src).toContain('const sourceCount = sourceCountOf(result);')
    expect(src).not.toMatch(/result\.total\s*>\s*result\.messages\.length/)
  })
})
