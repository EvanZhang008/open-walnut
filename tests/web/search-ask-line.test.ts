/**
 * A search hit's folded ask reads the same pages its card does (web/src/components/tasks/SearchAskLine.tsx;
 * 2026-11-22 review: the line read the first raw ask while the card restored the page it was on and
 * judged answers by its own record, so right after the last answer the card was empty and the line
 * still said "Needs you"). Rendered for real (React on a linkedom document) over the real page record
 * (ask-pages.ts); the card is a stand-in that draws its page and keeps a send failure in its own state,
 * as ActionNeeded does, so the test sees whether the line keeps it mounted.
 *   - several asks: the line leads with the page the card opens on, and counts the other open ones;
 *   - a page answered from here: the line leads with the next open one, and opening shows that one;
 *   - the last ask answered: the line goes at once, before the status drops it;
 *   - a send that failed: the line comes back with the card's error, which a fold and a reopen keep.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import type { ActionItem } from '@open-walnut/user-status'
import type { Task } from '@open-walnut/core'
import type { AskPages } from '../../web/src/components/actions/ask-pages'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

/** What the stand-in card exposes: its page record, and a way to fail a send as a real one does. */
const card: { book?: AskPages; fail?: (id: string, why: string) => void } = {}

vi.mock('@/components/actions/ActionNeeded', async () => {
  const { anyOpen, useAskPages } = await import('../../web/src/components/actions/ask-pages')
  const { createElement, useState } = await import('../../web/node_modules/react/index.js')
  return {
    ActionNeeded: ({ task }: { task: Task }) => {
      const book = useAskPages(task.id, task.user_status?.actions ?? [])
      const [failure, setFailure] = useState<Record<string, string>>({})
      card.book = book
      card.fail = (id, why) => { book.reopen(id); setFailure((f) => ({ ...f, [id]: why })) }
      if (!book.pages.length || !anyOpen(book.pages, book.answered)) return null
      const item = book.pages[book.index]!
      return createElement('div', { 'data-testid': 'card', 'data-page': item.id }, item.summary,
        failure[item.id] ? createElement('span', { 'data-testid': 'card-error' }, failure[item.id]) : null)
    },
  }
})
vi.mock('../../web/src/components/common/AgentText', async () => {
  const { createElement } = await import('../../web/node_modules/react/index.js')
  return { AgentText: ({ text, testId }: { text: string; testId?: string }) => createElement('span', { 'data-testid': testId }, text) }
})

let doc: Document
let SearchAskLine: typeof import('../../web/src/components/tasks/SearchAskLine').SearchAskLine
beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  Object.assign(globalThis, { window: dom.window, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true })
  doc = dom.document as unknown as Document
  ;({ SearchAskLine } = await import('../../web/src/components/tasks/SearchAskLine'))
})

const ask = (id: string): ActionItem => ({ id, kind: 'ask', summary: `Question ${id}?` } as ActionItem)
let seq = 0
const taskWith = (items: ActionItem[], id = `t-${++seq}`): Task => ({ id, title: 'Rollout', phase: 'NEED_ACTION', user_status: { actions: items } } as unknown as Task)

async function mount(task: Task) {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host)
  const render = async (t: Task) => { await act(async () => { root.render(createElement(SearchAskLine, { task: t })) }) }
  await render(task)
  const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  const line = () => q('search-ask-line')
  const toggle = async () => { await act(async () => { q('search-ask-toggle')!.click() }) }
  return { host, root, render, q, line, toggle, shown: () => !!line() && !line()!.hasAttribute('hidden') }
}

describe('the folded ask line reads the pages its card opens on', () => {
  it('with several asks it leads with the page that opens, and counts the other open ones', async () => {
    const task = taskWith([ask('a'), ask('b'), ask('c')])
    const ui = await mount(task)
    expect(ui.q('search-ask-summary')!.textContent).toBe('Question a?')
    expect(ui.q('search-ask-toggle')!.textContent).toContain('Show')
    expect(ui.host.querySelector('.search-ask-more')!.textContent).toBe('+2')
    // The card moves to page c (an arrow, or the session's strip on the same task): folded, the line says c.
    await ui.toggle()
    expect(ui.q('search-ask-toggle')!.textContent).toContain('Hide')
    await act(async () => { card.book!.show('c') })
    await ui.toggle()
    expect(ui.q('search-ask-summary')!.textContent).toBe('Question c?')
    await ui.toggle()
    expect(ui.q('card')!.dataset.page).toBe('c')
    await act(async () => { ui.root.unmount() })
  })

  it('a page answered from here gives the lead to the next open one, which is the page that opens', async () => {
    const task = taskWith([ask('a'), ask('b'), ask('c')])
    const ui = await mount(task)
    await ui.toggle()
    await act(async () => { card.book!.answer(ask('a'), 'Mac first') })
    await ui.toggle()
    // Still asks two things: the line leads with b and counts c alone, never the answered a.
    expect(ui.shown()).toBe(true)
    expect(ui.q('search-ask-summary')!.textContent).toBe('Question b?')
    expect(ui.host.querySelector('.search-ask-more')!.textContent).toBe('+1')
    await ui.toggle()
    expect(ui.q('card')!.dataset.page).toBe('b')
    await act(async () => { ui.root.unmount() })
  })

  it('the last ask answered from here takes the line away at once, before the status drops it', async () => {
    const task = taskWith([ask('a')])
    const ui = await mount(task)
    await ui.toggle()
    await act(async () => { card.book!.answer(ask('a'), 'Yes') })
    // The status still lists the ask (no refresh yet), and the line is gone with the card's last page.
    expect(task.user_status!.actions).toHaveLength(1)
    expect(ui.shown()).toBe(false)
    expect(ui.q('search-ask-toggle')).toBeNull()
    // The status catches up: still nothing.
    await ui.render(taskWith([], task.id))
    expect(ui.shown()).toBe(false)
    await act(async () => { ui.root.unmount() })
  })

  it('a send that failed brings the line back with its error, and a fold and a reopen keep it', async () => {
    const task = taskWith([ask('a')])
    const ui = await mount(task)
    await ui.toggle()
    await act(async () => { card.book!.answer(ask('a'), 'Yes') })
    expect(ui.shown()).toBe(false)
    await act(async () => { card.fail!('a', 'Could not send: the host is offline') })
    expect(ui.shown()).toBe(true)
    expect(ui.q('card-error')!.textContent).toBe('Could not send: the host is offline')
    await ui.toggle()
    expect(ui.q('search-ask-summary')!.textContent).toBe('Question a?')
    expect((ui.host.querySelector('.search-ask-actions-below') as HTMLElement).hasAttribute('hidden')).toBe(true)
    await ui.toggle()
    expect(ui.q('card-error')!.textContent).toBe('Could not send: the host is offline')
    await act(async () => { ui.root.unmount() })
  })

  it('a task that asks nothing draws nothing', async () => {
    const ui = await mount(taskWith([]))
    expect(ui.line()).toBeNull()
    await act(async () => { ui.root.unmount() })
  })
})
