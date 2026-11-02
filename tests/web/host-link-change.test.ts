/**
 * A surface that polls its own snapshot of hosts reads it again when a host connects or
 * drops (web/src/hooks/useHostLinkChange.ts). 2026-11-02: a machine that had just connected
 * read "Not connected" on the fleet overview for up to 30 s.
 */
import { describe, expect, it } from 'vitest'
import { linkMoved } from '../../web/src/hooks/useHostLinkChange.js'

const m = (o: Record<string, '0' | '1'>) => new Map(Object.entries(o))

describe('a host link change', () => {
  it('is a host that connects or drops', () => {
    expect(linkMoved(m({ a: '0' }), m({ a: '1' }), false)).toBe(true)
    expect(linkMoved(m({ a: '1' }), m({ a: '0' }), false)).toBe(true)
    expect(linkMoved(m({ a: '1', b: '0' }), m({ a: '1', b: '0' }), true)).toBe(false)
  })

  it('counts a new host for the whole fleet, and one already connected for a list of its own', () => {
    expect(linkMoved(m({ a: '1' }), m({ a: '1', b: '0' }), true)).toBe(true)
    expect(linkMoved(m({}), m({ b: '0' }), false)).toBe(false)
    expect(linkMoved(m({}), m({ b: '1' }), false)).toBe(true)
  })

  it('a host that left is no change of its own', () => {
    expect(linkMoved(m({ a: '1', b: '1' }), m({ a: '1' }), true)).toBe(false)
  })
})
