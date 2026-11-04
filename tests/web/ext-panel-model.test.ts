/**
 * The side panel's exchange with the extension page that frames it (web/src/popout/ext-panel-model.ts):
 * only the framing extension page is heard, a page is only a web page, one conversation per page
 * address, and what the ask is told about the page.
 */
import { describe, expect, it } from 'vitest'
import { ACT_CONTEXT_NAME, actLine, conversationKey, handedOf, otherOwnerOf, pageContextBlock, pageKey, readInbound, rememberHanded, selectionQuote } from '../../web/src/popout/ext-panel-model'

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

  it('a later selection leads the next message; a later hand-over is a Walnut hint, never the person\'s words', () => {
    expect(selectionQuote('a\nb')).toBe('> a\n> b\n\n')
    expect(actLine(3)).toMatch(/^They let you act in this tab: tab 3 /)
    expect(ACT_CONTEXT_NAME).toBe('Browser tab you may act in')
  })
})

describe('a tab handed to a conversation stays with it', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

  it('the panel shows the conversation the tab was handed to, wherever the tab went since', () => {
    const s = mem()
    const first = pageKey('https://mail.example.test/mail/u/0/')
    rememberHanded(7, first, 't1', s)
    const h = handedOf(7, s)
    expect(h).toMatchObject({ key: first, taskId: 't1' })
    // The mail app moved to a message: same tab, same conversation, while t1 still acts there.
    expect(conversationKey('https://mail.example.test/mail/u/0/?view=msg', 7, 'task:t1', h)).toBe(first)
    // Taken back, or another task holds it: the page's own conversation.
    expect(conversationKey('https://mail.example.test/mail/u/0/?view=msg', 7, undefined, h)).toBe(pageKey('https://mail.example.test/mail/u/0/?view=msg'))
    expect(conversationKey('https://mail.example.test/x', 7, 'task:t2', h)).toBe(pageKey('https://mail.example.test/x'))
    expect(handedOf(8, s)).toBeNull()
    expect(handedOf(undefined, s)).toBeNull()
  })

  it('keeps the newest tabs only', () => {
    const s = mem()
    for (let i = 0; i < 60; i++) rememberHanded(i, `k${i}`, `t${i}`, s, 1000 + i)
    expect(handedOf(0, s)).toBeNull()
    expect(handedOf(59, s)).toMatchObject({ taskId: 't59' })
  })

  it('"another conversation acts here" only for one that is not this one', () => {
    const h = { key: 'k', taskId: 't1', at: 1 }
    expect(otherOwnerOf(undefined, '', h)).toBe(false)
    expect(otherOwnerOf('task:t1', 'task:t1', h)).toBe(false)
    // This conversation is still loading: the owner it was handed to is this one.
    expect(otherOwnerOf('task:t1', '', h)).toBe(false)
    expect(otherOwnerOf('task:t1', '', null)).toBe(true)
    expect(otherOwnerOf('task:t9', '', h)).toBe(true)
    expect(otherOwnerOf('task:t1', 'task:t2', h)).toBe(true)
    // New chat with the tab: t2 asked for it and the hand-over is on the way.
    expect(otherOwnerOf('task:t1', 'task:t2', h, true)).toBe(false)
    expect(otherOwnerOf('task:t9', 'task:t2', h, true)).toBe(true)
  })
})

describe('the text a message took from the page', () => {
  it('is read back from the context it went with, and is nothing when it took none', async () => {
    const { selectionOfContext } = await import('../../web/src/popout/ext-panel-model')
    const page = { url: 'https://docs.example.test/a', title: 'A', selection: 'First line\n\nSecond line' }
    expect(selectionOfContext(pageContextBlock(page, { file: '/tmp/p.md', tab: 4 }))).toBe('First line\n\nSecond line')
    expect(selectionOfContext(`Web page you are asking about:\n${pageContextBlock(page, {})}`)).toBe('First line\n\nSecond line')
    expect(selectionOfContext(pageContextBlock({ url: page.url, title: 'A' }, { file: '/tmp/p.md' }))).toBe('')
    expect(selectionOfContext(actLine(4))).toBe('')
    expect(selectionOfContext(undefined)).toBe('')
  })
})

describe('hints a surface decides when the message goes', () => {
  it('are asked once per send, under the waiting ones and the send\'s own; a failing source adds nothing', async () => {
    const ph = await import('../../web/src/utils/pending-hints')
    let asked = 0
    ph.setPendingHintsSource('s1', async () => { asked++; return { 'object-context': { arg: 'hc-src' }, other: { arg: 'x' } } })
    ph.setPendingHints('s1', { other: { arg: 'waiting' } })
    expect(ph.hasPendingHintsSource('s1')).toBe(true)
    expect(await ph.takePendingHintsAsync('s1', { question: { arg: 'Q1' } })).toEqual({ 'object-context': { arg: 'hc-src' }, other: { arg: 'waiting' }, question: { arg: 'Q1' } })
    expect(asked).toBe(1)
    let words = ''
    ph.setPendingHintsSource('s2', async (m) => { words = m; return undefined })
    expect(await ph.takePendingHintsAsync('s2', undefined, 'What does this mean?')).toBeUndefined()
    expect(words).toBe('What does this mean?')
    ph.setPendingHintsSource('s2', null)
    expect(await ph.takePendingHintsAsync('s1')).toEqual({ 'object-context': { arg: 'hc-src' }, other: { arg: 'x' } })
    ph.setPendingHintsSource('s1', async () => { throw new Error('offline') })
    expect(await ph.takePendingHintsAsync('s1', { question: { arg: 'Q2' } })).toEqual({ question: { arg: 'Q2' } })
    ph.setPendingHintsSource('s1', null)
    expect(ph.hasPendingHintsSource('s1')).toBe(false)
  })
})

describe('the selection a conversation already took', () => {
  it('is remembered per conversation, the newest few only, and an unreadable store forgets it', async () => {
    const { rememberSent, sentOf } = await import('../../web/src/popout/ext-panel-model')
    const m = new Map<string, string>()
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
    rememberSent('web:https://a.example.test/x', 'Selected words', s, 1)
    expect(sentOf('web:https://a.example.test/x', s)).toBe('Selected words')
    expect(sentOf('web:https://a.example.test/other', s)).toBe('')
    for (let i = 0; i < 45; i++) rememberSent(`web:k${i}`, `s${i}`, s, 10 + i)
    expect(sentOf('web:https://a.example.test/x', s)).toBe('')
    expect(sentOf('web:k44', s)).toBe('s44')
    m.set('walnut.ext-panel.sent', '{not json')
    expect(sentOf('web:k44', s)).toBe('')
    rememberSent('web:k1', 'again', s, 99)
    expect(sentOf('web:k1', s)).toBe('again')
  })
})
