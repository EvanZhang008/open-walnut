/**
 * The Settings rule editor checks a subject pattern with the SAME module the server refuses it with
 * (src/integrations/mail/sort-regex-safety.ts), so the editor refuses what the server refuses, in
 * the same sentences (an invalid pattern's reason is read from the pattern itself), and a
 * pattern the server would refuse never reaches a preview. The web alias
 * `@open-walnut/mail-subject-pattern` must resolve to that file in every config (vite, web tsconfig,
 * the three vitest configs), and at test time it is literally the same module instance.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as viaAlias from '@open-walnut/mail-subject-pattern'
import * as viaServer from '../../src/integrations/mail/sort-regex-safety.js'

const root = path.resolve(import.meta.dirname, '../..')
const target = path.join(root, 'src/integrations/mail/sort-regex-safety.ts')

describe('@open-walnut/mail-subject-pattern alias', () => {
  it('is the same module instance as the server import', () => {
    expect(viaAlias.compileSubjectPattern).toBe(viaServer.compileSubjectPattern)
    expect(viaAlias.PATTERN_BACKREFERENCE).toBe(viaServer.PATTERN_BACKREFERENCE)
  })

  it('every config points the alias at the same file', () => {
    const vite = readFileSync(path.join(root, 'web/vite.config.ts'), 'utf8')
    const m = vite.match(/'@open-walnut\/mail-subject-pattern':\s*path\.resolve\(__dirname,\s*'([^']+)'\)/)
    expect(m).not.toBeNull()
    expect(path.resolve(root, 'web', m![1]!)).toBe(target)

    const tsconfig = JSON.parse(readFileSync(path.join(root, 'web/tsconfig.json'), 'utf8'))
    const p = tsconfig.compilerOptions.paths['@open-walnut/mail-subject-pattern']
    expect(path.resolve(root, 'web', p[0]) + '.ts').toBe(target)

    for (const cfg of ['vitest.config.ts', 'vitest.focus.config.ts', 'vitest.quick.config.ts']) {
      const src = readFileSync(path.join(root, cfg), 'utf8')
      const hit = src.match(/'@open-walnut\/mail-subject-pattern':\s*path\.resolve\(import\.meta\.dirname,\s*'([^']+)'\)/)
      expect(hit, cfg).not.toBeNull()
      expect(path.resolve(root, hit![1]!)).toBe(target)
    }
  })

  it('the module and the engine under it are browser-safe: no node imports', () => {
    // Every file of the engine, so a new one is checked too.
    const engine = path.join(root, 'src/lib/linear-regex')
    const files = [target, ...readdirSync(engine).filter((name) => name.endsWith('.ts')).map((name) => path.join(engine, name))]
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const imports = [...readFileSync(file, 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map((hit) => hit[1]!)
      expect(imports.filter((one) => !one.startsWith('./') && !one.startsWith('../')), file).toEqual([])
    }
  })
})
