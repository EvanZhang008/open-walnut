/**
 * What an acting step changed (packages/browser-extension/src/agent-change.ts; 2026-11-10: a click
 * "said ok" while nothing happened, and the agent waited 30 s on an address and then listed every
 * tab of the person's to find out): one line from the page's own watch around the step, against a
 * fake browser. A new tab beats an address beats a reload beats a mutation beats a field beats a
 * scroll; a page that could not be watched gets no line (never a guess); a step in a frame never
 * reads "nothing changed"; a click that changed nothing looks again for a page that answers late,
 * a hover or scroll does not; a dialog or a new tab needs no look after the step. A step whose
 * answer the page never sent (2026-11-11, a review: `type --submit` ran GitHub's search and answered
 * page_not_ready "try again") is judged by the tab: another address means it ran, else the words say
 * it may have run and to look first; every acting step is covered.
 */
import { beforeEach, describe, expect, it } from 'vitest'

interface Fake { url: string; ok: boolean; doc: string; values: number; scroll: number; mutations: number; scrolls: number; watching: boolean; looks: Array<Record<string, unknown>>; later: null | (() => void); enter?: Record<string, unknown> }
const fake: Fake = { url: '', ok: true, doc: 'd1', values: 1, scroll: 0, mutations: 0, scrolls: 0, watching: true, looks: [], later: null }
const ev = () => ({ addListener() {}, removeListener() {} })
;(globalThis as any).chrome = {
  runtime: { id: 'test', getURL: (p: string) => p, getManifest: () => ({ version: '0' }), onMessage: ev() },
  storage: { session: { get: async () => ({}), set: async () => {} }, local: { get: async () => ({}), set: async () => {} }, onChanged: ev() },
  tabs: {
    onCreated: ev(), onRemoved: ev(), onUpdated: ev(),
    get: async () => ({ id: 7, url: fake.url, status: 'complete' }),
    sendMessage: async (_t: number, msg: Record<string, unknown>) => {
      if (msg.type !== 'agent-digest') return { ok: true }
      fake.looks.push(msg)
      if (fake.looks.length === 3 && fake.later) fake.later()
      if (!fake.ok) return undefined
      return { ok: true, doc: fake.doc, values: fake.values, scroll: fake.scroll, ...(msg.read ? (fake.watching ? { watching: true, mutations: fake.mutations, scrolls: fake.scrolls, ...(fake.enter ? { enter: fake.enter } : {}) } : { watching: false }) : {}) }
    },
  },
}
const { changedLine, withChange, NOTHING, IN_FRAME, ENTER_NOTHING, CHANGE_ACTS, MAYBE_RAN } = await import('../../../packages/browser-extension/src/agent-change')
const { AgentError } = await import('../../../packages/browser-extension/src/agent-shared')

const before = { url: 'https://x.test/a', doc: 'd1', values: 1, scroll: 0 }
const after = { ...before, watching: true, mutations: 0, scrolls: 0 }

beforeEach(() => {
  Object.assign(fake, { url: 'https://x.test/a', ok: true, doc: 'd1', values: 1, scroll: 0, mutations: 0, scrolls: 0, watching: true, looks: [], later: null, enter: undefined })
})

describe('changedLine', () => {
  it('names the biggest change first', () => {
    expect(changedLine(before, { ...after, url: 'https://x.test/b' }, { opened: { tab: 9, url: 'https://x.test/n' }, url: 'https://x.test/b' })).toBe('opened a new tab 9: https://x.test/n (yours too: --tab 9)')
    expect(changedLine(before, { ...after, url: 'https://x.test/b', doc: 'd2' }, { url: 'https://x.test/b', title: 'B' })).toBe('went to https://x.test/b "B"')
    expect(changedLine(before, { ...after, doc: 'd2' }, { url: before.url, title: 'A' })).toBe('the page loaded again "A"')
    expect(changedLine(before, { ...after, mutations: 3, values: 2 }, {})).toBe('the page content changed')
    expect(changedLine(before, { ...after, values: 2, scrolls: 1 }, {})).toBe('a field\'s value changed')
    // A scroll of a box inside the page counts, not only the page's own.
    expect(changedLine(before, { ...after, scrolls: 2 }, {})).toBe('the page scrolled')
    expect(changedLine(before, { ...after, scroll: 9 }, {})).toBe('the page scrolled')
    expect(changedLine(before, { ...after }, {})).toBe(NOTHING)
    expect(changedLine(before, { ...after }, { dialog: { type: 'confirm' } })).toBe('it opened a dialog')
  })

  it('says nothing when the page could not be watched (no guess); a frame step never reads "nothing changed"', () => {
    expect(changedLine({ url: before.url }, { ...after }, {})).toBeUndefined()
    expect(changedLine(before, { url: before.url }, {})).toBeUndefined()
    // This document never started the watch (the page was swapped without a new address).
    expect(changedLine(before, { ...after, watching: false }, {})).toBeUndefined()
    // An address it moved to is known without the page.
    expect(changedLine({ url: before.url }, { url: 'https://x.test/b' }, {})).toBe('went to https://x.test/b')
    expect(changedLine(before, { ...after }, {}, true)).toBe(IN_FRAME)
    expect(IN_FRAME).not.toMatch(/^nothing changed/)
  })
})

describe('withChange', () => {
  it('starts the watch before the step and reads it once after a step that changed the page', async () => {
    const r = await withChange(7, 'click', {}, async () => { fake.mutations = 4; return { tab: 7, clicked: 'x' } })
    expect(r.changed).toBe('the page content changed')
    await new Promise((res) => setTimeout(res, 0))
    // The watch, the read, and the watch ended (no late looks: it changed).
    expect(fake.looks).toHaveLength(3)
    const id = fake.looks[0].watch
    expect(typeof id).toBe('string')
    expect(fake.looks[1]).toMatchObject({ read: id, done: false })
    expect(fake.looks[2]).toMatchObject({ read: id, done: true })
  })

  it('a page that answers late: nothing at first, then the change it made is the line', async () => {
    fake.later = () => { fake.url = 'https://x.test/late' }
    const r = await withChange(7, 'click', {}, async () => ({ tab: 7, clicked: 'x', url: 'https://x.test/a' }))
    expect(r.changed).toBe('went to https://x.test/late')
  })

  it('a click with no change: said after two more looks, and the watch is ended', async () => {
    const r = await withChange(7, 'click', {}, async () => ({ tab: 7, clicked: 'x' }))
    expect(r.changed).toBe(NOTHING)
    await new Promise((res) => setTimeout(res, 0))
    expect(fake.looks).toHaveLength(5)
    expect(fake.looks.at(-1)).toMatchObject({ done: true })
  })

  it('a hover or a scroll looks once (no late looks)', async () => {
    for (const action of ['hover', 'scroll']) {
      fake.looks = []
      expect((await withChange(7, action, {}, async () => ({ tab: 7 }))).changed).toBe(NOTHING)
      expect(fake.looks).toHaveLength(2)
      expect(fake.looks[1]).toMatchObject({ done: true })
    }
  })

  it('a dialog or a new tab is the line at once, with no look at the page after the step', async () => {
    expect((await withChange(7, 'click', {}, async () => ({ tab: 7, dialog: { type: 'alert' } }))).changed).toBe('it opened a dialog')
    expect(fake.looks).toHaveLength(1)
    fake.looks = []
    const r = await withChange(7, 'click', {}, async () => ({ tab: 7, opened: { tab: 9, url: 'https://x.test/n' } }))
    expect(r.changed).toMatch(/^opened a new tab 9/)
    expect(fake.looks.filter((l) => l.read && !l.done)).toHaveLength(0)
  })

  it('a step in a frame (its ref, its match or a form field) says the frame was not checked', async () => {
    expect((await withChange(7, 'click', { ref: 'f3:e2' }, async () => ({ tab: 7 }))).changed).toBe(IN_FRAME)
    expect((await withChange(7, 'click', {}, async () => ({ tab: 7, matched: { ref: 'f2:e1', of: 1 } }))).changed).toBe(IN_FRAME)
    expect((await withChange(7, 'fill_form', { fields: [{ ref: 'e1' }, { ref: 'f4:e3' }] }, async () => ({ tab: 7 }))).changed).toBe(IN_FRAME)
  })

  it('a page that does not answer the look gets no line; the step\'s own error is its answer and ends the watch', async () => {
    fake.ok = false
    expect((await withChange(7, 'click', {}, async () => ({ tab: 7, clicked: 'x' }))).changed).toBeUndefined()
    fake.ok = true
    fake.looks = []
    await expect(withChange(7, 'click', {}, async () => { throw Object.assign(new Error('covered'), { code: 'covered' }) })).rejects.toMatchObject({ code: 'covered' })
    await new Promise((res) => setTimeout(res, 0))
    expect(fake.looks.at(-1)).toMatchObject({ done: true })
  })

  it('a typed text that submits says what its Enter did, never the typing\'s change as the page\'s', async () => {
    // Only the field moved before the Enter, and the Enter changed nothing: said so, after the late looks.
    fake.enter = { mutations: 0, scrolls: 0, values: false, scroll: false }
    const quiet = await withChange(7, 'type', { ref: 'e3', text: 'cats', submit: true }, async () => { fake.values = 2; return { tab: 7, typed: 'x', enter_quiet: true } })
    expect(quiet.changed).toBe(ENTER_NOTHING)
    expect(fake.looks).toHaveLength(5)
    // The Enter went somewhere, late: the address is the line.
    fake.looks = []; fake.values = 1
    fake.enter = { mutations: 3, scrolls: 0, values: false, scroll: false }
    fake.later = () => { fake.url = 'https://x.test/search?q=cats' }
    const went = await withChange(7, 'type', { ref: 'e3', text: 'cats', submit: true }, async () => ({ tab: 7, typed: 'x', url: 'https://x.test/a' }))
    expect(went.changed).toBe('Enter: went to https://x.test/search?q=cats')
    // A plain type with no submit that only moved the field.
    fake.later = null; fake.url = 'https://x.test/a'; fake.enter = undefined
    expect((await withChange(7, 'type', { ref: 'e3', text: 'x' }, async () => { fake.values = 5; return { tab: 7 } })).changed).toBe('a field\'s value changed')
  })
})

describe('a step whose answer the page never sent', () => {
  const unanswered = () => new AgentError('The page did not answer in time (it may be busy or frozen): try again.', 'page_not_ready', { unanswered: true })

  it('went to another page before answering: the step ran, and the answer says where', async () => {
    const r = await withChange(7, 'type', { ref: 'e17', text: 'walnut personal ai', submit: true }, async () => { fake.url = 'https://x.test/search?q=walnut'; throw unanswered() })
    expect(r).toMatchObject({ tab: 7, url: 'https://x.test/search?q=walnut', typed: '18 characters into e17', changed: 'Enter: went to https://x.test/search?q=walnut' })
    expect(String(r.note)).toMatch(/the step ran/)
  })

  it('the page loaded again: the step ran', async () => {
    const r = await withChange(7, 'click', { ref: 'e3' }, async () => { fake.doc = 'd2'; throw unanswered() })
    expect(r).toMatchObject({ clicked: 'e3', changed: 'the page loaded again' })
  })

  it('no change the tab shows: it may have run, look before acting again (never a bare "try again")', async () => {
    const err = await withChange(7, 'press', { key: 'Enter' }, async () => { throw unanswered() }).catch((e) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect(err.code).toBe('page_not_ready')
    expect(err.message).toBe(MAYBE_RAN)
    expect(err.message).not.toMatch(/try again/)
    expect(err.extra.unanswered).toBeUndefined()
  })

  it('a refusal before the step was sent, or another failure, is thrown as it is', async () => {
    const early = new AgentError('No time was left for the step: call it again.', 'page_not_ready')
    fake.url = 'https://x.test/a'
    expect(await withChange(7, 'click', {}, async () => { fake.url = 'https://x.test/b'; throw early }).catch((e) => e)).toBe(early)
    const other = new AgentError('No element e9 on the page now', 'stale_ref', { unanswered: true })
    expect(await withChange(7, 'click', {}, async () => { throw other }).catch((e) => e)).toBe(other)
  })

  it('the tab closed meanwhile: the step may have closed it, never "try again"', async () => {
    const get = (globalThis as any).chrome.tabs.get
    try {
      const err = await withChange(7, 'click', { ref: 'e3' }, async () => { (globalThis as any).chrome.tabs.get = async () => { throw new Error('No tab') }; throw unanswered() }).catch((e) => e)
      expect(err.code).toBe('not_your_tab')
      expect(err.message).toMatch(/may have closed it/)
    } finally { (globalThis as any).chrome.tabs.get = get }
  })

  it('every acting step is judged the same way (a new one is covered by being one)', async () => {
    for (const action of CHANGE_ACTS) {
      fake.url = 'https://x.test/a'
      const r = await withChange(7, action, {}, async () => { fake.url = `https://x.test/${action}`; throw unanswered() })
      expect(String(r.changed), action).toContain(`went to https://x.test/${action}`)
    }
  })
})
