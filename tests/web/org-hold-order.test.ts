/**
 * The Org list's hold (web/src/components/org/hold-order.ts): while the pointer is over the
 * list, rows keep the order they had when it came in; a row that arrived since goes last.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { holdOrder, settleHold } from '../../web/src/components/org/hold-order.js'

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

// A list drawn under a resting pointer (a reload while its rows load) gets its pointerenter with
// no rows yet. That hold held nothing, so every row moved live under the pointer: on 2026-11-03
// a project that came in took the top of the Org list and Down picked it (CI, org-page.spec.ts).
describe('settleHold', () => {
  it('takes the rows as the hold when the hold came before them', () => {
    expect(settleHold([], ['b', 'a'])).toEqual(['b', 'a'])
    expect(keysOf(holdOrder(rows('new', 'b', 'a'), settleHold(['b', 'a'], ['new', 'b', 'a'])))).toEqual(['b', 'a', 'new'])
  })

  it('leaves no hold, a hold with rows, and an empty list as they are', () => {
    expect(settleHold(null, ['a'])).toBe(null)
    const held = ['a']
    expect(settleHold(held, ['b', 'a'])).toBe(held)
    const empty: string[] = []
    expect(settleHold(empty, [])).toBe(empty)
  })
})

// Every list that holds its order under the pointer goes through usePointerHold, so a new one
// cannot take the hold at pointerenter alone and miss rows that arrive after it.
describe('pointer holds', () => {
  it('no component keeps its own pointer hold over holdOrder', () => {
    const root = path.resolve(__dirname, '../../web/src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !p.endsWith(path.join('org', 'hold-order.ts'))) {
          const src = fs.readFileSync(p, 'utf-8')
          if (/from '[^']*\/hold-order'/.test(src) && /\bholdOrder\b/.test(src)) offenders.push(path.relative(root, p))
        }
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
