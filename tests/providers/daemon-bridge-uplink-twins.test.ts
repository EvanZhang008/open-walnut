/**
 * Both daemon twins speak the same paced-uplink protocol (CLAUDE.md: keep
 * daemon-standalone.ts and daemon-source.ts in sync). Static ratchets over both
 * sources, plus the source twin's rendered template, which must carry a working
 * inlined copy of the uplink core.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createBridgeUplink, createLoopDriftProbe } from '../../src/providers/bridge-uplink-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const root = path.join(import.meta.dirname, '..', '..')
const standalone = fs.readFileSync(path.join(root, 'src/providers/daemon-standalone.ts'), 'utf-8')
const source = fs.readFileSync(path.join(root, 'src/providers/daemon-source.ts'), 'utf-8')
const twins = { standalone, source }

/** The allowlist's entries, comments stripped (they name commands that are NOT allowed). */
function allowlist(src: string): string {
  const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
  expect(start).toBeGreaterThan(0)
  return src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
}

describe('paced uplink: both twins', () => {
  it('advertise bridge-uplink-v1', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('bridge-uplink-v1')
  })

  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: only bridge.peer joins the bridge allowlist (bridge.status and mobile-event stay trusted-only)`, () => {
      const list = allowlist(src)
      expect(list).toContain("'bridge.peer'")
      expect(list).not.toContain("'bridge.status'")
      expect(list).not.toContain("'mobile-event'")
    })

    it(`${name}: a bridge ping confirms a marker, and bridge.peer / bridge.status are handled`, () => {
      expect(src).toMatch(/case 'ping':[\s\S]{0,300}bridgeUplink\??\.ack\(cmd\.ackSeq\)/)
      expect(src).toMatch(/case 'bridge\.peer': return cmdBridgePeer\(/)
      expect(src).toMatch(/case 'bridge\.status': return cmdBridgeStatus\(/)
    })

    it(`${name}: every bridge frame goes through the uplink, and the keepalive is a marker`, () => {
      expect(src).toMatch(/send\(payload[^)]*\)[^{]*\{[^}]*uplink\.send\(payload\)/)
      expect(src).toMatch(/uplink\.ping\(\)/)
      expect(src).not.toMatch(/ev: 'bridge-ping', ts: Date\.now\(\) \}\)/)
    })

    it(`${name}: logs one open and one close line with the documented fields`, () => {
      expect(src).toMatch(/'bridge-conn-open', \{ connId[^}]*dialMs/)
      const close = src.slice(src.indexOf("'bridge-conn-close'"), src.indexOf("'bridge-conn-close'") + 1500)
      for (const field of [
        'connId', 'uptimeMs', 'code', 'reason', 'wasClean', 'lastError', 'bytesIn', 'bytesOut', 'framesIn',
        'framesOut', 'maxOutFrameBytes', 'maxOutFrameKind', 'bufferedAmountPeak', 'bufferedAmountAtClose',
        'lastInboundAgeMs', 'rttMsP50', 'rttMsMax', 'loopDriftMax60sMs', 'loopDriftMax5sMs',
      ]) {
        expect(close, field).toMatch(new RegExp(`\\b${field}\\b`))
      }
    })

    it(`${name}: the hello names the connection and offers the uplink`, () => {
      expect(src).toMatch(/ev: 'hello',[\s\S]{0,300}connId[\s\S]{0,40}uplink: 1/)
    })
  }

  it('the standalone adapter never returns 0 (that would park frames in a drain queue no event flushes)', () => {
    const adapter = standalone.slice(standalone.indexOf('function makeBridgeAdapter('), standalone.indexOf('function cmdBridgePeer('))
    expect(adapter).toMatch(/uplink\.send\(payload\) === 'sent' \? payload\.length : -1/)
    expect(adapter).not.toMatch(/return 0/)
  })
})

describe('the source twin template', () => {
  it('inlines working copies of the uplink core and the drift probe', () => {
    const rendered = getDaemonSource() // throws if any injected function fails its smoke check
    expect(rendered).not.toContain('__CREATE_BRIDGE_UPLINK__')
    expect(rendered).not.toContain('__CREATE_LOOP_DRIFT_PROBE__')
    for (const fn of [createBridgeUplink, createLoopDriftProbe]) {
      const text = fn.toString()
      expect(text).not.toMatch(/__name\(|__vite|import\(/)
      expect(rendered).toContain(text)
    }
  })
})
