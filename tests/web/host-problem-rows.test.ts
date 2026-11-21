/**
 * A host problem row (SingleHostRow, HostProblemRows.tsx), the row the
 * notification panel's problem list and System's host list draw, mounted for
 * real (linkedom + the web app's own React, the real host store with the API
 * mocked):
 *
 *   promoted   a row that moves to the top opens (open by position on every
 *              frame, not only at mount); a row below keeps its Show details toggle
 *   x          drawn only with an onDismiss and dismiss keys (the problem list
 *              passes one, System's inventory does not)
 *   dense      several rows start as headline + primary action + Show details
 *   headline   a readiness row's first sentence is the bold headline, then its buttons
 *   verb       'Install' (Claude Code there needs Node) reads 'Installing Claude Code on X...'
 *   expanded   the user's Show / Hide details choice is shared by row id across mounts
 *   attempt    Retry reads the attempt at once, and one attempt is shared across mounts
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { HostStatus } from '../../web/src/api/hosts'
import type { BannerRow } from '../../web/src/utils/attention-banner-model'

// The server's answer to a hydrate (it replaces the store map): the latest frame per host.
const server = vi.hoisted(() => new Map<string, unknown>())
const api = vi.hoisted(() => ({
  fetchHostStatus: vi.fn(async () => [...server.values()]),
  connectHost: vi.fn(),
  checkHostReadiness: vi.fn(),
}))
vi.mock('@/api/hosts', () => api)
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  return {
    wsClient: {
      state: 'connected',
      onEvent(name: string, cb: (data: unknown) => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(cb) },
      offEvent(name: string, cb: (data: unknown) => void) { handlers.get(name)?.delete(cb) },
    },
    emit(name: string, data: unknown) { for (const cb of handlers.get(name) ?? []) cb(data) },
  }
})
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }))

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')
const { SingleHostRow, readySentenceText, splitReadinessMessage } = await import('../../web/src/components/common/HostProblemRows')
const { __resetRowExpandedForTests, getRowExpanded, setRowExpanded, subscribeRowExpanded } = await import('../../web/src/utils/host-row-expanded')
const { __resetHostActionStoreForTests } = await import('../../web/src/utils/host-action-store')
const { __resetHostStatusForTests } = await import('../../web/src/hooks/useHostStatus')
const { getUserRetryingHosts, __resetUserRetryForTests } = await import('../../web/src/utils/host-user-retrying')

let doc: Document
let win: Window & typeof globalThis
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let host: HTMLElement
let at = 1_900_000_000_000

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
  __resetHostStatusForTests()
  __resetUserRetryForTests()
  __resetRowExpandedForTests()
  __resetHostActionStoreForTests()
  server.clear()
  api.connectHost.mockReset()
  api.checkHostReadiness.mockReset()
  host = doc.createElement('div')
  doc.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

const frame = (o: Partial<HostStatus> & { host: string }): HostStatus => ({
  label: o.host, hostname: `${o.host}.example.com`, connected: false, phase: 'failed', phaseLabel: '', steps: [],
  phaseElapsedMs: 0, connectElapsedMs: 0, at: ++at, serverNow: at, ...o,
} as HostStatus)
const push = async (f: HostStatus) => { server.set(f.host, f); await act(async () => { ws.emit('host:status', f) }) }
const render = async (el: unknown) => { await act(async () => { root!.render(createElement(MemoryRouter, null, el)) }) }
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new win.Event('click', { bubbles: true })); await Promise.resolve() }) }
const buttons = () => Array.from(host.querySelectorAll('button'))
const byText = (t: string) => buttons().find((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === t)
const noop = () => {}

const readinessRow = (id = 'host:buildbox'): BannerRow => ({
  id, type: 'readiness', group: 'readiness', hosts: ['buildbox'], labels: ['Build box'], kind: 'claude_not_logged_in',
  problem: { kind: 'claude_not_logged_in', message: 'Claude Code on Build box is not signed in.', commands: ['ssh -t alice@build.example.com claude'] },
  dismissKeys: ['buildbox|claude_not_logged_in|'], actions: ['checkAgain', 'openSettings'],
})

describe('a row promoted to the top opens', () => {
  it('a readiness row below the first starts behind Show details; at index 0 its command shows, with Hide details', async () => {
    const row = readinessRow('host:promote-a')
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hc-chip')).toBeNull()
    expect(byText('Show details')?.getAttribute('aria-expanded')).toBe('false')
    // The row above it went away: this row is now the first (the same mounted row).
    await render(createElement(SingleHostRow, { row, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hc-chip')?.textContent).toBe('ssh -t alice@build.example.com claude')
    expect(byText('Show details')).toBeUndefined()
    expect(byText('Hide details')?.getAttribute('aria-expanded')).toBe('true')
    // Moved back down: the user never opened it, so it folds again, with its toggle.
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hc-chip')).toBeNull()
    expect(byText('Show details')).toBeDefined()
  })

  it('a connect row promoted to the top shows its hint', async () => {
    const row: BannerRow = {
      id: 'host:promote-b', type: 'connect', group: 'connect', hosts: ['netbox'], labels: ['Net box'], kind: 'unreachable',
      headline: 'Could not connect to Net box', hint: 'Net box is not reachable from this machine.', summary: 'ssh: no route',
      retryable: true, dismissKeys: ['netbox|connect'], actions: ['retry'],
    }
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hft-hint')).toBeNull()
    await render(createElement(SingleHostRow, { row, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hft-hint')?.textContent).toBe('Net box is not reachable from this machine.')
  })
})

describe('the row x (the problem list passes onDismiss; System\'s inventory does not)', () => {
  it('draws an x only with an onDismiss and dismiss keys, statusList or not; the rest of the row is the same', async () => {
    const row = readinessRow('host:list-a')
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, dense: true, statusList: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hpb-x')?.getAttribute('aria-label')).toBe('Dismiss Build box')
    await render(createElement(SingleHostRow, { row: { ...row, dismissKeys: [] }, defaultExpanded: false, dense: true, statusList: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hpb-x')).toBeNull()
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, dense: true, statusList: true, onOpenSettings: noop }))
    expect(host.querySelector('.hpb-x')).toBeNull()
    // Dense and folded: the headline, the primary button, Show details.
    expect(host.querySelector('.hpb-headline')?.textContent).toBe('Claude Code on Build box is not signed in.')
    expect(Array.from(host.querySelectorAll('.hpb-actions button')).map((b) => b.textContent)).toEqual(['Check again'])
    expect(byText('Show details')?.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('dense rows (N1)', () => {
  const keybox = {
    id: 'host:keybox', type: 'connect', group: 'connect', hosts: ['keybox'], labels: ['Key box'], kind: 'auth',
    headline: 'Could not connect to Key box', hint: 'Walnut runs `ssh alice@key.example.com` without a password prompt.',
    summary: 'Permission denied (publickey).', dismissKeys: ['keybox|connect'], actions: ['retry', 'openSettings'],
  } as unknown as BannerRow
  const mount = async (props: Record<string, unknown>, row: BannerRow = keybox) => {
    await render(createElement(SingleHostRow, { row, onDismiss: noop, onOpenSettings: noop, ...props } as never))
    return host.querySelector('li.hpb-row')!
  }
  const texts = (li: Element) => Array.from(li.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())

  it('a dense row starts closed: its headline, its primary action, Show details, the x; no hint', async () => {
    const li = await mount({ dense: true, defaultExpanded: false })
    expect(li.classList.contains('hpb-dense')).toBe(true)
    expect(li.classList.contains('hpb-open')).toBe(false)
    // Fix with agent is one of the row's actions: behind Show details with the rest (BP-R3-N1).
    expect(texts(li)).toEqual(['Retry', 'Show details', '×'])
    expect(li.querySelector('.hft-hint')).toBeNull()
  })

  it('opened by the user, a dense row shows every action and the details', async () => {
    await mount({ dense: true, defaultExpanded: false })
    await click(byText('Show details')!)
    const open = host.querySelector('li.hpb-row')!
    expect(open.classList.contains('hpb-open')).toBe(true)
    expect(texts(open)).toContain('Open Settings')
    expect(texts(open)).toContain('Fix with agent')
    expect(open.querySelector('.hft-hint')).not.toBeNull()
  })

  it('a dense row with no words to open still offers Show details when it keeps an action back', async () => {
    const bare = { ...keybox, hint: undefined, summary: undefined, actions: ['retry'] } as unknown as BannerRow
    const li = await mount({ dense: true, defaultExpanded: false }, bare)
    expect(texts(li)).toEqual(['Retry', 'Show details', '×'])
    await click(byText('Show details')!)
    expect(texts(host.querySelector('li.hpb-row')!)).toEqual(['Retry', 'Fix with agent', 'Hide details', '×'])
  })

  it('a lone row (not dense) opens by position with all of its actions', async () => {
    const li = await mount({ dense: false, defaultExpanded: true })
    expect(li.classList.contains('hpb-dense')).toBe(false)
    expect(texts(li).slice(0, 2)).toEqual(['Retry', 'Open Settings'])
  })
})

describe('rows name their host first (N10, N15)', () => {
  it('splitReadinessMessage: the first sentence is the headline, the rest the detail', () => {
    expect(splitReadinessMessage('Claude Code on Sign box is not signed in. Run `ssh -t alice@sign.example.com claude` once, then Check again.'))
      .toEqual({ head: 'Claude Code on Sign box is not signed in.', rest: 'Run `ssh -t alice@sign.example.com claude` once, then Check again.' })
    expect(splitReadinessMessage('Claude Code is not installed on Fix box.')).toEqual({ head: 'Claude Code is not installed on Fix box.', rest: '' })
  })

  it('a readiness row: bold first-sentence headline, then its buttons, then the rest', async () => {
    const row = {
      id: 'host:signbox', type: 'readiness', group: 'readiness', hosts: ['signbox'], labels: ['Sign box'], kind: 'claude_not_logged_in',
      problem: { kind: 'claude_not_logged_in', message: 'Claude Code on Sign box is not signed in. Run the command once, then Check again.', commands: ['ssh -t alice@sign.example.com claude'] },
      dismissKeys: ['signbox|claude_not_logged_in|'], actions: ['checkAgain', 'openSettings'],
    } as unknown as BannerRow
    await render(createElement(SingleHostRow, { row, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    const li = host.querySelector('li.hpb-row')!
    expect(li.querySelector('.hpb-headline')!.textContent).toBe('Claude Code on Sign box is not signed in.')
    const order = Array.from(li.querySelectorAll('.hpb-headline, button, .hpb-rest')).map((e) => e.className.split(' ')[0] + ':' + (e.textContent ?? '').trim().slice(0, 12))
    expect(order[0]).toBe('hpb-message:Claude Code ')
    expect(order[1]).toMatch(/^btn:Check again/)
    expect(order.findIndex((o) => o.startsWith('hpb-rest'))).toBeGreaterThan(1)
    expect(order[order.length - 1]).toMatch(/^setup-banner-dismiss/)
  })
})

describe('the autofix verb', () => {
  // A banner row: claude_outdated (whose npm build also installs) takes none (BANNER_READINESS_KINDS).
  it("a Claude Code that needs Node: Install reads 'Installing Claude Code on Build box...', not Updating", async () => {
    const readiness = { checkedAt: at, claude: { version: '2.1.281', minVersion: '2.1.280', installMethod: 'npm' }, problems: [{ kind: 'claude_needs_node', message: 'Claude Code on Build box needs Node.js, which is not installed there.', commands: [] }] }
    await push(frame({ host: 'buildbox', label: 'Build box', connected: true, phase: 'connected', connectedAt: at - 60_000, readiness } as Partial<HostStatus> & { host: string }))
    api.connectHost.mockImplementation(async () => frame({ host: 'buildbox', label: 'Build box', connected: true, phase: 'connected', connectedAt: at - 60_000, readiness } as Partial<HostStatus> & { host: string }))
    const row: BannerRow = {
      id: 'host:buildbox-fix', type: 'readiness', group: 'readiness', hosts: ['buildbox'], labels: ['Build box'], kind: 'claude_needs_node',
      problem: readiness.problems[0], dismissKeys: ['buildbox|claude_needs_node|2.1.280'], actions: ['install', 'checkAgain'],
    }
    await render(createElement(SingleHostRow, { row, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    await click(byText('Install')!)
    expect(host.querySelector('[data-testid="hpb-fixing"]')?.textContent).toContain('Installing Claude Code on Build box...')
    const bar = host.querySelector('[data-testid="hpb-fixing"] [role="progressbar"]')!
    expect(bar.getAttribute('aria-label')).toBe('Installing Claude Code on Build box...')
    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
    expect(host.querySelector('[data-testid="hpb-fixing"] .hpb-spinner')).toBeNull()
  })
})

const connectRow = (host = 'netbox', label = 'Net box'): BannerRow => ({
  id: `host:${host}`, type: 'connect', group: 'connect', hosts: [host], labels: [label], kind: 'unreachable',
  headline: `Could not connect to ${label}`, hint: `${label} is not reachable from this machine.`, summary: 'ssh: no route',
  retryable: true, dismissKeys: [`${host}|connect`], actions: ['retry', 'openSettings'],
})

describe('the expanded flag is shared by row id (C48, second half)', () => {
  it('the store keeps each row\'s choice and notifies once per real change', () => {
    setRowExpanded('host:keybox', true)
    setRowExpanded('host:netbox', false)
    expect(getRowExpanded('host:keybox')).toBe(true)
    expect(getRowExpanded('host:netbox')).toBe(false)
    expect(getRowExpanded('host:proxybox')).toBeUndefined()
    const seen = vi.fn()
    const off = subscribeRowExpanded(seen)
    setRowExpanded('host:netbox', true)
    setRowExpanded('host:netbox', true)
    setRowExpanded('host:netbox', false)
    off()
    setRowExpanded('host:netbox', true)
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('row 2 opened and row 1 folded by the user survive an unmount and a remount elsewhere', async () => {
    const r1 = connectRow('netbox', 'Net box')
    const r2 = connectRow('keybox', 'Key box')
    const rowsEl = (a: boolean) => createElement('ul', null,
      createElement(SingleHostRow, { key: 'a', row: r1, defaultExpanded: a, onDismiss: noop, onOpenSettings: noop }),
      createElement(SingleHostRow, { key: 'b', row: r2, defaultExpanded: false, onDismiss: noop, onOpenSettings: noop }))
    await render(rowsEl(true))
    const li = (id: string) => host.querySelector(`li[data-row-id="${id}"]`)!
    expect(li(r1.id).querySelector('.hft-hint')).not.toBeNull()
    expect(li(r2.id).querySelector('.hft-hint')).toBeNull()
    await click(Array.from(li(r1.id).querySelectorAll('button')).find((b) => b.textContent === 'Hide details')!)
    await click(Array.from(li(r2.id).querySelectorAll('button')).find((b) => b.textContent === 'Show details')!)
    expect(getRowExpanded(r1.id)).toBe(false)
    expect(getRowExpanded(r2.id)).toBe(true)
    // This mount goes away (the panel closed), another renders the same rows (System's list).
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    await render(rowsEl(true))
    expect(li(r1.id).querySelector('.hft-hint')).toBeNull()
    expect(li(r2.id).querySelector('.hft-hint')?.textContent).toBe('Key box is not reachable from this machine.')
    expect(li(r1.id).classList.contains('hpb-open')).toBe(false)
    expect(li(r2.id).classList.contains('hpb-open')).toBe(true)
  })
})

describe('one-line rows (the notification panel over pending asks, C62)', () => {
  it('only the primary action, not opened by position, and Show details still opens it', async () => {
    const row = connectRow()
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, singleLine: true, onDismiss: noop, onOpenSettings: noop }))
    const li = host.querySelector('li.hpb-row')!
    expect(li.classList.contains('hpb-single')).toBe(true)
    expect(Array.from(li.querySelectorAll('.hpb-actions button')).map((b) => b.textContent)).toEqual(['Retry'])
    expect(li.querySelector('.hft-hint')).toBeNull()
    await click(byText('Show details')!)
    expect(li.querySelector('.hft-hint')).not.toBeNull()
    expect(li.classList.contains('hpb-open')).toBe(true)
  })
})

describe('the row x title and the success sentence', () => {
  it('every x has a title equal to its aria-label (C53)', async () => {
    await render(createElement(SingleHostRow, { row: connectRow(), defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    const x = host.querySelector('.hpb-x')!
    expect(x.getAttribute('aria-label')).toBe('Dismiss Net box')
    expect(x.getAttribute('title')).toBe('Dismiss Net box')
  })

  it('the success sentence (the announcer says it on a heal) loses its leading check mark (C67)', () => {
    expect(readySentenceText('\u2713 Build box is ready (Claude Code 2.1.281)')).toBe('Build box is ready (Claude Code 2.1.281)')
    expect(readySentenceText('Build box is ready')).toBe('Build box is ready')
    expect(readySentenceText(undefined)).toBe('')
  })
})

describe('Retry reads the attempt at once, and one attempt is shared across mounts (C22, C48)', () => {
  it("'Connecting to Net box...' with a disabled Retrying... before any frame; a remount reads the same attempt; one POST", async () => {
    // The last frame is from before the click (a frame within 1s of it would count as its answer).
    await push(frame({ host: 'netbox', label: 'Net box', kind: 'unreachable', at: at - 10_000 }))
    let answer: (f: HostStatus) => void = () => {}
    api.connectHost.mockImplementation(() => new Promise<HostStatus>((r) => { answer = r }))
    const row = connectRow()
    const el = () => createElement(SingleHostRow, { row, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop })
    await render(el())
    await click(byText('Retry')!)
    expect(host.querySelector('.hpb-trying-text')?.textContent).toBe('Connecting to Net box...')
    expect(byText('Retrying...')?.disabled).toBe(true)
    // Another mount of the same row mid-attempt (the panel closed and opened): it reads the same attempt.
    await act(async () => { root!.unmount() })
    root = createRoot(host)
    await render(el())
    expect(host.querySelector('.hpb-trying-text')?.textContent).toBe('Connecting to Net box...')
    expect(byText('Retrying...')?.disabled).toBe(true)
    expect(api.connectHost).toHaveBeenCalledTimes(1)
    // The same failure comes back: the row is a failure again with the store's receipt.
    await act(async () => { answer(frame({ host: 'netbox', label: 'Net box', kind: 'unreachable' })) })
    await push(frame({ host: 'netbox', label: 'Net box', kind: 'unreachable' }))
    expect(host.querySelector('.hpb-trying-text')).toBeNull()
    expect(byText('Retry')?.disabled).toBe(false)
    expect(host.querySelector('[data-testid="hpb-receipt"]')?.textContent).toBe('Tried again just now: same result')
  })
})

describe('what a row shows of its actions (rowActionsFor)', () => {
  it('a folded dense row and a one-line row show their first action; Fix with agent waits behind Show details', async () => {
    const { rowActionsFor } = await import('../../web/src/components/common/HostProblemRows')
    expect(rowActionsFor(['retry', 'openSettings'], true, { dense: true })).toEqual({ ids: ['retry'], fix: false, folds: true })
    expect(rowActionsFor(['retry'], true, { singleLine: true })).toEqual({ ids: ['retry'], fix: false, folds: true })
    expect(rowActionsFor(['retry'], true, { singleLine: true, expanded: true })).toEqual({ ids: ['retry'], fix: true, folds: true })
    // Opened, or a lone row: every action, Fix with agent last.
    expect(rowActionsFor(['retry', 'openSettings'], true, { dense: true, expanded: true })).toEqual({ ids: ['retry', 'openSettings'], fix: true, folds: true })
    expect(rowActionsFor(['retry'], true, {})).toEqual({ ids: ['retry'], fix: true, folds: false })
    // No action of its own: Fix with agent is its one action, and nothing is folded away.
    expect(rowActionsFor([], true, { dense: true })).toEqual({ ids: [], fix: true, folds: false })
    // The System list's row keeps its repair folded (the pane where a repair starts).
    expect(rowActionsFor(['retry'], true, { dense: true, statusList: true })).toEqual({ ids: ['retry'], fix: true, folds: false })
    // A row trying again offers no repair.
    expect(rowActionsFor(['retry'], false, { dense: true })).toEqual({ ids: ['retry'], fix: false, folds: false })
  })

  it('every folded action is one Show details away: a one-line row, opened, has Fix with agent', async () => {
    await render(createElement(SingleHostRow, { row: connectRow(), defaultExpanded: false, singleLine: true, onDismiss: noop, onOpenSettings: noop }))
    expect(byText('Fix with agent')).toBeUndefined()
    await click(byText('Show details')!)
    expect(byText('Fix with agent')).toBeDefined()
  })

  it('a dense row whose one-click fix failed opens by itself and offers Fix with agent', async () => {
    const problem = { kind: 'claude_needs_node', message: 'Claude Code on Build box needs Node.js, which is not installed there.', commands: [] as string[],
      fix: { action: 'install-claude', state: 'failed', text: 'the installer exited with 1' } }
    const row: BannerRow = {
      id: 'host:buildbox-failed', type: 'readiness', group: 'readiness', hosts: ['buildbox'], labels: ['Build box'], kind: 'claude_needs_node',
      problem: problem as BannerRow['problem'], dismissKeys: ['buildbox|claude_needs_node|2.1.280'], actions: ['install', 'checkAgain'],
    }
    await render(createElement(SingleHostRow, { row, defaultExpanded: false, dense: true, onDismiss: noop, onOpenSettings: noop }))
    // No Show details while the failure shows, so nothing may be folded behind it.
    expect(byText('Show details')).toBeUndefined()
    expect(byText('Fix with agent')).toBeDefined()
    expect(byText('Check again')).toBeDefined()
  })

  it('ratchet: every action a host row draws comes from rowActionsFor', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '../../web/src/components/common/HostProblemRows.tsx'), 'utf8')
    // A repair or an action list drawn beside the cap took every folded row to a third line (2026-10-31).
    const fixes = src.match(/[^\n]*<HostFixButton\b[^\n]*/g) ?? []
    expect(fixes.length).toBeGreaterThan(0)
    for (const line of fixes) expect(line, line.trim()).toMatch(/\bshown\.fix && <HostFixButton\b/)
    const lists = src.match(/<ActionButtons ids=\{[^}]*\}/g) ?? []
    expect(lists.length).toBeGreaterThan(0)
    for (const l of lists) expect(l).toMatch(/<ActionButtons ids=\{(?:ids|shown\.ids)\}/)
    expect(src).toMatch(/const ids = shown\.ids/)
  })
})
