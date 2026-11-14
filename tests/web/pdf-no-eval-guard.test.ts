/**
 * The PDF viewer never compiles code a PDF carries.
 *
 * PdfPreview renders PDFs from strangers since 2026-11-13 (a mail attachment, opened on a click).
 * Older pdf.js compiled font glyphs with `new Function` unless `getDocument` was given
 * `isEvalSupported: false`. The pdf.js this console ships (6.x) has neither the compile nor the option,
 * so there is nothing to pass. This guard keeps it that way across upgrades: the bundles PdfPreview
 * loads hold no `eval(` or `new Function(`, and if a later pdf.js brings the option back, PdfPreview
 * must pass it as false.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const BUILD = path.join(ROOT, 'web', 'node_modules', 'pdfjs-dist', 'build')
const PREVIEW = path.join(ROOT, 'web', 'src', 'components', 'common', 'PdfPreview.tsx')

/** What PdfPreview loads: the library (`import('pdfjs-dist')`) and the minified worker. */
const LOADED = ['pdf.mjs', 'pdf.min.mjs', 'pdf.worker.mjs', 'pdf.worker.min.mjs']

describe('pdf.js runs no code from a PDF', () => {
  it('loads the bundles this guard reads', () => {
    const preview = fs.readFileSync(PREVIEW, 'utf8')
    expect(preview).toContain("import('pdfjs-dist')")
    expect(preview).toContain("import('pdfjs-dist/build/pdf.worker.min.mjs?url')")
    for (const file of LOADED) expect(fs.existsSync(path.join(BUILD, file)), file).toBe(true)
  })

  it.each(LOADED)('%s compiles nothing at run time', (file) => {
    const code = fs.readFileSync(path.join(BUILD, file), 'utf8')
    expect(code).not.toMatch(/\beval\s*\(/)
    expect(code).not.toMatch(/\bnew\s+Function\s*\(/)
  })

  it('turns eval off wherever the library offers the switch', () => {
    const offered = LOADED.some((file) => fs.readFileSync(path.join(BUILD, file), 'utf8').includes('isEvalSupported'))
    if (offered) expect(fs.readFileSync(PREVIEW, 'utf8')).toMatch(/isEvalSupported:\s*false/)
  })
})
