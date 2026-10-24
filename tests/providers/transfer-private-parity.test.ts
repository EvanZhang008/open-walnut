/**
 * 'transfer-private-v1' is wired the same way in both daemon twins: the private
 * fs.writePart takes its caller from the socket's own binding and origin, and
 * the factory gets the same three deps (getuid, the raw owner stamp, this
 * incarnation's DAEMON_INSTANCE_ID) in both, and both read the stamp the same
 * way (non-blocking open, fd type check). What the stamp vouches for is decided
 * once, in transfer-core.ts, and tested with pure fakes in
 * transfer-core-private.test.ts.
 *
 * MACHINE SAFETY: text only. Reads four source files and imports the capability
 * list (a constant module); generates no twin, runs
 * no factory text, spawns nothing.
 */
import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ADVERTISED_DAEMON_CAPABILITIES, REQUIRED_DAEMON_CAPABILITIES } from '../../src/providers/daemon-capabilities.js'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const standalone = read('src/providers/daemon-standalone.ts')
const source = read('src/providers/daemon-source.ts')
const core = read('src/providers/transfer-core.ts')
const client = read('src/core/transfer/daemon-transfer-client.ts')

const writePartCase = (src: string) => src.split('\n').find((l) => l.includes("case 'fs.writePart':")) ?? ''

describe('transfer-private-v1 twin wiring', () => {
  it('is advertised, not required, and is the client\'s gate', () => {
    expect(client).toContain("export const PRIVATE_STAGE_CAPABILITY = 'transfer-private-v1'")
    expect(ADVERTISED_DAEMON_CAPABILITIES).toContain('transfer-private-v1')
    expect(REQUIRED_DAEMON_CAPABILITIES as readonly string[]).not.toContain('transfer-private-v1')
  })

  it('both twins pass the socket binding and origin to writePart, and nothing from the command', () => {
    expect(writePartCase(standalone)).toContain('transferCore.writePart(cmd, { boundHome: gatewayClientHomes.get(ws) ?? null, origin: ws.data?.origin ?? null })')
    expect(writePartCase(source)).toContain('transferCore.writePart(cmd, { boundHome: gatewayClientHomes.get(ws) || null, origin: ws.origin || null })')
  })

  it('both twins give the factory getuid, the raw owner stamp and this incarnation\'s id', () => {
    expect(standalone).toMatch(/createTransferCore\(\{[\s\S]{0,400}getuid: \(\) => process\.getuid!\(\),\s*ownerStamp: readDaemonOwnerStamp,\s*instanceId: DAEMON_INSTANCE_ID,\s*\}\)/)
    expect(source).toMatch(/\(__CREATE_TRANSFER_CORE__\)\(\{[\s\S]{0,400}getuid: function \(\) \{ return process\.getuid\(\); \},\s*ownerStamp: readDaemonOwnerStamp,\s*instanceId: DAEMON_INSTANCE_ID,\s*\}\);/)
    // The id is defined once per process, before the factory runs.
    for (const src of [standalone, source]) {
      expect(src.indexOf('const DAEMON_INSTANCE_ID = ')).toBeGreaterThan(0)
      expect(src.indexOf('const DAEMON_INSTANCE_ID = ')).toBeLessThan(src.indexOf('ownerStamp: readDaemonOwnerStamp,'))
    }
  })

  it('both twins read the stamp from their own daemon dir, the same way, without blocking', () => {
    for (const src of [standalone, source]) {
      const at = src.indexOf('function readDaemonOwnerStamp(')
      expect(at).toBeGreaterThan(0)
      const body = src.slice(at, src.indexOf('\n}\n', at))
      expect(body).toContain("fs.openSync(path.join(DAEMON_DIR, 'daemon.owner'), C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK | C.O_NOCTTY)")
      expect(body).toContain("=== 'ENOENT' ? null : undefined")
      expect(body).toMatch(/fs\.fstatSync\(fd\)/)
      expect(body).toMatch(/!st\.isFile\(\) \|\| st\.uid !== process\.getuid!?\(\) \|\| st\.size > 64 \* 1024\) return undefined/)
      expect(body).toContain("fs.readFileSync(fd, 'utf8')")
      expect(body).toMatch(/fs\.closeSync\(fd\)/)
      // The reader judges nothing: no JSON, no home, no instance id here.
      expect(body).not.toMatch(/JSON|walnutHome|instanceId/)
    }
  })

  it('the private branch names no command field for its root or its caller', () => {
    const at = core.indexOf('function privateRoot(')
    const body = core.slice(at, core.indexOf('function privatePaths(', at))
    expect(body).not.toMatch(/cmd\./)
    expect(body).toContain('ctx.boundHome')
    expect(body).toContain('deps.ownerStamp()')
    expect(body).toContain('stampedHome(raw, deps.instanceId)')
  })

  it('the source twin text holds no template-literal syntax in what it inlines', () => {
    const at = source.indexOf('function readDaemonOwnerStamp(')
    const body = source.slice(at, source.indexOf('\n}\n', at))
    expect(body).not.toMatch(/`|\$\{|\\/)
  })
})
