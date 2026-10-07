/**
 * Both daemon twins keep the host's read copy the same way (CLAUDE.md: keep
 * daemon-standalone.ts and daemon-source.ts in sync): the replica.* commands
 * from the trusted primary only, the copy handed to the offline host, and a read
 * that skips a silent primary or a relay that timed out. Static ratchets over
 * both sources plus the source twin's rendered template. The behaviour on real
 * daemon processes is tests/integration/host-replica-twins.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { getDaemonSource } from '../../src/providers/daemon-source.js'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const root = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8')
const twins = { standalone: read('src/providers/daemon-standalone.ts'), source: read('src/providers/daemon-source.ts') }

function allowlist(src: string): string {
  const start = src.indexOf('BRIDGE_ALLOWED_COMMANDS = new Set([')
  expect(start).toBeGreaterThan(0)
  return src.slice(start, src.indexOf('])', start)).replace(/\/\/[^\n]*/g, '')
}

function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`(async )?function ${name}\\(`))
  expect(start, name).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\n}', start))
}

describe('host copy: both twins', () => {
  it('advertise host-replica-v1 without requiring it (an old daemon just keeps no copy)', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-replica-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('host-replica-v1')
  })

  for (const [name, src] of Object.entries(twins)) {
    it(`${name}: replica.* reach the trusted primary only, never the bridge`, () => {
      const list = allowlist(src)
      for (const c of ['replica.sync', 'replica.put', 'replica.drop', 'replica.status']) {
        expect(list).not.toContain(`'${c}'`)
        expect(src).toMatch(new RegExp(`case '${c.replace('.', '\\.')}': return cmdReplica\\(ws, id( as number)?, '${c.split('.')[1]}', cmd\\)`))
      }
      expect(fnBody(src, 'cmdReplica')).toMatch(/origin === 'bridge'\) return sendError\(ws, id,/)
    })

    it(`${name}: the copy is the offline host's, kept beside the trigger state`, () => {
      expect(src).toMatch(/replica: hostReplica,/)
      expect(src).toMatch(/process\.env\.WALNUT_REPLICA_DIR \|\| \(IS_PROD_DAEMON_DIR \? path\.join\(HOME_DIR, '\.open-walnut', 'tmp', 'host-replica'\)/)
      // The hash the copy checks bodies against is the notes contentHash: sha256, 12 hex.
      expect(src).toMatch(/hash: (\(body\) => |function \(body\) \{ return )crypto\.createHash\('sha256'\)\.update\(body\)\.digest\('hex'\)\.slice\(0, 12\)/)
    })

    it(`${name}: a read skips a primary that missed 3 beats, and a relay that timed out`, () => {
      const gw = fnBody(src, 'sendGatewayRequest')
      expect(gw).toMatch(/offlineHost\.answersRead\(payload\.name, home\)/)
      expect(gw).toMatch(/>= GATEWAY_SILENT_BEATS/)
      // Only reads: a write is never answered twice.
      const timeout = gw.slice(gw.indexOf('setTimeout('))
      expect(timeout.indexOf('if (readable && home)')).toBeGreaterThan(-1)
      expect(timeout.indexOf('if (readable && home)')).toBeLessThan(timeout.indexOf("'hub_timeout'"))
      expect(src).toMatch(/GATEWAY_SILENT_BEATS = 3/)
      // Beats, not wall time: heard resets them, the keepalive counts them.
      expect(fnBody(src, 'heardFrom')).toMatch(/missedBeats = 0/)
      expect(src).toMatch(/missedBeats = missed/)
    })
  }

  it('the core is part of the daemon version hash, in the build script', () => {
    expect(read('src/providers/daemon-version-check.ts')).toContain("'src/providers/host-replica-core.ts'")
    expect(read('scripts/build-daemon.sh')).toContain('src/providers/host-replica-core.ts')
  })

  it('the primary sends bodies on the bulk channel', () => {
    expect(read('src/providers/daemon-connection.ts')).toMatch(/BULK_COMMANDS = new Set\(\[[^\]]*'replica\.put'/)
  })
})

describe('the source twin template', () => {
  it('inlines a working copy of the host replica', () => {
    const rendered = getDaemonSource() // throws if an injected function fails its smoke check
    expect(rendered).not.toContain('__CREATE_HOST_REPLICA__')
    const text = createHostReplica.toString()
    expect(text).not.toMatch(/__name\(|__vite|import\(/)
    expect(rendered).toContain(text)
  })
})
