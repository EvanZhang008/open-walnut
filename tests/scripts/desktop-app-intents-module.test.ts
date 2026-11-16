/**
 * The Mac app's Spotlight and Shortcuts actions (desktop/WalnutIntents.swift) are listed by Xcode's
 * appintentsmetadataprocessor, which matches the compiler's constants to types by Swift module.
 * swiftc names the module after its output file unless told: build-release.sh writes Walnut_arm64,
 * the processor was told Walnut, and every released Mac app shipped without its actions while a
 * warning scrolled by (Release archives run 43839271955). This fails when any compile of the app
 * names no module, or names one the processor is not given, and when a release can ship unlisted.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

/** Every swiftc command of a script, its continuation lines joined. */
function swiftcCommands(text: string): string[] {
  return text.replace(/\\\n\s*/g, ' ').split('\n').map((l) => l.trim()).filter((l) => /^swiftc\b/.test(l))
}

const intents = read('desktop/app-intents.sh')
const MODULE_FLAG = '-module-name "$WALNUT_MODULE"'

describe('every compile of the Mac app names the module its actions are listed under', () => {
  it('app-intents.sh names the module once, in the compile flags and in the processor call', () => {
    expect(intents).toMatch(/^WALNUT_MODULE=Walnut$/m)
    const flags = /app_intents_swift_flags\(\) \{([\s\S]*?)^\}/m.exec(intents)?.[1] ?? ''
    expect(flags).toContain(MODULE_FLAG)
    expect(intents).toContain('--module-name "$WALNUT_MODULE"')
    expect(intents).not.toMatch(/--module-name [^"]/)
  })

  // The app's compiles: every swiftc in desktop/ that builds the SOURCES list.
  const scripts = fs.readdirSync(path.join(ROOT, 'desktop')).filter((f) => f.endsWith('.sh')).map((f) => `desktop/${f}`)
  const appCompiles = scripts.flatMap((s) => swiftcCommands(read(s)).filter((c) => c.includes('"${SOURCES[@]}"')).map((c) => ({ s, c })))

  it('finds the app compiles of build.sh and both architectures of build-release.sh', () => {
    expect(appCompiles.filter(({ s }) => s === 'desktop/build.sh')).toHaveLength(1)
    expect(appCompiles.filter(({ s }) => s === 'desktop/build-release.sh')).toHaveLength(2)
  })

  it.each(appCompiles.map(({ s, c }) => [`${s}: ${c.slice(0, 60)}`, c] as const))('%s', (_name, command) => {
    const named = command.includes(MODULE_FLAG) || command.includes('"${INTENTS_FLAGS[@]}"')
    expect(named, `pass ${MODULE_FLAG} (or "\${INTENTS_FLAGS[@]}"): ${command}`).toBe(true)
  })
})

describe('a release ships its actions or stops', () => {
  it('build-release.sh fails when the processor exists and listed nothing', () => {
    const release = read('desktop/build-release.sh')
    const at = release.indexOf('app_intents_metadata "$APP_BUNDLE"')
    expect(at).toBeGreaterThan(0)
    const after = release.slice(at, at + 600)
    expect(after).toContain('[ ! -d "$RESOURCES/Metadata.appintents" ]')
    expect(after).toContain('xcrun --find appintentsmetadataprocessor')
    expect(after).toMatch(/exit 1/)
  })
})
