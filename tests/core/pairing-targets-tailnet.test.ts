/**
 * Tailnet direct access: the 100.64/10 address a phone can reach this Mac at
 * from anywhere on the same tailnet, and the Tailscale CLI probe behind the
 * console's install hint.
 *
 * Only the interface list and the CLI spawn are faked (the CLI JSON below is
 * the shape `tailscale status --json` prints); everything else is real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'

vi.mock('../../src/integrations/git-sync.js', () => ({
  getCloudRemoteCredentials: vi.fn(() => null),
  getCloudRemoteCredentialsAsync: vi.fn(async () => null),
}))

import { detectLanAddress, getPairingTargets } from '../../src/core/pairing-targets.js'
import {
  detectTailnetAddress, isCgnatV4, isTailnetHost, tailscaleStatus, tailscaleSummary, peekTailscaleStatus,
  parseTailscaleStatusJson, _setTailscaleProbeForTesting,
} from '../../src/core/tailnet.js'
import { getCloudRemoteCredentialsAsync } from '../../src/integrations/git-sync.js'

type Ifaces = ReturnType<typeof os.networkInterfaces>
type Iface = { address: string; family: string | number; internal: boolean }

function mockIfaces(map: Record<string, Iface[]>): void {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(map as unknown as Ifaces)
}

/** What `tailscale status --json` prints on a logged-in, connected Mac (trimmed). */
function runningJson(): string {
  return JSON.stringify({
    Version: '1.76.1-t1234abcd-g5678efgh',
    TUN: true,
    BackendState: 'Running',
    AuthURL: '',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
    Self: {
      ID: 'nABCDEF1CNTRL',
      PublicKey: 'nodekey:0123456789abcdef',
      HostName: 'studio-mac',
      DNSName: 'studio-mac.tail1234.ts.net.',
      OS: 'macOS',
      UserID: 123456,
      TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
      Online: true,
    },
    MagicDNSSuffix: 'tail1234.ts.net',
    CurrentTailnet: { Name: 'someone@example.com', MagicDNSSuffix: 'tail1234.ts.net', MagicDNSEnabled: true },
    Peer: {},
  })
}

function stoppedJson(): string {
  return JSON.stringify({
    Version: '1.76.1', BackendState: 'Stopped', TailscaleIPs: null,
    Self: { HostName: 'studio-mac', DNSName: 'studio-mac.tail1234.ts.net.', TailscaleIPs: null, Online: false },
    Peer: null,
  })
}

const CLI = '/fake/bin/tailscale'

function fakeCli(answer: () => Promise<{ stdout: string; stderr: string }>) {
  const exec = vi.fn(async (_file: string, _args: string[], _opts: { timeout: number; maxBuffer: number }) => answer())
  _setTailscaleProbeForTesting({ locate: async () => CLI, exec })
  return exec
}

beforeEach(() => {
  vi.mocked(getCloudRemoteCredentialsAsync).mockResolvedValue(null)
  _setTailscaleProbeForTesting({ locate: async () => null })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  _setTailscaleProbeForTesting(null)
})

describe('isCgnatV4 / isTailnetHost', () => {
  it('takes exactly 100.64.0.0/10', () => {
    expect(isCgnatV4('100.63.255.255')).toBe(false)
    expect(isCgnatV4('100.64.0.0')).toBe(true)
    expect(isCgnatV4('100.101.102.103')).toBe(true)
    expect(isCgnatV4('100.127.255.255')).toBe(true)
    expect(isCgnatV4('100.128.0.0')).toBe(false)
  })

  it('refuses anything that is not a dotted IPv4', () => {
    for (const bad of ['', '100.64.0', '100.64.0.0.1', '100.64.0.256', '100.64.x.1', '100.064.0.1x', 'fd7a:115c:a1e0::1', ' 100.64.0.1']) {
      expect(isCgnatV4(bad), bad).toBe(false)
    }
  })

  it('knows a tailnet browser origin by address or MagicDNS name, case-insensitively', () => {
    expect(isTailnetHost('100.101.102.103')).toBe(true)
    expect(isTailnetHost('studio-mac.tail1234.ts.net')).toBe(true)
    expect(isTailnetHost('Studio-Mac.TAIL1234.TS.NET')).toBe(true)
    // Look-alikes are not.
    for (const host of ['ts.net', 'evil-ts.net', 'ts.net.example.com', '192.168.1.20', 'example.com', '100.128.0.1']) {
      expect(isTailnetHost(host), host).toBe(false)
    }
  })
})

describe('detectTailnetAddress', () => {
  it('a utun 100.x is the tailnet address while en0\'s 10.x stays the LAN one', () => {
    mockIfaces({
      en0: [{ address: '10.0.0.7', family: 'IPv4', internal: false }],
      utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    })
    expect(detectTailnetAddress()).toEqual({ address: '100.101.102.103', iface: 'utun3' })
    expect(detectLanAddress()).toBe('10.0.0.7')
  })

  it('ranks tunnel names first, and ignores IPv6, internal and non-CGNAT addresses', () => {
    mockIfaces({
      bridge100: [{ address: '100.70.0.1', family: 'IPv4', internal: false }],
      lo0: [{ address: '100.64.0.9', family: 'IPv4', internal: true }],
      tailscale0: [
        { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false },
        { address: '100.88.1.2', family: 'IPv4', internal: false },
      ],
    })
    expect(detectTailnetAddress()).toEqual({ address: '100.88.1.2', iface: 'tailscale0' })
  })

  it('accepts the numeric family older Node versions reported', () => {
    mockIfaces({ wg0: [{ address: '100.99.0.4', family: 4, internal: false }] })
    expect(detectTailnetAddress()).toEqual({ address: '100.99.0.4', iface: 'wg0' })
  })

  it('a 100.x on Wi-Fi or Ethernet is the carrier\'s NAT, not a tailnet', () => {
    mockIfaces({
      en0: [{ address: '100.72.14.3', family: 'IPv4', internal: false }],
      eth0: [{ address: '100.72.14.4', family: 'IPv4', internal: false }],
      wlan0: [{ address: '100.72.14.5', family: 'IPv4', internal: false }],
    })
    expect(detectTailnetAddress()).toBeNull()
  })
})

describe('getPairingTargets with a tailnet', () => {
  it('orders lan, tailnet, cloud and labels the tailnet generically without the Tailscale CLI', async () => {
    mockIfaces({
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    })
    vi.mocked(getCloudRemoteCredentialsAsync).mockResolvedValue({ domain: 'cloud.example.invalid', token: 'tok', secure: true })
    const targets = await getPairingTargets('http://localhost:3456', 3456)
    expect(targets).toEqual([
      { kind: 'lan', origin: 'http://192.168.1.20:3456', label: 'This network (Wi-Fi)', remoteMint: false },
      { kind: 'tailnet', origin: 'http://100.101.102.103:3456', label: 'Tailnet (anywhere this machine is on)', remoteMint: false },
      { kind: 'cloud', origin: 'https://cloud.example.invalid', label: 'Cloud (anywhere)', remoteMint: true },
    ])
  })

  it('names Tailscale when its CLI is installed, and offers the tailnet alone when there is no LAN', async () => {
    mockIfaces({ utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }] })
    fakeCli(async () => ({ stdout: runningJson(), stderr: '' }))
    const targets = await getPairingTargets('http://localhost:3456', 3456)
    expect(targets).toEqual([
      { kind: 'tailnet', origin: 'http://100.101.102.103:3456', label: 'Tailscale (anywhere this machine is on)', remoteMint: false },
    ])
  })

  it('a console opened over the tailnet fills the tailnet slot, and the LAN is still detected', async () => {
    mockIfaces({
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    })
    for (const origin of ['http://100.101.102.103:3456', 'https://studio-mac.tail1234.ts.net']) {
      const targets = await getPairingTargets(origin, 3456)
      expect(targets.map((t) => [t.kind, t.origin])).toEqual([['lan', 'http://192.168.1.20:3456'], ['tailnet', origin]])
    }
  })
})

describe('tailscaleStatus', () => {
  it('reads a running client: Running, DNS name without the trailing dot, its addresses; asks with the deadline', async () => {
    const exec = fakeCli(async () => ({ stdout: runningJson(), stderr: '' }))
    expect(await tailscaleStatus()).toEqual({
      installed: true, running: true, dnsName: 'studio-mac.tail1234.ts.net',
      ips: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
    })
    expect(exec).toHaveBeenCalledWith(CLI, ['status', '--json'], { timeout: 3000, maxBuffer: 400 * 1024 })
    expect(await tailscaleSummary()).toEqual({ installed: true, running: true, dnsName: 'studio-mac.tail1234.ts.net' })
  })

  it('a stopped client is installed but not running', async () => {
    fakeCli(async () => ({ stdout: stoppedJson(), stderr: '' }))
    expect(await tailscaleStatus()).toEqual({ installed: true, running: false, dnsName: 'studio-mac.tail1234.ts.net', ips: [] })
  })

  it('a client that exits non-zero but prints its JSON (logged out) is still read', async () => {
    fakeCli(async () => {
      throw Object.assign(new Error('exit status 1'), { code: 1, stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: '', TailscaleIPs: [] } }), stderr: '' })
    })
    expect(await tailscaleStatus()).toEqual({ installed: true, running: false, ips: [] })
  })

  it('malformed output, a dead daemon and a timeout read as installed, not running', async () => {
    for (const answer of [
      async () => ({ stdout: 'not json at all', stderr: '' }),
      async () => ({ stdout: JSON.stringify({ Self: {} }), stderr: '' }),
      async () => { throw Object.assign(new Error('exit status 1'), { stdout: '', stderr: 'failed to connect to local tailscaled; it doesn\'t appear to be running' }) },
      async () => { throw Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM', stdout: '' }) },
    ]) {
      fakeCli(answer)
      expect(await tailscaleStatus()).toEqual({ installed: true, running: false, ips: [] })
    }
  })

  it('no CLI anywhere: not installed, and nothing is spawned', async () => {
    const exec = vi.fn()
    _setTailscaleProbeForTesting({ locate: async () => null, exec })
    expect(await tailscaleStatus()).toEqual({ installed: false, running: false, ips: [] })
    expect(exec).not.toHaveBeenCalled()
  })

  it('finds the CLI on PATH the way `which` does', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-tailnet-path-'))
    const notExec = await fs.mkdtemp(path.join(os.tmpdir(), 'walnut-tailnet-path-'))
    await fs.writeFile(path.join(notExec, 'tailscale'), '', { mode: 0o644 }) // present but not executable: skipped
    await fs.writeFile(path.join(dir, 'tailscale'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const savedPath = process.env.PATH
    process.env.PATH = [notExec, dir].join(path.delimiter)
    try {
      const exec = vi.fn(async () => ({ stdout: runningJson(), stderr: '' }))
      _setTailscaleProbeForTesting({ exec }) // real lookup, fake spawn
      expect((await tailscaleStatus()).running).toBe(true)
      expect(exec).toHaveBeenCalledWith(path.join(dir, 'tailscale'), ['status', '--json'], expect.any(Object))
    } finally {
      process.env.PATH = savedPath
      await fs.rm(dir, { recursive: true, force: true })
      await fs.rm(notExec, { recursive: true, force: true })
    }
  })

  it('caches a good answer for 60s and a failed probe for 10s; concurrent callers share one probe', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-30T10:00:00Z'))
    const exec = fakeCli(async () => ({ stdout: runningJson(), stderr: '' }))
    await Promise.all([tailscaleStatus(), tailscaleStatus(), tailscaleStatus()])
    expect(exec).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-30T10:00:59Z'))
    await tailscaleStatus()
    expect(exec).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-30T10:01:01Z'))
    await tailscaleStatus()
    expect(exec).toHaveBeenCalledTimes(2)

    // A failed probe (timeout) retries after 10s, not 60s.
    let fail = true
    const flaky = fakeCli(async () => {
      if (fail) throw Object.assign(new Error('timed out'), { killed: true, stdout: '' })
      return { stdout: runningJson(), stderr: '' }
    })
    expect((await tailscaleStatus()).running).toBe(false)
    fail = false
    vi.setSystemTime(new Date('2026-09-30T10:01:10Z'))
    expect((await tailscaleStatus()).running).toBe(false) // still the cached failure
    vi.setSystemTime(new Date('2026-09-30T10:01:12Z'))
    expect((await tailscaleStatus()).running).toBe(true)
    expect(flaky).toHaveBeenCalledTimes(2)
  })

  it('request paths never wait out a slow CLI: the first probe for at most the wait, then stale-while-refresh', async () => {
    let answer!: (v: { stdout: string; stderr: string }) => void
    const exec = vi.fn(() => new Promise<{ stdout: string; stderr: string }>((resolve) => { answer = resolve }))
    _setTailscaleProbeForTesting({ locate: async () => CLI, exec, peekWaitMs: 50 })
    const t0 = Date.now()
    expect(await peekTailscaleStatus(50)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(await tailscaleSummary()).toBeNull() // the console omits the field
    mockIfaces({ utun3: [{ address: '100.101.102.103', family: 'IPv4', internal: false }] })
    // Unknown yet: the generic label, never a wrong "Tailscale".
    expect((await getPairingTargets('http://localhost:3456', 3456))[0].label).toBe('Tailnet (anywhere this machine is on)')
    answer({ stdout: runningJson(), stderr: '' })
    await tailscaleStatus()
    expect(await peekTailscaleStatus(50)).toMatchObject({ installed: true, running: true })
    expect((await getPairingTargets('http://localhost:3456', 3456))[0].label).toBe('Tailscale (anywhere this machine is on)')
    expect(exec).toHaveBeenCalledTimes(1)

    // Past the TTL: the stale answer comes back at once and one refresh runs behind it.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 61_000)
    expect(await peekTailscaleStatus(50)).toMatchObject({ running: true })
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('parseTailscaleStatusJson keeps only string addresses', () => {
    expect(parseTailscaleStatusJson(JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.1', 7, null] } })))
      .toEqual({ running: true, ips: ['100.64.0.1'] })
  })
})
