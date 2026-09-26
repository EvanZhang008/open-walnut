/**
 * The two host error bars say what the banner says (review fixes):
 *
 *   gate bar      (a refused Start) prefers the LIVE problem whenever the store
 *                 has one, of any kind, and falls back to the 409's own words;
 *                 a replica shows no Retry (it cannot dial ssh)
 *   session bar   a connected host whose Claude Code cannot run says the
 *                 readiness sentence (the generic suggestion is quiet because
 *                 of it, so something must speak), a test server's host says it
 *                 is off, and a replica shows no Retry
 *   note / copy   the picker note's buttons and the Copy button are tabbable
 *                 (WebKit) and reserve their widest label, so a flip to
 *                 'Retrying...' or 'Copy failed' never moves the row
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { HostStatus } from '../../web/src/api/hosts'

const state = vi.hoisted(() => ({ current: undefined as unknown, replica: false }))
vi.mock('@/hooks/useHostStatus', () => ({
  useHostStatus: () => state.current,
  useHostStatusHydration: () => 'done',
  serverNow: () => 1_900_000_000_000,
  seedHostStatus: () => {},
}))
vi.mock('@/hooks/useIsCloudReplica', () => ({ useIsCloudReplica: () => state.replica }))
vi.mock('@/api/hosts', () => ({ connectHost: async () => state.current, checkHostReadiness: async () => state.current }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')
const { gateProblem, HostGateErrorBar } = await import('../../web/src/components/sessions/HostGateErrorBar')
const { SessionHostErrorText, useSessionHostHasProblem } = await import('../../web/src/components/sessions/SessionHostErrorBar')
const { hostProblemOf, REMOTE_OFF_NOTE } = await import('../../src/core/hosts/host-problem')
const { HostNote } = await import('../../web/src/components/sessions/path-selector/HostNote')

const NOW = 1_900_000_000_000
const base = {
  host: 'buildbox', label: 'Build box', hostname: 'build.example.com', connected: true, phase: 'connected',
  phaseLabel: '', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: NOW, connectedAt: NOW - 60_000,
} as HostStatus
const OUTDATED = 'Claude Code on Build box is 2.1.220; the default model needs 2.1.280 or newer.'
const readiness = {
  ...base, readiness: { checkedAt: NOW - 1_000, claude: { version: '2.1.220', minVersion: '2.1.280' }, problems: [{ kind: 'claude_outdated', message: OUTDATED, commands: ['claude update'] }] },
} as HostStatus
const failed = { ...base, connected: false, phase: 'failed', kind: 'unreachable', error: 'ssh: no route', hint: 'Build box is not reachable from this machine.', retryable: true } as HostStatus
const off = { ...base, connected: false, phase: 'off' } as unknown as HostStatus

const notReady = { code: 'host_not_ready' as const, at: 1, body: { host: 'buildbox', code: 'host_not_ready', error: OUTDATED, kind: 'claude_outdated', allowOverride: true } }
const unreachable = { code: 'host_unreachable' as const, at: 1, body: { host: 'buildbox', code: 'host_unreachable', error: 'Could not connect to Build box. Old hint.', kind: 'unreachable', headline: 'Could not connect to Build box', hint: 'Old hint.' } }

describe('gateProblem: the live problem whenever there is one', () => {
  it('a Start refused as not ready, on a host that has since dropped: the live connect failure', () => {
    expect(gateProblem(notReady as never, hostProblemOf(failed))).toMatchObject({ type: 'connect', kind: 'unreachable' })
  })
  it('a Start refused as unreachable, on a host that now connects but cannot run Claude Code: the live readiness problem', () => {
    expect(gateProblem(unreachable as never, hostProblemOf(readiness))).toMatchObject({ type: 'readiness', problem: { kind: 'claude_outdated' } })
  })
  it('no live problem: the refusal speaks for itself', () => {
    expect(gateProblem(unreachable as never, null)).toMatchObject({ type: 'connect', headline: 'Could not connect to Build box', hint: 'Old hint.' })
    expect(gateProblem(notReady as never, null)).toMatchObject({ type: 'readiness', problem: { message: OUTDATED } })
  })
  it('off and removed', () => {
    expect(gateProblem({ ...notReady, code: 'host_off' } as never, null)).toBeNull()
    expect(gateProblem(notReady as never, hostProblemOf(off))).toEqual({ type: 'off' })
    expect(gateProblem({ ...notReady, code: 'host_removed' } as never, hostProblemOf(failed))).toBeNull()
  })
})

let doc: Document
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let el: HTMLElement
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  state.replica = false
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})
const render = async (node: unknown) => { await act(async () => { root!.render(createElement(MemoryRouter, null, node)) }) }
const buttonTexts = () => Array.from(el.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())

describe('the gate bar on a replica', () => {
  it('a connect failure shows its sentence, no Retry (Retry is kept on the Mac)', async () => {
    state.current = failed
    await render(createElement(HostGateErrorBar, { gate: unreachable as never, draftHost: 'buildbox', label: 'Build box', onClear: () => {}, onStartAnyway: () => {} }))
    expect(el.querySelector('.hft-headline')?.textContent).toBe('Could not connect to Build box')
    expect(buttonTexts()).toContain('Retry')
    state.replica = true
    await render(createElement(HostGateErrorBar, { gate: unreachable as never, draftHost: 'buildbox', label: 'Build box', onClear: () => {}, onStartAnyway: () => {} }))
    expect(el.querySelector('.hft-headline')?.textContent).toBe('Could not connect to Build box')
    expect(buttonTexts()).not.toContain('Retry')
  })
})

function Probe({ fallback }: { fallback: string }) {
  const quiet = useSessionHostHasProblem('buildbox')
  return createElement('div', { 'data-quiet': String(quiet) },
    createElement(SessionHostErrorText, { host: 'buildbox', label: 'build.example.com', reconnecting: false, fallback }))
}

describe('the session error bar', () => {
  it('readiness: the suggestion is quiet, and the readiness sentence (with Check again) speaks under the session error', async () => {
    state.current = readiness
    await render(createElement(Probe, { fallback: 'Remote session exited with code 1' }))
    expect(el.querySelector('[data-quiet]')?.getAttribute('data-quiet')).toBe('true')
    const bar = el.querySelector('[data-testid="session-host-readiness"]')!
    expect(bar.textContent).toContain('Remote session exited with code 1')
    expect(bar.querySelector('.hpb-message')?.textContent).toBe(OUTDATED)
    expect(bar.querySelector('.hc-chip')?.textContent).toBe('claude update')
    expect(buttonTexts()).toContain('Check again')
  })

  it('off: the session error, then the off note', async () => {
    state.current = off
    await render(createElement(Probe, { fallback: 'Remote session exited' }))
    const bar = el.querySelector('[data-testid="session-host-off"]')!
    expect(bar.textContent).toContain('Remote session exited')
    expect(bar.textContent).toContain(REMOTE_OFF_NOTE)
  })

  it('a replica: the connect failure without a Retry', async () => {
    state.current = failed
    state.replica = true
    await render(createElement(Probe, { fallback: 'x' }))
    expect(el.querySelector('[data-testid="session-host-error"] .hft-headline')?.textContent).toBe('Could not connect to Build box')
    expect(buttonTexts()).not.toContain('Retry')
    state.replica = false
    await render(createElement(Probe, { fallback: 'x' }))
    expect(buttonTexts()).toContain('Retry')
  })
})

describe('buttons that flip their label keep their width', () => {
  it('the picker note: Retry is tabbable and reserves Retrying...', async () => {
    state.current = failed
    await render(createElement(HostNote, { hostKey: 'buildbox', label: 'Build box', onRelist: () => {}, onOpenSettings: () => {} }))
    const retry = el.querySelector('[data-testid="sps-note-retry"]')!
    expect(retry.getAttribute('tabindex')).toBe('0')
    expect(retry.querySelector('.hpb-btn-stack')?.getAttribute('data-r1')).toBe('Retrying...')
    expect(retry.querySelector('.hpb-btn-stack')?.getAttribute('data-r2')).toBe('Retry')
  })

  it('the readiness note: Check again reserves Checking..., Open Settings is a tabbable secondary, Copy reserves Copy failed', async () => {
    state.current = readiness
    await render(createElement(HostNote, { hostKey: 'buildbox', label: 'Build box', onRelist: () => {}, onOpenSettings: () => {} }))
    const check = el.querySelector('[data-testid="sps-note-check"]')!
    expect(check.getAttribute('tabindex')).toBe('0')
    expect(check.querySelector('.hpb-btn-stack')?.getAttribute('data-r1')).toBe('Check again')
    expect(check.querySelector('.hpb-btn-stack')?.getAttribute('data-r2')).toBe('Checking...')
    const settings = el.querySelector('[data-testid="sps-note-open-settings"]')!
    expect(settings.getAttribute('tabindex')).toBe('0')
    expect(settings.className).toContain('hpb-btn-secondary')
    const copy = Array.from(el.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? '').startsWith('Copy'))!
    expect(copy.querySelector('.hpb-btn-stack')?.getAttribute('data-r1')).toBe('Copy failed')
    expect(copy.querySelector('.hpb-btn-stack')?.getAttribute('data-r2')).toBe('Copied')
  })
})
