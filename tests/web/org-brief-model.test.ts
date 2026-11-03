/**
 * The Brief's pure helpers (web/src/components/org/org-brief-model.ts): each task pill in the
 * letter wears its task's live status, each section heading its section, and the dot on the Brief
 * tab marks a rewrite the user has not read here yet.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeEach } from 'vitest'
import { applyBriefDecorations, briefUnread, markBriefSeen, readBriefFolded, writeBriefFolded } from '../../web/src/components/org/org-brief-model'
import { BRIEF_SECTIONS } from '../../src/core/user-status'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
})

describe('applyBriefDecorations', () => {
  // A stand-in for the rendered letter's pills: the attributes, and every write counted.
  const pill = (id: string, attrs: Record<string, string> = {}) => {
    const a = new Map(Object.entries({ 'data-task-id': id, ...attrs }))
    return {
      writes: 0,
      getAttribute(n: string) { return a.get(n) ?? null },
      setAttribute(n: string, v: string) { a.set(n, v); this.writes++ },
      removeAttribute(n: string) { a.delete(n); this.writes++ },
    }
  }
  const root = (pills: ReturnType<typeof pill>[]) => ({ querySelectorAll: (sel: string) => (sel === 'a[data-task-id]' ? pills : []) })

  it('moves only the attribute of the pill whose task changed, and nothing when none did', () => {
    const t1 = pill('t1'); const t2 = pill('t2')
    const letter = root([t1, t2])
    expect(applyBriefDecorations(letter, new Map([['t1', 'working'], ['t2', 'needs']]))).toBe(2)
    expect(t1.getAttribute('data-user-state')).toBe('working')
    // The same statuses again (a re-render for another task's change): no write at all.
    expect(applyBriefDecorations(letter, new Map([['t1', 'working'], ['t2', 'needs']]))).toBe(0)
    // One task moves: one write, on its pill.
    const before = t2.writes
    expect(applyBriefDecorations(letter, new Map([['t1', 'needs'], ['t2', 'needs']]))).toBe(1)
    expect(t1.getAttribute('data-user-state')).toBe('needs')
    expect(t2.writes).toBe(before)
  })

  it('a To read pill keeps its state (its dot is the Needs you one, org-brief.css); "To read" is no section heading', () => {
    const t1 = pill('t1')
    const head = { ...pill(''), textContent: 'To read' }
    const letter = { querySelectorAll: (sel: string) => (sel === 'a[data-task-id]' ? [t1] : [head]) }
    applyBriefDecorations(letter, new Map([['t1', 'read']]))
    expect(t1.getAttribute('data-user-state')).toBe('read')
    expect(head.getAttribute('data-brief-section')).toBeNull()
    expect(BRIEF_SECTIONS.map((s) => s.heading)).toEqual(['Needs you', 'Working', 'Waiting / snoozed'])
    // The stylesheets draw a read pill in the Needs you colour, the same rule as needs.
    const css = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/styles/org-brief.css'), 'utf8')
    const globals = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'), 'utf8')
    expect(css).toMatch(/a\.task-link\[data-user-state='needs'\]::before,\s*\.org-brief-body a\.task-link\[data-user-state='read'\]::before/)
    expect(globals).toContain("a.task-link[data-user-state='read']::before { background: var(--error, #ff3b30); }")
    expect(css).not.toContain('#6d5bd0')
  })

  it('drops a status no longer known', () => {
    const t1 = pill('t1', { 'data-user-state': 'needs' })
    applyBriefDecorations(root([t1]), new Map())
    expect(t1.getAttribute('data-user-state')).toBeNull()
  })

  it('marks each of the three section headings with its section, and no other heading', () => {
    const heading = (text: string) => ({ ...pill(''), textContent: text })
    const heads = [...BRIEF_SECTIONS.map((s) => heading(s.heading)), heading('Notes')]
    const letter = { querySelectorAll: (sel: string) => (sel === 'a[data-task-id]' ? [] : heads) }
    applyBriefDecorations(letter, new Map())
    expect(heads.map((h) => h.getAttribute('data-brief-section'))).toEqual([...BRIEF_SECTIONS.map((s) => s.state), null])
  })
})

describe('the switch\'s memory', () => {
  it('keeps the fold', () => {
    expect(readBriefFolded()).toBe(false)
    writeBriefFolded(true)
    expect(readBriefFolded()).toBe(true)
  })

  it('marks a Brief unread until it is read, and again after a rewrite', () => {
    expect(briefUnread('lead', undefined)).toBe(false)
    expect(briefUnread('lead', '2026-10-26T10:00:00Z')).toBe(true)
    markBriefSeen('lead', '2026-10-26T10:00:00Z')
    expect(briefUnread('lead', '2026-10-26T10:00:00Z')).toBe(false)
    expect(briefUnread('lead', '2026-10-26T10:05:00Z')).toBe(true)
    expect(briefUnread('other', '2026-10-26T10:00:00Z')).toBe(true)
  })
})
