/**
 * The side panel and toolbar popup as Walnut's own Ask (D02): the frame's options from its address,
 * the new messages from the extension page (vault-state, key-state, hand), the composer's page chip,
 * the page a message went with read back from its context, Main's line, the ask rows' lines, and
 * the key popover's unlock line (packages/browser-extension/src/key-pop.ts).
 */
import { describe, expect, it } from 'vitest'
import { pageChipOn, pageOfContext, panelOptions, readInbound, rememberSentPage, sentPageOf, pageContextBlock } from '../../web/src/popout/ext-panel-model'
import { mainLineOf } from '../../web/src/popout/useExtAsks'
import { askRowDetail } from '../../web/src/popout/ext-tasks-model'
import { lastWordsOfStatus, turnToReadLine } from '../../src/core/user-status'
import { unlockLine } from '../../packages/browser-extension/src/key-pop'

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const msg = (type: string, extra: Record<string, unknown> = {}) => ({ walnut: 'ext-panel', type, ...extra })

describe('panelOptions', () => {
  it('the key and the drawer rows only for an extension that draws the popover (ext=2)', () => {
    expect(panelOptions('?view=ext-panel')).toEqual({ keyed: false, surface: 'panel' })
    expect(panelOptions('?view=ext-panel&ext=2')).toEqual({ keyed: true, surface: 'panel' })
    expect(panelOptions('?view=ext-panel&ext=3&surface=popup')).toEqual({ keyed: true, surface: 'popup' })
    // An old extension cannot have the popup shape: it never framed one.
    expect(panelOptions('?view=ext-panel&surface=popup')).toEqual({ keyed: false, surface: 'panel' })
  })
})

describe('readInbound: the new messages', () => {
  it('vault-state: locked unless it says otherwise, a count only when it is a whole number', () => {
    expect(readInbound(msg('vault-state', { locked: false, siteCount: 2, host: 'docs.example.test' }), EXT, true)).toEqual({ type: 'vault-state', locked: false, siteCount: 2, host: 'docs.example.test' })
    expect(readInbound(msg('vault-state', { siteCount: -1 }), EXT, true)).toEqual({ type: 'vault-state', locked: true, siteCount: null, host: '' })
    expect(readInbound(msg('vault-state', { locked: 'no', siteCount: 1.5 }), EXT, true)).toMatchObject({ locked: true, siteCount: null })
    expect(readInbound(msg('vault-state', { locked: false }), 'https://evil.example', true)).toBeNull()
  })

  it('key-state', () => {
    expect(readInbound(msg('key-state', { open: true }), EXT, true)).toEqual({ type: 'key-state', open: true })
    expect(readInbound(msg('key-state', { open: 'yes' }), EXT, true)).toEqual({ type: 'key-state', open: false })
  })

  it('hand: a question with its choices, or an ask to show; nothing else', () => {
    expect(readInbound(msg('hand', { ask: { text: 'What is this?', act: true } }), EXT, true)).toEqual({ type: 'hand', ask: { text: 'What is this?', page: true, act: true } })
    expect(readInbound(msg('hand', { ask: { text: 'Hi', page: false } }), EXT, true)).toEqual({ type: 'hand', ask: { text: 'Hi', page: false, act: false } })
    expect(readInbound(msg('hand', { open: { taskId: 't-1', sessionId: 's:2' } }), EXT, true)).toEqual({ type: 'hand', open: { taskId: 't-1', sessionId: 's:2' } })
    expect(readInbound(msg('hand', { open: { taskId: 't 1' } }), EXT, true)).toBeNull()
    expect(readInbound(msg('hand', { open: { taskId: 't1', sessionId: '<x>' } }), EXT, true)).toEqual({ type: 'hand', open: { taskId: 't1' } })
    expect(readInbound(msg('hand', { ask: { text: '   ' } }), EXT, true)).toBeNull()
    const long = readInbound(msg('hand', { ask: { text: 'x'.repeat(30_000) } }), EXT, true) as { ask: { text: string } }
    expect(long.ask.text.length).toBe(20_000)
    expect(readInbound(msg('hand', { ask: { text: 'Hi' } }), EXT, false)).toBeNull()
  })
})

describe('pageChipOn', () => {
  const at = (o: Partial<Parameters<typeof pageChipOn>[0]>) => pageChipOn({ url: 'https://a.example/x', conversation: false, sentPage: '', leftOut: '', added: '', ...o })
  it('on for a new chat, off in a conversation that already had this page', () => {
    expect(at({})).toBe(true)
    expect(at({ conversation: true, sentPage: 'https://a.example/x' })).toBe(false)
    expect(at({ conversation: true, sentPage: 'https://a.example/y' })).toBe(true)
    expect(at({ conversation: true })).toBe(true)
  })
  it('× leaves it out; a click puts it back; no page, no chip', () => {
    expect(at({ leftOut: 'https://a.example/x' })).toBe(false)
    expect(at({ conversation: true, sentPage: 'https://a.example/x', added: 'https://a.example/x' })).toBe(true)
    expect(at({ leftOut: 'https://a.example/other' })).toBe(true)
    expect(at({ url: '' })).toBe(false)
  })
})

describe('the page an ask last had', () => {
  it('is kept by task, newest first, and read back', () => {
    const data = new Map<string, string>()
    const s = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
    rememberSentPage('t1', 'https://a.example/x', s, 1)
    rememberSentPage('t2', 'https://b.example/y', s, 2)
    expect(sentPageOf('t1', s)).toBe('https://a.example/x')
    expect(sentPageOf('t2', s)).toBe('https://b.example/y')
    expect(sentPageOf('t3', s)).toBe('')
    rememberSentPage('t1', 'https://a.example/z', s, 3)
    expect(sentPageOf('t1', s)).toBe('https://a.example/z')
    data.set('walnut.ext-panel.page-sent', '{not json')
    expect(sentPageOf('t1', s)).toBe('')
  })
})

describe('pageOfContext', () => {
  it('reads the page back from the context a message went with', () => {
    const block = pageContextBlock({ url: 'https://docs.example.test/notes', title: 'Release notes' }, {})
    expect(pageOfContext(block)).toEqual({ title: 'Release notes', host: 'docs.example.test' })
    expect(pageOfContext('nothing here')).toBeNull()
    expect(pageOfContext(undefined)).toBeNull()
  })
})

describe('the words around the drawer and the key', () => {
  it("Main's line counts what needs the person", () => {
    expect(mainLineOf(0)).toBe('Your main agent: nothing needs you')
    expect(mainLineOf(1)).toBe('Your main agent: 1 thing needs you')
    expect(mainLineOf(2)).toBe('Your main agent: 2 things need you')
  })
  it("an ask's row line: its last words, never a passing wait", () => {
    const base = { id: 't1', title: 'Ask Walnut', phase: 'IN_PROGRESS', created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }
    const passing = { ...base, user_status: { state: 'waiting', kind: 'other', waitingOn: 'Its report on the turn that just ended', transient: true } }
    expect(askRowDetail(passing as never)).toEqual({ line: '', needs: false })
    const said = { ...passing, last_words: { text: 'Filled 6 fields.\nSubmit is yours.', at: '2026-11-06T00:01:00Z' } }
    expect(askRowDetail(said as never).line).toBe('Filled 6 fields. Submit is yours.')
    // Its own question to the person comes first; with neither, a Needs you row reads its category.
    const asking = { ...said, user_status: { state: 'needs', kind: 'other', source: 'session', ask: 'Pick the 3 pm slot?' } }
    expect(askRowDetail(asking as never)).toEqual({ line: 'Pick the 3 pm slot?', needs: true })
    const bare = { ...base, user_status: { state: 'needs', kind: 'other', source: 'session', toRead: 'answer' } }
    expect(askRowDetail(bare as never).line).not.toBe('')
    // A list's task has no last_words: a hand-back's status carries them (turnToReadLine), and the
    // row reads them from there, never the stock sentence around them.
    const handedBack = { ...base, phase: 'NEED_ACTION', user_status: { state: 'read', toRead: 'turn', waitingOn: turnToReadLine('Zen 14 wins on battery.') } }
    expect(askRowDetail(handedBack as never)).toEqual({ line: 'Zen 14 wins on battery.', needs: true })
    expect(lastWordsOfStatus({ toRead: 'turn', waitingOn: turnToReadLine(null) })).toBe('')
    expect(lastWordsOfStatus({ toRead: 'answer', waitingOn: turnToReadLine('x') })).toBe('')
  })
  it("the unlock line follows Walnut's setting, or the extension's own auto-lock", () => {
    expect(unlockLine({ autoLock: 'walnut', unlockFor: '48h' })).toBe('Stays unlocked 48 hours, renewed on use.')
    expect(unlockLine({ unlockFor: '1h' })).toBe('Stays unlocked 1 hour.')
    expect(unlockLine({ autoLock: '15' })).toBe('Locks after 15 minutes unused.')
    expect(unlockLine({ autoLock: '60' })).toBe('Locks after 1 hour unused.')
    expect(unlockLine({ autoLock: 'browser' })).toBe('Stays unlocked until the browser closes.')
    expect(unlockLine({})).toBe('')
  })
})
