/**
 * In the dev server the console page's load event waits for the app's own modules
 * (web/src/boot-shell.ts holdLoadForApp adds web/src/dev-load-hold.ts as a module script): the
 * browser specs wait for `load` and then give a page 5 s. That holds only what dev-load-hold.ts
 * imports, and by the same specifiers, so each module is one module (fetched and run once). This
 * fails when the console shell starts an import that file does not hold, or holds one by another
 * specifier, and when code imports the hold file (a build must leave it out).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(__dirname, '../..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

describe('the dev load event waits for the console modules', () => {
  it('dev-load-hold.ts imports every module the console shell imports, by the same specifier', () => {
    const shell = read('web/src/boot-shell.ts')
    // The console's own imports: everything but the pop-out's and the stylesheets asked after them.
    const consoleImports = [...shell.matchAll(/import\('(\.\/[\w/-]+)'\)/g)].map((m) => m[1])
      .filter((s) => !s.startsWith('./popout/') && s !== './styles/global-styles')
    expect(consoleImports).toEqual(expect.arrayContaining(['./App', './plugins/loader']))
    const held = [...read('web/src/dev-load-hold.ts').matchAll(/^import '([^']+)';$/gm)].map((m) => m[1])
    expect(new Set(held)).toEqual(new Set(consoleImports))
    expect(shell).toMatch(/replace\(\/\[\^\/\]\*\$\/, 'dev-load-hold\.ts'\)/)
  })

  it('no code imports the hold file', () => {
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'web/src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(t|j)sx?$/.test(f) && fs.existsSync(path.join(ROOT, f)))
    const importers = files.filter((f) => /from ['"][^'"]*dev-load-hold['"]|import\(['"][^'"]*dev-load-hold['"]\)|import ['"][^'"]*dev-load-hold['"]/.test(read(f)))
    expect(importers).toEqual([])
  })
})
