/**
 * A task row's Action needed folds as one block (web/src/components/actions/ActionNeeded.tsx with
 * AskFold.tsx): its × folds every ask of the task to one line, paging from that line stays folded,
 * a page answered here reads "Answered" on the line (never "Waits on you"), and a new ask opens
 * the block again. Mounted for real (linkedom + the web app's own React).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import type { ActionItem } from '@open-walnut/user-status'
import type { Task } from '@open-walnut/core'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('../../web/src/components/common/AgentText', async () => {
  const { createElement } = await import('../../web/node_modules/react/index.js')
  return { AgentText: ({ text, testId }: { text: string; testId?: string }) => createElement('span', { 'data-testid': testId }, text) }
})

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

let win: Window & typeof globalThis
let ActionNeeded: typeof import('../../web/src/components/actions/ActionNeeded').ActionNeeded
let host: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null

beforeAll(async () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  win = dom.window as unknown as Window & typeof globalThis
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  // The card's slash-command and skill lists are read on import: nothing to read here.
  vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }))
  ;({ ActionNeeded } = await import('../../web/src/components/actions/ActionNeeded'))
})
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  document.body.innerHTML = ''
})

const ask = (id: string): ActionItem => ({ id, kind: 'ask', summary: `Question ${id}?` } as ActionItem)
let seq = 0
const taskWith = (items: ActionItem[], id = `t-fold-${++seq}`): Task => ({ id, title: 'Rollout', phase: 'NEED_ACTION', user_status: { actions: items } } as unknown as Task)
const render = async (task: Task) => { await act(async () => { root!.render(createElement(ActionNeeded, { task })) }) }
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (id: string) => {
  const el = q(id)
  expect(el, `${id} is drawn`).not.toBeNull()
  await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true })) })
}

describe('a task row\'s Action needed folds as one block', () => {
  it('paging from the folded line stays folded and names each page', async () => {
    const task = taskWith([ask('a'), ask('b'), ask('c')])
    await render(task)
    expect(q('action-item')).not.toBeNull()
    await click('action-item-close')
    expect(q('action-item')).toBeNull()
    expect(q('action-fold-title')!.textContent).toBe('Question a?')
    expect(q('action-fold-line')!.textContent).toContain('Waits on you')
    await click('action-page-next')
    expect(q('action-item'), 'the next page opens folded too').toBeNull()
    expect(q('action-fold-title')!.textContent).toBe('Question b?')
    await click('action-fold-show')
    expect(q('action-item')).not.toBeNull()
  })

  it('stays folded when one of its asks goes, and a new ask opens it', async () => {
    const task = taskWith([ask('a'), ask('b')])
    await render(task)
    await click('action-item-close')
    expect(q('action-fold-line')).not.toBeNull()
    await render({ ...task, user_status: { actions: [ask('b')] } } as unknown as Task)
    expect(q('action-fold-line'), 'one answered elsewhere: still folded').not.toBeNull()
    await render({ ...task, user_status: { actions: [ask('b'), ask('d')] } } as unknown as Task)
    expect(q('action-fold-line'), 'a new ask never arrives folded').toBeNull()
    expect(q('action-item')).not.toBeNull()
  })
})
