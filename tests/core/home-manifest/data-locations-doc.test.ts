/**
 * docs/reference/data-locations.md shows the manifest (src/core/home-manifest/) as
 * tables between two markers. This fails when they differ; run it with
 * WALNUT_WRITE_DATA_LOCATIONS=1 to write the tables again from the manifest.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { DOC_TABLE_END, DOC_TABLE_START, documentedEntries, renderDataLocationsBlock } from '../../../src/core/home-manifest/doc-table.js'
import { homeEntries, outsideHomeEntries } from '../../../src/core/home-manifest/index.js'

const root = path.resolve(import.meta.dirname, '../../..')
const DOC = path.join(root, 'docs/reference/data-locations.md')

describe('docs/reference/data-locations.md', () => {
  it('shows the manifest as it is', () => {
    const text = fs.readFileSync(DOC, 'utf8')
    const start = text.indexOf(DOC_TABLE_START)
    const end = text.indexOf(DOC_TABLE_END)
    expect(start, 'the doc keeps its start marker').toBeGreaterThanOrEqual(0)
    expect(end, 'the doc keeps its end marker').toBeGreaterThan(start)
    const current = text.slice(start, end + DOC_TABLE_END.length)
    const wanted = renderDataLocationsBlock()
    if (current !== wanted && process.env.WALNUT_WRITE_DATA_LOCATIONS === '1') {
      fs.writeFileSync(DOC, text.slice(0, start) + wanted + text.slice(end + DOC_TABLE_END.length))
      return
    }
    expect(current, 'run this test with WALNUT_WRITE_DATA_LOCATIONS=1 to write the tables again').toBe(wanted)
  })

  it('has one row per entry but the legacy ones, and no dashes as clause separators outside the tables', () => {
    const block = renderDataLocationsBlock()
    const rows = block.split('\n').filter((l) => l.startsWith('| `'))
    const legacy = [...homeEntries(), ...outsideHomeEntries()].filter((e) => e.legacy)
    expect(legacy.length, 'the places older releases used stay classed').toBeGreaterThan(0)
    expect(rows.length).toBe(documentedEntries().length)
    expect(rows.length).toBe(homeEntries().length + outsideHomeEntries().length - legacy.length)
    for (const e of legacy) {
      const where = `| \`~/.open-walnut/${e.path}`
      expect(rows.some((l) => l.startsWith(`${where}/\``) || l.startsWith(`${where}\``)), e.id).toBe(false)
    }
    const prose = fs.readFileSync(DOC, 'utf8').replace(block, '')
    expect(prose).not.toMatch(/[\u2013\u2014]| - /)
  })

  it('is linked from docs/README.md', () => {
    expect(fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8')).toContain('(reference/data-locations.md)')
  })
})
