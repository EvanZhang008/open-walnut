/**
 * The row-disclosure store (web/src/components/sessions/row-disclosure.ts): an
 * open state named by what it shows outlives the element that showed it, so a
 * live row and the saved row that replaces it (another component, another
 * parent) read the same state. Mounted for real: react-dom over linkedom.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import {
  RowDisclosureScope,
  useRowDisclosure,
  __resetRowDisclosuresForTests,
} from '../../web/src/components/sessions/row-disclosure'

beforeAll(() => {
  const { window } = parseHTML('<!doctype html><html><body></body></html>')
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
})
beforeEach(() => __resetRowDisclosuresForTests())

let toggle: (() => void) | null = null
function Live({ id }: { id?: string }) {
  const [open, setOpen] = useRowDisclosure(id, false)
  toggle = () => setOpen((o) => !o)
  return createElement('div', { 'data-live': '', 'data-open': String(open) })
}
function Saved({ id }: { id?: string }) {
  const [open] = useRowDisclosure(id, false)
  return createElement('section', { 'data-saved': '', 'data-open': String(open) })
}

async function mount(scope: string | null, node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(createElement(RowDisclosureScope.Provider, { value: scope }, node)) })
  return {
    host,
    render: async (next: ReturnType<typeof createElement>) => {
      await act(async () => { root.render(createElement(RowDisclosureScope.Provider, { value: scope }, next)) })
    },
    unmount: async () => { await act(async () => { root.unmount() }) },
  }
}

describe('useRowDisclosure', () => {
  it('a run opened while live is open in the saved row that replaces it', async () => {
    const m = await mount('s1', createElement('div', null, createElement(Live, { id: 'run-tu1' })))
    await act(async () => { toggle!() })
    expect(m.host.querySelector('[data-live]')!.getAttribute('data-open')).toBe('true')
    // Another component under another parent: React builds it anew.
    await m.render(createElement('article', null, createElement(Saved, { id: 'run-tu1' })))
    expect(m.host.querySelector('[data-live]')).toBeNull()
    expect(m.host.querySelector('[data-saved]')!.getAttribute('data-open')).toBe('true')
    await m.unmount()
  })

  it('another session, another id or no scope starts closed', async () => {
    const a = await mount('s1', createElement(Live, { id: 'run-tu1' }))
    await act(async () => { toggle!() })
    await a.unmount()
    const other = await mount('s2', createElement(Saved, { id: 'run-tu1' }))
    expect(other.host.querySelector('[data-saved]')!.getAttribute('data-open')).toBe('false')
    await other.unmount()
    const otherId = await mount('s1', createElement(Saved, { id: 'run-tu2' }))
    expect(otherId.host.querySelector('[data-saved]')!.getAttribute('data-open')).toBe('false')
    await otherId.unmount()
    const noScope = await mount(null, createElement(Saved, { id: 'run-tu1' }))
    expect(noScope.host.querySelector('[data-saved]')!.getAttribute('data-open')).toBe('false')
    await noScope.unmount()
  })

  it('an element that comes to show another thing hands its state on, or takes the one that thing had', async () => {
    // A reasoning row opened, then a tool joined it: the row now shows the run.
    const m = await mount('s1', createElement(Live, { id: 'run-msg1' }))
    await act(async () => { toggle!() })
    await m.render(createElement(Live, { id: 'run-tu9' }))
    expect(m.host.querySelector('[data-live]')!.getAttribute('data-open')).toBe('true')
    await m.render(createElement('p', null, createElement(Saved, { id: 'run-tu9' })))
    expect(m.host.querySelector('[data-saved]')!.getAttribute('data-open')).toBe('true')
    await m.unmount()
  })

  it('closing is kept too', async () => {
    function OpenByDefault({ id }: { id: string }) {
      const [open, setOpen] = useRowDisclosure(id, true)
      toggle = () => setOpen((o) => !o)
      return createElement('div', { 'data-plan': '', 'data-open': String(open) })
    }
    const m = await mount('s1', createElement(OpenByDefault, { id: 'plan-tu1' }))
    await act(async () => { toggle!() })
    await m.render(createElement('section', null, createElement(OpenByDefault, { id: 'plan-tu1' })))
    expect(m.host.querySelector('[data-plan]')!.getAttribute('data-open')).toBe('false')
    await m.unmount()
  })
})
