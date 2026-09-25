/**
 * Settings › Remote hosts, rendered: how the readiness lines read while Walnut
 * fixes a host by itself. A problem being fixed says so instead of offering a
 * command; a failed fix keeps its line, says why, and offers the exact command
 * with Copy; a finished fix no problem carries gets one muted line.
 *
 * The live host-status store is replaced by a fixed status (its hook has no
 * server snapshot, and it would open a WebSocket).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { HostStatus } from '../../web/src/api/hosts'

let current: HostStatus | undefined
vi.mock('@/hooks/useHostStatus', () => ({
  useHostStatus: () => current,
  useHostStatusHydration: () => 'hydrated',
  seedHostStatus: () => {},
}))
vi.mock('@/api/hosts', () => ({ connectHost: async () => current }))

const { RemoteHostReadiness } = await import('../../web/src/components/settings/sections/RemoteHostStatus')
const { FIX_NOTE_MS } = await import('../../web/src/utils/host-readiness')

const base = {
  host: 'devbox', label: 'devbox', hostname: 'devbox.example.test', connected: true, phase: 'connected',
  phaseLabel: 'Connected', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 1,
} as HostStatus
const render = (readiness: unknown) => {
  current = { ...base, readiness } as HostStatus
  return renderToStaticMarkup(createElement(RemoteHostReadiness, { alias: 'devbox', name: 'devbox' }))
}
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

const CLAUDE = { kind: 'claude_needs_node', message: 'Claude Code here is the npm build and no working Node.js was found.', commands: ['curl -fsSL https://claude.ai/install.sh | bash'] }
const GCC = { kind: 'compiler_missing', message: 'No C compiler, so terminals on this host will not survive a disconnect.', commands: ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'] }

beforeEach(() => { current = undefined })

describe('RemoteHostReadiness with automatic fixes', () => {
  it('a problem being fixed reads "Installing ... on <host>..." with no command and no Copy', () => {
    const html = render({
      checkedAt: 5,
      problems: [{ ...CLAUDE, fix: { action: 'install-claude-native', state: 'running', text: 'Installing Claude Code' } }, GCC],
      fixing: { action: 'install-claude-native', startedAt: 5, text: 'Installing Claude Code' },
      fixes: [],
    })
    expect(text(html)).toContain('Installing Claude Code on devbox...')
    expect(html).not.toContain('rh-readiness-copy-claude_needs_node')
    expect(html).toMatch(/data-problem="claude_needs_node" data-fix="running"/)
    // The running line is muted (info), the one still waiting on the user keeps Copy and Check again.
    expect(html).toMatch(/settings-notice-info[^>]*><span class="rh-readiness"[^>]*data-fix="running"/)
    expect(html).toContain('rh-readiness-copy-compiler_missing')
    expect(html).toContain('rh-readiness-recheck')
  })

  it('a failed fix keeps the line, adds its reason, and offers the exact command with Copy', () => {
    const html = render({
      checkedAt: 6,
      problems: [{
        ...GCC, commands: ['sudo apt-get install -y gcc libc6-dev'],
        fix: { action: 'install-compiler', state: 'failed', text: 'Could not install gcc automatically (sudo needs a password)', needsPassword: true, detail: 'sudo: a password is required' },
      }],
      fixes: [{ action: 'install-compiler', ok: false, needsPassword: true, finishedAt: 6, text: 'Could not install gcc automatically (sudo needs a password)' }],
    })
    expect(text(html)).toContain('devbox: No C compiler, so terminals on this host will not survive a disconnect. Could not install gcc automatically (sudo needs a password): run sudo apt-get install -y gcc libc6-dev')
    expect(html).toContain('rh-readiness-copy-compiler_missing')
    expect(html).toContain('title="sudo: a password is required"')
    expect(html).toContain('settings-notice-warn')
  })

  it('once fixed, the problem is gone and one muted line says what was installed', () => {
    const html = render({
      checkedAt: 7, problems: [], dtach: { found: true },
      fixes: [{ action: 'install-claude-native', ok: true, finishedAt: 1, ageMs: 1000, text: 'Installed Claude Code 2.1.280' }],
    })
    expect(text(html)).toBe('devbox: Installed Claude Code 2.1.280.')
    expect(html).toContain('settings-notice-info')
    expect(html).not.toContain('Copy')
  })

  it('a fix no problem carries (dtach) shows while it runs; a fine host with nothing new shows nothing', () => {
    expect(text(render({ checkedAt: 8, problems: [], fixing: { action: 'build-dtach', startedAt: 8, text: 'Installing dtach' }, fixes: [] })))
      .toBe('Installing dtach on devbox...')
    expect(render({ checkedAt: 9, problems: [], fixes: [] })).toBe('')
    expect(render(undefined)).toBe('')
  })
})

describe('a finished-fix line leaves on its own', () => {
  let doc: Document
  beforeAll(() => {
    // react-dom needs a document; the repo has no jsdom (see tests/web/use-integrations-cache.test.ts).
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    doc = dom.document as unknown as Document
  })
  afterEach(() => { vi.useRealTimers() })

  it('each note disappears when its 15 minutes run out, with no new status push', async () => {
    vi.useFakeTimers()
    current = {
      ...base,
      readiness: {
        checkedAt: 7, problems: [], dtach: { found: true },
        fixes: [
          { action: 'install-compiler', ok: true, finishedAt: 1, ageMs: FIX_NOTE_MS - 60_000, text: 'Installed gcc' },
          { action: 'install-claude-native', ok: true, finishedAt: 2, ageMs: FIX_NOTE_MS - 120_000, text: 'Installed Claude Code 2.1.281' },
        ],
      },
    } as HostStatus
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(RemoteHostReadiness, { alias: 'devbox', name: 'devbox' })) })
    expect(host.textContent).toContain('Installed gcc')
    expect(host.textContent).toContain('Installed Claude Code 2.1.281')
    await act(async () => { vi.advanceTimersByTime(59_000) })
    expect(host.textContent).toContain('Installed gcc')
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(host.textContent).not.toContain('Installed gcc')
    expect(host.textContent).toContain('Installed Claude Code 2.1.281')
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(host.textContent).toBe('')
    // Nothing left to wait for: no timer stays armed for a settled row.
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => { root.unmount() })
  })
})
