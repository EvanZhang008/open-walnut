/**
 * The side panel's drawing of last time (packages/browser-extension/src/panel-snap.ts): what the
 * Ask and Tasks views said they show is kept (cut to words and lengths it can draw), one
 * conversation per page address without its #part, the newest few pages only; two writes at once
 * keep both; and the drawing puts the words in as text, never as markup.
 * The browser API is a fake; the DOM is linkedom's.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'

;(globalThis as any).document = parseHTML('<!doctype html><html><body></body></html>').document

const local: Record<string, unknown> = {}
;(globalThis as any).chrome = {
  runtime: { getURL: (p: string) => `chrome-extension://self/${p}` },
  storage: { local: { get: async (k: string) => ({ [k]: structuredClone(local[k]) }), set: async (o: Record<string, unknown>) => { Object.assign(local, structuredClone(o)) }, remove: async (ks: string | string[]) => { for (const k of [ks].flat()) delete local[k] } } },
}

const { drawSnap, keepSnap, snapKeyOf, snapOf } = await import('../../../packages/browser-extension/src/panel-snap')
const { clearPanelData } = await import('../../../packages/browser-extension/src/panel-data')

beforeEach(() => { for (const k of Object.keys(local)) delete local[k]; local.panelServer = 'http://walnut.example.test' })

describe('kept per page, cut to what it draws', () => {
  it('a conversation comes back for the same page, also with another #part, and not for another page', async () => {
    await keepSnap('ask', { title: 'Release notes', host: 'docs.example.test', messages: [{ role: 'user', text: 'What changed?' }, { role: 'assistant', text: 'Uploads retry.' }] }, { key: snapKeyOf('https://docs.example.test/notes?v=2') }, 1000)
    const back = await snapOf('ask', 'https://docs.example.test/notes?v=2#top', 2000) as { messages: unknown[]; title: string }
    expect(back.title).toBe('Release notes')
    expect(back.messages).toEqual([{ role: 'user', text: 'What changed?' }, { role: 'assistant', text: 'Uploads retry.' }])
    expect(await snapOf('ask', 'https://docs.example.test/other', 2000)).toBeNull()
  })

  it('strange shapes are cut down: long words, a role it does not know, empty messages, too many', async () => {
    const messages = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'robot' : 'user', text: i === 8 ? '' : `m${i} ${'x'.repeat(2000)}` }))
    await keepSnap('ask', { title: 't'.repeat(900), host: 7, messages }, { key: 'web:k' }, 1)
    const s = (local.panelSnaps as any).ask['web:k']
    expect(s.title).toHaveLength(300)
    expect(s.host).toBe('')
    expect(s.messages.length).toBeLessThanOrEqual(6)
    expect(s.messages.every((m: any) => m.text.length <= 800 && (m.role === 'user' || m.role === 'assistant'))).toBe(true)
  })

  it('only the newest pages are kept; two writes at once keep both views', async () => {
    for (let i = 0; i < 35; i++) await keepSnap('ask', { title: `p${i}`, host: 'h', messages: [] }, { key: `web:p${i}` }, 100 + i)
    expect(Object.keys((local.panelSnaps as any).ask)).toHaveLength(30)
    expect((local.panelSnaps as any).ask['web:p0']).toBeUndefined()
    await Promise.all([
      keepSnap('tasks', { sections: [{ title: 'Focus', rows: [{ title: 'Ship it', line: 'Working', state: 'working' }] }] }, { counts: [3] }, 500),
      keepSnap('ask', { title: 'Last', host: 'h', messages: [] }, { key: 'web:last' }, 500),
    ])
    expect((local.panelSnaps as any).tasks.sections[0]).toEqual({ title: 'Focus', count: 3, rows: [{ title: 'Ship it', line: 'Working', state: 'working' }] })
    expect((local.panelSnaps as any).ask['web:last'].title).toBe('Last')
  })

  it('a drawing two weeks old is not drawn', async () => {
    await keepSnap('tasks', { sections: [] }, {}, 0)
    expect(await snapOf('tasks', undefined, 15 * 24 * 3600_000)).toBeNull()
  })
})

describe('only while connected', () => {
  it('a disconnect removes every kept word and the server; a write that lands after it keeps nothing', async () => {
    await keepSnap('ask', { title: 'Private chat', host: 'h', messages: [{ role: 'user', text: 'secret question' }] }, { key: 'web:k' }, 1)
    await keepSnap('tasks', { sections: [{ title: 'Focus', rows: [{ title: 'T', line: 'L', state: 'working' }] }] }, {}, 1)
    await clearPanelData()
    expect(local.panelSnaps).toBeUndefined()
    expect(local.panelServer).toBeUndefined()
    expect(await snapOf('ask', 'k', 2)).toBeNull()
    await keepSnap('ask', { title: 'Late', host: 'h', messages: [{ role: 'user', text: 'late words' }] }, { key: 'web:late' }, 3)
    expect(local.panelSnaps).toBeUndefined()
  })
})

describe('drawn in the view\'s own layout', () => {
  it('Tasks: its save row on top, then the sections; an empty Focus says so as the view does', async () => {
    await keepSnap('tasks', { sections: [{ title: 'Focus', rows: [] }, { title: 'Needs you', rows: [{ title: 'Pick a design', line: 'Decide: A or B?', state: 'needs' }] }] }, { counts: [0, 1] }, 1)
    const t = drawSnap('tasks', (local.panelSnaps as any).tasks)
    expect(t.firstElementChild?.className).toBe('panel-snap-save')
    expect(t.querySelector('.panel-snap-save')?.textContent).toBe('Save this page as a task')
    expect(t.querySelector('.panel-snap-empty')?.textContent).toBe('No Focus tasks.')
    expect(t.querySelectorAll('section')).toHaveLength(2)
    expect(t.querySelector('.panel-snap-task-line')?.textContent).toBe('Decide: A or B?')
  })
})

describe('drawn as text', () => {
  it('markup in the words stays words, and a state that is not a word is dropped from the class', async () => {
    await keepSnap('ask', { title: '<img src=x onerror=alert(1)>', host: 'h', messages: [{ role: 'user', text: '<b>hi</b>' }] }, { key: 'web:x' }, 1)
    const el = drawSnap('ask', (local.panelSnaps as any).ask['web:x'])
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.querySelector('.panel-snap-msg.is-user')?.textContent).toBe('<b>hi</b>')
    await keepSnap('tasks', { sections: [{ title: 'Needs you', rows: [{ title: 'A', line: 'B', state: 'x" onclick="y' }] }] }, {}, 1)
    const t = drawSnap('tasks', (local.panelSnaps as any).tasks)
    expect(t.querySelector('.panel-snap-dot')?.getAttribute('class')).toBe('panel-snap-dot state-')
    expect(t.querySelector('.panel-snap-task-title')?.textContent).toBe('A')
  })
})
