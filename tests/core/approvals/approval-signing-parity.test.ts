/**
 * The approval digest has three implementations that must agree byte for byte: the server
 * (src/core/approvals/digest.ts), the Mac app's Touch ID bridge (desktop/ApprovalBridge.swift)
 * and the iPhone (ios-native/Walnut/Core/ApprovalSigning.swift). A device signs only a digest it
 * rebuilt itself, so a field added to one and not the others would make every biometric
 * approval fail (or, worse, sign less than the server shows).
 *
 *  - every implementation lists the same fields in the same order (read from the source, so a
 *    new field in any one fails here);
 *  - the Mac bridge, compiled, gives the server's digest for a fixture with non-ASCII text, and
 *    a CryptoKit signature in its DER form verifies on the server;
 *  - the fixture digests are pinned, and WalnutTests/ApprovalSigningTests.swift pins the same
 *    values for the iPhone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { answerMessage, approvalDigest, keyIdOf, verifySignature } from '../../../src/core/approvals/digest.js'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const FIXTURE = {
  id: 'apr-fixture1', mode: 'biometric' as const, createdAt: '2026-11-02T23:00:00.000Z', expiresAt: '2026-11-02T23:10:00.000Z',
  host: 'build-box', taskId: 'task-1', what: 'Deploy \u90e8\u7f72 v2 \u2705', detail: 'line1\nline2',
}
const FIXTURE_DIGEST = '9b934a00d16af6e5ebeaf0ed8503c7a2067f07a01182028e267ac4347b6d853a'
const BARE = { ...FIXTURE, taskId: undefined, detail: undefined, mode: 'tap' as const }
const BARE_DIGEST = '14cc5cc3e64183f6a8fc9c49d2c7404342f90f0442ea8188debb923c2fb644b7'

/** The `key=` prefixes of the canonical lines, in order, from one source file. */
function fieldOrder(file: string): string[] {
  const src = fs.readFileSync(path.join(REPO, file), 'utf8')
  const start = src.indexOf("'walnut-approval-v1'") >= 0 ? src.indexOf("'walnut-approval-v1'") : src.indexOf('"walnut-approval-v1"')
  expect(start, `${file} has no canonical text`).toBeGreaterThan(0)
  const block = src.slice(start, src.indexOf('].join', start))
  return [...block.matchAll(/[`"]([a-z]+)=/g)].map((m) => m[1])
}

describe('approval digest parity', () => {
  it('pins the server digest of the fixtures', () => {
    expect(approvalDigest(FIXTURE)).toBe(FIXTURE_DIGEST)
    expect(approvalDigest(BARE)).toBe(BARE_DIGEST)
  })

  it('every implementation builds the same fields in the same order', () => {
    const server = fieldOrder('src/core/approvals/digest.ts')
    expect(server).toEqual(['id', 'mode', 'created', 'expires', 'host', 'task', 'what', 'detail'])
    expect(fieldOrder('desktop/ApprovalBridge.swift')).toEqual(server)
    expect(fieldOrder('ios-native/Walnut/Core/ApprovalSigning.swift')).toEqual(server)
  })

  it('the iPhone tests pin the same digests', () => {
    const tests = fs.readFileSync(path.join(REPO, 'ios-native/WalnutTests/ApprovalSigningTests.swift'), 'utf8')
    expect(tests).toContain(FIXTURE_DIGEST)
    expect(tests).toContain(BARE_DIGEST)
  })
})

const hasSwift = process.platform === 'darwin' && spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' }).status === 0

describe.skipIf(!hasSwift)('the Mac bridge, compiled', () => {
  let dir = ''
  let exe = ''
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-approval-parity-'))
    exe = path.join(dir, 'parity')
    fs.writeFileSync(path.join(dir, 'main.swift'), `
import CryptoKit
import Foundation
let fixture: [String: Any] = ["id": "apr-fixture1", "mode": "biometric", "createdAt": "2026-11-02T23:00:00.000Z",
  "expiresAt": "2026-11-02T23:10:00.000Z", "host": "build-box", "taskId": "task-1",
  "what": "Deploy \\u{90E8}\\u{7F72} v2 \\u{2705}", "detail": "line1\\nline2"]
let bare: [String: Any] = ["id": "apr-fixture1", "mode": "tap", "createdAt": "2026-11-02T23:00:00.000Z",
  "expiresAt": "2026-11-02T23:10:00.000Z", "host": "build-box", "what": "Deploy \\u{90E8}\\u{7F72} v2 \\u{2705}"]
let d = ApprovalBridge.digest(fixture)
let key = P256.Signing.PrivateKey()
let spki = key.publicKey.derRepresentation
let sig = try! key.signature(for: Data("walnut-approval-answer-v1\\n\\(d)\\napprove".utf8)).derRepresentation
print(d)
print(ApprovalBridge.digest(bare))
print(spki.base64EncodedString())
print(sig.base64EncodedString())
print(ApprovalBridge.keyId(spki))
`)
    const r = spawnSync('xcrun', ['swiftc', '-o', exe, path.join(REPO, 'desktop/ApprovalBridge.swift'), path.join(dir, 'main.swift')],
      { encoding: 'utf8', timeout: 300_000 })
    if (r.status !== 0) throw new Error(`swiftc failed:\n${r.stderr}`)
  }, 320_000)
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('gives the server digest, and its signature verifies there', () => {
    const r = spawnSync(exe, [], { encoding: 'utf8', timeout: 30_000 })
    expect(r.status, r.stderr).toBe(0)
    const [digest, bare, spki, sig, keyId] = r.stdout.trim().split('\n')
    expect(digest).toBe(FIXTURE_DIGEST)
    expect(bare).toBe(BARE_DIGEST)
    expect(verifySignature(spki, answerMessage(FIXTURE_DIGEST, 'approve'), sig)).toBe(true)
    expect(verifySignature(spki, answerMessage(FIXTURE_DIGEST, 'deny'), sig)).toBe(false)
    expect(keyId).toBe(keyIdOf(spki))
  })
})
