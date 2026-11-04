/**
 * Every darwin program Walnut builds keeps one identity across builds.
 *
 * macOS Local Network privacy records an unbundled, ad-hoc signed program by its
 * signing identifier and path, and matches a later run by the path and the Mach-O
 * UUID (measured 2026-11-04: a different binary with the same UUID at an allowed
 * path connected, another UUID at that path was refused). bun gives every file it
 * compiles bun's own runtime UUID and the identifier `a.out`, so each bun upgrade
 * would ask the user again, and Walnut shared both with every bun program on the
 * Mac. scripts/lib/macho-identity.mjs stamps a fixed UUID and identifier on each.
 *
 * The class: every `bun build --compile --target=bun-darwin-*` in the build
 * scripts and every darwin target of scripts/build-binary.mjs. A new one fails
 * here until it has an entry in DARWIN_IDENTITY and goes through the stamp.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DARWIN_IDENTITY, readMachoUuid, stampDarwinIdentity, uuidOffset, writeMachoUuid,
} from '../../scripts/lib/macho-identity.mjs'

const REPO = path.join(import.meta.dirname, '..', '..')
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8')

/** A minimal thin arm64 Mach-O header: one LC_SEGMENT_64 stub, then LC_UUID. */
function fakeMacho(uuid: Buffer): Buffer {
  const seg = Buffer.alloc(72); seg.writeUInt32LE(0x19, 0); seg.writeUInt32LE(72, 4)
  const lc = Buffer.alloc(24); lc.writeUInt32LE(0x1b, 0); lc.writeUInt32LE(24, 4); uuid.copy(lc, 8)
  const head = Buffer.alloc(32)
  head.writeUInt32LE(0xfeedfacf, 0); head.writeUInt32LE(0x0100000c, 4)
  head.writeUInt32LE(2, 12); head.writeUInt32LE(2, 16); head.writeUInt32LE(seg.length + lc.length, 20)
  return Buffer.concat([head, seg, lc, Buffer.alloc(256)])
}

describe('darwin identity: the class', () => {
  it('every darwin compile in the build scripts has a fixed identity and is stamped', () => {
    const shells = ['scripts/build-daemon.sh', ...fs.readdirSync(path.join(REPO, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`)]
    const found: string[] = []
    for (const rel of new Set(shells)) {
      const text = read(rel)
      for (const m of text.matchAll(/--target=bun-darwin-[\w-]+[\s\S]*?--outfile\s+"?[^"\s]*\/([\w.-]+)"?/g)) {
        const name = m[1]!
        found.push(name)
        expect(DARWIN_IDENTITY, `${rel} compiles ${name}: add it to DARWIN_IDENTITY in scripts/lib/macho-identity.mjs`).toHaveProperty(name)
        expect(text, `${rel} must stamp ${name} right after compiling it`).toMatch(new RegExp(`macho-identity\\.mjs stamp [^\\n]*${name.replace(/[.-]/g, '\\$&')}`))
      }
    }
    expect(found).toContain('daemon-darwin-arm64')

    const binary = read('scripts/build-binary.mjs')
    const targets = [...binary.matchAll(/'(darwin-[\w-]+)':\s*'bun-darwin/g)].map((m) => m[1]!)
    expect(targets.length).toBeGreaterThan(0)
    for (const t of targets) expect(DARWIN_IDENTITY, `build-binary target ${t}`).toHaveProperty(`walnut-${t}`)
    // Every built target goes through signDarwin, which stamps any darwin-* target.
    expect(binary).toMatch(/signDarwin\(target, outfile\)/)
    expect(binary).toMatch(/if \(!target\.startsWith\('darwin-'\)\) return\s*\n\s*stampDarwinIdentity\(outfile, `walnut-\$\{target\}`\)/)
  })

  it('identities are unique per program and architecture and never bun\'s own', () => {
    const uuids = Object.values(DARWIN_IDENTITY).map((i) => i.uuid)
    expect(new Set(uuids).size).toBe(uuids.length)
    for (const { uuid, identifier } of Object.values(DARWIN_IDENTITY)) {
      expect(uuid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
      expect(uuid.startsWith('4C4C44')).toBe(false) // bun's runtime UUIDs read "LLD..."
      expect(identifier).toMatch(/^dev\.openwalnut\./)
    }
  })

  it('the deploy refuses a darwin file without it, before the kill', () => {
    const devProd = read('scripts/dev-prod.sh')
    const check = devProd.indexOf('macho-identity.mjs" check "$SERVER_FILE"')
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(devProd.indexOf('\nlaunch_server "$SERVER_FILE"'))
    expect(check).toBeLessThan(devProd.indexOf('Pre-kill smoke boot'))
  })
})

describe('darwin identity: the Mach-O edit', () => {
  it('writes the UUID in place and reads it back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-id-'))
    const file = path.join(dir, 'walnut-darwin-arm64')
    fs.writeFileSync(file, fakeMacho(Buffer.from('4c4c44565555314' + '4a175b24f7cbbd850', 'hex')))
    expect(readMachoUuid(file)).toBe('4C4C4456-5555-3144-A175-B24F7CBBD850')
    writeMachoUuid(file, DARWIN_IDENTITY['walnut-darwin-arm64'].uuid)
    expect(readMachoUuid(file)).toBe(DARWIN_IDENTITY['walnut-darwin-arm64'].uuid)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('refuses what it cannot edit safely: a fat file, no LC_UUID', () => {
    const fat = Buffer.alloc(64); fat.writeUInt32BE(0xcafebabe, 0)
    expect(() => uuidOffset(fat)).toThrow(/thin 64-bit/)
    const none = fakeMacho(Buffer.alloc(16)); none.writeUInt32LE(0x2, 32 + 72) // turn LC_UUID into another command
    expect(() => uuidOffset(none)).toThrow(/no LC_UUID/)
  })

  it('stamps then signs with the fixed identifier, keeping bun\'s flags and entitlements', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macho-id-'))
    const file = path.join(dir, 'f')
    fs.writeFileSync(file, fakeMacho(Buffer.alloc(16)))
    const calls: string[][] = []
    stampDarwinIdentity(file, 'walnut-darwin-arm64', { platform: 'darwin', run: (cmd: string, args: string[]) => { calls.push([cmd, ...args]) } })
    expect(calls[0]).toEqual(['codesign', '--force', '--sign', '-', '--identifier', 'dev.openwalnut.walnut', '--preserve-metadata=entitlements,flags', file])
    expect(readMachoUuid(file)).toBe(DARWIN_IDENTITY['walnut-darwin-arm64'].uuid)
    const linux: string[][] = []
    stampDarwinIdentity(file, 'walnut-darwin-x64', { platform: 'linux', rcodesign: 'rc', run: (cmd: string, args: string[]) => { linux.push([cmd, ...args]) } })
    expect(linux.at(-1)).toEqual(['rc', 'sign', '--binary-identifier', 'dev.openwalnut.walnut', file])
    expect(() => stampDarwinIdentity(file, 'walnut-darwin-new', { platform: 'darwin', run: () => {} })).toThrow(/no fixed darwin identity/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
