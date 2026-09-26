/**
 * The banner's host rows (HostProblemRows), mounted for real (linkedom + the
 * web app's own React, the real host store with the API mocked). Review fixes:
 *
 *   promoted   a row that moves to the top opens (the first row is open by
 *              position on every frame, not only at mount), and a row below it
 *              keeps its own Show details toggle
 *   Retry all  the merged credential row keeps the user's receipt until every
 *              member settles: 'Connecting to Cert box and Cert box 2...' with a
 *              disabled 'Retrying...' (spec 3.2), also when the model says the
 *              row is only an attempt in flight
 *   verb       a banner 'Install' (Claude Code there needs Node) reads 'Installing Claude Code on X...'
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

const { SingleHostRow, GroupRow, ReadyRow, readySentenceText } = await import('../../web/src/components/common/HostProblemRows')
const { __resetBannerSessionForTests, getRowExpanded } = await import('../../web/src/utils/attention-banner-session')
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
  __resetBannerSessionForTests()
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
const render = async (el: unknown) => { await act(async () => { root!.render(el) }) }
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

describe('Retry all on the merged credential row', () => {
  const members = ['certbox', 'certbox2']
  const failedRow: BannerRow = {
    id: 'cred:cert_expired', type: 'connect', group: 'connect', kind: 'cert_expired', hosts: members, labels: ['Cert box', 'Cert box 2'],
    headline: 'Could not connect to Cert box and Cert box 2: SSH certificate expired', hint: 'Run your login command, then Retry.',
    summary: '', retryable: false, dismissKeys: ['certbox|connect', 'certbox2|connect'], actions: ['retry', 'openSettings'],
  }
  const tryingRow: BannerRow = { ...failedRow, type: 'trying', actions: [] }

  it("reads 'Connecting to Cert box and Cert box 2...' with a disabled Retrying... until every member settles", async () => {
    for (const h of members) await push(frame({ host: h, label: h === 'certbox' ? 'Cert box' : 'Cert box 2', kind: 'cert_expired' }))
    api.connectHost.mockImplementation(async (h: string) => frame({ host: h, phase: 'ssh' }))
    await render(createElement(GroupRow, { row: failedRow, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    await click(byText('Retry all')!)
    expect(api.connectHost).toHaveBeenCalledTimes(2)
    expect(getUserRetryingHosts()).toEqual(new Set(members))
    // The model now says: both members in flight, the row is an attempt.
    await render(createElement(GroupRow, { row: tryingRow, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hpb-trying-text')?.textContent).toBe('Connecting to Cert box and Cert box 2...')
    const retrying = byText('Retrying...')
    expect(retrying).toBeDefined()
    expect(retrying!.disabled).toBe(true)
    // One member settles: still the user's attempt.
    await push(frame({ host: 'certbox', phase: 'connected', connected: true }))
    expect(byText('Retrying...')?.disabled).toBe(true)
    // The other settles (failed again): the row is a failure again, with its button back.
    await push(frame({ host: 'certbox2', kind: 'cert_expired' }))
    expect(getUserRetryingHosts().size).toBe(0)
    await render(createElement(GroupRow, { row: { ...failedRow, hosts: ['certbox2'], labels: ['Cert box 2'] }, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    expect(byText('Retry')?.disabled).toBe(false)
  })

  it('an attempt nobody clicked reads Trying again..., with no button', async () => {
    await render(createElement(GroupRow, { row: tryingRow, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hpb-trying-text')?.textContent).toBe('Trying again...')
    expect(host.querySelector('.hpb-actions')).toBeNull()
  })

  it("the model's by: 'user' (a Retry from another surface) reads as the user's attempt too", async () => {
    await render(createElement(GroupRow, { row: { ...tryingRow, by: 'user' }, defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    expect(host.querySelector('.hpb-trying-text')?.textContent).toBe('Connecting to Cert box and Cert box 2...')
    expect(byText('Retrying...')?.disabled).toBe(true)
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
  })
})

const connectRow = (host = 'netbox', label = 'Net box'): BannerRow => ({
  id: `host:${host}`, type: 'connect', group: 'connect', hosts: [host], labels: [label], kind: 'unreachable',
  headline: `Could not connect to ${label}`, hint: `${label} is not reachable from this machine.`, summary: 'ssh: no route',
  retryable: true, dismissKeys: [`${host}|connect`], actions: ['retry', 'openSettings'],
})

describe('the expanded flag lives in the banner session (C48, second half)', () => {
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
    // The owner switches: this mount goes away, another renders the same rows.
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

describe('the row x and the success sentence', () => {
  it('every x has a title equal to its aria-label (C53)', async () => {
    await render(createElement(SingleHostRow, { row: connectRow(), defaultExpanded: true, onDismiss: noop, onOpenSettings: noop }))
    const x = host.querySelector('.hpb-x')!
    expect(x.getAttribute('aria-label')).toBe('Dismiss Net box')
    expect(x.getAttribute('title')).toBe('Dismiss Net box')
  })

  it('a success row reads the sentence without its leading check mark; the ok dot carries the state (C67)', async () => {
    const sentence = '\u2713 Build box is ready (Claude Code 2.1.281)'
    expect(readySentenceText(sentence)).toBe('Build box is ready (Claude Code 2.1.281)')
    expect(readySentenceText('Build box is ready')).toBe('Build box is ready')
    const row: BannerRow = { id: 'ready:buildbox', type: 'ready', group: 'readiness', hosts: ['buildbox'], labels: ['Build box'], dismissKeys: [], actions: [], sentence }
    await render(createElement(ReadyRow, { row }))
    expect(host.querySelector('.hpb-ready-text')?.textContent).toBe('Build box is ready (Claude Code 2.1.281)')
    expect(host.textContent).not.toContain('\u2713')
    expect(host.querySelector('.hpb-dot')).not.toBeNull()
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
    // The owner switches mid-attempt (the bell opened): the new mount reads the same attempt.
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
