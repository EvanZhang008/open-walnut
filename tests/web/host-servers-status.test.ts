/**
 * The "Walnut on a host" group's sentence per host and its poll interval
 * (web/src/components/settings/sections/host-servers-status.ts).
 */
import { describe, expect, it } from 'vitest'
import {
  describeHostServer, hostServersPollMs, type HostServerEntry, type HostServerView,
} from '../../web/src/components/settings/sections/host-servers-status.js'

const entry = (view: Partial<HostServerView> | null, over: Partial<HostServerEntry['settings']> = {}): HostServerEntry => ({
  hostKey: 'devbox',
  label: 'Dev box',
  settings: { enabled: true, expose: { enabled: false, provider: null, options: {} }, ...over },
  view: view ? { hostKey: 'devbox', enabled: true, phase: 'off', since: 0, ...view } : null,
})

describe('describeHostServer', () => {
  it('off says what turning it on does, whatever the view says', () => {
    expect(describeHostServer(entry({ phase: 'error', message: 'old' }, { enabled: false }))).toMatchObject({ dot: 'pending', retry: false, text: expect.stringContaining('while this Mac sleeps') })
  })

  it('on with no view yet reads', () => {
    expect(describeHostServer(entry(null))).toEqual({ dot: 'pending', text: 'Reading its state...', retry: false })
  })

  it('waiting and setting up are muted and say the manager\'s words', () => {
    expect(describeHostServer(entry({ phase: 'waiting-for-host', message: 'The host is not connected right now.' }))).toEqual({ dot: 'pending', text: 'The host is not connected right now.', retry: false })
    for (const phase of ['checking', 'installing', 'starting'] as const) {
      expect(describeHostServer(entry({ phase }))).toEqual({ dot: 'pending', text: 'Setting it up...', retry: false })
    }
  })

  it('an old daemon needs an update; an error offers Try again', () => {
    expect(describeHostServer(entry({ phase: 'unsupported' }))).toMatchObject({ dot: 'action', retry: false })
    expect(describeHostServer(entry({ phase: 'error', message: 'npm failed' }))).toEqual({ dot: 'error', text: 'npm failed', retry: true })
  })

  it('running says where a browser there reaches', () => {
    const running = (route?: { kind: string; why?: string }) => describeHostServer(entry({ phase: 'running', server: route ? { route } : {} }))
    expect(running()).toEqual({ dot: 'done', text: 'Running.', retry: false })
    expect(running({ kind: 'leader' }).text).toBe('Running. A browser there reaches this Mac.')
    expect(running({ kind: 'companion' }).text).toContain('cloud companion')
    expect(running({ kind: 'alone', why: 'no link' }).text).toContain('on its own')
  })
})

describe('hostServersPollMs', () => {
  it('polls fast before the first answer and while a host is being set up', () => {
    expect(hostServersPollMs(null)).toBe(3_000)
    expect(hostServersPollMs({ hosts: [entry({ phase: 'installing' })], providers: [] })).toBe(3_000)
  })

  it('polls fast while an enabled tunnel moves, slow once it settles or is off', () => {
    const withTunnel = (state: string, enabled = true) => hostServersPollMs({
      hosts: [entry({ phase: 'running', server: { expose: { enabled, provider: 'acme', state: state as never, since: 0 } } }, { expose: { enabled, provider: 'acme', options: {} } })],
      providers: [],
    })
    expect(withTunnel('starting')).toBe(3_000)
    expect(withTunnel('retrying')).toBe(3_000)
    expect(withTunnel('connected')).toBe(30_000)
    expect(withTunnel('unavailable')).toBe(30_000)
    expect(withTunnel('starting', false)).toBe(30_000)
  })

  it('a host turned off or settled polls slow', () => {
    expect(hostServersPollMs({ hosts: [entry({ phase: 'installing' }, { enabled: false })], providers: [] })).toBe(30_000)
    expect(hostServersPollMs({ hosts: [entry({ phase: 'waiting-for-host' })], providers: [] })).toBe(30_000)
  })
})
