/**
 * Add host > Join with a link (web/src/components/settings/sections/join-link-model.ts): a link
 * that could not be made offers the fix its reason names (2026-11-04 review: "The host network is
 * not running on this Mac" offered only Try again, which failed the same way), and a closed link
 * that still works says how long.
 */
import { describe, expect, it } from 'vitest'
import { closedLinkNote, joinFix, minutesLeft } from '../../web/src/components/settings/sections/join-link-model'

describe('joinFix: one way forward per reason', () => {
  it('a host network that did not start offers to start it', () => {
    for (const code of ['net_unavailable', 'net_start_failed', 'no_identity']) expect(joinFix(code, false)).toBe('start')
  })
  it('one still starting, or a link walnut-net did not take, is Try again: it runs, so starting it again is no fix (review)', () => {
    expect(joinFix('net_starting', false)).toBe('retry')
    expect(joinFix('net_invite_failed', false)).toBe('retry')
  })
  it('a missing or old companion points at Phones & Cloud; a test server offers nothing', () => {
    expect(joinFix('no_companion', false)).toBe('pair')
    expect(joinFix('companion_too_old', false)).toBe('companion')
    expect(joinFix('test_server', false)).toBe('none')
  })
  it('too many links: show ours if one still waits, else try again later', () => {
    expect(joinFix('too_many_invites', true)).toBe('show-open')
    expect(joinFix('too_many_invites', false)).toBe('retry')
  })
  it('anything else, or an older server with no code, is Try again', () => {
    expect(joinFix('timeout', false)).toBe('retry')
    expect(joinFix(null, false)).toBe('retry')
    expect(joinFix('daemon_too_old', true)).toBe('retry')
  })
})

describe('closedLinkNote: a closed link that still works', () => {
  it('says the minutes left, rounded up, never 0', () => {
    const now = 1_000_000
    expect(closedLinkNote(now + 9 * 60_000, now)).toBe('Link still works for 9 min.')
    expect(closedLinkNote(now + 8 * 60_000 + 1, now)).toBe('Link still works for 9 min.')
    expect(minutesLeft(20_000)).toBe('1 min')
    expect(minutesLeft(-5)).toBe('1 min')
  })
})
