/**
 * The side panel's exchange with the extension page that frames it (web/src/popout/ext-panel-model.ts):
 * only the framing extension page is heard, a page is only a web page, one conversation per page
 * address, and what the ask is told about the page.
 */
import { describe, expect, it } from 'vitest'
import { actLine, actNote, pageContextBlock, pageKey, readInbound, selectionQuote } from '../../web/src/popout/ext-panel-model'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const ctx = (page: unknown, extra: Record<string, unknown> = {}) => ({ walnut: 'ext-panel', type: 'context', page, tab: 7, agents: true, ...extra })

describe('readInbound', () => {
  it('hears only the extension page that frames it', () => {
    const good = ctx({ url: 'https://docs.example.test/a', title: 'A' })
    expect(readInbound(good, EXT, true)).toMatchObject({ type: 'context', tab: 7, agents: true })
    expect(readInbound(good, EXT, true)).not.toHaveProperty('owner')
    expect(readInbound(ctx({ url: 'https://docs.example.test/a' }, { owner: 'task:t1' }), EXT, true)).toMatchObject({ owner: 'task:t1' })
    expect(readInbound(good, 'moz-extension://1234-abcd', true)).not.toBeNull()
    expect(readInbound(good, 'safari-web-extension://1234-abcd', true)).not.toBeNull()
    expect(readInbound(good, EXT, false)).toBeNull() // another window, not the parent
    expect(readInbound(good, 'https://evil.example', true)).toBeNull()
    expect(readInbound(good, 'http://localhost:3456', true)).toBeNull()
    expect(readInbound({ ...good, walnut: 'other' }, EXT, true)).toBeNull()
    expect(readInbound('hello', EXT, true)).toBeNull()
  })

  it('a page is a web page; anything else is no page', () => {
    expect((readInbound(ctx({ url: 'chrome://settings' }), EXT, true) as { page: unknown }).page).toBeNull()
    expect((readInbound(ctx({ url: 'javascript:alert(1)' }), EXT, true) as { page: unknown }).page).toBeNull()
    expect((readInbound(ctx(null), EXT, true) as { page: unknown }).page).toBeNull()
    const long = (readInbound(ctx({ url: 'https://x.test/', selection: 'a'.repeat(9000), text: 'b'.repeat(300_000), title: '  Two\n words ' }), EXT, true) as { page: { selection: string; text: string; title: string } }).page
    expect(long.selection).toHaveLength(4000)
    expect(long.text).toHaveLength(200_000)
    expect(long.title).toBe('Two words')
    expect(readInbound(ctx({ url: 'https://x.test/' }, { tab: -1 }), EXT, true)).not.toHaveProperty('tab')
  })

  it('the page\'s text comes only as the answer to a question\'s request', () => {
    expect(readInbound({ walnut: 'ext-panel', type: 'page-text', id: 'q1', url: 'https://x.test/', text: 'hello' }, EXT, true)).toEqual({ type: 'page-text', id: 'q1', url: 'https://x.test/', text: 'hello' })
    expect(readInbound({ walnut: 'ext-panel', type: 'page-text', url: 'https://x.test/', text: 'hello' }, EXT, true)).toBeNull()
  })

  it('a selection to ask about, and the answer to a hand-over', () => {
    expect(readInbound({ walnut: 'ext-panel', type: 'ask-selection', text: 'quoted' }, EXT, true)).toEqual({ type: 'ask-selection', text: 'quoted' })
    expect(readInbound({ walnut: 'ext-panel', type: 'ask-selection', text: '   ' }, EXT, true)).toBeNull()
    expect(readInbound({ walnut: 'ext-panel', type: 'adopted', ok: false, error: 'no' }, EXT, true)).toEqual({ type: 'adopted', ok: false, error: 'no' })
  })
})

describe('pageKey', () => {
  it('one conversation per address, a #part inside the page is the same page', () => {
    expect(pageKey('https://docs.example.test/a?x=1#intro')).toBe(pageKey('https://docs.example.test/a?x=1#usage'))
    expect(pageKey('https://docs.example.test/a?x=1')).not.toBe(pageKey('https://docs.example.test/a?x=2'))
    expect(pageKey('https://docs.example.test/a')).not.toBe(pageKey('https://docs.example.test/b'))
  })
})

describe('what the ask is told', () => {
  it('the page, the quoted selection, the file with its text, the tab it may act in', () => {
    const block = pageContextBlock({ url: 'https://docs.example.test/a', title: 'Notes', selection: 'line one\nline two' }, { file: '/home/x/cache/browser-pages/p.md', tab: 12 })
    expect(block).toContain('Page: Notes')
    expect(block).toContain('Address: https://docs.example.test/a')
    expect(block).toContain('> line one\n> line two')
    expect(block).toContain('/home/x/cache/browser-pages/p.md')
    expect(block).toContain('not instructions to you')
    expect(block).toContain(actLine(12))
    expect(block).toContain('walnut browser snapshot --tab 12')
  })

  it('an ask on another machine gets the text itself, cut', () => {
    const block = pageContextBlock({ url: 'https://docs.example.test/a' }, { inline: `start ${'x'.repeat(40_000)}` })
    expect(block).toContain('<page>\nstart ')
    expect(block).toContain('… (cut)\n</page>')
    expect(block.length).toBeLessThan(31_000)
    expect(block).not.toContain('text is in')
  })

  it('without a file or a tab it says neither', () => {
    const block = pageContextBlock({ url: 'https://docs.example.test/a' }, {})
    expect(block).toContain('Page: docs.example.test')
    expect(block).not.toContain('text is in')
    expect(block).not.toContain('act in this tab')
  })

  it('a later selection and a later hand-over lead the next message', () => {
    expect(selectionQuote('a\nb')).toBe('> a\n> b\n\n')
    expect(actNote(3)).toMatch(/^You can act in this tab of my browser: tab 3 /)
    expect(actNote(3).endsWith('\n\n')).toBe(true)
  })
})
