/**
 * The host fixture route can rewrite config.hosts, so two guards keep it a test
 * tool: it is mounted only on an ephemeral, non-cloud server with the flag set
 * (hostFixtureRouteAllowed), and it reads a fixture only by name or from a .json
 * path inside tests/e2e/browser/fixtures (readFixture): never `..`, an outside
 * absolute path, a symlink that leads out, or a subdirectory.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

// The route module pulls in config and readiness: keep them off the real data dir.
vi.mock('../../../src/constants.js', () => createMockConstants())

const { hostFixtureRouteAllowed } = await import('../../../src/core/hosts/host-fixture.js')
const { readFixture } = await import('../../../src/web/routes/test-host-fixture.js')

describe('hostFixtureRouteAllowed', () => {
  const on = { WALNUT_TEST_HOST_FIXTURE_MODE: '1' }
  it('needs the flag AND an ephemeral server AND not cloud mode', () => {
    expect(hostFixtureRouteAllowed({ env: on, ephemeral: true, cloudMode: false })).toBe(true)
    // A leaked env var on the real server or on the cloud companion opens nothing.
    expect(hostFixtureRouteAllowed({ env: on, ephemeral: false, cloudMode: false })).toBe(false)
    expect(hostFixtureRouteAllowed({ env: on, ephemeral: true, cloudMode: true })).toBe(false)
    expect(hostFixtureRouteAllowed({ env: {}, ephemeral: true, cloudMode: false })).toBe(false)
    expect(hostFixtureRouteAllowed({ env: { WALNUT_TEST_HOST_FIXTURE_MODE: 'true' }, ephemeral: true, cloudMode: false })).toBe(false)
  })
})

describe('readFixture', () => {
  let root: string
  let dir: string
  let prevDir: string | undefined
  const body = { hosts: { devbox: { hostname: 'devbox.example.com', phase: 'connected' } } }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-fixture-guard-'))
    dir = path.join(root, 'tests', 'e2e', 'browser', 'fixtures')
    fs.mkdirSync(path.join(dir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(body))
    fs.writeFileSync(path.join(dir, 'sub', 'inner.json'), JSON.stringify(body))
    fs.writeFileSync(path.join(root, 'outside.json'), JSON.stringify(body))
    fs.symlinkSync(path.join(root, 'outside.json'), path.join(dir, 'link.json'))
    prevDir = process.env.WALNUT_TEST_HOST_FIXTURE_DIR
    process.env.WALNUT_TEST_HOST_FIXTURE_DIR = dir
  })
  afterAll(() => {
    if (prevDir === undefined) delete process.env.WALNUT_TEST_HOST_FIXTURE_DIR
    else process.env.WALNUT_TEST_HOST_FIXTURE_DIR = prevDir
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reads a fixture by name, by a relative .json path, and by an absolute path inside the dir', async () => {
    expect(await readFixture('good')).toEqual(body)
    expect(await readFixture('good.json')).toEqual(body)
    expect(await readFixture(path.join(dir, 'good.json'))).toEqual(body)
  })

  it.each([
    ['a parent path', '../../../../outside.json'],
    ['an outside absolute path', '__ROOT__/outside.json'],
    ['a symlink that leads out', 'link.json'],
    ['a subdirectory', 'sub/inner.json'],
    ['a non-json path', '/etc/passwd'],
    ['a dot name', '..'],
  ])('refuses %s with a 400', async (_label, raw) => {
    const err = await readFixture(raw.replace('__ROOT__', root)).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(400)
  })

  it('refuses any fixture dir that is not tests/e2e/browser/fixtures', async () => {
    process.env.WALNUT_TEST_HOST_FIXTURE_DIR = root
    try {
      const err = await readFixture('outside').catch((e) => e)
      expect(err.status).toBe(400)
      expect(err.message).toMatch(/tests\/e2e\/browser\/fixtures/)
    } finally {
      process.env.WALNUT_TEST_HOST_FIXTURE_DIR = dir
    }
  })
})
