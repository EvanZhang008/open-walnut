/**
 * The session daemon (daemon-standalone.ts) speaks the paced-uplink protocol:
 * static ratchets over its source.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const root = path.join(import.meta.dirname, '..', '..')
const standalone = fs.readFileSync(path.join(root, 'src/providers/daemon-standalone.ts'), 'utf-8')

/** The allowlist's entries, comments stripped (they name commands that are NOT allowed). */
function allowlist(src: string): string {
  const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
  expect(start).toBeGreaterThan(0)
  return src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
}

describe('paced uplink', () => {
  it('advertises bridge-uplink-v1', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('bridge-uplink-v1')
  })

  it('only bridge.peer joins the bridge allowlist (bridge.status and mobile-event stay trusted-only)', () => {
    const list = allowlist(standalone)
    expect(list).toContain("'bridge.peer'")
    expect(list).not.toContain("'bridge.status'")
    expect(list).not.toContain("'mobile-event'")
  })

  it('a bridge ping confirms a marker, and bridge.peer / bridge.status are handled', () => {
    expect(standalone).toMatch(/case 'ping':[\s\S]{0,300}(bridgeLinkOf\(ws\)\?\.uplink\?|pingLink\.uplink)\.ack\(cmd\.ackSeq\)/)
    expect(standalone).toMatch(/case 'bridge\.peer': return cmdBridgePeer\(/)
    expect(standalone).toMatch(/case 'bridge\.status': return cmdBridgeStatus\(/)
  })

  it('every bridge frame goes through the uplink, and the keepalive is a marker', () => {
    expect(standalone).toMatch(/send\(payload[^)]*\)[^{]*\{[^}]*uplink\.send\(payload\)/)
    expect(standalone).toMatch(/uplink\.ping\(\)/)
    expect(standalone).not.toMatch(/ev: 'bridge-ping', ts: Date\.now\(\) \}\)/)
  })

  it('logs one open and one close line with the documented fields', () => {
    expect(standalone).toMatch(/'bridge-conn-open', \{ connId[^}]*dialMs/)
    const close = standalone.slice(standalone.indexOf("'bridge-conn-close'"), standalone.indexOf("'bridge-conn-close'") + 1500)
    for (const field of [
      'connId', 'uptimeMs', 'code', 'reason', 'wasClean', 'lastError', 'bytesIn', 'bytesOut', 'framesIn',
      'framesOut', 'maxOutFrameBytes', 'maxOutFrameKind', 'bufferedAmountPeak', 'bufferedAmountAtClose',
      'lastInboundAgeMs', 'rttMsP50', 'rttMsMax', 'loopDriftMax60sMs', 'loopDriftMax5sMs',
    ]) {
      expect(close, field).toMatch(new RegExp(`\\b${field}\\b`))
    }
  })

  it('the hello names the connection and offers the uplink', () => {
    expect(standalone).toMatch(/ev: 'hello',[\s\S]{0,300}connId[\s\S]{0,40}uplink: 1/)
  })

  it('the bridge adapter never returns 0 (that would park frames in a drain queue no event flushes)', () => {
    const adapter = standalone.slice(standalone.indexOf('function makeBridgeAdapter('), standalone.indexOf('function cmdBridgePeer('))
    expect(adapter).toMatch(/uplink\.send\(payload\) === 'sent' \? payload\.length : -1/)
    expect(adapter).not.toMatch(/return 0/)
  })
})
