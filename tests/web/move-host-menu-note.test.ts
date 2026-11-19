/**
 * The Move to host menu (web/src/components/transfer/MoveHostMenuItems.tsx) lists the cloud
 * box like any host, and says beside its name what it is (the server's `note` on its
 * /api/v1/hosts/load row): a small machine that costs money while it works.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const NOTE = 'The cloud box: a small machine that costs money while it works; pick it when asked.'
const row = (host: string, label: string, extra: Record<string, unknown> = {}) => ({
  host, label, known: true, busy: false, reasons: [], loadPerCpu: 0.2, cpus: 4, running: 0, runningLimit: 4, ...extra,
})
const api = vi.hoisted(() => ({ hosts: [] as unknown[] }))
vi.mock('@/api/client', () => ({
  apiGet: async (url: string) => url.includes('/hosts/load')
    ? { hosts: api.hosts }
    : { sessions: [{ host: null, active: true }] },
  apiPost: async () => ({}),
}))
vi.mock('@/utils/session-status', () => ({ resolveTaskSessionId: () => 'sid-1' }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { MoveHostMenuItems } = await import('../../web/src/components/transfer/MoveHostMenuItems')

let doc: Document
let el: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

describe('Move to host: the cloud box row', () => {
  it('stays listed, with the server\'s note beside its name; other hosts carry none', async () => {
    api.hosts = [row('__local__', 'this Mac'), row('devbox', 'Dev box'), row('__cloudbox__', 'Cloud', { note: NOTE, autoPick: false })]
    await act(async () => { root!.render(createElement(MoveHostMenuItems, { task: { id: 't1' } as never, afterAction: () => {} })) })
    const toggle = el.querySelector('[data-testid="kebab-move-host-toggle"]') as HTMLElement
    await act(async () => { toggle.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('click', { bubbles: true })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    const box = el.querySelector('[data-testid="kebab-move-host-__cloudbox__"]')
    expect(box?.textContent).toContain('Move to Cloud')
    expect(el.querySelector('[data-testid="kebab-move-host-note-__cloudbox__"]')?.textContent).toBe(NOTE)
    expect(box?.getAttribute('title')).toContain(NOTE)
    expect(el.querySelector('[data-testid="kebab-move-host-devbox"]')).toBeTruthy()
    expect(el.querySelector('[data-testid="kebab-move-host-note-devbox"]')).toBeNull()
  })
})
