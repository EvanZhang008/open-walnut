/**
 * The side panel's and the popup's Ask drawn by the extension page while Walnut's view loads
 * (packages/browser-extension/src/panel-look.ts, the view's fields kept by panel-snap.ts): the
 * view's own header, body and composer from what the view said it showed last time (review
 * R1-4), the Continue list and suggestions kept for pages seen the first time and the popup, and
 * every word put in as text, never as markup. The browser API is a fake; the DOM is linkedom's.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

const win = parseHTML('<!doctype html><html><body></body></html>')
;(globalThis as any).document = win.document
;(globalThis as any).DOMParser = win.DOMParser

const local: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://self/${p}` },
  storage: { local: { get: async (k: string) => ({ [k]: structuredClone(local[k]) }), set: async (o: Record<string, unknown>) => { Object.assign(local, structuredClone(o)) }, remove: async (ks: string | string[]) => { for (const k of [ks].flat()) delete local[k] } } },
}

const { agentAskKey, keepSnap, shellOf, snapOf } = await import('../../../packages/browser-extension/src/panel-snap')
// The Ask view on Walnut's own agent said so (its `agent` word): its conversation is the one drawn.
const CURRENT_ASK_KEY = agentAskKey('walnut')
const { drawAskLook, newChatPlaceholder, NEW_CHAT_PLACEHOLDER, FOLLOW_UP_PLACEHOLDER } = await import('../../../packages/browser-extension/src/panel-look')
const { composerPlaceholderOf } = await import('../../../web/src/popout/ext-panel-model')

beforeEach(() => { for (const k of Object.keys(local)) delete local[k]; local.panelServer = 'http://walnut.example.test'; local.panelSnaps = { agent: { id: 'walnut', at: 0 } } })

const CONT = [
  { title: 'Compare two laptops', line: 'Zen 14 wins.', time: '3h ago', needs: false },
  { title: 'Draft a reply', line: 'Say yes to 3 pm?', time: '1d ago', needs: true },
]
const text = (el: Element, sel: string) => el.querySelector(sel)?.textContent ?? null

describe('kept: the view around the conversation', () => {
  it("the view's fields come back with the open conversation, and the Continue list and suggestions are kept for every page", async () => {
    await keepSnap('ask', {
      title: 'Release notes', host: 'docs.example.test', messages: [],
      askTitle: 'New quick question', agent: 'Quick question', placeholder: NEW_CHAT_PLACEHOLDER, continue: CONT, suggestions: ['Which task is …', 'Schedule my day'], pageOn: true,
    }, { key: CURRENT_ASK_KEY, agentId: 'walnut' }, 1000)
    const s = await snapOf('ask', 'https://docs.example.test/notes', 2000) as any
    expect(s).toMatchObject({ askTitle: 'New quick question', agent: 'Quick question', placeholder: NEW_CHAT_PLACEHOLDER, cont: CONT, suggestions: ['Which task is …', 'Schedule my day'], pageOn: true })
    expect(await shellOf(2000)).toMatchObject({ agent: 'Quick question', cont: CONT, suggestions: ['Which task is …', 'Schedule my day'] })
  })

  it('an older view (messages alone) keeps no view fields and leaves the shell as it was', async () => {
    await keepSnap('ask', { title: 'p', host: 'h', messages: [{ role: 'user', text: 'hi' }] }, { key: CURRENT_ASK_KEY, agentId: 'walnut' }, 5)
    const s = await snapOf('ask', 'p', 6) as any
    expect(s.askTitle).toBeUndefined()
    expect(s.cont).toBeUndefined()
    expect(await shellOf(6)).toBeNull()
  })

  it('what is kept is cut short and a needs that is not true is false', async () => {
    await keepSnap('ask', { title: 't', host: 'h', messages: [], continue: Array.from({ length: 9 }, () => ({ title: 'x'.repeat(500), line: 1, time: 'now', needs: 'yes' })), suggestions: ['a', 'b', 'c', 'd'] }, { key: CURRENT_ASK_KEY, agentId: 'walnut' }, 1)
    const s = await snapOf('ask', 't', 2) as any
    expect(s.cont).toHaveLength(6)
    expect(s.cont[0].title.length).toBe(200)
    expect(s.cont[0].line).toBe('')
    expect(s.cont[0].needs).toBe(false)
    expect(s.suggestions).toHaveLength(3)
  })
})

describe('drawn: the view as it will look', () => {
  const page = { title: 'Release notes 4.2', host: 'docs.example.test' }

  it('a new quick question in the side panel: ≡, New quick question over the agent, the key with its padlock, Continue, suggestions, the composer with the page chip and Act in tab', () => {
    const el = drawAskLook({ surface: 'panel', snap: null, shell: { at: 1, agent: 'Quick question', cont: CONT, suggestions: ['Schedule my day'] }, page, locked: true })
    expect(el.querySelector('[data-testid="panel-snap-menu"]')).not.toBeNull()
    expect(text(el, '[data-testid="panel-snap-title"]')).toBe('New quick question')
    expect(text(el, '.look-agent')).toBe('Quick question')
    expect(el.querySelector('[data-testid="panel-snap-locked"]')).not.toBeNull()
    expect(el.querySelectorAll('.look-cont-row')).toHaveLength(2)
    expect(el.querySelector('.look-dot.is-needs')).not.toBeNull()
    expect(text(el, '.look-sugg-chip')).toBe('Schedule my day')
    expect(text(el, '[data-testid="panel-snap-placeholder"]')).toBe(NEW_CHAT_PLACEHOLDER)
    expect(text(el, '.look-chip-label')).toBe('Release notes 4.2 · docs.example.test')
    expect(el.querySelector('.look-chip-page.is-on')).not.toBeNull()
    expect(text(el, '.look-chip-act')).toBe('Act in tab')
    expect(text(el, '.look-fav')).toBe('D')
  })

  it("a conversation: its title, its messages, the follow-up placeholder, the page chip as the view had it; unlocked, no padlock", () => {
    const snap = { at: 1, title: 'Release notes 4.2', host: 'docs.example.test', messages: [{ role: 'user' as const, text: 'What changed?' }, { role: 'assistant' as const, text: 'Uploads retry.' }], askTitle: 'Uploads in 4.2', pageOn: false }
    const el = drawAskLook({ surface: 'panel', snap, shell: { at: 1, cont: CONT }, page, locked: false })
    expect(text(el, '[data-testid="panel-snap-title"]')).toBe('Uploads in 4.2')
    expect(el.querySelectorAll('.panel-snap-msg')).toHaveLength(2)
    expect(el.querySelector('.look-cont')).toBeNull()
    expect(text(el, '[data-testid="panel-snap-placeholder"]')).toBe(FOLLOW_UP_PLACEHOLDER)
    expect(el.querySelector('.look-chip-page.is-on')).toBeNull()
    expect(el.querySelector('[data-testid="panel-snap-locked"]')).toBeNull()
  })

  it('the conversation shown on another page: the page chip is on there, as the view draws it; on its own page as it was', () => {
    const snap = { at: 1, title: 'Release notes 4.2', host: 'docs.example.test', pageKey: 'web:https://docs.example.test/notes', messages: [{ role: 'user' as const, text: 'What changed?' }], pageOn: false }
    const other = drawAskLook({ surface: 'panel', snap, shell: null, page: { title: 'Shop', host: 'shop.example.test', key: 'web:https://shop.example.test/' }, locked: false })
    expect(other.querySelector('.look-chip-page.is-on')).not.toBeNull()
    const same = drawAskLook({ surface: 'panel', snap, shell: null, page: { title: 'Notes', host: 'docs.example.test', key: 'web:https://docs.example.test/notes' }, locked: false })
    expect(same.querySelector('.look-chip-page.is-on')).toBeNull()
  })

  it('no agent known: the bare Ask, its header and composer, no chat, no Continue rows, no suggestions (round 3 code review, item 3)', () => {
    const el = drawAskLook({ surface: 'panel', snap: null, shell: null, page, locked: true })
    expect(el.querySelector('.look-chat')).toBeNull()
    expect(el.querySelectorAll('.panel-snap-msg')).toHaveLength(0)
    expect(el.querySelector('.look-cont')).toBeNull()
    expect(el.querySelector('.look-sugg')).toBeNull()
    expect(text(el, '[data-testid="panel-snap-title"]')).toBe('New quick question')
    expect(text(el, '[data-testid="panel-snap-placeholder"]')).toBe(NEW_CHAT_PLACEHOLDER)
  })

  it('an agent with none of its words kept yet: the drawing names it as its header does, with no chat', () => {
    const el = drawAskLook({ surface: 'panel', snap: null, shell: null, page, locked: false, agentName: 'Quick question · Mentor' })
    expect(el.querySelector('.look-agent')?.textContent).toBe('Quick question · Mentor')
    expect(el.querySelectorAll('.panel-snap-msg')).toHaveLength(0)
  })

  it('the popup: the agent alone in its header, the Continue list, no suggestions; no web page, no chips', () => {
    const el = drawAskLook({ surface: 'popup', snap: null, shell: { at: 1, agent: 'Quick question', cont: CONT, suggestions: ['Schedule my day'] }, page: null, locked: true })
    expect(el.querySelector('[data-testid="panel-snap-title"]')).toBeNull()
    expect(el.querySelector('.look-titles.is-popup .look-agent')?.textContent).toBe('Quick question')
    expect(el.querySelectorAll('.look-cont-row')).toHaveLength(2)
    expect(el.querySelector('.look-sugg')).toBeNull()
    expect(el.querySelector('.look-chip')).toBeNull()
  })

  it('the suggestion chips as the view draws them: each with its icon, a stem with its blank; an unknown icon draws none (R2-6)', async () => {
    await keepSnap('ask', {
      title: 'Release notes', host: 'docs.example.test', messages: [],
      suggestions: ['Which task is …', 'Schedule my day', 'What is due'], suggestionIcons: ['search', 'calendar', '<svg onload=x>'],
    }, { key: CURRENT_ASK_KEY, agentId: 'walnut' }, 1000)
    const snap = await snapOf('ask', 'https://docs.example.test/notes', 2000) as any
    expect(snap.suggestionIcons).toEqual(['search', 'calendar', ''])
    const el = drawAskLook({ surface: 'panel', snap, shell: null, page, locked: false })
    const chips = [...el.querySelectorAll('.look-sugg-chip')]
    expect(chips.map((c) => c.textContent)).toEqual(['Which task is', 'Schedule my day', 'What is due'])
    expect(chips.map((c) => !!c.querySelector('.look-sugg-ic svg'))).toEqual([true, true, false])
    expect(chips.map((c) => !!c.querySelector('.look-sugg-blank'))).toEqual([true, false, false])
    // The shell keeps them for a page seen the first time.
    const fresh = drawAskLook({ surface: 'panel', snap: null, shell: await shellOf(2000), page, locked: false })
    expect(fresh.querySelectorAll('.look-sugg-ic svg')).toHaveLength(2)
  })

  it("a person's message carries what it took from the page, in its bubble, as text (R2-6)", async () => {
    await keepSnap('ask', {
      title: 'Release notes', host: 'docs.example.test', askTitle: 'Uploads in 4.2',
      messages: [{ role: 'user', text: 'What changed?', page: 'Release notes 4.2 · docs.example.test', quote: '<b>retries</b> three times' }, { role: 'assistant', text: 'Uploads retry.', page: 'never on a reply' }],
    }, { key: CURRENT_ASK_KEY, agentId: 'walnut' }, 1000)
    const snap = await snapOf('ask', 'https://docs.example.test/notes', 2000) as any
    expect(snap.messages[1].page).toBeUndefined()
    const el = drawAskLook({ surface: 'panel', snap, shell: null, page, locked: false })
    const user = el.querySelector('.panel-snap-msg.is-user')!
    expect(text(user, '.look-msg-page-text')).toBe('Release notes 4.2 · docs.example.test')
    expect(text(user, '.look-msg-quote-cap')).toBe('From the page')
    expect(text(user, '.look-msg-quote-text')).toBe('<b>retries</b> three times')
    expect(user.querySelector('b')).toBeNull()
    expect(el.querySelector('.panel-snap-msg.is-assistant .look-msg-page')).toBeNull()
  })

  it('a conversation whose ask has no title yet names the agent once, as its title line, as the view does', () => {
    const snap = { at: 1, title: 'Release notes 4.2', host: 'docs.example.test', agent: 'Quick question', messages: [{ role: 'user' as const, text: 'What changed?' }] }
    const el = drawAskLook({ surface: 'panel', snap, shell: null, page, locked: false })
    expect(el.querySelector('[data-testid="panel-snap-title"]')).toBeNull()
    expect(text(el, '[data-testid="panel-snap-agent-title"]')).toBe('Quick question')
    expect(el.querySelectorAll('.look-agent')).toHaveLength(1)
  })

  it('drawn again in the same element when more is known; words stay words', () => {
    const el = drawAskLook({ surface: 'panel', snap: null, shell: null, page: null, locked: true })
    expect(el.querySelector('.look-cont')).toBeNull()
    const again = drawAskLook({ surface: 'panel', snap: null, shell: { at: 1, cont: [{ title: '<img src=x onerror=alert(1)>', line: '<b>x</b>', time: '', needs: false }] }, page: { title: '<i>t</i>', host: 'h' }, locked: false }, el)
    expect(again).toBe(el)
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('i')).toBeNull()
    expect(text(el, '.look-cont-title')).toBe('<img src=x onerror=alert(1)>')
  })
})

describe('every icon the extension draws parses', () => {
  // The extension parses icon markup as XML (dom.ts svg), where an attribute named twice is a fatal
  // error: the icon becomes the parser's error text (2026-11-06: the look's ≡ spread a shared
  // attribute string and then set width again, and its header grew to 181 px).
  const repeated = (markup: string): string[] => {
    const out: string[] = []
    for (const tag of markup.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      const names = Array.from(tag.matchAll(/\s([a-zA-Z:-]+)=/g), (m) => m[1])
      for (const n of names) if (names.indexOf(n) !== names.lastIndexOf(n)) out.push(`${n} in ${tag.slice(0, 60)}`)
    }
    return [...new Set(out)]
  }

  it('no icon table names an attribute twice in one tag', async () => {
    const { ICONS } = await import('../../../packages/browser-extension/src/dom')
    const { POPUP_ICONS } = await import('../../../packages/browser-extension/src/popup-ui')
    const { LOOK_ICONS } = await import('../../../packages/browser-extension/src/panel-look')
    for (const [table, icons] of Object.entries({ ICONS, POPUP_ICONS, LOOK_ICONS })) {
      for (const [name, markup] of Object.entries(icons as Record<string, string>)) expect(repeated(markup), `${table}.${name}`).toEqual([])
    }
  })

  it('no source spreads a shared attribute string into an <svg> tag and then sets one of its attributes again', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = path.resolve(__dirname, '../../../packages/browser-extension/src')
    const bad: string[] = []
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const m of src.matchAll(/<svg \$\{[^}]+\}([^>]*)>/g)) if (/\b(width|height|stroke-width|viewBox|fill|stroke)=/.test(m[1])) bad.push(`${f}: ${m[0].slice(0, 80)}`)
    }
    expect(bad).toEqual([])
  })
})

describe('a new chat of another agent (review round 4, #5)', () => {
  it('the drawing names the agent in its placeholder, as the view does', () => {
    expect(newChatPlaceholder('Quick question · Mentor')).toBe(composerPlaceholderOf('Mentor', true))
    expect(newChatPlaceholder('Quick question')).toBe(composerPlaceholderOf('Walnut', true))
    // The labels an older view stored before the rename still draw the same words.
    expect(newChatPlaceholder('Ask Mentor')).toBe(composerPlaceholderOf('Mentor', true))
    expect(newChatPlaceholder('Ask Walnut')).toBe(composerPlaceholderOf('Walnut', true))
    const el = drawAskLook({ surface: 'panel', snap: null, shell: { at: 0, agent: 'Quick question · Mentor' }, page: null, locked: false } as never)
    expect(el.querySelector('[data-testid="panel-snap-placeholder"]')?.textContent).toBe('Ask Mentor a quick question, or have it do something here…')
  })
})
