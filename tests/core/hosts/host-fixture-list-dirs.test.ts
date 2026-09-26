/**
 * list-dirs on the Playwright fixture server (C23, C26): that server is itself
 * ephemeral, so a fixture host must answer for itself BEFORE the "remote hosts
 * are off" rule, and only an ephemeral FIXTURE turns its hosts off. A host the
 * fixture does not own still gets the off answer. Nothing dials.
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test', { IS_EPHEMERAL: true }))

const fixture = await import('../../../src/core/hosts/host-fixture.js')
const { listDirsRoute } = await import('../../../src/core/hosts/host-connect-action.js')

const HOSTS = {
  devbox: { label: 'Dev box', hostname: 'devbox.example.com', phase: 'connected' as const },
}

beforeAll(() => { process.env.WALNUT_TEST_HOST_FIXTURE_MODE = '1' })
afterAll(() => { delete process.env.WALNUT_TEST_HOST_FIXTURE_MODE })
afterEach(() => { fixture.resetFixtureState() })

describe('listDirsRoute under the host fixture', () => {
  it('a fixture host lists through the fixture even though the server is ephemeral', async () => {
    fixture.loadFixtureState({ user: 'alice', hosts: HOSTS })
    const r = await listDirsRoute('devbox', { prefix: '~/', depth: 1 })
    expect(r.kind).toBe('fixture')
    expect(fixture.fixtureCounters().listDirs.devbox).toBe(1)
  })

  it('an ephemeral fixture turns its hosts off, with the off sentence', async () => {
    fixture.loadFixtureState({ user: 'alice', ephemeral: true, hosts: HOSTS })
    const r = await listDirsRoute('devbox', { prefix: '~/', depth: 1 })
    expect(r).toMatchObject({ kind: 'answer', result: { hostError: { kind: 'ephemeral', message: 'Remote hosts are off on this test server.' } } })
  })

  it('a host the fixture does not own is off on an ephemeral server', async () => {
    fixture.loadFixtureState({ user: 'alice', hosts: HOSTS })
    const r = await listDirsRoute('otherbox', { prefix: '/srv/', depth: 1 })
    expect(r).toMatchObject({ kind: 'answer', result: { hostError: { kind: 'ephemeral' } } })
  })
})
