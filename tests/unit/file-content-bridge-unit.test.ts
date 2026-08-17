/**
 * Pure-logic units of the cloud file-content relay (file-content-bridge.ts):
 * host resolution ('' / absent / garbage → '__local__'), the daemon-error →
 * outcome ladder (needs_upgrade / too_large / not_found / denied / error),
 * and the cap + deadline constants that protect the bridge WS frames and the
 * route from hanging.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveBridgeHost,
  classifyBridgeReadFailure,
  MAX_BRIDGE_FILE_BYTES,
  FILE_RELAY_TIMEOUT_MS,
} from '../../src/web/routes/file-content-bridge.js'

describe('resolveBridgeHost', () => {
  it("'' and absent target the primary ('__local__')", () => {
    expect(resolveBridgeHost('')).toBe('__local__')
    expect(resolveBridgeHost(undefined)).toBe('__local__')
    expect(resolveBridgeHost(null)).toBe('__local__')
  })
  it('non-string query values (array/object) fall back to the primary', () => {
    expect(resolveBridgeHost(['a', 'b'])).toBe('__local__')
    expect(resolveBridgeHost({})).toBe('__local__')
  })
  it('a named host passes through', () => {
    expect(resolveBridgeHost('clouddev')).toBe('clouddev')
  })
})

describe('classifyBridgeReadFailure ladder', () => {
  it('old daemon → needs_upgrade (both the unknown-command and allowlist shapes)', () => {
    expect(classifyBridgeReadFailure('unknown command: fs.readBounded').kind).toBe('needs_upgrade')
    expect(classifyBridgeReadFailure('command not permitted over bridge: fs.readBounded').kind).toBe('needs_upgrade')
  })
  it('EFBIG → too_large', () => {
    expect(classifyBridgeReadFailure('fs.readBounded: too large (EFBIG)').kind).toBe('too_large')
  })
  it('ENOENT / ENOTFILE → not_found', () => {
    expect(classifyBridgeReadFailure("fs.readBounded failed: ENOENT: no such file, realpath '/x' (ENOENT)").kind).toBe('not_found')
    expect(classifyBridgeReadFailure('fs.readBounded: not a regular file (ENOTFILE)').kind).toBe('not_found')
  })
  it('EDENIED / EACCES / EPERM → denied', () => {
    expect(classifyBridgeReadFailure('fs.readBounded: path not permitted (EDENIED)').kind).toBe('denied')
    expect(classifyBridgeReadFailure('fs.readBounded failed: permission denied (EACCES)').kind).toBe('denied')
    expect(classifyBridgeReadFailure('fs.readBounded failed: operation not permitted (EPERM)').kind).toBe('denied')
  })
  it('anything else → error, message preserved', () => {
    const f = classifyBridgeReadFailure('internal daemon error handling fs.readBounded: boom')
    expect(f.kind).toBe('error')
    expect(f.kind === 'error' && f.message).toContain('boom')
  })
})

describe('bridge protection constants', () => {
  it('cap matches the daemon twins (2MB) and stays far under the 32MB WS frame kill line', () => {
    expect(MAX_BRIDGE_FILE_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_BRIDGE_FILE_BYTES).toBeLessThan(32 * 1024 * 1024 / 4)
  })
  it('relay deadline exists and is bounded (route can never hang)', () => {
    expect(FILE_RELAY_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FILE_RELAY_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })
})
