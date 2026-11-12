/**
 * Settings › Remote Hosts, one row's state line with its one action (useLinkedHostRow.tsx, as
 * HostRow draws them) and its detail block, rendered in every state (spec 5.2; checklist C6,
 * C9, C24, C25, C27, C35, C78): a connect failure offers Retry SSH (2026-11-04 review: two
 * "Retry" buttons on the page meant different things), and the SAME HostFailureText the
 * banner and picker use sits in its own block (never in the row's line); a reconnect keeps
 * Connect now enabled; a host switched off says Off with no button; a test server says 'Off on
 * this test server' with no button; a replica shows no Retry SSH / Connect now.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import type { HostStatus } from '../../web/src/api/hosts'

const clock = 1_800_000_000_000
let current: HostStatus | undefined
let replica = false
vi.mock('@/hooks/useHostStatus', () => ({
  useHostStatus: () => current,
  useHostStatusHydration: () => 'done',
  serverNow: () => clock,
  seedHostStatus: () => {},
}))
vi.mock('@/api/hosts', () => ({ connectHost: async () => current, checkHostReadiness: async () => current }))
vi.mock('@/api/config', () => ({ fetchServerRole: async () => ({ replica, capabilities: [] }) }))

const { RemoteHostDetail } = await import('../../web/src/components/settings/sections/RemoteHostStatus')
const { useLinkedHostRow } = await import('../../web/src/components/settings/sections/useLinkedHostRow')

/** The row's dot, its one state line and its one action, as HostRow.tsx draws them. */
function Line({ enabled = true }: { enabled?: boolean }) {
  const r = useLinkedHostRow({ alias: 'keybox', name: 'Key box', enabled, saved: true, now: clock })
  return createElement('div', null,
    r.dot,
    createElement('span', { className: 'rh-row-state', title: r.stateTitle }, r.state),
    r.primary ? createElement('button', { disabled: r.primary.disabled, 'data-testid': r.primary.testId }, r.primary.label) : null,
    ...r.lines)
}

const base = {
  host: 'keybox', label: 'Key box', hostname: 'key.example.com', connected: false, phase: 'idle',
  phaseLabel: '', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: clock,
} as HostStatus
const HINT = 'Walnut runs `ssh alice@key.example.com` without a password prompt. Make sure that command works from this machine on its own, then Retry.'
const auth = { ...base, phase: 'failed', error: 'alice@key.example.com: Permission denied (publickey).', kind: 'auth', hint: HINT, retryable: false } as HostStatus
const row = (s: HostStatus | undefined) => {
  current = s
  const line = renderToStaticMarkup(createElement(Line))
  const detail = renderToStaticMarkup(createElement(RemoteHostDetail, { alias: 'keybox', name: 'Key box' }))
  return { line, detail }
}
/** The row's connect button: its visible label (the reserve stack repeats labels in data attributes only) and state. */
const button = (html: string) => {
  const b = html.match(/<button[\s\S]*?<\/button>/)?.[0]
  return b ? { label: text(b.replace(/data-r\d="[^"]*"/g, '')).trim(), disabled: /<button[^>]*disabled/.test(b), cls: b.includes('rh-row-connect') } : null
}
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

describe('connect failure (C6, C27, C78)', () => {
  it('the line is short, with Retry SSH (even when retryable is false), no countdown', () => {
    const { line, detail } = row(auth)
    expect(text(line)).toContain('Key box')
    expect(button(line)).toMatchObject({ label: 'Retry SSH', disabled: false, cls: true })
    expect(text(line + detail)).not.toMatch(/tries again in/)
    expect(text(line + detail)).not.toContain("isn't reachable right now")
  })

  it('the detail block is the shared HostFailureText: the hint verbatim, SSH output behind a toggle; the headline is the row\'s', () => {
    const { line, detail } = row(auth)
    expect(detail).toContain('class="rh-failure"')
    // The headline is the row's state line, said once (2026-11-05 review: again in Details). A
    // sign-in failure is walked through the way first-run setup does, so it reads as that step.
    expect(text(line)).toContain('Key box needs your SSH key')
    expect(text(detail)).not.toContain('Key box needs your SSH key')
    expect(text(detail)).not.toContain('Could not connect to Key box')
    expect(detail).not.toContain('hft-headline')
    expect(detail).toContain('<code>ssh alice@key.example.com</code>')
    expect(text(detail)).toContain('Show SSH output')
    expect(detail).toContain('aria-expanded="false"')
    // Never inside the one-line status classes.
    expect(line).not.toContain('hft-')
  })

  it('a real schedule shows the countdown; cert_expired names its cause in the headline', () => {
    const { line, detail } = row({ ...auth, kind: 'cert_expired', retryAt: clock + 192_000 } as HostStatus)
    expect(text(line)).toContain('Could not connect to Key box: SSH certificate expired')
    expect(text(detail)).not.toContain('Could not connect to Key box')
    expect(text(detail)).toContain('Walnut tries again in 3m 12s')
  })
})

describe('reconnecting, connecting, healthy (C9)', () => {
  it('a reconnect with a last cause: "Reconnecting to {L}", Connect now enabled, "Last attempt: ..."', () => {
    const { line, detail } = row({ ...base, phase: 'reconnecting', lastKind: 'timeout', lastHint: 'Check the VPN.', reconnectSince: clock - 30_000 } as HostStatus)
    expect(text(line)).toContain('Reconnecting to Key box')
    expect(button(line)).toMatchObject({ label: 'Connect now', disabled: false, cls: true })
    expect(text(detail)).toContain('Last attempt: Connecting to Key box timed out')
    expect(text(detail)).toContain('Check the VPN.')
  })

  it('an attempt in flight: the phase with its time, and a disabled "Connecting..."', () => {
    const { line } = row({ ...base, phase: 'ssh', phaseLabel: 'Opening an SSH connection to Key box\u2026', attemptStartedAt: clock - 4_000 } as HostStatus)
    expect(button(line)).toMatchObject({ label: 'Connecting...', disabled: true })
    expect(text(line)).not.toContain('\u2026')
    expect(text(line)).toContain('4s')
  })

  it('healthy: no button, no detail', () => {
    const { line, detail } = row({ ...base, connected: true, phase: 'connected', readiness: { checkedAt: clock, problems: [] } } as HostStatus)
    expect(line).not.toContain('<button')
    expect(text(detail)).toBe('')
  })
})

describe('a host switched off in Settings', () => {
  it('reads Off with no button, whatever the store still holds (never a Connect now that answers 409)', () => {
    for (const s of [undefined, auth, { ...base, connected: true, phase: 'connected' } as HostStatus]) {
      current = s
      const line = renderToStaticMarkup(createElement(Line, { enabled: false }))
      // Details are not offered for a host switched off (RemoteHostSshRow passes linked = enabled).
      expect(text(line)).toContain('Off: Walnut does not connect to it.')
      expect(text(line)).not.toContain('Not connected')
      expect(line).not.toContain('<button')
      expect(line).toContain('data-kind="off"')
    }
  })
})

describe('test server and replica (C24, C25)', () => {
  it('off: "Off on this test server", no button, no readiness, the tooltip names the env switch', () => {
    const { line, detail } = row({ ...base, phase: 'off', readiness: { checkedAt: 1, problems: [{ kind: 'claude_outdated', message: 'old', commands: [] }] } } as unknown as HostStatus)
    expect(text(line)).toContain('Off on this test server')
    expect(line).toContain('WALNUT_EPHEMERAL_REMOTE_HOSTS=1')
    expect(line).not.toContain('<button')
    expect(detail).toBe('')
  })

  it('a replica shows no Retry / Connect now', async () => {
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window; g.document = dom.document; g.IS_REACT_ACT_ENVIRONMENT = true
    replica = true
    current = auth
    const host = dom.document.createElement('div')
    dom.document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(createElement(Line)) })
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('Key box')
    expect(host.querySelector('[data-testid="rh-row-connect"]')).toBeNull()
    await act(async () => { root.unmount() })
    replica = false
  })
})

// Mounted after the replica test: the server role store keeps the first answer it read.
describe('what a finished fix did', () => {
  // 2026-11-05 review: a finished install stayed on the row as a fourth status line for 15
  // minutes. The row says it for ROW_FIX_NOTE_MS (the receipt); Details keep it the 15 minutes.
  it('reads on the row for its receipt time, then goes away with no new push; an old one is not drawn', async () => {
    const { FIX_NOTE_MS } = await import('../../web/src/utils/host-readiness')
    const { ROW_FIX_NOTE_MS } = await import('../../web/src/components/settings/sections/useLinkedHostRow')
    const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window; g.document = dom.document; g.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers()
    const withFix = (ageMs: number) => ({
      ...base, connected: true, phase: 'connected',
      readiness: {
        checkedAt: clock, problems: [], dtach: { found: true },
        fixes: [{ action: 'install-compiler', ok: true, finishedAt: 1, ageMs, text: 'Installed gcc' }],
      },
    } as unknown as HostStatus)
    current = withFix(1_000)
    const host = dom.document.createElement('div')
    dom.document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => { root.render(createElement(Line)) })
      expect(host.querySelector('[data-testid="rh-row-fix-note"]')?.textContent).toBe('Installed gcc.')
      await act(async () => { vi.advanceTimersByTime(ROW_FIX_NOTE_MS) })
      expect(host.querySelector('[data-testid="rh-row-fix-note"]')).toBeNull()
      await act(async () => { root.unmount() })
      current = withFix(FIX_NOTE_MS - 60_000)
      const again = createRoot(host)
      await act(async () => { again.render(createElement(Line)) })
      expect(host.querySelector('[data-testid="rh-row-fix-note"]')).toBeNull()
      await act(async () => { again.unmount() })
    } finally {
      vi.useRealTimers()
    }
  })
})

// 2026-11-05 review: a failed Turn on or Connect now said only "Could not retry right now.", for a
// Retry nobody pressed. The line says what was pressed, why it failed, and what tries again.
describe('connectFailedLine: why a dial failed, in the words of the button pressed', () => {
  it('names the press, the reason and the next step', async () => {
    const { connectFailedLine } = await import('../../web/src/components/settings/sections/useLinkedHostRow')
    expect(connectFailedLine('turn-on', 'Walnut has it turned off here', 'Retry SSH')).toBe('Turned on, but Walnut could not connect: Walnut has it turned off here. Retry SSH tries again.')
    expect(connectFailedLine('add', 'ssh: Could not resolve hostname x', 'Connect now')).toBe('Added, but Walnut could not connect: ssh: Could not resolve hostname x. Connect now tries again.')
    expect(connectFailedLine('connect', 'Home PC refused the sign-in', 'Retry SSH')).toBe('Could not connect: Home PC refused the sign-in. Retry SSH tries again.')
    expect(connectFailedLine('connect', null, null)).toBe('Could not connect: Walnut gave no reason.')
  })
})
