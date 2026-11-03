/**
 * Every task row renames from its title, through the one hook (2026-11-03, the user, on a row
 * under Watching: "whhy the preivosu avaiible text edit cna't be done here?"; the status section
 * rows drew a plain title while the list row, the Recent card and the Focus card each kept their
 * own copy of the editor).
 *
 * Guard for the class: every element in web/src that draws a task title (`todo-item-title` or
 * `todo-pinned-title`) spreads the props of `useInlineTitleEdit`, unless it is listed below with
 * why. A new row that draws a title without it fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB_SRC = path.resolve(__dirname, '../../web/src')

/** Titles that are no row: what they draw cannot be renamed. Keyed by a marker in the element's context. */
const NOT_A_ROW: Record<string, string> = {
  'drag-overlay-item': 'the ghost a list row drags, gone when the drag ends',
  activeDragPinnedTask: 'the ghost a card drags, gone when the drag ends',
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return /\.tsx$/.test(e.name) ? [p] : []
  })
}

/** Each element whose className names a task title class: its file, its opening tag, and the text before it. */
function titleElements(): Array<{ file: string; tag: string; before: string }> {
  const out: Array<{ file: string; tag: string; before: string }> = []
  for (const f of sourceFiles(WEB_SRC)) {
    const src = fs.readFileSync(f, 'utf8')
    const re = /className=\{?[`'"]todo-(?:item|pinned)-title(?![-\w])/g
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const open = src.lastIndexOf('<', m.index)
      const close = src.indexOf('>', src.indexOf('}', m.index))
      out.push({ file: path.relative(WEB_SRC, f), tag: src.slice(open, close + 1), before: src.slice(Math.max(0, open - 400), open) })
    }
  }
  return out
}

describe('every task row renames from its title', () => {
  const found = titleElements()

  it('finds the rows (the list row, the Recent card, the Focus card, the status section card)', () => {
    const files = new Set(found.map((e) => e.file))
    for (const f of ['components/tasks/TodoPanel.tsx', 'components/tasks/FocusSatelliteCards.tsx', 'components/tasks/StatusSections.tsx']) {
      expect(files.has(f), f).toBe(true)
    }
    expect(found.length).toBeGreaterThanOrEqual(6)
  })

  it('each one spreads useInlineTitleEdit\'s props, or is listed as no row', () => {
    const missing = found.filter((e) => {
      if (/\{\.\.\.(?:\w+\.)?titleProps\}/.test(e.tag)) return false
      return !Object.keys(NOT_A_ROW).some((marker) => e.tag.includes(marker) || e.before.includes(marker))
    }).map((e) => `${e.file}: ${e.tag.slice(0, 120)}`)
    expect(missing).toEqual([])
  })

  it('each row hands the hook a rename, and the panel gives the section rows one', () => {
    const calls = sourceFiles(WEB_SRC).flatMap((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return [...src.matchAll(/useInlineTitleEdit\(([^,)]+),\s*([^,)]*)/g)].map((m) => ({ file: path.relative(WEB_SRC, f), rename: m[2].trim() }))
    })
    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect(calls.filter((c) => !c.rename || c.rename === 'undefined')).toEqual([])
    // The section rows' rename comes from the panel's handlers (the bug: they had none).
    const panel = fs.readFileSync(path.join(WEB_SRC, 'components/tasks/TodoPanel.tsx'), 'utf8')
    const handlers = panel.slice(panel.indexOf('const sectionRowHandlers'), panel.indexOf('}), [', panel.indexOf('const sectionRowHandlers')))
    expect(handlers).toMatch(/onUpdateTitle:/)
  })

  it('no row keeps its own copy of the editor', () => {
    for (const f of sourceFiles(WEB_SRC)) {
      if (f.endsWith('useInlineTitleEdit.ts')) continue
      const src = fs.readFileSync(f, 'utf8')
      if (!/todo-(?:item|pinned)-title(?![-\w])/.test(src)) continue
      expect(/contentEditable=\{/.test(src), `${path.relative(WEB_SRC, f)} sets contentEditable on a title itself`).toBe(false)
    }
  })
})
