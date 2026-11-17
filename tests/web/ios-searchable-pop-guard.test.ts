/**
 * A phone page that leaves itself by code (a pick that pops it, a dismiss) never carries a system
 * search (`.searchable`): on iOS 26.5 the Changes page's compare picker popped while its search was
 * active, and the search field stayed on screen at the foot of every page after it, over the diff's
 * selection bar, where it took the taps meant for Copy (CI, from 2026-11-11 to 2026-11-16:
 * SessionChangesUITests "Copy said nothing"). Ending that search from code before the pop made
 * iOS 26 drop the pop instead. The picker now draws a plain field (`compare.search`), which leaves
 * with its page.
 *
 * The members are read from source: every `.searchable(` under ios-native/Walnut is listed below
 * with why its page is never left by code while it searches. A new one fails here until decided.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const IOS = path.resolve(import.meta.dirname, '../../ios-native/Walnut')

/** File -> how many `.searchable(` it holds, and why none is popped by code while searching. */
const DECIDED: Record<string, { count: number; why: string }> = {
  'Views/Tasks/TasksView.swift': { count: 1, why: 'the Tasks tab root: nothing pops it' },
  'Views/Notes/NotesView.swift': { count: 1, why: 'the Notes tab root: a hit pushes a note on top, the search page stays' },
  'Views/Passwords/PasswordsHomeView.swift': {
    count: 2,
    why: 'the vault home and a filter list: a row pushes forward, and only Back leaves them',
  },
}

const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

function swiftFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...swiftFiles(full))
    else if (entry.name.endsWith('.swift')) out.push(full)
  }
  return out
}

describe('iOS: a page that leaves itself by code has no system search', () => {
  const counts = Object.fromEntries(
    swiftFiles(IOS)
      .map((f) => [path.relative(IOS, f).split(path.sep).join('/'), (code(fs.readFileSync(f, 'utf8')).match(/\.searchable\s*\(/g) ?? []).length] as const)
      .filter(([, n]) => n > 0),
  )

  it('every .searchable is decided', () => {
    const undecided = Object.entries(counts).filter(([f, n]) => DECIDED[f]?.count !== n).map(([f, n]) => `${f} (${n})`)
    expect(undecided, 'a page a pick pops draws a plain field (see DiffComparePickerView); a root or Back-only page: list it here with why').toEqual([])
  })

  it('the list holds no stale entry', () => {
    expect(Object.keys(DECIDED).filter((f) => !(f in counts))).toEqual([])
  })

  it('the compare picker searches with a plain field', () => {
    const src = code(fs.readFileSync(path.join(IOS, 'Views/Sessions/Changes/DiffReviewViews.swift'), 'utf8'))
    expect(src).not.toMatch(/\.searchable\s*\(/)
    expect(src).toMatch(/accessibilityIdentifier\("compare\.search"\)/)
  })
})
