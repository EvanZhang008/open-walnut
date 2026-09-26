/**
 * The third nitpick round on the attention card (banner placement slice), the
 * pure parts and one mounted row:
 *   N1   dense rows: several entries start as headline + primary action
 *   N2   the host list is the one scroll region (scrollMaxPx budget)
 *   N9   the visible part ends on a row or line boundary
 *   N7   an undo line keeps about one row (undoLinePx)
 *   N15  the subhead count does not repeat 'hosts'
 *   N5   the notification panel keeps Tab inside (wrapTarget)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { BannerRow } from '../../web/src/utils/attention-banner-model'

vi.mock('@/api/hosts', () => ({ fetchHostStatus: vi.fn(async () => []), connectHost: vi.fn(), checkHostReadiness: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('@/api/ws', () => ({ wsClient: { state: 'connected', onEvent() {}, offEvent() {} } }))

const { scrollMaxPx, undoLinePx } = await import('../../web/src/components/common/banner-scroll')
const { SingleHostRow, GroupRow } = await import('../../web/src/components/common/HostProblemRows')
const hostsApi = await import('@/api/hosts') as unknown as { connectHost: ReturnType<typeof vi.fn> }
const { hostCount, hostCountText, subheadCountText } = await import('../../web/src/components/common/AttentionBanner')
const { wrapTarget } = await import('../../web/src/hooks/useDialogFocus')
const { __resetBannerSessionForTests } = await import('../../web/src/utils/attention-banner-session')
const { __resetHostActionStoreForTests } = await import('../../web/src/utils/host-action-store')

const r = (id: string, hosts: string[], type = 'connect') => ({ id, hosts, type }) as unknown as BannerRow

describe('the host list budget (N2, N9)', () => {
  it('everything fits: no clamp at all', () => {
    expect(scrollMaxPx(300, 90, 48, 200, [46, 92, 138, 200])).toBeNull()
  })
  it('the list takes what the cap leaves after the rest of the card, ending on the last boundary that fits', () => {
    // cap 300, rest 90: 210 for the list; rows end at 46, 98, 150, 202, 254.
    expect(scrollMaxPx(300, 90, 48, 254, [18, 46, 70, 98, 122, 150, 174, 202, 226, 254])).toBe(202)
    // A headline line (226) fits a 230 budget where its buttons (254) do not: end under the headline.
    expect(scrollMaxPx(300, 70, 48, 254, [18, 46, 70, 98, 122, 150, 174, 202, 226, 254])).toBe(226)
  })
  it('never less than the first row: a tall local section makes the card taller, not a second scroll region', () => {
    expect(scrollMaxPx(220, 200, 66, 272, [34, 66, 70, 134])).toBe(66)
  })
  it('no boundary inside the budget: the budget itself (still at least the first row)', () => {
    expect(scrollMaxPx(300, 100, 40, 500, [260, 500])).toBe(200)
  })
})

describe('undo line height (N7)', () => {
  const li = (whole: number, actionsBottom: number | null, headBottom = 18) => ({
    getBoundingClientRect: () => ({ top: 0, bottom: whole, height: whole }),
    querySelector: (sel: string) => {
      if (sel === '.hpb-actions') return actionsBottom == null ? null : { getBoundingClientRect: () => ({ bottom: actionsBottom }) }
      return { getBoundingClientRect: () => ({ bottom: headBottom }) }
    },
  }) as unknown as HTMLElement
  it('an opened 222px row leaves a line about one row tall (its head), not 222px of blank card', () => {
    expect(undoLinePx(li(222, 52))).toBe(54)
  })
  it('a short row keeps its own height; the line is never shorter than two x boxes apart (34px)', () => {
    expect(undoLinePx(li(46, 44))).toBe(46)
    expect(undoLinePx(li(30, 16, 16))).toBe(30)
    expect(undoLinePx(li(60, 20))).toBe(34)
  })
})

describe('counts (N15)', () => {
  const rows = [r('a', ['keybox']), r('cred', ['certbox', 'certbox2']), r('ok', ['devbox'], 'ready')]
  it("the title says '4 hosts'; the 'Remote hosts' subhead says '(4)', never 'Remote hosts 4 hosts'", () => {
    expect(hostCount(rows, ['netbox'])).toBe(4)
    expect(hostCountText(rows, ['netbox'])).toBe('4 hosts')
    expect(subheadCountText(rows, ['netbox'])).toBe('(4)')
    expect(subheadCountText([], [])).toBe('')
  })
})

describe('the panel keeps Tab inside (N5)', () => {
  const a = {} as HTMLElement, b = {} as HTMLElement, c = {} as HTMLElement
  it('Tab from the last stop wraps to the first; Shift+Tab from the first wraps to the last', () => {
    expect(wrapTarget([a, b, c], c, false)).toBe(a)
    expect(wrapTarget([a, b, c], a, true)).toBe(c)
  })
  it('inside the list the browser moves focus itself; from the panel or from nowhere, focus enters at an end', () => {
    expect(wrapTarget([a, b, c], b, false)).toBeNull()
    expect(wrapTarget([a, b, c], b, true)).toBeNull()
    const panel = {} as HTMLElement
    expect(wrapTarget([a, b, c], panel, false)).toBe(a)
    expect(wrapTarget([a, b, c], panel, true)).toBe(c)
    expect(wrapTarget([], panel, false)).toBeNull()
  })
})

let doc: Document
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let host: HTMLElement
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  __resetBannerSessionForTests()
  __resetHostActionStoreForTests()
  host = doc.createElement('div')
  doc.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

describe('dense rows (N1)', () => {
  const keybox = {
    id: 'host:keybox', type: 'connect', group: 'connect', hosts: ['keybox'], labels: ['Key box'], kind: 'auth',
    headline: 'Could not connect to Key box', hint: 'Walnut runs `ssh alice@key.example.com` without a password prompt.',
    summary: 'Permission denied (publickey).', dismissKeys: ['keybox|connect'], actions: ['retry', 'openSettings'],
  } as unknown as BannerRow
  const render = async (props: Record<string, unknown>) => {
    await act(async () => { root!.render(createElement(SingleHostRow, { row: keybox, onDismiss: () => {}, onOpenSettings: () => {}, ...props } as never)) })
    return host.querySelector('li.hpb-row')!
  }
  const texts = (li: Element) => Array.from(li.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())

  it('a dense row starts closed: its headline, its primary action, Show details, the x; no hint', async () => {
    const li = await render({ dense: true, defaultExpanded: false })
    expect(li.classList.contains('hpb-dense')).toBe(true)
    expect(li.classList.contains('hpb-open')).toBe(false)
    expect(texts(li)).toEqual(['Retry', 'Show details', '×'])
    expect(li.querySelector('.hft-hint')).toBeNull()
  })
  it('opened by the user, a dense row shows every action and the details', async () => {
    const li = await render({ dense: true, defaultExpanded: false })
    const toggle = Array.from(li.querySelectorAll('button')).find((b) => b.textContent === 'Show details')!
    await act(async () => { toggle.dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true }) as Event) })
    const open = host.querySelector('li.hpb-row')!
    expect(open.classList.contains('hpb-open')).toBe(true)
    expect(texts(open)).toContain('Open Settings')
    expect(open.querySelector('.hft-hint')).not.toBeNull()
  })
  it('a lone row (not dense) opens by position with all of its actions, as before', async () => {
    const li = await render({ dense: false, defaultExpanded: true })
    expect(li.classList.contains('hpb-dense')).toBe(false)
    expect(texts(li).slice(0, 2)).toEqual(['Retry', 'Open Settings'])
  })
})

describe('a credential row shares the one attempt store (C48)', () => {
  const cred = {
    id: 'cred:cert_expired', type: 'connect', group: 'connect', hosts: ['certbox'], labels: ['Cert box'], kind: 'cert_expired',
    headline: 'Could not connect to Cert box: SSH certificate expired', hint: 'Renew the certificate.', summary: '',
    dismissKeys: ['certbox|connect'], actions: ['retry', 'openSettings'],
  } as unknown as BannerRow
  it('Retry in one mount: a second mount of the same row reads Retrying..., disabled, and no second request goes', async () => {
    let answer!: (v: unknown) => void
    hostsApi.connectHost.mockReset()
    hostsApi.connectHost.mockImplementation(() => new Promise((r) => { answer = r }))
    const two = doc.createElement('div')
    doc.body.appendChild(two)
    const root2 = createRoot(two)
    const props = { row: cred, defaultExpanded: false, onDismiss: () => {}, onOpenSettings: () => {} }
    await act(async () => { root!.render(createElement(GroupRow, props as never)) })
    const retry = () => host.querySelector<HTMLButtonElement>('[data-testid="hpb-retry"]')!
    await act(async () => { retry().dispatchEvent(new (doc.defaultView as unknown as typeof globalThis).Event('click', { bubbles: true }) as Event) })
    // The other panel mounts the same row while the request is in flight.
    await act(async () => { root2.render(createElement(GroupRow, props as never)) })
    const other = two.querySelector<HTMLButtonElement>('[data-testid="hpb-retry"]')!
    expect(other.textContent).toBe('Retrying...')
    expect(other.disabled).toBe(true)
    expect(hostsApi.connectHost).toHaveBeenCalledTimes(1)
    await act(async () => { answer(undefined) })
    await act(async () => { root2.unmount() })
  })
})
