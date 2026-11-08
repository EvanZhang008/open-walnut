/**
 * Walnut Demo's "Use my SSH hosts" over a real server (src/commands/demo-routes.ts, demo-real-ssh.ts).
 *
 * The Demo's front door runs ahead of every route: GET /api/demo/generation says whether the
 * opt-in is on and possible, and POST /api/demo/ssh-hosts turns it on for this generation only.
 * A page of another generation (a reset happened) gets 409 and changes nothing. Once on, the
 * server's scanner reads the account's ~/.ssh/config (here a temp dir standing in for it; the
 * machine's own ~/.ssh is never read), and found hosts still wait for their own yes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

const account = vi.hoisted(() => ({ homedir: '' }))
vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: account.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-demo-ssh-hosts'))

import { startServer, stopServer } from '../../src/web/server.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { demoPaths, type DemoPaths } from '../../src/commands/demo-home.js'
import { demoBeforeRoutes, type DemoRouteOptions } from '../../src/commands/demo-routes.js'
import { demoRealSshFlag, prepareDemoRealSsh } from '../../src/commands/demo-real-ssh.js'
import { accountSshInUse, setAccountSsh, sshHome } from '../../src/lib/ssh-home.js'
import { _resetScanCacheForTest, scanSshConfig } from '../../src/core/ssh-config-scanner.js'

let base: string
let paths: DemoPaths
let url: string
const opts: DemoRouteOptions = {
  paths: undefined as unknown as DemoPaths, generation: 'gen-a', signInCommand: null, host: '', url: '', closed: () => false,
}

beforeAll(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-ssh-route-')))
  // The account's home, a stand-in: its ~/.ssh/config names one host through an Include and ~.
  account.homedir = path.join(base, 'account')
  fs.mkdirSync(path.join(account.homedir, '.ssh', 'conf.d'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(account.homedir, '.ssh', 'config'), 'Include ~/.ssh/conf.d/*.conf\n', { mode: 0o600 })
  fs.writeFileSync(path.join(account.homedir, '.ssh', 'conf.d', 'lab.conf'), 'Host lab-box\n  HostName 10.0.0.9\n  User dev\n', { mode: 0o600 })
  paths = demoPaths(path.join(base, 'open-walnut-demo'), 'gen-a')
  fs.mkdirSync(path.join(paths.home, '.ssh'), { recursive: true, mode: 0o700 })
  await prepareDemoRealSsh(paths, account.homedir, undefined)
  opts.paths = paths
  const server = await startServer({ port: 0, dev: true, bindAddress: '127.0.0.1', beforeRoutes: demoBeforeRoutes(opts) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test server address')
  opts.host = `127.0.0.1:${address.port}`
  opts.url = url = `http://127.0.0.1:${address.port}`
}, 120_000)

afterAll(async () => {
  setAccountSsh(null)
  await stopServer({ dropConnections: true })
  fs.rmSync(base, { recursive: true, force: true })
})

const generation = async () => (await fetch(`${url}/api/demo/generation`)).json() as Promise<Record<string, unknown>>

describe('Demo "Use my SSH hosts" route', () => {
  it('starts off, and says the account has a config to read', async () => {
    expect(await generation()).toEqual({ generation: 'gen-a', signInCommand: null, realSsh: false, realSshAvailable: true })
    expect(accountSshInUse()).toBe(false)
  })

  it('refuses a page of another generation, and one naming none, writing nothing', async () => {
    for (const headers of [{ 'x-walnut-demo-generation': 'gen-old' }, {} as Record<string, string>]) {
      const res = await fetch(`${url}/api/demo/ssh-hosts`, { method: 'POST', headers })
      expect(res.status).toBe(409)
    }
    expect(fs.existsSync(demoRealSshFlag(paths))).toBe(false)
    expect(accountSshInUse()).toBe(false)
    expect((await generation()).realSsh).toBe(false)
  })

  it('answers another address with 421', async () => {
    const res = await fetch(`${url}/api/demo/generation`, { headers: { host: 'localhost:9' } })
    expect(res.status).toBe(421)
  })

  it('turns on for this generation: the flag is written, found hosts wait for a yes, the scanner reads the account', async () => {
    const res = await fetch(`${url}/api/demo/ssh-hosts`, { method: 'POST', headers: { 'x-walnut-demo-generation': 'gen-a' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ realSsh: true })
    const flag = fs.statSync(demoRealSshFlag(paths))
    expect(flag.mode & 0o777).toBe(0o600)
    expect((await generation()).realSsh).toBe(true)
    expect(sshHome()).toBe(path.resolve(account.homedir))
    // A found host is never merged on as said yes to: the server asks first.
    expect(fs.readFileSync(path.join(WALNUT_HOME, 'config.yaml'), 'utf8')).toMatch(/asking_since:/)
    _resetScanCacheForTest()
    const found = await scanSshConfig()
    expect(found.get('lab-box')).toMatchObject({ hostname: '10.0.0.9', user: 'dev' })
    // Nothing was written into the account's ~/.ssh.
    expect(fs.readdirSync(path.join(account.homedir, '.ssh')).sort()).toEqual(['conf.d', 'config'])
  })

  it('a reset generation starts off again', async () => {
    const next = demoPaths(path.join(base, 'open-walnut-demo'), 'gen-b')
    await prepareDemoRealSsh(next, account.homedir, undefined)
    expect(fs.existsSync(demoRealSshFlag(next))).toBe(false)
    // The flag lives in the generation's data dir, which a reset removes (demo-home.ts clearDemoHome).
    expect(demoRealSshFlag(paths).startsWith(paths.data + path.sep)).toBe(true)
  })
})
