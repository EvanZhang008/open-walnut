/**
 * Settings › Remote Hosts, rendered: the readiness lines inside a host's row
 * (spec 5.3; checklist C29, C35, C41, C77, C95). The message reads verbatim
 * (it names the host already: never a `{alias}: ` prefix); an automatic fix
 * holds 'Updating Claude Code on {L}...' until the re-check answers; a failed
 * fix says 'Update failed: ...' with its command and Try again; informational
 * lines are grey notes with no button.
 *
 * The live store is not involved: status and the actions object are passed in.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { HostStatus } from '../../web/src/api/hosts'
import type { HostActions } from '../../web/src/hooks/useHostActions'

let clock = 1_000_000
vi.mock('@/hooks/useHostStatus', () => ({ serverNow: () => clock }))
vi.mock('@/api/config', () => ({ fetchIsCloudReplica: async () => false }))

const { RemoteHostReadiness, agoText } = await import('../../web/src/components/settings/sections/RemoteHostReadiness')
const { FIX_NOTE_MS } = await import('../../web/src/utils/host-readiness')

const base = {
  host: 'buildbox', label: 'Build box', hostname: 'build.example.com', connected: true, phase: 'connected',
  phaseLabel: 'Connected', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 1,
} as HostStatus
const idle: HostActions = {
  retry: async () => {}, connectNow: async () => {}, update: async () => {}, checkAgain: async () => {},
  pending: null, failed: null, receipt: null, fixing: null, lastTriedAt: null,
}
const statusWith = (readiness: unknown, extra: Partial<HostStatus> = {}) => ({ ...base, readiness, ...extra }) as HostStatus
const render = (status: HostStatus | undefined, actions: Partial<HostActions> = {}, replica = false) =>
  renderToStaticMarkup(createElement(RemoteHostReadiness, { alias: 'buildbox', label: 'Build box', status, actions: { ...idle, ...actions }, replica }))
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

const OUTDATED = { kind: 'claude_outdated', message: 'Claude Code on Build box is 2.1.220; this model needs 2.1.280 or newer.', commands: [] as string[] }
const GCC = { kind: 'compiler_missing', message: 'No C compiler on Build box, so terminals there will not survive a disconnect.', commands: ['sudo yum install -y gcc', 'sudo apt-get install -y gcc'] }
const claudeOther = { version: '2.1.220', minVersion: '2.1.280', installMethod: 'other' }
const claudeNative = { ...claudeOther, installMethod: 'native' }

describe('RemoteHostReadiness: the problem line', () => {
  it('the message verbatim, no alias prefix, the label once; no command chip when there is none (C35)', () => {
    const html = render(statusWith({ checkedAt: 5, claude: claudeOther, problems: [OUTDATED] }))
    const t = text(html)
    expect(t).toContain(OUTDATED.message)
    expect(t.startsWith('buildbox: ')).toBe(false)
    expect(t.split('Build box').length - 1).toBe(1)
    expect(html).not.toContain('hc-chip')
    // Not autofixable (installMethod other): Check again only, no Update.
    expect(html).toContain('rh-readiness-recheck')
    expect(html).not.toContain('rh-readiness-fix-claude_outdated')
  })

  it('a native install offers Update + Check again; a replica shows Check again only (C25)', () => {
    const s = statusWith({ checkedAt: 5, claude: claudeNative, problems: [OUTDATED] })
    expect(render(s)).toContain('rh-readiness-fix-claude_outdated')
    const onReplica = render(s, {}, true)
    expect(onReplica).not.toContain('rh-readiness-fix-claude_outdated')
    expect(onReplica).toContain('rh-readiness-recheck')
  })

  it('commands render as chips with Copy; alternatives sit behind Other ways', () => {
    const html = render(statusWith({ checkedAt: 5, problems: [GCC] }))
    expect(html).toContain('<code class="hc-chip" title="sudo yum install -y gcc">')
    expect(text(html)).toContain('Other ways')
  })
})

describe('RemoteHostReadiness: automatic fixes (C29, C95)', () => {
  it('while the fix runs, and after the server dropped `fixing` but before the re-check answered, the line holds', () => {
    const running = statusWith({ checkedAt: 5, claude: claudeNative, problems: [{ ...OUTDATED, fix: { action: 'update-claude', state: 'running', text: 'Updating Claude Code' } }], fixing: { action: 'update-claude', text: 'Updating Claude Code', startedAt: clock } })
    expect(text(render(running))).toContain('Updating Claude Code on Build box...')
    // The gap: the server's fix is over, the old warning is still in the answer.
    const gap = statusWith({ checkedAt: 5, claude: claudeNative, problems: [OUTDATED] })
    const held = text(render(gap, { fixing: { verb: 'update', startedAt: clock } }))
    expect(held).toContain('Updating Claude Code on Build box...')
    expect(held).not.toContain(OUTDATED.message)
  })

  it('after 5s the elapsed time shows; after 3 minutes "Still updating" and Check again', () => {
    const gap = statusWith({ checkedAt: 5, claude: claudeNative, problems: [OUTDATED] })
    const at6 = text(render(gap, { fixing: { verb: 'update', startedAt: clock - 6_000 } }))
    expect(at6).toMatch(/Updating Claude Code on Build box\.\.\. \d+s/)
    const html = render(gap, { fixing: { verb: 'update', startedAt: clock - 181_000 } })
    expect(text(html)).toMatch(/^Still updating Claude Code on Build box/)
    expect(html).toContain('rh-readiness-recheck')
  })

  it('a failed fix: "Update failed: {fix.text}", the command chip, and Try again', () => {
    const html = render(statusWith({ checkedAt: 6, claude: claudeNative, problems: [{ ...OUTDATED, commands: ['claude update'], fix: { action: 'update-claude', state: 'failed', text: 'the installer exited with 1' } }] }))
    expect(text(html)).toContain('Update failed: the installer exited with 1')
    expect(html).toContain('title="claude update"')
    expect(text(html)).toContain('Try again')
  })
})

describe('RemoteHostReadiness: notes, receipts, last checked (C41, C77)', () => {
  it('daemon_dir_fallback and status.warnings are grey notes with no Check again', () => {
    const html = render(statusWith(
      { checkedAt: 5, problems: [{ kind: 'daemon_dir_fallback', message: 'Using ~/.cache/open-walnut because /tmp is not usable.', commands: [] }] },
      { warnings: ['The clock on this host is 90s off.'] },
    ))
    expect(html.match(/class="rh-readiness-note"/g)?.length).toBe(2)
    expect(text(html)).toContain('Using ~/.cache/open-walnut because /tmp is not usable.')
    expect(text(html)).toContain('The clock on this host is 90s off.')
    expect(html).not.toContain('rh-readiness-recheck')
  })

  it('the same result after Check again says so; afterwards "Last checked" stays', () => {
    const s = statusWith({ checkedAt: clock - 120_000, claude: claudeOther, problems: [OUTDATED] })
    expect(text(render(s, { receipt: 'Checked just now: still 2.1.220', lastTriedAt: clock }))).toContain('Checked just now: still 2.1.220')
    expect(text(render(s, { lastTriedAt: clock }))).toContain('Last checked 2m ago')
    expect(agoText(30_000)).toBe('just now')
    expect(agoText(3_700_000)).toBe('1h ago')
  })

  it('a fine host, or one not connected, renders nothing', () => {
    expect(render(statusWith({ checkedAt: 9, problems: [], fixes: [] }))).toBe('')
    expect(render(undefined)).toBe('')
    expect(render(statusWith({ checkedAt: 9, problems: [OUTDATED] }, { connected: false, phase: 'failed' }))).toBe('')
  })
})

describe('RemoteHostReadiness: lines that leave on their own', () => {
  let doc: Document
  beforeAll(() => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    doc = dom.document as unknown as Document
  })
  afterEach(() => { vi.useRealTimers() })

  const mount = async (el: ReturnType<typeof createElement>) => {
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(el) })
    return { host, root }
  }
  const view = (status: HostStatus) => createElement(RemoteHostReadiness, { alias: 'buildbox', label: 'Build box', status, actions: idle, replica: false })

  it('a cleared blocking problem reads "✓ Build box is ready (Claude Code 2.1.280)" for 3s, then nothing', async () => {
    vi.useFakeTimers()
    const { host, root } = await mount(view(statusWith({ checkedAt: 5, claude: claudeOther, problems: [OUTDATED] })))
    await act(async () => { root.render(view(statusWith({ checkedAt: 6, claude: { ...claudeOther, version: '2.1.280' }, problems: [] }))) })
    expect(host.textContent).toContain('✓ Build box is ready (Claude Code 2.1.280)')
    await act(async () => { vi.advanceTimersByTime(3_100) })
    expect(host.textContent).toBe('')
    await act(async () => { root.unmount() })
  })

  it('a finished-fix note disappears when its 15 minutes run out, with no new push', async () => {
    vi.useFakeTimers()
    const s = statusWith({
      checkedAt: 7, problems: [], dtach: { found: true },
      fixes: [{ action: 'install-compiler', ok: true, finishedAt: 1, ageMs: FIX_NOTE_MS - 60_000, text: 'Installed gcc' }],
    })
    const { host, root } = await mount(view(s))
    expect(host.textContent).toContain('Installed gcc.')
    await act(async () => { vi.advanceTimersByTime(61_000) })
    expect(host.textContent).toBe('')
    await act(async () => { root.unmount() })
  })
})
