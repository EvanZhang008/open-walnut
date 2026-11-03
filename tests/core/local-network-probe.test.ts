/**
 * The local network check (src/core/hosts/local-network-probe.ts): the verdict from the default
 * gateway's answers, the route table and ARP parsing, and the probe's order of attempts. Every io
 * is injected; the one real-socket case connects to loopback only.
 */
import { describe, it, expect } from 'vitest'
import net from 'node:net'
import {
  decideLocalNetwork, defaultLocalNetworkProbeIo, isPrivateIPv4, parseArpLink, parseArpNeighbors, parseDefaultGateway, probeLocalNetwork,
  CONNECT_TIMEOUT_MS, GATEWAY_PORTS, MAX_NEIGHBORS, NEIGHBOR_PORTS, RECOVERY_GATEWAY_PORTS, type ConnectOutcome, type LocalNetworkProbeIo,
} from '../../src/core/hosts/local-network-probe.js'

/** `route -n get default` on a Mac on Wi-Fi, as it prints it. */
const ROUTE_WIFI = `   route to: default
destination: default
       mask: default
    gateway: 192.168.1.1
  interface: en0
      flags: <UP,GATEWAY,DONE,STATIC,PRCLONING,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1500         0
`
/** A full-tunnel VPN: the default route is an interface, no gateway line. */
const ROUTE_VPN = `   route to: default
destination: default
       mask: default
  interface: utun4
      flags: <UP,DONE,CLONING,STATIC,GLOBAL>
 recvpipe  sendpipe  ssthresh  rtt,msec    rttvar  hopcount      mtu     expire
       0         0         0         0         0         0      1400         0
`
/** A documentation-range MAC (RFC 7042), printed the way macOS prints it, without leading zeros. */
const ARP_OK = '? (192.168.1.1) at 0:0:5e:0:53:1 on en0 ifscope [ethernet]\n'
const ARP_INCOMPLETE = '? (192.168.1.1) at (incomplete) on en0 ifscope [ethernet]\n'
const ARP_NONE = '192.168.1.1 (192.168.1.1) -- no entry\n'
/** `arp -an` on a Mac on Wi-Fi with a VM running (documentation-range MACs). */
const ARP_TABLE = [
  '? (192.168.1.1) at 0:0:5e:0:53:1 on en0 ifscope [ethernet]',
  '? (192.168.1.23) at 0:0:5e:0:53:17 on en0 ifscope [ethernet]',
  '? (192.168.1.5) at 0:0:5e:0:53:5 on en0 ifscope permanent [ethernet]',
  '? (192.168.1.40) at (incomplete) on en0 ifscope [ethernet]',
  '? (192.168.1.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]',
  '? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]',
  '? (192.168.64.3) at 0:0:5e:0:53:40 on bridge100 ifscope [bridge]',
  '? (10.0.5.7) at 0:0:5e:0:53:41 on en7 ifscope [ethernet]',
  '? (8.8.8.8) at 0:0:5e:0:53:42 on en0 ifscope [ethernet]',
].join('\n') + '\n'

describe('parseDefaultGateway', () => {
  it.each<[string, string, string | null]>([
    ['Wi-Fi', ROUTE_WIFI, '192.168.1.1'],
    ['a 10/8 gateway', ROUTE_WIFI.replace('192.168.1.1', '10.0.0.1'), '10.0.0.1'],
    ['a full-tunnel VPN (no gateway line)', ROUTE_VPN, null],
    ['an IPv6 gateway', ROUTE_WIFI.replace('192.168.1.1', 'fe80::1%en0'), null],
    ['a link gateway', ROUTE_WIFI.replace('192.168.1.1', 'link#14'), null],
    ['an octet out of range', ROUTE_WIFI.replace('192.168.1.1', '192.168.1.300'), null],
    ['no default route (route failed: empty stdout)', '', null],
  ])('%s', (_name, out, gw) => {
    expect(parseDefaultGateway(out)).toBe(gw)
  })
})

describe('isPrivateIPv4', () => {
  it.each<[string, boolean]>([
    ['10.0.0.1', true], ['10.255.255.254', true],
    ['172.16.0.1', true], ['172.31.255.1', true], ['172.15.0.1', false], ['172.32.0.1', false],
    ['192.168.0.1', true], ['192.169.0.1', false],
    ['169.254.10.1', true],
    ['8.8.8.8', false], ['100.64.0.1', false], ['127.0.0.1', false], ['not-an-ip', false],
  ])('%s -> %s', (ip, want) => {
    expect(isPrivateIPv4(ip)).toBe(want)
  })
})

describe('parseArpLink', () => {
  it.each<[string, string, boolean | null]>([
    ['a complete entry', ARP_OK, true],
    ['an incomplete entry', ARP_INCOMPLETE, false],
    ['no entry', ARP_NONE, false],
    ['arp failed (empty)', '', null],
    ['another address only', '? (192.168.1.10) at 0:0:5e:0:53:1 on en0 ifscope [ethernet]\n', null],
  ])('%s', (_name, out, want) => {
    expect(parseArpLink(out, '192.168.1.1')).toBe(want)
  })
})

describe('parseArpNeighbors', () => {
  it('keeps complete private entries on Wi-Fi and Ethernet; never its own address, broadcast, multicast, incomplete or a VM bridge', () => {
    expect(parseArpNeighbors(ARP_TABLE)).toEqual(['192.168.1.1', '192.168.1.23', '10.0.5.7'])
    expect(parseArpNeighbors('')).toEqual([])
  })
})

describe('decideLocalNetwork', () => {
  const GW = '192.168.1.1'
  const H = 'EHOSTUNREACH'
  it.each<[string, string | null, ConnectOutcome[], boolean | null, string]>([
    ['the gateway refused: the packet got there', GW, ['refused'], null, 'reachable'],
    ['one connect', GW, [H, 'connected'], null, 'reachable'],
    ['refused after timeouts', GW, ['ETIMEDOUT', 'ETIMEDOUT', 'refused'], null, 'reachable'],
    ['every attempt EHOSTUNREACH, the machine knows the gateway', GW, [H, H, H], true, 'blocked'],
    ['every attempt EHOSTUNREACH, the gateway itself is gone from ARP', GW, [H, H, H], false, 'unknown'],
    ['every attempt EHOSTUNREACH, ARP unreadable', GW, [H, H, H], null, 'unknown'],
    ['all timeouts', GW, ['ETIMEDOUT', 'ETIMEDOUT', 'ETIMEDOUT'], true, 'unknown'],
    ['mixed EHOSTUNREACH and a timeout', GW, [H, 'ETIMEDOUT', H], true, 'unknown'],
    ['no route out (ENETUNREACH)', GW, ['ENETUNREACH', 'ENETUNREACH', 'ENETUNREACH'], true, 'unknown'],
    ['no attempts', GW, [], true, 'unknown'],
    ['no gateway', null, [H, H, H], true, 'unknown'],
    ['a public gateway', '100.64.0.1', [H, H, H], true, 'unknown'],
  ])('%s', (_name, gw, outcomes, link, want) => {
    expect(decideLocalNetwork(gw, outcomes, link)).toBe(want)
  })
})

describe('probeLocalNetwork', () => {
  function io(outcomes: Record<number, ConnectOutcome>, route = ROUTE_WIFI, arp = ARP_OK) {
    const calls: Array<{ host: string; port: number; timeoutMs: number }> = []
    let arpCalls = 0
    const fake: LocalNetworkProbeIo = {
      routeDefault: async () => route,
      connect: async (host, port, timeoutMs) => { calls.push({ host, port, timeoutMs }); return outcomes[port] ?? 'ETIMEDOUT' },
      gatewayArp: async () => { arpCalls++; return arp },
      arpTable: async () => { throw new Error('a shallow probe never reads the whole table') },
    }
    return { fake, calls, arpCalls: () => arpCalls }
  }

  it('knocks on 53, 80, 443 in order and stops at the first that gets there', async () => {
    const t = io({ 53: 'ETIMEDOUT', 80: 'refused', 443: 'connected' })
    const r = await probeLocalNetwork(t.fake)
    expect(r.verdict).toBe('reachable')
    expect(t.calls.map((c) => c.port)).toEqual([53, 80])
    expect(t.calls.every((c) => c.host === '192.168.1.1' && c.timeoutMs === CONNECT_TIMEOUT_MS)).toBe(true)
    expect(t.arpCalls()).toBe(0)
    expect(GATEWAY_PORTS).toEqual([53, 80, 443])
  })

  it('blocked: every port EHOSTUNREACH and the gateway in ARP; the ARP table read only then', async () => {
    const t = io({ 53: 'EHOSTUNREACH', 80: 'EHOSTUNREACH', 443: 'EHOSTUNREACH' })
    const r = await probeLocalNetwork(t.fake)
    expect(r).toMatchObject({ verdict: 'blocked', gateway: '192.168.1.1', linkKnown: true })
    expect(r.attempts.map((a) => a.port)).toEqual([53, 80, 443])
    expect(t.arpCalls()).toBe(1)

    const down = io({ 53: 'EHOSTUNREACH', 80: 'EHOSTUNREACH', 443: 'EHOSTUNREACH' }, ROUTE_WIFI, ARP_INCOMPLETE)
    expect((await probeLocalNetwork(down.fake)).verdict).toBe('unknown')
  })

  it('mixed failures are unknown and never read ARP', async () => {
    const t = io({ 53: 'EHOSTUNREACH', 80: 'ETIMEDOUT', 443: 'EHOSTUNREACH' })
    expect((await probeLocalNetwork(t.fake)).verdict).toBe('unknown')
    expect(t.arpCalls()).toBe(0)
  })

  it('no private gateway: unknown with no connect at all', async () => {
    for (const route of [ROUTE_VPN, '', ROUTE_WIFI.replace('192.168.1.1', '100.64.0.1')]) {
      const t = io({}, route)
      const r = await probeLocalNetwork(t.fake)
      expect(r.verdict).toBe('unknown')
      expect(t.calls).toEqual([])
    }
  })

  it('an io that throws reads as its error code, never as a verdict', async () => {
    const r = await probeLocalNetwork({
      routeDefault: async () => { throw new Error('spawn failed') },
      connect: async () => 'connected',
      gatewayArp: async () => ARP_OK,
      arpTable: async () => '',
    })
    expect(r.verdict).toBe('unknown')
    const thrown = await probeLocalNetwork({
      routeDefault: async () => ROUTE_WIFI,
      connect: async () => { throw Object.assign(new Error('x'), { code: 'EHOSTUNREACH' }) },
      gatewayArp: async () => ARP_OK,
      arpTable: async () => '',
    })
    expect(thrown.verdict).toBe('blocked')
  })
})

describe('probeLocalNetwork, deep (an episode is open)', () => {
  /** Main gateway ports drop everything; `answers` says what the extra targets do. */
  function deepIo(answers: Record<string, ConnectOutcome>, route = ROUTE_WIFI, table = ARP_TABLE) {
    const calls: string[] = []
    let tableReads = 0
    const fake: LocalNetworkProbeIo = {
      routeDefault: async () => route,
      connect: async (host, port) => { calls.push(`${host}:${port}`); return answers[`${host}:${port}`] ?? 'ETIMEDOUT' },
      gatewayArp: async () => ARP_OK,
      arpTable: async () => { tableReads++; return table },
    }
    return { fake, calls, tableReads: () => tableReads }
  }

  it('a gateway that drops 53, 80 and 443 but refuses another port proves the LAN works', async () => {
    const t = deepIo({ '192.168.1.1:8080': 'refused' })
    const r = await probeLocalNetwork(t.fake, { deep: true })
    expect(r.verdict).toBe('reachable')
    expect(r.proof).toEqual({ host: '192.168.1.1', port: 8080, outcome: 'refused' })
    // Every extra target is tried at once: the gateway's other ports and each neighbour's.
    expect(t.calls).toEqual(expect.arrayContaining([
      ...RECOVERY_GATEWAY_PORTS.map((p) => `192.168.1.1:${p}`),
      ...NEIGHBOR_PORTS.flatMap((p) => [`192.168.1.23:${p}`, `10.0.5.7:${p}`]),
    ]))
    expect(t.calls.some((c) => c.startsWith('192.168.64.') || c.startsWith('192.168.1.5:'))).toBe(false)
  })

  it('a neighbour the ARP table knows answering proves it too', async () => {
    const t = deepIo({ '192.168.1.23:22': 'connected' })
    const r = await probeLocalNetwork(t.fake, { deep: true })
    expect(r).toMatchObject({ verdict: 'reachable', proof: { host: '192.168.1.23', port: 22, outcome: 'connected' } })
  })

  it('a full-tunnel VPN (no gateway): the LAN router in the ARP table is a neighbour like any other', async () => {
    const t = deepIo({ '192.168.1.1:80': 'connected' }, ROUTE_VPN)
    const r = await probeLocalNetwork(t.fake, { deep: true })
    expect(r).toMatchObject({ verdict: 'reachable', gateway: null, proof: { host: '192.168.1.1', port: 80 } })
  })

  it('nothing answering, or only EHOSTUNREACH, proves nothing', async () => {
    expect((await probeLocalNetwork(deepIo({}).fake, { deep: true })).verdict).toBe('unknown')
    const unreach: Record<string, ConnectOutcome> = {}
    for (const h of ['192.168.1.23', '10.0.5.7']) for (const p of NEIGHBOR_PORTS) unreach[`${h}:${p}`] = 'EHOSTUNREACH'
    const r = await probeLocalNetwork(deepIo(unreach).fake, { deep: true })
    expect(r.verdict).toBe('unknown')
    expect(r.proof).toBeUndefined()
  })

  it('at most MAX_NEIGHBORS neighbours', async () => {
    const many = Array.from({ length: 10 }, (_, i) => `? (192.168.1.${100 + i}) at 0:0:5e:0:53:${i + 1} on en0 ifscope [ethernet]`).join('\n')
    const t = deepIo({}, ROUTE_WIFI, many)
    await probeLocalNetwork(t.fake, { deep: true })
    const hosts = new Set(t.calls.map((c) => c.split(':')[0]).filter((h) => h !== '192.168.1.1'))
    expect(hosts.size).toBe(MAX_NEIGHBORS)
  })

  it('never runs when the gateway already said reachable or blocked, or when not asked', async () => {
    const blocked = deepIo({ '192.168.1.1:53': 'EHOSTUNREACH', '192.168.1.1:80': 'EHOSTUNREACH', '192.168.1.1:443': 'EHOSTUNREACH', '192.168.1.23:80': 'connected' })
    const r = await probeLocalNetwork(blocked.fake, { deep: true })
    expect(r.verdict).toBe('blocked')
    expect(blocked.tableReads()).toBe(0)
    const shallow = deepIo({ '192.168.1.23:80': 'connected' })
    expect((await probeLocalNetwork(shallow.fake)).verdict).toBe('unknown')
    expect(shallow.tableReads()).toBe(0)
    expect(shallow.calls).toEqual(GATEWAY_PORTS.map((p) => `192.168.1.1:${p}`))
  })
})

describe('the real connect (loopback only)', () => {
  it('maps a listener to connected and a closed port to refused', async () => {
    const server = net.createServer((s) => s.destroy())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    expect(await defaultLocalNetworkProbeIo.connect('127.0.0.1', port, 1500)).toBe('connected')
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await defaultLocalNetworkProbeIo.connect('127.0.0.1', port, 1500)).toBe('refused')
  })
})
