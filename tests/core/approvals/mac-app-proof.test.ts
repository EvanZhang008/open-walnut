import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MAC_APP_BUNDLE_ID, bundleOfExecutable, injectionEntitlementIn, liveSigningRefusal, pidIsMacApp, requestFromMacApp, signingInfo,
} from '../../../src/core/approvals/mac-app-proof.js'

const SIGNED = [
  'Executable=/Applications/Walnut.app/Contents/MacOS/Walnut',
  'Identifier=com.local.walnut-desktop',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=2716 flags=0x10000(runtime) hashes=78+7 location=embedded',
  'CandidateCDHash sha256=abc',
  'CDHash=22f7da2a9b2f1b61da905a91ac6500154652c10c',
  'Authority=Apple Development: A Person (ABCDE12345)',
  'TeamIdentifier=ABCDE12345',
].join('\n')

describe('mac-app-proof', () => {
  it('reads the app bundle an executable runs from, and nothing else', () => {
    expect(bundleOfExecutable('/Applications/Walnut.app/Contents/MacOS/Walnut\n')).toBe('/Applications/Walnut.app')
    expect(bundleOfExecutable('/Users/a/Apps/My Walnut.app/Contents/MacOS/Walnut')).toBe('/Users/a/Apps/My Walnut.app')
    expect(bundleOfExecutable('/usr/bin/curl')).toBeNull()
    expect(bundleOfExecutable('/Applications/Walnut.app/Contents/Resources/walnut')).toBeNull()
    expect(bundleOfExecutable('curl')).toBeNull()
  })

  it('reads the identifier, code hash, team and flags codesign prints', () => {
    expect(signingInfo(SIGNED)).toEqual({
      identifier: 'com.local.walnut-desktop', cdhash: '22f7da2a9b2f1b61da905a91ac6500154652c10c', team: 'ABCDE12345', flags: ['runtime'],
    })
    expect(signingInfo('code object is not signed at all')).toEqual({})
    expect(signingInfo('CodeDirectory v=20400 size=2 flags=0x0(none) hashes=1+0\nTeamIdentifier=not set').flags).toEqual([])
    expect(signingInfo('TeamIdentifier=not set').team).toBeUndefined()
  })

  it('only a team-signed app under the hardened runtime may speak for the person', () => {
    const info = signingInfo(SIGNED)
    expect(liveSigningRefusal(info)).toBeNull()
    expect(liveSigningRefusal({ ...info, identifier: 'com.example.other' })).toMatch(/not the Walnut Mac app/)
    // Ad-hoc: anyone can sign a look-alike with the same identifier.
    expect(liveSigningRefusal({ ...info, flags: ['adhoc', 'runtime'], team: undefined })).toMatch(/developer certificate/)
    expect(liveSigningRefusal({ ...info, team: undefined })).toMatch(/no team/)
    // No hardened runtime: another program may load code into it.
    expect(liveSigningRefusal({ ...info, flags: [] })).toMatch(/hardened runtime/)
    expect(liveSigningRefusal({ ...info, flags: undefined })).toMatch(/developer certificate/)
  })

  it('an entitlement that lets other programs into the app is refused', () => {
    const plist = (body: string) => `<?xml version="1.0"?><plist version="1.0"><dict>${body}</dict></plist>`
    expect(injectionEntitlementIn(plist('<key>com.apple.security.device.audio-input</key><true/>'))).toBeNull()
    expect(injectionEntitlementIn('')).toBeNull()
    expect(injectionEntitlementIn(plist('<key>com.apple.security.get-task-allow</key>\n  <true/>'))).toBe('com.apple.security.get-task-allow')
    expect(injectionEntitlementIn(plist('<key>com.apple.security.cs.disable-library-validation</key><true/>'))).toBe('com.apple.security.cs.disable-library-validation')
    expect(injectionEntitlementIn(plist('<key>com.apple.security.cs.allow-dyld-environment-variables</key><false/>'))).toBeNull()
  })

  it('a script is never the Mac app: this test process, a bad pid, no connection', async () => {
    expect((await pidIsMacApp(process.pid)).ok).toBe(false)
    expect((await pidIsMacApp(1)).ok).toBe(false)
    expect((await pidIsMacApp(-5)).ok).toBe(false)
    expect((await requestFromMacApp(undefined)).ok).toBe(false)
  })
})

/** A look-alike app anyone can make: the Mac app's identifier, signed ad-hoc (no certificate). */
const canBuild = process.platform === 'darwin' && (() => {
  try { execFileSync('xcrun', ['--find', 'clang'], { stdio: 'ignore' }); return true } catch { return false }
})()
let lookAlike: ChildProcess | null = null
let lookAlikeDir = ''

afterAll(() => {
  lookAlike?.kill('SIGTERM')
  if (lookAlikeDir) fs.rmSync(lookAlikeDir, { recursive: true, force: true })
})

describe.skipIf(!canBuild)('a look-alike app on this Mac', () => {
  it('an ad-hoc signed bundle with the Mac app\'s identifier is refused', async () => {
    lookAlikeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-lookalike-'))
    const app = path.join(lookAlikeDir, 'Walnut.app')
    const macos = path.join(app, 'Contents', 'MacOS')
    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${MAC_APP_BUNDLE_ID}</string>
<key>CFBundleExecutable</key><string>Walnut</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`)
    const src = path.join(lookAlikeDir, 'main.c')
    fs.writeFileSync(src, '#include <unistd.h>\nint main(void){ sleep(60); return 0; }\n')
    const exe = path.join(macos, 'Walnut')
    execFileSync('xcrun', ['clang', '-o', exe, src])
    // Hardened runtime too: only the missing certificate tells it apart.
    execFileSync('codesign', ['--force', '--options', 'runtime', '--sign', '-', '--identifier', MAC_APP_BUNDLE_ID, app])
    lookAlike = spawn(exe, [], { stdio: 'ignore' })
    await new Promise((r) => setTimeout(r, 300))
    const proof = await pidIsMacApp(lookAlike.pid!)
    expect(proof).toEqual({ ok: false, why: 'the app is not signed by a developer certificate' })
  }, 60_000)
})
