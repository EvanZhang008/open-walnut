import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// A build script that writes a key into a target's built Info.plist with PlistBuddy `Set`
// fails the whole build when that plist lacks the key (2026-11-10: the widget extension's
// "Take the app's build number" script set CFBundleShortVersionString on a built plist that
// had none, and every iOS CI build stopped there). Each such `Set` falls back to `Add`.
const ROOT = path.resolve(__dirname, '../..')

function builtPlistSets(yml: string): string[] {
  const lines = yml.split('\n')
  const bare: string[] = []
  lines.forEach((line, i) => {
    if (!/PlistBuddy -c ["']Set :/.test(line)) return
    // Only writes into the built product; the source plists are the app's own, always whole.
    if (!/TARGET_BUILD_DIR|\$\{?plist\}?"/.test(line)) return
    const next = lines[i + 1] ?? ''
    const fallback = /\|\|[^\n]*PlistBuddy -c ["']Add :/.test(`${line} ${next}`)
    if (!fallback) bare.push(`ios-native/project.yml:${i + 1}: ${line.trim()}`)
  })
  return bare
}

describe('iOS build scripts that write a built Info.plist', () => {
  it('every PlistBuddy Set into a built plist falls back to Add', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'ios-native/project.yml'), 'utf8')
    expect(yml, 'the scan must still find the build-number scripts').toMatch(/PlistBuddy -c "Set :/)
    expect(builtPlistSets(yml)).toEqual([])
  })

  it('the scan catches a bare Set', () => {
    const bad = [
      `          plist="\${TARGET_BUILD_DIR}/\${INFOPLIST_PATH}"`,
      `          /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString \${short}" "$plist"`,
    ].join('\n')
    expect(builtPlistSets(bad)).toHaveLength(1)
  })
})
