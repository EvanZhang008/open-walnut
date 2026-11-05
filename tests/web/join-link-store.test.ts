/**
 * Join with a link (web/src/components/settings/sections/join-link-store.ts): the link that still
 * waits is kept for the browser session, by its id and end only (never the link itself), so it
 * outlives the pane; one that ended is dropped.
 */
import { describe, expect, it } from 'vitest'
import { JOIN_LINK_KEY, keepJoinLink, keptJoinLink } from '../../web/src/components/settings/sections/join-link-store'

function memory() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
}

describe('the waiting join link, kept across the pane', () => {
  it('keeps its id and end, never the link, and reads it back while it works', () => {
    const s = memory()
    keepJoinLink({ id: 'ni-7', expiresAt: 10_000, link: 'secret-code' } as { id: string; expiresAt: number }, s)
    expect(JSON.parse(s.m.get(JOIN_LINK_KEY)!)).toEqual({ id: 'ni-7', expiresAt: 10_000 })
    expect(keptJoinLink(9_000, s)).toEqual({ id: 'ni-7', expiresAt: 10_000 })
  })
  it('a link that ended is dropped; none kept reads none', () => {
    const s = memory()
    keepJoinLink({ id: 'ni-7', expiresAt: 10_000 }, s)
    expect(keptJoinLink(10_001, s)).toBeNull()
    expect(s.m.has(JOIN_LINK_KEY)).toBe(false)
    expect(keptJoinLink(0, s)).toBeNull()
  })
  it('put away: none is kept; a broken entry reads none and is dropped', () => {
    const s = memory()
    keepJoinLink({ id: 'ni-7', expiresAt: 10_000 }, s)
    keepJoinLink(null, s)
    expect(s.m.has(JOIN_LINK_KEY)).toBe(false)
    s.setItem(JOIN_LINK_KEY, '{"id":3}')
    expect(keptJoinLink(0, s)).toBeNull()
    expect(s.m.has(JOIN_LINK_KEY)).toBe(false)
    s.setItem(JOIN_LINK_KEY, 'not json')
    expect(keptJoinLink(0, s)).toBeNull()
  })
})
