/**
 * How the daemon keeps the host's read copy: the replica.* commands from the
 * trusted primary only, the copy handed to the offline host, and a read that
 * skips a silent primary or a relay that timed out. Static ratchets over
 * daemon-standalone.ts. The behaviour on real daemon processes is
 * tests/integration/host-replica-twins.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createHostReplica } from '../../src/providers/host-replica-core.js'
import { createAttachmentCopy } from '../../src/providers/attachment-copy-core.js'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'
import { twinText } from '../helpers/standalone-twin-text.js'

const root = path.join(import.meta.dirname, '..', '..')
const read = (f: string) => twinText(f, fs.readFileSync(path.join(root, f), 'utf-8'))
const src = read('src/providers/daemon-standalone.ts')

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

describe('host copy: the daemon', () => {
  it('advertise host-replica-v1 without requiring it (an old daemon just keeps no copy)', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-replica-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('host-replica-v1')
  })

  it('replica.* reach the trusted primary only, never the bridge', () => {
    const list = allowlist(src)
    for (const c of ['replica.sync', 'replica.put', 'replica.drop', 'replica.status']) {
      expect(list).not.toContain(`'${c}'`)
      expect(src).toMatch(new RegExp(`case '${c.replace('.', '\\.')}': return cmdReplica\\(ws, id( as number)?, '${c.split('.')[1]}', cmd\\)`))
    }
    expect(fnBody(src, 'cmdReplica')).toMatch(/origin === 'bridge'\) return sendError\(ws, id,/)
  })

  it('attachments.* reach the trusted primary only, on the shared core, and its follower reads it', () => {
    const list = allowlist(src)
    for (const c of ['attachments.sync', 'attachments.put', 'attachments.drop', 'attachments.status']) {
      expect(list).not.toContain(`'${c}'`)
      expect(src).toContain(`case '${c}':`)
    }
    expect(src).toMatch(/case 'attachments\.status': return cmdAttachments\(ws, id( as number)?, cmd\)/)
    const cmd = fnBody(src, 'cmdAttachments')
    expect(cmd).toMatch(/origin === 'bridge'\) return sendError\(ws, id,/)
    expect(cmd).toMatch(/attachmentCopy\.command\(cmd\.home( as string)?, cmd\.cmd, cmd\)/)
    // Beside the notes copy, under the same hashed home key: the ONE key walnutScope gives a
    // home (sha1 of the Walnut's first home here, 16 hex), which the notes copy takes too.
    expect(src).toMatch(/dirOf: (\(home\) => |function \(home\) \{ return )path\.join\(REPLICA_DIR, walnutScope\.keyOf\(home\), 'attachments'\)/)
    expect(src).toMatch(/const hostReplica = createHostReplica\(\{[\s\S]{0,200}?keyOf: walnutScope\.keyOf,|var hostReplica = [\s\S]{0,300}?keyOf: walnutScope\.keyOf,/)
    expect(src).toMatch(/keyOf: (\(value\) => |function \(value\) \{ return )crypto\.createHash\('sha1'\)\.update\(value\)\.digest\('hex'\)\.slice\(0, 16\)/)
    expect(src).toMatch(/attachments: attachmentCopy,/)
  })

  it("the copy is the offline host's, kept beside the trigger state", () => {
    expect(src).toMatch(/replica: hostReplica,/)
    expect(src).toMatch(/process\.env\.WALNUT_REPLICA_DIR \|\| \(IS_PROD_DAEMON_DIR \? path\.join\(HOME_DIR, '\.open-walnut', 'tmp', 'host-replica'\)/)
    // The hash the copy checks bodies against is the notes contentHash: sha256, 12 hex.
    expect(src).toMatch(/hash: (\(body\) => |function \(body\) \{ return )crypto\.createHash\('sha256'\)\.update\(body\)\.digest\('hex'\)\.slice\(0, 12\)/)
  })

  it('a primary that missed 3 beats is away for every call; a relayed read that timed out reads the copy', () => {
    const gw = fnBody(src, 'sendGatewayRequest')
    expect(gw).toMatch(/offlineHost\.answersRead\(payload\.name, home\)/)
    // Not only for reads: the silence check (gatewayTargetFor, which picks the
    // target) comes first and asks nothing about the op.
    const pick = fnBody(src, 'gatewayTargetFor')
    expect(pick).toMatch(/if \(target && \(target\.(data\?\.)?missedBeats( \?\? 0| \|\| 0)\) >= GATEWAY_SILENT_BEATS\) \{/)
    expect(gw.indexOf('gatewayTargetFor(')).toBeGreaterThan(-1)
    expect(gw.indexOf('gatewayTargetFor(')).toBeLessThan(gw.indexOf('const readable') === -1 ? gw.indexOf('var readable') : gw.indexOf('const readable'))
    // Only reads: a write is never answered twice. The relay is relayToPrimary, which
    // every relaying branch of the gateway calls; each attempt's timer ends in
    // relayAttemptEnded, where only a read goes to the copy, before any hub_timeout.
    expect(gw).toMatch(/relayToPrimary\(/)
    expect(fnBody(src, 'relayToPrimary')).toMatch(/sendRelayAttempt\(relayId, target\)/)
    expect(fnBody(src, 'sendRelayAttempt')).toMatch(/setTimeout\((\(\) => |function \(\) \{ )relayAttemptEnded\(relayId\)/)
    const ended = fnBody(src, 'relayAttemptEnded')
    expect(ended.indexOf('if (call.readable && call.home)')).toBeGreaterThan(-1)
    expect(ended.indexOf('if (call.readable && call.home)')).toBeLessThan(ended.indexOf("'hub_timeout'"))
    expect(src).toMatch(/GATEWAY_SILENT_BEATS = 3/)
    // Beats, not wall time: heard resets them, the keepalive counts them.
    expect(fnBody(src, 'heardFrom')).toMatch(/missedBeats = 0/)
    expect(src).toMatch(/missedBeats = missed/)
  })

  it('the cores are part of the daemon version hash, in the build script', () => {
    for (const core of ['src/providers/host-replica-core.ts', 'src/providers/attachment-copy-core.ts']) {
      expect(read('src/providers/daemon-version-check.ts')).toContain(`'${core}'`)
      expect(read('scripts/build-daemon.sh')).toContain(core)
    }
  })

  it('the primary sends bodies and picture chunks on the bulk channel, pictures only to a daemon that keeps them', () => {
    const conn = read('src/providers/daemon-connection.ts')
    expect(conn).toMatch(/BULK_COMMANDS = new Set\(\[[^\]]*'replica\.put'/)
    expect(conn).toMatch(/BULK_COMMANDS = new Set\(\[[^\]]*'attachments\.put'/)
    // Not to this Mac's own daemon: it shares the vault's disk.
    expect(conn).toMatch(/const attachments = this\.hostKey !== '__local__' && this\.hasCapability\('attachment-copy-v1'\)/)
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('attachment-copy-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('attachment-copy-v1')
  })
})

describe('host copy moves', () => {
  it('advertises host-replica-moves-v1, and its cores take renamed', () => {
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('host-replica-moves-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('host-replica-moves-v1')
    // The moves are in the cores; the command handlers hand them on whole.
    for (const core of [createHostReplica, createAttachmentCopy]) expect(core.toString()).toContain('renamed')
    expect(fnBody(src, 'cmdReplica')).toMatch(/\{ confirm: cmd\.confirm, confirmFor: cmd\.confirmFor \}, cmd\)/)
    expect(fnBody(src, 'cmdAttachments')).toMatch(/attachmentCopy\.command\(cmd\.home( as string)?, cmd\.cmd, cmd\)/)
  })
})
