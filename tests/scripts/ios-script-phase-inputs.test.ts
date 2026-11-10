import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'

// A script phase that edits a file Xcode itself writes (the built Info.plist) is
// ordered after Xcode's own step only when it names that file in inputFiles. With
// none, Xcode may run it first: 2026-11-10, the widget's build number phase found
// no built Info.plist, failed on its version key and stopped CI's iOS build (run
// 42728088538). Every phase of ios-native/project.yml that touches a built file
// Xcode makes declares it.
const ROOT = path.resolve(__dirname, '../..')
const SPEC = path.join(ROOT, 'ios-native/project.yml')

// Built files Xcode writes, as a script reads them, and the input naming each.
const BUILT = [{ uses: /\$\{?TARGET_BUILD_DIR\}?\/\$\{?INFOPLIST_PATH\}?/, input: '$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)' }]

type Phase = { name?: string; script?: string; inputFiles?: string[] }
type Target = Record<string, unknown> & Partial<Record<'preBuildScripts' | 'postBuildScripts' | 'postCompileScripts', Phase[]>>

export function undeclared(targets: Record<string, Target>): string[] {
  const bad: string[] = []
  for (const [name, t] of Object.entries(targets)) {
    for (const kind of ['preBuildScripts', 'postCompileScripts', 'postBuildScripts'] as const) {
      for (const phase of t[kind] ?? []) {
        for (const b of BUILT) {
          if (b.uses.test(phase.script ?? '') && !(phase.inputFiles ?? []).includes(b.input)) {
            bad.push(`${name} "${phase.name}" uses ${b.input} without it in inputFiles`)
          }
        }
      }
    }
  }
  return bad
}

describe('iOS script phases that edit a built file wait for Xcode to write it', () => {
  it('holds for every target in ios-native/project.yml', () => {
    const spec = parseYaml(fs.readFileSync(SPEC, 'utf8')) as { targets: Record<string, Target> }
    const users = Object.values(spec.targets).flatMap((t) =>
      ['preBuildScripts', 'postCompileScripts', 'postBuildScripts'].flatMap((k) => (t[k] as Phase[] | undefined) ?? []),
    ).filter((p) => BUILT.some((b) => b.uses.test(p.script ?? '')))
    expect(users.length).toBeGreaterThanOrEqual(2)
    expect(undeclared(spec.targets)).toEqual([])
  })

  it('finds a phase that edits the built Info.plist with no input, the 2026-11-10 failure', () => {
    const phase = { name: 'Take the build number', script: 'plist="${TARGET_BUILD_DIR}/${INFOPLIST_PATH}"' }
    expect(undeclared({ W: { postBuildScripts: [phase] } })).toEqual([
      'W "Take the build number" uses $(TARGET_BUILD_DIR)/$(INFOPLIST_PATH) without it in inputFiles',
    ])
    expect(undeclared({ W: { postBuildScripts: [{ ...phase, inputFiles: ['$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)'] }] } })).toEqual([])
  })
})
