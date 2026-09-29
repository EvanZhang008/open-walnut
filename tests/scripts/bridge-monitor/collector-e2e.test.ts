/**
 * The real collector process, for a few seconds, in temp dirs (macOS only):
 * the first start scrubs what an older version stored, the public IP is kept
 * as a change flag only (from a local echo server, never the real service),
 * and a second collector refuses to run beside the first. The heavy samples
 * (kernel log sweep, pmset log, Wi-Fi radio) are marked as just done so none
 * of them runs here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

type AnyRec = Record<string, any>
const COLLECTOR = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'bridge-monitor', 'collector.mjs')
const isMac = process.platform === 'darwin'

let tmp = ''
let echo: http.Server | null = null
const kids: ChildProcess[] = []
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-e2e-')) })
afterEach(async () => {
  for (const k of kids.splice(0)) { try { k.kill('SIGKILL') } catch { /* gone */ } }
  if (echo) await new Promise((r) => echo!.close(r))
  echo = null
  fs.rmSync(tmp, { recursive: true, force: true })
})

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [COLLECTOR, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  kids.push(child)
  let stderr = ''
  child.stderr!.on('data', (b) => { stderr += b })
  const exited = new Promise<{ code: number | null, stderr: string }>((resolve) => child.on('exit', (code) => resolve({ code, stderr })))
  return { child, exited }
}

describe.skipIf(!isMac)('collector process', () => {
  it('scrubs old records on first start, stores no address, and runs one at a time', async () => {
    echo = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('203.0.113.10\n') })
    await new Promise<void>((r) => echo!.listen(0, '127.0.0.1', () => r()))
    const port = (echo.address() as AnyRec).port
    const logDir = path.join(tmp, 'logs', 'bridge-monitor')
    const stateDir = path.join(tmp, 'state')
    const daemonDir = path.join(tmp, 'daemon')
    fs.mkdirSync(logDir, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    fs.mkdirSync(daemonDir, { recursive: true })
    const configFile = path.join(tmp, 'bridge-monitor.json')
    fs.writeFileSync(configFile, JSON.stringify({
      daemonLogDir: daemonDir, serverLogDir: daemonDir, netEverySec: 2, loadEverySec: 2,
      publicIp: { url: `http://127.0.0.1:${port}/`, everyMin: 5, timeoutMs: 3000 },
      inbox: { enabled: false }, alert: { enabled: false },
    }))
    // What an older version left behind: addresses and Wi-Fi names in the store and the state.
    const now = Date.now()
    const day = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
    fs.writeFileSync(path.join(logDir, `${day}.ndjson`), [
      { t: new Date(now - 60_000).toISOString(), kind: 'pubip', ip: '203.0.113.9', ms: 40, changed: false },
      { t: new Date(now - 50_000).toISOString(), kind: 'net', primary: 'en0', wifiSsid: 'redacted', wifiBssid: 'redacted', changed: ['wifiSsid'] },
      { t: new Date(now - 40_000).toISOString(), kind: 'dns', addrs: ['198.51.100.7'], ms: 2, changed: false },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n')
    const just = now - 1000
    fs.writeFileSync(path.join(stateDir, 'collector.json'), JSON.stringify({
      runs: { tcp: just, tcpEnd: just, daily: just, dailyDone: just, radio: just, health: just },
      last: { pubip: { ip: '203.0.113.9', ms: 40 }, net: { primary: 'en0', wifiSsid: 'redacted' }, radio: { network: 'redacted', channel: 36 }, dnsAddrs: ['198.51.100.7'], egressTo: '198.51.100.7' },
    }))
    const env = { ...process.env, BRIDGE_MONITOR_CONFIG: configFile, BRIDGE_MONITOR_LOG_DIR: logDir, BRIDGE_MONITOR_STATE_DIR: stateDir }

    const first = start(['--run-for', '8', '--no-letters'], env)
    // Wait until the first one holds the lock, then try a second.
    const lock = path.join(stateDir, 'collector.lock')
    for (let i = 0; i < 100 && !fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 50))
    expect(fs.existsSync(lock)).toBe(true)
    const second = await start(['--run-for', '8', '--no-letters'], env).exited
    expect(second.code).toBe(1)
    expect(second.stderr).toContain(`already running as pid ${first.child.pid}`)

    const done = await first.exited
    expect(done.code).toBe(0)
    expect(fs.existsSync(lock)).toBe(false)

    const recs = fs.readFileSync(path.join(logDir, `${day}.ndjson`), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const store = JSON.stringify(recs)
    expect(store).not.toContain('203.0.113.')
    expect(store).not.toContain('198.51.100.')
    // (The scrub record itself names the removed fields; nothing else may carry them.)
    expect(JSON.stringify(recs.filter((r) => r.kind !== 'scrub'))).not.toMatch(/wifiSsid|wifiBssid|"network"/)
    expect(recs.find((r) => r.kind === 'scrub')).toMatchObject({
      version: 3, files: 1, records: 3,
      fields: { 'pubip.ip': 1, 'net.wifiSsid': 1, 'net.wifiBssid': 1, 'net.changed.wifiSsid': 1, 'dns.addrs': 1 },
      stateFields: expect.arrayContaining(['last.pubip.ip', 'last.net.wifiSsid', 'last.radio.network', 'last.dnsAddrs', 'last.egressTo']),
    })
    expect(recs.find((r) => r.kind === 'start')).toMatchObject({ version: 'bridge-monitor-collector/4', sleepCheck: 'kernel' })
    // The echo answered a new address: seen as a change against the fingerprint the scrub kept.
    const pub = recs.filter((r) => r.kind === 'pubip').at(-1)
    expect(pub).toMatchObject({ changed: true })
    expect(pub).not.toHaveProperty('ip')
    // Nothing heavy ran.
    expect(recs.some((r) => r.kind === 'tcp-sweep' || r.kind === 'daily' || r.kind === 'wifi')).toBe(false)

    const state = fs.readFileSync(path.join(stateDir, 'collector.json'), 'utf-8')
    expect(state).not.toContain('203.0.113.')
    expect(state).not.toContain('198.51.100.')
    expect(state).not.toMatch(/wifiSsid|wifiBssid|"network"|egressTo|dnsAddrs/)
    expect(JSON.parse(state).scrubV).toBe(3)
    expect(fs.statSync(path.join(stateDir, 'privacy.key')).mode & 0o777).toBe(0o600)
  }, 40_000)
})
