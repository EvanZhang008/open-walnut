/**
 * Test-ssh isolation ratchet, by behavior: a server under test that is NOT
 * behind isolateFromRealSsh() runs no ssh at all.
 *
 * A server reads ~/.ssh/config (its Host blocks become discovered hosts) and,
 * at startup, sweeps every host it knows over ssh for orphaned terminal
 * sessions, with a ControlMaster (src/web/terminal/dtach-lifecycle.ts). A
 * gate review watched test servers do exactly that and leave real
 * ControlMasters open to the developer's own machines. The old ratchet read
 * test files for the helper's name and let more than two hundred files from
 * before the rule keep doing it.
 *
 * Now the server itself refuses (src/lib/real-ssh-guard.ts): under a test
 * runner, without the isolation marker, it skips the ssh config and the sweep.
 * This file starts such a server the way any of those files does, except that
 * HOME is a stand-in holding a canary ssh config and the first `ssh` on PATH
 * only records, so a regression shows up as a recorded call and never reaches
 * a real host. tests/web/test-server-no-real-ssh.test.ts is the other half: an
 * isolated server still sweeps, through the stand-in.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-ssh-unisolated'))

import { CONFIG_FILE } from '../../src/constants.js'
import { log } from '../../src/logging/index.js'
import { getConfig } from '../../src/core/config-manager.js'
import { realSshReachAllowed, underTestRunner } from '../../src/lib/real-ssh-guard.js'
import { startServer, stopServer } from '../../src/web/server.js'

const SWEEP_SKIPPED = 'terminal sweep skipped: a server under test without ssh isolation never runs ssh'

let base = ''
let sshLog = ''
let saved: Record<string, string | undefined> = {}
const infos: string[] = []

function sshCalls(): string[] {
  try { return fs.readFileSync(sshLog, 'utf-8').split('\n').filter(Boolean) } catch { return [] }
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-unisolated-'))
  const home = path.join(base, 'home')
  const bin = path.join(base, 'bin')
  sshLog = path.join(base, 'ssh.log')
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true })
  fs.mkdirSync(bin, { recursive: true })
  // TEST-NET-1 (RFC 5737): nothing answers there, even if a real ssh ran.
  fs.writeFileSync(path.join(home, '.ssh', 'config'), 'Host canary-from-ssh-config\n  HostName 192.0.2.2\n  User nobody\n')
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sshLog)}\nexit 255\n`, { mode: 0o755 })
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, 'version: 1\nhosts:\n  canary-from-config:\n    hostname: 192.0.2.3\n    user: nobody\n')

  saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PATH: process.env.PATH,
    WALNUT_TEST_SSH_ISOLATED_HOME: process.env.WALNUT_TEST_SSH_ISOLATED_HOME,
  }
  // What a test file without the helper looks like, minus the real HOME: no marker.
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ''}`
  delete process.env.WALNUT_TEST_SSH_ISOLATED_HOME

  const realInfo = log.web.info.bind(log.web)
  vi.spyOn(log.web, 'info').mockImplementation((message: string, meta?: Record<string, unknown>) => {
    infos.push(message)
    realInfo(message, meta)
  })
  await startServer({ port: 0, dev: true })
}, 60_000)

afterAll(async () => {
  try { await stopServer() } catch { /* already down */ }
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (base) fs.rmSync(base, { recursive: true, force: true })
})

describe('a server under test without isolateFromRealSsh()', () => {
  it('does not read ~/.ssh/config: its Host blocks never become hosts', async () => {
    const hosts = (await getConfig()).hosts ?? {}
    expect(Object.keys(hosts)).toContain('canary-from-config')
    expect(Object.keys(hosts)).not.toContain('canary-from-ssh-config')
  })

  it('runs no ssh at startup: the terminal sweep is skipped, not sent', async () => {
    const end = Date.now() + 30_000
    while (Date.now() < end && !infos.includes(SWEEP_SKIPPED) && sshCalls().length === 0) {
      await new Promise((r) => setTimeout(r, 200))
    }
    // A sweep that did start would have reached ssh within this grace.
    await new Promise((r) => setTimeout(r, 3_000))
    expect(sshCalls(), 'a server under test ran ssh without the isolation').toEqual([])
    expect(infos).toContain(SWEEP_SKIPPED)
  }, 45_000)
})

describe('the guard (src/lib/real-ssh-guard.ts)', () => {
  it('knows a test runner by vitest, NODE_ENV=test, or WALNUT_TEST_SERVER=1', () => {
    expect(underTestRunner({ VITEST: 'true' })).toBe(true)
    expect(underTestRunner({ VITEST_WORKER_ID: '1' })).toBe(true)
    expect(underTestRunner({ NODE_ENV: 'test' })).toBe(true)
    expect(underTestRunner({ WALNUT_TEST_SERVER: '1' })).toBe(true)
    expect(underTestRunner({ NODE_ENV: 'production' })).toBe(false)
    expect(underTestRunner({})).toBe(false)
  })

  it('lets a real server reach ssh, and a test server only behind the isolation of its current HOME', () => {
    expect(realSshReachAllowed({ HOME: '/home/someone' })).toBe(true)
    expect(realSshReachAllowed({ VITEST: 'true', HOME: '/home/someone' })).toBe(false)
    expect(realSshReachAllowed({ VITEST: 'true', HOME: '/tmp/iso', WALNUT_TEST_SSH_ISOLATED_HOME: '/tmp/iso' })).toBe(true)
    // A marker left behind after HOME moved back is not trusted.
    expect(realSshReachAllowed({ VITEST: 'true', HOME: '/home/someone', WALNUT_TEST_SSH_ISOLATED_HOME: '/tmp/iso' })).toBe(false)
  })

  it('the helper marks the isolation and takes the mark away again', async () => {
    const { isolateFromRealSsh } = await import('../helpers/isolate-ssh.js')
    const before = process.env.WALNUT_TEST_SSH_ISOLATED_HOME
    const isolation = isolateFromRealSsh()
    try {
      expect(process.env.WALNUT_TEST_SSH_ISOLATED_HOME).toBe(isolation.home)
      expect(realSshReachAllowed()).toBe(true)
    } finally {
      isolation.restore()
    }
    expect(process.env.WALNUT_TEST_SSH_ISOLATED_HOME).toBe(before)
    expect(realSshReachAllowed()).toBe(false)
  })

  it('the helper closes both doors: a throwaway HOME, and an ssh that refuses and records', async () => {
    const { execFileSync } = await import('node:child_process')
    const { isolateFromRealSsh } = await import('../helpers/isolate-ssh.js')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-isolation-'))
    const homeBefore = process.env.HOME
    const isolation = isolateFromRealSsh(dir)
    try {
      expect(os.homedir()).toBe(isolation.home)
      expect(fs.readdirSync(path.join(isolation.home, '.ssh'))).toEqual([])
      let code = 0
      let stderr = ''
      try {
        execFileSync('ssh', ['-o', 'BatchMode=yes', 'devbox', 'true'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 })
      } catch (err) {
        code = (err as { status?: number }).status ?? -1
        stderr = String((err as { stderr?: Buffer }).stderr ?? '')
      }
      expect(code).toBe(255)
      expect(stderr).toContain('refused by the test')
      expect(isolation.calls()).toEqual(['-o BatchMode=yes devbox true'])
    } finally {
      isolation.restore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
    expect(process.env.HOME).toBe(homeBefore)
  })
})
