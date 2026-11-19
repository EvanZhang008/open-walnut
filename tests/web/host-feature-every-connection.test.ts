/**
 * Every feature is there whatever the connection (the user, 2026-11-18: "make sure all
 * feature is availble. no matter the connection ntype"). A feature a host cannot give
 * right now keeps its place and says why and how to fix it, never vanishes:
 *
 *   route     the host frame's `ssh: false` + `via` name how this machine reaches a host;
 *             the tag beside a remote file, editor or page names that real connection
 *   terminal  a host whose daemon has no terminal streams keeps its Terminal tab, which
 *             says why, offers "Update the daemon" where that exists, and opens no pty
 *   servers   an offline host or a daemon too old for the list: the menu count says so
 *   VS Code   a host with no SSH route keeps "Open in VS Code", which says VS Code desktop
 *             needs SSH and opens Walnut's Code view instead
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { HostStatus } from '../../web/src/api/hosts'

const state = vi.hoisted(() => ({
  hosts: new Map<string, unknown>(),
  all: [] as unknown[],
  updates: [] as string[],
  updateAnswer: null as null | { message: string } | Error,
  servers: { servers: [] as unknown[], state: 'ok', host: '__local__', why: undefined as string | undefined },
}))
vi.mock('@/hooks/useHostStatus', () => ({
  getHostStatus: (h: string) => state.hosts.get(h),
  // A stable array, as the real store keeps (allCache): a new one per read loops useSyncExternalStore.
  getAllHostStatus: () => state.all,
  subscribeHostStatus: () => () => {},
  useHostStatus: (h: string) => state.hosts.get(h),
}))
vi.mock('@/api/hosts', () => ({
  requestHostDaemonUpdate: async (host: string) => {
    state.updates.push(host)
    if (state.updateAnswer instanceof Error) throw state.updateAnswer
    return { host, ...(state.updateAnswer ?? {}) }
  },
}))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('@/hooks/useSessionServers', () => ({ useSessionServers: () => state.servers }))
vi.mock('@/hooks/useBackgroundRunning', () => ({ useBackgroundRunning: () => ({ tasks: [], running: { total: 0 } }) }))
vi.mock('../../web/src/components/sessions/KebabGroup', () => ({ KebabGroup: ({ children }: { children: unknown }) => children }))
vi.mock('../../web/src/components/sessions/SessionMetaFacts', () => ({ SessionMetaFacts: () => null }))
vi.mock('../../web/src/components/sessions/openSessionInVscode', () => ({ openSessionInVscode: vi.fn(async () => {}) }))
vi.mock('../../web/src/components/sessions/vscodeEmbedPrefetch', () => ({ prefetchVscodeEmbed: () => {} }))
vi.mock('../../web/src/components/sessions/SessionRawView', () => ({ openSessionRawView: () => {} }))
vi.mock('@/api/sessions', () => ({ resolveSessionServicePreview: async () => { throw new Error('not in this test') } }))
vi.mock('@/stores/background-panel-store', () => ({ openBackgroundPanel: () => {} }))
vi.mock('@/hooks/useSessionPanelMode', () => ({
  useSessionPanelMode: () => ({ mode: 'auto', setMode: () => {} }), useLiveAutoPanelCount: () => null, MIN_PANELS: 1, MAX_PANELS: 4,
}))

const { hostRoute, remoteHostTag, hostRouteTunnelWords } = await import('../../web/src/utils/host-display-label')
const { HostFeatureUnavailable, TerminalUnavailableView, daemonUpdatePath } = await import('../../web/src/components/sessions/HostFeatureUnavailable')
const { SessionKebabSection, SessionViewItems } = await import('../../web/src/components/sessions/SessionKebabSection')
const { SessionWebView } = await import('../../web/src/components/sessions/SessionWebView')
const { openSessionInVscode } = await import('../../web/src/components/sessions/openSessionInVscode')

const frame = (host: string, label: string, extra: Partial<HostStatus> = {}) => ({
  host, label, hostname: `${host}.example.test`, connected: true, phase: 'connected', phaseLabel: '', steps: [],
  phaseElapsedMs: 0, connectElapsedMs: 0, at: 1, ...extra,
}) as HostStatus
const SSH = frame('devbox', 'Dev box')
const NET = frame('studio', 'Studio', { ssh: false, via: 'host-network' })
const CLOUD = frame('__cloudbox__', 'Cloud', { ssh: false, via: 'cloud' })
const WHY = 'The Walnut daemon on Studio needs an update before it can open a terminal (it has no terminal streams: an older build, or one running on Node)'

let doc: Document
let el: HTMLElement
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  g.requestAnimationFrame ??= (cb: () => void) => setTimeout(cb, 0)
  g.cancelAnimationFrame ??= (id: number) => clearTimeout(id)
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  state.hosts = new Map([[SSH.host, SSH], [NET.host, NET], [CLOUD.host, CLOUD]])
  state.all = [...state.hosts.values()]
  state.updates = []
  state.updateAnswer = null
  state.servers = { servers: [], state: 'ok', host: '__local__', why: undefined }
  el = doc.createElement('div')
  doc.body.appendChild(el)
  root = createRoot(el)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})
const render = async (node: unknown) => { await act(async () => { root!.render(node) }) }
const q = (sel: string) => el.querySelector(sel)
const click = async (node: Element | null) => {
  expect(node).toBeTruthy()
  await act(async () => { (node as HTMLElement).dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('click', { bubbles: true })) })
}

describe('the route a host has, and the tag that names it', () => {
  it('reads the frame, never the alias, with the cloud box and this machine known by their own keys', () => {
    expect(hostRoute('devbox', SSH)).toBe('ssh')
    expect(hostRoute('studio', NET)).toBe('host-network')
    expect(hostRoute('__cloudbox__', CLOUD)).toBe('cloud')
    expect(hostRoute('__cloudbox__')).toBe('cloud')
    expect(hostRoute('__local__')).toBe('local')
    expect(hostRoute(null)).toBe('local')
    // A frame from an older server has no route fields: a host-network machine is still known by its placeholder hostname.
    expect(hostRoute('old-net', { hostname: 'old-net.walnut-net.invalid' })).toBe('host-network')
    expect(hostRoute('devbox')).toBe('ssh')
  })

  it('tags by the real connection: only an SSH host reads "SSH"', () => {
    expect(remoteHostTag('devbox', 'Dev box', 'ssh')).toBe('SSH: Dev box')
    expect(remoteHostTag('studio', 'Studio', 'host-network')).toBe('Host network: Studio')
    expect(remoteHostTag('__cloudbox__', 'Cloud', 'cloud')).toBe('Cloud')
    expect(remoteHostTag('__cloudbox__', 'Cloud')).toBe('Cloud')
    expect(hostRouteTunnelWords('host-network')).not.toMatch(/ssh/i)
    expect(hostRouteTunnelWords('cloud')).not.toMatch(/ssh/i)
    expect(hostRouteTunnelWords('ssh')).toMatch(/SSH tunnel/)
  })
})

describe('a terminal the host cannot open yet: the tab stays and says why', () => {
  it('on a host-network machine: the sentence, and Update the daemon asks that host', async () => {
    state.updateAnswer = { message: 'Updating the daemon on Studio' }
    await render(createElement(TerminalUnavailableView, { host: 'studio', why: WHY }))
    expect(q('[data-testid="terminal-unavailable"] .session-code-label')?.textContent).toBe('Terminal')
    expect(q('[data-testid="host-feature-why"]')?.textContent).toBe(`${WHY}.`)
    expect(q('.session-code-error-title')?.textContent).toBe('No terminal on Studio yet')
    await click(q('[data-testid="host-feature-update-daemon"]'))
    expect(state.updates).toEqual(['studio'])
    expect(q('[data-testid="host-feature-update-answer"]')?.textContent).toBe('Updating the daemon on Studio')
    expect(q('[data-testid="host-feature-update-daemon"]')?.textContent).toBe('Update started')
  })

  it('a refused update says the server\'s reason in place', async () => {
    state.updateAnswer = Object.assign(new Error('409'), { status: 409, body: { error: 'Nothing to ask for Studio: it updates another way.' } })
    Object.setPrototypeOf(state.updateAnswer, (await import('../../web/src/api/api-error')).ApiError.prototype)
    await render(createElement(HostFeatureUnavailable, { host: 'studio', title: 't', why: WHY }))
    await click(q('[data-testid="host-feature-update-daemon"]'))
    expect(q('[data-testid="host-feature-update-answer"]')?.textContent).toBe('Nothing to ask for Studio: it updates another way.')
  })

  it('on the cloud box, an SSH host or this machine: no button, the sentence of how its daemon is updated', async () => {
    for (const [host, re] of [['__cloudbox__', /Deploying the cloud companion/], ['devbox', /Walnut updates the daemon on Dev box itself/], ['__local__', /restart Walnut/]] as const) {
      await render(createElement(HostFeatureUnavailable, { host, title: 't', why: WHY }))
      expect(q('[data-testid="host-feature-update-daemon"]'), host).toBeNull()
      expect(q('[data-testid="host-feature-fix"]')?.textContent, host).toMatch(re)
    }
    expect(daemonUpdatePath('host-network', 'Studio')).toBeNull()
  })

  it('shows the server\'s sentence of how the daemon updates when the frame has one, and keeps the button where one exists', async () => {
    const said = {
      devbox: 'Walnut updates the daemon on Dev box by itself the next time it connects there over SSH',
      studio: 'Walnut updates the daemon on Studio by itself after a deploy (unless its automatic fixes are off), or use "Update the daemon" in Settings › Hosts to do it now',
      __cloudbox__: 'Deploying the cloud companion updates the daemon there (it starts that daemon from its own build)',
    }
    for (const [host, how] of Object.entries(said)) state.hosts.set(host, { ...(state.hosts.get(host) as object), daemonUpdateHow: how })
    for (const [host, how] of Object.entries(said)) {
      await render(createElement(HostFeatureUnavailable, { host, title: 't', why: WHY }))
      expect(q('[data-testid="host-feature-fix"]')?.textContent, host).toBe(`${how}.`)
      expect(!!q('[data-testid="host-feature-update-daemon"]'), host).toBe(host === 'studio')
    }
  })
})

describe('Open in VS Code, by the host\'s route', () => {
  const kebab = (host: string | undefined, onOpenCodeView = vi.fn(), onAfterAction = vi.fn()) => createElement(SessionKebabSection, {
    sessionId: 's1', host, cwd: '/srv/repo', onRestart: () => {}, restartBusy: false, onTerminate: () => {}, terminateBusy: false,
    onInvestigate: () => {}, investigating: false, investigateResult: null, onOpenVscodeError: () => {}, onOpenCodeView, onAfterAction,
  })

  it('a host with no SSH route keeps the row, says why, and opens the Code view instead', async () => {
    for (const host of ['studio', '__cloudbox__']) {
      const open = vi.fn()
      await render(kebab(host, open))
      const row = q('[data-testid="session-kebab-vscode-desktop"]')
      expect(row?.getAttribute('data-unavailable'), host).toBe('no-ssh')
      expect(row?.textContent).toMatch(/VS Code desktop opens remote folders over SSH, and (Studio|Cloud) has no SSH/)
      await click(row)
      expect(open, host).toHaveBeenCalledTimes(1)
      expect(openSessionInVscode).not.toHaveBeenCalled()
    }
  })

  it('an SSH host and this machine open VS Code desktop as before', async () => {
    for (const host of ['devbox', undefined]) {
      vi.mocked(openSessionInVscode).mockClear()
      await render(kebab(host))
      const row = q('[data-testid="session-kebab-vscode-desktop"]')
      expect(row?.hasAttribute('data-unavailable')).toBe(false)
      await click(row)
      expect(openSessionInVscode).toHaveBeenCalledWith('s1')
    }
  })
})

describe('the Web preview row\'s count when the servers cannot be listed', () => {
  const items = () => createElement(SessionViewItems, {
    sessionId: 's1', activeView: null, onToggleView: () => {}, unreadCount: 0, decisionCount: 0, attentionCount: 0,
    notesOpen: false, onToggleNotes: () => {}, messagesOpen: false, onToggleMessages: () => {},
  })
  it.each([
    ['unsupported', 'daemon needs an update'],
    ['offline', 'host not connected'],
  ])('%s: says so, with the server\'s sentence on hover', async (st, words) => {
    state.servers = { servers: [], state: st, host: 'studio', why: `why ${st}` }
    await render(items())
    const count = q('[data-testid="session-menu-servers-count"]')
    expect(count?.textContent).toBe(` · ${words}`)
    expect(count?.getAttribute('title')).toBe(`why ${st}`)
  })
  it('ok with none running still says none running', async () => {
    await render(items())
    expect(q('[data-testid="session-menu-servers-count"]')?.textContent).toBe(' · none running')
  })
})

describe('class guard: a surface that reads a host\'s terminal: false keeps the tab and says why', () => {
  const WEB = join(__dirname, '../../web/src')
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })
  it('every reader of `terminal === false` also renders `terminalWhy`, and nothing hides the Terminal chip on it', () => {
    const readers = files(WEB).filter((f) => /\.terminal\s*[!=]==\s*false/.test(readFileSync(f, 'utf8')))
    expect(readers.length).toBeGreaterThan(0)
    for (const f of readers) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).toMatch(/terminalWhy/)
      expect(src, f).not.toMatch(/\.terminal\s*!==\s*false/)
    }
    const panel = readFileSync(join(WEB, 'components/sessions/SessionPanel.tsx'), 'utf8')
    expect(panel).toMatch(/<TerminalUnavailableView\b/)
    // The chip itself is drawn whatever the host's frame says.
    const chip = panel.indexOf('data-header-id="terminal"')
    expect(chip).toBeGreaterThan(0)
    expect(panel.slice(Math.max(0, chip - 400), chip)).not.toMatch(/\{\s*terminal\w*\s*&&\s*\(/)
  })
})

describe('the Web view when the servers cannot be listed, and its words per connection', () => {
  const view = (host: string, servers: Record<string, unknown>) => createElement(SessionWebView, {
    sessionId: 's1', host, request: null, onNavigate: () => {},
    servers: { servers: [], stopping: new Set(), stopErrors: new Map(), stop: async () => true, refresh: () => {}, ...servers },
  } as never)

  it('a daemon too old for the list: the sentence and the fix, never an empty view', async () => {
    await render(view('studio', { state: 'unsupported', host: 'studio', why: 'The Walnut daemon on Studio needs an update before it can list the servers this session started' }))
    expect(q('[data-testid="session-servers-unavailable"]')).toBeTruthy()
    expect(q('[data-testid="session-servers-why"]')?.textContent).toMatch(/needs an update/)
    expect(q('[data-testid="host-feature-update-daemon"]')).toBeTruthy()
  })

  it('an offline host: the sentence, no update button', async () => {
    await render(view('devbox', { state: 'offline', host: 'devbox', why: 'Dev box is not connected right now' }))
    expect(q('[data-testid="session-servers-why"]')?.textContent).toBe('Dev box is not connected right now.')
    expect(q('[data-testid="host-feature-update-daemon"]')).toBeNull()
  })

  it('says how a remote port opens by the host\'s real connection', async () => {
    for (const [host, re] of [['devbox', /A port on Dev box opens over an SSH tunnel/], ['studio', /A port on Studio opens through the host network/], ['__cloudbox__', /A port on Cloud opens through the cloud companion/]] as const) {
      await render(view(host, { state: 'ok', host }))
      const text = el.textContent ?? ''
      expect(text, host).toMatch(re)
      if (host !== 'devbox') expect(text, host).not.toMatch(/SSH/)
    }
  })
})
