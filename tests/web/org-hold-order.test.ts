/**
 * The Org list's hold (web/src/components/org/hold-order.ts): while the pointer is over the
 * list, rows keep the order they had when it came in; a row that arrived since goes last.
 */
import { describe, it, expect } from 'vitest'
import { holdOrder } from '../../web/src/components/org/hold-order.js'

const rows = (...keys: string[]) => keys.map((key) => ({ key }))
const keysOf = (list: readonly { key: string }[]) => list.map((r) => r.key)

describe('holdOrder', () => {
  it('passes the rows through when nothing is held', () => {
    const live = rows('b', 'a')
    expect(holdOrder(live, null)).toBe(live)
  })

  it('keeps the held order when the live order changes', () => {
    expect(keysOf(holdOrder(rows('c', 'a', 'b'), ['a', 'b', 'c']))).toEqual(['a', 'b', 'c'])
  })

  it('puts a row that arrived since last, and drops one that left', () => {
    expect(keysOf(holdOrder(rows('d', 'b', 'a'), ['a', 'b', 'c']))).toEqual(['a', 'b', 'd'])
  })

  it('keeps the live order among several new rows', () => {
    expect(keysOf(holdOrder(rows('y', 'a', 'x'), ['a']))).toEqual(['a', 'y', 'x'])
  })
})
