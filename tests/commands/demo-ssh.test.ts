/**
 * OpenSSH finds ~/.ssh from the OS account, never from $HOME, so a Demo with its own HOME still
 * read the person's real SSH config, keys and known hosts (2026-11-08: `HOME=<demo> ssh -G host`
 * printed the account's user and ~/.ssh/id_* identities). The Demo now puts ssh and scp wrappers
 * first on its PATH that name its own settings (src/commands/demo-ssh.ts). These tests pin the
 * wrappers, the settings they name, that a login shell keeps them first, and, for the whole class,
 * that no Walnut source runs ssh or scp by an absolute path, which would go around them.
 *
 * No real ssh runs here: a fake one on a temp PATH prints the arguments it was given.
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

import { demoPaths, demoChildEnv, type DemoPaths } from '../../src/commands/demo-home.js'
import { DEMO_PROFILES, demoSshBinDir, demoSshConfigFile, demoSshHomeConfigFile, prepareDemoSsh } from '../../src/commands/demo-ssh.js'

let base: string
let paths: DemoPaths
let fakeBin: string

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-demo-ssh-')))
  account.homedir = path.join(base, 'account')
  fs.mkdirSync(account.homedir)
  paths = demoPaths(path.join(base, 'open-walnut-demo'), 'gen-1')
  fs.mkdirSync(paths.home, { recursive: true })
  fakeBin = path.join(base, 'system-bin')
  fs.mkdirSync(fakeBin)
  for (const name of ['ssh', 'scp']) {
    fs.writeFileSync(path.join(fakeBin, name), `#!/bin/sh\nprintf '${name}'; for a in "$@"; do printf ' [%s]' "$a"; done; echo\n`, { mode: 0o755 })
  }
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('Demo ssh settings', () => {
  it('writes wrappers that run the system ssh and scp with the Demo HOME\'s own settings', async () => {
    await prepareDemoSsh(paths, `/nonexistent:${fakeBin}`)
    const config = demoSshConfigFile(paths)
    for (const name of ['ssh', 'scp']) {
      const wrapper = path.join(demoSshBinDir(paths), name)
      expect(fs.statSync(wrapper).mode & 0o777).toBe(0o700)
      const out = execFileSync(wrapper, ['-G', 'devbox'], { encoding: 'utf8', env: { PATH: guardedPath() } }).trim()
      expect(out).toBe(`${name} [-F] [${config}] [-G] [devbox]`)
    }
    const text = fs.readFileSync(config, 'utf8')
    const sshHome = path.join(paths.home, '.ssh')
    expect(text).toContain(`Include "${demoSshHomeConfigFile(paths)}"`)
    // The default keys are named in the translated home config, only those the Demo HOME has.
    expect(text).not.toMatch(/IdentityFile/)
    expect(text).toContain(`UserKnownHostsFile "${sshHome}/known_hosts"`)
    expect(text).toMatch(/IdentityAgent none/)
    expect(text).not.toContain(account.homedir)
    expect(fs.statSync(sshHome).mode & 0o077).toBe(0)
  })

  it('reads the Demo HOME config with its ~/, %d and relative Includes naming the Demo HOME, never the account', async () => {
    const sshHome = path.join(paths.home, '.ssh')
    fs.mkdirSync(path.join(sshHome, 'conf.d'), { recursive: true })
    fs.writeFileSync(path.join(sshHome, 'config'), [
      'Include conf.d/*.conf',
      'Host demo-devbox',
      '  HostName 127.0.0.1',
      '  IdentityFile ~/.ssh/id_ed25519_devbox',
      '  UserKnownHostsFile "~/.ssh/kh" ~/.ssh/kh2',
      '  ControlPath %d/.ssh/cm-%r@%h',
      '  LocalCommand echo 100%%d not~/home',
      'Host other',
      '  Include ~/.ssh/extra',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(sshHome, 'conf.d', 'a.conf'), 'Host fromd\n  IdentityFile ~/.ssh/d_key\n')
    fs.writeFileSync(path.join(sshHome, 'extra'), '  IdentityFile ~/.ssh/extra_key\n')
    await prepareDemoSsh(paths, fakeBin)
    execFileSync(path.join(demoSshBinDir(paths), 'ssh'), ['-G', 'demo-devbox'], { encoding: 'utf8', env: { PATH: guardedPath() } })
    const read = fs.readFileSync(demoSshHomeConfigFile(paths), 'utf8')
    expect(read).toContain(`IdentityFile ${sshHome}/id_ed25519_devbox`)
    expect(read).toContain(`UserKnownHostsFile "${sshHome}/kh" ${sshHome}/kh2`)
    expect(read).toContain(`ControlPath ${paths.home}/.ssh/cm-%r@%h`)
    // A literal %% stays, and ~/ inside a word is no home.
    expect(read).toContain('LocalCommand echo 100%%d not~/home')
    const includes = [...read.matchAll(/^Include "([^"]+)"$/gm)].map(m => m[1]!)
    expect(includes).toHaveLength(2)
    const copies = includes.map(file => fs.readFileSync(file, 'utf8'))
    expect(copies[0]).toBe(`Host fromd\n  IdentityFile ${sshHome}/d_key\n`)
    expect(copies[1]).toBe(`  IdentityFile ${sshHome}/extra_key\n`)
    // The Include in a Host block stays an Include there, so its scope is the one OpenSSH gives it.
    const lines = read.split('\n')
    expect(lines.slice(lines.indexOf('Host other'), lines.indexOf('Host other') + 2)).toEqual(['Host other', `Include "${includes[1]}"`])
    // No default key in the Demo HOME: no identity at all, never the account's, and no "no such identity" lines.
    expect(lines.slice(-3, -1)).toEqual(['Host *', '  IdentityFile none'])
    for (const text of [read, ...copies]) expect(text).not.toContain('~/.ssh')
    // An edit counts at the next run.
    fs.appendFileSync(path.join(sshHome, 'config'), 'Host later\n  IdentityFile ~/.ssh/later\n')
    execFileSync(path.join(demoSshBinDir(paths), 'ssh'), ['-G', 'later'], { encoding: 'utf8', env: { PATH: guardedPath() } })
    expect(fs.readFileSync(demoSshHomeConfigFile(paths), 'utf8')).toContain(`IdentityFile ${sshHome}/later`)
  })

  it('names only the default keys the Demo HOME has', async () => {
    const sshHome = path.join(paths.home, '.ssh')
    fs.mkdirSync(sshHome, { mode: 0o700 })
    fs.writeFileSync(path.join(sshHome, 'config'), 'Host demo-devbox\n  HostName 127.0.0.1\n')
    fs.writeFileSync(path.join(sshHome, 'id_ed25519'), 'k', { mode: 0o600 })
    await prepareDemoSsh(paths, fakeBin)
    execFileSync(path.join(demoSshBinDir(paths), 'ssh'), ['-G', 'demo-devbox'], { encoding: 'utf8', env: { PATH: guardedPath() } })
    const read = fs.readFileSync(demoSshHomeConfigFile(paths), 'utf8')
    expect(read.split('\n').slice(-3, -1)).toEqual(['Host *', `  IdentityFile "${sshHome}/id_ed25519"`])
  })

  it.skipIf(!fs.existsSync('/usr/bin/ssh'))('OpenSSH itself resolves a Demo HOME ~/ key to the Demo HOME (ssh -G, no connection)', async () => {
    const sshHome = path.join(paths.home, '.ssh')
    fs.mkdirSync(sshHome, { mode: 0o700 })
    fs.writeFileSync(path.join(sshHome, 'config'), 'Host demo-devbox\n  HostName 127.0.0.1\n  IdentityFile ~/.ssh/id_ed25519_devbox\n')
    await prepareDemoSsh(paths, '/usr/bin')
    const out = execFileSync(path.join(demoSshBinDir(paths), 'ssh'), ['-G', 'demo-devbox'], { encoding: 'utf8', env: { PATH: guardedPath(), HOME: paths.home } })
    const identities = out.split('\n').filter(line => line.startsWith('identityfile ')).map(line => line.slice('identityfile '.length))
    expect(identities).toEqual([path.join(sshHome, 'id_ed25519_devbox'), 'none'])
    for (const file of identities.slice(0, 1)) expect(file.startsWith(sshHome + path.sep), file).toBe(true)
    const known = out.split('\n').find(line => line.startsWith('userknownhostsfile '))
    expect(known).toBe(`userknownhostsfile ${sshHome}/known_hosts`)
  })

  it('never wraps itself, and leaves out a tool the machine does not have', async () => {
    fs.rmSync(path.join(fakeBin, 'scp'))
    await prepareDemoSsh(paths, `${demoSshBinDir(paths)}:${fakeBin}`)
    const wrapper = fs.readFileSync(path.join(demoSshBinDir(paths), 'ssh'), 'utf8')
    expect(wrapper).toContain(`'${path.join(fakeBin, 'ssh')}'`)
    expect(fs.existsSync(path.join(demoSshBinDir(paths), 'scp'))).toBe(false)
  })

  it('puts the wrappers first on the Demo child PATH', () => {
    const parentPath = guardedPath()
    const env = demoChildEnv({ PATH: parentPath }, paths, '11111111-2222-3333-4444-555555555555')
    expect(env.PATH).toBe(`${demoSshBinDir(paths)}:${parentPath}`)
  })

  it('keeps them first in a login shell, and keeps a profile the person edited', async () => {
    fs.writeFileSync(path.join(paths.home, '.bash_profile'), '# mine\n')
    await prepareDemoSsh(paths, fakeBin)
    expect(fs.readFileSync(path.join(paths.home, '.bash_profile'), 'utf8')).toBe('# mine\n')
    for (const profile of DEMO_PROFILES.filter(name => name !== '.bash_profile')) {
      expect(fs.readFileSync(path.join(paths.home, profile), 'utf8')).toContain(demoSshBinDir(paths))
    }
    for (const shell of ['/bin/zsh', '/bin/sh']) {
      if (!fs.existsSync(shell)) continue
      const found = execFileSync(shell, ['-l', '-c', 'command -v ssh'], {
        encoding: 'utf8', env: { HOME: paths.home, PATH: guardedPath([fakeBin]), ZDOTDIR: paths.home },
      }).trim()
      expect(found, shell).toBe(path.join(demoSshBinDir(paths), 'ssh'))
    }
  })
})

describe('no Walnut source runs ssh or scp by an absolute path', () => {
  it('spawns them by name, so the Demo wrappers on PATH apply', () => {
    const src = path.resolve(__dirname, '../../src')
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(file)
        else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) {
          fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*)/.test(line)) return
            if (/['"`](\/usr(\/local)?)?\/(s?bin|opt\/homebrew\/bin)\/(ssh|scp|sftp)['"`]/.test(line)) hits.push(`${path.relative(src, file)}:${i + 1}`)
          })
        }
      }
    }
    walk(src)
    expect(hits).toEqual([])
  })
})
