/**
 * POST /api/test/host-fixture drives the Playwright host fixture (C20, C52,
 * C72, C90): every action changes the fixture state the real buildHostStatus
 * reads, the hosts land in (and leave) config.hosts, and nothing dials.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

process.env.WALNUT_TEST_HOST_FIXTURE_MODE = '1'
const fixture = await import('../../../src/core/hosts/host-fixture.js')
const { testHostFixtureRouter } = await import('../../../src/web/routes/test-host-fixture.js')
const { getConfig } = await import('../../../src/core/config-manager.js')
const { getHostReadiness } = await import('../../../src/core/hosts/host-readiness.js')

const app = express().use(express.json()).use('/api/test/host-fixture', testHostFixtureRouter)
const act = (body: Record<string, unknown>) => request(app).post('/api/test/host-fixture').send(body)

const FILE = {
  user: 'alice',
  floor: { minVersion: '2.1.280', model: 'Opus 5.5' },
  hosts: {
    devbox: { label: 'Dev box', hostname: 'devbox.example.com', phase: 'connected', claude: { version: '2.1.281', auth: 'ok' } },
    buildbox: { label: 'Build box', hostname: 'build.example.com', phase: 'connected', claude: { version: '2.1.220', installMethod: 'other' } },
    netbox: { label: 'Net box', hostname: 'net.example.com', phase: 'failed', error: 'ssh: connect to host net.example.com port 22: No route to host' },
  },
}

beforeAll(async () => { expect((await act({ action: 'load', file: FILE })).status).toBe(200) })
afterAll(async () => {
  await act({ action: 'reset' })
  delete process.env.WALNUT_TEST_HOST_FIXTURE_MODE
})

describe('test host fixture actions', () => {
  it('load writes the hosts into config and seeds readiness for the connected ones', async () => {
    const hosts = (await getConfig()).hosts ?? {}
    expect(Object.keys(hosts)).toEqual(expect.arrayContaining(['devbox', 'buildbox', 'netbox']))
    expect(hosts.buildbox).toMatchObject({ hostname: 'build.example.com', user: 'alice', label: 'Build box' })
    expect(getHostReadiness('buildbox')?.problems.map((p) => p.kind)).toEqual(['claude_outdated'])
    expect(getHostReadiness('devbox')?.problems).toEqual([])
    expect(getHostReadiness('netbox')).toBeUndefined()
  })

  it('set-floor rewords the stored answers without a check; clear-problems clears one host', async () => {
    expect((await act({ action: 'set-floor', minVersion: '2.1.300' })).body.floor).toMatchObject({ minVersion: '2.1.300', model: 'Opus 5.5' })
    expect(getHostReadiness('devbox')?.problems.map((p) => p.kind)).toEqual(['claude_outdated'])
    const checks = fixture.fixtureCounters().check
    await act({ action: 'clear-problems', host: 'devbox' })
    expect(getHostReadiness('devbox')?.problems).toEqual([])
    expect(getHostReadiness('devbox')?.claude.version).toBe('2.1.300')
    expect(fixture.fixtureCounters().check).toEqual(checks)
    await act({ action: 'set-floor', minVersion: '2.1.280' })
  })

  it('set-status, start-reconnect and inject-failure move the host the way the real loop would', async () => {
    await act({ action: 'set-status', host: 'buildbox', phase: 'failed', kind: 'auth' })
    expect(fixture.fixtureHost('buildbox')).toMatchObject({ phase: 'failed', kind: 'auth' })
    await act({ action: 'start-reconnect', host: 'buildbox' })
    expect(fixture.fixtureHost('buildbox')?.phase).toBe('reconnecting')
    await act({ action: 'inject-failure', host: 'buildbox', kind: 'timeout' })
    expect(fixture.fixtureHost('buildbox')).toMatchObject({ phase: 'reconnecting', kind: 'timeout' })
    await act({ action: 'inject-failure', host: 'buildbox', kind: 'auth' })
    const h = fixture.fixtureHost('buildbox')!
    expect(h.phase).toBe('failed')
    expect(h.probeAt).toBeGreaterThan(fixture.fixtureNow())
    await act({ action: 'set-status', host: 'buildbox', phase: 'connected' })
    expect(fixture.fixtureHost('buildbox')?.phase).toBe('connected')
  })

  it('the next connect and the next check answer what the actions set', async () => {
    await act({ action: 'renew-credential', host: 'netbox' })
    expect(fixture.fixtureConnectAttempt('netbox').connected).toBe(true)
    await act({ action: 'set-shell-setup', host: 'buildbox', claudeVersion: '2.1.281' })
    expect(fixture.fixtureHost('buildbox')?.shellSetupVersion).toBe('2.1.281')
    await act({ action: 'autofix-slow', host: 'buildbox', ms: 200_000 })
    expect(fixture.fixtureHost('buildbox')?.autofixSlowMs).toBe(200_000)
    const counters = await request(app).get('/api/test/host-fixture/counters')
    expect(counters.body.connect.netbox).toBe(1)
  })

  it('advance-clock moves the fixture clock; unknown hosts and actions are refused', async () => {
    const before = fixture.fixtureNow()
    await act({ action: 'advance-clock', ms: 600_000 })
    expect(fixture.fixtureNow() - before).toBeGreaterThanOrEqual(600_000)
    expect((await act({ action: 'set-status', host: 'nosuch', phase: 'connected' })).status).toBe(404)
    expect((await act({ action: 'nosuch' })).status).toBe(400)
  })

  it('remove-host takes the host out of config and the fixture; reset takes the rest', async () => {
    await act({ action: 'remove-host', host: 'netbox' })
    expect((await getConfig()).hosts?.netbox).toBeUndefined()
    expect(fixture.isFixtureHost('netbox')).toBe(false)
    const reset = await act({ action: 'reset' })
    expect(reset.body.removed).toEqual(expect.arrayContaining(['devbox', 'buildbox']))
    expect(Object.keys((await getConfig()).hosts ?? {})).not.toContain('devbox')
    expect(fixture.fixtureHosts()).toEqual([])
    await act({ action: 'load', file: FILE })
  })
})
