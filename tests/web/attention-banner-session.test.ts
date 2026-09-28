/**
 * The attention card's page-session memory (attention-banner-session.ts) and
 * the card's pure helpers (undo timing, the height cap):
 *
 *   remount    the frame state, the hidden success rows and every row's
 *              expanded flag outlive a mount (an owner switch continues)
 *   return     a success that completed while NO card was mounted is not
 *              replayed; one already on screen keeps its 3s
 *   undo       the later of 5s and the pointer leaving, 10s at most; clicks
 *              in the first 400ms are ignored; an undo line keeps its place
 *   cap        the whole card is at most max(40% of its container, 132px)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_BANNER_STATE, READY_HOLD_MS, nextBanner, type BannerInput,
} from '../../web/src/utils/attention-banner-model'
import type { HostStatusInput } from '../../src/core/hosts/host-problem'

const logs = vi.hoisted(() => [] as Array<{ sub: string; msg: string; data?: Record<string, unknown> }>)
vi.mock('@/utils/log', () => ({ log: {
  debug: () => {}, warn: () => {}, error: () => {},
  info: (sub: string, msg: string, data?: Record<string, unknown>) => { logs.push({ sub, msg, data }) },
} }))
const api = vi.hoisted(() => {
  const o = { statuses: [] as unknown[], fetchHostStatus: (() => Promise.resolve([])) as () => Promise<unknown[]>, connectHost: () => new Promise(() => {}), checkHostReadiness: () => new Promise(() => {}) }
  o.fetchHostStatus = () => Promise.resolve(o.statuses)
  return o
})
vi.mock('@/api/hosts', () => ({
  fetchHostStatus: () => api.fetchHostStatus(), connectHost: () => api.connectHost(), checkHostReadiness: () => api.checkHostReadiness(),
}))
vi.mock('@/api/ws', () => ({ wsClient: { state: 'connected', onEvent() {}, offEvent() {} } }))
vi.mock('@/hooks/useIsCloudReplica', () => ({ useIsCloudReplica: () => false }))
vi.mock('@/utils/local-claude-recheck', () => ({ recheckLocalClaudeNow: async () => {} }))
const nav = vi.hoisted(() => ({ order: [] as string[], openHostSettings: null as unknown as ReturnType<typeof import('vitest').vi.fn> }))
vi.mock('@/utils/host-settings-nav', async () => {
  const { vi: v } = await import('vitest')
  nav.openHostSettings = v.fn((_n: unknown, alias?: string, opts?: unknown) => { nav.order.push(`open:${alias ?? ''}:${JSON.stringify(opts ?? null)}`) })
  return { openHostSettings: nav.openHostSettings }
})

const session = await import('../../web/src/utils/attention-banner-session')
const undoMod = await import('../../web/src/components/common/banner-undo')
const hooks = await import('../../web/src/components/common/attention-banner-hooks')

const NOW = 1_000_000_000
type S = HostStatusInput & { label: string }
const failed = (host: string, label: string, extra: Partial<S> = {}): S => ({
  host, label, connected: false, phase: 'failed', kind: 'unreachable', error: 'ssh: no route', hint: 'Check the network, then Retry.',
  retryable: true, at: NOW, ...extra,
})
const healthy = (host: string, label: string, at = NOW): S => ({
  host, label, connected: true, phase: 'connected', connectedAt: at - 60_000, at,
  readiness: { checkedAt: at - 1_000, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280' } },
})
const input = (statuses: S[], now = NOW, extra: Partial<BannerInput> = {}): BannerInput => ({ statuses, dismissed: new Set(), now, ...extra })

beforeEach(() => { session.__resetBannerSessionForTests(); undoMod.__resetBannerUndoForTests() })

describe('the session keeps the card across mounts', () => {
  it('frame state, hidden success rows and the expanded flags survive (the next mount reads them)', () => {
    const r = nextBanner(input([failed('netbox', 'Net box'), failed('keybox', 'Key box')]))
    session.setBannerState(r.state)
    session.setHiddenReady(new Map([['ready:devbox', NOW + 3_000]]))
    session.setRowExpanded('host:keybox', true)
    session.setRowExpanded('host:netbox', false)
    expect(session.getBannerState().order.map((x) => x.id)).toEqual(['host:netbox', 'host:keybox'])
    expect(session.getHiddenReady().get('ready:devbox')).toBe(NOW + 3_000)
    expect(session.getRowExpanded('host:keybox')).toBe(true)
    expect(session.getRowExpanded('host:netbox')).toBe(false)
    expect(session.getRowExpanded('host:proxybox')).toBeUndefined()
  })

  it('an expanded flag notifies once per real change', () => {
    const seen = vi.fn()
    const off = session.subscribeRowExpanded(seen)
    session.setRowExpanded('host:netbox', true)
    session.setRowExpanded('host:netbox', true)
    session.setRowExpanded('host:netbox', false)
    off()
    session.setRowExpanded('host:netbox', true)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('an owner switch is never a return; a remount after a gap with no card is', () => {
    vi.useFakeTimers({ now: 10_000 })
    try {
      expect(session.isResumingAfterGap()).toBe(false)
      const a = session.cardMounted()
      // The new owner renders before the old one's cleanup: a card is still counted.
      expect(session.isResumingAfterGap()).toBe(false)
      const b = session.cardMounted()
      a()
      expect(session.isResumingAfterGap()).toBe(false)
      b()
      vi.setSystemTime(10_000 + session.RESUME_GAP_MS / 2)
      expect(session.isResumingAfterGap()).toBe(false)
      vi.setSystemTime(10_000 + session.RESUME_GAP_MS + 1)
      expect(session.isResumingAfterGap()).toBe(true)
      const c = session.cardMounted()
      expect(session.isResumingAfterGap()).toBe(false)
      c(); c()
      expect(session.isResumingAfterGap()).toBe(false)
    } finally { vi.useRealTimers() }
  })
})

describe('a success that completed while no card was mounted is not replayed', () => {
  it('a heal seen for the first time on a return drops its success row; one already held keeps it', () => {
    const first = nextBanner(input([failed('netbox', 'Net box'), failed('keybox', 'Key box')]))
    // netbox heals while a card is on screen: its success row is held.
    const second = nextBanner(input([healthy('netbox', 'Net box'), failed('keybox', 'Key box')], NOW + 100), first.state)
    expect(second.view.rows.map((r) => r.id)).toEqual(['ready:netbox', 'host:keybox'])
    // No card for a while; keybox heals then; the card comes back within netbox's 3s.
    const back = nextBanner(input([healthy('netbox', 'Net box'), healthy('keybox', 'Key box')], NOW + 200), second.state)
    expect(back.view.rows.map((r) => r.id)).toEqual(['ready:netbox', 'ready:keybox'])
    const kept = session.withoutReplayedReady(back, second.state)
    expect(kept.view.rows.map((r) => r.id)).toEqual(['ready:netbox'])
    expect(kept.state.order.map((r) => r.id)).toEqual(['ready:netbox'])
    expect(Object.keys(kept.state.ready)).toEqual(['ready:netbox'])
    // The next frame does not bring it back.
    const after = nextBanner(input([healthy('netbox', 'Net box'), healthy('keybox', 'Key box')], NOW + 300), kept.state)
    expect(after.view.rows.map((r) => r.id)).toEqual(['ready:netbox'])
    const later = nextBanner(input([healthy('netbox', 'Net box'), healthy('keybox', 'Key box')], NOW + 100 + READY_HOLD_MS + 1), after.state)
    expect(later.view.rows).toEqual([])
  })

  it('nothing to drop: the same object comes back', () => {
    const r = nextBanner(input([failed('netbox', 'Net box')]))
    expect(session.withoutReplayedReady(r, EMPTY_BANNER_STATE)).toBe(r)
  })
})

describe('undo lines (spec 5.1, C54)', () => {
  const { undoCollapseAt, undoClickCounts, withUndoSlots, UNDO_MIN_MS, UNDO_MAX_MS, UNDO_GUARD_MS } = undoMod
  it('collapses after the later of 5s and the pointer leaving, 10s at most', () => {
    // Pointer never inside: 5s.
    expect(undoCollapseAt(0, false, 100)).toBe(UNDO_MIN_MS)
    // Pointer inside: the 10s cap is the only clock.
    expect(undoCollapseAt(0, true, 100)).toBe(UNDO_MAX_MS)
    // Pointer left at 7s: now.
    expect(undoCollapseAt(0, false, 7_000)).toBe(7_000)
    // Pointer left at 12s: the cap already passed.
    expect(undoCollapseAt(0, false, 12_000)).toBe(UNDO_MAX_MS)
  })

  it('ignores a click in the first 400ms (the second click of a double click on the x)', () => {
    expect(undoClickCounts(1_000, 1_000 + UNDO_GUARD_MS - 1)).toBe(false)
    expect(undoClickCounts(1_000, 1_000 + UNDO_GUARD_MS)).toBe(true)
  })

  it("puts each row's undo line back where the row stood", () => {
    const rows = [{ id: 'a' }, { id: 'c' }, { id: 'e' }]
    const entry = (id: string, index: number) => ({ id, kind: 'row' as const, index, height: 30, shownAt: 0, collapsing: false, restore: () => {} })
    const slots = withUndoSlots(rows, [entry('row:d', 3), entry('row:b', 1), { ...entry('all', 0), kind: 'all' as const }])
    expect(slots.map((s) => ('row' in s ? s.row.id : s.undo.id))).toEqual(['a', 'row:b', 'c', 'row:d', 'e'])
    // A place past the end clamps to the end.
    expect(withUndoSlots([], [entry('row:z', 4)]).map((s) => ('undo' in s ? s.undo.id : ''))).toEqual(['row:z'])
  })
})

describe('the height cap (C28, C29, C61)', () => {
  it('max(40% of the mount container, 132px), by mount', () => {
    expect(hooks.cardCapPx(900)).toBe(360)
    expect(hooks.cardCapPx(560)).toBe(224)
    expect(hooks.cardCapPx(300)).toBe(132)
    expect(hooks.cardCapPx(0)).toBe(132)
    // The card's own margins count inside the 40%, so the body below keeps 60% (C29).
    expect(hooks.cardCapPx(900, 20)).toBe(340)
    expect(hooks.cardCapPx(360, 20)).toBe(132)
    expect(hooks.MOUNT_CONTAINER).toEqual({
      tasks: '.todo-panel', slot: '.main-page-chat',
      draft: '.main-page-session-column, .draft-session-panel',
    })
  })
})

// ── The card mounted for real (linkedom + the web app's own React, the real host store) ──

describe('the card mounted', async () => {
  const { parseHTML } = await import('linkedom')
  const { createElement, act } = await import('../../web/node_modules/react/index.js')
  const { createRoot } = await import('../../web/node_modules/react-dom/client.js')
  const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')
  const { AttentionBanner } = await import('../../web/src/components/common/AttentionBanner')
  const hostStore = await import('../../web/src/hooks/useHostStatus')
  const dismiss = await import('../../web/src/utils/host-banner-dismiss')
  const { __resetUserRetryForTests } = await import('../../web/src/utils/host-user-retrying')
  const { __resetHostActionStoreForTests } = await import('../../web/src/utils/host-action-store')

  class MemStorage {
    private m = new Map<string, string>()
    getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
    setItem(k: string, v: string) { this.m.set(k, String(v)) }
    removeItem(k: string) { this.m.delete(k) }
    clear() { this.m.clear() }
  }
  let at = 1_900_000_000_000
  const wire = (host: string, label: string) => ({
    host, label, hostname: `${host}.example.com`, connected: false, phase: 'failed', phaseLabel: '', steps: [],
    phaseElapsedMs: 0, connectElapsedMs: 0, at: ++at, serverNow: at, kind: 'unreachable', error: 'ssh: no route',
    hint: `${label} is not reachable from this machine.`, retryable: true,
  })
  const five = () => [wire('netbox', 'Net box'), wire('keybox', 'Key box'), wire('proxybox', 'Proxy box'), wire('barebox', 'Bare box'), wire('farbox', 'Far box')]
  let root: { render: (n: unknown) => void; unmount: () => void } | null = null
  let host: HTMLElement
  let win: Window & typeof globalThis
  const card = () => host.querySelector<HTMLElement>('[data-testid="attention-banner"]')
  const rowIds = () => Array.from(host.querySelectorAll('li.hpb-row[data-host]')).map((li) => li.getAttribute('data-host'))
  const button = (name: string) => Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === name || (b.textContent ?? '').trim() === name)
  const click = async (el: Element | undefined) => { await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true })) }) }
  const mount = async (props: Record<string, unknown> = {}) => {
    await act(async () => {
      root!.render(createElement(MemoryRouter, null, createElement(AttentionBanner, { mount: 'tasks', onNavigateSettings: () => {}, ...props })))
    })
  }
  const remount = async (props: Record<string, unknown> = {}) => {
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    await mount(props)
  }

  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    // linkedom has no Node constructor on its window; the card reads one constant from it.
    const WinNode = (dom.window as unknown as { Node?: { DOCUMENT_POSITION_FOLLOWING?: number } }).Node
    g.Node = WinNode?.DOCUMENT_POSITION_FOLLOWING ? WinNode : class { static DOCUMENT_POSITION_FOLLOWING = 4 }
    win = dom.window as unknown as Window & typeof globalThis
  })
  beforeEach(async () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
    dismiss.__resetHostBannerDismissForTests()
    hostStore.__resetHostStatusForTests()
    __resetUserRetryForTests()
    __resetHostActionStoreForTests()
    logs.length = 0
    nav.order.length = 0
    api.statuses = five()
    await hostStore.hydrateHostStatus({ force: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    vi.useRealTimers()
    if (root) { await act(async () => { root!.unmount() }); root = null }
    document.body.innerHTML = ''
  })

  it('carries data-mount, and has no live region of its own (the announcer speaks, C64)', async () => {
    await mount({ mount: 'slot' })
    expect(card()?.getAttribute('data-mount')).toBe('slot')
    expect(card()?.querySelector('[aria-live]')).toBeNull()
    expect(card()?.querySelector('[role="status"]')).toBeNull()
    expect(rowIds()).toEqual(['netbox', 'keybox', 'proxybox'])
  })

  it('a row x becomes an undo line in place (same place, no data-host); the log names the mount (C54, C41)', async () => {
    await mount()
    await click(button('Dismiss Key box'))
    const lines = Array.from(host.querySelectorAll('.hpb-rows > li'))
    // Four problems left: the cap shows all four (the model's rule), the undo line holds keybox's place.
    expect(lines.map((li) => li.getAttribute('data-host') ?? li.getAttribute('data-undo-id'))).toEqual(['netbox', 'row:host:keybox', 'proxybox', 'barebox', 'farbox'])
    const undo = host.querySelector('[data-undo-id="row:host:keybox"]')!
    // The line names what it hid (N3-13).
    expect(undo.textContent).toBe('Key box hidden until it changes.Undo')
    expect(undo.querySelector('.hpb-undo')?.textContent).toBe('Undo')
    expect(dismiss.getHostDismissed().has('keybox|connect')).toBe(true)
    expect(logs.find((l) => l.msg === 'row dismissed')?.data).toMatchObject({ row: 'host:keybox', mount: 'tasks' })
    // Dismissed in one place, dismissed in all: the slot's card has no keybox row (C9, C10).
    await remount({ mount: 'slot' })
    expect(rowIds()).not.toContain('keybox')
    expect(rowIds()).toEqual(['netbox', 'proxybox', 'barebox', 'farbox'])
  })

  it('Undo in the first 400ms does nothing; after that the row returns in its place and the key is gone (C54)', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    await mount()
    await click(button('Dismiss Key box'))
    await click(button('Undo'))
    expect(dismiss.getHostDismissed().has('keybox|connect')).toBe(true)
    vi.setSystemTime(Date.now() + 450)
    await click(button('Undo'))
    expect(dismiss.getHostDismissed().has('keybox|connect')).toBe(false)
    expect(rowIds()).toEqual(['netbox', 'keybox', 'proxybox'])
    expect(host.querySelector('[data-undo-id]')).toBeNull()
  })

  it('the undo line collapses after 5s with the pointer outside, and focus inside it moves to the next row x', async () => {
    vi.useFakeTimers({ now: Date.now() })
    await mount()
    let active: Element | null = null
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => active })
    const focus = vi.spyOn(win.HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement) { active = this })
    await click(button('Dismiss Net box'))
    // After the x: focus is on Undo.
    expect(active).toBe(host.querySelector('[data-undo-id="row:host:netbox"] .hpb-undo'))
    await act(async () => { vi.advanceTimersByTime(4_900) })
    expect(host.querySelector('[data-undo-id="row:host:netbox"]')).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(host.querySelector('.hpb-undo-collapsing')).not.toBeNull()
    await act(async () => { vi.advanceTimersByTime(200) })
    expect(host.querySelector('[data-undo-id]')).toBeNull()
    expect(active).toBe(button('Dismiss Key box'))
    focus.mockRestore()
    delete (document as unknown as Record<string, unknown>).activeElement
  })

  it("Dismiss all: a text button after 'and N more', last in the card; the host section becomes one undo line (C53, C11)", async () => {
    await mount()
    const buttons = Array.from(card()!.querySelectorAll('button'))
    const all = buttons[buttons.length - 1]
    expect(all.textContent).toBe('Dismiss all')
    // Quieter than any fix: not the outlined button Retry wears (N16).
    expect(all.classList.contains('setup-step-btn')).toBe(false)
    expect(all.classList.contains('ab-dismiss-all')).toBe(true)
    expect(all.previousElementSibling?.textContent).toBe('and 2 more')
    expect(host.querySelectorAll('.ab-dismiss-all-x')).toHaveLength(0)
    await click(all)
    expect(rowIds()).toEqual([])
    expect(host.querySelector('[data-undo-id="all"]')?.textContent).toBe('5 hosts hidden until they change.Undo')
    // Nothing asks for attention over a hidden list: the plain section name (N3-12).
    expect(host.querySelector('.hpb .setup-banner-title')?.textContent).toBe('Remote hosts')
    expect(logs.find((l) => l.msg === 'dismissed all host rows')?.data).toMatchObject({ count: 5, mount: 'tasks' })
    expect([...dismiss.getHostDismissed()].sort()).toEqual(['barebox|connect', 'farbox|connect', 'keybox|connect', 'netbox|connect', 'proxybox|connect'])
  })

  it("'and N more' and Open Settings call onLeave first, then open Settings (flashing the hidden hosts)", async () => {
    const onLeave = () => { nav.order.push('leave') }
    await mount({ mount: 'slot', onLeave })
    await click(button('and 2 more'))
    expect(nav.order).toEqual(['leave', 'open::{"flashHosts":["barebox","farbox"]}'])
    nav.order.length = 0
    // An auth failure offers Open Settings (the fix lives there).
    api.statuses = [{ ...wire('keybox', 'Key box'), kind: 'auth', retryable: false }]
    await hostStore.hydrateHostStatus({ force: true })
    await remount({ mount: 'slot', onLeave })
    nav.order.length = 0
    const settings = host.querySelector('li[data-host="keybox"] [data-testid="hpb-open-settings"]')
    expect(settings).not.toBeNull()
    await click(settings ?? undefined)
    expect(nav.order).toEqual(['leave', 'open:keybox:null'])
  })

  it('an owner switch continues the last frame: order and expanded flags stay (C48)', async () => {
    await mount({ mount: 'tasks' })
    const li = (h: string) => host.querySelector(`li[data-host="${h}"]`)!
    const toggle = (h: string, name: string) => Array.from(li(h).querySelectorAll('button')).find((b) => b.textContent === name)
    // Several rows: none opens by position (dense, N1); the user's own choices are the session's.
    expect(li('netbox').classList.contains('hpb-dense')).toBe(true)
    expect(li('netbox').classList.contains('hpb-open')).toBe(false)
    await click(toggle('keybox', 'Show details'))
    await click(toggle('netbox', 'Show details'))
    await click(toggle('netbox', 'Hide details'))
    await remount({ mount: 'slot' })
    expect(rowIds()).toEqual(['netbox', 'keybox', 'proxybox'])
    expect(li('netbox').classList.contains('hpb-open')).toBe(false)
    expect(li('keybox').classList.contains('hpb-open')).toBe(true)
  })

  it('holdLayout queues a height change (a new row) and applies it once the hold ends', async () => {
    api.statuses = [wire('netbox', 'Net box')]
    await hostStore.hydrateHostStatus({ force: true })
    await mount({ holdLayout: true })
    expect(rowIds()).toEqual(['netbox'])
    await act(async () => { hostStore.seedHostStatus(wire('keybox', 'Key box') as never) })
    expect(rowIds()).toEqual(['netbox'])
    await mount({ holdLayout: false })
    expect(rowIds()).toEqual(['netbox', 'keybox'])
  })

  it('a mount whose cap is at its 132px floor: one-line rows, row 1 not opened by position, one action each', async () => {
    // The slot's container, measured at 0px here (linkedom has no layout): its cap is the 132px floor.
    const chat = document.createElement('div')
    chat.className = 'main-page-chat'
    document.body.appendChild(chat)
    chat.appendChild(host)
    await mount({ mount: 'slot' })
    const first = host.querySelector('li[data-host="netbox"]')!
    expect(first.classList.contains('hpb-single')).toBe(true)
    expect(first.classList.contains('hpb-open')).toBe(false)
    expect(first.querySelectorAll('.hpb-actions button')).toHaveLength(1)
    expect(card()!.classList.contains('attention-banner-single')).toBe(true)
  })

  it('the draft mount is compact: no title; Dismiss all is the same text button at the end, no corner x (N3)', async () => {
    await mount({ mount: 'draft' })
    expect(card()!.classList.contains('attention-banner-compact')).toBe(true)
    expect(host.querySelector('.setup-banner-title')).toBeNull()
    expect(host.querySelector('.ab-dismiss-all-x')).toBeNull()
    const buttons = Array.from(card()!.querySelectorAll('button'))
    const all = buttons[buttons.length - 1]
    expect(all.textContent).toBe('Dismiss all')
    expect(all.closest('.hpb-foot')).not.toBeNull()
    // Only row x buttons are bare x glyphs; none of them hides everything.
    expect(buttons.filter((b) => b.textContent === '\u00d7').every((b) => /^Dismiss (?!all)/.test(b.getAttribute('aria-label') ?? ''))).toBe(true)
  })

  const healthyWire = (host: string, label: string) => ({
    ...wire(host, label), connected: true, phase: 'connected', kind: undefined, error: undefined, hint: undefined,
    connectedAt: at - 60_000, readiness: { checkedAt: at - 1_000, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280' } },
  })

  it('a heal while NO card was mounted is not replayed on the return; one seen by a mounted card is (the owner switch)', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    api.statuses = [wire('netbox', 'Net box'), wire('keybox', 'Key box')]
    await hostStore.hydrateHostStatus({ force: true })
    await mount()
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    vi.setSystemTime(Date.now() + 5_000)
    api.statuses = [healthyWire('netbox', 'Net box'), wire('keybox', 'Key box')]
    await hostStore.hydrateHostStatus({ force: true })
    await mount()
    expect(host.querySelector('li[data-type="ready"]')).toBeNull()
    expect(rowIds()).toEqual(['keybox'])
    // keybox heals with this card on screen: its success row shows, and survives an owner switch.
    api.statuses = [healthyWire('netbox', 'Net box'), healthyWire('keybox', 'Key box')]
    await act(async () => { await hostStore.hydrateHostStatus({ force: true }) })
    expect(host.querySelector('li[data-type="ready"]')?.getAttribute('data-host')).toBe('keybox')
    await remount({ mount: 'slot' })
    expect(host.querySelector('li[data-type="ready"]')?.getAttribute('data-host')).toBe('keybox')
  })

  it('a card mounted under a resting pointer holds its rows at once, with no pointerenter (C63)', async () => {
    const orig = win.HTMLElement.prototype.matches
    const hover = vi.spyOn(win.HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, sel: string) {
      return sel === ':hover' ? this.classList.contains('attention-banner') : orig.call(this, sel)
    })
    await mount()
    api.statuses = five().filter((x) => x.host !== 'keybox')
    await act(async () => { await hostStore.hydrateHostStatus({ force: true }) })
    // keybox would go (the frame no longer has it): it stays while the pointer rests on the card.
    expect(rowIds()).toEqual(['netbox', 'keybox', 'proxybox'])
    hover.mockRestore()
    await remount()
    expect(rowIds()).toEqual(['netbox', 'proxybox', 'barebox', 'farbox'])
  })

  it('the local x turns the local section into an undo line; Undo brings it back (spec 5.1)', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    const health = {
      hasReadyProvider: true, claudeCliAvailable: true,
      localClaude: { checkedAt: 1, claude: { found: true, version: '2.1.281', auth: 'not-logged-in' }, problems: [{ kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }] },
    }
    await mount({ health })
    expect(host.querySelector('[data-testid="setup-banner-sign-in"]')).not.toBeNull()
    expect(host.querySelector('.hpb-subhead')?.textContent).toBe('Remote hosts')
    await click(button('Dismiss Claude Code notice'))
    expect(host.querySelector('[data-testid="setup-banner-sign-in"]')).toBeNull()
    expect(host.querySelector('[data-undo-id="local"]')?.textContent).toBe('Hidden until it changes.Undo')
    // The host section keeps its subhead while the undo line holds the local place (no title swap under the hand).
    expect(host.querySelector('.hpb-subhead')?.textContent).toBe('Remote hosts')
    expect(dismiss.readLocalDismissed()).toContain('sign-in:2.1.281')
    vi.setSystemTime(Date.now() + 500)
    await click(button('Undo'))
    expect(host.querySelector('[data-testid="setup-banner-sign-in"]')).not.toBeNull()
    expect(dismiss.readLocalDismissed()).not.toContain('sign-in:2.1.281')
  })

  it('the announcer: a page load and card mounts say nothing; a new problem and a heal are said once (C64)', async () => {
    const { HostBannerAnnouncer } = await import('../../web/src/components/common/HostBannerAnnouncer')
    const { hostProblemOf } = await import('../../src/core/hosts/host-problem')
    const say = () => host.querySelector('[data-testid="host-banner-announcer"]')!
    api.statuses = [wire('netbox', 'Net box')]
    await hostStore.hydrateHostStatus({ force: true })
    const both = (withCard: boolean) => createElement(MemoryRouter, null,
      createElement(HostBannerAnnouncer), withCard ? createElement(AttentionBanner, { mount: 'tasks', onNavigateSettings: () => {} }) : null)
    await act(async () => { root!.render(both(true)) })
    expect(say().getAttribute('role')).toBe('status')
    expect(say().getAttribute('aria-live')).toBe('polite')
    expect(say().textContent).toBe('')
    for (const withCard of [false, true, false, true]) await act(async () => { root!.render(both(withCard)) })
    expect(say().textContent).toBe('')
    const key = wire('keybox', 'Key box')
    api.statuses = [wire('netbox', 'Net box'), key]
    await act(async () => { await hostStore.hydrateHostStatus({ force: true }) })
    const headline = (hostProblemOf(key as never, { surface: 'banner' }) as { headline: string }).headline
    expect(say().textContent).toBe(`Key box: ${headline}`)
    api.statuses = [healthyWire('netbox', 'Net box'), key]
    await act(async () => { await hostStore.hydrateHostStatus({ force: true }) })
    expect(say().textContent).toMatch(/^Net box is ready/)
    expect(say().textContent).not.toContain('\u2713')
  })
})

