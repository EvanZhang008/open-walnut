/**
 * tests/helpers/swift-compiles.ts reads a desktop build script's swiftc invocations with their
 * bash arrays spelled out. Every test that checks what the app compiles goes through it: four
 * tests split the script on "swiftc " and went red together when the files moved into a
 * SOURCES list (2026-10-31, 4fde6292b).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { swiftCompiles } from '../helpers/swift-compiles.js'

const ROOT = path.resolve(__dirname, '../..')

describe('swiftCompiles', () => {
  it('spells out the arrays a compile names and joins its continuation lines', () => {
    const script = [
      'SOURCES=(',
      '    "$SCRIPT_DIR/main.swift" \\',
      '    "$SCRIPT_DIR/Bridge.swift"',
      ')',
      'FRAMEWORKS=(-framework Cocoa -framework Security)',
      'swiftc -O -o "$MACOS/App" "${SOURCES[@]}" -D WALNUT_APP \\',
      '    "${FRAMEWORKS[@]}" -target arm64-apple-macos12.0',
      'echo done',
    ].join('\n')
    const [cmd, ...rest] = swiftCompiles(script)
    expect(rest).toEqual([])
    expect(cmd).toContain('Bridge.swift')
    expect(cmd).toContain('-framework Security')
    expect(cmd).toContain('-target arm64-apple-macos12.0')
    expect(cmd).not.toContain('${SOURCES')
  })

  it('finds every compile of both real build scripts, each with its sources', () => {
    for (const script of ['desktop/build.sh', 'desktop/build-release.sh']) {
      const compiles = swiftCompiles(fs.readFileSync(path.join(ROOT, script), 'utf8'))
      expect(compiles.length, script).toBeGreaterThan(0)
      for (const cmd of compiles) expect(cmd, script).toContain('main.swift')
    }
  })

  it('no test reads a build script by splitting it on "swiftc "', () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p) }
        else if (/\.test\.tsx?$/.test(e.name) && p !== __filename && /split\(\s*['"]swiftc /.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p))
      }
    }
    walk(path.join(ROOT, 'tests'))
    expect(offenders).toEqual([])
  })
})
