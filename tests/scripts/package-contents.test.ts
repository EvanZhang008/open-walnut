/**
 * The npm package carries each full server bundle once per entry, never a copy per built-in
 * plugin (2026-11-16: four unused 23 MB plugin bundles put it 1.3 MB under the 200 MB limit).
 * Enumerated from the source: every built-in plugin directory against the build's entries, and
 * check-publish's rule for any big file of the pack.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DUPLICATE_FILE_BYTES, LARGE_BUNDLES, LARGE_FILE_BYTES, PACKAGE_LIMIT_BYTES, PACKAGE_MARGIN_BYTES, packageContentProblems } from '../../scripts/package-contents.mjs'
import { BUILTIN_HOST_MODULES } from '../../src/integrations/host-modules.js'

const ROOT = path.resolve(import.meta.dirname, '../..')
const MB = 1024 * 1024

describe('built-in plugins ship no bundle of their own', () => {
  const tsup = fs.readFileSync(path.join(ROOT, 'tsup.config.ts'), 'utf8')
  const entries = /entry: \[([\s\S]*?)\n  \],/.exec(tsup)?.[1] ?? ''

  it('reads the build entries', () => {
    expect(entries).toContain("'src/cli.ts'")
    expect(entries).toContain("'src/web/server.ts'")
  })

  it('no entry names src/integrations, and none is spread in from a list', () => {
    expect(entries).not.toMatch(/src\/integrations/)
    expect(entries).not.toMatch(/\.\.\./)
  })

  it.each(Object.keys(BUILTIN_HOST_MODULES))('%s loads through the host bundle', (id) => {
    expect(fs.existsSync(path.join(ROOT, 'src/integrations', id, 'index.ts'))).toBe(true)
  })

  it('a build removes the plugin bundles an older build left in dist', () => {
    expect(tsup).toMatch(/async function afterBuild\(\)[^]*?removeStalePluginBundles\(\)/)
  })
})

describe('check-publish refuses a big file that is not an entry bundle', () => {
  const ok = LARGE_BUNDLES.map((p) => ({ path: p, size: 23 * MB }))

  it('the entry bundles may be large', () => {
    expect(packageContentProblems([...ok, { path: 'dist/cli-fast.js.jsc', size: 6.3 * MB }])).toEqual([])
  })

  it('a plugin bundle over the limit is named', () => {
    const problems = packageContentProblems([...ok, { path: 'dist/integrations/jira/index.js', size: 23 * MB }])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('dist/integrations/jira/index.js is 23.0 MB')
  })

  it('a file just over the limit counts, one at the limit does not', () => {
    expect(packageContentProblems([{ path: 'dist/x.js', size: LARGE_FILE_BYTES }])).toEqual([])
    expect(packageContentProblems([{ path: 'dist/x.js', size: LARGE_FILE_BYTES + 1 }])).toHaveLength(1)
  })

  it('a compiled-file staging tree is one problem, however many files it has', () => {
    const staged = Array.from({ length: 300 }, (_, i) => ({ path: `dist/binary-stage/root/f${i}.js`, size: 10 }))
    expect(packageContentProblems(staged)).toEqual(['300 files of dist/binary-stage/, a compiled-file build\'s staging tree'])
  })

  it('two big files with the same content are one problem naming both, whatever their names', () => {
    const problems = packageContentProblems([
      ...ok.map((f, i) => ({ ...f, hash: `h${i}` })),
      { path: 'dist/web/static/a.js', size: 2 * MB, hash: 'same' },
      { path: 'dist/vendor/a-copy.js', size: 2 * MB, hash: 'same' },
    ])
    expect(problems).toEqual(['2 copies of one 2.0 MB file: dist/web/static/a.js, dist/vendor/a-copy.js'])
  })

  it('small files may repeat (a LICENSE, an icon)', () => {
    expect(packageContentProblems([
      { path: 'a/LICENSE', size: DUPLICATE_FILE_BYTES - 1, hash: 'same' },
      { path: 'b/LICENSE', size: DUPLICATE_FILE_BYTES - 1, hash: 'same' },
    ])).toEqual([])
  })

  it('a package within the margin of the limit is refused, one just outside it is not', () => {
    const edge = PACKAGE_LIMIT_BYTES - PACKAGE_MARGIN_BYTES
    expect(packageContentProblems(ok, edge)).toEqual([])
    const [problem] = packageContentProblems(ok, edge + 1)
    expect(problem).toContain('within 20.0 MB of the 200.0 MB limit')
  })

  it('check-publish runs the rules on the real pack listing, hashing every big file', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/check-publish.mjs'), 'utf8')
    expect(script).toContain('packageContentProblems(hashed, pack.unpackedSize)')
    expect(script).toMatch(/f\.size >= DUPLICATE_FILE_BYTES[\s\S]*createHash\('sha256'\)/)
    // The limit has one home: package-contents.mjs.
    expect(script).not.toMatch(/200 \* 1024 \* 1024/)
  })

  it('package.json leaves the staging tree out', () => {
    const files = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { files: string[] }).files
    expect(files).toContain('!dist/binary-stage')
  })
})
