/**
 * Settings › Remote Hosts, one row's status line and detail block, rendered in
 * every state (spec 5.2; checklist C6, C9, C24, C25, C27, C35, C78):
 * a connect failure reads 'Not connected' with Retry, and the SAME
 * HostFailureText the banner and picker use sits in its own block (never inside
 * .rh-status); a reconnect names its last cause and keeps Connect now enabled;
 * a test server says 'Off on this test server' with no button; a replica shows
 * no Retry / Connect now.
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
vi.mock('@/api/config', () => ({ fetchIsCloudReplica: async () => replica }))

const { RemoteHostStatus, RemoteHostDetail } = await import('../../web/src/components/settings/sections/RemoteHostStatus')

const base = {
  host: 'keybox', label: 'Key box', hostname: 'key.example.com', connected: false, phase: 'idle',
  phaseLabel: '', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: clock,
} as HostStatus
const HINT = 'Walnut runs `ssh alice@key.example.com` without a password prompt. Make sure that command works from this machine on its own, then Retry.'
const auth = { ...base, phase: 'failed', error: 'alice@key.example.com: Permission denied (publickey).', kind: 'auth', hint: HINT, retryable: false } as HostStatus
const row = (s: HostStatus | undefined) => {
  current = s
  const line = renderToStaticMarkup(createElement(RemoteHostStatus, { alias: 'keybox', name: 'Key box' }))
  const detail = renderToStaticMarkup(createElement(RemoteHostDetail, { alias: 'keybox', name: 'Key box' }))
  return { line, detail }
}
/** The row's connect button: its visible label (the reserve stack repeats labels in data attributes only) and state. */
const button = (html: string) => {
  const b = html.match(/<button[\s\S]*?<\/button>/)?.[0]
  return b ? { label: text(b.replace(/data-r\d="[^"]*"/g, '')).trim(), disabled: /<button[^>]*disabled/.test(b), cls: b.includes('rh-connect-btn') } : null
}
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")

describe('connect failure (C6, C27, C78)', () => {
  it('the line is short: "Not connected" + Retry (even when retryable is false), no countdown', () => {
    const { line, detail } = row(auth)
    expect(text(line)).toContain('Not connected')
    expect(button(line)).toMatchObject({ label: 'Retry', disabled: false, cls: true })
    expect(text(line + detail)).not.toMatch(/tries again in/)
    expect(text(line + detail)).not.toContain("isn't reachable right now")
  })

  it('the detail block is the shared HostFailureText: headline by kind + the hint verbatim, SSH output behind a toggle', () => {
    const { line, detail } = row(auth)
    expect(detail).toContain('class="rh-failure"')
    expect(text(detail)).toContain('Could not connect to Key box')
    expect(detail).toContain('<code>ssh alice@key.example.com</code>')
    expect(text(detail)).toContain('Show SSH output')
    expect(detail).toContain('aria-expanded="false"')
    // Never inside the one-line status classes.
    expect(line).not.toContain('hft-')
  })

  it('a real schedule shows the countdown; cert_expired names its cause in the headline', () => {
    const { detail } = row({ ...auth, kind: 'cert_expired', retryAt: clock + 192_000 } as HostStatus)
    expect(text(detail)).toContain('Could not connect to Key box: SSH certificate expired')
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

  it('an attempt in flight: the phase and a disabled "Retrying..." (never "Connecting...")', () => {
    const { line } = row({ ...base, phase: 'ssh', phaseLabel: 'Opening an SSH connection to Key box…', attemptStartedAt: clock - 4_000 } as HostStatus)
    expect(button(line)).toMatchObject({ label: 'Retrying...', disabled: true })
    expect(text(line)).not.toContain('Connecting...')
    expect(text(line)).toContain('4s')
  })

  it('healthy: "Connected", no button, no detail', () => {
    const { line, detail } = row({ ...base, connected: true, phase: 'connected', readiness: { checkedAt: clock, problems: [] } } as HostStatus)
    expect(text(line)).toContain('Connected')
    expect(line).not.toContain('rh-connect-btn')
    expect(text(detail)).toBe('')
  })
})

describe('a host switched off in Settings', () => {
  it('reads Disabled with no button and no detail, whatever the store still holds (never a Connect now that answers 409)', () => {
    for (const s of [undefined, auth, { ...base, connected: true, phase: 'connected' } as HostStatus]) {
      current = s
      const line = renderToStaticMarkup(createElement(RemoteHostStatus, { alias: 'keybox', name: 'Key box', enabled: false }))
      const detail = renderToStaticMarkup(createElement(RemoteHostDetail, { alias: 'keybox', name: 'Key box', enabled: false }))
      expect(text(line)).toContain('Disabled')
      expect(text(line)).not.toContain('Not connected')
      expect(line).not.toContain('<button')
      expect(line).toContain('data-kind="off"')
      expect(detail).toBe('')
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
    await act(async () => { root.render(createElement(RemoteHostStatus, { alias: 'keybox', name: 'Key box' })) })
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('Not connected')
    expect(host.querySelector('.rh-connect-btn')).toBeNull()
    await act(async () => { root.unmount() })
    replica = false
  })
})
