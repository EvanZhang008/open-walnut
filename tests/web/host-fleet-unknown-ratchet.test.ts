/**
 * The fleet Overview never draws a bare "?" (2026-11-04, the user on the Mac's card: "why
 * sesison is ?"). A number it does not have is drawn by FleetNumber.tsx, which always puts
 * why in words beside the mark, or by a ring that names its reason (`why`).
 *
 * Over the TypeScript AST of every Overview file (enumerated from the folder, so a new
 * card part is checked the day it lands), a string literal, template literal or JSX text
 * that is exactly "?" fails, except in FleetNumber.tsx itself.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const dir = path.resolve(__dirname, '../../web/src/components/settings/sections')
const OWNER = 'FleetNumber.tsx'

function overviewFiles(): string[] {
  return fs.readdirSync(dir).filter((f) => /^(HostFleet|host-fleet-|Fleet)[\w-]*\.tsx?$/.test(f)).sort()
}

function bareMarks(file: string): string[] {
  const text = fs.readFileSync(path.join(dir, file), 'utf8')
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const hits: string[] = []
  const visit = (n: ts.Node) => {
    const literal = ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isJsxText(n) ? n.text.trim() : null
    if (literal === '?') hits.push(`${file}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`)
    ts.forEachChild(n, visit)
  }
  visit(src)
  return hits
}

describe('the fleet Overview draws no bare "?"', () => {
  it('finds the Overview files', () => {
    const files = overviewFiles()
    for (const f of ['HostFleetCard.tsx', 'HostFleetGroup.tsx', 'HostFleetTopology.tsx', 'host-fleet-dashboard-model.ts', OWNER]) expect(files).toContain(f)
  })
  it('only FleetNumber.tsx holds the mark, and it always says why', () => {
    const hits = overviewFiles().filter((f) => f !== OWNER).flatMap(bareMarks)
    expect(hits, 'draw an unknown number with <FleetNumber> (or a ring\'s why), never a bare "?"').toEqual([])
    expect(bareMarks(OWNER)).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, OWNER), 'utf8')).toContain('className="hf-why"')
  })
})
