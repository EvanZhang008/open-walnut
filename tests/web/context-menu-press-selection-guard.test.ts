/**
 * Every row menu ignores the selection its own right-press made (web/src/AGENTS.md, "A ContextMenu
 * hook on a row whose text is selectable passes ignorePressSelection"). WebKit, the Mac app's
 * engine, selects the word under a right-press before `contextmenu` fires; without the flag that
 * selection hands the gesture to the native menu, so the row's own menu never opens on a word
 * (2026-11-12: a right-click on a session reply's text never showed "Read in split"; five call
 * sites lacked the flag). A deliberate selection made before the press still gets the native menu.
 * Fails on a new useContextMenu call that does not pass it.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const WEB = path.resolve(__dirname, '../../web/src')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

describe('row menus ignore the selection their own right-press made', () => {
  const calls = walk(WEB)
    .filter((f) => !f.endsWith(path.join('common', 'ContextMenu.tsx')))
    .flatMap((f) => {
      const src = fs.readFileSync(f, 'utf8')
      return [...src.matchAll(/\buseContextMenu(?:<[^>()]*>)?\(([^)]*)\)/g)].map((m) => ({ file: path.relative(WEB, f), args: m[1] }))
    })

  it('finds the call sites', () => {
    expect(calls.length).toBeGreaterThanOrEqual(10)
  })

  it('every call passes ignorePressSelection: true', () => {
    expect(calls.filter((c) => !/ignorePressSelection:\s*true/.test(c.args)).map((c) => c.file)).toEqual([])
  })
})
