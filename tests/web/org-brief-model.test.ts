/**
 * The Brief's pure helpers (web/src/components/org/org-brief-model.ts): each task pill in the
 * letter wears its task's live status, and the dot on the Brief tab marks a rewrite the user has
 * not read here yet.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { applyBriefDecorations, briefUnread, decorateBriefHtml, markBriefSeen, readBriefFolded, readTopView, writeBriefFolded, writeTopView } from '../../web/src/components/org/org-brief-model'

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v) },
    removeItem: (k: string) => { store.delete(k) },
  }
})

describe('decorateBriefHtml', () => {
  it('stamps each known task pill with its status, and leaves the rest as rendered', () => {
    const html = '<p><a href="/tasks/t1" class="task-link" data-task-id="t1" title="x">Parser</a> and '
      + '<a href="/tasks/t2" class="task-link" data-task-id="t2">Review</a> and <a href="https://example.com">a link</a></p>'
    const out = decorateBriefHtml(html, new Map([['t1', 'needs']]))
    expect(out).toContain('<a href="/tasks/t1" class="task-link" data-user-state="needs" data-task-id="t1" title="x">Parser</a>')
    expect(out).toContain('<a href="/tasks/t2" class="task-link" data-task-id="t2">Review</a>')
    expect(out).toContain('<a href="https://example.com">a link</a>')
  })
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

  it('sets and clears the partial and unverified marks, and drops a status no longer known', () => {
    const t1 = pill('t1', { 'data-user-state': 'needs' })
    const letter = root([t1])
    applyBriefDecorations(letter, new Map([['t1', 'needs']]), new Set(['t1']), new Set(['t1']))
    expect(t1.getAttribute('data-partial')).toBe('1')
    expect(t1.getAttribute('data-unverified')).toBe('1')
    applyBriefDecorations(letter, new Map())
    expect(t1.getAttribute('data-user-state')).toBeNull()
    expect(t1.getAttribute('data-partial')).toBeNull()
    expect(t1.getAttribute('data-unverified')).toBeNull()
  })
})

describe('the switch\'s memory', () => {
  it('opens on Status until the user picks the Brief, and keeps the fold', () => {
    expect(readTopView()).toBe('status')
    writeTopView('brief')
    expect(readTopView()).toBe('brief')
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
