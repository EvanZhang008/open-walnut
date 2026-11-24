/**
 * In the dev server the console page's load event waits for the app's own modules
 * (web/src/boot-shell.ts holdLoadForApp adds web/src/dev-load-hold.ts as a module script): the
 * browser specs wait for `load` and then give a page 5 s. That holds only what dev-load-hold.ts
 * imports, and by the same specifiers, so each module is one module (fetched and run once). This
 * fails when the console shell starts an import that file does not hold, or holds one by another
 * specifier, and when code imports the hold file (a build must leave it out).
 *
 * A hold added after `load` holds nothing, so the page's own entry (index.html's module script)
 * holds every module it imports late: 2026-11-24, boot.ts imported main only after its Demo check,
 * boot-shell's hold for App was never added, and `load` came at 0.15 s while the app's socket
 * opened at 6.8 s (specs that sent on the socket right after load found none).
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

  it('the page entry holds the load for every module it imports late, by the address the import uses', () => {
    const entry = read('web/index.html').match(/<script type="module" src="\/src\/([\w/-]+\.tsx?)"><\/script>/)?.[1]
    expect(entry).toBeTruthy()
    const source = read(`web/src/${entry}`)
    const late = [...source.matchAll(/import\('\.\/([\w/-]+)'\)/g)].map((m) => m[1])
    expect(late).toContain('main')
    for (const name of late) {
      const file = ['.tsx', '.ts'].map((ext) => `${name}${ext}`).find((f) => fs.existsSync(path.join(ROOT, 'web/src', f)))
      expect(file, `web/src/${name} exists`).toBeTruthy()
      // The same address the import resolves to (import.meta.url's folder + the file), never
      // `new URL(..., import.meta.url)`, which a build would copy as an asset.
      expect(source, `${entry} holds the load for ./${name}`).toContain(`holdDevLoad(import.meta.url.replace(/[^/]*$/, '${file}'))`)
    }
  })
})
