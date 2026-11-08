/**
 * Settings › Remote Hosts, rendered: the readiness lines in a host's Details
 * (spec 5.3; checklist C29, C35, C41, C77, C95). The message reads verbatim
 * (it names the host already: never a `{alias}: ` prefix). A Claude Code
 * problem the host's row fixes (Install, Update, Try again: its one action, and
 * its warning line says the problem) reads here only as "Install by hand" or
 * "Update by hand", folded, with its command and Check again; while that fix
 * runs the row says how it goes and Details add nothing until 3 minutes, then
 * Check again (2026-11-04 review: Details said the problem a second time, with a
 * second fix beside the row's). On a replica, whose row fixes nothing, the
 * message reads in full. A fix of Walnut's own parts (gcc) reads on its own line;
 * informational lines are grey notes with no button.
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
vi.mock('@/api/config', () => ({ fetchServerRole: async () => ({ replica: false, capabilities: [] }) }))

const { RemoteHostReadiness, agoText } = await import('../../web/src/components/settings/sections/RemoteHostReadiness')
const { FIX_NOTE_MS } = await import('../../web/src/utils/host-readiness')

const base = {
  host: 'buildbox', label: 'Build box', hostname: 'build.example.com', connected: true, phase: 'connected',
  phaseLabel: 'Connected', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: 1,
} as HostStatus
const idle: HostActions = {
  retry: async () => {}, connectNow: async () => {}, update: async () => {}, checkAgain: async () => {},
  pending: null, failed: null, failedReason: null, receipt: null, fixing: null, lastTriedAt: null,
}
const statusWith = (readiness: unknown, extra: Partial<HostStatus> = {}) => ({ ...base, readiness, ...extra }) as HostStatus
/** `replica`: the host's row offers no fix (RemoteHostDetail passes rowFixes={!replica}). */
const render = (status: HostStatus | undefined, actions: Partial<HostActions> = {}, replica = false) =>
  renderToStaticMarkup(createElement(RemoteHostReadiness, { alias: 'buildbox', label: 'Build box', status, actions: { ...idle, ...actions }, rowFixes: !replica }))
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

  it('a native install: the row offers Update, so Details fold it to "Update by hand" with Check again; a replica reads it in full (C25)', () => {
    const s = statusWith({ checkedAt: 5, claude: claudeNative, problems: [OUTDATED] })
    const html = render(s)
    expect(html).toContain('data-testid="rh-by-hand"')
    expect(text(html)).toContain('Update by hand')
    // The row's warning says the problem; Details never say it again, nor offer a second Update.
    expect(text(html)).not.toContain(OUTDATED.message)
    expect(html).not.toContain('rh-readiness-fix-claude_outdated')
    expect(html).toContain('rh-readiness-recheck')
    // A replica's row fixes nothing: the message in full, with Check again only.
    const onReplica = render(s, {}, true)
    expect(onReplica).not.toContain('rh-by-hand')
    expect(text(onReplica)).toContain(OUTDATED.message)
    expect(onReplica).not.toContain('rh-readiness-fix-claude_outdated')
    expect(onReplica).toContain('rh-readiness-recheck')
  })

  it('commands render as chips with Copy; alternatives sit behind Other ways', () => {
    const html = render(statusWith({ checkedAt: 5, problems: [GCC] }))
    expect(html).toContain('<code class="hc-chip">sudo yum install -y gcc</code>')
    expect(text(html)).toContain('Other ways')
  })
})

describe('RemoteHostReadiness: automatic fixes (C29, C95)', () => {
  it('while the fix runs, and after the server dropped `fixing` but before the re-check answered, Details add nothing: the row says how it goes', () => {
    const running = statusWith({ checkedAt: 5, claude: claudeNative, problems: [{ ...OUTDATED, fix: { action: 'update-claude', state: 'running', text: 'Updating Claude Code' } }], fixing: { action: 'update-claude', text: 'Updating Claude Code', startedAt: clock } })
    const during = render(running)
    expect(text(during)).not.toContain('Updating Claude Code')
    expect(text(during)).not.toContain(OUTDATED.message)
    expect(during).not.toContain('rh-by-hand')
    // The gap: the server's fix is over, the old warning is still in the answer; it never comes back here.
    const gap = statusWith({ checkedAt: 5, claude: claudeNative, problems: [OUTDATED] })
    const held = render(gap, { fixing: { verb: 'update', startedAt: clock } })
    expect(text(held)).not.toContain(OUTDATED.message)
    expect(held).not.toContain('rh-by-hand')
  })

  it('a fix of Walnut\'s own parts (gcc) never reads as installing Claude Code on the Claude line', () => {
    const MISSING = { kind: 'claude_missing', message: 'Claude Code is not installed on Build box.', commands: [] as string[] }
    const s = statusWith({
      checkedAt: 5, problems: [MISSING, { ...GCC, fix: { action: 'install-compiler', state: 'running', text: 'Installing gcc' } }],
      fixing: { action: 'install-compiler', text: 'Installing gcc', startedAt: clock },
    })
    const html = render(s, { fixing: { verb: 'install', startedAt: clock, action: 'install-compiler' } })
    const t = text(html)
    expect(t).not.toContain('Installing Claude Code')
    expect(t).toContain('Installing gcc on Build box...')
    // The Claude line is the row's to fix: here only its command by hand, folded.
    expect(t).toContain('Install by hand')
    expect(html).not.toContain('rh-readiness-fix-claude_missing')
    // A click on the row's Install, before the server names its fix, takes the Claude line away
    // here (the row says the progress)...
    const clicked = render(statusWith({ checkedAt: 5, problems: [MISSING] }), { fixing: { verb: 'install', startedAt: clock } })
    expect(clicked).not.toContain('rh-by-hand')
    expect(text(clicked)).not.toContain(MISSING.message)
    // ...and so does a person's Install whose round sets up gcc first: no second Install to click.
    const asked = render(s, { fixing: { verb: 'install', startedAt: clock, action: 'install-compiler', asked: true } })
    expect(asked).not.toContain('rh-by-hand')
    expect(asked).not.toContain('rh-readiness-fix-claude_missing')
  })

  it('every non-Claude fix, including a running note without a problem, has an unknown progress bar', () => {
    const fix = { action: 'install-compiler', state: 'running' as const, text: 'Installing gcc' }
    const withProblem = render(statusWith({ checkedAt: 5, problems: [{ ...GCC, fix }] }))
    const unclaimed = render(statusWith({ checkedAt: 5, problems: [], fixing: { ...fix, startedAt: clock } }))
    for (const html of [withProblem, unclaimed]) {
      const bars = parseHTML(html).document.querySelectorAll('[role="progressbar"]')
      expect(bars.length).toBe(1)
      expect(bars[0].getAttribute('aria-label')).toBe('Installing gcc on Build box...')
      expect(bars[0].hasAttribute('aria-valuenow')).toBe(false)
    }
    const failed = render(statusWith({ checkedAt: 6, problems: [{ ...GCC, fix: { ...fix, state: 'failed' } }] }))
    expect(failed).not.toContain('role="progressbar"')
  })

  it('the row says how long a fix runs; after 3 minutes Details offer Check again, and only then', () => {
    const gap = statusWith({ checkedAt: 5, claude: claudeNative, problems: [OUTDATED] })
    const at6 = render(gap, { fixing: { verb: 'update', startedAt: clock - 6_000 } })
    expect(at6).not.toContain('rh-readiness-recheck')
    expect(text(at6)).not.toContain('Updating Claude Code')
    const html = render(gap, { fixing: { verb: 'update', startedAt: clock - 181_000 } })
    expect(html).toContain('rh-readiness-recheck')
    expect(text(html)).not.toContain(OUTDATED.message)
  })

  it('a failed fix: Details say it did not work, with the command by hand; Try again is the row\'s', () => {
    const html = render(statusWith({ checkedAt: 6, claude: claudeNative, problems: [{ ...OUTDATED, commands: ['claude update'], fix: { action: 'update-claude', state: 'failed', text: 'the installer exited with 1' } }] }))
    expect(text(html)).toContain('The update did not work: the installer exited with 1')
    expect(text(html)).toContain('Update by hand')
    expect(html).toContain('<code class="hc-chip">claude update</code>')
    expect(text(html)).not.toContain('Try again')
  })
})

describe('RemoteHostReadiness: a failed fix of Walnut\'s own parts', () => {
  it('a failed gcc or dtach fix says what it costs, never a bare "Update failed"', () => {
    const COMPILER = { kind: 'compiler_missing', message: 'No C compiler on Build box, so its terminals will not survive a disconnect.', commands: ['sudo apt-get install -y gcc libc6-dev'] }
    for (const action of ['install-compiler', 'build-dtach']) {
      const html = render(statusWith({ checkedAt: 6, claude: claudeNative, problems: [{ ...COMPILER, fix: { action, state: 'failed', text: 'Could not install gcc automatically (sudo needs a password)' } }] }))
      expect(text(html)).toContain('No C compiler on Build box, so its terminals will not survive a disconnect. Could not install gcc automatically (sudo needs a password).')
      expect(text(html)).not.toContain('Update failed')
      expect(html).toContain('<code class="hc-chip">sudo apt-get install -y gcc libc6-dev</code>')
      expect(text(html)).toContain('Check again')
    }
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

  it('an unknown sign-in keeps a conditional login instruction and Check again, without an installer', () => {
    const s = statusWith({ checkedAt: 9, claude: { found: true, auth: 'unknown' }, problems: [] });
    const html = render(s);
    expect(text(html)).toContain('Walnut could not confirm the Claude Code sign-in on Build box.');
    expect(text(html)).toContain('If you have not signed in');
    expect(html).toContain('claude auth login');
    expect(html).toContain('rh-readiness-recheck');
    expect(html).not.toContain('rh-readiness-fix-');
    const checking = render(s, { pending: 'check' });
    expect(checking).toContain('role="progressbar"');
    expect(text(checking)).toContain('Checking Claude Code on Build box...');
    expect(render(statusWith({ checkedAt: 9, claude: { auth: 'ok' }, problems: [] }))).toBe('');
  });

  it('an inconclusive executable probe stays visible with retry but no install or sign-in command', () => {
    const s = statusWith({ checkedAt: 9, claude: { found: false, unknown: 'The login shell timed out.' }, problems: [] });
    const html = render(s);
    expect(text(html)).toContain('Walnut could not check Claude Code on Build box.');
    expect(text(html)).toContain('The login shell timed out.');
    expect(html).toContain('rh-readiness-recheck');
    expect(html).not.toContain('claude auth login');
    expect(html).not.toContain('rh-readiness-fix-');
    expect(text(html)).not.toContain('is ready');
    expect(render(s, { pending: 'check' })).toContain('role="progressbar"');
  });

  it('a failed readiness check leaves its error and retry visible even without problems', () => {
    const html = render(statusWith({ checkedAt: 9, problems: [], checkError: 'The check timed out.' }));
    expect(text(html)).toContain('The check timed out.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('rh-readiness-recheck');
    const firstFailure = render(statusWith({ checkedAt: 9, claude: { found: false, auth: 'unknown' }, problems: [], checkError: 'The check timed out.' }));
    expect(firstFailure).not.toContain('claude auth login');
    expect(text(firstFailure)).toContain('The check timed out.');
  });

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
  const view = (status: HostStatus) => createElement(RemoteHostReadiness, { alias: 'buildbox', label: 'Build box', status, actions: idle, rowFixes: true })

  it('a cleared blocking problem reads "✓ Build box is ready (Claude Code 2.1.280)" for 3s, then nothing', async () => {
    vi.useFakeTimers()
    const { host, root } = await mount(view(statusWith({ checkedAt: 5, claude: claudeOther, problems: [OUTDATED] })))
    await act(async () => { root.render(view(statusWith({ checkedAt: 6, claude: { ...claudeOther, version: '2.1.280' }, problems: [] }))) })
    expect(host.textContent).toContain('✓ Build box is ready (Claude Code 2.1.280)')
    await act(async () => { vi.advanceTimersByTime(3_100) })
    expect(host.textContent).toBe('')
    await act(async () => { root.unmount() })
  })

  it('installing an engine does not say ready while its sign-in remains unknown', async () => {
    const { host, root } = await mount(view(statusWith({ checkedAt: 5, problems: [OUTDATED] })));
    await act(async () => { root.render(view(statusWith({ checkedAt: 6, claude: { found: true, auth: 'unknown' }, problems: [] }))); });
    expect(host.textContent).toContain('could not confirm');
    expect(host.textContent).not.toContain('is ready');
    await act(async () => { root.render(view(statusWith({ checkedAt: 7, claude: { auth: 'ok' }, problems: [] }))); });
    expect(host.textContent).toContain('Build box is ready');
    await act(async () => { root.unmount(); });
  });

  it('what a finished fix did is the row line, so Details say nothing of it (remote-host-view.test.ts has the row)', async () => {
    const s = statusWith({
      checkedAt: 7, problems: [], dtach: { found: true },
      fixes: [{ action: 'install-compiler', ok: true, finishedAt: 1, ageMs: FIX_NOTE_MS - 60_000, text: 'Installed gcc' }],
    })
    const { host, root } = await mount(view(s))
    expect(host.textContent).toBe('')
    await act(async () => { root.unmount() })
  })
})
