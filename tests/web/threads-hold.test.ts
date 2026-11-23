/**
 * A Threads list holds still while he reads it (web/src/components/org/useThreadsHold.ts; 2026-11-23,
 * the user: "keep this location from changing, or it keeps flashing"). The pure order step, and a
 * guard that every list OrgThreads draws goes through the hold (a list added beside them would move
 * under his pointer again). The browser half: tests/e2e/browser/threads-hold-still.spec.ts.
 */
import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import { inHeldOrder, THREAD_CARD_ROWS } from '../../web/src/components/org/useThreadsHold'
import type { OrgThread } from '../../web/src/api/org-threads'

const t = (id: string) => ({ id }) as OrgThread

describe('the held order of a Threads list', () => {
  it('keeps the held places, puts a newcomer after them in its own order, and drops one that left', () => {
    const at = new Map([['a', 0], ['b', 1], ['c', 2]])
    expect(inHeldOrder([t('c'), t('x'), t('a'), t('y'), t('b')], at).map((x) => x.id)).toEqual(['a', 'b', 'c', 'x', 'y'])
    expect(inHeldOrder([t('c'), t('a')], at).map((x) => x.id)).toEqual(['a', 'c'])
    // No hold: the list as it came (the map is its own order).
    const own = new Map([['c', 0], ['a', 1]])
    expect(inHeldOrder([t('c'), t('a')], own).map((x) => x.id)).toEqual(['c', 'a'])
  })

  it('anchors on the cards themselves', () => {
    expect(THREAD_CARD_ROWS).toBe('[data-testid="org-thread"]')
  })

  it('every list OrgThreads draws of open threads goes through the hold', () => {
    const src = fs.readFileSync(`${process.cwd()}/web/src/components/org/OrgThreads.tsx`, 'utf8')
    expect(src).toContain('const hold = useThreadsHold(rootRef, open, groups)')
    expect(src).toContain('onPointerEnter={hold.onPointerEnter} onPointerLeave={hold.onPointerLeave}')
    expect(src).toMatch(/groups=\{hold\.groups\}/)
    expect(src).toMatch(/\{hold\.open\.map\(/)
    // The open list and the groups are never drawn from the unheld arrays.
    expect(src).not.toMatch(/\{open\.map\(\(t\) => card\(t\)\)\}/)
    expect(src).not.toMatch(/groups=\{groups\}/)
  })

  it('the boxes that scroll a Threads list leave Chromium\'s own anchoring off (one keeper in both engines)', () => {
    const css = fs.readFileSync(`${process.cwd()}/web/src/styles/org-threads.css`, 'utf8')
    expect(css).toContain('.org-rail-body:has(> .org-threads), .session-threads-body:has(> .org-threads) { overflow-anchor: none; }')
  })
})
