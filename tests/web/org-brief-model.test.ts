/**
 * The Brief's pure helpers (web/src/components/org/org-brief-model.ts): each task pill in the
 * letter wears its task's live status, and the dot on the Brief tab marks a rewrite the user has
 * not read here yet.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { briefUnread, decorateBriefHtml, markBriefSeen, readBriefFolded, readTopView, writeBriefFolded, writeTopView } from '../../web/src/components/org/org-brief-model'

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
