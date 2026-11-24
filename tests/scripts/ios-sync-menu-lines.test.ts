/**
 * The phone's task menu Sync section (ios-native/Walnut/Views/Tasks/TaskSyncViews.swift,
 * TaskSyncMenu) shows at most two lines per row and cuts the rest: 2026-11-24 the simulator showed
 * "Kept out of Tracker: Kept local when it w…". Every line it shows must come from SyncMenuText
 * (each case measured against two menu lines by PrivateTasksTests.testEveryMenuLineFitsTwoLines,
 * so a new case that does not fit fails there) or from SyncStanding's note/menuRow, which measure a
 * server reason before showing it. This guard fails when a line is written into the menu as a
 * string literal, which no measurement would see.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../ios-native')
const VIEWS = fs.readFileSync(path.join(ROOT, 'Walnut/Views/Tasks/TaskSyncViews.swift'), 'utf-8')
const MODEL = fs.readFileSync(path.join(ROOT, 'Walnut/Views/Tasks/TaskSyncModel.swift'), 'utf-8')
const UNIT = fs.readFileSync(path.join(ROOT, 'WalnutTests/PrivateTasksTests.swift'), 'utf-8')

/** The source of `struct <name>` up to the next top-level declaration. */
function structBody(src: string, name: string): string {
  const start = src.indexOf(`struct ${name}`)
  expect(start, `struct ${name} not found`).toBeGreaterThanOrEqual(0)
  const rest = src.slice(start + 1)
  const next = rest.search(/\n(?:\/\/\/[^\n]*\n)*(?:struct|enum|extension|final class|class) /)
  return next < 0 ? rest : rest.slice(0, next)
}

describe('every line of the phone Sync menu is measured against its two lines', () => {
  const menu = structBody(VIEWS, 'TaskSyncMenu')

  it('TaskSyncMenu writes no line as a literal: only identifiers and symbol names are quoted', () => {
    const quoted = menu
      .replace(/\.accessibilityIdentifier\("[^"]*"\)/g, '')
      .replace(/systemImage: (?:[^"\n]*\? )?"[^"]*"(?: : "[^"]*")?/g, '')
    const literals = [...quoted.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => m[0])
    expect(literals, 'put the line in SyncMenuText (TaskSyncModel.swift) so it is measured').toEqual([])
  })

  it('each Text and Label of the menu reads SyncMenuText, the note or the menu row', () => {
    const args = [...menu.matchAll(/\b(?:Text|Label)\(([^,)]+(?:\([^)]*\))?)/g)].map((m) => m[1]!.trim())
    expect(args.length).toBeGreaterThan(5)
    for (const arg of args) {
      expect(arg, `menu line ${arg} does not come from SyncMenuText`).toMatch(/^(?:SyncMenuText\.\w+\.text\(|note$|standing\.menuRow\()/)
    }
  })

  it('the unit test measures every SyncMenuText case and the note measures a server reason first', () => {
    expect(UNIT).toMatch(/for line in SyncMenuText\.allCases[\s\S]{0,200}SyncMenuText\.fits\(/)
    expect(MODEL).toMatch(/enum SyncMenuText: CaseIterable/)
    expect(MODEL).toMatch(/!reason\.isEmpty,\s*fits\(reason\)/)
  })
})
