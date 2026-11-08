/**
 * A found host is dialled by its ~/.ssh/config alias. Settings the person keeps under a pattern
 * for the host's real name (a ProxyCommand under `Host dev-*.example.com`, say) must apply to that
 * alias too, as they do when Walnut dials a host by its hostname (2026-11-12: such a host failed
 * with "Could not resolve hostname" when dialled as `olddev`, and connected by hostname).
 *
 * Real ssh, `-G` only: it prints the settings it would use and connects to nothing. `-F` names the
 * test's own config, so no file of the person's is read.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sshAliasOptions } from '../../src/providers/session-io.js'
import { guardedPath } from '../setup/exec-guard.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-ssh-alias-blocks-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// OpenSSH by its absolute path (the exec guard refuses a bare `ssh`), and only with -G.
const SSH = '/usr/bin/ssh'
const hasSsh = fs.existsSync(SSH)

function effective(config: string, alias: string, hostname: string): Map<string, string> {
  const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(file, config)
  const out = execFileSync(SSH, ['-G', '-F', file, ...sshAliasOptions({ hostname, sshAlias: alias }), alias], {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: guardedPath(), HOME: dir },
  })
  const map = new Map<string, string>()
  for (const line of out.split('\n')) {
    const at = line.indexOf(' ')
    if (at > 0 && !map.has(line.slice(0, at))) map.set(line.slice(0, at), line.slice(at + 1))
  }
  return map
}

describe.skipIf(!hasSsh)('a found host dialled by its alias gets the settings of its real name too', () => {
  it('a ProxyCommand under a hostname pattern applies to the alias', () => {
    const got = effective([
      'Host dev-*.example.test',
      '  ProxyCommand /bin/false proxy %h',
      'Host olddev',
      '  HostName dev-box1.example.test',
      '  User builder',
      '',
    ].join('\n'), 'olddev', 'dev-box1.example.test')
    expect(got.get('hostname')).toBe('dev-box1.example.test')
    expect(got.get('proxycommand')).toBe('/bin/false proxy %h')
    expect(got.get('user')).toBe('builder')
  })

  it('the alias\'s own settings still win over the hostname block', () => {
    const got = effective([
      'Host chen',
      '  HostName 10.0.0.9',
      '  User alias-user',
      '  IdentitiesOnly yes',
      'Host 10.0.0.*',
      '  User pattern-user',
      '',
    ].join('\n'), 'chen', '10.0.0.9')
    expect(got.get('user')).toBe('alias-user')
    expect(got.get('identitiesonly')).toBe('yes')
  })
})
