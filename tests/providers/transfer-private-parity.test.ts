/**
 * 'transfer-private-v1' is wired into the daemon: the private fs.writePart takes
 * its caller from the socket's own binding and origin, the factory gets three
 * deps (getuid, the raw owner stamp, this incarnation's DAEMON_INSTANCE_ID), and
 * the stamp is read without blocking (non-blocking open, fd type check). What the
 * stamp vouches for is decided once, in transfer-core.ts, and tested with pure
 * fakes in transfer-core-private.test.ts.
 *
 * MACHINE SAFETY: text only. Reads three source files and imports the capability
 * list (a constant module); runs no factory text, spawns nothing.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const core = read('src/providers/transfer-core.ts')
const client = read('src/core/transfer/daemon-transfer-client.ts')

const writePartCase = (src: string) => src.split('\n').find((l) => l.includes("case 'fs.writePart':")) ?? ''

describe('transfer-private-v1 daemon wiring', () => {
  it('is advertised, not required, and is the client\'s gate', () => {
    expect(client).toContain("export const PRIVATE_STAGE_CAPABILITY = 'transfer-private-v1'")
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('transfer-private-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('transfer-private-v1')
  })

  it('the daemon passes the socket binding and origin to writePart, and nothing from the command', () => {
    expect(writePartCase(standalone)).toContain('transferCore.writePart(cmd, { boundHome: boundLocationOf(ws), origin: ws.data?.origin ?? null })')
    // The bound home is the socket's own binding (where that Walnut lives now), never the command's.
    const at = standalone.search(/function boundLocationOf\(ws/)
    expect(at).toBeGreaterThan(0)
    const body = standalone.slice(at, standalone.indexOf('\n}\n', at))
    expect(body).toMatch(/const bound = gatewayClientHomes\.get\(ws\)/)
    expect(body).toMatch(/return bound \? walnutScope\.whereNow\(bound\) : null/)
    expect(body).not.toContain('cmd')
  })

  it('the daemon gives the factory getuid, the raw owner stamp and this incarnation\'s id', () => {
    expect(standalone).toMatch(/createTransferCore\(\{[\s\S]{0,400}getuid: \(\) => process\.getuid!\(\),\s*ownerStamp: readDaemonOwnerStamp,\s*instanceId: DAEMON_INSTANCE_ID,\s*\}\)/)
    // The id is defined once per process, before the factory runs.
    expect(standalone.indexOf('const DAEMON_INSTANCE_ID = ')).toBeGreaterThan(0)
    expect(standalone.indexOf('const DAEMON_INSTANCE_ID = ')).toBeLessThan(standalone.indexOf('ownerStamp: readDaemonOwnerStamp,'))
  })

  it('the daemon reads the stamp from its own daemon dir without blocking', () => {
    const at = standalone.indexOf('function readDaemonOwnerStamp(')
    expect(at).toBeGreaterThan(0)
    const body = standalone.slice(at, standalone.indexOf('\n}\n', at))
    expect(body).toContain("fs.openSync(path.join(DAEMON_DIR, 'daemon.owner'), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY)")
    expect(body).toContain("=== 'ENOENT' ? null : undefined")
    expect(body).toMatch(/fs\.fstatSync\(fd\)/)
    expect(body).toMatch(/!st\.isFile\(\) \|\| st\.uid !== process\.getuid!?\(\) \|\| st\.size > 64 \* 1024\) return undefined/)
    expect(body).toContain("fs.readFileSync(fd, 'utf8')")
    expect(body).toMatch(/fs\.closeSync\(fd\)/)
    // The reader judges nothing: no JSON, no home, no instance id here.
    expect(body).not.toMatch(/JSON|walnutHome|instanceId/)
  })

  it('the private branch names no command field for its root or its caller', () => {
    const at = core.indexOf('function privateRoot(')
    const body = core.slice(at, core.indexOf('function privatePaths(', at))
    expect(body).not.toMatch(/cmd\./)
    expect(body).toContain('ctx.boundHome')
    expect(body).toContain('deps.ownerStamp()')
    expect(body).toContain('stampedHome(raw, deps.instanceId)')
  })
})
