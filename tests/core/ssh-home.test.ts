/**
 * The one helper every ~/.ssh read goes through (src/lib/ssh-home.ts): $HOME by default, the
 * account's home once Walnut Demo's "Use my SSH hosts" is on. The scanner follows it, Include and
 * ~ included, and the Demo's remote isolation does not move with it.
 *
 * Both homes are temp dirs; the machine's own ~/.ssh is never read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// The passwd home differs from every HOME the test sets, so a lookup that answers $HOME (what
// os.userInfo() does on bun) fails this test.
vi.mock('../../src/lib/account.js', async (orig) => ({ ...(await orig<object>()), accountInfo: () => ({ username: 'p', homedir: '/passwd/home', shell: '', uid: 1, gid: 1 }) }))

import { accountSshInUse, setAccountSsh, sshAgentEnv, sshAgentSock, sshDir, sshDirs, sshHome } from '../../src/lib/ssh-home.js'
import { _resetScanCacheForTest, scanSshConfig } from '../../src/core/ssh-config-scanner.js'
import { remoteIsolationFor } from '../../src/providers/remote-isolation.js'

let base: string
let demoHome: string
let realHome: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ssh-home-')))
  demoHome = path.join(base, 'demo-home')
  realHome = path.join(base, 'account')
  fs.mkdirSync(path.join(demoHome, '.ssh'), { recursive: true })
  fs.mkdirSync(path.join(realHome, '.ssh', 'conf.d'), { recursive: true })
  vi.stubEnv('HOME', demoHome)
  vi.stubEnv('SSH_AUTH_SOCK', '/tmp/env-agent.sock')
  _resetScanCacheForTest()
})

afterEach(() => {
  setAccountSsh(null)
  vi.unstubAllEnvs()
  fs.rmSync(base, { recursive: true, force: true })
})

describe('sshHome', () => {
  it('is $HOME and its agent until the account is used', () => {
    expect(sshHome()).toBe(demoHome)
    expect(sshDir()).toBe(path.join(demoHome, '.ssh'))
    // The OS account's own ~/.ssh is always one of them: its keys are the person's, whatever HOME says.
    expect(sshDirs()).toEqual([...new Set([path.join(demoHome, '.ssh'), '/passwd/home/.ssh'])])
    expect(sshAgentSock()).toBe('/tmp/env-agent.sock')
    expect(sshAgentEnv()).toBeUndefined()
    expect(accountSshInUse()).toBe(false)
  })

  it('is the account once used, with the agent the Demo captured (or none)', () => {
    setAccountSsh({ home: realHome, agentSock: '/tmp/launcher.sock' })
    expect(sshHome()).toBe(realHome)
    expect(sshDirs()).toEqual([...new Set([path.join(demoHome, '.ssh'), path.join(realHome, '.ssh'), '/passwd/home/.ssh'])])
    expect(sshAgentSock()).toBe('/tmp/launcher.sock')
    expect(sshAgentEnv({ LANG: 'C', SSH_AUTH_SOCK: '/tmp/env-agent.sock' })).toEqual({ LANG: 'C', SSH_AUTH_SOCK: '/tmp/launcher.sock' })
    setAccountSsh({ home: realHome, agentSock: undefined })
    expect(sshAgentSock()).toBeUndefined()
    expect(sshAgentEnv({ LANG: 'C', SSH_AUTH_SOCK: '/tmp/env-agent.sock' })).toEqual({ LANG: 'C' })
  })

  it('ignores a relative home', () => {
    setAccountSsh({ home: 'relative/home', agentSock: undefined })
    expect(accountSshInUse()).toBe(false)
    expect(sshHome()).toBe(demoHome)
  })
})

describe('the scanner reads the home sshHome names', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(demoHome, '.ssh', 'config'), 'Host demo-only\n  HostName 127.0.0.1\n')
    fs.writeFileSync(path.join(realHome, '.ssh', 'config'), [
      'Include ~/.ssh/conf.d/*.conf',
      'Include extra',
      'Host lab-box',
      '  HostName 10.0.0.9',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(realHome, '.ssh', 'conf.d', 'a.conf'), 'Host from-glob\n  HostName 10.0.0.10\n  User dev\n')
    fs.writeFileSync(path.join(realHome, '.ssh', 'extra'), 'Host from-relative\n  HostName 10.0.0.11\n  Port 2222\n')
  })

  it('off: only the HOME config', async () => {
    expect([...(await scanSshConfig()).keys()]).toEqual(['demo-only'])
  })

  it('on: the account config, its ~ and relative Includes resolved in the account home', async () => {
    setAccountSsh({ home: realHome, agentSock: undefined })
    const found = await scanSshConfig()
    expect([...found.keys()].sort()).toEqual(['from-glob', 'from-relative', 'lab-box'])
    expect(found.get('from-glob')).toMatchObject({ hostname: '10.0.0.10', user: 'dev' })
    expect(found.get('from-relative')).toMatchObject({ hostname: '10.0.0.11', port: 2222 })
    setAccountSsh(null)
    expect([...(await scanSshConfig()).keys()]).toEqual(['demo-only'])
  })
})

describe('the Demo\'s remote isolation does not follow the opt-in', () => {
  it('gives every ssh host the same isolated root with the account\'s ~/.ssh in use', () => {
    const input = { hostKey: 'lab-box', env: {}, ephemeral: true, link: 'ssh', home: path.join(base, 'data', 'gen-1'), demo: { closed: false } }
    const off = remoteIsolationFor(input)
    setAccountSsh({ home: realHome, agentSock: '/tmp/launcher.sock' })
    const on = remoteIsolationFor(input)
    expect(on).toEqual(off)
    expect(on.mode).toBe('isolated')
    expect(remoteIsolationFor({ ...input, demo: { closed: true } })).toEqual({ mode: 'off', reason: 'demo-stopped' })
    // remote-isolation.ts asks nothing of the ssh home.
    const src = fs.readFileSync(path.join(__dirname, '../../src/providers/remote-isolation.ts'), 'utf8')
    expect(src).not.toMatch(/ssh-home|demo-real-ssh/)
  })
})
