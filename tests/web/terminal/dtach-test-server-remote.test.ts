/**
 * The in-app terminal reaches a remote host over its own ssh, not through the
 * daemon, so it needs isolation of its own (src/providers/remote-isolation.ts): a
 * test server's remote terminals live under its own root
 * (`/tmp/open-walnut-test-<key>/term`), it builds dtach into its own install home,
 * and a host that is off for test servers refuses the terminal too.
 *
 * MACHINE SAFETY: no host is dialled; the probe script runs under /bin/sh with a
 * temp HOME and writes nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-term-iso', { IS_EPHEMERAL: true }))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.com', user: 'tester' } } }),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { isolationKey } from '../../../src/providers/remote-isolation.js'
import { REMOTE_DTACH_OWN_BIN, REMOTE_DTACH_SOCKET_DIR, resolveSshTarget } from '../../../src/web/terminal/spawn.js'
import { buildInstallScript, buildProbeScript } from '../../../src/web/terminal/dtach-probe-script.js'
import { DTACH_SOURCES } from '../../../src/web/terminal/dtach-sources.js'
import { REMOTE_TEST_ROOT, dtachOwnerClaimScript, testServerTerminalHosts } from '../../../src/web/terminal/spawn.js'

const saved = process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
afterEach(() => {
  if (saved === undefined) delete process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
  else process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = saved
})

const ROOT = `/tmp/open-walnut-test-${isolationKey(WALNUT_HOME)}`

describe('a test server\'s remote terminals stay in its own root', () => {
  it('its sockets and its dtach live under its /tmp root', () => {
    expect(REMOTE_DTACH_SOCKET_DIR).toBe(`${ROOT}/term`)
    expect(REMOTE_DTACH_OWN_BIN).toBe(`${ROOT}/home/.local/bin/walnut-dtach`)
  })

  it('the install writes its own dtach, never ~/.local/bin', () => {
    const script = buildInstallScript({ sources: DTACH_SOURCES, cc: 'cc', ownBin: REMOTE_DTACH_OWN_BIN, ownRoot: REMOTE_TEST_ROOT })
    expect(script).toContain(`B='${REMOTE_DTACH_OWN_BIN}'`)
    expect(script).not.toMatch(/\$HOME\/\.local\/bin/)
  })

  it('the probe looks at its own dtach first and writes nothing', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-term-iso-home-')))
    try {
      const script = buildProbeScript({ ownBin: REMOTE_DTACH_OWN_BIN })
      expect(script.indexOf(REMOTE_DTACH_OWN_BIN!)).toBeLessThan(script.indexOf('$HOME/.local/bin'))
      execFileSync('/bin/sh', ['-s'], { input: script, encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: home } })
      expect(fs.readdirSync(home)).toEqual([])
      expect(fs.existsSync(ROOT)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('a host that is off for test servers refuses the terminal; the opt-in lets it through', async () => {
    delete process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS
    await expect(resolveSshTarget('devbox')).rejects.toThrow(/ephemeral server: remote host 'devbox' is off for test servers/)
    process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS = '1'
    await expect(resolveSshTarget('devbox')).resolves.toMatchObject({ hostname: 'devbox.example.com' })
    // Its exit ends that host's terminals and removes its root there, daemon or not.
    expect(testServerTerminalHosts()).toEqual(['devbox'])
  })

  it('a root someone planted as a symlink stops the install and the socket claim before they write', () => {
    expect(REMOTE_TEST_ROOT).toBe(ROOT)
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-term-iso-plant-')))
    const target = path.join(scratch, 'real-home')
    fs.mkdirSync(target)
    fs.symlinkSync(target, ROOT)
    try {
      const run = (input: string) => {
        try { execFileSync('/bin/sh', ['-s'], { input, encoding: 'utf-8', env: { PATH: '/usr/bin:/bin', HOME: scratch } }); return 0 } catch (e) { return (e as { status: number }).status }
      }
      expect(run(buildInstallScript({ sources: DTACH_SOURCES, cc: 'cc', ownBin: REMOTE_DTACH_OWN_BIN, ownRoot: REMOTE_TEST_ROOT }))).toBe(97)
      expect(run(dtachOwnerClaimScript(true))).toBe(97)
      expect(run(buildProbeScript({ ownBin: REMOTE_DTACH_OWN_BIN, ownRoot: REMOTE_TEST_ROOT }))).toBe(97)
      expect(fs.readdirSync(target)).toEqual([])
    } finally {
      fs.unlinkSync(ROOT)
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('the socket claim makes its own root 0700 and claims the term dir', () => {
    try {
      execFileSync('/bin/sh', ['-c', dtachOwnerClaimScript(true)], { encoding: 'utf-8', env: { PATH: '/usr/bin:/bin' } })
      expect(fs.statSync(ROOT).mode & 0o777).toBe(0o700)
      expect(fs.existsSync(`${ROOT}/term`)).toBe(true)
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true })
    }
  })
})
