/**
 * Redaction of the doctor report, fed by the real collector (fake probes carry
 * the strings a real host and a real machine produce). One block per review
 * item it pins:
 *   1. an alias that IS the machine (FQDN, IP) never survives, and markers are ordinal;
 *   2. this machine's home and user names, and each remote home's user name;
 *   3. unknown domains, IPv4 addresses and `user@` in error and warning text;
 *  16. short hostnames and one-letter users.
 */
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-doctor-redact'))

import { collectDiagnostics } from '../../../src/core/diagnostics/doctor.js'
import { renderDiagnosticsText } from '../../../src/core/diagnostics/render.js'
import { localIdentity, maskHostIdentitiesInText, redactDiagnostics } from '../../../src/core/diagnostics/redact.js'
import type { HostDiagnostics } from '../../../src/core/diagnostics/types.js'
import { ENV, HOST, fakeProbes } from './fakes.js'

const LOCAL = { home: '/Users/alice', users: ['alice'] }

async function collected(hosts: HostDiagnostics[], env: Record<string, string | undefined> = ENV) {
  return collectDiagnostics({ probes: fakeProbes({ hosts: async () => hosts, daemonHello: async () => null }), env })
}

describe('1. an alias that names the machine', () => {
  it('masks an FQDN alias and an IP alias in every field and line, with ordinal markers', async () => {
    const fqdn = 'build-7.corp.example.com'
    const r = await collected([
      { ...HOST, alias: fqdn, label: fqdn, hostname: fqdn, user: 'bob', connected: false, phase: 'failed',
        lastError: `ssh: Could not resolve hostname ${fqdn}: nodename nor servname provided` },
      { ...HOST, alias: '10.1.2.3', label: '10.1.2.3', hostname: '10.1.2.3', user: undefined, connected: false, phase: 'failed',
        lastError: 'ssh: connect to host 10.1.2.3 port 22: Connection refused' },
      { ...HOST, connected: false, phase: 'idle' },
    ])
    const red = redactDiagnostics(r, { local: LOCAL })
    const dumps = [JSON.stringify(red), renderDiagnosticsText(red), renderDiagnosticsText(red, { section: 'hosts' })]
    for (const dump of dumps) {
      expect(dump).not.toContain('build-7')
      expect(dump).not.toContain('10.1.2.3')
      expect(dump).not.toContain('bob')
      expect(dump).not.toContain('devbox.example.com')
    }
    expect(red.hosts.map((h) => [h.alias, h.label, h.hostname])).toEqual([
      ['[host:1]', '[host:1]', '[host:1]'], ['[host:2]', '[host:2]', '[host:2]'], ['devbox', 'devbox', '[host:3]'],
    ])
    const text = renderDiagnosticsText(red)
    expect(text).toContain('  [host:1]  [user:1]@[host:1]  failed')
    expect(text).toContain('error: ssh: Could not resolve hostname [host:1]: nodename nor servname provided')
    expect(text).toContain('error: ssh: connect to host [host:2] port 22: Connection refused')
    // A plain alias carries no machine name, so it stays: it is how the user names the host.
    expect(text).toContain('  devbox    [user:3]@[host:3]  idle')
  })

  it('still masks a report host the caller\'s host table lacks, after the table\'s own markers', async () => {
    const r = await collected([{ ...HOST, alias: 'build-7.corp.example.com', label: 'build-7.corp.example.com', hostname: 'build-7.corp.example.com' }])
    const red = redactDiagnostics(r, { hosts: [{ alias: 'devbox', hostname: 'devbox.example.com' }], local: LOCAL })
    expect(red.hosts[0]).toMatchObject({ alias: '[host:2]', hostname: '[host:2]', user: '[user:2]' })
    expect(JSON.stringify(red)).not.toContain('build-7')
  })

  it('masks the same aliases across the bug report text with the same markers', () => {
    const hosts = [{ alias: 'build-7.corp.example.com', user: 'bob' }, { alias: 'devbox', hostname: 'devbox.example.com' }]
    const text = maskHostIdentitiesInText('connect build-7.corp.example.com as bob; devbox (devbox.example.com) ok', hosts)
    expect(text).toBe('connect [host:1] as [user:1]; devbox ([host:2]) ok')
  })
})

describe('2. home and user names', () => {
  it('knows every name this machine\'s user goes by', () => {
    const id = localIdentity({ USER: 'quentin', LOGNAME: 'qlogin' })
    expect(id.home).toBe(os.homedir())
    expect(id.users).toEqual(expect.arrayContaining([path.basename(os.homedir()), os.userInfo().username, 'quentin', 'qlogin']))
  })

  it('turns this machine\'s home into ~ and masks the user name outside a home path too', async () => {
    const home = os.homedir()
    const user = os.userInfo().username
    const env = { ...ENV, USER: 'quentin', HOME: home, PATH: `${home}/.local/bin:/opt/quentin/tools/bin:/usr/bin` }
    const r = await collectDiagnostics({
      probes: fakeProbes({
        hosts: async () => [],
        preflight: async () => ({
          claude: { found: true, path: `${home}/.local/bin/claude`, version: '2.1.280', kind: 'native' },
          compiler: { found: true, name: 'clang' }, dtach: { found: false },
        }),
        server: () => ({ ...fakeProbes().server!(), dataDir: `${home}/.open-walnut` }),
      }),
      env,
    })
    r.warnings.push(`login shell PATH: ${user} has no rc file`)
    const red = redactDiagnostics(r, { local: localIdentity(env) })
    const text = renderDiagnosticsText(red)
    expect(text).toContain('data dir   ~/.open-walnut')
    expect(text).toContain('~/.local/bin/claude')
    expect(red.local.processPath.entries).toEqual(['~/.local/bin', '/opt/\u2026/tools/bin', '/usr/bin'])
    expect(text).not.toContain(home)
    expect(text).not.toContain('quentin')
    if (user.length >= 2) expect(text).not.toMatch(new RegExp(`(^|[^A-Za-z0-9_.-])${user}([^A-Za-z0-9_-]|$)`))
  })

  it('masks a remote host\'s user name taken from its home directory', async () => {
    const r = await collected([{
      ...HOST, user: undefined,
      daemonDir: { display: '/home/carol/.cache/open-walnut', fallback: true, home: '/home/carol' },
      warnings: ['carol cannot write /tmp, so the daemon runs from /home/carol/.cache/open-walnut'],
    }])
    const red = redactDiagnostics(r, { local: LOCAL })
    const text = renderDiagnosticsText(red)
    expect(text).not.toContain('carol')
    expect(red.hosts[0].warnings).toEqual(['\u2026 cannot write /tmp, so the daemon runs from ~/.cache/open-walnut'])
    expect(red.hosts[0].daemonDir?.display).toBe('~/.cache/open-walnut')
  })
})

describe('3. network fragments in free text', () => {
  it('masks unknown domains, IPv4 addresses and user@ in errors, and keeps public hosts and non-text fields', async () => {
    const r = await collected([
      { ...HOST, connected: false, phase: 'failed', lastError: 'ssh: connect to host ip-10-0-0-5.ec2.internal port 22: Operation timed out' },
      { ...HOST, alias: 'lab', label: 'lab', hostname: 'lab.example.com', user: undefined, connected: true,
        warnings: ['proxy jump.example.net (10.20.30.40) reset the connection; 127.0.0.1 answered'],
        readiness: {
          claude: { found: false }, compiler: { found: true }, dtach: { found: true }, checkedAt: 1, fixes: [],
          problems: [{ kind: 'claude_missing', message: 'Claude Code is not installed on this host.', commands: ['curl -fsSL https://claude.ai/install.sh | bash'] }],
          checkError: 'dave@build.internal: Permission denied (publickey); see settings.local.json',
        } },
    ])
    const red = redactDiagnostics(r, { local: LOCAL })
    const json = JSON.stringify(red)
    for (const leak of ['ec2.internal', 'ip-10-0-0-5', 'jump.example.net', '10.20.30.40', 'dave', 'build.internal']) expect(json).not.toContain(leak)
    expect(red.hosts[0].lastError).toBe('ssh: connect to host [hostname] port 22: Operation timed out')
    expect(red.hosts[1].warnings).toEqual(['proxy [hostname] ([ip]) reset the connection; 127.0.0.1 answered'])
    expect(red.hosts[1].readiness?.checkError).toBe('[user]@[hostname]: Permission denied (publickey); see settings.local.json')
    expect(red.hosts[1].readiness?.problems[0].commands).toEqual(['curl -fsSL https://claude.ai/install.sh | bash'])
    // Not free text: a model id and a version are not hostnames.
    const withModel = redactDiagnostics({ ...r, config: { ...r.config!, mainModel: 'global.anthropic.claude-opus-5-5' } }, { local: LOCAL })
    expect(withModel.config?.mainModel).toBe('global.anthropic.claude-opus-5-5')
    expect(withModel.build.version).toBe(r.build.version)
  })
})

describe('16. short hostnames and users', () => {
  it('masks a two-letter hostname as a word and a one-letter user where it reads as one', async () => {
    const r = await collected([
      { ...HOST, alias: 'gp', label: 'gp', hostname: 'gp', user: 'a', connected: false, phase: 'failed',
        lastError: 'a@gp: Permission denied (publickey); sign in with a Claude account' },
      { ...HOST, alias: 'lab', label: 'lab', hostname: 'gpu', user: 'ab', connected: false, phase: 'failed',
        lastError: 'ssh: connect to host gpu port 22: ab has no key' },
    ])
    r.warnings.push('host gp: daemon hello: no answer within 5s')
    const red = redactDiagnostics(r, { local: LOCAL })
    expect(red.hosts[0]).toMatchObject({ alias: '[host:1]', hostname: '[host:1]', user: '[user:1]' })
    expect(red.hosts[0].lastError).toBe('[user:1]@[host:1]: Permission denied (publickey); sign in with a Claude account')
    expect(red.hosts[1]).toMatchObject({ alias: 'lab', hostname: '[host:2]', user: '[user:2]' })
    expect(red.hosts[1].lastError).toBe('ssh: connect to host [host:2] port 22: [user:2] has no key')
    expect(red.warnings).toContain('host [host:1]: daemon hello: no answer within 5s')
  })
})
