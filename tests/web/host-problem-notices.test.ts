/**
 * HostProblemNotices mounted for real (linkedom + the web app's own React, the
 * real host store with the API mocked, the notification context replaced by a
 * recorder): a host problem is a toast once and a screen reader line for what
 * the toast does not say (host-problem-toasts.test.ts has the pure rule).
 *
 *   toast     the first load with a failing host toasts it (title, Retry, Show details)
 *   once      a later frame, a re-render and a remount after a reload toast nothing new
 *   new       a second host failing toasts that host only
 *   retry     the toast's Retry dials the host; Show details opens the notification panel
 *   heal      a host that heals is said once in the live region, without the check mark
 *   quiet     quiet mode holds the toast; the live region says the problem instead
 *   health    a host Walnut reconnects by itself never toasts (Walnut Health lists it), nor
 *             before the quiet state is known
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { HostStatus } from '../../web/src/api/hosts'

const api = vi.hoisted(() => ({
  statuses: [] as unknown[],
  connectHost: vi.fn(),
}))
vi.mock('@/api/hosts', () => ({
  fetchHostStatus: async () => api.statuses, connectHost: (...a: unknown[]) => api.connectHost(...a), checkHostReadiness: () => new Promise(() => {}),
}))
vi.mock('@/api/ws', () => ({ wsClient: { state: 'connected', onEvent() {}, offEvent() {} } }))
vi.mock('@/hooks/useServerRole', () => ({ useIsReplicaServer: () => false }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))
const notes = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>>, quiet: null as unknown }))
vi.mock('@/contexts/notifications', () => ({
  useNotifications: () => ({ notify: (n: Record<string, unknown>) => { notes.sent.push(n) }, quiet: notes.quiet }),
}))

const { NOT_QUIET } = await import('../../web/src/contexts/notifications/quiet-model')
const { HostProblemNotices } = await import('../../web/src/components/common/HostProblemNotices')
const hostStore = await import('../../web/src/hooks/useHostStatus')
const { __resetHostBannerDismissForTests } = await import('../../web/src/utils/host-banner-dismiss')
const { __resetUserRetryForTests } = await import('../../web/src/utils/host-user-retrying')
const { __resetHostActionStoreForTests } = await import('../../web/src/utils/host-action-store')
const { OPEN_CENTER_EVENT } = await import('../../web/src/utils/open-anywhere')
const { TOASTED_STORAGE_KEY } = await import('../../web/src/utils/host-problem-toasts')

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

let at = 1_900_000_000_000
// A login only the person can do ('auth': SSH refused the key) toasts; a host Walnut reconnects
// by itself ('unreachable') is Walnut Health's and never does (audience.ts, 2026-11-17).
const failing = (host: string, label: string, kind = 'auth'): HostStatus => ({
  host, label, hostname: `${host}.example.com`, connected: false, phase: 'failed', phaseLabel: '', steps: [],
  phaseElapsedMs: 0, connectElapsedMs: 0, at: ++at, serverNow: at, kind, error: 'ssh: no route',
  hint: `${label} is not reachable from this machine.`, retryable: true,
} as unknown as HostStatus)
const healthy = (host: string, label: string): HostStatus => ({
  host, label, hostname: `${host}.example.com`, connected: true, phase: 'connected', phaseLabel: '', steps: [],
  phaseElapsedMs: 0, connectElapsedMs: 0, at: ++at, serverNow: at, connectedAt: at - 60_000,
  readiness: { checkedAt: at - 1_000, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280' } },
} as unknown as HostStatus)

let win: Window & typeof globalThis
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let host: HTMLElement
const say = () => host.querySelector('[data-testid="host-banner-announcer"]')!.textContent
const frame = async (statuses: HostStatus[]) => {
  api.statuses = statuses
  await act(async () => { await hostStore.hydrateHostStatus({ force: true }) })
}
const mount = async () => { await act(async () => { root!.render(createElement(HostProblemNotices)) }) }
const reload = async () => {
  await act(async () => { root!.unmount() })
  hostStore.__resetHostStatusForTests()
  root = createRoot(host)
}
type Action = { label: string; run: () => void }
const actionsOf = (n: Record<string, unknown>) => (n.actions as Action[])

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  win = dom.window as unknown as Window & typeof globalThis
})
beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  notes.sent.length = 0
  notes.quiet = NOT_QUIET
  api.connectHost.mockReset()
  api.connectHost.mockImplementation(() => new Promise(() => {}))
  __resetHostBannerDismissForTests()
  hostStore.__resetHostStatusForTests()
  __resetUserRetryForTests()
  __resetHostActionStoreForTests()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  document.body.innerHTML = ''
})

describe('HostProblemNotices', () => {
  it('the first load toasts a failing host once: its headline, Retry and Show details; a reload does not toast it again', async () => {
    await frame([failing('netbox', 'Net box')])
    await mount()
    expect(notes.sent).toHaveLength(1)
    const t = notes.sent[0]
    expect(t).toMatchObject({ kind: 'host', severity: 'error', title: 'Could not connect to Net box', persistent: false })
    expect(actionsOf(t).map((a) => a.label)).toEqual(['Retry', 'Show details'])
    const stored = JSON.parse(localStorage.getItem(TOASTED_STORAGE_KEY)!) as Record<string, string[]>
    expect(Object.values(stored)).toEqual([['netbox']])
    expect(Object.keys(stored)[0]).toMatch(/^host:netbox#/)
    // The same failure again, and a re-render: nothing new.
    await frame([failing('netbox', 'Net box')])
    await mount()
    expect(notes.sent).toHaveLength(1)
    // A reload with the host still failing: the memory is in localStorage.
    await reload()
    await frame([failing('netbox', 'Net box')])
    await mount()
    expect(notes.sent).toHaveLength(1)
    expect(say()).toBe('')
  })

  it('two hosts failing at once are one toast with Retry all; a third later toasts alone', async () => {
    await frame([failing('netbox', 'Net box'), failing('keybox', 'Key box')])
    await mount()
    expect(notes.sent).toHaveLength(1)
    expect(notes.sent[0].title).toBe('2 remote hosts need attention')
    expect(notes.sent[0].body).toBe('Could not connect to Net box. Could not connect to Key box')
    expect(actionsOf(notes.sent[0]).map((a) => a.label)).toEqual(['Retry all', 'Show details'])
    await frame([failing('netbox', 'Net box'), failing('keybox', 'Key box'), failing('farbox', 'Far box')])
    expect(notes.sent).toHaveLength(2)
    expect(notes.sent[1].title).toBe('Could not connect to Far box')
  })

  it("the toast's Retry all dials every host; Show details opens the notification panel", async () => {
    await frame([failing('netbox', 'Net box'), failing('keybox', 'Key box')])
    await mount()
    const [retry, details] = actionsOf(notes.sent[0])
    await act(async () => { retry.run() })
    expect(api.connectHost.mock.calls.map((c) => c[0]).sort()).toEqual(['keybox', 'netbox'])
    // linkedom's window cannot dispatch the runtime's CustomEvent: a stand-in window records it.
    const g = globalThis as unknown as { window: unknown }
    const sent: string[] = []
    g.window = { dispatchEvent: (e: Event) => { sent.push(e.type); return true } }
    try {
      details.run()
    } finally { g.window = win }
    expect(sent).toEqual([OPEN_CENTER_EVENT])
  })

  it('a heal is said once in the live region, without the check mark, and the host may toast again later', async () => {
    await frame([failing('netbox', 'Net box')])
    await mount()
    await frame([healthy('netbox', 'Net box')])
    expect(say()).toMatch(/^Net box is ready/)
    expect(say()).not.toContain('✓')
    expect(JSON.parse(localStorage.getItem(TOASTED_STORAGE_KEY)!)).toEqual({})
    await frame([failing('netbox', 'Net box')])
    expect(notes.sent).toHaveLength(2)
  })

  it('a host Walnut reconnects by itself never toasts; a login next to it still does', async () => {
    await frame([failing('othermac', 'Other Mac', 'unreachable'), failing('keybox', 'Key box')])
    await mount()
    expect(notes.sent.map((n) => n.title)).toEqual(['Could not connect to Key box'])
    expect(notes.sent[0]).toMatchObject({ needsYou: 'sign-in' })
    // Known from here on: a later frame toasts nothing for it either.
    await frame([failing('othermac', 'Other Mac', 'unreachable'), failing('keybox', 'Key box')])
    expect(notes.sent).toHaveLength(1)
    expect(say()).toBe('')
  })

  it('nothing toasts before the quiet state is known (a reload in a focus block)', async () => {
    notes.quiet = { ...NOT_QUIET, unknown: true }
    await frame([failing('keybox', 'Key box')])
    await mount()
    expect(notes.sent).toHaveLength(0)
  })

  it('quiet mode holds the toast; the live region names the problem instead', async () => {
    notes.quiet = { active: true, allowPermissions: true, holds: [{ source: 'user', since: Date.now(), until: Date.now() + 3_600_000 }] }
    await frame([failing('netbox', 'Net box')])
    await mount()
    expect(notes.sent).toHaveLength(0)
    expect(say()).toBe('Net box: Could not connect to Net box')
  })
})
