/**
 * GET /api/diagnostics: the doctor report over HTTP.
 *
 * Contract under test:
 *   - JSON by default, redacted by default (paths and hostnames masked);
 *   - ?format=text is the paste-ready block, ?section=hosts the hosts block;
 *   - ?redact=0 keeps the raw values only for a loopback reader on a primary;
 *   - concurrent requests share ONE collection (it runs processes);
 *   - a collection failure still answers 200 with the reason.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-diagnostics-route'))

import express from 'express'
import request from 'supertest'
import {
  createDiagnosticsRouter, isLoopbackAddress, rawAllowed, serverDiagnosticsOptions,
} from '../../../src/web/routes/diagnostics.js'
import type { CollectOptions, DiagnosticsProbes } from '../../../src/core/diagnostics/doctor.js'

const probes: Partial<DiagnosticsProbes> = {
  loginShellPath: async () => '/Users/alice/.local/bin:/usr/bin',
  daemonPreflight: async () => null,
  preflight: async () => ({
    claude: { found: true, path: '/Users/alice/.local/bin/claude', version: '2.1.280', kind: 'native', needsNode: false },
    compiler: { found: true, name: 'clang' },
    dtach: { found: false },
  }),
  claudePath: () => null,
  claudeFloor: async () => null,
  compiler: () => ({ found: true, name: 'clang' }),
  dtach: async () => ({ found: false, path: null, source: null }),
  sqlite: async () => ({ ok: true }),
  webAssets: async () => null,
  config: async () => ({
    provider: 'anthropic', mainProvider: null, mainModel: 'claude-opus-5-5', fastModel: null,
    providers: [], engine: 'claude', hostsConfigured: 1, searchDisabled: false,
  }),
  server: () => ({
    node: 'v24.1.0', platform: 'darwin', arch: 'arm64', pid: 1, nice: 0, port: 3456,
    dataDir: '/Users/alice/.open-walnut', uptimeMs: 1000, mode: 'primary',
  }),
  hosts: async () => [{
    alias: 'devbox', label: 'devbox', hostname: 'devbox.example.com', connected: false, phase: 'idle',
    runtime: null, daemonVersion: null, readiness: null, lastError: null,
  }],
  daemonHello: async () => null,
}

const ENV = { HOME: '/Users/alice', SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }

function app(options: () => CollectOptions, allowRaw?: () => boolean) {
  const a = express()
  a.use('/api/diagnostics', createDiagnosticsRouter({ collect: options, ...(allowRaw ? { allowRaw } : {}) }))
  return a
}

const fixed = () => ({ collector: 'server' as const, probes, env: ENV })

describe('GET /api/diagnostics', () => {
  it('returns the redacted JSON report by default', async () => {
    const res = await request(app(fixed)).get('/api/diagnostics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body.local.claude).toMatchObject({ found: true, version: '2.1.280', path: '/Users/\u2026/.local/bin/claude' })
    expect(res.body.hosts[0].hostname).toBe('[host:1]')
    expect(JSON.stringify(res.body)).not.toContain('alice')
    expect(res.headers['x-diagnostics-redacted']).toBeUndefined()
  })

  it('keeps raw values with redact=0 for a loopback reader (supertest connects over 127.0.0.1)', async () => {
    const res = await request(app(fixed)).get('/api/diagnostics?redact=0')
    expect(res.headers['x-diagnostics-redacted']).toBeUndefined()
    expect(res.body.local.claude.path).toBe('/Users/alice/.local/bin/claude')
    expect(res.body.hosts[0].hostname).toBe('devbox.example.com')
  })

  it('returns the paste-ready text block, and the hosts block alone', async () => {
    const res = await request(app(fixed)).get('/api/diagnostics?format=text')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.text.startsWith('Open Walnut doctor (server, ')).toBe(true)
    expect(res.text).toContain('claude     2.1.280  native  /Users/\u2026/.local/bin/claude')
    expect(res.text).toContain('  devbox  [host:1]  idle  -  -  -  -  not connected')

    const hosts = await request(app(fixed)).get('/api/diagnostics?format=text&section=hosts')
    expect(hosts.text.startsWith('Open Walnut host diagnostics (')).toBe(true)
    expect(hosts.text).not.toContain('claude     ')
    expect(hosts.text).toContain('hosts      1 configured')
  })

  // Review round 1, item 5: raw output is for this machine's own terminal only.
  it('refuses redact=0 to a reader that may not have raw output, and says so', async () => {
    const res = await request(app(fixed, () => false)).get('/api/diagnostics?redact=0')
    expect(res.headers['x-diagnostics-redacted']).toBe('forced')
    expect(res.body.local.claude.path).toBe('/Users/\u2026/.local/bin/claude')
    expect(res.body.hosts[0].hostname).toBe('[host:1]')
    const text = await request(app(fixed, () => false)).get('/api/diagnostics?format=text&redact=0')
    expect(text.text).not.toContain('alice')
    expect(text.text).not.toContain('devbox.example.com')
  })

  // Review round 1, item 15: the hosts section is the hosts section in JSON too.
  it('returns only the hosts section as JSON with section=hosts', async () => {
    const res = await request(app(fixed)).get('/api/diagnostics?section=hosts')
    expect(Object.keys(res.body).sort()).toEqual(['build', 'collector', 'generatedAt', 'hosts', 'warnings'])
    expect(res.body.hosts).toHaveLength(1)
    expect(res.body.local).toBeUndefined()
    expect(res.body.config).toBeUndefined()
  })

  it('shares one collection between concurrent requests', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const sqlite = vi.fn(async () => { await gate; return { ok: true } })
    const a = app(() => ({ collector: 'server', probes: { ...probes, sqlite }, env: ENV, localTimeoutMs: 5_000 }))
    const first = request(a).get('/api/diagnostics').then((r) => r)
    const second = request(a).get('/api/diagnostics?format=text').then((r) => r)
    await vi.waitFor(() => expect(sqlite).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    release()
    const [r1, r2] = await Promise.all([first, second])
    expect(sqlite).toHaveBeenCalledTimes(1)
    expect(r1.status).toBe(200)
    expect(r2.text).toContain('sqlite     ok')
    // The shared collection is released once it settles: the next request collects again.
    await request(a).get('/api/diagnostics')
    expect(sqlite).toHaveBeenCalledTimes(2)
  })

  it('answers 200 with the reason when collection itself fails', async () => {
    const res = await request(app(() => { throw new Error('options exploded') })).get('/api/diagnostics?format=text')
    expect(res.status).toBe(200)
    expect(res.text).toContain('collection failed: options exploded')
  })
})

describe('who may read raw output', () => {
  it('treats only loopback socket addresses as this machine', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(a)).toBe(true)
    for (const a of [undefined, '', '192.168.1.20', '::ffff:10.0.0.5', 'fe80::1', '127.0.0.1.example.com']) expect(isLoopbackAddress(a)).toBe(false)
  })

  it('never allows raw output on a replica, and reads the socket, not a forwarded header', () => {
    const req = (remoteAddress: string, headers: Record<string, string> = {}) =>
      ({ socket: { remoteAddress }, headers }) as unknown as Parameters<typeof rawAllowed>[0]
    expect(rawAllowed(req('127.0.0.1'), false)).toBe(true)
    expect(rawAllowed(req('127.0.0.1'), true)).toBe(false)
    expect(rawAllowed(req('10.0.0.5', { 'x-forwarded-for': '127.0.0.1' }), false)).toBe(false)
  })
})

describe('serverDiagnosticsOptions', () => {
  // Review round 1, item 13: a replica answers dtach read-only, never through the installer.
  it('passes the terminal\'s dtach resolver on a primary only', () => {
    expect(serverDiagnosticsOptions(false).probes?.dtach).toBeTypeOf('function')
    expect(serverDiagnosticsOptions(true).probes?.dtach).toBeUndefined()
    expect(serverDiagnosticsOptions(true).probes?.webAssets).toBeTypeOf('function')
  })
})
