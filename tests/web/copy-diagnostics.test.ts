/**
 * Settings "Copy diagnostics" (web/src/components/settings/CopyDiagnostics.tsx),
 * mounted for real (linkedom + the web app's own React).
 *
 * Review round 1:
 *   8. the first click fetches; when the browser refuses the late clipboard
 *      write, the text is kept and shown read-only, and the NEXT click copies
 *      it synchronously inside its own gesture, without fetching again;
 *   9. the bare button carries tabIndex={0} (WebKit tabs only to those, N20);
 *  12. the Remote Hosts button counts saved hosts by the server's rule.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const apiGetText = vi.fn<(path: string, params?: Record<string, string>) => Promise<string>>()
vi.mock('@/api/client', () => ({ apiGetText: (path: string, params?: Record<string, string>) => apiGetText(path, params) }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { useCopyDiagnostics, CopyDiagnosticsLink, DiagnosticsFallback } = await import('../../web/src/components/settings/CopyDiagnostics')
const { diagnosticsQuery, hasStatusHosts } = await import('../../web/src/components/settings/diagnostics-copy')

const TEXT = 'Open Walnut doctor (server, 2026-09-25T12:00:00.000Z)\nbuild      0.4.5\n'

let doc: Document
let win: Window & typeof globalThis
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let writeText: ReturnType<typeof vi.fn>

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
  win = dom.window as unknown as Window & typeof globalThis
})

beforeEach(() => {
  apiGetText.mockReset()
  writeText = vi.fn()
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})

afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function Harness() {
  const copy = useCopyDiagnostics('all')
  // linkedom keeps no textarea value, so the harness prints the text the box is bound to.
  return createElement('div', null,
    createElement(CopyDiagnosticsLink, { copy }),
    createElement(DiagnosticsFallback, { copy, testId: 'fallback' }),
    createElement('output', { 'data-testid': 'kept' }, copy.fallbackText ?? ''))
}

async function mount(): Promise<HTMLElement> {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Harness)) })
  return host
}

const button = (host: HTMLElement) => host.querySelector('[data-testid="settings-copy-diagnostics"]') as HTMLElement
const fallback = (host: HTMLElement) => host.querySelector('[data-testid="fallback"] textarea') as HTMLTextAreaElement | null
const click = (el: HTMLElement) => el.dispatchEvent(new win.Event('click', { bubbles: true }))
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('Copy diagnostics', () => {
  it('is a tabbable button (tabIndex 0) labelled Copy diagnostics', async () => {
    const host = await mount()
    expect(button(host).getAttribute('tabindex')).toBe('0')
    expect(button(host).textContent).toBe('Copy diagnostics')
  })

  it('copies the fetched text and says Copied', async () => {
    apiGetText.mockResolvedValue(TEXT)
    writeText.mockResolvedValue(undefined)
    const host = await mount()
    await act(async () => { click(button(host)); await settle() })
    expect(apiGetText).toHaveBeenCalledWith('/api/diagnostics', { format: 'text' })
    expect(writeText).toHaveBeenCalledWith(TEXT)
    expect(button(host).textContent).toBe('Copied')
    expect(fallback(host)).toBeNull()
  })

  it('keeps the text after a refused copy, shows it, and copies it inside the next click without refetching', async () => {
    apiGetText.mockResolvedValue(TEXT)
    writeText.mockRejectedValueOnce(new Error('NotAllowedError'))
    const host = await mount()
    await act(async () => { click(button(host)); await settle() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Copy failed: the browser refused clipboard access')
    const box = fallback(host)!
    // linkedom keeps React's attribute name as written (readOnly).
    expect(box.outerHTML).toMatch(/readonly/i)
    expect(box.getAttribute('aria-label')).toBe('Diagnostics text')
    expect(host.querySelector('[data-testid="kept"]')?.textContent).toBe(TEXT)

    writeText.mockResolvedValue(undefined)
    await act(async () => {
      click(button(host))
      // Synchronously, in the gesture: no fetch, no await before the write.
      expect(writeText).toHaveBeenCalledTimes(2)
      expect(writeText).toHaveBeenLastCalledWith(TEXT)
      await settle()
    })
    expect(apiGetText).toHaveBeenCalledTimes(1)
    expect(button(host).textContent).toBe('Copied')
    expect(fallback(host)).toBeNull()
    expect(host.querySelector('[data-testid="kept"]')?.textContent).toBe('')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('reports a failed fetch and fetches again on the next click', async () => {
    apiGetText.mockRejectedValueOnce(new Error('Server unreachable')).mockResolvedValue(TEXT)
    writeText.mockResolvedValue(undefined)
    const host = await mount()
    await act(async () => { click(button(host)); await settle() })
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Copy failed: Server unreachable')
    expect(fallback(host)).toBeNull()
    await act(async () => { click(button(host)); await settle() })
    expect(apiGetText).toHaveBeenCalledTimes(2)
    expect(button(host).textContent).toBe('Copied')
  })
})

describe('diagnostics-copy helpers', () => {
  it('asks for the hosts section only from Remote Hosts', () => {
    expect(diagnosticsQuery('all')).toEqual({ format: 'text' })
    expect(diagnosticsQuery('hosts')).toEqual({ format: 'text', section: 'hosts' })
  })

  it('counts saved hosts the way the server lists them: not __local__, not disabled', () => {
    expect(hasStatusHosts({})).toBe(false)
    expect(hasStatusHosts({ hosts: {} })).toBe(false)
    expect(hasStatusHosts({ hosts: { __local__: { hostname: 'localhost' } } } as never)).toBe(false)
    expect(hasStatusHosts({ hosts: { devbox: { hostname: 'devbox.example.com', enabled: false } } } as never)).toBe(false)
    expect(hasStatusHosts({ hosts: { __local__: {}, devbox: { hostname: 'devbox.example.com' } } } as never)).toBe(true)
  })
})
