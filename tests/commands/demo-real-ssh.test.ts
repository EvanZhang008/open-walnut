/**
 * Walnut Demo's "Use my SSH hosts" (src/commands/demo-real-ssh.ts, demo-ssh.ts): off, the ssh and
 * scp wrappers run exactly as before with the Demo HOME's own settings and no agent; on, they run
 * with `real_config`, whose Walnut overrides come BEFORE the account's own config (OpenSSH keeps
 * the first value), and with the agent the launcher was started with.
 *
 * The account's home is a temp dir here. No real ssh connects: a fake one prints its arguments,
 * and the one OpenSSH check is `ssh -G` (prints the resolved settings, dials nothing) on temp files.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { guardedPath } from '../setup/exec-guard.js'

const account = vi.hoisted(() => ({ homedir: '' }))
vi.mock('../../src/lib/account.js', () => ({
  accountInfo: () => ({ username: 'demo-user', homedir: account.homedir, shell: '/bin/sh', uid: 501, gid: 20 }),
}))

import { demoPaths, type DemoPaths } from '../../src/commands/demo-home.js'
import { demoSshBinDir, demoSshConfigFile, prepareDemoSsh } from '../../src/commands/demo-ssh.js'
import {
  applyDemoRealSsh, demoAgentSockFile, demoRealSshAvailable, demoRealSshConfigFile, demoRealSshFlag, demoRealSshOn, enableDemoRealSsh,
  startDemoRealSsh,
} from '../../src/commands/demo-real-ssh.js'
import { accountSshInUse, setAccountSsh, sshAgentSock, sshDirs, sshHome } from '../../src/lib/ssh-home.js'

let base: string
let paths: DemoPaths
let fakeBin: string
let realSsh: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-real-ssh-')))
  account.homedir = path.join(base, 'account')
  realSsh = path.join(account.homedir, '.ssh')
  fs.mkdirSync(realSsh, { recursive: true, mode: 0o700 })
  paths = demoPaths(path.join(base, 'open-walnut-demo'), 'gen-1')
  fs.mkdirSync(paths.home, { recursive: true })
  fakeBin = path.join(base, 'system-bin')
  fs.mkdirSync(fakeBin)
  for (const name of ['ssh', 'scp']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '${name} agent=%s' "\${SSH_AUTH_SOCK-unset}"; for a in "$@"; do printf ' [%s]' "$a"; done; echo\n`, { mode: 0o755 })
  }
})

afterEach(() => {
  setAccountSsh(null)
  fs.rmSync(base, { recursive: true, force: true })
})

const run = (name: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(path.join(demoSshBinDir(paths), name), ['-G', 'lab-box'], { encoding: 'utf8', env: { PATH: guardedPath(), ...env } }).trim()

describe.skipIf(process.platform === 'win32')('Demo "Use my SSH hosts"', () => {
  it('off: the wrappers run exactly as before, with the Demo settings and no agent of the account', async () => {
    fs.writeFileSync(path.join(realSsh, 'config'), 'Host lab-box\n  HostName 10.0.0.9\n')
    await prepareDemoSsh(paths, fakeBin, '/tmp/agent.sock')
    expect(await demoRealSshOn(paths)).toBe(false)
    for (const name of ['ssh', 'scp']) {
      expect(run(name)).toBe(`${name} agent=unset [-F] [${demoSshConfigFile(paths)}] [-G] [lab-box]`)
    }
    expect(fs.readFileSync(demoSshConfigFile(paths), 'utf8')).not.toContain(account.homedir)
    expect(await applyDemoRealSsh(paths)).toBe(false)
    expect(accountSshInUse()).toBe(false)
  })

  it('on: real_config, overrides before the account Include, and the launcher\'s agent', async () => {
    fs.writeFileSync(path.join(realSsh, 'config'), 'Host lab-box\n  HostName 10.0.0.9\n')
    await prepareDemoSsh(paths, fakeBin, '/tmp/agent.sock')
    expect(await demoRealSshAvailable(paths)).toBe(true)
    await enableDemoRealSsh(paths)
    expect(fs.statSync(demoRealSshFlag(paths)).mode & 0o777).toBe(0o600)
    for (const name of ['ssh', 'scp']) {
      expect(run(name)).toBe(`${name} agent=/tmp/agent.sock [-F] [${demoRealSshConfigFile(paths)}] [-G] [lab-box]`)
    }
    const lines = fs.readFileSync(demoRealSshConfigFile(paths), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
    const include = lines.indexOf(`Include "${path.join(realSsh, 'config')}"`)
    expect(include).toBeGreaterThan(0)
    const before = lines.slice(0, include)
    expect(before).toEqual([
      `UserKnownHostsFile "${path.join(paths.home, '.ssh', 'known_hosts')}" "${path.join(realSsh, 'known_hosts')}"`,
      'UpdateHostKeys no', 'ForwardAgent no', 'ForwardX11 no', 'ControlPath none',
    ])
    // No Host line ahead of the overrides (they apply to every host), and no IdentityAgent none: the agent is the account's.
    expect(lines.some((l) => /^\s*IdentityAgent/i.test(l))).toBe(false)
    expect(fs.statSync(demoRealSshConfigFile(paths)).mode & 0o777).toBe(0o600)
    // This process reads the account's ~/.ssh and agent from now on.
    expect(sshHome()).toBe(account.homedir)
    expect(sshAgentSock({})).toBe('/tmp/agent.sock')
    expect(sshDirs({ HOME: paths.home })).toEqual([...new Set([path.join(paths.home, '.ssh'), realSsh, realSsh])])
    // Nothing was written into the account's ~/.ssh.
    expect(fs.readdirSync(realSsh)).toEqual(['config'])
  })

  it('on with no agent at launch: ssh gets none', async () => {
    fs.writeFileSync(path.join(realSsh, 'config'), '')
    await prepareDemoSsh(paths, fakeBin, undefined)
    expect(fs.existsSync(demoAgentSockFile(paths))).toBe(false)
    await enableDemoRealSsh(paths)
    expect(run('ssh', { SSH_AUTH_SOCK: '/tmp/stray.sock' })).toBe(`ssh agent=unset [-F] [${demoRealSshConfigFile(paths)}] [-G] [lab-box]`)
    expect(sshAgentSock({ SSH_AUTH_SOCK: '/tmp/stray.sock' })).toBeUndefined()
  })

  it('refuses to turn on when the account has no ~/.ssh/config, writing no flag', async () => {
    await prepareDemoSsh(paths, fakeBin, undefined)
    expect(await demoRealSshAvailable(paths)).toBe(false)
    await expect(enableDemoRealSsh(paths)).rejects.toThrow(/no ~\/\.ssh\/config/)
    expect(fs.existsSync(demoRealSshFlag(paths))).toBe(false)
  })

  it('at start, a generation whose account has a ~/.ssh/config reads it by itself (no click)', async () => {
    fs.writeFileSync(path.join(realSsh, 'config'), 'Host lab-box\n  HostName 10.0.0.9\n')
    await prepareDemoSsh(paths, fakeBin, '/tmp/agent.sock')
    expect(await startDemoRealSsh(paths)).toBe(true)
    expect(await demoRealSshOn(paths)).toBe(true)
    expect(accountSshInUse()).toBe(true)
    expect(sshHome()).toBe(account.homedir)
    expect(run('ssh')).toContain(`[-F] [${demoRealSshConfigFile(paths)}]`)
    // A restart of the same generation keeps it on.
    setAccountSsh(null)
    expect(await startDemoRealSsh(paths)).toBe(true)
    // The next generation turns on again by itself.
    const next = demoPaths(path.join(base, 'open-walnut-demo'), 'gen-2')
    fs.mkdirSync(next.home, { recursive: true })
    await prepareDemoSsh(next, fakeBin, undefined)
    expect(await startDemoRealSsh(next)).toBe(true)
  })

  it('at start, an account with no ~/.ssh/config leaves the Demo on its own settings, writing no flag', async () => {
    await prepareDemoSsh(paths, fakeBin, undefined)
    expect(await startDemoRealSsh(paths)).toBe(false)
    expect(fs.existsSync(demoRealSshFlag(paths))).toBe(false)
    expect(accountSshInUse()).toBe(false)
  })

  it('a new generation starts off until its start reads the config, whatever the last one chose', async () => {
    fs.writeFileSync(path.join(realSsh, 'config'), '')
    await prepareDemoSsh(paths, fakeBin, undefined)
    await enableDemoRealSsh(paths)
    const next = demoPaths(path.join(base, 'open-walnut-demo'), 'gen-2')
    fs.mkdirSync(next.home, { recursive: true })
    await prepareDemoSsh(next, fakeBin, undefined)
    expect(await demoRealSshOn(next)).toBe(false)
    expect(await applyDemoRealSsh(next)).toBe(false)
    expect(accountSshInUse()).toBe(false)
    expect(execFileSync(path.join(demoSshBinDir(next), 'ssh'), ['-G', 'x'], { encoding: 'utf8', env: { PATH: guardedPath() } }).trim())
      .toBe(`ssh agent=unset [-F] [${demoSshConfigFile(next)}] [-G] [x]`)
  })

  it.skipIf(!fs.existsSync('/usr/bin/ssh'))('OpenSSH keeps Walnut\'s overrides over the account\'s own values (ssh -G, no connection)', async () => {
    fs.writeFileSync(path.join(realSsh, 'config'), [
      'Host lab-box',
      '  HostName 10.0.0.9',
      '  User dev',
      `  UserKnownHostsFile ${path.join(realSsh, 'other_known')}`,
      '  ForwardAgent yes',
      '  ControlMaster auto',
      `  ControlPath ${realSsh}/cm-%r@%h`,
      '',
    ].join('\n'), { mode: 0o600 })
    await prepareDemoSsh(paths, '/usr/bin', undefined)
    await enableDemoRealSsh(paths)
    const out = execFileSync(path.join(demoSshBinDir(paths), 'ssh'), ['-G', 'lab-box'], { encoding: 'utf8', env: { PATH: guardedPath(), HOME: paths.home } })
    const get = (key: string) => out.split('\n').find((l) => l.startsWith(`${key} `))?.slice(key.length + 1)
    expect(get('hostname')).toBe('10.0.0.9')
    expect(get('user')).toBe('dev')
    expect(get('userknownhostsfile')).toBe(`${path.join(paths.home, '.ssh', 'known_hosts')} ${path.join(realSsh, 'known_hosts')}`)
    expect(get('forwardagent')).not.toBe('yes')
    // ControlPath none: no socket of the person's config (OpenSSH may print it as none or not at all).
    expect(out).not.toContain('cm-%r')
    expect(['false', 'no']).toContain(get('updatehostkeys'))
  })
})
