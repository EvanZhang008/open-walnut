/**
 * What the monitor keeps about addresses and networks: a keyed fingerprint
 * of the public IP and of the bridge host's DNS answer, no Wi-Fi names, and
 * a scrub that removes what older versions stored, in records and state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fingerprint, loadKey, scrubRecord, scrubState, scrubStoreDir } from '../../../scripts/bridge-monitor/lib/privacy.mjs'

type AnyRec = Record<string, any>
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/
let dir = ''
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-priv-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('fingerprints', () => {
  it('a per-install key (0600), 4 hex digits, stable under one key and different under another', () => {
    const key = loadKey(dir)
    expect(fs.statSync(path.join(dir, 'privacy.key')).mode & 0o777).toBe(0o600)
    expect(loadKey(dir).equals(key)).toBe(true)
    const fp = fingerprint(key, '203.0.113.9')
    expect(fp).toMatch(/^[0-9a-f]{4}$/)
    expect(fingerprint(key, '203.0.113.9')).toBe(fp)
    expect(fingerprint(Buffer.alloc(32, 1), '203.0.113.9')).not.toBe(fingerprint(Buffer.alloc(32, 2), '203.0.113.9'))
    expect(fingerprint(key, null)).toBeNull()
  })
})

describe('scrub', () => {
  const key = Buffer.alloc(32, 9)
  const old: AnyRec[] = [
    { t: '2026-03-10T10:00:00Z', kind: 'pubip', ip: '203.0.113.9', ms: 80, changed: false },
    { t: '2026-03-10T10:05:00Z', kind: 'pubip', ip: '203.0.113.10', ms: 90, changed: true },
    { t: '2026-03-10T10:00:10Z', kind: 'net', primary: 'en0', router: '10.0.0.1', wifiSsid: 'redacted', wifiBssid: 'redacted', changed: ['primary', 'wifiSsid', 'wifiBssid'] },
    { t: '2026-03-10T10:00:20Z', kind: 'wifi', network: 'redacted', channel: 36 },
    { t: '2026-03-10T10:00:30Z', kind: 'dns', addrs: ['198.51.100.7'], ms: 3, changed: false },
    { t: '2026-03-10T10:00:40Z', kind: 'load', load1: 2 },
  ]

  it('records lose the address and network fields; the counts say what went', async () => {
    fs.writeFileSync(path.join(dir, '2026-03-10.ndjson'), `${old.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(dir, 'probe-2026-03-10.ndjson'), '{"t":"2026-03-10T10:00:00Z","kind":"probe","ev":"connected"}\n')
    const before = fs.statSync(path.join(dir, 'probe-2026-03-10.ndjson')).mtimeMs
    const totals = await scrubStoreDir(dir, key)
    expect(totals).toEqual({
      files: 1, records: 5,
      fields: { 'pubip.ip': 2, 'net.wifiSsid': 1, 'net.wifiBssid': 1, 'net.changed.wifiSsid': 1, 'net.changed.wifiBssid': 1, 'wifi.network': 1, 'dns.addrs': 1 },
    })
    const text = fs.readFileSync(path.join(dir, '2026-03-10.ndjson'), 'utf-8')
    expect(text.replace(/"router":"10\.0\.0\.1"/, '')).not.toMatch(IPV4) // the LAN router stays: it is a change signal
    // Not even as a key name in a change list: the change itself stays.
    expect(text).not.toMatch(/wifiSsid|wifiBssid/)
    const recs = text.trim().split('\n').map((l) => JSON.parse(l))
    expect(recs[2]).toEqual({ t: '2026-03-10T10:00:10Z', kind: 'net', primary: 'en0', router: '10.0.0.1', changed: ['primary'] })
    expect(recs[1]).toEqual({ t: '2026-03-10T10:05:00Z', kind: 'pubip', ms: 90, changed: true })
    expect(recs[4]).toMatchObject({ kind: 'dns', count: 1, fp: fingerprint(key, '198.51.100.7') })
    expect(recs[5]).toEqual(old[5])
    expect(fs.statSync(path.join(dir, '2026-03-10.ndjson')).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(dir, 'probe-2026-03-10.ndjson')).mtimeMs).toBe(before) // nothing to remove: untouched
    // Idempotent.
    expect(await scrubStoreDir(dir, key)).toEqual({ files: 0, records: 0, fields: {} })
  })

  it('the state keeps a fingerprint instead of the address, and no Wi-Fi names', () => {
    const state: AnyRec = {
      last: {
        pubip: { ip: '203.0.113.9', ms: 80 },
        net: { primary: 'en0', wifiSsid: 'redacted', wifiBssid: 'redacted' },
        radio: { network: 'redacted', channel: 36 },
        dnsAddrs: ['198.51.100.7'],
        egressTo: '198.51.100.7',
      },
      recentNet: [{ t: '2026-03-10T10:00:10Z', changed: ['wifiLink', 'wifiSsid'] }, { t: '2026-03-10T10:01:10Z', changed: ['primary'] }],
    }
    const removed = scrubState(state, key)
    expect(removed.sort()).toEqual(['last.dnsAddrs', 'last.egressTo', 'last.net.wifiBssid', 'last.net.wifiSsid', 'last.pubip.ip', 'last.radio.network', 'recentNet.changed'])
    expect(JSON.stringify(state)).not.toMatch(IPV4)
    expect(JSON.stringify(state)).not.toMatch(/wifiSsid|wifiBssid|"network"/)
    expect(state.recentNet.map((n: AnyRec) => n.changed)).toEqual([['wifiLink'], ['primary']])
    expect(state.last.pubip).toEqual({ fp: fingerprint(key, '203.0.113.9'), ms: 80 })
    expect(state.last.dnsFp).toBe(fingerprint(key, '198.51.100.7'))
    expect(scrubState(state, key)).toEqual([])
  })

  it('scrub v3: daemon records down to the allowlist (the 4 live sid/cwd records), SSH host aliases down to local or remote', async () => {
    const live = [
      // As older versions stored them: every field the daemon logged.
      { instanceId: 'd-2846-e2fd8ef6', sid: 'f6e22820-ded5-4341-b0e4-1b3839fec85f', cwd: '/Users/someone/workplace/project', recordLost: false, t: '2026-09-25T01:11:02.975Z', ev: 'other', msg: 'bridgeResume: respawning dead session', level: 'info', kind: 'daemon', file: 'daemon-d-2846-e2fd8ef6.log' },
      { instanceId: 'd-1', hostAlias: '__local__', wsId: 18, t: '2026-09-25T01:12:00Z', ev: 'connected', msg: 'bridge: connected', level: 'info', kind: 'daemon', file: 'daemon-d-1.log' },
      { instanceId: 'd-1', connId: 'c-1', code: 1006, nextBackoffMs: 500, chunkedFrames: 0, t: '2026-09-25T01:13:00Z', ev: 'closed', msg: 'bridge: disconnected \u2014 redialing', level: 'info', kind: 'daemon', file: 'daemon-d-1.log' },
      { t: '2026-09-25T01:14:00Z', ev: 'ssh-died', host: 'devbox', kind: 'server' },
      { t: '2026-09-25T01:14:01Z', ev: 'ssh-lost', host: '__local__', kind: 'server' },
    ]
    fs.writeFileSync(path.join(dir, '2026-09-25.ndjson'), `${live.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 })
    const totals = await scrubStoreDir(dir, key)
    expect(totals).toMatchObject({ files: 1, records: 4 })
    expect(totals.fields).toMatchObject({ 'daemon.sid': 1, 'daemon.cwd': 1, 'daemon.instanceId': 3, 'daemon.hostAlias': 1, 'daemon.msg text': 2, 'server.host alias': 1 })
    const text = fs.readFileSync(path.join(dir, '2026-09-25.ndjson'), 'utf-8')
    expect(text).not.toMatch(/sid|cwd|\/Users\/|devbox|hostAlias|instanceId|wsId|\u2014/)
    const recs = text.trim().split('\n').map((l) => JSON.parse(l))
    expect(recs[0]).toEqual({ t: '2026-09-25T01:11:02.975Z', ev: 'other', msg: 'bridgeResume', level: 'info', kind: 'daemon', file: 'daemon-d-2846-e2fd8ef6.log' })
    expect(recs[2]).toEqual({ connId: 'c-1', code: 1006, t: '2026-09-25T01:13:00Z', ev: 'closed', msg: 'bridge: disconnected', level: 'info', kind: 'daemon', file: 'daemon-d-1.log' })
    expect(recs.slice(3).map((r) => r.host)).toEqual(['remote', '__local__'])
    expect(await scrubStoreDir(dir, key)).toEqual({ files: 0, records: 0, fields: {} })
    // The state's live-alert buffers get the same treatment.
    const state: AnyRec = { recent: [live[0], live[2]], recentServer: [live[3], live[4]] }
    expect(scrubState(state, key).sort()).toEqual(['recent (2)', 'recentServer (1)'])
    expect(JSON.stringify(state)).not.toMatch(/sid|cwd|\/Users\/|devbox|instanceId/)
    expect(state.recentServer.map((r: AnyRec) => r.host)).toEqual(['remote', '__local__'])
    expect(scrubState(state, key)).toEqual([])
  })

  it('scrubRecord leaves a record that has nothing to remove as the same object', () => {
    const r = { t: 'x', kind: 'pubip', ms: 1, changed: false }
    expect(scrubRecord(r, key)).toEqual({ rec: r, removed: [] })
    expect(scrubRecord(r, key).rec).toBe(r)
  })
})
