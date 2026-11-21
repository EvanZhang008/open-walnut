/**
 * The web derives a task's project key through projectGroupKey, never `task.project || ''`
 * (2026-11-21: the Inbox became a real project, src/core/inbox-project.ts).
 *
 * Every task now carries `project: "Inbox"`, while an older row or client may still say ''.
 * `t.project || ''` keys the first 'Inbox' and the second '', so a board grew a second "Inbox"
 * group beside its own, a rail a second "Inbox" row, and the Inbox lost its fixed place, fold
 * and order. projectGroupKey (web/src/utils/project-display.ts) answers '' for every spelling
 * of the Inbox, the key its prefs have always used; projectIdentity is its case-insensitive
 * twin. The class: any `.project || ''` in web/src. Ratchet: counts may only fall.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.resolve(import.meta.dirname, '..', '..', 'web', 'src')
const PATTERN = /\.project\s*\|\|\s*''/g

/** Files still holding the pattern, with their count: lower a row when it falls. */
const PINS: Record<string, number> = {
  // A label line (selfRouterLine), not a key.
  'components/org/OrgNodeDetail.tsx': 1,
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

describe("a task's project key in the web goes through projectGroupKey", () => {
  const counts = new Map<string, number>()
  for (const file of sources(WEB)) {
    const n = fs.readFileSync(file, 'utf8').match(PATTERN)?.length ?? 0
    if (n) counts.set(path.relative(WEB, file).split(path.sep).join('/'), n)
  }

  it("no file derives one with `.project || ''` past its pin", () => {
    const grew = [...counts].filter(([f, n]) => n > (PINS[f] ?? 0)).map(([f, n]) => `${f}: ${n} (pin ${PINS[f] ?? 0})`)
    expect(grew, "use projectGroupKey(task.project) ('' for the Inbox) from web/src/utils/project-display.ts").toEqual([])
  })

  it('a file that fell is lowered in PINS', () => {
    const fell = Object.entries(PINS).filter(([f, pin]) => (counts.get(f) ?? 0) < pin).map(([f]) => `${f}: ${counts.get(f) ?? 0}`)
    expect(fell).toEqual([])
  })
})
