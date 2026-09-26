/**
 * The nitpick round on the attention card, pure parts and one mounted store:
 *   scroll     rowsBelow / keepRowInView / firstRowMinPx (banner-scroll.ts)
 *   appear     appearsInstantly and finalWidthOf (banner-mount-hooks.ts)
 *   bell       bellPresentation.dotKind, attentionDotsOf with a held-back row
 *   rows       splitReadinessMessage, hostCountText, headline before buttons
 *   undo       an undo line outlives the card's unmount (it moves with the card)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { BannerRow } from '../../web/src/utils/attention-banner-model'

vi.mock('@/api/hosts', () => ({ fetchHostStatus: vi.fn(async () => []), connectHost: vi.fn(), checkHostReadiness: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('@/api/ws', () => ({ wsClient: { state: 'connected', onEvent() {}, offEvent() {} } }))

const { rowsBelow, keepRowInView, firstRowMinPx } = await import('../../web/src/components/common/banner-scroll')
const { appearsInstantly, finalWidthOf, OWNER_SWITCH_MS, PAGE_LOAD_MS } = await import('../../web/src/components/common/banner-mount-hooks')
const { bellPresentation } = await import('../../web/src/utils/host-banner-placement')
const { attentionDotsOf } = await import('../../web/src/hooks/useAttentionDots')
const { splitReadinessMessage, SingleHostRow } = await import('../../web/src/components/common/HostProblemRows')
const { hostCountText } = await import('../../web/src/components/common/AttentionBanner')
const { useBannerUndo, __resetBannerUndoForTests } = await import('../../web/src/components/common/banner-undo')
const { __resetBannerSessionForTests } = await import('../../web/src/utils/attention-banner-session')
const { __resetHostActionStoreForTests } = await import('../../web/src/utils/host-action-store')

type Rect = { top: number; bottom: number; left?: number; right?: number; height?: number }
const box = (r: Rect) => ({ getBoundingClientRect: () => ({ left: 0, right: 100, width: 100, height: r.bottom - r.top, ...r }) })

describe('scroll cue and focus keeping (N3, N4)', () => {
  it('rowsBelow counts rows whose first line has not started to show', () => {
    expect(rowsBelow(200, [10, 120, 187, 189, 260])).toBe(2)
    expect(rowsBelow(200, [])).toBe(0)
  })

  it('keepRowInView keeps the row top when row-top-to-control fits, else shows the control', () => {
    const make = (rowTop: number, t: Rect) => {
      const sc = { ...box({ top: 100, bottom: 300 }), clientHeight: 200, scrollTop: 50, contains: () => true }
      const li = box({ top: rowTop, bottom: rowTop + 150 })
      const target = { ...box(t), closest: () => li }
      return { sc, target }
    }
    // The control half cut at the bottom, the row fits: scroll by the overhang only.
    let m = make(120, { top: 290, bottom: 318 })
    expect(keepRowInView(m.sc as never, m.target as never)).toBe(18)
    expect(m.sc.scrollTop).toBe(68)
    // The row's top scrolled away and row-top-to-control fits: bring the top back.
    m = make(80, { top: 150, bottom: 178 })
    expect(keepRowInView(m.sc as never, m.target as never)).toBe(-20)
    // Row taller than the list: the control alone decides.
    m = make(-200, { top: 120, bottom: 148 })
    expect(keepRowInView(m.sc as never, m.target as never)).toBe(0)
  })

  it('firstRowMinPx is the first row down to its buttons', () => {
    const li = { ...box({ top: 100, bottom: 250 }), querySelector: (s: string) => (s === '.hpb-actions' ? box({ top: 130, bottom: 162.4 }) : null) }
    const sc = { querySelector: () => li }
    expect(firstRowMinPx(sc as never)).toBe(65)
    expect(firstRowMinPx({ querySelector: () => null } as never)).toBe(0)
  })
})

describe('appear at full height (N5) and the final width while opening (N18)', () => {
  it('appearsInstantly: an owner switch or the page load, never later news', () => {
    expect(appearsInstantly(0, 60_000)).toBe(true)
    expect(appearsInstantly(OWNER_SWITCH_MS - 1, 60_000)).toBe(true)
    expect(appearsInstantly(OWNER_SWITCH_MS + 1, 60_000)).toBe(false)
    expect(appearsInstantly(60_000, PAGE_LOAD_MS - 1)).toBe(true)
  })

  it('finalWidthOf reads px, and % of the flex parent less its padding', () => {
    const g = globalThis as unknown as { getComputedStyle?: unknown }
    const prev = g.getComputedStyle
    g.getComputedStyle = () => ({ paddingLeft: '10px', paddingRight: '10px' })
    const parent = { getBoundingClientRect: () => ({ width: 1244 }) }
    expect(finalWidthOf({ style: { width: '25%' }, parentElement: parent } as never)).toBe(306)
    expect(finalWidthOf({ style: { width: '320px' }, parentElement: parent } as never)).toBe(320)
    g.getComputedStyle = prev
  })
})

describe('the bell (N9, N16)', () => {
  const base = { attentionCount: 0, quiet: false, quietLabel: '', collapsed: false }
  it('a host or local reason wears the attention look; the git sync dot alone keeps the system look', () => {
    expect(bellPresentation({ ...base, reason: 'hosts', hasIssues: true }).dotKind).toBe('attention')
    expect(bellPresentation({ ...base, reason: 'local', hasIssues: false }).dotKind).toBe('attention')
    expect(bellPresentation({ ...base, reason: null, hasIssues: true }).dotKind).toBe('system')
    expect(bellPresentation({ ...base, reason: null, hasIssues: false }).dotKind).toBe(null)
    expect(bellPresentation({ ...base, attentionCount: 2, reason: 'hosts', hasIssues: false })).toMatchObject({ cornerDot: true, dotKind: 'attention' })
  })

  it('a held-back host row lights the bell on Home with the card on screen, never the rail dot', () => {
    const at = { localOn: false, where: 'tasks' as const, pathname: '/', hash: '' }
    expect(attentionDotsOf({ ...at, hostOn: true })).toEqual({ railSettingsDot: false, bellReason: null })
    expect(attentionDotsOf({ ...at, hostOn: true, deferred: true })).toEqual({ railSettingsDot: false, bellReason: 'hosts' })
    expect(attentionDotsOf({ ...at, hostOn: false, deferred: true })).toEqual({ railSettingsDot: false, bellReason: null })
  })
})

describe('rows name their host first (N10, N15, N3)', () => {
  it('splitReadinessMessage: the first sentence is the headline, the rest the detail', () => {
    expect(splitReadinessMessage('Claude Code on Sign box is not signed in. Run `ssh -t alice@sign.example.com claude` once, then Check again.'))
      .toEqual({ head: 'Claude Code on Sign box is not signed in.', rest: 'Run `ssh -t alice@sign.example.com claude` once, then Check again.' })
    expect(splitReadinessMessage('Claude Code is not installed on Fix box.')).toEqual({ head: 'Claude Code is not installed on Fix box.', rest: '' })
  })

  it('hostCountText counts each host once, shown or behind and N more; success rows do not count', () => {
    const r = (id: string, hosts: string[], type: BannerRow['type'] = 'connect') => ({ id, type, hosts } as unknown as BannerRow)
    expect(hostCountText([r('a', ['keybox']), r('cred', ['certbox', 'certbox2']), r('ok', ['devbox'], 'ready')], ['netbox'])).toBe('4 hosts')
    expect(hostCountText([r('a', ['keybox'])], [])).toBe('1 host')
    expect(hostCountText([r('ok', ['devbox'], 'ready')], [])).toBe('')
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
  __resetBannerUndoForTests()
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

describe('mounted', () => {
  it('a readiness row: bold first-sentence headline, then its buttons, then the rest (N10, N15)', async () => {
    const row = {
      id: 'host:signbox', type: 'readiness', group: 'readiness', hosts: ['signbox'], labels: ['Sign box'], kind: 'claude_not_logged_in',
      problem: { kind: 'claude_not_logged_in', message: 'Claude Code on Sign box is not signed in. Run the command once, then Check again.', commands: ['ssh -t alice@sign.example.com claude'] },
      dismissKeys: ['signbox|claude_not_logged_in|'], actions: ['checkAgain', 'openSettings'],
    } as unknown as BannerRow
    await act(async () => { root!.render(createElement(SingleHostRow, { row, defaultExpanded: true, onDismiss: () => {}, onOpenSettings: () => {} })) })
    const li = host.querySelector('li.hpb-row')!
    const head = li.querySelector('.hpb-headline')!
    expect(head.textContent).toBe('Claude Code on Sign box is not signed in.')
    const order = Array.from(li.querySelectorAll('.hpb-headline, button, .hpb-rest')).map((e) => e.className.split(' ')[0] + ':' + (e.textContent ?? '').trim().slice(0, 12))
    expect(order[0]).toBe('hpb-message:Claude Code ')
    expect(order[1]).toMatch(/^setup-step-btn:Check again/)
    expect(order.findIndex((o) => o.startsWith('hpb-rest'))).toBeGreaterThan(1)
    expect(order[order.length - 1]).toMatch(/^setup-banner-dismiss/)
  })

  it('an undo line outlives the card: the next mount (the other panel) shows it (N8)', async () => {
    let add: ((e: never) => void) | null = null
    const Probe = ({ onEntries }: { onEntries: (n: number) => void }) => {
      const u = useBannerUndo({ pointerInside: false, reducedMotion: () => false, onGone: () => {}, root: null })
      add = u.add as never
      onEntries(u.entries.length)
      return null
    }
    let seen = -1
    await act(async () => { root!.render(createElement(Probe, { onEntries: (n: number) => { seen = n } })) })
    await act(async () => { add!({ id: 'row:host:certbox', kind: 'row', index: 1, height: 40, restore: () => {} } as never) })
    expect(seen).toBe(1)
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    seen = -1
    await act(async () => { root!.render(createElement(Probe, { onEntries: (n: number) => { seen = n } })) })
    expect(seen).toBe(1)
  })
})
