/**
 * Bridge monitor parsers: macOS tool output, kernel TCP summaries and the
 * three bridge log writers. Fixtures are neutral (documentation IP ranges,
 * example.test names, no real networks).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isPowerEvent, parseIpconfigSummary, parseNwi, parsePmsetLog, parsePmsetPs, parseRouteGet, parseScutilState,
  parseSleepWake, parseSntp, parseSystemProfilerWifi, powerStateAt, sleptInGap,
} from '../../../scripts/bridge-monitor/lib/parse-net.mjs'
import { sampleDns, samplePublicIp } from '../../../scripts/bridge-monitor/lib/samplers.mjs'
import { parseSummaryMessage, parseTcpSummaries, processFilter, sweepWindowMin, tcpEnding } from '../../../scripts/bridge-monitor/lib/parse-tcp.mjs'
import { DAEMON_FIELDS, DAEMON_RECORD_KEYS, parseDaemonLine, parseReplicaLine, parseServerLine } from '../../../scripts/bridge-monitor/lib/parse-bridge.mjs'
import { parseTimeL } from '../../../scripts/bridge-monitor/lib/run.mjs'

const FIX = path.join(import.meta.dirname, 'fixtures')
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf-8')

describe('network parsers', () => {
  it('scutil state: primary interface, router, IPv4 interfaces without lo0', () => {
    expect(parseScutilState(fixture('scutil-state.txt'))).toEqual({
      primary: 'en0', router: '10.0.0.1', ipv4Ifaces: ['en0', 'utun7'],
    })
  })

  it('scutil state: empty output yields nulls, not a crash', () => {
    expect(parseScutilState('')).toEqual({ primary: null, router: null, ipv4Ifaces: [] })
  })

  it('scutil --nwi: interface order, per-interface flags, reachability per family', () => {
    const n = parseNwi(fixture('nwi.txt'))
    expect(n.ifaces).toEqual(['en0', 'utun7'])
    expect(n.v4).toEqual([{ name: 'en0', flags: 'IPv4,IPv6,DNS' }, { name: 'utun7', flags: 'IPv4,DNS' }])
    expect(n.reachV4).toBe('Reachable')
    expect(n.reachV6).toBe('Not Reachable')
  })

  it('route -n get: egress interface and gateway', () => {
    expect(parseRouteGet(fixture('route-get.txt'))).toEqual({ iface: 'en0', gateway: '10.0.0.1' })
  })

  it('ipconfig getsummary: link state only, even when the SSID is redacted', () => {
    expect(parseIpconfigSummary(fixture('ipconfig-redacted.txt'))).toEqual({ type: 'WiFi', link: true, security: 'WPA3_SAE' })
  })

  it('ipconfig getsummary: a visible SSID and BSSID are dropped at parse time, never returned', () => {
    const w = parseIpconfigSummary(fixture('ipconfig-visible.txt'))
    expect(w.link).toBe(false)
    expect(w).not.toHaveProperty('ssid')
    expect(w).not.toHaveProperty('bssid')
    expect(JSON.stringify(w)).not.toContain('ExampleNet')
    expect(JSON.stringify(w)).not.toContain('02:00:00:00:00:01')
  })

  it('pmset -g ps: AC and battery', () => {
    expect(parsePmsetPs(fixture('pmset-ps-ac.txt'))).toEqual({ source: 'ac', batteryPct: 100, batteryState: 'charged' })
    expect(parsePmsetPs(fixture('pmset-ps-batt.txt'))).toEqual({ source: 'battery', batteryPct: 57, batteryState: 'discharging' })
    expect(parsePmsetPs('').source).toBeNull()
  })

  it('system_profiler: the Wi-Fi interface block, not awdl0 or the neighbour list', () => {
    expect(parseSystemProfilerWifi(fixture('system-profiler-wifi.txt'))).toEqual({
      phy: '802.11ax', channel: 36, band: '5GHz', width: '80MHz',
      signalDbm: -66, noiseDbm: -94, txRate: 432, mcs: 3,
    })
    expect(parseSystemProfilerWifi('Wi-Fi:\n  Interfaces:\n')).toBeNull()
  })

  it('system_profiler: a visible network name is used to find the block, never returned', () => {
    const visible = fixture('system-profiler-wifi.txt').replace('<redacted>:', 'ExampleNet:')
    expect(visible).toContain('ExampleNet:')
    const r = parseSystemProfilerWifi(visible)
    expect(r).toMatchObject({ channel: 36, signalDbm: -66 })
    expect(r).not.toHaveProperty('network')
    expect(JSON.stringify(r)).not.toContain('ExampleNet')
  })

  it('sntp: offset and error in ms; garbage yields null', () => {
    expect(parseSntp(fixture('sntp.txt'))).toEqual({ offsetMs: 99.108, errMs: 37.586, server: 'time.example.test' })
    expect(parseSntp('sntp: Exchange failed: timeout')).toBeNull()
    expect(parseSntp('-1.250000 +/- 0.010000 time.example.test 192.0.2.1')?.offsetMs).toBe(-1250)
  })

  it('pmset -g log: sleep, dark wake, wake and display lines in UTC; assertions and wake requests skipped', () => {
    const ev = parsePmsetLog(fixture('pmset-log.txt'))
    expect(ev.map((e) => e.state)).toEqual(['display-off', 'asleep', 'darkwake', 'asleep', 'awake', 'display-on'])
    expect(ev[1].t).toBe('2026-03-10T10:00:05.000Z')
    expect(parsePmsetLog(fixture('pmset-log.txt'), { sinceMs: Date.parse('2026-03-10T10:05:00Z') })).toHaveLength(2)
  })

  it('regression: a "Wake Requests" line one second after a sleep is not a wake', () => {
    // Live 2026-09-28: every sleep read "awake" 1 to 4 s in, from these lines.
    const line = '2026-03-10 03:00:06 -0700 Wake Requests       \t[process=dasd request=SleepService deltaSecs=909 wakeAt=2026-03-10 03:15:00]'
    expect(parsePmsetLog(line)).toEqual([])
    const sleep = '2026-03-10 03:00:05 -0700 Sleep               \tEntering Sleep state due to \'Clamshell Sleep\''
    expect(parsePmsetLog(`${sleep}\n${line}`).map((e) => e.state)).toEqual(['asleep'])
    // Rows stored by older versions are skipped by the readers.
    const old = { t: '2026-03-10T10:00:06.000Z', type: 'Wake', state: 'awake', text: 'Requests [process=dasd request=SleepService]' }
    expect(isPowerEvent(old)).toBe(false)
    const ev = [{ t: '2026-03-10T10:00:05.000Z', type: 'Sleep', state: 'asleep', text: 'Entering Sleep' }, old]
    expect(powerStateAt(ev, Date.parse('2026-03-10T10:05:00Z')).state).toBe('asleep')
  })

  it('powerStateAt: the last state event before the instant wins', () => {
    const ev = parsePmsetLog(fixture('pmset-log.txt'))
    expect(powerStateAt(ev, Date.parse('2026-03-10T09:59:00Z')).state).toBe('unknown')
    expect(powerStateAt(ev, Date.parse('2026-03-10T10:01:00Z'))).toEqual({ state: 'asleep', display: 'off' })
    expect(powerStateAt(ev, Date.parse('2026-03-10T10:02:10Z')).state).toBe('darkwake')
    expect(powerStateAt(ev, Date.parse('2026-03-10T10:11:00Z'))).toEqual({ state: 'awake', display: 'on' })
  })

  it('/usr/bin/time -l block: wall, cpu and peak memory', () => {
    const stderr = '       61.10 real         5.66 user         3.94 sys\n  715276288  maximum resident set size\n'
    expect(parseTimeL(stderr)).toEqual({ wallMs: 61100, cpuMs: 9600, maxRssMB: 682 })
    expect(parseTimeL('nothing')).toBeNull()
  })
})

describe('kernel tcp_connection_summary', () => {
  it('merges the two entries of each socket by so_gencnt (ndjson style)', () => {
    const rows = parseTcpSummaries(fixture('tcp-ndjson.txt'))
    expect(rows.map((r) => r.soGen)).toEqual(['1001', '1002', '1003', '1004', '1005'])
    const a = rows[0]
    expect(a).toMatchObject({
      t: '2026-03-10T10:05:00.500Z', closefn: 'tcp_close', state: 'ESTABLISHED', proc: 'daemon-darwin-ar', pid: 4242,
      durS: 300.2, bytesIn: 5120, bytesOut: 2400000, rxmit: 429, rttMs: 130.062, baseRttMs: 33, soError: 54,
      synIn: 1, synOut: 1, finIn: 0, rstIn: 1, localPort: 60945, remotePort: 443, iface: 'en0',
    })
    // The redacted addresses are never copied into a row.
    expect(JSON.stringify(rows)).not.toContain('redacted')
  })

  it('an overlapping window parses to the same rows (dedupe key is so_gencnt)', () => {
    const text = fixture('tcp-ndjson.txt')
    const twice = parseTcpSummaries(`${text}${text}`)
    expect(twice).toHaveLength(5)
  })

  it('compact style (no zone) uses the given offset, same fields as ndjson', () => {
    const rows = parseTcpSummaries(fixture('tcp-compact.txt'), { offsetMin: -420 })
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ soGen: '1001', t: '2026-03-10T10:05:00.500Z', rstIn: 1, soError: 54, closefn: 'tcp_close' })
    expect(rows[1]).toMatchObject({ soGen: '1002', state: 'LAST_ACK', closefn: 'tcp_usrclosed', durS: 33.463 })
  })

  it('process filter: daemon by name prefix, probe by pid, others dropped', () => {
    const rows = parseTcpSummaries(fixture('tcp-ndjson.txt'), { keep: processFilter(['daemon-darwin'], [5555]) })
    expect(rows.map((r) => r.soGen)).toEqual(['1001', '1002', '1003', '1005'])
    // The kernel truncates names to 16 chars; a longer configured name still matches.
    const long = parseTcpSummaries(fixture('tcp-ndjson.txt'), { keep: processFilter(['daemon-darwin-arm64'], []) })
    expect(long).toHaveLength(3)
  })

  it('tcpEnding: peer reset, peer FIN, local abort, local-first close', () => {
    const rows = parseTcpSummaries(fixture('tcp-ndjson.txt'))
    const bySo = Object.fromEntries(rows.map((r) => [r.soGen, tcpEnding(r)]))
    // 1003 is tcp_drop with so_error 0: aborted by the process, even after 480 retransmits.
    expect(bySo).toEqual({ 1001: 'peer-reset', 1002: 'peer-fin', 1003: 'local-abort', 1004: 'local', 1005: 'local' })
    expect(tcpEnding(null)).toBeNull()
    expect(tcpEnding({ state: 'ESTABLISHED', soError: 60 })).toBe('drop')
  })

  it('tcp_drop with no error and a RST out is a LOCAL abort, not a network drop', () => {
    // Live rows (daemon sockets): tcp_drop, so_error 0, CLOSED, RST in/out 0/1.
    expect(tcpEnding({ closefn: 'tcp_drop', soError: 0, state: 'CLOSED', rstIn: 0, rstOut: 1 })).toBe('local-abort')
    expect(tcpEnding({ closefn: 'tcp_drop', soError: 0, state: 'CLOSED', rstOut: 1, finIn: 1 })).toBe('local-abort')
    // The kernel's own drops carry an errno: a timeout, or the local address went away.
    expect(tcpEnding({ closefn: 'tcp_drop', soError: 60, state: 'CLOSED', rstOut: 1 })).toBe('drop')
    expect(tcpEnding({ closefn: 'tcp_drop', soError: 49, state: 'CLOSED' })).toBe('drop')
    expect(tcpEnding({ closefn: 'tcp_drop', soError: 54, state: 'CLOSED', rstIn: 1 })).toBe('peer-reset')
  })

  it('ignores lines that are not summaries', () => {
    expect(parseSummaryMessage('something else entirely')).toBeNull()
    expect(parseTcpSummaries('')).toEqual([])
    expect(parseTcpSummaries('{"eventMessage": 5}\n{broken')).toEqual([])
  })
})

describe('bridge log lines', () => {
  const daemon = fixture('daemon.log').split('\n').map(parseDaemonLine).filter(Boolean) as Array<Record<string, unknown>>

  it('daemon: every bridge transition, today\'s wording and the structured records', () => {
    expect(daemon.map((e) => e.ev)).toEqual([
      'restart', 'conn-open', 'connected', 'configured', 'conn-close', 'closed', 'connected', 'silence', 'closed',
      'dial-timeout', 'connected', 'restart', 'connected',
    ])
    const close = daemon.find((e) => e.ev === 'conn-close')!
    expect(close).toMatchObject({ connId: 'c-1', code: 1006, wasClean: false, lastError: 'ECONNRESET', maxOutFrameBytes: 1900000, loopDriftMax60sMs: 12 })
    expect(daemon.find((e) => e.ev === 'silence')).toMatchObject({ silentMs: 98000, t: '2026-03-10T10:20:00.000Z' })
  })

  it('daemon: the cloud URL and any token are never copied', () => {
    const json = JSON.stringify(daemon)
    expect(json).not.toContain('example.test')
    expect(json).not.toContain('must-never-be-copied')
  })

  it('daemon: an allowlist, so a field a newer daemon adds (sid, cwd, host alias) is never recorded', () => {
    // The live case: "bridgeResume: respawning dead session" lines carried a session id and a working directory.
    const line = JSON.stringify({
      ts: '2026-09-25T01:11:02.975Z', level: 'info', msg: 'bridgeResume: respawning dead session', instanceId: 'd-1-abc',
      sid: 'f6e22820-ded5-4341-b0e4-1b3839fec85f', cwd: '/Users/someone/workplace/project', hostAlias: 'devbox', recordLost: false,
      url: 'wss://bridge.example.test/bridge', token: 'must-never-be-copied', futureField: 'anything', nested: { a: 1 },
    })
    expect(parseDaemonLine(line)).toEqual({ t: '2026-09-25T01:11:02.975Z', ev: 'other', msg: 'bridgeResume', level: 'info' })
    const close = parseDaemonLine(JSON.stringify({
      ts: '2026-09-25T01:12:00Z', level: 'info', msg: 'bridge-conn-close', connId: 'c-9', code: 1006, loopDriftMax60sMs: 71000,
      sid: 'x', cwd: '/Users/someone', hostAlias: 'devbox', wsId: 7, nextBackoffMs: 500,
    }))
    expect(close).toEqual({ connId: 'c-9', code: 1006, loopDriftMax60sMs: 71000, t: '2026-09-25T01:12:00Z', ev: 'conn-close', msg: 'bridge-conn-close', level: 'info' })
    for (const rec of [...daemon, close]) for (const k of Object.keys(rec!)) expect(DAEMON_RECORD_KEYS).toContain(k)
    expect(DAEMON_FIELDS).not.toContain('sid')
    // The message text is never the daemon's own: an address or a URL after its first words is not kept.
    expect(parseDaemonLine(JSON.stringify({ ts: '2026-09-25T01:13:00Z', msg: 'bridge: dial failed: getaddrinfo ENOTFOUND bridge.example.test' }))?.msg).toBe('bridge: dial failed')
    expect(parseDaemonLine(JSON.stringify({ ts: '2026-09-25T01:13:00Z', msg: 'bridge: disconnected \u2014 redialing' }))?.msg).toBe('bridge: disconnected')
    expect(parseDaemonLine(JSON.stringify({ ts: '2026-09-25T01:13:00Z', msg: 'bridgeHost wn.example.test up' }))?.msg).toBe('bridgeHost')
  })

  it('daemon: non-bridge, non-JSON and malformed lines are skipped', () => {
    expect(parseDaemonLine('{"ts":"2026-03-10T10:30:00.000Z","msg":"client connected"}')).toBeNull()
    expect(parseDaemonLine('not json "bridge')).toBeNull()
    expect(parseDaemonLine('{"msg":"bridge: connected"}')).toBeNull()
  })

  it('daemon: the dash inside a message does not matter (prefix match)', () => {
    // Test data: the real log line carries U+2014 between clauses.
    const line = JSON.stringify({ ts: '2026-03-10T10:00:00Z', msg: 'bridge: disconnected \u2014 redialing' })
    expect(parseDaemonLine(line)?.ev).toBe('closed')
    expect(parseDaemonLine(JSON.stringify({ ts: '2026-03-10T10:00:00Z', msg: 'bridge: disconnected - redialing' }))?.ev).toBe('closed')
  })

  it('server: SSH-link lines, the host kept only as local or remote (never the alias); unrelated lines skipped', () => {
    const s = fixture('server.log').split('\n').map(parseServerLine).filter(Boolean)
    expect(s.map((e) => [e!.ev, e!.host])).toEqual([
      ['ssh-ws-closed', 'remote'], ['ssh-lost', 'remote'], ['ssh-died', 'remote'], ['ssh-up', 'remote'], ['ssh-lost', '__local__'],
    ])
    expect(JSON.stringify(s)).not.toContain('devbox')
  })

  it('replica JSON: the four legacy messages plus the structured close', () => {
    const r = fixture('replica.log').split('\n').map(parseReplicaLine).filter(Boolean) as Array<Record<string, unknown>>
    expect(r.map((e) => [e.kind, e.alias])).toEqual([
      ['connected', '__local__'], ['disconnected', '__local__'], ['closed', '__local__'], ['connected', '__local__'], ['connected', 'probe'],
    ])
    // Only what the replica join reads: a field the join does not use is not kept.
    expect(r[2]).toEqual({ t: '2026-03-10T10:05:00.950Z', kind: 'closed', alias: '__local__', reason: '', initiator: 'client' })
    expect(JSON.stringify(r)).not.toContain('198.51.100.7') // the replica's clientIp field
  })

  it('replica TSV (the investigation cut): zone-less UTC stamps, reason and silentMs columns', () => {
    const tsv = [
      '2026-03-10T10:19:58.100\t__local__\tbridge: host silent \u2014 dropping\t\t97000\t',
      '2026-03-10T10:20:00.300\t__local__\tbridge: host disconnected\tsocket closed\t\t',
      '2026-03-10T10:22:30.200\t__local__\tbridge: replacing existing connection\t\t\t',
      '',
      'garbage',
    ].map(parseReplicaLine).filter(Boolean)
    expect(tsv).toEqual([
      { t: '2026-03-10T10:19:58.100Z', kind: 'silent', alias: '__local__', silentMs: 97000 },
      { t: '2026-03-10T10:20:00.300Z', kind: 'disconnected', alias: '__local__', reason: 'socket closed' },
      { t: '2026-03-10T10:22:30.200Z', kind: 'replaced', alias: '__local__' },
    ])
  })
})

describe('kernel log sweep window', () => {
  const tcp = { windowMin: 20, maxWindowMin: 360 }
  const now = Date.parse('2026-03-10T12:00:00Z')
  it('an on-time sweep reads its usual window; the first ever reads back as far as allowed', () => {
    expect(sweepWindowMin(now - 15 * 60_000, now, tcp)).toBe(20)
    expect(sweepWindowMin(0, now, tcp)).toBe(360)
  })
  it('after skipped sweeps it reaches back to the last good one, capped at 6 hours', () => {
    expect(sweepWindowMin(now - 50 * 60_000, now, tcp)).toBe(52)
    expect(sweepWindowMin(now - 10 * 3_600_000, now, tcp)).toBe(360)
  })
})

describe('sleep inside a collector tick gap', () => {
  // `sysctl -n kern.sleeptime kern.waketime` output shape (neutral instants).
  const SYSCTL = '{ sec = 1773140000, usec = 250000 } Tue Mar 10 03:53:20 2026\n{ sec = 1773140635, usec = 999999 } Tue Mar 10 04:03:55 2026\n'
  it('parses the kernel sleep and wake times to epoch ms', () => {
    expect(parseSleepWake(SYSCTL)).toEqual({ sleepMs: 1773140000250, wakeMs: 1773140635999 })
    expect(parseSleepWake('')).toEqual({ sleepMs: null, wakeMs: null })
  })

  const { sleepMs, wakeMs } = parseSleepWake(SYSCTL)
  const startMs = sleepMs - 4000 // the last tick before the lid closed
  const endMs = wakeMs + 3000 // the first tick after the wake

  it('a sleep counts even when the monotonic clock ran through it (Node on macOS)', () => {
    // Measured live: over a 635 s sleep both clocks moved 645 s, so wall minus mono read 0.
    const wallMs = endMs - startMs
    expect(sleptInGap({ startMs, endMs, monoMs: wallMs, sleepMs, wakeMs, tickMs: 10_000 })).toBe(wallMs - 10_000)
  })

  it('starvation is not sleep: the kernel last slept long before the gap', () => {
    const later = { startMs: wakeMs + 3_600_000, endMs: wakeMs + 3_600_000 + 176_000 }
    expect(sleptInGap({ ...later, monoMs: 176_000, sleepMs, wakeMs })).toBe(0)
  })

  it('where the monotonic clock stops in sleep, wall minus mono still works without kernel data', () => {
    expect(sleptInGap({ startMs, endMs, monoMs: 12_000 })).toBe(endMs - startMs - 12_000)
    expect(sleptInGap({ startMs, endMs })).toBe(0)
  })
})

describe('samplers that must not store or hang', () => {
  it('the public IP comes back as a keyed fingerprint only, never the address', async () => {
    const key = Buffer.alloc(32, 7)
    const fetchImpl = async () => new Response('203.0.113.44\n', { status: 200 })
    const r = await samplePublicIp('https://echo.example.test', 2000, key, fetchImpl)
    expect(r).not.toHaveProperty('ip')
    expect(r.fp).toMatch(/^[0-9a-f]{4}$/)
    expect(JSON.stringify(r)).not.toContain('203.0.113.44')
    const other = await samplePublicIp('https://echo.example.test', 2000, key, async () => new Response('203.0.113.45', { status: 200 }))
    expect(other.fp).not.toBe(r.fp)
    // Every path, not just the happy one: the result carries a fingerprint and a time, nothing else.
    const ipv4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
    const paths = [
      r,
      await samplePublicIp('https://echo.example.test', 2000, key, async () => new Response('2001:db8::7', { status: 200 })),
      await samplePublicIp('https://echo.example.test', 2000, key, async () => new Response('203.0.113.46', { status: 503 })),
      await samplePublicIp('https://echo.example.test', 2000, key, async () => { throw Object.assign(new Error('connect to 203.0.113.47 failed'), { cause: { code: 'ECONNREFUSED' } }) }),
      await samplePublicIp('https://echo.example.test', 2000, null, fetchImpl),
    ]
    for (const p of paths) {
      expect(Object.keys(p).filter((k) => k !== 'error').sort()).toEqual(['fp', 'ms'])
      expect(JSON.stringify(p)).not.toMatch(ipv4)
      expect(JSON.stringify(p)).not.toContain('2001:db8')
    }
    expect(paths[2]).toMatchObject({ fp: null, error: 'HTTP 503' })
    expect(paths[3]).toMatchObject({ fp: null, error: 'ECONNREFUSED' })
  })

  it('a DNS lookup that never answers times out, and no second one starts meanwhile', async () => {
    let calls = 0
    let release: (v: unknown) => void = () => {}
    const hang = () => { calls++; return new Promise((r) => { release = r }) }
    const t0 = Date.now()
    const r = await sampleDns('bridge.example.test', { timeoutMs: 150, lookup: hang as any })
    expect(r).toMatchObject({ addrs: [], error: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(2000)
    const again = await sampleDns('bridge.example.test', { timeoutMs: 150, lookup: hang as any })
    expect(again.error).toBe('previous lookup still running')
    expect(calls).toBe(1)
    release([{ address: '192.0.2.10' }])
    await new Promise((r) => setTimeout(r, 10))
    const ok = await sampleDns('bridge.example.test', { timeoutMs: 150, lookup: (async () => [{ address: '192.0.2.10' }]) as any })
    expect(ok).toMatchObject({ addrs: ['192.0.2.10'] })
  })
})
