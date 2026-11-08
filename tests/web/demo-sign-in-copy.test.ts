// A copied command runs in the user's own terminal and real home, so a Demo page shows only Demo's own or none.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'

const demo = vi.hoisted(() => ({ copy: null as { command: string | null } | null }))
vi.mock('@/utils/demo-generation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../web/src/utils/demo-generation')>(), demoSignInCopy: () => demo.copy,
}))
const bridge = vi.hoisted(() => ({ present: false, open: vi.fn(async () => {}) }))
vi.mock('@/utils/claude-sign-in', () => ({ canOpenClaudeSignIn: () => bridge.present, openClaudeSignIn: bridge.open }))
vi.mock('@/utils/local-claude-recheck', () => ({ recheckLocalClaudeNow: vi.fn(async () => {}) }))
vi.mock('@/utils/log', () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }))

import { ClaudeSignIn, SetupBanner, CLAUDE_CODE_INSTALL, DEMO_UPDATE_ONE_CLICK, DEMO_UPDATE_UNAVAILABLE, DEMO_INSTALL_ONE_CLICK, DEMO_INSTALL_UNAVAILABLE, DEMO_SIGN_IN_LEAD, DEMO_SIGN_IN_UNAVAILABLE } from '../../web/src/components/common/SetupBanner'
import { FirstUseSetup } from '../../web/src/components/common/FirstUseSetup'
import type { SystemHealth } from '../../web/src/hooks/useSystemHealth'

const { MemoryRouter } = await import('../../web/node_modules/react-router-dom')

const SAFE = "/usr/bin/env -i HOME='/x/it'\\''s demo' CLAUDE_CONFIG_DIR='/x/it'\\''s demo/.claude' PATH='/usr/bin' /bin/sh -c 'exec claude'"
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
const codes = (html: string) => [...html.matchAll(/<code class="setup-command"[^>]*>([^<]*)<\/code>/g)].map(m => text(m[1]!))
const signInHealth: SystemHealth = {
  hasReadyProvider: true, claudeCliAvailable: true,
  localClaude: {
    checkedAt: 1, claude: { found: true, version: '2.1.281', kind: 'native', auth: 'not-logged-in', versionOk: true, installMethod: 'native' },
    problems: [{ kind: 'claude_not_logged_in', message: 'Claude Code is not signed in. Run `claude` once in a terminal and sign in.', commands: ['claude'] }],
  },
} as SystemHealth

beforeEach(() => { demo.copy = null; bridge.present = false; bridge.open.mockReset().mockResolvedValue(undefined) })

describe('copied sign-in with no native bridge', () => {
  const copy = (command: string) => renderToStaticMarkup(createElement(ClaudeSignIn, { command }))

  it('outside a confirmed Demo: the normal command, unchanged', () => {
    expect(codes(copy('claude auth login'))).toEqual(['claude auth login'])
    expect(codes(copy('claude'))).toEqual(['claude'])
  })

  it('on Demo: only its own command, whatever the caller passed', () => {
    demo.copy = { command: SAFE }
    for (const command of ['claude', 'claude auth login']) expect(codes(copy(command))).toEqual([SAFE])
  })

  it('on Demo with no command: a notice and nothing to copy', () => {
    demo.copy = { command: null }
    const html = copy('claude auth login')
    expect(codes(html)).toEqual([])
    expect(text(html)).toContain(DEMO_SIGN_IN_UNAVAILABLE)
    expect(html).toContain('role="alert"')
    expect(text(html)).not.toContain('claude auth login')
  })

  it('the sign-in card on Demo never tells the user to run their own `claude`', () => {
    demo.copy = { command: SAFE }
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SetupBanner, { health: signInHealth, onNavigateSettings: () => {} })))
    expect(text(html)).toContain(DEMO_SIGN_IN_LEAD)
    expect(text(html)).not.toContain('Run claude once')
    expect(codes(html)).toEqual([SAFE])
    demo.copy = null
    const normal = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SetupBanner, { health: signInHealth, onNavigateSettings: () => {} })))
    expect(normal).toContain('Run <code>claude</code> once in a terminal and sign in.')
    expect(codes(normal)).toEqual(['claude'])
  })
})

describe('the install card on Demo', () => {
  const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on this computer.', commands: [CLAUDE_CODE_INSTALL] }
  const failed = { ...MISSING, fix: { action: 'install-claude-native', state: 'failed', text: 'Could not install Claude Code automatically (the installer failed)' } }
  const missing = (problems: unknown[]) => ({ hasReadyProvider: true, claudeCliAvailable: false,
    localClaude: { checkedAt: 1, claude: { found: false }, problems } }) as unknown as SystemHealth
  const cards: Array<[string, SystemHealth]> = [
    ['one-click', missing([MISSING])], ['one-click failed', missing([failed])],
    ['no fix (no native install)', { hasReadyProvider: false, claudeCliAvailable: false } as SystemHealth],
  ]
  const card = (health: SystemHealth, firstUse = false) => renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(SetupBanner, { health, firstUse, onNavigateSettings: () => {} })))

  it.each(cards.flatMap(([name, health]) => [[name, health, false], [`${name}, first use`, health, true]] as const))(
    '%s: no command to copy and no `claude` to run in the real home', (_name, health, firstUse) => {
      demo.copy = { command: SAFE }
      const html = card(health, firstUse)
      expect(html).toContain('data-testid="setup-banner-install"')
      expect(codes(html)).toEqual([])
      expect(html).not.toContain('install.sh')
      expect(text(html)).not.toMatch(/run claude|run it yourself/i)
      demo.copy = null
      expect(codes(card(health, firstUse)).length).toBeGreaterThan(0)
    })

  it('keeps the one-click install, and says it installs for Demo only', () => {
    demo.copy = { command: null }
    const html = card(missing([MISSING]))
    expect(html).toContain('data-testid="setup-banner-fix"')
    expect(text(html)).toContain(DEMO_INSTALL_ONE_CLICK)
    expect(text(card(missing([failed])))).toContain('Try again')
  })

  it('with no one-click install, says why there is no command, and the normal card still copies the installer', () => {
    demo.copy = { command: SAFE }
    const none = { hasReadyProvider: false, claudeCliAvailable: false } as SystemHealth
    expect(text(card(none))).toContain(DEMO_INSTALL_UNAVAILABLE)
    expect(text(card(none))).toContain('Open API settings')
    demo.copy = null
    expect(codes(card(none))).toEqual([CLAUDE_CODE_INSTALL])
    expect(card(none)).toContain('run <code>claude</code> once to sign in')
  })
})

describe('the update card on Demo (first use shows it)', () => {
  const OUTDATED = { kind: 'claude_outdated', commands: ['claude update'],
    message: 'Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer. Run `claude update` or `curl -fsSL https://claude.ai/install.sh | bash`.' }
  const SIGN_IN = { kind: 'claude_not_logged_in', message: 'Claude Code is not signed in. Run `claude` once in a terminal and sign in.', commands: ['claude'] }
  const failedFix = { action: 'update-claude', state: 'failed', text: 'Could not update Claude Code automatically' }
  const outdated = (installMethod: string, fix?: unknown) => ({ hasReadyProvider: true, claudeCliAvailable: true, localClaude: {
    checkedAt: 1, claude: { found: true, version: '2.1.258', kind: 'native', auth: 'ok', versionOk: false, minVersion: '2.1.280', installMethod },
    problems: [{ ...OUTDATED, ...(fix ? { fix } : {}) }, SIGN_IN] } }) as unknown as SystemHealth
  const card = (health: SystemHealth) => renderToStaticMarkup(createElement(MemoryRouter, null,
    createElement(SetupBanner, { health, firstUse: true, onNavigateSettings: () => {} })))
  const cards: Array<[string, SystemHealth, string]> = [
    ['one-click', outdated('native'), DEMO_UPDATE_ONE_CLICK],
    ['one-click failed', outdated('native', failedFix), DEMO_UPDATE_ONE_CLICK],
    ['no one-click', outdated('other'), DEMO_UPDATE_UNAVAILABLE],
  ]

  it.each(cards)('%s: only the state sentence, no command and no instruction for the real home', (_name, health, line) => {
    demo.copy = { command: SAFE }
    const html = card(health)
    expect(html).toContain('data-testid="setup-banner-outdated"')
    expect(codes(html)).toEqual([])
    expect(text(html)).toContain('Claude Code on this computer is 2.1.258, but Opus 5.5 needs 2.1.280 or newer.')
    expect(text(html)).toContain(line)
    expect(text(html)).not.toMatch(/claude update|install\.sh|curl|run it yourself/i)
  })

  it('keeps the one-click update and its retry on Demo', () => {
    demo.copy = { command: null }
    expect(card(outdated('native'))).toContain('data-testid="setup-banner-fix"')
    expect(text(card(outdated('native', failedFix)))).toContain('Try again')
  })

  it.each(cards)('%s: the normal page is unchanged', (_name, health) => {
    const html = card(health)
    expect(text(html)).toContain('Run claude update or curl')
    expect(text(html)).not.toMatch(/Walnut Demo/)
    if (health.localClaude!.problems[0]!.fix) expect(codes(html)).toEqual(['claude update'])
    else if (health.localClaude!.claude.installMethod === 'other') expect(codes(html)).toEqual(['claude update'])
    else expect(codes(html)).toEqual([])
  })
})

describe('first-use sign-in check', () => {
  const unconfirmed = { ...signInHealth, localClaude: { ...signInHealth.localClaude!, problems: [] } } as SystemHealth
  const first = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(FirstUseSetup, { health: unconfirmed, loading: false })))

  it('copies Demo own command on Demo, and `claude auth login` elsewhere', () => {
    expect(codes(first())).toEqual(['claude auth login'])
    demo.copy = { command: SAFE }
    expect(codes(first())).toEqual([SAFE])
    demo.copy = { command: null }
    expect(codes(first())).toEqual([])
    expect(text(first())).toContain(DEMO_SIGN_IN_UNAVAILABLE)
  })
})

describe('the native bridge button', () => {
  let win: Window & typeof globalThis
  let host: HTMLElement
  let root: { render: (n: unknown) => void; unmount: () => void } | null = null
  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    win = dom.window as unknown as Window & typeof globalThis
  })
  beforeEach(() => {
    bridge.present = true
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    if (root) { await act(async () => { root!.unmount() }); root = null }
    document.body.innerHTML = ''
  })
  const clickAfterFailure = async (command: string) => {
    bridge.open.mockRejectedValue(new Error('The sign-in terminal could not be opened.'))
    await act(async () => { root!.render(createElement(ClaudeSignIn, { command })) })
    const button = host.querySelector('button')!
    expect(button.textContent).toBe('Sign in to Claude Code')
    expect(host.querySelector('code')).toBeNull()
    await act(async () => { button.dispatchEvent(new win.Event('click', { bubbles: true })) })
    expect(bridge.open).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be opened')
    return [...host.querySelectorAll('code.setup-command')].map(element => element.textContent)
  }

  it('is unchanged on Demo, and a bridge failure falls back to Demo own command', async () => {
    demo.copy = { command: SAFE }
    expect(await clickAfterFailure('claude auth login')).toEqual([SAFE])
  })

  it('a bridge failure on Demo with no command shows the notice, never the normal command', async () => {
    demo.copy = { command: null }
    expect(await clickAfterFailure('claude auth login')).toEqual([])
    expect(host.textContent).toContain(DEMO_SIGN_IN_UNAVAILABLE)
  })

  it('outside Demo a bridge failure still offers the normal command', async () => {
    expect(await clickAfterFailure('claude auth login')).toEqual(['claude auth login'])
  })
})
