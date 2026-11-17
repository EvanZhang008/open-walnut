/**
 * Each Org node keeps its free (unlocked) panel (2026-11-17, the user: "I have this task open, but I
 * did not lock it. Then I switch to other chat, and come back, it should be there"). The rule:
 * web/src/components/org/org-side-columns.ts readNodeOpen / writeNodeOpen; the browser walk:
 * tests/e2e/browser/org-free-panel-kept.spec.ts.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readNodeOpen, writeNodeOpen } from '../../web/src/components/org/org-side-columns.js'

const g = globalThis as unknown as { localStorage?: unknown }
let before: unknown
const store = new Map<string, string>()
beforeEach(() => {
  before = g.localStorage
  store.clear()
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
})
afterEach(() => { g.localStorage = before })

describe('a node\'s free panel', () => {
  it('is kept per node: one node\'s open, close or replace leaves every other node\'s as it was', () => {
    writeNodeOpen('project:a', 'task:a2')
    writeNodeOpen('project:b', 'task:b1')
    expect(readNodeOpen('project:a')).toBe('task:a2')
    expect(readNodeOpen('project:b')).toBe('task:b1')
    writeNodeOpen('project:b', 'task:b2')
    expect(readNodeOpen('project:a')).toBe('task:a2')
    writeNodeOpen('project:a', null)
    expect(readNodeOpen('project:a')).toBeNull()
    expect(readNodeOpen('project:b')).toBe('task:b2')
    // A node that never had one writes nothing for "none".
    const kept = new Map(store)
    writeNodeOpen('project:c', null)
    expect(store).toEqual(kept)
  })
})

describe('OrgPage', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/pages/OrgPage.tsx'), 'utf8')
  // The class: a way of changing the node that drops the free panel instead of bringing the node's
  // own back. Every URL write that names a node takes that node's free panel with it.
  it('every URL write that picks a node brings that node\'s free panel back', () => {
    const picks = [...src.matchAll(/next\.set\('node',[\s\S]*?return next;/g)].map((m) => m[0])
    expect(picks.length).toBeGreaterThan(0)
    for (const p of picks) expect(p, 'a node picked without its kept free panel (readNodeOpen)').toMatch(/readNodeOpen\(/)
  })
  it('the free panel is let go only where the user closes it', () => {
    const drops = [...src.matchAll(/next\.delete\('open'\)/g)].length
    const close = src.match(/const closeSide = useCallback\(\(\) => \{[\s\S]*?\n {2}\}, /)?.[0] ?? ''
    expect(close).toMatch(/writeNodeOpen\(shownKey\.current, null\)/)
    // closeSide's own delete and select's fallback for a node with none kept.
    expect(drops).toBe(2)
  })
})
