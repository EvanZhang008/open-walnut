/**
 * The × of the status lines, banners and passing lines outside the session panel (2026-11-22, the
 * user: "why there is no x so that i cna close"): a state line hides until what it says changes,
 * a passing line goes now, and the welcome card hides until its setup step changes. Mounted for
 * real (linkedom + the web app's own React).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

vi.mock('@/utils/local-claude-recheck', () => ({ recheckLocalClaudeNow: async () => {} }))
vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

import { CalendarAlert } from '../../web/src/components/calendar/CalendarAlert'
import { MailListStatus } from '../../web/src/apps/mail/MailListStatus'
import { mailListStatusSnapshot, pushMailListStatus } from '../../web/src/apps/mail/mail-groups-bus'
import { FirstUseSetup, firstUseSignature, useFirstUseCard } from '../../web/src/components/common/FirstUseSetup'
import { awaySignature } from '../../web/src/components/layout/AwayLine'
import { focusStaySignature } from '../../web/src/focus-spaces/FocusBanner'
import { NOTICE_DISMISS_KEY, resetNoticeDismissCache } from '../../web/src/utils/notice-dismiss'
import type { LeaderPresenceState } from '../../web/src/api/leader-presence'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

let win: Window & typeof globalThis
let host: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
const render = async (node: unknown) => { await act(async () => { root!.render(node) }) }
const click = async (el: Element | null) => {
  expect(el, 'the × is drawn').not.toBeNull()
  await act(async () => { el!.dispatchEvent(new win.Event('click', { bubbles: true })) })
}

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
  resetNoticeDismissCache()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  document.body.innerHTML = ''
})

describe('a state line: hidden until what it says changes', () => {
  const failed = { sources: [], loading: false, loadError: 'boom' }
  const alert = (calendar: typeof failed) => createElement(CalendarAlert, { calendar, onRetry: () => {} })

  it('the calendar alert closes, stays closed through a retry, and a good load brings the next one back', async () => {
    await render(alert(failed))
    expect(host.querySelector('[data-testid="cal-alert"]')).not.toBeNull()
    await click(host.querySelector('[data-testid="cal-alert-close"]'))
    expect(host.querySelector('[data-testid="cal-alert"]')).toBeNull()
    expect(localStorage.getItem(NOTICE_DISMISS_KEY)).toContain('cal-alert|')
    // A retry in flight says nothing new: still closed.
    await render(alert({ ...failed, loading: true }))
    await render(alert(failed))
    expect(host.querySelector('[data-testid="cal-alert"]')).toBeNull()
    // Other words show at once.
    const denied = { sources: [{ enabled: true, reason: 'permission-denied' }], loading: false, loadError: null } as never
    await render(alert(denied))
    expect(host.querySelector('[data-testid="cal-alert"]')?.textContent).toContain('Calendar access lost')
    // A good load forgets the close: the same failure later shows again.
    await render(alert({ sources: [], loading: false, loadError: null } as never))
    await render(alert(failed))
    expect(host.querySelector('[data-testid="cal-alert"]')).not.toBeNull()
  })

  it('the away line is keyed by this away, unknown before the console heard anything', () => {
    const p = (over: Partial<LeaderPresenceState>): LeaderPresenceState => ({
      answers: true, asOf: null, host: null, hostKey: null, why: null, console: false, source: 'none', ...over,
    })
    expect(awaySignature(p({}))).toBeUndefined()
    expect(awaySignature(p({ source: 'ws' }))).toBeNull()
    expect(awaySignature(p({ answers: false, host: 'Build box', source: 'ws' }))).toBe('mac:Build box')
    expect(awaySignature(p({ answers: false, host: 'Build box', console: true, source: 'ws', asOf: 7 }))).toBe('leader:Build box')
  })

  it('the focus line is keyed by one stay in a focus', () => {
    const active = { spaceId: 'deep', name: 'Deep work', scope: { projects: [], tasks: [] }, since: 5, by: 'person' } as never
    expect(focusStaySignature(false, null, true)).toBeUndefined()
    expect(focusStaySignature(true, null, true)).toBeNull()
    expect(focusStaySignature(true, active, false)).toBeNull()
    expect(focusStaySignature(true, active, true)).toBe('deep@5')
    expect(focusStaySignature(true, { ...(active as object), since: 9 } as never, true), 'entered again: shows again').toBe('deep@9')
  })
})

describe('a passing line: the × takes it away now', () => {
  it('every mail list status line has the ×, sticky or not, and it removes that line only', async () => {
    pushMailListStatus({ id: 'a', viewKey: 'v', text: 'Rule saved' })
    pushMailListStatus({ id: 'b', viewKey: 'v', text: 'Could not unsubscribe', sticky: true, tone: 'error' })
    await render(createElement(MailListStatus, { viewKey: 'v' }))
    const closes = host.querySelectorAll('[data-testid="mail-list-status-close"]')
    expect(closes).toHaveLength(2)
    expect([...closes].every((b) => b.classList.contains('wn-notice-close'))).toBe(true)
    await click(host.querySelector('[data-status-id="a"] [data-testid="mail-list-status-close"]'))
    expect(mailListStatusSnapshot('v').map((n) => n.id)).toEqual(['b'])
    await click(host.querySelector('[data-status-id="b"] [data-testid="mail-list-status-close"]'))
    expect(mailListStatusSnapshot('v')).toEqual([])
  })
})

describe('the welcome card', () => {
  const signIn = {
    hasReadyProvider: true, claudeCliAvailable: true,
    localClaude: { checkedAt: 1, claude: { found: true, version: '2.1.281', kind: 'native', auth: 'not-logged-in', versionOk: true, installMethod: 'native' }, problems: [{ kind: 'claude_not_logged_in', message: 'Claude Code is not signed in.', commands: ['claude'] }] },
  } as unknown as SystemHealth
  // Home's shape (MainPage): the card's place and its × come from useFirstUseCard.
  function Home({ health }: { health: SystemHealth }) {
    const welcome = useFirstUseCard(true, true, true, health, false)
    return welcome.place ? createElement(FirstUseSetup, { health, loading: false, onClose: welcome.close }) : null
  }
  const card = (health: SystemHealth) => createElement(MemoryRouter, null, createElement(Home, { health }))

  it('has one × in every state, which hides it until the setup step changes', async () => {
    for (const health of [signIn, { hasReadyProvider: false, claudeCliAvailable: false } as SystemHealth]) {
      await render(card(health))
      expect(host.querySelectorAll('[data-testid="first-use-close"]'), 'the card has its ×').toHaveLength(1)
      expect(host.querySelector('.ab-local-x'), 'the section inside draws none of its own').toBeNull()
    }
    await render(card(signIn))
    await click(host.querySelector('[data-testid="first-use-close"]'))
    expect(host.querySelector('[data-testid="first-use-setup"]')).toBeNull()
    await render(card(signIn))
    expect(host.querySelector('[data-testid="first-use-setup"]'), 'same step: still hidden').toBeNull()
    await render(card({ hasReadyProvider: false, claudeCliAvailable: false } as SystemHealth))
    expect(host.querySelector('[data-testid="first-use-setup"]'), 'another step: back').not.toBeNull()
  })

  it('keeps what was closed while health loads', () => {
    expect(firstUseSignature(signIn, true)).toBeUndefined()
    expect(firstUseSignature({} as SystemHealth, false)).toBeUndefined()
    expect(firstUseSignature(signIn, false)).toBe('setup:ready:cli:claude_not_logged_in')
  })
})
